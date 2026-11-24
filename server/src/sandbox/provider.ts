/**
 * What a sandbox provider owes the code that runs a turn (turn.ts, token-file.ts). That code knows
 * nothing of Docker or of E2B: it is handed a `TurnSandbox`, and everything it does in a sandbox goes
 * through this interface. Two providers implement it:
 *
 *   sandboxes.ts        local Docker containers: `docker exec`
 *   e2b/sandboxes.ts    E2B microVMs: E2B's command API
 *
 * Both run the same image (sandbox/Dockerfile; sandbox/e2b/ builds the E2B template from it), so the
 * layout inside a sandbox is one and is named here: the user `agent`, the workspace, Windlass's data
 * directory, and `wlp-run`, the helper that tags every process of a run so that a stop reaches all of
 * them (sandbox/wlp-run).
 */

import { randomBytes } from "node:crypto";
import { RUNNER_HTTP_PROXY } from "../runner/egress.js";
import type { ModelProvider } from "../contract.js";
import type { AccessToken, ExecResult, SandboxHandle } from "./api.js";

/** Windlass's data directory inside a sandbox (`$XDG_DATA_HOME` is unset, so `~/.local/share/windlass`). */
export const DATA_DIR = "/home/agent/.local/share/windlass";
export const WORKSPACE = "/workspace";

export function randomId(bytes = 8): string {
	return randomBytes(bytes).toString("hex");
}

/** User ids become names at the provider (a Docker volume, an E2B metadata value): letters, digits, `_` and `-`, starting with a letter or digit, at most 64. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface InternalExecResult extends ExecResult {
	/** SIGKILL had to be sent. */
	killed: boolean;
	/** Signals sent during a stop, in order, with ms since the stop began. */
	stopLog: string[];
	/** Processes of the run still alive after it ended and was reaped (should be 0). */
	leftovers: number;
}

// Apply these before the provider starts its shell. In particular E2B uses a login shell.
export const GIT_USER_ENV = { HOME: "/nonexistent", PATH: "/usr/bin:/bin", ENV: "/dev/null", BASH_ENV: "/dev/null" };

// Existing sandbox images have a single agent-owned wlp-run pid directory.
// Give the transport uid its own per-command directory and signal the entire Git process group.
export function gitProcess(tag: string, argv: string[]): string[] {
	return ["/bin/sh", "-ec", `export PATH=/usr/bin:/bin
umask 077
proxy=
if [ "\${https_proxy:-}" = '${RUNNER_HTTP_PROXY}' ]; then proxy='${RUNNER_HTTP_PROXY}'; fi
dir=/tmp/wlp-transport-process-$1
shift
mkdir -m 700 -- "$dir"
trap 'rm -rf -- "$dir"' EXIT
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent LANG=C.UTF-8 https_proxy="$proxy" setsid -w /bin/sh -ec 'echo $$ > "$0/pid"; exec "$@"' "$dir" "$@"`, "git-run", tag, ...argv];
}

export function signalGitProcess(tag: string, signal: string): string[] {
	return ["/bin/sh", "-ec", 'dir=/tmp/wlp-transport-process-$1; [ ! -L "$dir" ] && [ -O "$dir" ] && read -r pid < "$dir/pid" && /bin/kill -s "$2" -- "-$pid"', "git-stop", tag, signal];
}

export interface StartOptions {
	/** Run as the unprivileged transport user, outside the workspace. */
	gitUser?: true;
	cwd?: string;
	env?: Record<string, string>;
	/** `ExecOptions.secretEnv`: environment whose values are on no command line. A name that is also in `env` keeps `env`'s value. */
	secretEnv?: Record<string, string>;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

/** How a started program ended, as the provider's client saw it (the local `docker exec`, E2B's command stream). */
export interface ProcessEnd {
	/** The program's exit code; null when the client was ended by a signal, lost its connection or could not be started. */
	code: number | null;
	/** The signal that ended the client or the program, if one did. */
	signal: string | null;
	/** Set when the program could not be run at all, or the connection to it broke. */
	error: Error | null;
}

/**
 * A program running in the sandbox under wlp-run, with its standard input left open: what a turn's
 * `windlass acp` is. Everything it starts carries the tag, so `signal` and `sweep` reach all of it.
 */
export interface SandboxProcess {
	readonly tag: string;
	/** Writes to standard input, in the order of the calls. False once it is closed or the client is gone. */
	write(text: string): boolean;
	closeStdin(): void;
	/** Resolves when the client has ended and all its output was handed over. Never rejects. */
	readonly ended: Promise<ProcessEnd>;
	/** Whether `ended` has resolved. */
	readonly hasEnded: boolean;
	/** Sends a signal inside the sandbox: to the program itself, or to every process that carries the tag. */
	signal(sig: "INT" | "TERM" | "KILL", who: "leader" | "all"): Promise<void>;
	/** Ends the client. It does not stop anything inside the sandbox. */
	killClient(): void;
	/**
	 * On a machine whose conversation is kept durably: the id the runner knows the process by, once the
	 * runner has it, so that a restarted server can take it up again (`TurnSandbox.adopt`). Absent elsewhere.
	 */
	readonly runnerProcess?: string | null;
}

/** What a short program said: its exit code (null when it was killed), and what it printed. */
export interface Answer {
	code: number | null;
	stdout: string;
	stderr: string;
}

const TURN_SANDBOX = Symbol.for("windlass-platform.turn-sandbox");

/**
 * A running sandbox as the turn code needs it. `SandboxHandle` is what the actors see; this adds the
 * rest. Every method that takes a path or a tag is given one the layer made itself, never the user's.
 */
export interface TurnSandbox extends SandboxHandle {
	/** The user the sandbox was made for: whose access token its turns are handed. */
	readonly uid: string;
	/** The `--approval` mode Windlass runs with here (the profile's). */
	readonly approval: "auto" | "full";
	/** Starts argv (no shell) under wlp-run and leaves its standard input open. Never throws: a program that could not be started is one that has `ended` with an error. */
	start(argv: string[], options?: StartOptions): SandboxProcess;
	/**
	 * Takes up a process a turn of a server that has since restarted started (`SandboxProcess.runnerProcess`),
	 * which the machine's runner kept running through the gap: its output from where the server's
	 * storage ends goes to `onStdout`/`onStderr`. Null when it cannot be had; absent where no provider can.
	 */
	adopt?(process: string, tag: string, output: Pick<StartOptions, "onStdout" | "onStderr">): SandboxProcess | null;
	/**
	 * Runs a short program (no shell, no standard input, not under wlp-run) to its end and returns what it
	 * said; null when it could not be run at all (the sandbox is not running). `env` may be written into
	 * a command line (Docker's): it is for names and paths, never for a secret.
	 */
	ask(argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<Answer | null>;
	/**
	 * Stops every run of `program` still going in the sandbox (one whose client died with a server that
	 * stopped): SIGINT to its leader, then SIGKILL to all its processes after 3 s. Returns how many runs
	 * were stopped.
	 */
	stopLeftovers(program: string): Promise<number>;
	/**
	 * Makes sure nothing of a run is left: waits up to `waitMs` for the processes that carry `tag` to go,
	 * kills what is left, and removes `files`. Returns how many processes were still there after that.
	 */
	sweep(tag: string, options?: { waitMs?: number; files?: string[] }): Promise<number>;
	/**
	 * Writes a file that only its owner can read (0600), whole: whoever reads `path` sees the old content
	 * or the new and never a part of either. The content never appears on a command line. One write of a
	 * path at a time.
	 */
	writeSecretFile(path: string, content: string): Promise<void>;
	/** Removes files. A no-op for those that are gone, and when the sandbox is. */
	removeFiles(paths: string[]): Promise<void>;
	/**
	 * Tells the provider that a turn is at work in the sandbox, and resolves with what ends that. A
	 * provider whose sandboxes stop by themselves when nobody vouches for them (E2B: the sandbox's own
	 * timeout) keeps this one running in between; for Docker it is nothing. Rejects when the sandbox
	 * cannot be kept running.
	 */
	holdForTurn(): Promise<() => Promise<void>>;
	/**
	 * Windlass's model relay for one turn (docs/model-relay.md). Where it is there, the turn's token file
	 * holds the lease's placeholder and the token goes to the relay instead; where it is not, the token
	 * goes into the file as before (a runner older than `model-relay`, a deployment with
	 * WLP_MODEL_RELAY=off). Rejects when the relay cannot be had: the turn then fails, and nothing is
	 * written into the sandbox.
	 */
	modelRelay?(): Promise<TurnModelRelay>;
	modelKeyRelay?(sessionId: string, key: ModelKeyLease): Promise<KeyTurnRelay>;
	/** The lease a turn of a server that has since restarted opened (`TurnModelRelay.lease`), taken up again for the same process. */
	resumeRelay?(relay: { lease: string; placeholder: string; env: Record<string, string> }): TurnModelRelay;
}

export interface ModelKeyLease {
	provider: ModelProvider;
	generation: string;
}

export type KeyTurnRelay = Pick<TurnModelRelay, "env" | "placeholder" | "close">;

/** Only this scoped platform placeholder crosses to a Docker relay. */
export interface ForwardedKeyLease {
	/** Delivered only to the paired machine that signs requests for this turn. */
	proofKey?: string;
	provider: ModelProvider;
	host: string;
	placeholder: string;
	expiresAt: number;
}

/** One turn's lease of the model relay. */
export interface TurnModelRelay {
	/** What Windlass is started with besides its token file: WINDLASS_MODEL_BASE_URL, and WINDLASS_MODEL_ALLOWED_ORIGIN for a relay outside loopback. Names and an address: no secret. */
	readonly env: Record<string, string>;
	/** What the sandbox's token file holds in place of the token: a bearer only this relay takes, for this turn. */
	readonly placeholder: string;
	/** Gives the relay the turn's current token; a request that starts after it carries the new one. */
	hand(token: AccessToken): Promise<void>;
	/** Ends the lease: the relay forgets the turn's token and refuses its placeholder. Never rejects. */
	close(): Promise<void>;
	/** The lease's name where a restarted server can take it up again (`TurnSandbox.resumeRelay`): no credential. */
	readonly lease?: string;
}

/** Sets the mark `isTurnSandbox` looks for. Called by a provider's handle in its constructor. */
export function markTurnSandbox(handle: object): void {
	Object.defineProperty(handle, TURN_SANDBOX, { value: true });
}

/** Whether a handle the actors passed back came from a provider of this layer. */
export function isTurnSandbox(handle: SandboxHandle): handle is TurnSandbox {
	return (handle as unknown as Record<symbol, unknown>)[TURN_SANDBOX] === true;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws for a name that is not an environment variable's: one with `=` in it would be read as a name and a value. */
export function assertEnvNames(env: Record<string, string> | undefined): void {
	for (const key of Object.keys(env ?? {})) if (!ENV_NAME.test(key)) throw new Error(`invalid environment variable name: ${key}`);
}

/** One argument of a command line, quoted for a POSIX shell: for providers whose command API takes a string. */
export function shellQuote(argument: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`;
}

/** What `sweep` runs once the wait is over: SIGKILL to what is left of the run, the files removed, and what still runs after that counted. `$1` is the tag, the rest the files. */
export const SWEEP_SCRIPT = 'tag=$1; shift; if [ -n "$(wlp-run list "$tag")" ]; then wlp-run signal "$tag" KILL all; sleep 0.2; fi; [ $# -gt 0 ] && rm -f -- "$@"; wlp-run list "$tag" | wc -l';

// Runs directly via ask(), outside wlp-run, only at a turn boundary. A process can shed its
// run tag, session and parent, but remains visible in the container/guest's PID namespace.
const SWEEP_PROCESSES = `import os, signal, sys, time
from pathlib import Path

guest = sys.argv[1] == "e2b"
uid = os.getuid()
if uid != 1000:
    sys.exit("expected the sandbox agent")
keep = {1, os.getpid()}
if guest:
    # The E2B command launcher may wait for us in a login shell. Its ancestors belong
    # to this provider invocation, never to a previous turn.
    parent = os.getppid()
    while parent > 1:
        keep.add(parent)
        parent = int(Path(f"/proc/{parent}/stat").read_text().rsplit(")", 1)[1].split()[1])
else:
    mounts = Path("/proc/self/mountinfo").read_text().splitlines()
    if not any(line.split()[4] == "/dev/shm" and " - tmpfs " in line for line in mounts):
        sys.exit("missing private token tmpfs")
    init = Path("/proc/1/cmdline").read_bytes().split(b"\\0")
    if init[1:] != [b"--", b"sleep", b"infinity", b""]:
        sys.exit("unexpected container keepalive")
    # The init's original child precedes any orphans it adopted. A lookalike sleep is not exempt.
    keep.add(int(Path("/proc/1/task/1/children").read_text().split()[0]))

deadline = time.monotonic() + 10
while True:
    found = False
    processes = {entry for entry in Path("/proc").iterdir() if entry.name.isdecimal()}
    for proc in processes:
        if int(proc.name) in keep:
            continue
        try:
            status = dict(line.split(":", 1) for line in (proc / "status").read_text(errors="replace").splitlines() if ":" in line)
            if status["State"].split()[0] in ("Z", "X"):
                continue
            owner = int(status["Uid"].split()[0])
            if guest and owner != uid:
                continue
            if not guest and owner == 65534:
                sys.exit(75)
            os.kill(int(proc.name), signal.SIGKILL)
            found = True
        except (FileNotFoundError, ProcessLookupError):
            # It could have forked before exiting. Obtain a fresh process list.
            found = True
    # A process in the first snapshot may have forked and become a zombie before
    # we read its status. Inspect any new PID before reporting an empty sandbox.
    if not found and all(entry in processes for entry in Path("/proc").iterdir() if entry.name.isdecimal()):
        break
    if time.monotonic() >= deadline:
        sys.exit("processes still running")
    time.sleep(0.02)

if len(sys.argv) == 3:
    # A setup could have left a symlink here. Older paired runners reused the staging
    # filename without unlinking it before opening it for the first write.
    Path(sys.argv[2] + ".tmp").unlink(missing_ok=True)
`;

/** Fail closed if the provider cannot confirm that the session is clear for a new handoff. */
export async function sweepSessionProcesses(sandbox: TurnSandbox, tokenPath?: string): Promise<void> {
	const kind = sandbox.profile.startsWith("e2b") ? "e2b" : "docker";
	const scan = () => sandbox.ask(["/usr/bin/python3", "-I", "-S", "-c", SWEEP_PROCESSES, kind, ...(tokenPath ? [tokenPath] : [])], { timeoutMs: 15_000 });
	let result = await scan();
	if (kind === "docker" && result?.code === 75) {
		// No CAP_KILL: only the Git transport UID can signal its own orphan. Spare the
		// provider shells awaiting pkill, then confirm the whole namespace is clear.
		await sandbox.run("exec /usr/bin/pkill -KILL --ignore-ancestors -u 65534", { gitUser: true, timeoutMs: 10_000 });
		result = await scan();
	}
	if (result?.code !== 0) throw new Error("Could not clear leftover sandbox processes.");
}

/** What `writeSecretFile` runs, the content on standard input: a file beside the path (`<path>.tmp`), mode 0600, renamed into place. `$1` is the path. */
export const SECRET_FILE_SCRIPT = 'set -eu; umask 077; tmp="$1.tmp"; trap \'rm -f -- "$tmp"\' EXIT; rm -f -- "$tmp"; set -C; cat > "$tmp"; mv -fT -- "$tmp" "$1"';

export const RUN_TAG = /^[A-Za-z0-9_-]+$/;

/**
 * The arguments of Windlass's own start-up probe of bubblewrap (its packages/core/src/sandbox/detect.ts,
 * `PROBE_FLAGS`): the namespaces and mounts its sandbox uses. Where this passes, Windlass sandboxes
 * commands; where it fails, it sandboxes none and asks before each. E2B runs it in a sandbox it is to
 * promise this of, a runner in each new container of the profile that needs it.
 */
export const BWRAP_PROBE = ["bwrap", "--die-with-parent", "--unshare-user-try", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--", "true"];

