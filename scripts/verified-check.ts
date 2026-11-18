/**
 * What a pull request shows was verified, on its own: a repository's checks as they are saved
 * (server/src/repository-checks.ts), how they reach Windlass (server/src/windlass-config.ts), what a
 * turn's events come to, what is looked for in the work's changes, and the section of a pull
 * request's description (server/src/verified.ts). No server, nothing sent anywhere.
 *
 *   cd server && npx tsx ../scripts/verified-check.ts
 *   cd server && flock /tmp/wlp-test.lock npx tsx ../scripts/verified-check.ts --docker
 *
 * With --docker it also asks the Windlass of the sandbox image what it does with a user's checks and
 * a repository's own: real turns in local containers, with a scripted model and no sign-in. That is
 * what the platform's account of "whose check ran" rests on, so it is held to here: a list in the
 * repository's `.windlass/config.json` stands in for the user's whole, `verify.mode` there turns the
 * gate off, and a file the agent writes during a turn counts from the next turn on.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CHECK_OUTPUT_CHARS, MAX_CHECKS_PER_REPOSITORY, type RepositoryCheck, type Verified, type WindlassEvent } from "../server/src/contract.js";
import { evidenceSection } from "../server/src/github/publish.js";
import { CHECKS_TABLE, type ChecksDb, ChecksProblem, cleanChecks, readChecks, saveChecks, windlassChecks } from "../server/src/repository-checks.js";
import { DEFAULTS_TABLE } from "../server/src/repository-defaults.js";
import type { TurnChecks } from "../server/src/sandbox/api.js";
import { VerificationLog, type WorkDiff, checkScripts, isCheckOutputPath, isTestPath, outputTail, verifiedSection, verifiedWords, withOutputs, withVerifiedSection, workFlags } from "../server/src/verified.js";
import { platformConfig, projectChecks } from "../server/src/windlass-config.js";

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
expect("with none to hand over, the file has no checks, and a file that held nothing else is removed", !("checks" in JSON.parse(withdrawn?.config ?? "{}")) && platformConfig(JSON.stringify({ checks: [{ name: "a", command: "b" }] }), null, [])?.config === null);
expect("a file that is not Windlass's is left alone", platformConfig("not json", null, [], windlassChecks([TEST])) === null);
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
const report = () => event("synthetic.appended", { messageId: "m", origin: "check_report", content: [] });
const succeeded = (verification: Data) => event("execution.succeeded", { executionId: "e", verification });
const log = (events: WindlassEvent[]) => {
	const made = new VerificationLog();
	for (const one of events) made.note(one);
	return made;
};
const HANDED: TurnChecks = { handed: true, project: null };
const failing = evidence(["test", "npm test", "failed"]);
const passing = evidence(["test", "npm test", "passed"]);

// The run recorded in the repository's own fixture: Windlass's real events, with their own names.
const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/windlass-events/demo-the-checks-fail-the-model-fixes-the-code-and-they-pass.jsonl"), "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as WindlassEvent);
const recorded = log(fixture).verified(1, [{ name: "test", command: "bun test" }], HANDED, null);
expect("a recorded run of Windlass's: the check failed, the agent was sent back once, and it passed", recorded.state === "passed" && plain(recorded.run?.checks.map((check) => [check.name, check.whose, check.status, check.sentBack])) === plain([["test", "user", "passed", 1]]) && !recorded.changedAfter, plain(recorded));

const sentBack = log([snapshot("w0", "delivery"), ...ran("w1", failing), report(), report(), snapshot("w2", "step_end"), ...ran("w2", passing), succeeded({ status: "passed", evidence: passing })]);
const twice = sentBack.verified(2, [TEST, TYPES], HANDED, null);
expect("each time the harness appends its report, the agent was sent back: twice here, and it is the user's check", twice.run?.checks[0]?.sentBack === 2 && twice.run.checks[0].whose === "user" && twice.run.turn === 2);
expect("a check of the user's that is not among the ones that ran is listed as one that did not", plain(twice.unrun) === plain([{ name: "types", command: "npm run typecheck" }]) && !twice.replaced);

const others = evidence(["test", "true", "passed"], ["smoke", "true", "passed"]);
const replaced = log([...ran("w1", others), succeeded({ status: "passed", evidence: others })]).verified(1, [TEST], { handed: true, project: { checks: 2, verify: null } }, null);
expect("when the repository's file names a list, no check that ran is the user's, whatever it is called", replaced.replaced && replaced.run?.checks.every((check) => check.whose === "repository") === true && plain(replaced.unrun) === plain([{ name: "test", command: "npm test" }]));
const renamed = log([...ran("w1", others), succeeded({ status: "passed", evidence: others })]).verified(1, [TEST], HANDED, null);
expect("a check under the user's name with another command is not the user's either, nor is any check when the list was not handed over", renamed.run?.checks.every((check) => check.whose === "repository") === true && log([...ran("w1", passing), succeeded({ status: "passed", evidence: passing })]).verified(1, [TEST], { handed: false, project: null }, null).run?.checks[0]?.whose === "repository");

const none = (handed: TurnChecks | undefined, own: RepositoryCheck[], extra: WindlassEvent[] = []) => log([...extra, succeeded({ status: "not_configured" })]).verified(1, own, handed, null).state;
expect(
	"when Windlass says no checks were in force, the reason is the one a field gives",
	none(HANDED, []) === "none_set" &&
		none({ handed: true, project: { checks: null, verify: "off" } }, [TEST]) === "off" &&
		none({ handed: true, project: { checks: 0, verify: null } }, [TEST]) === "emptied" &&
		none(HANDED, [TEST], [{ type: "notice", kind: "checks_not_run", message: "..." }]) === "no_sandbox" &&
		none({ handed: false, project: null }, [TEST]) === "not_handed" &&
		none(HANDED, [TEST]) === "not_in_force",
);

const unresolved = log([...ran("w1", failing), report(), succeeded({ status: "unresolved", reason: "acknowledged", failing: ["test"], acknowledgement: { checks: ["test"], reason: "The registry is down." }, evidence: failing })]).verified(1, [TEST], HANDED, null);
expect("a turn that ended with a check failing says why it was let end, in the agent's own reason where it gave one", unresolved.state === "unresolved" && plain(unresolved.unresolved) === plain({ reason: "acknowledged", said: "The registry is down." }));

const stopped = log([snapshot("w0", "delivery"), ...ran("w1", failing), report(), snapshot("w2", "step_end"), event("execution.interrupted", { reason: "user" })]).verified(1, [TEST], HANDED, null);
expect("a turn stopped after its checks ran and before they ran again: the results are of an earlier state, and it says so", stopped.state === "stopped" && stopped.changedAfter && stopped.run?.checks[0]?.status === "failed");

const before = log([...ran("w1", passing), succeeded({ status: "passed", evidence: passing })]).verified(1, [TEST], HANDED, null);
const answered = log([snapshot("w1", "delivery"), succeeded({ status: "not_needed" })]).verified(2, [TEST], HANDED, before);
const edited = log([snapshot("w1", "delivery"), snapshot("w5", "step_end"), succeeded({ status: "not_configured" })]).verified(3, [TEST], { handed: true, project: { checks: null, verify: "off" } }, answered);
expect("a turn that ran no check keeps what the last run found, with the turn it was in", answered.state === "not_needed" && answered.run?.turn === 1 && !answered.changedAfter && answered.unrun.length === 0);
expect("and a later turn that changed files without a check says that files changed after the checks last ran", edited.state === "off" && edited.run?.turn === 1 && edited.changedAfter);
const cut = log([snapshot("w1", "delivery"), snapshot("w9", "step_end")]).cutOff(4, before);
expect("a turn cut off with its server keeps nothing of its own, and says the same", cut.state === "stopped" && cut.run?.turn === 1 && cut.changedAfter && log([]).cutOff(4, null).run === null);

const wanted = log([...ran("w1", evidence(["test", "npm test", "failed"], ["lint", "npm run lint", "passed", { outputBytes: 40 }], ["docs", "x", "passed", { outputBytes: 40, outputPath: "/etc/passwd" }]))]);
expect(
	"output is read for a check that did not pass and for one whose user asked, and only from a file Windlass names as it names them",
	plain(wanted.outputs([{ name: "lint", command: "npm run lint", showOutput: true }, { name: "docs", command: "x", showOutput: true }]).map((output) => output.name)) === plain(["test", "lint"]) &&
		isCheckOutputPath("/home/agent/.local/share/windlass/spill/checks/ses_1/check-test-e3b0c44298fc1c149afbf4c8996fb924.log") &&
		!isCheckOutputPath("/tmp/x/../../etc/check-test-e3b0c44298fc1c149afbf4c8996fb924.log") &&
		!isCheckOutputPath("check-test-e3b0c44298fc1c149afbf4c8996fb924.log") &&
		!isCheckOutputPath("/home/agent/.local/share/windlass/access-token-1.json"),
);
expect("the end of an output is kept, cut at a line", outputTail(`${"x".repeat(4000)}\nlast line\n`) === "last line" && outputTail(`${"line\n".repeat(1000)}`).length <= CHECK_OUTPUT_CHARS && outputTail("a\r\nb\u0007\n") === "a\nb");

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

// ---- with --docker: what the image's Windlass does with a user's checks and a repository's own ------

if (process.argv.includes("--docker")) {
	const { LABEL_ARG, docker, randomId } = await import("../server/src/sandbox/docker.js");
	const { createSandboxLayer } = await import("../server/src/sandbox/index.js");
	type Handle = import("../server/src/sandbox/sandboxes.js").DockerSandboxHandle;
	const layer = createSandboxLayer({ signIns: "memory", tokenNetwork: "none" });
	const run = randomId(3);
	const created: string[] = [];
	const users: string[] = [];
	type Item = Record<string, unknown>;
	const call = (callId: string, name: string, input: Record<string, unknown>): Item[] => [{ type: "tool_call", callId, name, input }, { type: "finish", reason: "tool_calls" }];
	const say = (words: string): Item[] => [{ type: "text", text: words }, { type: "finish", reason: "stop" }];
	const scripted = (...responses: Item[][]) => ({ responses: [...responses, say("Nothing more."), say("Nothing more."), say("Nothing more.")] });
	const write = (callId: string, content: string, path = "app.txt") => call(callId, "write", { path, content });
	const OWN_CHECK: RepositoryCheck = { name: "test", command: "sh test.sh" };

	async function sandbox(name: string, project?: unknown): Promise<Handle> {
		const user = `verified-${run}-${name}`;
		users.push(user);
		await layer.logins.ensureUserVolume(user);
		const id = await layer.sandboxes.create({ uid: user, sessionId: `s-${name}`, profile: "docker-windlass-sandbox" });
		created.push(id);
		const handle = (await layer.sandboxes.connect(id)) as Handle;
		await handle.writeTextFile("/workspace/test.sh", 'grep -q fixed app.txt || { echo "app.txt is not fixed"; exit 1; }\n');
		await handle.writeTextFile("/workspace/app.txt", "broken\n");
		if (project !== undefined) await handle.writeTextFile("/workspace/.windlass/config.json", JSON.stringify(project));
		return handle;
	}
	async function turn(handle: Handle, script: ReturnType<typeof scripted>, checks: RepositoryCheck[], windlassSessionId?: string) {
		const made = new VerificationLog();
		const result = await layer.windlass.runTurn(handle, { prompt: "go", script, checks, windlassSessionId, onEvent: (one) => made.note(one), onQuestion: async () => ({ choice: "once" }) });
		return { result, log: made, verified: made.verified(1, checks, result.checks, null) };
	}

	try {
		console.log(`\nwith the Windlass of the sandbox image (${(await layer.windlass.version()) ?? "unknown version"}):`);
		const a = await sandbox("a");
		const fixed = await turn(a, scripted(write("c1", "still broken\n"), say("Done."), write("c2", "fixed\n"), say("Fixed.")), [OWN_CHECK]);
		expect("the user's check, handed over in Windlass's own file, runs before the turn ends; it fails, the agent is sent back, and it passes", fixed.verified.state === "passed" && plain(fixed.verified.run?.checks.map((check) => [check.name, check.command, check.whose, check.status, check.sentBack])) === plain([["test", "sh test.sh", "user", "passed", 1]]), plain(fixed.verified));
		expect("the layer says that it handed the checks over and that the repository's file names none", plain(fixed.result.checks) === plain({ handed: true, project: null }));
		const left = await a.run("cat /home/agent/.config/windlass/config.json 2>/dev/null || echo none");
		expect("and takes them out of Windlass's file again when the turn has ended", left.stdout.trim() === "none", left.stdout.trim());

		const b = await sandbox("b", { checks: [{ name: "smoke", command: "true" }] });
		const theirsRan = await turn(b, scripted(write("c1", "still broken\n"), say("Done.")), [OWN_CHECK]);
		expect("a list in the repository's .windlass/config.json stands in for the user's whole: its check runs, the user's does not, and the turn is called done", plain(theirsRan.verified.run?.checks.map((check) => [check.name, check.whose, check.status])) === plain([["smoke", "repository", "passed"]]) && theirsRan.verified.replaced && plain(theirsRan.verified.unrun.map((check) => check.name)) === plain(["test"]), plain(theirsRan.verified));

		const c = await sandbox("c", { verify: { mode: "off" } });
		const off = await turn(c, scripted(write("c1", "still broken\n"), say("Done.")), [OWN_CHECK]);
		expect("verify.mode off in the repository's file turns the gate off for the user's checks, and the platform says which file did", off.verified.state === "off" && off.verified.run === null, plain(off.verified));

		const d = await sandbox("d");
		const during = await turn(d, scripted(write("c1", JSON.stringify({ checks: [{ name: "test", command: "true" }] }), ".windlass/config.json"), write("c2", "still broken\n"), say("Done."), say("Giving up."), say("Giving up."), say("Giving up.")), [OWN_CHECK]);
		expect("a repository's file the agent writes during a turn changes nothing in that turn: the user's check still runs, and fails", during.verified.state === "unresolved" && during.verified.run?.checks[0]?.whose === "user" && during.verified.run.checks[0].status === "failed" && during.verified.unresolved?.reason === "max_rounds", plain(during.verified));
		const outputs = during.log.outputs([OWN_CHECK]);
		const printed = outputs[0] ? await d.run(`tail -c 400 -- '${outputs[0].path}'`) : null;
		expect("the output of the failing check is in the file its evidence names", printed?.stdout.trim() === "app.txt is not fixed", `${plain(outputs)} ${printed?.stdout}`);
		const after = await turn(d, scripted(write("c3", "broken again\n"), say("Done.")), [OWN_CHECK], during.result.windlassSessionId ?? undefined);
		expect("from the next turn on it does: the check that runs has the user's name and another command, and is not presented as the user's", after.verified.state === "passed" && after.verified.replaced && plain(after.verified.run?.checks.map((check) => [check.name, check.command, check.whose])) === plain([["test", "true", "repository"]]), plain(after.verified));
	} finally {
		for (const id of created) await layer.sandboxes.destroy(id).catch(() => undefined);
		for (const user of users) await docker(["volume", "rm", "-f", `wlp-user-${user}`, `wlp-auth-${user}`]).catch(() => undefined);
		const remaining = await docker(["ps", "-a", "--filter", `label=${LABEL_ARG}`, "--format", "{{.Names}}"]);
		expect("every container of this check is removed", !created.some((id) => remaining.stdout.includes(id)));
	}
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
