import { spawn, spawnSync } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { LABEL_ARG, docker, helperFlags, runHelper, tmpName } from "../../server/src/sandbox/docker.js";
import { image, harnessImage, type MachineDocker } from "./policy.js";
import { directory, loadPair, RunnerError } from "./state.js";

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

function volumeFlags(machine: MachineDocker, readonly: boolean) {
	return [...Object.entries(machine.labels).flatMap(([k, v]) => ["--label", k + "=" + v]),
		"--pull", "never", "--log-driver", "none", "--mount",
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
	const container = (await docker(["create", "--network", "none", "--label", LABEL_ARG,
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

async function pastedToken(signal: AbortSignal) {
	const message = "Paste the token it printed (or one made by claude setup-token on any computer): ";
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
			if (value.length > 514) throw new RunnerError("Expected one Claude setup token of at most 512 characters.");
		}
		value = value.replace(/\r?\n$/, "");
	}
	if (value.length > 512 || !/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(value) || /\s/.test(value))
		throw new RunnerError("Expected one Claude setup token of at most 512 characters.");
	return value;
}

export async function changeClaudeLogin(machine: MachineDocker, login: boolean, signal: AbortSignal) {
	let token: string | undefined;
	if (login) {
		const pin = harnessImage("claude");
		if (!pin) throw new RunnerError("This runner was built without the Claude Code image.");
		console.log("This makes a Claude Code token for this machine with Anthropic's own sign-in (claude setup-token). " +
			"The token is kept in a Docker volume on this machine and is given only to Claude Code's containers. " +
			"The platform never receives it during sign-in, but the platform runs commands in those containers, so it could read it there.");
		if (process.stdin.isTTY) {
			if (!process.stdout.isTTY || !process.stderr.isTTY) throw new RunnerError("Attach a terminal to sign in interactively.");
			await machine.ensureImage(pin);
			// The CLI prints its token in the owner's attached terminal. Disable Docker log capture.
			const setup = spawnSync("docker", ["run", "--rm", "-it", "--log-driver", "none", "--pull", "never", "--network", "bridge",
				pin, "/opt/wlp-claude/node_modules/.bin/claude-agent-acp", "--cli", "setup-token"], { stdio: "inherit" });
			if (setup.status !== 0) console.log("Setup did not finish. You can paste a token made on another computer.");
		}
		token = await pastedToken(signal);
	}
	await machine.ensureImage();
	await withLoginVolume(machine, async () => {
		if (login) {
			// Browser approval can take minutes. A re-pair or removal during that time
			// must not install a new login for the former pairing.
			const pair = loadPair();
			if (!pair?.key || pair.current.machineId !== machine.identity.machineId || pair.current.uid !== machine.identity.uid)
				throw new RunnerError("The machine pairing changed during login. Run windlass-runner login claude again.");
		}
		if (!await machine.ownedVolume(login, machine.claudeVolume)) return;
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
		if (!login) await dropDetachedLoginVolume(machine);
	});
}

// Docker retains even a stopped container's volume reference. Logout unlinks the token
// immediately. The last Claude sandbox's removal drops the empty volume.
export async function dropDetachedLoginVolume(machine: MachineDocker) {
	const refs = await docker(["ps", "-aq", "--filter", "volume=" + machine.claudeVolume], { check: true });
	if (!refs.stdout.trim()) await machine.dropVolume(machine.claudeVolume);
}
