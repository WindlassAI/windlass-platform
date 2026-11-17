/**
 * A user's sandbox time and kept sandboxes: what is counted, the two limits, and the book that decides.
 *
 * What costs money is the time a sandbox runs, so that is what is counted: from the moment a session
 * has its sandbox created or resumed until it is suspended, removed, or stops by itself. A paused
 * sandbox runs nothing and counts no time; it counts as one of the sandboxes its user keeps.
 *
 *   The allowance    A user may use WLP_DAILY_SANDBOX_SECONDS of sandbox time in one UTC day (two hours
 *                    unless set otherwise).
 *   The cap          A user may keep WLP_MAX_KEPT_SANDBOXES sandboxes at once, running or paused (five).
 *
 * One place decides both: the user's `user` actor, which every server reaches and which runs one step
 * at a time. It keeps a `UsageBook` beside its tables, and every decision is one synchronous call on
 * the book, so two sessions that ask at the same moment are answered one after the other.
 *
 * A ledger, not a counter. Every second counted is in an entry: which session, which hold, how many
 * seconds, when, and a note where something was out of the ordinary. A day's total is the sum of its
 * entries and is never stored by itself, so it can be added up again, the usage page can show the
 * days and the agents, and a mistake can be seen. Nothing is ever taken out of an entry.
 *
 * Reserve, then settle. A session does not ask whether time is left and report afterwards: two that
 * asked together would both be told yes. Before its sandbox runs, it takes a hold: a few minutes of
 * the day's allowance (WLP_USAGE_HOLD_SECONDS), which count as used from that moment for everybody
 * else. While the sandbox runs, the session trades the hold for the next one when it ends, reporting
 * what the first really used (`reserve` with `settle`, one step). When the sandbox stops, it settles
 * the last hold with what ran, and the rest of that hold is free again. A hold never reaches past
 * midnight UTC, so the hold that follows it is taken from the new day.
 *
 * A hold that nobody settles runs out by itself, HOLD_GRACE_SECONDS after the time it was for: its
 * session's server stopped under it. It is then counted in full, as an entry of the kind "unreported":
 * the sandbox ran for some part of it that nobody measured, and the whole hold is the most this book
 * can know. A session that did measure, and only could not say so in time (it stopped its sandbox as
 * its server shut down), keeps its report and sends it when it is next awake: the difference is then
 * given back in an entry of its own, "corrected", and the first entry stays as it was.
 *
 * What a session reports is checked against the hold: never less than nothing, and never more than
 * the time since the hold was taken. A report above the hold's own length is counted (the sandbox ran
 * that long) and the entry says by how much it went over.
 *
 * The cap is a count and a claim in the same step. A session that needs a sandbox it does not have is
 * given a place with its hold or is refused both; the place is given back when its sandbox is removed.
 * The count can come apart from what exists (a sandbox that was never made, one removed at the
 * provider), so it is held against the provider's own list (`reconcile`): a claim with no sandbox
 * behind it is dropped, and a sandbox with no claim is counted even past the cap, because it exists.
 *
 * This file has no actor and reads no clock: the `user` actor keeps the book (actors/user.ts), the
 * session actor holds and settles (actors/agent-session.ts), and scripts/usage-check.ts runs the rules
 * on their own.
 */

import type { UsageDay, UsageNumbers, UsageSession } from "./contract.js";
import { USAGE_HISTORY_DAYS } from "./contract.js";

export const DAY_MS = 86_400_000;
/** The defaults of the three settings (config.ts). */
export const DEFAULT_DAILY_SECONDS = 2 * 60 * 60;
export const DEFAULT_MAX_KEPT = 5;
export const DEFAULT_HOLD_SECONDS = 5 * 60;
/**
 * How long after the time it was for a hold still waits to be settled. It covers a session that
 * reports late, and the time a provider lets a sandbox run after the server that used it has died
 * (E2B: WLP_E2B_TURN_LEASE_MS, three minutes at most by default), so by the time a hold is counted in
 * full its sandbox has stopped.
 */
export const HOLD_GRACE_SECONDS = 4 * 60;
/** The least that must be left of the day for a turn to start: less than this is spent on starting the sandbox. */
export const MIN_START_SECONDS = 30;
/** How much later than this book's own clock a session's report may be before it is cut to that clock. */
export const REPORT_SLACK_SECONDS = 5;
/** What follows a hold's id in the entry that corrects it: a hold is counted once and corrected once. */
const LATE = "+late";
/** A hold taken this close to midnight UTC is the new day's first: the session would trade it within the same moment. */
const MIDNIGHT_SLACK_MS = 2_000;
/** A claim this young is not dropped for having no sandbox: its session is still making one. */
export const CLAIM_SETTLING_MS = 5 * 60_000;
/** How many days of entries the `user` actor keeps in its table; the usage page shows USAGE_HISTORY_DAYS of them. */
export const USAGE_KEPT_DAYS = 90;

export function dayOf(ms: number): number {
	return Math.floor(ms / DAY_MS);
}

/** A day as the contract names it: "2026-11-17". */
export function dayName(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The settings, as the book takes them. `null` is "no limit". */
export interface UsageLimits {
	dailySeconds: number | null;
	maxKept: number | null;
	holdSeconds: number;
}

/** A second or more of sandbox time that was counted. */
export interface UsageEntry {
	/** The UTC day it counts against: the day its hold was taken on. */
	day: number;
	session: string;
	/** The hold it closed. A hold is closed once, so this names the entry. */
	hold: string;
	/**
	 * "used": the session reported what ran. "unreported": nobody did before the hold ran out, or the
	 * session took another hold without settling this one, and the hold is counted in full.
	 * "corrected": the report for an unreported hold came after all; `seconds` is what that gives back,
	 * below zero, and `hold` is the hold's id with LATE after it.
	 */
	kind: "used" | "unreported" | "corrected";
	seconds: number;
	/** When it was counted, ms since the epoch. */
	at: number;
	/** Set where the count is not simply what was reported: why. */
	note: string | null;
}

/** Sandbox time a session has reserved for a sandbox that runs. */
export interface UsageHold {
	/** Made by the session: asking again with the same id is the same request, not a second hold. */
	id: string;
	session: string;
	day: number;
	seconds: number;
	startedAt: number;
	/** When it is counted in full unless it was settled. */
	expiresAt: number;
}

/** A session's place among the sandboxes its user keeps. */
export interface KeptClaim {
	session: string;
	since: number;
}

/** What a step did to the book, for whoever keeps a copy of it elsewhere. */
export interface UsageChange {
	entries: UsageEntry[];
	opened: UsageHold[];
	/** The ids of holds that are no longer open. */
	closed: string[];
	kept: KeptClaim[];
	/** The sessions whose place was given back. */
	released: string[];
}

function noChange(): UsageChange {
	return { entries: [], opened: [], closed: [], kept: [], released: [] };
}

export function isEmptyChange(change: UsageChange): boolean {
	return change.entries.length === 0 && change.opened.length === 0 && change.closed.length === 0 && change.kept.length === 0 && change.released.length === 0;
}

export type ReserveRefusal =
	/** Too little of today's allowance is left. */
	| "allowance"
	/** The user keeps as many sandboxes as they may, and this session has none. */
	| "sandboxes";

export type ReserveResult = { ok: true; hold: UsageHold; change: UsageChange } | { ok: false; reason: ReserveRefusal; change: UsageChange };

export interface ReserveInput {
	/** The new hold's id, made by the session. */
	id: string;
	session: string;
	/** True when the session has no sandbox and is about to have one made: it needs a place among the kept ones. */
	keep?: boolean;
	/** True when something is about to start (a turn, a paused sandbox): MIN_START_SECONDS must be left. Otherwise a sandbox that runs is given whatever is left. */
	fresh?: boolean;
	/** The session's open hold and what its sandbox ran of it: closed in the same step the new one is taken in. */
	settle?: { hold: string; seconds: number };
}

/** One user's sandbox time and kept sandboxes. Every method takes the time, so nothing here reads a clock. */
export class UsageBook {
	private readonly entries: UsageEntry[] = [];
	private readonly totals = new Map<number, number>();
	/** By session: a session has one sandbox, and so one open hold. */
	private readonly holds = new Map<string, UsageHold>();
	private readonly claims = new Map<string, KeptClaim>();

	constructor(
		readonly limits: UsageLimits,
		state: { entries?: readonly UsageEntry[]; holds?: readonly UsageHold[]; kept?: readonly KeptClaim[] } = {},
	) {
		for (const entry of state.entries ?? []) this.add(entry);
		for (const hold of state.holds ?? []) this.holds.set(hold.session, hold);
		for (const claim of state.kept ?? []) this.claims.set(claim.session, claim);
	}

	/** The least that must be left for something to start: never more than one hold. */
	get startSeconds(): number {
		return Math.min(MIN_START_SECONDS, this.limits.holdSeconds);
	}

	private add(entry: UsageEntry): void {
		this.entries.push(entry);
		this.totals.set(entry.day, (this.totals.get(entry.day) ?? 0) + entry.seconds);
	}

	/** The seconds counted on a day: the sum of its entries. */
	usedOn(day: number): number {
		return this.totals.get(day) ?? 0;
	}

	/** The same sum, added up again from the entries: what `usedOn` must equal. */
	recount(day: number): number {
		return this.entries.reduce((sum, entry) => (entry.day === day ? sum + entry.seconds : sum), 0);
	}

	/** The seconds open holds have reserved of a day, without `except`'s. */
	heldOn(day: number, except?: string): number {
		let sum = 0;
		for (const hold of this.holds.values()) if (hold.day === day && hold.session !== except) sum += hold.seconds;
		return sum;
	}

	holdOf(session: string): UsageHold | null {
		return this.holds.get(session) ?? null;
	}

	openHolds(): UsageHold[] {
		return [...this.holds.values()];
	}

	keeps(session: string): boolean {
		return this.claims.has(session);
	}

	kept(): KeptClaim[] {
		return [...this.claims.values()];
	}

	/** Whether a session without a place would be refused one now. */
	atCap(session: string): boolean {
		return !this.claims.has(session) && this.limits.maxKept !== null && this.claims.size >= this.limits.maxKept;
	}

	/** The day a hold taken now counts against. */
	private holdDay(now: number): number {
		return dayOf(now + MIDNIGHT_SLACK_MS);
	}

	/** Closes a hold with what its session reported, and returns the entry that counts it. */
	private close(hold: UsageHold, reported: number, now: number): UsageEntry {
		// What can have run of a hold is the time since it was taken, by this book's clock.
		const most = Math.max(0, Math.ceil((now - hold.startedAt) / 1000)) + REPORT_SLACK_SECONDS;
		const notes: string[] = [];
		let seconds: number;
		if (!Number.isFinite(reported) || reported < 0) {
			notes.push(`the session reported ${String(reported)} s, which cannot be: counted as 0 s`);
			seconds = 0;
		} else {
			// Whole seconds, the nearest: a hold that was traded a few milliseconds after its time ran its length, not a second more.
			seconds = Math.round(reported);
			if (seconds > most) {
				notes.push(`the session reported ${seconds} s, more than the ${most} s since its hold was taken: ${most} s counted`);
				seconds = most;
			}
		}
		if (seconds > hold.seconds) notes.push(`${seconds - hold.seconds} s over its hold of ${hold.seconds} s`);
		return { day: hold.day, session: hold.session, hold: hold.id, kind: "used", seconds, at: now, note: notes.length === 0 ? null : notes.join("; ") };
	}

	private unreported(hold: UsageHold, at: number, why: string): UsageEntry {
		return { day: hold.day, session: hold.session, hold: hold.id, kind: "unreported", seconds: hold.seconds, at, note: why };
	}

	/** Counts in full every hold that ran out without being settled. Every other step begins with this. */
	sweep(now: number): UsageChange {
		const change = noChange();
		for (const hold of [...this.holds.values()]) {
			if (hold.expiresAt > now) continue;
			this.holds.delete(hold.session);
			const entry = this.unreported(hold, hold.expiresAt, "no report came before the hold ran out, so it is counted in full");
			this.add(entry);
			change.entries.push(entry);
			change.closed.push(hold.id);
		}
		return change;
	}

	/**
	 * Takes a hold for a session whose sandbox is about to run or goes on running, with a place among
	 * the kept sandboxes when it needs one. A refusal takes nothing and closes nothing: a hold named in
	 * `settle` stays open, and its sandbox may run to the end of it.
	 */
	reserve(now: number, input: ReserveInput): ReserveResult {
		const change = this.sweep(now);
		const own = this.holds.get(input.session) ?? null;
		// The same request again, after an answer that was lost on its way.
		if (own !== null && own.id === input.id) return { ok: true, hold: own, change };

		const day = this.holdDay(now);
		const settled = own !== null && input.settle?.hold === own.id ? this.close(own, input.settle.seconds, now) : null;
		// A hold of its own that the session does not settle was lost with a server: it is counted in full.
		const dropped = own !== null && settled === null ? this.unreported(own, now, "its session took another hold without settling this one, so it is counted in full") : null;
		const closing = settled ?? dropped;

		let grant = this.limits.holdSeconds;
		if (this.limits.dailySeconds !== null) {
			const left = this.limits.dailySeconds - this.usedOn(day) - this.heldOn(day, input.session) - (closing !== null && closing.day === day ? closing.seconds : 0);
			if (left < (input.fresh === true ? this.startSeconds : 1)) return { ok: false, reason: "allowance", change };
			grant = Math.min(grant, left);
		}
		// Asked after the allowance: someone told to free a sandbox must not then be told the day is used up.
		if (input.keep === true && this.atCap(input.session)) return { ok: false, reason: "sandboxes", change };

		// Never past midnight: the hold after this one is the new day's.
		grant = Math.max(1, Math.min(grant, Math.ceil(((day + 1) * DAY_MS - now) / 1000)));
		if (own !== null && closing !== null) {
			this.holds.delete(input.session);
			this.add(closing);
			change.entries.push(closing);
			change.closed.push(own.id);
		}
		if (input.keep === true && !this.claims.has(input.session)) {
			const claim = { session: input.session, since: now };
			this.claims.set(input.session, claim);
			change.kept.push(claim);
		}
		const hold: UsageHold = { id: input.id, session: input.session, day, seconds: grant, startedAt: now, expiresAt: now + (grant + HOLD_GRACE_SECONDS) * 1000 };
		this.holds.set(input.session, hold);
		change.opened.push(hold);
		return { ok: true, hold, change };
	}

	/**
	 * The sandbox stopped: counts what it ran of the hold. A report for a hold that was counted in full
	 * because it came too late gives the difference back, once. `known` is false for a hold this book
	 * has neither open nor counted as unreported, and for a second report: nothing is counted then.
	 */
	settle(now: number, input: { session: string; hold: string; seconds: number }): { known: boolean; entry: UsageEntry | null; change: UsageChange } {
		const change = this.sweep(now);
		const own = this.holds.get(input.session);
		if (own === undefined || own.id !== input.hold) {
			const full = this.entries.find((entry) => entry.kind === "unreported" && entry.hold === input.hold && entry.session === input.session);
			if (full === undefined || this.entries.some((entry) => entry.hold === `${input.hold}${LATE}`)) return { known: false, entry: null, change };
			// Never more than was counted, and never less than nothing: a late report only ever gives back.
			const ran = Number.isFinite(input.seconds) ? Math.min(full.seconds, Math.max(0, Math.round(input.seconds))) : full.seconds;
			const entry: UsageEntry = { day: full.day, session: full.session, hold: `${full.hold}${LATE}`, kind: "corrected", seconds: ran - full.seconds, at: now, note: `its session reported afterwards that the sandbox ran ${ran} s of the ${full.seconds} s that were counted in full` };
			this.add(entry);
			change.entries.push(entry);
			return { known: true, entry, change };
		}
		this.holds.delete(input.session);
		const entry = this.close(own, input.seconds, now);
		this.add(entry);
		change.entries.push(entry);
		change.closed.push(own.id);
		return { known: true, entry, change };
	}

	/** The session's sandbox is gone: its place is free. */
	release(session: string): UsageChange {
		const change = noChange();
		if (this.claims.delete(session)) change.released.push(session);
		return change;
	}

	/**
	 * Holds the claims against the sessions the provider has a sandbox for. A claim without a sandbox is
	 * dropped, unless it was made a moment ago and the sandbox is still being made. A sandbox without a
	 * claim is given one, also past the cap: it exists, and leaving it out would let its user make more.
	 */
	reconcile(now: number, existing: readonly string[]): { added: string[]; dropped: string[]; change: UsageChange } {
		const change = noChange();
		const there = new Set(existing);
		const added: string[] = [];
		const dropped: string[] = [];
		for (const claim of [...this.claims.values()]) {
			if (there.has(claim.session) || now - claim.since < CLAIM_SETTLING_MS) continue;
			this.claims.delete(claim.session);
			change.released.push(claim.session);
			dropped.push(claim.session);
		}
		for (const session of there) {
			if (this.claims.has(session)) continue;
			const claim = { session, since: now };
			this.claims.set(session, claim);
			change.kept.push(claim);
			added.push(session);
		}
		return { added, dropped, change };
	}

	/** Today's numbers. Holds that have run out are still counted as held until `sweep` counts them: the sum is the same. */
	numbers(now: number): UsageNumbers {
		const day = dayOf(now);
		const usedSeconds = this.usedOn(day);
		const heldSeconds = this.heldOn(day);
		const allowance = this.limits.dailySeconds;
		return {
			at: now,
			day: dayName(day),
			resetsAt: (day + 1) * DAY_MS,
			allowanceSeconds: allowance,
			usedSeconds,
			heldSeconds,
			leftSeconds: allowance === null ? null : Math.max(0, allowance - usedSeconds - heldSeconds),
			startSeconds: this.startSeconds,
			sandboxes: { kept: this.claims.size, limit: this.limits.maxKept },
		};
	}

	/** The last `count` days, the oldest first and today last. */
	days(now: number, count = USAGE_HISTORY_DAYS): UsageDay[] {
		const today = dayOf(now);
		return Array.from({ length: count }, (_, index) => {
			const day = today - (count - 1 - index);
			return { day: dayName(day), seconds: this.usedOn(day) };
		});
	}

	/** Today's sandbox time by session, the most first, with what each one's running sandbox holds. `title` is the caller's to fill in. */
	today(now: number): UsageSession[] {
		const day = dayOf(now);
		const rows = new Map<string, UsageSession>();
		const row = (session: string): UsageSession => {
			let found = rows.get(session);
			if (found === undefined) {
				found = { sessionId: session, title: null, seconds: 0, unreportedSeconds: 0, heldSeconds: 0 };
				rows.set(session, found);
			}
			return found;
		};
		const corrected = new Set(this.entries.filter((entry) => entry.kind === "corrected").map((entry) => entry.hold));
		for (const entry of this.entries) {
			if (entry.day !== day) continue;
			const found = row(entry.session);
			found.seconds += entry.seconds;
			if (entry.kind === "unreported" && !corrected.has(`${entry.hold}${LATE}`)) found.unreportedSeconds += entry.seconds;
		}
		for (const hold of this.holds.values()) if (hold.day === day) row(hold.session).heldSeconds += hold.seconds;
		return [...rows.values()].sort((a, b) => b.seconds + b.heldSeconds - (a.seconds + a.heldSeconds) || (a.sessionId < b.sessionId ? -1 : 1));
	}

	/** The entries of a day, in the order they were counted: for a check, and for whoever reads the ledger. */
	entriesOn(day: number): UsageEntry[] {
		return this.entries.filter((entry) => entry.day === day);
	}
}

// ---------------------------------------------------------------------------------------------
// What a session keeps of the time its sandbox runs
// ---------------------------------------------------------------------------------------------

/**
 * A stretch of a sandbox running, as its session keeps it in its stored state: the hold it has now,
 * and since when that hold has been running by the session's own clock. A sandbox runs from `since`
 * of its first hold to the settling of its last; trading one hold for the next moves `since` to the
 * moment of the trade, so every second is in exactly one hold.
 */
export interface OpenStretch {
	hold: string;
	since: number;
	/** How many seconds the hold is for: the session trades it for the next one when they are over. */
	seconds: number;
	/** When the session last saw the sandbox running after the time it would have stopped by itself. */
	seen?: number;
}

/** The seconds of a stretch's hold that ran until `until`. */
export function stretchSeconds(stretch: OpenStretch, until: number): number {
	return Math.max(0, until - stretch.since) / 1000;
}

/**
 * The latest moment a sandbox can have been running that its session finds stopped without having
 * stopped it. A provider that stops an unused sandbox by itself (`idleStopMs`) did so that long after
 * the sandbox was last used; where there is no such timeout, nothing is known but now.
 */
export function stoppedBy(stretch: OpenStretch, lastUsedAt: number, idleStopMs: number | null, now: number): number {
	if (idleStopMs === null) return now;
	return Math.min(now, Math.max(stretch.seen ?? 0, Math.max(stretch.since, lastUsedAt) + idleStopMs));
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

/** A length of sandbox time for a sentence: "2 h", "1 h 50 min", "12 min", "4 min 5 s", "45 s". */
export function spellSeconds(total: number): string {
	const seconds = Math.max(0, Math.round(total));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	if (hours > 0) return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
	// Under ten minutes the seconds matter.
	if (minutes >= 10 || (minutes > 0 && rest === 0)) return `${minutes} min`;
	if (minutes > 0) return `${minutes} min ${rest} s`;
	return `${seconds} s`;
}

/** "It resets at 00:00 UTC, in 5 h 12 min." The day is UTC's, so the hour is said in UTC and as a time from now. */
function resetWords(numbers: Pick<UsageNumbers, "resetsAt" | "at">): string {
	return `The allowance is whole again at 00:00 UTC, in ${spellSeconds(Math.max(60, Math.ceil((numbers.resetsAt - numbers.at) / 60_000) * 60))}.`;
}

/** What a user reads when something that needs sandbox time is refused for the day's allowance: what was used, what the allowance is, and when it is whole again. */
export function allowanceRefusal(numbers: UsageNumbers): string {
	const allowance = spellSeconds(numbers.allowanceSeconds ?? 0);
	const used = spellSeconds(numbers.usedSeconds);
	const held = numbers.heldSeconds > 0 ? spellSeconds(numbers.heldSeconds) : null;
	const left = numbers.leftSeconds ?? 0;
	let said: string;
	if (left > 0) {
		said = `Only ${spellSeconds(left)} of today's ${allowance} of sandbox time is left (${used} used${held === null ? "" : `, ${held} held for sandboxes that are running now`}), which is too little to start with, so nothing was started.`;
	} else if (held === null) {
		said = `Today's ${allowance} of sandbox time is used up, so nothing was started.`;
	} else {
		said = `Today's ${allowance} of sandbox time is all used or held: ${used} used, and ${held} held for sandboxes that are running now. Nothing was started.`;
	}
	// A hold is given back in part when its sandbox stops: worth a try before midnight.
	if (held !== null) said += " What a running sandbox does not use of its hold is free again when it stops.";
	return `${said} ${resetWords(numbers)}`;
}

/** What a user reads when an agent needs a sandbox and they keep as many as they may. */
export function sandboxRefusal(numbers: UsageNumbers): string {
	const limit = numbers.sandboxes.limit ?? numbers.sandboxes.kept;
	return `You keep ${limit} ${limit === 1 ? "sandbox" : "sandboxes"}, the most an account may have, and this agent needs one of its own. Free one on the Usage page, which says what goes with it, or delete an agent you no longer need. Then send this again.`;
}

export const USAGE_UNAVAILABLE = "Your sandbox time could not be checked just now, so nothing was started. Try again in a moment.";

/** The timeline's line when a running turn is stopped because the day's allowance is used up. */
export function turnStoppedNote(numbers: UsageNumbers): string {
	return `Today's ${spellSeconds(numbers.allowanceSeconds ?? 0)} of sandbox time is used up, so this turn was stopped at the end of the time it held. The sandbox is suspended with its files as they are, and the conversation is kept. ${resetWords(numbers)} A prompt after that goes on from here.`;
}

/** The timeline's line when a sandbox that runs with no turn in it is suspended for the same reason. */
export function idleSuspendedNote(numbers: UsageNumbers): string {
	return `Suspended the sandbox: today's ${spellSeconds(numbers.allowanceSeconds ?? 0)} of sandbox time is used up. Its files are kept. ${resetWords(numbers)}`;
}

/** The timeline's line when the user freed the session's sandbox on the usage page. `memory` is null for an agent that has no memory yet. */
export function freedNote(memory: "kept" | "copied" | "lost" | null): string {
	const remembered =
		memory === "lost"
			? " The agent's own memory of the conversation went with it, so it starts the next turn without it."
			: memory === null
				? ""
				: " The agent keeps its memory of the conversation, and is told that the workspace is a new one.";
	return `You freed this agent's sandbox on the Usage page: the files in its workspace are gone. The conversation stays, and the next prompt starts a new sandbox.${remembered}`;
}
