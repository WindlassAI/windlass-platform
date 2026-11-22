import { dropPreviousSnapshots } from "./snapshot-retention.js";
import type { SnapshotSelection, SnapshotSource } from "../../server/src/sandbox/snapshot-key.js";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import type { HarnessOptions } from "../../server/src/contract.js";
import { innerModesReason, reportedCodexModes } from "../../server/src/sandbox/codex-modes.js";
import { codexLogin } from "./codex-login.js";
import { PROFILE_RUN_FLAGS } from "../../server/src/sandbox/docker-flags.js";
import { commonRunFlags } from "../../server/src/sandbox/profiles.js";
import { tmpName } from "../../server/src/sandbox/docker.js";
import { currentProvider, installedProvider } from "./opencode-login.js";
import { ensureRelay, prepareRelay, removeRelay, stopLegacyClaude } from "./claude-relay.js";
import { probeHarnessOptions } from "./harness-options.js";
import claudePackage from "../../sandbox/harness/claude/package.json";
import { MAX_REPORTED_SANDBOXES, type Report } from "../../server/src/runner/control.js";
import { PROFILE_DENIED, type Operation } from "../../server/src/runner/protocol.js";
import { SandboxUserError } from "../../server/src/sandbox/api.js";
import { LABEL, LABEL_ARG, docker } from "../../server/src/sandbox/docker.js";
import { DOCKER_BWRAP_PROBE } from "../../server/src/sandbox/docker-flags.js";
import { NAME, WORKSPACE } from "../../server/src/sandbox/provider.js";
import { containerName, removeRunningTokenFiles, DockerSandboxes, DockerSandboxHandle } from "../../server/src/sandbox/sandboxes.js";
import { tokenFilePath } from "../../server/src/sandbox/token-file.js";
import { audit, safeSentence } from "./audit.js";
import { bubblewrap, externalId, harnessImage, image, shotsImage, MachineDocker, rawId, type Limits, type Profile, type MachineHarness } from "./policy.js";
import { localSizing } from "./sizing.js";
const legacyLoginLabel = LABEL + ".claude-login=1";
import { cleanClaudeOutput } from "./claude-output.js";
import { claudeLoginGeneration, loginFileState, dropDetachedLoginVolume, retireClaudeRelay, withLoginVolume } from "./harness-login.js";
import { open, type Egress } from "./egress-policy.js";
import { EgressNetwork } from "./egress-network.js";
import { loadPair, Refusal, RunnerError, type Identity } from "./state.js";

type Lifecycle = Extract<Operation, { name: "connect" | "state" | "suspend" | "destroy" }>;
export interface Box { resizePending?: true; snapshotCandidate?: boolean; savingSnapshot?: boolean; egress?: string; legacyClaude?: boolean; raw: string; sessionId: string; state: "running" | "paused"; profile: Profile; harness?: MachineHarness; usedAt: number; busy: number; workspaceChecked: boolean }

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

const INVENTORY_TTL_MS = 6 * 60 * 60_000;
const INVENTORY_RETRY_MS = 5 * 60_000;

export class Executor extends MachineDocker {
	readonly provider: DockerSandboxes;
	readonly network: EgressNetwork;
	readonly slots: Report["slots"];
	get maxTurns() { return this.slots?.max; }
	readonly boxes = new Map<string, Box>();
	private readonly codexPin?: string;
	private readonly codexProvider?: DockerSandboxes;
	private codexCredential?: ReturnType<typeof codexLogin>;
	private codexOptions?: HarnessOptions;
	private codexGeneration?: string;
	private nextCodexProbe = 0;
	private codexInner?: boolean;
	private readonly opencodePin?: string;
	private readonly opencodeProvider?: DockerSandboxes;
	private opencodeLogin?: ReturnType<typeof currentProvider>;
	private opencodeOptions?: HarnessOptions;
	private probedLogin?: string;
	private readonly claudePin?: string;
	private readonly claudeProvider?: DockerSandboxes;
	private credentialPathChecked = false;
	private nextClaudeProbe = 0;
	private nextOpenCodeProbe = 0;
	private claudeOptions?: HarnessOptions;
	private claudeGeneration?: string;
	private signIn: "none" | "token" | "unknown" = "unknown";
	private enforceEgress = false;
	private inventoryStarted = false;
	private egressError?: string;
	private pending: Promise<unknown> = Promise.resolve();
	private dockerHealth: Report["docker"] = { ok: false, reason: "Docker has not been checked." };
	publishReport?: () => void;
	private commandSandbox: Report["commandSandbox"] = { ok: false, reason: "The Windlass sandbox probe has not run." };
	private freeDiskBytes: number | null = null;

	constructor(identity: Identity, private readonly limits: Limits, readonly screenshots = false, readonly claude = false, private readonly allowedProfiles: Profile[] = ["docker-hardened"], policy: Egress = open, readonly opencode = false, readonly codex = false) {
		super(identity);
		this.slots = limits.slots === null ? undefined : limits.slots ?? localSizing({ slots: limits.maxTurns?.toString() });
		this.network = new EgressNetwork(this, policy);
		const network = this.network.sandboxNetwork();
		const slots = this.slots;
		this.provider = new DockerSandboxes({ slots, network, machine: identity.machineId, image, shotsImage, dataVolume: async () => {
			await this.ownedVolume(true);
			return this.volume;
		} });
		if (codex) {
			this.codexPin = harnessImage("codex");
			if (!this.codexPin) throw new Refusal("This runner was built without the Codex image.");
			this.codexProvider = new DockerSandboxes({slots,network,machine:identity.machineId,image:this.codexPin,harness:"codex",
				sessionRelay:async () => {
					const login = codexLogin(this);
					if (!login) throw new Refusal("Run windlass-runner login codex on this machine.");
					return prepareRelay(this, login);
				}});
		}
		if (opencode) {
			this.opencodePin = harnessImage("opencode");
			if (!this.opencodePin) throw new Refusal("This runner was built without the OpenCode image.");
			this.opencodeProvider = new DockerSandboxes({ slots, network, machine: identity.machineId, image: this.opencodePin,
				harness: "opencode", sessionRelay: async () => {
					const login = currentProvider(this);
					if (!login) throw new Refusal("Run windlass-runner login opencode on this machine.");
					return prepareRelay(this, login);
				} });
		}
		if (claude) {
			this.claudePin = harnessImage("claude");
			if (!this.claudePin) throw new Refusal("This runner was built without the Claude Code image.");
			this.claudeProvider = new DockerSandboxes({ slots, network, machine: identity.machineId, image: this.claudePin, sessionRelay: () => this.prepareClaudeRelay() });
		}
	}
	/** Caller holds the login lock while preparing the relay and issuing a session credential. */
	prepareClaudeRelay() { return prepareRelay(this); }
	requireHarness(profile: Profile, harness: MachineHarness = "claude") {
		if (harness === "codex") {
			if (!this.codexPin) throw new Refusal("Start the runner with --harness codex.");
			if (profile !== "docker-hardened" && !(profile === bubblewrap && this.codexInner)) throw new Refusal(innerModesReason);
			return;
		}
		if (harness === "opencode") {
			if (!this.opencodeProvider) throw new Refusal("Start the runner with --harness opencode.");
			if (profile !== "docker-hardened") throw new Refusal("OpenCode requires the docker-hardened profile.");
			return;
		}
		if (!this.claudeProvider) throw new Refusal("Claude Code is not turned on on this machine: start the runner with --harness claude.");
		if (profile !== "docker-hardened") throw new Refusal("Claude Code requires the docker-hardened profile.");
	}
	async prepareHarness(profile: Profile, harness: MachineHarness = "claude") {
		this.requireHarness(profile, harness);
		if (harness === "codex") return this.ensureImage(this.codexPin);
		if (harness === "opencode") return this.ensureImage(this.opencodePin);
		try { await this.ensureImage(this.claudePin); }
		catch { throw new Refusal("The pinned Claude Code image is missing on this machine. Update the runner and start it with --harness claude."); }
	}
	private async refreshLogin() {
		if (this.codexPin) {
			const credential = codexLogin(this);
			this.codexCredential = credential && await this.ownedVolume(false, this.codexVolume) ? credential : undefined;
			if ((this.codexCredential?.generation ?? "signed-out") !== this.codexGeneration) this.codexOptions = undefined;
		}
		if (this.opencodePin) {
			this.opencodeLogin = await installedProvider(this);
			if ((this.opencodeLogin?.generation ?? "signed-out") !== this.probedLogin) this.opencodeOptions = undefined;
		}
		if (!this.claudePin) return;
		await withLoginVolume(this, async () => {
			this.signIn = await loginFileState(this);
			this.claudeGeneration = this.signIn === "token" ? claudeLoginGeneration(this) : undefined;
		}).catch(() => { this.signIn = "unknown"; });
	}
	async loginChanged(signedIn: boolean) {
		await this.refreshLogin();
		if (signedIn) await this.restoreRelay();
		await this.refreshClaudeOptions(true);
		await this.refreshOpenCodeOptions(true);
		await this.refreshCodexOptions(true);
	}
	private async ensureSignedInRelay() {
		await withLoginVolume(this, async () => {
			if (await loginFileState(this) === "token") await ensureRelay(this);
		});
	}
	private async refreshCodexOptions(force = false) {
		const pin = this.codexPin;
		const login = this.codexCredential;
		const generation = login?.generation ?? "signed-out";
		if (!pin || (!force && generation === this.codexGeneration && Date.now() < this.nextCodexProbe)) return;
		this.codexGeneration = generation;
		this.nextCodexProbe = Date.now() + INVENTORY_RETRY_MS;
		let options: HarnessOptions | undefined;
		try {
			await this.ensureImage(pin);
			if (this.codexInner === undefined && this.allowedProfiles.includes(bubblewrap)) {
				let passed = true;
				for (const mode of ["read-only", "workspace-write"]) {
					const result = await docker(["run","--rm","--name",tmpName(),"--pull","never","--log-driver","none",
						...this.pairingLabelFlags,...commonRunFlags(1,"none"),...PROFILE_RUN_FLAGS[bubblewrap]!,
						pin,"codex","-c",`sandbox_mode="${mode}"`,"sandbox","--","/bin/true"], {timeoutMs:30_000});
					if (result.code !== 0) { passed = false; break; }
				}
				this.codexInner = passed;
			}
			options = await probeHarnessOptions(this, pin, undefined, { login });
		} catch {
			// The session can disappear normally if the owner logs out during discovery.
		}
		await this.refreshLogin();
		if ((this.codexCredential?.generation ?? "signed-out") !== generation) return;
		if (options) {
			this.codexOptions = options;
			this.nextCodexProbe = Date.now() + INVENTORY_TTL_MS;
		} else console.log("Could not read Codex model options.");
	}
	private async refreshOpenCodeOptions(force = false) {
		const pin = this.opencodePin;
		const login = this.opencodeLogin;
		const generation = login?.generation ?? "signed-out";
		if (!pin || (!force && this.probedLogin === generation && Date.now() < this.nextOpenCodeProbe)) return;
		this.probedLogin = generation;
		this.nextOpenCodeProbe = Date.now() + INVENTORY_RETRY_MS;
		try {
			await this.ensureImage(pin);
			const options = await probeHarnessOptions(this, pin, login?.providers ?? login?.provider ?? "free");
			// The terminal can replace the credential while the offline probe is running.
			await this.refreshLogin();
			if ((this.opencodeLogin?.generation ?? "signed-out") === generation) {
				this.opencodeOptions = options;
				this.nextOpenCodeProbe = Date.now() + INVENTORY_TTL_MS;
			}
		} catch { console.log("Could not read OpenCode model options."); }
	}
	private async restoreRelay() {
		if (this.codex && this.codexCredential && [...this.boxes.values()].some(b => b.harness === "codex"))
			await withLoginVolume(this, async () => { const login = codexLogin(this); if (login) await ensureRelay(this,login); });
		if (this.opencode && this.opencodeLogin && [...this.boxes.values()].some(b => b.harness === "opencode")) {
			await withLoginVolume(this, async () => { const login = currentProvider(this); if (login) await ensureRelay(this, login); });
		}
		if (this.claude && this.signIn === "token" && [...this.boxes.values()].some(b => b.harness === "claude" && !b.legacyClaude))
			await this.ensureSignedInRelay();
	}
	private async refreshClaudeOptions(force = false) {
		const pin = this.claudePin;
		if (!pin || (!force && Date.now() < this.nextClaudeProbe)) return;
		this.nextClaudeProbe = Date.now() + INVENTORY_RETRY_MS;
		try {
			await this.ensureImage(pin);
			// Read the pinned adapter with a dummy token, even before login.
			this.claudeOptions = await probeHarnessOptions(this, pin);
			this.nextClaudeProbe = Date.now() + INVENTORY_TTL_MS;
		} catch { console.log("Could not read Claude Code model options."); }
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
		const rows = await dockerOutput(["ps", "-a", ...filters, "--format", `{{.Names}}|{{.State}}|{{.Label "${LABEL}.session"}}|{{.Label "${LABEL}.profile"}}|{{.Label "${LABEL}.harness"}}|{{.Label "${LABEL}.egress"}}|{{.Label "${LABEL}.relay-session"}}`]);
		const found = new Set<string>();
		for (const line of rows.trim().split("\n")) {
			const [name, state, sessionId, profile, harness, egress, relay] = line.split("|");
			const raw = /^wlp-session-((?:(?:claude|opencode|codex)-)?[a-f0-9]{12})$/.exec(name)?.[1];
			if (!raw || (raw.startsWith("claude-") && harness !== "claude") || (raw.startsWith("opencode-") !== (harness === "opencode")) || (raw.startsWith("codex-") !== (harness === "codex")) || (harness && harness !== "claude" && harness !== "opencode" && harness !== "codex") || !NAME.test(sessionId) || (profile !== bubblewrap && profile !== "docker-hardened")) continue;
			const id = externalId(this.identity.machineId, raw);
			found.add(id);
			const box = this.boxes.get(id) ?? { raw, sessionId, profile, ...(harness === "claude" || harness === "opencode" || harness === "codex" ? { harness: harness as MachineHarness } : {}), usedAt: Date.now(), busy: 0, workspaceChecked: false };
			this.boxes.set(id, Object.assign(box, { egress, legacyClaude: !!harness && !/^[0-9a-f]{32}$/.test(relay), state: state === "running" || state === "restarting" ? "running" as const : "paused" as const }));
		}
		for (const [id, box] of this.boxes) {
			if ((!onlySession || box.sessionId === onlySession) && !found.has(id)) this.boxes.delete(id);
		}
		this.dockerHealth = { ok: true };
	}
	async secureCredentialPath() {
		if (this.credentialPathChecked) return;
		if (this.claude) await withLoginVolume(this, () => stopLegacyClaude(this));
		else await retireClaudeRelay(this);
		if (!this.codex && codexLogin(this)) await withLoginVolume(this, () => removeRelay(this,"codex"));
		if (!this.opencode && currentProvider(this)) await withLoginVolume(this, () => removeRelay(this, "opencode"));
		const pair = loadPair();
		if (pair?.current.machineId === this.identity.machineId) {
			for (const old of pair.previous) {
				const machine = new MachineDocker(old);
				await retireClaudeRelay(machine);
				if (codexLogin(machine)) await withLoginVolume(machine, () => removeRelay(machine,"codex"));
				if (currentProvider(machine)) await withLoginVolume(machine, () => removeRelay(machine, "opencode"));
			}
		}
		this.credentialPathChecked = true;
	}
	// Run only after this pairing's authenticated welcome. Stop an old container before
	// advertising a tighter policy. Its workspace remains available to the owner.
	private async reconcileEgress() {
		await this.discover();
		const running = new Set<string>();
		for (const [id, box] of this.boxes) {
			if (box.state !== "running") continue;
			if (box.legacyClaude || (box.egress || "open") !== this.network.policy.mode) {
				await this.lifecycle("suspend", id);
				continue;
			}
			if (!box.egress) await this.network.migrateOpen(containerName(box.raw));
			if (box.egress === "restricted" || box.harness) {
				await this.network.attach(box.raw, containerName(box.raw));
				running.add(box.raw);
			}
		}
		await this.network.reconcile(running);
	}
	async refresh(): Promise<void> {
		try {
			await this.secureCredentialPath();
			if (this.enforceEgress) {
				try { await this.reconcileEgress(); this.egressError = undefined; }
				catch (error) {
					this.egressError = error instanceof RunnerError ? error.message : "Docker could not apply the runner’s network policy.";
					throw new RunnerError(this.egressError);
				}
			} else if (this.dockerHealth.ok) await dockerOutput(["version", "--format", "{{.Server.Version}}"]);
			else await this.discover();
			await this.refreshLogin();
			if (this.inventoryStarted) {
				await this.refreshClaudeOptions();
				await this.refreshOpenCodeOptions();
				await this.refreshCodexOptions();
			}
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
			const stale = await dockerOutput(["ps", "-aq", ...this.filters(), "--filter", "label=" + legacyLoginLabel]);
			for (const id of stale.trim().split(/\s+/).filter(Boolean)) {
				if (signal.aborted) return;
				await docker(["rm", "-f", id]);
			}
			await this.ensureImage();
			await this.serial(async () => {
				if (signal.aborted) return;
				if (this.signIn === "unknown") await this.refreshLogin();
				await this.restoreRelay();
				this.inventoryStarted = true;
				await this.refreshClaudeOptions();
				await this.refreshOpenCodeOptions();
				await this.refreshCodexOptions();
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
		const harnesses: NonNullable<Report["harnesses"]> = [];
		if (this.claudePin) harnesses.push({
			id: "claude", adapter: "claude-agent-acp " + claudePackage.dependencies["@agentclientprotocol/claude-agent-acp"],
			image: this.claudePin.split("@").at(-1)!, signIn: this.signIn, loginGeneration: this.claudeGeneration,
			...(this.claudeOptions && { options: this.claudeOptions }),
		});
		if (this.codexPin) harnesses.push({
			id:"codex", adapter:"codex-acp 2.9.0", image:this.codexPin.split("@").at(-1)!,
			signIn:!this.dockerHealth.ok ? "unknown" : this.codexCredential ? "token" : "none",
			...(this.codexCredential && {method:this.codexCredential.provider === "chatgpt" ? "chatgpt" : "api-key"}),
			modes:reportedCodexModes(!!this.codexInner),
			...(!this.codexInner && {modeReason:innerModesReason}),
			...(this.codexOptions && {options:this.codexOptions}),
		});
		if (this.opencodePin) harnesses.push({
			id: "opencode", adapter: "OpenCode 1.19.6", image: this.opencodePin.split("@").at(-1)!,
			signIn: !this.dockerHealth.ok ? "unknown" : this.opencodeLogin ? "token" : "none",
			loginGeneration: this.opencodeLogin?.generation,
			...(this.opencodeOptions && { options: this.opencodeOptions }),
		});
		return { kind: "report", egress: this.network.policy.mode, allowedProfiles: this.allowedProfiles,
			slots: this.slots,
			host: { cpus: availableParallelism(), sandboxCpus: this.slots?.unit.cpus ?? 1, memoryBytes: totalmem(), memoryFreeBytes: freemem(), load1: loadavg()[0] ?? null },
			docker: this.egressError ? { ok: false, reason: this.egressError } : this.dockerHealth,
			...(this.claudePin && { claudeRelay: true as const }),
			...(harnesses.length ? { harnesses } : {}),
			...(this.screenshots ? { screenshots: true } : {}),
			commandSandbox: this.commandSandbox, freeDiskBytes: this.freeDiskBytes,
			sandboxes: [...this.boxes.entries()].slice(0, MAX_REPORTED_SANDBOXES).map(([id, { sessionId, state, usedAt, resizePending }]) => ({ id, sessionId, state, usedAt, resizePending })),
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
	async existing(sessionId: string, profile: Profile, harness?: MachineHarness) {
		this.requireProfile(profile);
		if (this.egressError) throw new Refusal(this.egressError);
		// The owner may have removed the container since discovery. Refresh just this
		// session once the rest of the inventory is known, before applying capacity limits.
		if (!this.dockerHealth.ok) await this.discover();
		else if ([...this.boxes.values()].some(box => box.sessionId === sessionId)) await this.discover(sessionId);
		else return;
		for (const [id, box] of this.boxes) {
			if (box.sessionId === sessionId) {
				this.requireRelaySession(box);
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
	async create(sessionId: string, profile: Profile, screenshots = false, harness?: MachineHarness, size = 1, prepared?: SnapshotSelection & { privateData: boolean }) {
		// Another create could have finished while this one waited for the image.
		if (harness) this.requireHarness(profile, harness);
		const existing = await this.existing(sessionId, profile, harness);
		if (existing) return existing;
		if (this.limits.maxSandboxes !== undefined && this.boxes.size >= this.limits.maxSandboxes)
			throw new SandboxUserError("This machine has reached its own limit on kept sandboxes, set by --max-sandboxes.");
		this.room();
		await this.network.prepare();
		this.freeDiskBytes = await this.disk();
		if (this.freeDiskBytes < 5_000_000_000) throw new Refusal("Docker needs at least 5 GB free to create a sandbox.");
		const input = { uid: this.identity.uid, sessionId, profile, size };
		const raw = harness ? await withLoginVolume(this, () => (harness === "codex" ? this.codexProvider! : harness === "opencode" ? this.opencodeProvider! : this.claudeProvider!).create({ ...input, harness })) : await this.provider.create({ ...input, fromSnapshot: prepared, privateData: prepared?.privateData, screenshots: this.screenshots && screenshots });
		const id = externalId(this.identity.machineId, raw);
		this.boxes.set(id, { raw, sessionId, profile, harness, snapshotCandidate: !!prepared?.writer && !prepared.privateData && !harness, egress: this.network.policy.mode, state: "running", usedAt: Date.now(), busy: 0, workspaceChecked: true });
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
	async saveSnapshot(session: string, id: string, source: SnapshotSource) {
		const box = this.running(id, session);
		if (!box.snapshotCandidate || box.busy || box.harness) return false;
		box.snapshotCandidate = false;
		box.savingSnapshot = true;
		try { return await this.provider.saveSnapshot(box.raw, source); }
		finally { box.savingSnapshot = false; }
	}
	private owned(id: string, session?: string) {
		rawId(this.identity.machineId, id);
		const box = this.boxes.get(id);
		if (box && session !== undefined && box.sessionId !== session) throw new Refusal("This sandbox belongs to another session.");
		return box;
	}
	private requireRelaySession(box: Box) {
		if (box.legacyClaude) throw new Refusal("This Claude session predates credential isolation. Archive its workspace locally and recreate the session.");
	}
	running(id: string, session: string) {
		const box = this.owned(id, session);
		if (!box || box.state !== "running") throw new Refusal("Commands require a running sandbox owned by this machine and session.");
		this.requireProfile(box.profile);
		this.requireEgress(box);
		this.requireRelaySession(box);
		if (box.harness) this.requireHarness(box.profile, box.harness);
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
			this.requireRelaySession(box);
			this.requireProfile(box.profile);
			this.requireEgress(box);
			if (box.harness) {
				this.requireHarness(box.profile, box.harness);
				if (box.harness === "claude") await this.ensureSignedInRelay();
				else await withLoginVolume(this, async () => {
					const login = box.harness === "codex" ? codexLogin(this) : currentProvider(this);
					if (!login) throw new Refusal(`Run windlass-runner login ${box.harness} on this machine.`);
					await ensureRelay(this, login);
				});
			}
			if (box.state === "paused") this.room();
			const handle = await this.provider.connect(box.raw);
			if (!!box.resizePending !== !!handle?.resizePending) {
				box.resizePending = handle?.resizePending || undefined;
				this.publishReport?.();
			}
			this.noteState(id, box, handle ? "running" : "none");
			if (!handle) return null;
			if (!box.egress) await this.network.migrateOpen(containerName(box.raw));
			await this.network.attach(box.raw, containerName(box.raw));
			return { cwd: handle.cwd, profile: box.profile, ...(handle.snapshot && { snapshot: handle.snapshot }), ...(box.harness ? { harness: box.harness } : {}), ...(this.screenshots && !box.harness ? { screenshots: true } : {}) };
		}
		// The server names the token by the external sandbox id; the provider knows the raw id.
		if (box.state === "running") {
			const path = tokenFilePath(id);
			await new DockerSandboxHandle(box.raw, box.profile, this.identity.uid).removeFiles([path, path + ".tmp"]);
		}
		if (op === "destroy") await this.remove(id);
		else {
			if (box.egress === "restricted" || box.harness) await this.network.detach(box.raw);
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
		if (egress === "restricted" || harness) await this.network.detach(raw);
		await this.provider.destroy(raw);
		this.boxes.delete(id);
		if (harness === "claude") await withLoginVolume(this, async () => {
			if (await loginFileState(this).catch(() => "unknown") === "none") {
				await removeRelay(this);
				await dropDetachedLoginVolume(this);
			}
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
	override async logout() {
		const { uid, machineId } = this.identity;
		await removeRunningTokenFiles(uid, machineId, raw => externalId(machineId, raw));
		await super.logout(); // Files left on the volume by previous runner versions.
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
			await this.provider.dropSnapshots(this.identity.uid);
			await dropPreviousSnapshots(this.identity);
			const volumes = await docker(["volume", "ls", "-q", ...this.filters()], { check: true });
			for (const name of volumes.stdout.trim().split(/\s+/).filter(Boolean)) await this.dropVolume(name);
		});
	}
}
