/**
 * The pieces of the start composer's one-line tray (components/StartComposer.tsx), shared by the Agents
 * composer and the Factory's: the agent pill with its model and effort bars (effort is chosen inside
 * the agent's menu, `effortGroup`), the one "where" pill (place · repository / branch), the options
 * icon, and the lock whose tooltip says what the sandbox lets the agent's commands do.
 */
import type { ReactNode } from "react";
import { effortChoices } from "../lib/models";
import { ChevronDownIcon, CloudIcon, LockIcon, MachineIcon, SlidersIcon, WarnIcon } from "./Icons";
import { RepoTile } from "./RepoTile";
import type { MenuGroup, TriggerProps } from "./ui/Menu";
import { AgentGlyph } from "./ui/Pill";
import { Tooltip } from "./ui/Tooltip";

/** An effort as bars, filled to its level. */
export function EffortBars({ level, of }: { level: number; of: number }) {
	const bars = Math.max(of, 3);
	return (
		<span className="effort-bars" aria-hidden="true">
			{Array.from({ length: bars }, (_, index) => (
				<i key={index} className={index < level ? "effort-bar-on" : undefined} style={{ height: 3 + index * (7 / (bars - 1)) }} />
			))}
		</span>
	);
}

/** Where the effort stands among its model's: 0 for the default, one more for each level up. */
export const effortLevel = (efforts: readonly string[], effort: string): number => Math.max(0, effortChoices([...efforts]).indexOf(effort));

/** The effort's rows, as the agent menu's last group. Null for a model with no efforts. */
export function effortGroup(efforts: readonly string[], effort: string, model: string, onChoose: (level: string) => void): MenuGroup | null {
	if (efforts.length === 0) return null;
	return {
		id: "effort",
		label: "Effort",
		note: model,
		items: effortChoices([...efforts]).map((level, index) => ({
			id: `effort:${level || "default"}`,
			value: level || "default",
			label: level || "default",
			textValue: `effort ${level || "default"}`,
			icon: <EffortBars level={index} of={efforts.length} />,
			checked: (effort || "default") === (level || "default"),
			onSelect: () => onChoose(level),
		})),
	};
}

type Dot = "warn" | "changed" | "ok" | "off" | null;

function PillDot({ dot, label }: { dot: Dot; label?: string }) {
	if (!dot) return null;
	return <span className={`ui-dot ui-dot-${dot}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/** The agent: its logo, name and model, and the effort as bars. */
export function AgentPill({ trigger, harness, name, model, effort, efforts, dot, dotLabel, changed, ...data }: { trigger: TriggerProps; harness: string; name: string; model: string; effort: string; efforts: readonly string[]; dot: Dot; dotLabel?: string; changed: boolean; "data-value": string; "data-effort": string; disabled?: boolean }) {
	return (
		<button type="button" {...trigger} {...data} className={`ui-pill tray-pill tray-agent${dot === "warn" ? " ui-pill-warn" : ""}${changed ? " ui-pill-changed" : ""}`} data-picker="agent" aria-label={`Agent: ${name} · ${model}${efforts.length > 0 ? `, effort ${effort || "default"}` : ""}`}>
			<span className="ui-pill-icon">
				<AgentGlyph harness={harness} accent={harness === "windlass"} />
			</span>
			<span className="ui-pill-value tray-hide-phone">{name}</span>
			<span className="ui-pill-secondary tray-hide-phone">{model}</span>
			{efforts.length > 0 ? <EffortBars level={effortLevel(efforts, effort)} of={efforts.length} /> : null}
			<PillDot dot={dot} label={dotLabel} />
			<ChevronDownIcon size={12} className="ui-pill-chevron" />
		</button>
	);
}

/** Where: the place, then the repository's tile and name and its branch. */
export function WherePill({ trigger, machine, place, repository, branch, empty, dot, dotLabel, changed, reading, ...data }: { trigger: TriggerProps; machine: boolean; place: string; repository: string | null; branch: string | null; /** Said where no repository is chosen. */ empty: string; dot: Dot; dotLabel?: string; changed: boolean; reading: boolean; "data-value": string; "data-sandbox": string; "data-repo": string }) {
	return (
		<button type="button" {...trigger} {...data} className={`ui-pill tray-pill tray-where${dot === "warn" ? " ui-pill-warn" : ""}${changed ? " ui-pill-changed" : ""}`} data-picker="where" aria-busy={reading || undefined} aria-label={`Where: ${place}, ${repository ? `${repository}${branch ? ` at ${branch}` : ""}` : empty}`}>
			<span className="ui-pill-icon">{machine ? <MachineIcon size={15} /> : <CloudIcon size={15} />}</span>
			<span className="ui-pill-value tray-place tray-hide-phone">{place}</span>
			<span className="tray-sep tray-hide-phone" aria-hidden="true">
				·
			</span>
			{reading ? (
				<span className="tray-repo">…</span>
			) : repository ? (
				<>
					<RepoTile name={repository.split("/").pop() ?? repository} size="xs" />
					<span className="ui-pill-value tray-repo">{repository.split("/").pop()}</span>
					{branch ? (
						<>
							<span className="tray-sep tray-hide-phone" aria-hidden="true">
								/
							</span>
							<span className="ui-pill-secondary tray-branch tray-hide-phone">{branch}</span>
						</>
					) : null}
				</>
			) : (
				<span className="ui-pill-secondary tray-repo">{empty}</span>
			)}
			<PillDot dot={dot} label={dotLabel} />
			<ChevronDownIcon size={12} className="ui-pill-chevron" />
		</button>
	);
}

/** The options: the rarer settings, a dot when one of them needs a look or is set. */
export function OptionsButton({ trigger, label, dot, value }: { trigger: TriggerProps; label: string; dot: "warn" | "set" | null; /** What the options hold now, for tests and tools: the mode's name. */ value?: string }) {
	return (
		<button type="button" {...trigger} className="tray-icon" data-picker="options" data-value={value} aria-label={label}>
			<SlidersIcon size={15} />
			{dot ? <span className={`tray-icon-dot tray-icon-dot-${dot}`} aria-hidden="true" /> : null}
		</button>
	);
}

/** The lock: what the sandbox lets its commands do, in a tooltip (and in words for assistive technology). The same sentence is in the options. */
export function LockHint({ sentence, open, children }: { sentence: string; open: boolean; children?: ReactNode }) {
	return (
		<Tooltip content={sentence}>
			<button type="button" className={`tray-icon tray-lock start-sandbox${open ? " tray-lock-open start-sandbox-open" : ""}`} aria-label={sentence} data-picker="lock">
				{open ? <WarnIcon size={14} /> : <LockIcon size={14} />}
				{children}
			</button>
		</Tooltip>
	);
}
