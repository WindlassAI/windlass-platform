import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docker, LABEL, LABEL_ARG } from "../../server/src/sandbox/docker.js";
import { type Egress } from "./egress-policy.js";
import { image, type MachineDocker } from "./policy.js";
import { Refusal } from "./state.js";

declare const EGRESS_SOURCE: string;
const proxy = "http://127.0.0.1:17891";
const roleLabel = LABEL + ".egress-helper";
const revisionLabel = LABEL + ".egress-revision";
const checked = (args: string[]) => docker(args, { check: true, timeoutMs: 30_000 });
const icc = "com.docker.network.bridge.enable_icc";
const ready = `
const net = require("node:net");
const deadline = Date.now() + 8000;
const address = process.argv[1] === "broker" ? { path: "/workspace/egress.sock" } : { host: "127.0.0.1", port: 17891 };
function probe() {
	const socket = net.connect(address);
	socket.once("connect", () => socket.end());
	socket.on("error", () => {
		if (Date.now() >= deadline) process.exit(1);
		setTimeout(probe, 50);
	});
}
probe();`;

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
			HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
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
	private async ensure(role: "broker" | "forward", name: string, revision: string, network: string, source: string) {
		const existing = await this.helper(name, role);
		if (existing?.revision === revision && existing.running) return;
		if (existing) await checked(["rm", "-f", existing.id]);
		const volume = this.prefix + "-socket";
		const args = role === "broker" ? [JSON.stringify(this.policy.allow)] : [];
		const started = await checked(["run", "-d", "--pull", "never", "--name", name,
			"--label", LABEL_ARG, ...this.machine.pairingLabelFlags, "--label", roleLabel + "=" + role,
			"--label", revisionLabel + "=" + revision, "--network", network, "--user", "agent", "--cap-drop", "ALL",
			"--read-only", "--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "128m", "--cpus", "0.5",
			"--log-driver", "none", "--mount", `type=volume,src=${volume},dst=/workspace${role === "forward" ? ",readonly" : ""}`,
			image, "node", "--input-type=module", "-e", source, "--", "wlp-egress-" + role, ...args]);
		const id = started.stdout.trim();
		try { await checked(["exec", id, "node", "-e", ready, role]); }
		catch (err) { await checked(["rm", "-f", id]); throw err; }
	}
	async attach(raw: string, container: string) {
		if (this.policy.mode !== "restricted") return;
		const source = typeof EGRESS_SOURCE === "string" ? EGRESS_SOURCE : readFileSync(join(import.meta.dirname, "egress-proxy.mjs"), "utf8");
		const revision = createHash("sha256").update(JSON.stringify([image, source, this.policy.allow])).digest("hex");
		await this.machine.ownedVolume(true, this.prefix + "-socket");
		await this.ensure("broker", this.prefix, revision, "host", source);
		// A stopped container receives a fresh loopback namespace on start.
		const started = await checked(["inspect", "-f", "{{.Id}}|{{.State.StartedAt}}", container]);
		await this.ensure("forward", this.prefix + "-" + raw, revision + "-" + started.stdout.trim().replace("|", "-"), "container:" + container, source);
	}
	async detach(raw: string) {
		const helper = await this.helper(this.prefix + "-" + raw, "forward");
		if (helper) await checked(["rm", "-f", helper.id]);
	}
	async reconcile(running: Set<string>) {
		const flags = Object.entries(this.machine.labels).flatMap(([k, v]) => ["--filter", "label=" + k + "=" + v]);
		const rows = await checked(["ps", "-a", "--filter", "label=" + LABEL_ARG, ...flags, "--filter", "label=" + roleLabel, "--format", "{{.Names}}"]);
		for (const name of rows.stdout.trim().split("\n").filter(Boolean)) {
			if (name === this.prefix) {
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
