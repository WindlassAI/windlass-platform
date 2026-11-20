/**
 * Tests of the E2B provider that need no E2B account and send nothing to E2B. Run with:
 *
 *   cd server && npx tsx ../scripts/e2b-provider-test.ts                  the provider on the in-memory client
 *   cd server && npx tsx ../scripts/e2b-provider-test.ts --docker
 *                                                                        the same, and "a real turn" besides
 *
 * The first part runs the provider's logic (server/src/sandbox/e2b/sandboxes.ts) on `FakeE2b`, which
 * does to sandboxes what E2B's documentation says E2B does: the cap, the timeout that is pushed out
 * while a turn runs and stops a sandbox whose server is gone, pause and resume, destroy, the metadata,
 * the line about what a sandbox cost, and the cleanup.
 *
 * "A real turn" (--docker) gives the same in-memory client sandboxes whose commands run in real
 * containers of the sandbox image on this machine, each on a disk of its own as a microVM is. Then
 * everything between `E2bClient` and Windlass is real: the provider's quoting of commands, standard
 * input and its order, signals, the access token file, and a whole scripted turn through turn.ts. What
 * stays untried is only the adapter to E2B's SDK (e2b/sdk.ts) and E2B itself: scripts/e2b-check.ts.
 * The containers carry the label dev.windlass-platform=1 and are removed at the end.
 *
 * Exit code 0 when every check passed.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WindlassEvent } from "../server/src/contract.js";
import { type AccessTokens, type ChatgptLogins, DeploymentFull, type RunTurnResult, SandboxUserError, type ScriptedModel, type TurnQuestion } from "../server/src/sandbox/api.js";
import { IMAGE, LABEL_ARG, docker } from "../server/src/sandbox/docker.js";
import { cleanupDeployment } from "../server/src/sandbox/e2b/cleanup.js";
import type { E2bClient, E2bCommand, E2bCommandOptions } from "../server/src/sandbox/e2b/client.js";
import { DEFAULT_MAX_RUNNING, type E2bSettings, HOBBY_MAX_RUNNING, readE2bConfig, readE2bSettings } from "../server/src/sandbox/e2b/config.js";
import { FakeE2b, type FakeMachine, ScriptedMachine } from "../server/src/sandbox/e2b/fake.js";
import { createE2bSandboxLayer } from "../server/src/sandbox/e2b/index.js";
import { describeUsage, estimatedCostUsd } from "../server/src/sandbox/e2b/pricing.js";
import { ACCOUNT_LIMIT, E2bSandboxHandle, E2bSandboxes, META, capReached } from "../server/src/sandbox/e2b/sandboxes.js";
import { describeTemplate } from "../server/src/sandbox/e2b/template.js";
import { OPEN_PROFILE_NOT_OFFERED, PROFILES, PROFILE_RUN_FLAGS, e2bProfile, profilesFor } from "../server/src/sandbox/profiles.js";
import { BWRAP_PROBE, DATA_DIR, isTurnSandbox, randomId, shellQuote } from "../server/src/sandbox/provider.js";
import { tokenFilePath } from "../server/src/sandbox/token-file.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const withDocker = process.argv.includes("--docker");
const run = randomId(3);
let passes = 0;
let failures = 0;

function expect(name: string, ok: boolean, detail = ""): boolean {
	const text = detail.trim().replace(/\s*\n\s*/g, " | ");
	if (ok) {
		passes += 1;
		console.log(`PASS  ${name}${text ? `  (${text})` : ""}`);
	} else {
		failures += 1;
		console.log(`FAIL  ${name}  ${text || "condition not met"}`);
	}
	return ok;
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		failures += 1;
		console.log(`FAIL  ${name}: unexpected error  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	}
}
async function userError(body: () => Promise<unknown>): Promise<string | null> {
	try {
		await body();
		return null;
	} catch (error) {
		return error instanceof SandboxUserError ? error.message : `not a SandboxUserError: ${error instanceof Error ? error.message : String(error)}`;
	}
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MINUTE = 60_000;
const SETTINGS: E2bSettings = {
	template: "windlass-platform-sandbox",
	deployment: "test",
	maxRunning: 2,
	idleTimeoutMs: 2 * MINUTE,
	turnLeaseMs: 3 * MINUTE,
	maxRuntimeMs: 60 * MINUTE,
	turnLimitMs: 45 * MINUTE,
	pause: true,
	windlassSandbox: false,
	openProfile: false,
	windlassVersion: null,
};

/** A machine that answers as the sandbox image would to what the provider itself runs. */
function imageLike(extra: (command: string, stdin: () => string) => { exitCode?: number; stdout?: string; stderr?: string } | undefined = () => undefined): ScriptedMachine {
	return new ScriptedMachine((command, stdin) => extra(command, stdin) ?? (command.includes("windlass --version") ? { stdout: "Windlass 0.4.0+test (linux-x64)\n" } : command.includes("wlp-run list") && command.includes("wc -l") ? { stdout: "0\n" } : undefined));
}

/** A provider on a fake E2B, with a clock of its own and its log lines kept. */
function world(settings: Partial<E2bSettings> = {}, fakeOptions: { accountMaxRunning?: number; machine?: (id: string) => FakeMachine } = {}) {
	const clock = { now: Date.parse("2026-11-15T12:00:00Z") };
	const lines: string[] = [];
	const machines = new Map<string, ScriptedMachine>();
	const fake = new FakeE2b({
		now: () => clock.now,
		accountMaxRunning: fakeOptions.accountMaxRunning,
		machine:
			fakeOptions.machine ??
			((id) => {
				const machine = imageLike();
				machines.set(id, machine);
				return machine;
			}),
	});
	const versions: string[] = [];
	const sandboxes = new E2bSandboxes(fake, { ...SETTINGS, ...settings }, { log: (line) => lines.push(line), now: () => clock.now, sleep: async () => {}, onVersion: (version) => versions.push(version) });
	const make = (uid = "u1", sessionId = "s1") => sandboxes.create({ uid, sessionId, profile: "e2b" });
	return { clock, lines, fake, sandboxes, machines, versions, make };
}

const callsOf = (fake: FakeE2b, name: string) => fake.calls.filter((call) => call.startsWith(`${name} `));

// ---------------------------------------------------------------------------------------------
// The provider on the in-memory client
// ---------------------------------------------------------------------------------------------

await section("profiles", async () => {
	const onE2b = profilesFor("e2b");
	const e2b = onE2b.find((profile) => profile.id === "e2b");
	expect("a server on E2B offers the E2B profile and no other", onE2b.filter((profile) => profile.available).map((profile) => profile.id).join() === "e2b" && onE2b.length === PROFILES.length);
	const notOffered = onE2b.find((profile) => profile.id === "e2b-open");
	expect("without WLP_E2B_OPEN_PROFILE=1 the microVM-only profile is listed, with why it cannot be chosen", notOffered?.available === false && notOffered.unavailableReason === OPEN_PROFILE_NOT_OFFERED);
	const both = profilesFor("e2b", { windlassSandbox: true, openProfile: true });
	const open = both.find((profile) => profile.id === "e2b-open");
	expect("with it, both E2B profiles are offered, the one with Windlass's sandbox first (the picker's default)", both.filter((profile) => profile.available).map((profile) => profile.id).join() === "e2b,e2b-open");
	expect(
		"the microVM-only profile says what it gives up: network, the access token, no questions",
		open?.approval === "full" && open.commandNetwork && open.commandsCanReadAccessToken && open.layers.length === 1 && /any host on the network/.test(open.summary) && /access token/.test(open.summary) && /without asking/.test(open.summary) && /never in the microVM/.test(open.summary),
		open?.summary,
	);
	expect(
		"what it promises holds with or without bubblewrap: Windlass asks or sandboxes, and commands are not said to be without network or token",
		e2b?.approval === "auto" && e2b.commandNetwork === true && e2b.commandsCanReadAccessToken === true && /not been established/.test(e2b.summary) && /never in the microVM/.test(e2b.summary),
		e2b?.summary,
	);
	expect("the Docker profiles say why they cannot be chosen there", onE2b.filter((profile) => profile.id.startsWith("docker-")).every((profile) => !profile.available && /E2B/.test(profile.unavailableReason ?? "")));
	const onDocker = profilesFor("docker");
	expect("a server on Docker lists E2B as unavailable, with what would offer it", JSON.stringify(onDocker) === JSON.stringify(PROFILES) && onDocker.find((profile) => profile.id === "e2b")?.available === false && /WLP_SANDBOX=e2b/.test(onDocker.find((profile) => profile.id === "e2b")?.unavailableReason ?? ""));
	expect("and the microVM-only profile too", onDocker.find((profile) => profile.id === "e2b-open")?.available === false && /WLP_E2B_OPEN_PROFILE=1/.test(onDocker.find((profile) => profile.id === "e2b-open")?.unavailableReason ?? ""));
	const strong = e2bProfile({ windlassSandbox: true });
	expect("with WLP_E2B_WINDLASS_SANDBOX=1 the stronger promise is made", strong.available && strong.approval === "auto" && !strong.commandNetwork && !strong.commandsCanReadAccessToken && strong.layers.length === 2);
	const mock = readFileSync(join(root, "web/src/api/mock.ts"), "utf8");
	const listed = PROFILES.find((profile) => profile.id === "e2b");
	expect("web/src/api/mock.ts repeats the E2B profile's texts", listed !== undefined && mock.includes(JSON.stringify(listed.unavailableReason)) && mock.includes(JSON.stringify(listed.summary)));
	expect("and the microVM-only profile's", open !== undefined && mock.includes(JSON.stringify(open.name)) && mock.includes(JSON.stringify(open.summary)) && mock.includes(JSON.stringify(open.layers[0])));
	const { sandboxes } = world();
	expect("the provider answers profiles() and profile() from the same list", JSON.stringify(sandboxes.profiles()) === JSON.stringify(onE2b) && sandboxes.profile("e2b").available && sandboxes.sessionsLiveInSandbox === true);
});

await section("create", async () => {
	const { fake, sandboxes, machines, versions, lines, make, clock } = world();
	const id = await make("user-1", "session-1");
	const made = fake.sandboxes.get(id);
	expect(
		"a sandbox is tagged with the deployment, the user, the session and the profile",
		made !== undefined && made.metadata[META.deployment] === "test" && made.metadata[META.uid] === "user-1" && made.metadata[META.session] === "session-1" && made.metadata[META.profile] === "e2b",
		JSON.stringify(made?.metadata),
	);
	expect("it is made from the template, with the short timeout, and pauses when that runs out", made?.template === "windlass-platform-sandbox" && made.endAt === clock.now + 2 * MINUTE && made.onTimeout === "pause", `${(made?.endAt ?? 0) - clock.now} ms, ${made?.onTimeout}`);
	expect("every command gets the environment the Dockerfile's ENV gives a container", made?.envs.LANG === "C.UTF-8" && made.envs.NO_COLOR === "1");
	const commands = machines.get(id)?.commands ?? [];
	const init = commands.find((entry) => entry.command.includes("git init"));
	expect(
		"the workspace gets an empty git repository, under wlp-run, in /workspace",
		init !== undefined && /^wlp-run exec r[a-f0-9]{12} sh -c 'git init -q && git commit -q --allow-empty -m "Empty workspace" && windlass --version'$/.test(init.command) && init.options.cwd === "/workspace",
		init?.command,
	);
	expect("the Windlass in the template is noted from the first sandbox", versions.join() === "0.4.0+test");
	expect("a line says it was created, and how many run", lines.some((line) => line.startsWith(`[wlp] e2b.sandbox.created id=${id} uid=user-1 session=session-1`) && line.includes("1 of at most 2 running")), lines.join(" | "));
	expect("the handle is one the turn code takes", isTurnSandbox((await sandboxes.connect(id))!));
	const refused = await userError(() => sandboxes.create({ uid: "user-1", sessionId: "s", profile: "docker-hardened" }));
	expect("create() refuses a profile that is not offered here, in a sentence fit to show", refused !== null && /not available/.test(refused) && /E2B/.test(refused), refused ?? "did not throw");
	let invalid = "";
	await sandboxes.create({ uid: "../x", sessionId: "s", profile: "e2b" }).catch((error: unknown) => (invalid = error instanceof Error ? error.message : String(error)));
	expect("create() refuses an invalid user id before it asks E2B anything", /invalid user id/.test(invalid) && callsOf(fake, "create").length === 1);

	const broken = world({}, { machine: () => imageLike((command) => (command.includes("git init") ? { exitCode: 128, stderr: "fatal: not a git repository" } : undefined)) });
	let why = "";
	await broken.make().catch((error: unknown) => (why = error instanceof Error ? error.message : String(error)));
	expect("a sandbox whose workspace cannot be set up is removed again", /could not set up the workspace: fatal: not a git repository/.test(why) && broken.fake.sandboxes.size === 0 && callsOf(broken.fake, "kill").length === 1, why);
});

await section("a profile per session", async () => {
	const notOffered = world({ windlassSandbox: true });
	const refused = await userError(() => notOffered.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b-open" }));
	expect("a server without WLP_E2B_OPEN_PROFILE=1 refuses to make a microVM-only sandbox, and asks E2B nothing", refused !== null && refused.includes(OPEN_PROFILE_NOT_OFFERED) && callsOf(notOffered.fake, "create").length === 0, refused ?? "did not throw");

	const w = world({ windlassSandbox: true, openProfile: true });
	const strict = await w.make("u1", "s-strict");
	const open = await w.sandboxes.create({ uid: "u1", sessionId: "s-open", profile: "e2b-open" });
	const probed = (id: string) => (w.machines.get(id)?.commands ?? []).some((entry) => entry.command === BWRAP_PROBE.map(shellQuote).join(" "));
	expect("each sandbox carries the profile it was made with", w.fake.sandboxes.get(strict)?.metadata[META.profile] === "e2b" && w.fake.sandboxes.get(open)?.metadata[META.profile] === "e2b-open");
	expect("only the profile that promises Windlass's sandbox holds a new sandbox to bubblewrap's probe", probed(strict) && !probed(open));
	// Another server, which made neither: what it knows of a sandbox's profile is what E2B keeps.
	const other = new E2bSandboxes(w.fake, { ...SETTINGS, windlassSandbox: true, openProfile: true }, { log: () => undefined, now: () => w.clock.now, sleep: async () => {} });
	const a = (await other.connect(strict)) as E2bSandboxHandle;
	const b = (await other.connect(open)) as E2bSandboxHandle;
	expect("Windlass runs with --approval auto in the one and full in the other, on any server", a.profile === "e2b" && a.approval === "auto" && b.profile === "e2b-open" && b.approval === "full", `${a.profile} ${a.approval}, ${b.profile} ${b.approval}`);
	const withdrawn = new E2bSandboxes(w.fake, { ...SETTINGS, windlassSandbox: true }, { log: () => undefined, now: () => w.clock.now, sleep: async () => {} });
	const kept = (await withdrawn.connect(open)) as E2bSandboxHandle;
	expect("a session made with it keeps it after the operator stops offering it to new ones", kept.profile === "e2b-open" && kept.approval === "full");
	w.fake.sandboxes.get(strict)!.metadata = Object.fromEntries(Object.entries(w.fake.sandboxes.get(strict)!.metadata).filter(([key]) => key !== META.profile));
	const old = (await other.connect(strict)) as E2bSandboxHandle;
	expect("a sandbox that names no profile is an E2B one, as every sandbox was before there were two", old.profile === "e2b" && old.approval === "auto");
});

await section("the cap", async () => {
	const w = world({ maxRunning: 1 });
	const a = await w.make("u1", "s1");
	const capacityWait = (error: unknown) => error instanceof DeploymentFull && error.limit === 1 && error.message === capReached(1);
	const before = callsOf(w.fake, "create").length;
	const refused = await w.make("u2", "s2").catch((error: unknown) => error);
	expect("creating at the deployment cap throws the capacity wait with limit 1 and the user's sentence", capacityWait(refused) && callsOf(w.fake, "create").length === before && w.fake.sandboxes.size === 1);
	expect("the sentence is one for a user", /at most 2 sandboxes at the same time/.test(capReached(2)) && /Try again in a few minutes/.test(capReached(2)) && /at most 1 sandbox at the same time, and it is in use/.test(capReached(1)));
	expect("the count comes from E2B's list of the deployment's running sandboxes", w.fake.calls.some((call) => call === `list {"${META.deployment}":"test"} running`));
	expect("a line says the cap was reached", w.lines.some((line) => line.includes("e2b.cap_reached deployment=test: 1 of at most 1 sandboxes are running")));

	await w.sandboxes.suspend(a);
	const c = await w.make("u3", "s3");
	expect("a paused sandbox does not count: another may be created", w.fake.sandboxes.get(c)?.state === "running" && w.fake.sandboxes.get(a)?.state === "paused");
	const resumed = await w.sandboxes.connect(a).catch((error: unknown) => error);
	expect("resuming at the deployment cap throws the same capacity wait and keeps the sandbox paused", capacityWait(resumed) && w.fake.sandboxes.get(a)?.state === "paused" && callsOf(w.fake, "connect").filter((call) => call.includes(a)).length === 1);
	await w.sandboxes.destroy(c);
	expect("once one is gone the paused one can be resumed", (await w.sandboxes.connect(a)) !== undefined && w.fake.sandboxes.get(a)?.state === "running");

	// Sandboxes of other deployments on the same account, and sandboxes that are not the platform's at all, are not counted.
	const others = world({ maxRunning: 1 });
	await others.fake.plant({ [META.deployment]: "another" });
	await others.fake.plant({});
	const own = await others.make();
	expect("only this deployment's sandboxes count", others.fake.sandboxes.get(own)?.state === "running" && others.fake.sandboxes.size === 3);

	// Two servers look at the list at the same moment and both create: the second finds one too many and takes its own back.
	const race = world({ maxRunning: 1 });
	const racing: E2bClient = Object.assign(Object.create(race.fake) as E2bClient, {
		create: async (input: Parameters<E2bClient["create"]>[0]) => {
			const connection = await race.fake.create(input);
			await race.fake.plant({ [META.deployment]: "test", [META.uid]: "other-server" });
			return connection;
		},
	});
	const second = new E2bSandboxes(racing, { ...SETTINGS, maxRunning: 1 }, { log: (line) => race.lines.push(line), now: () => race.clock.now });
	const lost = await userError(() => second.create({ uid: "u1", sessionId: "s1", profile: "e2b" }));
	const left = [...race.fake.sandboxes.values()];
	expect(
		"a sandbox that turns out to be one too many (another server made one at the same moment) is removed at once",
		lost === capReached(1) && left.length === 1 && left[0]?.metadata[META.uid] === "other-server" && race.lines.some((line) => line.includes("the newest") && line.includes("was removed again")),
		`${lost} | ${left.length} left`,
	);

	const account = world({ maxRunning: 5 }, { accountMaxRunning: 1 });
	await account.fake.plant({});
	const refusedByE2b = await userError(() => account.make());
	expect("when E2B itself refuses (the account's own limit), the user reads that", refusedByE2b === ACCOUNT_LIMIT && /limit of its plan/.test(ACCOUNT_LIMIT), refusedByE2b ?? "did not throw");
	expect(`the default cap (${DEFAULT_MAX_RUNNING}) is well under the Hobby plan's ${HOBBY_MAX_RUNNING}`, DEFAULT_MAX_RUNNING * 2 <= HOBBY_MAX_RUNNING && readE2bSettings({}).maxRunning === DEFAULT_MAX_RUNNING);
});

await section("only this deployment's sandboxes", async () => {
	const w = world();
	const foreign = await w.fake.plant({ [META.deployment]: "another", [META.uid]: "u1" });
	const bare = await w.fake.plant({});
	w.fake.calls.length = 0;
	const states = [await w.sandboxes.state(foreign), await w.sandboxes.state(bare), await w.sandboxes.state("nosuchsandbox"), await w.sandboxes.state("../etc")];
	expect("a sandbox of another deployment, or of nobody, is none of ours", states.join() === "none,none,none,none" && (await w.sandboxes.connect(foreign)) === undefined && (await w.sandboxes.connect(bare)) === undefined);
	await w.sandboxes.suspend(foreign);
	await w.sandboxes.destroy(foreign);
	await w.sandboxes.destroy(bare);
	expect("it is never connected to, paused or killed", w.fake.sandboxes.size === 2 && [...w.fake.sandboxes.values()].every((sandbox) => sandbox.state === "running") && !w.fake.calls.some((call) => /^(connect|pause|kill|setTimeout) /.test(call)), w.fake.calls.join(" | "));
	expect("an id that cannot be E2B's is not sent to E2B", !w.fake.calls.some((call) => call.includes("../etc")));
});

await section("what the usage meter reads", async () => {
	const w = world({ maxRunning: 5 });
	const mine = await w.make("u1", "s1");
	const paused = await w.make("u1", "s2");
	await w.sandboxes.suspend(paused);
	await w.make("u2", "s3");
	await w.fake.plant({ [META.deployment]: "another", [META.uid]: "u1", [META.session]: "elsewhere" });
	const listed = await w.sandboxes.list("u1");
	expect(
		"a user's sandboxes are listed with their sessions, running and paused, and nobody else's",
		listed.length === 2 && listed.some((sandbox) => sandbox.id === mine && sandbox.sessionId === "s1" && sandbox.state === "running") && listed.some((sandbox) => sandbox.id === paused && sandbox.sessionId === "s2" && sandbox.state === "paused"),
		JSON.stringify(listed),
	);
	expect("a user id that cannot be one lists nothing", (await w.sandboxes.list("../u1")).length === 0);
	expect("an unused sandbox stops by itself after the idle timeout", w.sandboxes.idleStopMs === SETTINGS.idleTimeoutMs);
	const price = w.sandboxes.price();
	expect("a second is priced for the size E2B said the sandboxes have", Math.abs(price.usdPerSecond - 0.0000185) < 1e-9 && price.basis === "1 vCPU and 1,024 MiB of memory at E2B's published prices", JSON.stringify(price));
});

await section("the dead-man switch", async () => {
	// Real time here: the keepalive is a timer. A lease of 3 s is set again every second.
	const w = world({ turnLeaseMs: 3_000, idleTimeoutMs: 30_000 });
	const real = { offset: w.clock.now - Date.now() };
	const tick = () => (w.clock.now = Date.now() + real.offset);
	const id = await w.make();
	const handle = (await w.sandboxes.connect(id)) as E2bSandboxHandle;
	tick();
	w.fake.calls.length = 0;
	const release = await handle.holdForTurn();
	expect("when a turn starts, the timeout is set to the lease at once", callsOf(w.fake, "setTimeout").join() === `setTimeout ${id} 3000`, w.fake.calls.join(" | "));
	await sleep(2_300);
	tick();
	const during = callsOf(w.fake, "setTimeout").length;
	expect("while the turn runs it is pushed out again every third of the lease", during === 3 && w.fake.sandboxes.get(id)!.endAt > w.clock.now, `${during} calls in 2.3 s`);
	await release();
	const after = callsOf(w.fake, "setTimeout");
	expect("when the turn ends the timeout goes back to the short one", after.at(-1) === `setTimeout ${id} 30000` && after.length === during + 1, after.join(" | "));
	await sleep(1_300);
	expect("and nothing pushes it out any more", callsOf(w.fake, "setTimeout").length === during + 1);
	await release();
	expect("releasing twice does nothing more", callsOf(w.fake, "setTimeout").length === during + 1);

	// A server that dies in the middle of a turn: nothing is released, nothing is pushed out again.
	const crashed = world({ turnLeaseMs: 3 * MINUTE });
	const lost = await crashed.make();
	const held = (await crashed.sandboxes.connect(lost)) as E2bSandboxHandle;
	await held.holdForTurn();
	const startedAt = crashed.clock.now;
	// The dead server's timer is not this test's to wait for: the clock moves on without it.
	crashed.clock.now += 3 * MINUTE + 1_000;
	const info = await crashed.fake.info(lost);
	expect(
		"a sandbox whose server died is paused by E2B itself when the lease runs out, having run no longer than the lease",
		info?.state === "paused" && crashed.fake.ranMs(lost) === 3 * MINUTE && crashed.fake.ranMs(lost) <= crashed.clock.now - startedAt,
		`${info?.state}, ran ${crashed.fake.ranMs(lost) / 1000} s`,
	);
	const idle = world();
	const quiet = await idle.make();
	idle.clock.now += 2 * MINUTE + 1;
	expect("a sandbox nobody connects to is paused when the short timeout runs out", (await idle.sandboxes.state(quiet)) === "paused" && idle.fake.ranMs(quiet) === 2 * MINUTE);
	expect("and a line says it stopped by itself, with the most it can have cost", idle.lines.some((line) => line.includes(`e2b.sandbox.timed_out id=${quiet}`) && line.includes("ran at most 120 s at 1 vCPU and 1024 MiB") && line.includes("(estimated)")), idle.lines.join(" | "));

	const failing = world({ turnLeaseMs: 3_000 });
	const flaky = await failing.make();
	const flakyHandle = (await failing.sandboxes.connect(flaky)) as E2bSandboxHandle;
	const let_go = await flakyHandle.holdForTurn();
	failing.fake.failSetTimeout = new Error("fake E2B: unreachable");
	await sleep(2_300);
	const said = failing.lines.filter((line) => line.includes("e2b.keepalive_failed"));
	expect("a timeout that cannot be pushed out is said once, with when the sandbox stops", said.length === 1 && /unreachable/.test(said[0] ?? "") && /it stops \d+ s from now/.test(said[0] ?? ""), said.join(" | "));
	failing.fake.failSetTimeout = null;
	await let_go();

	// A command outside a turn that takes long (a clone) is vouched for too, once it has run a third of the short timeout.
	let finish: () => void = () => {};
	const slowCommand = new Promise<void>((resolve) => (finish = resolve));
	const cloning = world({ idleTimeoutMs: 30_000, turnLeaseMs: 60_000 });
	const repo = await cloning.make();
	const repoHandle = (await cloning.sandboxes.connect(repo)) as E2bSandboxHandle;
	const repoMachine = cloning.machines.get(repo)!;
	const startOf = repoMachine.start.bind(repoMachine);
	repoMachine.start = async (command, options) => {
		const started = await startOf(command, options);
		return command.includes("git clone") ? { ...started, wait: async () => (await slowCommand, started.wait()) } : started;
	};
	cloning.fake.calls.length = 0;
	const quick = await repoHandle.run("git status");
	expect("a short command asks E2B for nothing about the timeout", quick.exitCode === 0 && callsOf(cloning.fake, "setTimeout").length === 0);
	// The provider waits a third of the idle timeout (10 s here) before it vouches; the test does not: it shortens that wait.
	(cloning.sandboxes as unknown as { holdCommandsAfterMs: number }).holdCommandsAfterMs = 200;
	const clone = repoHandle.run("git clone https://example.invalid/repo.git");
	await sleep(600);
	const whileCloning = callsOf(cloning.fake, "setTimeout");
	finish();
	const cloned = await clone;
	expect(
		"a command that takes long keeps its sandbox alive like a turn, and lets go when it ends",
		whileCloning.join() === `setTimeout ${repo} 60000` && cloned.exitCode === 0 && callsOf(cloning.fake, "setTimeout").at(-1) === `setTimeout ${repo} 30000` && callsOf(cloning.fake, "pause").length === 0,
		callsOf(cloning.fake, "setTimeout").join(" | "),
	);

	const refused = world();
	const gone = await refused.make();
	const goneHandle = (await refused.sandboxes.connect(gone)) as E2bSandboxHandle;
	await refused.fake.kill(gone);
	let rejected = "";
	await goneHandle.holdForTurn().catch((error: unknown) => (rejected = error instanceof Error ? error.message : String(error)));
	expect("a sandbox that cannot be kept running is not held: the turn is told", /not running/.test(rejected), rejected);
});

await section("the plan's hour", async () => {
	const w = world();
	const id = await w.make();
	const handle = (await w.sandboxes.connect(id)) as E2bSandboxHandle;
	w.fake.calls.length = 0;
	await (await handle.holdForTurn())();
	expect("a sandbox with most of its hour left is not paused before a turn", callsOf(w.fake, "pause").length === 0);
	// It has run 20 minutes without a pause, kept up by turns: 45 minutes of turn and the lease no longer fit into the hour.
	w.fake.sandboxes.get(id)!.endAt = Number.MAX_SAFE_INTEGER;
	w.clock.now += 20 * MINUTE;
	w.fake.calls.length = 0;
	const before = handle.connection;
	const release = await handle.holdForTurn();
	const order = w.fake.calls.filter((call) => /^(pause|connect|setTimeout) /.test(call)).map((call) => call.split(" ")[0]);
	expect("a sandbox with too little of its hour left is paused and resumed before the turn starts", order.join() === "pause,connect,setTimeout" && handle.connection !== before && w.lines.some((line) => line.includes("e2b.sandbox.refreshed") && line.includes("20 min of the 60")), order.join());
	await release();
	w.fake.calls.length = 0;
	await (await handle.holdForTurn())();
	expect("after that it has a whole hour again", callsOf(w.fake, "pause").length === 0);
	const long = world({ turnLimitMs: 2 * 60 * MINUTE });
	const big = await long.make();
	const bigHandle = (await long.sandboxes.connect(big)) as E2bSandboxHandle;
	long.fake.sandboxes.get(big)!.endAt = Number.MAX_SAFE_INTEGER;
	long.clock.now += 20 * MINUTE;
	long.fake.calls.length = 0;
	await (await bigHandle.holdForTurn())();
	expect("where a turn may take longer than the plan's hour, pausing first would not help and is not done", callsOf(long.fake, "pause").length === 0);
});

await section("suspend, resume, destroy", async () => {
	const w = world();
	const id = await w.make("u1", "s1");
	const machine = w.machines.get(id)!;
	w.clock.now += 90_000;
	machine.commands.length = 0;
	await w.sandboxes.suspend(id);
	const path = tokenFilePath(id);
	expect("suspend removes an access token file a turn that was cut off left, then pauses", machine.commands.some((entry) => entry.command === `rm -f -- ${path} ${path}.tmp`) && w.fake.sandboxes.get(id)?.state === "paused" && (await w.sandboxes.state(id)) === "paused", machine.commands.map((entry) => entry.command).join(" | "));
	expect("the token file is where it is in a container: one per sandbox in Windlass's data directory", path === `${DATA_DIR}/access-token-${id}.json`);
	const paused = w.lines.find((line) => line.includes(`e2b.sandbox.paused id=${id}`));
	expect("a line says how long it ran and what that costs by estimate", paused !== undefined && paused.includes("uid=u1 session=s1: it ran 90 s at 1 vCPU and 1024 MiB, $0.0017 (estimated)"), paused);
	expect("E2B counted the same running time", w.fake.ranMs(id) === 90_000);
	const pausesBefore = callsOf(w.fake, "pause").length;
	await w.sandboxes.suspend(id);
	expect("suspending a paused sandbox does nothing", callsOf(w.fake, "pause").length === pausesBefore);

	w.clock.now += 10 * MINUTE;
	machine.commands.length = 0;
	const handle = await w.sandboxes.connect(id);
	expect("connect resumes it", handle !== undefined && w.fake.sandboxes.get(id)?.state === "running" && w.lines.some((line) => line.includes(`e2b.sandbox.resumed id=${id}`)));
	expect(
		"a resumed sandbox is tidied first: a Windlass a cut-off turn left is looked for, and its token file removed",
		machine.commands[0]?.command === "wlp-run tags-of windlass" && machine.commands.some((entry) => entry.command === `rm -f -- ${path} ${path}.tmp`),
		machine.commands.map((entry) => entry.command).join(" | "),
	);
	expect("the ten minutes it was paused are not running time", w.fake.ranMs(id) === 90_000);

	const busy = world();
	const slow = await busy.make();
	busy.fake.pauseBusy = 2;
	await busy.sandboxes.suspend(slow);
	expect("a pause E2B refuses for now is tried again", callsOf(busy.fake, "pause").length === 3 && busy.fake.sandboxes.get(slow)?.state === "paused");
	const stuck = world();
	const never = await stuck.make();
	stuck.fake.pauseBusy = 5;
	let gaveUp = "";
	await stuck.sandboxes.suspend(never).catch((error: unknown) => (gaveUp = error instanceof Error ? error.message : String(error)));
	expect("one that is refused three times is reported, with what stops the sandbox instead", /could not pause the sandbox \(its own timeout pauses it within 120 s\)/.test(gaveUp), gaveUp);

	w.clock.now += 30_000;
	await w.sandboxes.destroy(id);
	const killed = w.lines.find((line) => line.includes(`e2b.sandbox.killed id=${id}`));
	expect("destroy kills it, and a line says what the last stretch cost", w.fake.sandboxes.size === 0 && (await w.sandboxes.state(id)) === "none" && killed !== undefined && killed.includes("it ran 30 s at 1 vCPU and 1024 MiB, $0.0006 (estimated)"), killed);
	const killsBefore = callsOf(w.fake, "kill").length;
	await w.sandboxes.destroy(id);
	expect("destroying one that is gone does nothing", callsOf(w.fake, "kill").length === killsBefore && (await w.sandboxes.connect(id)) === undefined);
	const p = world();
	const sleeping = await p.make();
	await p.sandboxes.suspend(sleeping);
	p.lines.length = 0;
	await p.sandboxes.destroy(sleeping);
	expect("a paused sandbox is destroyed too, and the line says nothing ran", p.fake.sandboxes.size === 0 && p.lines.some((line) => line.includes("it was paused already, so nothing ran")), p.lines.join(" | "));

	const noPause = world({ pause: false });
	const brief = await noPause.make();
	expect("with WLP_E2B_PAUSE=0 a sandbox is killed when its timeout runs out", noPause.fake.sandboxes.get(brief)?.onTimeout === "kill");
	await noPause.sandboxes.suspend(brief);
	expect(
		"and suspend kills it, saying plainly what is lost",
		noPause.fake.sandboxes.size === 0 && noPause.lines.some((line) => line.includes(`e2b.sandbox.killed id=${brief}`) && line.includes("the files in its workspace and its Windlass session are lost")),
		noPause.lines.join(" | "),
	);
});

await section("the handle", async () => {
	const secrets: string[] = [];
	const w = world({}, { machine: () => imageLike((command, stdin) => (command.includes("umask 077") ? (secrets.push(stdin()), {}) : command === "cat /etc/hostname" ? { stdout: "sandbox\n" } : undefined)) });
	const id = await w.make();
	const handle = (await w.sandboxes.connect(id)) as E2bSandboxHandle;
	const machine = [...w.fake.sandboxes.values()][0]!.machine as ScriptedMachine;
	machine.commands.length = 0;
	await handle.writeSecretFile("/home/agent/.local/share/windlass/access-token-x.json", '{"accessToken":"FAKE-TOKEN-not-real"}');
	const write = machine.commands[0];
	expect("a secret goes in on standard input and is on no command line", secrets.join() === '{"accessToken":"FAKE-TOKEN-not-real"}' && write !== undefined && !write.command.includes("FAKE-TOKEN") && write.command.endsWith("sh /home/agent/.local/share/windlass/access-token-x.json") && write.options.stdin === true, write?.command);
	expect("it is written beside the file and renamed into place, readable by its owner only", /umask 077/.test(write?.command ?? "") && /mv -f -- "\$tmp" "\$1"/.test(write?.command ?? ""));
	expect("an argument is quoted for E2B's shell, whatever is in it", shellQuote("it's $HOME `x`") === `'it'\\''s $HOME \`x\`'` && shellQuote("plain-1.txt") === "plain-1.txt" && shellQuote("") === "''");
	machine.commands.length = 0;
	await handle.run("echo hi", { env: { A_B: "x y" }, cwd: "/tmp" });
	const ran = machine.commands[0];
	expect("run() goes through bash under wlp-run, with its environment beside the command and not in it", ran !== undefined && /^wlp-run exec r[a-f0-9]{12} bash -c 'echo hi'$/.test(ran.command) && ran.options.envs?.A_B === "x y" && ran.options.cwd === "/tmp", ran?.command);
	let bad = "";
	await Promise.resolve()
		.then(() => handle.run("true", { env: { "A;B": "x" } }))
		.catch((error: unknown) => (bad = error instanceof Error ? error.message : String(error)));
	expect("an environment variable's name that is none is refused", /invalid environment variable name/.test(bad));
	await handle.writeTextFile("notes/a.txt", "hello");
	expect("a relative path is the workspace's, as on Docker", machine.files.get("/workspace/notes/a.txt") === "hello" && (await handle.readTextFile("notes/a.txt")) === "hello" && (await handle.readTextFile("/workspace/notes/a.txt")) === "hello");
	let missing = "";
	await handle.readTextFile("nope.txt").catch((error: unknown) => (missing = error instanceof Error ? error.message : String(error)));
	expect("a file that is not there is an error that names it", /cannot read nope.txt/.test(missing), missing);
	const answer = await handle.ask(["cat", "/etc/hostname"]);
	expect("ask() runs a short program directly and returns what it said", answer?.code === 0 && answer.stdout === "sandbox\n" && machine.commands.at(-1)?.command === "cat /etc/hostname");
	await w.fake.pause(id);
	expect("ask() of a sandbox that is not running answers null, as the turn code expects", (await handle.ask(["true"])) === null);
});

await section("a sign-in that is forgotten", async () => {
	const w = world({ maxRunning: 5 });
	const one = await w.make("u1", "s1");
	const two = await w.make("u1", "s2");
	const other = await w.make("u2", "s3");
	const asleep = await w.make("u1", "s4");
	await w.sandboxes.suspend(asleep);
	for (const machine of w.machines.values()) machine.commands.length = 0;
	let loggedOut = "";
	const logins = { logout: async (uid: string) => void (loggedOut = uid) } as unknown as ChatgptLogins;
	const tokens: AccessTokens = { current: async () => ({ accessToken: "x".repeat(20), expiresAt: Date.now() + 3_600_000 }) };
	const layer = createE2bSandboxLayer({ logins, tokens }, { client: w.fake, settings: { ...SETTINGS, maxRunning: 5 }, log: () => undefined, now: () => w.clock.now });
	await layer.logins.logout("u1");
	const removed = (id: string) => (w.machines.get(id)?.commands ?? []).some((entry) => entry.command === `rm -f -- ${tokenFilePath(id)} ${tokenFilePath(id)}.tmp`);
	expect("logout forgets the sign-in, then removes the token files of the user's running turns, each in its own sandbox", loggedOut === "u1" && removed(one) && removed(two));
	expect("another user's sandbox is left alone, and a paused one is not started for it", !removed(other) && w.fake.sandboxes.get(asleep)?.state === "paused" && (w.machines.get(other)?.commands.length ?? 0) === 0);
});

await section("cleanup", async () => {
	const w = world({ maxRunning: 5 });
	const a = await w.make("u1", "s1");
	const b = await w.make("u2", "s2");
	await w.sandboxes.suspend(b);
	const foreign = await w.fake.plant({ [META.deployment]: "another" });
	const bare = await w.fake.plant({});
	w.clock.now += 5 * MINUTE;
	w.fake.sandboxes.get(a)!.endAt = Number.MAX_SAFE_INTEGER;
	w.fake.calls.length = 0;
	const dry = await cleanupDeployment(w.fake, "test", { kill: false, now: () => w.clock.now });
	expect("a dry run lists the deployment's sandboxes, running and paused, and changes nothing", dry.found.length === 2 && dry.killed.length === 0 && w.fake.sandboxes.size === 4 && !w.fake.calls.some((call) => call.startsWith("kill ")), dry.lines.join(" | "));
	expect(
		"each line names the sandbox, its user and session, and what it has cost at most",
		dry.lines.some((line) => line.startsWith(`${a}  uid=u1 session=s1  running, at most 300 s at 1 vCPU and 1024 MiB, $0.0055 (estimated) so far: would be killed`)) && dry.lines.some((line) => line.startsWith(`${b}  uid=u2 session=s2  paused`)) && /A dry run: nothing was changed/.test(dry.lines.at(-1) ?? ""),
		dry.lines.join(" | "),
	);
	const real = await cleanupDeployment(w.fake, "test", { kill: true, now: () => w.clock.now });
	expect("with --kill they are removed, paused ones too", real.killed.sort().join() === [a, b].sort().join() && real.failed.length === 0 && /Killed 2 of the 2 sandboxes/.test(real.lines.at(-1) ?? ""));
	expect("sandboxes of another deployment, and those that are not the platform's, are left alone", w.fake.sandboxes.size === 2 && w.fake.sandboxes.has(foreign) && w.fake.sandboxes.has(bare));
	const none = await cleanupDeployment(w.fake, "test", { kill: true });
	expect("with nothing left it says so", none.found.length === 0 && /has no sandboxes at E2B/.test(none.lines.join()));
});

await section("settings and prices", async () => {
	const defaults = readE2bSettings({});
	expect(
		"the defaults are the careful ones",
		defaults.maxRunning === 3 && defaults.idleTimeoutMs === 2 * MINUTE && defaults.turnLeaseMs === 3 * MINUTE && defaults.maxRuntimeMs === 60 * MINUTE && defaults.pause && !defaults.windlassSandbox && defaults.deployment === "default" && defaults.template === "windlass-platform-sandbox",
		JSON.stringify(defaults),
	);
	const set = readE2bSettings({ WLP_E2B_MAX_RUNNING: "1", WLP_E2B_DEPLOYMENT: "prod-1", WLP_E2B_IDLE_TIMEOUT_MS: "60000", WLP_E2B_PAUSE: "0", WLP_E2B_WINDLASS_SANDBOX: "1", WLP_TURN_TIMEOUT_MS: "600000", WLP_E2B_WINDLASS_VERSION: "0.4.0+abc" });
	expect("every one of them is read from the environment", set.maxRunning === 1 && set.deployment === "prod-1" && set.idleTimeoutMs === 60_000 && !set.pause && set.windlassSandbox && set.turnLimitMs === 600_000 && set.windlassVersion === "0.4.0+abc");
	expect("the turn limit is read as the server's own settings read it: the whole text as a number", readE2bSettings({ WLP_TURN_TIMEOUT_MS: "1e6" }).turnLimitMs === 1_000_000 && readE2bSettings({ WLP_TURN_TIMEOUT_MS: " 90000 " }).turnLimitMs === 90_000);
	const rejects = (env: NodeJS.ProcessEnv) => {
		try {
			readE2bSettings(env);
			return false;
		} catch {
			return true;
		}
	};
	expect("a value that makes no sense is refused, not guessed at", rejects({ WLP_E2B_MAX_RUNNING: "0" }) && rejects({ WLP_E2B_MAX_RUNNING: "many" }) && rejects({ WLP_E2B_IDLE_TIMEOUT_MS: "5" }) && rejects({ WLP_E2B_DEPLOYMENT: "a b" }) && rejects({ WLP_E2B_PAUSE: "yes" }));
	let noKey = "";
	try {
		readE2bConfig({});
	} catch (error) {
		noKey = error instanceof Error ? error.message : String(error);
	}
	expect("without E2B_API_KEY the provider refuses to be configured, and says what to set", /E2B_API_KEY is not set/.test(noKey), noKey);
	let layerError = "";
	const saved = process.env.E2B_API_KEY;
	delete process.env.E2B_API_KEY;
	try {
		createE2bSandboxLayer({ logins: {} as ChatgptLogins, tokens: { current: async () => ({ accessToken: "", expiresAt: 0 }) } });
	} catch (error) {
		layerError = error instanceof Error ? error.message : String(error);
	}
	if (saved !== undefined) process.env.E2B_API_KEY = saved;
	expect("so a server configured for E2B without a key does not start as if it could run agents", /E2B_API_KEY is not set/.test(layerError));
	const hour = estimatedCostUsd(3600, 1, 1024);
	expect("an hour of the default sandbox is estimated at about 6.7 cents", Math.abs(hour - 0.0666) < 1e-9 && describeUsage(3600, 1, 1024) === "3600 s at 1 vCPU and 1024 MiB, $0.0666 (estimated)", describeUsage(3600, 1, 1024));
});

await section("the template", async () => {
	// What E2B would be asked to build, from a context like the one sandbox/e2b/build.sh makes. Nothing is sent.
	const context = mkdtempSync(join(tmpdir(), "wlp-e2b-template-"));
	try {
		writeFileSync(join(context, "Dockerfile"), readFileSync(join(root, "sandbox/Dockerfile"), "utf8"));
		writeFileSync(join(context, "wlp-run"), readFileSync(join(root, "sandbox/wlp-run"), "utf8"));
		writeFileSync(join(context, "wlp-shot"), readFileSync(join(root, "sandbox/wlp-shot"), "utf8"));
		writeFileSync(join(context, "windlass"), "not a real binary\n");
		const text = describeTemplate(context);
		const lines = text.split("\n");
		expect("the template is the Docker image's Dockerfile: Ubuntu 24.04, the same packages", /^FROM ubuntu:24\.04/m.test(text) && /bubblewrap git ripgrep/.test(text), lines[0]);
		expect("it has the user agent, the workspace and Windlass's data directory", /useradd --create-home --uid 1000 --shell \/bin\/bash agent/.test(text) && /mkdir -p \/workspace \/home\/agent\/\.local\/share\/windlass/.test(text));
		expect("it copies the Windlass binary, wlp-run and wlp-shot into place", /COPY .*windlass \/usr\/local\/bin\/windlass/.test(text) && /COPY .*wlp-run \/usr\/local\/bin\/wlp-run/.test(text) && /COPY .*wlp-shot \/usr\/local\/bin\/wlp-shot/.test(text), lines.filter((line) => line.startsWith("COPY")).join(" | "));
		const users = lines.filter((line) => /^USER /.test(line));
		const workdirs = lines.filter((line) => /^WORKDIR /.test(line));
		expect("commands run as agent in /workspace by default", users.at(-1) === "USER agent" && workdirs.at(-1) === "WORKDIR /workspace", `${users.at(-1)} | ${workdirs.at(-1)}`);
		expect("the line that only keeps a container alive is left out", !/sleep/.test(text));
	} finally {
		rmSync(context, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------------------------
// A real turn: the fake client's sandboxes are containers of the sandbox image
// ---------------------------------------------------------------------------------------------

/** A fake sandbox whose commands run in a container, each started the way E2B starts one: a login shell that is given the command as one string. */
class ContainerMachine implements FakeMachine {
	private constructor(readonly container: string) {}

	static async make(id: string, image: string): Promise<ContainerMachine> {
		const name = `wlp-e2bfake-${run}-${id.slice(0, 12)}`;
		// As a session container of the first Docker profile, where bubblewrap works, but on a disk of its own (no
		// volume) and with no network at all: nothing these turns do needs one.
		const flags = ["--init", "--user", "agent", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--network", "none", "--memory", "1024m", "--memory-swap", "1024m", "--cpus", "1", "--pids-limit", "512", "--hostname", "sandbox", ...(PROFILE_RUN_FLAGS["docker-windlass-sandbox"] ?? [])];
		await docker(["run", "-d", "--pull", "never", "--name", name, "--label", LABEL_ARG, ...flags, image], { timeoutMs: 120_000, check: true });
		return new ContainerMachine(name);
	}

	async start(command: string, options: E2bCommandOptions): Promise<E2bCommand> {
		const envs = Object.entries(options.envs ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
		const child: ChildProcess = spawn("docker", ["exec", ...(options.stdin ? ["-i"] : []), "-u", "agent", "-w", options.cwd, ...envs, this.container, "bash", "-l", "-c", command], { stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
		child.stdout?.setEncoding("utf8").on("data", (text: string) => options.onStdout?.(text));
		child.stderr?.setEncoding("utf8").on("data", (text: string) => options.onStderr?.(text));
		child.stdin?.on("error", () => undefined);
		const done = new Promise<{ exitCode: number; error?: string }>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code, signal) => (signal !== null ? reject(new Error("the stream to the command was cut")) : resolve({ exitCode: code ?? -1 })));
		});
		done.catch(() => undefined);
		return {
			pid: child.pid ?? 0,
			sendStdin: (data) => new Promise<void>((resolve, reject) => child.stdin?.write(data, (error) => (error ? reject(error) : resolve()))),
			closeStdin: async () => void child.stdin?.end(),
			wait: () => done,
			// As E2B's: this side stops listening, the command goes on in the sandbox.
			disconnect: async () => void child.kill("SIGKILL"),
			kill: async () => void child.kill("SIGKILL"),
		};
	}

	async readFile(path: string): Promise<string> {
		const result = await docker(["exec", this.container, "cat", "--", path]);
		if (result.code !== 0) throw new Error(result.stderr.trim());
		return result.stdout;
	}

	async writeFile(path: string, content: string): Promise<void> {
		await docker(["exec", "-i", "-u", "agent", this.container, "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path], { stdin: content, check: true });
	}

	async paused(): Promise<void> {
		await docker(["pause", this.container]);
	}
	async resumed(): Promise<void> {
		await docker(["unpause", this.container]);
	}
	async killed(): Promise<void> {
		await docker(["rm", "-f", "-v", this.container]);
	}
}

async function stray(container: string): Promise<string[]> {
	const result = await docker(["exec", container, "ps", "-eo", "pid=,args="]);
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !/^1 /.test(line) && !/ sleep infinity$/.test(line) && !/ ps -eo/.test(line));
}

type Response = ScriptedModel["responses"][number];
const say = (text: string): Response => [{ type: "text", text }, { type: "finish", reason: "stop" }];
const shell = (callId: string, command: string): Response => [{ type: "tool_call", callId, name: "shell", input: { command } }, { type: "finish", reason: "tool_calls" }];
const TOKEN = "FAKE-ACCESS-TOKEN-E2B-TEST-not-a-real-token";

if (withDocker) {
	await section("a real turn", async () => {
		const image = await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
		if (image.code !== 0) {
			expect(`the sandbox image ${IMAGE} is here`, false, "build it with sandbox/build.sh");
			return;
		}
		const machines = new Map<string, ContainerMachine>();
		const fake = new FakeE2b({
			machine: async (id) => {
				const machine = await ContainerMachine.make(id, image.stdout.trim());
				machines.set(id, machine);
				return machine;
			},
		});
		const lines: string[] = [];
		let asked = 0;
		const tokens: AccessTokens = { current: async () => (asked++, { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 }) };
		const settings: E2bSettings = { ...SETTINGS, deployment: `test-${run}`, turnLeaseMs: 3_000, idleTimeoutMs: 10 * MINUTE };
		const layer = createE2bSandboxLayer({ logins: { logout: async () => undefined } as unknown as ChatgptLogins, tokens }, { client: fake, settings, log: (line) => lines.push(line) });
		const turn = async (handle: E2bSandboxHandle, prompt: string, script: ScriptedModel | undefined, extra: { windlassSessionId?: string; windlass?: typeof layer.windlass } = {}) => {
			const events: WindlassEvent[] = [];
			const questions: TurnQuestion[] = [];
			const result: RunTurnResult = await (extra.windlass ?? layer.windlass).runTurn(handle, {
				prompt,
				script,
				windlassSessionId: extra.windlassSessionId,
				onEvent: (event) => events.push(event),
				// Whatever Windlass asks about is allowed once: the turns here run what this file wrote.
				onQuestion: async (question) => (questions.push(question), { choice: question.choices.find((choice) => choice.approve)?.id ?? question.choices[0]?.id ?? "" }),
			});
			return { result, events, questions, outcome: (result.summary as { outcome?: string } | null)?.outcome };
		};
		try {
			const id = await layer.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
			const container = machines.get(id)!.container;
			const handle = (await layer.sandboxes.connect(id)) as E2bSandboxHandle;
			const version = await layer.windlass.version();
			const log = await handle.run("git log --oneline | wc -l; git status --short | wc -l; whoami; pwd; echo $LANG $NO_COLOR");
			expect("a new sandbox has an empty git repository in /workspace, and commands run as agent with the image's environment", log.exitCode === 0 && log.stdout.trim().split(/\s+/).join(" ") === "1 0 agent /workspace C.UTF-8 1", log.stdout.trim());
			expect("the Windlass version is known once a sandbox was made", version !== null && /^\d+\.\d+\.\d+/.test(version), String(version));
			const odd = ["a b", "it's", "$HOME", 'x"y', "`uname`", "", "é✓", "a\nb", "*", "~", "; echo no"];
			const echoed = await handle.exec(["printf", "[%s]", ...odd]);
			expect("every argument arrives as it was given, whatever is in it", echoed.exitCode === 0 && echoed.stdout === odd.map((item) => `[${item}]`).join(""), echoed.stdout);
			const mixed = await handle.run('cat; echo "to stderr" >&2; echo "$ODD"; exit 3', { stdin: "from stdin\n", env: { ODD: "it's $x \"y\"" } });
			expect("standard input, both outputs, the environment and the exit code come through", mixed.exitCode === 3 && mixed.stdout === 'from stdin\nit\'s $x "y"\n' && mixed.stderr === "to stderr\n", JSON.stringify(mixed));

			const controller = new AbortController();
			const began = Date.now();
			const stopping = handle.run("sleep 60 & sleep 60", { signal: controller.signal });
			setTimeout(() => controller.abort(), 700);
			const stopped = await stopping;
			expect("an abort stops the command inside the sandbox, and what it started", stopped.aborted && stopped.exitCode === null && Date.now() - began < 8_000 && (await stray(container)).length === 0, `${Date.now() - began} ms, ${(await stray(container)).join(" ; ")}`);
			const late = await handle.run("sleep 60", { timeoutMs: 700 });
			expect("so does a timeout", late.timedOut && late.exitCode === null && (await stray(container)).length === 0);

			const secret = `${DATA_DIR}/secret-test.json`;
			await handle.writeSecretFile(secret, `{"accessToken":"${TOKEN}"}`);
			const facts = await handle.run(`stat -c '%a %U' ${secret}; cat ${secret} | wc -c; ls ${DATA_DIR} | grep -c tmp`);
			expect("a secret file is written whole, readable by its owner only, with nothing left beside it", facts.stdout.trim().split(/\s+/).join(" ") === `600 agent ${`{"accessToken":"${TOKEN}"}`.length} 0`, facts.stdout.trim());
			await handle.removeFiles([secret]);
			expect("and removed again", (await handle.run(`ls ${secret}`)).exitCode !== 0);

			// A scripted turn through turn.ts: Windlass's real engine and real tool calls, a scripted model.
			fake.calls.length = 0;
			const first = await turn(handle, "Write a file and run it", { responses: [shell("w", "printf 'echo from-the-script\\n' > hello.sh && sh hello.sh"), shell("s", "sleep 4; cat hello.sh | wc -l"), say("Done.")] });
			const tools = first.events.filter((event) => event.type === "tool.settled").map((event) => String((event.data as { output?: unknown } | undefined)?.output ?? ""));
			expect(
				"a scripted turn runs to its end through the E2B provider: events, tool output, the summary",
				first.outcome === "succeeded" && first.result.exitCode === 0 && first.result.failure === null && !first.result.aborted && tools.some((output) => output.includes("from-the-script")) && first.events.at(-1)?.type === "cli.summary",
				`${first.outcome}, exit ${first.result.exitCode}, ${first.events.length} events, ${first.questions.length} question(s), ${first.result.failure?.message ?? ""} ${first.result.stderrTail}`,
			);
			const pushes = fake.calls.filter((call) => call.startsWith(`setTimeout ${id} `));
			expect(
				"while it ran the sandbox's timeout was pushed out, and set back to the short one at the end",
				pushes.length >= 3 && pushes[0] === `setTimeout ${id} 3000` && pushes.at(-1) === `setTimeout ${id} ${10 * MINUTE}` && pushes.slice(0, -1).every((call) => call === `setTimeout ${id} 3000`),
				`${pushes.length} calls`,
			);
			expect("a scripted turn is handed no access token", asked === 0 && !(await handle.run(`ls ${DATA_DIR}`)).stdout.includes("access-token"));
			expect("it leaves no process and no script file in the sandbox", (await stray(container)).length === 0 && (await handle.run("ls /tmp/.wlp-script-* 2>/dev/null | wc -l")).stdout.trim() === "0", (await stray(container)).join(" ; "));
			const session = first.result.windlassSessionId;
			const second = await turn(handle, "And again", { responses: [shell("c", "cat hello.sh"), say("Still there.")] }, { windlassSessionId: session ?? undefined });
			expect("the next turn continues the same Windlass session: its data directory is on the sandbox's disk", session !== null && second.outcome === "succeeded" && second.result.windlassSessionId === session, `${session} -> ${second.result.windlassSessionId}, ${second.result.failure?.message ?? ""}`);

			// A turn that is not scripted is handed its user's token in a file. A stand-in for the engine says what it found and exits.
			const standIn = new (layer.windlass.constructor as new (tokens: AccessTokens, options: { engineCommand: string[]; tokenFile: { log: (line: string) => void } }) => typeof layer.windlass)(tokens, {
				engineCommand: ["sh", "-c", 'echo "file=$WINDLASS_ACCESS_TOKEN_FILE mode=$(stat -c %a "$WINDLASS_ACCESS_TOKEN_FILE") holds=$(grep -c accessToken "$WINDLASS_ACCESS_TOKEN_FILE") $(cat "$WINDLASS_ACCESS_TOKEN_FILE")" >&2; exit 7'],
				tokenFile: { log: (line) => lines.push(line) },
			});
			const handed = await turn(handle, "Hello", undefined, { windlass: standIn });
			const tail = handed.result.stderrTail;
			expect(
				"a turn that is not scripted finds its user's access token in its sandbox's own file, readable by its owner only",
				asked === 1 && tail.includes(`file=${tokenFilePath(id)} mode=600 holds=1`) && handed.result.failure?.reason === "engine",
				tail.replace(TOKEN, "<the token>"),
			);
			expect(
				"the token itself is taken out of what the turn gives back",
				!tail.includes(TOKEN) && tail.includes("[access token removed]") && !JSON.stringify(handed.result).includes(TOKEN) && !lines.join("\n").includes(TOKEN),
				`in the tail: ${tail.includes(TOKEN)}, marked: ${tail.includes("[access token removed]")}, in the result: ${JSON.stringify(handed.result).includes(TOKEN)}, in the log: ${lines.join("\n").includes(TOKEN)}`,
			);
			expect("and the file is gone when the turn has ended", !(await handle.run(`ls ${DATA_DIR}`)).stdout.includes("access-token") && (await stray(container)).length === 0);

			// Suspend, resume: E2B keeps the disk; here the container is paused and unpaused.
			await layer.sandboxes.suspend(id);
			const pausedState = await docker(["container", "inspect", "--format", "{{.State.Status}}", container]);
			expect("suspend pauses the sandbox", (await layer.sandboxes.state(id)) === "paused" && pausedState.stdout.trim() === "paused");
			const again = (await layer.sandboxes.connect(id)) as E2bSandboxHandle;
			const third = await turn(again, "After the pause", { responses: [shell("c", "cat hello.sh"), say("Still there.")] }, { windlassSessionId: session ?? undefined });
			expect("after a resume the files and the Windlass session are there", third.outcome === "succeeded" && third.result.windlassSessionId === session && third.events.some((event) => event.type === "tool.settled" && String((event.data as { output?: unknown } | undefined)?.output ?? "").includes("from-the-script")));

			// The sandbox is gone: a new one has no Windlass session to continue.
			await layer.sandboxes.destroy(id);
			const exists = await docker(["container", "inspect", container]);
			expect("destroy removes the sandbox", exists.code !== 0 && (await layer.sandboxes.state(id)) === "none" && (await layer.sandboxes.connect(id)) === undefined);
			const fresh = await layer.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
			const freshHandle = (await layer.sandboxes.connect(fresh)) as E2bSandboxHandle;
			const orphan = await turn(freshHandle, "Go on", { responses: [say("Hello.")] }, { windlassSessionId: session ?? undefined });
			expect(
				"a sandbox made in place of one that is gone has no Windlass session to continue: the turn ends with session_not_found",
				orphan.result.failure?.reason === "session_not_found" && orphan.events.length === 0 && layer.sandboxes.sessionsLiveInSandbox,
				`${orphan.result.failure?.reason}: ${orphan.result.failure?.message}`,
			);
			const restart = await turn(freshHandle, "Start again", { responses: [say("Hello.")] });
			expect("and a turn that names none starts a new one there", restart.outcome === "succeeded" && restart.result.windlassSessionId !== null && restart.result.windlassSessionId !== session);
			await layer.sandboxes.destroy(fresh);
			expect("every line the provider logged about cost calls it an estimate, and none holds a token", lines.filter((line) => /\$\d/.test(line)).every((line) => line.includes("(estimated)")) && lines.filter((line) => /\$\d/.test(line)).length >= 3 && !lines.join("\n").includes(TOKEN));
		} finally {
			for (const machine of machines.values()) await docker(["rm", "-f", "-v", machine.container]).catch(() => undefined);
			const left = await docker(["ps", "-a", "--filter", `name=^wlp-e2bfake-${run}-`, "--format", "{{.Names}}"]);
			expect("every container this test started is removed", left.stdout.trim() === "", left.stdout.trim());
		}
	});
} else {
	console.log('\n== a real turn\n      skipped: run with --docker to drive real containers of the sandbox image through the provider');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
