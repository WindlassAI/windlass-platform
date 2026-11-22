/**
 * The rules of a repository's setup command (server/src/setup-command.ts), on their own: no server, no
 * sandbox, nothing sent anywhere.
 *
 *   cd server && npx tsx ../scripts/setup-check.ts
 *
 * What it holds to: a command is saved for a repository of the GitHub connection and for nothing else,
 * by GitHub's id; what is saved is text of a bounded length; however much a run prints, a bounded end
 * of it is kept; the note the agent gets says what happened, with the command and the last lines; and
 * whatever way a setup ends, on every profile, nothing it started is left running in the sandbox.
 */

import { isDeepStrictEqual } from "node:util";
import { MAX_SETUP_COMMAND_CHARS, SETUP_OUTPUT_CHARS } from "../server/src/contract.js";
import { markTurnSandbox } from "../server/src/sandbox/provider.js";
import { PROFILES } from "../server/src/sandbox/profiles.js";
import { runSetupCommand, stopCutOffSetup } from "../server/src/sandbox/setup.js";
import type { SandboxHandle } from "../server/src/sandbox/api.js";
import { OutputTail, SetupCommandProblem, cleanSetupCommand, lastLines, setupNote, setupProjectKey, setupProjectOf } from "../server/src/setup-command.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
}

function refused(raw: unknown): string | null {
	try {
		cleanSetupCommand(raw);
		return null;
	} catch (error) {
		return error instanceof SetupCommandProblem ? error.message : `another error: ${String(error)}`;
	}
}

// What it is saved for.
const repo = { id: 7101, owner: "acme", name: "harbor" };
expect("a session on a repository of the GitHub connection has a setup, under GitHub's id", setupProjectOf({ repo })?.key === "github:7101" && setupProjectOf({ repo })?.label === "acme/harbor");
expect("a renamed repository keeps it", setupProjectOf({ repo: { ...repo, owner: "acme-co", name: "quay" } })?.key === "github:7101");
expect("a session on a pasted address has none", setupProjectOf({ repo: null }) === null && setupProjectOf({}) === null);
expect(
	"a key is made from an id and from nothing else",
	[0, -1, 1.5, Number.NaN, "7101", null, undefined, { id: 7101 }].every((value) => setupProjectKey(value) === null) && setupProjectKey(7101) === "github:7101",
);

// What may be saved.
expect("a command is kept as it was written, without what is around it", cleanSetupCommand("  npm ci && npm run build\n") === "npm ci && npm run build");
expect("the line ends of a text field are made plain", cleanSetupCommand("npm ci\r\nnpm run build\r") === "npm ci\nnpm run build");
expect("nothing but white space is no command", cleanSetupCommand(" \n\t ") === "");
expect(`a command of ${MAX_SETUP_COMMAND_CHARS} characters is taken`, cleanSetupCommand("x".repeat(MAX_SETUP_COMMAND_CHARS)).length === MAX_SETUP_COMMAND_CHARS);
expect("one character more is refused, and the sentence says the limit", (refused("x".repeat(MAX_SETUP_COMMAND_CHARS + 1)) ?? "").includes(String(MAX_SETUP_COMMAND_CHARS)));
expect("anything that is not text is refused", [undefined, null, 7, ["npm ci"], { command: "npm ci" }].every((value) => refused(value) !== null));
expect("a NUL is refused", refused("echo a\0b") !== null);

// What is kept of a run's output.
const tail = new OutputTail(100);
for (let line = 0; line < 5_000; line += 1) tail.push(`line ${line}\n`);
expect("however much a run prints, no more than the limit is kept, and it is the end", tail.text.length <= 100 && tail.text.endsWith("line 4999\n") && tail.truncated, `${tail.text.length} characters`);
const short = new OutputTail(100);
short.push("added 3 packages\r\n");
expect("a short output is kept whole, its line ends plain", short.text === "added 3 packages\n" && !short.truncated);
const wide = new OutputTail(4);
wide.push("ab😀😀");
expect("the cut does not split a character", !/^[\udc00-\udfff]/.test(wide.text), JSON.stringify(wide.text));
expect("the default limit is the contract's", (() => {
	const full = new OutputTail();
	full.push("x".repeat(SETUP_OUTPUT_CHARS * 3));
	return full.text.length === SETUP_OUTPUT_CHARS;
})());
expect("the last lines leave out the empty ones", lastLines("a\n\n\nb\r\nc\n", 2) === "b\nc");

// What the agent is told.
const note = setupNote({ command: "npm ci", state: "failed", exitCode: 3, limitMs: 600_000, output: "npm error code E404\nnpm error 404 Not Found\n" });
expect(
	"a failed run is told with the command, the exit code and the last lines, as the platform's own words",
	note.startsWith("[A note from the platform, not from the user:") && note.includes("\nnpm ci\n") && note.includes("exit code 3") && note.includes("npm error 404 Not Found") && note.endsWith("]\n\n"),
	note,
);
expect("a run that was stopped at its limit says the limit", setupNote({ command: "sleep 900", state: "timed_out", exitCode: null, limitMs: 600_000, output: "" }).includes("stopped after 10 minutes") && setupNote({ command: "sleep 900", state: "timed_out", exitCode: null, limitMs: 600_000, output: "" }).includes("It printed nothing."));
expect("a run stopped with its turn, and one cut off with its server, say so", setupNote({ command: "npm ci", state: "stopped", exitCode: null, limitMs: 1, output: "" }).includes("stopped before it finished") && setupNote({ command: "npm ci", state: "interrupted", exitCode: null, limitMs: 1, output: "" }).includes("cut off"));
const long = setupNote({ command: "make", state: "failed", exitCode: 2, limitMs: 1, output: Array.from({ length: 500 }, (_, index) => `line ${index} ${"x".repeat(80)}`).join("\n") });
expect("a long output does not make a long note", long.length < 2_600 && long.includes("line 499"), `${long.length} characters`);

// What a setup leaves running: the whole sandbox is swept when it ends, also when it ends normally.
// A provider's handle stands in here; the Docker and E2B checks run the sweep itself against detached processes.
function stub(profile: string, exitCode: number | "throws" = 0) {
	const sweeps: string[] = [];
	const handle = {
		id: "sb", uid: "u", cwd: "/workspace", profile,
		holdForTurn: async () => async () => {},
		run: async () => {
			if (exitCode === "throws") throw new Error("the link was lost");
			return { exitCode, timedOut: false, aborted: false, stdout: "", stderr: "" };
		},
		ask: async (argv: string[]) => {
			if (argv[0] === "/usr/bin/python3" && argv[4]?.includes("expected the sandbox agent")) sweeps.push(argv[5] ?? "");
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	markTurnSandbox(handle);
	return { handle: handle as unknown as SandboxHandle, sweeps };
}
const profiles = [...PROFILES.filter(p => p.available).map(p => p.id), "e2b", "e2b-open"].filter((id, i, all) => all.indexOf(id) === i);
for (const profile of profiles) {
	for (const exitCode of [0, 1, "throws"] as const) {
		const { handle, sweeps } = stub(profile, exitCode);
		const result = await runSetupCommand(handle, { command: "npm ci", cwd: "/workspace", timeoutMs: 1000 });
		const kind = profile.startsWith("e2b") ? "e2b" : "docker";
		expect(`on ${profile}, a setup that ${exitCode === 0 ? "ends normally" : exitCode === 1 ? "fails" : "cannot be run to its end"} has the sandbox swept (${kind}) before it returns`,
			isDeepStrictEqual(sweeps, [kind]) && result.cleanupPending === undefined, `${JSON.stringify(sweeps)} ${JSON.stringify(result)}`);
	}
}
{
	// The server stopped during setup: the actor stops what it left as soon as it wakes, not at the next prompt.
	const { handle, sweeps } = stub("docker-hardened");
	let state: "running" | "paused" | "none" = "running";
	let connects = 0;
	const sandboxes = { state: async () => state, connect: async () => { connects += 1; return handle; } };
	expect("a setup cut off with the server is stopped in a running sandbox", await stopCutOffSetup(sandboxes, "sb") && isDeepStrictEqual(sweeps, ["docker"]));
	state = "paused";
	expect("a paused sandbox runs nothing and is not started for it", !await stopCutOffSetup(sandboxes, "sb") && connects === 1 && sweeps.length === 1);
	state = "none";
	expect("nor is one that is gone", !await stopCutOffSetup(sandboxes, "sb") && connects === 1);
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
