/**
 * The Factory page, at `/factory`: every work item of the user across repositories, grouped by what
 * its person must do, with the start composer on "Work item" at the top. Filing from it stays on the
 * page; the new item comes into its group through the live list.
 *
 * The groups: "Needs you" (an item that asks something, the longest waiting first), "Ready for you"
 * (handed over: its verdict, CI, the second review's word, its pull request), "In progress" (working,
 * queued, or waiting for something that ends by itself, with the server's sentence), "Drafts", and the
 * ended ones (done, failed, cancelled), folded. Two chips filter it by repository and by how an item
 * was filed; both are kept in the address (`?repository=`, `?from=`), so a link can open it filtered.
 *
 * Where the deployment runs no second review (`PlatformInfo.items.reviewer`), one line under the
 * heading says so and no row says a word of it.
 */
import type { GithubId, ItemState, ItemSummary } from "@contract";
import { useId, useState, type ReactNode } from "react";
import { StartComposer } from "../components/StartComposer";
import { ChevronIcon, FileIcon, Mark, RepoIcon, WarnIcon } from "../components/Icons";
import { Menu, Pill, type MenuSpec } from "../components/ui";
import { plural } from "../lib/format";
import { repositoryName, workingCounts } from "../lib/repositories";
import { ITEM_SOURCES, linkProps, navigate, type ItemSource } from "../lib/router";
import { useApp } from "../state/app";
import { useFactoryLimits, useNow, useSessions } from "../state/hooks";
import { asking, ItemRow, type ItemsState } from "./Items";

/** How an item was filed, in the filter's words. */
export const SOURCE_WORD: Record<ItemSource, string> = { web: "web", api: "API", github: "GitHub issue" };

const IN_PROGRESS: ItemState[] = ["working", "queued", "waiting"];
const ENDED: ItemState[] = ["done", "failed", "cancelled"];

/** The page's groups of what is shown, each newest first but "Needs you", which is the longest waiting first. */
export function factoryGroups(list: readonly ItemSummary[]): { needs: ItemSummary[]; ready: ItemSummary[]; progress: ItemSummary[]; drafts: ItemSummary[]; ended: ItemSummary[] } {
	const newest = (items: ItemSummary[]) => items.sort((a, b) => b.updatedAt - a.updatedAt);
	const rest = list.filter((item) => item.question === null);
	return {
		needs: asking(list),
		ready: newest(rest.filter((item) => item.state === "review")),
		progress: newest(rest.filter((item) => IN_PROGRESS.includes(item.state))),
		drafts: newest(rest.filter((item) => item.state === "draft")),
		ended: newest(rest.filter((item) => ENDED.includes(item.state))),
	};
}

/** The items the filters leave: on one repository, filed one way. */
export function filterItems(list: readonly ItemSummary[], filters: { repository?: GithubId; from?: ItemSource }): ItemSummary[] {
	return list.filter((item) => (filters.repository === undefined || String(item.repository.id) === String(filters.repository)) && (filters.from === undefined || item.source === filters.from));
}

/** The repositories that have items, by name. */
function repositoriesOf(list: readonly ItemSummary[]): Array<{ id: GithubId; name: string }> {
	const found = new Map<string, { id: GithubId; name: string }>();
	for (const item of list) found.set(String(item.repository.id), { id: item.repository.id, name: repositoryName(item.repository) });
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function Group({ id, name, items, now, reviewer, tone }: { id: string; name: string; items: ItemSummary[]; now: number; reviewer: boolean; tone?: "needs" }) {
	if (items.length === 0) return null;
	return (
		<section className={`agent-group factory-group${tone === "needs" ? " needs-you factory-lane-needs" : ""}`} aria-labelledby={id}>
			<h2 className="agent-group-head factory-lane-head" id={id}>
				<span className="agent-group-name">{name}</span>
				<span className="agent-group-count">{plural(items.length, "work item")}</span>
			</h2>
			<ul className="agents factory-lane">
				{items.map((item) => (
					<ItemRow key={item.id} item={item} now={now} repository ci reviewer={reviewer} why={tone === "needs" ? item.question?.text : undefined} />
				))}
			</ul>
		</section>
	);
}

/**
 * A filter: a pill that says what it keeps, and its choices in a menu anchored to it ("all" first), a
 * sheet on a phone. A long list of repositories gets a filter field. Choosing one changes the address.
 */
function FilterMenu({ name, label, icon, value, choices, chosen, onChoose }: { name: string; label: string; icon: ReactNode; value: string; choices: Array<{ key: string; name: string; note?: string }>; chosen: string | null; onChoose(key: string | null): void }) {
	const spec: MenuSpec = {
		label,
		width: 264,
		hints: false,
		...(choices.length > 7 ? { filter: { placeholder: "Filter repositories…" } } : {}),
		groups: [
			{ id: "all", items: [{ id: "all", value: "", label: "all", textValue: "all", checked: chosen === null, onSelect: () => onChoose(null) }] },
			{ id: "choices", items: choices.map((choice) => ({ id: choice.key, value: choice.key, label: choice.name, description: choice.note, checked: chosen === choice.key, onSelect: () => onChoose(choice.key) })) },
		],
	};
	return (
		<Menu
			spec={spec}
			trigger={(props) => (
				<Pill {...props} icon={icon} data-picker={name} data-value={chosen ?? ""} dot={chosen === null ? null : "changed"} dotLabel={chosen === null ? undefined : "Filtered"} className="factory-filter" aria-label={`${label}: ${value}`}>
					<span className="factory-filter-name">{name === "repository" ? "repo" : "from"}</span>
					{value}
				</Pill>
			)}
		/>
	);
}

/** No work item yet: what the factory does, in three sentences, under the composer that files the first. */
function FactoryEmpty({ github }: { github: boolean }) {
	return (
		<div className="state state-empty factory-empty">
			<Mark size={56} />
			<h2>No work items yet</h2>
			<p>
				Write what you want done on one of your repositories, and an agent works on it by itself in a sandbox, runs your checks and hands it to you as a pull request. When it needs a decision from you, it waits here under Needs you, and merging always stays yours.{" "}
				{github ? (
					<>
						You can also file one by labelling a GitHub issue <code>windlass</code>, or from the API with a{" "}
						<a className="link" {...linkProps({ name: "settings" })}>
							token
						</a>
						.
					</>
				) : (
					<>
						You can also file one from the API with a{" "}
						<a className="link" {...linkProps({ name: "settings" })}>
							token
						</a>
						.
					</>
				)}
			</p>
		</div>
	);
}

export function Factory({ filters, items }: { filters: { repository?: GithubId; from?: ItemSource }; items: ItemsState }) {
	const { platform } = useApp();
	const { sessions } = useSessions();
	const now = useNow(15_000);
	const limits = useFactoryLimits().value;
	const reviewer = platform.info?.items?.reviewer !== false;
	const [showEnded, setShowEnded] = useState(false);
	const ended = useId();
	const ids = { needs: useId(), ready: useId(), progress: useId(), drafts: useId(), ended: useId() };

	const list = items.list;
	const shown = list === null ? null : filterItems(list, filters);
	const groups = factoryGroups(shown ?? []);
	const repositories = repositoriesOf(list ?? []);
	const filtered = filters.repository !== undefined || filters.from !== undefined;
	const running = workingCounts(sessions ?? []).items;
	const choose = (next: { repository?: GithubId; from?: ItemSource }) => {
		navigate({ name: "factory", ...next }, { replace: true });
	};
	const chosenRepository = filters.repository === undefined ? null : (repositories.find((repository) => String(repository.id) === String(filters.repository)) ?? null);

	// What the page holds, as Helm's facts: the count in ink, each group with its dot; "Needs you" last, in its hue.
	type Fact = { n: number; word: string; tone: "work" | "ready" | "draft" | "needs" };
	const facts = ([
		{ n: groups.progress.length, word: "in progress", tone: "work" },
		{ n: groups.ready.length, word: "ready for you", tone: "ready" },
		{ n: groups.drafts.length, word: groups.drafts.length === 1 ? "draft" : "drafts", tone: "draft" },
		{ n: groups.needs.length, word: groups.needs.length === 1 ? "needs you" : "need you", tone: "needs" },
	] satisfies Fact[]).filter((fact) => fact.n > 0);
	const turnsUsed = limits && sessions !== null ? Math.min(running, limits.factoryTurns) : null;

	return (
		<main className="home factory">
			<header className="home-head factory-head">
				<div>
					<h1 className="display">Factory</h1>
					<p className="eyebrow factory-facts">
						{shown === null ? (
							"work items"
						) : (
							<>
								<span className="factory-fact">
									<strong>{shown.length}</strong> {shown.length === 1 ? "work item" : "work items"}
								</span>
								{facts.map((fact) => (
									<span key={fact.tone} className={`factory-fact factory-fact-${fact.tone}${fact.tone === "needs" ? " eyebrow-waiting" : ""}`}>
										<span className="factory-fact-dot" aria-hidden="true" />
										{fact.n} {fact.word}
									</span>
								))}
							</>
						)}
					</p>
					{reviewer ? null : <p className="home-account factory-reviewer-off">No second review on this deployment: the verdict rests on CI and your checks.</p>}
				</div>
				<div className="home-account factory-turns">
					{limits ? (
						<>
							<span className="factory-turns-line">
								{turnsUsed !== null ? (
									<span className="factory-meter" role="img" aria-label={`${turnsUsed} of ${limits.factoryTurns} factory turns in use`}>
										{Array.from({ length: limits.factoryTurns }, (_, index) => (
											<i key={index} className={index < turnsUsed ? "on" : undefined} />
										))}
									</span>
								) : null}
								{sessions === null ? (
									<span>Up to {plural(limits.factoryTurns, "factory turn")} at once</span>
								) : (
									<span>
										<span className="factory-turns-n">{running}</span> of {plural(limits.factoryTurns, "factory turn")} running
									</span>
								)}
							</span>
							<span className="factory-turns-line">
								New items wait while {limits.reviewCap} are in review
								<span className="home-account-sep" aria-hidden="true">
									·
								</span>
								<a className="link factory-usage-link" {...linkProps({ name: "usage" })}>
									Usage
								</a>
							</span>
						</>
					) : (
						<a className="link factory-usage-link" {...linkProps({ name: "usage" })}>
							Usage
						</a>
					)}
				</div>
			</header>

			<section className="home-start" aria-label="File a work item">
				<StartComposer sessions={sessions} items={list} kind="item" switchable repositoryId={filters.repository} />
			</section>

			{list === null ? (
				items.error ? (
					<div className="state state-error" role="alert">
						<WarnIcon size={22} />
						<h2>The work items could not be loaded</h2>
						<p>{items.error}</p>
						<button type="button" className="button button-outline" onClick={items.reload}>
							Try again
						</button>
					</div>
				) : (
					<ul className="agents agents-loading" aria-busy="true" aria-label="Loading the work items">
						{[0, 1, 2].map((row) => (
							<li key={row} className="agent-row agent-row-skeleton">
								<span className="skeleton skeleton-dot" />
								<div className="agent-main">
									<span className="skeleton skeleton-title" style={{ width: `${46 - row * 7}%` }} />
									<span className="skeleton skeleton-meta" style={{ width: `${62 - row * 5}%` }} />
								</div>
							</li>
						))}
					</ul>
				)
			) : list.length === 0 ? (
				<FactoryEmpty github={Boolean(platform.info?.github)} />
			) : (
				<>
					{items.error ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{items.error} What is shown may be behind.</span>
						</p>
					) : null}
					<div className="factory-filters" role="group" aria-label="Filters">
						<FilterMenu
							name="repository"
							label="Repository"
							icon={<RepoIcon size={14} />}
							value={chosenRepository?.name ?? (filters.repository === undefined ? "all" : "none of yours")}
							choices={repositories.map((repository) => ({ key: String(repository.id), name: repository.name, note: plural((list ?? []).filter((item) => String(item.repository.id) === String(repository.id)).length, "work item") }))}
							chosen={filters.repository === undefined ? null : String(filters.repository)}
							onChoose={(key) => choose({ repository: key === null ? undefined : (repositories.find((repository) => String(repository.id) === key)?.id ?? undefined), from: filters.from })}
						/>
						<FilterMenu
							name="from"
							label="Filed from"
							icon={<FileIcon size={14} />}
							value={filters.from ? SOURCE_WORD[filters.from] : "all"}
							choices={ITEM_SOURCES.map((source) => ({ key: source, name: SOURCE_WORD[source] }))}
							chosen={filters.from ?? null}
							onChoose={(key) => choose({ repository: filters.repository, from: ITEM_SOURCES.find((source) => source === key) })}
						/>
						{filtered ? (
							<button type="button" className="link factory-clear" onClick={() => choose({})}>
								Clear
							</button>
						) : null}
					</div>
					{shown && shown.length === 0 && filtered ? (
						<p className="usage-empty factory-none">
							No work item matches.{" "}
							<button type="button" className="link" onClick={() => choose({})}>
								Show them all
							</button>
						</p>
					) : null}
					<Group id={ids.needs} name="Needs you" items={groups.needs} now={now} reviewer={reviewer} tone="needs" />
					<Group id={ids.ready} name="Ready for you" items={groups.ready} now={now} reviewer={reviewer} />
					<Group id={ids.progress} name="In progress" items={groups.progress} now={now} reviewer={reviewer} />
					<Group id={ids.drafts} name="Drafts" items={groups.drafts} now={now} reviewer={reviewer} />
					{groups.ended.length > 0 ? (
						<>
							<p className="agents-fold items-fold factory-fold">
								<button type="button" className="link machine-toggle" aria-expanded={showEnded} aria-controls={ended} onClick={() => setShowEnded((value) => !value)}>
									<ChevronIcon size={11} className="machine-chevron" />
									{showEnded ? "Hide the ended ones" : `Show ${plural(groups.ended.length, "ended item")}`}
								</button>
								{showEnded ? null : <span>{ENDED.map((state) => [state, groups.ended.filter((item) => item.state === state).length] as const).filter(([, n]) => n > 0).map(([state, n]) => `${n} ${state}`).join(", ")}</span>}
							</p>
							<div id={ended} hidden={!showEnded}>
								<Group id={ids.ended} name="Ended" items={groups.ended} now={now} reviewer={reviewer} />
							</div>
						</>
					) : null}
				</>
			)}
		</main>
	);
}
