import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { count, nullable, object, text } from "../../server/src/runner/check.js";
import { MAX_REPORTED_SANDBOXES } from "../../server/src/runner/control.js";
import { PROTOCOL_VERSION } from "../../server/src/runner/protocol.js";
import type { Socket } from "node:net";
import { audit, showLog } from "./audit.js";
import { category, control, pair } from "./control.js";
import { Executor } from "./docker-executor.js";
import { requestPair, waitForPair } from "./pair-command.js";
import { forgetKey, save, loadPair, lock, origin, read, RunnerError, serviceRunning, VERSION } from "./state.js";

const snapshot = object({ machineId: nullable(text(64)), connection: text(2048), idleSuspendMs: nullable(count), runnerVersion: text(64), protocol: count });
function limit(value: string | undefined, fallback: number) {
	const n = Number(value ?? fallback);
	if (!Number.isSafeInteger(n) || n < 1 || n > MAX_REPORTED_SANDBOXES)
		throw new RunnerError(`Choose sandbox limits between 1 and ${MAX_REPORTED_SANDBOXES}.`);
	return n;
}
async function main() {
	const { positionals, values } = parseArgs({ allowPositionals: true, options: {
		platform: { type: "string" }, "max-sandboxes": { type: "string" }, "max-running": { type: "string" },
	} });
	const command = positionals[0] ?? "run";
	if (positionals.length > 1 || !["run", "pair", "status", "log", "prune"].includes(command))
		throw new RunnerError("Use windlass-runner [run|pair|status|log|prune] [--platform URL] [--max-sandboxes N] [--max-running N].");
	if (command === "log") return showLog();
	const limits = { maxSandboxes: limit(values["max-sandboxes"], 10), maxRunning: limit(values["max-running"], 3) };
	// Orphaned commands may still be finishing when the control loop returns.
	if (command === "pair" && serviceRunning()) return requestPair(values.platform);
	const abort = new AbortController();
	const stop = () => abort.abort();
	process.on("SIGINT", stop); process.on("SIGTERM", stop);
	try {
		if (command !== "status") await lock(abort.signal);
		if (abort.signal.aborted) return;
		let paired = loadPair();
		const stored = read("status.json");
		if (stored !== undefined && !snapshot(stored)) throw new RunnerError("Invalid status.json. Repair or restore that file in the runner state volume.");
		const status = snapshot(stored) && stored.machineId === (paired?.current.machineId ?? null) ? stored : undefined;
		if (command === "status") {
			console.log(`Runner ${VERSION}, protocol ${PROTOCOL_VERSION}. ${paired && !serviceRunning() ? "Stopped" : status?.connection ?? (paired ? "Paired" : "Unpaired")}`);
			if (paired) for (const machine of [paired.current, ...paired.previous]) {
				console.log(`${machine.machineId}${machine === paired.current ? "" : " (previous pairing)"}`);
				const executor = new Executor(machine, limits);
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
				const local = waitForPair(active, () => {}).then(request => {
					if (request) connection.abort();
					return request;
				});
				let removed: string | undefined;
				try {
					removed = await control(new Executor(paired.current, limits), paired.key, platform, active,
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
				save("status.json", { machineId: paired?.current.machineId ?? null, connection: idle, idleSuspendMs: null, runnerVersion: VERSION, protocol: PROTOCOL_VERSION });
				audit(null, null, "idle", idle); say(idle);
				client?.end(); client = undefined;
			});
			client = requested?.client;
			platform = requested?.platform ?? platform;
			needsPair = true;
		}
	} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
void main().catch(error => { console.error(category(error)); process.exitCode = 1; });
