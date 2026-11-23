/* The ids of a feature's children are in feature-ids.ts: this file is shared with the web mock and stays free of Node modules. */
import type { EarlyCheck, FeaturePlan, FeaturePlanEdit, FinalIntegration, ItemBudget, MergeStep, PlanSubtask, SubtaskAgent, SubtaskBudget } from "../contract.js";
import { harnessName, knownHarness, subtaskHarnessProblem, worksWithoutAsking } from "../sandbox/harnesses.js";
import { MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_TITLE_CHARS } from "../contract.js";

/** The figures a budget has (`ItemBudget`). A subtask's plan budget has `tokens` only. */
export const dimensions = ["tokens", "hostedSeconds"] as const;
export const emptyBudget = (): ItemBudget => ({ tokens: 0, hostedSeconds: 0 });

/** Planning receipts stay on the ledger. One implementer gets one item's budget on top of what planning spent. */
export function singleAfterPlanning(single: ItemBudget, spent: Pick<ItemBudget, "tokens" | "hostedSeconds">): ItemBudget {
	return { tokens: Math.ceil(spent.tokens) + single.tokens, hostedSeconds: Math.ceil(spent.hostedSeconds) + single.hostedSeconds };
}

/** The longest a combined run may take. */
export const INTEGRATION_SECONDS = 3600;

/** A cross-repo plan: one that names its repositories. */
export const crossRepoPlan = (plan: Pick<FeaturePlanEdit, "repos"> | null | undefined): boolean => (plan?.repos?.length ?? 0) > 1;

/** The tokens a plan gives its subtasks, together. */
export const planTokens = (plan: Pick<FeaturePlanEdit, "subtasks">): number => plan.subtasks.reduce((sum, task) => sum + task.budget.tokens, 0);

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
	const words = (b: SubtaskBudget) => b.tokens.toLocaleString("en-US") + " tokens";
	const unattended = unattendedKeys(plan);
	const cross = crossRepoPlan(plan);
	const final = plan.finalIntegration;
	return [plan.spec.goal, ...plan.subtasks.map(s => s.key + ". " + (cross ? `[${s.repo}] ` : "") + s.title + " — " + words(s.budget) + (s.place ? ` on ‘${s.place.prefer}’: ${s.place.reason}` : "") + " — " + agentWords(s.agent)),
		...(unattended.length ? [`${unattended.join(", ")} would run an agent that works without asking: it runs every command and edit in its sandbox without asking you. The planner proposed it from the item's text; approve only after confirming each one.`] : []),
		...(cross && final ? [
			"Merge order — " + (plan.mergeOrder ?? []).map(m => m.repo + (m.prerequisite.length ? ` after ${m.prerequisite.join(", ")}` : "")).join(", then ") + ".",
			`Tested together in ${final.runFrom}: ${final.command} (inputs ${final.inputs.join(", ")}; at most ${final.timeoutSeconds} seconds; required cases: ${final.requiredCases.join("; ")}).`,
			plan.releaseGate === "wait" ? "Ends when the owner's release is adopted." : "Ends at a tested set of pull requests and a release request; adopting a release is a separate feature.",
		] : []),
		...(plan.subtasks.some(s => s.needs?.cpus !== undefined || s.needs?.memoryGiB !== undefined) ? ["On hosted, cpus and memoryGiB choose the least sandbox size that has them, at most 4 vCPU and 8 GiB; on a machine, its slots."] : []),
		"Subtasks together — " + words({ tokens: planTokens(plan) }) + " (cost-weighted: cached input counts at a tenth)", "Feature budget with planning, summary and review — " + words(plan.budget), "At most per subtask — " + words(plan.compare.singleBudget),
		...plan.questions.filter(q => !q.answer).map(q => q.text)].join("\n");
}

export class PlanError extends Error {}

/** A budget-only reallocation keeps the approved scope. */
export function planScope(plan: FeaturePlanEdit): string {
	const scope: unknown[] = [plan.overflow ?? false, plan.spec, plan.subtasks.map(({budget, ...scope}) => scope)];
	// A one-repository plan keeps the fingerprint it always had; a cross-repo one adds what was approved of its repositories.
	if (crossRepoPlan(plan)) scope.push({ repos: plan.repos, releaseGate: plan.releaseGate ?? "request", finalIntegration: plan.finalIntegration ?? null, mergeOrder: plan.mergeOrder ?? [], earlyChecks: plan.earlyChecks ?? [] });
	return JSON.stringify(scope);
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

/** The most a plan question's background (`why`) keeps: it is cut there, never refused, so a long one costs the plan nothing. */
export const PLAN_QUESTION_WHY_CHARS = 400;

/** Text cut to `max` characters, with an ellipsis where it was cut. */
function cut(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
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
 * A subtask's agent, checked as far as a plan can be: an agent subtasks run (not Codex: `subtaskHarnessProblem`), a model and an
 * effort of plain id text. Whether its place offers them is placement's (`placement.ts`, `agentFit`).
 * Windlass with nothing chosen is no choice: the subtask inherits the feature's model.
 */
function agentOf(value: unknown): SubtaskAgent | undefined {
	const a = record(value);
	for (const key of Object.keys(a)) requirePlan(["harness", "model", "effort"].includes(key), "Unknown agent field: " + key);
	const harness = a.harness === undefined ? "windlass" : knownHarness(a.harness);
	requirePlan(harness !== null, "Choose a supported agent: windlass, claude or opencode.");
	const problem = subtaskHarnessProblem(harness);
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

/** The least a subtask may be given: a tenth of one item's tokens, and at least 1,000. */
export function subtaskMinimum(single: Pick<ItemBudget, "tokens">): SubtaskBudget {
	return { tokens: Math.max(1000, Math.ceil(single.tokens / 10)) };
}

/** A repository alias as a filing gives it. */
export const ALIAS = /^[a-z][a-z0-9-]{0,15}$/;

function aliasIn(value: unknown, filing: readonly string[], what: string): string {
	requirePlan(typeof value === "string" && ALIAS.test(value), `Name ${what} by its short alias.`);
	requirePlan(filing.includes(value), `${value} is not a repository of this feature: use ${filing.join(" or ")}.`);
	return value;
}

/**
 * What a cross-repo plan adds, checked against the filing's repositories (`filing`, the primary first):
 * the repositories, the merge order, the release gate, early checks and the combined run.
 */
function crossRepoFields(p: Record<string, unknown>, filing: readonly string[], subtasks: PlanSubtask[]): Pick<FeaturePlanEdit, "repos" | "mergeOrder" | "releaseGate" | "earlyChecks" | "finalIntegration"> {
	requirePlan(Array.isArray(p.repos) && p.repos.every(r => typeof r === "string"), "List the feature's repositories in repos.");
	const named = p.repos as string[];
	requirePlan(named.length <= filing.length, `A feature may span at most ${filing.length} repositories: those it was filed over.`);
	for (const r of named) aliasIn(r, filing, "each repository");
	unique(named);
	requirePlan(named.length === filing.length, "Plan for every repository the feature was filed over: " + filing.join(", ") + ".");
	for (const alias of filing) requirePlan(subtasks.some(s => s.repo === alias), `Give ${alias} at least one subtask, or file the feature over one repository.`);
	requirePlan(Array.isArray(p.mergeOrder), "Give the merge order: one entry per repository.");
	const seen = new Set<string>();
	const mergeOrder: MergeStep[] = (p.mergeOrder as unknown[]).map(raw => {
		const m = record(raw), repo = aliasIn(m.repo, filing, "each merge step's repository");
		requirePlan(!seen.has(repo), `${repo} appears twice in the merge order: one pull request merges once, so a rollout that merges it again after another needs a later feature.`);
		requirePlan(Array.isArray(m.prerequisite ?? []), "A merge step's prerequisite is a list of repositories.");
		const prerequisite = ((m.prerequisite ?? []) as unknown[]).map(r => aliasIn(r, filing, "a merge prerequisite"));
		unique(prerequisite);
		for (const before of prerequisite) {
			requirePlan(before !== repo, `${repo} cannot merge after itself.`);
			requirePlan(seen.has(before), `${repo} needs ${before} to merge first, so ${before} comes earlier in the merge order. Merge prerequisites must not form a cycle.`);
		}
		seen.add(repo);
		return { repo, prerequisite, intermediate: text(m.intermediate), evidence: text(m.evidence), fallback: text(m.fallback) };
	});
	for (const alias of filing) requirePlan(seen.has(alias), `Put ${alias} in the merge order.`);
	const releaseGate = p.releaseGate === undefined || p.releaseGate === null ? "request" : p.releaseGate;
	requirePlan(releaseGate === "request" || releaseGate === "wait", "Choose request or wait for the release gate.");
	requirePlan(releaseGate === "request", "Waiting for a release is not offered yet: end the feature at a release request.");
	const early = p.earlyChecks ?? [];
	requirePlan(Array.isArray(early) && early.length <= 4, "Use at most 4 early checks.");
	const earlyChecks: EarlyCheck[] = early.map(raw => {
		const e = record(raw), repo = aliasIn(e.repo, filing, "an early check's repository"), sibling = aliasIn(e.sibling, filing, "an early check's sibling");
		requirePlan(repo !== sibling, "An early check runs one repository against the other.");
		return { repo, sibling, name: text(e.name, 200), command: text(e.command, 2000) };
	});
	const f = record(p.finalIntegration);
	const runFrom = aliasIn(f.runFrom, filing, "the repository the combined run starts from");
	requirePlan(typeof f.command === "string" && f.command.trim() !== "", "Give the combined run a command.");
	requirePlan(Array.isArray(f.inputs), "List the combined run's inputs.");
	const inputs = (f.inputs as unknown[]).map(r => aliasIn(r, filing, "each input of the combined run"));
	unique(inputs);
	for (const alias of filing) requirePlan(inputs.includes(alias), `The combined run must take ${alias} as an input.`);
	const profile = f.profile === undefined ? "actions" : f.profile;
	requirePlan(profile === "actions", "The combined run runs on GitHub Actions (profile actions).");
	const timeoutSeconds = f.timeoutSeconds === undefined ? INTEGRATION_SECONDS : f.timeoutSeconds;
	requirePlan(typeof timeoutSeconds === "number" && Number.isSafeInteger(timeoutSeconds) && timeoutSeconds >= 60 && timeoutSeconds <= INTEGRATION_SECONDS, `The combined run's timeout is a whole number of seconds from 60 to ${INTEGRATION_SECONDS}.`);
	const finalIntegration: FinalIntegration = {
		runFrom, command: text(f.command, 2000), inputs: filing.filter(a => inputs.includes(a)), profile, timeoutSeconds,
		requiredCases: lines(f.requiredCases, 1, 32).map(c => text(c, 200)),
		artifactOutputs: lines(f.artifactOutputs ?? [], 0, 16).map(c => text(c, 200)),
	};
	return { repos: [...filing], mergeOrder, releaseGate, earlyChecks, finalIntegration };
}

/**
 * The plan, checked. `repos`: the aliases of a cross-repo filing's repositories, the primary first; a
 * plan for one is then cross-repo and must say how its repositories merge and are tested together.
 */
export function validatePlan(value: unknown, single: Pick<ItemBudget, "tokens">, repos: readonly string[] = []): FeaturePlanEdit {
	const p = record(value), spec = record(p.spec);
	const cross = repos.length > 1;
	// A one-repository plan is checked as it always was: what only a cross-repo plan has (repos, mergeOrder, releaseGate,
	// earlyChecks, finalIntegration, a subtask's repo) is not read, as before there were cross-repo features.
	requirePlan(p.overflow === undefined || typeof p.overflow === "boolean", "Choose yes or no for placement overflow.");
	const singleSuggested = p.singleSuggested == null ? null : text(p.singleSuggested);
	requirePlan(Array.isArray(p.questions) && p.questions.length <= 16, "Use at most 16 plan questions.");
	const questions = p.questions.map(raw => {
		const q = record(raw);
		requirePlan(q.why == null || typeof q.why === "string", "A question's why must be text.");
		const why = typeof q.why === "string" ? cut(q.why.trim(), PLAN_QUESTION_WHY_CHARS) : "";
		return { id: keyOf(q.id), text: text(q.text), ...(q.options !== undefined && { options: lines(q.options, 1, 12) }), ...(why && { why }), ...(q.answer && { answer: text(q.answer) } || {}) };
	});
	unique(questions.map(q => q.id));
	requirePlan(Array.isArray(p.subtasks) && (singleSuggested && p.subtasks.length === 0 || p.subtasks.length >= 2 && p.subtasks.length <= 6), "Propose two to six subtasks or suggest one single item.");
	const minimum = subtaskMinimum(single);
	const subtasks: PlanSubtask[] = p.subtasks.map(raw => {
		const s = record(raw), asked = record(s.budget);
		// One cost-weighted token figure. A plan from before names more figures; only its tokens are read.
		const n = asked.tokens;
		requirePlan(typeof n === "number" && Number.isSafeInteger(n) && n >= minimum.tokens && n <= single.tokens, `Subtask tokens must be a whole number between ${minimum.tokens} and ${single.tokens}.`);
		const budget: SubtaskBudget = { tokens: n };
		const owns = lines(s.owns, 1, 32);
		for (const path of owns) requirePlan(/^[\w.*@/-]+$/.test(path) && path.split("/").every(part => part && ![".", "..", ".git"].includes(part)), "Use repository-relative owned path globs.");
		const dependsOn = lines(s.dependsOn, 0, 5).map(keyOf);
		unique(dependsOn);
		const acceptance = lines(s.acceptance, 1);
		requirePlan(acceptance.some(line => /screenshot|`[^`]+`|(?:^|\s)(?:run|use|execute|npm|pnpm|yarn|bun|make|go test|cargo|pytest|python|docker|curl|gradle|mvn|dotnet|bash|sh)\s+\S/i.test(line)), "Name a check command or screenshot in each subtask’s acceptance.");
		const repo = cross ? aliasIn(s.repo, repos, "each subtask's repository") : undefined;
		return { key: keyOf(s.key), title: text(s.title, MAX_TITLE_CHARS), brief: text(s.brief, MAX_ITEM_BODY_CHARS), acceptance, owns, dependsOn, budget, ...placementFields(s), ...(repo && { repo }) };
	});
	unique(subtasks.map(s => s.key));
	const ancestors = new Map<string, Set<string>>();
	const done = new Set<string>();
	while (done.size < subtasks.length) {
		const next = subtasks.find(s => !done.has(s.key) && s.dependsOn.every(k => done.has(k)));
		requirePlan(next, "Dependencies must name existing subtasks and form an acyclic graph.");
		const deps = new Set(next.dependsOn.flatMap(k => [k, ...ancestors.get(k)!]));
		// Paths are a repository's: the same path in two repositories is two paths.
		for (const other of subtasks) if (done.has(other.key) && !deps.has(other.key) && other.repo === next.repo)
			requirePlan(!next.owns.some(p => other.owns.some(q => overlaps(p, q))), "Independent subtasks must not overlap owned paths.");
		ancestors.set(next.key, deps);
		done.add(next.key);
	}
	const plan: FeaturePlanEdit = { overflow: p.overflow === true, questions, singleSuggested, subtasks, spec: { goal: text(spec.goal, 2000), acceptance: lines(spec.acceptance, 1), requirements: lines(spec.requirements), outOfScope: lines(spec.outOfScope) } };
	// A suggestion of one item names no subtasks: the person sees which repository it would be on before converting.
	if (cross && !(singleSuggested && subtasks.length === 0)) Object.assign(plan, crossRepoFields(p, repos, subtasks));
	return plan;
}
