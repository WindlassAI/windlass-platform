import { hostname } from "node:os";
import { validMachineName } from "../../server/src/runner/control.js";
import { docker } from "../../server/src/sandbox/docker.js";
import { read, RunnerError, save } from "./state.js";

async function dockerHost() {
	const result = await docker(["info", "--format", "{{.Name}}"], { timeoutMs: 3000, check: true });
	return result.stdout.trim();
}

export async function resolveMachineName(requested?: string, probe = dockerHost): Promise<string> {
	const configured = requested ?? read("name.json");
	if (configured !== undefined) {
		if (!validMachineName(configured))
			throw new RunnerError("Give --name a printable machine name of 1 to 64 characters.");
		if (requested !== undefined) save("name.json", requested);
		return configured;
	}
	const host = await probe().catch(() => undefined);
	return validMachineName(host) ? host : hostname().slice(0, 64);
}
