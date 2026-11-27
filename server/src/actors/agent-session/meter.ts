// Sandbox time: holds, the meter, idle suspension and removal of the sandbox.
import { randomBytes } from "node:crypto";
import { UserError } from "rivetkit";
import { describeError } from "../../auth.js";
import { config } from "../../config.js";
import { type HostedSize, HOSTED_SIZE_NAMES } from "../../contract.js";
import { observeSandbox } from "../../sandbox/api.js";
import { stoppedBy, stretchSeconds, hostedLimitsApply, USAGE_UNAVAILABLE, allowanceRefusal, sandboxRefusal, holdDeadline, turnStoppedNote, idleSuspendedNote, UNCHECKED_TURN_NOTE, UNCHECKED_IDLE_NOTE, closingReports, foundStoppedAt } from "../../usage.js";
import { type ReserveAnswer, userActor } from "../internal.js";
import { persist, note } from "./timeline.js";
import { abortTurn, duration } from "./questions.js";
import type { Ctx, SessionMeta, ActiveTurn } from "./state.js";
import { layerOf } from "./runner.js";
import { publish } from "./summary.js";
import { busy, takeSandbox, sandboxChanged } from "./common.js";
import { dropWorkspace } from "./workspace.js";

export function noteSandbox(c: Ctx, meta: SessionMeta, state: SessionMeta["sandbox"], use: string | null = useOf(meta), pausedAt?: number): void {
	// Close only the metered use the state read observed. A new hold may have arrived meanwhile.
	if (state !== "running" && meta.meter && !c.vars.turn && !c.vars.accepting) void closeMeter(c, meta, "found", use, pausedAt);
	if (meta.sandbox === state) return;
	meta.sandbox = state;
	publish(c);
	void persist(c);
}

/** Apply the account's size decision once, even if both the hold and the place claim observe the downgrade. */
export function applySandboxClamp(meta: Pick<SessionMeta, "hostedSize">, size: HostedSize | undefined, notify: (text: string) => void): boolean {
	if (!size || meta.hostedSize === size) return false;
	meta.hostedSize = size;
	notify(`This agent's next sandbox is ${HOSTED_SIZE_NAMES[size]}: Large sandboxes are part of Pro.`);
	return true;
}

// Reading a paused workspace restarts its idle clock.
export function markUsed(c: Ctx, meta: SessionMeta): void {
	if (c.vars.turn) return;
	meta.lastUsedAt = Date.now();
	delete meta.pauseNow;
	armMeter(c, meta);
	void c.keepAwake(armIdle(c, meta));
}

/** How long the user's meter may take to answer before a prompt gives up on it, and a running sandbox goes on without the answer. */
const METER_WAIT_MS = 10_000;
/** How long after a call to the meter that failed, or that found the session in the middle of something, the session looks again. */
const METER_RETRY_MS = 15_000;
/** How long after the moment the provider stops an unused sandbox the session asks whether it did. */
const IDLE_STOP_MARGIN_MS = 3_000;
/** How many reports of sandbox time a session keeps to send again. */
const MAX_UNSETTLED = 20;

// Identify the use by its reservation so a stale stop cannot settle its replacement.
export function useOf(meta: SessionMeta): string | null {
	return meta.meter?.use ?? null;
}

/** Runs `job` after every call to the user's meter queued before it. */
export function metered<T>(c: Ctx, job: () => Promise<T>): Promise<T> {
	const run = c.vars.metering.then(job, job);
	c.vars.metering = run.catch(() => undefined);
	return run;
}

/** `promise`, or a rejection when it takes longer than `ms`. */
function inTime<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

// A carried hold is valid only while its use and sandbox generation still match.
export function carriedOver(c: Ctx, meta: SessionMeta): boolean {
	const carried = c.vars.carried;
	return carried !== null && carried.use === useOf(meta) && carried.gen === c.vars.sandboxGen;
}

// Write the request ID before reserving time. Reuse it if the response is lost. Call only from inside `metered`.
export async function takeHold(c: Ctx, meta: SessionMeta, fresh: boolean, observedUntil?: number): Promise<ReserveAnswer | null> {
	// Reports the book has not had go first: one for a hold it still has open would be counted in full once another is taken.
	if (meta.unsettled?.length) await sendUnsettled(c, meta);
	const open = meta.meter ?? null;
	// The same id, from the same moment, until an answer comes: a request that arrived and whose answer did
	// not is not a second hold, and the stretch goes on in it from when it was asked, not from the retry.
	const asked = meta.meterAsked ?? { id: `h_${randomBytes(8).toString("hex")}`, at: Date.now() };
	const now = asked.at;
	if (!meta.meterAsked) {
		// Stored before it is sent: a sleep, a crash or another node after this still knows what may be open.
		meta.meterAsked = asked;
		await persist(c);
	}
	// A carried hold may have stopped at the provider before this actor woke.
	const until = open && fresh && carriedOver(c, meta) ? stoppedBy(open, meta.lastUsedAt, c.vars.idleStopMs, now) : now;
	let answer: ReserveAnswer;
	try {
		answer = await inTime(
			userActor(c, meta.uid).internalReserve({ id: asked.id, sessionId: meta.sessionId, hostedSize: meta.hostedSize ?? "small", keep: !meta.sandboxId, fresh, settle: open ? { hold: open.hold, seconds: stretchSeconds(open, until), observedUntil } : undefined }),
			METER_WAIT_MS,
		);
	} catch (error) {
		c.log.warn({ msg: "the user's sandbox time could not be asked for", session: meta.sessionId, error: describeError(error) });
		// With nothing running, nothing was started on it: a hold the book may have opened is reported at 0 s before the next is asked for.
		if (!meta.meter && meta.meterAsked === asked) {
			meta.unsettled = [...(meta.unsettled ?? []), { hold: asked.id, seconds: 0 }].slice(-MAX_UNSETTLED);
			meta.meterAsked = null;
			void persist(c);
		}
		return null;
	}
	meta.meterAsked = null;
	void persist(c);
	if (answer.ok) {
		applySandboxClamp(meta, answer.clampedSize, text => note(c, c.vars.turn?.number ?? 0, "info", text));
		// A renewal goes on with the use the hold was for; anything that starts takes a use of its own.
		const use = !fresh && open ? open.use : answer.hold.id;
		meta.meter = { hold: answer.hold.id, since: now, seconds: answer.hold.seconds, use, ...(open?.seen ? { seen: open.seen } : {}) };
		void persist(c);
	}
	return answer;
}

// Acquire time and any new place before starting the sandbox.
export function holdSandbox(c: Ctx, meta: SessionMeta, fresh: boolean, observedUntil?: number): Promise<void> {
	if (!hostedLimitsApply(meta.place)) return Promise.resolve();
	return metered(c, async () => {
		c.vars.idleStopMs = (await layerOf(c, meta)).sandboxes.idleStopMs;
		const answer = await takeHold(c, meta, fresh, observedUntil);
		armMeter(c, meta);
		if (answer === null) throw new UserError(USAGE_UNAVAILABLE, { code: "usage_unavailable" });
		if (answer.ok) return;
		if (answer.reason === "allowance") throw new UserError(allowanceRefusal(answer.numbers), { code: "allowance_used" });
		if (answer.reason === "sandboxes") throw new UserError(sandboxRefusal(answer.numbers), { code: "too_many_sandboxes" });
		throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
	});
}

// Bound renewal by the provider's idle timeout as well as the user's hold.
function armMeter(c: Ctx, meta: SessionMeta, notBefore = 0): void {
	if (c.vars.meterTimer) clearTimeout(c.vars.meterTimer);
	c.vars.meterTimer = null;
	const open = meta.meter;
	if (!open || c.vars.stopping || c.vars.destroying) return;
	let at = open.since + open.seconds * 1000;
	const idleStopMs = c.vars.idleStopMs;
	if (idleStopMs !== null && !c.vars.turn) {
		at = Math.min(at, Math.max(Math.max(open.since, meta.lastUsedAt) + idleStopMs + IDLE_STOP_MARGIN_MS, (open.seen ?? 0) + METER_RETRY_MS));
	}
	c.vars.meterTimer = setTimeout(
		() => {
			// As with the actor's abort signal: RivetKit may have let go of the actor's state by now, and reading it then throws.
			try {
				c.vars.meterTimer = null;
				if (c.vars.stopping || c.vars.destroying || c.vars.meta !== meta) return;
				void c.keepAwake(meterTick(c, meta));
			} catch {
				// The actor is stopping: `onSleep` settles what is open.
			}
		},
		Math.max(0, Math.max(at, notBefore) - Date.now()),
	);
}

// Recheck the observed use after reading the provider. Another operation may have replaced the hold.
function meterTick(c: Ctx, meta: SessionMeta): Promise<void> {
	return metered(c, async () => {
		const open = meta.meter;
		if (!open || c.vars.stopping || c.vars.destroying || c.vars.meta !== meta) return;
		const id = meta.sandboxId;
		const unused = !busy(c);
		const idleStopMs = c.vars.idleStopMs;
		if (id && unused && idleStopMs !== null && Date.now() >= Math.max(open.since, meta.lastUsedAt) + idleStopMs) {
			const gen = c.vars.sandboxGen;
			const read = await layerOf(c, meta)
				.then(({ sandboxes }) => observeSandbox(sandboxes, id))
				.catch(() => null);
			// A sandbox resumed or suspended while it was asked about is not the one the answer describes.
			const observed = c.vars.sandboxGen === gen ? read : null;
			if (observed?.state === "running") open.seen = Date.now();
			else if (observed !== null && !busy(c)) {
				const until = stoppedBy(open, meta.lastUsedAt, idleStopMs, Date.now(), observed.pausedAt);
				await settleStretch(c, meta, until, useOf(meta), observed.pausedAt);
				noteSandbox(c, meta, observed.state);
				void armIdle(c, meta);
				return;
			}
		}
		if (Date.now() < open.since + open.seconds * 1000) {
			armMeter(c, meta);
			return;
		}
		const answer = await takeHold(c, meta, false);
		// Without an answer the sandbox goes on, still counted by the book, until shortly before the hold runs out there; then it stops.
		const deadline = holdDeadline(open.since, open.seconds);
		if (answer !== null && !answer.ok && answer.reason === "allowance") outOfTime(c, meta, turnStoppedNote(answer.numbers), idleSuspendedNote(answer.numbers));
		else if (answer === null && Date.now() >= deadline) {
			console.log(`[wlp] usage.unchecked_stop session=${meta.sessionId}: its sandbox time could not be checked before its hold ran out`);
			outOfTime(c, meta, UNCHECKED_TURN_NOTE, UNCHECKED_IDLE_NOTE);
		} else armMeter(c, meta, answer?.ok ? 0 : Math.min(Date.now() + METER_RETRY_MS, deadline));
	});
}

// Stop the active turn before its sandbox consumes unreserved time.
function outOfTime(c: Ctx, meta: SessionMeta, turnText: string, idleText: string): void {
	const active = c.vars.turn;
	if (active) {
		if (active.outOfTime || active.closed) return;
		active.outOfTime = true;
		note(c, active.number, "warn", turnText);
		console.log(`[wlp] usage.turn_stopped session=${meta.sessionId} turn=${active.number}: its sandbox may not run on`);
		abortTurn(c, meta, active);
		return;
	}
	void c.keepAwake(suspendOutOfTime(c, meta, idleText));
}

// Suspend first so settlement uses the actual pause time when the provider supplies one.
async function suspendOutOfTime(c: Ctx, meta: SessionMeta, text: string | null): Promise<void> {
	const id = meta.sandboxId;
	if (!id || c.vars.stopping || c.vars.destroying) return;
	if (busy(c)) {
		armMeter(c, meta, Date.now() + METER_RETRY_MS);
		return;
	}
	// Set in the same step as the checks above: from here a prompt waits for it.
	const release = takeSandbox(c);
	const work = (async () => {
		const { sandboxes } = await layerOf(c, meta);
		await sandboxes.suspend(id);
		sandboxChanged(c);
		console.log(`[wlp] sandbox.suspended_out_of_time id=${id} session=${meta.sessionId}`);
		meta.sandbox = "paused";
		const use = useOf(meta);
		if (text !== null) note(c, meta.turns, "info", text);
		await closeMeter(c, meta, "now", use);
		publish(c);
		await persist(c);
	})();
	c.vars.idling = work;
	try {
		await work;
	} catch (error) {
		c.log.error({ msg: "could not suspend the sandbox when its user's sandbox time was used up", sandbox: id, error: describeError(error) });
		armMeter(c, meta, Date.now() + METER_RETRY_MS);
	} finally {
		c.vars.idling = null;
		release();
	}
	await armIdle(c, meta);
}

// Keep the settlement until the user's meter acknowledges its idempotent receipt.
// Call only from inside `metered`: it does not take the queue itself.
async function settleStretch(c: Ctx, meta: SessionMeta, until: number, use: string | null, observedUntil?: number): Promise<void> {
	const open = meta.meter;
	if (!open || useOf(meta) !== use) return;
	meta.meter = null;
	if (c.vars.meterTimer) clearTimeout(c.vars.meterTimer);
	c.vars.meterTimer = null;
	// A renewal whose answer never came ends with the stretch it was to continue.
	meta.unsettled = [...(meta.unsettled ?? []), ...closingReports(open, meta.meterAsked ?? null, until, observedUntil)].slice(-MAX_UNSETTLED);
	meta.meterAsked = null;
	void persist(c);
	await sendUnsettled(c, meta);
}

/** Sends the reports the user's actor has not had. One that does not get through stays for the next time. Never throws. */
async function sendUnsettled(c: Ctx, meta: SessionMeta): Promise<void> {
	for (const report of [...(meta.unsettled ?? [])]) {
		try {
			await inTime(userActor(c, meta.uid).internalSettle({ sessionId: meta.sessionId, ...report }), METER_WAIT_MS);
		} catch (error) {
			c.log.warn({ msg: "could not report the sandbox's time to its user; it is reported again when the session is next awake", session: meta.sessionId, hold: report.hold, error: describeError(error) });
			return;
		}
		meta.unsettled = (meta.unsettled ?? []).filter((other) => other !== report);
		void persist(c);
	}
}

// A provider-observed stop can precede the actor's own clock.
export function closeMeter(c: Ctx, meta: SessionMeta, how: "now" | "found", use: string | null, pausedAt?: number): Promise<void> {
	const at = Date.now();
	if (use === null) return Promise.resolve();
	return metered(c, async () => {
		const open = meta.meter;
		if (!open || useOf(meta) !== use) return;
		// The provider's timeout is asked of this session's layer every time: a server that has not asked yet must not count to now.
		const until = how === "now" ? at : foundStoppedAt(open, meta.lastUsedAt, (await layerOf(c, meta)).sandboxes.idleStopMs, at, pausedAt);
		await settleStretch(c, meta, until, use, pausedAt);
	}).catch((error) => {
		c.log.warn({ msg: "could not settle the sandbox's time", session: meta.sessionId, error: describeError(error) });
	});
}

/** The session has no sandbox any more: its place among the sandboxes its user keeps is free. Never throws; a place that is not given back is found when the count is held against the provider's list. */
export async function releasePlace(c: Ctx, meta: SessionMeta): Promise<void> {
	if (!hostedLimitsApply(meta.place)) return;
	await inTime(userActor(c, meta.uid).internalRelease(meta.sessionId), METER_WAIT_MS).catch((error) => {
		c.log.warn({ msg: "could not give the sandbox's place back to its user", session: meta.sessionId, error: describeError(error) });
	});
}

// An idle sandbox that stays running still needs a hold.
export async function meterAfterTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn, use: string | null): Promise<void> {
	try {
		if (!meta.sandboxId || meta.sandbox !== "running") {
			await closeMeter(c, meta, "now", use);
			// A turn that ended without a sandbox, because none could be made, holds no place; unless a prompt that came since is making one.
			if (!meta.sandboxId && !c.vars.turn && !c.vars.accepting && !c.vars.destroying) await releasePlace(c, meta);
		} else if (active.outOfTime) {
			await suspendOutOfTime(c, meta, null);
		} else {
			armMeter(c, meta);
		}
	} catch (error) {
		c.log.warn({ msg: "could not look after the sandbox's time when the turn ended", session: meta.sessionId, error: describeError(error) });
	}
}

// Inspect the provider before charging time that elapsed while the actor slept.
export async function wakeMeter(c: Ctx, meta: SessionMeta, use: string | null): Promise<void> {
	// The sandbox's state was read (`refreshSandbox`): from here the stretch is settled as found, or goes on.
	c.vars.carried = null;
	if (!hostedLimitsApply(meta.place)) return;
	try {
		c.vars.idleStopMs = (await layerOf(c, meta)).sandboxes.idleStopMs;
		const running = meta.sandboxId !== null && meta.sandbox === "running";
		if (use !== null && !running) await closeMeter(c, meta, "found", use);
		else if (meta.meter) armMeter(c, meta);
		else if (running && !busy(c)) {
			const answer = await metered(c, () => takeHold(c, meta, false));
			armMeter(c, meta);
			if (answer !== null && !answer.ok && answer.reason === "allowance") await suspendOutOfTime(c, meta, idleSuspendedNote(answer.numbers));
		}
		await metered(c, () => sendUnsettled(c, meta));
	} catch (error) {
		c.log.warn({ msg: "could not take up the sandbox's time again", session: meta.sessionId, error: describeError(error) });
	}
}

// Reconcile a lost reservation response before a new turn can ask for another hold.
export function settleWokenAsk(c: Ctx, meta: SessionMeta): void {
	const asked = meta.meterAsked;
	if (!asked || meta.meter || (meta.sandboxId !== null && meta.sandbox === "running")) return;
	meta.unsettled = [...(meta.unsettled ?? []), { hold: asked.id, seconds: 0 }].slice(-MAX_UNSETTLED);
	meta.meterAsked = null;
	void persist(c);
}

/** Going to sleep: the timer goes, and a sandbox that was suspended has its stretch settled. One that could not be suspended keeps its hold, which the meter counts by itself. */
export function sleepMeter(c: Ctx, meta: SessionMeta): Promise<void> {
	if (c.vars.meterTimer) clearTimeout(c.vars.meterTimer);
	c.vars.meterTimer = null;
	return meta.sandboxId && meta.sandbox === "running" ? Promise.resolve() : closeMeter(c, meta, "now", useOf(meta));
}

/** The sessions that have settled and given back what they had as they were deleted, so that it is done once. */
const usageLeft = new WeakSet<SessionMeta>();

/** The session is deleted: its sandbox's stretch is settled and its place given back. Never throws. */
export async function leaveUsage(c: Ctx, meta: SessionMeta): Promise<void> {
	if (usageLeft.has(meta)) return;
	usageLeft.add(meta);
	if (c.vars.meterTimer) clearTimeout(c.vars.meterTimer);
	c.vars.meterTimer = null;
	await closeMeter(c, meta, "now", useOf(meta));
	await releasePlace(c, meta);
}

export async function removeSandbox(c: Ctx, meta: SessionMeta, id: string, text: string): Promise<void> {
	const { sandboxes } = await layerOf(c, meta);
	await sandboxes.destroy(id);
	sandboxChanged(c);
	meta.sandboxId = null;
	meta.sandbox = "none";
	const use = useOf(meta);
	meta.cloned = false;
	meta.setupDue = null;
	meta.setupUnfinished = null;
	meta.workDue = null;
	meta.setupOnBase = null;
	meta.snapshotCommit = null;
	await dropWorkspace(c);
	note(c, meta.turns, "info", text);
	await closeMeter(c, meta, "now", use);
	await releasePlace(c, meta);
}

/** How long a check that failed, or found a prompt being accepted, waits before it looks again. */
const IDLE_RETRY_MS = 60_000;

// Never remove a user's machine sandbox merely because this actor was idle.
function removedWhenIdle(meta: SessionMeta): boolean {
	return meta.place.kind === "hosted";
}

/** When the sandbox is next due: to be suspended while it runs, to be removed while it exists. Null when there is none. */
function idleDue(meta: SessionMeta): number | null {
	if (!meta.sandboxId) return null;
	if (meta.sandbox === "running") return meta.lastUsedAt + (meta.pauseNow ? 0 : config.idleSuspendMs);
	return removedWhenIdle(meta) ? meta.lastUsedAt + config.idleDestroyMs : null;
}

// Serialize schedule replacement so an older request cannot cancel a newer idle check.
export function armIdle(c: Ctx, meta: SessionMeta, notBefore = 0): Promise<void> {
	const run = c.vars.arming.then(async () => {
		if (c.vars.destroying || c.vars.meta !== meta) return;
		const due = idleDue(meta);
		const at = due === null ? null : Math.max(due, notBefore);
		const current = meta.idleCheck ?? null;
		// A check whose time has passed was taken by the schedule already. One that was cut off before it set
		// the next (a deploy or a crash while it ran) would otherwise stand for ever, the wake's repair included.
		const armed = current !== null && current.at > Date.now() ? current : null;
		if (armed?.at === at || (armed === null && at === null)) return;
		if (notBefore > 0 && armed !== null && at !== null && armed.at < at) return;
		meta.idleCheck = at === null ? null : { id: await c.schedule.at(at, "internalIdle"), at };
		// Written before the old one is cancelled: a crash in between leaves the old one, which still works.
		await persist(c);
		if (current) await c.schedule.cancel(current.id).catch(() => false);
	});
	c.vars.arming = run.catch((error) => {
		c.log.warn({ msg: "could not schedule the idle check of the sandbox", error: describeError(error) });
	});
	return c.vars.arming;
}

/** The durable schedule's visit: suspends or removes the sandbox when it is due, then sets the next visit. */
export async function idleCheck(c: Ctx, meta: SessionMeta): Promise<void> {
	// A turn in progress, or one waiting on the user's answer, is never cut off: its end sets the next check.
	if (c.vars.turn || meta.status !== "idle") {
		console.log(`[wlp] sandbox.idle_kept session=${meta.sessionId} status=${meta.status}`);
		return;
	}
	// Something has the sandbox (a prompt being accepted, a push, a read of the workspace, a suspend): it
	// is not taken from under it, and the check comes back, since what has it may set none.
	if (busy(c)) {
		console.log(`[wlp] sandbox.idle_busy session=${meta.sessionId}`);
		await armIdle(c, meta, Date.now() + IDLE_RETRY_MS);
		return;
	}
	const id = meta.sandboxId;
	const since = meta.lastUsedAt;
	const now = Date.now();
	const remove = id !== null && removedWhenIdle(meta) && now >= since + config.idleDestroyMs;
	const pauseNow = meta.pauseNow === true;
delete meta.pauseNow;
const suspend = id !== null && !remove && meta.sandbox === "running" && (pauseNow || now >= since + config.idleSuspendMs);
	let retry = 0;
	if (id && (remove || suspend)) {
		// Set in the same step as the checks above: from here a prompt waits for it.
		const release = takeSandbox(c);
		const work = (async () => {
			const { sandboxes } = await layerOf(c, meta);
			if (remove) {
				await removeSandbox(c, meta, id, `Removed the sandbox and its files after ${duration(config.idleDestroyMs)} without use; the next prompt starts a new one.`);
				console.log(`[wlp] sandbox.idle_removed id=${id} session=${meta.sessionId}`);
			} else {
				const state = await sandboxes.state(id);
				if (state === "running") {
					await sandboxes.suspend(id);
					sandboxChanged(c);
					console.log(`[wlp] sandbox.idle_suspended id=${id} session=${meta.sessionId}`);
					meta.sandbox = "paused";
					const use = useOf(meta);
					note(c, meta.turns, "info", pauseNow ? "Paused the sandbox: its turn ended on a question nobody answered. The next prompt resumes it." : `Suspended the sandbox after ${duration(config.idleSuspendMs)} without use; the next prompt resumes it.`);
					await closeMeter(c, meta, "now", use);
				} else {
					// Paused by a sleep, or gone: nothing to suspend, and nothing to say.
					meta.sandbox = state;
					await closeMeter(c, meta, "found", useOf(meta));
				}
			}
			publish(c);
			await persist(c);
		})();
		c.vars.idling = work;
		try {
			await work;
		} catch (error) {
			c.log.error({ msg: remove ? "could not remove the idle sandbox" : "could not suspend the idle sandbox", sandbox: id, error: describeError(error) });
			retry = Date.now() + IDLE_RETRY_MS;
		} finally {
			c.vars.idling = null;
			release();
		}
	}
	await armIdle(c, meta, retry);
}
