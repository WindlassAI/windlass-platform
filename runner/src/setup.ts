import { hostname } from "node:os";
import { docker } from "../../server/src/sandbox/docker.js";
import type { MachineHarness } from "./policy.js";
import { directory, RunnerError } from "./state.js";

export async function setupImageAndMounts() {
	// Only inspect the setup container itself. Docker gives it its short id as the default hostname.
	if (!/^[a-f0-9]{12}$/.test(hostname())) throw new RunnerError("Run setup in the runner image with its default Docker hostname.");
	const result = await docker(["container", "inspect", "--format", "{{json .Image}} {{json .Mounts}}", hostname()]);
	if (result.code !== 0) throw new RunnerError("Could not inspect this setup container.");
	const space = result.stdout.indexOf(" ");
	const image = JSON.parse(result.stdout.slice(0, space));
	const mounts: Array<{ Type: string; Name?: string; Destination: string; Source: string }> = JSON.parse(result.stdout.slice(space + 1));
	if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new RunnerError("Could not determine the runner image ID.");
	const args = ["docker", "run", "-d", "--name", "windlass-runner", "--restart", "unless-stopped"];
	for (const dst of ["/var/run/docker.sock", directory]) {
		const mount = mounts.find(m => m.Destination === dst);
		if (!mount || (mount.Type !== "bind" && mount.Type !== "volume")) throw new RunnerError("Mount the Docker socket and runner state for setup.");
		args.push("-v", (mount.Type === "volume" ? mount.Name : mount.Source) + ":" + dst);
	}
	return [...args, image];
}

export async function setupAgents(harnesses: MachineHarness[], ask: (message: string) => Promise<string>, login: (harness: MachineHarness) => Promise<void>) {
	for (const harness of harnesses) {
		let answer: string;
		do { answer = (await ask((harness === "claude" ? "Claude Code" : "OpenCode") + ": sign in now? [Y/n] ")).toLowerCase(); }
		while (!["", "y", "yes", "n", "no"].includes(answer));
		if (answer !== "n" && answer !== "no") await login(harness);
	}
}
export const shellCommand = (args: string[]) => args.map(arg => /^[a-zA-Z0-9/:._@=-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
