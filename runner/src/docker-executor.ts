import type { HarnessOptions } from "../../server/src/contract.js";
import { probeClaudeOptions } from "./claude-options.js";
import claudePackage from "../../sandbox/harness/claude/package.json";
import { MAX_REPORTED_SANDBOXES, type Report } from "../../server/src/runner/control.js";
import { PROFILE_DENIED, type Operation } from "../../server/src/runner/protocol.js";
import { SandboxUserError } from "../../server/src/sandbox/api.js";
import { LABEL, LABEL_ARG, docker } from "../../server/src/sandbox/docker.js";
import { DOCKER_BWRAP_PROBE } from "../../server/src/sandbox/docker-flags.js";
import { NAME, WORKSPACE } from "../../server/src/sandbox/provider.js";
import { containerName, DockerSandboxes, DockerSandboxHandle } from "../../server/src/sandbox/sandboxes.js";
import { tokenFilePath } from "../../server/src/sandbox/token-file.js";
import { audit, safeSentence } from "./audit.js";
import { bubblewrap, externalId, harnessImage, image, shotsImage, runnerCpus, MachineDocker, rawId, type Limits, type Profile } from "./policy.js";
import { pageLoginLabel } from "./page-login.js";
import { cleanClaudeOutput } from "./claude-output.js";
import { claudeSignIn, loginFileState, dropDetachedLoginVolume, withLoginVolume } from "./harness-login.js";
import { open, type Egress } from "./egress-policy.js";
import { EgressNetwork } from "./egress-network.js";
import { Refusal, RunnerError, type Identity } from "./state.js";

type Lifecycle = Extract<Operation, { name: "connect" | "state" | "suspend" | "destroy" }>;
export interface Box { egress?: string; raw: string; sessionId: string; state: "running" | "paused"; profile: Profile; harness?: "claude"; usedAt: number; busy: number; workspaceChecked: boolean }

// Docker's archive HEAD stats just the path, even in a stopped or paused container.
// Use the CLI's daemon connection so this also respects the owner's Docker context.
async function hasWorkspaceGit(raw: string) {
	const path = `/containers/${containerName(raw)}/archive?path=${WORKSPACE}/.git`;
	const result = await docker(["system", "dial-stdio"], {
		stdin: `HEAD ${path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`, timeoutMs: 30_000,
	});
	if (result.code === 0) {
		if (result.stdout.startsWith("HTTP/1.1 200 ")) return true;
		if (result.stdout.startsWith("HTTP/1.1 404 ")) return false;
	}
	throw new RunnerError("Docker could not check the sandbox workspace.");
}

// Health checks need Docker's diagnostic itself, without the CLI wrapper's command and exit status.
async function dockerOutput(args: string[]) {
	try {
		const result = await docker(args);
		if (result.code === 0) return result.stdout;
		throw new Error(result.stderr.trim() || result.stdout.trim() || "Docker exited without a diagnostic.");
	} catch (error) {
		let line = error instanceof Error ? cleanClaudeOutput(error.message).split(/[\r\n]/, 1)[0] : "";
		// Docker may echo a setting (including a credential) verbatim in its diagnostic.
		for (const value of Object.values(process.env).filter((v): v is string => !!v).sort((a, b) => b.length - a.length)) {
			line = line.replaceAll(value, "[redacted]");
		}
		line = line.replace(/\b(?!unix:)[a-z][a-z0-9+.-]*:\/\/\S+|\bBasic\s+\S+/gi, "[redacted]")
			.replace(/\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "[redacted]");
		throw new RunnerError(safeSentence(line).trim().slice(0, 500) || "Docker did not provide a diagnostic.");
	}
}

export class Executor extends MachineDocker {
	readonly provider: DockerSandboxes;
	readonly network: EgressNetwork;
	readonly maxTurns: number;
	readonly boxes = new Map<string, Box>();
	private readonly claudePin?: string;
	private readonly claudeProvider?: DockerSandboxes;
	private optionsPin?: string;
	private claudeOptions?: HarnessOptions;
	private signIn: "none" | "token" | "unknown" = "unknown";
	private enforceEgress = false;
	private egressError?: string;
	private pending: Promise<unknown> = Promise.resolve();
	private dockerHealth: Report["docker"] = { ok: false, reason: "Docker has not been checked." };
	publishReport?: () => void;
	private commandSandbox: Report["commandSandbox"] = { ok: false, reason: "The Windlass sandbox probe has not run." };
	private freeDiskBytes: number | null = null;

	constructor(identity: Identity, private readonly limits: Limits, readonly screenshots = false, readonly claude = false, private readonly allowedProfiles: Profile[] = ["docker-hardened"], policy: Egress = open) {
		super(identity);
		this.maxTurns = limits.maxTurns ?? 2;
		this.network = new EgressNetwork(this, policy);
		const network = this.network.sandboxNetwork();
		const cpus = runnerCpus();
		this.provider = new DockerSandboxes({ cpus, network, machine: identity.machineId, image, shotsImage, dataVolume: async () => {
			await this.ownedVolume(true);
			return this.volume;
		} });
		if (claude) {
			this.claudePin = harnessImage("claude");
			if (!this.claudePin) throw new Refusal("This runner was built without the Claude Code image.");
			this.claudeProvider = new DockerSandboxes({ cpus, network, machine: identity.machineId, image: this.claudePin, claudeVolume: this.claudeVolume });
		}
	}
	requireClaude(profile: Profile) {
		if (!this.claudeProvider) throw new Refusal("Claude Code is not turned on on this machine: start the runner with --harness claude.");
		if (profile !== "docker-hardened") throw new Refusal("Claude Code requires the docker-hardened profile.");
	}
	async prepareClaude(profile: Profile) {
		this.requireClaude(profile);
		try { await this.ensureImage(this.claudePin); }
		catch { throw new Refusal("The pinned Claude Code image is missing on this machine. Update the runner and start it with --harness claude."); }
	}
	private async refreshLogin() {
		if (!this.claudePin) return;
		this.signIn = await claudeSignIn(this);
		if (this.signIn === "none") this.claudeOptions = undefined;
	}
	async loginChanged(signedIn: boolean) {
		await this.refreshLogin();
		if (signedIn) await this.refreshClaudeOptions(true);
	}
	private async refreshClaudeOptions(loginChanged = false) {
		const pin = this.claudePin;
		if (!pin || this.signIn !== "token") return;
		// The pin is immutable for this runner build. Reconnects and inventory refreshes reuse the result.
		if (this.optionsPin === pin && !loginChanged) return;
		this.optionsPin = pin;
		this.claudeOptions = undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await this.ensureImage(pin);
				this.claudeOptions = await withLoginVolume(this, async () => {
					if (await loginFileState(this) !== "token") return undefined;
					return probeClaudeOptions(this, pin);
				});
				return;
			} catch { /* A transient adapter startup failure gets one retry. */ }
		}
		console.log("Could not read Claude Code model options.");
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
	// Docker keeps the container and its workspace across a rename. Finish all such renames
	// before writing a status.json the rollback runner can read.
	async migrateClaudeNames() {
		const names = await dockerOutput(["ps", "-a", ...this.filters(), "--filter", `label=${LABEL}.harness=claude`, "--format", "{{.Names}}"]);
		for (const name of names.trim().split("\n")) {
			const raw = /^wlp-session-([a-f0-9]{12})$/.exec(name)?.[1];
			if (raw) await dockerOutput(["rename", name, containerName("claude-" + raw)]);
		}
	}
	async discover(onlySession?: string) {
		const filters = this.filters();
		if (onlySession) filters.push("--filter", `label=${LABEL}.session=${onlySession}`);
		const rows = await dockerOutput(["ps", "-a", ...filters, "--format", `{{.Names}}|{{.State}}|{{.Label "${LABEL}.session"}}|{{.Label "${LABEL}.profile"}}|{{.Label "${LABEL}.harness"}}|{{.Label "${LABEL}.egress"}}`]);
		const found = new Set<string>();
		for (const line of rows.trim().split("\n")) {
			const [name, state, sessionId, profile, harness, egress] = line.split("|");
			const raw = /^wlp-session-((?:claude-)?[a-f0-9]{12})$/.exec(name)?.[1];
			if (!raw || (raw.startsWith("claude-") && harness !== "claude") || (harness && harness !== "claude") || !NAME.test(sessionId) || (profile !== bubblewrap && profile !== "docker-hardened")) continue;
			const id = externalId(this.identity.machineId, raw);
			found.add(id);
			const box = this.boxes.get(id) ?? { raw, sessionId, profile, ...(harness === "claude" ? { harness: "claude" as const } : {}), usedAt: Date.now(), busy: 0, workspaceChecked: false };
			this.boxes.set(id, Object.assign(box, { egress, state: state === "running" || state === "restarting" ? "running" as const : "paused" as const }));
		}
		for (const [id, box] of this.boxes) {
			if ((!onlySession || box.sessionId === onlySession) && !found.has(id)) this.boxes.delete(id);
		}
		this.dockerHealth = { ok: true };
	}
	// Run only after this pairing's authenticated welcome. Stop an old container before
	// advertising a tighter policy. Its workspace remains available to the owner.
	private async reconcileEgress() {
		await this.discover();
		const running = new Set<string>();
		for (const [id, box] of this.boxes) {
			if (box.state !== "running") continue;
			if ((box.egress || "open") !== this.network.policy.mode) {
				await this.lifecycle("suspend", id);
				continue;
			}
			if (!box.egress) await this.network.migrateOpen(containerName(box.raw));
			if (box.egress === "restricted") {
				await this.network.attach(box.raw, containerName(box.raw));
				running.add(box.raw);
			}
		}
		await this.network.reconcile(running);
	}
	async refresh(): Promise<void> {
		try {
			if (this.enforceEgress) {
				try { await this.reconcileEgress(); this.egressError = undefined; }
				catch (error) {
					this.egressError = error instanceof RunnerError ? error.message : "Docker could not apply the runner’s network policy.";
					throw new RunnerError(this.egressError);
				}
			} else if (this.dockerHealth.ok) await dockerOutput(["version", "--format", "{{.Server.Version}}"]);
			else await this.discover();
			await this.refreshLogin();
		} catch (error) {
			const reason = error instanceof RunnerError ? error.message : "Docker did not provide a diagnostic.";
			const category = /permission denied|EACCES/i.test(reason) ? "permission denied"
				: /no such file|ENOENT/i.test(reason) ? "not found" : "unreachable";
			audit(null, null, "docker", category);
			this.dockerHealth = { ok: false, reason };
			this.signIn = "unknown";
		}
	}
	async checkAuthenticatedNetwork() {
		this.enforceEgress = true;
		await this.serial(() => this.refresh());
	}
	async welcome(signal: AbortSignal) {
		if (!this.dockerHealth.ok || signal.aborted) return;
		try {
			// A killed runner can leave setup between Docker create and start, before its
			// in-container deadline exists. Only the authenticated pairing reaps its leftovers.
			const stale = await dockerOutput(["ps", "-aq", ...this.filters(), "--filter", "label=" + pageLoginLabel]);
			for (const id of stale.trim().split(/\s+/).filter(Boolean)) {
				if (signal.aborted) return;
				await docker(["rm", "-f", id]);
			}
			await this.ensureImage();
			if (this.claudePin) await this.ensureImage(this.claudePin).catch(() => {}); // create explains a missing harness pin.
			await this.serial(async () => {
				if (signal.aborted) return;
				if (this.signIn === "unknown") await this.refreshLogin();
				await this.refreshClaudeOptions();
				// Keep the result of a real sandbox create after this initial bubblewrap check.
				const first = this.freeDiskBytes === null;
				this.freeDiskBytes = await this.disk();
				if (first) this.commandSandbox = this.allowedProfiles.includes(bubblewrap) ? await this.probeAvailable() : { ok: false, reason: PROFILE_DENIED };
			});
		} catch (error) {
			if (signal.aborted) return;
			this.freeDiskBytes = null;
			this.commandSandbox = { ok: false, reason: error instanceof RunnerError ? error.message : "The sandbox image could not be checked." };
		}
	}
	private async probeAvailable(): Promise<Report["commandSandbox"]> {
		return await this.probe() ? { ok: true } : { ok: false, reason: "Bubblewrap could not start in a sandbox on this machine." };
	}
	report(): Report {
		return { kind: "report", egress: this.network.policy.mode, allowedProfiles: this.allowedProfiles,
			docker: this.egressError ? { ok: false, reason: this.egressError } : this.dockerHealth,
			...(this.claudePin ? { claudeLogin: true as const, harnesses: [{ id: "claude" as const,
				adapter: "claude-agent-acp " + claudePackage.dependencies["@agentclientprotocol/claude-agent-acp"],
				image: this.claudePin.slice(this.claudePin.lastIndexOf("@") + 1), signIn: this.signIn,
				...(this.signIn === "token" && this.claudeOptions && { options: this.claudeOptions }) }] } : {}),
			...(this.screenshots ? { screenshots: true } : {}),
			commandSandbox: this.commandSandbox, freeDiskBytes: this.freeDiskBytes,
			sandboxes: [...this.boxes.entries()].slice(0, MAX_REPORTED_SANDBOXES).map(([id, { sessionId, state, usedAt }]) => ({ id, sessionId, state, usedAt })),
			...(this.limits.maxRunning !== undefined ? { maxRunning: this.limits.maxRunning } : {}),
			...(this.limits.maxSandboxes !== undefined ? { maxSandboxes: this.limits.maxSandboxes } : {}) };
	}
	private room() {
		if (this.limits.maxRunning !== undefined && [...this.boxes.values()].filter(b => b.state === "running").length >= this.limits.maxRunning)
			throw new SandboxUserError("This machine has reached its own limit on running sandboxes, set by --max-running.");
	}
	private requireProfile(profile: Profile) {
		if (!this.allowedProfiles.includes(profile)) throw new Refusal(PROFILE_DENIED);
	}
	private requireEgress(box: Box) {
		if (this.egressError) throw new Refusal(this.egressError);
		if ((box.egress || "open") !== this.network.policy.mode)
			throw new Refusal("This kept sandbox has a different network policy. Save its workspace and recreate the sandbox to use the runner’s current --egress setting.");
	}
	async existing(sessionId: string, profile: Profile, harness?: "claude") {
		this.requireProfile(profile);
		if (this.egressError) throw new Refusal(this.egressError);
		// The owner may have removed the container since discovery. Refresh just this
		// session once the rest of the inventory is known, before applying capacity limits.
		if (!this.dockerHealth.ok) await this.discover();
		else if ([...this.boxes.values()].some(box => box.sessionId === sessionId)) await this.discover(sessionId);
		else return;
		for (const [id, box] of this.boxes) {
			if (box.sessionId === sessionId) {
				this.requireProfile(box.profile);
				this.requireEgress(box);
				if (box.harness !== harness) throw new Refusal("This session already has a sandbox with a different harness.");
				if (!box.workspaceChecked) {
					if (!await hasWorkspaceGit(box.raw)) {
						await this.remove(id);
						await this.discover(sessionId);
						if (this.boxes.has(id)) throw new RunnerError("Docker could not remove the unfinished sandbox.");
						continue;
					}
					box.workspaceChecked = true;
				}
				this.publishReport?.();
				return id;
			}
		}
	}
	async create(sessionId: string, profile: Profile, screenshots = false, harness?: "claude") {
		// Another create could have finished while this one waited for the image.
		if (harness) this.requireClaude(profile);
		const existing = await this.existing(sessionId, profile, harness);
		if (existing) return existing;
		if (this.limits.maxSandboxes !== undefined && this.boxes.size >= this.limits.maxSandboxes)
			throw new SandboxUserError("This machine has reached its own limit on kept sandboxes, set by --max-sandboxes.");
		this.room();
		await this.network.prepare();
		this.freeDiskBytes = await this.disk();
		if (this.freeDiskBytes < 5_000_000_000) throw new Refusal("Docker needs at least 5 GB free to create a sandbox.");
		const input = { uid: this.identity.uid, sessionId, profile };
		const raw = harness ? await withLoginVolume(this, async () => {
			await this.ownedVolume(true, this.claudeVolume);
			return this.claudeProvider!.create({ ...input, harness });
		}) : await this.provider.create({ ...input, screenshots: this.screenshots && screenshots });
		const id = externalId(this.identity.machineId, raw);
		this.boxes.set(id, { raw, sessionId, profile, harness, egress: this.network.policy.mode, state: "running", usedAt: Date.now(), busy: 0, workspaceChecked: true });
		try { await this.network.attach(raw, containerName(raw)); }
		catch (error) { await this.remove(id); throw error; }
		if (profile === bubblewrap) {
			const result = await new DockerSandboxHandle(raw, profile, this.identity.uid).ask(DOCKER_BWRAP_PROBE, { timeoutMs: 20_000 });
			if (result?.code !== 0) {
				const why = result?.stderr.trim();
				const message = "Bubblewrap could not start in the new sandbox." + (why ? " " + why : "");
				this.commandSandbox = { ok: false, reason: safeSentence(message).slice(0, 500) };
				await this.remove(id);
				throw new Refusal(message);
			}
			this.commandSandbox = { ok: true };
		}
		this.publishReport?.();
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
		this.requireProfile(box.profile);
		this.requireEgress(box);
		if (box.harness) this.requireClaude(box.profile);
		box.usedAt = Date.now();
		return box;
	}
	/** Keep the control report in step with an observed container transition, including an idle stop. */
	private noteState(id: string, box: Box, state: "none" | "running" | "paused") {
		if (box.state === state) return;
		if (state === "none") this.boxes.delete(id);
		else box.state = state;
		this.publishReport?.();
	}
	async lifecycle(op: Lifecycle["name"], id: string, session?: string) {
		if (!this.dockerHealth.ok) await this.discover();
		const box = this.owned(id, session);
		if (!box) {
			// A repeated destroy is harmless, but an existing, unlabelled namesake is not ours.
			const raw = rawId(this.identity.machineId, id);
			if ((await docker(["container", "inspect", "--format", "{{.Id}}", containerName(raw)])).code === 0)
				throw new Refusal("This sandbox does not belong to this machine.");
			if (op === "destroy") this.publishReport?.();
			return op === "state" ? "none" as const : null;
		}
		box.usedAt = Date.now();
		if (op === "state") {
			const state = await this.provider.state(box.raw);
			this.noteState(id, box, state);
			return state;
		}
		if (op === "connect") {
			this.requireProfile(box.profile);
			this.requireEgress(box);
			if (box.harness) this.requireClaude(box.profile);
			if (box.state === "paused") this.room();
			const handle = await this.provider.connect(box.raw);
			this.noteState(id, box, handle ? "running" : "none");
			if (!handle) return null;
			if (!box.egress) await this.network.migrateOpen(containerName(box.raw));
			await this.network.attach(box.raw, containerName(box.raw));
			return { cwd: handle.cwd, profile: box.profile, ...(box.harness ? { harness: box.harness } : {}), ...(this.screenshots && !box.harness ? { screenshots: true } : {}) };
		}
		// The server names the token by the external sandbox id; the provider knows the raw id.
		if (box.state === "running") {
			const path = tokenFilePath(id);
			await new DockerSandboxHandle(box.raw, box.profile, this.identity.uid).removeFiles([path, path + ".tmp"]);
		}
		if (op === "destroy") await this.remove(id);
		else {
			if (box.egress === "restricted") await this.network.detach(box.raw);
			await this.provider.suspend(box.raw);
			const state = await this.provider.state(box.raw);
			this.noteState(id, box, state);
			if (state === "running") throw new RunnerError("Docker could not stop the sandbox.");
		}
		return null;
	}
	async requestedRemoval(id: string) {
		if (!this.dockerHealth.ok) await this.discover();
		if (this.boxes.has(id)) await this.lifecycle("destroy", id);
		else this.publishReport?.();
		// The control acknowledgement also covers a sandbox that was never this machine's.
	}
	private async remove(id: string) {
		const { raw, harness, egress } = this.boxes.get(id)!;
		if (egress === "restricted") await this.network.detach(raw);
		await this.provider.destroy(raw);
		this.boxes.delete(id);
		if (harness) await withLoginVolume(this, async () => {
			if (await loginFileState(this).catch(() => "unknown") === "none") await dropDetachedLoginVolume(this);
		});
		this.publishReport?.();
	}
	async idle(ms: number, connected: (session: string) => boolean) {
		// A running process (including Windlass throughout a turn), an outstanding operation,
		// or a connected session socket keeps the sandbox in use.
		for (const [id, b] of this.boxes) {
			if (b.state === "running" && !b.busy && !connected(b.sessionId) && Date.now() - b.usedAt >= ms) {
				await this.lifecycle("suspend", id);
				audit(b.sessionId, id, "idle-suspend", "done");
			}
		}
	}
	async suspendAll() {
		await this.discover();
		let failed = false;
		for (const [id, box] of this.boxes) {
			if (box.state !== "running") continue;
			try { await this.lifecycle("suspend", id); }
			catch { failed = true; audit(box.sessionId, id, "suspend", "failed"); }
		}
		if (failed) throw new RunnerError("Docker could not stop all kept sandboxes.");
	}
	async prune() {
		await this.discover();
		for (const [id, b] of this.boxes) {
			await this.lifecycle("destroy", id);
			audit(b.sessionId, id, "prune", "done");
		}
		// A killed runner can also have left a labelled probe or disk-check helper.
		await withLoginVolume(this, async () => {
			const helpers = await docker(["ps", "-aq", ...this.filters()], { check: true });
			for (const id of helpers.stdout.trim().split(/\s+/).filter(Boolean)) await docker(["rm", "-fv", id], { check: true });
			await this.network.prune();
			const volumes = await docker(["volume", "ls", "-q", ...this.filters()], { check: true });
			for (const name of volumes.stdout.trim().split(/\s+/).filter(Boolean)) await this.dropVolume(name);
		});
	}
}
