/**
 * The agent's mode (lib/modes.ts says whose modes they are), where it is chosen: in a session's
 * composer and in the start composer's toolbar. A small pill with the mode's name opens the list, each
 * mode with its description in a line under it, so the choice can be made without knowing the names.
 */
import type { SessionMode } from "@contract";
import { ShieldIcon } from "./Icons";
import { Menu, type MenuSpec } from "./ui/Menu";
import { Pill } from "./ui/Pill";
import { Tooltip } from "./ui/Tooltip";

/**
 * "Auto", in the composer's pill style; pressed, the modes open as a menu, each with its description.
 * `current` is the mode shown as chosen; `title` says what a choice applies to; `warn` marks a mode
 * that runs without asking.
 */
/** The modes as a menu: each with its description under it, the current one checked. */
export function modeMenu(
	modes: SessionMode[],
	current: string,
	onChoose: (mode: string) => void,
	warn = false,
): MenuSpec {
	return {
		label: "Mode",
		width: 300,
		groups: [
			{
				id: "modes",
				items: modes.map(mode => ({
					id: mode.id,
					label: mode.name,
					description: mode.description || undefined,
					title: mode.description || undefined,
					checked: mode.id === current,
					tone: warn && mode.id === current ? ("warn" as const) : undefined,
					onSelect: () => {
						if (mode.id !== current) onChoose(mode.id);
					},
				})),
			},
		],
	};
}

export function ModePicker({
	modes,
	current,
	disabled = false,
	title,
	warn = false,
	onChoose,
	onOpen,
	open,
	onOpenChange,
}: {
	modes: SessionMode[];
	current: string;
	disabled?: boolean;
	title?: string;
	warn?: boolean;
	onChoose(mode: string): void /** Told when the list opens, so that another open list can close. */;
	onOpen?(): void;
	open?: boolean;
	onOpenChange?(open: boolean): void;
}) {
	const chosen = modes.find(mode => mode.id === current) ?? null;
	const spec = modeMenu(modes, current, onChoose, warn);
	const pill = (
		<Menu
			spec={spec}
			align="end"
			open={open}
			onOpenChange={next => {
				if (next) onOpen?.();
				onOpenChange?.(next);
			}}
			trigger={props => (
				<Pill
					{...props}
					outlined
					className="mode-picker"
					data-picker="mode"
					data-value={chosen?.name ?? current}
					icon={<ShieldIcon size={14} />}
					dot={warn ? "warn" : null}
					dotLabel={warn ? "runs without asking" : undefined}
					disabled={disabled}
					aria-label={`Mode: ${chosen?.name ?? current}${title ? `. ${title}` : ""}`}
				>
					{chosen?.name ?? current}
				</Pill>
			)}
		/>
	);
	return title ? <Tooltip content={title}>{pill}</Tooltip> : pill;
}
