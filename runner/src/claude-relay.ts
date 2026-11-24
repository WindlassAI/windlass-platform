import { providers } from "./opencode-providers.js";
import { createHash, createPublicKey, randomBytes, sign } from "node:crypto";
import { docker, helperFlags, LABEL, LABEL_ARG, RELAY_LOGS, runHelper, tmpName } from "../../server/src/sandbox/docker.js";
import { waitForListener } from "./helper-ready.js";
import { image, type MachineHarness, type MachineDocker } from "./policy.js";
import { loadPair, Refusal, RunnerError } from "./state.js";

declare const CLAUDE_RELAY_SCRIPT: string;
declare const CODEX_RELAY_SCRIPT: string;
declare const OPENCODE_RELAY_SCRIPT: string;
export interface ProviderLogin { harness?: "codex"; provider: string; providers?: string[]; generation: string; sessionGeneration?: string }
// Pre-upgrade metadata used its credential generation as the signing epoch.
const sessionDomain = (login: ProviderLogin) => "windlass-" + (login.harness ?? "opencode") + "-relay-v1-" + (login.sessionGeneration ?? login.generation);
export function projection(selected: string | string[], placeholder: string) {
	const ids = typeof selected === "string" ? [selected] : selected;
	const auth: Record<string, unknown> = {}, config: Record<string, unknown> = {};
	for (const selected of ids) {
		const id = selected === "free" ? "opencode" : selected === "chatgpt" ? "openai" : selected;
		const route = selected === "chatgpt" ? "openai" : selected;
		const p = providers[id];
		config[id] = {
			options: { baseURL: relayUrl + "/" + route, ...(selected === "free" && { headers: { authorization: "Bearer " + placeholder } }) },
			...(p?.blocked && { blacklist: p.blocked }),
			...(p?.variants && { models: Object.fromEntries(Object.keys(p.variants).map(model => [model, {headers: {"x-wlp-route":model}}])) }),
		};
		if (selected !== "free") auth[id] = selected === "chatgpt" ? { type:"oauth", refresh:"", access:placeholder, expires:Number.MAX_SAFE_INTEGER }
			: { type:"api", key:placeholder };
	}
	return ["-e", "WLP_OPENCODE_PROVIDER=" + ids.join(","), "-e", "WLP_SESSION_BEARER=" + placeholder,
		"-e", "OPENCODE_AUTH_CONTENT=" + JSON.stringify(auth),
		"-e", "OPENCODE_CONFIG_CONTENT=" + JSON.stringify({ enabled_providers:Object.keys(config), provider:config })];
}
const role = LABEL + ".credential-relay";
export const relaySocketVolume = (m: MachineDocker, harness: MachineHarness = "claude") => "wlp-" + harness + "-socket-" + m.identity.machineId;
export const relayUrl = "http://127.0.0.1:17892";
const relayName = (m: MachineDocker, harness: MachineHarness) => "wlp-" + harness + "-relay-" + m.identity.machineId;
const flags = (m: MachineDocker) => ["--label", LABEL_ARG, ...m.pairingLabelFlags, "--label", role + "=1"];

function owned(labels: Record<string, string> | null, m: MachineDocker) {
	return labels?.[LABEL] === "1" && labels[role] === "1" && Object.entries(m.labels).every(([k, v]) => labels[k] === v);
}

// A missing object is normal. A daemon or permissions failure must never authorize adoption.
async function inspect(name: string) {
	const result = await docker(["container", "inspect", name], { timeoutMs: 15_000 });
	if (result.code === 0) return JSON.parse(result.stdout)[0];
	if (/no such (container|object)/i.test(result.stderr)) return;
	throw new RunnerError("Docker could not inspect the credential relay.");
}

async function ownedRelay(m: MachineDocker, harness: MachineHarness) {
	const box = await inspect(relayName(m, harness));
	if (box && !owned(box.Config.Labels, m)) throw new Refusal("The credential relay container belongs to a different pairing.");
	return box;
}

/**
 * The relay's latest notes about answers it did not pass on as the provider gave them (sandbox/relay/server.cjs
 * `notesFile`). Only the fields the relay writes, as short printable text.
 */
export async function relayNotes(m: MachineDocker, harness: MachineHarness, latest = 3): Promise<string[]> {
	const box = await ownedRelay(m, harness).catch(() => undefined);
	if (!box?.State?.Running) return [];
	// Copied out as a tar stream, never run in the relay (status starts and runs nothing: runner-check.ts). One file, so one header.
	const read = await docker(["cp", box.Id + ":/workspace/relay-notes.json", "-"], { timeoutMs: 15_000 });
	if (read.code !== 0 || read.stdout.length < 512) return [];
	const size = Number.parseInt(read.stdout.slice(124, 136).replace(/\0/g, "").trim(), 8);
	if (!Number.isSafeInteger(size) || size <= 0 || size > 65_536) return [];
	let notes: unknown;
	try { notes = JSON.parse(read.stdout.slice(512, 512 + size)); } catch { return []; }
	if (!Array.isArray(notes)) return [];
	const field = (value: unknown) => (typeof value === "string" || typeof value === "number") && /^[A-Za-z0-9 ./;=_+:,-]{0,120}$/.test(String(value)) ? String(value) : "?";
	return notes.slice(-latest).filter(note => note && typeof note === "object").map((note: Record<string, unknown>) =>
		[field(note.at), field(note.event), field(note.route), note.upstream !== undefined ? `upstream ${field(note.upstream)}, content-type ${field(note.contentType)}` : `error ${field(note.error)}`,
			note.passedAs !== undefined ? `passed as ${field(note.passedAs)}` : `answered ${field(note.answered)}`].join("  "));
}

// Call under the login lock, including logout from a standalone runner command.
/** `signedOut` for a logout: sessions are then told signed out, not to try again (sandbox/relay/server.cjs SIGNED_OUT). */
export async function removeRelay(m: MachineDocker, harness: MachineHarness = "claude", signedOut = false) {
	const box = await ownedRelay(m, harness);
	const mark = signedOut && harness !== "claude";
	// Written by the relay's own user into its socket volume, before the relay stops answering.
	const marked = mark && box?.State?.Running === true &&
		(await docker(["exec", box.Id, "touch", SIGNED_OUT_MARKER], { timeoutMs: 15_000 })).code === 0;
	if (box) await retireRelay(box.Id, harness);
	if (mark && !marked) await markSignedOut(m, harness);
}
const SIGNED_OUT_MARKER = "/workspace/signed-out";
/** The marker without a running relay: a short container of the pinned base image, as the relay's user, on the socket volume. */
async function markSignedOut(m: MachineDocker, harness: MachineHarness) {
	const volume = relaySocketVolume(m, harness);
	// Without the volume no session can reach a relay; there is no one to tell.
	if (!await m.ownedVolume(false, volume)) return;
	const name = tmpName();
	const result = await runHelper([...helperFlags(name, "none"), ...m.pairingLabelFlags, "--pull", "never", "--user", "1000:1000", "--read-only",
		"--mount", `type=volume,src=${volume},dst=/workspace,volume-nocopy`], name, ["touch", SIGNED_OUT_MARKER], { image, timeoutMs: 30_000 });
	if (result.code !== 0) throw new RunnerError(`Could not tell ${harness === "codex" ? "Codex" : "OpenCode"} sessions they are signed out: ${result.stderr.trim() || "exit " + result.code}.`);
}
/**
 * A relay that refreshes a login saves a refresh already sent before it exits on SIGTERM, since that
 * refresh spent the old refresh token (sandbox/relay/server.cjs stopOnSignal). Its token request
 * times out after 20 s, so give it that and the write before Docker kills it.
 */
export const RELAY_STOP_SECONDS = 30;
async function retireRelay(id: string, harness: MachineHarness) {
	if (harness !== "claude") await docker(["stop", "-t", String(RELAY_STOP_SECONDS), id], { timeoutMs: (RELAY_STOP_SECONDS + 15) * 1000 });
	await docker(["rm", "-f", id], { check: true });
}
// The old image gave every session a volume reference. Preserve its workspace, but stop
// the process before replacing the token. Docker cannot detach a container's volume.
export async function stopLegacyClaude(m: MachineDocker) {
	const running = await docker(["ps", "-q", "--filter", "volume=" + m.claudeVolume, "--filter", "label=" + LABEL + ".harness=claude", "--filter", "label=" + LABEL + ".session",
		...Object.entries(m.labels).flatMap(([k, v]) => ["--filter", "label=" + k + "=" + v])], { check: true });
	for (const id of running.stdout.trim().split(/\s+/).filter(Boolean))
		await docker(["stop", "-t", "1", id], { check: true });
}

/** Caller holds the pairing login lock through credential and relay setup. */
export async function ensureRelay(m: MachineDocker, login?: ProviderLogin) {
	const harness = login ? login.harness ?? "opencode" : "claude";
	const script = harness === "codex" ? CODEX_RELAY_SCRIPT : login ? OPENCODE_RELAY_SCRIPT : CLAUDE_RELAY_SCRIPT;
	const prefix = harness === "codex" ? "WLP_CODEX_RELAY_" : login ? "WLP_OPENCODE_RELAY_" : "WLP_CLAUDE_RELAY_";
	const credentials = harness === "codex" ? m.codexVolume : login ? m.opencodeVolume : m.claudeVolume;
	const pair = loadPair();
	if (!pair?.key || pair.current.machineId !== m.identity.machineId || pair.current.uid !== m.identity.uid)
		throw new Refusal("The machine pairing changed while preparing the credential relay.");
	if (!await m.ownedVolume(!login, credentials)) throw new Refusal(`Run windlass-runner login ${harness} on this machine.`);
	await m.ensureImage();
	const socketVolume = relaySocketVolume(m, harness);
	await m.ownedVolume(true, socketVolume);
	const version = createHash("sha256").update(script).update(JSON.stringify(login ?? null)).update(JSON.stringify(RELAY_LOGS)).digest("hex");
	const publicKey = createPublicKey(pair.key).export({ format: "der", type: "spki" }).toString("base64");
	let box = await ownedRelay(m, harness);
	if (box && (box.Config.Labels[role + ".version"] !== version || box.Config.Image !== image ||
		!box.Config.Env.includes(prefix + "PUBLIC_KEY=" + publicKey))) {
		await retireRelay(box.Id, harness); box = undefined;
	}
	if (!box) {
		await docker(["create", "--pull", "never", "--name", relayName(m, harness), ...flags(m), "--label", role + ".version=" + version,
			"--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
			...RELAY_LOGS, "--memory", "192m", "--pids-limit", "48",
			"--network", "bridge", "--mount", `type=volume,src=${socketVolume},dst=/workspace`,
			"--mount", `type=volume,src=${credentials},dst=/run/wlp-harness/${harness},${login ? "" : "readonly,"}volume-nocopy`,
			"-e", prefix + "PUBLIC_KEY=" + publicKey, "-e", prefix + "MACHINE=" + m.identity.machineId,
			...(login?.harness === "codex" ? ["-e", "WLP_CODEX_SESSION_DOMAIN=" + sessionDomain(login), "-e", "WLP_CODEX_GENERATION=" + login.generation, "-e", "WLP_CODEX_PROVIDER=" + login.provider] : login ? ["-e", "WLP_OPENCODE_SESSION_DOMAIN=" + sessionDomain(login), "-e", "WLP_OPENCODE_GENERATION=" + login.generation, "-e", "WLP_OPENCODE_PROVIDER=" + (login.providers ?? [login.provider]).join(",")] : []),
			image, "node", "-e", script], { check: true });
		box = await ownedRelay(m, harness);
	}
	if (!box.State.Running) {
		await docker(["start", box.Id], { check: true });
		try { await waitForListener(box.Id, "/workspace/relay.sock"); }
		catch (error) { await docker(["rm", "-f", box.Id], { check: true }); throw error; }
	}
	return pair.key;
}

export async function prepareRelay(m: MachineDocker, login?: ProviderLogin, nonce = randomBytes(16).toString("hex")) {
	const key = await ensureRelay(m, login);
	const domain = login ? sessionDomain(login) : "windlass-claude-relay-v2";
	if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Refusal("Invalid session relay nonce.");
	const signature = sign(null, Buffer.from(domain + "\n" + m.identity.machineId + "\n" + nonce), key);
	return {
		env: login?.harness === "codex" ? ["-e", "WLP_SESSION_BEARER=" + nonce + "." + signature.toString("base64url")] : login ? projection(login.providers ?? login.provider, nonce + "." + signature.toString("base64url")) : ["-e", "ANTHROPIC_BASE_URL=" + relayUrl, "-e", "CLAUDE_CODE_OAUTH_TOKEN=" + nonce + "." + signature.toString("base64url")],
		nonce,
	};
}
