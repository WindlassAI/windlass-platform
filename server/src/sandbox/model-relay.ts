/**
 * Windlass's model relay on a Docker daemon (docs/model-relay.md): one relay container per daemon scope
 * (the hosted server's, or one machine's runner), and one forwarder container per running turn in that
 * turn's session container's network namespace.
 *
 *   relay      wlp-model-relay[-<machine>]: `sandbox/relay/windlass.cjs` from the pinned base image, as
 *              agent, read-only, no capabilities, no logs, on the bridge (its route to api.openai.com).
 *              Its tokens are in its own tmpfs, `/run/wlp-model/tokens/<nonce>.json`, written with
 *              `docker exec -i` and the content on standard input; its socket in the volume
 *              wlp-model-socket[-<machine>], which only the relay and the forwarders mount.
 *   forwarder  wlp-model-fwd-<sandbox>: `wlp-model-forward <nonce>` of runner/src/egress-proxy.mjs, with
 *              `--network container:<session>`, so it listens on the session's 127.0.0.1:17893 and is
 *              in none of its other namespaces. It prefixes each connection with the turn's nonce. It
 *              says it holds the port in a tmpfs of its own; a session process that took the port
 *              first makes it exit, and the turn fails instead of talking to that process.
 *
 * The session gets `WINDLASS_MODEL_BASE_URL=http://127.0.0.1:17893/v1` and a token file that holds
 * `wlp-model.<32 hex>`, a bearer the relay takes only on that turn's connections and only while the
 * turn's file is in its tmpfs. `close` removes both, and the relay stops the turn's requests still
 * running. What a process that died left behind (forwarders, files of leases that are gone) `sweep`
 * removes when the server or the runner starts; the relay deletes a file whose token expired itself.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessToken } from "./api.js";
import { LABEL, LABEL_ARG, MACHINE_LABEL, NO_LOGS, docker } from "./docker.js";
import { SECRET_FILE_SCRIPT, type TurnModelRelay } from "./provider.js";

declare const WINDLASS_RELAY_SCRIPT: string;
declare const EGRESS_SOURCE: string;

/** Where Windlass in the session sends its model requests. */
export const MODEL_RELAY_URL = "http://127.0.0.1:17893/v1";
const ROLE = `${LABEL}.model-relay`;
const VERSION = `${ROLE}-version`;
/** On a forwarder: the nonce of its turn, so the turn's file can be found when the lease's holder is gone. */
const NONCE_LABEL = `${ROLE}-nonce`;
const TOKENS = "/run/wlp-model/tokens";
/** runner/src/egress-proxy.mjs `MODEL_FORWARD_READY`. */
const FORWARD_READY_DIR = "/run/wlp-model/ready";
const FORWARD_READY = `${FORWARD_READY_DIR}/listening`;
/** The hosted relay's ceiling for the whole deployment, when WLP_MODEL_RELAY_REQUESTS does not name one. */
export const HOSTED_RELAY_REQUESTS = 64;
/** The hosted relay's ceiling per user, the E2B route's (relay-leases.ts `ROUTE_LIMITS.userRequests`). */
export const HOSTED_RELAY_USER_REQUESTS = 16;
export { MODEL_RELAY_WINDLASS } from "../model-relay-url.js";
/** The relay container's memory; scripts/model-relay-docker-check.ts runs 64 streams in it. */
export const RELAY_MEMORY = "192m";

const root = () => join(import.meta.dirname, "..", "..", "..");
/** The relay program, with the shared relay it requires, as one script for `node -e`. The runner's bundle has it built. */
export function relayScript(): string {
	if (typeof WINDLASS_RELAY_SCRIPT === "string") return WINDLASS_RELAY_SCRIPT;
	const read = (name: string) => readFileSync(join(root(), "sandbox", "relay", name), "utf8");
	return [
		"const __require = require;",
		`const __server = (() => { const module = { exports: {} }; const exports = module.exports; ${read("server.cjs")}\n; return module.exports; })();`,
		`(() => { const module = { exports: {} }; const exports = module.exports; const require = (id) => id === "./server.cjs" ? __server : __require(id); ${read("windlass.cjs")}\n})();`,
	].join("\n");
}
function forwarderScript(): string {
	return typeof EGRESS_SOURCE === "string" ? EGRESS_SOURCE : readFileSync(join(root(), "runner", "src", "egress-proxy.mjs"), "utf8");
}

const READY = `
const net = require("node:net");
const { existsSync } = require("node:fs");
const deadline = Date.now() + 8000;
const address = process.argv[1].startsWith("/") ? { path: process.argv[1] } : { host: "127.0.0.1", port: Number(process.argv[1]) };
const marker = process.argv[2];
function probe() {
	if (marker && !existsSync(marker)) return retry();
	const socket = net.connect(address);
	socket.once("connect", () => socket.end());
	socket.on("error", retry);
}
function retry() { if (Date.now() >= deadline) process.exit(1); setTimeout(probe, 50); }
probe();`;
/** Waits, inside the helper's own namespaces, until it listens (and, with `marker`, until it said so itself). */
async function waitForListener(id: string, address: string, marker?: string): Promise<void> {
	const result = await docker(["exec", id, "node", "-e", READY, address, ...(marker ? [marker] : [])], { timeoutMs: 15_000 });
	if (result.code !== 0) throw new Error(`the model relay helper did not start listening (${result.stderr.trim() || `exit ${result.code}`})`);
}

export interface DockerModelRelayOptions {
	/** The machine id of a runner's relay; "" for the hosted server's. Every container and volume carries it as MACHINE_LABEL. */
	machine: string;
	/** The pinned base image: it has node, and the agent user. */
	image: string;
	/** More labels for every container and volume (a runner's pairing). */
	labelFlags?: string[];
	/** The relay's ceiling of requests in flight for its whole scope (`limits.machineRequests`). */
	requests?: number;
	/** Its ceiling per user (`limits.userRequests`): the hosted relay serves every user of the deployment. None on a machine, which serves one. */
	userRequests?: number;
	/** Called before a container is made, so that the image is there. */
	ensureImage?: () => Promise<void>;
	/** The relay's own checks: another network than the bridge, an upstream other than api.openai.com, other caps. */
	network?: string;
	upstream?: string;
	limits?: Record<string, number>;
}

/** The turn's relay as a turn of a Docker sandbox has it. */
export interface DockerTurnRelay extends TurnModelRelay {
	/** The turn's nonce: what its forwarder writes, and its token file's name in the relay. */
	readonly nonce: string;
}

export class DockerModelRelay {
	private readonly suffix: string;
	private ensuring: Promise<string> | null = null;
	/** The leases this process opened and has not closed, by sandbox: what `endSandbox` closes. */
	private readonly open_ = new Map<string, DockerTurnRelay>();

	constructor(private readonly options: DockerModelRelayOptions) {
		if (options.machine !== "" && !/^[A-Za-z0-9_-]+$/.test(options.machine)) throw new Error("invalid machine id");
		this.suffix = options.machine === "" ? "" : `-${options.machine}`;
	}

	get relayName(): string {
		return `wlp-model-relay${this.suffix}`;
	}
	get socketVolume(): string {
		return `wlp-model-socket${this.suffix}`;
	}
	forwarderName(sandbox: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(sandbox)) throw new Error("invalid sandbox id");
		return `wlp-model-fwd-${sandbox}`;
	}

	private labels(role: "relay" | "forward" | "socket"): string[] {
		return ["--label", LABEL_ARG, ...(this.options.machine ? ["--label", `${MACHINE_LABEL}=${this.options.machine}`] : []), ...(this.options.labelFlags ?? []), "--label", `${ROLE}=${role}`];
	}

	/** Labels of a container or volume of this scope with that role; anything else of that name is not this relay's to touch. */
	private owned(labels: Record<string, string> | null | undefined, role: string): boolean {
		if (labels?.[LABEL] !== "1" || labels[ROLE] !== role || (labels[MACHINE_LABEL] ?? "") !== this.options.machine) return false;
		const extra = this.options.labelFlags ?? [];
		for (let i = 0; i + 1 < extra.length; i += 2) {
			const at = extra[i + 1].indexOf("=");
			const [key, value] = at < 0 ? [extra[i + 1], ""] : [extra[i + 1].slice(0, at), extra[i + 1].slice(at + 1)];
			if (labels[key] !== value) return false;
		}
		return true;
	}

	private async inspect(name: string): Promise<{ id: string; running: boolean; labels: Record<string, string> } | null> {
		const result = await docker(["container", "inspect", "--format", "{{.Id}}|{{.State.Running}}|{{json .Config.Labels}}", name], { timeoutMs: 15_000 });
		if (result.code !== 0) {
			if (/no such (container|object)/i.test(result.stderr)) return null;
			throw new Error("Docker could not inspect the model relay.");
		}
		const [id, running, json] = result.stdout.trim().split("|");
		return { id, running: running === "true", labels: JSON.parse(json || "{}") ?? {} };
	}

	private version(): string {
		const { image, requests, userRequests, network, upstream, limits } = this.options;
		return createHash("sha256").update(relayScript()).update(JSON.stringify([image, requests ?? null, userRequests ?? null, network ?? null, upstream ?? null, limits ?? null, RELAY_MEMORY])).digest("hex");
	}

	/** The relay is running, with this program: its container id. One at a time in this process. */
	ensure(): Promise<string> {
		this.ensuring ??= this.ensureOnce().finally(() => (this.ensuring = null));
		return this.ensuring;
	}

	private async ensureOnce(): Promise<string> {
		const version = this.version();
		let box = await this.inspect(this.relayName);
		if (box && !this.owned(box.labels, "relay")) throw new Error("The model relay's container name belongs to another container.");
		if (box && (box.labels[VERSION] !== version || !box.running)) {
			// Another program or a stopped one: its tokens went with its tmpfs. Turns that used it get a 401 and end.
			await docker(["rm", "-f", box.id], { timeoutMs: 30_000, check: true });
			box = null;
		}
		if (box) return box.id;
		await this.options.ensureImage?.();
		await this.ensureVolume();
		const limits = { ...(this.options.limits ?? {}), ...(this.options.requests ? { machineRequests: this.options.requests } : {}), ...(this.options.userRequests ? { userRequests: this.options.userRequests } : {}) };
		const run = await docker([
			"run", "-d", "--pull", "never", "--name", this.relayName, ...this.labels("relay"), "--label", `${VERSION}=${version}`,
			"--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", ...NO_LOGS,
			"--memory", RELAY_MEMORY, "--pids-limit", "48", "--restart", "no",
			"--network", this.options.network ?? "bridge",
			"--mount", `type=volume,src=${this.socketVolume},dst=/workspace`,
			"--tmpfs", `${TOKENS}:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=4m`,
			"-e", "WLP_MODEL_RELAY_PROGRAM=1",
			...(Object.keys(limits).length ? ["-e", `WLP_MODEL_RELAY_LIMITS=${JSON.stringify(limits)}`] : []),
			...(this.options.upstream ? ["-e", `WLP_MODEL_RELAY_UPSTREAM=${this.options.upstream}`] : []),
			this.options.image, "node", "-e", relayScript(),
		], { timeoutMs: 120_000 });
		if (run.code !== 0) {
			// Another server process made it at the same moment: use that one when it is this program.
			const other = await this.inspect(this.relayName);
			if (other && this.owned(other.labels, "relay") && other.labels[VERSION] === version && other.running) return other.id;
			throw new Error(`could not start the model relay: ${run.stderr.trim() || `exit ${run.code}`}`);
		}
		const id = run.stdout.trim();
		try {
			await waitForListener(id, "/workspace/relay.sock");
		} catch (error) {
			await docker(["rm", "-f", id], { timeoutMs: 30_000 });
			throw error;
		}
		return id;
	}

	private async ensureVolume(): Promise<void> {
		const inspected = await docker(["volume", "inspect", "--format", "{{json .Labels}}", this.socketVolume], { timeoutMs: 15_000 });
		if (inspected.code === 0) {
			if (!this.owned(JSON.parse(inspected.stdout.trim() || "{}"), "socket")) throw new Error("The model relay's socket volume belongs to someone else.");
			return;
		}
		const made = await docker(["volume", "create", ...this.labels("socket"), this.socketVolume], { timeoutMs: 30_000 });
		if (made.code !== 0 && (await docker(["volume", "inspect", this.socketVolume], { timeoutMs: 15_000 })).code !== 0)
			throw new Error(`could not create the model relay's socket volume: ${made.stderr.trim()}`);
	}

	/**
	 * A lease for one turn of `sandbox`, whose container is `container` and running: the relay is there,
	 * the turn's forwarder listens in the container's namespace, and nothing is in the relay for it yet.
	 */
	async open(container: string, sandbox: string, user?: string): Promise<DockerTurnRelay> {
		const relay = await this.ensure();
		const nonce = randomBytes(16).toString("hex");
		const placeholder = `wlp-model.${randomBytes(16).toString("hex")}`;
		const name = this.forwarderName(sandbox);
		await this.endSandbox(sandbox);
		const started = await docker([
			"run", "-d", "--pull", "never", "--name", name, ...this.labels("forward"), "--label", `${NONCE_LABEL}=${nonce}`,
			"--network", `container:${container}`, "--user", "agent", "--cap-drop", "ALL", "--read-only",
			"--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "64m", "--cpus", "0.25", "--restart", "no", ...NO_LOGS,
			"--mount", `type=volume,src=${this.socketVolume},dst=/run/wlp-model/socket,readonly,volume-nocopy`,
			"--tmpfs", `${FORWARD_READY_DIR}:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=16k`,
			this.options.image, "node", "--input-type=module", "-e", forwarderScript(), "--", "wlp-model-forward", nonce,
		], { timeoutMs: 60_000 });
		if (started.code !== 0) throw new Error(`could not start the model relay's forwarder: ${started.stderr.trim() || `exit ${started.code}`}`);
		const id = started.stdout.trim();
		try {
			await waitForListener(id, "17893", FORWARD_READY);
			// The probe connects to whatever listens on the session's 127.0.0.1:17893. Only a forwarder that is
			// still running, and that said it holds the port, is the one it reached.
			const box = await this.inspect(id);
			if (!box?.running) throw new Error("the model relay's forwarder could not take 127.0.0.1:17893 in the session: a process in the sandbox may be holding that port. Stop it, or send the prompt again");
		} catch (error) {
			await docker(["rm", "-f", id], { timeoutMs: 30_000 });
			if (error instanceof Error && /did not start listening/.test(error.message))
				throw new Error(`the model relay's forwarder did not start listening on 127.0.0.1:17893 in the session (a process in the sandbox may be holding that port): ${error.message}`);
			throw error;
		}
		const file = `${TOKENS}/${nonce}.json`;
		let closed = false;
		const lease: DockerTurnRelay = {
			nonce,
			placeholder,
			env: { WINDLASS_MODEL_BASE_URL: MODEL_RELAY_URL },
			hand: async (token: AccessToken) => {
				if (closed) throw new Error("the turn's model relay lease has ended");
				const content = JSON.stringify({ accessToken: token.accessToken, expiresAt: token.expiresAt, lease: placeholder, ...(user !== undefined && { user }) });
				const result = await docker(["exec", "-i", "-u", "1000:1000", relay, "sh", "-c", SECRET_FILE_SCRIPT, "sh", file], { stdin: content, timeoutMs: 30_000 });
				// What `sh` says names the path, never the content.
				if (result.code !== 0) throw new Error(`could not hand the model relay the turn's token: ${result.timedOut ? "timed out" : result.stderr.trim() || `exit ${result.code}`}`);
			},
			// The file first: the relay then stops the turn's requests still running, and the forwarder's removal ends its connections.
			close: async () => {
				closed = true;
				if (this.open_.get(sandbox) === lease) this.open_.delete(sandbox);
				await this.removeFiles(relay, [nonce]);
				await docker(["rm", "-f", id], { timeoutMs: 30_000 }).catch(() => undefined);
			},
		};
		this.open_.set(sandbox, lease);
		return lease;
	}

	/** Removes the files of these nonces from the relay's tmpfs. Never rejects. */
	private async removeFiles(relay: string, nonces: string[]): Promise<void> {
		const paths = nonces.filter((n) => /^[a-f0-9]{32}$/.test(n)).flatMap((n) => [`${TOKENS}/${n}.json`, `${TOKENS}/${n}.json.tmp`]);
		if (paths.length) await docker(["exec", "-u", "1000:1000", relay, "rm", "-f", "--", ...paths], { timeoutMs: 15_000 }).catch(() => undefined);
	}

	/**
	 * Ends whatever lease `sandbox` has: its turn's file in the relay and its forwarder, also one left by a
	 * process that is gone (the forwarder names its nonce). For a sandbox that stops or goes, and before a
	 * new lease of it.
	 */
	async endSandbox(sandbox: string): Promise<void> {
		const held = this.open_.get(sandbox);
		if (held) await held.close();
		const box = await this.inspect(this.forwarderName(sandbox)).catch(() => null);
		if (!box || !this.owned(box.labels, "forward")) return;
		const relay = await this.inspect(this.relayName).catch(() => null);
		const nonce = box.labels[NONCE_LABEL];
		if (relay?.running && this.owned(relay.labels, "relay") && nonce) await this.removeFiles(relay.id, [nonce]);
		await docker(["rm", "-f", box.id], { timeoutMs: 30_000 });
	}

	/** `endSandbox`, as the stopping and removal of a sandbox call it. */
	removeForwarder(sandbox: string): Promise<void> {
		return this.endSandbox(sandbox);
	}

	/**
	 * What a server or runner that died left: every forwarder of this scope, and every file in the relay. At
	 * its start no lease of this scope is live, since each is held by the process that opened it (with one
	 * server process per Docker daemon, and one runner per machine). Returns how many forwarders it removed.
	 */
	async sweep(): Promise<number> {
		const listed = await docker(["ps", "-aq", "--no-trunc", "--filter", `label=${ROLE}=forward`], { timeoutMs: 15_000 });
		let removed = 0;
		for (const id of listed.code === 0 ? listed.stdout.split(/\s+/).filter(Boolean) : []) {
			const box = await this.inspect(id).catch(() => null);
			if (!box || !this.owned(box.labels, "forward") || [...this.open_.values()].some((lease) => lease.nonce === box.labels[NONCE_LABEL])) continue;
			if ((await docker(["rm", "-f", box.id], { timeoutMs: 30_000 })).code === 0) removed += 1;
		}
		const relay = await this.inspect(this.relayName).catch(() => null);
		if (relay?.running && this.owned(relay.labels, "relay")) {
			const live = [...this.open_.values()].map((lease) => `${lease.nonce}.json`);
			// Every file but those of the leases this process holds now.
			const script = `cd ${TOKENS} && for f in *; do [ -e "$f" ] || continue; case " $* " in *" $f "*) ;; *) rm -f -- "$f" ;; esac; done`;
			await docker(["exec", "-u", "1000:1000", relay.id, "sh", "-c", script, "sh", ...live], { timeoutMs: 30_000 }).catch(() => undefined);
		}
		return removed;
	}
}
