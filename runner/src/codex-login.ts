import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { docker, helperFlags, runHelper, tmpName } from "../../server/src/sandbox/docker.js";
import { commonRunFlags } from "../../server/src/sandbox/profiles.js";
import { removeRelay, type ProviderLogin } from "./claude-relay.js";
import { pastedToken, withLoginVolume } from "./harness-login.js";
import { terminalQuestion } from "./opencode-login.js";
import { waitForListener } from "./helper-ready.js";
import { harnessImage, image, type MachineDocker } from "./policy.js";
import { read, save, loadPair, RunnerError } from "./state.js";

declare const EGRESS_SOURCE: string;
type Credential =
	| { provider: "openai"; key: string }
	| { provider: "chatgpt"; access: string; refresh: string; accountId: string; expires: number };
const metadata = (m: MachineDocker) => "codex-" + m.identity.machineId + ".json";
const attemptFile = (m: MachineDocker) => "codex-attempt-" + m.identity.machineId + ".json";
export function codexLogin(m: MachineDocker): ProviderLogin | undefined {
	const login = read(metadata(m)) as ProviderLogin | null;
	if (login == null) return;
	if (
		(login.sessionGeneration !== undefined && !/^[a-f0-9]{32}$/.test(login.sessionGeneration)) ||
		login.harness !== "codex" ||
		!["openai", "chatgpt"].includes(login.provider) ||
		!/^[a-f0-9]{32}$/.test(login.generation)
	)
		throw new RunnerError("Invalid Codex login metadata. Log out and sign in again.");
	return login;
}

const verificationUrl = "https://auth.openai.com/codex/device";
export function devicePrompt() {
	let verified = false,
		printed = false;
	return (raw: string): string | undefined => {
		const line = stripVTControlCharacters(raw).trim();
		if (/https?:\/\//i.test(line)) {
			if (line !== verificationUrl) throw new RunnerError("Codex returned an unexpected verification URL.");
			verified = true;
		}
		if (/device (?:code|authentication).*not enabled|enable.*device.*(?:code|auth)/i.test(line))
			throw new RunnerError("Device login may need enabling by a workspace admin.");
		if (!printed && verified && /^[A-Z0-9]{4,5}-[A-Z0-9]{4,5}$/.test(line)) {
			printed = true;
			return verificationUrl + "\n" + line;
		}
	};
}
async function deviceCredential(m: MachineDocker, pin: string, signal: AbortSignal): Promise<Credential> {
	await m.ensureImage(pin);
	await m.ensureImage();
	const broker = tmpName(),
		setup = tmpName();
	const helper = (network: string) => [
		...commonRunFlags(1, network),
		...m.pairingLabelFlags,
		"--pull",
		"never",
		"--log-driver",
		"none",
	];
	const proxy = ["node", "--input-type=module", "-e", EGRESS_SOURCE, "--"];
	try {
		const brokerId = (
			await docker(
				[
					"run",
					"-d",
					"--rm",
					"--name",
					broker,
					...helper("bridge"),
					"-v",
					"/workspace",
					image,
					"timeout",
					"960",
					...proxy,
					"wlp-egress-device",
				],
				{ check: true },
			)
		).stdout.trim();
		await waitForListener(brokerId, "/workspace/egress.sock");
		const id = (
			await docker(
				[
					"run",
					"-d",
					"--rm",
					"--name",
					setup,
					...helper("none"),
					"--volumes-from",
					broker + ":ro",
					"--tmpfs",
					"/login:rw,nosuid,nodev,mode=0700,uid=1000,gid=1000",
					"-e",
					"CODEX_HOME=/login",
					"-e",
					"HTTPS_PROXY=http://127.0.0.1:17891",
					pin,
					"timeout",
					"950",
					...proxy,
					"wlp-egress-forward",
					"restricted",
				],
				{ check: true },
			)
		).stdout.trim();
		await waitForListener(id, "17891");
		const child = spawn(
			"docker",
			["exec", id, "codex", "-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"],
			{ signal, stdio: ["ignore", "pipe", "pipe"] },
		);
		const closed = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const parse = devicePrompt();
		let shown = false;
		const stream = async (output: NodeJS.ReadableStream) => {
			for await (const line of createInterface({ input: output })) {
				const prompt = parse(line);
				if (prompt) {
					console.log(prompt);
					shown = true;
				}
			}
		};
		const [code] = await Promise.all([closed, stream(child.stdout), stream(child.stderr)]);
		if (code !== 0 || !shown) throw new RunnerError("Codex device sign-in did not finish.");
		const file = await docker(["exec", id, "cat", "/login/auth.json"]);
		try {
			const t = JSON.parse(file.stdout).tokens;
			const expires = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64url").toString()).exp * 1000;
			if (
				file.code === 0 &&
				Number.isSafeInteger(expires) &&
				[t.access_token, t.refresh_token, t.account_id].every(
					(s) => typeof s === "string" && s.length && s.length < 32768,
				)
			)
				return {
					provider: "chatgpt",
					access: t.access_token,
					refresh: t.refresh_token,
					accountId: t.account_id,
					expires,
				};
		} catch {}
		throw new RunnerError("Codex did not return a ChatGPT login.");
	} finally {
		await docker(["rm", "-fv", setup]);
		await docker(["rm", "-fv", broker]);
	}
}

export async function changeCodexLogin(m: MachineDocker, signIn: boolean, signal: AbortSignal) {
	let credential: Credential | undefined;
	const attempt = randomBytes(16).toString("hex");
	await withLoginVolume(m, async () => save(attemptFile(m), attempt));
	if (signIn) {
		const pin = harnessImage("codex");
		if (!pin) throw new RunnerError("This runner was built without the Codex image.");
		if (!process.stdin.isTTY || !process.stdout.isTTY) throw new RunnerError("Attach a terminal to sign in to Codex.");
		const choice = await terminalQuestion("1) ChatGPT (device code)\n2) OpenAI API key\nChoose a method: ", signal);
		if (choice === "1") {
			if (process.env.WLP_CODEX_DEVICE_LOGIN !== "1")
				throw new RunnerError("ChatGPT device login is pending owner verification. Use an OpenAI API key.");
			credential = await deviceCredential(m, pin, signal);
		} else if (choice === "2") credential = { provider: "openai", key: await pastedToken(signal, "OpenAI") };
		else throw new RunnerError("Choose 1 or 2.");
	}
	await storeCodexLogin(m, credential, signal, attempt);
}

export async function storeCodexLogin(
	m: MachineDocker,
	credential?: Credential,
	signal?: AbortSignal,
	attempt?: string,
) {
	await withLoginVolume(m, async () => {
		signal?.throwIfAborted();
		if (attempt && read(attemptFile(m)) !== attempt)
			throw new RunnerError("A later login or logout superseded this Codex sign-in.");
		save(attemptFile(m), null);
		const pair = loadPair();
		if (
			credential &&
			(!pair?.key || pair.current.machineId !== m.identity.machineId || pair.current.uid !== m.identity.uid)
		)
			throw new RunnerError("The machine pairing changed during Codex login.");
		const previous = credential && codexLogin(m);
		await removeRelay(m, "codex");
		if (!credential) {
			save(metadata(m), null);
			await m.dropVolume(m.codexVolume);
			return;
		}
		await m.ensureImage();
		await m.ownedVolume(true, m.codexVolume);
		const name = tmpName();
		const generation = randomBytes(16).toString("hex");
		const result = await runHelper(
			[
				...helperFlags(name, "none"),
				...m.pairingLabelFlags,
				"--pull",
				"never",
				"--log-driver",
				"none",
				"--user",
				"0",
				"--cap-add",
				"CHOWN",
				"--cap-add",
				"FOWNER",
				"--cap-add",
				"DAC_OVERRIDE",
				"--mount",
				`type=volume,src=${m.codexVolume},dst=/login,volume-nocopy`,
			],
			name,
			[
				"sh",
				"-ec",
				'cd /login; chown 1000:1000 .; chmod 0700 .; umask 077; f=$(mktemp .incoming-XXXXXXXX); trap \'rm -f "$f"\' EXIT; cat > "$f"; chown 1000:1000 "$f"; chmod 0400 "$f"; mv -f "$f" login.json',
			],
			{
				image,
				stdin: JSON.stringify({
					...credential,
					generation,
					...(credential.provider === "chatgpt" &&
						process.env.WLP_CODEX_VERIFY_REFRESH === "1" && { verifyRefreshAfterTurn: true }),
				}),
			},
		);
		if (result.code !== 0) throw new RunnerError("Could not store the Codex login.");
		save(metadata(m), {
			harness: "codex",
			provider: credential.provider,
			generation,
			sessionGeneration: previous?.sessionGeneration ?? previous?.generation ?? generation,
		});
	});
}
