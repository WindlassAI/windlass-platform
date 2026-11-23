/**
 * A toolbar control that shows a value and opens its picker: a glyph, the value, a quieter second
 * part ("· Sonnet 5.5"), a dot (changed from the saved default, or a warning), and a chevron. Spread a
 * Menu's trigger props on it.
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { HARNESS_NAMES } from "../../lib/acp";
import { ChevronDownIcon } from "../Icons";

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

/**
 * An agent's badge, from its name (server/src/sandbox/harnesses.ts): the capitals of a name of two words or
 * two parts ("Claude Code" CC, "OpenCode" OC), the initial of a name of one (Windlass W, Codex C). No two
 * agents share one. Takes the harness's id ("claude") or its name.
 */
export function agentBadge(harness: string): string {
	const name = (HARNESS_NAMES as Record<string, string | undefined>)[harness] ?? harness;
	const capitals = name.match(/[A-Z]/g) ?? [];
	return capitals.length >= 2 ? capitals.slice(0, 2).join("") : name.slice(0, 1).toUpperCase();
}

/** An agent's glyph: its badge in a small square (`agentBadge`). */
export function AgentGlyph({ harness, accent = false }: { harness: string; accent?: boolean }) {
	return (
		<span className={`ui-glyph${accent ? " ui-glyph-accent" : ""}`} aria-hidden="true">
			{agentBadge(harness)}
		</span>
	);
}
