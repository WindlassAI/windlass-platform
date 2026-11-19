/**
 * What a pull request shows was verified, on its own: a repository's checks as they are saved
 * (server/src/repository-checks.ts), how they reach Windlass (server/src/windlass-config.ts), what a
 * turn's events come to, what is looked for in the work's changes, and the section of a pull
 * request's description (server/src/verified.ts). No server, nothing sent anywhere.
 *
 *   cd server && npx tsx ../scripts/verified-check.ts
 *   cd server && ../scripts/locked.sh verified-check.ts --docker
 *
 * With --docker it also asks a real Windlass what it does with a user's checks and a repository's
 * own: real turns in local containers, with a scripted model and no sign-in. That is what the
 * platform's account of "whose check ran" rests on, so it is held to here, for both kinds of
 * Windlass, each asked what it takes and held to what follows from its answer:
 *
 *   without required checks (the released 0.2.0)   a list in the repository's `.windlass/config.json`
 *       stands in for the user's whole, `verify.mode` there turns the gate off, a file the agent
 *       writes during a turn counts from the next turn on, and a check's output is in a file
 *   with them                                       the user's checks run whatever that file says,
 *       in that turn and the next, the repository's own run besides them, and the evidence says
 *       whose each is, whether it is required, and carries the redacted end of an output; an
 *       ending that needed no check says why and what it rests on, a check that could not be
 *       started ends the turn at once and is kept apart from one that failed, a check named
 *       later runs with the next change, and a session it cannot read is refused with a reason
 *
 * The same cases run against the server's image, whose Windlass is the pinned release and takes
 * required checks, and against a throwaway image made from the last release without them, which
 * sandbox/fetch-windlass.sh keeps (`older`): the Windlass of a sandbox made before the image was
 * rebuilt. Where that release cannot be had, its half is skipped, and the check says so.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CHECK_OUTPUT_CHARS, MAX_CHECKS_PER_REPOSITORY, type RepositoryCheck, type Verified, type WindlassEvent } from "../server/src/contract.js";
import { evidenceSection } from "../server/src/github/publish.js";
import { CHECKS_TABLE, type ChecksDb, ChecksProblem, cleanChecks, readChecks, saveChecks, windlassChecks } from "../server/src/repository-checks.js";
import { DEFAULTS_TABLE } from "../server/src/repository-defaults.js";
import type { TurnChecks } from "../server/src/sandbox/api.js";
import { VerificationLog, type WorkDiff, checkScripts, isCheckOutputPath, isTestPath, outputTail, verifiedSection, verifiedWords, withOutputs, withVerifiedSection, workFlags } from "../server/src/verified.js";
import { PLATFORM_WAKE, platformConfig, projectChecks } from "../server/src/windlass-config.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
}
const plain = (value: unknown) => JSON.stringify(value);
const refused = (raw: unknown): string | null => {
	try {
		cleanChecks(raw);
		return null;
	} catch (error) {
		return error instanceof ChecksProblem ? error.message : `another error: ${String(error)}`;
	}
};

// ---- what may be saved ---------------------------------------------------------------------------

const TEST: RepositoryCheck = { name: "test", command: "npm test" };
const TYPES: RepositoryCheck = { name: "types", command: "npm run typecheck", timeoutSeconds: 300, when: ["src/**"] };
expect("a check is a name and a command, with Windlass's own optional fields and the platform's one", plain(cleanChecks([{ name: " test ", command: " npm test\r\n", junk: 1 }, { ...TYPES, showOutput: true }])) === plain([TEST, { ...TYPES, showOutput: true }]));
expect("a name is what Windlass takes for one, and no two are alike", refused([{ name: "has space", command: "x" }]) !== null && refused([{ name: "-x", command: "x" }]) !== null && (refused([TEST, TEST]) ?? "").includes('Two checks are named "test"'));
expect("a command is needed, a time limit is 1 to 3600 seconds, and a pattern cannot start with \"!\"", refused([{ name: "a", command: " " }]) !== null && refused([{ ...TEST, timeoutSeconds: 3601 }]) !== null && refused([{ ...TEST, timeoutSeconds: 1.5 }]) !== null && refused([{ ...TEST, when: ["!src/**"] }]) !== null);
expect("no pattern is no condition, and a list has its limit", cleanChecks([{ ...TEST, when: [" ", ""] }])[0]?.when === undefined && refused(Array.from({ length: MAX_CHECKS_PER_REPOSITORY + 1 }, (_, index) => ({ name: `c${index}`, command: "true" }))) !== null && refused("npm test") !== null);
expect("Windlass is handed its own fields and no other: it refuses a file with a key it does not know", plain(windlassChecks([{ ...TYPES, showOutput: true }])) === plain([{ name: "types", command: "npm run typecheck", timeoutSeconds: 300, when: ["src/**"] }]));
expect("as required checks they are the same list, and a check whose output is to be shown also when it passes says so in Windlass's own field", plain(windlassChecks([TEST, { ...TYPES, showOutput: true }], true)) === plain([{ name: "test", command: "npm test" }, { name: "types", command: "npm run typecheck", timeoutSeconds: 300, when: ["src/**"], outputTail: "always" }]));

// ---- storage: a table of its own beside the ones a user's record has -------------------------------

const sqlite = new DatabaseSync(":memory:");
/** The actor's database waits at every statement, so two saves started together take turns statement by statement. */
const db: ChecksDb = {
	async execute<Row extends Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> {
		await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
		const statement = sqlite.prepare(query);
		return (/^\s*(SELECT|PRAGMA)/i.test(query) ? statement.all(...(args as never[])) : (statement.run(...(args as never[])), [])) as Row[];
	},
};
// A record as the code before this change made it: its tables stay as they are, and the new one is added beside them.
await db.execute("CREATE TABLE IF NOT EXISTS setup_command (project TEXT PRIMARY KEY, label TEXT NOT NULL, command TEXT NOT NULL, updated_at INTEGER NOT NULL)");
await db.execute(DEFAULTS_TABLE);
await db.execute("INSERT INTO setup_command (project, label, command, updated_at) VALUES ('github:7101', 'acme/harbor', 'npm ci', 1)");
await db.execute(CHECKS_TABLE);
await db.execute(CHECKS_TABLE);
expect("a record from before the checks gets their table, keeps what it had, and has no checks", (await readChecks(db, "github:7101")).checks.length === 0 && (await db.execute<{ command: string }>("SELECT command FROM setup_command"))[0]?.command === "npm ci");
const saved = await saveChecks(db, "github:7101", "acme/harbor", [TEST, TYPES], 5);
expect("a list is saved whole and read back as it was saved", plain(saved) === plain({ checks: cleanChecks([TEST, TYPES]), updatedAt: 5 }));
let whole = true;
for (let round = 0; round < 20; round += 1) {
	const [one, two] = [[TEST], cleanChecks([TYPES, { name: "lint", command: "npm run lint" }])];
	await Promise.all([saveChecks(db, "github:7101", "acme/harbor", one, 10 + round), saveChecks(db, "github:7101", "", two, 10 + round)]);
	const kept = plain((await readChecks(db, "github:7101")).checks);
	if (kept !== plain(one) && kept !== plain(two)) whole = false;
}
expect("of two saves that run together one stays, whole, and a save without a name keeps the repository's", whole && (await db.execute<{ label: string }>("SELECT label FROM repository_checks"))[0]?.label === "acme/harbor");
expect("an empty list leaves no row", (await saveChecks(db, "github:7101", "acme/harbor", [], 99)).updatedAt === null && (await db.execute("SELECT project FROM repository_checks")).length === 0);

// ---- Windlass's own configuration file -------------------------------------------------------------

const had = JSON.stringify({ model: "gpt-6-luna", checks: [{ name: "left", command: "true" }], verify: { mode: "off" }, mcp: { servers: { mine: { command: "x" } } } });
const written = platformConfig(had, null, [], windlassChecks([TEST]));
const config = JSON.parse(written?.config ?? "{}") as Record<string, unknown>;
expect("the user's checks go into Windlass's own file as its checks, and what the file had under checks and verify goes", plain(config.checks) === plain([{ name: "test", command: "npm test" }]) && !("verify" in config) && written?.changed === true);
expect("whatever else the file holds is kept", config.model === "gpt-6-luna" && plain(config.mcp) === plain({ servers: { mine: { command: "x" } } }));
const withdrawn = platformConfig(written?.config ?? null, written?.written ?? null, []);
expect("with none to hand over, the file has no checks, and a file that held nothing else keeps only the platform's wake-ups off", !("checks" in JSON.parse(withdrawn?.config ?? "{}")) && platformConfig(JSON.stringify({ checks: [{ name: "a", command: "b" }] }), null, [])?.config === `${JSON.stringify({ wake: PLATFORM_WAKE }, null, 2)}\n`);
expect("a file that is not Windlass's is left alone", platformConfig("not json", null, [], windlassChecks([TEST])) === null);
const strays = platformConfig(JSON.stringify({ model: "gpt-6-luna", checks: [{ name: "left", command: "true" }], requiredChecks: [{ name: "planted", command: "true" }], verify: { maxRounds: 1 } }), null, []);
expect("where the checks are named when the session is opened the file gets none, and required checks or a verify setting a command left there go too", strays?.config === `${JSON.stringify({ model: "gpt-6-luna", wake: PLATFORM_WAKE }, null, 2)}\n` && strays.changed);
expect(
	"what a repository's own file says about checks is read, and nothing else of it",
	plain(projectChecks(JSON.stringify({ checks: [{ name: "smoke", command: "true" }], mcp: {} }))) === plain({ checks: 1, verify: null }) &&
		plain(projectChecks(JSON.stringify({ checks: [], verify: { mode: "off" } }))) === plain({ checks: 0, verify: "off" }) &&
		plain(projectChecks(JSON.stringify({ model: "x" }))) === plain({ checks: null, verify: null }) &&
		projectChecks(null) === null &&
		projectChecks("{") === null,
);

// ---- a turn's events -----------------------------------------------------------------------------

type Data = Record<string, unknown>;
let seq = 0;
const event = (type: string, data: Data = {}): WindlassEvent => ({ type, v: 1, data, seq: ++seq, time: 1_800_000_000_000 + seq });
const evidence = (...checks: Array<[name: string, command: string, status: string, extra?: Data]>) => ({
	run: 1,
	afterSeq: 0,
	changedFiles: ["src/add.js"],
	checks: checks.map(([name, command, status, extra]) => ({ name, command, status, exitCode: status === "passed" ? 0 : 1, signal: null, durationMs: 4200, files: ["src/add.js"], fingerprint: "f", reusedFromSeq: null, outputPath: `/tmp/windlass-1000/ses_x/.spill/checks/check-${name}-${"0".repeat(32)}.log`, outputBytes: status === "passed" ? 0 : 90, outputLines: 3, ...extra })),
});
const snapshot = (id: string, point: string) => event("snapshot.taken", { id, point, messageId: null });
const ran = (id: string, found: ReturnType<typeof evidence>) => [snapshot(id, "checks_start"), event("checks.started", { run: 1, checks: found.checks.map((check) => check.name) }), snapshot(id, "checks_end"), event("checks.finished", { run: 1, evidence: found })];
/** The harness's message with the checks that did not pass, as Windlass writes it with an ending that leaves them unresolved. */
const report = () => event("synthetic.appended", { messageId: "m", origin: "check_report", content: [] });
/** The same message and the model call that follows it: the agent is sent back. */
const sentBackWith = () => [report(), event("step.started", { stepId: "s", messageId: "m" })];
const succeeded = (verification: Data) => event("execution.succeeded", { executionId: "e", verification });
const log = (events: WindlassEvent[]) => {
	const made = new VerificationLog();
	for (const one of events) made.note(one);
	return made;
};
/** A turn on a Windlass without required checks: the user's list was written into its own file. */
const HANDED: TurnChecks = { required: false, handed: true, project: null };
/** A turn on a Windlass with them: the list was named when the session was opened, and the evidence says whose each check is. */
const REQUIRED: TurnChecks = { required: true, handed: true, project: null };
const failing = evidence(["test", "npm test", "failed"]);
const passing = evidence(["test", "npm test", "passed"]);

// The run recorded in the repository's own fixture: Windlass's real events, with their own names.
const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/windlass-events/demo-the-checks-fail-the-model-fixes-the-code-and-they-pass.jsonl"), "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as WindlassEvent);
const recorded = log(fixture).verified(1, [{ name: "test", command: "bun test" }], HANDED, null);
expect("a recorded run of Windlass's: the check failed, the agent was sent back once, and it passed", recorded.state === "passed" && plain(recorded.run?.checks.map((check) => [check.name, check.whose, check.status, check.sentBack])) === plain([["test", "user", "passed", 1]]) && !recorded.changedAfter, plain(recorded));

const sentBack = log([snapshot("w0", "delivery"), ...ran("w1", failing), ...sentBackWith(), ...sentBackWith(), snapshot("w2", "step_end"), ...ran("w2", passing), succeeded({ status: "passed", evidence: passing })]);
const twice = sentBack.verified(2, [TEST, TYPES], HANDED, null);
expect("each time the harness appends its report, the agent was sent back: twice here, and it is the user's check", twice.run?.checks[0]?.sentBack === 2 && twice.run.checks[0].whose === "user" && twice.run.turn === 2);
const fourRuns = log([...ran("w1", failing), ...sentBackWith(), ...ran("w2", failing), ...sentBackWith(), ...ran("w3", failing), ...sentBackWith(), ...ran("w4", failing), report(), succeeded({ status: "unresolved", reason: "max_rounds", failing: ["test"], acknowledgement: null, evidence: failing })]).verified(1, [TEST], HANDED, null);
const reportOnly = log([...ran("w1", failing), report(), succeeded({ status: "unresolved", reason: "report_mode", failing: ["test"], acknowledgement: null, evidence: failing })]).verified(1, [TEST], HANDED, null);
expect(
	"the message Windlass writes with an ending that leaves a check unresolved sends nobody back: after four failing runs the agent was sent back three times, and where checks only report, never",
	fourRuns.run?.checks[0]?.sentBack === 3 && reportOnly.run?.checks[0]?.sentBack === 0 && verifiedSection({ verified: reportOnly, flags: [], during: null, login: "ada" }).includes("- **test** (`npm test`), ada's check: failed with exit code 1 after 4.2 s.\n"),
	`${plain(fourRuns.run)} ${plain(reportOnly.run)}`,
);
expect("a check of the user's that is not among the ones that ran is listed as one that did not", plain(twice.unrun) === plain([{ name: "types", command: "npm run typecheck" }]) && !twice.replaced);

const others = evidence(["test", "true", "passed"], ["smoke", "true", "passed"]);
const replaced = log([...ran("w1", others), succeeded({ status: "passed", evidence: others })]).verified(1, [TEST], { ...HANDED, project: { checks: 2, verify: null } }, null);
expect("when the repository's file names a list, no check that ran is the user's, whatever it is called", replaced.replaced && replaced.run?.checks.every((check) => check.whose === "repository") === true && plain(replaced.unrun) === plain([{ name: "test", command: "npm test" }]));
const renamed = log([...ran("w1", others), succeeded({ status: "passed", evidence: others })]).verified(1, [TEST], HANDED, null);
expect("a check under the user's name with another command is not the user's either, nor is any check when the list was not handed over", renamed.run?.checks.every((check) => check.whose === "repository") === true && log([...ran("w1", passing), succeeded({ status: "passed", evidence: passing })]).verified(1, [TEST], { ...HANDED, handed: false }, null).run?.checks[0]?.whose === "repository");

const none = (handed: TurnChecks | undefined, own: RepositoryCheck[], extra: WindlassEvent[] = []) => log([...extra, succeeded({ status: "not_configured" })]).verified(1, own, handed, null).state;
expect(
	"when Windlass says no checks were in force, the reason is the one a field gives",
	none(HANDED, []) === "none_set" &&
		none({ ...HANDED, project: { checks: null, verify: "off" } }, [TEST]) === "off" &&
		none({ ...HANDED, project: { checks: 0, verify: null } }, [TEST]) === "emptied" &&
		none(HANDED, [TEST], [{ type: "notice", kind: "checks_not_run", message: "..." }]) === "no_sandbox" &&
		none({ ...HANDED, handed: false }, [TEST]) === "not_handed" &&
		none(HANDED, [TEST]) === "not_in_force",
);

const unresolved = log([...ran("w1", failing), ...sentBackWith(), succeeded({ status: "unresolved", reason: "acknowledged", failing: ["test"], acknowledgement: { checks: ["test"], reason: "The registry is down." }, evidence: failing })]).verified(1, [TEST], HANDED, null);
expect("a turn that ended with a check failing says why it was let end, in the agent's own reason where it gave one", unresolved.state === "unresolved" && plain(unresolved.unresolved) === plain({ reason: "acknowledged", said: "The registry is down." }));

const stopped = log([snapshot("w0", "delivery"), ...ran("w1", failing), ...sentBackWith(), snapshot("w2", "step_end"), event("execution.interrupted", { reason: "user" })]).verified(1, [TEST], HANDED, null);
expect("a turn stopped after its checks ran and before they ran again: the results are of an earlier state, and it says so", stopped.state === "stopped" && stopped.changedAfter && stopped.run?.checks[0]?.status === "failed");

const before = log([...ran("w1", passing), succeeded({ status: "passed", evidence: passing })]).verified(1, [TEST], HANDED, null);
const answered = log([snapshot("w1", "delivery"), succeeded({ status: "not_needed" })]).verified(2, [TEST], HANDED, before);
const edited = log([snapshot("w1", "delivery"), snapshot("w5", "step_end"), succeeded({ status: "not_configured" })]).verified(3, [TEST], { ...HANDED, project: { checks: null, verify: "off" } }, answered);
expect("a turn that ran no check keeps what the last run found, with the turn it was in", answered.state === "not_needed" && answered.run?.turn === 1 && !answered.changedAfter && answered.unrun.length === 0);
expect("and a later turn that changed files without a check says that files changed after the checks last ran", edited.state === "off" && edited.run?.turn === 1 && edited.changedAfter);
const cut = log([snapshot("w1", "delivery"), snapshot("w9", "step_end")]).cutOff(4, before);
expect("a turn cut off with its server keeps nothing of its own, and says the same", cut.state === "stopped" && cut.run?.turn === 1 && cut.changedAfter && log([]).cutOff(4, null).run === null);

const wanted = log([...ran("w1", evidence(["test", "npm test", "failed"], ["lint", "npm run lint", "passed", { outputBytes: 40 }], ["docs", "x", "passed", { outputBytes: 40, outputPath: "/etc/passwd" }]))]);
expect(
	"output is read for a check that did not pass and for one whose user asked, and only from a file Windlass names as it names them",
	plain(wanted.outputs([{ name: "lint", command: "npm run lint", showOutput: true }, { name: "docs", command: "x", showOutput: true }], HANDED).map((output) => output.name)) === plain(["test", "lint"]) &&
		isCheckOutputPath("/home/agent/.local/share/windlass/spill/checks/ses_1/check-test-e3b0c44298fc1c149afbf4c8996fb924.log") &&
		!isCheckOutputPath("/tmp/x/../../etc/check-test-e3b0c44298fc1c149afbf4c8996fb924.log") &&
		!isCheckOutputPath("check-test-e3b0c44298fc1c149afbf4c8996fb924.log") &&
		!isCheckOutputPath("/home/agent/.local/share/windlass/access-token-1.json"),
);
expect("the end of an output is kept, cut at a line", outputTail(`${"x".repeat(4000)}\nlast line\n`) === "last line" && outputTail(`${"line\n".repeat(1000)}`).length <= CHECK_OUTPUT_CHARS && outputTail("a\r\nb\u0007\n") === "a\nb");

// ---- the same, on a Windlass that takes the user's checks as required ones ---------------------------

/** A check as such a Windlass records it: who named it, whether it is required, and the end of what it printed where it keeps that. */
const named = (origin: string, required: boolean, printed: string | null = null): Data => ({ origin, required, outputTail: printed === null ? null : { text: printed, truncated: false } });
const alone = evidence(["test", "npm test", "passed", named("session", true)]);
const mineAlone = log([...ran("w1", alone), succeeded({ status: "passed", evidence: alone })]).verified(1, [TEST], REQUIRED, null);
expect("the user's check alone: it is the user's because the evidence says the session's opener named it, and it is required", plain(mineAlone.run?.checks.map((check) => [check.name, check.whose, check.required])) === plain([["test", "user", true]]) && !mineAlone.replaced && mineAlone.overruled === undefined && mineAlone.unrun.length === 0, plain(mineAlone));
const besides = evidence(["test", "npm test", "passed", named("session", true)], ["smoke", "true", "passed", named("project", false)]);
const both = log([...ran("w1", besides), succeeded({ status: "passed", evidence: besides })]).verified(1, [TEST], { ...REQUIRED, project: { checks: 1, verify: null } }, null);
expect("the repository's file names a check of its own: both ran, each is whose the evidence says, and the file replaced nothing", plain(both.run?.checks.map((check) => [check.name, check.whose, check.required ?? false])) === plain([["test", "user", true], ["smoke", "repository", false]]) && !both.replaced && both.overruled === true && both.unrun.length === 0, plain(both));
const switchedOff = log([...ran("w1", alone), succeeded({ status: "passed", evidence: alone })]).verified(1, [TEST], { ...REQUIRED, project: { checks: 0, verify: "off" } }, null);
expect("the repository's file names an empty list and turns verification off: the user's check ran all the same, and the record says the file had a say that did not hold for it", switchedOff.state === "passed" && switchedOff.run?.checks[0]?.required === true && !switchedOff.replaced && switchedOff.overruled === true);
const impostors = evidence(["test", "npm test", "passed", named("project", false)], ["lint", "npm run lint", "passed", named("user", true)], ["types", "npm run typecheck", "passed"]);
const notMine = log([...ran("w1", impostors), succeeded({ status: "passed", evidence: impostors })]).verified(1, [TEST, TYPES, { name: "lint", command: "npm run lint" }], REQUIRED, null);
expect("a check is the user's by that field alone: one under a saved name and command that the repository's file, Windlass's own file or nobody is said to have named is not, and is not called required", notMine.run?.checks.every((check) => check.whose === "repository" && check.required === undefined) === true && notMine.unrun.length === 3, plain(notMine));
expect("and the other way about: on a Windlass without required checks such fields decide nothing", log([...ran("w1", alone), succeeded({ status: "passed", evidence: alone })]).verified(1, [TEST], { ...HANDED, project: { checks: 1, verify: null } }, null).run?.checks[0]?.whose === "repository");
const printed = evidence(["test", "npm test", "failed", named("session", true, "not ok 1 - adds\ntoken [REDACTED:github-token]\n")], ["lint", "npm run lint", "passed", named("session", true, "lint: clean\n")], ["docs", "x", "passed", named("session", true)]);
const kept = log([...ran("w1", printed), ...sentBackWith(), succeeded({ status: "unresolved", reason: "max_rounds", failing: ["test"], acknowledgement: null, evidence: printed })]);
const tails = kept.verified(1, [TEST, { name: "lint", command: "npm run lint", showOutput: true }, { name: "docs", command: "x" }], REQUIRED, null);
expect(
	"the end of an output is the evidence's own, as Windlass redacted it: of the check that failed and of the one whose entry asked, and no file in the sandbox is read for it",
	plain(tails.run?.checks.map((check) => check.output ?? null)) === plain(["not ok 1 - adds\ntoken [REDACTED:github-token]", "lint: clean", null]) && kept.outputs([TEST], REQUIRED).length === 0 && kept.outputs([TEST], HANDED).length === 1 && kept.verified(1, [TEST], HANDED, null).run?.checks[0]?.output === undefined,
	plain(tails.run),
);
const notStarted = evidence(["test", "npm test", "could_not_start", { ...named("session", true), exitCode: null, durationMs: 0, startError: "the checks run only in the sandbox in this mode, and the sandbox is unavailable (bwrap: not found)" }]);
const blocked = log([{ type: "notice", kind: "checks_not_run", message: "..." }, ...ran("w1", notStarted), ...sentBackWith(), ...sentBackWith(), ...sentBackWith(), succeeded({ status: "unresolved", reason: "max_rounds", failing: ["test"], acknowledgement: null, evidence: notStarted })]).verified(1, [TEST], REQUIRED, null);
expect("where no sandbox can run a required check it is recorded as not started and the turn ends with it failing: the platform says that nothing was verified, with the check", blocked.state === "no_sandbox" && plain(blocked.run?.checks.map((check) => [check.whose, check.required, check.status, check.sentBack])) === plain([["user", true, "could_not_start", 3]]) && verifiedWords(blocked, [], null) === "nothing verified", plain(blocked));

// ---- the same, on a Windlass that also says what an ending rests on and keeps a check it could not start apart ----

/** The evidence of a run as such a Windlass records it: what its changes are measured from, and the session's required checks. */
const REFS = [{ name: "test", definition: "9f86d081" }];
const resting = <Found extends ReturnType<typeof evidence>>(found: Found, since: Data) => ({ ...found, since, requiredChecks: REFS });
const seqOf = (events: WindlassEvent[]) => events.at(-1)?.seq ?? 0;
const AT_START = { seq: 1, run: null };
const mineRequired = named("session", true);
const brokenOutput = named("session", true, "not ok 1 - adds\n");

// A first turn whose check passes, and a second in which it fails and the agent puts the files back as they were.
const firstRun = ran("w1", resting(evidence(["test", "npm test", "passed", mineRequired]), AT_START));
const turnOne = log([snapshot("w0", "delivery"), ...firstRun, succeeded({ status: "passed", evidence: resting(evidence(["test", "npm test", "passed", mineRequired]), AT_START) })]).verified(1, [TEST], REQUIRED, null);
const onFirst = { seq: seqOf(firstRun), run: { seq: seqOf(firstRun), run: 1 } };
const brokenRun = ran("w2", resting(evidence(["test", "npm test", "failed", brokenOutput]), onFirst));
const backEvents = (ending: Data) => [snapshot("w1", "delivery"), ...brokenRun, ...sentBackWith(), snapshot("w1", "step_end"), succeeded(ending)];
const back = log(backEvents({ status: "not_needed", reason: "state_unchanged", since: onFirst, requiredChecks: REFS })).verified(2, [TEST], REQUIRED, turnOne);
expect(
	"a check failed, the agent put the files back as they were when the checks last passed, and nothing more ran: the work rests on that earlier run, which is the one listed, and the failed run is kept apart as one that does not stand",
	turnOne.run?.seq === seqOf(firstRun) &&
		back.state === "not_needed" &&
		plain(back.unneeded) === plain({ reason: "state_unchanged", on: "run" }) &&
		plain(back.run) === plain(turnOne.run) &&
		plain(back.putBack) === plain([{ name: "test", command: "npm test", whose: "user", required: true, status: "failed", exitCode: 1, durationMs: 4200, sentBack: 1 }]) &&
		!back.changedAfter &&
		back.unrun.length === 0,
	plain(back),
);
const backSection = verifiedSection({ verified: back, flags: [], during: null, login: "ada" });
expect(
	"the section says which state the work is back on and which run verified it, gives the failed run one sentence, and lists the earlier run's checks under the turn they ran in, with no flag and no output of the failed run",
	backSection.split("\n\n").slice(2, -2).join("|") ===
		[
			"No check was run again when the agent's turn 2 ended: the files the checks cover are again as they were when the checks last passed, at the end of turn 1.",
			"A run of checks earlier in turn 2 did not pass (**test** failed with exit code 1 after 4.2 s, and the agent was sent back once). The agent then changed the files back, so that run says nothing about the work as it is now.",
			"The checks as they passed when turn 1 ended:",
			"- **test** (`npm test`), ada's required check: passed in 4.2 s.",
		].join("|") && verifiedWords(back, [], null) === "no check was needed",
	backSection,
);
const backOlder = log(backEvents({ status: "not_needed" }).map((one) => (one.type === "checks.finished" ? { ...one, data: { run: 1, evidence: evidence(["test", "npm test", "failed", brokenOutput]) } } : one))).verified(2, [TEST], REQUIRED, turnOne);
const backOlderSection = verifiedSection({ verified: backOlder, flags: [], during: null, login: "ada" });
expect(
	"the same turn on a Windlass that says neither why nor on what: told as it was before, word for word",
	backOlder.unneeded === undefined && backOlder.putBack === undefined && backOlder.run?.turn === 2 && backOlder.changedAfter &&
		backOlderSection.includes("No check ran in the agent's turn 2: it changed nothing the checks cover.\n\n- **test** (`npm test`), ada's required check: failed with exit code 1 after 4.2 s, and the agent was sent back once.\n\nTo look at:\n\n- Files changed after the checks last ran, so the results above are of an earlier state of the work.") &&
		backOlderSection.includes("<summary>The end of what test printed</summary>") &&
		verifiedWords(backOlder, [], null) === "no check was needed, 1 thing to look at",
	backOlderSection,
);

// The same in a session's first turn: the files are back as the session started, and no run has passed.
const startRun = ran("w2", resting(evidence(["test", "npm test", "failed", brokenOutput]), AT_START));
const toStart = log([snapshot("w1", "delivery"), ...startRun, ...sentBackWith(), snapshot("w1", "step_end"), succeeded({ status: "not_needed", reason: "state_unchanged", since: AT_START, requiredChecks: REFS })]).verified(1, [TEST], REQUIRED, null);
const toStartSection = verifiedSection({ verified: toStart, flags: [], during: null, login: "ada" });
expect(
	"back as the session started: no run is listed, the section says that no check has verified that state, and the check that failed is not said not to have run",
	plain(toStart.unneeded) === plain({ reason: "state_unchanged", on: "start" }) && toStart.run === null && toStart.putBack?.length === 1 && toStart.unrun.length === 0 && !toStart.changedAfter &&
		toStartSection.split("\n\n").slice(2, -2).join("|") ===
			"No check was run again when the agent's turn 1 ended: the files the checks cover are again as they were when the session started, a state no check has verified.|A run of checks earlier in turn 1 did not pass (**test** failed with exit code 1 after 4.2 s, and the agent was sent back once). The agent then changed the files back, so that run says nothing about the work as it is now.",
	toStartSection,
);
const elsewhere = log(backEvents({ status: "not_needed", reason: "state_unchanged", since: { seq: 3, run: { seq: 3, run: 1 } }, requiredChecks: REFS })).verified(2, [TEST], REQUIRED, turnOne);
expect(
	"a run the platform does not hold is not made up: neither it nor the failed one is listed, and the sentence names no turn",
	plain(elsewhere.unneeded) === plain({ reason: "state_unchanged", on: null }) && elsewhere.run === null && elsewhere.putBack?.length === 1 && verifiedSection({ verified: elsewhere, flags: [], during: null, login: "ada" }).includes("No check was run again when the agent's turn 2 ended: the turn changed files and left them as they were before."),
	plain(elsewhere),
);

// No check covers what changed, told apart from a turn that changed nothing.
const uncovered = log([snapshot("w1", "delivery"), snapshot("w3", "step_end"), succeeded({ status: "not_needed", reason: "not_covered", since: onFirst, requiredChecks: REFS })]).verified(2, [TEST], REQUIRED, turnOne);
const answeredOnly = log([snapshot("w1", "delivery"), succeeded({ status: "not_needed", reason: "turn_unchanged", since: onFirst, requiredChecks: REFS })]).verified(2, [TEST], REQUIRED, turnOne);
const uncoveredFirst = log([snapshot("w1", "delivery"), snapshot("w3", "step_end"), succeeded({ status: "not_needed", reason: "not_covered", since: AT_START, requiredChecks: REFS })]).verified(1, [TYPES], REQUIRED, null);
expect(
	"no check covers what changed: said as that, with the run the covered files still rest on and the note that files changed after it; a turn that changed no file is said to be that",
	plain(uncovered.unneeded) === plain({ reason: "not_covered", on: "run" }) && uncovered.run?.turn === 1 && uncovered.changedAfter && uncovered.putBack === undefined &&
		verifiedSection({ verified: uncovered, flags: [], during: null, login: "ada" }).includes("No check ran in the agent's turn 2: no check covers the files that differ from the state the checks last passed on, at the end of turn 1.\n\nChecks last ran when turn 1 ended:") &&
		verifiedWords(uncovered, [], null) === "no check covers what changed, 1 thing to look at" &&
		plain(answeredOnly.unneeded) === plain({ reason: "turn_unchanged", on: null }) && answeredOnly.run?.turn === 1 && !answeredOnly.changedAfter &&
		verifiedSection({ verified: answeredOnly, flags: [], during: null, login: "ada" }).includes("No check ran in the agent's turn 2: the turn changed no file.") &&
		verifiedWords(answeredOnly, [], null) === "no check was needed",
	`${plain(uncovered)} ${plain(answeredOnly)}`,
);
expect(
	"where no run has passed, it says that no check has verified the state the uncovered changes are measured from, and names the check that did not run",
	plain(uncoveredFirst.unneeded) === plain({ reason: "not_covered", on: "start" }) && uncoveredFirst.run === null && !uncoveredFirst.changedAfter &&
		verifiedSection({ verified: uncoveredFirst, flags: [], during: null, login: "ada" }).split("\n\n").slice(2, -2).join("|") === "No check ran in the agent's turn 1: no check covers the files that differ from the state the session started from, which no check has verified.|Did not run: **types** (`npm run typecheck`).",
	plain(uncoveredFirst),
);

// A check that could not be started: alone, and beside one that failed on the code.
const WHY = "the checks run only in the sandbox in this mode, and the sandbox is unavailable (bubblewrap (bwrap) is not installed.)";
const unstartedCheck: [string, string, string, Data] = ["test", "npm test", "could_not_start", { ...mineRequired, exitCode: null, durationMs: 0, startError: WHY }];
const unstartedRun = resting(evidence(unstartedCheck), AT_START);
const unstarted = log([{ type: "notice", kind: "checks_not_run", message: "..." }, ...ran("w1", unstartedRun), report(), succeeded({ status: "unresolved", reason: "not_started", failing: ["test"], acknowledgement: null, evidence: unstartedRun })]).verified(1, [TEST], REQUIRED, null);
const unstartedSection = verifiedSection({ verified: unstarted, flags: [], during: null, login: "ada" });
expect(
	"a check that was not started ends the turn at once: nothing was verified, the agent was not sent back, and Windlass's reason is shown as what there is to fix",
	unstarted.state === "unresolved" && plain(unstarted.unresolved) === plain({ reason: "not_started", said: null }) && plain(unstarted.run?.checks.map((check) => [check.status, check.sentBack, check.startError])) === plain([["could_not_start", 0, WHY]]) &&
		unstartedSection.split("\n\n").slice(2, -2).join("|") ===
			`Nothing was verified in the agent's turn 1: the check that applied was not started. That says nothing about the code, so the agent was not sent back to change anything: what there is to fix is the reason given with the check below.|- **test** (\`npm test\`), ada's required check: was not started: ${WHY}.` &&
		verifiedWords(unstarted, [], null) === "nothing verified, 1 check not started",
	unstartedSection,
);
const mixedRun = resting(evidence(["test", "npm test", "failed", brokenOutput], ["lint", "npm run lint", "could_not_start", { ...mineRequired, exitCode: null, durationMs: 0, startError: "ENOENT: no such file or directory, posix_spawn 'bwrap'" }], ["docs", "x", "passed", mineRequired]), AT_START);
const mixed = log([...ran("w1", mixedRun), ...sentBackWith(), ...sentBackWith(), ...sentBackWith(), succeeded({ status: "unresolved", reason: "max_rounds", failing: ["test", "lint"], acknowledgement: null, evidence: mixedRun })]).verified(1, [TEST], REQUIRED, null);
const mixedSection = verifiedSection({ verified: mixed, flags: [], during: null, login: "ada" });
expect(
	"beside a check that failed on the code: the agent was sent back for that one alone, the sentence counts it alone, and the one that was not started is said to be that",
	plain(mixed.run?.checks.map((check) => [check.name, check.sentBack, check.startError ?? null])) === plain([["test", 3, null], ["lint", 0, "ENOENT: no such file or directory, posix_spawn 'bwrap'"], ["docs", 0, null]]) &&
		mixedSection.includes("The agent's turn 1 ended with a check still failing: the agent had been sent back as often as a turn allows. Another check was not started, which says nothing about the code: the agent was not asked to change anything for it, and what there is to fix is the reason given with it below.") &&
		mixedSection.includes("- **test** (`npm test`), ada's required check: failed with exit code 1 after 4.2 s, and the agent was sent back 3 times.") &&
		mixedSection.includes("- **lint** (`npm run lint`), ada's required check: was not started: ENOENT: no such file or directory, posix_spawn 'bwrap'.") &&
		verifiedWords(mixed, [], null) === "1 of 3 checks failing, 1 not started",
	mixedSection,
);
const passedBeside = resting(evidence(unstartedCheck, ["docs", "x", "passed", mineRequired]), AT_START);
// Without what such a Windlass adds to the evidence, the ending alone says that it keeps the check apart.
const someStarted = log([...ran("w1", evidence(unstartedCheck, ["docs", "x", "passed", mineRequired])), report(), succeeded({ status: "unresolved", reason: "not_started", failing: ["test"], acknowledgement: null, evidence: passedBeside })]).verified(1, [TEST], REQUIRED, null);
expect(
	"beside a check that passed, it is not said that nothing was verified",
	someStarted.run?.checks[0]?.sentBack === 0 && verifiedSection({ verified: someStarted, flags: [], during: null, login: "ada" }).includes("The agent's turn 1 ended with a check that was not started. That says nothing about the code") && verifiedWords(someStarted, [], null) === "1 of 2 checks not started",
	plain(someStarted),
);
expect(
	"on a Windlass that sends the agent back over such a check, it is told as it was: nothing verified for want of a sandbox, the check as one that could not be started, and how often the agent was sent back",
	blocked.run?.checks[0]?.startError === undefined && verifiedSection({ verified: blocked, flags: [], during: null, login: "ada" }).includes("- **test** (`npm test`), ada's required check: could not be started after 0 ms, and the agent was sent back 3 times."),
);

// Keys this code does not know, in the evidence, in a check, in the end of an output and in an ending, change nothing.
const later = (value: unknown): unknown => (Array.isArray(value) ? value.map(later) : isPlain(value) ? { ...Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, later(inner)])), laterKey: { any: "thing" } } : value);
const isPlain = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value);
const backLater = log(backEvents({ status: "not_needed", reason: "state_unchanged", since: onFirst, requiredChecks: REFS }).map((one) => ({ ...one, data: later(one.data) as Data }))).verified(2, [TEST], REQUIRED, turnOne);
expect("a key of a later Windlass, anywhere in the evidence or in an ending, is passed over", plain(backLater) === plain(back), plain(backLater));
const narrower = resting(evidence(["test", "npm test", "passed", mineRequired]), onFirst);
const withTypes = { ...narrower, requiredChecks: [...REFS, { name: "types", definition: "1b4f0e98" }] };
const notNeededOne = log([...ran("w4", withTypes), succeeded({ status: "passed", evidence: withTypes })]).verified(2, [TEST, TYPES], REQUIRED, turnOne);
expect("a required check that the evidence names and that is not among the run's checks did not run because nothing it covers changed", plain(notNeededOne.unrun) === plain([{ name: "types", command: "npm run typecheck" }]) && verifiedSection({ verified: notNeededOne, flags: [], during: null, login: "ada" }).includes("Did not run: **types** (`npm run typecheck`). No changed file matches its patterns."));

// ---- what is looked for in the work's changes --------------------------------------------------------

const diff = (files: WorkDiff["files"], patch = "", extra: Partial<WorkDiff> = {}): WorkDiff => ({ files, patch, config: { before: null, after: null }, packageJson: { before: null, after: null }, ...extra });
const patchOf = (path: string, added: string[], removed: string[] = []) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");
const kinds = (found: ReturnType<typeof workFlags>) => found.map((flag) => `${flag.kind}:${flag.where.join(",")}`).join(" ");
expect(
	"a test is told by its file's name, or as code in a directory of tests that is not one of fixtures or helpers",
	["test/add.test.js", "src/add.spec.ts", "tests/test_add.py", "pkg/add_test.go", "spec/add_spec.rb", "src/test/java/AddTest.java", "__tests__/add.js", "tests/add.rs"].every(isTestPath) &&
		!["src/add.js", "tests/fixtures/big.json", "test/helpers/server.js", "docs/testing.md", "src/contest.py", "latest/index.js", "tests/data/sample.py"].some(isTestPath),
);
expect("ordinary work raises nothing: changed code, a changed test, a new test, a renamed test", kinds(workFlags(diff([{ status: "M", path: "src/add.js" }, { status: "M", path: "test/add.test.js" }, { status: "A", path: "test/sub.test.js" }, { status: "R096", path: "test/old.test.js", to: "test/new.test.js" }], patchOf("test/add.test.js", ['it("adds", () => {'], ['it("add", () => {'])), [TEST])) === "");
expect("a test's file deleted, or renamed to something that is not a test", kinds(workFlags(diff([{ status: "D", path: "test/sub.test.js" }, { status: "R100", path: "tests/test_add.py", to: "attic/add.py.txt" }, { status: "D", path: "src/old.js" }]), [])) === "tests_removed:test/sub.test.js,tests/test_add.py");
expect(
	"a test newly skipped is seen in a test's file, and one that was skipped before and still is, or a marker in other code, is not",
	kinds(workFlags(diff([{ status: "M", path: "test/add.test.js" }, { status: "M", path: "tests/test_add.py" }, { status: "M", path: "src/skip.js" }, { status: "M", path: "test/b.test.js" }], [patchOf("test/add.test.js", ['it.skip("adds", () => {'], ['it("adds", () => {']), patchOf("tests/test_add.py", ["@pytest.mark.skip(reason='later')"]), patchOf("src/skip.js", ["queue.skip(1); it.skip()"]), patchOf("test/b.test.js", ['it.skip("b, renamed", () => {'], ['it.skip("b", () => {'])].join("\n")), [])) ===
		"tests_skipped:test/add.test.js,tests/test_add.py",
);
const OWN = JSON.stringify({ checks: [{ name: "test", command: "npm test" }] });
expect(
	"the repository's check configuration changed: its checks or verify, and nothing else in that file",
	kinds(workFlags(diff([{ status: "A", path: ".windlass/config.json" }], "", { config: { before: null, after: OWN } }), [])) === "checks_changed:.windlass/config.json" &&
		kinds(workFlags(diff([{ status: "M", path: ".windlass/config.json" }], "", { config: { before: OWN, after: JSON.stringify({ ...JSON.parse(OWN), verify: { mode: "off" } }) } }), [])) === "checks_changed:.windlass/config.json" &&
		kinds(workFlags(diff([{ status: "M", path: ".windlass/config.json" }], "", { config: { before: OWN, after: JSON.stringify({ ...JSON.parse(OWN), model: "gpt-6-luna" }) } }), [])) === "",
);
const scripts = (test: string) => JSON.stringify({ scripts: { test, build: "tsc" } });
expect(
	"what a check's command runs changed: the package.json script it names, or a file it names; another script is nobody's check",
	kinds(workFlags(diff([{ status: "M", path: "package.json" }], "", { packageJson: { before: scripts("node --test"), after: scripts("node --test test/fast") } }), [TEST])) === "checks_changed:package.json" &&
		kinds(workFlags(diff([{ status: "M", path: "package.json" }], "", { packageJson: { before: scripts("node --test"), after: JSON.stringify({ scripts: { test: "node --test", build: "tsc -b" } }) } }), [TEST])) === "" &&
		kinds(workFlags(diff([{ status: "M", path: "scripts/check.sh" }], patchOf("scripts/check.sh", ["echo checking"])), [{ name: "all", command: "sh ./scripts/check.sh --fast" }])) === "checks_changed:scripts/check.sh",
);
expect(
	"a script is what a command runs: by itself, through a shell, or as an interpreter's program; a file the command only names, and a test's file, are not",
	kinds(workFlags(diff([{ status: "M", path: "tools/check.py" }], patchOf("tools/check.py", ["print('ok')"])), [{ name: "all", command: "CI=1 python3 tools/check.py && echo done" }])) === "checks_changed:tools/check.py" &&
		kinds(workFlags(diff([{ status: "M", path: "tools/check.ts" }], patchOf("tools/check.ts", ["console.log('ok')"])), [{ name: "all", command: "deno run tools/check.ts" }])) === "checks_changed:tools/check.ts" &&
		kinds(workFlags(diff([{ status: "M", path: "src/slugify.js" }], patchOf("src/slugify.js", ["export const a = 1;"])), [{ name: "syntax", command: "node --check src/slugify.js" }])) === "" &&
		kinds(workFlags(diff([{ status: "M", path: "test/add.test.js" }], patchOf("test/add.test.js", ["test('more', () => {});"])), [{ name: "test", command: "node test/add.test.js" }])) === "" &&
		kinds(workFlags(diff([{ status: "M", path: "src/a.js" }], patchOf("src/a.js", ["export const a = 1;"])), [{ name: "lint", command: "eslint src/a.js" }])) === "" &&
		checkScripts("npm test").length === 0,
);
expect(
	"a check that came to ignore an exit status: in the script it runs, in the file it names, in the repository's own list; one that always did is not this work's",
	kinds(workFlags(diff([{ status: "M", path: "package.json" }], "", { packageJson: { before: scripts("node --test"), after: scripts("node --test || true") } }), [TEST])) === "checks_changed:package.json exit_ignored:package.json" &&
		kinds(workFlags(diff([{ status: "M", path: "scripts/check.sh" }], patchOf("scripts/check.sh", ["npm test || exit 0"], ["npm test"])), [{ name: "all", command: "scripts/check.sh" }])) === "checks_changed:scripts/check.sh exit_ignored:scripts/check.sh" &&
		kinds(workFlags(diff([{ status: "M", path: ".windlass/config.json" }], "", { config: { before: OWN, after: JSON.stringify({ checks: [{ name: "test", command: "npm test; true" }] }) } }), [])) === "checks_changed:.windlass/config.json exit_ignored:.windlass/config.json" &&
		kinds(workFlags(diff([{ status: "M", path: "src/add.js" }]), [{ name: "test", command: "npm test || true" }])) === "",
);

// ---- the section ---------------------------------------------------------------------------------

const told = withOutputs(twice, new Map([["test", "ok 1 - adds\n# pass 1"]]));
{
	const evidence = { verified: told, during: 2, checks: [TEST], redact: (text: string) => text.replaceAll("private*label", "hidden") };
	const firstParagraph = (machine: { name: string | null } | null) => evidenceSection({ ...evidence, machine }, null, "ada").section.split("\n\n")[2];
	expect("the first paragraph credits the named machine that reported the checks", firstParagraph({ name: "nas" }) === "These checks ran on ada's own machine, “nas”; this is what that machine reported.");
	expect("a machine whose name was not kept is still credited", firstParagraph({ name: null }) === "These checks ran on ada's own machine; this is what that machine reported.");
	expect("a machine name is plain text, including Markdown, and its raw value is redacted first", firstParagraph({ name: "[**nas**](link)\nprivate*label" }) === "These checks ran on ada's own machine, “\\[\\*\\*nas\\*\\*\\]\\(link\\) hidden”; this is what that machine reported.");
	expect("a hosted session goes straight to the evidence", firstParagraph(null)?.startsWith("This was pushed while") === true);
}
const section = verifiedSection({ verified: told, flags: workFlags(diff([{ status: "D", path: "test/sub.test.js" }]), []), during: null, login: "ada" });
expect("the section names each check that ran, its command, whose it is, how it ended, how long it took and how often the agent was sent back", section.includes("- **test** (`npm test`), ada's check: passed in 4.2 s after the agent was sent back twice."), section);
expect("the checks that did not run are named, with why", section.includes("Did not run: **types** (`npm run typecheck`). No changed file matches its patterns."), section);
expect("what was seen in the changes is an observation, with its paths", section.includes("- Test files were deleted or renamed away: `test/sub.test.js`."));
expect("output is folded, and what was asked for is shown though the check passed", section.includes("<details>\n<summary>The end of what test printed</summary>") && section.includes("ok 1 - adds\n# pass 1"));
expect("nothing in it reads as approval: no tick, no badge, no image", !/[✓✔✅☑]|!\[|shields\.io|badge/i.test(section) && section.includes("It says what ran; it is not a review."));
const nothing = verifiedSection({ verified: log([succeeded({ status: "not_configured" })]).verified(1, [], HANDED, null), flags: [], during: null, login: "ada" });
expect("when nothing was verified it says so in one plain sentence", nothing.split("\n\n").slice(2, -2).join("|") === "Nothing was verified: no checks are set for this repository.", nothing);
const theirs = verifiedSection({ verified: replaced, flags: [], during: null, login: "ada" });
expect("a check from the repository's file is said to be that, and the user's are said not to have run because of it", theirs.includes("from the repository's `.windlass/config.json`: passed") && !theirs.includes("ada's check:") && theirs.includes("names checks of its own, and Windlass follows a repository's list in place of ada's checks."), theirs);
const mineSection = verifiedSection({ verified: mineAlone, flags: [], during: null, login: "ada" });
expect("a required check of the user's is said to be both, and where the repository's file had no say nothing more is said of it", mineSection.includes("- **test** (`npm test`), ada's required check: passed in 4.2 s.") && !mineSection.includes(".windlass/config.json"), mineSection);
const bothSection = verifiedSection({ verified: both, flags: [], during: null, login: "ada" });
expect(
	"with required checks a user's check and the repository's own both ran, each labelled, and the section says whom the repository's settings held for and no longer that the user's did not run",
	bothSection.includes("The 2 checks that applied passed") &&
		bothSection.includes("- **test** (`npm test`), ada's required check: passed in 4.2 s.") &&
		bothSection.includes("- **smoke** (`true`), from the repository's `.windlass/config.json`: passed in 4.2 s.") &&
		bothSection.includes("\n\nThe repository's `.windlass/config.json` says something about checks too. That holds for the repository's own checks: ada's checks are required, and that file can neither replace them nor switch them off.\n\n") &&
		!bothSection.includes("Did not run") &&
		!bothSection.includes("names checks of its own") &&
		verifiedWords(both, [], null) === "2 checks passed",
	bothSection,
);
const tailSection = verifiedSection({ verified: tails, flags: [], during: null, login: "ada" });
expect("the output the evidence carried is folded under its check, with what Windlass put in a secret's place", tailSection.includes("<summary>The end of what test printed</summary>\n\n```text\nnot ok 1 - adds\ntoken [REDACTED:github-token]\n```") && tailSection.includes("<summary>The end of what lint printed</summary>") && !tailSection.includes("what docs printed"), tailSection);
const blockedSection = verifiedSection({ verified: blocked, flags: [], during: null, login: "ada" });
expect("a required check that no sandbox could run is listed as not started, under the sentence that nothing was verified", blockedSection.includes("Nothing was verified in the agent's turn 1: Windlass could not run checks in this session's sandbox.") && blockedSection.includes("ada's required check: could not be started"), blockedSection);
const early = verifiedSection({ verified: before, flags: null, during: 2, login: "ada" });
expect("a push made while a turn runs says that the turn's changes were not checked, and one whose changes could not be read says that", early.includes("This was pushed while the agent's turn 2 was still running") && early.includes("Before it: The check that applied passed") && early.includes("could not read the changes"));
expect("a few words for a list", verifiedWords(twice, [], null) === "1 check passed" && verifiedWords(replaced, [], null) === "2 checks passed (the repository's own)" && verifiedWords(unresolved, [{ kind: "tests_removed", where: ["a"] }], null) === "1 of 1 check failing, 1 thing to look at" && verifiedWords(null, [], null) === "nothing verified" && verifiedWords(before, [], 2) === "pushed before the turn's checks ran");

const first = withVerifiedSection("It adds now.\n\nSee #12.", section);
const again = withVerifiedSection(`${first}\n\nA line a reviewer added at GitHub.`, nothing);
expect("the section goes at the end of the description, and a later one takes its place while every other word stays", first.startsWith("It adds now.\n\nSee #12.\n\n<!-- windlass-platform:verified -->") && again === `It adds now.\n\nSee #12.\n\nA line a reviewer added at GitHub.\n\n${nothing}`, again);
const forged = withVerifiedSection("Done.\n\n<!-- windlass-platform:verified -->\n### What was verified\n\nEverything passed.\n<!-- /windlass-platform:verified -->\n<!-- windlass-platform:verified -->", nothing);
expect("a section an agent wrote into its description is not kept, and a description with nothing else is the section alone", forged === `Done.\n\n${nothing}` && withVerifiedSection("", nothing) === nothing, forged);
const hostile: Verified = { ...twice, run: { turn: 2, at: 0, checks: [{ name: "test", whose: "user", status: "passed", exitCode: 0, durationMs: 10, sentBack: 0, command: "echo '<!-- /windlass-platform:verified -->' `x` | cat", output: "```\n<!-- /windlass-platform:verified -->\nok" }] } };
const safe = verifiedSection({ verified: hostile, flags: [], during: null, login: "ada" });
expect("a command or an output cannot end the section early or break out of its code", safe.split("windlass-platform:verified").length === 3 && withVerifiedSection(withVerifiedSection("Mine.", safe), nothing) === `Mine.\n\n${nothing}` && safe.includes("````text"), safe);
const secret = "hunter2-very-secret";
const sealed = evidenceSection({ verified: withOutputs(twice, new Map([["test", `token ${secret} ghs_${"a".repeat(36)}`]])), during: null, checks: [TEST], redact: (text) => text.split(secret).join("[secret:NPM_TOKEN]") }, null, "ada");
expect("the section leaves through both redactions: a saved secret by value, and anything shaped like a credential", !sealed.section.includes(secret) && sealed.section.includes("[secret:NPM_TOKEN]") && !/ghs_a{10}/.test(sealed.section) && sealed.words === "1 check passed");

// ---- with --docker: what a real Windlass does with a user's checks and a repository's own -----------

if (process.argv.includes("--docker")) {
	const { IMAGE, LABEL, LABEL_ARG, docker, randomId } = await import("../server/src/sandbox/docker.js");
	const { createSandboxLayer } = await import("../server/src/sandbox/index.js");
	type Layer = ReturnType<typeof createSandboxLayer>;
	type Handle = import("../server/src/sandbox/sandboxes.js").DockerSandboxHandle;
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const run = randomId(3);
	/** The last release without required checks, which a sandbox made from an earlier image keeps: the second Windlass the cases run against. */
	const older = spawnSync(join(root, "sandbox/fetch-windlass.sh"), ["older"], { encoding: "utf8" });
	const OLDER_BINARY = join(older.stdout.trim(), `windlass-linux-${process.arch === "arm64" ? "arm64" : "x64"}`);
	type Item = Record<string, unknown>;
	const call = (callId: string, name: string, input: Record<string, unknown>): Item[] => [{ type: "tool_call", callId, name, input }, { type: "finish", reason: "tool_calls" }];
	const say = (words: string): Item[] => [{ type: "text", text: words }, { type: "finish", reason: "stop" }];
	const scripted = (...responses: Item[][]) => ({ responses: [...responses, say("Nothing more."), say("Nothing more."), say("Nothing more.")] });
	const write = (callId: string, content: string, path = "app.txt") => call(callId, "write", { path, content });
	/** Made up, and shaped like a GitHub token: what Windlass's own redaction takes out of a check's output. */
	const TOKEN = `ghp_${"R3quiredCh3cksMadeUpT0ken".padEnd(36, "x")}`;
	const OWN_CHECK: RepositoryCheck = { name: "test", command: "sh test.sh" };
	const SWITCHED_OFF = { checks: [], verify: { mode: "off" } };
	const facts = (verified: Verified) => plain(verified.run?.checks.map((check) => [check.name, check.command, check.whose, check.required ?? false, check.status, check.sentBack]) ?? null);

	/** The cases, against the Windlass of one image: what it says it takes decides what is expected of it, and `takes` is what it has to say. */
	async function cases(layer: Layer, image: string, takes: boolean): Promise<void> {
		const created: string[] = [];
		const users: string[] = [];
		async function sandbox(name: string, project?: unknown): Promise<Handle> {
			const user = `verified-${run}-${name}-${users.length}`;
			users.push(user);
			await layer.logins.ensureUserVolume(user);
			const id = await layer.sandboxes.create({ uid: user, sessionId: `s-${name}`, profile: "docker-windlass-sandbox" });
			created.push(id);
			const handle = (await layer.sandboxes.connect(id)) as Handle;
			await handle.writeTextFile("/workspace/test.sh", `grep -q fixed app.txt || { echo "app.txt is not fixed"; echo "token ${TOKEN}"; exit 1; }\necho "app.txt is fixed"\n`);
			await handle.writeTextFile("/workspace/app.txt", "broken\n");
			if (project !== undefined) await handle.writeTextFile("/workspace/.windlass/config.json", JSON.stringify(project));
			return handle;
		}
		/** One turn, and what the platform makes of its events: as the session's turn `number`, after `previous`. */
		async function turn(handle: Handle, script: ReturnType<typeof scripted>, checks: RepositoryCheck[], windlassSessionId?: string, number = 1, previous: Verified | null = null, onEvent?: (one: WindlassEvent) => void) {
			const made = new VerificationLog();
			const events: WindlassEvent[] = [];
			const result = await layer.windlass.runTurn(handle, { prompt: "go", script, checks, windlassSessionId, onEvent: (one) => (events.push(one), made.note(one), onEvent?.(one)), onQuestion: async () => ({ choice: "once" }) });
			return { result, log: made, events, verified: made.verified(number, checks, result.checks, previous) };
		}
		const reports = (events: WindlassEvent[]) => events.filter((one) => one.type === "synthetic.appended" && one.data?.origin === "check_report").length;
		const section = (verified: Verified) => verifiedSection({ verified, flags: [], during: null, login: "ada" });
		const fixes = () => scripted(write("c1", "still broken\n"), say("Done."), write("c2", "fixed\n"), say("Fixed."));

		try {
			const a = await sandbox("a");
			const { requiredChecks: required } = await layer.windlass.features(a);
			console.log(`\nwith the Windlass of ${image} (${(await layer.windlass.version()) ?? "unknown version"}), which ${required ? "takes" : "does not take"} required checks:`);
			const expectAs = (what: string, ok: boolean, detail = "") => expect(`${required ? "[required]" : "[replaceable]"} ${what}`, ok, detail);
			expectAs(takes ? "the server's image has a Windlass with required checks" : "the older release has none", required === takes);

			// (a) The user's check alone.
			const fixed = await turn(a, fixes(), [{ ...OWN_CHECK, showOutput: true }]);
			expectAs(
				`the user's check runs before the turn ends; it fails, the agent is sent back, and it passes${required ? ": the evidence says it is the session's and required" : ", handed over in Windlass's own file"}`,
				fixed.verified.state === "passed" && facts(fixed.verified) === plain([["test", "sh test.sh", "user", required, "passed", 1]]),
				plain(fixed.verified),
			);
			expectAs(`the layer says ${required ? "that the checks were named as required ones" : "that it wrote the checks into Windlass's file"}, and that the repository's file names none`, plain(fixed.result.checks) === plain({ required, handed: true, project: null }), plain(fixed.result.checks));
			const left = await a.run("cat /home/agent/.config/windlass/config.json 2>/dev/null || echo none");
			expectAs("Windlass's own file in the sandbox holds no check when the turn has ended", left.stdout.trim() === "none", left.stdout.trim());
			const shown = fixed.verified.run?.checks[0]?.output;
			const paths = fixed.log.outputs([{ ...OWN_CHECK, showOutput: true }], fixed.result.checks);
			if (required) expectAs("the end of the passing check's output is in the evidence because its entry asks for it, and no file is to be read", shown === "app.txt is fixed" && paths.length === 0, `${plain(shown)} ${plain(paths)}`);
			else expectAs("the passing check's output is in the file its evidence names, which the platform reads because the user asked", shown === undefined && paths.length === 1 && (await a.run(`tail -c 400 -- '${paths[0]?.path}'`)).stdout.trim() === "app.txt is fixed", `${plain(shown)} ${plain(paths)}`);

			// (b) The repository's file names a check of its own.
			const b = await sandbox("b", { checks: [{ name: "smoke", command: "true" }] });
			const theirs = await turn(b, fixes(), [OWN_CHECK]);
			if (required) expectAs("a list in the repository's .windlass/config.json runs besides the user's check, after it: both ran, each is whose the evidence says, and the user's sent the agent back", theirs.verified.state === "passed" && facts(theirs.verified) === plain([["test", "sh test.sh", "user", true, "passed", 1], ["smoke", "true", "repository", false, "passed", 0]]) && !theirs.verified.replaced && theirs.verified.overruled === true && theirs.verified.unrun.length === 0, plain(theirs.verified));
			else expectAs("a list in the repository's .windlass/config.json stands in for the user's whole: its check runs, the user's does not, and the turn is called done", facts(theirs.verified) === plain([["smoke", "true", "repository", false, "passed", 0]]) && theirs.verified.replaced && plain(theirs.verified.unrun.map((check) => check.name)) === plain(["test"]), plain(theirs.verified));

			// (c) The repository's file names an empty list and turns verification off.
			const c = await sandbox("c", SWITCHED_OFF);
			const off = await turn(c, fixes(), [OWN_CHECK]);
			if (required) expectAs("checks: [] and verify.mode off in the repository's file change nothing for the user's check: it runs, sends the agent back, and passes", off.verified.state === "passed" && facts(off.verified) === plain([["test", "sh test.sh", "user", true, "passed", 1]]) && off.verified.overruled === true, plain(off.verified));
			else expectAs("checks: [] and verify.mode off in the repository's file turn the gate off for the user's checks, and the platform says which file did", off.verified.state === "off" && off.verified.run === null, plain(off.verified));

			// (d) The agent writes the repository's file during a turn, then a second turn.
			const d = await sandbox("d");
			const during = await turn(d, scripted(write("c1", JSON.stringify({ checks: [{ name: "test", command: "true" }], verify: { mode: "off" } }), ".windlass/config.json"), write("c2", "still broken\n"), say("Done."), say("Giving up."), say("Giving up."), say("Giving up.")), [OWN_CHECK]);
			expectAs("a repository's file the agent writes during a turn changes nothing in that turn: the user's check still runs, and fails", during.verified.state === "unresolved" && facts(during.verified) === plain([["test", "sh test.sh", "user", required, "failed", 3]]) && during.verified.unresolved?.reason === "max_rounds", plain(during.verified));
			const after = await turn(d, scripted(write("c3", "broken again\n"), say("Done."), write("c4", "fixed\n"), say("Fixed.")), [OWN_CHECK], during.result.windlassSessionId ?? undefined);
			if (required) expectAs("nor in the next: the user's check runs and gates, and the repository's check of its name is not run in its place", after.verified.state === "passed" && facts(after.verified) === plain([["test", "sh test.sh", "user", true, "passed", 1]]) && !after.verified.replaced && after.verified.overruled === true, plain(after.verified));
			else expectAs("from the next turn on it does: nothing runs, and the platform says that the file turned verification off", after.verified.state === "off" && after.verified.run === null && after.verified.replaced, plain(after.verified));

			// The agent changes the file each time it is sent back, and the check never passes: Windlass writes its message a fourth time with the ending.
			const tries = await sandbox("tries");
			const tried = await turn(tries, scripted(write("c1", "broken 1\n"), say("Done."), write("c2", "broken 2\n"), say("Done."), write("c3", "broken 3\n"), say("Done."), write("c4", "broken 4\n"), say("Done.")), [OWN_CHECK]);
			expectAs(
				"a check that fails in four runs, the agent changing the file between them: Windlass writes its message four times, the last with the ending, and the agent was sent back three times",
				tried.verified.state === "unresolved" && tried.verified.unresolved?.reason === "max_rounds" && reports(tried.events) === 4 && tried.events.filter((one) => one.type === "checks.finished").length === 4 && facts(tried.verified) === plain([["test", "sh test.sh", "user", required, "failed", 3]]),
				`${reports(tried.events)} messages; ${plain(tried.verified)}`,
			);

			// (e) What the failing check printed, and a secret-looking value in it.
			const failingOutput = during.verified.run?.checks[0]?.output;
			const files = during.log.outputs([OWN_CHECK], during.result.checks);
			const everything = plain(during.events);
			if (required) expectAs("the end of the failing check's output is in the evidence, with the secret-looking value redacted by Windlass, and no file is to be read", failingOutput !== undefined && failingOutput.startsWith("app.txt is not fixed\ntoken ") && !failingOutput.includes(TOKEN) && files.length === 0, `${plain(failingOutput)} ${plain(files)}`);
			else {
				const read = files[0] ? await d.run(`tail -c 400 -- '${files[0].path}'`) : null;
				expectAs("the output of the failing check is in the file its evidence names, redacted by Windlass before it was kept", failingOutput === undefined && read !== null && read.stdout.startsWith("app.txt is not fixed\ntoken ") && !read.stdout.includes(TOKEN), `${plain(files)} ${read?.stdout}`);
			}
			expectAs("and that value is in no event of the turn", !everything.includes(TOKEN) && everything.includes("app.txt is not fixed"));

			// Where commands are sandboxed and no sandbox can run: bubblewrap is taken away in this container.
			const f = await sandbox("f");
			const gone = await docker(["exec", "-u", "0", f.container, "sh", "-c", 'mv "$(command -v bwrap)" /root/bwrap.off']);
			const noSandbox = await turn(f, scripted(write("c1", "fixed\n"), say("Done."), say("Giving up."), say("Giving up."), say("Giving up.")), [OWN_CHECK]);
			if (required)
				expectAs(
					"where no sandbox can run, the user's required check is recorded as not started and the turn ends at once, the agent not sent back: nothing was verified, and Windlass's reason is what the platform shows as the thing to fix",
					gone.code === 0 &&
						noSandbox.verified.state === "unresolved" &&
						noSandbox.verified.unresolved?.reason === "not_started" &&
						// Windlass tells the agent once, in the message it sends failing checks with, that the check was not started and that nothing is asked of it.
						reports(noSandbox.events) === 1 &&
						plain(noSandbox.verified.run?.checks.map((check) => [check.whose, check.required, check.status, check.sentBack, (check.startError ?? "").includes("the sandbox is unavailable")])) === plain([["user", true, "could_not_start", 0, true]]) &&
						section(noSandbox.verified).includes("Nothing was verified in the agent's turn 1: the check that applied was not started.") &&
						section(noSandbox.verified).includes("ada's required check: was not started: the checks run only in the sandbox in this mode") &&
						verifiedWords(noSandbox.verified, [], null) === "nothing verified, 1 check not started",
					plain(noSandbox.verified),
				);
			else expectAs("where no sandbox can run, the checks are passed over and the turn is called done: the platform says that nothing was verified", gone.code === 0 && noSandbox.verified.state === "no_sandbox" && noSandbox.verified.run === null, plain(noSandbox.verified));

			// (g) A check fails in a turn, the agent puts the file back as it was when the checks last passed, and nothing more runs.
			const g = await sandbox("g");
			const passed = await turn(g, fixes(), [OWN_CHECK]);
			const session = passed.result.windlassSessionId ?? undefined;
			const back = await turn(g, scripted(write("c3", "broken again\n"), say("Done."), write("c4", "fixed\n"), say("Put back.")), [OWN_CHECK], session, 2, passed.verified);
			if (required)
				expectAs(
					"a check fails, the agent puts the file back as it was when the checks last passed, and Windlass runs nothing more: it says why and on which run that rests, and the platform lists that run under its turn and gives the failed one a sentence",
					back.verified.state === "not_needed" &&
						plain(back.verified.unneeded) === plain({ reason: "state_unchanged", on: "run" }) &&
						plain(back.verified.run) === plain(passed.verified.run) &&
						plain(back.verified.putBack?.map((check) => [check.name, check.status, check.sentBack, check.output ?? null])) === plain([["test", "failed", 1, null]]) &&
						!back.verified.changedAfter &&
						back.verified.unrun.length === 0 &&
						section(back.verified).includes("No check was run again when the agent's turn 2 ended: the files the checks cover are again as they were when the checks last passed, at the end of turn 1.") &&
						section(back.verified).includes("The checks as they passed when turn 1 ended:\n\n- **test** (`sh test.sh`), ada's required check: passed in"),
					plain(back.verified),
				);
			else
				expectAs(
					"a check fails, the agent puts the file back as it was when the checks last passed, and Windlass runs nothing more: it says neither why nor on what, and the platform tells it as before, the failed run with the note that files changed after it",
					back.verified.state === "not_needed" && back.verified.unneeded === undefined && back.verified.putBack === undefined && facts(back.verified) === plain([["test", "sh test.sh", "user", false, "failed", 1]]) && back.verified.run?.turn === 2 && back.verified.changedAfter && section(back.verified).includes("No check ran in the agent's turn 2: it changed nothing the checks cover."),
					plain(back.verified),
				);

			// (h) The same in a session's first turn: the file is back as the session started.
			const h = await sandbox("h");
			const toStart = await turn(h, scripted(write("c1", "still broken\n"), say("Done."), write("c2", "broken\n"), say("Put back.")), [OWN_CHECK]);
			if (required)
				expectAs(
					"put back as the session started: Windlass says that no run has passed on that state, and the platform lists no run and says that no check has verified it",
					plain(toStart.verified.unneeded) === plain({ reason: "state_unchanged", on: "start" }) && toStart.verified.run === null && toStart.verified.putBack?.length === 1 && toStart.verified.unrun.length === 0 && !toStart.verified.changedAfter && section(toStart.verified).includes("the files the checks cover are again as they were when the session started, a state no check has verified."),
					plain(toStart.verified),
				);
			else expectAs("put back as the session started: told as before, the failed run with the note that files changed after it", toStart.verified.state === "not_needed" && toStart.verified.unneeded === undefined && facts(toStart.verified) === plain([["test", "sh test.sh", "user", false, "failed", 1]]) && toStart.verified.changedAfter, plain(toStart.verified));

			// (i) A turn that changes no file, and one that changes a file no check covers.
			const i = await sandbox("i");
			const covering: RepositoryCheck[] = [{ ...OWN_CHECK, when: ["app.txt"] }];
			const answered = await turn(i, scripted(say("Nothing to do.")), covering);
			const beside = await turn(i, scripted(write("c1", "a note\n", "notes.txt"), say("Noted.")), covering, answered.result.windlassSessionId ?? undefined, 2, answered.verified);
			if (required)
				expectAs(
					"a turn that changed no file and one that changed a file no check covers are told apart, and where no run has passed the platform says that no check has verified the state",
					plain(answered.verified.unneeded) === plain({ reason: "turn_unchanged", on: null }) &&
						section(answered.verified).includes("No check ran in the agent's turn 1: the turn changed no file.") &&
						plain(beside.verified.unneeded) === plain({ reason: "not_covered", on: "start" }) &&
						beside.verified.run === null &&
						plain(beside.verified.unrun.map((check) => check.name)) === plain(["test"]) &&
						section(beside.verified).includes("No check ran in the agent's turn 2: no check covers the files that differ from the state the session started from, which no check has verified.") &&
						verifiedWords(beside.verified, [], null) === "no check covers what changed",
					`${plain(answered.verified)} ${plain(beside.verified)}`,
				);
			else expectAs("a turn that changed no file and one that changed a file no check covers both end with no check needed and no reason given: told as before", answered.verified.state === "not_needed" && beside.verified.state === "not_needed" && answered.verified.unneeded === undefined && beside.verified.unneeded === undefined && section(beside.verified).includes("No check ran in the agent's turn 2: it changed nothing the checks cover."), `${plain(answered.verified)} ${plain(beside.verified)}`);

			// (j) One check fails on the code and another cannot be started: the program that starts a command is taken away while the first runs, and put back when the run has ended.
			const j = await sandbox("j");
			let taken: Promise<unknown> | null = null;
			const asRoot = (script: string) => docker(["exec", "-u", "0", j.container, "sh", "-c", script]);
			const mixed = await turn(j, scripted(write("c1", "still broken\n"), say("Done."), say("Giving up."), say("Giving up."), say("Giving up.")), [{ name: "test", command: "sleep 4; sh test.sh" }, { name: "lint", command: "true" }], undefined, 1, null, (one) => {
				if (one.type === "checks.started" && taken === null) taken = new Promise((done) => setTimeout(done, 1500)).then(() => asRoot("mv /usr/bin/env /root/env.off"));
				if (one.type === "checks.finished") void Promise.resolve(taken).then(() => asRoot("mv /root/env.off /usr/bin/env"));
			});
			const lint = mixed.verified.run?.checks.find((check) => check.name === "lint");
			if (required)
				expectAs(
					"one check fails on the code and another cannot be started: the agent is sent back for the first alone, and the platform counts and words them apart, with why the second did not start",
					mixed.verified.state === "unresolved" &&
						mixed.verified.unresolved?.reason === "max_rounds" &&
						plain(mixed.verified.run?.checks.map((check) => [check.name, check.status, check.exitCode, check.sentBack])) === plain([["test", "failed", 1, 3], ["lint", "could_not_start", null, 0]]) &&
						(lint?.startError ?? "").includes("/usr/bin/env") &&
						section(mixed.verified).includes("The agent's turn 1 ended with a check still failing: the agent had been sent back as often as a turn allows. Another check was not started, which says nothing about the code") &&
						verifiedWords(mixed.verified, [], null) === "1 of 2 checks failing, 1 not started",
					plain(mixed.verified),
				);
			else
				expectAs(
					"one check fails on the code and another cannot be started: this Windlass sends the agent back over both, and the platform tells it as before",
					mixed.verified.state === "unresolved" && plain(mixed.verified.run?.checks.map((check) => [check.name, check.status, check.exitCode, check.sentBack, check.startError ?? null])) === plain([["test", "failed", 1, 3, null], ["lint", "could_not_start", null, 3, null]]) && section(mixed.verified).includes("The agent's turn 1 ended with 2 checks still failing") && verifiedWords(mixed.verified, [], null) === "2 of 2 checks failing",
					plain(mixed.verified),
				);

			// (k) A check is added between two turns of one session, with patterns the next turn's change does not match.
			const k = await sandbox("k");
			const DOCS: RepositoryCheck = { name: "docs", command: "true", when: ["docs/**"] };
			const before = await turn(k, scripted(write("c1", "fixed\n"), say("Fixed.")), [OWN_CHECK]);
			const kSession = before.result.windlassSessionId ?? undefined;
			const added = await turn(k, scripted(write("c2", "a note\n", "notes.txt"), say("Noted.")), [OWN_CHECK, DOCS], kSession, 2, before.verified);
			const later = await turn(k, scripted(write("c3", "another note\n", "notes.txt"), say("Noted.")), [OWN_CHECK, DOCS], kSession, 3, added.verified);
			if (required)
				expectAs(
					"a required check named between two turns runs at the end of the next turn that changes a file, whatever the file, and from then on only for what it covers",
					facts(added.verified) === plain([["test", "sh test.sh", "user", true, "passed", 0], ["docs", "true", "user", true, "passed", 0]]) && added.verified.unrun.length === 0 && facts(later.verified) === plain([["test", "sh test.sh", "user", true, "passed", 0]]) && section(later.verified).includes("Did not run: **docs** (`true`). No changed file matches its patterns."),
					`${plain(added.verified)} ${plain(later.verified)}`,
				);
			else expectAs("a check added between two turns runs only for a change its patterns match: it did not run, and the platform says why", facts(added.verified) === plain([["test", "sh test.sh", "user", false, "passed", 0]]) && plain(added.verified.unrun.map((check) => check.name)) === plain(["docs"]), plain(added.verified));

			// (l) A session that holds what this Windlass does not read: a key a later one would have added to the session's state.
			const key = await k.run(`node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.prepare("update session set state = json_set(state, ?, 1)").run("$.laterKey"); console.log(db.prepare("select json_extract(state, ?) as kept from session").get("$.laterKey").kept);' '/home/agent/.local/share/windlass/sessions/${kSession}.db'`);
			const unread = await turn(k, scripted(say("Hello.")), [OWN_CHECK, DOCS], kSession, 4, later.verified);
			if (required) expectAs("a session that holds a record this Windlass does not read is refused with that reason and a sentence, and the layer hands both on", key.stdout.trim() === "1" && unread.result.failure?.reason === "unreadable_session" && unread.result.failure.message.includes("holds a record this version of Windlass does not read") && unread.events.length === 0, plain(unread.result.failure));
			else expectAs("a session that holds a record this Windlass does not read is refused with an internal error and no reason: the layer says that the open was refused, and nothing more", key.stdout.trim() === "1" && plain(unread.result.failure) === plain({ reason: "open_refused", message: "Internal error" }) && unread.events.length === 0, plain(unread.result.failure));
		} finally {
			for (const id of created) await layer.sandboxes.destroy(id).catch(() => undefined);
			for (const user of users) await docker(["volume", "rm", "-f", `wlp-user-${user}`, `wlp-auth-${user}`]).catch(() => undefined);
			const remaining = await docker(["ps", "-a", "--filter", `label=${LABEL_ARG}`, "--format", "{{.Names}}"]);
			expect("every container of these cases is removed", !created.some((id) => remaining.stdout.includes(id)));
		}
	}

	await cases(createSandboxLayer({ signIns: "memory", tokenNetwork: "none" }), IMAGE, true);

	if (older.status !== 0 || !existsSync(OLDER_BINARY)) console.log(`\nSKIP  the same cases against a Windlass without required checks: sandbox/fetch-windlass.sh older did not give one (${older.stderr.trim().split("\n").pop() ?? `exit ${older.status}`})`);
	else {
		const tag = `windlass-platform-sandbox-older:chk-${run}`;
		const idOf = async (image: string) => (await docker(["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();
		const latest = await idOf(IMAGE);
		const built = spawnSync(join(root, "sandbox/build.sh"), { env: { ...process.env, WLP_SANDBOX_IMAGE: tag, WINDLASS_BINARY: OLDER_BINARY }, encoding: "utf8" });
		expect("build.sh builds that Windlass into a throwaway image of its own", built.status === 0 && (await idOf(tag)) !== "" && (await idOf(IMAGE)) === latest, built.stderr.trim().split("\n").pop());
		try {
			if (built.status === 0) await cases(createSandboxLayer({ image: tag, signIns: "memory", tokenNetwork: "none" }), tag, false);
		} finally {
			const label = await docker(["image", "inspect", "--format", `{{index .Config.Labels "${LABEL}"}}`, tag]);
			if (label.code === 0 && label.stdout.trim() === "1") await docker(["rmi", tag]);
			expect("the throwaway image is removed again, and the server's image was never replaced", (await idOf(tag)) === "" && (await idOf(IMAGE)) === latest);
		}
	}
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
