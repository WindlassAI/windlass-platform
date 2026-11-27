/**
 * The Agents home's filters: by status, agent, where it runs and kind. One menu, opened from the list's
 * header and from the rail, with each choice a check that leaves the menu open; the filters that are on
 * stand beside it as chips, each with the way to take it off.
 */
import type { HarnessId, MachineSummary } from "@contract";
import { HARNESS_DISPLAY_ORDER, HARNESS_NAMES } from "../lib/acp";
import { machineLabel } from "../lib/machines";
import {
	KIND_FILTERS,
	KIND_FILTER_WORD,
	NO_FILTERS,
	STATUS_FILTERS,
	STATUS_FILTER_WORD,
	filterCount,
	toggleFilter,
	type Filters,
} from "../lib/workspace";
import { CrossIcon, SlidersIcon } from "./Icons";
import { Menu, type MenuGroup, type MenuSpec } from "./ui/Menu";

export interface FilterProps {
	filters: Filters;
	onChange(filters: Filters): void;
	/** The user's machines, where the deployment offers them: each is a place to filter by. */
	machines: readonly MachineSummary[];
}

/** What one place filter says: "Hosted", or the machine's name. */
export function placeWord(place: string, machines: readonly MachineSummary[]): string {
	if (place === "hosted") return "Hosted";
	const id = place.slice("machine:".length);
	const machine = machines.find(one => one.machineId === id);
	return machine ? machineLabel(machine) : "A removed machine";
}

function filterSpec({ filters, onChange, machines }: FilterProps): MenuSpec {
	const check = <K extends keyof Filters>(key: K, value: Filters[K][number], label: string) => ({
		id: `${key}:${value}`,
		label,
		checked: (filters[key] as string[]).includes(value),
		keepOpen: true,
		onSelect: () => onChange(toggleFilter(filters, key, value)),
	});
	const places = ["hosted", ...machines.map(machine => `machine:${machine.machineId}`)];
	// A machine filtered by that was removed since stays in the menu, so that it can be taken off.
	for (const place of filters.place) if (!places.includes(place)) places.push(place);
	const groups: MenuGroup[] = [
		{
			id: "status",
			label: "Status",
			items: STATUS_FILTERS.map(status => check("status", status, STATUS_FILTER_WORD[status])),
		},
		{
			id: "agent",
			label: "Agent",
			items: HARNESS_DISPLAY_ORDER.map(agent => check("agent", agent, HARNESS_NAMES[agent])),
		},
		{ id: "place", label: "Runs on", items: places.map(place => check("place", place, placeWord(place, machines))) },
		{ id: "kind", label: "Kind", items: KIND_FILTERS.map(kind => check("kind", kind, KIND_FILTER_WORD[kind])) },
	];
	return {
		label: "Filter",
		groups,
		hints: false,
		width: 260,
		maxHeight: 460,
		footer:
			filterCount(filters) > 0 ? (
				<button type="button" className="link ws-filter-clear" onClick={() => onChange(NO_FILTERS)}>
					Clear filters
				</button>
			) : undefined,
	};
}

/** The menu's button: "Filter", with how many are on. `compact` is the rail's, an icon alone. */
export function FilterMenu({ compact = false, ...props }: FilterProps & { compact?: boolean }) {
	const on = filterCount(props.filters);
	return (
		<Menu
			spec={filterSpec(props)}
			align={compact ? "start" : "end"}
			trigger={trigger => (
				<button
					{...trigger}
					type="button"
					className={`ws-filter-button${compact ? " ws-filter-button-compact" : ""}${on > 0 ? " ws-filter-button-on" : ""}`}
					aria-label={on > 0 ? `Filter, ${on} on` : "Filter"}
					title={compact ? "Filter the repositories and lists" : undefined}
				>
					<SlidersIcon size={14} />
					{compact ? null : <span>Filter</span>}
					{on > 0 ? <span className="ws-filter-count">{on}</span> : null}
				</button>
			)}
		/>
	);
}

/** The filters that are on, as chips: each takes itself off. Nothing when none is on. */
export function ActiveFilters({ filters, onChange, machines }: FilterProps) {
	if (filterCount(filters) === 0) return null;
	const chips: { key: string; label: string; off(): void }[] = [
		...filters.status.map(status => ({
			key: `status:${status}`,
			label: STATUS_FILTER_WORD[status],
			off: () => onChange(toggleFilter(filters, "status", status)),
		})),
		...filters.agent.map((agent: HarnessId) => ({
			key: `agent:${agent}`,
			label: HARNESS_NAMES[agent],
			off: () => onChange(toggleFilter(filters, "agent", agent)),
		})),
		...filters.place.map(place => ({
			key: `place:${place}`,
			label: placeWord(place, machines),
			off: () => onChange(toggleFilter(filters, "place", place)),
		})),
		...filters.kind.map(kind => ({
			key: `kind:${kind}`,
			label: KIND_FILTER_WORD[kind],
			off: () => onChange(toggleFilter(filters, "kind", kind)),
		})),
	];
	return (
		<ul className="ws-chips" aria-label="Filters on">
			{chips.map(chip => (
				<li key={chip.key}>
					<button type="button" className="ws-chip" onClick={chip.off} aria-label={`Remove the filter ${chip.label}`}>
						{chip.label}
						<CrossIcon size={10} />
					</button>
				</li>
			))}
		</ul>
	);
}

/** The filters' bar of a list: the chips of what is on, and the menu. */
export function FilterBar(props: FilterProps) {
	return (
		<div className="ws-filter-bar">
			<ActiveFilters {...props} />
			<FilterMenu {...props} />
		</div>
	);
}

/** A list's header: its title and how many, over a rule. */
export function ListHeader({ id, title, count }: { id?: string; title: string; count?: number | null }) {
	return (
		<div className="ws-list-head">
			<h2 className="ws-section-title" id={id}>
				{title}
				{count !== null && count !== undefined ? <span className="ws-section-count">{count}</span> : null}
			</h2>
		</div>
	);
}
