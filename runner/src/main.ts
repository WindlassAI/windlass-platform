import { createInterface } from "node:readline/promises";
import { setTimeout as wait } from "node:timers/promises";
import { parseArgs } from "node:util";
import { boolean, count, is, nullable, object, optional, text } from "../../server/src/runner/check.js";
import { REFUSED_RETRY_MS } from "../../server/src/runner/control.js";
import { PROTOCOL_VERSION } from "../../server/src/runner/protocol.js";
import type { Socket } from "node:net";
import { audit, showLog } from "./audit.js";
import { category, control, pair } from "./control.js";
import { cleanClaudeOutput } from "./claude-output.js";
import { changeClaudeLogin, claudeSignIn } from "./harness-login.js";
import { harnessImage, shotsImage } from "./policy.js";
import { Executor } from "./docker-executor.js";
import { requestPair, requestLoginReport, waitForPair } from "./pair-command.js";
import { forgetKey, save, loadPair, tryLock, origin, read, RunnerError, serviceRunning, VERSION } from "./state.js";

const positiveInteger = is<number>(v => count(v) && v > 0);
const snapshot = object({ machineId: nullable(text(64)), connection: text(2048), idleSuspendMs: nullable(count), runnerVersion: text(64), protocol: count,
	claude: optional(boolean), maxRunning: optional(positiveInteger), maxSandboxes: optional(positiveInteger) });
function limit(flag: string, value: string | undefined) {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!/^\d+$/.test(value) || !positiveInteger(n)) throw new RunnerError(`Give --${flag} a positive whole number.`);
	return n;
}
async function main() {
	// An owner piping a token can already have it exported under a shell-specific name.
	// Keep it out of every child, including Docker clients and the login helper.
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "CLAUDE_CODE_OAUTH_TOKEN" || (value && cleanClaudeOutput(value) !== value)) delete process.env[key];
	}
	const { positionals, values } = parseArgs({ allowPositionals: true, options: {
		platform: { type: "string" }, harness: { type: "string", multiple: true }, screenshots: { type: "boolean", default: false }, "max-sandboxes": { type: "string" }, "max-running": { type: "string" },
	} });
	const command = positionals[0] ?? "run";
	const auth = command === "login" || command === "logout";
	const claude = !!values.harness?.length;
	const validCommand = auth ? positionals.length === 2 && positionals[1] === "claude"
		: positionals.length <= 1 && ["run", "pair", "status", "log", "prune"].includes(command);
	if (!validCommand)
		throw new RunnerError("Use windlass-runner [run|pair|status|log|prune|login claude|logout claude] [--platform URL] [--max-sandboxes N] [--max-running N] [--screenshots] [--harness claude].");
	if (values.harness?.some(id => id !== "claude" || !harnessImage("claude")))
		throw new RunnerError("Use --harness claude with a runner built with the pinned Claude Code image.");
	if (values.screenshots && !shotsImage) throw new RunnerError("--screenshots requires a runner built with a pinned screenshots sandbox image.");
	const limits = { maxSandboxes: limit("max-sandboxes", values["max-sandboxes"]), maxRunning: limit("max-running", values["max-running"]) };
	if (command === "log") return showLog();
	const abort = new AbortController();
	const stop = () => abort.abort();
	process.on("SIGINT", stop); process.on("SIGTERM", stop);
	try {
		if (auth) {
			const paired = loadPair();
			if (!paired || (command === "login" && !paired.key)) throw new RunnerError("Pair this machine before signing in to Claude Code.");
			const machine = new Executor(paired.current, limits);
			await changeClaudeLogin(machine, command === "login", abort.signal);
			await requestLoginReport();
			console.log(command === "login" ? "Claude Code: signed in." : "Claude Code: signed out.");
			return;
		}
		if (command !== "status" && !tryLock()) {
			if (command === "pair") return requestPair(values.platform);
			if (command === "prune") throw new RunnerError("The runner service or another command is using this state volume. Stop the runner container or finish the command, then run prune in a one-off runner container with the same state volume and Docker socket.");
			// Docker's restart policy would immediately relaunch a service that exits here.
			console.error("Another runner holds the state lock. Waiting to retry.");
			do {
				await wait(REFUSED_RETRY_MS, undefined, { signal: abort.signal }).catch(() => {});
				if (abort.signal.aborted) return;
			} while (!tryLock());
		}
		let paired = loadPair();
		const stored = read("status.json");
		if (stored !== undefined && !snapshot(stored)) throw new RunnerError("Invalid status.json. Repair or restore that file in the runner state volume.");
		const status = snapshot(stored) && stored.machineId === (paired?.current.machineId ?? null) ? stored : undefined;
		if (command === "status") {
			console.log(`Runner ${VERSION}, protocol ${PROTOCOL_VERSION}. ${paired && !serviceRunning() ? "Stopped" : status?.connection ?? (paired ? "Paired" : "Unpaired")}`);
			const caps = status ?? limits;
			console.log(`Running sandbox limit: ${caps.maxRunning ?? "no limit"}`);
			console.log(`Kept sandbox limit: ${caps.maxSandboxes ?? "no limit"}`);
			if (paired) for (const machine of [paired.current, ...paired.previous]) {
				console.log(`${machine.machineId}${machine === paired.current ? "" : " (previous pairing)"}`);
				const executor = new Executor(machine, limits);
				if (status?.claude || claude || harnessImage("claude")) {
					const signIn = await claudeSignIn(executor);
					console.log(`  Claude Code${status?.claude && machine === paired.current ? " (offered)" : ""}: ${signIn === "token" ? "signed in" : signIn === "none" ? "not signed in" : "unknown"}`);
				}
				try {
					await executor.discover();
					for (const [id, b] of executor.boxes) console.log(`  ${id}  ${b.sessionId}  ${b.state}`);
					if (await executor.ownedVolume(false)) console.log("  Data volume " + executor.volume);
				} catch (error) { console.log(error instanceof RunnerError ? error.message : "Docker is not reachable. Check the daemon and the socket permissions."); }
			}
			return;
		}
		if (command === "prune") {
			if (!paired) { console.log("No paired machines."); return; }
			const prompt = createInterface({ input: process.stdin, output: process.stdout });
			let answer: string;
			try { answer = await prompt.question("Remove all containers and data volumes of these runner pairings? Type yes: ", { signal: abort.signal }); }
			finally { prompt.close(); }
			if (answer !== "yes") return;
			for (const machine of [paired.current, ...paired.previous]) await new Executor(machine, limits).prune();
			console.log("Pruned runner containers and volumes.");
			return;
		}
		let platform = origin(values.platform ?? paired?.platform ?? "");
		let needsPair = command === "pair" || !paired?.key;
		let client: Socket | undefined;
		let resumePlatform: string | undefined;
		function saveStatus(connection: string, idleSuspendMs?: number) {
			save("status.json", { machineId: paired?.current.machineId ?? null, connection, idleSuspendMs: idleSuspendMs ?? null,
				runnerVersion: VERSION, protocol: PROTOCOL_VERSION, ...(claude ? { claude } : {}), ...limits });
		}
		if (command === "run") saveStatus(needsPair ? "Pairing" : "Connecting", status?.idleSuspendMs ?? undefined);
		const say = (line: string) => { console.log(line); client?.write(line + "\n"); };
		while (!abort.signal.aborted) {
			let idle: string;
			if (needsPair) {
				const result = await pair(platform, abort.signal, say);
				if (abort.signal.aborted) { client?.end(); return; }
				if (result.paired) {
					paired = result.paired; resumePlatform = undefined;
					client?.end(); client = undefined;
					if (command === "pair") return;
					needsPair = false;
					continue;
				}
				idle = result.idle!;
				if (command === "pair") { say(idle); process.exitCode = 1; return; }
				if (resumePlatform) {
					say(idle); client?.end(); client = undefined;
					platform = resumePlatform; resumePlatform = undefined; needsPair = false;
					continue;
				}
			} else if (!paired?.key || platform !== paired.platform) {
				idle = "Run windlass-runner pair to pair with a different platform.";
			} else {
				// The recovery command printed after approval also works when the owner sees
				// the wrong account: the lock holder shuts its links before making a new key.
				const connection = new AbortController();
				const active = AbortSignal.any([abort.signal, connection.signal]);
				const owner = new Executor(paired.current, limits, values.screenshots, claude);
				const local = waitForPair(active, () => {}, async () => {
					await owner.serial(() => owner.refreshLogin());
					owner.publishReport?.();
				}).then(request => {
					if (request) connection.abort();
					return request;
				});
				let removed: string | undefined;
				try {
					removed = await control(owner, paired.key, platform, active, saveStatus,
						status?.machineId === paired.current.machineId ? status.idleSuspendMs ?? undefined : undefined);
				} finally { connection.abort(); }
				const request = await local;
				if (request && !abort.signal.aborted) {
					resumePlatform = platform;
					client = request.client; platform = request.platform ?? platform; needsPair = true;
					continue;
				}
				if (!removed) return;
				forgetKey();
				paired = { ...paired, key: null };
				idle = removed;
			}
			// No network timer in either terminal state. Only a local owner starts the next pairing.
			const requested = await waitForPair(abort.signal, () => {
				saveStatus(idle);
				audit(null, null, "idle", idle); say(idle);
				client?.end(); client = undefined;
			});
			client = requested?.client;
			platform = requested?.platform ?? platform;
			needsPair = true;
		}
	} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
void main().catch(error => {
	console.error(error?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
		? "Give each sandbox limit a positive whole number and --platform a URL." : category(error));
	process.exitCode = 1;
});
