/**
 * Running a repository's setup command in a session's sandbox (setup-command.ts says what it is and
 * whose). It is the platform that runs it, beside Windlass and not under it, so Windlass's sandbox
 * around the agent's commands does not hold it: it has the sandbox's own network and writes where the
 * sandbox's user may write.
 *
 * It goes through the provider's seam (provider.ts), so it is the same on Docker and on E2B:
 *
 *   as        the sandbox's user, `agent`: what it installs is the agent's to change
 *   where     the directory the repository was cloned into
 *   how       `bash -c <command>` under wlp-run (`SandboxHandle.run`), its standard input empty: every
 *             process it starts carries the run's tag, so a stop (the turn's, or the time limit) reaches
 *             all of them, SIGTERM first and SIGKILL after two seconds, and what is left is swept.
 *             Its standard error goes where its standard output goes, inside the sandbox, so what it
 *             prints arrives in the order it was printed: an error after the line it belongs to
 *   held      `TurnSandbox.holdForTurn` for as long as it runs: on E2B the sandbox's own timeout would
 *             otherwise pause it in the middle of an install
 *   with      the sandbox's environment, WLP_SETUP=1 and the secrets the user saved for the repository
 *             (repo-secrets.ts), each as a variable of its name: in the command's environment and on
 *             no command line (`ExecOptions.secretEnv`). No credential of the platform's is handed
 *             to it: the token a clone used was given to that one git command and revoked when it
 *             ended (github/git.ts), and a turn's access token file is written when a turn starts
 *             Windlass, which is after this, and removed when that turn ends (token-file.ts)
 *   output    every saved value of the repository is taken out of what the command prints before
 *             it is handed on, also one that arrives in two pieces (`RedactingStream`)
 *
 * A setup runs before handoff. Session-private storage and a process sweep on exit keep
 * another session's file and the next turn's file outside the setup process's lifetime.
 */

import { NO_REDACTION, RedactingStream, type Redactor } from "../repo-secrets.js";
import type { SandboxHandle } from "./api.js";
import { isTurnSandbox, sweepSessionProcesses } from "./provider.js";

export interface SetupRun {
	command: string;
	/** The directory to run in: the clone's. */
	cwd: string;
	/** After this long the command is stopped. */
	timeoutMs: number;
	/** The turn's: aborting stops the command and everything it started. */
	signal?: AbortSignal;
	/** The repository's secrets, each under its name: added to the command's environment. */
	secretEnv?: Record<string, string>;
	/** Takes the repository's saved values out of what the command prints and of `problem`. */
	redactor?: Redactor;
	/** What it prints, standard output and standard error as they arrive, without those values. */
	onOutput?: (text: string) => void;
}

export interface SetupResult {
	/** "failed" is any exit code but 0, and a command that could not be run. */
	state: "succeeded" | "failed" | "timed_out" | "stopped";
	/** Null when it was killed or could not be run. */
	exitCode: number | null;
	durationMs: number;
	/** Set when the sandbox could not run it at all: a sentence for the timeline. */
	problem: string | null;
	/** Cleanup must succeed on retry before any more work in this sandbox. */
	cleanupPending?: true;
}

/** Identifies the setup phase to the command. Cleanup works independently of its environment. */
const MARK = "WLP_SETUP";

/** Recover an interrupted setup before retrying work in this sandbox. */
export async function stopLeftoverSetup(sandbox: SandboxHandle): Promise<void> {
	if (isTurnSandbox(sandbox)) await sweepSessionProcesses(sandbox);
}

/** Runs the command to its end, its time limit or a stop. Never throws. */
export async function runSetupCommand(sandbox: SandboxHandle, run: SetupRun): Promise<SetupResult> {
	const began = Date.now();
	const redactor = run.redactor ?? NO_REDACTION;
	const failed = (problem: string): SetupResult => ({ state: "failed", exitCode: null, durationMs: Date.now() - began, problem: redactor.text(problem) });
	if (run.signal?.aborted) return { state: "stopped", exitCode: null, durationMs: 0, problem: null };
	let release: (() => Promise<void>) | null = null;
	try {
		// The layer's own sandboxes are held; another one (the tests' in-memory layer) has nothing that stops by itself.
		if (isTurnSandbox(sandbox)) release = await sandbox.holdForTurn();
	} catch (error) {
		return failed(`The sandbox could not be kept running for it: ${error instanceof Error ? error.message : String(error)}`);
	}
	let outcome: SetupResult;
	try {
		const hand = (text: string) => {
			if (text === "") return;
			try {
				run.onOutput?.(text);
			} catch {
				// A listener's failure must not stop the command's output from being read.
			}
		};
		// One stream: the command's standard error is joined to its standard output inside the sandbox.
		const stream = new RedactingStream(redactor);
		const emit = (text: string) => hand(stream.push(text));
		// On the command's own first line, so that a line number bash names is the command's.
		const result = await sandbox
			.run(`exec 2>&1; ${run.command}`, { cwd: run.cwd, env: { [MARK]: "1" }, secretEnv: run.secretEnv, timeoutMs: run.timeoutMs, signal: run.signal, onStdout: emit, onStderr: emit })
			.finally(() => hand(stream.flush()));
		// A stop that came while it was ending on its own counts as the stop.
		const durationMs = Date.now() - began;
		if (result.aborted || run.signal?.aborted) outcome = { state: "stopped", exitCode: null, durationMs, problem: null };
		else if (result.timedOut) outcome = { state: "timed_out", exitCode: null, durationMs, problem: null };
		else outcome = { state: result.exitCode === 0 ? "succeeded" : "failed", exitCode: result.exitCode, durationMs, problem: null };
	} catch (error) {
		outcome = failed(`The sandbox could not run it: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		await stopLeftoverSetup(sandbox);
		return outcome;
	} catch {
		return { ...failed("The platform could not stop leftover setup processes."), cleanupPending: true };
	} finally {
		await release?.().catch(() => undefined);
	}
}
