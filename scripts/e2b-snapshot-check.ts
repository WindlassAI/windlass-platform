/**
 * The check of hosted E2B setup snapshots (server/src/sandbox/e2b/snapshots.ts) and of the snapshot
 * bonus in placement (server/src/factory/placement.ts).
 *
 *   cd server && npx tsx ../scripts/e2b-snapshot-check.ts              # on the in-memory E2B: no account, no network
 *   cd server && npx tsx ../scripts/e2b-snapshot-check.ts --docker     # and the disk check run in the sandbox image
 *   cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-snapshot-check.ts --live
 *
 * The fake run covers the rules: the switch, the cache key and names, a cold writer's save, a later
 * session starting from it, another user never getting it, a template rebuild, stale generations, the
 * audit's refusals, E2B refusing a filesystem snapshot, the caps, expiry, a record that does not fit, a
 * second server reading the record, dropping, and placement.
 *
 * `--live` runs one save and one start from it at E2B with the template the deployment uses: two
 * sandboxes, one after the other, under a deployment label of this run's own, never longer than four
 * minutes (WLP_E2B_CHECK_LIMIT_MS caps it lower). It prints what Windlass's data directory and /tmp held
 * before the save, how long the save and the start took, and what the sandboxes' running time costs at
 * E2B's published prices. Whatever happens, `finally` kills both sandboxes and deletes the run's snapshots.
 * Exit code 0 when every check passed, 1 when one failed, 2 without a key for --live.
 */

import { snapshotsFor } from "../server/src/config.js";
import { choosePlacement, SNAPSHOT_BONUS } from "../server/src/factory/placement.js";
import type { PlanSubtask } from "../server/src/contract.js";
import { digest, DEFERRED_INPUTS, type SnapshotSelection } from "../server/src/sandbox/snapshot-key.js";
import type { E2bClient } from "../server/src/sandbox/e2b/client.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../server/src/sandbox/hosted-settings.js";
import { type E2bSettings, readE2bSettings } from "../server/src/sandbox/e2b/config.js";
import { FakeE2b, ScriptedMachine } from "../server/src/sandbox/e2b/fake.js";
import { describeUsage } from "../server/src/sandbox/e2b/pricing.js";
import { type E2bSandboxHandle, e2bSandboxes, META } from "../server/src/sandbox/e2b/sandboxes.js";
import { AUDIT_SCRIPT, E2bSnapshots, RECORD_PATH, SNAP_META } from "../server/src/sandbox/e2b/snapshots.js";
import { DATA_DIR, randomId } from "../server/src/sandbox/provider.js";
import { docker, IMAGE } from "../server/src/sandbox/docker.js";

const live = process.argv.includes("--live");
/** --docker: also runs the disk check for real, as root in a throwaway container of the sandbox image. */
const withDocker = process.argv.includes("--docker");
let passes = 0;
let failures = 0;
function expect(name: string, ok: boolean, detail = ""): boolean {
	const text = detail.trim().replace(/\s*\n\s*/g, " | ");
	if (ok) { passes += 1; console.log(`PASS  ${name}${text ? `  (${text})` : ""}`); }
	else { failures += 1; console.log(`FAIL  ${name}  ${text || "condition not met"}`); }
	return ok;
}
const sections = process.env.WLP_CHECK_SECTIONS?.split(",");
const selected = (name: string) => !sections || sections.some(prefix => name.startsWith(prefix));

async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (!selected(name)) return;
	console.log(`\n== ${name}`);
	try { await body(); }
	catch (error) { failures += 1; console.log(`FAIL  ${name}: unexpected error  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`); }
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const SETTINGS: E2bSettings = {
	...readE2bSettings({}),
	deployment: "snapcheck",
	maxRunning: 50,
	snapshots: { ...DEFAULT_SNAPSHOT_LIMITS },
};
const GEN = digest(["generation", 1]);
const INPUTS = digest(["inputs", 1]);
const COMMIT = "c".repeat(40);
const attempt = () => randomId(16);
const request = (over: Partial<SnapshotSelection> = {}): SnapshotSelection => ({ repo: "42", generation: GEN, inputs: INPUTS, attempt: attempt(), writer: true, ...over });

/** What a sandbox of the template answers to the provider's own commands; `audit` is the disk check's answer. */
function machineFor(state: { audit: string; roots: string[] }) {
	return () => {
		const machine: ScriptedMachine = new ScriptedMachine((command, stdin) => {
			if (command.includes("refused staging")) { state.roots.push("audit"); return { stdout: `${state.audit}\n` }; }
			if (command.includes(`mv -f ${RECORD_PATH}.tmp`)) { machine.files.set(RECORD_PATH, stdin()); state.roots.push("record"); return { stdout: "written\n" }; }
			if (command.includes(`cat ${RECORD_PATH}`)) { state.roots.push("adopt"); const r = machine.files.get(RECORD_PATH); return r === undefined ? { exitCode: 1 } : { stdout: r }; }
			if (command.includes("windlass --version")) return { stdout: `${command.includes("git init") ? "" : "from-snapshot "}Windlass 0.6.0 (linux-x64)\n` };
			if (command.includes("wlp-run list") && command.includes("wc -l")) return { stdout: "0\n" };
			return undefined;
		});
		return machine;
	};
}

function world(settings: Partial<E2bSettings> = {}) {
	const clock = { now: Date.parse("2026-11-22T12:00:00Z") };
	const lines: string[] = [];
	const state = { audit: "ok 1048576", roots: [] as string[] };
	const fake = new FakeE2b({ now: () => clock.now, machine: machineFor(state) });
	const make = (extra: Partial<E2bSettings> = {}) => e2bSandboxes(fake, { ...SETTINGS, ...settings, ...extra }, { log: (line) => lines.push(line), now: () => clock.now, sleep: async () => {} });
	const sandboxes = make();
	const create = (uid: string, fromSnapshot?: SnapshotSelection, sessionId = "s-" + randomId(3)) => sandboxes.create({ uid, sessionId, profile: "e2b", fromSnapshot });
	const store = new E2bSnapshots(fake, { ...SETTINGS, ...settings, snapshots: { ...DEFAULT_SNAPSHOT_LIMITS, ...settings.snapshots } }, () => undefined, () => clock.now);
	/** A cold writer's sandbox, saved as setup would have it saved. */
	const saved = async (uid: string, over: Partial<SnapshotSelection> = {}) => {
		const ask = request({ inputs: DEFERRED_INPUTS, ...over });
		const id = await create(uid, ask);
		const ok = await sandboxes.saveSnapshot!(id, { repo: ask.repo, generation: ask.generation, inputs: over.inputs && over.inputs !== DEFERRED_INPUTS ? over.inputs : INPUTS, attempt: ask.attempt, commit: COMMIT, created: clock.now });
		return { id, ok };
	};
	return { clock, lines, state, fake, sandboxes, make, create, store, saved };
}

async function fakeChecks() {
	await section("the switch", async () => {
		const off = e2bSandboxes(new FakeE2b(), { ...SETTINGS, snapshots: undefined }, { log: () => undefined });
		expect("off: the provider offers none of the four snapshot calls", off.hasSnapshot === undefined && off.saveSnapshot === undefined && off.dropSnapshots === undefined && off.sweepSnapshots === undefined);
		const on = world().sandboxes;
		expect("on: all four are there", !!on.hasSnapshot && !!on.saveSnapshot && !!on.dropSnapshots && !!on.sweepSnapshots);
		expect("WLP_E2B_SNAPSHOTS is off unless it says on", readE2bSettings({}).snapshots === undefined && readE2bSettings({ WLP_E2B_SNAPSHOTS: "off" }).snapshots === undefined);
		const read = readE2bSettings({ WLP_E2B_SNAPSHOTS: "on", WLP_E2B_SNAPSHOT_MAX: "4", WLP_E2B_SNAPSHOT_USER_MAX: "2", WLP_E2B_SNAPSHOT_MAX_GB: "3" }).snapshots;
		expect("its limits are read", read?.maxTotal === 4 && read.maxPerUser === 2 && read.maxBytes === 3 * 2 ** 30 && read.ttlMs === 14 * DAY);
		let threw = false;
		try { readE2bSettings({ WLP_E2B_SNAPSHOTS: "yes" }); } catch { threw = true; }
		expect("a value that is neither on nor off stops the server", threw);
		const base = { hosted: SETTINGS, snapshots: false };
		expect("hosted on E2B follows WLP_E2B_SNAPSHOTS, a machine WLP_SNAPSHOTS, hosted Docker WLP_SNAPSHOTS",
			snapshotsFor({ kind: "hosted" }, base) && !snapshotsFor({ kind: "machine" }, base) && !snapshotsFor({ kind: "hosted" }, { ...base, hosted: null }) && snapshotsFor({ kind: "hosted" }, { hosted: null, snapshots: true }));
	});

	await section("a cold writer saves, and a later session of the same user and repository starts from it", async () => {
		const w = world();
		const { id, ok } = await w.saved("u1");
		expect("the save succeeds", ok, w.lines.filter((l) => l.includes("snapshot")).join(" "));
		const info = await w.fake.info(id);
		expect("the cold sandbox carried its candidate, attempt and build", !!info?.metadata[SNAP_META.candidate] && info.metadata[SNAP_META.build] === "build-1" && /^[a-f0-9]{32}$/.test(info.metadata[SNAP_META.attempt] ?? ""));
		expect("the audit and the record ran as root before the snapshot", JSON.stringify(w.state.roots) === JSON.stringify(["audit", "record"]));
		const machineCalls = w.fake.calls.filter((c) => c.startsWith("createSnapshot"));
		expect("one filesystem snapshot was asked for, named by the scheme", machineCalls.length === 1 && /createSnapshot \S+ wlp-[0-9a-f]{8}-[0-9a-f]{10}-[0-9a-f]{10}-[0-9a-f]{8}-[0-9a-f]{12}-[0-9a-z]+$/.test(machineCalls[0]!), machineCalls[0]);
		expect("hasSnapshot sees it for that user and repository only", await w.sandboxes.hasSnapshot!("u1", "42") && !(await w.sandboxes.hasSnapshot!("u2", "42")) && !(await w.sandboxes.hasSnapshot!("u1", "43")));
		w.state.roots.length = 0;
		const ask = request({ writer: false });
		const second = await w.create("u1", ask);
		const made = w.fake.sandboxes.get(second)!;
		expect("the next sandbox is made from the snapshot", made.template.startsWith("fake-team/wlp-") && !!made.metadata[SNAP_META.from]);
		expect("its record was read as root, and the workspace was not made again", w.state.roots.includes("adopt") && !(made.machine as ScriptedMachine).commands.some((c) => c.command.includes("git init")));
		const handle = await w.sandboxes.connect(second);
		expect("its handle carries the source: this attempt, the saved commit", handle?.snapshot?.attempt === ask.attempt && handle.snapshot.commit === COMMIT && handle.snapshot.inputs === INPUTS && handle.snapshot.generation === GEN);
		const other = w.make();
		const again = await other.connect(second);
		expect("another server reads the record from the sandbox", again?.snapshot?.commit === COMMIT && again.snapshot.attempt === ask.attempt);
		const switchedOff = w.make({ snapshots: undefined });
		const stillReadable = await switchedOff.connect(second);
		expect("with snapshots turned off since, it still connects with its source", stillReadable?.snapshot?.commit === COMMIT);
		expect("a sandbox made from a snapshot is never saved again", !(await w.sandboxes.saveSnapshot!(second, { ...ask, commit: COMMIT, created: w.clock.now })));
	});

	await section("environment build lifetime", async () => {
		const w = world();
		const { id, ok } = await w.saved("u1");
		await w.sandboxes.suspend(id);
		expect("suspending a saved candidate removes its source and preserves the image", ok && !w.fake.sandboxes.has(id) && await w.sandboxes.hasSnapshot!("u1", "42"));
		const abandoned = await w.sandboxes.create({ uid: "u1", sessionId: "abandoned", profile: "e2b", environmentBuild: true });
		const reader = await w.create("u1", request({ writer: false }));
		await w.fake.expire(abandoned);
		await w.fake.expire(reader);
		expect("the provider kills an abandoned build and pauses a session restored from its image", await w.sandboxes.state(abandoned) === "none" && await w.sandboxes.state(reader) === "paused");
	});

	await section("never across users", async () => {
		const w = world();
		await w.saved("u1");
		const theirs = await w.create("u2", request());
		expect("another user of the same repository starts cold", !w.fake.sandboxes.get(theirs)!.metadata[SNAP_META.from] && w.fake.sandboxes.get(theirs)!.template === SETTINGS.template);
		// The record names u1: even a sandbox of u2's made from u1's snapshot by mistake would not be handed out.
		const [snapshotId] = [...w.fake.snapshots.keys()];
		const name = snapshotId!.slice(snapshotId!.indexOf("/") + 1).split(":")[0]!;
		const record = (w.fake.snapshots.get(snapshotId!)!.from as Map<string, string>).get(RECORD_PATH)!;
		expect("the record of u1's snapshot does not fit u2", !w.store.recordFits(JSON.parse(record), name, "u2") && w.store.recordFits(JSON.parse(record), name, "u1"));
		const tampered = JSON.stringify({ ...JSON.parse(record), uid: "u2" });
		(w.fake.snapshots.get(snapshotId!)!.from as Map<string, string>).set(RECORD_PATH, tampered);
		const before = w.fake.sandboxes.size;
		const id = await w.create("u1", request());
		expect("a snapshot whose record does not fit is not used: its sandbox is removed and setup runs", !w.fake.sandboxes.get(id)!.metadata[SNAP_META.from] && w.fake.sandboxes.size === before + 1 && w.lines.some((l) => l.includes("e2b.snapshot.refused")));
	});

	await section("what makes a snapshot unusable", async () => {
		const w = world();
		await w.saved("u1");
		const other = await w.create("u1", request({ inputs: digest(["inputs", 2]) }));
		expect("other dependency inputs: cold", !w.fake.sandboxes.get(other)!.metadata[SNAP_META.from]);
		const shots = await w.sandboxes.create({ uid: "u1", sessionId: "s", profile: "e2b", screenshots: true, fromSnapshot: request() });
		expect("the screenshots variant: cold, from the shots template", w.fake.sandboxes.get(shots)!.template === SETTINGS.shotsTemplate);
		w.fake.builds.set(SETTINGS.template, "build-2");
		w.clock.now += 6 * MINUTE;
		const rebuilt = await w.create("u1", request());
		expect("a rebuilt template: cold", !w.fake.sandboxes.get(rebuilt)!.metadata[SNAP_META.from]);
		const ask = request({ inputs: DEFERRED_INPUTS });
		const id = await w.create("u1", ask);
		w.fake.builds.set(SETTINGS.template, "build-3");
		w.clock.now += 6 * MINUTE;
		expect("a sandbox made before a rebuild is not saved after it", !(await w.sandboxes.saveSnapshot!(id, { ...ask, inputs: INPUTS, commit: COMMIT, created: w.clock.now })));
		w.fake.builds.delete(SETTINGS.template);
		w.clock.now += 6 * MINUTE;
		const unknown = await w.create("u1", request());
		expect("a template whose build is unknown: cold, and no candidate to save", !w.fake.sandboxes.get(unknown)!.metadata[SNAP_META.candidate]);
	});

	await section("a new settings generation removes the old snapshot", async () => {
		const w = world();
		await w.saved("u1");
		expect("one snapshot", w.fake.snapshots.size === 1);
		await w.create("u1", request({ generation: digest(["generation", 2]) }));
		expect("the lookup of the next generation removed it", w.fake.snapshots.size === 0 && w.lines.some((l) => l.includes("setup or GitHub connection changed")));
	});

	await section("what the save refuses", async () => {
		for (const answer of ["refused staging", "refused data", "refused token", "refused git-config", "refused scan"]) {
			const w = world();
			w.state.audit = answer;
			const { ok } = await w.saved("u1");
			expect(`the disk check's "${answer}" refuses the save`, !ok && w.fake.snapshots.size === 0 && !w.state.roots.includes("record"));
		}
		const big = world({ snapshots: { ...DEFAULT_SNAPSHOT_LIMITS, maxBytes: 2 ** 30 } });
		big.state.audit = `ok ${2 * 2 ** 30}`;
		expect("a disk over WLP_E2B_SNAPSHOT_MAX_GB is not saved", !(await big.saved("u1")).ok && big.fake.snapshots.size === 0);
		const w = world();
		const ask = request({ inputs: DEFERRED_INPUTS, writer: false });
		const id = await w.create("u1", ask);
		expect("a sandbox made for a reader is not saved", !(await w.sandboxes.saveSnapshot!(id, { ...ask, inputs: INPUTS, commit: COMMIT, created: w.clock.now })));
		const writer = request({ inputs: DEFERRED_INPUTS });
		const mine = await w.create("u1", writer);
		expect("another attempt's save is refused", !(await w.sandboxes.saveSnapshot!(mine, { ...writer, attempt: attempt(), inputs: INPUTS, commit: COMMIT, created: w.clock.now })));
		expect("another repository's save is refused", !(await w.sandboxes.saveSnapshot!(mine, { ...writer, repo: "43", inputs: INPUTS, commit: COMMIT, created: w.clock.now })));
		const plain = await w.sandboxes.create({ uid: "u1", sessionId: "s", profile: "e2b" });
		expect("a sandbox made without a lookup is not saved", !(await w.sandboxes.saveSnapshot!(plain, { ...writer, inputs: INPUTS, commit: COMMIT, created: w.clock.now })));
		const refusing = world();
		refusing.fake.filesystemSnapshots = false;
		expect("E2B refusing a filesystem-only snapshot: not saved, and said", !(await refusing.saved("u1")).ok && refusing.lines.some((l) => l.includes("a memory snapshot is never taken")));
		refusing.fake.filesystemSnapshots = true;
		const tries = refusing.fake.calls.filter((c) => c.startsWith("createSnapshot")).length;
		expect("that server tries no other save", !(await refusing.saved("u1")).ok && refusing.fake.calls.filter((c) => c.startsWith("createSnapshot")).length === tries);
	});

	await section("one per user and repository, and the caps", async () => {
		const w = world({ snapshots: { ...DEFAULT_SNAPSHOT_LIMITS, maxPerUser: 2, maxTotal: 3 } });
		await w.saved("u1");
		w.clock.now += 1000;
		await w.saved("u1");
		expect("a newer save replaces the older one", w.fake.snapshots.size === 1 && w.lines.some((l) => l.includes("a newer snapshot of the same user and repository")));
		for (const repo of ["43", "44"]) { w.clock.now += 1000; await w.saved("u1", { repo }); }
		const u1 = (await w.store.rows()).filter((r) => r.user === w.store.userTag("u1"));
		expect("a user over WLP_E2B_SNAPSHOT_USER_MAX loses the oldest", u1.length === 2 && !u1.some((r) => r.repo === w.store.repoTag("u1", "42")));
		for (const uid of ["u2", "u3"]) { w.clock.now += 1000; await w.saved(uid); }
		const rows = await w.store.rows();
		expect("the deployment over WLP_E2B_SNAPSHOT_MAX loses the oldest", rows.length === 3 && !rows.some((r) => r.repo === w.store.repoTag("u1", "43")), rows.map((r) => r.name).join(" "));
		w.clock.now += 15 * DAY;
		await w.sandboxes.sweepSnapshots!(async () => null);
		expect("the sweep removes snapshots older than 14 days", w.fake.snapshots.size === 0);
		await w.fake.createSnapshot((await w.fake.plant({})), "someone-elses-snapshot");
		await w.sandboxes.sweepSnapshots!(async () => null);
		expect("a snapshot of another scheme or deployment is never touched", w.fake.snapshots.size === 1);
	});

	await section("dropping", async () => {
		const w = world();
		await w.saved("u1");
		await w.saved("u1", { repo: "43" });
		await w.saved("u2");
		await w.sandboxes.dropSnapshots!("u1", "43");
		expect("one repository's", !(await w.sandboxes.hasSnapshot!("u1", "43")) && (await w.sandboxes.hasSnapshot!("u1", "42")));
		await w.sandboxes.dropSnapshots!("u1");
		expect("a user's, and nobody else's", !(await w.sandboxes.hasSnapshot!("u1", "42")) && (await w.sandboxes.hasSnapshot!("u2", "42")));
	});

	await section("the disk check names what must never be in a snapshot", async () => {
		for (const [what, found] of [
			["the platform's staging under /tmp", AUDIT_SCRIPT.includes("/tmp/wlp-*") && AUDIT_SCRIPT.includes("/tmp/.wlp-*")],
			["any file in Windlass's data directory (sessions, the turn's token or relay placeholder file)", AUDIT_SCRIPT.includes('find "$data" -mindepth 1 ! -type d')],
			["GitHub tokens", AUDIT_SCRIPT.includes("gh[opsu]_") && AUDIT_SCRIPT.includes("github_pat_")],
			["the model relay's placeholder", AUDIT_SCRIPT.includes("wlpm1")],
			["git credentials and extra headers", AUDIT_SCRIPT.includes("extraheader") && AUDIT_SCRIPT.includes(".git-credentials")],
			["a flush to disk last", AUDIT_SCRIPT.trim().split("\n").slice(-3).join(" ").includes("sync")],
		] as const) expect(`it covers ${what}`, found);
		const w = world();
		await w.saved("u1");
		const audit = [...w.fake.sandboxes.values()][0]!.machine as ScriptedMachine;
		const call = audit.commands.find((c) => c.command.includes("refused staging"));
		expect("it runs as root with the data directory", call?.options.root === true && call.command.includes(DATA_DIR));
	});
}

function placementChecks() {
	const task = (over: Partial<PlanSubtask> = {}): PlanSubtask => ({ key: "a", title: "A", brief: "b", owns: ["src"], dependsOn: [], acceptance: [], place: { prefer: "pref" }, ...over } as unknown as PlanSubtask);
	const machine = (id: string, busy = 0) => ({ machineId: id, name: id, online: true, tags: [], os: "linux", arch: "x64", egress: "open", orchestrator: "allowed", availableProfiles: ["docker-hardened"], allowedProfiles: ["docker-hardened"],
		freeDiskBytes: 50 * 2 ** 30, slots: { max: 4, busy, queued: 0, unit: { cpus: 2, memoryBytes: 2 ** 31 } }, personalRunning: 0, repositorySecrets: false, screenshots: false } as never);
	const inventory = (snapshotPlaces?: string[], machines = [machine("m1"), machine("m2")]) => ({ machines, hostedProfiles: ["e2b" as const], ...(snapshotPlaces && { snapshotPlaces }) });
	const route = (preferred: string, ...alternatives: string[]) => ({ preferred: preferred === "hosted" ? { kind: "hosted" as const } : { kind: "machine" as const, machineId: preferred }, alternatives: alternatives.map((id) => id === "hosted" ? { kind: "hosted" as const } : { kind: "machine" as const, machineId: id }) });
	const at = (fit: ReturnType<typeof choosePlacement>) => fit.decision ? (fit.decision.place.kind === "hosted" ? "hosted" : fit.decision.place.machineId) : "none";
	console.log("\n== the snapshot bonus in placement");
	expect("the bonus is worth less than the preferred place's own", SNAPSHOT_BONUS < 3);
	expect("among alternatives with the same load, the one with a snapshot wins", at(choosePlacement(task({ place: { prefer: "m9", allow: ["m1", "m2"] } as never }), route("m9", "m1", "m2"), inventory(["m2"]))) === "m2");
	expect("without one, the first", at(choosePlacement(task(), route("m9", "m1", "m2"), inventory())) === "m1");
	expect("a ready preferred place is never left for an alternative that only the bonus puts ahead", at(choosePlacement(task(), route("m1", "m2"), inventory(["m2"]))) === "m1");
	expect("nor for one a little less loaded", at(choosePlacement(task(), route("m1", "m2"), inventory(["m2"], [machine("m1", 1), machine("m2", 0)]))) === "m1");
	expect("an alternative that outranks the preferred place on its own still does", at(choosePlacement(task(), route("m1", "m2"), inventory([], [machine("m1", 4), machine("m2", 0)]))) === "m2");
	expect("the bonus can keep the preferred place ahead of a less loaded alternative", at(choosePlacement(task(), route("m1", "m2"), inventory(["m1"], [machine("m1", 2), machine("m2", 0)]))) === "m1"
		&& at(choosePlacement(task(), route("m1", "m2"), inventory([], [machine("m1", 2), machine("m2", 0)]))) === "m1");
	expect("a place that must wait gets nothing from it", at(choosePlacement(task(), route("m9", "m1", "m2"), inventory(["m2"], [machine("m1"), machine("m2", 4)]))) === "m1");
	const offline = { ...(machine("m2") as object), online: false } as never;
	expect("nor one that is offline", at(choosePlacement(task(), route("m9", "m1", "m2"), inventory(["m2"], [machine("m1"), offline]))) === "m1");
	expect("nor one refused for a capability", at(choosePlacement(task({ needs: { tags: ["gpu"] } } as never), route("m9", "hosted", "m2"), inventory(["m2"]))) === "none");
	const busy = [machine("m1", 3)];
	expect("hosted counts as one place: a snapshot there ranks it among the alternatives", at(choosePlacement(task(), route("m9", "m1", "hosted"), inventory(["hosted"], busy))) === "hosted"
		&& at(choosePlacement(task(), route("m9", "m1", "hosted"), inventory([], busy))) === "m1");
}

/** The disk check as E2B's root would run it, in a container of the sandbox image that is removed afterwards: each case puts one thing on the disk. */
async function dockerChecks() {
	console.log("\n== the disk check, run in the sandbox image");
	const cases: [string, string, RegExp][] = [
		["a clean disk passes, with the bytes used", "true", /^ok \d+$/],
		["the platform's staging is removed, and then the disk passes", "mkdir -p /tmp/wlp-transport-x && echo t > /tmp/wlp-transport-x/f && touch /tmp/.wlp-backup-1.tgz", /^ok \d+$/],
		["a file in Windlass's data directory refuses it", `mkdir -p ${DATA_DIR} && echo '{}' > ${DATA_DIR}/access-token-abc.json`, /^refused data$/],
		["an empty data directory with subdirectories passes", `mkdir -p ${DATA_DIR}/sessions ${DATA_DIR}/memory`, /^ok \d+$/],
		["a GitHub token under the agent's home refuses it", `echo "token=ghs_${"a".repeat(36)}" > /home/agent/notes.txt`, /^refused token$/],
		["the model relay's placeholder refuses it", `echo "wlpm1.${"x".repeat(40)}" > /var/tmp/held`, /^refused token$/],
		["a credential store refuses it", "echo https://x:y@github.com > /home/agent/.git-credentials", /^refused credentials$/],
		["an extra header in the workspace's git config refuses it", "mkdir -p /workspace/.git && printf '[http \\042https://github.com/\\042]\\n\\textraheader = AUTHORIZATION: basic x\\n' > /workspace/.git/config", /^refused git-config$/],
		["a user in a remote URL refuses it", "mkdir -p /workspace/.git && printf '[remote \\042origin\\042]\\n\\turl = https://x-access-token:abc@github.com/o/r.git\\n' > /workspace/.git/config", /^refused remote$/],
		["a credential helper in the workspace's git config refuses it", "mkdir -p /workspace/.git && printf '[credential]\\n\\thelper = store\\n' > /workspace/.git/config", /^refused git-config$/],
		["a plain remote passes", "mkdir -p /workspace/.git && printf '[remote \\042origin\\042]\\n\\turl = https://github.com/o/r.git\\n' > /workspace/.git/config", /^ok \d+$/],
		["a token inside node_modules is not searched (it is the repository's own dependency)", `mkdir -p /workspace/node_modules/p && echo ghs_${"b".repeat(36)} > /workspace/node_modules/p/f`, /^ok \d+$/],
	];
	for (const [name, prepare, want] of cases) {
		const script = `set -e\n${prepare}\nset +e\nsh -c "$WLP_AUDIT" sh ${DATA_DIR}\necho "staging=$(ls -a /tmp | grep -c wlp-)"`;
		const result = await docker(["run", "--rm", "--network", "none", "--user", "root", "--entrypoint", "/bin/bash", "-e", `WLP_AUDIT=${AUDIT_SCRIPT}`, IMAGE, "-c", script], { timeoutMs: 120_000 });
		const out = result.stdout.trim().split("\n");
		const answer = out.at(-2) ?? "";
		const staging = out.at(-1) ?? "";
		expect(name, result.code === 0 && want.test(answer) && (!/^ok/.test(answer) || staging === "staging=0"), `${answer} ${staging} ${result.stderr.trim().slice(-200)}`);
	}
}

async function liveCheck() {
	const { createE2bSdkClient } = await import("../server/src/sandbox/e2b/sdk.js");
	const apiKey = (process.env.E2B_API_KEY ?? "").trim();
	if (!apiKey) { console.log("E2B_API_KEY is not set: --live needs the E2B account's key"); process.exit(2); }
	const limitMs = Math.min(4 * MINUTE, Number(process.env.WLP_E2B_CHECK_LIMIT_MS) || 4 * MINUTE);
	const timer = setTimeout(() => { console.log(`FAIL  the live check reached its ${limitMs / 1000} s limit`); process.exitCode = 3; void cleanup().finally(() => process.exit(3)); }, limitMs);
	const client: E2bClient = createE2bSdkClient(apiKey);
	const base = readE2bSettings({ ...process.env, WLP_HOSTED_SNAPSHOTS: "on" });
	const settings: E2bSettings = { ...base, deployment: `snapcheck-${randomId(3)}`, maxRunning: 1, snapshots: { ...base.snapshots!, maxTotal: 2, maxPerUser: 1 } };
	const lines: string[] = [];
	const sandboxes = e2bSandboxes(client, settings, { log: (line) => { lines.push(line); console.log(`      ${line}`); } });
	const store = new E2bSnapshots(client, { ...settings, snapshots: settings.snapshots! }, () => undefined, Date.now);
	const ran: { id: string; ms: number }[] = [];
	async function cleanup() {
		for (const info of await client.list({ metadata: { [META.deployment]: settings.deployment } }).catch(() => [])) await client.kill(info.sandboxId).catch(() => undefined);
		for (const row of await store.rows().catch(() => [])) await client.deleteSnapshot(row.id).catch(() => undefined);
	}
	console.log(`INFO  deployment label ${settings.deployment}; template ${settings.template}; to remove by hand: e2b-cleanup.ts --kill with WLP_E2B_DEPLOYMENT=${settings.deployment}`);
	try {
		const build = await client.templateBuild(settings.template);
		if (!expect("the template's tag names a build", build !== null, String(build))) return;
		const ask = request({ inputs: DEFERRED_INPUTS });
		let began = Date.now();
		const id = await sandboxes.create({ uid: "snapcheck", sessionId: "snapcheck-1", profile: "e2b", fromSnapshot: ask });
		const handle = (await sandboxes.connect(id)) as E2bSandboxHandle;
		// A stand-in for setup: a file in the workspace, a dependency cache, and the staging a clone leaves behind.
		await handle.run("echo prepared > /workspace/.setup-marker && mkdir -p node_modules/x && echo 1 > node_modules/x/index.js", { timeoutMs: 30_000 });
		await handle.run("mkdir -p /tmp/wlp-transport-check && echo leftover > /tmp/wlp-transport-check/file", { gitUser: true, cwd: "/", timeoutMs: 30_000 });
		const seen = await handle.rootAnswer(`find ${DATA_DIR} -mindepth 1 | head -20; echo ---; ls -a /tmp | head -40; echo ---; df -B1 --output=used / | tail -n 1`, [], { timeoutMs: 30_000 });
		console.log(`INFO  before the save: data directory, /tmp, bytes used:\n${seen?.stdout ?? "(could not be read)"}`);
		const saveBegan = Date.now();
		const ok = await sandboxes.saveSnapshot!(id, { ...ask, inputs: INPUTS, commit: COMMIT, created: Date.now() });
		const saveMs = Date.now() - saveBegan;
		expect("the save succeeds", ok, `${Math.round(saveMs / 1000)} s`);
		const after = await handle.run("cat /workspace/.setup-marker && test ! -e /tmp/wlp-transport-check && echo gone", { timeoutMs: 30_000 }).catch((error: unknown) => ({ exitCode: null, stdout: String(error) }));
		expect("the source sandbox runs commands after the save, and the staging is gone", after.exitCode === 0 && after.stdout.includes("gone"), after.stdout);
		const snaps = await store.rows();
		expect("E2B lists it under the scheme's name", snaps.length === 1, snaps.map((s) => `${s.name} (${s.id})`).join(" "));
		await sandboxes.destroy(id);
		ran.push({ id, ms: Date.now() - began });
		if (!ok) return;
		began = Date.now();
		const reader = request({ writer: false });
		const second = await sandboxes.create({ uid: "snapcheck", sessionId: "snapcheck-2", profile: "e2b", fromSnapshot: reader });
		const startMs = Date.now() - began;
		const from = (await client.info(second))?.metadata[SNAP_META.from];
		expect("a later sandbox is made from it", !!from, `${Math.round(startMs / 1000)} s to start`);
		const h2 = (await sandboxes.connect(second)) as E2bSandboxHandle;
		expect("its handle carries the saved commit", h2.snapshot?.commit === COMMIT);
		const files = await h2.run("cat /workspace/.setup-marker && test -f node_modules/x/index.js && echo deps", { timeoutMs: 30_000 });
		expect("it holds what setup wrote", files.exitCode === 0 && files.stdout.includes("prepared") && files.stdout.includes("deps"), files.stdout);
		const empty = await h2.rootAnswer(`find ${DATA_DIR} -mindepth 1 ! -type d | head -5; ls /tmp | grep -c '^wlp-' || true`, [], { timeoutMs: 30_000 });
		expect("its data directory holds no file and /tmp no staging", (empty?.stdout.trim() ?? "x") === "0", empty?.stdout);
		await sandboxes.destroy(second);
		ran.push({ id: second, ms: Date.now() - began });
	} finally {
		clearTimeout(timer);
		await cleanup();
		const left = await store.rows().catch(() => []);
		expect("the run's snapshots are deleted", left.length === 0);
		const seconds = ran.reduce((n, r) => n + r.ms, 0) / 1000;
		console.log(`INFO  ${ran.length} sandboxes ran about ${describeUsage(seconds, 1, 1024, settings.rateCard)} (the template's real size may differ)`);
	}
}

if (live) await liveCheck();
else {
	await fakeChecks();
	if (selected("placement")) placementChecks();
	if (withDocker) await dockerChecks();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
