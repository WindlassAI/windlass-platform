import { hostname } from "node:os";
import { RUNNER_LOGS, docker } from "../../server/src/sandbox/docker.js";
import { HARNESS_LABELS } from "./setup-choices.js";
import type { MachineHarness } from "./policy.js";
import { directory, RunnerError } from "./state.js";

export async function setupImageAndMounts() {
	// Only inspect the setup container itself. Docker gives it its short id as the default hostname.
	if (!/^[a-f0-9]{12}$/.test(hostname()))
		throw new RunnerError("Run setup in the runner image with its default Docker hostname.");
	const result = await docker([
		"container",
		"inspect",
		"--format",
		"[{{json .Image}},{{json .Config.Image}},{{json .Mounts}}]",
		hostname(),
	]);
	if (result.code !== 0) throw new RunnerError("Could not inspect this setup container.");
	type Mount = { Type: string; Name?: string; RW?: boolean; Destination: string; Source: string };
	const [imageId, configured, mounts]: [string, string, Mount[]] = JSON.parse(result.stdout);
	if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new RunnerError("Could not determine the runner image ID.");
	const image = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(configured) ? configured : imageId;
	const args = ["docker", "run", "-d", "--name", "windlass-runner", "--restart", "unless-stopped", ...RUNNER_LOGS];
	for (const dst of ["/var/run/docker.sock", directory]) {
		const mount = mounts.find(m => m.Destination === dst);
		if (!mount || (mount.Type !== "bind" && mount.Type !== "volume"))
			throw new RunnerError("Mount the Docker socket and runner state for setup.");
		args.push("-v", (mount.Type === "volume" ? mount.Name : mount.Source) + ":" + dst);
	}
	if (directory !== "/var/lib/windlass-runner") args.push("-e", "WLP_RUNNER_STATE_DIR=" + directory);
	const source = mounts.find(m => m.Destination === "/import/opencode");
	if (source && (source.Type !== "bind" || source.RW !== false))
		throw new RunnerError("Mount /import/opencode read-only with :ro.");
	return { command: [...args, image], importFile: source && "/import/opencode/auth.json" };
}

export const laterLogin = (harness: MachineHarness) =>
	`docker exec -it windlass-runner windlass-runner login ${harness}`;

// Setup continues with the other agents when a sign-in fails.
export async function setupAgents(
	harnesses: MachineHarness[],
	ask: (message: string) => Promise<string>,
	login: (harness: MachineHarness) => Promise<void>,
	say: (line: string) => void = console.log,
	stopped: () => boolean = () => false,
): Promise<MachineHarness[]> {
	const unsigned: MachineHarness[] = [];
	for (const harness of harnesses) {
		let answer: string;
		do {
			answer = (await ask(HARNESS_LABELS[harness] + ": sign in now? [Y/n] ")).toLowerCase();
		} while (!["", "y", "yes", "n", "no"].includes(answer));
		if (answer === "n" || answer === "no") {
			say(`${HARNESS_LABELS[harness]} is not signed in. Sign it in later with: ${laterLogin(harness)}`);
			unsigned.push(harness);
			continue;
		}
		try {
			await login(harness);
		} catch (error) {
			if (stopped()) throw error;
			const why = error instanceof RunnerError ? error.message : "the sign-in did not finish.";
			say(`${HARNESS_LABELS[harness]} was not signed in: ${why} Sign it in later with: ${laterLogin(harness)}`);
			unsigned.push(harness);
		}
	}
	return unsigned;
}
export const shellCommand = (args: string[]) =>
	args.map(arg => (/^[a-zA-Z0-9/:._@=-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'")).join(" ");
