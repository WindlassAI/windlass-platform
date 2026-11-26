/**
 * The `user` actor's side of prepared environments (environments.ts): what starts a build, the one build that runs
 * at a time, what a build's result does to the record, and what a session is told of its place's environment.
 *
 * It holds no actor of its own: the user actor hands it an `EnvironmentHost` with its database, its sessions and
 * machines, and the two things only the actor can do, make a build's hidden session and delete it. That keeps
 * every rule here checkable with a stand-in host (scripts/environment-check.ts).
 */

import { config } from "../config.js";
import { itemScreenshots, type EnvironmentBuildReport } from "./internal.js";
import type { RawAccess } from "rivetkit/db";
import type { EnvironmentBuild, EnvironmentPlace, EnvironmentSchedule, EnvironmentTrigger, HostedSize, MachineSummary, RepositoryCheck, RepositoryDefaults, RepositoryEnvironments, SandboxProfileId, SessionSummary } from "../contract.js";
import { resolveRun, type RunSettings } from "../factory/resolve-run.js";
import { machineLabel } from "../contract.js";
import {
	afterChange, afterPush, emptyRow, environmentInputs, environmentPlaces, environmentView, finishBuild, interruptBuild, HOSTED, nextBuild, nextScheduled, nextWake, placeRefusal, readEnvironments, readSchedule, sameInputs,
	BUILD_LOST_MS, INTERRUPTION_RETRY_MS, RETRY_MS, usable, writeEnvironment, defaultSchedule, type DueBuild, type EnvironmentRow, type PlaceFacts,
} from "../environments.js";

type Db = Pick<RawAccess, "execute">;

/** What is saved for a repository that a build depends on. */
export interface SavedInputs { command: string; checks: RepositoryCheck[]; secrets: number; defaults: RepositoryDefaults; account?: RunSettings; deployment?: RunSettings; label: string }

export interface BuildRequest { project: string; place: EnvironmentPlace; profile: SandboxProfileId; screenshots: boolean; trigger: EnvironmentTrigger; repositoryId: string; /** Hosted: the size the build's sandbox is asked for (`makeSession` holds it to the sizes offered). */ hostedSize?: HostedSize }

/**
 * Whether a hosted environment was built in a session's size. A sandbox's image starts only sandboxes of its own size
 * (e2b/snapshots.ts keys it by template), and one recorded without a size, or a session without one, is small: the
 * only size there was before sizes, and the only one where the deployment offers one.
 */
export function sameSize(built: Pick<EnvironmentBuild, "hostedSize"> | null | undefined, session: HostedSize | undefined): boolean {
	return (built?.hostedSize ?? "small") === (session ?? "small");
}

function matchesImage(ready: EnvironmentBuild, place: EnvironmentPlace, hostedSize: HostedSize | undefined, screenshots: boolean): boolean {
	return (ready.screenshots === true) === screenshots && (place !== HOSTED || sameSize(ready, hostedSize));
}

/** A known refusal before the build turn began (for example a sandbox quota). */
export class BuildStartRefused extends Error {}

export interface EnvironmentHost {
	db: Db;
	uid: string;
	now(): number;
	sessions(): SessionSummary[];
	machines(): Promise<MachineSummary[]>;
	saved(project: string): Promise<SavedInputs>;
	dependenciesChanged(repositoryId: string, since: string): Promise<boolean>;
	/** Whether the deployment keeps prepared sandboxes hosted, and on machines (`snapshotsFor`). */
	snapshots: { hosted: boolean; machines: boolean };
	/** E2B's WLP_E2B_SNAPSHOT_USER_MAX where hosted sandboxes are E2B; null where the store caps bytes, not count. */
	hostedUserMax: number | null;
	/** Makes the hidden session. The row records its id before the turn is handed to it. */
	createBuild(request: BuildRequest): Promise<string>;
	runBuild(session: string): Promise<void>;
	removeSession(id: string): Promise<void>;
	/** Asks to be told of pushes to the repository's default branch (github-repository.ts). Never throws. */
	watchPushes(repositoryId: string): Promise<void>;
	/** Wakes `tick` at this time. */
	arm(at: number): Promise<void>;
}

const repoOf = (project: string) => project.slice("github:".length);
const placeOf = (s: SessionSummary): EnvironmentPlace => s.place.kind === "hosted" ? HOSTED : s.place.machineId;

/** The places a repository's own work ran, with each one's facts. */
export async function placeFacts(host: EnvironmentHost, project: string): Promise<PlaceFacts[]> {
	const repo = repoOf(project);
	const used = new Map<EnvironmentPlace, number>();
	for (const s of host.sessions()) {
		if (s.environmentBuild || String(s.repository?.id ?? "") !== repo) continue;
		used.set(placeOf(s), Math.max(used.get(placeOf(s)) ?? 0, s.updatedAt));
	}
	const machines = await host.machines();
	return [
		{ place: HOSTED, name: "Hosted", snapshots: host.snapshots.hosted, online: true, featuresLimited: false, lastUsed: used.get(HOSTED) ?? 0 },
		...machines.map(m => ({ place: m.machineId, name: `‘${machineLabel(m)}’`, snapshots: host.snapshots.machines, online: m.status === "online", featuresLimited: (m.orchestrator ?? "yes") !== "yes", lastUsed: used.get(m.machineId) ?? 0 })),
	];
}

/** Why a repository can have no environment at all; null when it can. */
function unavailable(host: EnvironmentHost, saved: SavedInputs): string | null {
	if (!host.snapshots.hosted && !host.snapshots.machines) return "This deployment keeps no prepared sandboxes.";
	if (saved.command.trim() === "") return "Save a setup command first: an environment is what it prepares.";
	if (saved.secrets > 0) return "Not available for repositories with saved secrets.";
	return null;
}

async function scheduleOf(host: EnvironmentHost, project: string, command: string): Promise<{ hours: EnvironmentSchedule; chosen: boolean }> {
	const chosen = await readSchedule(host.db, project);
	return chosen === null ? { hours: defaultSchedule(command), chosen: false } : { hours: chosen, chosen: true };
}

/** The projects with a setup command: every one that may have environments. */
async function projects(host: EnvironmentHost): Promise<string[]> {
	const rows = await host.db.execute<{ project: string }>("SELECT project FROM setup_command WHERE command != '' UNION SELECT project FROM environment");
	return rows.map(r => r.project);
}

/** The scheduled builds due now, and when each project's next one is. */
async function scheduled(host: EnvironmentHost, rows: EnvironmentRow[]): Promise<{ due: DueBuild[]; at: number[] }> {
	const now = host.now(), due: DueBuild[] = [], at: number[] = [];
	for (const project of await projects(host)) {
		const saved = await host.saved(project);
		if (unavailable(host, saved)) continue;
		const { hours } = await scheduleOf(host, project, saved.command);
		const kept = rows.filter(r => r.project === project);
		for (const place of environmentPlaces(await placeFacts(host, project), now, kept.map(r => r.place))) {
			const row = kept.find(r => r.place === place.place);
			if ((row?.note || row?.dueTrigger === "retry") && row.dueAt !== null && row.dueAt > now) continue; // Honor a deferred build’s retry time.
			const when = nextScheduled(hours, row?.attempt?.startedAt ?? 0, host.uid + ":" + project, now);
			if (when === null) continue;
			if (when <= now) due.push({ project, place: place.place, trigger: "schedule" });
			else at.push(when);
		}
	}
	return { due, at };
}

async function rowFor(host: EnvironmentHost, project: string, place: EnvironmentPlace): Promise<EnvironmentRow> {
	return (await readEnvironments(host.db, project)).find(r => r.place === place) ?? emptyRow(project, place);
}

async function rearm(host: EnvironmentHost): Promise<void> {
	const rows = await readEnvironments(host.db);
	const { at } = await scheduled(host, rows);
	const wake = nextWake(rows, at);
	if (wake !== null) await host.arm(Math.max(wake, host.now()));
}

async function buildSandbox(host: EnvironmentHost, project: string, place: EnvironmentPlace, saved: SavedInputs) {
	const latest = host.sessions()
		.filter(s => !s.environmentBuild && String(s.repository?.id ?? "") === repoOf(project) && placeOf(s) === place && (s.harness ?? "windlass") === "windlass")
		.sort((a, b) => b.updatedAt - a.updatedAt)[0];
	const allowed = config.factory.screenshots && saved.defaults.screenshots;
	const machine = place !== HOSTED && (await host.machines()).find(m => m.machineId === place);
	const deployment = { ...saved.deployment, machineProfile: machine ? machine.profiles?.find(p => p.available)?.id : undefined };
	const run = resolveRun({ deployment, account: saved.account, repository: saved.defaults,
		item: { place: place === HOSTED ? "hosted" : { machine: place } } }, "environment");
	const profile = run.profile;
	if (!profile) return null;
	return { profile, screenshots: latest ? itemScreenshots(latest.item, latest.harness, allowed) : allowed,
		...(place === HOSTED && (run.sources.size !== "deployment" || deployment.hostedSize) && { hostedSize: run.size }) };
}

/**
 * Starts the next due build, if one may run. Called by the alarm, and after anything that makes one due. A build
 * refused for a limit or an away machine is noted on its record and tried again RETRY_MS later; never a failure.
 */
export async function tick(host: EnvironmentHost): Promise<DueBuild | null> {
	const now = host.now();
	await sweepLostBuilds(host);
	const fresh = await readEnvironments(host.db);
	const { due } = await scheduled(host, fresh);
	const next = nextBuild(fresh, due, now);
	if (next) await start(host, next);
	await rearm(host);
	return next;
}

/** Recover an overdue attempt even if the server stopped before it armed the build deadline. */
async function sweepLostBuilds(host: EnvironmentHost): Promise<void> {
	const now = host.now();
	for (const row of await readEnvironments(host.db)) {
		if (row.attempt?.finishedAt !== null) continue;
		if (now < row.attempt.startedAt + BUILD_LOST_MS && host.sessions().some(s => s.id === row.session)) continue;
		await writeEnvironment(host.db, interruptBuild(row, row.attempt, now));
		if (row.session) await host.removeSession(row.session).catch(() => undefined);
	}
}

export async function wakeEnvironments(host: EnvironmentHost): Promise<void> {
	await sweepLostBuilds(host);
	const at = nextWake(await readEnvironments(host.db), []);
	if (at !== null) await host.arm(Math.max(host.now(), at));
}

async function start(host: EnvironmentHost, due: DueBuild): Promise<void> {
	const now = host.now();
	const row = await rowFor(host, due.project, due.place);
	const saved = await host.saved(due.project);
	const retry = due.trigger === "retry";
	const trigger = due.trigger === "retry" ? row.attempt!.trigger : due.trigger;
	const later = async (note: string, delay = RETRY_MS) => writeEnvironment(host.db, { ...row, note, dueAt: now + delay, dueTrigger: due.trigger });
	const none = unavailable(host, saved);
	if (none) {
		await writeEnvironment(host.db, { ...row, note: none, dueAt: null, dueTrigger: null, firstPush: null });
		return;
	}
	const facts = (await placeFacts(host, due.project)).find(p => p.place === due.place);
	const hostedProjects = (await readEnvironments(host.db)).filter(r => r.place === HOSTED && r.ready).map(r => r.project);
	const refusal = facts ? placeRefusal(facts, { userEnvironments: hostedProjects.length, userMax: host.hostedUserMax }, due.project, hostedProjects) : "That machine is not yours any more.";
	if (refusal) return later(refusal, retry && facts && !facts.online ? INTERRUPTION_RETRY_MS : RETRY_MS);
	const sandbox = await buildSandbox(host, due.project, due.place, saved);
	if (!sandbox) return later("Choose an available sandbox profile for this environment.");
	const inputs = environmentInputs(saved.command, saved.checks);
	// Compare the tree after pushes settle with the one whose setup and checks ran.
	if (due.trigger === "push" && row.attempt?.commit && sameInputs(row.attempt, inputs)) {
		let changed: boolean;
		try { changed = await host.dependenciesChanged(repoOf(due.project), row.attempt.commit); }
		catch { return later("Waiting to read the repository’s environment inputs."); }
		if (!changed) {
			// A newer push or settings change may have arrived during the GitHub read.
			await host.db.execute("UPDATE environment SET due_at = NULL, due_trigger = NULL, first_push = NULL, note = NULL WHERE project = ? AND place = ? AND due_trigger = 'push' AND due_at = ?", row.project, row.place, row.dueAt);
			return;
		}
	}
	let attempt: EnvironmentBuild = { trigger, ...(retry && { retries: (row.attempt?.retries ?? 0) + 1 }), startedAt: now, finishedAt: null, commit: "", image: "", ...inputs, profile: sandbox.profile, checks: [], failure: null, snapshot: false };
	let session: string;
	try {
		session = await host.createBuild({ project: due.project, place: due.place, ...sandbox, trigger, repositoryId: repoOf(due.project) });
	} catch (error) {
		// The user's running-agent limit, daily sandbox time, a full machine: the same refusals any session gets.
		console.log(`[wlp] environment.waiting uid=${host.uid} project=${due.project} place=${due.place}: ${error instanceof Error ? error.message.slice(0, 200) : "refused"}`);
		return later(error instanceof Error ? error.message.slice(0, 300) : "The build could not start.");
	}
	// The size the build's session was made in, as makeSession held it to what is offered: what sessions are matched against.
	const made = host.sessions().find(s => s.id === session)?.hostedSize;
	if (made) attempt = { ...attempt, hostedSize: made };
	const running = { ...row, attempt, session, note: null, dueAt: null, dueTrigger: null, firstPush: null };
	await host.arm(now + BUILD_LOST_MS);
	await writeEnvironment(host.db, running);
	try {
		await host.runBuild(session);
	} catch (error) {
		if (error instanceof BuildStartRefused) await later(error.message);
		else await writeEnvironment(host.db, interruptBuild(running, attempt, host.now()));
		await host.removeSession(session).catch(() => undefined);
		return;
	}
	console.log(`[wlp] environment.started session=${session} trigger=${due.trigger}`);
	await host.watchPushes(repoOf(due.project));
}

/** A build's session reports how it ended. Promoted only when every check passed; the session is then deleted. */
export async function buildResult(host: EnvironmentHost, sessionId: string, result: EnvironmentBuildReport): Promise<boolean> {
	const row = (await readEnvironments(host.db)).find(r => r.session === sessionId);
	if (!row?.attempt) return false;
	if ("interrupted" in result) {
		await writeEnvironment(host.db, interruptBuild(row, row.attempt, host.now()));
	} else if ("waiting" in result && row.attempt.retries) {
		// No slot was granted: put the same retry back, without spending it.
		await writeEnvironment(host.db, { ...row, session: null, note: result.waiting,
			attempt: { ...row.attempt, retries: row.attempt.retries - 1, interrupted: true, finishedAt: host.now() },
			dueAt: row.dueAt ?? host.now() + RETRY_MS, dueTrigger: row.dueTrigger ?? "retry" });
	} else if ("waiting" in result) {
		await writeEnvironment(host.db, { ...row, session: null, attempt: row.ready, note: result.waiting,
			dueAt: host.now() + RETRY_MS, dueTrigger: row.dueTrigger === "rebuild" ? "rebuild" : row.attempt.trigger });
	} else {
		await writeEnvironment(host.db, finishBuild(row, { ...row.attempt, ...result, finishedAt: result.finishedAt ?? host.now() }));
	}
	await host.removeSession(sessionId).catch(() => undefined);
	await tick(host);
	return "failure" in result && result.failure === null;
}

/** A push to the repository's default branch: each of its environments builds once the pushes settle. */
export async function pushed(host: EnvironmentHost, project: string): Promise<void> {
	const saved = await host.saved(project);
	if (unavailable(host, saved)) return;
	const kept = await readEnvironments(host.db, project);
	const places = environmentPlaces(await placeFacts(host, project), host.now(), kept.map(r => r.place));
	for (const place of places) {
		const row = kept.find(r => r.place === place.place) ?? emptyRow(project, place.place);
		await writeEnvironment(host.db, { ...row, ...afterPush(row, host.now()) });
	}
	await rearm(host);
}

/** The setup command or the checks were saved: every environment of the repository is stale and builds again. */
export async function settingsChanged(host: EnvironmentHost, project: string): Promise<void> {
	const saved = await host.saved(project);
	const kept = await readEnvironments(host.db, project);
	if (unavailable(host, saved)) {
		for (const row of kept) await writeEnvironment(host.db, { ...row, dueAt: null, dueTrigger: null, firstPush: null });
		return;
	}
	const places = environmentPlaces(await placeFacts(host, project), host.now(), kept.map(r => r.place)).map(p => p.place);
	const inputs = environmentInputs(saved.command, saved.checks);
	for (const place of new Set([...kept.map(r => r.place), ...places])) {
		const row = kept.find(r => r.place === place) ?? emptyRow(project, place);
		if (sameInputs(row.attempt, inputs)) continue;
		await writeEnvironment(host.db, { ...row, ...afterChange(row, host.now()) });
	}
	await rearm(host);
}

/** Rebuild: now, at one place or at each the repository has. Throws with a sentence fit to show. */
export async function rebuild(host: EnvironmentHost, project: string, place?: EnvironmentPlace): Promise<void> {
	const saved = await host.saved(project);
	const none = unavailable(host, saved);
	if (none) throw new Error(none);
	const kept = await readEnvironments(host.db, project);
	const facts = await placeFacts(host, project);
	const places = place !== undefined ? [place] : [...new Set([...kept.map(r => r.place), ...environmentPlaces(facts, host.now()).map(p => p.place)])];
	if (place !== undefined && !facts.some(p => p.place === place && p.snapshots && !p.featuresLimited)) throw new Error("An environment cannot be built there.");
	if (!places.length) throw new Error("Run an agent on this repository first, so the platform knows where to build its environment.");
	for (const p of places) {
		const row = kept.find(r => r.place === p) ?? emptyRow(project, p);
		await writeEnvironment(host.db, { ...row, note: null, dueAt: host.now(), dueTrigger: "rebuild", firstPush: null });
	}
	await tick(host);
}

/**
 * A session at a place found what its record says: `missed`, the ready image was not there (the place's image
 * changed, or the store evicted it), so it is stale and builds again; `cold`, it started cold where the repository
 * has no environment yet, so one is built.
 */
export async function nudge(host: EnvironmentHost, project: string, place: EnvironmentPlace, kind: "missed" | "cold", hostedSize?: HostedSize, screenshots = false): Promise<void> {
	const saved = await host.saved(project);
	if (unavailable(host, saved)) return;
	const row = await rowFor(host, project, place);
	// A different image variant or hosted size starts cold and leaves the ready build available to matching sessions.
	if (row.ready && !matchesImage(row.ready, place, hostedSize, screenshots)) return;
	if (kind === "missed") {
		if (!row.ready || row.stale !== null) return;
		await writeEnvironment(host.db, { ...row, stale: "Its prepared image is no longer at this place: the image changed or was removed.", dueAt: row.dueAt ?? host.now() + 60_000, dueTrigger: row.dueTrigger ?? "image" });
	} else {
		if (row.session !== null || row.dueAt !== null || (row.stale === null && sameInputs(row.ready, environmentInputs(saved.command, saved.checks)))) return;
		// One that failed is not tried again for every cold start: its schedule, a push or Rebuild builds it.
		if ((row.attempt?.failure || row.attempt?.interrupted) && (!row.ready || row.attempt.startedAt > row.ready.startedAt)) return;
		await writeEnvironment(host.db, { ...row, dueAt: host.now() + 60_000, dueTrigger: "first_use" });
	}
	await rearm(host);
}

/** What a session at a place is told: whether it may start from the ready image, and of what. */
export async function sessionEnvironment(host: Pick<EnvironmentHost, "db">, project: string, place: EnvironmentPlace, command: string, checks: RepositoryCheck[], hostedSize?: HostedSize, screenshots = false): Promise<{ usable: boolean; commit: string; validatedAt: number; checks: number } | undefined> {
	const row = (await readEnvironments(host.db, project)).find(r => r.place === place);
	if (!row?.ready) return undefined;
	return { usable: usable(row, environmentInputs(command, checks)) && matchesImage(row.ready, place, hostedSize, screenshots), commit: row.ready.commit, validatedAt: row.ready.finishedAt ?? row.ready.startedAt, checks: row.ready.checks.length };
}

/** The Settings section's view. */
export async function environmentsView(host: EnvironmentHost, project: string): Promise<RepositoryEnvironments> {
	const saved = await host.saved(project);
	const none = unavailable(host, saved);
	const { hours, chosen } = await scheduleOf(host, project, saved.command);
	const inputs = environmentInputs(saved.command, saved.checks);
	const facts = await placeFacts(host, project);
	const kept = await readEnvironments(host.db, project);
	const name = (place: string) => facts.find(f => f.place === place)?.name ?? "A removed machine";
	const environments = kept.filter(r => r.attempt || r.ready || r.dueAt !== null).map(r => {
		const next = nextScheduled(hours, r.attempt?.startedAt ?? 0, host.uid + ":" + project, host.now());
		return environmentView(r, inputs, name(r.place), none ? null : next);
	});
	const places = facts.filter(f => f.snapshots && !f.featuresLimited && !environments.some(e => e.place === f.place)).map(f => ({ place: f.place, placeName: f.name }));
	return { available: none === null, unavailableReason: none, schedule: hours, scheduleChosen: chosen, environments, places: none ? [] : places };
}

export async function saveSchedule(host: EnvironmentHost, project: string, hours: EnvironmentSchedule): Promise<void> {
	await host.db.execute("INSERT OR REPLACE INTO environment_schedule (project, hours) VALUES (?, ?)", project, hours);
	await rearm(host);
}

/** Everything of a repository goes with its saved settings (`forgetRepository`). */
export async function forgetEnvironments(host: Pick<EnvironmentHost, "db" | "removeSession">, project: string): Promise<void> {
	for (const row of await readEnvironments(host.db, project)) if (row.session) await host.removeSession(row.session).catch(() => undefined);
	await host.db.execute("DELETE FROM environment WHERE project = ?", project);
	await host.db.execute("DELETE FROM environment_schedule WHERE project = ?", project);
}
