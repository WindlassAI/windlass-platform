import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { LABEL_ARG, NO_LOGS, docker, helperFlags, runHelper, tmpName } from "../../server/src/sandbox/docker.js";
import { COMMON_RUN_FLAGS } from "../../server/src/sandbox/profiles.js";
import { removeRelay, stopLegacyClaude } from "./claude-relay.js";
import { image, harnessImage, type MachineDocker } from "./policy.js";
import { directory, loadPair, read, save, RunnerError } from "./state.js";

const loginDir = "/run/wlp-harness/claude";

// The service, login, logout and status can run in different PID namespaces. Hold this lock
// from volume ownership validation until Docker has attached (or finished removing) the volume.
export async function withLoginVolume<T>(machine: MachineDocker, work: () => Promise<T>): Promise<T> {
	const fd = await open(join(directory, machine.claudeVolume + ".lock"), "a", 0o600);
	try {
		const lock = spawn("flock", ["-x", "3"], { stdio: ["ignore", "ignore", "ignore", fd.fd] });
		await new Promise<void>((resolve, reject) => {
			lock.on("error", reject);
			lock.on("close", code => code === 0 ? resolve() : reject(new RunnerError("Could not lock the Claude login volume.")));
		});
		return await work();
	} finally { await fd.close(); }
}

export async function retireClaudeRelay(machine: MachineDocker) {
	await withLoginVolume(machine, async () => {
		await stopLegacyClaude(machine);
		await removeRelay(machine);
	});
}

export function volumeFlags(machine: MachineDocker, readonly: boolean) {
	return [...machine.pairingLabelFlags,
		"--pull", "never", "--mount",
		`type=volume,src=${machine.claudeVolume},dst=${loginDir},volume-nocopy${readonly ? ",readonly" : ""}`];
}

// Docker's archive HEAD returns file metadata even with a stopped container. The runner
// container has no host mountpoint access. Never start a probe or ask Docker for the bytes.
export async function claudeSignIn(machine: MachineDocker): Promise<"none" | "token" | "unknown"> {
	try {
		return await withLoginVolume(machine, () => loginFileState(machine));
	} catch { return "unknown"; }
}

export async function loginFileState(machine: MachineDocker): Promise<"none" | "token" | "unknown"> {
	if (!await machine.ownedVolume(false, machine.claudeVolume)) return "none";
	const container = (await docker(["create", ...NO_LOGS, "--network", "none", "--label", LABEL_ARG,
		...volumeFlags(machine, true), image, "true"], { check: true })).stdout.trim();
	try {
		const result = await docker(["system", "dial-stdio"], { timeoutMs: 15_000,
			stdin: `HEAD /containers/${container}/archive?path=${loginDir}/token HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n` });
		if (result.code !== 0) return "unknown";
		if (result.stdout.startsWith("HTTP/1.1 404 ")) return "none";
		const header = /^X-Docker-Container-Path-Stat: ([^\r\n]+)/im.exec(result.stdout);
		if (!header || !result.stdout.startsWith("HTTP/1.1 200 ")) return "unknown";
		const stat = JSON.parse(Buffer.from(header[1], "base64").toString());
		if (stat.name !== "token" || !(Number.isInteger(stat.mode) && stat.mode >= 0 && stat.mode <= 0o777) || !Number.isSafeInteger(stat.size)) return "unknown";
		return stat.size > 0 ? "token" : "none";
	} finally { await docker(["rm", "-v", container], { check: true }); }
}

export async function pastedToken(signal: AbortSignal, provider?: string) {
	const message = provider ? `Enter the ${provider} API key: ` : "Paste the token it printed (or one made by claude setup-token on any computer): ";
	const invalid = provider ? `Enter a ${provider} API key of up to 4096 characters.` : "Expected one Claude setup token of at most 512 characters.";
	let value = "";
	if (process.stdin.isTTY) {
		const stty = (arg: string) => spawnSync("stty", [arg], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" });
		const saved = stty("-g");
		if (saved.status !== 0 || stty("-echo").status !== 0) throw new RunnerError("Could not disable terminal echo.");
		const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
		try { value = await lines.question(message, { signal }); }
		finally { lines.close(); stty(saved.stdout.trim()); process.stdout.write("\n"); }
	} else {
		for await (const bytes of process.stdin) {
			value += bytes.toString("utf8");
			if (value.length > (provider ? 4098 : 514)) throw new RunnerError(invalid);
		}
		value = value.replace(/\r?\n$/, "");
	}
	if (provider) {
		if (!/^[!-~]{1,4096}$/.test(value)) throw new RunnerError(invalid);
		return value;
	}
	if (value.length > 512 || !/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(value) || /\s/.test(value))
		throw new RunnerError(invalid);
	return value;
}

export const setupCli = "/opt/wlp-claude/node_modules/.bin/claude-agent-acp";

export function setupFlags(machine: MachineDocker) {
	return [...NO_LOGS, "--pull", "never", "--label", LABEL_ARG, ...machine.pairingLabelFlags, ...COMMON_RUN_FLAGS];
}

export async function changeClaudeLogin(machine: MachineDocker, login: boolean, signal: AbortSignal) {
	let token: string | undefined;
	if (login) {
		const pin = harnessImage("claude");
		if (!pin) throw new RunnerError("This runner was built without the Claude Code image.");
		console.log("This makes a Claude Code token for this machine with Anthropic's own sign-in (claude setup-token). " +
			"A relay on this machine holds the token. Claude sessions can use the login while they are running.");
		if (process.stdin.isTTY) {
			if (!process.stdout.isTTY || !process.stderr.isTTY) throw new RunnerError("Attach a terminal to sign in interactively.");
			await machine.ensureImage(pin);
			// The CLI prints its token in the owner's attached terminal. Disable Docker log capture.
			const setup = spawnSync("docker", ["run", "--rm", "-it", ...setupFlags(machine),
				pin, setupCli, "--cli", "setup-token"], { stdio: "inherit" });
			if (setup.status !== 0) console.log("Setup did not finish. You can paste a token made on another computer.");
		}
		token = await pastedToken(signal);
	}
	await storeClaudeLogin(machine, token);
}

const generationFile = (m: MachineDocker) => "claude-generation-" + m.identity.machineId + ".json";

export function claudeLoginGeneration(m: MachineDocker) {
	const value = read(generationFile(m));
	return typeof value === "string" && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
}

export async function storeClaudeLogin(machine: MachineDocker, token: string | undefined, signal?: AbortSignal) {
	const login = token !== undefined;
	await machine.ensureImage();
	await withLoginVolume(machine, async () => {
		if (login) {
			// Browser approval can take minutes. A re-pair or removal during that time
			// must not install a new login for the former pairing.
			const pair = loadPair();
			if (!pair?.key || pair.current.machineId !== machine.identity.machineId || pair.current.uid !== machine.identity.uid)
				throw new RunnerError("The machine pairing changed during login. Run windlass-runner login claude again.");
		}
		await stopLegacyClaude(machine);
		if (!await machine.ownedVolume(login, machine.claudeVolume)) {
			if (!login) await removeRelay(machine);
			return;
		}
		signal?.throwIfAborted();
		const name = tmpName();
		// Use the base image, no network and a private temporary file. No login data in Docker's
		// argv, environment, container logs, or diagnostics returned to the operator.
		const script = login ? `set -eu
umask 077
cd "$1"
t=$(mktemp .token.XXXXXXXX)
trap 'rm -f -- "$t"' EXIT
cat > "$t"
chmod 0400 "$t"
chown 1000:1000 "$t"
mv -fT -- "$t" token` : 'rm -f -- "$1/token" "$1"/.token.*';
		const result = await runHelper([...helperFlags(name, "none"), "--user", "0", "--cap-add", "CHOWN",
			...volumeFlags(machine, false)], name, ["sh", "-c", script, "sh", loginDir], { image, stdin: token });
		if (result.code !== 0) throw new RunnerError("Docker could not update the Claude login volume.");
		save(generationFile(machine), login ? randomBytes(16).toString("hex") : null);
		if (!login) {
			await removeRelay(machine);
			await dropDetachedLoginVolume(machine);
		}
	});
}

// Docker retains even a stopped container's volume reference. Logout unlinks the token
// immediately. Removing the last legacy mount lets the runner drop the empty volume.
export async function dropDetachedLoginVolume(machine: MachineDocker) {
	const refs = await docker(["ps", "-aq", "--filter", "volume=" + machine.claudeVolume], { check: true });
	if (!refs.stdout.trim()) await machine.dropVolume(machine.claudeVolume);
}
