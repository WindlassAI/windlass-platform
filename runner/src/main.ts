import { createInterface } from "node:readline/promises";
import { setTimeout as wait } from "node:timers/promises";
import { parseArgs } from "node:util";
import { boolean, count, is, nullable, object, optional, text } from "../../server/src/runner/check.js";
import { validMachineName, REFUSED_RETRY_MS } from "../../server/src/runner/control.js";
import { pairingTrust } from "./state.js";
import { MACHINE_PROFILES, machineProfile, PROTOCOL_VERSION } from "../../server/src/runner/protocol.js";
import type { Socket } from "node:net";
import { audit, showLog } from "./audit.js";
import { resolveMachineName } from "./machine-name.js";
import { category, control, pair } from "./control.js";
import { cleanClaudeOutput } from "./claude-output.js";
import { changeClaudeLogin, claudeSignIn, retireClaudeRelay } from "./harness-login.js";
import { storeProvider, changeProviderLogin, currentProvider, installedProvider, terminalQuestion } from "./opencode-login.js";
import { importOpenCode } from "./opencode-import.js";
import { setupAgents, setupImageAndMounts, shellCommand } from "./setup.js";
import { removeRelay } from "./claude-relay.js";
import { withLoginVolume } from "./harness-login.js";
import { harnessImage, imagePins, prepareImages, shotsImage, type MachineHarness } from "./policy.js";
import { localSizing } from "./sizing.js";
import { Executor } from "./docker-executor.js";
import { requestPair, requestLoginReport, waitForPair } from "./pair-command.js";
import { egressFlags } from "./egress-policy.js";
import { egressNote, pairingEgress, forgetKey, save, loadPair, pairingProfiles, tryLock, origin, read, RunnerError, serviceRunning, VERSION } from "./state.js";

const positiveInteger = is<number>(v => count(v) && v > 0);
// Accept the first C3b snapshot on upgrade. Only harness.json records opt-in on new writes.
const snapshot = object({ machineId: nullable(text(64)), connection: text(2048), idleSuspendMs: nullable(count), runnerVersion: text(64), protocol: count,
	claude: optional(boolean), maxTurns: optional(positiveInteger), maxRunning: optional(positiveInteger), maxSandboxes: optional(positiveInteger) });
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
		provider: { type: "string" }, egress: { type: "string" }, "egress-allow": { type: "string" },
		"allow-profile": { type: "string", multiple: true }, platform: { type: "string" }, name: { type: "string" }, harness: { type: "string", multiple: true }, screenshots: { type: "boolean", default: false },
		slots: { type: "string" }, "slot-cpus": { type: "string" }, "slot-memory": { type: "string" }, "sandbox-memory": { type: "string" }, "max-turns": { type: "string" }, "max-sandboxes": { type: "string" }, "max-running": { type: "string" },
	} });
	const command = positionals[0] ?? "run";
	// A release can publish this report without mounting runner state or a Docker socket.
	if (command === "capabilities" && positionals.length === 1) {
		const harnesses = (["claude", "opencode"] as const).filter(id => harnessImage(id));
		console.log(JSON.stringify({ image: process.env.WLP_RUNNER_IMAGE ?? null, harnesses }));
		return;
	}
	if (command === "image-pins" && positionals.length === 1) {
		console.log(JSON.stringify(imagePins()));
		return;
	}
	const auth = command === "login" || command === "logout";
	const claude = !!values.harness?.includes("claude");
	const opencode = !!values.harness?.includes("opencode");
	const agents = [...new Set(values.harness ?? [])] as MachineHarness[];
	const agent = positionals[1] as MachineHarness;
	const changeLogin = agent === "opencode" ? changeProviderLogin : changeClaudeLogin;
	const label = agent === "opencode" ? "OpenCode" : "Claude Code";
	if (values.provider && !(agent === "opencode" && command === "login")) throw new RunnerError("Use --provider with login opencode.");
	const validCommand = auth ? positionals.length === 2 && ["claude", "opencode"].includes(agent)
		: positionals.length <= 1 && ["setup", "run", "pair", "status", "log", "prune"].includes(command);
	if (!validCommand)
		throw new RunnerError("Use windlass-runner [setup|run|pair|status|capabilities|log|prune|login <agent>|logout <agent>] [--platform URL] [--name TEXT] [--max-sandboxes N] [--max-running N] [--slots N | --max-turns N] [--slot-cpus X] [--slot-memory Nm|Ng] [--sandbox-memory Ng] [--screenshots] [--harness claude] [--harness opencode] [--allow-profile ID ...] [--egress open|restricted|none] [--egress-allow host[,host]].");
	if (values.name !== undefined && (!["setup", "run", "pair"].includes(command) || !validMachineName(values.name)))
		throw new RunnerError("Use --name with setup, run or pair and a printable name of 1 to 64 characters.");
	const requestedEgress = egressFlags(values.egress, values["egress-allow"]);
	if (requestedEgress && command !== "run" && command !== "setup") throw new RunnerError("Use --egress and --egress-allow with setup or run.");
	const flags = values["allow-profile"];
	if (flags && ((command !== "run" && command !== "setup") || flags.some(id => !machineProfile(id))))
		throw new RunnerError("Use --allow-profile with setup or run and a profile ID: docker-hardened or docker-windlass-sandbox.");
	const profiles = flags && MACHINE_PROFILES.filter(id => id === "docker-hardened" || flags.includes(id));
	if (agents.some(id => id !== "claude" && id !== "opencode")) throw new RunnerError("Choose --harness claude or --harness opencode.");
	if (opencode && !harnessImage("opencode")) throw new RunnerError("Use --harness opencode with a runner built with the pinned OpenCode image.");
	if (claude && !harnessImage("claude"))
		throw new RunnerError("Use --harness claude with a runner built with the pinned Claude Code image.");
	if (values.screenshots && !shotsImage) throw new RunnerError("--screenshots requires a runner built with a pinned screenshots sandbox image.");
	// Owner commands such as status and prune do not need a viable session budget.
	const sizingCommand = command === "run" || command === "setup";
	if (!sizingCommand && [values.slots, values["slot-cpus"], values["slot-memory"], values["sandbox-memory"]].some(v => v !== undefined))
		throw new RunnerError("Use --slots, --slot-cpus, --slot-memory and --sandbox-memory with run or setup.");
	const slots = sizingCommand ? localSizing(values) : null;
	const limits = { slots, maxTurns: slots?.max, maxSandboxes: limit("max-sandboxes", values["max-sandboxes"]), maxRunning: limit("max-running", values["max-running"]) };
	if (command === "log") return showLog();
	const abort = new AbortController();
	const stop = () => abort.abort();
	process.on("SIGINT", stop); process.on("SIGTERM", stop);
	try {
		if (auth) {
			const paired = loadPair();
			if (!paired || (command === "login" && !paired.key)) throw new RunnerError("Pair this machine before signing in to " + label + ".");
			if (command === "login") {
				await changeLogin(new Executor(paired.current, limits), true, abort.signal, values.provider);
				console.log(label + ": signed in.");
			} else {
				for (const identity of [paired.current, ...paired.previous]) {
					try {
						await changeLogin(new Executor(identity, limits), false, abort.signal);
						console.log(`${identity.machineId} ${label}: signed out.`);
					} catch (error) {
						console.error(`${identity.machineId} ${label}: ${category(error)}`);
						process.exitCode = 1;
					}
				}
			}
			await requestLoginReport(command === "login");
			return;
		}
		if (command !== "status" && !tryLock()) {
			if (command === "setup") throw new RunnerError("The runner is already using this state. Use login <agent> in the running runner.");
			if (command === "pair") return requestPair(values.platform, values.name);
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
		const harness = read("harness.json");
		if (harness !== undefined && !boolean(harness)) throw new RunnerError("Invalid harness.json. Repair or restore that file in the runner state volume.");
		if (command === "status") {
			const offered = status && (harness ?? status.claude);
			console.log(`Runner ${VERSION}, protocol ${PROTOCOL_VERSION}. ${paired && !serviceRunning() ? "Stopped" : status?.connection ?? (paired ? "Paired" : "Unpaired")}`);
			if (paired) console.log(egressNote(paired.current.machineId));
			const caps = status ?? limits;
			console.log(`Turn capacity: ${caps.maxTurns === undefined ? "not reported yet" : `${caps.maxTurns} slots`}`);
			console.log(`Running sandbox limit: ${caps.maxRunning ?? "no limit"}`);
			console.log(`Kept sandbox limit: ${caps.maxSandboxes ?? "no limit"}`);
			if (paired) for (const machine of [paired.current, ...paired.previous]) {
				console.log(`${machine.machineId}${machine === paired.current ? "" : " (previous pairing)"}`);
				const executor = new Executor(machine, limits);
				if (opencode || harnessImage("opencode")) {
					console.log(`  OpenCode${machine === paired.current && read("opencode-offered.json") === true ? " (offered)" : ""}: ${await installedProvider(executor) ? "signed in" : "not signed in"}`);
				}
				if (offered || claude || harnessImage("claude")) {
					const signIn = await claudeSignIn(executor);
					console.log(`  Claude Code${offered && machine === paired.current ? " (offered)" : ""}: ${signIn === "token" ? "signed in" : signIn === "none" ? "not signed in" : "unknown"}`);
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
		let name = await resolveMachineName(values.name);
		const launch = command === "setup" ? await setupImageAndMounts() : undefined;
		if (command === "run" || command === "setup") await prepareImages(agents, values.screenshots, command);
		let needsPair = command === "setup" || command === "pair" || !paired?.key || !paired?.pin;
		let client: Socket | undefined;
		let resumePlatform: string | undefined;
		function saveStatus(connection: string, idleSuspendMs?: number) {
			save("status.json", { machineId: paired?.current.machineId ?? null, connection, idleSuspendMs: idleSuspendMs ?? null,
				runnerVersion: VERSION, protocol: PROTOCOL_VERSION, maxTurns: limits.maxTurns, maxRunning: limits.maxRunning, maxSandboxes: limits.maxSandboxes });
		}
		if (command === "run") {
			if (paired && (harness === undefined || status?.claude)) {
				for (const identity of [paired.current, ...paired.previous])
					await new Executor(identity, limits).migrateClaudeNames();
			}
			save("harness.json", claude);
			save("opencode-offered.json", opencode);
			saveStatus(needsPair ? "Pairing" : "Connecting", status?.idleSuspendMs ?? undefined);
		}
		const say = (line: string) => { console.log(line); client?.write(line + "\n"); };
		while (!abort.signal.aborted) {
			let idle: string;
			if (needsPair) {
				const result = await pair(platform, abort.signal, say, name, profiles, command === "setup");
				if (abort.signal.aborted) { client?.end(); return; }
				if (result.paired) {
					if (paired) {
						const old = new Executor(paired.current, limits);
						await retireClaudeRelay(old);
						if (currentProvider(old)) await withLoginVolume(old, () => removeRelay(old, "opencode"));
					}
					paired = result.paired; resumePlatform = undefined;
					client?.end(); client = undefined;
					if (command === "setup") {
						const machine = new Executor(result.paired.current, limits);
						await setupAgents(agents, prompt => terminalQuestion(prompt, abort.signal),
							async id => {
								if (id === "claude") return changeClaudeLogin(machine, true, abort.signal);
								const login = (provider?: string) => changeProviderLogin(machine, true, abort.signal, provider);
								if (launch?.importFile && await importOpenCode(launch.importFile, p => terminalQuestion(p, abort.signal),
									(provider,key) => storeProvider(machine,{provider,key}), login)) return;
								await login();
							});
						const flags = process.argv.slice(2).filter((_, i) => i !== process.argv.slice(2).indexOf("setup"));
						if (values["slot-cpus"] === undefined && process.env.WLP_RUNNER_CPUS !== undefined) flags.push("--slot-cpus", String(slots!.unit.cpus));
						console.log("Start the runner on this machine:\n" + shellCommand([...launch!.command, "run", ...flags]));
						return;
					}
					if (command === "pair") return;
					needsPair = false;
					continue;
				}
				idle = result.idle!;
				if (command === "setup" || command === "pair") { say(idle); process.exitCode = 1; return; }
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
				const policy = pairingEgress(paired.current.machineId, requestedEgress);
				const note = egressNote(paired.current.machineId);
				console.log(note);
				audit(null, null, "egress", note);
				const owner = new Executor(paired.current, limits, values.screenshots, claude, pairingProfiles(paired.current.machineId, profiles), policy, opencode);
				// Quarantine old mounts even when the platform is offline. Docker health refresh
				// reports and retries an unavailable daemon. Legacy sessions cannot reconnect.
				await owner.secureCredentialPath().catch(() => {});
				const local = waitForPair(active, () => {}, async signedIn => {
					await owner.serial(() => owner.loginChanged(signedIn));
					owner.publishReport?.();
				}).then(request => {
					if (request) connection.abort();
					return request;
				});
				let removed: string | undefined;
				try {
					removed = await control(owner, paired.key, platform, active, saveStatus,
						status?.machineId === paired.current.machineId ? status.idleSuspendMs ?? undefined : undefined, name, pairingTrust(paired));
				} finally { connection.abort(); }
				const request = await local;
				if (request && !abort.signal.aborted) {
					if (request.name !== undefined) name = await resolveMachineName(request.name);
					resumePlatform = platform;
					client = request.client; platform = request.platform ?? platform; needsPair = true;
					continue;
				}
				if (!removed) return;
				try { await retireClaudeRelay(owner); if (currentProvider(owner)) await withLoginVolume(owner, () => removeRelay(owner, "opencode")); } finally { forgetKey(); }
				paired = { ...paired, key: null };
				idle = removed;
			}
			// No network timer in either terminal state. Only a local owner starts the next pairing.
			const requested = await waitForPair(abort.signal, () => {
				saveStatus(idle);
				audit(null, null, "idle", idle); say(idle);
				client?.end(); client = undefined;
			});
			if (requested?.name !== undefined) name = await resolveMachineName(requested.name);
			client = requested?.client;
			platform = requested?.platform ?? platform;
			needsPair = true;
		}
	} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
void main().catch(error => {
	console.error(error?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
		? "Give --slots or --max-turns a count, --slot-cpus a CPU count, --slot-memory or --sandbox-memory a size, --egress a mode, --egress-allow a hostname list, --allow-profile a profile ID, each sandbox count a positive whole number and --platform a URL." : category(error));
	process.exitCode = 1;
});
