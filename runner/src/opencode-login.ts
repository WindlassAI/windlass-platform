import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { docker, helperFlags, runHelper, tmpName } from "../../server/src/sandbox/docker.js";
import { removeRelay, type ProviderLogin } from "./claude-relay.js";
import { pastedToken, setupFlags, withLoginVolume } from "./harness-login.js";
import { harnessImage, image, type MachineDocker } from "./policy.js";
import { loadPair, read, RunnerError, save } from "./state.js";

type Credential = { provider: "free" } | { provider: "anthropic" | "openai"; key: string } |
	{ provider: "chatgpt"; access: string; refresh: string; expires: number; accountId?: string };
const metadata = (m: MachineDocker) => "opencode-" + m.identity.machineId + ".json";

export function currentProvider(m: MachineDocker): ProviderLogin | undefined {
	const value = read(metadata(m));
	if (value == null) return;
	const login = value as ProviderLogin;
	if (!["chatgpt", "openai", "anthropic", "free"].includes(login.provider) || !/^[a-f0-9]{32}$/.test(login.generation))
		throw new RunnerError("Invalid OpenCode login metadata. Sign in again.");
	return login;
}

export async function installedProvider(m: MachineDocker) {
	const login = currentProvider(m);
	return login && await m.ownedVolume(false, m.opencodeVolume) ? login : undefined;
}

export async function storeProvider(m: MachineDocker, credential?: Credential) {
	await m.ensureImage();
	await withLoginVolume(m, async () => {
		const pair = loadPair();
		if (credential && (!pair?.key || pair.current.machineId !== m.identity.machineId || pair.current.uid !== m.identity.uid))
			throw new RunnerError("The pairing changed during OpenCode login. Sign in again.");
		// Stop the sole refresh writer before replacing or unlinking the credential.
		await removeRelay(m, "opencode");
		save(metadata(m), null);
		if (!await m.ownedVolume(!!credential, m.opencodeVolume)) return;
		if (!credential) { await m.dropVolume(m.opencodeVolume); return; }
		const login = { provider: credential.provider, generation: randomBytes(16).toString("hex") };
		const name = tmpName();
		const script = `set -eu
cd /login
chown 1000:1000 .
chmod 0700 .
umask 077
trap 'rm -f .incoming' EXIT
cat > .incoming
chown 1000:1000 .incoming
mv -fT .incoming login.json`;
		const stored = await runHelper([...helperFlags(name, "none"), ...m.pairingLabelFlags, "--pull", "never",
			"--log-driver", "none", "--user", "0", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
			"--mount", `type=volume,src=${m.opencodeVolume},dst=/login,volume-nocopy`], name,
			["sh", "-c", script], { image, stdin: JSON.stringify({ ...credential, ...login }) });
		if (stored.code !== 0) throw new RunnerError("Could not store the OpenCode login on this machine.");
		save(metadata(m), login);
	});
}

export async function terminalQuestion(prompt: string, signal: AbortSignal) {
	const lines = createInterface({ input: process.stdin, output: process.stdout });
	try { return (await lines.question(prompt, { signal })).trim(); }
	finally { lines.close(); }
}

async function deviceLogin(machine: MachineDocker, pin: string): Promise<Credential> {
	const name = tmpName();
	// Keep the setup home in RAM. The canonical login volume is never given to OpenCode.
	const id = (await docker(["run", "--rm", "-d", "--name", name, ...setupFlags(machine),
		"--tmpfs", "/login:rw,nosuid,nodev,mode=0700,uid=1000,gid=1000", "-e", "XDG_DATA_HOME=/login",
		pin, "sleep", "600"], { check: true })).stdout.trim();
	try {
		const result = spawnSync("docker", ["exec", "-it", id, "opencode", "auth", "login", "--provider", "openai",
			"--method", "ChatGPT Pro/Plus (headless)"], { stdio: "inherit" });
		if (result.status !== 0) throw new RunnerError("OpenCode device sign-in did not finish.");
		const file = await docker(["exec", id, "cat", "/login/opencode/auth.json"]);
		if (file.code === 0) {
			const a = JSON.parse(file.stdout).openai;
			if (a?.type === "oauth" && typeof a.access === "string" && a.access && typeof a.refresh === "string" && a.refresh && Number.isSafeInteger(a.expires))
				return { provider: "chatgpt", access: a.access, refresh: a.refresh, expires: a.expires,
					...(typeof a.accountId === "string" && { accountId: a.accountId }) };
		}
		throw new RunnerError("OpenCode did not return a ChatGPT login.");
	} finally {
		const removed = await docker(["rm", "-f", id]);
		if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) throw new RunnerError("Could not remove the OpenCode setup container.");
	}
}

export async function changeProviderLogin(machine: MachineDocker, login: boolean, signal: AbortSignal, method?: string) {
	if (!login) return storeProvider(machine);
	const pin = harnessImage("opencode");
	if (!pin) throw new RunnerError("This runner was built without the OpenCode image.");
	const provider = method ?? ((await terminalQuestion("OpenCode provider [chatgpt/openai/anthropic/free] (chatgpt): ", signal)) || "chatgpt");
	let record: Credential;
	if (provider === "chatgpt") {
		if (!process.stdin.isTTY) throw new RunnerError("Use an interactive terminal for device sign-in.");
		await machine.ensureImage(pin);
		record = await deviceLogin(machine, pin);
	} else if (provider === "openai" || provider === "anthropic") {
		record = { provider, key: await pastedToken(signal, provider) };
	} else if (provider === "free") record = { provider };
	else throw new RunnerError("Choose chatgpt, openai, anthropic or free.");
	signal.throwIfAborted();
	await storeProvider(machine, record);
}
