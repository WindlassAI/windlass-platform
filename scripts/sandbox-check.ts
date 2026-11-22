/**
 * End-to-end check of the sandbox layer on this machine. Run with:
 *
 *   cd server && npx tsx ../scripts/sandbox-check.ts
 *
 * No real model is called, no real sign-in is completed, and nothing is sent to OpenAI:
 *
 *   - every sign-in here is a synthetic auth.json with obviously fake tokens (`FAKE-ACCESS-TOKEN-...`);
 *   - no server runs beside this check, so its layers keep the users' sign-ins in this process
 *     (`signIns: "memory"`) where a server keeps them in the users' actors: the same holders, sealed
 *     the same way, over a store in memory. Windlass's sign-in commands run in helper containers of
 *     the image, as a development server runs them;
 *   - the helper that asks Windlass for an access token has no network in this check's layers
 *     (`tokenNetwork: "none"`), so it can send nothing: a token that has the time left the platform
 *     asks for is printed all the same, and one that needs a refresh fails;
 *   - where a refresh has to work, or to be refused (the section `valid-for`), the helper still has no
 *     network: its image is a throwaway one in which a stand-in for OpenAI's token endpoint runs beside
 *     Windlass, inside the same container, and answers the refresh with tokens that are as fake, or with
 *     a refusal;
 *   - every turn is scripted with WINDLASS_ACP_SCRIPT, except those of the sections `failures`,
 *     `hand-off` and `valid-for` that are handed a (fake) access token or must fail for want of one.
 *     Each of those runs in a sandbox that was first cut off from every network and shown to be, so
 *     Windlass could reach no model whatever it tried;
 *   - `finish` is tried only with addresses Windlass rejects before any network request.
 *
 * What a failure of the sign-in means is checked by Windlass's code for it, never by its words: each
 * code is produced by a real Windlass where a container can produce it (an expired token, a rejected
 * one, a file that is missing, empty, malformed or unreadable, a sign-in service that cannot be reached
 * or refuses), and a stand-in for the engine reports codes with words that say something else, to show
 * that the words decide nothing (`hand-off`).
 *
 * Everything created here is removed at the end, and nothing this run did not create is touched. No
 * token, fake as they are, may appear in what this check prints: its last check reads its own output.
 *
 *   WLP_CHECK_SECTIONS=image,failures   run only the sections whose names start with one of these
 */

import { DOCKER_BWRAP_PROBE } from "../server/src/sandbox/docker-flags.js";
import { imageId } from "./check-image.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProfileId, WindlassEvent } from "../server/src/contract.js";
import { type AccessToken, type AccessTokens, type RunTurnResult, type ScriptedModel, SandboxUserError, type TurnAnswer, type TurnControl, type TurnQuestion, type Windlass } from "../server/src/sandbox/api.js";
import { AcpConnection, AcpError, LineSplitter } from "../server/src/sandbox/acp.js";
import { DEMO_SCENARIOS, DEMO_SPARE_ANSWERS } from "../server/src/sandbox/demo.js";
import { DATA_DIR, IMAGE, LABEL, LABEL_ARG, MACHINE_LABEL, PROCESS_MARK, docker, helperFlags, randomId, runHelper, tmpName } from "../server/src/sandbox/docker.js";
import { ACCESS_TOKEN_FILE_ENV, NOT_SIGNED_IN, SIGN_IN_EXPIRED, SignInRefreshError, TOKEN_REJECTED, TOKEN_REPLACE_LEAD_MS, TOKEN_VALID_FOR_MS, loginTokenCommand } from "../server/src/sandbox/handoff.js";
import { createSandboxLayer } from "../server/src/sandbox/index.js";
import { DockerSandboxHandle, DockerSandboxes, containerName } from "../server/src/sandbox/sandboxes.js";
import { TOKEN_REMOVED, tokenFilePath } from "../server/src/sandbox/token-file.js";
import { runSetupCommand } from "../server/src/sandbox/setup.js";
import { ensureDataVolume } from "../server/src/sandbox/volumes.js";
import type { SignInMaterial } from "../server/src/signin/material.js";
import { sessionSandboxInput } from "../server/src/actors/internal.js";
import { DockerWindlass } from "../server/src/sandbox/windlass.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** This machine's architecture as Windlass's builds name it. */
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
/** The helper that asks Windlass for an access token gets no network here: nothing this check does can reach OpenAI. */
let image: string;
let layer: ReturnType<typeof createSandboxLayer>;
async function useImage(reference: string) {
	image = await imageId(reference);
	layer = createSandboxLayer({ image, signIns: "memory", tokenNetwork: "none" });
}
const run = randomId(8);
const baseTag = `windlass-platform-sandbox:chk-${run}`;
const uid = `chk-${run}`;
const uid2 = `chk-${run}-b`;
/** A user with no sign-in at all, for the turn that must fail for want of one. */
const uid3 = `chk-${run}-n`;
/** The users of the token source, of the hand-off (two) and of `--valid-for`. */
const uidT = `chk-${run}-t`;
const uidH = `chk-${run}-h`;
const uidD = `chk-${run}-d`;
const uidV = `chk-${run}-v`;
const allUids = [uid, uid2, uid3, uidT, uidH, uidD, uidV];
/** The volume the stand-in for OpenAI's token endpoint reads its plan from and notes its requests in (see STANDIN). */
const STANDIN_VOLUME = `wlp-standin-chk-${run}`;
/** Throwaway images this run built. */
const createdImages = new Set<string>();

/** The access tokens of this check's synthetic sign-ins. None may ever be printed. */
const TOKEN_A = "FAKE-ACCESS-TOKEN-A-not-a-real-token";
const TOKEN_B = "FAKE-ACCESS-TOKEN-B-not-a-real-token";
const TOKEN_C = "FAKE-ACCESS-TOKEN-C-not-a-real-token";
const SECRET = /FAKE-(ACCESS|REFRESH)-TOKEN|FAKE\.ID\.TOKEN/;

/** Everything this process prints, to be read at the end; the layer's own `[wlp]` lines are kept apart as well. */
const output: string[] = [];
const wlpLines: string[] = [];
for (const method of ["log", "warn", "error"] as const) {
	const real = console[method].bind(console);
	console[method] = (...parts: unknown[]) => {
		const line = parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
		output.push(line);
		if (line.startsWith("[wlp] ")) {
			wlpLines.push(line);
			real(`      ${line}`);
		} else real(line);
	};
}
const only = (process.env.WLP_CHECK_SECTIONS ?? "")
	.split(",")
	.map((name) => name.trim())
	.filter((name) => name !== "");
const createdSandboxes = new Set<string>();
/** Every sandbox this run created, removed or not. */
const everySandbox = new Set<string>();
let failures = 0;
let passes = 0;

function pass(name: string, detail = ""): void {
	passes += 1;
	console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
}
function fail(name: string, detail: string): void {
	failures += 1;
	console.log(`FAIL  ${name}  ${detail}`);
}
function expect(name: string, ok: boolean, detail = ""): boolean {
	// One line per check, whatever a command printed.
	const text = detail.trim().replace(/\s*\n\s*/g, " | ");
	if (ok) pass(name, text);
	else fail(name, text || "condition not met");
	return ok;
}
function info(text: string): void {
	console.log(`      ${text}`);
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (only.length > 0 && name !== "cleanup" && !only.some((prefix) => name.startsWith(prefix))) return;
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		fail(`${name}: unexpected error`, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
}
async function throwsUserError(name: string, body: () => Promise<unknown>, pattern?: RegExp): Promise<void> {
	try {
		await body();
		fail(name, "did not throw");
	} catch (error) {
		const ok = error instanceof SandboxUserError && (pattern === undefined || pattern.test(error.message));
		expect(name, ok, `${error instanceof SandboxUserError ? "SandboxUserError" : (error as Error).name}: ${(error as Error).message}`);
	}
}
async function throwsAny(name: string, body: () => Promise<unknown>): Promise<void> {
	try {
		await body();
		fail(name, "did not throw");
	} catch (error) {
		pass(name, (error as Error).message.slice(0, 100));
	}
}

const ms = (start: number) => `${Date.now() - start} ms`;

async function listOurs(): Promise<{ containers: string[]; volumes: string[] }> {
	const c = await docker(["ps", "-a", "--filter", `label=${LABEL_ARG}`, "--format", "{{.Names}}"]);
	const v = await docker(["volume", "ls", "--filter", `label=${LABEL_ARG}`, "--format", "{{.Name}}"]);
	const lines = (text: string) => text.split("\n").filter(name =>
		name.includes(run) || name.startsWith(`wlp-tmp-${PROCESS_MARK}-`) || [...everySandbox].some(id => name === containerName(id)));
	return { containers: lines(c.stdout), volumes: lines(v.stdout) };
}

/** Processes inside a container other than its init, `sleep infinity` and the ps itself. */
async function strayProcesses(container: string): Promise<string[]> {
	const result = await docker(["exec", container, "ps", "-eo", "pid=,args="]);
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !/^1 /.test(line) && !/ sleep infinity$/.test(line) && !/ ps -eo/.test(line));
}

interface TurnRun {
	result: RunTurnResult;
	events: WindlassEvent[];
	/** ms after start when each event arrived. */
	arrivals: number[];
	durationMs: number;
	questions: TurnQuestion[];
	control: TurnControl | null;
}

interface TurnExtra {
	onReview?: () => Promise<string>;
	windlassSessionId?: string;
	signal?: AbortSignal;
	onEvent?: (event: WindlassEvent, control: TurnControl | null) => void;
	onQuestion?: (question: TurnQuestion, signal: AbortSignal) => Promise<TurnAnswer>;
	/** Another engine than the layer's, for the checks of how a turn starts. */
	windlass?: Windlass;
}

/** Runs one turn. `script: null` is the one unscripted turn of this check: see `failures`. */
async function turn(handle: DockerSandboxHandle, prompt: string, script: ScriptedModel | null, extra: TurnExtra = {}): Promise<TurnRun> {
	const events: WindlassEvent[] = [];
	const arrivals: number[] = [];
	const questions: TurnQuestion[] = [];
	let control: TurnControl | null = null;
	const start = Date.now();
	const ask = extra.onQuestion;
	const result = await (extra.windlass ?? layer.windlass).runTurn(handle, {
		prompt,
		onReview: extra.onReview,
		script: script ?? undefined,
		windlassSessionId: extra.windlassSessionId,
		signal: extra.signal,
		onEvent: (event) => {
			events.push(event);
			arrivals.push(Date.now() - start);
			extra.onEvent?.(event, control);
		},
		onQuestion:
			ask === undefined
				? undefined
				: (question, signal) => {
						questions.push(question);
						return ask(question, signal);
					},
		onControl: (given) => (control = given),
	});
	return { result, events, arrivals, durationMs: Date.now() - start, questions, control };
}

const dataOf = (event: WindlassEvent | undefined) => (event?.data ?? {}) as Record<string, unknown>;
const ofType = (events: WindlassEvent[], type: string) => events.filter((event) => event.type === type);
const settled = (events: WindlassEvent[], callId: string) => events.find((event) => event.type === "tool.settled" && dataOf(event).callId === callId);
const started = (events: WindlassEvent[], callId: string) => events.find((event) => event.type === "tool.started" && dataOf(event).callId === callId);
const outputOf = (event: WindlassEvent | undefined) => String(dataOf(event).output ?? "");
const outcomeOf = (run: TurnRun) => (run.result.summary as { outcome?: string } | null)?.outcome;
const summaryOf = (run: TurnRun) => run.result.summary as { outcome?: string; steps?: number; requests?: number; durationMs?: number; usage?: { inputTokens: number; cachedInputTokens: number } | null; cachedShare?: number | null; executionId?: string; sessionId?: string } | null;
/** The summary is the last event, and the one the result carries. */
const endsWithSummary = (run: TurnRun) => run.events.length > 0 && run.events[run.events.length - 1]?.type === "cli.summary" && run.events[run.events.length - 1] === run.result.summary;
const kindsOf = (events: WindlassEvent[]) => [...new Set(events.map((event) => event.type))];
/** Whether one of this check's (fake) tokens is in what a turn gave back. */
const leaks = (found: TurnRun) => SECRET.test(JSON.stringify(found.events)) || SECRET.test(found.result.stderrTail) || SECRET.test(JSON.stringify(found.result.failure));
/** Why the turn's last model call failed, as Windlass names it: "transport", "auth", ... */
const lastStepError = (found: TurnRun) => ((dataOf(ofType(found.events, "step.failed").at(-1)).error as { error?: { kind?: string } } | undefined)?.error?.kind ?? "none") as string;
/** Windlass's code for why the turn's last model call failed (`step.failed`, `error.error.code`): "handed_in_expired", ...; "none" when it gave none. */
const lastStepCode = (found: TurnRun) => ((dataOf(ofType(found.events, "step.failed").at(-1)).error as { error?: { code?: string | null } } | undefined)?.error?.code ?? "none") as string;
/** After how many seconds each failed replacement of a turn's token file said it would be tried again. */
const retryWaits = (lines: string[]) => lines.filter((line) => line.includes("token.replace_failed")).map((line) => Number(/trying again in (\d+) s/.exec(line)?.[1] ?? Number.NaN));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const NET_PROBE = "if timeout 4 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>/dev/null; then echo NET_OK; else echo NET_BLOCKED; fi";

const PROBE_COMMAND = ["id -un", "echo probe-1 > probe.txt", `if ls ${DATA_DIR} >/dev/null 2>&1; then echo DATA_DIR_READABLE; else echo DATA_DIR_HIDDEN; fi`, NET_PROBE].join("; ");

/** What a command the agent runs can find out about the turn's access token file. It prints words, never the file. */
const tokenProbe = (path: string) =>
	[
		`if cat ${path} >/dev/null 2>&1; then echo TOKEN_READABLE; else echo TOKEN_HIDDEN; fi`,
		`if [ -n "\${${ACCESS_TOKEN_FILE_ENV}:-}" ]; then echo VARIABLE_PASSED; else echo VARIABLE_NOT_PASSED; fi`,
	].join("; ");

/** The engine of the turn running in a sandbox (`windlass acp`), and the variable that names its access token file, if it has one. */
const ENGINE_ENV = `pid=$(pgrep -f '^windlass acp$' | head -n 1); if [ -z "$pid" ]; then echo NO_ENGINE; else echo ENGINE; tr '\\0' '\\n' < /proc/$pid/environ | grep '^${ACCESS_TOKEN_FILE_ENV}=' || echo VARIABLE_UNSET; fi`;

/** Mode, owner and inode of a file, and of its content only the keys and the expiry. */
const fileFacts = (path: string) => `stat -c '%a %U %i' ${path} && python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); print(",".join(sorted(v)), v["expiresAt"])' ${path}`;

/** What Windlass's data directory in a sandbox holds, on one line. */
const DATA_LS = `(ls -A ${DATA_DIR}; ls -A /dev/shm) | tr '\\n' ' '`;

/**
 * Reads a file again and again for a while, as Windlass does at each model call, and counts the reads
 * that were not the whole JSON object: a file written in place would give some.
 */
const READER = `
import json, os, sys, time
path, until = sys.argv[1], time.time() + float(sys.argv[2])
good = bad = missing = 0
expiries, inodes = set(), set()
while time.time() < until:
    try:
        with open(path) as f:
            text = f.read()
            inode = os.fstat(f.fileno()).st_ino
    except FileNotFoundError:
        missing += 1
        time.sleep(0.004)
        continue
    try:
        value = json.loads(text)
        assert isinstance(value["accessToken"], str) and value["accessToken"] != "" and isinstance(value["expiresAt"], int)
        good += 1
        expiries.add(value["expiresAt"])
        inodes.add(inode)
    except Exception:
        bad += 1
    time.sleep(0.004)
print(json.dumps({"good": good, "bad": bad, "missing": missing, "tokens": len(expiries), "inodes": len(inodes)}))
`;

type Response = ScriptedModel["responses"][number];
const say = (text: string): Response => [{ type: "text", text }, { type: "finish", reason: "stop" }];
const shell = (callId: string, command: string, input: Record<string, unknown> = {}): Response => [{ type: "tool_call", callId, name: "shell", input: { command, ...input } }, { type: "finish", reason: "tool_calls" }];
/** A command that asks for the network: a question where commands are sandboxed. Each is a command of its own: Windlass refuses the same call a third time in one turn. */
const netCommand = (callId: string) => `${NET_PROBE}; echo "asked as ${callId}"`;
const net = (callId: string): Response => shell(callId, netCommand(callId), { sandbox: { network: true } });

const probeScript: ScriptedModel = {
	responses: [
		[
			{ type: "text", text: "Probing " },
			{ type: "delay", ms: 200 },
			{ type: "text", text: "the sandbox." },
			{ type: "tool_call", callId: "probe", name: "shell", input: { command: PROBE_COMMAND } },
			{ type: "usage", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 40, reasoningTokens: 0 },
			{ type: "finish", reason: "tool_calls" },
		],
		[{ type: "text", text: "Probed." }, { type: "usage", inputTokens: 1100, cachedInputTokens: 896, outputTokens: 5, reasoningTokens: 0 }, { type: "finish", reason: "stop" }],
	],
};

const continueScript: ScriptedModel = { responses: [shell("again", "cat probe.txt"), say("Still there.")] };
const plainScript: ScriptedModel = { responses: [say("Nothing to run.")] };
const longScript: ScriptedModel = { responses: [[{ type: "text", text: "Running a long command." }, ...shell("long", "sleep 120; echo finished")], say("It finished.")] };

const slowModelScript: ScriptedModel = {
	responses: [[{ type: "text", text: "Thinking" }, { type: "delay", ms: 120_000 }, { type: "text", text: " for a long time." }, { type: "finish", reason: "stop" }]],
};

/**
 * A stand-in for the engine that cannot be talked out of a turn: it answers `initialize` and
 * `session/new`, says an execution started, and then ignores every message, the end of its input and SIGINT.
 */
const DEAF_ENGINE = `
import json, signal, sys, time
signal.signal(signal.SIGINT, signal.SIG_IGN)
def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"protocolVersion": 1, "agentCapabilities": {"_meta": {"windlass": {"openMeta": ["hostTools"], "notifications": ["_windlass/event"]}}}}})
    elif message.get("method") == "session/new":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"sessionId": "ses_deaf"}})
    elif message.get("method") == "session/prompt":
        send({"jsonrpc": "2.0", "method": "_windlass/event", "params": {"sessionId": "ses_deaf", "event": {"type": "execution.started", "sessionId": "ses_deaf", "seq": 1, "time": 0, "v": 1, "data": {"executionId": "exe_deaf"}}}})
while True:
    time.sleep(1)
`;

/**
 * A stand-in for the engine whose one turn fails as it is told to: with a code on the failed model call
 * (`step.failed`), a code on the error the prompt is answered with, both or neither, and with whatever
 * words. It is how this check shows that the platform reads the codes and not the words.
 */
const CODED_ENGINE = `
import json, sys
plan = json.loads(sys.argv[1])
seq = 0
def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
def event(kind, data):
    global seq
    seq += 1
    send({"jsonrpc": "2.0", "method": "_windlass/event", "params": {"sessionId": "ses_coded", "event": {"type": kind, "sessionId": "ses_coded", "seq": seq, "time": 0, "v": 1, "data": data}}})
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"protocolVersion": 1, "agentCapabilities": {"_meta": {"windlass": {"openMeta": ["hostTools"], "notifications": ["_windlass/event"]}}}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"sessionId": "ses_coded"}})
    elif method == "session/prompt":
        event("execution.started", {"executionId": "exe_coded"})
        event("step.started", {"messageId": "msg_coded"})
        event("step.failed", {"messageId": "msg_coded", "usage": None, "error": {"kind": "provider", "error": {"kind": plan["kind"], "retryable": False, "status": None, "code": plan.get("stepCode"), "retryAfterMs": None, "requestId": None, "message": plan["stepSays"]}}})
        event("execution.failed", {"executionId": "exe_coded", "message": plan["says"]})
        named = {"reason": plan["reason"], "message": plan["says"]}
        if plan.get("code") is not None:
            named["code"] = plan["code"]
        if plan["reason"] == "execution_failed":
            named["providerError"] = plan["kind"]
        send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000 if plan["reason"] == "auth_required" else -32603, "message": plan["says"], "data": {"windlass": named}}})
    elif "id" in message:
        send({"jsonrpc": "2.0", "id": message["id"], "result": None})
`;

/**
 * A stand-in for the model's endpoint that turns every access token down. It runs inside the sandbox of
 * the one turn that needs it, which has no network: Windlass is pointed at it as its HTTPS proxy, so the
 * model request Windlass means for api.openai.com arrives here, is answered here with a 401, and goes
 * nowhere else. Anything that is not a POST (the list of the account's models) gets no answer at all,
 * as without a network. Each request is noted in `log` (where it was meant for and what it asked,
 * never a header or a body).
 */
const REJECTING_PROVIDER = `
import json, os, socket, ssl, sys
home = sys.argv[1]
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.path.join(home, "cert.pem"), os.path.join(home, "key.pem"))
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen(8)
with open(os.path.join(home, "ready"), "w") as ready:
    print(server.getsockname()[1], file=ready)
def head(stream):
    got = b""
    while b"\\r\\n\\r\\n" not in got:
        chunk = stream.recv(4096)
        if not chunk:
            raise EOFError()
        got += chunk
    return got
while True:
    connection, _ = server.accept()
    try:
        target = head(connection).split(b"\\r\\n")[0].decode().rsplit(" ", 1)[0]
        connection.sendall(b"HTTP/1.1 200 Connection established\\r\\n\\r\\n")
        tls = context.wrap_socket(connection, server_side=True)
        headers, _, body = head(tls).partition(b"\\r\\n\\r\\n")
        asked = headers.split(b"\\r\\n")[0].decode().rsplit(" ", 1)[0]
        with open(os.path.join(home, "log"), "a") as f:
            f.write("%s | %s\\n" % (target, asked))
        if asked.startswith("POST "):
            lower = headers.lower()
            length = max([int(line.split(b":")[1]) for line in lower.split(b"\\r\\n") if line.startswith(b"content-length:")] + [0])
            chunked = b"transfer-encoding: chunked" in lower
            while len(body) < length or (chunked and not body.endswith(b"0\\r\\n\\r\\n")):
                more = tls.recv(65536)
                if not more:
                    break
                body += more
            answer = json.dumps({"error": {"message": "the stand-in accepts no token", "code": "token_revoked"}}).encode()
            tls.sendall(b"HTTP/1.1 401 Unauthorized\\r\\nContent-Type: application/json\\r\\nContent-Length: %d\\r\\nConnection: close\\r\\n\\r\\n" % len(answer) + answer)
        tls.close()
    except Exception:
        pass
`;

/** How the stand-in's turn fails: Windlass's reason and sentence, the failed call's kind and message, and the codes (absent: none). */
interface CodedPlan {
	reason: "auth_required" | "execution_failed";
	kind: "auth" | "transport";
	says: string;
	stepSays: string;
	code?: string;
	stepCode?: string;
}

/** The kinds of events a one-shot `windlass --json` turn printed for a turn like the probe: what the layer passed on before it spoke ACP. */
function kindsBefore(): string[] {
	const lines = readFileSync(join(root, "fixtures/windlass-events/real-scripted-bwrap.jsonl"), "utf8").split("\n");
	return [...new Set(lines.filter((line) => line.trim() !== "").map((line) => (JSON.parse(line) as WindlassEvent).type))];
}

/** The local `docker exec` client of the turn running in `container`, a child of this process. */
function turnClient(container: string): number | null {
	const listed = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(process.pid)], { encoding: "utf8" });
	for (const line of listed.split("\n")) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (match !== null && match[2]!.includes(container) && match[2]!.includes("wlp-run exec") && match[2]!.includes("windlass acp")) return Number(match[1]);
	}
	return null;
}

/** A synthetic, obviously fake sign-in as Windlass saves one. */
function fakeCredentials(account: { sub: string; email: string }, expiresAt: number, accessToken = TOKEN_A) {
	return {
		hostId: "urn:uuid:00000000-0000-4000-8000-00000000c0de",
		clientId: "FAKE-client-id-for-sandbox-check",
		account,
		accessToken,
		refreshToken: "FAKE-REFRESH-TOKEN-not-a-real-token",
		idToken: "FAKE.ID.TOKEN",
		scopes: ["openid", "chatgpt.tokens.use.direct"],
		expiresAt,
	};
}

/** The same as sign-in material: what a user's holder is handed, and what it keeps sealed. */
function fakeSignIn(account: { sub: string; email: string }, expiresAt: number, accessToken = TOKEN_A): SignInMaterial {
	const credentials = fakeCredentials(account, expiresAt, accessToken);
	return { files: { "auth.json": JSON.stringify(credentials, null, 2), "host-id": credentials.hostId } };
}

async function lsVolume(volume: string): Promise<string> {
	const helper = tmpName();
	const result = await runHelper([...helperFlags(helper, "none"), "-v", `${volume}:${DATA_DIR}:ro`], helper, ["ls", "-A", DATA_DIR], { image });
	return result.stdout.trim().split("\n").join(" ");
}

const fakeAccount = (user: string) => ({ sub: `fake-sub-${user}`, email: "check@example.invalid" });

/** A synthetic sign-in in the user's store, as `adopt` leaves one, with nothing kept of an earlier one. The store is one for all of this check's layers, as it is for all servers; what `from` keeps of the user's token is dropped. */
async function signInFake(user: string, accessToken: string, expiresAt: number, from = layer): Promise<void> {
	saveFakeSignIn(user, accessToken, expiresAt);
	from.tokens.forget(user);
}

/** The same without dropping the token a layer keeps: what a refresh leaves in the store. */
function saveFakeSignIn(user: string, accessToken: string, expiresAt: number): void {
	layer.signIns!.put(user, fakeSignIn(fakeAccount(user), expiresAt, accessToken));
}

/** A finished sign-in attempt, simulated: the synthetic sign-in Windlass would have saved, sealed for the attempt as `finish` hands it back. */
function finishedAttempt(attemptId: string, account: { sub: string; email: string }, expiresAt: number, accessToken = TOKEN_A): string {
	return layer.signIns!.sealer.seal("attempt", attemptId, JSON.stringify({ files: fakeSignIn(account, expiresAt, accessToken).files }));
}

/** What a user's store holds, as it is stored: null when nothing was ever saved for the user. */
const storedSignIn = (user: string) => layer.signIns!.stored(user);

const volumeGone = async (name: string) => (await docker(["volume", "inspect", name])).code !== 0;

/** The names of the volumes a container mounts, with where. */
async function mountsOf(container: string): Promise<string> {
	const result = await docker(["container", "inspect", "--format", "{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}", container]);
	return result.stdout.trim();
}

/** A sandbox cut off from every network: where every turn that is handed an access token runs in this check. Null when it could not be shown to be. */
async function offlineSandbox(user: string, profile: SandboxProfileId, sessionId: string, from = layer): Promise<DockerSandboxHandle | null> {
	const id = await from.sandboxes.create({ uid: user, sessionId, profile });
	createdSandboxes.add(id);
	everySandbox.add(id);
	const handle = (await from.sandboxes.connect(id)) as DockerSandboxHandle;
	const cut = await docker(["network", "disconnect", "bridge", handle.container]);
	const reach = await handle.run(NET_PROBE);
	const networks = await docker(["container", "inspect", "--format", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}", handle.container]);
	const offline = cut.code === 0 && reach.stdout.trim() === "NET_BLOCKED" && networks.stdout.trim() === "";
	expect(`the ${profile} sandbox of ${sessionId} is cut off from every network`, offline, `${reach.stdout.trim()}, networks: ${networks.stdout.trim() || "none"}`);
	return offline ? handle : null;
}

/** Waits until `test` holds, at most `ms`. */
async function until(test: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) return false;
		await wait(50);
	}
	return true;
}

// ---------------------------------------------------------------------------------------------
// A stand-in for OpenAI's token endpoint, for the checks in which a refresh has to work
// ---------------------------------------------------------------------------------------------

/**
 * The stand-in itself. It runs inside the helper container that asks Windlass for a token, which has no
 * network: Windlass is pointed at it as its HTTPS proxy, so the request Windlass means for
 * auth.openai.com arrives here instead, is answered here, and goes nowhere else. The answer is what a
 * refresh gives: a new access token and a new refresh token, both obviously fake, and how long the
 * access token lasts, which the check says in `standin.json` in a volume of the stand-in's own (the
 * helper has no volume of a sign-in to put it beside: the sign-in comes and goes on its standard input
 * and output); or, when the check says so there, a refusal with the OAuth error code and the status it
 * names. Each request is noted in `standin.log` there (where it was meant for and what it asked, never
 * a token).
 */
const STANDIN = `
import json, os, socket, ssl, sys
data = sys.argv[1]
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/opt/standin/cert.pem", "/opt/standin/key.pem")
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen(8)
with open("/tmp/standin.ready", "w") as ready:
    print(server.getsockname()[1], file=ready)
def head(stream):
    got = b""
    while b"\\r\\n\\r\\n" not in got:
        chunk = stream.recv(4096)
        if not chunk:
            raise EOFError()
        got += chunk
    return got
while True:
    connection, _ = server.accept()
    try:
        target = head(connection).split(b"\\r\\n")[0].decode().rsplit(" ", 1)[0]
        connection.sendall(b"HTTP/1.1 200 Connection established\\r\\n\\r\\n")
        tls = context.wrap_socket(connection, server_side=True)
        headers, _, body = head(tls).partition(b"\\r\\n\\r\\n")
        length = max([int(line.split(b":")[1]) for line in headers.split(b"\\r\\n") if line.lower().startswith(b"content-length:")] + [0])
        while len(body) < length:
            body += tls.recv(4096)
        asked = headers.split(b"\\r\\n")[0].decode().rsplit(" ", 1)[0]
        log = os.path.join(data, "standin.log")
        number = (len(open(log).read().splitlines()) if os.path.exists(log) else 0) + 1
        with open(log, "a") as f:
            f.write("%s | %s | %s\\n" % (target, asked, "refresh_token" if b"grant_type=refresh_token" in body else "another grant"))
        with open(os.path.join(data, "standin.json")) as f:
            plan = json.load(f)
        if "refuse" in plan:
            status = b"%d Refused" % plan["status"]
            answer = json.dumps({"error": plan["refuse"], "error_description": "the stand-in does not refresh this sign-in"}).encode()
        else:
            status = b"200 OK"
            answer = json.dumps({"access_token": "FAKE-ACCESS-TOKEN-R%d-not-a-real-token" % number, "refresh_token": "FAKE-REFRESH-TOKEN-R%d-not-a-real-token" % number, "id_token": "FAKE.ID.TOKEN", "expires_in": plan["expiresIn"]}).encode()
        tls.sendall(b"HTTP/1.1 " + status + b"\\r\\nContent-Type: application/json\\r\\nContent-Length: %d\\r\\nConnection: close\\r\\n\\r\\n" % len(answer) + answer)
        tls.close()
    except Exception:
        pass
`;

/** Where the stand-in's volume is mounted in the helper container. */
const STANDIN_PLAN = "/opt/standin/plan";
/** The image the stand-in's volume is made with, so it belongs to the user Windlass runs as. Set when the image is built. */
let standInImage = "";

/** `windlass` in the throwaway image: the real one, with the stand-in beside it when it is asked for a token and the check has said what to answer (`standin.json`). */
const STANDIN_WINDLASS = `#!/bin/sh
if [ "\${1:-} \${2:-}" = "login token" ] && [ -f ${STANDIN_PLAN}/standin.json ]; then
  python3 -I /opt/standin/standin.py ${STANDIN_PLAN} >/dev/null 2>&1 &
  tries=0
  while [ ! -s /tmp/standin.ready ] && [ "$tries" -lt 100 ]; do sleep 0.1; tries=$((tries + 1)); done
  HTTPS_PROXY=http://127.0.0.1:$(cat /tmp/standin.ready) NODE_EXTRA_CA_CERTS=/opt/standin/cert.pem exec /usr/local/bin/windlass-real "$@"
fi
exec /usr/local/bin/windlass-real "$@"
`;

/** The throwaway image: the server's, its Windlass untouched but started through the wrapper, and a certificate of its own for the stand-in. */
const STANDIN_DOCKERFILE = `FROM ${baseTag}
USER root
RUN mv /usr/local/bin/windlass /usr/local/bin/windlass-real \\
 && mkdir -p ${STANDIN_PLAN} && chown agent ${STANDIN_PLAN} \\
 && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=auth.openai.com -addext subjectAltName=DNS:auth.openai.com \\
      -keyout /opt/standin/key.pem -out /opt/standin/cert.pem 2>/dev/null \\
 && chmod 644 /opt/standin/key.pem
COPY --chmod=0755 windlass /usr/local/bin/windlass
COPY --chmod=0644 standin.py /opt/standin/standin.py
USER agent
LABEL ${LABEL_ARG}
`;

/** Builds the throwaway image with the stand-in, labelled as everything of this project. Returns what went wrong, or "". */
function buildStandInImage(tag: string): string {
	const context = mkdtempSync(join(tmpdir(), "wlp-check-standin-"));
	try {
		// BuildKit needs a named FROM. Give the pinned base a private name for a sections-only run.
		if (!createdImages.has(baseTag)) {
			execFileSync("docker", ["tag", image, baseTag]);
			createdImages.add(baseTag);
		}
		writeFileSync(join(context, "Dockerfile"), STANDIN_DOCKERFILE);
		writeFileSync(join(context, "windlass"), STANDIN_WINDLASS);
		writeFileSync(join(context, "standin.py"), STANDIN);
		const built = spawnSync("docker", ["build", "--quiet", "--network", "none", "--label", LABEL_ARG, "--tag", tag, context], { encoding: "utf8" });
		if (built.status === 0) standInImage = tag;
		return built.status === 0 ? "" : built.stderr.trim() || `docker build exited with ${built.status}`;
	} finally {
		rmSync(context, { recursive: true, force: true });
	}
}

/** The `docker run` flags that give a helper the stand-in's volume: what a layer on the throwaway image runs its sign-in helpers with. */
const standInFlags = () => ["-v", `${STANDIN_VOLUME}:${STANDIN_PLAN}`];

/** Runs a short command in the stand-in's volume. The volume is made, labelled, the first time, by a container of the throwaway image, whose directory there is the agent's. */
async function inStandInVolume(command: string, stdin?: string): Promise<string> {
	if ((await docker(["volume", "inspect", STANDIN_VOLUME])).code !== 0) await docker(["volume", "create", "--label", LABEL_ARG, STANDIN_VOLUME], { check: true });
	const helper = tmpName();
	const result = await runHelper([...helperFlags(helper, "none"), ...standInFlags()], helper, ["sh", "-c", command], { stdin, image: standInImage });
	if (result.code !== 0) throw new Error(`could not reach the stand-in's plan: ${result.stderr}`);
	return result.stdout;
}

/** Says what the stand-in answers the next refresh with: a token that lasts this long. (One plan serves the one user whose sign-in is refreshed there.) */
async function standInIssues(_user: string, seconds: number): Promise<void> {
	await inStandInVolume(`cat > ${STANDIN_PLAN}/standin.json`, JSON.stringify({ expiresIn: seconds }));
}

/** Says that the stand-in refuses the next refreshes, with this OAuth error code and HTTP status. */
async function standInRefuses(_user: string, code: string, status: number): Promise<void> {
	await inStandInVolume(`cat > ${STANDIN_PLAN}/standin.json`, JSON.stringify({ refuse: code, status }));
}

/** The requests the stand-in answered, one line each: where Windlass meant it to go and what it asked. */
async function standInRequests(_user: string): Promise<string[]> {
	return (await inStandInVolume(`cat ${STANDIN_PLAN}/standin.log 2>/dev/null || true`)).split("\n").filter((line) => line.trim() !== "");
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log(`sandbox-check run ${run} on ${process.arch}`);
	const checkBuild = !only.length || only.some(prefix => "image".startsWith(prefix) || "screenshot images".startsWith(prefix));
	let built;
	if (checkBuild) {
		createdImages.add(baseTag);
		built = spawnSync(join(root, "sandbox/build.sh"), { env: { ...process.env, WLP_SANDBOX_VARIANT: "base", WLP_SANDBOX_IMAGE: baseTag }, encoding: "utf8" });
		if (built.status !== 0) throw new Error(built.stderr);
	}
	await useImage(checkBuild ? baseTag : IMAGE);
	if (built) {
		const { stdout, stderr } = built;
		await section("image", async () => {
			const printed = stdout.trim().split("\n").pop() ?? "";
			expect("build.sh builds the image and prints the Windlass version", /^\d+\.\d+\.\d+/.test(printed), printed);
			// Without WINDLASS_BINARY the image is built with the release sandbox/fetch-windlass.sh pins.
			if ((process.env.WINDLASS_BINARY ?? "") !== "") info("SKIP  which binary build.sh takes by default: WINDLASS_BINARY is set");
			else {
				expect(
					"without WINDLASS_BINARY build.sh takes the released Windlass that fetch-windlass.sh pins",
					new RegExp(`building ${baseTag} with \\S+/windlass-v\\d+\\.\\d+\\.\\d+/windlass-linux-${ARCH}`).test(stderr),
					stderr.trim().split("\n")[0] ?? "",
				);
			}
			const cache = await docker(["run", "--rm", "--pull", "never", "--network", "none", "--user", "agent",
				"--mount", "type=volume,dst=/tmp/.cache", image, "sh", "-c", "test -O /tmp/.cache && touch /tmp/.cache/check"]);
			expect("an empty cache volume inherits agent ownership and can be written", cache.code === 0, cache.stderr);
			const version = await layer.windlass.version();
			expect("windlass.version() reports the same version", version === printed, String(version));
			const problem = await layer.windlass.problem();
			expect("the sandbox image meets the Windlass version requirement", problem === null, problem ?? "");
			const size = await docker(["image", "inspect", "--format", "{{.Size}}", image]);
			info(`image size ${(Number(size.stdout.trim()) / 1e6).toFixed(0)} MB`);
		});
	}

	await section("screenshot images", async () => {
		const shotsTag = `windlass-platform-sandbox:chk-${run}-shots`;
		createdImages.add(shotsTag);
		execFileSync(join(root, "sandbox/build.sh"), { env: { ...process.env, WLP_SANDBOX_VARIANT: "shots", WLP_SANDBOX_IMAGE: shotsTag } });
		const shotsImage = await imageId(shotsTag);
		const { sandboxes } = createSandboxLayer({ image, shotsImage, signIns: "memory", tokenNetwork: "none" });
		for (const role of ["builder", "reviewer", undefined] as const) {
			for (const enabled of [false, true]) {
				const origin = role && { kind: "item" as const, itemId: "item", role };
				const args = sessionSandboxInput({ uid, sessionId: "check-selection", profile: "docker-hardened", origin }, enabled);
				const id = await sandboxes.create(args);
				createdSandboxes.add(id);
				everySandbox.add(id);
				const chosen = (await docker(["inspect", "-f", "{{.Config.Image}}", containerName(id)], { check: true })).stdout.trim();
				const expected = enabled && role ? shotsImage : image;
				expect(`Docker creates ${role ?? "personal"} on ${expected} with repository screenshots ${enabled}`, chosen === expected, chosen);
				const hasBrowser = expected === shotsImage;
				const files = hasBrowser ? "test -x /usr/local/bin/wlp-shot && test -x /usr/local/bin/wlp-headless-shell"
					: "test ! -e /usr/local/bin/wlp-shot && test ! -e /usr/local/bin/wlp-headless-shell && test ! -d /opt/wlp-browser";
				await docker(["exec", containerName(id), "sh", "-c", "test -O /tmp/.cache && " + files], { check: true });
				await sandboxes.destroy(id);
			}
		}
	});

	await section("profiles", async () => {
		const profiles = layer.sandboxes.profiles();
		expect("seven profiles, two available", profiles.length === 7 && profiles.filter((p) => p.available).map((p) => p.id).join(",") === "docker-windlass-sandbox,docker-hardened");
		expect("every unavailable profile says why", profiles.every((p) => p.available || (p.unavailableReason ?? "").length > 20));
		await throwsUserError("create() refuses an unavailable profile", () => layer.sandboxes.create({ uid, sessionId: "s", profile: "e2b" }));
		await throwsAny("create() refuses an invalid uid", () => layer.sandboxes.create({ uid: "../etc", sessionId: "s", profile: "docker-hardened" }));
	});

	await section("provider", async () => {
		// A runner's provider on the same daemon, for the same user: its containers and the hosted ones never meet.
		const machine = `m_${randomId(8)}`;
		const volume = `wlp-machine-chk-${run}`;
		const own = new DockerSandboxes({ image, machine, dataVolume: async () => (await ensureDataVolume(volume, { [MACHINE_LABEL]: machine }, image), volume) });
		let theirs: string | null = null;
		try {
			const hosted = await layer.sandboxes.create({ uid, sessionId: "check-provider", profile: "docker-hardened" });
			createdSandboxes.add(hosted);
			everySandbox.add(hosted);
			theirs = await own.create({ uid, sessionId: "check-provider", profile: "docker-hardened" });
			everySandbox.add(theirs);
			const hostedList = (await layer.sandboxes.list(uid)).map((box) => box.id);
			const ownList = (await own.list(uid)).map((box) => box.id);
			expect(
				"a runner's provider and the hosted one on one daemon each list, find and reach only their own containers",
				hostedList.includes(hosted) && !hostedList.includes(theirs) && ownList.includes(theirs) && !ownList.includes(hosted) && (await layer.sandboxes.state(theirs)) === "none" && (await own.state(hosted)) === "none" && (await layer.sandboxes.connect(theirs)) === undefined,
				`hosted ${hostedList.join(" ")}; runner ${ownList.join(" ")}`,
			);
			expect("the runner's container mounts its own data volume", (await mountsOf(containerName(theirs))) === `${volume}:${DATA_DIR}`, await mountsOf(containerName(theirs)));

			const handle = (await layer.sandboxes.connect(hosted)) as DockerSandboxHandle;
			// Names the docker client reads itself, and a value no shell quoting may change.
			const values: Record<string, string> = { DOCKER_HOST: "unix:///nowhere.sock", LD_PRELOAD: "/nowhere.so", HTTPS_PROXY: "http://127.0.0.1:9", CHECK_VALUE: "two words\n'q' \"$HOME\" `id` \\ %s" };
			let printed = "";
			const tag = `rchk${run}`;
			const shown = handle.start(["sh", "-c", 'for n in "$@"; do printf "%s=" "$n"; printenv "$n" | base64 -w0; echo; done; echo "aliases=$(env | grep -c "^WLP_SECRET_")"; echo "tag=$WLP_RUN_TAG"', "sh", ...Object.keys(values)], { secretEnv: values, onStdout: (text) => (printed += text) }, tag);
			const end = await shown.ended;
			const seen = Object.fromEntries(printed.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
			const exact = Object.entries(values).every(([name, value]) => seen[name] !== undefined && Buffer.from(seen[name]!, "base64").toString("utf8") === `${value}\n`);
			expect(
				"secrets reach the program under their own names, whole, though the docker client reads such names; no alias is left, and the run has the caller's tag",
				end.code === 0 && end.error === null && exact && seen.aliases === "0" && seen.tag === tag && shown.tag === tag,
				`exit ${end.code}; ${Object.keys(seen).join(", ")}`,
			);
			await throwsAny("a secret may not be named as the aliases are", async () => handle.start(["true"], { secretEnv: { WLP_SECRET_0: "x" } }));

			let got = 0;
			const big = handle.start(["sh", "-c", "head -c 4194304 /dev/zero | tr '\\0' x"], { onStdout: (text) => (got += text.length) });
			big.pauseOutput(true);
			await wait(1500);
			const whilePaused = got;
			const heldBack = !big.hasEnded;
			big.pauseOutput(false);
			const bigEnd = await big.ended;
			expect("pauseOutput holds the program back until it is resumed, and nothing is lost", heldBack && whilePaused < 2 * 1024 * 1024 && got === 4194304 && bigEnd.code === 0, `${whilePaused} bytes read while paused, ${got} in all`);
		} finally {
			if (theirs !== null) await own.destroy(theirs);
			await docker(["volume", "rm", "-f", volume]);
		}
	});

	await section("protocol client", async () => {
		// Two ends joined in memory: what one writes, the other receives.
		const agentSaw: string[] = [];
		let toAgent: (line: string) => void = () => {};
		const client = new AcpConnection(
			(line) => {
				toAgent(line);
				return true;
			},
			{
				notification: (method, params) => void agentSaw.push(`client got ${method} ${JSON.stringify(params)}`),
				request: async (method, params) => {
					if (method === "ask") return { answer: (params.n as number) * 2 };
					throw new Error(`no ${method} here`);
				},
			},
			"windlass",
		);
		const feed = new LineSplitter((line) => client.receive(line));
		const reply = (message: unknown) => feed.push(`${JSON.stringify(message)}\n`);
		const answered: unknown[] = [];
		toAgent = (line) => {
			const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
			if (message.method === "echo") {
				// A stray print, an empty line and a line split over two chunks before the answer.
				feed.push("warning: this is not JSON\n\n[1,2,3]\n");
				feed.push(`{"jsonrpc":"2.0","id":${message.id},`);
				feed.push(`"result":{"echo":${JSON.stringify(message.params)}}}\n`);
			} else if (message.method === "refuse") {
				reply({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "protocol words", data: { windlass: { reason: "session_in_use", message: "the engine's own sentence", holderPid: 42 } } } });
			} else if (message.method === "plain") {
				reply({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Resource not found" } });
			} else if (message.method === undefined && message.id !== undefined) {
				answered.push(message.result ?? message.error);
			}
		};
		const echoed = await client.request<{ echo: unknown }>("echo", { a: 1 });
		expect("a response is matched to its request across lines that are not JSON, an empty line and a split line", JSON.stringify(echoed) === '{"echo":{"a":1}}' && client.notJson.length === 2, JSON.stringify(client.notJson));
		const refused = await client.request("refuse", {}).then(() => null, (error: unknown) => error);
		const plain = await client.request("plain", {}).then(() => null, (error: unknown) => error);
		expect(
			"an error carries Windlass's reason, its own sentence and the holder; a plain one keeps the protocol's code and words",
			refused instanceof AcpError && refused.reason === "session_in_use" && refused.message === "the engine's own sentence" && refused.holderPid === 42 && plain instanceof AcpError && plain.reason === null && plain.code === -32002 && plain.message === "Resource not found",
		);
		reply({ jsonrpc: "2.0", method: "_windlass/event", params: { sessionId: "s", event: { type: "x" } } });
		reply({ jsonrpc: "2.0", id: 7, method: "ask", params: { n: 21 } });
		reply({ jsonrpc: "2.0", id: "b", method: "fs/read_text_file", params: {} });
		await wait(20);
		expect(
			"notifications reach the handler, and the agent's requests are answered with a result or an error",
			agentSaw.length === 1 && agentSaw[0]!.includes("_windlass/event") && JSON.stringify(answered) === '[{"answer":42},{"code":-32603,"message":"no fs/read_text_file here"}]',
			JSON.stringify(answered),
		);
		const slow = await client.request("silence", {}, { timeoutMs: 150 }).then(() => null, (error: unknown) => error);
		const pending = client.request("silence", {}).then(() => null, (error: unknown) => error);
		client.end("the engine process exited with code 9");
		const lost = await pending;
		const after = await client.request("echo", {}).then(() => null, (error: unknown) => error);
		expect(
			"a request fails when its time limit passes, when the connection ends under it, and after that",
			slow instanceof AcpError && slow.reason === "timeout" && /0\.1 s|0\.2 s/.test(slow.message) && lost instanceof AcpError && lost.reason === "closed" && /exited with code 9/.test(lost.message) && after instanceof AcpError && after.reason === "closed",
			`${(slow as Error | null)?.message} / ${(lost as Error | null)?.message}`,
		);
	});

	await section("seccomp", async () => {
		const profile = "docker-windlass-sandbox";
		const id = await layer.sandboxes.create({ uid, profile, sessionId: "seccomp" });
		createdSandboxes.add(id);
		everySandbox.add(id);
		const handle = (await layer.sandboxes.connect(id)) as DockerSandboxHandle;
		const security = await docker(["inspect", "--format", "{{json .HostConfig.SecurityOpt}}", handle.container], { check: true });
		const option = (JSON.parse(security.stdout) as string[]).find(opt => opt.startsWith("seccomp="));
		const policy = option?.startsWith("seccomp={") ? JSON.parse(option.slice(8)) : null;
		expect("dockerd received the seccomp filter as JSON", policy?.defaultAction === "SCMP_ACT_ERRNO");
		const [addition, ...syscalls] = policy?.syscalls ?? [];
		const { comment: _source, ...rule } = addition ?? {};
		// Removing our one rule reproduces the upstream seccomp/v0.1.0 default.json byte for byte,
		// including its architecture map, capability tests, and clone3 ENOSYS rule.
		const upstream = JSON.stringify({ ...policy, syscalls }, null, "\t");
		expect("the daemon filter differs from Docker 29.1.3’s default by exactly five bubblewrap calls",
			createHash("sha256").update(upstream).digest("hex") === "01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28"
			&& isDeepStrictEqual(rule, { names: ["clone", "unshare", "mount", "umount2", "pivot_root"], action: "SCMP_ACT_ALLOW" }));
		const probe = await handle.ask(DOCKER_BWRAP_PROBE);
		expect("the runner’s create-time probe works in the session container", probe?.code === 0, probe?.stderr);
		// io_uring_setup is syscall 425 on arm64 and amd64. Invalid arguments cannot create a ring.
		const filter = await handle.run(`python3 - <<'PYTHON'
import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
rc = libc.syscall(425, 0, None)
print(rc, ctypes.get_errno())
assert rc == -1 and ctypes.get_errno() in (errno.EPERM, errno.ENOSYS)
PYTHON`);
		expect("the outer container denies io_uring_setup", filter.exitCode === 0, filter.stdout);
		const t = await turn(handle, "Probe the sandbox, please.", probeScript);
		const result = outputOf(settled(t.events, "probe"));
		const run = dataOf(started(t.events, "probe")).run as { mode?: string; sandbox?: unknown } | undefined;
		expect("a full Windlass turn executes the shell tool inside bubblewrap",
			t.result.exitCode === 0 && outcomeOf(t) === "succeeded" && endsWithSummary(t)
			&& run?.mode === "auto" && !!run.sandbox && result.includes("DATA_DIR_HIDDEN") && result.includes("NET_BLOCKED")
			&& (await handle.readTextFile("probe.txt")) === "probe-1\n",
			`${t.events.length} events, exit ${t.result.exitCode}, ${outcomeOf(t)}, ${result.trim()}`);
		await layer.sandboxes.destroy(id);
		createdSandboxes.delete(id);
	});

	await section("reviewer commands", async () => {
		const box = await offlineSandbox(uid, "docker-windlass-sandbox", "check-reviewer");
		if (!box) throw new Error("reviewer sandbox unavailable");
		const script: ScriptedModel = { responses: [
			shell("pnpm", 'pnpm config get store-dir && test ! -w "$HOME/.config/pnpm/config.yaml" && echo read-only'),
			[{ type: "tool_call", callId: "delegate", name: "subagent", input: { task: "Say hello." } }, { type: "finish", reason: "tool_calls" }],
			say("Done."), say("Done."),
		] };
		let session: string | undefined;
		for (const open of ["new", "resume"]) {
			const attempt = await turn(box, "Review this commit.", script, { windlassSessionId: session, onReview: async () => "Filed." });
			expect(`reviewer ${open}: pnpm reads the image's read-only configuration`, outputOf(settled(attempt.events, "pnpm")).includes("/tmp/.cache/pnpm-store\nread-only"), outputOf(settled(attempt.events, "pnpm")));
			const denied = outputOf(settled(attempt.events, "delegate"));
			expect(`reviewer ${open}: the subagent tool is refused before it starts`, /may not use the tool "subagent"/.test(denied) && !started(attempt.events, "delegate"), denied);
			session = attempt.result.windlassSessionId ?? undefined;
			if (!session) throw new Error("missing reviewer session");
		}
	});

	for (const profileId of ["docker-windlass-sandbox", "docker-hardened"] as SandboxProfileId[]) {
		await section(`profile ${profileId}`, async () => {
			const profile = layer.sandboxes.profile(profileId);
			// The user is signed in (a synthetic sign-in): the sandbox must hold nothing of it all the same.
			await layer.logins.ensureUserVolume(uid);
			await signInFake(uid, TOKEN_A, Date.now() + 3600_000);
			const askedBefore = layer.tokens.asked;

			let start = Date.now();
			const id = await layer.sandboxes.create({ uid, sessionId: `check-${profileId}`, profile: profileId });
			createdSandboxes.add(id);
			everySandbox.add(id);
			expect("create() starts a sandbox", (await layer.sandboxes.state(id)) === "running", `id ${id}, ${ms(start)}`);
			const handle = (await layer.sandboxes.connect(id)) as DockerSandboxHandle;
			expect("connect() returns a handle with the profile and the user", handle !== undefined && handle.profile === profileId && handle.cwd === "/workspace" && handle.uid === uid);
			const mounted = await mountsOf(handle.container);
			const holds = (await handle.run(DATA_LS)).stdout.trim();
			expect(
				"the session's container mounts the user's data volume only and holds no sign-in, though the user has one",
				mounted === `wlp-user-${uid}:${DATA_DIR}` && !/auth\.json|host-id|auth\.lock/.test(holds) && (await layer.logins.status(uid)) !== null,
				`mounts: ${mounted}; data directory: ${holds === "" ? "empty" : holds}`,
			);
			const git = await handle.run("git rev-parse --is-inside-work-tree && git log --oneline | wc -l && ls -A");
			expect("the workspace is an empty git repository", git.exitCode === 0 && git.stdout.trim() === "true\n1\n.git", JSON.stringify(git.stdout));

			// Turn 1: streams events and ends with a summary; the profile's properties hold.
			const t1 = await turn(handle, "Probe the sandbox, please.", probeScript);
			const s1 = summaryOf(t1);
			const firstAt = t1.arrivals[0] ?? 0;
			const lastAt = t1.arrivals[t1.arrivals.length - 1] ?? 0;
			expect(
				"turn 1 streams events and ends with the summary event, succeeded",
				t1.events.length > 10 && endsWithSummary(t1) && s1?.outcome === "succeeded" && t1.result.exitCode === 0 && t1.result.failure === null && !t1.result.aborted,
				`${t1.events.length} events over ${lastAt - firstAt} ms, exit ${t1.result.exitCode}, outcome ${s1?.outcome}, turn ${t1.durationMs} ms`,
			);
			const missing = kindsBefore().filter((kind) => !kindsOf(t1.events).includes(kind));
			expect("turn 1 has every kind of event a one-shot `windlass --json` turn printed", missing.length === 0, missing.length === 0 ? kindsOf(t1.events).join(" ") : `missing: ${missing.join(" ")}`);
			const execution1 = dataOf(ofType(t1.events, "execution.succeeded")[0]).executionId;
			expect(
				"the summary has the command line's fields, added up from the turn's events",
				s1?.sessionId === t1.result.windlassSessionId && s1?.executionId === execution1 && s1?.steps === 2 && s1?.requests === 2 && typeof s1?.durationMs === "number" && s1?.usage?.inputTokens === 2100 && s1?.usage?.cachedInputTokens === 896 && s1?.cachedShare === 0.427,
				JSON.stringify(t1.result.summary),
			);
			expect("turn 1 reports Windlass's session id", /^ses_/.test(t1.result.windlassSessionId ?? ""), String(t1.result.windlassSessionId));
			// Nothing delivers a wake-up to a paused sandbox, so the platform's sessions are not offered the tools
			// (windlass-config.ts). The same Windlass in the same sandbox without the platform's file offers them.
			const toolsOf = (events: WindlassEvent[]) => ((dataOf(ofType(events, "baseline.set")[0]).tools ?? []) as { name?: string }[]).map((tool) => String(tool.name));
			const offered = toolsOf(t1.events);
			const bare = await handle.run(`d=$(mktemp -d) && mkdir $d/config $d/data $d/work && printf '%s' '${JSON.stringify({ responses: [say("ok")] })}' > $d/script.json && cd $d/work && XDG_CONFIG_HOME=$d/config XDG_DATA_HOME=$d/data WINDLASS_ACP_SCRIPT=$d/script.json windlass --json hi; rm -rf $d`);
			const bareOffered = toolsOf(bare.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as WindlassEvent));
			expect(
				"the platform's session is offered no wake-up tool, where Windlass without the platform's file offers wake_create",
				offered.includes("shell") && !offered.some((name) => name.startsWith("wake_")) && bareOffered.includes("wake_create"),
				`platform: ${offered.filter((name) => name.startsWith("wake_")).join(" ") || "no wake_*"}; without its file: ${bareOffered.filter((name) => name.startsWith("wake_")).join(" ") || `none (exit ${bare.exitCode})`}`,
			);
			const seqs = t1.events.filter((e) => typeof e.seq === "number").map((e) => e.seq as number);
			expect("every stored event of the turn arrives once and in order", seqs.length > 10 && seqs.every((seq, index) => seq === index + 1), `seq 1 to ${seqs[seqs.length - 1]}`);
			expect("text arrives as deltas before the turn ends", t1.events.some((e) => e.type === "text.delta") && t1.events.findIndex((e) => e.type === "text.delta") < t1.events.length - 3);
			if (t1.result.stderrTail.trim() !== "") info(`stderr: ${t1.result.stderrTail.trim()}`);
			const run1 = (dataOf(started(t1.events, "probe")) as { run?: { mode?: string; sandbox?: unknown } }).run;
			const out1 = outputOf(settled(t1.events, "probe"));
			info(`probe output: ${out1.trim().split("\n").join(" | ")}`);
			const sandboxed = run1?.sandbox !== null && run1?.sandbox !== undefined;
			expect(`commands run ${profile.approval === "auto" ? "inside" : "outside"} Windlass's sandbox (approval ${profile.approval})`, run1?.mode === profile.approval && sandboxed === (profileId === "docker-windlass-sandbox"), JSON.stringify(run1));
			expect(`commands ${profile.commandNetwork ? "have" : "have no"} network`, out1.includes(profile.commandNetwork ? "NET_OK" : "NET_BLOCKED"));
			expect(`commands ${profile.commandsCanReadAccessToken ? "can" : "cannot"} read Windlass's data directory`, out1.includes(profile.commandsCanReadAccessToken ? "DATA_DIR_READABLE" : "DATA_DIR_HIDDEN"));
			expect("the command ran as the non-root user and wrote the workspace", out1.startsWith("agent\n") && (await handle.readTextFile("probe.txt")) === "probe-1\n");
			const session = t1.result.windlassSessionId ?? undefined;

			// Turn 2 continues the same Windlass session.
			const t2 = await turn(handle, "Is the file still there?", continueScript, { windlassSessionId: session });
			const firstSeq2 = t2.events.find((e) => typeof e.seq === "number")?.seq ?? 0;
			const lastSeq1 = [...t1.events].reverse().find((e) => typeof e.seq === "number")?.seq ?? 0;
			expect(
				"turn 2 resumes the session: same id, no replayed history, its events follow turn 1's",
				t2.result.windlassSessionId === t1.result.windlassSessionId && !t2.events.some((e) => e.type === "session.created") && firstSeq2 === lastSeq1 + 1 && outcomeOf(t2) === "succeeded" && endsWithSummary(t2),
				`same id, first seq ${firstSeq2} after ${lastSeq1}, output ${JSON.stringify(outputOf(settled(t2.events, "again")).trim())}`,
			);
			const t2b = await turn(handle, "Nothing to do.", plainScript, { windlassSessionId: session });
			expect("a turn without a tool call ends the same way", outcomeOf(t2b) === "succeeded" && endsWithSummary(t2b) && t2b.result.exitCode === 0);
			info(`timing: a turn with one command and one answer took ${t2.durationMs} ms (first event after ${t2.arrivals[0]} ms, the summary after ${t2.arrivals[t2.arrivals.length - 1]} ms); one with an answer only ${t2b.durationMs} ms (first event ${t2b.arrivals[0]} ms, summary ${t2b.arrivals[t2b.arrivals.length - 1]} ms)`);

			// Questions. Where commands are sandboxed, one that asks for the network is a question to the user.
			if (profile.approval === "auto") {
				// Allow once: the call runs with the network, and nothing is remembered.
				const q1 = await turn(handle, "Two networked commands.", { responses: [net("n1"), net("n2"), say("Done.")] }, { onQuestion: async () => ({ choice: "once" }) });
				const asked = q1.questions[0];
				expect(
					"a command that asks for the network is put to onQuestion, as Windlass asks it",
					asked !== undefined &&
						asked.callId === "n1" &&
						asked.messageId === dataOf(ofType(q1.events, "approval.requested")[0]).messageId &&
						/network/i.test(asked.title) &&
						asked.subject === netCommand("n1") &&
						asked.details.length > 0 &&
						asked.choices.map((choice) => `${choice.id}:${choice.approve}`).join(",") === "once:true,session:true,deny:false" &&
						asked.choices[1]?.remembers !== null &&
						asked.subagent === null,
					JSON.stringify({ title: asked?.title, choices: asked?.choices.map((choice) => choice.id), remembers: asked?.choices[1]?.remembers }),
				);
				const answers1 = ofType(q1.events, "approval.answered").map((e) => dataOf(e));
				expect(
					"allow once: the command runs with the network, and the next one asks again",
					q1.questions.length === 2 && answers1.length === 2 && answers1.every((a) => a.choice === "once" && a.approve === true) && outputOf(settled(q1.events, "n1")).includes("NET_OK") && outputOf(settled(q1.events, "n2")).includes("NET_OK") && outcomeOf(q1) === "succeeded",
					`${q1.questions.length} questions, outputs ${outputOf(settled(q1.events, "n1")).trim()} / ${outputOf(settled(q1.events, "n2")).trim()}`,
				);
				const qSession = q1.result.windlassSessionId ?? undefined;

				// Deny with a note: the call is refused and the model is given the note.
				const q3 = await turn(handle, "One more networked command.", { responses: [net("n3"), say("Done.")] }, { windlassSessionId: qSession, onQuestion: async () => ({ choice: "deny", note: "not on this network" }) });
				const answer3 = dataOf(ofType(q3.events, "approval.answered")[0]);
				expect(
					"deny with a note: the call is refused, the model reads the note, and the turn goes on",
					answer3.choice === "deny" && answer3.approve === false && answer3.note === "not on this network" && dataOf(settled(q3.events, "n3")).outcome === "error" && /declined/.test(outputOf(settled(q3.events, "n3"))) && outputOf(settled(q3.events, "n3")).includes("not on this network") && started(q3.events, "n3") === undefined && outcomeOf(q3) === "succeeded",
					outputOf(settled(q3.events, "n3")),
				);

				// A rejection, and a choice the question does not offer: both decline.
				let nth = 0;
				const q4 = await turn(handle, "Two more.", { responses: [net("n4"), net("n5"), say("Done.")] }, {
					windlassSessionId: qSession,
					onQuestion: async () => {
						nth += 1;
						if (nth === 1) throw new Error("the answerer failed");
						return { choice: "always" };
					},
				});
				expect(
					"a rejected onQuestion and a choice the question does not offer both decline the call",
					q4.questions.length === 2 && ofType(q4.events, "approval.answered").every((e) => dataOf(e).approve === false) && ["n4", "n5"].every((id) => dataOf(settled(q4.events, id)).outcome === "error" && started(q4.events, id) === undefined) && outcomeOf(q4) === "succeeded",
					ofType(q4.events, "approval.answered").map((e) => `${String(dataOf(e).choice)}:${String(dataOf(e).approve)}`).join(", "),
				);

				// Nobody to ask: refused at once as unattended.
				const q5 = await turn(handle, "And one with nobody there.", { responses: [net("n6"), say("Done.")] }, { windlassSessionId: qSession });
				const denied5 = dataOf(ofType(q5.events, "approval.denied")[0]);
				expect(
					"without onQuestion the call is refused at once as unattended, and the model is told",
					denied5.reason === "unattended" && ofType(q5.events, "approval.requested").length === 0 && dataOf(settled(q5.events, "n6")).outcome === "error" && /no one to approve/.test(outputOf(settled(q5.events, "n6"))) && outcomeOf(q5) === "succeeded",
					outputOf(settled(q5.events, "n6")),
				);

				// An abort while the question is pending withdraws it.
				{
					const controller = new AbortController();
					let withdrawn = false;
					let abortedAt = 0;
					const q6 = await turn(handle, "A question nobody answers.", { responses: [net("n7"), say("Done.")] }, {
						windlassSessionId: qSession,
						signal: controller.signal,
						onQuestion: (_question, signal) =>
							new Promise<TurnAnswer>(() => {
								signal.addEventListener("abort", () => (withdrawn = true));
								setTimeout(() => {
									abortedAt = Date.now();
									controller.abort();
								}, 600);
							}),
					});
					const stopMs = Date.now() - abortedAt;
					expect(
						"an abort while a question is pending withdraws it: its signal aborts and the turn ends as interrupted",
						withdrawn && q6.result.aborted && outcomeOf(q6) === "interrupted" && endsWithSummary(q6) && q6.result.failure === null && stopMs < 4000,
						`${stopMs} ms after the abort, exit ${q6.result.exitCode}`,
					);
					expect(
						"the withdrawn question is in the events as a call that did not start, with no answer recorded",
						ofType(q6.events, "approval.requested").length === 1 && ofType(q6.events, "approval.answered").length === 0 && ofType(q6.events, "approval.denied").length === 0 && dataOf(settled(q6.events, "n7")).outcome === "not_started" && ofType(q6.events, "execution.interrupted").length === 1,
						kindsOf(q6.events.slice(q6.events.findIndex((e) => e.type === "approval.requested"))).join(" "),
					);
					const after = await turn(handle, "Is the file still there?", continueScript, { windlassSessionId: qSession });
					expect("the next turn works after a withdrawn question", outcomeOf(after) === "succeeded" && after.result.exitCode === 0 && (await strayProcesses(handle.container)).length === 0);
				}

				// Allow for the session, in a session nothing has tainted yet. The first networked command's output is
				// content from outside, and Windlass documents (docs/safety.md, "Taint") that an approval given before
				// such content arrived does not count after it: the second call asks once more, and the approval given
				// then holds, for the rest of this turn and in the next turn's process.
				const q7 = await turn(handle, "Three networked commands.", { responses: [net("s1"), net("s2"), net("s3"), say("Done.")] }, { onQuestion: async () => ({ choice: "session" }) });
				const grants = ofType(q7.events, "approval.answered").map((e) => (dataOf(e).grants as unknown[] | undefined)?.length ?? 0);
				expect(
					"allow for the session: remembered once the conversation holds the first command's output, then a networked call does not ask",
					q7.questions.map((question) => question.callId).join(",") === "s1,s2" &&
						q7.questions[1]!.details.some((detail) => /do not apply/.test(detail)) &&
						grants.join(",") === "1,1" &&
						ofType(q7.events, "taint.noticed").length === 1 &&
						["s1", "s2", "s3"].every((id) => outputOf(settled(q7.events, id)).includes("NET_OK")) &&
						outcomeOf(q7) === "succeeded",
					`asked for ${q7.questions.map((question) => question.callId).join(", ")}; the second question says: ${q7.questions[1]?.details.slice(1).join(" ")}`,
				);
				const q8 = await turn(handle, "And one in the next turn.", { responses: [net("s4"), say("Done.")] }, { windlassSessionId: q7.result.windlassSessionId ?? undefined });
				expect(
					"the session's approval holds in the next turn's process: the call runs with nobody to ask",
					ofType(q8.events, "approval.requested").length === 0 && ofType(q8.events, "approval.denied").length === 0 && outputOf(settled(q8.events, "s4")).includes("NET_OK") && outcomeOf(q8) === "succeeded",
					outputOf(settled(q8.events, "s4")).trim(),
				);
			} else {
				const q1 = await turn(handle, "Two networked commands.", { responses: [net("n1"), net("n2"), say("Done.")] }, { onQuestion: async () => ({ choice: "deny" }) });
				expect(
					"with approval full the same commands run without a question",
					q1.questions.length === 0 && ofType(q1.events, "approval.requested").length === 0 && outputOf(settled(q1.events, "n1")).includes("NET_OK") && outputOf(settled(q1.events, "n2")).includes("NET_OK") && outcomeOf(q1) === "succeeded",
				);
			}

			// Abort a long command.
			{
				const controller = new AbortController();
				let abortedAt = 0;
				const t3 = await turn(handle, "Run the long command.", longScript, {
					windlassSessionId: session,
					signal: controller.signal,
					onEvent: (event) => {
						if (event.type === "tool.started" && abortedAt === 0)
							setTimeout(() => {
								abortedAt = Date.now();
								controller.abort();
							}, 1500);
					},
				});
				const stopMs = Date.now() - abortedAt;
				const stray = await strayProcesses(handle.container);
				expect(
					"aborting a turn running `sleep 120` cancels it through the protocol and stops the command within a few seconds",
					abortedAt > 0 && t3.result.aborted && stopMs < 6000 && outcomeOf(t3) === "interrupted" && endsWithSummary(t3) && t3.result.exitCode === 0 && t3.result.failure === null && ofType(t3.events, "execution.interrupt_requested").length === 1,
					`stopped ${stopMs} ms after the abort, exit ${t3.result.exitCode}, outcome ${outcomeOf(t3)}, settled: ${JSON.stringify(outputOf(settled(t3.events, "long")).slice(0, 90))}`,
				);
				info(`timing: the summary of the stopped turn arrived ${t3.arrivals[t3.arrivals.length - 1]! - (t3.durationMs - stopMs)} ms after the abort, the result ${stopMs} ms after it`);
				expect("no stray processes are left after the abort", stray.length === 0, stray.join("; ") || "only init and sleep infinity");
				if (t3.result.stderrTail.trim() !== "") info(`stderr: ${t3.result.stderrTail.trim()}`);
			}

			// Abort while the (scripted) model is streaming.
			{
				const controller = new AbortController();
				let abortedAt = 0;
				const t4 = await turn(handle, "Think for a long time.", slowModelScript, {
					windlassSessionId: session,
					signal: controller.signal,
					onEvent: (event) => {
						if (event.type === "text.delta" && abortedAt === 0)
							setTimeout(() => {
								abortedAt = Date.now();
								controller.abort();
							}, 800);
					},
				});
				const stopMs = Date.now() - abortedAt;
				const stray = await strayProcesses(handle.container);
				expect("aborting while the model streams stops the turn", t4.result.aborted && stopMs < 6000 && outcomeOf(t4) === "interrupted" && stray.length === 0, `${stopMs} ms, exit ${t4.result.exitCode}, outcome ${outcomeOf(t4)}, stray ${stray.length}`);
			}

			// The interrupted session takes the next turn.
			const t5 = await turn(handle, "Is the file still there?", continueScript, { windlassSessionId: session });
			expect("an interrupted session continues with the next turn", outcomeOf(t5) === "succeeded" && t5.result.exitCode === 0);

			// An abort that comes before the turn has started anything.
			{
				const controller = new AbortController();
				controller.abort();
				const never = await turn(handle, "Never sent.", continueScript, { windlassSessionId: session, signal: controller.signal });
				expect("a turn whose signal is already aborted starts nothing", never.result.aborted && never.events.length === 0 && never.result.summary === null && never.durationMs < 1000);
			}

			// Steering: a message sent while a command runs reaches the model at the next step of the same turn.
			{
				let steered: Promise<void> | null = null;
				let admittedAt = -1;
				const steerScript: ScriptedModel = { responses: [shell("slow", "for i in 1 2 3; do echo tick $i; sleep 1; done"), say("Done, and I read your note."), say("Spare.")] };
				const t6 = await turn(handle, "Run something slow.", steerScript, {
					windlassSessionId: session,
					onEvent: (event, control) => {
						if (event.type === "tool.started" && steered === null && control !== null)
							steered = wait(700)
								.then(() => control.steer("Keep it short."))
								.then(() => void (admittedAt = Date.now()));
					},
				});
				await (steered as Promise<void> | null)?.catch(() => undefined);
				const enqueued = t6.events.find((e) => e.type === "inbox.enqueued" && JSON.stringify(dataOf(e).content).includes("Keep it short."));
				const deliveredAt = t6.events.findIndex((e) => e.type === "inbox.delivered" && dataOf(e).messageId === dataOf(enqueued).messageId);
				const lastStepAt = t6.events.map((e) => e.type).lastIndexOf("step.started");
				expect(
					"steer() resolves once Windlass admitted the message, which reaches the model at the next step of the same turn",
					admittedAt > 0 && dataOf(enqueued).delivery === "steer" && deliveredAt > 0 && deliveredAt < lastStepAt && t6.events.findIndex((e) => e.type === "tool.settled") < deliveredAt && ofType(t6.events, "execution.started").length === 1 && summaryOf(t6)?.steps === 2 && outcomeOf(t6) === "succeeded",
					`admitted while the command ran, delivered at event ${deliveredAt} before the last step at ${lastStepAt}, ${summaryOf(t6)?.steps} steps`,
				);
				const late = await Promise.all([t6.control!.steer("Too late.").then(() => "resolved", (error: Error) => error.message), t6.control!.cancelCall("msg_x", "slow").then(() => "resolved", (error: Error) => error.message)]);
				expect("steer() and cancelCall() reject once the turn has ended", late.every((message) => /turn has ended/.test(message)), late.join(" / "));
			}

			// A message admitted just after the model's last step ended starts another execution; it is this turn's too.
			{
				let steered: Promise<void> | null = null;
				const t7 = await turn(handle, "Answer briefly.", { responses: [say("First answer."), say("Answer to the late message."), say("Spare.")] }, {
					windlassSessionId: session,
					onEvent: (event, control) => {
						if (event.type === "execution.succeeded" && steered === null && control !== null) steered = control.steer("One more thing.");
					},
				});
				const admitted = await (steered as Promise<void> | null)?.then(() => true, () => false);
				const texts = ofType(t7.events, "text.ended").map((e) => String(dataOf(e).text));
				expect(
					"a message admitted right after the turn's last step is answered in the same runTurn, with one summary at the end",
					admitted === true && texts.join("|") === "First answer.|Answer to the late message." && ofType(t7.events, "cli.summary").length === 1 && endsWithSummary(t7) && summaryOf(t7)?.steps === 2 && outcomeOf(t7) === "succeeded" && t7.result.failure === null,
					`${ofType(t7.events, "execution.started").length} executions, ${summaryOf(t7)?.steps} steps, texts: ${texts.join(" | ")}`,
				);
			}

			// The local docker client of a running turn is killed: the turn ends as a failure of the engine, and the session is free.
			{
				let killedAt = 0;
				const t8 = await turn(handle, "Run the long command.", longScript, {
					windlassSessionId: session,
					onEvent: (event) => {
						if (event.type === "tool.started" && killedAt === 0)
							setTimeout(() => {
								const pid = turnClient(handle.container);
								killedAt = Date.now();
								if (pid !== null) process.kill(pid, "SIGKILL");
							}, 500);
					},
				});
				const endedMs = Date.now() - killedAt;
				const stray = await strayProcesses(handle.container);
				expect(
					"a turn whose local docker client is killed ends as an engine failure and leaves nothing running in the sandbox",
					killedAt > 0 && t8.result.failure?.reason === "engine" && !t8.result.aborted && t8.result.exitCode === null && t8.result.summary === null && stray.length === 0 && endedMs < 9000,
					`${endedMs} ms after the kill; ${t8.result.failure?.message}; stray ${stray.length}`,
				);
				const next = await turn(handle, "Is the file still there?", continueScript, { windlassSessionId: session });
				expect("the next turn works at once after the client was killed", outcomeOf(next) === "succeeded" && next.result.exitCode === 0 && next.result.failure === null, `${next.durationMs} ms${next.result.stderrTail.trim() === "" ? "" : `; ${next.result.stderrTail.trim().split("\n")[0]}`}`);
			}

			// The server is killed in the middle of a turn: another process (this one) runs the next turn.
			{
				const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--orphan-turn", id, session ?? ""], { env: { ...process.env, WLP_SANDBOX_IMAGE: image }, stdio: ["ignore", "pipe", "inherit"] });
				let printed = "";
				const reached = new Promise<boolean>((resolve) => {
					child.stdout.on("data", (chunk: Buffer) => {
						printed += chunk.toString();
						if (printed.includes("ORPHAN-COMMAND-RUNNING")) resolve(true);
					});
					child.on("exit", () => resolve(false));
					setTimeout(() => resolve(false), 30_000);
				});
				const running = await reached;
				await wait(300);
				child.kill("SIGKILL");
				const orphaned = (await strayProcesses(handle.container)).filter((line) => line.includes("windlass"));
				const t9 = await turn(handle, "Is the file still there?", continueScript, { windlassSessionId: session });
				expect(
					"after the server was killed mid-turn, the next turn stops what it left running and works at once",
					running && outcomeOf(t9) === "succeeded" && t9.result.failure === null && (await strayProcesses(handle.container)).length === 0,
					`${orphaned.length} Windlass process(es) were left; the next turn took ${t9.durationMs} ms; ${t9.result.stderrTail.trim().split("\n")[0] ?? ""}`,
				);
			}

			// The session is still held by an engine that is shutting down, and that the layer did not start (so it is not
			// stopped first): the turn waits for it, as the command line does, instead of failing as "in use".
			{
				await handle.writeTextFile("/tmp/.wlp-holder.json", JSON.stringify({ responses: [shell("hold", "trap '' TERM; sleep 60 & sleep 60"), say("Never.")] }));
				const client = spawn("docker", ["exec", "-i", "-w", "/workspace", "-e", "WINDLASS_ACP_SCRIPT=/tmp/.wlp-holder.json", "-e", "WINDLASS_WAKE=off", "-e", "WINDLASS_ACP_LOG=warn", handle.container, "windlass", "acp"], { stdio: ["pipe", "pipe", "ignore"] });
				let commandRuns = () => {};
				const running = new Promise<void>((resolve) => (commandRuns = resolve));
				const holder = new AcpConnection(
					(line) => client.stdin.write(`${line}\n`),
					{
						notification: (method, params) => {
							if (method === "_windlass/event" && (params.event as WindlassEvent).type === "tool.started") commandRuns();
						},
						request: async () => ({ outcome: { outcome: "cancelled" } }),
					},
					"windlass",
				);
				const lines = new LineSplitter((line) => holder.receive(line));
				client.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
				client.on("close", () => holder.end("the holder is gone"));
				await holder.request("initialize", { protocolVersion: 1, clientInfo: { name: "wlp-check", version: "0" }, clientCapabilities: { _meta: { windlass: { events: true, updates: false } } } });
				await holder.request("session/resume", { sessionId: session, cwd: "/workspace", mcpServers: [], _meta: { windlass: { approval: profile.approval, attended: false, unattended: "deny" } } });
				holder.request("session/prompt", { sessionId: session, prompt: [{ type: "text", text: "Hold the session." }] }).catch(() => undefined);
				const held = await Promise.race([running.then(() => true), wait(15_000).then(() => false)]);
				// A moment for the command to set its trap.
				await wait(800);
				// Its client dies: the engine shuts down, and its command, which ignores SIGTERM, keeps it at that for 3 s.
				client.kill("SIGKILL");
				const waited = await turn(handle, "Is the file still there?", continueScript, { windlassSessionId: session });
				expect(
					"a session still held by an engine that is shutting down is waited for, not refused",
					held && outcomeOf(waited) === "succeeded" && waited.result.failure === null && /still held by the engine of an earlier turn/.test(waited.result.stderrTail) && waited.durationMs > 2000 && waited.durationMs < 9000,
					`${waited.durationMs} ms; ${waited.result.stderrTail.trim().split("\n")[0]}`,
				);
				await handle.run("rm -f /tmp/.wlp-holder.json");
				// It exits by itself once its command is dead (SIGKILL after 3 s) and its last timer has run out.
				let stray = await strayProcesses(handle.container);
				for (let tries = 0; stray.length > 0 && tries < 30; tries += 1) {
					await wait(200);
					stray = await strayProcesses(handle.container);
				}
				expect("the engine that held it is gone, and its command with it", stray.length === 0, stray.join("; ") || "only init and sleep infinity");
			}

			// Every demo scenario really runs to `succeeded`; where a call asks, the user allows it.
			let n = 0;
			for (const [name, build] of Object.entries(DEMO_SCENARIOS)) {
				n += 1;
				const script = build(n + 1);
				const td = await turn(handle, `demo ${name}`, script, { windlassSessionId: session, onQuestion: async () => ({ choice: "once" }) });
				const summary = summaryOf(td);
				const planned = script.responses.length - DEMO_SPARE_ANSWERS;
				const errors = td.events.filter((e) => e.type === "tool.settled" && dataOf(e).outcome !== "success").map((e) => outputOf(e).split("\n")[0]);
				const deltas = td.events.filter((e) => e.type === "text.delta").length;
				expect(
					`demo scenario ${name} succeeds`,
					summary?.outcome === "succeeded" &&
						td.result.exitCode === 0 &&
						td.result.failure === null &&
						summary?.steps === planned &&
						(name === "failThenCorrect" ? errors.length === 1 : errors.length === 0) &&
						td.questions.length === (name === "askForNetwork" && profile.approval === "auto" ? 1 : 0) &&
						td.durationMs > 4000 &&
						td.durationMs < (name === "longCommand" ? 26000 : 16000) &&
						(summary?.usage?.inputTokens ?? 0) > 0,
					`${td.durationMs} ms, ${summary?.steps} steps, ${deltas} text deltas, cached share ${summary?.cachedShare}, ${td.questions.length} question(s), tool errors: ${errors.length === 0 ? "none" : errors.join(" / ")}`,
				);
				const last = [...td.events].reverse().find((e) => e.type === "text.ended");
				if (summary?.outcome !== "succeeded" || errors.length > (name === "failThenCorrect" ? 1 : 0)) info(`closing text: ${JSON.stringify(dataOf(last).text)}`);
				if (name === "askForNetwork") expect("the question scenario's second command reports that the request ran", /The request ran: \d+ header lines saved/.test(outputOf(settled(td.events, `call_${n + 1}_2`))), outputOf(settled(td.events, `call_${n + 1}_2`)).split("\n")[0]);
				if (name === "longCommand") expect("the long command prints a line a second and its report says it completed", td.events.filter((e) => e.type === "tool.progress").length >= 10 && /completed: all 12/.test(outputOf(settled(td.events, `call_${n + 1}_2`))), outputOf(settled(td.events, `call_${n + 1}_2`)).trim());
			}

			// The same scenarios with the user in the way: a message while the first tool runs (the model reads it at the
			// next step), one while the last planned answer plays and one while the answer to that plays (each makes the
			// model answer once more), the question declined, and the long command stopped. None may end in an error.
			for (const [name, build] of Object.entries(DEMO_SCENARIOS)) {
				n += 1;
				const script = build(n + 1);
				const planned = script.responses.length - DEMO_SPARE_ANSWERS;
				const steers: Array<Promise<string>> = [];
				let steps = 0;
				let early = false;
				let stopped: Promise<{ stopped: boolean; message: string | null }> | null = null;
				const send = (control: TurnControl, text: string) => steers.push(control.steer(text).then(() => "admitted", (error: Error) => `refused: ${error.message}`));
				const td = await turn(handle, `demo ${name}, steered`, script, {
					windlassSessionId: session,
					onQuestion: async () => ({ choice: "deny", note: "not now" }),
					onEvent: (event, control) => {
						if (control === null) return;
						if (event.type === "tool.started" && !early) {
							early = true;
							send(control, "A note while you work.");
							if (name === "longCommand") stopped = wait(2500).then(() => control.cancelCall(String(dataOf(event).messageId), String(dataOf(event).callId)));
						}
						if (event.type === "step.started") {
							steps += 1;
							if (steps === planned) send(control, "One more thing before you finish.");
							if (steps === planned + 1) send(control, "And another.");
						}
					},
				});
				const admitted = await Promise.all(steers);
				const summary = summaryOf(td);
				const errors = td.events.filter((e) => e.type === "tool.settled" && dataOf(e).outcome !== "success").map((e) => outputOf(e).split("\n")[0]);
				const expected = (name === "failThenCorrect" ? 1 : 0) + (name === "askForNetwork" && profile.approval === "auto" ? 1 : 0) + (name === "longCommand" ? 1 : 0);
				const texts = ofType(td.events, "text.ended");
				expect(
					`demo scenario ${name} ends well when steered three times`,
					summary?.outcome === "succeeded" && td.result.failure === null && td.result.exitCode === 0 && admitted.join(",") === "admitted,admitted,admitted" && summary?.steps === planned + DEMO_SPARE_ANSWERS && ofType(td.events, "execution.failed").length === 0 && ofType(td.events, "retry.scheduled").length === 0 && errors.length === expected,
					`${td.durationMs} ms, ${summary?.steps} steps for ${planned} planned, steers ${admitted.join(", ")}, tool errors: ${errors.length === 0 ? "none" : errors.join(" / ")}; last words: ${JSON.stringify(String(dataOf(texts[texts.length - 1]).text).slice(0, 60))}`,
				);
				if (name === "askForNetwork" && profile.approval === "auto") expect("the question scenario's second command reports that the declined request did not run", /did not run/.test(outputOf(settled(td.events, `call_${n + 1}_2`))) && td.questions.length === 1, outputOf(settled(td.events, `call_${n + 1}_2`)).trim());
				if (name === "longCommand") {
					const answer = await (stopped as Promise<{ stopped: boolean; message: string | null }> | null);
					const first = settled(td.events, `call_${n + 1}_1`);
					expect(
						"cancelCall() stops the long command only: it settles as stopped by the user and the turn goes on to its end",
						answer?.stopped === true && ofType(td.events, "tool.cancel_requested").length === 1 && dataOf(first).outcome === "error" && /Stopped by the user/.test(outputOf(first)) && /stopped early: [1-9] of 12/.test(outputOf(settled(td.events, `call_${n + 1}_2`))) && ofType(td.events, "execution.interrupt_requested").length === 0 && td.durationMs < 14000,
						`${td.durationMs} ms; ${outputOf(settled(td.events, `call_${n + 1}_2`)).trim()}`,
					);
				}
			}
			const status = await handle.run("git status --porcelain | sort | tr '\\n' ' '");
			info(`workspace after the demos: ${status.stdout.trim()}`);
			const picked = ["please fix the failing test", "hello", "hello", "fetch the response headers of example.com", "what does https://example.com answer?", "run a long build", "wait a little"].map((prompt, index) => JSON.stringify(layer.windlass.demoScript(prompt, index === 2 ? 2 : 1)));
			expect(
				"demoScript picks by the prompt's words, otherwise rotates by turn",
				picked[0]!.includes("slugify") && picked[1]!.includes("primes.py") && picked[2]!.includes("slugify") && picked[3]!.includes("curl") && picked[4]!.includes("curl") && picked[5]!.includes("build.log") && picked[6]!.includes("build.log"),
			);
			const scripts = Object.values(DEMO_SCENARIOS).map((build) => build(3));
			const count = (response: Response, type: string) => response.filter((item) => item.type === type).length;
			expect(
				`every demo script has ${DEMO_SPARE_ANSWERS} spare answers after its planned ones, and each thought and answer is a single item`,
				scripts.every(
					(script) =>
						script.responses.every((response) => count(response, "text") <= 1 && count(response, "reasoning") <= 1) &&
						script.responses.slice(-DEMO_SPARE_ANSWERS).every((response) => count(response, "text") === 1 && count(response, "tool_call") === 0 && response.some((item) => item.type === "finish" && item.reason === "stop")) &&
						count(script.responses[script.responses.length - DEMO_SPARE_ANSWERS - 1]!, "tool_call") === 0,
				),
			);

			// run(): stdin, env, separate stderr, multi-byte output, timeout and abort.
			if (profileId === "docker-windlass-sandbox") {
				let streamed = "";
				const r = await handle.run('cat; echo "$GREETING"; echo "to stderr" >&2; printf "\\xc3\\xa9t\\xc3\\xa9\\n"; exit 7', { stdin: "from stdin\n", env: { GREETING: "héllo wörld" }, onStdout: (chunk) => (streamed += chunk) });
				expect("run() passes stdin and env, separates stderr, keeps UTF-8 and the exit code", r.exitCode === 7 && r.stdout === "from stdin\nhéllo wörld\nété\n" && streamed === r.stdout && r.stderr === "to stderr\n", JSON.stringify(r));
				start = Date.now();
				const t = await handle.run("trap '' TERM; sleep 60 & sleep 60; wait", { timeoutMs: 1000 });
				const strayT = await strayProcesses(handle.container);
				expect("run() with timeoutMs stops a command that ignores SIGTERM (SIGKILL after the grace period)", t.timedOut && t.exitCode === null && strayT.length === 0 && Date.now() - start < 8000, `${ms(start)}, stray ${strayT.length}`);
				const controller = new AbortController();
				start = Date.now();
				setTimeout(() => controller.abort(), 700);
				const a = await handle.run("sleep 60", { signal: controller.signal });
				const strayA = await strayProcesses(handle.container);
				expect("run() abort stops the command inside the container", a.aborted && a.exitCode === null && strayA.length === 0 && Date.now() - start < 5000, `${ms(start)}`);
				await handle.writeTextFile("dir/sub/ünïcode.txt", "line 1\nzwei ✓\n");
				expect("writeTextFile/readTextFile round-trip, creating directories", (await handle.readTextFile("/workspace/dir/sub/ünïcode.txt")) === "line 1\nzwei ✓\n");
			}

			// Suspend keeps files; connect starts it again.
			start = Date.now();
			await layer.sandboxes.suspend(id);
			expect("suspend() stops the sandbox", (await layer.sandboxes.state(id)) === "paused", ms(start));
			await layer.sandboxes.suspend(id);
			const stoppedTurn = await turn(handle, "Is the file still there?", continueScript, { windlassSessionId: session });
			expect("a turn in a sandbox that is not running fails as `engine`, with why", stoppedTurn.result.failure?.reason === "engine" && stoppedTurn.result.summary === null && stoppedTurn.events.length === 0, stoppedTurn.result.failure?.message.split("\n")[0] ?? "");
			start = Date.now();
			const again = (await layer.sandboxes.connect(id)) as DockerSandboxHandle;
			expect("connect() starts it again and the workspace files are kept", (await layer.sandboxes.state(id)) === "running" && (await again.readTextFile("probe.txt")) === "probe-1\n" && (await again.readTextFile("primes.py")).includes("sieve"), ms(start));
			const resumed = await turn(again, "Is the file still there?", continueScript, { windlassSessionId: session });
			expect("the Windlass session continues after suspend and connect", outcomeOf(resumed) === "succeeded" && outputOf(settled(resumed.events, "again")) === "probe-1\n");

			// Destroy.
			await layer.sandboxes.destroy(id);
			const gone = await docker(["container", "inspect", `wlp-session-${id}`]);
			expect("destroy() removes the container", (await layer.sandboxes.state(id)) === "none" && gone.code !== 0 && (await layer.sandboxes.connect(id)) === undefined);
			await layer.sandboxes.destroy(id);
			createdSandboxes.delete(id);
			const kept = await lsVolume(`wlp-user-${uid}`);
			expect("the user's data volume outlives the sandbox and holds Windlass's sessions, no sign-in and no token file", kept.includes("sessions") && !/auth\.json|host-id|access-token/.test(kept), kept);
			expect("none of these scripted turns asked for the user's access token", layer.tokens.asked === askedBefore, `${layer.tokens.asked - askedBefore} requests`);
		});
	}

	await section("failures", async () => {
		// A user with no sign-in, and a sandbox cut off from every network: nothing here could reach a model.
		await layer.logins.ensureUserVolume(uid3);
		const id = await layer.sandboxes.create({ uid: uid3, sessionId: "check-failures", profile: "docker-windlass-sandbox" });
		createdSandboxes.add(id);
		everySandbox.add(id);
		const handle = (await layer.sandboxes.connect(id)) as DockerSandboxHandle;
		const cut = await docker(["network", "disconnect", "bridge", handle.container]);
		const reach = await handle.run(NET_PROBE);
		const account = await layer.logins.status(uid3);
		const files = await lsVolume(`wlp-user-${uid3}`);
		const isolated = cut.code === 0 && reach.stdout.trim() === "NET_BLOCKED" && account === null && !files.includes("auth");
		expect("the sandbox for the failures has no sign-in and no network", isolated, `network ${reach.stdout.trim()}, sign-in ${account === null ? "none" : "PRESENT"}, data volume: ${files === "" ? "empty" : files}`);

		// Scripted failures first.
		const unknown = await turn(handle, "Continue.", plainScript, { windlassSessionId: "ses_000000000000000000000000" });
		expect(
			"an unknown session id fails as `session_not_found` with Windlass's sentence, before anything runs",
			unknown.result.failure?.reason === "session_not_found" && /no session ses_0{24}/.test(unknown.result.failure.message) && unknown.events.length === 0 && unknown.result.summary === null && unknown.result.windlassSessionId === null && unknown.result.exitCode === 0 && !unknown.result.aborted,
			`${unknown.result.failure?.message} (${unknown.durationMs} ms)`,
		);
		const failing = await turn(handle, "Fail.", { responses: [[{ type: "fail", kind: "usage_limit", message: "the scripted plan has no requests left" }]] });
		expect(
			"a turn whose model call fails ends as `execution_failed`, with the events and a summary that say failed",
			failing.result.failure?.reason === "execution_failed" && outcomeOf(failing) === "failed" && endsWithSummary(failing) && ofType(failing.events, "execution.failed").length === 1 && failing.result.exitCode === 0,
			failing.result.failure?.message ?? "",
		);
		const signedOut = await turn(handle, "Fail.", { responses: [[{ type: "fail", kind: "auth", message: "the scripted token was rejected" }]] }, { windlassSessionId: failing.result.windlassSessionId ?? undefined });
		expect("a turn the provider rejects for its sign-in ends as `auth_required`", signedOut.result.failure?.reason === "auth_required" && outcomeOf(signedOut) === "failed", signedOut.result.failure?.message ?? "");
		const slash = await turn(handle, "/nosuchcommand now", plainScript, { windlassSessionId: failing.result.windlassSessionId ?? undefined });
		expect(
			"a prompt that names a command file that does not exist is refused with Windlass's sentence and no model call",
			slash.result.failure?.reason === "invalid_request" && /no command \/nosuchcommand/.test(slash.result.failure.message) && ofType(slash.events, "step.started").length === 0 && slash.result.summary === null,
			slash.result.failure?.message ?? "",
		);

		// How a turn starts, with stand-ins for the engine.
		const standIn = (command: string, startTimeoutMs?: number) => new DockerWindlass(layer.tokens, { image, engineCommand: ["sh", "-c", command], startTimeoutMs });
		const silent = await turn(handle, "x", plainScript, { windlass: standIn("cat > /dev/null", 1500) });
		expect("an engine that does not answer `initialize` in time is given up on", silent.result.failure?.reason === "engine" && /did not start within 1\.5 s/.test(silent.result.failure.message) && silent.durationMs < 8000, `${silent.result.failure?.message} (${silent.durationMs} ms)`);
		const other = await turn(handle, "x", plainScript, { windlass: standIn(`read -r line; printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}'; cat > /dev/null`) });
		expect("a server that does not offer `_windlass/event` is refused", other.result.failure?.reason === "engine" && /does not send Windlass's events \(_windlass\/event\)/.test(other.result.failure.message) && other.events.length === 0, other.result.failure?.message ?? "");
		const broken = await turn(handle, "x", plainScript, { windlass: standIn("echo 'fatal: the engine broke' >&2; exit 3") });
		expect(
			"an engine that exits before it is ready fails the turn as `engine`, with its last words and exit code",
			broken.result.failure?.reason === "engine" && /could not start: fatal: the engine broke \(its process exited with code 3\)/.test(broken.result.failure.message) && broken.result.exitCode === 3 && /the engine broke/.test(broken.result.stderrTail),
			broken.result.failure?.message ?? "",
		);
		const noisy = await turn(handle, "Say something.", plainScript, { windlass: standIn("echo 'this line is not JSON'; exec windlass acp") });
		expect(
			"a line on stdout that is not JSON does not disturb the turn, and is kept for the error message",
			outcomeOf(noisy) === "succeeded" && noisy.result.failure === null && noisy.result.stderrTail === "[stdout, not protocol messages]\nthis line is not JSON",
			JSON.stringify(noisy.result.stderrTail),
		);
		// An engine that opens a session and then answers nothing, not even a cancel, and ignores its stdin closing and
		// SIGINT: the abort falls back to the signals, and the turn still ends as aborted with nothing left behind.
		{
			const controller = new AbortController();
			const deaf = new DockerWindlass(layer.tokens, { image, engineCommand: ["python3", "-c", DEAF_ENGINE] });
			let abortedAt = 0;
			const pending = turn(handle, "x", plainScript, { windlass: deaf, signal: controller.signal });
			setTimeout(() => {
				abortedAt = Date.now();
				controller.abort();
			}, 1500);
			const cut = await pending;
			const stopMs = Date.now() - abortedAt;
			expect(
				"an abort the engine does not answer falls back to signals: the turn ends as aborted, without an exit code, and nothing is left",
				cut.result.aborted && cut.result.exitCode === null && cut.result.summary === null && cut.result.failure === null && cut.events.length === 1 && stopMs > 6000 && stopMs < 16000 && (await strayProcesses(handle.container)).length === 0,
				`${stopMs} ms after the abort (6 s for the cancel, then session/close, stdin closed, SIGINT, SIGTERM)`,
			);
		}
		expect("none of these left a process in the sandbox", (await strayProcesses(handle.container)).length === 0);

		// An unscripted turn of a user without a sign-in: there is no access token to hand it, so Windlass is not even
		// started. No prompt is sent, so no model is asked; and had anything tried, this sandbox has no network to try with.
		if (!isolated) {
			info("SKIP  the turn without a sign-in: the sandbox is not provably cut off from the network and without a sign-in");
		} else {
			const noSignIn = await turn(handle, "Hello?", null);
			expect(
				"an unscripted turn without a sign-in fails as `auth_required` before Windlass starts: no event, no prompt, no model request",
				noSignIn.result.failure?.reason === "auth_required" && /Sign in with ChatGPT/.test(noSignIn.result.failure.message) && noSignIn.events.length === 0 && noSignIn.result.summary === null && noSignIn.result.windlassSessionId === null && noSignIn.result.exitCode === null && !noSignIn.result.aborted && noSignIn.durationMs < 5000,
				`${noSignIn.result.failure?.message} (${noSignIn.durationMs} ms)`,
			);
			expect("it left nothing in the sandbox: no process, no token file", (await strayProcesses(handle.container)).length === 0 && !(await handle.run(DATA_LS)).stdout.includes("access-token"));
		}
		await layer.sandboxes.destroy(id);
		createdSandboxes.delete(id);
	});

	await section("sign-in", async () => {
		const sealer = layer.signIns!.sealer;
		const attempt = `chk${run}a`;
		const resourcesBefore = await listOurs();
		await throwsAny("start() refuses an invalid attempt id", () => layer.logins.start("../../x"));
		await throwsAny("status() refuses an invalid uid", () => layer.logins.status("a b"));
		const started1 = await layer.logins.start(attempt);
		const url = new URL(started1.url);
		expect(
			"start() returns OpenAI's address and the loopback redirect",
			url.origin === "https://auth.openai.com" && started1.redirectPrefix === "http://127.0.0.1:1455/auth/callback" && url.searchParams.get("redirect_uri") === started1.redirectPrefix,
			`${url.origin}${url.pathname}, redirect ${started1.redirectPrefix}`,
		);
		const state = url.searchParams.get("state") ?? "";
		const pending = Object.keys((JSON.parse(sealer.open("attempt", attempt, started1.attempt)) as { files: Record<string, string> }).files).sort();
		const resourcesAfter = await listOurs();
		expect(
			"what it hands back is the pending sign-in Windlass saved, sealed for this attempt: the blob shows nothing of it, and the helper that ran Windlass left no volume and no container",
			pending.join(" ") === "auth-pending.json host-id" && state !== "" && !started1.attempt.includes(state) && resourcesAfter.volumes.join(" ") === resourcesBefore.volumes.join(" ") && resourcesAfter.containers.join(" ") === resourcesBefore.containers.join(" "),
			`${pending.join(", ")}; ${started1.attempt.length} characters`,
		);
		const callback = started1.redirectPrefix;
		// Each of these is rejected by Windlass before any network request (packages/core/src/auth/chatgpt.ts finishLogin), and the helper has no network.
		await throwsUserError("finish() rejects a malformed address (checked here)", () => layer.logins.finish(attempt, started1.attempt, "not an address"), /not the address/);
		await throwsUserError("finish() rejects another site's address (checked here)", () => layer.logins.finish(attempt, started1.attempt, `https://example.com/auth/callback?code=x&state=${state}`), /not the address/);
		await throwsUserError("finish() rejects a wrong state (Windlass: state_mismatch)", () => layer.logins.finish(attempt, started1.attempt, `${callback}?code=fake-code&state=wrong-state`), /different sign-in attempt/);
		await throwsUserError("finish() reports a refusal in the browser (Windlass: access_denied)", () => layer.logins.finish(attempt, started1.attempt, `${callback}?error=access_denied&state=${state}`), /not approved/);
		await throwsUserError("finish() rejects an address without an issued client (Windlass: registration_incomplete)", () => layer.logins.finish(attempt, started1.attempt, `${callback}?code=fake-code&state=${state}`), /registering/);
		await throwsUserError("finish() under another attempt's id finds the attempt unknown: the blob is this attempt's only", () => layer.logins.finish(`chk${run}none`, started1.attempt, `${callback}?code=fake-code&state=${state}`), /unknown or has expired/);
		await throwsUserError("finish() of something that is not a sealed attempt finds the attempt unknown", () => layer.logins.finish(attempt, "not a blob", `${callback}?code=fake-code&state=${state}`), /unknown or has expired/);
		await throwsUserError("adopt() refuses an attempt that is not finished", () => layer.logins.adopt(attempt, started1.attempt, uid2), /not finished/);

		expect("status() is null for a user who never signed in", (await layer.logins.status(`chk-${run}-nobody`)) === null && storedSignIn(`chk-${run}-nobody`) === null);
		await layer.logins.ensureUserVolume(uid2);
		await layer.logins.ensureUserVolume(uid2);
		expect("ensureUserVolume() creates an empty data volume (idempotent) and nothing for a sign-in, as for a demo user; status() is null", (await layer.logins.status(uid2)) === null && (await lsVolume(`wlp-user-${uid2}`)) === "");

		// A finished attempt, simulated: the synthetic auth.json Windlass would have saved, sealed as `finish` hands it back.
		const expiresAt = Date.now() + 3_600_000;
		await layer.logins.adopt(attempt, finishedAttempt(attempt, { sub: "fake-sub-123", email: "fake.user@example.invalid" }, expiresAt), uid2);
		const account = await layer.logins.status(uid2);
		const row = storedSignIn(uid2);
		expect(
			"adopt() puts the sign-in in the user's store, sealed for that user: the data volume gets nothing, and what is stored shows no token and no account",
			row?.sealed != null && !SECRET.test(row.sealed) && !row.sealed.includes("fake-sub-123") && !row.sealed.includes("fake.user") && (await lsVolume(`wlp-user-${uid2}`)) === "",
			`${row?.sealed?.length ?? 0} characters stored`,
		);
		expect("status() reports sub, email and expiry only", JSON.stringify(account) === JSON.stringify({ sub: "fake-sub-123", email: "fake.user@example.invalid", accessExpiresAt: expiresAt }) && !JSON.stringify(account).includes("FAKE-"), JSON.stringify(account));
		let opened = "it opened";
		try {
			sealer.open("user", uid, row!.sealed!);
		} catch (error) {
			opened = error instanceof Error ? error.name : String(error);
		}
		const asAnother = await layer.signIns!.adopt(uid3, row!.sealed!).then(
			() => null,
			(error: unknown) => error,
		);
		expect("the stored sign-in is of no use to another user: it does not open as theirs, and their holder refuses it", opened === "SealError" && asAnother instanceof Error && (await layer.logins.status(uid3)) === null, opened);

		// A second sign-in replaces the first.
		const attempt2 = `chk${run}b`;
		await layer.logins.adopt(attempt2, finishedAttempt(attempt2, { sub: "fake-sub-456", email: "other@example.invalid" }, expiresAt + 1), uid2);
		expect("adopt() replaces an earlier sign-in", (await layer.logins.status(uid2))?.sub === "fake-sub-456");

		// A pre-upgrade token file left on the data volume: logout takes it too.
		{
			const helper = tmpName();
			await runHelper([...helperFlags(helper, "none"), "-v", `wlp-user-${uid2}:${DATA_DIR}`], helper, ["sh", "-c", `umask 077; echo '{}' > ${DATA_DIR}/access-token-0123456789ab.json; mkdir -p ${DATA_DIR}/sessions`], { image });
		}
		await layer.logins.logout(uid2);
		expect(
			"logout() forgets the sign-in in the user's store and removes legacy token files from the data volume",
			(await layer.logins.status(uid2)) === null && storedSignIn(uid2)?.sealed === null && (await lsVolume(`wlp-user-${uid2}`)) === "sessions",
			`wlp-user-${uid2}: ${await lsVolume(`wlp-user-${uid2}`)}`,
		);
		await layer.logins.logout(`chk-${run}-nobody`);
		expect("logout() of a user without a sign-in is a no-op and makes no volume", (await volumeGone(`wlp-user-chk-${run}-nobody`)));

		const attempt3 = `chk${run}c`;
		const once = await layer.logins.start(attempt3);
		const twice = await layer.logins.start(attempt3);
		expect(
			"start() again issues a new pending sign-in",
			new URL(once.url).searchParams.get("state") !== new URL(twice.url).searchParams.get("state") && once.attempt !== twice.attempt,
		);
	});

	await section("token source", async () => {
		const tokens = layer.tokens;
		let asked = tokens.asked;
		await throwsUserError("current() tells a user without any sign-in to sign in with ChatGPT", () => tokens.current(uidT), /Sign in with ChatGPT/);
		expect("for that it does not start Windlass: there is no sign-in to ask about", tokens.asked === asked);
		await throwsAny("current() refuses an invalid uid", () => tokens.current("../etc"));

		// A synthetic sign-in whose token is new: Windlass prints it without a request, so the helper needs no network (and here has none).
		const expiresAt = Date.now() + 3_600_000;
		await signInFake(uidT, TOKEN_A, expiresAt);
		asked = tokens.asked;
		const resourcesBefore = await listOurs();
		let start = Date.now();
		const first = await tokens.current(uidT);
		const resourcesAfter = await listOurs();
		expect(
			"current() returns the access token of the user's sign-in with its expiry, from a helper container that has no network, mounts no volume and is gone afterwards",
			first.accessToken === TOKEN_A && first.expiresAt === expiresAt && tokens.asked === asked + 1 && resourcesAfter.volumes.join(" ") === resourcesBefore.volumes.join(" ") && resourcesAfter.containers.join(" ") === resourcesBefore.containers.join(" "),
			`a token that expires in ${Math.round((first.expiresAt - Date.now()) / 60_000)} min, ${ms(start)}, one run of \`${loginTokenCommand().join(" ")}\` with --network none`,
		);
		start = Date.now();
		const again = await tokens.current(uidT);
		first.accessToken = "changed by the caller";
		const third = await tokens.current(uidT);
		expect("a fresh answer is reused: Windlass is not asked again, and what a caller does to its copy changes nothing", again.accessToken === TOKEN_A && third.accessToken === TOKEN_A && third.expiresAt === expiresAt && tokens.asked === asked + 1 && Date.now() - start < 100, `two more requests, ${ms(start)}, still one run`);

		// At once: one run serves them all.
		tokens.forget(uidT);
		asked = tokens.asked;
		start = Date.now();
		const many = await Promise.all(Array.from({ length: 6 }, () => tokens.current(uidT)));
		expect("six requests at once for one user are served one at a time: by a single run of Windlass", many.every((token) => token.accessToken === TOKEN_A && token.expiresAt === expiresAt) && tokens.asked === asked + 1, `${tokens.asked - asked} run for 6 requests, ${ms(start)}`);
		// Two users at once are two runs: the queue is per user.
		tokens.forget(uidT);
		await signInFake(uid2, TOKEN_B, expiresAt);
		asked = tokens.asked;
		const [mine, theirs] = await Promise.all([tokens.current(uidT), tokens.current(uid2)]);
		expect("two users' requests do not wait for each other and never get each other's token", mine.accessToken === TOKEN_A && theirs.accessToken === TOKEN_B && tokens.asked - asked === 2, `${tokens.asked - asked} run(s)`);

		// A new sign-in: what was kept of the old one is not handed out again.
		const attempt = `chk${run}t`;
		await layer.logins.adopt(attempt, finishedAttempt(attempt, fakeAccount(uidT), expiresAt + 1, TOKEN_B), uidT);
		const adopted = await tokens.current(uidT);
		expect("after adopt() the new sign-in's token is returned, not the one that was kept", adopted.accessToken === TOKEN_B && adopted.expiresAt === expiresAt + 1);

		// How much time a token must have left is the platform's to say: twenty minutes (`--valid-for 20m`). A token
		// with more is handed out as it is and reused while it has that much: here for 7 s. After that Windlass is
		// asked again and has to refresh, which is a request to OpenAI: this helper cannot make one.
		const VALID_FOR_MIN = TOKEN_VALID_FOR_MS / 60_000;
		const enough = Date.now() + TOKEN_VALID_FOR_MS + 7_000;
		await signInFake(uidT, TOKEN_C, enough);
		asked = tokens.asked;
		const asIs = await tokens.current(uidT);
		const reused = await tokens.current(uidT);
		expect(
			`a token with a little more than ${VALID_FOR_MIN} minutes left is handed out as it is, without a refresh (there is no network to refresh with), and reused`,
			asIs.accessToken === TOKEN_C && asIs.expiresAt === enough && reused.expiresAt === enough && tokens.asked === asked + 1,
			`${((asIs.expiresAt - Date.now()) / 60_000).toFixed(2)} min left, one run for two requests`,
		);
		await wait(enough - TOKEN_VALID_FOR_MS - Date.now() + 500);
		const tooLittle = await tokens.current(uidT).then(
			() => null,
			(error: unknown) => error,
		);
		// What that failure is, the token source reads from Windlass's code for it, `network_error`: it is the one
		// failure of a refresh that says nothing about the sign-in.
		const unreachable = (error: unknown): error is SignInRefreshError => error instanceof SignInRefreshError && !(error instanceof SandboxUserError) && error.code === "network_error";
		expect(
			`once it has less than ${VALID_FOR_MIN} minutes left it is no longer reused: Windlass is asked again and refreshes first, and without a network that fails with Windlass's code \`network_error\`, as an error that is not the user's`,
			unreachable(tooLittle) && /^could not reach the sign-in service at auth\.openai\.com: \S/.test(tooLittle.message) && !SECRET.test(tooLittle.message) && tokens.asked === asked + 2,
			tooLittle instanceof Error ? `${((enough - Date.now()) / 60_000).toFixed(2)} min left: ${tooLittle.name}, code ${(tooLittle as { code?: string }).code}: ${tooLittle.message}` : "it returned a token",
		);
		// Twelve minutes: far from the five in which Windlass refreshes of its own accord, and still too little.
		await signInFake(uidT, TOKEN_C, Date.now() + 12 * 60_000);
		const due = await tokens.current(uidT).then(
			() => null,
			(error: unknown) => error,
		);
		expect(
			`a token with 12 minutes left, more than twice Windlass's own five and less than the ${VALID_FOR_MIN} the platform asks for, is not handed out as it is: Windlass refreshes first`,
			unreachable(due) && !SECRET.test(due.message),
			due instanceof Error ? `${due.name}, code ${(due as { code?: string }).code}: ${due.message}` : "it returned a token",
		);
		expect("the failed refresh left the sign-in as it was", (await layer.logins.status(uidT))?.sub === `fake-sub-${uidT}`);

		await layer.logins.logout(uidT);
		asked = tokens.asked;
		await throwsUserError("after logout() current() says to sign in with ChatGPT", () => tokens.current(uidT), /^You are not signed in with ChatGPT\. Sign in with ChatGPT/);
		expect("for that Windlass is not started: the user's store holds no sign-in to ask it about", tokens.asked === asked && storedSignIn(uidT)?.sealed === null);
	});

	await section("session token isolation", async () => {
		const first = await offlineSandbox(uidH, "docker-hardened", "isolation-first");
		if (!first) throw new Error("Could not isolate the first test container");
		const legacyPath = `${DATA_DIR}/access-token-old-check.json`;
		await first.writeSecretFile(legacyPath, "{}");
		const second = await offlineSandbox(uidH, "docker-windlass-sandbox", "isolation-second");
		if (!second) throw new Error("Could not isolate the second test container");
		expect("connect clears pre-upgrade files before setup can run", (await second.ask(["test", "!", "-e", legacyPath]))?.code === 0);
		const path = tokenFilePath(first.id);
		await first.writeSecretFile(path, JSON.stringify({ accessToken: TOKEN_A, expiresAt: Date.now() + 3_600_000 }));
		const setup = await runSetupCommand(second, { command: `test ! -e ${path}`, cwd: second.cwd, timeoutMs: 5000 });
		expect("a second hosted session's setup cannot see the first session's file", setup.state === "succeeded");
		expect("the token is on tmpfs", (await first.ask(["stat", "-f", "-c", "%T", path]))?.stdout.trim() === "tmpfs");
		await first.removeFiles([path]);

		// Use inert sleepers and check their PIDs. Neither fixture opens a credential file.
		const detached = [
			"rm -f /tmp/check-sleeper",
			"setsid env -i /bin/sh -c 'echo $$ > /tmp/check-sleeper; exec sleep infinity' </dev/null >/dev/null 2>&1 &",
			"while [ ! -s /tmp/check-sleeper ]; do sleep 0.01; done",
		].join("\n");
		const gone = async (box: DockerSandboxHandle) => (await box.run('! kill -0 "$(cat /tmp/check-sleeper)" 2>/dev/null')).exitCode === 0;
		await docker(["exec", "-d", "--user", "65534:65534", second.container, "/bin/sleep", "610"], { check: true });
		const result = await runSetupCommand(second, { command: detached, cwd: second.cwd, timeoutMs: 5000 });
		expect("setup reaps a detached process with an empty environment before returning", result.state === "succeeded" && await gone(second));
		expect("cleanup also removes a stranded Git transport process", (await second.ask(["pgrep", "-u", "65534", "-x", "sleep"]))?.code === 1);
		const brokenSweep = new (class extends DockerSandboxHandle {
			override async ask() { return null; }
		})(first.id, first.profile, first.uid);
		const incomplete = await runSetupCommand(brokenSweep, { command: "true", cwd: first.cwd, timeoutMs: 5000 });
		expect("setup reports an unsuccessful cleanup even when its command succeeded", incomplete.cleanupPending === true && incomplete.state === "failed");
		let requested = false;
		const unavailable = new DockerWindlass({ current: async () => { requested = true; throw new Error("unexpected token request"); } }, { image });
		const refused = await turn(brokenSweep, "Check unavailable cleanup", null, { windlass: unavailable });
		expect("a failed process sweep stops the turn before it requests a token", !requested && refused.result.failure?.reason === "engine" && refused.events.length === 0);
		for (const box of [first, second]) {
			const script = "/tmp/check-profile.json";
			const sandboxed = box.profile === "docker-windlass-sandbox";
			await box.writeTextFile(script, JSON.stringify({ responses: [shell("visibility", `test ${sandboxed ? "!" : ""} -r ${tokenFilePath(box.id)} && echo expected-visibility`), say("Done.")] }));
			await box.run(detached);
			expect("a detached sleeper is alive before turn preparation", !await gone(box));
			let cleanAtHandoff = false;
			const tokens: AccessTokens = { current: async () => {
				cleanAtHandoff = await gone(box);
				return { accessToken: TOKEN_A, expiresAt: Date.now() + 3_600_000 };
			} };
			const windlass = new DockerWindlass(tokens, { image, engineCommand: ["sh", "-ec", `test "$(stat -f -c %T "$WINDLASS_ACCESS_TOKEN_FILE")" = tmpfs; windlass login status >/dev/null; WINDLASS_ACP_SCRIPT=${script} exec windlass acp`] });
			const completed = await turn(box, "Check file visibility", null, { windlass });
			expect(`${box.profile} clears old processes before the token request`, cleanAtHandoff);
			expect(`${box.profile} runs Windlass with the handed-in file and the expected command visibility`, outcomeOf(completed) === "succeeded" && outputOf(settled(completed.events, "visibility")).includes("expected-visibility"), completed.result.failure?.message ?? "");
			await layer.sandboxes.destroy(box.id);
			createdSandboxes.delete(box.id);
		}
	});

	await section("hand-off", async () => {
		// Every turn here is handed a (fake) access token, so every one runs where there is no network.
		await layer.logins.ensureUserVolume(uidH);
		const boxed = await offlineSandbox(uidH, "docker-windlass-sandbox", "check-hand-off-a");
		const direct = await offlineSandbox(uidH, "docker-hardened", "check-hand-off-b");
		if (boxed === null || direct === null) {
			fail("the hand-off checks", "skipped: a sandbox could not be shown to be cut off from the network");
			return;
		}
		const path = tokenFilePath(boxed.id);
		expect("the token file is one per sandbox, on its private tmpfs", path === `/dev/shm/access-token-${boxed.id}.json` && tokenFilePath(direct.id) !== path, path);
		const status = (handle: DockerSandboxHandle) => handle.run("windlass login status", { env: { [ACCESS_TOKEN_FILE_ENV]: tokenFilePath(handle.id) } });

		// ---- A: the real token source and the real engine. The sign-in's token has the twenty minutes the platform
		// asks for, and 10 s more: it is handed to the turn as it is, and 10 s later it has too little.
		{
			const expiresA = Date.now() + TOKEN_VALID_FOR_MS + 10_000;
			const expiresB = Date.now() + 3_600_000;
			await signInFake(uidH, TOKEN_A, expiresA);
			const lines: Array<{ at: number; line: string }> = [];
			// Replaced 2 s after the token has less left than is asked for; a failed replacement is tried again after 3 s.
			const windlass = new DockerWindlass(layer.tokens, { image, tokenFile: { leadMs: TOKEN_VALID_FOR_MS - 2_000, retryMs: 3_000, log: (line) => void (lines.push({ at: Date.now(), line }), console.log(line)) } });
			const has = (word: string) => lines.some((entry) => entry.line.includes(word));
			const askedBefore = layer.tokens.asked;
			const watch = async () => {
				const engine = (await boxed.run(ENGINE_ENV)).stdout.trim().split("\n");
				const facts = (await boxed.run(fileFacts(path))).stdout.trim().split("\n");
				const content = JSON.parse(await boxed.readTextFile(path)) as AccessToken;
				const accepted = await status(boxed);
				const holds = (await boxed.run(DATA_LS)).stdout.trim();
				const mounted = await mountsOf(boxed.container);
				// The first replacement is due now and fails: the token has less left than is asked for, so Windlass has to refresh, and the helper has no network.
				const failed = await until(() => has("token.replace_failed"), 30_000);
				// What a refresh would have saved, written by this check instead: a new token in the user's store.
				saveFakeSignIn(uidH, TOKEN_B, expiresB);
				const replaced = await until(() => has("token.replaced"), 30_000);
				const after = replaced ? (JSON.parse(await boxed.readTextFile(path)) as AccessToken) : null;
				const factsAfter = (await boxed.run(fileFacts(path))).stdout.trim().split("\n");
				const acceptedAfter = await status(boxed);
				const leftovers = (await boxed.run(DATA_LS)).stdout.trim();
				return { engine, facts, content, accepted, holds, mounted, failed, replaced, after, factsAfter, acceptedAfter, leftovers };
			};
			type Seen = Awaited<ReturnType<typeof watch>>;
			let watching: Promise<Seen | null> | null = null;
			let watchError = "";
			const started = Date.now();
			const a = await turn(boxed, "Hello?", null, {
				windlass,
				onEvent: (event) => {
					// Once Windlass is at its first model call, which it cannot reach from here and tries again for half a minute.
					if (event.type === "retry.scheduled" && watching === null)
						watching = watch().catch((error: unknown) => {
							watchError = error instanceof Error ? error.message : String(error);
							return null;
						});
				},
			});
			const seen = await (watching as Promise<Seen | null> | null);
			if (seen === null) {
				fail("an unscripted turn with a signed-in user starts Windlass on a handed-in token", watchError !== "" ? `looking at it failed: ${watchError}` : `the turn ended before its model call was retried: ${a.result.failure?.reason} ${a.result.failure?.message}`);
			} else {
				expect(
					`an unscripted turn starts \`windlass acp\` with ${ACCESS_TOKEN_FILE_ENV} naming its sandbox's token file`,
					seen.engine[0] === "ENGINE" && seen.engine[1] === `${ACCESS_TOKEN_FILE_ENV}=${path}`,
					seen.engine.join(" "),
				);
				expect(
					"the file is the user's access token in the JSON form, readable by its owner only",
					seen.facts[0]?.startsWith("600 agent ") === true && seen.facts[1] === `accessToken,expiresAt ${expiresA}` && seen.content.accessToken === TOKEN_A && seen.content.expiresAt === expiresA,
					`mode, owner, inode: ${seen.facts[0]}; keys and expiry: ${seen.facts[1]}`,
				);
				expect(
					"Windlass accepts it: `windlass login status` with the same variable reports the handed-in sign-in as usable, and prints no token",
					seen.accepted.exitCode === 0 && /^signed in with the access token handed in through WINDLASS_ACCESS_TOKEN_FILE/.test(seen.accepted.stdout) && seen.accepted.stdout.includes(path) && /valid for (19|20) more minutes/.test(seen.accepted.stdout) && !SECRET.test(seen.accepted.stdout),
					seen.accepted.stdout.trim(),
				);
				expect(
					"while the turn runs the container still holds no sign-in and mounts no auth volume: the token and Windlass data are separate",
					seen.mounted === `wlp-user-${uidH}:${DATA_DIR}` && seen.holds.split(" ").includes(`access-token-${boxed.id}.json`) && !/auth\.json|host-id|auth\.lock|\.tmp/.test(seen.holds),
					`mounts: ${seen.mounted}; data directory: ${seen.holds}`,
				);
				const failedLine = lines.find((entry) => entry.line.includes("token.replace_failed"));
				const replacedLine = lines.find((entry) => entry.line.includes("token.replaced"));
				const handedLine = lines.find((entry) => entry.line.includes("token.handed"));
				expect(
					"a replacement that fails is logged with its reason and when it is tried again, without a token",
					seen.failed && failedLine !== undefined && failedLine.line.includes(`sandbox=${boxed.id}`) && failedLine.line.includes(`uid=${uidH}`) && failedLine.line.includes("(could not reach the sign-in service at auth.openai.com: ") && /trying again in 3 s/.test(failedLine.line) && !SECRET.test(failedLine.line),
					failedLine?.line ?? "no such line",
				);
				expect(
					"it came on schedule: 2 s after the token had less left than the platform asks for, with almost twenty minutes still to go",
					handedLine !== undefined && failedLine !== undefined && failedLine.at >= expiresA - TOKEN_VALID_FOR_MS + 2_000 - 200 && failedLine.at < expiresA - TOKEN_VALID_FOR_MS + 2_000 + 4_000 && /lasts 11\d\d s more/.test(failedLine.line),
					failedLine === undefined ? "" : `${failedLine.at - (expiresA - TOKEN_VALID_FOR_MS)} ms after that moment, ${failedLine.at - started} ms into the turn`,
				);
				expect(
					"it is tried again, and once the sign-in has a new token the file is replaced with it, as its owner's only, and Windlass accepts that one",
					seen.replaced && seen.after?.accessToken === TOKEN_B && seen.after.expiresAt === expiresB && seen.factsAfter[0]?.startsWith("600 agent ") === true && seen.factsAfter[0] !== seen.facts[0] && seen.acceptedAfter.exitCode === 0 && /valid for (59|60) more minutes/.test(seen.acceptedAfter.stdout) && !/\.tmp/.test(seen.leftovers),
					`${replacedLine === undefined || failedLine === undefined ? "" : `${replacedLine.at - failedLine.at} ms after the failure; `}before: ${seen.facts[0]}; after: ${seen.factsAfter[0]}; ${seen.acceptedAfter.stdout.trim().split("\n")[2] ?? ""}`,
				);
			}
			expect(
				"the failed replacement did not end the turn: it ran until Windlass gave up on a model it cannot reach from here",
				a.result.failure?.reason === "execution_failed" && /failed \d+ times/.test(a.result.failure.message) && lastStepError(a) === "transport" && outcomeOf(a) === "failed" && endsWithSummary(a) && a.durationMs > 20_000,
				`${a.result.failure?.reason}: ${a.result.failure?.message} (${a.durationMs} ms, ${ofType(a.events, "retry.scheduled").length} retries)`,
			);
			expect("the token source ran Windlass for the turn's start, for the replacement that failed and for the one that worked, and no more often than the schedule says", layer.tokens.asked >= askedBefore + 3 && layer.tokens.asked <= askedBefore + 5, `${layer.tokens.asked - askedBefore} runs`);
			expect("when the turn has ended the token file is gone, and no process is left", !(await boxed.run(DATA_LS)).stdout.includes("access-token") && (await strayProcesses(boxed.container)).length === 0, (await boxed.run(DATA_LS)).stdout.trim());
			expect("no token is in the turn's events, its failure or its standard error", !leaks(a));
		}

		// ---- B: a token that lasts 12 s, replaced 6 s before it runs out. The turn goes on past the first token's expiry.
		{
			let calls = 0;
			let firstExpiry = 0;
			const short: AccessTokens = {
				current: async () => {
					calls += 1;
					if (calls === 1) firstExpiry = Date.now() + 12_000;
					return calls === 1 ? { accessToken: TOKEN_A, expiresAt: firstExpiry } : { accessToken: TOKEN_B, expiresAt: Date.now() + 3_600_000 };
				},
			};
			const lines: Array<{ at: number; line: string }> = [];
			const windlass = new DockerWindlass(short, { image, tokenFile: { leadMs: 6_000, retryMs: 1_000, log: (line) => void (lines.push({ at: Date.now(), line }), console.log(line)) } });
			// Something that reads the file the way Windlass does, all through the replacement.
			let reading: Promise<{ stdout: string }> | null = null;
			const b = await turn(boxed, "Hello again?", null, {
				windlass,
				onEvent: () => {
					reading ??= boxed.run(`python3 -I -c "$READER" ${path} 10`, { env: { READER } }).catch(() => ({ stdout: "" }));
				},
			});
			const reads = JSON.parse((await (reading as Promise<{ stdout: string }> | null))?.stdout.trim() || "{}") as { good?: number; bad?: number; missing?: number; tokens?: number; inodes?: number };
			const handed = lines.find((entry) => entry.line.includes("token.handed"));
			const replaced = lines.filter((entry) => entry.line.includes("token.replaced"));
			expect(
				"a token with a short life is replaced on schedule: once, 6 s before it expires",
				calls === 2 && replaced.length === 1 && !lines.some((entry) => entry.line.includes("replace_failed")) && replaced[0]!.at >= firstExpiry - 6_000 - 200 && replaced[0]!.at < firstExpiry - 6_000 + 2_500,
				replaced.length === 1 && handed !== undefined ? `handed at +0 s, replaced at +${((replaced[0]!.at - handed.at) / 1000).toFixed(1)} s, ${((firstExpiry - replaced[0]!.at) / 1000).toFixed(1)} s before the first token expired` : `${replaced.length} replacements, ${calls} requests`,
			);
			expect(
				"a reader never sees a half-written file: every read through the replacement is a whole token, the old one or the new one, and the new one is another file renamed into place",
				(reads.good ?? 0) > 200 && reads.bad === 0 && reads.missing === 0 && reads.tokens === 2 && reads.inodes === 2,
				JSON.stringify(reads),
			);
			const lastFailedAt = (ofType(b.events, "step.failed").at(-1)?.time as number | undefined) ?? 0;
			expect(
				"Windlass used the new token without a restart: its model calls after the first token's expiry fail for the network, not for the token",
				b.result.failure?.reason === "execution_failed" && lastStepError(b) === "transport" && lastFailedAt > firstExpiry + 5_000 && ofType(b.events, "retry.scheduled").length >= 3,
				`${b.result.failure?.reason}: ${b.result.failure?.message}; its last model call failed ${((lastFailedAt - firstExpiry) / 1000).toFixed(1)} s after the first token had expired`,
			);
			expect("the file is gone again and no token is in the turn's events", !(await boxed.run(DATA_LS)).stdout.includes("access-token") && !leaks(b));
		}

		// ---- B2: the layer's own schedule, nothing changed: when the token has ten minutes left.
		{
			let calls = 0;
			let firstExpiry = 0;
			const real: AccessTokens = {
				current: async () => {
					calls += 1;
					if (calls === 1) firstExpiry = Date.now() + TOKEN_REPLACE_LEAD_MS + 22_000;
					return calls === 1 ? { accessToken: TOKEN_A, expiresAt: firstExpiry } : { accessToken: TOKEN_B, expiresAt: Date.now() + 3_600_000 };
				},
			};
			const lines: Array<{ at: number; line: string }> = [];
			const b2 = await turn(boxed, "Hello, on the usual schedule?", null, { windlass: new DockerWindlass(real, { image, tokenFile: { log: (line) => void (lines.push({ at: Date.now(), line }), console.log(line)) } }) });
			const replaced = lines.filter((entry) => entry.line.includes("token.replaced"));
			expect(
				`with the layer's own schedule a token is replaced when it has ${TOKEN_REPLACE_LEAD_MS / 60_000} minutes left, half of the ${TOKEN_VALID_FOR_MS / 60_000} a token is asked with`,
				TOKEN_REPLACE_LEAD_MS * 2 === TOKEN_VALID_FOR_MS && calls === 2 && replaced.length === 1 && replaced[0]!.at >= firstExpiry - TOKEN_REPLACE_LEAD_MS - 200 && replaced[0]!.at < firstExpiry - TOKEN_REPLACE_LEAD_MS + 2_500 && b2.result.failure?.reason === "execution_failed" && !leaks(b2),
				replaced.length === 1 ? `replaced ${((firstExpiry - replaced[0]!.at) / 1000).toFixed(1)} s before the token's expiry, ${((b2.durationMs - (Date.now() - replaced[0]!.at)) / 1000).toFixed(0)} s into a turn of ${(b2.durationMs / 1000).toFixed(0)} s` : `${replaced.length} replacements, ${calls} requests`,
			);
		}

		// ---- C: the token runs out and cannot be replaced. Windlass finds that out itself; what the user is told depends on why.
		for (const why of ["the sign-in is no longer accepted", "the token could not be had"] as const) {
			let calls = 0;
			let firstExpiry = 0;
			const failing: AccessTokens = {
				current: async () => {
					calls += 1;
					if (calls === 1) return { accessToken: TOKEN_A, expiresAt: (firstExpiry = Date.now() + 8_000) };
					// As the token source throws them: for a refusal of the sign-in service (`invalid_grant`), and for one that cannot be reached (`network_error`).
					throw why === "the sign-in is no longer accepted" ? new SandboxUserError(SIGN_IN_EXPIRED) : new SignInRefreshError("could not reach the sign-in service at auth.openai.com: this check's stand-in", "network_error");
				},
			};
			const lines: string[] = [];
			const windlass = new DockerWindlass(failing, { image, tokenFile: { leadMs: 4_000, retryMs: 1_000, log: (line) => void (lines.push(line), console.log(line)) } });
			const c = await turn(boxed, "Hello once more?", null, { windlass });
			const failures = lines.filter((line) => line.includes("token.replace_failed"));
			const windlassSaid = String(dataOf(ofType(c.events, "execution.failed")[0]).message ?? "");
			const expected = why === "the sign-in is no longer accepted" ? c.result.failure?.reason === "auth_required" && c.result.failure.message === SIGN_IN_EXPIRED : c.result.failure?.reason === "token_unavailable" && /could not replace it: could not reach the sign-in service/.test(c.result.failure.message) && /send the prompt again/.test(c.result.failure.message);
			expect(
				`when ${why}, the replacement is tried again and again while the turn goes on, and the turn ends only when Windlass finds the token expired (its code: \`handed_in_expired\`): ${why === "the sign-in is no longer accepted" ? "`auth_required`, sign in again" : "`token_unavailable`, not the user's doing"}`,
				expected && lastStepCode(c) === "handed_in_expired" && failures.length >= 3 && calls >= failures.length + 1 && Date.now() > firstExpiry && c.durationMs > 7_000 && outcomeOf(c) === "failed" && lastStepError(c) === "auth" && windlassSaid.includes(ACCESS_TOKEN_FILE_ENV) && !c.result.failure!.message.includes(ACCESS_TOKEN_FILE_ENV) && !leaks(c),
				`${c.result.failure?.reason}: ${c.result.failure?.message} (${failures.length} failed replacements in ${c.durationMs} ms; Windlass itself said: ${windlassSaid})`,
			);
			const waits = retryWaits(lines);
			expect(
				why === "the sign-in is no longer accepted" ? "a sign-in that is refused does not come back by asking again: each wait before the next try is twice the one before" : "a sign-in service that cannot be reached may be back at any moment: the next try comes after the same short wait every time",
				why === "the sign-in is no longer accepted" ? waits[0] === 1 && waits[1] === 2 && waits[2] === 4 : waits.length >= 3 && waits.every((seconds) => seconds === 1),
				`trying again in ${waits.join(", ")} s`,
			);
		}
		expect("after those the sandbox holds no token file and no process", !(await boxed.run(DATA_LS)).stdout.includes("access-token") && (await strayProcesses(boxed.container)).length === 0);

		// A stop while the token is still on its way (a refresh can take a while) does not wait for it, and the token
		// that arrives afterwards is not written.
		{
			const slow: AccessTokens = { current: () => new Promise((resolve) => setTimeout(() => resolve({ accessToken: TOKEN_A, expiresAt: Date.now() + 3_600_000 }), 4_000)) };
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 500);
			const stopped = await turn(boxed, "Hello?", null, { windlass: new DockerWindlass(slow, { image }), signal: controller.signal });
			await wait(4_500 - stopped.durationMs);
			expect(
				"a turn stopped while its token is being fetched ends at once as aborted, starts no engine, and the late token is never written",
				stopped.result.aborted && stopped.result.failure === null && stopped.events.length === 0 && stopped.durationMs < 2_500 && !(await boxed.run(DATA_LS)).stdout.includes("access-token") && (await strayProcesses(boxed.container)).length === 0,
				`ended ${stopped.durationMs} ms after it began, 3.5 s before the token arrived`,
			);
		}

		// ---- D: what a command of the agent can do with the file, and a token the provider rejects. The layer hands the
		// token in as for any unscripted turn; the engine's command line adds a scripted model, so that tool calls happen
		// and no model is asked.
		await signInFake(uidH, TOKEN_A, Date.now() + 3_600_000);
		const scriptedOnToken = async (handle: DockerSandboxHandle, prompt: string, script: ScriptedModel, extra: TurnExtra = {}) => {
			const file = `/tmp/.wlp-check-script-${randomId(4)}.json`;
			await handle.writeTextFile(file, JSON.stringify(script));
			const windlass = new DockerWindlass(layer.tokens, { image, engineCommand: ["sh", "-c", `WINDLASS_ACP_SCRIPT=${file} exec windlass acp`] });
			const found = await turn(handle, prompt, null, { windlass, ...extra });
			await handle.removeFiles([file]);
			return found;
		};
		for (const handle of [boxed, direct]) {
			const profile = layer.sandboxes.profile(handle.profile);
			let engine: Promise<{ stdout: string }> | null = null;
			const d = await scriptedOnToken(handle, "Can a command read the token?", { responses: [shell("tok", `${tokenProbe(tokenFilePath(handle.id))}; sleep 1`), shell("show", `cat ${tokenFilePath(handle.id)} 2>/dev/null | tr -d '\\n'; echo; echo SHOWN`), say("Done.")] }, {
				onEvent: (event) => {
					if (event.type === "tool.started") engine ??= handle.run(`${ENGINE_ENV}; ${fileFacts(tokenFilePath(handle.id))}`).catch(() => ({ stdout: "" }));
				},
			});
			const out = outputOf(settled(d.events, "tok"));
			const during = ((await (engine as Promise<{ stdout: string }> | null))?.stdout ?? "").trim().split("\n");
			const sandboxed = (dataOf(started(d.events, "tok")) as { run?: { sandbox?: unknown } }).run?.sandbox != null;
			expect(
				`${profile.name}: a command the agent runs ${profile.commandsCanReadAccessToken ? "can" : "cannot"} read the turn's access token file, as the profile says (${sandboxed ? "sandboxed by Windlass" : "not sandboxed"})`,
				outcomeOf(d) === "succeeded" && during[1] === `${ACCESS_TOKEN_FILE_ENV}=${tokenFilePath(handle.id)}` && during[2]?.startsWith("600 agent ") === true && out.includes(profile.commandsCanReadAccessToken ? "TOKEN_READABLE" : "TOKEN_HIDDEN") && sandboxed === !profile.commandsCanReadAccessToken && !leaks(d),
				`the command printed: ${out.trim().split("\n").join(" | ")}; the engine had ${during[1]}; file ${during[2]}`,
			);
			// A command that prints the file: where it can read it, what it printed reaches the events (and so the
			// session's timeline) only with the token taken out. Here that is the platform's doing: Windlass takes out
			// the tokens it has read at a model call, and this turn's scripted model makes none.
			const shown = outputOf(settled(d.events, "show"));
			expect(
				`${profile.name}: a command that prints the token file ${profile.commandsCanReadAccessToken ? "has the token taken out of its output before it becomes an event" : "prints nothing of it"}`,
				shown.includes("SHOWN") && !SECRET.test(shown) && !leaks(d) && (profile.commandsCanReadAccessToken ? /expiresAt/.test(shown) && shown.includes(TOKEN_REMOVED) : !/expiresAt|accessToken/.test(shown)),
				SECRET.test(shown) ? "the output holds the token" : `the command's output in the events: ${shown.trim().split("\n").join(" | ").slice(0, 160)}`,
			);
		}
		// A token the provider rejects. The real engine and the real provider code, which gets a 401 for the token: from
		// a stand-in for the model's endpoint that runs beside the engine, inside this sandbox, which has no network.
		{
			const home = `/tmp/.wlp-check-provider-${randomId(4)}`;
			await direct.run(`mkdir -m 700 ${home}`);
			await direct.writeTextFile(`${home}/provider.py`, REJECTING_PROVIDER);
			const start = [
				"set -eu",
				`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=api.openai.com -addext subjectAltName=DNS:api.openai.com -keyout ${home}/key.pem -out ${home}/cert.pem 2>/dev/null`,
				`python3 -I ${home}/provider.py ${home} >/dev/null 2>&1 &`,
				`tries=0; while [ ! -s ${home}/ready ] && [ "$tries" -lt 100 ]; do sleep 0.1; tries=$((tries + 1)); done`,
				`HTTPS_PROXY=http://127.0.0.1:$(cat ${home}/ready) NODE_EXTRA_CA_CERTS=${home}/cert.pem exec windlass acp`,
			].join("\n");
			const turnedDown = await turn(direct, "Hello, with a token the provider turns down?", null, { windlass: new DockerWindlass(layer.tokens, { image, engineCommand: ["sh", "-c", start] }) });
			const requests = (await direct.run(`cat ${home}/log 2>/dev/null || true`)).stdout.split("\n").filter((line) => line.trim() !== "");
			await direct.run(`rm -rf ${home}`);
			const said = String(dataOf(ofType(turnedDown.events, "execution.failed")[0]).message ?? "");
			expect(
				"the model request of that turn went to the stand-in inside the sandbox, which answered it with a 401, and nowhere else",
				requests.length >= 1 && requests.every((line) => line.startsWith("CONNECT api.openai.com:443 | ")) && requests.some((line) => / \| POST \//.test(line)),
				[...new Set(requests)].join("; ") || "the stand-in saw no request",
			);
			expect(
				"a handed-in token the provider rejects (Windlass's code: `handed_in_rejected`) ends the turn as `auth_required`, with the sentence that says to sign in with ChatGPT again instead of Windlass's about handing in a token",
				turnedDown.result.failure?.reason === "auth_required" && turnedDown.result.failure.message === TOKEN_REJECTED && /Sign in with ChatGPT again/.test(TOKEN_REJECTED) && lastStepCode(turnedDown) === "handed_in_rejected" && lastStepError(turnedDown) === "auth" && said.includes(ACCESS_TOKEN_FILE_ENV) && outcomeOf(turnedDown) === "failed" && !leaks(turnedDown) && (await strayProcesses(direct.container)).length === 0,
				`${turnedDown.result.failure?.reason}: ${turnedDown.result.failure?.message} (Windlass's code: ${lastStepCode(turnedDown)}; Windlass itself said: ${said})`,
			);
		}
		// Windlass reports an auth failure for a scripted provider without a token-specific error code.
		const rejected = await scriptedOnToken(direct, "Fail.", { responses: [[{ type: "fail", kind: "auth", message: "the scripted provider rejected the token" }]] });
		const rejectedSaid = String(dataOf(ofType(rejected.events, "execution.failed")[0]).message ?? "");
		expect(
			"an auth failure without a token-specific code keeps Windlass's message",
			rejected.result.failure?.reason === "auth_required" && rejected.result.failure.message === rejectedSaid &&
				lastStepCode(rejected) === "none" && lastStepError(rejected) === "auth" && rejectedSaid.includes(ACCESS_TOKEN_FILE_ENV) &&
				outcomeOf(rejected) === "failed" && !leaks(rejected),
			`${rejected.result.failure?.message} (Windlass's code: ${lastStepCode(rejected)}; Windlass itself said: ${rejectedSaid})`,
		);

		// ---- E: the file gives no token in the middle of a turn: it is gone, emptied, holds something else, or cannot
		// be read. Windlass says the same sentence as for any token it cannot use, and a code of its own for each; what
		// the user is told depends on whether there still is a sign-in.
		{
			const spoiled: Array<{ code: string; what: string; how: () => Promise<unknown> }> = [
				{ code: "handed_in_missing", what: "goes missing", how: () => boxed.removeFiles([path]) },
				{ code: "handed_in_empty", what: "is emptied", how: () => boxed.run(`: > ${path}`) },
				{ code: "handed_in_malformed", what: "holds something that is no token", how: () => boxed.run(`echo '{' > ${path}`) },
				{ code: "handed_in_unreadable", what: "can no longer be read", how: () => boxed.run(`chmod 000 ${path}`) },
			];
			for (const kind of spoiled) {
				let spoiling: Promise<unknown> | null = null;
				const e = await turn(boxed, `Hello, with a file that ${kind.what}?`, null, {
					onEvent: (event) => {
						// At the first model call that could not be sent: the next one finds no token in the file.
						if (event.type === "retry.scheduled") spoiling ??= kind.how();
					},
				});
				expect(
					`a token file that ${kind.what} while the sign-in is fine (Windlass's code: \`${kind.code}\`) ends the turn as \`token_unavailable\`: Windlass could not read it, and the user is not told to sign in`,
					spoiling !== null && lastStepCode(e) === kind.code && e.result.failure?.reason === "token_unavailable" && /could not read the access token/.test(e.result.failure.message) && /send the prompt again/.test(e.result.failure.message) && !/sign in/i.test(e.result.failure.message) && lastStepError(e) === "auth" && outcomeOf(e) === "failed" && !leaks(e),
					`${e.result.failure?.reason}: ${e.result.failure?.message} (the code of Windlass's failed model call: ${lastStepCode(e)})`,
				);
			}
			let forgetting: Promise<unknown> | null = null;
			const askedBefore = layer.tokens.asked;
			const f = await turn(boxed, "Hello, while the sign-in is forgotten?", null, {
				onEvent: (event) => {
					if (event.type === "retry.scheduled") forgetting ??= layer.logins.logout(uidH);
				},
			});
			await (forgetting as Promise<unknown> | null);
			expect(
				"logout() while a turn runs takes the turn's token file away (Windlass's code is `handed_in_missing` again), and the turn ends as `auth_required` with the sentence that says to sign in with ChatGPT: the token source is asked and reports no sign-in",
				forgetting !== null && f.result.failure?.reason === "auth_required" && f.result.failure.message === NOT_SIGNED_IN && lastStepCode(f) === "handed_in_missing" && lastStepError(f) === "auth" && outcomeOf(f) === "failed" && layer.tokens.asked === askedBefore && (await layer.logins.status(uidH)) === null && !leaks(f),
				`${f.result.failure?.reason}: ${f.result.failure?.message} (${f.durationMs} ms)`,
			);
			expect("after those the sandbox holds no token file and no process", !(await boxed.run(DATA_LS)).stdout.includes("access-token") && (await strayProcesses(boxed.container)).length === 0);
			await signInFake(uidH, TOKEN_A, Date.now() + 3_600_000);
		}

		// ---- F: the codes decide, not the words. A stand-in for the engine fails its turn with a code and with words
		// that say something else, and each time the platform follows the code. The token source is a stand-in too:
		// it hands the turn a token that lasts an hour, and answers as said when it is asked again at the turn's end.
		{
			const expiredWords = `no usable access token: The access token handed in through ${ACCESS_TOKEN_FILE_ENV} expired at 2026-01-01T00:00:00.000Z (/nowhere). Hand in a new token.`;
			const missingWords = `no usable access token: The file ${ACCESS_TOKEN_FILE_ENV} names does not exist (/nowhere). Hand in a new token.`;
			const providerWords = "HTTP 401: the provider's own words about a token";
			const handInWords = `Signed out: the access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected or cannot be used. Hand in a new token to continue.`;
			const unreachableWords = `The model call failed 5 times: no usable access token: Could not reach the sign-in service at auth.openai.com: a stand-in, though ${ACCESS_TOKEN_FILE_ENV} is named here and the token expired at some time`;
			const auth = { reason: "auth_required", kind: "auth", says: handInWords } as const;
			type Later = "a token" | "no longer accepted" | "unreachable";
			const cases: Array<{ name: string; plan: CodedPlan; later?: Later; reason: string; message: RegExp | string; asksAgain: boolean }> = [
				{
					name: "`handed_in_missing`, on the error alone, with words that say the token expired: the file was not delivered, `token_unavailable`",
					plan: { ...auth, code: "handed_in_missing", stepSays: expiredWords },
					reason: "token_unavailable",
					message: /^Windlass could not read the access token the platform handed it.*send the prompt again/,
					asksAgain: true,
				},
				{
					name: "`handed_in_rejected`, on the failed model call alone, with words that say the file does not exist: the token is no longer good, `auth_required`",
					plan: { ...auth, stepCode: "handed_in_rejected", stepSays: missingWords },
					reason: "auth_required",
					message: TOKEN_REJECTED,
					asksAgain: false,
				},
				{
					name: "`handed_in_expired` with the provider's words, while the token source has a token: the sign-in is fine and the platform was late, `token_unavailable`",
					plan: { ...auth, code: "handed_in_expired", stepCode: "handed_in_expired", stepSays: providerWords },
					later: "a token",
					reason: "token_unavailable",
					message: /ran out before the platform replaced it\. Your ChatGPT sign-in is untouched; send the prompt again/,
					asksAgain: true,
				},
				{
					name: "`handed_in_expired` while the token source says the sign-in is no longer accepted: `auth_required`, sign in again",
					plan: { ...auth, code: "handed_in_expired", stepCode: "handed_in_expired", stepSays: missingWords },
					later: "no longer accepted",
					reason: "auth_required",
					message: SIGN_IN_EXPIRED,
					asksAgain: true,
				},
				{
					name: "`handed_in_expired` while the token source cannot reach the sign-in service: `token_unavailable`, with that reason",
					plan: { ...auth, code: "handed_in_expired", stepCode: "handed_in_expired", stepSays: expiredWords },
					later: "unreachable",
					reason: "token_unavailable",
					message: /ran out and the platform could not replace it: could not reach the sign-in service.*Your ChatGPT sign-in is untouched/,
					asksAgain: true,
				},
				{
					name: "`network_error`, with words that name the variable and an expired token: a connection problem, passed on as Windlass reported it",
					plan: { reason: "execution_failed", kind: "transport", says: unreachableWords, code: "network_error", stepCode: "network_error", stepSays: expiredWords },
					reason: "execution_failed",
					message: unreachableWords,
					asksAgain: false,
				},
				{
					name: "`signed_out`, which is not about a handed-in token, with words that are: left as Windlass's `auth_required`",
					plan: { ...auth, code: "signed_out", stepCode: "signed_out", stepSays: expiredWords },
					reason: "auth_required",
					message: handInWords,
					asksAgain: false,
				},
				{
					name: "a `handed_in_...` code this platform does not know, with words that say the token expired: `token_unavailable`, with a sentence that claims neither a bad sign-in nor a sound one",
					plan: { ...auth, code: "handed_in_by_a_newer_windlass", stepCode: "handed_in_by_a_newer_windlass", stepSays: expiredWords },
					reason: "token_unavailable",
					message: /^Windlass could not use the access token the platform handed it for this turn\. Send the prompt again; if it ends the same way, sign in with ChatGPT again\.$/,
					asksAgain: false,
				},
			];
			const results: boolean[] = [];
			for (const one of cases) {
				let calls = 0;
				const source: AccessTokens = {
					current: async () => {
						calls += 1;
						if (calls > 1 && one.later === "no longer accepted") throw new SandboxUserError(SIGN_IN_EXPIRED);
						if (calls > 1 && one.later === "unreachable") throw new SignInRefreshError("could not reach the sign-in service at auth.openai.com: this check's stand-in", "network_error");
						return { accessToken: TOKEN_A, expiresAt: Date.now() + 3_600_000 };
					},
				};
				const coded = await turn(boxed, "x", null, { windlass: new DockerWindlass(source, { image, engineCommand: ["python3", "-I", "-c", CODED_ENGINE, JSON.stringify(one.plan)], tokenFile: { log: () => undefined } }) });
				const failure = coded.result.failure;
				const told = failure !== null && (typeof one.message === "string" ? failure.message === one.message : one.message.test(failure.message));
				results.push(
					expect(
						`the engine reports ${one.name}`,
						failure?.reason === one.reason && told && calls === (one.asksAgain ? 2 : 1) && outcomeOf(coded) === "failed" && endsWithSummary(coded) && !leaks(coded),
						`${failure?.reason}: ${failure?.message} (the token source was asked ${calls} time${calls === 1 ? "" : "s"})`,
					),
				);
			}
			expect("after those the sandbox holds no token file and no process", results.length === cases.length && !(await boxed.run(DATA_LS)).stdout.includes("access-token") && (await strayProcesses(boxed.container)).length === 0);
		}

		// A scripted (demo) turn is handed nothing.
		{
			const askedBefore = layer.tokens.asked;
			let engine: Promise<{ stdout: string }> | null = null;
			const demo = await turn(direct, "A demo turn.", { responses: [shell("nap", "sleep 2"), say("Done.")] }, {
				onEvent: (event) => {
					if (event.type === "tool.started") engine ??= direct.run(`${ENGINE_ENV}; ${DATA_LS}`).catch(() => ({ stdout: "" }));
				},
			});
			const during = ((await (engine as Promise<{ stdout: string }> | null))?.stdout ?? "").trim().split("\n");
			expect(
				"a scripted turn gets no token and no variable: its engine runs without it, no token file exists, and the token source is not asked",
				outcomeOf(demo) === "succeeded" && during[0] === "ENGINE" && during[1] === "VARIABLE_UNSET" && !(during[2] ?? "").includes("access-token") && layer.tokens.asked === askedBefore,
				during.join(" | "),
			);
		}

		// A token that cannot be had when the turn starts: the turn does not start, and says that it is not the user's doing.
		await signInFake(uidD, TOKEN_C, Date.now() + 12 * 60_000);
		const offline = await offlineSandbox(uidD, "docker-hardened", "check-hand-off-c");
		if (offline !== null) {
			const none = await turn(offline, "Hello?", null);
			expect(
				"when the token source cannot get a token (the saved one has 12 minutes left, too little to hand to a turn, and OpenAI cannot be reached for a refresh: Windlass's `network_error`), the turn fails as `token_unavailable` before Windlass starts, and says that the sign-in service could not be reached",
				none.result.failure?.reason === "token_unavailable" && /could not get an access token of your ChatGPT sign-in for this turn: could not reach the sign-in service at auth\.openai\.com: /.test(none.result.failure.message) && /Your sign-in is untouched; send the prompt again/.test(none.result.failure.message) && none.events.length === 0 && none.result.exitCode === null && !leaks(none) && !(await offline.run(DATA_LS)).stdout.includes("access-token"),
				none.result.failure?.message ?? "",
			);
			await layer.sandboxes.destroy(offline.id);
			createdSandboxes.delete(offline.id);
		}

		// What a turn that was cut off with its server left behind: a token file, and one half-written beside it. They are
		// private to each container. Stopping a container discards its tmpfs.
		const stale = (handle: DockerSandboxHandle) => handle.run(`umask 077; echo '{}' > ${tokenFilePath(handle.id)}; echo '{' > ${tokenFilePath(handle.id)}.tmp`);
		await stale(direct);
		await stale(boxed);
		const before = await lsVolume(`wlp-user-${uidH}`);
		await layer.sandboxes.suspend(direct.id);
		const peerFiles = (await boxed.run(DATA_LS)).stdout;
		expect("suspending one sandbox preserves its peer's private token and leaves the volume token-free",
			!before.includes("access-token") && peerFiles.includes(`access-token-${boxed.id}.json.tmp`) && !peerFiles.includes(`access-token-${direct.id}.json`));

		const asleep = await turn(direct, "Hello?", null);
		expect(
			"an unscripted turn in a sandbox that is not running fails as `engine`, not as anything about the sign-in",
			asleep.result.failure?.reason === "engine" && /could not be started in the sandbox/.test(asleep.result.failure.message) && asleep.events.length === 0 && !leaks(asleep),
			asleep.result.failure?.message.split("\n")[0] ?? "",
		);

		for (const handle of [boxed, direct]) {
			await layer.sandboxes.destroy(handle.id);
			createdSandboxes.delete(handle.id);
		}
		const kept = await lsVolume(`wlp-user-${uidH}`);
		expect("destroy() removes the token file left for its sandbox too: after all of it the user's data volume holds Windlass's sessions and neither a sign-in nor a token file", kept.includes("sessions") && !/auth\.json|host-id|access-token/.test(kept), kept);
	});

	await section("valid-for", async () => {
		// The token source as the server has it, on a throwaway image in which a refresh works without a network:
		// what Windlass sends to OpenAI's token endpoint is answered inside the helper container (see STANDIN).
		const tag = `windlass-platform-sandbox-standin:chk-${run}`;
		const idOf = async (image: string) => (await docker(["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();

		createdImages.add(tag);
		const wrong = buildStandInImage(tag);
		const standin = createSandboxLayer({ image: tag, signIns: "memory", tokenNetwork: "none", signInHelperFlags: standInFlags() });
		const usable = wrong === "" && (await idOf(tag)) !== "" && (await standin.windlass.problem()) === null && (await standin.windlass.version()) === (await layer.windlass.version());
		expect("a throwaway image is built from the server's: the same Windlass, with a stand-in for OpenAI's token endpoint beside it, so a refresh works in a helper that has no network", usable, wrong || `${tag}, Windlass ${await standin.windlass.version()}`);
		if (!usable) return;
		const tokens = standin.tokens;
		const MIN = 60_000;
		const VALID_FOR_MIN = TOKEN_VALID_FOR_MS / MIN;
		const issued = (token: AccessToken, number: number) => token.accessToken === `FAKE-ACCESS-TOKEN-R${number}-not-a-real-token`;
		const REFRESH = "CONNECT auth.openai.com:443 | POST /api/accounts/oauth/token | refresh_token";

		// ---- 1: too little left. Twelve minutes is far from the five in which Windlass refreshes of its own accord.
		await signInFake(uidV, TOKEN_A, Date.now() + 12 * MIN, standin);
		await standInIssues(uidV, 3600);
		let asked = tokens.asked;
		let start = Date.now();
		const refreshed = await tokens.current(uidV);
		const took = Date.now() - start;
		let requests = await standInRequests(uidV);
		expect(
			`a token with 12 minutes left, less than the ${VALID_FOR_MIN} the platform asks for, is not handed out: the sign-in is refreshed first, and the new token is handed out and saved`,
			issued(refreshed, 1) && refreshed.expiresAt - start > 3_600_000 - 1_000 && refreshed.expiresAt - start < 3_600_000 + took && tokens.asked === asked + 1 && requests.length === 1 && (await layer.logins.status(uidV))?.accessExpiresAt === refreshed.expiresAt,
			`one run of \`${loginTokenCommand().join(" ")}\` (${took} ms), one refresh; the token handed out lasts ${Math.round((refreshed.expiresAt - Date.now()) / MIN)} min`,
		);
		expect("that refresh is Windlass's own request for OpenAI's token endpoint, answered by the stand-in inside the helper, which has no network: nothing left this machine", requests[0] === REFRESH, requests.join("; "));

		// ---- 2: enough left. Nothing is refreshed, though here a refresh would be answered.
		tokens.forget(uidV);
		asked = tokens.asked;
		const again = await tokens.current(uidV);
		const plenty = Date.now() + 25 * MIN;
		await signInFake(uidV, TOKEN_B, plenty, standin);
		const asIs = await tokens.current(uidV);
		requests = await standInRequests(uidV);
		expect(
			`a token with more than ${VALID_FOR_MIN} minutes left is handed out as it is, without a refresh: the new one when Windlass is asked again, and a sign-in's own with 25 minutes left`,
			again.accessToken === refreshed.accessToken && again.expiresAt === refreshed.expiresAt && asIs.accessToken === TOKEN_B && asIs.expiresAt === plenty && tokens.asked === asked + 2 && requests.length === 1,
			`two more runs of Windlass, still ${requests.length} refresh`,
		);

		// ---- 3: more is asked than the service issues. The stand-in's tokens last 16 s; Windlass prints such a token
		// all the same, exits 0 and adds one line on standard error.
		await signInFake(uidV, TOKEN_C, Date.now() + 12 * MIN, standin);
		await standInIssues(uidV, 16);
		const saidFrom = wlpLines.length;
		const said = () => wlpLines.slice(saidFrom).filter((line) => line.includes("token.short"));
		asked = tokens.asked;
		start = Date.now();
		const short = await tokens.current(uidV).then(
			(token) => token,
			(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
		);
		if (short instanceof Error) {
			fail("a token that lasts less than was asked for is handed out all the same", `current() threw: ${short.message}`);
		} else {
			const saved = await layer.logins.status(uidV);
			const more = await Promise.all([tokens.current(uidV), tokens.current(uidV), tokens.current(uidV)]);
			requests = await standInRequests(uidV);
			expect(
				`when a refresh gives a token that lasts less than the ${VALID_FOR_MIN} minutes asked for (16 s here), that is no error: the token is handed out with its real expiry`,
				issued(short, 2) && short.expiresAt === saved?.accessExpiresAt && short.expiresAt - start > 15_000 && short.expiresAt - start < 16_000 + 15_000 && requests.length === 2 && requests[1] === REFRESH,
				`it expires ${((short.expiresAt - start) / 1000).toFixed(1)} s after it was asked for, as the saved sign-in says`,
			);
			expect(
				"that more was asked than the service issues is logged once, without a token",
				said().length === 1 && said()[0]!.includes(`uid=${uidV}`) && /more than the sign-in service issues/.test(said()[0]!) && /used as it is/.test(said()[0]!) && !SECRET.test(said()[0]!),
				said().join(" | ") || "no such line",
			);
			expect(
				"and nothing loops: three more requests get the same token, though it has less left than is asked for, without Windlass being run or the sign-in refreshed again",
				more.every((token) => token.accessToken === short.accessToken && token.expiresAt === short.expiresAt) && tokens.asked === asked + 1 && requests.length === 2,
				`${tokens.asked - asked} run, ${requests.length - 1} refresh for four requests`,
			);
			// It is reused until half of what it had left is gone: 8 s. Then the next is fetched, which is short too.
			await wait(short.expiresAt - 6_000 - Date.now());
			const next = await tokens.current(uidV);
			await standInIssues(uidV, 3600);
			await wait(next.expiresAt - 6_000 - Date.now());
			const long = await tokens.current(uidV);
			const longAgain = await tokens.current(uidV);
			requests = await standInRequests(uidV);
			expect(
				"when half of what such a token had left is gone the next one is fetched, once; that it is short too is not logged again; and a token that lasts an hour is reused as usual afterwards",
				issued(next, 3) && next.expiresAt > short.expiresAt && issued(long, 4) && long.expiresAt - Date.now() > 59 * MIN && longAgain.expiresAt === long.expiresAt && tokens.asked === asked + 3 && requests.length === 4 && said().length === 1,
				`${tokens.asked - asked} runs and ${requests.length - 1} refreshes in ${((Date.now() - start) / 1000).toFixed(0)} s, ${said().length} line`,
			);
		}

		// ---- 3b: the sign-in service answers the refresh with an error. What that means is read from the code
		// Windlass passes on in the brackets of its one line, `sign-in failed: <message> (<code>)`.
		{
			await signInFake(uidV, TOKEN_C, Date.now() + 12 * MIN, standin);
			await standInRefuses(uidV, "invalid_grant", 400);
			const before = (await standInRequests(uidV)).length;
			const refusal = await tokens.current(uidV).then(
				() => null,
				(error: unknown) => error,
			);
			expect(
				"a refresh the sign-in service refuses with `invalid_grant` is the user's to mend: the sign-in is no longer accepted, sign in with ChatGPT again",
				refusal instanceof SandboxUserError && refusal.message === SIGN_IN_EXPIRED && (await standInRequests(uidV)).length === before + 1,
				refusal instanceof Error ? `${refusal.name}: ${refusal.message}` : "it returned a token",
			);
			await standInRefuses(uidV, "server_error", 503);
			const unwell = await tokens.current(uidV).then(
				() => null,
				(error: unknown) => error,
			);
			expect(
				"an error of the sign-in service that is no refusal (`server_error`, HTTP 503) is not the user's doing: it is passed on with its code, and nothing says to sign in",
				unwell instanceof SignInRefreshError && !(unwell instanceof SandboxUserError) && unwell.code === "server_error" && /^the sign-in could not be refreshed: .* \(server_error\)$/.test(unwell.message) && !/sign in/i.test(unwell.message) && !SECRET.test(unwell.message) && (await standInRequests(uidV)).length === before + 2,
				unwell instanceof Error ? `${unwell.name}, code ${(unwell as { code?: string }).code}: ${unwell.message}` : "it returned a token",
			);
			expect("neither answer changed the saved sign-in", (await layer.logins.status(uidV))?.sub === `fake-sub-${uidV}`);
		}

		// ---- 4: a turn. The real token source, the real engine, the layer's own token file; only the moment of the
		// replacement is moved, from ten minutes before the token's expiry to two seconds after the token has less
		// than twenty minutes left, so that it comes within the turn. It is nowhere near a five-minute window.
		await layer.logins.ensureUserVolume(uidV);
		const box = await offlineSandbox(uidV, "docker-windlass-sandbox", "check-valid-for");
		if (box === null) {
			fail("the turns of the valid-for checks", "skipped: the sandbox could not be shown to be cut off from the network");
		} else {
			const path = tokenFilePath(box.id);
			{
				const expiresA = Date.now() + TOKEN_VALID_FOR_MS + 10_000;
				await signInFake(uidV, TOKEN_A, expiresA, standin);
				await standInIssues(uidV, 3600);
				const requestsBefore = (await standInRequests(uidV)).length;
				asked = tokens.asked;
				const lines: Array<{ at: number; line: string }> = [];
				const windlass = new DockerWindlass(tokens, { image, tokenFile: { leadMs: TOKEN_VALID_FOR_MS - 2_000, retryMs: 3_000, log: (line) => void (lines.push({ at: Date.now(), line }), console.log(line)) } });
				const look = async () => {
					const replaced = await until(() => lines.some((entry) => entry.line.includes("token.replaced")), 30_000);
					const content = JSON.parse(await box.readTextFile(path)) as AccessToken;
					const accepted = await box.run("windlass login status", { env: { [ACCESS_TOKEN_FILE_ENV]: path } });
					return { replaced, expiresAt: content.expiresAt, issued: /^FAKE-ACCESS-TOKEN-R\d+-not-a-real-token$/.test(content.accessToken), accepted: accepted.exitCode === 0 && /valid for (59|60) more minutes/.test(accepted.stdout) && !SECRET.test(accepted.stdout) };
				};
				let looking: Promise<Awaited<ReturnType<typeof look>> | null> | null = null;
				const v = await turn(box, "Hello?", null, {
					windlass,
					onEvent: (event) => {
						if (event.type === "retry.scheduled") looking ??= look().catch(() => null);
					},
				});
				const seen = await (looking as Promise<Awaited<ReturnType<typeof look>> | null> | null);
				const handed = lines.find((entry) => entry.line.includes("token.handed"));
				const replaced = lines.filter((entry) => entry.line.includes("token.replaced"));
				requests = await standInRequests(uidV);
				expect(
					`a turn is handed the sign-in's own token when it has ${VALID_FOR_MIN} minutes left and a little more: nothing is refreshed for the turn's start`,
					handed !== undefined && /lasts 12\d\d s more/.test(handed.line) && !SECRET.test(handed.line),
					handed?.line.replace(/^.*?: /, "") ?? "no such line",
				);
				const due = expiresA - TOKEN_VALID_FOR_MS + 2_000;
				expect(
					"the file is replaced on schedule, by a refresh, while the token in it still had almost twenty minutes: the replacement does not have to fall in the last five minutes of a token, or in any window",
					replaced.length === 1 && replaced[0]!.at >= due - 200 && replaced[0]!.at < due + 8_000 && expiresA - replaced[0]!.at > 19 * MIN && /lasts 3[56]\d\d s more/.test(replaced[0]!.line) && requests.length === requestsBefore + 1 && requests.at(-1) === REFRESH && !lines.some((entry) => entry.line.includes("replace_failed")),
					replaced.length === 1 ? `replaced ${replaced[0]!.at - due} ms after it was due, ${((expiresA - replaced[0]!.at) / MIN).toFixed(1)} min before the old token's expiry; ${requests.length - requestsBefore} refresh` : `${replaced.length} replacements, ${requests.length - requestsBefore} refreshes`,
				);
				expect(
					"the file then holds the new token, good for an hour, and Windlass in the sandbox accepts it",
					seen !== null && seen.replaced && seen.issued && replaced.length === 1 && Math.abs(seen.expiresAt - (replaced[0]!.at + 3_600_000)) < 10_000 && seen.accepted,
					seen === null ? "the turn ended before it could be looked at" : `expires ${Math.round((seen.expiresAt - replaced[0]!.at) / MIN)} min after the replacement`,
				);
				expect(
					"the token source ran Windlass twice for it, at the turn's start and for the replacement, and the turn went on until Windlass gave up on a model it cannot reach from here",
					tokens.asked === asked + 2 && v.result.failure?.reason === "execution_failed" && lastStepError(v) === "transport" && outcomeOf(v) === "failed" && !leaks(v) && !(await box.run(DATA_LS)).stdout.includes("access-token"),
					`${tokens.asked - asked} runs; ${v.result.failure?.reason}: ${v.result.failure?.message} (${v.durationMs} ms)`,
				);
			}

			// ---- 5: a turn on tokens that last less than is asked for (24 s). The layer's own schedule; only the least
			// time between two replacements is shortened, from 20 s to 1 s, so that it does not hide what the schedule does.
			{
				await signInFake(uidV, TOKEN_C, Date.now() + 12 * MIN, standin);
				await standInIssues(uidV, 24);
				const requestsBefore = (await standInRequests(uidV)).length;
				const saidBefore = wlpLines.length;
				let calls = 0;
				const counting: AccessTokens = {
					current: (user) => {
						calls += 1;
						return tokens.current(user);
					},
				};
				const lines: Array<{ at: number; line: string }> = [];
				const windlass = new DockerWindlass(counting, { image, tokenFile: { retryMs: 1_000, log: (line) => void (lines.push({ at: Date.now(), line }), console.log(line)) } });
				const w = await turn(box, "Hello, on tokens that do not last?", null, { windlass });
				// A request that was on its way when the turn ended has its answer by now.
				await wait(4_000);
				requests = await standInRequests(uidV);
				const written = lines.filter((entry) => entry.line.includes("token.handed") || entry.line.includes("token.replaced"));
				const replaced = written.slice(1);
				// When each token expires, from what its own line says, and how much the one before it had left then.
				const expiry = written.map((entry) => entry.at + Number(/lasts (\d+) s more/.exec(entry.line)?.[1] ?? Number.NaN) * 1000);
				const leftThen = replaced.map((entry, index) => (expiry[index]! - entry.at) / 1000);
				const shortSaid = wlpLines.slice(saidBefore).filter((line) => line.includes("token.short"));
				expect(
					"a turn is handed such a token as it is, and the file is not replaced at once and again and again: each replacement comes when about half of what the token had left is gone",
					written.length >= 3 && written.length <= 5 && written[0]!.line.includes("token.handed") && /lasts 2[0-4] s more/.test(written[0]!.line) && leftThen.every((left) => left > 5 && left < 12.5) && !lines.some((entry) => entry.line.includes("replace_failed")),
					`handed a token that lasts ${/lasts (\d+) s/.exec(written[0]?.line ?? "")?.[1]} s; replaced ${replaced.length} times, when the token in the file had ${leftThen.map((left) => left.toFixed(1)).join(", ")} s left`,
				);
				expect(
					"the token source is asked once for the start and once per replacement, each of them a refresh, and says once that the tokens are shorter than asked",
					calls >= written.length && calls <= written.length + 1 && requests.length - requestsBefore >= written.length && requests.length - requestsBefore <= calls && shortSaid.length === 1 && !SECRET.test(shortSaid.join(" ")),
					`${calls} requests to the token source, ${requests.length - requestsBefore} refreshes, ${shortSaid.length} line \`token.short\` in a turn of ${(w.durationMs / 1000).toFixed(0)} s`,
				);
				expect(
					"the turn never ran out of a token: it ended because Windlass cannot reach a model from here, not for its sign-in",
					w.result.failure?.reason === "execution_failed" && lastStepError(w) === "transport" && !ofType(w.events, "step.failed").some((event) => (dataOf(event).error as { error?: { kind?: string } } | undefined)?.error?.kind === "auth") && !leaks(w) && !(await box.run(DATA_LS)).stdout.includes("access-token"),
					`${w.result.failure?.reason}: ${w.result.failure?.message}`,
				);
			}
			// ---- 6: a turn whose sign-in is refused while it runs. The real token source and the real engine, on a
			// token that lasts 16 s; from the turn's first event on, the stand-in refuses every refresh with
			// `invalid_grant`. The replacements fail as the sign-in's own failure and back off, the token runs out,
			// Windlass says so with its code, and the user is told to sign in again.
			{
				await signInFake(uidV, TOKEN_C, Date.now() + 12 * MIN, standin);
				await standInIssues(uidV, 16);
				const lines: string[] = [];
				const windlass = new DockerWindlass(tokens, { image, tokenFile: { retryMs: 1_000, log: (line) => void (lines.push(line), console.log(line)) } });
				let refusing: Promise<void> | null = null;
				const r = await turn(box, "Hello, on a sign-in that is then refused?", null, {
					windlass,
					onEvent: () => {
						refusing ??= standInRefuses(uidV, "invalid_grant", 400).catch(() => undefined);
					},
				});
				await (refusing as Promise<void> | null);
				const failed = lines.filter((line) => line.includes("token.replace_failed"));
				const waits = retryWaits(lines);
				expect(
					"when the sign-in service refuses to refresh the sign-in (`invalid_grant`) while a turn runs, each failed replacement says that the sign-in is no longer accepted, and the next try waits twice as long as the one before",
					failed.length >= 2 && failed.every((line) => line.includes("no longer accepted") && !SECRET.test(line)) && waits[0] === 1 && waits[1] === 2 && (waits.length < 3 || waits[2] === 4),
					`${failed.length} failed replacements, trying again in ${waits.join(", ")} s`,
				);
				expect(
					"the turn ends when Windlass finds the token expired (its code: `handed_in_expired`), as `auth_required` with the sentence that says to sign in with ChatGPT again",
					r.result.failure?.reason === "auth_required" && r.result.failure.message === SIGN_IN_EXPIRED && lastStepCode(r) === "handed_in_expired" && lastStepError(r) === "auth" && outcomeOf(r) === "failed" && !leaks(r) && !(await box.run(DATA_LS)).stdout.includes("access-token"),
					`${r.result.failure?.reason}: ${r.result.failure?.message} (${r.durationMs} ms)`,
				);
			}
			await layer.sandboxes.destroy(box.id);
			createdSandboxes.delete(box.id);
		}
		const removed = await removeImage(tag);
		if (removed) createdImages.delete(tag);
		expect("the throwaway image is removed again", removed && (await idOf(tag)) === "");
	});

	await section("cleanup", async () => {
		for (const id of createdSandboxes) await layer.sandboxes.destroy(id);
		for (const user of allUids) await docker(["volume", "rm", "-f", `wlp-user-${user}`]);
		await docker(["volume", "rm", "-f", STANDIN_VOLUME]);
		for (const image of createdImages) await removeImage(image);
		const now = await listOurs();
		const mine = [...now.containers, ...now.volumes];
		expect("nothing this run created is left", mine.length === 0, mine.join(", ") || "no containers or volumes of this run");
		const images = await docker(["images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", `label=${LABEL_ARG}`]);
		const extra = images.stdout.split("\n").filter((name) => name.includes(`chk-${run}`));
		expect("no throwaway image of this run is left", extra.length === 0, extra.join(", "));
		// The layer's own lines and everything printed above: fake as this check's tokens are, none may be in there.
		const leaked = output.filter((line) => SECRET.test(line));
		expect("no token is in anything this check printed or the layer logged", leaked.length === 0, `${output.length} lines read, ${wlpLines.length} of them the layer's own${leaked.length === 0 ? "" : `; ${leaked.length} with a token`}`);
	});

	console.log(`\n${failures === 0 ? "ALL PASSED" : "FAILED"}: ${passes} passed, ${failures} failed`);
}

/** Removes an image this run built: only one that carries the label and is not the server's. */
async function removeImage(tag: string): Promise<boolean> {
	if (tag === IMAGE || !tag.includes(`chk-${run}`)) return false;
	const label = await docker(["image", "inspect", "--format", `{{index .Config.Labels "${LABEL}"}}`, tag]);
	if (label.code !== 0) return true;
	if (label.stdout.trim() !== "1") return false;
	return (await docker(["rmi", tag])).code === 0;
}

async function emergencyCleanup(): Promise<void> {
	for (const id of createdSandboxes) await docker(["rm", "-f", `wlp-session-${id}`]).catch(() => undefined);
	const tmp = await docker(["ps", "-aq", "--filter", `label=${LABEL_ARG}`, "--filter", `name=^wlp-tmp-${PROCESS_MARK}-`]);
	if (tmp.stdout.trim() !== "") await docker(["rm", "-f", ...tmp.stdout.trim().split("\n")]);
	for (const user of allUids) await docker(["volume", "rm", "-f", `wlp-user-${user}`]).catch(() => undefined);
	await docker(["volume", "rm", "-f", STANDIN_VOLUME]).catch(() => undefined);
	for (const image of createdImages) await removeImage(image).catch(() => undefined);
}

/**
 * `--orphan-turn <sandbox> <session>`: this script as the server that is killed in the middle of a turn.
 * It runs a turn with a long command and says when the command runs; its parent kills it then.
 */
async function orphanTurn(sandboxId: string, windlassSessionId: string): Promise<void> {
	const handle = (await layer.sandboxes.connect(sandboxId)) as DockerSandboxHandle;
	await layer.windlass.runTurn(handle, {
		prompt: "Run the long command.",
		script: longScript,
		windlassSessionId: windlassSessionId === "" ? undefined : windlassSessionId,
		onEvent: (event) => {
			if (event.type === "tool.started") console.log("ORPHAN-COMMAND-RUNNING");
		},
	});
}

const orphan = process.argv.indexOf("--orphan-turn");
if (orphan >= 0) {
	useImage(IMAGE).then(() => orphanTurn(process.argv[orphan + 1] ?? "", process.argv[orphan + 2] ?? ""))
		.catch((error) => console.error(error))
		.finally(() => process.exit(0));
} else {
	main()
		.catch(async (error) => {
			failures += 1;
			console.log(`FAIL  check crashed: ${error instanceof Error ? error.stack : String(error)}`);
		})
		.finally(async () => {
			await emergencyCleanup();
			process.exit(failures === 0 ? 0 : 1);
		});
}
