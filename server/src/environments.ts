/**
 * A repository's prepared environments (docs/github-and-repositories.md, "A repository's prepared environment"):
 * one record per user, repository and place, built by a hidden session that runs the setup command and every
 * saved check, and promoted only when all of them pass.
 *
 * The record has two parts. `attempt` is the latest build; `ready` the last one that passed. A build that fails
 * never touches `ready`, and saves no image, so the snapshot store keeps the last ready image. A session starts
 * from a prepared sandbox only while `ready` is current: built under today's setup command and checks, and not
 * marked stale by a session that missed its image (`stale`).
 *
 * This file has no actor in it: the `user` actor hands its database to these functions, as repository-checks.ts.
 */

import type { RawAccess } from "rivetkit/db";
import type { CheckStatus, EnvironmentBuild, EnvironmentCheckResult, EnvironmentFailureKind, EnvironmentPlace, EnvironmentSchedule, EnvironmentState, EnvironmentTrigger, RepositoryCheck, RepositoryEnvironment } from "./contract.js";
import { environmentFailure, outputExcerpt } from "./factory/check-environment.js";
import { windlassChecks } from "./repository-checks.js";
import { digest } from "./sandbox/snapshot-key.js";

export const ENVIRONMENT_TABLE = "CREATE TABLE IF NOT EXISTS environment (project TEXT NOT NULL, place TEXT NOT NULL, attempt TEXT, ready TEXT, stale TEXT, note TEXT, due_at INTEGER, due_trigger TEXT, first_push INTEGER, session TEXT, PRIMARY KEY (project, place))";
export const ENVIRONMENT_SCHEDULE_TABLE = "CREATE TABLE IF NOT EXISTS environment_schedule (project TEXT PRIMARY KEY, hours INTEGER NOT NULL)";

/** A push builds this long after the last push, and never later than PUSH_CAP_MS after the first. */
export const PUSH_DEBOUNCE_MS = 10 * 60_000;
export const PUSH_CAP_MS = 60 * 60_000;
/** A saved setup command or checks builds again this long after the last save. */
export const CHANGE_DEBOUNCE_MS = 2 * 60_000;
/** A repository gets an environment where its sessions ran within this long, at most at MAX_PLACES places. */
export const RECENT_USE_MS = 14 * 86_400_000;
export const MAX_PLACES = 3;
/** A build that has not reported in this long is taken as lost (its session went), and the next may start. */
export const BUILD_LOST_MS = 2 * 60 * 60_000;
export const INTERRUPTION_RETRY_MS = 90_000;
const MAX_BUILD_RETRIES = 2;
/** A build refused for a limit is tried again no sooner than this. */
export const RETRY_MS = 30 * 60_000;
/** Nightly builds start between these UTC hours, at a time picked from the user and repository. */
const NIGHT_START_HOUR = 1;
const NIGHT_HOURS = 4;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const HOSTED: EnvironmentPlace = "hosted";

/** The digests a record is compared to: today's setup command and checks. */
export interface EnvironmentInputs { setupHash: string; checksHash: string }

export function environmentInputs(command: string, checks: readonly RepositoryCheck[]): EnvironmentInputs {
	return { setupHash: digest(["setup", command.trim()]), checksHash: digest(["checks", windlassChecks(checks)]) };
}

export interface EnvironmentRow {
	project: string;
	place: EnvironmentPlace;
	attempt: EnvironmentBuild | null;
	ready: EnvironmentBuild | null;
	/** Why `ready` may not be used though its digests match: a session missed its image at the place. */
	stale: string | null;
	/** Why the next build waits (a limit, the machine away); shown, never a failure. */
	note: string | null;
	/** A build asked for (push, change, rebuild, image) and when it is due. */
	dueAt: number | null;
	dueTrigger: EnvironmentTrigger | "retry" | null;
	/** The first push of a run of pushes, for PUSH_CAP_MS. */
	firstPush: number | null;
	/** The build session running now, if any. */
	session: string | null;
}

export function sameInputs(build: EnvironmentInputs | null, inputs: EnvironmentInputs): boolean {
	return build?.setupHash === inputs.setupHash && build.checksHash === inputs.checksHash;
}

/** Whether a session at the record's place may start from its ready image. */
export function usable(row: Pick<EnvironmentRow, "ready" | "stale"> | undefined, inputs: EnvironmentInputs): boolean {
	const ready = row?.ready;
	return !!ready && ready.snapshot && row.stale === null && sameInputs(ready, inputs);
}

export function stateOf(row: EnvironmentRow, inputs: EnvironmentInputs): EnvironmentState {
	if (row.attempt && row.attempt.finishedAt === null) return "building";
	if (row.attempt?.interrupted && sameInputs(row.attempt, inputs)) return row.dueAt === null ? "interrupted" : "retrying";
	// Its image is gone from the place: whatever the last build said, sessions start cold until one is saved again.
	if (row.ready && row.stale !== null) return "stale";
	// A failure under settings that have changed since says nothing of today's: the record is stale then.
	const failedLater = row.attempt?.failure && (!row.ready || row.attempt.startedAt > row.ready.startedAt)
		&& row.attempt.setupHash === inputs.setupHash && row.attempt.checksHash === inputs.checksHash;
	if (failedLater) return "failed";
	if (!row.ready) return "stale";
	return row.stale === null && row.ready.setupHash === inputs.setupHash && row.ready.checksHash === inputs.checksHash ? "ready" : "stale";
}

/** Why a ready environment is stale, in words; null when it is not. */
export function staleReason(row: EnvironmentRow, inputs: EnvironmentInputs): string | null {
	if (!row.ready) return "Not built yet.";
	if (row.stale !== null) return row.stale;
	if (row.ready.setupHash !== inputs.setupHash) return "The setup command changed since it was built.";
	if (row.ready.checksHash !== inputs.checksHash) return "The checks changed since it was validated.";
	return null;
}

/** The schedule a repository has when none was chosen: nightly with a setup command, off without. */
export function defaultSchedule(command: string): EnvironmentSchedule {
	return command.trim() === "" ? 0 : 24;
}

/** The UTC minute of the day nightly builds of this user's repository start at, spread over the night. */
export function nightlyMinute(seed: string): number {
	return NIGHT_START_HOUR * 60 + (parseInt(digest(["night", seed]).slice(0, 8), 16) % (NIGHT_HOURS * 60));
}

/**
 * When the schedule next builds, given the last build's start (0: never). Nightly: the first night slot after a
 * day since the last build less a slot's slack, so a build the day before at the slot does not skip a night.
 * Every 6 or 12 hours: that long after the last. Null when off.
 */
export function nextScheduled(hours: EnvironmentSchedule, lastStart: number, seed: string, now: number): number | null {
	if (hours === 0) return null;
	if (hours !== 24) return lastStart === 0 ? now : lastStart + hours * HOUR;
	const minute = nightlyMinute(seed);
	const earliest = lastStart === 0 ? now : lastStart + DAY - 2 * HOUR;
	const midnight = Math.floor(earliest / DAY) * DAY;
	const slot = midnight + minute * 60_000;
	return slot >= earliest ? slot : slot + DAY;
}

/** A push: due PUSH_DEBOUNCE_MS after it, but no later than PUSH_CAP_MS after the first of the run. */
export function afterPush(row: Pick<EnvironmentRow, "dueAt" | "dueTrigger" | "firstPush">, now: number): Pick<EnvironmentRow, "dueAt" | "dueTrigger" | "firstPush"> {
	const first = row.dueTrigger === "push" && row.firstPush !== null && row.dueAt !== null ? row.firstPush : now;
	// A build asked for sooner for another reason (Rebuild, a change) keeps its time and covers the push.
	if (row.dueAt !== null && row.dueTrigger !== "push" && row.dueAt <= now + PUSH_DEBOUNCE_MS) return { dueAt: row.dueAt, dueTrigger: row.dueTrigger, firstPush: row.firstPush };
	return { dueAt: Math.min(now + PUSH_DEBOUNCE_MS, first + PUSH_CAP_MS), dueTrigger: "push", firstPush: first };
}

/** A change of setup or checks: due CHANGE_DEBOUNCE_MS after the last save. A Rebuild due sooner stays. */
export function afterChange(row: Pick<EnvironmentRow, "dueAt" | "dueTrigger">, now: number): Pick<EnvironmentRow, "dueAt" | "dueTrigger"> {
	if (row.dueTrigger === "rebuild" && row.dueAt !== null && row.dueAt <= now) return row;
	return { dueAt: now + CHANGE_DEBOUNCE_MS, dueTrigger: "change" };
}

/** What a place offers for a build: whether one can run there now, and why not. */
export interface PlaceFacts {
	place: EnvironmentPlace;
	name: string;
	/** The deployment keeps prepared sandboxes for this place (`snapshotsFor`). */
	snapshots: boolean;
	/** A machine: its runner is connected on the signed protocol. */
	online: boolean;
	/** A machine whose owner chose When named or Never under "Let features use it": only machines features may use freely get environments. */
	featuresLimited: boolean;
	/** When the repository's sessions or items last ran here; 0 for never. */
	lastUsed: number;
}

/** The places a repository gets environments: where its work ran lately, that allow them, most recent first. */
export function environmentPlaces(places: readonly PlaceFacts[], now: number, existing: readonly EnvironmentPlace[] = []): PlaceFacts[] {
	return places
		.filter(p => p.snapshots && !p.featuresLimited && (now - p.lastUsed < RECENT_USE_MS || existing.includes(p.place)))
		.sort((a, b) => b.lastUsed - a.lastUsed || (a.place < b.place ? -1 : 1))
		.slice(0, MAX_PLACES);
}

/** Why a build may not start at a place now (a limit, the machine away); null when it may. */
export function placeRefusal(place: PlaceFacts, hosted: { userEnvironments: number; userMax: number | null }, project: string, hostedProjects: readonly string[]): string | null {
	if (!place.snapshots) return "This deployment keeps no prepared sandboxes here.";
	if (place.featuresLimited) return `The owner of ${place.name} chose When named or Never under "Let features use it".`;
	if (place.place !== HOSTED && !place.online) return `Waiting for ${place.name} to connect.`;
	// E2B keeps a few snapshots per user and evicts the oldest past them: one more repository would evict another's.
	if (place.place === HOSTED && hosted.userMax !== null && !hostedProjects.includes(project) && hosted.userEnvironments >= hosted.userMax)
		return `This platform keeps ${hosted.userMax} prepared sandboxes per user, and yours are in use by other repositories.`;
	return null;
}

/** A due build: the record, and why. */
export interface DueBuild { project: string; place: EnvironmentPlace; trigger: EnvironmentTrigger | "retry" }

/**
 * The next build to start, or null. One runs at a time: none while a build is running and not lost. Asked-for
 * builds (Rebuild first, then the oldest due) go before scheduled ones.
 */
export function nextBuild(rows: readonly EnvironmentRow[], scheduled: readonly DueBuild[], now: number): DueBuild | null {
	if (rows.some(r => r.attempt?.finishedAt === null && now - r.attempt.startedAt < BUILD_LOST_MS)) return null;
	const asked = rows.filter(r => r.dueAt !== null && r.dueAt <= now && r.dueTrigger !== null)
		.sort((a, b) => Number(b.dueTrigger === "rebuild") - Number(a.dueTrigger === "rebuild") || a.dueAt! - b.dueAt!);
	if (asked[0]) {
		const { project, place, dueTrigger } = asked[0];
		// A code-only push can be skipped, but a scheduled refresh at that place still runs.
		const refresh = dueTrigger === "push" && scheduled.find(d => d.project === project && d.place === place);
		return refresh || { project, place, trigger: dueTrigger! };
	}
	return scheduled[0] ?? null;
}

/** The soonest time anything is due, for the alarm; null when nothing is. */
export function nextWake(rows: readonly EnvironmentRow[], scheduledAt: readonly number[]): number | null {
	const deadlines = rows.flatMap(r => r.attempt?.finishedAt === null ? [r.attempt.startedAt + BUILD_LOST_MS] : []);
	if (deadlines.length) return Math.min(...deadlines);
	const times = [...rows.flatMap(r => r.dueAt !== null ? [r.dueAt] : []), ...scheduledAt];
	return times.length ? Math.min(...times) : null;
}

// --- a build's result ---------------------------------------------------------------------------

/** One check as the build ran it (sandbox/platform-checks.ts `PlatformCheckResult`). */
export interface RanCheck { name: string; status: CheckStatus; exitCode: number | null; durationMs: number; output: string; startError: string }

/**
 * What a build's checks say: each with its classification. Only the sandbox's own problems keep it from being
 * promoted: a check check-environment.ts says the sandbox could not run, or one that could not start. The first such
 * is the failure. A check that ran and failed on the base commit's code (main is red) is in `codeFailures`: the
 * environment is still promoted, and says so. Null failure: promotable.
 */
export function judgeChecks(ran: readonly RanCheck[]): { checks: EnvironmentCheckResult[]; failure: EnvironmentBuild["failure"]; codeFailures: string[] } {
	let failure: EnvironmentBuild["failure"] = null;
	const codeFailures: string[] = [];
	const checks = ran.map(r => {
		const env = r.status === "passed" ? null : environmentFailure({ status: r.status, exitCode: r.exitCode, output: r.output, ...(r.startError ? { startError: r.startError } : {}) });
		const sandbox = env !== null || r.startError !== "" || r.status === "could_not_start" || r.status === "interrupted";
		if (r.status !== "passed" && !sandbox) codeFailures.push(r.name);
		if (!failure && r.status !== "passed" && sandbox) {
			const kind: EnvironmentFailureKind = env?.kind ?? "setup";
			const line = env?.line ?? (r.startError || "It could not be run.");
			failure = { kind, check: r.name, line, excerpt: outputExcerpt(r.output) };
		}
		return { name: r.name, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, environment: env?.kind ?? null };
	});
	return { checks, failure, codeFailures };
}

/** A newer push, settings change or Rebuild already queued gets its own retry budget. */
export function interruptBuild(row: EnvironmentRow, attempt: EnvironmentBuild, now: number): EnvironmentRow {
	const retry = row.dueAt === null && (attempt.retries ?? 0) < MAX_BUILD_RETRIES;
	return { ...row, session: null, note: null, attempt: { ...attempt, finishedAt: now, interrupted: true },
		...(retry && { dueTrigger: "retry", dueAt: now + INTERRUPTION_RETRY_MS }) };
}

/** The record after a build ended: promoted when it passed, else only the attempt changes. */
export function finishBuild(row: EnvironmentRow, build: EnvironmentBuild): EnvironmentRow {
	const ended = { ...build, finishedAt: build.finishedAt ?? Date.now() };
	const passed = ended.failure === null;
	return { ...row, session: null, note: null, attempt: ended, ...(passed ? { ready: ended, stale: null } : {}) };
}

/** Words for a failure, for the Settings section and logs. */
export function failureWords(failure: NonNullable<EnvironmentBuild["failure"]>): string {
	const which = failure.check ? `"${failure.check}"` : "setup";
	switch (failure.kind) {
		case "package_manager": return `The sandbox could not run ${which}: its package manager is not the one the repository pins.`;
		case "network": return `The sandbox could not run ${which}: a tool could not be fetched over the network.`;
		case "not_found": return `The sandbox could not run ${which}: the command was not found.`;
		case "setup": return failure.check ? `${which} could not start.` : "The setup command failed.";
		case "clone": return "The repository could not be cloned.";
		case "save": return "The checks passed, but the prepared sandbox could not be saved here.";
		case "code": return `${which} failed on the base commit's code.`;
	}
}

// --- the table ----------------------------------------------------------------------------------

type Stored = { project: string; place: string; attempt: string | null; ready: string | null; stale: string | null; note: string | null; due_at: number | null; due_trigger: string | null; first_push: number | null; session: string | null };

const parse = (text: string | null): EnvironmentBuild | null => {
	if (!text) return null;
	try { return JSON.parse(text) as EnvironmentBuild; } catch { return null; }
};

function rowOf(s: Stored): EnvironmentRow {
	return { project: s.project, place: s.place, attempt: parse(s.attempt), ready: parse(s.ready), stale: s.stale, note: s.note, dueAt: s.due_at, dueTrigger: s.due_trigger as EnvironmentRow["dueTrigger"], firstPush: s.first_push, session: s.session };
}

export async function readEnvironments(db: Pick<RawAccess, "execute">, project?: string): Promise<EnvironmentRow[]> {
	const rows = project === undefined
		? await db.execute<Stored>("SELECT * FROM environment ORDER BY project, place")
		: await db.execute<Stored>("SELECT * FROM environment WHERE project = ? ORDER BY place", project);
	return rows.map(rowOf);
}

export function emptyRow(project: string, place: EnvironmentPlace): EnvironmentRow {
	return { project, place, attempt: null, ready: null, stale: null, note: null, dueAt: null, dueTrigger: null, firstPush: null, session: null };
}

export async function writeEnvironment(db: Pick<RawAccess, "execute">, row: EnvironmentRow): Promise<void> {
	await db.execute("INSERT OR REPLACE INTO environment (project, place, attempt, ready, stale, note, due_at, due_trigger, first_push, session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		row.project, row.place, row.attempt && JSON.stringify(row.attempt), row.ready && JSON.stringify(row.ready), row.stale, row.note, row.dueAt, row.dueTrigger, row.firstPush, row.session);
}

export async function readSchedule(db: Pick<RawAccess, "execute">, project: string): Promise<EnvironmentSchedule | null> {
	const [row] = await db.execute<{ hours: number }>("SELECT hours FROM environment_schedule WHERE project = ?", project);
	return row && [0, 6, 12, 24].includes(row.hours) ? row.hours as EnvironmentSchedule : null;
}

/** The view of one record for the Settings section. */
export function environmentView(row: EnvironmentRow, inputs: EnvironmentInputs, placeName: string, nextAt: number | null): RepositoryEnvironment {
	const state = stateOf(row, inputs);
	const newer = row.attempt && (!row.ready || row.attempt.startedAt > row.ready.startedAt) ? row.attempt : null;
	return { place: row.place, placeName, state, ready: row.ready, attempt: newer, note: row.note ?? (state === "stale" ? staleReason(row, inputs) : null), nextAt: row.dueAt ?? nextAt };
}
