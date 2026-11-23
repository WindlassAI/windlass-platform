import type { SandboxProfileId, SessionMode } from "../contract.js";
import { CODEX } from "./harnesses.js";

const name = CODEX.name;

export const containerMode = "agent-full-access";
export const innerModesReason =
	`${name} read-only and workspace-write modes require a successful ${name} sandbox probe on the docker-windlass-sandbox profile.`;
const container: SessionMode = {
	id: containerMode,
	name: "Container access",
	description: "Commands run as agent in this machine’s container, with this machine’s egress setting.",
};
const inner: SessionMode[] = [
	{ id: "read-only", name: "Read-only", description: `Commands run in ${name}’s sandbox without network and cannot change files. Requests to edit or to go outside the sandbox are refused.` },
	{ id: "workspace-write", name: "Workspace access", description: `Commands run in ${name}’s sandbox without network and can change files in the workspace only. Requests to go outside the sandbox are refused.` },
];
/**
 * The Windlass sandbox profile's container is loosened (AppArmor and system paths unconfined, user
 * namespaces and mount allowed) so that a command sandbox can run inside it. Commands there must run
 * in Codex's own sandbox, so Container access is offered only on docker-hardened. Codex's Auto review
 * mode is not offered at all: its reviewer model approves a request to run outside the sandbox, so a
 * prompt injection could reach that looser container. The other two modes ask the client before
 * anything outside the sandbox, and on this profile every such request is refused
 * (`refusesSandboxEscape`, and the image's PermissionRequest hook in sandbox/harness/codex/config.toml).
 */
export function codexModes(profile: SandboxProfileId, probed?: readonly string[]) {
	const modes = profile === "docker-windlass-sandbox" ? inner : [container];
	return modes.filter((mode) => !probed || probed.includes(mode.id));
}
/** Whether a Codex permission request must be refused without asking: on this profile each one leaves Codex's sandbox. */
export const refusesSandboxEscape = (profile: SandboxProfileId) => profile === "docker-windlass-sandbox";
/** The timeline note for a refused request. An edit Codex asks about is one outside its sandbox's writable paths. */
export const sandboxEscapeNote = (kind: unknown) =>
	kind === "edit"
		? `${name} asked to edit files outside its sandbox; refused on this profile.`
		: `${name} asked to run a command outside its sandbox; refused on this profile.`;
/**
 * A work item's turn in which Codex asked to leave its sandbox on this profile fails with this reason
 * (`RunTurnResult.failure`), its message the note above: the request is refused and the turn is stopped,
 * and the item asks its person to file the work again on "Docker, hardened" or to give up.
 */
export const SANDBOX_ESCAPE_REFUSED = "sandbox_escape_refused";
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
