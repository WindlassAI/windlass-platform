import { spawn } from "node:child_process";
import { validHarnessOptions } from "../../server/src/runner/control.js";
import { AcpConnection, LineSplitter, MethodNotFound } from "../../server/src/sandbox/acp.js";
import { modesOf, object, optionsOf, type Fields } from "../../server/src/sandbox/acp-options.js";
import { LABEL_ARG, docker, tmpName } from "../../server/src/sandbox/docker.js";
import { PROFILE_RUN_FLAGS } from "../../server/src/sandbox/docker-flags.js";
import { COMMON_RUN_FLAGS } from "../../server/src/sandbox/profiles.js";
import { WORKSPACE } from "../../server/src/sandbox/provider.js";
import { cleanClaudeOutput } from "./claude-output.js";
import { volumeFlags } from "./harness-login.js";
import type { MachineDocker } from "./policy.js";

/** The caller holds the login-volume lock and has checked its ownership. */
export async function probeClaudeOptions(machine: MachineDocker, pin: string) {
	const name = tmpName();
	const child = spawn("docker", ["run", "--rm", "-i", "--name", name, "--label", LABEL_ARG,
		...volumeFlags(machine, true), ...COMMON_RUN_FLAGS, ...PROFILE_RUN_FLAGS["docker-hardened"]!,
		pin, "wlp-claude-acp"], { stdio: ["pipe", "pipe", "ignore"] });
	const rpc = new AcpConnection(line => child.stdin.write(line + "\n"), {
		notification() {}, async request(method) { throw new MethodNotFound(method); },
	}, "");
	const lines = new LineSplitter(line => rpc.receive(line));
	let bytes = 0;
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		bytes += Buffer.byteLength(chunk);
		if (bytes > 256 * 1024) rpc.end("Options response too large.");
		else lines.push(chunk);
	});
	const closed = new Promise<void>(resolve => child.once("close", () => { rpc.end("Options probe closed."); resolve(); }));
	child.on("error", () => rpc.end("Could not start options probe."));
	child.stdin.on("error", () => rpc.end("Options probe input closed."));
	const deadline = setTimeout(() => rpc.end("Options probe timed out."), 25_000);
	try {
		const init = await rpc.request<Fields>("initialize", { protocolVersion: 1, clientCapabilities: {} });
		if (init.protocolVersion !== 1 || object(object(init.agentCapabilities).sessionCapabilities).options == null)
			throw new Error("Options unavailable.");
		const result = await rpc.request<Fields>("session/options", { cwd: WORKSPACE });
		const { list } = optionsOf(result.configOptions);
		if (!list) throw new Error("No models reported.");
		const options = { models: list.models, defaultModel: list.defaultModel, modes: modesOf(result.modes), checkedAt: Date.now() };
		const serialized = JSON.stringify(options);
		if (!validHarnessOptions(options) || cleanClaudeOutput(serialized) !== serialized)
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
