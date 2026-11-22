/* The ids of a feature's children are in feature-ids.ts: this file is shared with the web mock and stays free of Node modules. */
import type { FeaturePlan, FeaturePlanEdit, ItemBudget, PlanSubtask, SubtaskAgent } from "../contract.js";
import { harnessName, itemHarnessProblem, knownHarness, worksWithoutAsking } from "../sandbox/harnesses.js";
import { MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_TITLE_CHARS } from "../contract.js";

export const dimensions = ["tokens", "turns", "activeSeconds", "hostedSeconds"] as const;
export const emptyBudget = (): ItemBudget => ({ tokens: 0, turns: 0, activeSeconds: 0, hostedSeconds: 0 });
export function featureCap(single: ItemBudget, multiplier = 3): ItemBudget {
	const cap = emptyBudget();
	for (const key of dimensions) cap[key] = multiplier * single[key];
	return cap;
}

/** Planning receipts stay on the ledger. The implementer gets one Quick allowance within the feature cap. */
export function singleAfterPlanning(single: ItemBudget, spent: ItemBudget, feature: ItemBudget): ItemBudget {
	const budget = emptyBudget();
	for (const d of dimensions) budget[d] = Math.min(feature[d], Math.ceil(spent[d]) + single[d]);
	return budget;
}

/** Four closing turns allow the summary and reviewer a retry each. Scale time and tokens with the configured single item. */
export function closingReserve(single: ItemBudget): ItemBudget {
	return { tokens: Math.ceil(single.tokens / 6), turns: 4, activeSeconds: Math.ceil(single.activeSeconds / 6), hostedSeconds: Math.ceil(single.hostedSeconds / 6) };
}

/** A subtask's agent in words: "Claude Code (sonnet, high effort), works without asking"; "Windlass on the feature's model". */
export function agentWords(agent: SubtaskAgent | undefined): string {
	if (!agent) return "Windlass on the feature's model";
	const choice = [agent.model ?? (agent.harness === "windlass" ? "the feature's model" : "its default model"), ...(agent.effort ? [agent.effort + " effort"] : [])].join(", ");
	return `${harnessName(agent.harness)} (${choice})` + (worksWithoutAsking(agent.harness) ? ", works without asking" : "");
}

/** The keys of the subtasks still to run whose agent works without asking: approval needs the person's confirmation of each. */
export function unattendedKeys(plan: Pick<FeaturePlanEdit, "subtasks">, completed: ReadonlySet<string> = new Set()): string[] {
	return plan.subtasks.filter(s => !completed.has(s.key) && worksWithoutAsking(s.agent?.harness)).map(s => s.key);
}

export function approvalText(plan: FeaturePlan): string {
	const words = (b: ItemBudget) => [
		b.tokens.toLocaleString("en-US") + " tokens", b.turns + " turns",
		b.activeSeconds + " active seconds", b.hostedSeconds + " hosted seconds",
	].join(", ");
	const unattended = unattendedKeys(plan);
	return [plan.spec.goal, ...plan.subtasks.map(s => s.key + ". " + s.title + " — " + words(s.budget) + (s.place ? ` on ‘${s.place.prefer}’: ${s.place.reason}` : "") + " — " + agentWords(s.agent)),
		...(unattended.length ? [`${unattended.join(", ")} would run an agent that works without asking: it runs every command and edit in its sandbox without asking you. The planner proposed it from the item's text; approve only after confirming each one.`] : []),
		"Sizing beyond one slot is not supported by current runners.",
		"Reserved for summary and review — " + words(closingReserve(plan.compare.singleBudget)), "Feature cap — " + words(plan.budget), "Single item — " + words(plan.compare.singleBudget),
		...plan.questions.filter(q => !q.answer).map(q => q.text)].join("\n");
}

export class PlanError extends Error {}

/** A budget-only reallocation keeps the approved scope. */
export function planScope(plan: FeaturePlanEdit): string {
	return JSON.stringify([plan.overflow ?? false, plan.spec, plan.subtasks.map(({budget, ...scope}) => scope)]);
}

function requirePlan(ok: unknown, message: string): asserts ok {
	if (!ok) throw new PlanError(message);
}

function record(value: unknown): Record<string, unknown> {
	requirePlan(value && typeof value === "object" && !Array.isArray(value), "Expected a plan object.");
	return value as Record<string, unknown>;
}

function text(value: unknown, max = MAX_NOTE_CHARS): string {
	requirePlan(typeof value === "string" && value.trim() && value.length <= max, `Expected nonempty text of at most ${max} characters.`);
	return value.trim();
}

function lines(value: unknown, min = 0, max = MAX_ACCEPTANCE_CRITERIA): string[] {
	requirePlan(Array.isArray(value) && value.length >= min && value.length <= max, `Expected ${min} to ${max} entries.`);
	return value.map(line => text(line));
}

function keyOf(value: unknown): string {
	requirePlan(typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value), "Use a short stable key starting with a letter.");
	return value;
}

function unique(keys: string[]) {
	requirePlan(new Set(keys).size === keys.length, "Keys must be unique.");
}

// Intersect the two small glob languages. A wildcard may consume an element or advance
// without consuming. Remember each pair of positions to bound the search.
function intersect(a: string[], b: string[], wildcard: string, match: (a: string, b: string) => boolean, literalRight = false) {
	const pending: [number, number][] = [[0, 0]];
	const seen = new Set<string>();
	while (pending.length) {
		const [i, j] = pending.pop()!, key = i + "/" + j;
		if (seen.has(key)) continue;
		seen.add(key);
		if (i === a.length && j === b.length) return true;
		const x = a[i], y = b[j], rightWildcard = !literalRight && y === wildcard;
		if (x === wildcard) pending.push([i + 1, j]);
		if (rightWildcard) pending.push([i, j + 1]);
		if (x !== undefined && y !== undefined && (x === wildcard || rightWildcard || match(x, y)))
			pending.push([x === wildcard ? i : i + 1, rightWildcard ? j : j + 1]);
	}
	return false;
}

function overlaps(a: string, b: string, literalRight = false) {
	return intersect(a.split("/"), b.split("/"), "**", (x, y) => intersect([...x], [...y], "*", (m,n) => m === n, literalRight), literalRight);
}

export function ownsPath(owns: string[], path: string): boolean {
	return owns.some(pattern => overlaps(pattern, path, true));
}

/** The longest model id a subtask may name; an effort is at most 64 characters, as a Quick item's. */
const MAX_AGENT_ID = 200;

/**
 * A subtask's agent, checked as far as a plan can be: an agent work items run (not Codex), a model and an
 * effort of plain id text. Whether its place offers them is placement's (`placement.ts`, `agentFit`).
 * Windlass with nothing chosen is no choice: the subtask inherits the feature's model.
 */
function agentOf(value: unknown): SubtaskAgent | undefined {
	const a = record(value);
	for (const key of Object.keys(a)) requirePlan(["harness", "model", "effort"].includes(key), "Unknown agent field: " + key);
	const harness = a.harness === undefined ? "windlass" : knownHarness(a.harness);
	requirePlan(harness !== null, "Choose a supported agent: windlass, claude or opencode.");
	const problem = itemHarnessProblem(harness);
	requirePlan(problem === null, problem!);
	const id = (v: unknown, what: string, max: number) => {
		requirePlan(typeof v === "string" && v.length > 0 && v.length <= max && /^[\w.:/@+\[\]-]+$/.test(v), `Name the ${what} by its id.`);
		return v;
	};
	const model = a.model === undefined || a.model === null || a.model === "" ? undefined : id(a.model, "model", MAX_AGENT_ID);
	const effort = a.effort === undefined || a.effort === null || a.effort === "" ? undefined : id(a.effort, "effort", 64);
	if (harness === "windlass" && model === undefined && effort === undefined) return undefined;
	return { harness, ...(model !== undefined && { model }), ...(effort !== undefined && { effort }) };
}

/** Why a subtask's profile need refuses its agent: a machine harness runs only in the docker-hardened profile. */
export function agentProfileProblem(task: Pick<PlanSubtask, "agent" | "needs">): string | null {
	const agent = task.agent, profile = task.needs?.profile;
	return agent && worksWithoutAsking(agent.harness) && profile !== undefined && profile !== "docker-hardened" ? `${harnessName(agent.harness)} runs only in the docker-hardened profile.` : null;
}

function placementFields(s: Record<string, unknown>): Pick<PlanSubtask, "place" | "needs" | "agent"> {
	const result: Pick<PlanSubtask, "place" | "needs" | "agent"> = {};
	if (s.place !== undefined) {
		const p = record(s.place);
		const allow = p.allow === undefined ? undefined : lines(p.allow, 0, 12).map(n => text(n, 200));
		if (allow) unique(allow);
		result.place = { prefer: text(p.prefer, 200), reason: text(p.reason, 200), ...(allow && { allow }) };
	}
	if (s.needs !== undefined) {
		const n = record(s.needs);
		for (const key of Object.keys(n)) requirePlan(["tags", "screenshots", "egress", "profile", "harness", "cpus", "memoryGiB"].includes(key), "Unknown placement need: " + key);
		const needs: NonNullable<PlanSubtask["needs"]> = {};
		if (n.tags !== undefined) needs.tags = lines(n.tags, 0, 24).map(tag => text(tag, 100));
		if (n.screenshots !== undefined) {
			requirePlan(typeof n.screenshots === "boolean", "Choose yes or no for screenshots.");
			needs.screenshots = n.screenshots;
		}
		if (n.egress !== undefined) {
			requirePlan(n.egress === "open" || n.egress === "restricted", "Choose open or restricted egress.");
			needs.egress = n.egress;
		}
		if (n.profile !== undefined) {
			requirePlan(n.profile === "docker-hardened" || n.profile === "docker-windlass-sandbox", "Choose a supported Docker profile.");
			needs.profile = n.profile;
		}
		// Before subtasks named their agent, a need named its harness: read as the agent.
		if (n.harness !== undefined) result.agent = agentOf({ harness: n.harness });
		for (const key of ["cpus", "memoryGiB"] as const) if (n[key] !== undefined) {
			const value = n[key];
			requirePlan(typeof value === "number" && Number.isFinite(value) && value > 0, key + " must be a positive finite number.");
			needs[key] = value;
		}
		result.needs = needs;
	}
	if (s.agent !== undefined && s.agent !== null) {
		const agent = agentOf(s.agent);
		requirePlan(!result.agent || result.agent.harness === (agent?.harness ?? "windlass"), "Name the subtask's agent once, in agent.");
		if (agent) result.agent = agent; else delete result.agent;
	}
	const profile = agentProfileProblem(result);
	requirePlan(profile === null, profile!);
	return result;
}

export function subtaskMinimum(single: ItemBudget): ItemBudget {
	return {
		tokens: Math.max(1000, Math.ceil(single.tokens / 10)), turns: 2,
		activeSeconds: Math.max(60, Math.ceil(single.activeSeconds / 10)),
		hostedSeconds: Math.max(60, Math.ceil(single.hostedSeconds / 10)),
	};
}

export function validatePlan(value: unknown, single: ItemBudget, available: ItemBudget): FeaturePlanEdit {
	const p = record(value), spec = record(p.spec);
	requirePlan(p.overflow === undefined || typeof p.overflow === "boolean", "Choose yes or no for placement overflow.");
	const singleSuggested = p.singleSuggested == null ? null : text(p.singleSuggested);
	requirePlan(Array.isArray(p.questions) && p.questions.length <= 16, "Use at most 16 plan questions.");
	const questions = p.questions.map(raw => {
		const q = record(raw);
		return { id: keyOf(q.id), text: text(q.text), ...(q.options !== undefined && { options: lines(q.options, 1, 12) }), ...(q.answer && { answer: text(q.answer) } || {}) };
	});
	unique(questions.map(q => q.id));
	requirePlan(Array.isArray(p.subtasks) && (singleSuggested && p.subtasks.length === 0 || p.subtasks.length >= 2 && p.subtasks.length <= 6), "Propose two to six subtasks or suggest one single item.");
	const minimum = subtaskMinimum(single);
	const total = emptyBudget();
	const subtasks: PlanSubtask[] = p.subtasks.map(raw => {
		const s = record(raw), asked = record(s.budget), budget = emptyBudget();
		for (const key of dimensions) {
			const n = asked[key];
			requirePlan(typeof n === "number" && Number.isSafeInteger(n) && n >= minimum[key] && n <= single[key], `Subtask ${key} must be a whole number between ${minimum[key]} and ${single[key]}.`);
			budget[key] = n;
			total[key] += n;
			requirePlan(total[key] <= available[key], `Subtasks exceed the remaining ${key} budget after the summary and review reserve.`);
		}
		const owns = lines(s.owns, 1, 32);
		for (const path of owns) requirePlan(/^[\w.*@/-]+$/.test(path) && path.split("/").every(part => part && ![".", "..", ".git"].includes(part)), "Use repository-relative owned path globs.");
		const dependsOn = lines(s.dependsOn, 0, 5).map(keyOf);
		unique(dependsOn);
		const acceptance = lines(s.acceptance, 1);
		requirePlan(acceptance.some(line => /screenshot|`[^`]+`|(?:^|\s)(?:run|use|execute|npm|pnpm|yarn|bun|make|go test|cargo|pytest|python|docker|curl|gradle|mvn|dotnet|bash|sh)\s+\S/i.test(line)), "Name a check command or screenshot in each subtask’s acceptance.");
		return { key: keyOf(s.key), title: text(s.title, MAX_TITLE_CHARS), brief: text(s.brief, MAX_ITEM_BODY_CHARS), acceptance, owns, dependsOn, budget, ...placementFields(s) };
	});
	unique(subtasks.map(s => s.key));
	const ancestors = new Map<string, Set<string>>();
	const done = new Set<string>();
	while (done.size < subtasks.length) {
		const next = subtasks.find(s => !done.has(s.key) && s.dependsOn.every(k => done.has(k)));
		requirePlan(next, "Dependencies must name existing subtasks and form an acyclic graph.");
		const deps = new Set(next.dependsOn.flatMap(k => [k, ...ancestors.get(k)!]));
		for (const other of subtasks) if (done.has(other.key) && !deps.has(other.key))
			requirePlan(!next.owns.some(p => other.owns.some(q => overlaps(p, q))), "Independent subtasks must not overlap owned paths.");
		ancestors.set(next.key, deps);
		done.add(next.key);
	}
	return { overflow: p.overflow === true, questions, singleSuggested, subtasks, spec: { goal: text(spec.goal, 2000), acceptance: lines(spec.acceptance, 1), requirements: lines(spec.requirements), outOfScope: lines(spec.outOfScope) } };
}
