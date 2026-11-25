/**
 * The Agents home: a rail of the user's repositories on the left, and on the right what is chosen in it:
 * everything (screens/Home.tsx), the agents on no repository, or one repository (screens/Repository.tsx).
 * The repository chosen is in the address (`/repositories/<GitHub's id>`), so a reload, a link or the
 * back button lands on it.
 *
 * The rail groups the repositories by owner, each owner row with their GitHub picture, folding away
 * (this browser remembers which), and each repository with its tile and its live state: a lime ring
 * while something on it runs, an amber count of what asks the user; one with neither is quiet, its
 * name dimmer and no count ("saved" for one that only has saved settings). Above the owners, "Active
 * now" repeats the repositories with something running or asking. "Everything" and "No repository"
 * stand at its top, a search at the very top (`/` reaches it from anywhere on the page), and the day's
 * sandbox time, what is at work and the sandboxes kept at its foot. Hovering a repository shows a new
 * agent there and its saved settings. The arrow keys move between its rows; Ctrl+B (⌘B on a Mac)
 * folds it away and back, which this browser remembers. On a phone the rail is a sheet, opened from a
 * switcher at the top of the page, with a strip of the repositories under it.
 *
 * The lists can be filtered (lib/workspace.ts): by status, agent, where it runs and kind. The filters
 * are the viewer's own, remembered in this browser, and narrow the rail and the lists alike.
 */
import { minutes, monthReset } from "../lib/hosted";
import { USAGE_LOW_SHARE, type GithubId, type MachineSummary, type UsageNumbers } from "@contract";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Badges, EverythingIcon, moveFocus, RailFoldButton, RailFrame, RailLink, useRailFold } from "../components/Rail";
import { ChevronDownIcon, PlusIcon, RepoIcon, RingIcon, SearchIcon, SlidersIcon } from "../components/Icons";
import { OwnerAvatar, RepoTile } from "../components/RepoTile";
import { FilterMenu } from "../components/WorkspaceFilters";
import { Sheet } from "../components/ui/Sheet";
import { PHONE_QUERY, useMediaQuery } from "../components/ui/useMediaQuery";
import { count, localTime, plural, sandboxTime } from "../lib/format";
import { workingCounts } from "../lib/repositories";
import { repositoryLabel } from "../lib/nav";
import { linkProps, navigate, usePageLabel, type RepositoryPaneView } from "../lib/router";
import { activeRepositories, filterCount, loadFilters, loadFoldedOwners, railBadge, railOf, saveFilters, saveFoldedOwners, searchRail, type Filters, type Rail, type RailRepository } from "../lib/workspace";
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
	const phone = useMediaQuery(PHONE_QUERY);
	const [folded, fold] = useRailFold(phone);
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
	// What the back control of a page opened from here calls it: "tide-tables · Work items".
	const chosenName = chosen === null ? null : (rail.groups.flatMap((group) => group.repositories).find((repository) => String(repository.id) === String(chosen))?.name ?? null);
	usePageLabel(selection.kind === "repository" ? (chosenName ? repositoryLabel(chosenName, selection.view) : null) : selection.kind === "none" ? "No repository" : "Agents");
	const [sheet, setSheet] = useState(false);

	// "/" finds a repository from anywhere but a field.
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
		<>
			<RailFrame
				label="Repositories"
				folded={folded}
				phone={phone}
				onUnfold={() => fold(false)}
				rail={
					<>
						{body(false)}
						{meter}
					</>
				}
			>
				{phone ? <PhoneSwitcher rail={rail} selection={selection} onOpen={() => setSheet(true)} /> : null}
				{selection.kind === "repository" ? (
					<RepositorySide key={selection.id} id={selection.id} view={selection.view} launching={selection.launching ?? false} items={items} filters={filters} onFilters={setFilters} machines={machineList} />
				) : (
					<Home state={state} items={platform.info?.items ? items.list : []} usage={usage} scope={selection.kind === "none" ? "none" : "all"} filters={filters} onFilters={setFilters} machines={machineList} />
				)}
			</RailFrame>
			{phone ? (
				<Sheet open={sheet} onClose={() => setSheet(false)} title="Repositories" footer={meter}>
					{body(true)}
				</Sheet>
			) : null}
		</>
	);
}

function RepositorySide({ id, ...props }: { id: GithubId; view?: RepositoryPaneView; launching: boolean; items: ItemsState; filters: Filters; onFilters(filters: Filters): void; machines: readonly MachineSummary[] }) {
	const page = useRepository(id);
	return <RepositoryPane page={page} {...props} />;
}

// ---- the rail --------------------------------------------------------------------------------------

function RailBody({ rail, selection, filters, onFilters, machines, search, onFold }: { rail: Rail; selection: Selection; filters: Filters; onFilters(filters: Filters): void; machines: readonly MachineSummary[]; search?: RefObject<HTMLInputElement | null>; onFold?: () => void }) {
	const [query, setQuery] = useState("");
	const [foldedOwners, setFoldedOwners] = useState<ReadonlySet<string>>(() => loadFoldedOwners());
	const list = useRef<HTMLDivElement>(null);
	const groups = searchRail(rail.groups, query);
	const searching = query.trim() !== "";
	const active = searching ? [] : activeRepositories(rail.groups);
	const toggleOwner = (owner: string) => {
		const next = new Set(foldedOwners);
		if (next.has(owner)) next.delete(owner);
		else next.add(owner);
		setFoldedOwners(next);
		saveFoldedOwners(next);
	};
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
				{onFold ? <RailFoldButton label="Repositories" onFold={onFold} /> : null}
			</div>
			<div className="ws-rail-list" ref={list} onKeyDown={(event) => moveFocus(event, list.current)}>
				{query.trim() === "" ? (
					<ul className="ws-rail-rows">
						<RailLink route={{ name: "home" }} current={selection.kind === "everything"} label="Everything" icon={<EverythingIcon />} badges={<Badges running={rail.everything.running > 0 ? rail.everything.running : false} needs={rail.everything.needs} count={null} label="Everything" />} />
						<RailLink route={{ name: "home", scope: "none" }} current={selection.kind === "none"} label="No repository" icon={<PlusIcon size={13} />} badges={<Badges running={rail.none.running > 0 ? rail.none.running : false} needs={rail.none.needs} count={null} label="No repository" />} />
					</ul>
				) : null}
				{active.length > 0 ? (
					<section className="ws-rail-active" aria-label="Active now">
						<h3 className="ws-rail-label">
							<RingIcon size={11} className="ws-ring" />
							Active now
						</h3>
						<ul className="ws-rail-rows">
							{active.map((repository) => (
								<RepoRow key={String(repository.id)} repository={repository} current={chosen === String(repository.id)} owned />
							))}
						</ul>
					</section>
				) : null}
				{groups.map((group) => {
					// A search shows every match, folded owner or not; the chosen repository keeps its owner open.
					const shut = !searching && group.owner !== "" && foldedOwners.has(group.owner) && !group.repositories.some((repository) => chosen === String(repository.id));
					return (
						<section key={group.owner} className={`ws-rail-group${shut ? " ws-rail-group-shut" : ""}`} aria-label={group.owner || "Repositories"}>
							{group.owner ? (
								<h3 className="ws-rail-owner">
									<button type="button" className="ws-rail-owner-row" data-rail-row="" aria-expanded={!shut} onClick={() => toggleOwner(group.owner)} title={shut ? `Show ${group.owner}'s repositories` : `Fold ${group.owner}'s repositories`}>
										<ChevronDownIcon size={12} className="ws-rail-chevron" />
										<OwnerAvatar owner={group.owner} />
										<span className="ws-rail-owner-name">{group.owner}</span>
										<span className="ws-rail-owner-count">{group.repositories.length}</span>
									</button>
								</h3>
							) : null}
							{shut ? null : (
								<ul className="ws-rail-rows">
									{group.repositories.map((repository) => (
										<RepoRow key={String(repository.id)} repository={repository} current={chosen === String(repository.id)} />
									))}
								</ul>
							)}
						</section>
					);
				})}
				{groups.length === 0 && query.trim() !== "" ? <p className="ws-rail-empty">No repository matches “{query.trim()}”.</p> : null}
				{groups.length === 0 && query.trim() === "" && filterCount(filters) > 0 ? <p className="ws-rail-empty">No repository has anything the filters leave.</p> : null}
			</div>
		</div>
	);
}

/** A repository's row: its tile, its name and its state; `owned` (in "Active now") says its owner too, quietly. */
function RepoRow({ repository, current, owned = false }: { repository: RailRepository; current: boolean; owned?: boolean }) {
	const badge = railBadge(repository);
	const name = `${repository.owner ? `${repository.owner}/` : ""}${repository.name}`;
	return (
		<RailLink
			route={{ name: "repository", id: repository.id }}
			current={current}
			label={repository.name}
			title={name}
			quiet={!badge.running && badge.needs === 0}
			icon={<RepoTile name={repository.name} />}
			before={owned && repository.owner ? <span className="visually-hidden">{repository.owner}/</span> : null}
			badges={<Badges running={badge.running} needs={badge.needs} count={badge.count} saved={badge.saved} label={name} />}
		>
			<span className="ws-rail-actions">
				<a className="ws-rail-action" {...linkProps({ name: "new", repository: repository.id })} aria-label={`New agent on ${name}`} title="New agent here">
					<PlusIcon size={13} />
				</a>
				<a className="ws-rail-action" {...linkProps({ name: "repository", id: repository.id, view: "settings" })} aria-label={`Saved settings of ${name}`} title="Saved settings">
					<SlidersIcon size={13} />
				</a>
			</span>
		</RailLink>
	);
}

/** The rail's foot: the day's sandbox time as a meter, what is at work and the sandboxes kept, leading to the usage page. */
function RailFoot({ usage, working, ceiling, onMachines }: { usage: UsageNumbers | null; working: number; ceiling: number | null; onMachines: number }) {
	const state = usage === null ? "plenty" : allowanceState(usage, USAGE_LOW_SHARE);
	// With a plan, the month's hosted minutes, in weighted seconds (lib/hosted.ts).
	const month = usage?.hosted ?? null;
	const spent = month ? month.usedSeconds + month.heldSeconds : usage === null ? 0 : usage.usedSeconds + usage.heldSeconds;
	const allowance = month ? month.limitSeconds : (usage?.allowanceSeconds ?? null);
	const share = allowance === null || allowance === 0 ? null : Math.min(1, spent / allowance);
	const sandboxes = usage?.sandboxes ?? null;
	const full = sandboxes !== null && sandboxes.limit !== null && sandboxes.kept >= sandboxes.limit;
	return (
		<a className={`ws-rail-foot${state !== "plenty" ? " ws-rail-foot-warn" : ""}`} {...linkProps({ name: "usage" })} title="Usage: sandbox time and sandboxes">
			<span className="ws-foot-time">
				<span>{month ? (month.plan === "pro" ? `Hosted · resets ${monthReset(month)}` : "Hosted this month") : "Hosted time today"}</span>
				<span>
					<strong>{usage === null ? "–" : month ? minutes(spent) : sandboxTime(spent)}</strong>
					{allowance === null ? null : month ? ` of ${minutes(allowance)} min` : ` of ${sandboxTime(allowance)}`}
				</span>
				{month && state !== "plenty" ? <span className="ws-foot-left">{state === "used" ? `Used up until ${monthReset(month)}` : `${minutes(month.leftSeconds)} min left`}</span> : null}
				{!month && usage !== null && state !== "plenty" && usage.leftSeconds !== null ? <span className="ws-foot-left">{state === "used" ? `Used up until ${localTime(usage.resetsAt)}` : `${sandboxTime(usage.leftSeconds)} left`}</span> : null}
			</span>
			{share === null ? null : (
				<span className="ws-foot-bar" role="meter" aria-label="Hosted time used today" aria-valuemin={0} aria-valuemax={allowance ?? 0} aria-valuenow={Math.min(spent, allowance ?? spent)} aria-valuetext={`${sandboxTime(spent)} of ${sandboxTime(allowance ?? 0)}`}>
					<span className="ws-foot-bar-fill" style={{ width: `${Math.max(share, spent > 0 ? 0.04 : 0) * 100}%` }} />
				</span>
			)}
			<span className="ws-foot-facts">
				<span>
					{working > 0 ? <RingIcon size={11} className="ws-ring" /> : null}
					<span>
						<strong>{working}</strong>
						{ceiling === null ? "" : ` of ${ceiling}`} working{onMachines > 0 ? `, ${onMachines} on your machines` : ""}
					</span>
				</span>
				{sandboxes === null ? null : (
					<span className={full ? "ws-foot-full" : undefined}>
						<span>
							<strong>{count(sandboxes.kept)}</strong>
							{sandboxes.limit === null ? (sandboxes.kept === 1 ? " sandbox kept" : " sandboxes kept") : ` of ${count(sandboxes.limit)} kept sandboxes`}
						</span>
						{sandboxes.limit !== null && sandboxes.limit <= 10 ? (
							<span className="ws-foot-slots" aria-hidden="true">
								{Array.from({ length: sandboxes.limit }, (_, index) => (
									<i key={index} className={index < sandboxes.kept ? "ws-foot-slot-on" : undefined} />
								))}
							</span>
						) : null}
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
