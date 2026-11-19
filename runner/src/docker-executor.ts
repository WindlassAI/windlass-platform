import { MAX_REPORTED_SANDBOXES, type Report } from "../../server/src/runner/control.js";
import { type Operation } from "../../server/src/runner/protocol.js";
import { LABEL, LABEL_ARG, docker } from "../../server/src/sandbox/docker.js";
import { BWRAP_PROBE, NAME } from "../../server/src/sandbox/provider.js";
import { containerName, DockerSandboxes, DockerSandboxHandle } from "../../server/src/sandbox/sandboxes.js";
import { tokenFilePath } from "../../server/src/sandbox/token-file.js";
import { audit, safeSentence } from "./audit.js";
import { bubblewrap, externalId, image, MachineDocker, rawId, type Limits, type Profile } from "./policy.js";
import { Refusal, RunnerError, type Identity } from "./state.js";

type Lifecycle = Extract<Operation, { name: "connect" | "state" | "suspend" | "destroy" }>;
export interface Box { raw: string; sessionId: string; state: "running" | "paused"; profile: Profile; usedAt: number; busy: number }

export class Executor extends MachineDocker {
	readonly provider: DockerSandboxes;
	readonly boxes = new Map<string, Box>();
	private pending: Promise<unknown> = Promise.resolve();
	private ready = false;
	private commandSandbox: Report["commandSandbox"] = { ok: false, reason: "The Windlass sandbox probe has not run." };
	private freeDiskBytes: number | null = null;

	constructor(identity: Identity, private readonly limits: Limits) {
		super(identity);
		this.provider = new DockerSandboxes({ machine: identity.machineId, image, dataVolume: async () => {
			await this.ownedVolume(true);
			return this.volume;
		} });
	}
	// Count, reserve and change a container under one ordering, including idle stops and prune.
	serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.pending.then(work);
		this.pending = next.catch(() => {});
		return next;
	}
	private filters() {
		return [LABEL_ARG, ...Object.entries(this.labels).map(([k, v]) => k + "=" + v)].flatMap(label => ["--filter", "label=" + label]);
	}
	async discover() {
		const rows = await docker(["ps", "-a", ...this.filters(), "--format", `{{.Names}}|{{.State}}|{{.Label "${LABEL}.session"}}|{{.Label "${LABEL}.profile"}}`], { check: true });
		const found = new Set<string>();
		for (const line of rows.stdout.trim().split("\n")) {
			const [name, state, sessionId, profile] = line.split("|");
			const raw = /^wlp-session-([a-f0-9]{12})$/.exec(name)?.[1];
			if (!raw || !NAME.test(sessionId) || (profile !== bubblewrap && profile !== "docker-hardened")) continue;
			const id = externalId(this.identity.machineId, raw);
			found.add(id);
			const box = this.boxes.get(id) ?? { raw, sessionId, profile, usedAt: Date.now(), busy: 0 };
			this.boxes.set(id, Object.assign(box, { state: state === "running" || state === "restarting" ? "running" as const : "paused" as const }));
		}
		for (const id of this.boxes.keys()) if (!found.has(id)) this.boxes.delete(id);
		this.ready = true;
	}
	async refresh(): Promise<void> {
		try {
			if (this.ready) await docker(["version", "--format", "{{.Server.Version}}"], { check: true });
			else await this.discover();
		} catch {
			this.ready = false;
			this.freeDiskBytes = null;
			return;
		}
		try {
			await this.ensureImage();
			// Once a real create has failed its probe, keep that result. A lightweight
			// startup probe cannot overrule what happened inside the actual sandbox.
			const first = this.freeDiskBytes === null;
			this.freeDiskBytes = await this.disk();
			if (first) this.commandSandbox = await this.probeAvailable();
		} catch (error) {
			this.freeDiskBytes = null;
			this.commandSandbox = { ok: false, reason: error instanceof RunnerError ? error.message : "The sandbox image could not be checked." };
		}
	}
	private async probeAvailable(): Promise<Report["commandSandbox"]> {
		return await this.probe() ? { ok: true } : { ok: false, reason: "Bubblewrap could not start in a sandbox on this machine." };
	}
	report(): Report {
		return { kind: "report", docker: this.ready ? { ok: true } : { ok: false, reason: "Docker is not reachable. Check the daemon and the socket mount and permissions." },
			commandSandbox: this.commandSandbox, freeDiskBytes: this.freeDiskBytes,
			sandboxes: [...this.boxes.entries()].slice(0, MAX_REPORTED_SANDBOXES).map(([id, { sessionId, state, usedAt }]) => ({ id, sessionId, state, usedAt })) };
	}
	private room() {
		if ([...this.boxes.values()].filter(b => b.state === "running").length >= this.limits.maxRunning)
			throw new Refusal("This machine has reached its limit on running sandboxes.");
	}
	async create(sessionId: string, profile: Profile) {
		if (!this.ready) await this.discover();
		if (this.boxes.size >= this.limits.maxSandboxes) throw new Refusal("This machine has reached its limit on kept sandboxes.");
		this.room();
		await this.ensureImage();
		this.freeDiskBytes = await this.disk();
		if (this.freeDiskBytes < 5_000_000_000) throw new Refusal("Docker needs at least 5 GB free to create a sandbox.");
		const raw = await this.provider.create({ uid: this.identity.uid, sessionId, profile });
		const id = externalId(this.identity.machineId, raw);
		this.boxes.set(id, { raw, sessionId, profile, state: "running", usedAt: Date.now(), busy: 0 });
		if (profile === bubblewrap) {
			const result = await new DockerSandboxHandle(raw, profile, this.identity.uid).ask(BWRAP_PROBE, { timeoutMs: 20_000 });
			if (result?.code !== 0) {
				const why = result?.stderr.trim();
				const message = "Bubblewrap could not start in the new sandbox." + (why ? " " + why : "");
				this.commandSandbox = { ok: false, reason: safeSentence(message).slice(0, 500) };
				await this.remove(id);
				throw new Refusal(message);
			}
			this.commandSandbox = { ok: true };
		}
		return id;
	}
	private owned(id: string, session?: string) {
		rawId(this.identity.machineId, id);
		const box = this.boxes.get(id);
		if (box && session !== undefined && box.sessionId !== session) throw new Refusal("This sandbox belongs to another session.");
		return box;
	}
	running(id: string, session: string) {
		const box = this.owned(id, session);
		if (!box || box.state !== "running") throw new Refusal("Commands require a running sandbox owned by this machine and session.");
		box.usedAt = Date.now();
		return box;
	}
	async lifecycle(op: Lifecycle["name"], id: string, session?: string) {
		if (!this.ready) await this.discover();
		const box = this.owned(id, session);
		if (!box) {
			// A repeated destroy is harmless, but an existing, unlabelled namesake is not ours.
			const raw = rawId(this.identity.machineId, id);
			if ((await docker(["container", "inspect", "--format", "{{.Id}}", containerName(raw)])).code === 0)
				throw new Refusal("This sandbox does not belong to this machine.");
			return op === "state" ? "none" as const : null;
		}
		box.usedAt = Date.now();
		if (op === "state") {
			const state = await this.provider.state(box.raw);
			if (state === "none") this.boxes.delete(id);
			else box.state = state;
			return state;
		}
		if (op === "connect") {
			if (box.state === "paused") this.room();
			const handle = await this.provider.connect(box.raw);
			if (!handle) { this.boxes.delete(id); return null; }
			box.state = "running";
			return { cwd: handle.cwd, profile: box.profile };
		}
		// The server names the token by the external sandbox id; the provider knows the raw id.
		if (box.state === "running") {
			const path = tokenFilePath(id);
			await new DockerSandboxHandle(box.raw, box.profile, this.identity.uid).removeFiles([path, path + ".tmp"]);
		}
		if (op === "destroy") await this.remove(id);
		else {
			await this.provider.suspend(box.raw);
			const state = await this.provider.state(box.raw);
			if (state === "none") this.boxes.delete(id);
			else box.state = state;
			if (state === "running") throw new RunnerError("Docker could not stop the sandbox.");
		}
		return null;
	}
	async requestedRemoval(id: string) {
		if (!this.ready) await this.discover();
		if (this.boxes.has(id)) await this.lifecycle("destroy", id);
		// The control acknowledgement also covers a sandbox that was never this machine's.
	}
	private async remove(id: string) {
		await this.provider.destroy(rawId(this.identity.machineId, id));
		this.boxes.delete(id);
	}
	async idle(ms: number, connected: (session: string) => boolean) {
		for (const [id, b] of this.boxes) {
			if (b.state === "running" && !b.busy && !connected(b.sessionId) && Date.now() - b.usedAt >= ms) {
				await this.lifecycle("suspend", id);
				audit(b.sessionId, id, "idle-suspend", "done");
			}
		}
	}
	async prune() {
		await this.discover();
		for (const [id, b] of this.boxes) {
			await this.lifecycle("destroy", id);
			audit(b.sessionId, id, "prune", "done");
		}
		// A killed runner can also have left a labelled probe or disk-check helper.
		const helpers = await docker(["ps", "-aq", ...this.filters()], { check: true });
		for (const id of helpers.stdout.trim().split(/\s+/).filter(Boolean)) await docker(["rm", "-fv", id], { check: true });
		const volumes = await docker(["volume", "ls", "-q", ...this.filters()], { check: true });
		for (const name of volumes.stdout.trim().split(/\s+/).filter(Boolean)) await this.dropVolume(name);
	}
}
