/**
 * A toolbar control that shows a value and opens its picker: a glyph, the value, a quieter second
 * part ("· Sonnet 5.5"), a dot (changed from the saved default, or a warning), and a chevron. Spread a
 * Menu's trigger props on it.
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import type { HarnessId } from "@contract";
import { HARNESS_NAMES } from "../../lib/acp";
import { ClaudeLogo, CodexLogo, OpenCodeLogo } from "../AgentLogos";
import { ChevronDownIcon, Mark } from "../Icons";

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	icon?: ReactNode;
	/** The quieter part after the value. */
	secondary?: ReactNode;
	/** A dot after the value: "changed" (differs from its saved default), "warn" (something open, or a problem), "ok" (a machine online). */
	dot?: "changed" | "warn" | "ok" | "off" | null;
	/** What the dot means, for assistive technology. */
	dotLabel?: string;
	chevron?: boolean;
	/** Outlined, for a control that stands apart (the mode). */
	outlined?: boolean;
	ref?: Ref<HTMLButtonElement>;
	children: ReactNode;
}

export function Pill({ icon, secondary, dot = null, dotLabel, chevron = true, outlined = false, className, children, type = "button", ...rest }: PillProps) {
	return (
		<button type={type} className={`ui-pill${outlined ? " ui-pill-outlined" : ""}${dot === "warn" ? " ui-pill-warn" : ""}${dot === "changed" ? " ui-pill-changed" : ""}${className ? ` ${className}` : ""}`} {...rest}>
			{icon ? <span className="ui-pill-icon">{icon}</span> : null}
			<span className="ui-pill-value">{children}</span>
			{secondary ? <span className="ui-pill-secondary">{secondary}</span> : null}
			{dot ? (
				<span className={`ui-dot ui-dot-${dot}`} role={dotLabel ? "img" : undefined} aria-label={dotLabel} aria-hidden={dotLabel ? undefined : true} />
			) : null}
			{chevron ? <ChevronDownIcon size={12} className="ui-pill-chevron" /> : null}
		</button>
	);
}

/** An agent's id from its id or its name ("claude", "Claude Code"); Windlass's for one it does not know. */
export function agentId(harness: string): HarnessId {
	if (harness in HARNESS_NAMES) return harness as HarnessId;
	const found = (Object.entries(HARNESS_NAMES) as Array<[HarnessId, string]>).find(([, name]) => name === harness);
	return found?.[0] ?? "windlass";
}

/**
 * An agent's badge: its own logo in a small square (components/AgentLogos.tsx; Windlass's is the app's
 * mark). Every agent badge is this one. Takes the harness's id ("claude") or its name.
 */
export function AgentGlyph({ harness, accent = false, size = 13, inline = false }: { harness: string; accent?: boolean; size?: number; /** In a line of text, before the agent's name. */ inline?: boolean }) {
	const id = agentId(harness);
	return (
		<span className={`ui-glyph ui-glyph-logo${accent ? " ui-glyph-accent" : ""}${inline ? " ui-glyph-inline" : ""}`} aria-hidden="true" data-agent={id}>
			<AgentLogo id={id} size={size} />
		</span>
	);
}

/** The logo alone, by the agent's id. */
export function AgentLogo({ id, size = 16 }: { id: HarnessId; size?: number }) {
	switch (id) {
		case "claude":
			return <ClaudeLogo size={size} />;
		case "codex":
			return <CodexLogo size={size} />;
		case "opencode":
			return <OpenCodeLogo size={size} />;
		default:
			return <Mark size={size} />;
	}
}
