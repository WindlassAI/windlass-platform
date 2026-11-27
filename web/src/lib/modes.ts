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
import {
	CLAUDE_LAUNCH_MODES,
	type HarnessId,
	type SandboxProfile,
	type SessionMode,
	type SessionSummary,
} from "@contract";
import { allCodexModes, codexDefaultMode, containerMode } from "../../../server/src/sandbox/codex-modes.js";
import { windlassModes } from "../../../server/src/sandbox/profiles.js";

/** What Claude Code is launched in unless chosen otherwise (server/src/sandbox/acp-harness.ts). */
export const CLAUDE_DEFAULT_MODE = "auto";

type LaunchProfile = (Pick<SandboxProfile, "approval"> & { id?: SandboxProfile["id"] }) | null;
type LaunchModes = { modes: SessionMode[]; default: string };

const LAUNCH_MODES: Record<HarnessId, (profile: LaunchProfile) => LaunchModes | null> = {
	claude: () => ({ modes: [...CLAUDE_LAUNCH_MODES], default: CLAUDE_DEFAULT_MODE }),
	codex: profile => ({ modes: [], default: codexDefaultMode(profile?.id) }),
	opencode: () => ({ modes: [], default: "build" }),
	windlass: profile =>
		profile === null ? null : { modes: windlassModes(profile.approval), default: profile.approval },
};

/** The modes a new agent is offered in a sandbox profile, and the one it starts on. */
export function launchModes(harness: HarnessId, profile: LaunchProfile): LaunchModes | null {
	return LAUNCH_MODES[harness](profile);
}

/** The modes a session can be put in: the ones it reported, or before that the ones its agent is launched with. */
export function sessionModes(
	summary: Pick<SessionSummary, "harness" | "availableModes">,
	profile: Pick<SandboxProfile, "approval">,
): SessionMode[] {
	if (summary.availableModes.length > 0) return summary.availableModes;
	return launchModes(summary.harness ?? "windlass", profile)?.modes ?? [];
}

/** The session's current mode, by its name; a mode its list does not have is shown by its id. */
export function currentMode(
	summary: Pick<SessionSummary, "harness" | "availableModes" | "mode">,
	profile: Pick<SandboxProfile, "approval">,
): SessionMode {
	return (
		sessionModes(summary, profile).find(mode => mode.id === summary.mode) ?? {
			id: summary.mode,
			name: summary.mode,
			description: null,
		}
	);
}

/** Every mode an agent has, in any profile; OpenCode's are its own report's. */
const KNOWN_MODES: Record<HarnessId, () => readonly SessionMode[]> = {
	codex: () => allCodexModes,
	claude: () => CLAUDE_LAUNCH_MODES,
	windlass: () => [...windlassModes("auto"), ...windlassModes("full")],
	opencode: () => [],
};

/** A mode by its name, for a line that names one outside a session: "Plan", "Auto"; an id no list has is shown as it is. */
export function modeName(harness: HarnessId, id: string): string {
	const known = KNOWN_MODES[harness]();
	return known.find(mode => mode.id === id)?.name ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** The modes that let the agent act without asking anything: said in the warning tone where the sandbox's facts are. */
export const OPEN_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "full", containerMode]);
