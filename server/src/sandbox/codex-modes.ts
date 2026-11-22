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
export function codexModes(profile: SandboxProfileId, probed?: readonly string[]) {
	const modes = profile === "docker-windlass-sandbox" ? [container, ...inner] : [container];
	return modes.filter((mode) => !probed || probed.includes(mode.id));
}
