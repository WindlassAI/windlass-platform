/**
 * The Agents home: a rail of the user's repositories on the left, and on the right what is chosen in it:
 * everything (screens/Home.tsx), the agents on no repository, or one repository (screens/Repository.tsx).
 * The repository chosen is in the address (`/repositories/<GitHub's id>`), so a reload, a link or the
 * back button lands on it.
 *
 * The rail groups the repositories by owner, each with its live state: a ring while something on it
 * runs, an amber count of what asks the user, otherwise how many agents and work items it has, or
 * "saved" for one that only has saved settings. "Everything" and "No repository" stand at its top, a
 * search at the very top (`/` reaches it from anywhere on the page), and the day's sandbox time, what
 * is at work and the sandboxes kept at its foot. The arrow keys move between its rows; Ctrl+B (⌘B on
 * a Mac) folds it away and back, which this browser remembers. On a phone the rail is a sheet, opened
 * from a switcher at the top of the page, with a strip of the repositories under it.
 *
 * The lists can be filtered (lib/workspace.ts): by status, agent, where it runs and kind. The filters
 * are the viewer's own, remembered in this browser, and narrow the rail and the lists alike.
 */
import { USAGE_LOW_SHARE, type GithubId, type MachineSummary, type UsageNumbers } from "@contract";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, RepoIcon, RingIcon, SearchIcon, SlidersIcon } from "../components/Icons";
import { FilterMenu } from "../components/WorkspaceFilters";
import { Sheet } from "../components/ui/Sheet";
import { PHONE_QUERY, useMediaQuery } from "../components/ui/useMediaQuery";
import { count, localTime, plural, sandboxTime } from "../lib/format";
import { workingCounts } from "../lib/repositories";
import { linkProps, navigate, type RepositoryPaneView, type Route } from "../lib/router";
import { filterCount, loadFilters, loadRailFolded, railBadge, railOf, saveFilters, saveRailFolded, searchRail, type Filters, type Rail, type RailRepository, type RailTotals } from "../lib/workspace";
import { useApp } from "../state/app";
import { allowanceState, useAllowance, useFactoryLimits, useSessions } from "../state/hooks";
import { Home, useSavedRepositories } from "./Home";
import type { ItemsState } from "./Items";
import { useMachines } from "./Machines";
import { RepositoryPane, useRepository } from "./Repository";

/** What the right side shows. */
export type Selection = { kind: "everything" } | { kind: "none" } | { kind: "repository"; id: GithubId; view?: RepositoryPaneView; launching?: boolean };

/** The filters, as this browser remembers them: read once, written on each change. */
export function useFilters(): [Filters, (next: Filters) => void] {
	const [filters, setFilters] = useState<Filters>(() => loadFilters());
	const change = useCallback((next: Filters) => {
		setFilters(next);
		saveFilters(next);
	}, []);
	return [filters, change];
}

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

export function Workspace({ selection, items }: { selection: Selection; items: ItemsState }) {
	const { platform } = useApp();
	const state = useSessions();
	const { sessions } = state;
	const [filters, setFilters] = useFilters();
	const [folded, setFolded] = useState(() => loadRailFolded());
	const phone = useMediaQuery(PHONE_QUERY);
	const search = useRef<HTMLInputElement>(null);
	const saved = useSavedRepositories(sessions);
	const machinesOffered = platform.info?.machines != null;
	const machines = useMachines(machinesOffered);
	const machineList = machinesOffered ? (machines.list ?? []) : [];
	const counts = workingCounts(sessions ?? []);
	// Asked again when a session starts or stops working, and when one is added or deleted.
	const usage = useAllowance(`${counts.ceilinged + counts.onMachines}:${sessions?.length ?? 0}`);
	const ceiling = useFactoryLimits().value?.hostedRunning ?? null;
	const chosen = selection.kind === "repository" ? selection.id : null;
	const rail = railOf({ sessions, items: items.list, feed: items.feed, saved, filters, keep: chosen });
	const [sheet, setSheet] = useState(false);

	const fold = useCallback((next: boolean) => {
		setFolded(next);
		saveRailFolded(next);
	}, []);

	// "/" finds a repository from anywhere but a field; Ctrl+B (⌘B) folds the rail.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target)) {
				event.preventDefault();
				if (phone) setSheet(true);
				else if (folded) {
					// Once the rail is drawn again.
					fold(false);
					requestAnimationFrame(() => search.current?.focus());
				} else search.current?.focus();
				return;
			}
			if ((event.key === "b" || event.key === "B") && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !phone) {
				event.preventDefault();
				fold(!folded);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [phone, folded, fold]);

	// The sheet closes once something in it was chosen.
	const selectionKey = selection.kind === "repository" ? `r:${selection.id}` : selection.kind;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a change of what is chosen is when it closes
	useEffect(() => setSheet(false), [selectionKey]);

	const meter = <RailFoot usage={usage} working={counts.ceilinged} ceiling={ceiling} onMachines={counts.onMachines} />;
	const body = (inSheet: boolean) => <RailBody rail={rail} selection={selection} filters={filters} onFilters={setFilters} machines={machineList} search={inSheet ? undefined : search} onFold={inSheet ? undefined : () => fold(true)} />;

	return (
		<div className={`ws${folded && !phone ? " ws-folded" : ""}`}>
			{phone ? null : (
				<nav className="ws-rail" aria-label="Repositories" hidden={folded}>
					{body(false)}
					{meter}
				</nav>
			)}
			<div className="ws-main">
				{phone ? <PhoneSwitcher rail={rail} selection={selection} onOpen={() => setSheet(true)} /> : null}
				{folded && !phone ? (
					<button type="button" className="ws-unfold" onClick={() => fold(false)} aria-label="Show the repositories" title="Show the repositories (Ctrl+B)">
						<ChevronRightIcon size={14} />
						<span>Repositories</span>
					</button>
				) : null}
				{selection.kind === "repository" ? (
					<RepositorySide key={selection.id} id={selection.id} view={selection.view} launching={selection.launching ?? false} items={items} filters={filters} onFilters={setFilters} machines={machineList} />
				) : (
					<Home state={state} items={platform.info?.items ? items.list : []} saved={saved} usage={usage} scope={selection.kind === "none" ? "none" : "all"} filters={filters} onFilters={setFilters} machines={machineList} />
				)}
			</div>
			{phone ? (
				<Sheet open={sheet} onClose={() => setSheet(false)} title="Repositories" footer={meter}>
					{body(true)}
				</Sheet>
			) : null}
		</div>
	);
}

function RepositorySide({ id, ...props }: { id: GithubId; view?: RepositoryPaneView; launching: boolean; items: ItemsState; filters: Filters; onFilters(filters: Filters): void; machines: readonly MachineSummary[] }) {
	const page = useRepository(id);
	return <RepositoryPane page={page} {...props} />;
}

// ---- the rail --------------------------------------------------------------------------------------

/** Three dots in a row: everything at once. */
function EverythingIcon() {
	return (
		<svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
			<circle cx="3" cy="8" r="1.4" />
			<circle cx="8" cy="8" r="1.4" />
			<circle cx="13" cy="8" r="1.4" />
		</svg>
	);
}

/** The rows a key moves between: the rail's links, in the order they stand. */
function moveFocus(event: ReactKeyboardEvent<HTMLElement>, list: HTMLElement | null) {
	if (!list) return;
	const rows = [...list.querySelectorAll<HTMLElement>("[data-rail-row]")];
	if (rows.length === 0) return;
	const at = rows.indexOf(document.activeElement as HTMLElement);
	const to = event.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : event.key === "ArrowUp" ? (at <= 0 ? -1 : at - 1) : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : null;
	if (to === null) return;
	event.preventDefault();
	if (to === -1) {
		list.closest(".ws-rail-body")?.querySelector<HTMLInputElement>(".ws-search input")?.focus();
		return;
	}
	rows[to]?.focus();
	rows[to]?.scrollIntoView?.({ block: "nearest" });
}

function RailBody({ rail, selection, filters, onFilters, machines, search, onFold }: { rail: Rail; selection: Selection; filters: Filters; onFilters(filters: Filters): void; machines: readonly MachineSummary[]; search?: RefObject<HTMLInputElement | null>; onFold?: () => void }) {
	const [query, setQuery] = useState("");
	const list = useRef<HTMLDivElement>(null);
	const groups = searchRail(rail.groups, query);
	const chosen = selection.kind === "repository" ? String(selection.id) : null;
	const first = groups[0]?.repositories[0] ?? null;
	const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			if (query !== "") setQuery("");
			else event.currentTarget.blur();
		} else if (event.key === "Enter" && first && query.trim() !== "") {
			event.preventDefault();
			navigate({ name: "repository", id: first.id });
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			list.current?.querySelector<HTMLElement>("[data-rail-row]")?.focus();
		}
	};
	return (
		<div className="ws-rail-body">
			<div className="ws-rail-top">
				<label className="ws-search">
					<SearchIcon size={13} />
					<span className="visually-hidden">Find a repository</span>
					<input ref={search} type="search" placeholder="Find a repository" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKey} autoComplete="off" spellCheck={false} />
					{query === "" ? (
						<kbd className="ws-kbd" aria-hidden="true">
							/
						</kbd>
					) : null}
				</label>
				<FilterMenu compact filters={filters} onChange={onFilters} machines={machines} />
				{onFold ? (
					<button type="button" className="ws-fold" onClick={onFold} aria-label="Hide the repositories" title="Hide the repositories (Ctrl+B)">
						<ChevronLeftIcon size={14} />
					</button>
				) : null}
			</div>
			<div className="ws-rail-list" ref={list} onKeyDown={(event) => moveFocus(event, list.current)}>
				{query.trim() === "" ? (
					<ul className="ws-rail-rows">
						<ScopeRow route={{ name: "home" }} current={selection.kind === "everything"} label="Everything" icon={<EverythingIcon />} totals={rail.everything} />
						<ScopeRow route={{ name: "home", scope: "none" }} current={selection.kind === "none"} label="No repository" icon={<PlusIcon size={13} />} totals={rail.none} />
					</ul>
				) : null}
				{groups.map((group) => (
					<section key={group.owner} className="ws-rail-group" aria-label={group.owner || "Repositories"}>
						{group.owner ? <h3 className="ws-rail-owner">{group.owner}</h3> : null}
						<ul className="ws-rail-rows">
							{group.repositories.map((repository) => (
								<RepoRow key={String(repository.id)} repository={repository} current={chosen === String(repository.id)} />
							))}
						</ul>
					</section>
				))}
				{groups.length === 0 && query.trim() !== "" ? <p className="ws-rail-empty">No repository matches “{query.trim()}”.</p> : null}
				{groups.length === 0 && query.trim() === "" && filterCount(filters) > 0 ? <p className="ws-rail-empty">No repository has anything the filters leave.</p> : null}
			</div>
		</div>
	);
}

/** A ring while something runs, the amber count of what asks, otherwise how many. */
function Badges({ running, needs, count: total, saved = false, label }: { running: boolean | number; needs: number; count: number | null; saved?: boolean; label: string }) {
	const words = [running ? (typeof running === "number" ? `${running} running` : "something running") : null, needs > 0 ? `${needs} ${needs === 1 ? "needs" : "need"} you` : null, total !== null ? plural(total, "thing") : null, saved ? "saved settings only" : null].filter((part) => part !== null);
	return (
		<span className="ws-rail-badges">
			{running ? (
				<span className="ws-badge-running">
					<RingIcon size={12} className="ws-ring" />
					{typeof running === "number" ? <span className="ws-badge-number">{running}</span> : null}
				</span>
			) : null}
			{needs > 0 ? <span className="ws-badge-needs">{needs}</span> : null}
			{total !== null ? <span className="ws-badge-count">{total}</span> : null}
			{saved ? <span className="ws-badge-saved">saved</span> : null}
			<span className="visually-hidden">{words.length > 0 ? `, ${words.join(", ")}` : `, ${label} has nothing yet`}</span>
		</span>
	);
}

function ScopeRow({ route, current, label, icon, totals }: { route: Route; current: boolean; label: string; icon: ReactNode; totals: RailTotals }) {
	return (
		<li className="ws-rail-item">
			<a className="ws-rail-row" data-rail-row="" aria-current={current ? "page" : undefined} {...linkProps(route)}>
				<span className="ws-rail-icon">{icon}</span>
				<span className="ws-rail-name">{label}</span>
				<Badges running={totals.running > 0 ? totals.running : false} needs={totals.needs} count={totals.running === 0 && totals.needs === 0 ? totals.count : null} label={label} />
			</a>
		</li>
	);
}

function RepoRow({ repository, current }: { repository: RailRepository; current: boolean }) {
	const badge = railBadge(repository);
	const name = `${repository.owner ? `${repository.owner}/` : ""}${repository.name}`;
	return (
		<li className="ws-rail-item ws-rail-item-repo">
			<a className="ws-rail-row" data-rail-row="" aria-current={current ? "page" : undefined} title={name} {...linkProps({ name: "repository", id: repository.id })}>
				<span className="ws-rail-icon">
					<RepoIcon size={13} />
				</span>
				<span className="ws-rail-name">{repository.name}</span>
				<Badges running={badge.running} needs={badge.needs} count={badge.count} saved={badge.saved} label={name} />
			</a>
			<span className="ws-rail-actions">
				<a className="ws-rail-action" {...linkProps({ name: "new", repository: repository.id })} aria-label={`New agent on ${name}`} title="New agent here">
					<PlusIcon size={13} />
				</a>
				<a className="ws-rail-action" {...linkProps({ name: "repository", id: repository.id, view: "settings" })} aria-label={`Saved settings of ${name}`} title="Saved settings">
					<SlidersIcon size={13} />
				</a>
			</span>
		</li>
	);
}

/** The rail's foot: the day's sandbox time as a meter, what is at work and the sandboxes kept, leading to the usage page. */
function RailFoot({ usage, working, ceiling, onMachines }: { usage: UsageNumbers | null; working: number; ceiling: number | null; onMachines: number }) {
	const state = usage === null ? "plenty" : allowanceState(usage, USAGE_LOW_SHARE);
	const spent = usage === null ? 0 : usage.usedSeconds + usage.heldSeconds;
	const allowance = usage?.allowanceSeconds ?? null;
	const share = allowance === null || allowance === 0 ? null : Math.min(1, spent / allowance);
	const sandboxes = usage?.sandboxes ?? null;
	const full = sandboxes !== null && sandboxes.limit !== null && sandboxes.kept >= sandboxes.limit;
	return (
		<a className={`ws-rail-foot${state !== "plenty" ? " ws-rail-foot-warn" : ""}`} {...linkProps({ name: "usage" })} title="Usage: sandbox time and sandboxes">
			<span className="ws-foot-time">
				Sandbox today <strong>{usage === null ? "–" : sandboxTime(spent)}</strong>
				{allowance === null ? null : ` of ${sandboxTime(allowance)}`}
				{usage !== null && state !== "plenty" && usage.leftSeconds !== null ? <span className="ws-foot-left">{state === "used" ? `, used up until ${localTime(usage.resetsAt)}` : `, ${sandboxTime(usage.leftSeconds)} left`}</span> : null}
			</span>
			{share === null ? null : (
				<span className="home-meter ws-foot-meter" role="meter" aria-label="Sandbox time used today" aria-valuemin={0} aria-valuemax={allowance ?? 0} aria-valuenow={Math.min(spent, allowance ?? spent)} aria-valuetext={`${sandboxTime(spent)} of ${sandboxTime(allowance ?? 0)}`}>
					<span className="home-meter-fill" style={{ width: `${Math.max(share, spent > 0 ? 0.04 : 0) * 100}%` }} />
				</span>
			)}
			<span className="ws-foot-facts">
				<span>
					<strong>{working}</strong>
					{ceiling === null ? "" : ` of ${ceiling}`} working{onMachines > 0 ? `, ${onMachines} on your machines` : ""}
				</span>
				{sandboxes === null ? null : (
					<span className={full ? "ws-foot-full" : undefined}>
						<strong>{count(sandboxes.kept)}</strong>
						{sandboxes.limit === null ? (sandboxes.kept === 1 ? " sandbox kept" : " sandboxes kept") : ` of ${count(sandboxes.limit)} kept`}
						{full ? <span className="visually-hidden"> (the most an account may keep)</span> : null}
					</span>
				)}
			</span>
		</a>
	);
}

// ---- a phone's switcher ----------------------------------------------------------------------------

function PhoneSwitcher({ rail, selection, onOpen }: { rail: Rail; selection: Selection; onOpen(): void }) {
	const all = rail.groups.flatMap((group) => group.repositories);
	const chosen = selection.kind === "repository" ? (all.find((repository) => String(repository.id) === String(selection.id)) ?? null) : null;
	const needs = chosen ? chosen.needs : selection.kind === "none" ? rail.none.needs : rail.everything.needs;
	return (
		<div className="ws-switch">
			<button type="button" className="ws-switch-button" onClick={onOpen} aria-haspopup="dialog">
				<RepoIcon size={14} />
				<span className="ws-switch-name">
					{chosen ? (
						<>
							{chosen.owner ? <span className="ws-switch-owner">{chosen.owner}/</span> : null}
							<strong>{chosen.name}</strong>
						</>
					) : (
						<strong>{selection.kind === "none" ? "No repository" : "Everything"}</strong>
					)}
				</span>
				{needs > 0 ? (
					<span className="ws-badge-needs" aria-label={`${needs} ${needs === 1 ? "needs" : "need"} you`}>
						{needs}
					</span>
				) : null}
				<span className="ws-switch-count">{plural(rail.repositories, "repo")}</span>
				<ChevronDownIcon size={12} />
			</button>
			<ul className="ws-strip" aria-label="Repositories">
				<li>
					<a className="ws-strip-chip" aria-current={selection.kind === "everything" ? "page" : undefined} {...linkProps({ name: "home" })}>
						Everything
					</a>
				</li>
				{all.map((repository) => (
					<li key={String(repository.id)}>
						<a className="ws-strip-chip" aria-current={chosen?.id === repository.id ? "page" : undefined} {...linkProps({ name: "repository", id: repository.id })}>
							{repository.needs > 0 ? <span className="ws-lamp" aria-label="needs you" /> : repository.running > 0 ? <RingIcon size={11} className="ws-ring" /> : null}
							{repository.name}
						</a>
					</li>
				))}
			</ul>
		</div>
	);
}
