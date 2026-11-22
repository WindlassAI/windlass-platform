import { codexModes } from "../../server/src/sandbox/codex-modes.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { boundedCodexOptions, validHarnessOptions } from "../../server/src/runner/control.js";
import { AcpConnection, LineSplitter, MethodNotFound } from "../../server/src/sandbox/acp.js";
import { configChoices, modeSelection, objects, optionsOf, type Fields } from "../../server/src/sandbox/acp-options.js";
import { LABEL_ARG, NO_LOGS, docker, tmpName } from "../../server/src/sandbox/docker.js";
import { PROFILE_RUN_FLAGS } from "../../server/src/sandbox/docker-flags.js";
import { commonRunFlags } from "../../server/src/sandbox/profiles.js";
import { WORKSPACE } from "../../server/src/sandbox/provider.js";
import { cleanClaudeOutput } from "./claude-output.js";
import { withLoginVolume } from "./harness-login.js";
import { codexLogin } from "./codex-login.js";
import { prepareRelay, relaySocketVolume, type ProviderLogin, projection, relayUrl } from "./claude-relay.js";
import type { MachineDocker } from "./policy.js";

/** The pinned OpenCode CLI lists every model's variants in one offline read. ACP adds
 * its "default" reset to nonempty variant selectors. Reading them together avoids
 * requesting the complete model list again for each model on a large provider. */
async function openCodeEfforts(container: string) {
	const { stdout } = await promisify(execFile)("docker", ["exec", "-e", "OPENCODE_DISABLE_MODELS_FETCH=true",
		"-e", "OPENCODE_DISABLE_AUTOUPDATE=true", "-e", "XDG_CONFIG_HOME=/etc/wlp-opencode",
		// This CLI can exit before its stdout pipe drains. A regular file keeps the last models.
		container, "sh", "-ec", "ulimit -f 65536; opencode models --pure --verbose >/tmp/wlp-models.txt; cat /tmp/wlp-models.txt"], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
	const efforts = new Map<string, string[]>();
	for (const block of stdout.matchAll(/^(\S+)\n(\{[\s\S]*?^\})$/gm)) {
		const variants = Object.keys(JSON.parse(block[2]!).variants ?? {});
		efforts.set(block[1]!, variants.length ? [...variants.filter(id => id !== "default"), "default"] : []);
	}
	return efforts;
}

/** Offline probe using a dummy credential and a fresh container filesystem. */
export async function probeHarnessOptions(machine: MachineDocker, pin: string, provider?: string | string[], codex?: {login?: ProviderLogin}) {
	const name = tmpName();
	const lease = codex?.login ? await withLoginVolume(machine, async () => {
		const current = codexLogin(machine);
		if (!current || current.generation !== codex.login?.generation) throw new Error("Codex login changed.");
		return prepareRelay(machine,current);
	}) : undefined;
	const flags = lease ? [...lease.env, "--mount", `type=volume,src=${relaySocketVolume(machine, "codex")},dst=/run/wlp-relay,readonly,volume-nocopy`] : [];
	// A prompt-free probe has no user workspace. Its forwarder can share this disposable
	// container. Signed-out inventory reads the native catalog with an offline gateway.
	const forward = lease ? `node -e 'const net=require("net"); net.createServer(c=>{const u=net.connect("/run/wlp-relay/relay.sock");u.write("${lease.nonce}");c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());c.pipe(u).pipe(c)}).listen(17892,"127.0.0.1")' &` : "";
	const child = spawn("docker", ["run", "--rm", "-i", "--name", name, "--label", LABEL_ARG,
		...machine.pairingLabelFlags, "--pull", "never", ...NO_LOGS, ...commonRunFlags(1, "none"),
		...(codex ? flags : provider ? projection(provider, "options-only") : ["-e", "ANTHROPIC_BASE_URL=" + relayUrl, "-e", "CLAUDE_CODE_OAUTH_TOKEN=options-only"]), ...PROFILE_RUN_FLAGS["docker-hardened"]!,
		pin, ...(codex ? ["sh","-ec",forward + " exec wlp-codex-acp"] : [provider ? "wlp-opencode-acp" : "wlp-claude-acp"])], { stdio: ["pipe", "pipe", "ignore"] });
	const rpc = new AcpConnection(line => child.stdin.write(line + "\n"), {
		notification() {}, async request(method) { throw new MethodNotFound(method); },
	}, "");
	const lines = new LineSplitter(line => rpc.receive(line));
	let bytes = 0;
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		bytes += Buffer.byteLength(chunk);
		if (bytes > (provider ? 8 * 1024 * 1024 : 256 * 1024)) rpc.end("Options response too large.");
		else lines.push(chunk);
	});
	const closed = new Promise<void>(resolve => child.once("close", () => { rpc.end("Options probe closed."); resolve(); }));
	child.on("error", () => rpc.end("Could not start options probe."));
	child.stdin.on("error", () => rpc.end("Options probe input closed."));
	const deadline = setTimeout(() => rpc.end("Options probe timed out."), 25_000);
	try {
		const init = await rpc.request<Fields>("initialize", { protocolVersion: 1, clientCapabilities: codex ? {auth:{_meta:{gateway:true}}} : {} });
		if (init.protocolVersion !== 1) throw new Error("Options unavailable.");
		if (codex) {
			if (lease) await rpc.request("providers/set", {});
			else await rpc.request("authenticate", {methodId:"gateway",_meta:{gateway:{baseUrl:relayUrl+"/codex/v1",headers:{}}}});
		}
		const result = await rpc.request<Fields>("session/new", { cwd: WORKSPACE, mcpServers: [] });
		const { model, list } = optionsOf(result.configOptions);
		if (!model || !list) throw new Error("No models reported.");
		if (codex && list.models.length > 32) throw new Error("Codex catalog exceeds the report limit.");
		const catalog = provider ? await openCodeEfforts(name) : null;
		for (const choice of list.models) {
			if (choice.id === list.defaultModel) continue;
			const efforts = catalog?.get(choice.id);
			if (efforts) { choice.efforts = efforts; continue; }
			// Claude exposes efforts only after selecting a model in this temporary session.
			const selected = await rpc.request<Fields>("session/set_config_option", {
				sessionId: result.sessionId, configId: model.id, value: choice.id,
			});
			const configs = objects(selected.configOptions);
			if (!configs.some(option => option.id === model.id && option.currentValue === choice.id)) throw new Error("Model selection failed.");
			choice.efforts = configChoices(configs.find(option => option.category === "thought_level")).map(effort => effort.id);
		}
		const options = { models: list.models, defaultModel: list.defaultModel, modes: codex ? codexModes("docker-hardened") : modeSelection(result.modes, result.configOptions).modes, checkedAt: Date.now() };
		const serialized = JSON.stringify(options);
		if (!validHarnessOptions(options) || (codex && !boundedCodexOptions(options)) || cleanClaudeOutput(serialized) !== serialized)
			throw new Error("Invalid model options.");
		return options;
	} finally {
		clearTimeout(deadline);
		rpc.end("Options probe finished.");
		child.stdin.end();
		await docker(["rm", "-f", name], { timeoutMs: 5000 });
		child.kill();
		await closed;
	}
}
