import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { docker, helperFlags, runHelper, tmpName } from "../../server/src/sandbox/docker.js";
import { removeRelay, type ProviderLogin } from "./claude-relay.js";
import { pastedToken, setupFlags, withLoginVolume } from "./harness-login.js";
import { harnessImage, image, type MachineDocker } from "./policy.js";
import { loadPair, read, RunnerError, save } from "./state.js";

import { pickProvider } from "./opencode-import.js";
import { supported, validLogin } from "./opencode-providers.js";

type Credential = { provider: "free" } | { provider: string; key: string } |
	{ provider: "chatgpt"; access: string; refresh: string; expires: number; accountId?: string };
const metadata = (m: MachineDocker) => "opencode-" + m.identity.machineId + ".json";

export function currentProvider(m: MachineDocker): ProviderLogin | undefined {
	const value = read(metadata(m));
	if (value == null) return;
	const login = value as ProviderLogin;
	if (!validLogin(login.provider) || (login.providers !== undefined && (!Array.isArray(login.providers) || !login.providers.includes(login.provider) || !login.providers.every(validLogin))) || !/^[a-f0-9]{32}$/.test(login.generation))
		throw new RunnerError("Invalid OpenCode login metadata. Sign in again.");
	return login;
}

export async function installedProvider(m: MachineDocker) {
	const login = currentProvider(m);
	return login && await m.ownedVolume(false, m.opencodeVolume) ? login : undefined;
}

const attemptFile = (m: MachineDocker) => "opencode-attempt-" + m.identity.machineId + ".json";

export async function beginProviderLogin(m: MachineDocker) {
	return withLoginVolume(m, async () => {
		const attempt = randomBytes(16).toString("hex");
		save(attemptFile(m), attempt);
		return attempt;
	});
}

export async function storeProvider(m: MachineDocker, credential?: Credential, attempt?: string) {
	await m.ensureImage();
	await withLoginVolume(m, async () => {
		if (attempt && read(attemptFile(m)) !== attempt)
			throw new RunnerError("A later login or logout superseded this OpenCode sign-in.");
		save(attemptFile(m), null);
		const pair = loadPair();
		if (credential && (!pair?.key || pair.current.machineId !== m.identity.machineId || pair.current.uid !== m.identity.uid))
			throw new RunnerError("The pairing changed during OpenCode login. Sign in again.");
		// Stop the sole refresh writer before replacing or unlinking the credential.
		if (!credential) {
			save(metadata(m), null);
			try { await removeRelay(m, "opencode"); }
			finally { await m.dropVolume(m.opencodeVolume); }
			return;
		}
		await removeRelay(m, "opencode");
		await m.ownedVolume(true, m.opencodeVolume);
		const login = { provider: credential.provider, generation: randomBytes(16).toString("hex") };
		const name = tmpName();
		const script = `set -eu
cd /login
chown 1000:1000 .
chmod 0700 .
umask 077
exec node -e "$1"`;
		// Only this helper reads existing credentials. Its stdout contains provider ids only.
		const merge = `const fs = require("node:fs");
const entry = JSON.parse(fs.readFileSync(0, "utf8"));
const {generation, ...credential} = entry;
let records = {};
try {
	const old = JSON.parse(fs.readFileSync("login.json", "utf8"));
	if (old.records) records = old.records;
	else { const {generation, ...single} = old; records[single.provider] = single; }
} catch (err) { if (err.code !== "ENOENT") throw err; }
const conflict = {chatgpt:"openai",openai:"chatgpt",free:"opencode",opencode:"free"}[entry.provider];
if (conflict) delete records[conflict];
records[entry.provider] = credential;
const tmp = ".incoming-" + generation;
try {
	fs.writeFileSync(tmp, JSON.stringify({generation,records}), {flag:"wx",mode:0o600});
	fs.chownSync(tmp,1000,1000);
	fs.renameSync(tmp,"login.json");
} finally { fs.rmSync(tmp,{force:true}); }
process.stdout.write(JSON.stringify(Object.keys(records))); `;

		const stored = await runHelper([...helperFlags(name, "none"), ...m.pairingLabelFlags, "--pull", "never",
			"--log-driver", "none", "--user", "0", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
			"--mount", `type=volume,src=${m.opencodeVolume},dst=/login,volume-nocopy`], name,
			["sh", "-c", script, "store-opencode", merge], { image, stdin: JSON.stringify({ ...credential, ...login }) });
		if (stored.code !== 0) throw new RunnerError("Could not store the OpenCode login on this machine.");
		const providers = JSON.parse(stored.stdout);
		if (!Array.isArray(providers) || !providers.includes(login.provider) || !providers.every(validLogin))
			throw new RunnerError("Could not confirm the stored OpenCode providers.");
		save(metadata(m), { ...login, providers });
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
	const attempt = await beginProviderLogin(machine);
	const provider = method ?? await pickProvider(prompt => terminalQuestion(prompt, signal));
	let record: Credential;
	if (provider === "chatgpt") {
		if (!process.stdin.isTTY) throw new RunnerError("Use an interactive terminal for device sign-in.");
		await machine.ensureImage(pin);
		record = await deviceLogin(machine, pin);
	} else if (supported(provider)) {
		if (provider === "opencode-go") console.log("Use the API key issued for your OpenCode Go subscription.");
		record = { provider, key: await pastedToken(signal, provider) };
	} else if (provider === "free") record = { provider };
	else throw new RunnerError("Unknown OpenCode provider. Run login opencode to search the provider list.");
	signal.throwIfAborted();
	await storeProvider(machine, record, attempt);
}
