/**
 * A feature's subtasks as they run, read from the summaries the feed carries (`ItemFeed.children`,
 * `ItemView.children`) and the plan: how many run, ask, are done and are still to go; what each one is
 * doing now, in a step word and a short fact from its run, not a sentence; and where a subtask stands
 * among its siblings. Shared by the feature's page, a subtask's page and session, and the Factory's row.
 * Nothing here assumes one subtask at a time: any number may run at once.
 */
import type { FeaturePlan, ItemSummary, ItemView, PlanSubtask } from "@contract";
import { relativeTime } from "./format";

/** Where a subtask is, in one of five words: the segment bar's colours and the tally's parts. */
export type SubtaskState = "running" | "asks" | "done" | "stopped" | "to_go";

const ENDED = new Set<ItemSummary["state"]>(["done", "failed", "cancelled"]);

export function subtaskState(child: Pick<ItemSummary, "state" | "question"> | null): SubtaskState {
	if (!child) return "to_go";
	if (child.question) return "asks";
	if (child.state === "done") return "done";
	if (child.state === "failed" || child.state === "cancelled") return "stopped";
	return "running";
}

export interface SubtaskTally {
	running: number;
	asks: number;
	done: number;
	stopped: number;
	toGo: number;
	total: number;
}

/** One entry a subtask of the plan, in its order: its number, the task, and its item once it was made. */
export interface PlannedSubtask {
	n: number;
	task: PlanSubtask;
	child: ItemSummary | null;
	state: SubtaskState;
	/** A part the factory added on its own, not in the plan: what it repairs. */
	repair?: RepairKind;
}

/** What a part the factory adds repairs: the feature's failing CI, or its branch's conflicts with the base (blueprint.ts, `queueRepair`). */
export type RepairKind = "ci" | "conflict" | "review";

/** The repair a part's key names ("ci-fix-<n>", "conflict-fix-<n>"); null for a part of the plan. */
export function repairKind(key: string): RepairKind | null {
	if (key.startsWith("review-fix-")) return "review";
	return key.startsWith("ci-fix-") ? "ci" : key.startsWith("conflict-fix-") ? "conflict" : null;
}

/** Why the factory added a repair part, and what it fixes, in a sentence. */
export const REPAIR_WHY: Record<RepairKind, string> = {
	review: "This part addresses changes requested in review before the feature is checked again.",
	ci: "Added by the factory: the feature's CI failed after its parts were integrated. This part fixes the failing checks.",
	conflict:
		"Added by the factory: the feature branch no longer merges cleanly with its base. This part merges the base in and resolves the conflicts.",
};

/** A part as its feature's page names it: "Part 2: Render the table as a PDF", "Repair: Fix failing feature checks". */
export function partName(plan: Pick<FeaturePlan, "subtasks"> | null | undefined, key: string, title: string): string {
	const index = plan ? plan.subtasks.findIndex(task => task.key === key) : -1;
	if (index >= 0) return `Part ${index + 1}: ${title}`;
	return repairKind(key) ? `Repair: ${title}` : title;
}

/** The plan's subtasks in order, each with its item where there is one. A child the plan no longer names (an earlier version's) is left out. */
export function plannedSubtasks(
	plan: Pick<FeaturePlan, "subtasks">,
	children: readonly ItemSummary[],
): PlannedSubtask[] {
	const byKey = new Map<string, ItemSummary>();
	// The newest item of a key is the one that counts: a subtask re-planned gets a new one.
	for (const child of [...children].sort((a, b) => a.createdAt - b.createdAt))
		if (child.parent) byKey.set(child.parent.key, child);
	return plan.subtasks.map((task, index) => {
		const child = byKey.get(task.key) ?? null;
		return { n: index + 1, task, child, state: subtaskState(child) };
	});
}

export function tallyOf(subtasks: readonly PlannedSubtask[]): SubtaskTally {
	const tally: SubtaskTally = { running: 0, asks: 0, done: 0, stopped: 0, toGo: 0, total: subtasks.length };
	for (const { state } of subtasks) {
		if (state === "running") tally.running += 1;
		else if (state === "asks") tally.asks += 1;
		else if (state === "done") tally.done += 1;
		else if (state === "stopped") tally.stopped += 1;
		else tally.toGo += 1;
	}
	return tally;
}

/** The tally in a line: "2 running · 1 asks you · 1 of 6 done". The parts at nought are left out, but "done", which counts the whole. */
export function tallyParts(tally: SubtaskTally): Array<{ n: number; word: string; tone: SubtaskState }> {
	const parts: Array<{ n: number; word: string; tone: SubtaskState }> = [];
	if (tally.running > 0) parts.push({ n: tally.running, word: "running", tone: "running" });
	if (tally.asks > 0) parts.push({ n: tally.asks, word: tally.asks === 1 ? "asks you" : "ask you", tone: "asks" });
	if (tally.stopped > 0) parts.push({ n: tally.stopped, word: "stopped", tone: "stopped" });
	parts.push({ n: tally.done, word: `of ${tally.total} done`, tone: "done" });
	return parts;
}

export const tallyLine = (tally: SubtaskTally): string =>
	tallyParts(tally)
		.map(part => `${part.n} ${part.word}`)
		.join(" · ");

/** What a subtask is doing now: one step word, and a short fact or none. */
export interface Doing {
	word: string;
	fact: string | null;
	/** The fact quotes a command, shown in the mono face. */
	code?: string;
}

/** Name the prerequisites in plan order. */
export function afterWords(dependsOn: readonly string[], titles: ReadonlyMap<string, string>): string | null {
	const names = [...titles].filter(([key]) => dependsOn.includes(key)).map(([, title]) => `“${title}”`);
	return names.length ? "After " + new Intl.ListFormat("en").format(names) : null;
}

/** A command quoted in a subtask's first check, for the fact of a fixing step: "pnpm test test/golden". */
const firstCommand = (task: PlanSubtask): string | undefined =>
	task.acceptance.map(line => /`([^`]+)`/.exec(line)?.[1]).find(Boolean);

/**
 * What a subtask is doing now, from its summary's step (`ItemSummary.step`) where the server sends one:
 * "implementing · turn 2", "fixing · your checks failed, fix 1", "asks you · 3m ago".
 * A subtask not made yet says what it waits for: "After “Add the CSV writer”", or "not started".
 */
export function doingNow(
	entry: PlannedSubtask,
	titles: ReadonlyMap<string, string>,
	done: ReadonlySet<string>,
	now: number,
): Doing {
	const { child, task } = entry;
	if (!child) {
		const waiting = task.dependsOn.filter(key => !done.has(key));
		return waiting.length > 0
			? { word: "waits", fact: afterWords(waiting, titles) }
			: { word: "not started", fact: null };
	}
	return itemDoing(child, now, task);
}

export function itemDoing(child: ItemSummary, now: number, task?: PlanSubtask): Doing {
	if (child.question) return { word: "asks you", fact: relativeTime(child.question.askedAt, now) };
	switch (child.state) {
		case "done":
			return { word: "merged", fact: "into the feature branch" };
		case "failed":
			return { word: "failed", fact: null };
		case "cancelled":
			return { word: "cancelled", fact: null };
		case "draft":
		case "queued":
			return { word: "queued", fact: null };
		case "review":
			return { word: "handed over", fact: null };
		case "waiting":
			if (child.wait?.reason === "machine")
				return { word: "waits", fact: child.placement ? `for a slot on ${child.placement.name}` : "for its machine" };
			if (child.wait?.reason === "ci") return { word: "CI", fact: null };
			return { word: "waits", fact: (child.wait && WAIT_FACT[child.wait.reason]) ?? null };
	}
	const step = child.step;
	const turns = `turn ${Math.max(1, child.spent.turns)}`;
	if (!step) return { word: "working", fact: turns };
	const { rounds } = step;
	switch (step.kind) {
		case "implement":
		case "refine":
			if (rounds.gate > 0)
				return { word: "fixing", fact: `your checks failed, fix ${rounds.gate}`, code: task && firstCommand(task) };
			return { word: "implementing", fact: turns };
		case "run_checks":
			return { word: "checking", fact: "running local checks" };
		case "gate":
			return { word: "checking", fact: rounds.gate > 0 ? `after fix ${rounds.gate}` : null };
		case "ci_fix":
			return { word: "fixing", fact: `CI failed, fix ${rounds.ci}` };
		case "conflict":
			return { word: "merging", fact: `the base, round ${rounds.conflict}` };
		case "review_fix":
			return { word: "fixing", fact: `the review, fix ${rounds.review ?? 0}` };
		case "publish":
			return { word: "pushing", fact: null };
		case "ci":
			return { word: "CI", fact: null };
		case "review":
			return { word: "in review", fact: null };
		default:
			return { word: "working", fact: null };
	}
}

const WAIT_FACT: Partial<Record<NonNullable<ItemSummary["wait"]>["reason"], string>> = {
	capacity: "for a turn",
	provider: "for the provider",
	budget: "for budget",
	sandboxes: "for a sandbox",
	integration: "for testing together",
};

/** The keys of the plan's subtasks whose items are done: what a waiting subtask's "after" is read against. */
export const doneKeys = (subtasks: readonly PlannedSubtask[]): Set<string> =>
	new Set(subtasks.filter(entry => entry.state === "done").map(entry => entry.task.key));

/** The active ones (running or asking), in plan order: what the Factory's row lists under a feature. */
export const activeSubtasks = (subtasks: readonly PlannedSubtask[]): PlannedSubtask[] =>
	subtasks.filter(entry => entry.state === "running" || entry.state === "asks");

/**
 * Whether a page that shows a feature's subtasks (or one subtask) is behind the live feed's open
 * subtasks: one of them is at a newer revision than the page's, a subtask the page holds as open is no
 * longer open (it ended), or one was made that the page does not hold. `feedChildren` undefined (a
 * server before `ItemFeed.children`) says nothing.
 */
export function childrenBehind(
	parentId: string,
	shown: readonly Pick<ItemSummary, "id" | "revision" | "state">[],
	feedChildren: readonly ItemSummary[] | undefined,
): boolean {
	if (!feedChildren) return false;
	const mine = feedChildren.filter(child => child.parent?.itemId === parentId);
	const held = new Map(shown.map(child => [child.id, child]));
	for (const child of mine) {
		const at = held.get(child.id);
		if (!at || child.revision > at.revision) return true;
	}
	const open = new Set(mine.map(child => child.id));
	return shown.some(child => !ENDED.has(child.state) && !open.has(child.id));
}

// ---- what runs now, what is next, what is done --------------------------------------------------

/**
 * How many subtasks of a feature run at once: the server's `RULES.parallelChildren`
 * (server/src/factory/blueprint.ts). The view does not carry it.
 */
export const PARALLEL_SUBTASKS = 3;

/** A dispatched subtask as the feature's view lists it (`ItemView.subtasks`). */
export type DispatchedSubtask = NonNullable<ItemView["subtasks"]>[number];

/**
 * Where a subtask is, in the words the feature's page groups it by. Up next: "after" (a dependency not
 * integrated yet), "files" (its owned paths overlap a running one's), "slot" (every place is taken),
 * "starting" (nothing holds it: it starts at the next pass). Running: "place" (waiting for a place to
 * run), "asks", "running", "fixing", "checks", "ci", "integrating", "conflict". Done: "integrated",
 * "failed", "cancelled".
 */
export type SubtaskPhase =
	| "after"
	| "files"
	| "slot"
	| "starting"
	| "place"
	| "asks"
	| "running"
	| "fixing"
	| "checks"
	| "ci"
	| "integrating"
	| "conflict"
	| "integrated"
	| "failed"
	| "cancelled";

export interface SubtaskLine {
	entry: PlannedSubtask;
	phase: SubtaskPhase;
	/** One to three words: "running", "checks", "waiting for a place", "waits for". */
	word: string;
	/** A short fact beside the word, or none: "turn 2", the server's wait sentence. */
	fact: string | null;
	/** "after": the subtasks it waits for, not integrated yet, in plan order. */
	after?: PlannedSubtask[];
	/** "files": a path the running `owner` owns that overlaps one of its own; null when either lists none. */
	files?: { path: string | null; owner: PlannedSubtask };
	/** Its job, once dispatched. */
	job: DispatchedSubtask | null;
	/** Where it runs: the place it was given, "hosted", or null before it has one. */
	place: string | null;
	/** Since when it runs (its start, else its dispatch), ms; null when not known or not running. */
	since: number | null;
}

export interface SubtaskGroups {
	/** Dispatched and not ended, those waiting for a place among them: they hold the slots. In plan order. */
	running: SubtaskLine[];
	/** Not dispatched and not integrated, in plan order. */
	next: SubtaskLine[];
	/** Ended: integrated, failed or cancelled, in plan order. */
	done: SubtaskLine[];
	slots: number;
}

const WAITS_FOR_PLACE = new Set<NonNullable<ItemSummary["wait"]>["reason"]>([
	"machine",
	"capacity",
	"provider",
	"sandboxes",
]);

/** A running subtask's word and fact, from its item's state and step, or its job before its item is read. */
function runningPhase(
	child: ItemSummary | null,
	job: DispatchedSubtask | null,
	task: PlanSubtask,
): Pick<SubtaskLine, "phase" | "word" | "fact"> {
	const place = (fact: string | null) => ({ phase: "place" as const, word: "waiting for a place", fact });
	if (!child) return job?.wait ? place(job.wait) : { phase: "running", word: "starting", fact: null };
	if (child.question) return { phase: "asks", word: "asks you", fact: null };
	if (child.state === "waiting" && child.wait?.reason === "ci") return { phase: "ci", word: "CI", fact: null };
	if (child.state === "waiting" && child.wait && WAITS_FOR_PLACE.has(child.wait.reason))
		return place(job?.wait ?? child.wait.sentence);
	if (job?.wait && (child.state === "draft" || child.state === "queued" || child.state === "waiting"))
		return place(job.wait);
	if (child.state === "draft" || child.state === "queued") return { phase: "running", word: "starting", fact: null };
	const step = child.step;
	const turn = `turn ${Math.max(1, child.spent.turns)}`;
	if (!step) return { phase: "running", word: "running", fact: turn };
	const { rounds } = step;
	switch (step.kind) {
		case "implement":
		case "refine":
			return rounds.gate > 0
				? { phase: "fixing", word: "fixing", fact: `checks failed, fix ${rounds.gate}` }
				: { phase: "running", word: "running", fact: turn };
		case "ci_fix":
			return { phase: "fixing", word: "fixing", fact: `CI failed, fix ${rounds.ci}` };
		case "review_fix":
			return { phase: "fixing", word: "fixing", fact: `the review, fix ${rounds.review ?? 0}` };
		case "run_checks":
		case "gate":
			return { phase: "checks", word: "checks", fact: firstCommand(task) ?? null };
		case "publish":
		case "ci":
			return { phase: "ci", word: "CI", fact: null };
		// A subtask's own "subtasks" step is its integration into the feature branch (blueprint.ts, the "integrate" effect).
		case "subtasks":
			return { phase: "integrating", word: "integrating", fact: "into the feature branch" };
		case "conflict":
			return { phase: "conflict", word: "conflict", fact: "merging the feature branch" };
		default:
			return { phase: "running", word: "running", fact: turn };
	}
}

const placeOf = (child: ItemSummary | null): string | null =>
	child?.placement?.name ?? (child?.place.kind === "hosted" && child.state !== "draft" ? "hosted" : null);

/**
 * A feature's subtasks grouped as its page shows them: what runs now (holding the feature's
 * `PARALLEL_SUBTASKS` slots), what is next and what holds it, and what is done. What holds a subtask
 * not yet started is read as the server decides it (blueprint.ts, `nextChild`): a dependency not
 * integrated, then a running subtask whose owned paths overlap its own (`sharesPaths`), then a full set
 * of slots.
 */
/** The parts the factory adds on its own (a conflict or failing-CI repair): not in the plan, newest of each key. */
export function repairSubtasks(
	plan: Pick<FeaturePlan, "subtasks">,
	children: readonly ItemSummary[],
	from: number,
): PlannedSubtask[] {
	const planned = new Set(plan.subtasks.map(task => task.key));
	const byKey = new Map<string, ItemSummary>();
	for (const child of [...children].sort((a, b) => a.createdAt - b.createdAt))
		if (child.parent && !planned.has(child.parent.key)) byKey.set(child.parent.key, child);
	return [...byKey.values()].map((child, index) => {
		const key = child.parent!.key;
		const repair = repairKind(key);
		const task = {
			key,
			title: child.title,
			brief: "",
			acceptance: [],
			owns: [],
			dependsOn: [],
			budget: child.budget,
		} as PlanSubtask;
		return { n: from + index, task, child, state: subtaskState(child), ...(repair && { repair }) };
	});
}

export function groupSubtasks(
	plan: Pick<FeaturePlan, "subtasks">,
	children: readonly ItemSummary[],
	jobs: readonly DispatchedSubtask[] | undefined,
	featureWait?: ItemSummary["wait"],
): SubtaskGroups {
	// The feature waiting for a place is about the next subtask to start: that one says so, in the server's words.
	let placeWait = featureWait && WAITS_FOR_PLACE.has(featureWait.reason) ? featureWait.sentence : null;
	const planned = plannedSubtasks(plan, children);
	// Repairs run and end like any part, so they are listed with them; the "of N integrated" count stays the plan's.
	const entries = [...planned, ...repairSubtasks(plan, children, planned.length + 1)];
	// The newest job of a key is the one that counts, as for its item.
	const jobOf = new Map<string, DispatchedSubtask>();
	for (const job of [...(jobs ?? [])].sort((a, b) => (a.dispatchedAt ?? 0) - (b.dispatchedAt ?? 0)))
		jobOf.set(job.key, job);
	const groups: SubtaskGroups = { running: [], next: [], done: [], slots: PARALLEL_SUBTASKS };
	const byKey = new Map(entries.map(entry => [entry.task.key, entry]));
	const pending: PlannedSubtask[] = [];
	for (const entry of entries) {
		const job = jobOf.get(entry.task.key) ?? null;
		const { child } = entry;
		// The job's state is newer than a summary the feed has not brought yet; the item's is newer than a job's.
		const state = child?.state ?? job?.state ?? null;
		if (state === null) {
			pending.push(entry);
			continue;
		}
		const base = { entry, job, place: placeOf(child) };
		if (ENDED.has(state)) {
			const phase: SubtaskPhase = state === "done" ? "integrated" : state === "failed" ? "failed" : "cancelled";
			groups.done.push({ ...base, phase, word: phase, fact: null, since: null });
			continue;
		}
		groups.running.push({
			...base,
			...runningPhase(child, job, entry.task),
			since: job?.startedAt ?? job?.dispatchedAt ?? child?.createdAt ?? null,
		});
	}
	const integrated = new Set(groups.done.filter(line => line.phase === "integrated").map(line => line.entry.task.key));
	for (const entry of pending) {
		const base = { entry, job: null, place: null, since: null };
		const after = entry.task.dependsOn
			.filter(key => !integrated.has(key))
			.map(key => byKey.get(key))
			.filter((one): one is PlannedSubtask => one !== undefined);
		if (after.length > 0) {
			groups.next.push({ ...base, phase: "after", word: "waits for", fact: null, after });
			continue;
		}
		const holder = groups.running.find(line => sharesPaths(line.entry.task, entry.task));
		if (holder) {
			groups.next.push({
				...base,
				phase: "files",
				word: "waits for",
				fact: null,
				files: { path: overlappingPath(entry.task, holder.entry.task), owner: holder.entry },
			});
			continue;
		}
		if (groups.running.length >= PARALLEL_SUBTASKS)
			groups.next.push({
				...base,
				phase: "slot",
				word: "waits for",
				fact: `a free slot: ${PARALLEL_SUBTASKS} run at once`,
			});
		else if (placeWait) {
			groups.next.push({ ...base, phase: "starting", word: "waiting for a place", fact: placeWait });
			placeWait = null;
		} else groups.next.push({ ...base, phase: "starting", word: "starting", fact: null });
	}
	return groups;
}

/** How long a subtask has run, to the minute: "<1m", "14m", "1h 05m". */
export function elapsed(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// ---- owned paths: the server's overlap test (server/src/factory/feature-plan.ts, `sharedPaths`) ------

// Intersect the two small glob languages. A wildcard may consume an element or advance without
// consuming. Each pair of positions is remembered to bound the search.
function intersect(a: string[], b: string[], wildcard: string, match: (a: string, b: string) => boolean): boolean {
	const pending: [number, number][] = [[0, 0]];
	const seen = new Set<string>();
	while (pending.length) {
		const [i, j] = pending.pop()!;
		const key = `${i}/${j}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (i === a.length && j === b.length) return true;
		const x = a[i];
		const y = b[j];
		const rightWildcard = y === wildcard;
		if (x === wildcard) pending.push([i + 1, j]);
		if (rightWildcard) pending.push([i, j + 1]);
		if (x !== undefined && y !== undefined && (x === wildcard || rightWildcard || match(x, y)))
			pending.push([x === wildcard ? i : i + 1, rightWildcard ? j : j + 1]);
	}
	return false;
}

const overlaps = (a: string, b: string): boolean =>
	intersect(a.split("/"), b.split("/"), "**", (x, y) => intersect([...x], [...y], "*", (m, n) => m === n));

/** Plain paths include their descendants. A glob describes its own depth. */
const ownedGlob = (entry: string): string => (entry.includes("*") ? entry : `${entry}/**`);

/** Whether two subtasks may not run at once for their files: as the server reads it, one that lists no owned paths overlaps every other. */
export function sharesPaths(a: Pick<PlanSubtask, "owns" | "repo">, b: Pick<PlanSubtask, "owns" | "repo">): boolean {
	if (!a.owns?.length || !b.owns?.length) return true;
	return a.repo === b.repo && a.owns.some(p => b.owns.some(q => overlaps(ownedGlob(p), ownedGlob(q))));
}

/** The first of `holder`'s owned paths that overlaps one of `task`'s; null when either lists none. */
export function overlappingPath(task: Pick<PlanSubtask, "owns">, holder: Pick<PlanSubtask, "owns">): string | null {
	if (!task.owns?.length || !holder.owns?.length) return null;
	return holder.owns.find(q => task.owns.some(p => overlaps(ownedGlob(p), ownedGlob(q)))) ?? null;
}
