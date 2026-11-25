/**
 * The rules of a repository's prepared environments (server/src/environments.ts, server/src/actors/user-environments.ts),
 * on their own: no server, no sandbox. A stand-in user actor with its own database and clock.
 *
 *   cd server && npx tsx ../scripts/environment-check.ts
 *
 * What it holds to: a build is promoted only when setup and every check passed; a failed build keeps the last ready
 * one, which sessions go on using while it is current; a saved setup command, checks or a missed image make it
 * stale; the schedule, pushes (debounced and capped), Rebuild and changes start builds, one at a time; limits and an
 * away or "Never" machine hold a build back as a note, not a failure; and a session without a usable environment
 * starts cold.
 */

import { DatabaseSync } from "node:sqlite";
import type { EnvironmentBuild, MachineSummary, RepositoryCheck, SessionSummary } from "../server/src/contract.js";
import {
	afterChange, afterPush, CHANGE_DEBOUNCE_MS, ENVIRONMENT_SCHEDULE_TABLE, ENVIRONMENT_TABLE, environmentInputs, environmentPlaces, HOSTED, judgeChecks, nextBuild, nextScheduled, nightlyMinute,
	PUSH_CAP_MS, PUSH_DEBOUNCE_MS, readEnvironments, RETRY_MS, stateOf, usable, type EnvironmentRow,
} from "../server/src/environments.js";
import { snapshotPlaces } from "../server/src/snapshot-places.js";
import { edge } from "../server/src/github/events.js";
import { buildResult, environmentsView, nudge, pushed, rebuild, sameSize, saveSchedule, sessionEnvironment, settingsChanged, tick, type BuildRequest, type EnvironmentHost } from "../server/src/actors/user-environments.js";

let failed = 0;
function expect(what: string, ok: boolean, detail: unknown = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail !== "" ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

const HOUR = 3_600_000;
const PROJECT = "github:7101";
const CHECKS: RepositoryCheck[] = [{ name: "test", command: "npm test" }, { name: "types", command: "npm run typecheck", when: ["src/**"] }];
const COMMIT = "a".repeat(40);

// ---- the pure rules -------------------------------------------------------------------------------

const inputs = environmentInputs("npm ci", CHECKS);
const build = (over: Partial<EnvironmentBuild> = {}): EnvironmentBuild => ({ trigger: "rebuild", startedAt: 1000, finishedAt: 2000, commit: COMMIT, image: "sha256:" + "b".repeat(64), ...inputs, profile: "docker-hardened", checks: [], failure: null, snapshot: true, ...over });
const row = (over: Partial<EnvironmentRow> = {}): EnvironmentRow => ({ project: PROJECT, place: HOSTED, attempt: null, ready: null, stale: null, note: null, dueAt: null, dueTrigger: null, firstPush: null, session: null, ...over });

expect("the checks' digest ignores whitespace in the setup command but not a check's change",
	environmentInputs(" npm ci ", CHECKS).setupHash === inputs.setupHash && environmentInputs("npm ci", [CHECKS[0]]).checksHash !== inputs.checksHash);
expect("a ready, current environment is usable", usable(row({ ready: build() }), inputs) && stateOf(row({ ready: build() }), inputs) === "ready");
expect("one built under another setup command is stale and not used", !usable(row({ ready: build() }), environmentInputs("pnpm i", CHECKS)) && stateOf(row({ ready: build() }), environmentInputs("pnpm i", CHECKS)) === "stale");
expect("one validated under other checks is stale and not used", !usable(row({ ready: build() }), environmentInputs("npm ci", [])) && stateOf(row({ ready: build() }), environmentInputs("npm ci", [])) === "stale");
expect("one whose image a session missed is stale and not used", !usable(row({ ready: build(), stale: "image gone" }), inputs) && stateOf(row({ ready: build(), stale: "image gone" }), inputs) === "stale");
expect("a validated build that kept no image (quick setup) is ready but starts sessions cold", !usable(row({ ready: build({ snapshot: false }) }), inputs) && stateOf(row({ ready: build({ snapshot: false }) }), inputs) === "ready");
expect("a running build shows building", stateOf(row({ ready: build(), attempt: build({ startedAt: 3000, finishedAt: null }) }), inputs) === "building");
const failedLater = row({ ready: build(), attempt: build({ startedAt: 3000, finishedAt: 4000, failure: { kind: "code", check: "test", line: "", excerpt: "" } }) });
expect("a failed build after a ready one shows failed, and the ready one stays usable", stateOf(failedLater, inputs) === "failed" && usable(failedLater, inputs));

const judged = judgeChecks([
	{ name: "lint", status: "passed", exitCode: 0, durationMs: 5, output: "", startError: "" },
	{ name: "types", status: "failed", exitCode: 1, durationMs: 9, output: "ERR_PNPM_BAD_PM_VERSION This project is configured to use v9 of pnpm. Your current pnpm is v10.", startError: "" },
	{ name: "test", status: "failed", exitCode: 1, durationMs: 9, output: "1 test failed", startError: "" },
]);
expect("checks are classified: the pnpm mismatch is the environment's, the test failure the code's",
	judged.checks[1].environment === "package_manager" && judged.checks[2].environment === null, judged.checks);
expect("the first check that did not pass is the failure, with its line and the end of its output",
	judged.failure?.kind === "package_manager" && judged.failure.check === "types" && judged.failure.line.includes("ERR_PNPM_BAD_PM_VERSION") && judged.failure.excerpt.includes("pnpm"), judged.failure);
expect("a check that failed on the base commit's code is listed apart", judged.codeFailures.length === 1 && judged.codeFailures[0] === "test");
const red = judgeChecks([{ name: "test", status: "failed", exitCode: 1, durationMs: 1, output: "boom", startError: "" }, { name: "slow", status: "timed_out", exitCode: null, durationMs: 1, output: "", startError: "" }]);
expect("failures of the code alone (main is red) do not keep it from being promoted", red.failure === null && red.codeFailures.join() === "test,slow", red);
expect("a check that could not start is the sandbox's", judgeChecks([{ name: "test", status: "could_not_start", exitCode: null, durationMs: 0, output: "", startError: "no sandbox" }]).failure?.kind === "setup");
expect("all passing is no failure", judgeChecks([{ name: "test", status: "passed", exitCode: 0, durationMs: 1, output: "", startError: "" }]).failure === null);

// Debounce: 10 minutes after the last push, never later than 60 after the first.
let due = afterPush(row(), 0);
expect("a push is due 10 minutes later", due.dueAt === PUSH_DEBOUNCE_MS && due.dueTrigger === "push");
due = afterPush({ ...row(), ...due }, 5 * 60_000);
expect("another push moves it to 10 minutes after itself", due.dueAt === 15 * 60_000 && due.firstPush === 0);
for (let t = 10 * 60_000; t <= 70 * 60_000; t += 5 * 60_000) due = afterPush({ ...row(), ...due }, t);
expect("a stream of pushes still builds within an hour of the first", due.dueAt === PUSH_CAP_MS, due);
const rebuildSoon = afterPush(row({ dueAt: 100, dueTrigger: "rebuild" }), 50);
expect("a push does not delay a Rebuild already due sooner", rebuildSoon.dueAt === 100 && rebuildSoon.dueTrigger === "rebuild");
expect("a change is due 2 minutes after the last save", afterChange(row(), 1000).dueAt === 1000 + CHANGE_DEBOUNCE_MS);

// Schedule: nightly between 01:00 and 05:00 UTC, once a day; 6 and 12 hours; off.
const minute = nightlyMinute("u:" + PROJECT);
expect("the nightly slot is between 01:00 and 05:00 UTC", minute >= 60 && minute < 300);
const day0 = Date.UTC(2026, 10, 23);
const first = nextScheduled(24, 0, "u:" + PROJECT, day0 + 6 * HOUR)!;
expect("never built: the next night's slot", first === day0 + 24 * HOUR + minute * 60_000, new Date(first).toISOString());
expect("built at the slot: the next night's slot, not the same one", nextScheduled(24, first, "u:" + PROJECT, first + 1000) === first + 24 * HOUR);
expect("every 6 hours", nextScheduled(6, 1000, "x", 2000) === 1000 + 6 * HOUR);
expect("off schedules nothing", nextScheduled(0, 0, "x", 2000) === null);

// Places: where the repository's work ran lately, allowed, at most three.
const now = 100 * 86_400_000;
const places = environmentPlaces([
	{ place: HOSTED, name: "here", snapshots: true, online: true, featuresLimited: false, lastUsed: now - 1000 },
	{ place: "m1", name: "m1", snapshots: true, online: true, featuresLimited: true, lastUsed: now - 10 },
	{ place: "m2", name: "m2", snapshots: true, online: false, featuresLimited: false, lastUsed: now - 20 },
	{ place: "m3", name: "m3", snapshots: true, online: true, featuresLimited: false, lastUsed: now - 30 * 86_400_000 },
	{ place: "m4", name: "m4", snapshots: false, online: true, featuresLimited: false, lastUsed: now - 5 },
	{ place: "m5", name: "m5 (When named)", snapshots: true, online: true, featuresLimited: true, lastUsed: now - 6 },
], now);
expect("only places used lately, that keep snapshots and that features may use freely (not When named or Never)", JSON.stringify(places.map(p => p.place)) === JSON.stringify(["m2", HOSTED]), places.map(p => p.place));

// One build at a time; Rebuild before other asked-for builds, those before the schedule.
const running = row({ place: "m1", session: "s_1", attempt: build({ finishedAt: null, startedAt: now - 1000 }) });
expect("nothing starts while a build runs", nextBuild([running, row({ dueAt: 0, dueTrigger: "rebuild" })], [], now) === null);
expect("a build lost for two hours no longer holds the rest", nextBuild([row({ place: "m1", session: "s_1", attempt: build({ finishedAt: null, startedAt: now - 3 * HOUR }) }), row({ dueAt: 0, dueTrigger: "push" })], [], now)?.trigger === "push");
expect("Rebuild goes first", nextBuild([row({ place: "a", dueAt: 1, dueTrigger: "push" }), row({ place: "b", dueAt: 5, dueTrigger: "rebuild" })], [{ project: PROJECT, place: "c", trigger: "schedule" }], now)?.place === "b");
expect("an asked-for build goes before the schedule", nextBuild([row({ place: "a", dueAt: 1, dueTrigger: "change" })], [{ project: PROJECT, place: "c", trigger: "schedule" }], now)?.place === "a");

// Pushes: only the default branch moving builds, not another branch or a deletion; a merge into it does too.
const repo = { id: 7101, default_branch: "main" }, installation = { id: 5 };
const push = (ref: string, deleted = false) => edge("push", { ref, after: "d".repeat(40), deleted, repository: repo, installation }, { slug: "windlass" });
expect("a push to the default branch is taken", push("refs/heads/main")?.event === "push");
expect("a push to another branch, or deleting the default one, is not", push("refs/heads/feature") === null && push("refs/heads/main", true) === null);
const merged = edge("pull_request", { action: "closed", number: 3, pull_request: { number: 3, merged: true, head: { sha: "e".repeat(40) }, base: { ref: "main" } }, repository: repo, installation }, { slug: "windlass" });
expect("a pull request merged into the default branch counts as a push", merged?.event === "pull_request" && merged.data.toDefault === true);

// ---- the user actor's side, with a stand-in host ---------------------------------------------------

function database(): EnvironmentHost["db"] {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(ENVIRONMENT_TABLE);
	sqlite.exec(ENVIRONMENT_SCHEDULE_TABLE);
	sqlite.exec("CREATE TABLE setup_command (project TEXT PRIMARY KEY, label TEXT, command TEXT NOT NULL, updated_at INTEGER)");
	return {
		async execute<Row extends Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> {
			return sqlite.prepare(query).all(...(args as Array<string | number | null>)) as Row[];
		},
	} as unknown as EnvironmentHost["db"];
}

interface Stand { host: EnvironmentHost; started: BuildRequest[]; removed: string[]; clock: { now: number }; saved: { command: string; checks: RepositoryCheck[]; secrets: number }; refuse: string | null; machines: MachineSummary[]; watched: string[] }

function stand(): Stand {
	const db = database();
	const clock = { now: Date.UTC(2026, 10, 23, 12) };
	const saved = { command: "npm ci", checks: CHECKS, secrets: 0 };
	const started: BuildRequest[] = [], removed: string[] = [], watched: string[] = [];
	const sessions: SessionSummary[] = [
		{ id: "s_a", place: { kind: "hosted" }, profile: "docker-hardened", harness: "windlass", repository: { id: 7101 }, updatedAt: clock.now - HOUR } as unknown as SessionSummary,
		{ id: "s_b", place: { kind: "machine", machineId: "m_box" }, profile: "docker-hardened", harness: "windlass", repository: { id: 7101 }, updatedAt: clock.now - 2 * HOUR, item: { id: "i_1" } } as unknown as SessionSummary,
	];
	const s: Stand = { started, removed, clock, saved, refuse: null, watched, machines: [{ machineId: "m_box", name: "box", status: "online", orchestrator: "yes" } as unknown as MachineSummary], host: null as unknown as EnvironmentHost };
	let n = 0;
	s.host = {
		db, uid: "u_1", now: () => clock.now,
		sessions: () => sessions,
		machines: async () => s.machines,
		dependenciesChanged: async () => false,
		saved: async () => ({ ...saved, defaults: { screenshots: true, profile: null, model: null, updatedAt: null }, label: "acme/harbor" }),
		snapshots: { hosted: true, machines: true },
		hostedUserMax: null,
		startBuild: async (request) => {
			if (s.refuse) throw new Error(s.refuse);
			started.push(request);
			return `s_env_${++n}`;
		},
		removeSession: async (id) => { removed.push(id); },
		watchPushes: async (repo) => { watched.push(repo); },
		arm: async () => undefined,
	};
	void db.execute("INSERT INTO setup_command (project, label, command, updated_at) VALUES (?, 'acme/harbor', 'npm ci', 1)", PROJECT);
	return s;
}

const passed = (over: Partial<EnvironmentBuild> = {}) => ({ finishedAt: null, commit: COMMIT, image: "sha256:" + "c".repeat(64), checks: [{ name: "test", status: "passed" as const, exitCode: 0, durationMs: 3, environment: null }], failure: null, snapshot: true, ...over });
const failedBuild = { ...passed(), snapshot: false, failure: { kind: "package_manager" as const, check: "types", line: "ERR_PNPM_BAD_PM_VERSION", excerpt: "ERR_PNPM_BAD_PM_VERSION…" } };

async function run(): Promise<void> {
	{
		const db = database();
		await db.execute("CREATE TABLE snapshot_place (project TEXT, place TEXT, updated_at INTEGER, connected_at INTEGER, saved_at INTEGER)");
		await db.execute("CREATE TABLE repo_secret (project TEXT)");
		await db.execute("INSERT INTO setup_command VALUES (?, '', 'npm ci', 1)", PROJECT);
		for (const place of [HOSTED, "m1"]) await db.execute("INSERT INTO snapshot_place VALUES (?, ?, 1, 2, ?)", PROJECT, place, Date.now() - HOUR);
		expect("both placement hints use the existing retention by default", (await snapshotPlaces(db, PROJECT, 2)).join() === "hosted,m1");
		expect("short hosted retention expires only the hosted placement hint", (await snapshotPlaces(db, PROJECT, 2, HOUR / 2)).join() === "m1");
	}
	// Rebuild, one place at a time, promoted on a pass.
	{
		const s = stand();
		await rebuild(s.host, PROJECT);
		expect("Rebuild starts one build, hosted first (used most lately)", s.started.length === 1 && s.started[0].place === HOSTED && s.started[0].trigger === "rebuild", s.started);
		expect("the build session watches pushes to the repository", s.watched.includes("7101"));
		const rows = await readEnvironments(s.host.db, PROJECT);
		expect("both places are due; the other waits its turn", rows.length === 2 && rows.find(r => r.place === "m_box")?.dueTrigger === "rebuild");
		await buildResult(s.host, "s_env_1", passed());
		expect("a pass promotes it, and its session is deleted", (await readEnvironments(s.host.db, PROJECT)).find(r => r.place === HOSTED)?.ready?.commit === COMMIT && s.removed.includes("s_env_1"));
		expect("the next due build starts when one ends; an item's place builds the screenshots image", s.started.length === 2 && s.started[1].place === "m_box" && s.started[1].screenshots === true && s.started[0].screenshots === false, s.started);
		const told = await sessionEnvironment(s.host, PROJECT, HOSTED, "npm ci", CHECKS);
		expect("a session at the place is told it may start from it", told?.usable === true && told.commit === COMMIT && told.checks === 1);

		// A failed build keeps the last ready one.
		await buildResult(s.host, "s_env_2", passed());
		s.clock.now += HOUR;
		await rebuild(s.host, PROJECT, HOSTED);
		await buildResult(s.host, `s_env_${s.started.length}`, failedBuild);
		const after = (await readEnvironments(s.host.db, PROJECT)).find(r => r.place === HOSTED)!;
		expect("a failed build is recorded, and the ready one is kept and still used", after.attempt?.failure?.kind === "package_manager" && after.ready?.commit === COMMIT && (await sessionEnvironment(s.host, PROJECT, HOSTED, "npm ci", CHECKS))?.usable === true);
		const view = await environmentsView(s.host, PROJECT);
		const hosted = view.environments.find(e => e.place === HOSTED)!;
		expect("the Settings view shows failed, the failing check and the last ready build", hosted.state === "failed" && hosted.attempt?.failure?.check === "types" && hosted.ready?.commit === COMMIT, hosted);

		// Stale on a change of setup or checks; rebuilt 2 minutes after the save.
		s.saved.command = "pnpm install --frozen-lockfile";
		await settingsChanged(s.host, PROJECT);
		expect("a new setup command makes it stale: sessions start cold", (await sessionEnvironment(s.host, PROJECT, HOSTED, s.saved.command, CHECKS))?.usable === false);
		const changed = (await readEnvironments(s.host.db, PROJECT)).find(r => r.place === HOSTED)!;
		expect("and builds again after the debounce", changed.dueTrigger === "change" && changed.dueAt === s.clock.now + CHANGE_DEBOUNCE_MS);
		expect("the view says why it is stale", (await environmentsView(s.host, PROJECT)).environments.find(e => e.place === HOSTED)?.note?.includes("setup command") === true);
	}

	// A quick setup validates once. Cold items, identical settings and code-only merges leave it alone.
	{
		const s = stand();
		s.host.snapshots.hosted = false;
		const machineRow = async () => (await readEnvironments(s.host.db, PROJECT)).find(r => r.place === "m_box")!;
		await rebuild(s.host, PROJECT, "m_box");
		await buildResult(s.host, "s_env_1", passed({ snapshot: false }));
		await nudge(s.host, PROJECT, "m_box", "cold");
		await settingsChanged(s.host, PROJECT);
		expect("unchanged validated inputs with no image do not queue another build", (await machineRow()).dueAt === null);
		await pushed(s.host, PROJECT);
		s.clock.now += PUSH_DEBOUNCE_MS;
		await tick(s.host);
		expect("a code-only push needs no build", s.started.length === 1 && (await machineRow()).dueAt === null);
		s.host.dependenciesChanged = async (repo, since) => repo === "7101" && since === COMMIT;
		await pushed(s.host, PROJECT);
		s.clock.now += PUSH_DEBOUNCE_MS;
		await tick(s.host);
		expect("changed dependency inputs start a build", s.started.length === 2 && s.started[1].trigger === "push");
		await buildResult(s.host, "s_env_2", { waiting: "Waiting for a free slot." });
		const waiting = await machineRow();
		expect("waiting releases the session and keeps the ready environment", waiting.session === null && waiting.ready?.commit === COMMIT && waiting.dueAt === s.clock.now + RETRY_MS && s.removed.includes("s_env_2"));
		s.clock.now += RETRY_MS;
		await tick(s.host);
		expect("the deferred build retries", s.started.length === 3 && s.started[2].trigger === "push");
		await buildResult(s.host, "s_env_3", passed());
		await saveSchedule(s.host, PROJECT, 6);
		s.host.dependenciesChanged = async () => false;
		await pushed(s.host, PROJECT);
		s.clock.now += 6 * HOUR;
		await tick(s.host);
		expect("a code-only push still allows a due scheduled refresh", s.started.length === 4 && s.started[3].trigger === "schedule");
	}

	// Hosted sizes: an image starts only sandboxes of its own size, so the record keeps the size its build was made in.
	{
		const s = stand();
		const sessions = s.host.sessions();
		(sessions[0] as { hostedSize?: string }).hostedSize = "large";
		const startBuild = s.host.startBuild;
		s.host.startBuild = async (request) => {
			const id = await startBuild(request);
			sessions.push({ id, place: { kind: "hosted" }, profile: request.profile, harness: "windlass", repository: { id: 7101 }, updatedAt: s.clock.now, environmentBuild: {}, hostedSize: request.hostedSize } as unknown as SessionSummary);
			return id;
		};
		await rebuild(s.host, PROJECT, HOSTED);
		expect("a hosted build asks for the size of the repository's latest session there", s.started[0]?.hostedSize === "large", s.started);
		await buildResult(s.host, "s_env_1", passed());
		const ready = (await readEnvironments(s.host.db, PROJECT)).find(r => r.place === HOSTED)?.ready;
		expect("the record keeps the size the build was made in", ready?.hostedSize === "large", ready);
		expect("a session of that size may start from it; one of another size starts cold",
			(await sessionEnvironment(s.host, PROJECT, HOSTED, "npm ci", CHECKS, "large"))?.usable === true && (await sessionEnvironment(s.host, PROJECT, HOSTED, "npm ci", CHECKS, "small"))?.usable === false);
		await nudge(s.host, PROJECT, HOSTED, "missed", "small");
		expect("a session of another size that started cold does not make the environment stale", (await readEnvironments(s.host.db, PROJECT)).find(r => r.place === HOSTED)?.stale === null);
		expect("a record without a size is small's, as is a session without one", (await sessionEnvironment(s.host, PROJECT, "m_box", "npm ci", CHECKS)) === undefined && sameSize({}, undefined) && sameSize({}, "small") && !sameSize({}, "standard"));
	}

	// A red main: promoted, with the checks that failed on its code.
	{
		const s = stand();
		await rebuild(s.host, PROJECT, HOSTED);
		await buildResult(s.host, "s_env_1", { ...passed(), codeFailures: ["test"] });
		const view = (await environmentsView(s.host, PROJECT)).environments.find(e => e.place === HOSTED)!;
		expect("checks failing on main's code still promote it, and the record names them", view.state === "ready" && view.ready?.codeFailures?.[0] === "test" && (await sessionEnvironment(s.host, PROJECT, HOSTED, "npm ci", CHECKS))?.usable === true, view);
	}
	{
		const s = stand();
		s.machines = [{ ...s.machines[0], orchestrator: "named" } as unknown as MachineSummary];
		let refused = "";
		await rebuild(s.host, PROJECT, "m_box").catch((e: Error) => { refused = e.message; });
		expect("a machine on When named gets no environment", refused !== "" && !(await environmentsView(s.host, PROJECT)).places.some(p => p.place === "m_box"));
	}

	// A missed image (the place's image changed, or the store evicted it) makes it stale and builds again.
	{
		const s = stand();
		await rebuild(s.host, PROJECT, HOSTED);
		await buildResult(s.host, "s_env_1", passed());
		await nudge(s.host, PROJECT, HOSTED, "missed");
		const r = (await readEnvironments(s.host.db, PROJECT)).find(x => x.place === HOSTED)!;
		expect("an image change is stale, not used, and rebuilt", r.stale !== null && !usable(r, environmentInputs("npm ci", CHECKS)) && r.dueTrigger === "image");
		expect("a missed image is stale even after a failed build", stateOf({ ...r, attempt: build({ startedAt: Date.now() * 2, failure: { kind: "code", check: "test", line: "", excerpt: "" } }) }, environmentInputs("npm ci", CHECKS)) === "stale");
	}

	// Limits and an away machine hold a build back as a note, retried later; never a failure.
	{
		const s = stand();
		s.refuse = "Your sandbox time for today is used up.";
		await rebuild(s.host, PROJECT, HOSTED);
		const r = (await readEnvironments(s.host.db, PROJECT)).find(x => x.place === HOSTED)!;
		expect("a limit is a note, retried in 30 minutes, and records no failed build", r.note === s.refuse && r.dueAt === s.clock.now + RETRY_MS && r.attempt === null, r);
		s.refuse = null;
		s.machines = [{ ...s.machines[0], status: "offline" } as MachineSummary];
		await rebuild(s.host, PROJECT, "m_box");
		const m = (await readEnvironments(s.host.db, PROJECT)).find(x => x.place === "m_box")!;
		expect("an away machine waits, with a note", m.note?.includes("connect") === true && m.attempt === null, m);
		s.machines = [{ ...s.machines[0], status: "online", orchestrator: "never" } as unknown as MachineSummary];
		let refused = "";
		await rebuild(s.host, PROJECT, "m_box").catch((e: Error) => { refused = e.message; });
		expect("a machine whose owner chose Never is refused", refused !== "" && !s.started.some(b => b.place === "m_box"));
		expect("nor is it listed as a place for one", !(await environmentsView(s.host, PROJECT)).places.some(p => p.place === "m_box"));
	}
	{
		const s = stand();
		s.host = { ...s.host, hostedUserMax: 1 };
		await s.host.db.execute("INSERT INTO environment (project, place, ready) VALUES (?, ?, ?)", "github:9999", HOSTED, JSON.stringify(build()));
		await rebuild(s.host, PROJECT, HOSTED);
		const r = (await readEnvironments(s.host.db, PROJECT)).find(x => x.place === HOSTED)!;
		expect("E2B's per-user count: one more repository would evict another's, so it waits", s.started.length === 0 && r.note?.includes("per user") === true, r);
	}
	{
		const s = stand();
		s.saved.secrets = 1;
		let refused = "";
		await rebuild(s.host, PROJECT).catch((e: Error) => { refused = e.message; });
		expect("a repository with secrets has no environment", refused.includes("secrets") && !(await environmentsView(s.host, PROJECT)).available);
	}

	// Triggers: push (debounced), the schedule, a cold start.
	{
		const s = stand();
		await pushed(s.host, PROJECT);
		expect("a push starts nothing at once", s.started.length === 0);
		s.clock.now += PUSH_DEBOUNCE_MS;
		await tick(s.host);
		expect("it builds once the pushes settle", s.started.length === 1 && s.started[0].trigger === "push");
	}
	{
		const s = stand();
		await saveSchedule(s.host, PROJECT, 6);
		await tick(s.host);
		expect("a schedule builds a place that never built", s.started.length === 1 && s.started[0].trigger === "schedule");
		await buildResult(s.host, "s_env_1", passed());
		await buildResult(s.host, "s_env_2", passed());
		const second = s.started.length;
		await tick(s.host);
		expect("each place once, and not again until it is due", second === 2 && s.started.length === 2, s.started.map(b => b.place));
		await saveSchedule(s.host, PROJECT, 0);
		s.clock.now += 7 * HOUR;
		const before = s.started.length;
		await tick(s.host);
		expect("off builds nothing on a schedule", s.started.length === before);
	}
	{
		const s = stand();
		await s.host.db.execute("DELETE FROM setup_command");
		s.saved.command = "";
		expect("no setup command: no schedule by default, and no environment", (await environmentsView(s.host, PROJECT)).schedule === 0 && !(await environmentsView(s.host, PROJECT)).available);
	}
	{
		const s = stand();
		expect("no environment yet: a session is told nothing, so it starts cold", (await sessionEnvironment(s.host, PROJECT, HOSTED, "npm ci", CHECKS)) === undefined);
		await nudge(s.host, PROJECT, HOSTED, "cold");
		const r = (await readEnvironments(s.host.db, PROJECT)).find(x => x.place === HOSTED);
		expect("a cold start asks for a build at its place", r?.dueTrigger === "first_use");
	}
	{
		const s = stand();
		await rebuild(s.host, PROJECT, HOSTED);
		await buildResult(s.host, "s_env_1", { ...passed(), snapshot: false, failure: { kind: "save", check: null, line: "no room", excerpt: "" } });
		expect("checks that pass but an image the store refused (its caps) is not ready", (await sessionEnvironment(s.host, PROJECT, HOSTED, "npm ci", CHECKS)) === undefined);
	}

	console.log(failed ? `\n${failed} failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
}

void run();
