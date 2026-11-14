/**
 * End-to-end check of the sandbox layer on this machine. Run with:
 *
 *   cd server && npx tsx ../scripts/sandbox-check.ts
 *
 * No real model is called and no real sign-in is completed. Every turn is scripted with
 * WINDLASS_ACP_SCRIPT, but one: the turn that must fail for want of a sign-in runs in a sandbox with an
 * empty data volume and no network at all, so it could reach no model even if Windlass tried. `finish`
 * is tried only with addresses Windlass rejects before any network request, and `status`/`adopt` use a
 * synthetic auth.json with obviously fake tokens. Everything created here is removed at the end, and
 * nothing this run did not create is touched.
 *
 *   WLP_CHECK_SECTIONS=image,failures   run only the sections whose names start with one of these
 *   WLP_CHECK_CLEANUP_SH=0              do not run sandbox/cleanup.sh (it removes every windlass-platform
 *                                       resource on the machine, also those of a server running beside this check)
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProfileId, WindlassEvent } from "../server/src/contract.js";
import { type RunTurnResult, type ScriptedModel, SandboxUserError, type TurnAnswer, type TurnControl, type TurnQuestion, type Windlass } from "../server/src/sandbox/api.js";
import { AcpConnection, AcpError, LineSplitter } from "../server/src/sandbox/acp.js";
import { DEMO_SCENARIOS, DEMO_SPARE_ANSWERS } from "../server/src/sandbox/demo.js";
import { DATA_DIR, LABEL_ARG, PROCESS_MARK, docker, helperFlags, randomId, runHelper, tmpName } from "../server/src/sandbox/docker.js";
import { createSandboxLayer } from "../server/src/sandbox/index.js";
import type { DockerSandboxHandle } from "../server/src/sandbox/sandboxes.js";
import { DockerWindlass } from "../server/src/sandbox/windlass.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const layer = createSandboxLayer();
const run = randomId(3);
const uid = `chk-${run}`;
const uid2 = `chk-${run}-b`;
/** A user with no sign-in at all, for the turn that must fail for want of one. */
const uid3 = `chk-${run}-n`;
const only = (process.env.WLP_CHECK_SECTIONS ?? "")
	.split(",")
	.map((name) => name.trim())
	.filter((name) => name !== "");
const createdSandboxes = new Set<string>();
/** Every sandbox this run created, removed or not. */
const everySandbox = new Set<string>();
const createdAttempts = new Set<string>();
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
	const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
	return { containers: lines(c.stdout), volumes: lines(v.stdout) };
}

async function listOthers(): Promise<string> {
	const c = await docker(["ps", "-a", "--format", "{{.Names}} {{.Status}}"]);
	const v = await docker(["volume", "ls", "--format", "{{.Name}}"]);
	const keep = (text: string) =>
		text
			.split("\n")
			.filter((line) => line.trim() !== "" && !line.startsWith("wlp-"))
			.map((line) => line.split(" ")[0])
			.sort()
			.join(",");
	return `${keep(c.stdout)} | ${keep(v.stdout)}`;
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
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const NET_PROBE = "if timeout 4 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>/dev/null; then echo NET_OK; else echo NET_BLOCKED; fi";

const PROBE_COMMAND = [
	"id -un",
	"echo probe-1 > probe.txt",
	`if ls ${DATA_DIR} >/dev/null 2>&1; then echo DATA_DIR_READABLE; else echo DATA_DIR_HIDDEN; fi`,
	`if cat ${DATA_DIR}/auth.json >/dev/null 2>&1; then echo LOGIN_READABLE; else echo LOGIN_HIDDEN; fi`,
	NET_PROBE,
].join("; ");

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
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"protocolVersion": 1, "agentCapabilities": {"_meta": {"windlass": {"notifications": ["_windlass/event"]}}}}})
    elif message.get("method") == "session/new":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"sessionId": "ses_deaf"}})
    elif message.get("method") == "session/prompt":
        send({"jsonrpc": "2.0", "method": "_windlass/event", "params": {"sessionId": "ses_deaf", "event": {"type": "execution.started", "sessionId": "ses_deaf", "seq": 1, "time": 0, "v": 1, "data": {"executionId": "exe_deaf"}}}})
while True:
    time.sleep(1)
`;

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

/** Writes a synthetic, obviously fake auth.json into a volume. */
async function writeFakeAuth(volume: string, account: { sub: string; email: string }, expiresAt: number): Promise<void> {
	const credentials = {
		hostId: "urn:uuid:00000000-0000-4000-8000-00000000c0de",
		clientId: "FAKE-client-id-for-sandbox-check",
		account,
		accessToken: "FAKE-ACCESS-TOKEN-not-a-real-token",
		refreshToken: "FAKE-REFRESH-TOKEN-not-a-real-token",
		idToken: "FAKE.ID.TOKEN",
		scopes: ["openid", "chatgpt.tokens.use.direct"],
		expiresAt,
	};
	const helper = tmpName();
	const result = await runHelper(
		[...helperFlags(helper, "none"), "-v", `${volume}:${DATA_DIR}`],
		helper,
		["sh", "-c", `cat > ${DATA_DIR}/auth.json && chmod 600 ${DATA_DIR}/auth.json && printf '%s' "$1" > ${DATA_DIR}/host-id`, "sh", credentials.hostId],
		{ stdin: JSON.stringify(credentials, null, 2) },
	);
	if (result.code !== 0) throw new Error(`could not write the fake auth.json: ${result.stderr}`);
}

async function lsVolume(volume: string): Promise<string> {
	const helper = tmpName();
	const result = await runHelper([...helperFlags(helper, "none"), "-v", `${volume}:${DATA_DIR}:ro`], helper, ["ls", "-A", DATA_DIR]);
	return result.stdout.trim().split("\n").join(" ");
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log(`sandbox-check run ${run} on ${process.arch}`);
	const before = await listOurs();
	const othersBefore = await listOthers();
	if (before.containers.length + before.volumes.length > 0) info(`windlass-platform resources that existed before this run (left alone): ${[...before.containers, ...before.volumes].join(", ")}`);

	await section("image", async () => {
		const start = Date.now();
		const out = execFileSync(join(root, "sandbox/build.sh"), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		const printed = out.split("\n").pop() ?? "";
		expect("build.sh builds the image and prints the Windlass version", /^\d+\.\d+\.\d+/.test(printed), `${printed}, ${ms(start)}`);
		const version = await layer.windlass.version();
		expect("windlass.version() reports the same version", version === printed, String(version));
		const models = await layer.windlass.models();
		expect("windlass.models() lists models, the default first", models[0] === "gpt-6.1-sol", models.join(", "));
		const size = await docker(["image", "inspect", "--format", "{{.Size}}", "windlass-platform-sandbox:latest"]);
		info(`image size ${(Number(size.stdout.trim()) / 1e6).toFixed(0)} MB`);
	});

	await section("profiles", async () => {
		const profiles = layer.sandboxes.profiles();
		expect("six profiles, two available", profiles.length === 6 && profiles.filter((p) => p.available).map((p) => p.id).join(",") === "docker-windlass-sandbox,docker-hardened");
		expect("every unavailable profile says why", profiles.every((p) => p.available || (p.unavailableReason ?? "").length > 20));
		await throwsUserError("create() refuses an unavailable profile", () => layer.sandboxes.create({ uid, sessionId: "s", profile: "e2b" }));
		await throwsAny("create() refuses an invalid uid", () => layer.sandboxes.create({ uid: "../etc", sessionId: "s", profile: "docker-hardened" }));
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

	for (const profileId of ["docker-windlass-sandbox", "docker-hardened"] as SandboxProfileId[]) {
		await section(`profile ${profileId}`, async () => {
			const profile = layer.sandboxes.profile(profileId);
			// A synthetic sign-in in the user's volume, to see whether commands can read it.
			await layer.logins.ensureUserVolume(uid);
			await writeFakeAuth(`wlp-user-${uid}`, { sub: "fake-sub-check", email: "check@example.invalid" }, Date.now() + 3600_000);

			let start = Date.now();
			const id = await layer.sandboxes.create({ uid, sessionId: `check-${profileId}`, profile: profileId });
			createdSandboxes.add(id);
			everySandbox.add(id);
			expect("create() starts a sandbox", (await layer.sandboxes.state(id)) === "running", `id ${id}, ${ms(start)}`);
			const handle = (await layer.sandboxes.connect(id)) as DockerSandboxHandle;
			expect("connect() returns a handle with the profile", handle !== undefined && handle.profile === profileId && handle.cwd === "/workspace");
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
			expect(
				`commands ${profile.commandsCanReadLogin ? "can" : "cannot"} read the data directory and the sign-in`,
				profile.commandsCanReadLogin ? out1.includes("DATA_DIR_READABLE") && out1.includes("LOGIN_READABLE") : out1.includes("DATA_DIR_HIDDEN") && out1.includes("LOGIN_HIDDEN"),
			);
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
				const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--orphan-turn", id, session ?? ""], { stdio: ["ignore", "pipe", "inherit"] });
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
			expect("the user's data volume outlives the sandbox and holds Windlass's sessions", kept.includes("sessions") && kept.includes("auth.json"), kept);
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
		const standIn = (command: string, startTimeoutMs?: number) => new DockerWindlass({ engineCommand: ["sh", "-c", command], startTimeoutMs });
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
			const deaf = new DockerWindlass({ engineCommand: ["python3", "-c", DEAF_ENGINE] });
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

		// The one unscripted turn: no sign-in, so opening the session fails. No prompt is sent, so no model is asked;
		// and had Windlass tried, this sandbox has no network to try with.
		if (!isolated) {
			info("SKIP  the turn without a sign-in: the sandbox is not provably cut off from the network and without a sign-in");
		} else {
			const noSignIn = await turn(handle, "Hello?", null);
			expect(
				"an unscripted turn without a sign-in fails as `auth_required` when the session is opened: no event, no prompt, no model request",
				noSignIn.result.failure?.reason === "auth_required" && /sign/i.test(noSignIn.result.failure.message) && noSignIn.events.length === 0 && noSignIn.result.summary === null && noSignIn.result.windlassSessionId === null && noSignIn.result.exitCode === 0 && noSignIn.durationMs < 5000,
				`${noSignIn.result.failure?.message} (${noSignIn.durationMs} ms)`,
			);
		}
		await layer.sandboxes.destroy(id);
		createdSandboxes.delete(id);
	});

	await section("sign-in", async () => {
		const attempt = `chk${run}a`;
		createdAttempts.add(attempt);
		await throwsAny("start() refuses an invalid attempt id", () => layer.logins.start("../../x"));
		await throwsAny("status() refuses an invalid uid", () => layer.logins.status("a b"));
		const started1 = await layer.logins.start(attempt);
		const url = new URL(started1.url);
		expect(
			"start() returns OpenAI's address and the loopback redirect",
			url.origin === "https://auth.openai.com" && started1.redirectPrefix === "http://127.0.0.1:1455/auth/callback" && url.searchParams.get("redirect_uri") === started1.redirectPrefix,
			`${url.origin}${url.pathname}, redirect ${started1.redirectPrefix}`,
		);
		expect("the attempt volume holds the pending sign-in", (await lsVolume(`wlp-login-${attempt}`)) === "auth-pending.json host-id");
		const state = url.searchParams.get("state") ?? "";
		const callback = started1.redirectPrefix;
		// Each of these is rejected by Windlass before any network request (packages/core/src/auth/chatgpt.ts finishLogin).
		await throwsUserError("finish() rejects a malformed address (checked here)", () => layer.logins.finish(attempt, "not an address"), /not the address/);
		await throwsUserError("finish() rejects another site's address (checked here)", () => layer.logins.finish(attempt, `https://example.com/auth/callback?code=x&state=${state}`), /not the address/);
		await throwsUserError("finish() rejects a wrong state (Windlass: state_mismatch)", () => layer.logins.finish(attempt, `${callback}?code=fake-code&state=wrong-state`), /different sign-in attempt/);
		await throwsUserError("finish() reports a refusal in the browser (Windlass: access_denied)", () => layer.logins.finish(attempt, `${callback}?error=access_denied&state=${state}`), /not approved/);
		await throwsUserError("finish() rejects an address without an issued client (Windlass: registration_incomplete)", () => layer.logins.finish(attempt, `${callback}?code=fake-code&state=${state}`), /registering/);
		await throwsUserError("finish() rejects an unknown attempt", () => layer.logins.finish(`chk${run}none`, `${callback}?code=fake-code&state=${state}`), /unknown or has expired/);
		expect("the attempt is still pending after the rejections", (await lsVolume(`wlp-login-${attempt}`)) === "auth-pending.json host-id");
		await throwsUserError("adopt() refuses an attempt that is not finished", () => layer.logins.adopt(attempt, uid2), /not finished/);

		expect("status() is null for a user without a volume", (await layer.logins.status(`chk-${run}-nobody`)) === null);
		await layer.logins.ensureUserVolume(uid2);
		await layer.logins.ensureUserVolume(uid2);
		expect("ensureUserVolume() creates an empty data volume (idempotent); status() is null", (await layer.logins.status(uid2)) === null && (await lsVolume(`wlp-user-${uid2}`)) === "");

		// A finished attempt, simulated: the synthetic auth.json Windlass would have saved.
		const expiresAt = Date.now() + 3_600_000;
		await writeFakeAuth(`wlp-login-${attempt}`, { sub: "fake-sub-123", email: "fake.user@example.invalid" }, expiresAt);
		await layer.logins.adopt(attempt, uid2);
		createdAttempts.delete(attempt);
		const gone = await docker(["volume", "inspect", `wlp-login-${attempt}`]);
		const account = await layer.logins.status(uid2);
		expect("adopt() moves the sign-in into the user's volume and removes the attempt", gone.code !== 0 && (await lsVolume(`wlp-user-${uid2}`)).split(" ").sort().join(" ") === "auth.json host-id");
		expect("status() reports sub, email and expiry only", JSON.stringify(account) === JSON.stringify({ sub: "fake-sub-123", email: "fake.user@example.invalid", accessExpiresAt: expiresAt }) && !JSON.stringify(account).includes("FAKE-"), JSON.stringify(account));

		// A second sign-in replaces the first.
		const attempt2 = `chk${run}b`;
		createdAttempts.add(attempt2);
		await layer.logins.start(attempt2);
		await writeFakeAuth(`wlp-login-${attempt2}`, { sub: "fake-sub-456", email: "other@example.invalid" }, expiresAt + 1);
		await layer.logins.adopt(attempt2, uid2);
		createdAttempts.delete(attempt2);
		expect("adopt() replaces an earlier sign-in", (await layer.logins.status(uid2))?.sub === "fake-sub-456");

		await layer.logins.logout(uid2);
		expect("logout() forgets the sign-in", (await layer.logins.status(uid2)) === null && !(await lsVolume(`wlp-user-${uid2}`)).includes("auth.json"));

		const attempt3 = `chk${run}c`;
		createdAttempts.add(attempt3);
		await layer.logins.start(attempt3);
		await layer.logins.start(attempt3);
		await layer.logins.discard(attempt3);
		await layer.logins.discard(attempt3);
		createdAttempts.delete(attempt3);
		expect("start() again restarts an attempt; discard() removes it and is a no-op when gone", (await docker(["volume", "inspect", `wlp-login-${attempt3}`])).code !== 0);
	});

	await section("cleanup", async () => {
		for (const id of createdSandboxes) await layer.sandboxes.destroy(id);
		for (const attempt of createdAttempts) await layer.logins.discard(attempt);
		for (const volume of [`wlp-user-${uid}`, `wlp-user-${uid2}`, `wlp-user-${uid3}`]) await docker(["volume", "rm", "-f", volume]);
		const now = await listOurs();
		// What this run made: its sandboxes, the volumes named after it, and the helper containers of this process.
		const mine = [...now.containers, ...now.volumes].filter((name) => name.includes(run) || name.startsWith(`wlp-tmp-${PROCESS_MARK}-`) || [...everySandbox].some((id) => name === `wlp-session-${id}`));
		expect("nothing this run created is left", mine.length === 0, mine.join(", ") || "no containers or volumes of this run");

		// cleanup.sh: removes labelled wlp- resources and nothing else. It is only run when nothing of
		// windlass-platform existed before (another process may be using its resources), and not at all when
		// WLP_CHECK_CLEANUP_SH=0 says that something else is working with windlass-platform on this machine.
		const others = await listOurs();
		if (process.env.WLP_CHECK_CLEANUP_SH === "0") {
			info("SKIP  running cleanup.sh: WLP_CHECK_CLEANUP_SH=0");
		} else if (only.length > 0) {
			info("SKIP  running cleanup.sh: only some sections were run");
		} else if (others.containers.length + others.volumes.length > 0 || before.containers.length + before.volumes.length > 0) {
			info(`SKIP  running cleanup.sh: other windlass-platform resources exist (${[...others.containers, ...others.volumes].join(", ")})`);
		} else {
			const decoyVolume = `wlp-decoy-${run}`; // a wlp- name without the label: must survive
			const labelledVolume = `wlp-user-chk-${run}-c`;
			await docker(["volume", "create", decoyVolume], { check: true });
			await docker(["volume", "create", "--label", LABEL_ARG, labelledVolume], { check: true });
			await docker(["run", "-d", "--name", `wlp-session-${randomId(6)}`, "--label", LABEL_ARG, "windlass-platform-sandbox:latest"], { check: true });
			const out = execFileSync(join(root, "sandbox/cleanup.sh"), ["--keep-image"], { encoding: "utf8" });
			info(out.trim().split("\n").join(" | "));
			const after = await listOurs();
			const decoy = await docker(["volume", "inspect", decoyVolume]);
			expect("cleanup.sh removes every labelled container and volume", after.containers.length === 0 && after.volumes.length === 0);
			expect("cleanup.sh leaves a wlp- volume without the label alone", decoy.code === 0);
			await docker(["volume", "rm", decoyVolume]);
		}
		expect("containers and volumes of other projects are untouched", (await listOthers()) === othersBefore);
		const image = await docker(["image", "inspect", "windlass-platform-sandbox:latest"]);
		expect("the image stays for the server", image.code === 0);
	});

	console.log(`\n${failures === 0 ? "ALL PASSED" : "FAILED"}: ${passes} passed, ${failures} failed`);
}

async function emergencyCleanup(): Promise<void> {
	for (const id of createdSandboxes) await docker(["rm", "-f", `wlp-session-${id}`]).catch(() => undefined);
	for (const attempt of createdAttempts) await docker(["volume", "rm", "-f", `wlp-login-${attempt}`]).catch(() => undefined);
	const tmp = await docker(["ps", "-aq", "--filter", `label=${LABEL_ARG}`, "--filter", `name=^wlp-tmp-${PROCESS_MARK}-`]);
	if (tmp.stdout.trim() !== "") await docker(["rm", "-f", ...tmp.stdout.trim().split("\n")]);
	await docker(["volume", "rm", "-f", `wlp-user-${uid}`, `wlp-user-${uid2}`, `wlp-user-${uid3}`]).catch(() => undefined);
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
	orphanTurn(process.argv[orphan + 1] ?? "", process.argv[orphan + 2] ?? "")
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
