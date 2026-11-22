import type { SandboxProfileId, SessionMode } from "../contract.js";

export const containerMode = "agent-full-access";
export const innerModesReason =
	"Codex read-only, workspace-write and agent modes require a successful Codex sandbox probe on the docker-windlass-sandbox profile.";
const container: SessionMode = {
	id: containerMode,
	name: "Container access",
	description: "Commands run as agent in this machine’s container, with this machine’s egress setting.",
};
const inner: SessionMode[] = [
	{ id: "read-only", name: "Read-only", description: "Ask before editing files or using the network." },
	{ id: "workspace-write", name: "Workspace access", description: "Write in the workspace and ask for other access." },
	{ id: "agent", name: "Auto review", description: "Use the workspace sandbox with automatic review." },
];
/**
 * The Windlass sandbox profile's container is loosened (AppArmor and system paths unconfined, user
 * namespaces and mount allowed) so that a command sandbox can run inside it. Commands there must run
 * in Codex's own sandbox, so Container access is offered only on docker-hardened.
 */
export function codexModes(profile: SandboxProfileId, probed?: readonly string[]) {
	const modes = profile === "docker-windlass-sandbox" ? inner : [container];
	return modes.filter((mode) => !probed || probed.includes(mode.id));
}
/** The mode a Codex session starts in on this profile. */
export function codexDefaultMode(profile: SandboxProfileId | undefined) {
	return profile === "docker-windlass-sandbox" ? "workspace-write" : containerMode;
}
/** Every Codex mode, by its name, for a line that names one outside a session. */
export const allCodexModes: readonly SessionMode[] = [container, ...inner];
/** The mode ids a runner reports: Container access, and the inner modes once its probe passed. */
export function reportedCodexModes(innerProbed: boolean) {
	return [...codexModes("docker-hardened"), ...(innerProbed ? codexModes("docker-windlass-sandbox") : [])].map((mode) => mode.id);
}
