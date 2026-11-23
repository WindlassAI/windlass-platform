/**
 * A feature's subtasks as they run, read from the summaries the feed carries (`ItemFeed.children`,
 * `ItemView.children`) and the plan: how many run, ask, are done and are still to go; what each one is
 * doing now, in a step word and a short fact from its run, not a sentence; and where a subtask stands
 * among its siblings. Shared by the feature's page, a subtask's page and session, and the Factory's row.
 * Nothing here assumes one subtask at a time: any number may run at once.
 */
import type { FeaturePlan, ItemSummary, PlanSubtask } from "@contract";
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
}

/** The plan's subtasks in order, each with its item where there is one. A child the plan no longer names (an earlier version's) is left out. */
export function plannedSubtasks(plan: Pick<FeaturePlan, "subtasks">, children: readonly ItemSummary[]): PlannedSubtask[] {
	const byKey = new Map<string, ItemSummary>();
	// The newest item of a key is the one that counts: a subtask re-planned gets a new one.
	for (const child of [...children].sort((a, b) => a.createdAt - b.createdAt)) if (child.parent) byKey.set(child.parent.key, child);
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

export const tallyLine = (tally: SubtaskTally): string => tallyParts(tally).map((part) => `${part.n} ${part.word}`).join(" · ");

/** What a subtask is doing now: one step word, and a short fact or none. */
export interface Doing {
	word: string;
	fact: string | null;
	/** The fact quotes a command, shown in the mono face. */
	code?: string;
}

/** The keys a subtask waits for, by number, in words: "after 2", "after 2 and 3". */
export function afterWords(task: PlanSubtask, numbers: ReadonlyMap<string, number>): string | null {
	if (task.dependsOn.length === 0) return null;
	const ns = task.dependsOn.map((key) => numbers.get(key) ?? key).sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)))).map(String);
	return `after ${ns.length === 1 ? ns[0] : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`}`;
}

/** A command quoted in a subtask's first check, for the fact of a fixing step: "pnpm test test/golden". */
const firstCommand = (task: PlanSubtask): string | undefined => task.acceptance.map((line) => /`([^`]+)`/.exec(line)?.[1]).find(Boolean);

/**
 * What a subtask is doing now, from its summary's step (`ItemSummary.step`) where the server sends one:
 * "implementing · turn 2", "fixing · your checks failed, fix 1", "asks you · 3m ago".
 * A subtask not made yet says what it waits for: "after 2 and 3", or "not started".
 */
export function doingNow(entry: PlannedSubtask, numbers: ReadonlyMap<string, number>, done: ReadonlySet<string>, now: number): Doing {
	const { child, task } = entry;
	if (!child) {
		const waiting = task.dependsOn.filter((key) => !done.has(key));
		return waiting.length > 0 ? { word: "waits", fact: afterWords({ ...task, dependsOn: waiting }, numbers) } : { word: "not started", fact: null };
	}
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
			if (child.wait?.reason === "machine") return { word: "waits", fact: child.placement ? `for a slot on ${child.placement.name}` : "for its machine" };
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
			if (rounds.gate > 0) return { word: "fixing", fact: `your checks failed, fix ${rounds.gate}`, code: firstCommand(task) };
			return { word: "implementing", fact: turns };
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
export const doneKeys = (subtasks: readonly PlannedSubtask[]): Set<string> => new Set(subtasks.filter((entry) => entry.state === "done").map((entry) => entry.task.key));

/** A subtask among its siblings: its place, and the ones before and after it. */
export function siblingsOf(subtasks: readonly PlannedSubtask[], key: string): { at: PlannedSubtask; previous: PlannedSubtask | null; next: PlannedSubtask | null } | null {
	const index = subtasks.findIndex((entry) => entry.task.key === key);
	if (index < 0) return null;
	return { at: subtasks[index]!, previous: subtasks[index - 1] ?? null, next: subtasks[index + 1] ?? null };
}

/** The active ones (running or asking), in plan order: what the Factory's row lists under a feature. */
export const activeSubtasks = (subtasks: readonly PlannedSubtask[]): PlannedSubtask[] => subtasks.filter((entry) => entry.state === "running" || entry.state === "asks");

/**
 * Whether a page that shows a feature's subtasks (or one subtask) is behind the live feed's open
 * subtasks: one of them is at a newer revision than the page's, a subtask the page holds as open is no
 * longer open (it ended), or one was made that the page does not hold. `feedChildren` undefined (a
 * server before `ItemFeed.children`) says nothing.
 */
export function childrenBehind(parentId: string, shown: readonly Pick<ItemSummary, "id" | "revision" | "state">[], feedChildren: readonly ItemSummary[] | undefined): boolean {
	if (!feedChildren) return false;
	const mine = feedChildren.filter((child) => child.parent?.itemId === parentId);
	const held = new Map(shown.map((child) => [child.id, child]));
	for (const child of mine) {
		const at = held.get(child.id);
		if (!at || child.revision > at.revision) return true;
	}
	const open = new Set(mine.map((child) => child.id));
	return shown.some((child) => !ENDED.has(child.state) && !open.has(child.id));
}
