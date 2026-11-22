import { RUNNER_HTTP_PROXY as proxy } from "../../server/src/runner/egress.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docker, LABEL, LABEL_ARG, NO_LOGS } from "../../server/src/sandbox/docker.js";
import { waitForListener } from "./helper-ready.js";
import { relaySocketVolume } from "./claude-relay.js";
import { providerHosts } from "./opencode-providers.js";
import { type Egress } from "./egress-policy.js";
import { image, type MachineDocker } from "./policy.js";
import { Refusal } from "./state.js";

declare const EGRESS_SOURCE: string;

const roleLabel = LABEL + ".egress-helper";
const revisionLabel = LABEL + ".egress-revision";
const checked = (args: string[]) => docker(args, { check: true, timeoutMs: 30_000 });
const icc = "com.docker.network.bridge.enable_icc";
export class EgressNetwork {
	readonly openNet: string;
	private readonly prefix: string;
	constructor(private readonly machine: MachineDocker, readonly policy: Egress) {
		this.prefix = "wlp-egress-" + machine.identity.machineId;
		this.openNet = "wlp-open-" + machine.identity.machineId;
	}
	sandboxNetwork() {
		const env: Record<string, string> = {};
		if (this.policy.mode === "restricted") Object.assign(env, {
			HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy,
			NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1", NODE_USE_ENV_PROXY: "1",
		});
		return { name: this.policy.mode === "open" ? this.openNet : "none", env, mode: this.policy.mode };
	}
	private owns(labels: Record<string, string> | undefined) {
		return labels?.[LABEL] === "1" && Object.entries(this.machine.labels).every(([k, v]) => labels[k] === v);
	}
	private async openBridge(create: boolean) {
		const args = ["network", "inspect", "--format", "{{json .}}", this.openNet];
		let result = await docker(args, { timeoutMs: 30_000 });
		if (result.code !== 0) {
			if (!/No such network|network .* not found/i.test(result.stderr)) throw new Refusal("Docker could not check the open egress bridge.");
			if (!create) return;
			await checked(["network", "create", "--driver", "bridge", "--opt", icc + "=false",
				"--label", LABEL_ARG, ...this.machine.pairingLabelFlags, this.openNet]);
			result = await checked(args);
		}
		const net = JSON.parse(result.stdout);
		if (!this.owns(net.Labels) || net.Driver !== "bridge" || net.Options?.[icc] !== "false" || net.Internal)
			throw new Refusal("The open egress bridge does not belong to this pairing or allows traffic between agents.");
		return net.Id as string;
	}
	// Before adopting an older open sandbox, move it off Docker's shared default bridge.
	async migrateOpen(container: string) {
		await this.openBridge(true);
		const result = await checked(["inspect", "-f", "{{json .NetworkSettings.Networks}}", container]);
		const networks = Object.keys(JSON.parse(result.stdout));
		if (networks.some(n => n !== "bridge" && n !== this.openNet)) throw new Refusal("Unexpected network on the existing sandbox.");
		if (!networks.includes(this.openNet)) await checked(["network", "connect", this.openNet, container]);
		if (networks.includes("bridge")) await checked(["network", "disconnect", "bridge", container]);
	}
	async prepare() {
		if (this.policy.mode === "open") await this.openBridge(true);
	}
	private async helper(name: string, role: "broker" | "forward") {
		const result = await docker(["container", "inspect", "--format", "{{.Id}}|{{.State.Running}}|{{json .Config.Labels}}", name], { timeoutMs: 30_000 });
		if (result.code !== 0) {
			if (/No such (object|container)/i.test(result.stderr)) return;
			throw new Refusal("Docker could not check the egress helper.");
		}
		const [id, running, json] = result.stdout.trim().split("|");
		const labels = JSON.parse(json);
		if (!this.owns(labels) || labels[roleLabel] !== role) throw new Refusal("The egress helper name belongs to another container.");
		return { id, running: running === "true", revision: labels[revisionLabel] };
	}
	private async ensure(role: "broker" | "forward", name: string, revision: string, network: string, source: string, mounts: string[], args: string[], probes: string[]) {
		const existing = await this.helper(name, role);
		if (existing?.revision === revision && existing.running) return;
		if (existing) await checked(["rm", "-f", existing.id]);
		// A runner upgrade may restore a kept session before welcome prepares the new pin.
		await this.machine.ensureImage();
		const started = await checked(["run", "-d", "--pull", "never", "--name", name,
			"--label", LABEL_ARG, ...this.machine.pairingLabelFlags, "--label", roleLabel + "=" + role,
			"--label", revisionLabel + "=" + revision, "--network", network, "--user", "agent", "--cap-drop", "ALL",
			"--read-only", "--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "128m", "--cpus", "0.5",
			...NO_LOGS, ...mounts.flatMap(mount => ["--mount", mount]),
			image, "node", "--input-type=module", "-e", source, "--", "wlp-egress-" + role, ...args]);
		const id = started.stdout.trim();
		try { for (const probe of probes) await waitForListener(id, probe); }
		catch (err) { await checked(["rm", "-f", id]); throw err; }
	}
	async attach(raw: string, container: string) {
		const proxyEnabled = this.policy.mode === "restricted";
		const harness = raw.startsWith("claude-") ? "claude" : raw.startsWith("opencode-") ? "opencode" : raw.startsWith("codex-") ? "codex" : undefined;
		if (!proxyEnabled && !harness) return;
		const source = typeof EGRESS_SOURCE === "string" ? EGRESS_SOURCE : readFileSync(join(import.meta.dirname, "egress-proxy.mjs"), "utf8");
		const denied = !proxyEnabled ? [] : harness === "codex" ? ["api.openai.com", "auth.openai.com", "chatgpt.com"] : harness === "opencode" ? providerHosts : [];
		const revision = createHash("sha256").update(JSON.stringify([image, source, this.policy, denied])).digest("hex");
		const mounts: string[] = [], probes: string[] = [];
		if (proxyEnabled) {
			const broker = denied.length ? `${this.prefix}-${harness}-broker` : this.prefix;
			const volume = broker + "-socket";
			await this.machine.ownedVolume(true, volume);
			const mount = `type=volume,src=${volume},dst=/workspace`;
			await this.ensure("broker", broker, revision, "host", source, [mount], [JSON.stringify(this.policy.allow), JSON.stringify(denied), JSON.stringify(this.policy.domains ?? null)], ["/workspace/egress.sock"]);
			mounts.push(mount + ",readonly");
			probes.push("17891");
		}
		// The nonce is an immutable runner-issued container label, outside the agent filesystem.
		// Including StartedAt ties this helper to this incarnation of the network namespace.
		const started = await checked(["inspect", "-f", `{{.Id}}|{{.State.StartedAt}}|{{with index .Config.Labels "${LABEL}.relay-session"}}{{.}}{{end}}`, container]);
		const [id, since, nonce] = started.stdout.trim().split("|");
		if (harness) {
			if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Refusal("This session needs a new relay endpoint.");
			const volume = relaySocketVolume(this.machine, harness);
			if (!await this.machine.ownedVolume(false, volume)) throw new Refusal("The session relay socket volume is missing.");
			mounts.push(`type=volume,src=${volume},dst=/run/wlp-relay,readonly,volume-nocopy`);
			probes.push("17892");
		}
		await this.ensure("forward", this.prefix + "-" + raw, [revision, id, since, nonce].join("-"), "container:" + container,
			source, mounts, [this.policy.mode, ...(harness ? [nonce] : []), ...(harness === "codex" ? ["codex"] : [])], probes);
	}
	async detach(raw: string) {
		const helper = await this.helper(this.prefix + "-" + raw, "forward");
		if (helper) await checked(["rm", "-f", helper.id]);
	}
	async reconcile(running: Set<string>) {
		const flags = Object.entries(this.machine.labels).flatMap(([k, v]) => ["--filter", "label=" + k + "=" + v]);
		const rows = await checked(["ps", "-a", "--filter", "label=" + LABEL_ARG, ...flags, "--filter", "label=" + roleLabel, "--format", "{{.Names}}"]);
		for (const name of rows.stdout.trim().split("\n").filter(Boolean)) {
			if (name === this.prefix || name === this.prefix + "-opencode-broker" || name === this.prefix + "-codex-broker") {
				if (this.policy.mode === "restricted" && running.size) continue;
				const helper = await this.helper(name, "broker");
				if (helper) await checked(["rm", "-f", helper.id]);
			} else if (name.startsWith(this.prefix + "-")) {
				const raw = name.slice(this.prefix.length + 1);
				if (!running.has(raw)) await this.detach(raw);
			}
		}
	}
	async prune() {
		const id = await this.openBridge(false);
		if (id) await checked(["network", "rm", id]);
	}
}
