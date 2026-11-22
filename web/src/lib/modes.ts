/**
 * An agent's modes: how it asks before it acts. Each agent has its own list, and the session holds
 * the one chosen for its next prompt (`SessionSummary.mode`).
 *
 * - External agents use the machine's report before their first turn, then the open session's
 *   modes. Older runner reports can omit options. Claude defaults to Auto and OpenCode to Build.
 * - Windlass: Ask, and the approval the sandbox profile was built for (Auto with Windlass's command
 *   sandbox, Full without one), which is the default.
 *
 * A work item's agents keep their profile's mode, and the session lists none (server/src/actors/user.ts).
 */
import { CLAUDE_LAUNCH_MODES, type HarnessId, type SandboxProfile, type SessionMode, type SessionSummary } from "@contract";
import { codexModes, containerMode } from "../../../server/src/sandbox/codex-modes.js";
import { windlassModes } from "../../../server/src/sandbox/profiles.js";

/** What Claude Code is launched in unless chosen otherwise (server/src/sandbox/acp-harness.ts). */
export const CLAUDE_DEFAULT_MODE = "auto";

/** The modes a new agent is offered in a sandbox profile, and the one it starts on. */
export function launchModes(harness: HarnessId, profile: Pick<SandboxProfile, "approval"> | null): { modes: SessionMode[]; default: string } | null {
	if (harness === "claude") return { modes: [...CLAUDE_LAUNCH_MODES], default: CLAUDE_DEFAULT_MODE };
	if (harness === "codex") return { modes: [], default: containerMode };
	if (harness === "opencode") return { modes: [], default: "build" };
	if (profile === null) return null;
	return { modes: windlassModes(profile.approval), default: profile.approval };
}

/** The modes a session can be put in: the ones it reported, or before that the ones its agent is launched with. */
export function sessionModes(summary: Pick<SessionSummary, "harness" | "availableModes">, profile: Pick<SandboxProfile, "approval">): SessionMode[] {
	if (summary.availableModes.length > 0) return summary.availableModes;
	return launchModes(summary.harness ?? "windlass", profile)?.modes ?? [];
}

/** The session's current mode, by its name; a mode its list does not have is shown by its id. */
export function currentMode(summary: Pick<SessionSummary, "harness" | "availableModes" | "mode">, profile: Pick<SandboxProfile, "approval">): SessionMode {
	return sessionModes(summary, profile).find((mode) => mode.id === summary.mode) ?? { id: summary.mode, name: summary.mode, description: null };
}

/** A mode by its name, for a line that names one outside a session: "Plan", "Auto"; an id no list has is shown as it is. */
export function modeName(harness: HarnessId, id: string): string {
	const known = harness === "codex" ? codexModes("docker-windlass-sandbox") : harness === "claude" ? CLAUDE_LAUNCH_MODES : harness === "windlass" ? [...windlassModes("auto"), ...windlassModes("full")] : [];
	return known.find((mode) => mode.id === id)?.name ?? (id.charAt(0).toUpperCase() + id.slice(1));
}

/** The modes that let the agent act without asking anything: said in the warning tone where the sandbox's facts are. */
export const OPEN_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "full", containerMode]);
