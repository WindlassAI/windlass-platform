/**
 * An orchestrated work item's plan on its page (`ItemView.plan`): the spec the planner wrote, its
 * subtasks in order with what each depends on, the paths it owns, how it is checked and what it may
 * spend, and the total against what the feature may spend (its approved budget, less what is kept for
 * the summary and review).
 *
 * While the plan waits for approval its questions are answered here and its budgets edited in place:
 * each figure is checked as the server checks it (lib/feature.ts) before anything is sent. Changes
 * are sent with `edit_plan` and the version shown; approval with `approve_plan` and that version, and
 * only once nothing is unsaved and every question has an answer. A version that moved on meanwhile is
 * refused (`item_conflict`): the page reads the item again and says so.
 *
 * A subtask that has started has its own item: its row says its state and where it is on its track,
 * and leads to it.
 *
 * Placement: each subtask says where it runs (the planner's preferred place, why, the alternatives it
 * may overflow to, and what it needs of a place), and the feature whether overflow is allowed. While
 * the plan is open the owner changes the place, the alternatives and overflow as they change budgets:
 * drafts, saved together as the next version. A choice the server would refuse at approval says why
 * before it is saved (lib/placement.ts runs the server's check), and the server's own refusal is
 * shown under the subtask it names. Once a subtask has its item, its row says where it ran and why;
 * the subtask the feature waits to place says which machine it waits for and what for.
 *
 * Agents: each subtask names the agent, model and effort it runs (lib/subtask-agents.ts), the planner's
 * proposal or the owner's change, chosen from what its preferred place has signed in and offers. One
 * that works without asking (Claude Code, OpenCode) is marked so wherever it is shown, and the approval
 * card holds approval back until the owner confirms each such subtask: the planner reads text an issue's
 * author may have written, so its choice of such an agent is never approved by default.
 */
import { MAX_NOTE_CHARS, type FeaturePlan, type HarnessId, type ItemAction, type ItemBudget, type SubtaskBudget, type ItemQuestion, type ItemSummary, type ItemView, type MachineSummary, type ModelList, type PlanSubtask, type SubtaskAgent, type Waiting } from "@contract";
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { singleAfterPlanning } from "../../../server/src/factory/feature-plan.js";
import { ChevronIcon, WarnIcon } from "../components/Icons";
import { ItemSpend } from "../components/ItemSpend";
import { FOLD_WORDS, FoldList, FoldToggle, LongText, PathList } from "../components/Fold";
import { showsSubtasks } from "./Subtasks";
import { Menu, type MenuItem, type MenuSpec } from "../components/ui/Menu";
import { AgentGlyph, Pill } from "../components/ui/Pill";
import { machineLabel } from "../lib/machines";
import { HOSTED, OWNER_REASON, needsWords, routeWords, secretsFor, nextSubtask, orchestratorOf, parentPlaceName, placeChanged, placeDraftOf, placedWords, placementFit, placementProblem, placementWait, placeWord, refusalFor, refusedSubtask, withPlace, type PlaceDraft } from "../lib/placement";
import { plural } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { useModels } from "../state/hooks";
import { effortChoices, effortsOf, modelLabel, type ReportedOptions } from "../lib/models";
import type { AgentModels } from "../../../server/src/factory/placement.js";
import { agentChanged, agentChoices, agentModelsOf, agentParts, cleanAgent, machineModels, preferredMachine, UNATTENDED_MEANS, UNATTENDED_WORDS, withAgent, worksWithoutAsking, type Catalogs } from "../lib/subtask-agents";
import { useMachines } from "./Machines";
import { budgetProblems, featureTotal, PLAN_FIELDS, subtaskFloor, sumBudgets, type PlanField } from "../lib/feature";
import { compact } from "../lib/format";
import { linkProps } from "../lib/router";
import { ItemGlyph, ItemTrack, itemTrack, STATE_WORD } from "./Items";
import { Check } from "../components/ui/Check";

/** The page's actions on the item (Item.tsx, `useActing`), with how the last one failed. */
export interface PlanActing {
	busy: string | null;
	error: string | null;
	/** The kind of the action that failed last, and the server's reason. */
	failed: { kind: string; reason: string | null } | null;
	act(action: ItemAction): Promise<boolean>;
}

const PLAN_QUESTIONS = new Set(["plan_approval", "replan_approval", "single_suggested"]);

/** Whether the plan is the one its item asks about now: its budgets and questions can be changed, and it approved. */
export function planOpen(view: ItemView): boolean {
	return view.mode === "orchestrate" && view.plan?.status === "proposed" && PLAN_QUESTIONS.has(view.question?.kind ?? "");
}

type Drafts = Record<string, Record<keyof SubtaskBudget, string>>;

const placesOf = (plan: FeaturePlan): Record<string, PlaceDraft> => Object.fromEntries(plan.subtasks.map((task) => [task.key, placeDraftOf(task)]));

/** Each subtask's agent as the owner edits it: null runs Windlass on the feature's model. */
const agentsOf = (plan: FeaturePlan): Record<string, SubtaskAgent | null> => Object.fromEntries(plan.subtasks.map((task) => [task.key, cleanAgent(task.agent) ?? null]));

/**
 * The catalogs of every agent the user's machines report, fetched once per digest: the models and
 * efforts a subtask's agent may choose there, as the server checks a child's session against them.
 */
function useCatalogs(machines: MachineSummary[] | null): Catalogs {
	const { client } = useApp();
	const auth = useAuth();
	const [catalogs, setCatalogs] = useState<Record<string, ReportedOptions>>({});
	const wanted = (machines ?? []).flatMap((machine) => (machine.harnesses ?? []).filter((entry) => entry.optionsDigest && entry.id !== "codex").map((entry) => ({ machineId: machine.machineId, id: entry.id as "claude" | "opencode", digest: entry.optionsDigest! })));
	const keys = wanted.map((one) => `${one.machineId}/${one.id}/${one.digest}`).join(" ");
	useEffect(() => {
		let current = true;
		for (const one of wanted) {
			const key = `${one.machineId}/${one.id}/${one.digest}`;
			if (catalogs[key]) continue;
			client.user(auth).machineCatalog(one).then((options) => current && options && setCatalogs((now) => ({ ...now, [key]: options })), () => undefined);
		}
		return () => {
			current = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, auth, keys]);
	const out: Catalogs = {};
	for (const one of wanted) {
		const options = catalogs[`${one.machineId}/${one.id}/${one.digest}`];
		if (options) (out[one.machineId] ??= {})[one.id] = options;
	}
	return out;
}

const draftsOf = (plan: FeaturePlan): Drafts => Object.fromEntries(plan.subtasks.map((task) => [task.key, Object.fromEntries(PLAN_FIELDS.map((field) => [field.key, field.toInput(task.budget[field.key])])) as Record<keyof SubtaskBudget, string>]));

/** The plan's budgets, questions and the actions on them, kept together so that its question card and its section agree. */
export function usePlanReview(view: ItemView | null, acting: PlanActing) {
	const plan = view?.plan ?? null;
	const open = view ? planOpen(view) : false;
	const [drafts, setDrafts] = useState<Drafts>(() => (plan ? draftsOf(plan) : {}));
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [places, setPlaces] = useState<Record<string, PlaceDraft>>(() => (plan ? placesOf(plan) : {}));
	const [overflow, setOverflow] = useState(plan?.overflow ?? false);
	const [agents, setAgents] = useState<Record<string, SubtaskAgent | null>>(() => (plan ? agentsOf(plan) : {}));
	// The subtasks whose agent works without asking that the owner confirmed for this version.
	const [confirmed, setConfirmed] = useState<string[]>([]);
	const version = plan?.version ?? 0;
	// The user's machines: their names for the place menus, and their secrets switch for what the plan would send where.
	const { platform } = useApp();
	const machines = useMachines(platform.info?.machines != null && view?.mode === "orchestrate" && plan !== null && plan.status !== "superseded").list;
	// What each place's agents offer: the account's models for Windlass, each machine agent's catalog.
	const accountModels = useModels().list;
	const catalogs = useCatalogs(open ? machines : null);
	const models: AgentModels = useMemo(() => agentModelsOf(machines, catalogs, accountModels), [machines, catalogs, accountModels]);
	// Another version is another plan: what was typed for the one before is not this one's.
	useEffect(() => {
		if (plan) {
			setDrafts(draftsOf(plan));
			setPlaces(placesOf(plan));
			setOverflow(plan.overflow ?? false);
			setAgents(agentsOf(plan));
		}
		setAnswers({});
		setConfirmed([]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [view?.id, version]);

	const parsed = useMemo(() => {
		const out: Record<string, SubtaskBudget> = {};
		for (const task of plan?.subtasks ?? []) {
			const draft = drafts[task.key];
			out[task.key] = Object.fromEntries(PLAN_FIELDS.map((field) => [field.key, draft ? field.fromInput(draft[field.key]) : task.budget[field.key]])) as unknown as SubtaskBudget;
		}
		return out;
	}, [plan, drafts]);

	// What the feature may spend with these budgets: its own allowance and its subtasks' together.
	const pool = plan && view ? featureTotal(plan, parsed) : null;
	const problems = plan && pool ? budgetProblems(plan.compare.singleBudget, parsed) : { fields: {}, total: [], any: false };
	const budgetsChanged = plan ? plan.subtasks.some((task) => PLAN_FIELDS.some((field) => parsed[task.key]?.[field.key] !== task.budget[field.key])) : false;
	const answered = Object.entries(answers).filter(([, text]) => text.trim() !== "");
	const placesDirty = plan ? plan.subtasks.some((task) => places[task.key] !== undefined && placeChanged(task, places[task.key]!)) || overflow !== (plan.overflow ?? false) : false;
	const agentsDirty = plan ? plan.subtasks.some((task) => task.key in agents && agentChanged(task, agents[task.key])) : false;
	/** Changes to the plan itself (budgets, places, agents): these are saved as a new version before anything is approved. */
	const edits = budgetsChanged || placesDirty || agentsDirty;
	const dirty = edits || answered.length > 0;
	/** Only answers typed: they go with the approval, in one press, as the new version it approves. */
	const answersOnly = !edits && answered.length > 0;
	/** A subtask as it would be saved: its budget, place and agent as edited. */
	const edited = (task: PlanSubtask): PlanSubtask => {
		const place = places[task.key];
		const budgeted = { ...task, budget: parsed[task.key] ?? task.budget };
		const placed = place && placeChanged(task, place) ? withPlace(budgeted, place) : budgeted;
		return task.key in agents && agentChanged(task, agents[task.key]) ? withAgent(placed, agents[task.key]) : placed;
	};
	/** The saved version's subtasks still to run whose agent works without asking, as the server counts them: each needs the owner's confirmation. */
	const unattended = plan && !plan.singleSuggested ? (view?.unattended ?? []) : [];
	const unanswered = plan ? plan.questions.filter((question) => !question.answer).length : 0;

	const save = () => {
		if (!plan) return Promise.resolve(false);
		const questions = plan.questions.map((question) => (answers[question.id]?.trim() ? { ...question, answer: answers[question.id]!.trim() } : question));
		const subtasks: PlanSubtask[] = plan.subtasks.map(edited);
		return acting.act({ kind: "edit_plan", version: plan.version, plan: { questions, spec: plan.spec, subtasks, singleSuggested: plan.singleSuggested, overflow } });
	};
	const approve = () => {
		if (view?.question?.kind === "single_suggested") return acting.act({ kind: "answer", question: view.question.id, choice: "run_single" });
		return plan ? acting.act({ kind: "approve_plan", version: plan.version, ...(unattended.length > 0 && { agents: unattended.filter((key) => confirmed.includes(key)) }) }) : Promise.resolve(false);
	};
	/** Answers only: saved as the next version, which is then approved (one implementer, where the planner suggested that), in one press. */
	const approveWithAnswers = async () => {
		if (!plan) return false;
		const single = view?.question?.kind === "single_suggested";
		const agentsConfirmed = unattended.filter((key) => confirmed.includes(key));
		if (!(await save())) return false;
		if (single) return acting.act({ kind: "run_single" });
		return acting.act({ kind: "approve_plan", version: plan.version + 1, ...(unattended.length > 0 && { agents: agentsConfirmed }) });
	};
	const reset = () => {
		if (plan) {
			setDrafts(draftsOf(plan));
			setPlaces(placesOf(plan));
			setOverflow(plan.overflow ?? false);
			setAgents(agentsOf(plan));
		}
		setAnswers({});
	};

	return {
		plan,
		open,
		drafts,
		setDraft: (key: string, field: keyof SubtaskBudget, text: string) => setDrafts((now) => ({ ...now, [key]: { ...now[key]!, [field]: text } })),
		answers,
		setAnswer: (id: string, text: string) => setAnswers((now) => ({ ...now, [id]: text })),
		machines,
		places,
		setPlace: (key: string, draft: PlaceDraft) => setPlaces((now) => ({ ...now, [key]: draft })),
		overflow,
		setOverflow,
		agents,
		setAgent: (key: string, agent: SubtaskAgent | null) => setAgents((now) => ({ ...now, [key]: agent })),
		models,
		catalogs,
		accountModels,
		unattended,
		confirmed,
		setConfirmed: (key: string, on: boolean) => setConfirmed((now) => (on ? [...new Set([...now, key])] : now.filter((one) => one !== key))),
		/** Subtasks whose agent works without asking that the owner has not confirmed yet. */
		unconfirmed: unattended.filter((key) => !confirmed.includes(key)),
		edited,
		parsed,
		pool,
		problems,
		dirty,
		edits,
		answersOnly,
		/** Questions with no answer saved and none typed. */
		unansweredLeft: plan ? plan.questions.filter((question) => !question.answer && !answers[question.id]?.trim()).length : 0,
		unanswered,
		save,
		approve,
		approveWithAnswers,
		reset,
	};
}

export type PlanReview = ReturnType<typeof usePlanReview>;

/**
 * The subtasks of the saved version that no allowed place can ever take, in the words of the server's
 * check (lib/placement.ts); those already done are not placed again. Empty until the machines are read.
 */
function unplaceableOf(view: ItemView, plan: FeaturePlan, machines: MachineSummary[] | null, models?: AgentModels): { task: PlanSubtask; reason: string }[] {
	if (!machines) return [];
	const done = new Set(view.completedSubtasks ?? []);
	return plan.subtasks.flatMap((task) => {
		const reason = done.has(task.key) ? null : placementProblem(task, view.place, plan.overflow === true, machines, models);
		return reason ? [{ task, reason }] : [];
	});
}

/** What the server's refusal of an approval says to do instead: the feature as one item. */
const SINGLE_INSTEAD = /single item/i;

/**
 * The card of the open plan question: what it asks, the plan's own questions, and the actions. It
 * stands where an item's question does; the plan itself is in its section below.
 */
export function PlanQuestion({ view, review, acting, when, conflicted }: { view: ItemView; review: PlanReview; acting: PlanActing; when: ReactNode; conflicted: boolean }) {
	const { plan } = review;
	const ids = { title: useId() };
	if (!plan || !view.question) return null;
	const busy = acting.busy !== null;
	const single = view.question.kind === "single_suggested";
	const replan = view.question.kind === "replan_approval";
	const tasks = plan.subtasks.length;
	const totalTokens = sumBudgets(Object.values(review.parsed)).tokens;
	const refused = acting.failed?.kind === "approve_plan" && acting.failed.reason === "bad_input" ? acting.error : null;
	const unplaceable = single ? [] : unplaceableOf(view, plan, review.machines, review.models);
	const unconfirmed = single ? 0 : review.unconfirmed.length;
	// Answers alone go with the approval; changes to budgets, places or agents are saved as a version first.
	const blocked = review.problems.any ? "Fix the figures marked below first." : review.edits ? "Save your changes, then approve this version." : review.unansweredLeft > 0 ? `Answer ${review.unansweredLeft === 1 ? "the question" : `the ${review.unansweredLeft} questions`} first.` : unconfirmed > 0 ? `Confirm ${unconfirmed === 1 ? "the agent that works" : `the ${unconfirmed} agents that work`} without asking first.` : null;
	// The owner's choice: a place no allowed machine can ever take holds approval back, with the server's words. A busy or offline one does not.
	const placeBlocked = blocked === null && unplaceable.length > 0 ? unplaceable[0]! : null;
	const revise = view.question.choices.find((choice) => choice.id === "revise");
	const giveUp = view.question.choices.find((choice) => choice.id === "give_up");
	return (
		<section className="item-question plan-question" aria-labelledby={ids.title}>
			<p className="item-question-head" id={ids.title}>
				It asks you
				<span className="item-question-when">{when}</span>
			</p>
			<p className="item-question-text">
				{single ? view.question.text : <>{replan ? "A subtask stopped. Review the revised plan" : "Review the plan"}: {tasks} subtasks, {PLAN_FIELDS[0]!.spelled(totalTokens)} tokens of the {PLAN_FIELDS[0]!.spelled(plan.budget.tokens)} the feature may spend.</>}
				{" "}<span className="plan-version">Version {plan.version}</span>
			</p>

			{plan.subtasks.length > 0 ? <PlanRoutes view={view} plan={plan} machines={review.machines} models={review.models} catalogs={review.catalogs} accountModels={review.accountModels} refusal={refused} /> : null}

			{!single && review.unattended.length > 0 ? <UnattendedConfirm plan={plan} review={review} disabled={busy || review.edits} /> : null}

			{plan.questions.length > 0 ? (
				<div className="plan-asks">
					{plan.questions.map((question) => (
						<PlanAsk key={question.id} question={question} value={review.answers[question.id] ?? ""} disabled={busy} onChange={(text) => review.setAnswer(question.id, text)} />
					))}
				</div>
			) : null}

			{conflicted ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>The plan changed while you read it, here or in another tab: version {plan.version} is shown now. Check it, then approve again.</span>
				</p>
			) : null}
			{refused ? (
				<div className="callout callout-bad plan-refused" role="alert">
					<WarnIcon />
					<span>
						{refused}
						{SINGLE_INSTEAD.test(refused) && !replan ? " A single item needs neither." : null}
					</span>
				</div>
			) : acting.error && !conflicted ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{acting.error}</span>
				</p>
			) : null}

			<div className="item-choices">
				{review.edits ? (
					<>
						<button type="button" className="button button-primary" disabled={busy || review.problems.any} onClick={() => void review.save()}>
							{acting.busy === "edit_plan" ? "Saving…" : `Save as version ${plan.version + 1}`}
						</button>
						<button type="button" className="button button-quiet" disabled={busy} onClick={review.reset}>
							Discard changes
						</button>
					</>
				) : (
					<button type="button" className="button button-primary" disabled={busy || blocked !== null || placeBlocked !== null} onClick={() => void (review.answersOnly ? review.approveWithAnswers() : review.approve())} aria-describedby={blocked || placeBlocked ? `${ids.title}-why` : undefined}>
						{acting.busy === "edit_plan" || acting.busy === "approve_plan" || acting.busy === "run_single" ? "Approving…" : single ? "Approve for one implementer" : review.answersOnly ? "Approve" : `Approve version ${plan.version}`}
					</button>
				)}
				{single && !review.edits && view.question.choices.some(option => option.id === "orchestrate_anyway") && (
					<button type="button" className="button button-outline" disabled={busy} onClick={() => void acting.act({ kind: "answer", question: view.question!.id, choice: "orchestrate_anyway" })}>
						Ask for subtasks
					</button>
				)}
				{refused && SINGLE_INSTEAD.test(refused) && !replan ? (
					<button type="button" className="button button-outline" disabled={busy || blocked !== null} onClick={() => void acting.act({ kind: "run_single" })}>
						{acting.busy === "run_single" ? "Starting…" : "Run as a single item"}
					</button>
				) : null}
				{revise && !review.edits ? (
					<button type="button" className="button button-outline" disabled={busy} onClick={() => void acting.act({ kind: "answer", question: view.question!.id, choice: "revise" })}>
						{acting.busy === "revise" ? "Sending…" : "Ask for a new plan"}
					</button>
				) : null}
				{giveUp && !review.edits ? (
					<button type="button" className="button button-quiet" disabled={busy} onClick={() => void acting.act({ kind: "answer", question: view.question!.id, choice: "give_up" })}>
						{acting.busy === "give_up" ? "Sending…" : giveUp.label}
					</button>
				) : null}
			</div>
			{blocked && !review.edits ? (
				<p className="field-note" id={`${ids.title}-why`}>
					{blocked}
				</p>
			) : placeBlocked && !review.edits ? (
				<p className="field-note plan-blocked-place" id={`${ids.title}-why`}>
					<span className="plan-blocked-dot" aria-hidden="true" />
					<span>
						<strong>{placeBlocked.task.title}</strong>{unplaceable.length > 1 ? ` and ${unplaceable.length - 1} more` : ""} can't be placed: {placeBlocked.reason} Choose another place below and save, or ask for a new plan.
					</span>
				</p>
			) : null}
			{/* Said only of a plan that sizes a subtask: a runner that reports no slots cannot give it more than one. */}
			{!single && plan.subtasks.some((task) => task.needs?.cpus !== undefined || task.needs?.memoryGiB !== undefined) ? <p className="field-note">Sizing beyond one slot is not supported by current runners.</p> : null}
		</section>
	);
}

/** One of the plan's own questions: its options as a choice, or a line to write. */
/**
 * A plan question as the owner reads it: the question in one short bold line; the background folded under
 * "Why it asks"; the options as rows of radio buttons. An older plan has no `why`, and may have put the
 * background in its text: a long text is split there, its question sentence shown and the rest folded.
 */
export function questionParts(question: Pick<FeaturePlan["questions"][number], "text" | "why">): { ask: string; why: string | null } {
	if (question.why) return { ask: question.text, why: question.why };
	if (question.text.length <= ASK_SHORT) return { ask: question.text, why: null };
	const sentences = question.text.match(/[^.?!]+(?:[.?!]+["”’)]?|$)\s*/g)?.filter((one) => one.trim() !== "") ?? [question.text];
	const asking = [...sentences].reverse().find((one) => one.trim().endsWith("?")) ?? sentences[0]!;
	const rest = sentences.filter((one) => one !== asking).join("").trim();
	return { ask: asking.trim(), why: rest || null };
}

/** How long a question may be and still be the whole bold line. */
const ASK_SHORT = 160;

function PlanAsk({ question, value, disabled, onChange }: { question: FeaturePlan["questions"][number]; value: string; disabled: boolean; onChange(text: string): void }) {
	const id = useId();
	const { ask, why } = questionParts(question);
	const background = why ? (
		<details className="plan-ask-why">
			<summary>
				<ChevronIcon size={11} className="plan-task-more-chevron" />
				Why it asks
			</summary>
			<p>{why}</p>
		</details>
	) : null;
	if (question.answer) {
		return (
			<div className="plan-ask plan-ask-answered">
				<p className="plan-ask-text">{ask}</p>
				<p className="plan-ask-answer">{question.answer}</p>
				{background}
			</div>
		);
	}
	return (
		<div className="plan-ask">
			<p className="plan-ask-text" id={id}>
				{ask}
			</p>
			{background}
			{question.options?.length ? (
				<div className="plan-ask-options" role="radiogroup" aria-labelledby={id}>
					{question.options.map((option) => (
						<label key={option} className={`plan-ask-option${value === option ? " plan-ask-chosen" : ""}`}>
							<input className="check-input" type="radio" name={id} value={option} checked={value === option} disabled={disabled} onChange={() => onChange(option)} />
							<span className="plan-ask-dot" aria-hidden="true" />
							<span className="plan-ask-label">{option}</span>
						</label>
					))}
				</div>
			) : (
				<input className="input" aria-labelledby={id} value={value} readOnly={disabled} onChange={(event) => onChange(event.target.value)} />
			)}
		</div>
	);
}

const STATUS_WORD: Record<FeaturePlan["status"], string> = { proposed: "proposed", approved: "approved", superseded: "superseded" };

/** How long a part of the spec may be before the rest of it waits behind "Show more". */
const SPEC_SHOWN = 3;

/**
 * The plan's section: what it is for, then the spec as one column of short lists, the subtasks, and
 * what they may spend together. A plan that was set aside (superseded: the item runs as one item, or
 * the re-plans ran out) is one line, its version, its state and the start of its goal, that opens to
 * the whole plan.
 */
export function PlanSection({ view, review, acting }: { view: ItemView; review: PlanReview; acting: PlanActing }) {
	const { plan, pool } = review;
	const heading = useId();
	const [opened, setOpened] = useState(false);
	if (!plan || !pool) return null;
	const singleSpend = view.mode === "single" || plan.subtasks.length === 0 ? (
		<>
			<p className="plan-single">Runs as one item after this plan</p>
			<ItemSpend spent={view.spent} budget={view.mode === "single" ? view.budget : singleAfterPlanning(plan.compare.singleBudget, view.spent)} fields={PLAN_FIELDS} />
		</>
	) : null;
	if (plan.status === "superseded") {
		return (
			<section className={`usage-section feature-plan plan-set-aside${opened ? " plan-set-aside-open" : ""}`} aria-labelledby={heading}>
				<h2 className="usage-title plan-set-aside-title" id={heading}>
					<button type="button" className="plan-set-aside-row" aria-expanded={opened} onClick={() => setOpened((value) => !value)}>
						<ChevronIcon size={12} className={`plan-set-aside-chevron${opened ? " plan-set-aside-chevron-open" : ""}`} />
						<span className="plan-set-aside-name">The plan</span>
						<span className="usage-count">
							v{plan.version} · {STATUS_WORD[plan.status]}
						</span>
						<span className="plan-set-aside-goal">{plan.spec.goal.replace(/`/g, "")}</span>
					</button>
				</h2>
				{opened ? (
					<div className="plan-set-aside-body">
						<p className="plan-set-aside-note">{view.mode === "single" ? "Set aside: the work runs as one item, under its own budget." : "Set aside: no subtask of it runs any more."}</p>
						<PlanBody view={view} review={review} acting={acting} pool={pool} />
					</div>
				) : null}
				{singleSpend}
			</section>
		);
	}
	// Once approved and running, the subtasks block above says where each subtask is: the plan folds to its goal and what it holds.
	const folds = showsSubtasks(view) && !review.open;
	const body = `${heading}-body`;
	return (
		<section className="usage-section feature-plan" aria-labelledby={heading}>
			<h2 className="usage-title" id={heading}>
				The plan
				<span className="usage-count">
					v{plan.version} · {STATUS_WORD[plan.status]}
				</span>
			</h2>
			{folds && !opened ? (
				<>
					{/* Clamped with no control of its own: the line under it opens the whole plan, the goal with it. */}
					<div className="long-text">
						<p className="long-text-body plan-goal" data-clamped="true" style={{ "--lines": 3 } as CSSProperties}>
							<Inline text={plan.spec.goal} />
						</p>
					</div>
					<p className="plan-folded">
						<FoldToggle open={false} controls={body} label={FOLD_WORDS.all} onToggle={() => setOpened(true)} />
						<span className="tone-dim">{[...specParts(plan), plural(plan.subtasks.length, "subtask brief")].join(" · ")}</span>
					</p>
				</>
			) : (
				<div id={body}>
					<PlanBody view={view} review={review} acting={acting} pool={pool} />
					{folds ? (
						<p className="plan-folded">
							<FoldToggle open controls={body} label={FOLD_WORDS.all} onToggle={() => setOpened(false)} />
						</p>
					) : null}
				</div>
			)}
			{singleSpend}
		</section>
	);
}

function PlanBody({ view, review, acting, pool }: { view: ItemView; review: PlanReview; acting: PlanActing; pool: SubtaskBudget }) {
	const plan = review.plan!;
	const fields = PLAN_FIELDS;
	const editing = review.open;
	const children = new Map((view.children ?? []).filter((child) => child.parent).map((child) => [child.parent!.key, child]));
	const single = plan.compare.singleBudget;
	const floor = subtaskFloor(single);
	const total = sumBudgets(Object.values(review.parsed));
	const spent = view.children?.length ? { ...sumBudgets(view.children.map(child => child.spent)), raw: view.children.reduce((sum, child) => sum + (child.spent.rawTokens ?? child.spent.tokens), 0) } : null;
	const numbers = new Map(plan.subtasks.map((task, index) => [task.key, index + 1]));
	const setAside = plan.status === "superseded";
	const machines = review.machines;
	const placing = plan.subtasks.some((task) => task.place || task.needs) || plan.overflow === true || (view.children ?? []).some((child) => child.placement);
	const refusal = acting.failed?.kind === "approve_plan" && acting.failed.reason === "bad_input" ? acting.error : null;
	// The subtask the feature waits to place: a machine wait is about the next one to start.
	const waitingKey = plan.status === "approved" && view.wait?.reason === "machine" ? (nextSubtask(plan, view.children ?? [])?.key ?? null) : null;
	const place = (task: PlanSubtask): PlaceRow => ({
		machines,
		parent: parentPlaceName(view.place, machines),
		overflow: editing ? review.overflow : plan.overflow === true,
		draft: review.places[task.key] ?? placeDraftOf(task),
		// The server's refusal is about the place it was sent; a place changed since is checked here again.
		problem: plan.status !== "proposed" ? null : ((review.places[task.key] && placeChanged(task, review.places[task.key]!)) || (task.key in review.agents && agentChanged(task, review.agents[task.key])) ? null : refusalFor(task, refusal)) ?? (machines ? placementProblem(review.edited(task), view.place, editing ? review.overflow : plan.overflow === true, machines, review.models) : null),
		wait: task.key === waitingKey ? view.wait : null,
		ahead: plan.status !== "proposed" || !machines ? null : placementWait(review.edited(task), view.place, editing ? review.overflow : plan.overflow === true, machines, review.models),
		secrets: (name) => secretsFor(name, view.placementReview, machines),
		onPlace: (draft) => review.setPlace(task.key, draft),
	});
	const agentRow = (task: PlanSubtask): AgentRow => {
		const draft = editing && task.key in review.agents ? review.agents[task.key] ?? undefined : task.agent;
		const machine = preferredMachine(editing ? review.edited(task) : task, parentPlaceName(view.place, machines), machines);
		const harness = draft?.harness ?? "windlass";
		return {
			draft,
			changed: editing && agentChanged(task, review.agents[task.key]),
			machine,
			list: harness === "windlass" ? review.accountModels : machineModels(machine, harness, review.catalogs),
			onAgent: (agent) => review.setAgent(task.key, agent),
		};
	};
	return (
		<>
			<LongText lines={3} className="plan-goal">
				<Inline text={plan.spec.goal} />
			</LongText>

			{/* The goal stands; the rest of the spec is folded under one line that counts it. */}
			{specParts(plan).length > 0 ? (
				<details className="plan-spec-fold">
					<summary>
						<ChevronIcon size={11} className="plan-spec-fold-chevron" />
						{specParts(plan).join(" · ")}
					</summary>
					<dl className="plan-spec">
						{plan.spec.requirements.length > 0 ? <SpecList term="Requirements" kind="requirements" lines={plan.spec.requirements} /> : null}
						{plan.spec.acceptance.length > 0 ? <SpecList term="Done when" kind="acceptance" lines={plan.spec.acceptance} /> : null}
						{plan.spec.outOfScope.length > 0 ? <SpecList term="Not in it" kind="out" lines={plan.spec.outOfScope} /> : null}
					</dl>
				</details>
			) : null}

			{view.mode !== "single" && plan.subtasks.length > 0 ? (
				<div className="usage-card plan-card">
					<p className="plan-card-head">
						Subtasks <span className="plan-card-count">{plan.subtasks.length}</span>
					</p>
					{placing || editing ? <FeaturePlacement parent={parentPlaceName(view.place, machines)} editing={editing} overflow={editing ? review.overflow : plan.overflow === true} disabled={acting.busy !== null} onOverflow={review.setOverflow} /> : null}
					<ol className="plan-tasks" aria-label="Subtasks">
						{plan.subtasks.map((task) => (
							<SubtaskRow key={task.key} task={task} place={placing || editing ? place(task) : null} agent={agentRow(task)} n={numbers.get(task.key)!} numbers={numbers} child={children.get(task.key) ?? null} setAside={setAside} fields={fields} editing={editing} drafts={review.drafts[task.key]} problems={review.problems.fields[task.key] ?? {}} floor={floor} single={single} disabled={acting.busy !== null} onChange={(field, text) => review.setDraft(task.key, field, text)} />
						))}
					</ol>

					<div className="plan-total" aria-label="Allotted to subtasks">
						<p className="plan-total-head">Allotted to subtasks</p>
						<dl className="plan-total-figures">
							{fields.map((field) => {
								const share = Math.min(100, (total[field.key] / Math.max(1, pool[field.key])) * 100);
								return (
									<div key={field.key}>
										<dt>{field.label}</dt>
										<dd className="plan-total-number">
											{field.spelled(total[field.key])} <span className="tone-faint">of {field.spelled(pool[field.key])}</span>
										</dd>
										<dd>
											<span className="usage-meter plan-meter" aria-hidden="true">
												<span className="usage-meter-used" style={{ width: `${share}%` }} />
											</span>
										</dd>
										{spent && <dd className="tone-dim">Spent by subtasks: {field.spelled(spent[field.key])} <span className="tone-faint">({compact(spent.raw)} as reported)</span></dd>}
									</div>
								);
							})}
						</dl>
						<p className="usage-note plan-total-note">
							The feature may spend {PLAN_FIELDS[0]!.spelled(pool.tokens)} in all: its subtasks' budgets, and the rest for planning, the summary and the review. One token figure per subtask, cost-weighted: cached input counts at a tenth. A subtask gets at most {PLAN_FIELDS[0]!.spelled(single.tokens)}. One that uses its budget asks you for more, and what you give it adds to the feature's.
						</p>
					</div>
				</div>
			) : null}
		</>
	);
}

/** The spec's parts in a few words, for the line it is folded under: "5 requirements · 3 done when · 2 not in it". */
function specParts(plan: FeaturePlan): string[] {
	const { requirements, acceptance, outOfScope } = plan.spec;
	return [requirements.length > 0 ? plural(requirements.length, "requirement") : null, acceptance.length > 0 ? `${acceptance.length} done when` : null, outOfScope.length > 0 ? `${outOfScope.length} not in it` : null].filter((part): part is string => part !== null);
}

/** One part of the spec: its name in the margin, its lines as a list, the first few shown and the rest behind "Show N more". */
function SpecList({ term, kind, lines }: { term: string; kind: "requirements" | "acceptance" | "out"; lines: string[] }) {
	return (
		<div className={`plan-spec-part plan-spec-${kind}`}>
			<dt>
				{term}
				<span className="plan-spec-count">{lines.length}</span>
			</dt>
			<dd>
				<FoldList items={lines} shown={SPEC_SHOWN} render={(line) => <Inline text={line} />} />
			</dd>
		</div>
	);
}

/** Text with `code` in the mono face, as the planner writes commands. Nothing else in it is read as markup. */
export function Inline({ text }: { text: string }) {
	const parts = text.split(/(`[^`]+`)/);
	return (
		<>
			{parts.map((part, index) =>
				part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
					<code key={index} className="plan-code">
						{part.slice(1, -1)}
					</code>
				) : (
					part
				),
			)}
		</>
	);
}

function SubtaskRow({ task, place, agent, n, numbers, child, setAside, fields, editing, drafts, problems, floor, single, disabled, onChange }: { task: PlanSubtask; place: PlaceRow | null; agent: AgentRow; n: number; numbers: Map<string, number>; child: ItemSummary | null; setAside: boolean; fields: PlanField[]; editing: boolean; drafts: Record<keyof SubtaskBudget, string> | undefined; problems: Partial<Record<keyof SubtaskBudget, string>>; floor: SubtaskBudget; single: Pick<ItemBudget, "tokens">; disabled: boolean; onChange(field: keyof SubtaskBudget, text: string): void }) {
	const base = useId();
	return (
		<li className={`plan-task${child ? ` plan-task-is-${child.state}` : ""}`}>
			<span className="plan-task-n" aria-hidden="true">
				{child ? <ItemGlyph item={child} /> : n}
			</span>
			<div className="plan-task-main">
				<div className="plan-task-head">
					{child ? (
						<a className="plan-task-title" {...linkProps({ name: "item", id: child.id })}>
							{task.title}
						</a>
					) : (
						<span className="plan-task-title">{task.title}</span>
					)}
					<span className="plan-task-key">{task.key}</span>
					{task.dependsOn.length > 0 ? (
						<span className="plan-task-after" title={`After ${task.dependsOn.join(", ")}`}>
							after {task.dependsOn.map((key) => numbers.get(key) ?? key).join(", ")}
						</span>
					) : null}
					{task.owns.length > 0 ? <span className="plan-task-files">{plural(task.owns.length, "file")}</span> : null}
				</div>
				{/* Two lines of the brief; the whole of it, its files, checks and the place's reason under Details. */}
				<p className="plan-task-brief plan-task-brief-short">{task.brief}</p>
				<dl className="plan-task-facts">
					{place ? <SubtaskPlace task={task} child={child} row={place} editing={editing} disabled={disabled} /> : null}
					<SubtaskAgentFact title={task.title} child={child} row={agent} editing={editing && !child} disabled={disabled} />
				</dl>
				<details className="plan-task-more">
					<summary>
						<ChevronIcon size={11} className="plan-task-more-chevron" />
						Details
					</summary>
					<LongText lines={6} className="plan-task-brief">
						{task.brief}
					</LongText>
					<dl className="plan-task-more-facts">
						{placeReason(task, child, place) ? (
							<div>
								<dt>why there</dt>
								<dd className="plan-place-why">{placeReason(task, child, place)}</dd>
							</div>
						) : null}
						{task.owns.length > 0 ? (
							<div>
								<dt>owns</dt>
								<dd>
									<PathList paths={task.owns} />
								</dd>
							</div>
						) : null}
						<div>
							<dt>checked by</dt>
							<dd>
								<FoldList className="plan-checks" items={task.acceptance} render={(line) => <Inline text={line} />} />
							</dd>
						</div>
					</dl>
				</details>
				{editing && drafts ? (
					<div className="plan-budget" role="group" aria-label={`Budget of ${task.title}`}>
						{fields.map((field) => {
							const problem = problems[field.key];
							const id = `${base}-${field.key}`;
							return (
								<div key={field.key} className="plan-budget-field">
									<label className="plan-budget-label" htmlFor={id}>
										{field.short}
									</label>
									<span className={`plan-budget-input${problem ? " plan-budget-invalid" : ""}`}>
										<input id={id} className="input input-mono" inputMode="decimal" value={drafts[field.key]} readOnly={disabled} aria-invalid={problem ? true : undefined} aria-describedby={`${id}-range`} onChange={(event) => onChange(field.key, event.target.value)} />
										{field.unit ? <span className="plan-budget-unit">{field.unit}</span> : null}
									</span>
									<span className={`plan-budget-range${problem ? " tone-bad" : ""}`} id={`${id}-range`}>
										{field.spelled(floor[field.key])}–{field.spelled(single[field.key])}
									</span>
								</div>
							);
						})}
					</div>
				) : (
					<p className="plan-budget-read">
						{fields.map((field) => (
							<span key={field.key}>
								{child ? (
									<>
										{field.spelled(child.spent[field.key])} <span className="tone-faint">of</span>{" "}
									</>
								) : null}
								{field.spelled(task.budget[field.key])} <span className="tone-faint">{field.short}</span>
							</span>
						))}
					</p>
				)}
			</div>
			<div className="plan-task-state">
				{child ? (
					child.question ? (
						<span className="plan-task-word plan-task-asks">asks you</span>
					) : itemTrack(child, false) ? (
						<ItemTrack item={child} reviewer={false} />
					) : (
						<span className="plan-task-word">{STATE_WORD[child.state].toLowerCase()}</span>
					)
				) : (
					<span className={`plan-task-word${place?.wait ? "" : " tone-faint"}`}>{editing ? "planned" : setAside ? "not run" : place?.wait ? "waits for a machine" : "not started"}</span>
				)}
			</div>
		</li>
	);
}

/** Why the subtask runs where it does, as its Details say: where it ran, or the place the planner or the owner chose. */
function placeReason(task: PlanSubtask, child: ItemSummary | null, row: PlaceRow | null): string | null {
	if (child?.placement) return child.placement.reason || null;
	if (!row) return null;
	const prefer = row.draft.prefer;
	if (prefer !== (task.place?.prefer ?? null)) return prefer === null ? null : OWNER_REASON;
	return task.place?.reason ?? null;
}

/** What a subtask's row needs to say where it runs. */
interface PlaceRow {
	/** The user's machines; null until read, or where the deployment has none. */
	machines: MachineSummary[] | null;
	/** The name of the feature's place, which a subtask without one inherits. */
	parent: string;
	overflow: boolean;
	draft: PlaceDraft;
	/** Why the server would refuse its place, or did; only while the plan is proposed. */
	problem: string | null;
	/** The feature's wait, when it waits to place this subtask. */
	wait: Waiting | null;
	/** What it would wait for if the plan were approved now: a busy or offline place. Only while the plan is proposed. */
	ahead: string | null;
	/** Whether repository secrets go to a place, by its name; null when not known. */
	secrets(name: string): boolean | null;
	onPlace(draft: PlaceDraft): void;
}

/**
 * The feature's placement line, over its subtasks: where a subtask without a place runs, whether a
 * subtask may overflow to its alternatives, and which named places get no repository secrets.
 */
function FeaturePlacement({ parent, editing, overflow, disabled, onOverflow }: { parent: string; editing: boolean; overflow: boolean; disabled: boolean; onOverflow(on: boolean): void }) {
	const id = useId();
	return (
		<div className="plan-placement" aria-label="Placement">
			<p className="plan-placement-line">
				<span className="plan-placement-term">placement</span>
				<span>
					A subtask with no place runs where the feature does: <strong className="plan-place-name">{placeWord(parent)}</strong>.
				</span>
			</p>
			<div className="plan-placement-line">
				<span className="plan-placement-term" id={id}>
					overflow
				</span>
				{editing ? (
					<div className="segmented plan-overflow" role="radiogroup" aria-labelledby={id}>
						{[false, true].map((on) => (
							<label key={String(on)} className={`segment${overflow === on ? " segment-chosen" : ""}`}>
								<input className="segment-radio" type="radio" name={id} checked={overflow === on} disabled={disabled} onChange={() => onOverflow(on)} />
								{on ? "Allowed" : "Off"}
							</label>
						))}
					</div>
				) : (
					<strong className="plan-overflow-word">{overflow ? "allowed" : "off"}</strong>
				)}
				<span className="tone-dim">{overflow ? "A subtask whose machine is busy may run on one of the alternatives it lists." : "Each subtask waits for its preferred place."}</span>
			</div>
		</div>
	);
}

/** The menu of places a subtask may prefer: the feature's own, the user's machines, and this platform. */
function placeMenu(row: PlaceRow, current: string | null): MenuSpec {
	const machineItems: MenuItem[] = (row.machines ?? []).map((machine) => {
		const name = machineLabel(machine);
		const policy = orchestratorOf(machine);
		return {
			id: `m:${machine.machineId}`,
			label: name,
			textValue: name,
			description: policy === "never" ? "Its owner keeps it out of features." : [machine.status, ...(machine.slots ? [`${machine.slots.busy} of ${machine.slots.max} slots busy`] : []), ...(policy === "named" ? ["when named"] : []), machine.sendSecrets ? "secrets sent" : "no secrets"].join(" · "),
			disabled: policy === "never",
			wrap: true,
			checked: current === name,
			onSelect: () => row.onPlace({ prefer: name, allow: row.draft.allow.filter((other) => other !== name) }),
		};
	});
	return {
		label: "Runs on",
		width: 320,
		groups: [
			{ id: "feature", items: [{ id: "inherit", label: "Same as the feature", description: placeWord(row.parent), checked: current === null, onSelect: () => row.onPlace({ prefer: null, allow: [] }) }] },
			...(machineItems.length > 0 ? [{ id: "machines", label: "Your machines", items: machineItems }] : []),
			{ id: "hosted", items: [{ id: "hosted", label: "This platform", description: "A hosted sandbox · secrets sent", checked: current === HOSTED, onSelect: () => row.onPlace({ prefer: HOSTED, allow: row.draft.allow.filter((other) => other !== HOSTED) }) }] },
		],
	};
}

/** The menu of alternatives: every other place, each checked or not; it stays open while they are chosen. */
function allowMenu(row: PlaceRow): MenuSpec {
	const toggle = (name: string) => row.onPlace({ ...row.draft, allow: row.draft.allow.includes(name) ? row.draft.allow.filter((other) => other !== name) : [...row.draft.allow, name] });
	const names = [...(row.machines ?? []).map((machine) => ({ name: machineLabel(machine), never: orchestratorOf(machine) === "never", secrets: machine.sendSecrets })), { name: HOSTED, never: false, secrets: true }].filter((place) => place.name !== row.draft.prefer);
	return {
		label: "Alternatives",
		width: 300,
		header: row.overflow ? undefined : <span className="tone-dim">Overflow is off for this feature: alternatives are used once it is allowed.</span>,
		groups: [
			{
				id: "allow",
				items: names.map((place) => ({
					id: place.name,
					label: place.name === HOSTED ? "This platform" : place.name,
					description: place.never ? "Its owner keeps it out of features." : place.secrets ? "secrets sent" : "no secrets",
					disabled: place.never,
					checked: row.draft.allow.includes(place.name),
					keepOpen: true,
					onSelect: () => toggle(place.name),
				})),
			},
		],
	};
}

/** Where a subtask runs: planned, chosen while the plan is open, or where its item was placed; what it needs; and why it cannot be placed or waits. */
function SubtaskPlace({ task, child, row, editing, disabled }: { task: PlanSubtask; child: ItemSummary | null; row: PlaceRow; editing: boolean; disabled: boolean }) {
	const needs = needsWords(task.needs);
	const prefer = editing ? row.draft.prefer : (task.place?.prefer ?? null);
	const allow = (editing ? row.draft.allow : (task.place?.allow ?? [])).filter((name) => name !== prefer);
	const preferMoved = editing && prefer !== (task.place?.prefer ?? null);
	const allowMoved = editing && JSON.stringify(allow) !== JSON.stringify((task.place?.allow ?? []).filter((name) => name !== prefer));
	const childWait = child?.wait?.reason === "machine" ? child.wait : null;
	const ended = child && ["done", "failed", "cancelled"].includes(child.state);
	return (
		<>
			{child?.placement ? (
				<div className="plan-place">
					<dt>{ended ? "ran on" : "runs on"}</dt>
					<dd>
						<strong className="plan-place-name">{placedWords(child.placement)}</strong>
						<SecretsTag sent={child.placement.sendSecrets} done={ended === true} />
					</dd>
				</div>
			) : (
				<div className="plan-place">
					<dt>runs on</dt>
					<dd>
						{editing ? (
							<span className="plan-place-picks">
								<Menu spec={placeMenu(row, prefer)} trigger={(props) => <Pill {...props} outlined disabled={disabled} dot={preferMoved ? "changed" : null} dotLabel={preferMoved ? "changed, not saved" : undefined} className="plan-place-pick" aria-label={`Runs on: ${prefer === null ? `same as the feature, ${placeWord(row.parent)}` : placeWord(prefer)}`} secondary={prefer === null ? placeWord(row.parent) : undefined}>{prefer === null ? "Same as the feature" : placeWord(prefer)}</Pill>} />
								{prefer !== null ? (
									<Menu spec={allowMenu(row)} trigger={(props) => <Pill {...props} disabled={disabled} dot={allowMoved ? "changed" : null} dotLabel={allowMoved ? "changed, not saved" : undefined} className="plan-place-pick plan-place-allow" aria-label={`Alternatives: ${allow.length ? allow.map(placeWord).join(", ") : "none"}`}>{allow.length ? `or ${allow.map(placeWord).join(", ")}` : "No alternatives"}</Pill>} />
								) : null}
								<SecretsTag sent={row.secrets(prefer ?? row.parent)} />
							</span>
						) : (
							<>
								<strong className="plan-place-name">{prefer === null ? placeWord(row.parent) : placeWord(prefer)}</strong>
								{prefer === null ? <span className="tone-faint"> as the feature</span> : null}
								<SecretsTag sent={row.secrets(prefer ?? row.parent)} />
								{allow.length > 0 ? (
									<span className={row.overflow ? "plan-place-alt" : "plan-place-alt tone-faint"}>
										{" "}
										or {allow.map(placeWord).join(", ")}
										{row.overflow ? null : " · overflow off"}
									</span>
								) : null}
							</>
						)}
					</dd>
				</div>
			)}
			{needs.length > 0 ? (
				<div>
					<dt>needs</dt>
					<dd className="plan-paths">
						{needs.map((word) => (
							<span key={word} className="plan-path plan-need">
								{word}
							</span>
						))}
					</dd>
				</div>
			) : null}
			{row.wait || childWait ? (
				<div className="plan-place-wait">
					<dt>waits</dt>
					<dd role="status">
						<span className="plan-place-dot" aria-hidden="true" />
						{(row.wait ?? childWait)!.sentence}
					</dd>
				</div>
			) : null}
			{row.ahead && !row.problem && !child ? (
				<div className="plan-place-wait plan-place-ahead">
					<dt>if approved</dt>
					<dd>
						<span className="plan-place-dot" aria-hidden="true" />
						{row.ahead}
					</dd>
				</div>
			) : null}
			{row.problem && !child ? (
				<div className="plan-place-problem">
					<dt>can't place</dt>
					<dd role="alert">{row.problem}</dd>
				</div>
			) : null}
		</>
	);
}

/** What a subtask's row needs to say which agent it runs, and to change it while the plan is open. */
interface AgentRow {
	/** The agent as saved, or as edited while the plan is open; undefined runs Windlass on the feature's model. */
	draft: SubtaskAgent | undefined;
	changed: boolean;
	/** The machine the subtask prefers, whose agents it may choose; null for this platform. */
	machine: MachineSummary | null;
	/** The models its agent offers there; null where none were read. */
	list: ModelList | null;
	onAgent(agent: SubtaskAgent | null): void;
}

/** "works without asking": the words, with a small warm dot, wherever an agent that never asks is named. */
function UnattendedTag() {
	return (
		<>
			{" "}
			<span className="plan-unattended" title={UNATTENDED_MEANS}>
				{UNATTENDED_WORDS}
			</span>
		</>
	);
}

/** The agents the subtask's place offers: Windlass, and each machine agent signed in there; one not signed in is shown, not chosen. */
function agentMenu(row: AgentRow, title: string): MenuSpec {
	const current = row.draft?.harness ?? "windlass";
	return {
		label: `Agent for ${title}`,
		width: 300,
		groups: [
			{
				id: "agents",
				items: agentChoices(row.machine).map((choice) => ({
					id: choice.id,
					label: choice.name,
					description: choice.problem ?? (worksWithoutAsking(choice.id) ? `In its hardened container; ${UNATTENDED_WORDS}.` : choice.id === "windlass" ? "On the feature's model unless you choose one." : undefined),
					disabled: choice.problem !== null,
					wrap: true,
					checked: current === choice.id,
					onSelect: () => row.onAgent(choice.id === "windlass" ? null : { harness: choice.id }),
				})),
			},
		],
		...(row.machine ? {} : { header: <span className="tone-dim">This platform runs Windlass only. Claude Code and OpenCode run on a machine of yours that is signed into them.</span> }),
	};
}

/** The models its agent offers at the place, the default first: for Windlass "the feature's model" stands for none chosen. */
function modelMenu(row: AgentRow, harness: HarnessId): MenuSpec {
	const list = row.list;
	const chosen = row.draft?.model ?? "";
	const none = harness === "windlass" ? "The feature's model" : "Its default model";
	return {
		label: "Model",
		width: 280,
		groups: [
			{ id: "inherit", items: [{ id: "", label: none, checked: chosen === "", onSelect: () => row.onAgent(harness === "windlass" ? (row.draft?.effort ? { harness, effort: row.draft.effort } : null) : { harness }) }] },
			...(list && list.models.length > 0
				? [{ id: "models", items: list.models.map((model) => ({ id: model.id, label: modelLabel(list, model.id), checked: chosen === model.id, onSelect: () => row.onAgent({ harness, model: model.id }) })) }]
				: []),
		],
	};
}

/** The efforts its model offers, or every effort its agent reported where it reports a model's only once selected. */
function effortMenu(row: AgentRow, harness: HarnessId, efforts: string[]): MenuSpec {
	const chosen = row.draft?.effort ?? "";
	const pick = (effort: string) => {
		const next = { harness, ...(row.draft?.model && { model: row.draft.model }), ...(effort && { effort }) };
		row.onAgent(cleanAgent(next) ?? null);
	};
	return {
		label: "Effort",
		width: 220,
		groups: [{ id: "efforts", items: [{ id: "", label: "Default", checked: chosen === "", onSelect: () => pick("") }, ...effortChoices(efforts).map((effort) => ({ id: effort, label: effort, checked: chosen === effort, onSelect: () => pick(effort) }))] }],
	};
}

/** Which agent a subtask runs, on which model and effort: as chosen while the plan is open, or what its item runs. */
function SubtaskAgentFact({ title, child, row, editing, disabled }: { title: string; child: ItemSummary | null; row: AgentRow; editing: boolean; disabled: boolean }) {
	const harness = row.draft?.harness ?? "windlass";
	const parts = agentParts(row.draft, row.list);
	if (child?.agent) {
		const ran = cleanAgent({ harness: child.agent.harness, model: child.agent.model, ...(child.agent.effort && { effort: child.agent.effort }) });
		const words = agentParts(ran ?? { harness: child.agent.harness, model: child.agent.model }, null);
		return (
			<div className="plan-agent">
				<dt>agent</dt>
				<dd>
					<AgentGlyph harness={child.agent.harness} size={11} inline />
					<strong className="plan-agent-name">{words.name}</strong>
					<span className="tone-dim"> · {child.agent.model}{child.agent.effort ? ` · ${child.agent.effort} effort` : ""}</span>
					{words.unattended ? <UnattendedTag /> : null}
				</dd>
			</div>
		);
	}
	// A model that reports its efforts only once selected: any effort its agent reported (account-models.ts, `checkItemEffort`).
	const list = row.list;
	const model = row.draft?.model ?? (harness === "windlass" ? "" : (list?.defaultModel ?? ""));
	const own = effortsOf(list, model);
	const efforts = own.length > 0 || harness === "windlass" ? own : [...new Set((list?.models ?? []).flatMap((one) => one.efforts))];
	return (
		<div className="plan-agent">
			<dt>agent</dt>
			<dd>
				{editing ? (
					<span className="plan-place-picks">
						<Menu spec={agentMenu(row, title)} trigger={(props) => <Pill {...props} outlined disabled={disabled} dot={row.changed ? "changed" : null} dotLabel={row.changed ? "changed, not saved" : undefined} className="plan-place-pick" icon={<AgentGlyph harness={harness} size={11} />} aria-label={`Agent: ${parts.name}`}>{parts.name}</Pill>} />
						<Menu spec={modelMenu(row, harness)} trigger={(props) => <Pill {...props} disabled={disabled} className="plan-place-pick plan-place-allow" aria-label={`Model: ${parts.model}`}>{parts.model}</Pill>} />
						{efforts.length > 0 || row.draft?.effort ? <Menu spec={effortMenu(row, harness, efforts)} trigger={(props) => <Pill {...props} disabled={disabled} className="plan-place-pick plan-place-allow" aria-label={`Effort: ${parts.effort ?? "default"}`}>{parts.effort ? `${parts.effort} effort` : "Default effort"}</Pill>} /> : null}
						{parts.unattended ? <UnattendedTag /> : null}
					</span>
				) : (
					<>
						<AgentGlyph harness={harness} size={11} inline />
						<strong className="plan-agent-name">{parts.name}</strong>
						<span className="tone-dim"> · {parts.model}{parts.effort ? ` · ${parts.effort} effort` : ""}</span>
						{parts.unattended ? <UnattendedTag /> : null}
					</>
				)}
			</dd>
		</div>
	);
}

/**
 * On the approval card, before approval: each subtask still to run whose agent works without asking,
 * with a box the owner ticks for it. Approval is held back (and refused by the server) until every one is
 * ticked: the planner chose these agents from the item's text, which an issue's author may have written.
 */
function UnattendedConfirm({ plan, review, disabled }: { plan: FeaturePlan; review: PlanReview; disabled: boolean }) {
	const heading = useId();
	const tasks = plan.subtasks.filter((task) => review.unattended.includes(task.key));
	return (
		<div className="plan-unattended-confirm" role="group" aria-labelledby={heading}>
			<p className="plan-routes-head" id={heading}>
				Agents that work without asking
			</p>
			<p className="plan-unattended-note">
				{UNATTENDED_MEANS} The planner proposed {tasks.length === 1 ? "this one" : "these"} from the item's text, which may come from an issue anyone could file. Confirm each one, or choose Windlass for it below and save.
			</p>
			<ul className="plan-unattended-list">
				{tasks.map((task) => {
					const name = agentParts(task.agent, null).name;
					return (
						<li key={task.key}>
							<Check
								className="plan-unattended-row"
								checked={review.confirmed.includes(task.key)}
								disabled={disabled}
								onChange={(on) => review.setConfirmed(task.key, on)}
								label={
									<>
										Run <strong>{task.title}</strong> on {name}, which {UNATTENDED_WORDS}
									</>
								}
							/>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/**
 * Whether repository secrets go to a place: a small dot and two words. Sent is the warm signal: the
 * owner should see where the repository's secrets would go before approving a plan the planner wrote,
 * perhaps from an issue anyone could file.
 */
function SecretsTag({ sent, done = false }: { sent: boolean | null; done?: boolean }) {
	const words = sent === true ? (done ? "secrets were sent" : "secrets sent") : sent === false ? "no secrets" : "secrets unknown";
	const means = sent === true ? "Repository and account secrets this item is allowed are sent to this place." : sent === false ? "No saved secret is sent to this machine: what needs one fails there." : "This place is not among your machines as last read.";
	// The space keeps the place and its secrets apart when read aloud.
	return (
		<>
			{" "}
			<span className={`plan-secrets plan-secrets-${sent === true ? "sent" : sent === false ? "none" : "unknown"}`} title={means}>
				{words}
			</span>
		</>
	);
}

/**
 * On the approval card: where each subtask of the version shown would run, why, where it may overflow
 * to, and whether each of those places gets the repository's secrets. Read from the saved plan, the
 * version an approval approves, and the owner's current secrets policy (`placementReview`).
 */
function PlanRoutes({ view, plan, machines, models, catalogs, accountModels, refusal }: { view: ItemView; plan: FeaturePlan; machines: MachineSummary[] | null; models: AgentModels; catalogs: Catalogs; accountModels: ModelList | null; refusal: string | null }) {
	const heading = useId();
	const parent = parentPlaceName(view.place, machines);
	const overflow = plan.overflow === true;
	const secrets = (name: string) => secretsFor(name, view.placementReview, machines);
	return (
		<div className="plan-routes" role="group" aria-labelledby={heading}>
			<p className="plan-routes-head">
				<span id={heading}>Where each subtask runs</span>
				<span className="plan-routes-overflow">
					overflow <strong>{overflow ? "allowed" : "off"}</strong>
				</span>
			</p>
			<ol className="plan-routes-list">
				{plan.subtasks.map((task, index) => {
					const route = routeWords(task, parent, overflow);
					const fit = machines ? placementFit(task, view.place, overflow, machines, models) : null;
					const problem = refusalFor(task, refusal) ?? (fit && "refused" in fit ? fit.refused : null);
					const wait = !problem && fit && "wait" in fit ? fit.wait : null;
					const harness = task.agent?.harness ?? "windlass";
					const agent = agentParts(task.agent, harness === "windlass" ? accountModels : machineModels(preferredMachine(task, parent, machines), harness, catalogs));
					return (
						<li key={task.key} className="plan-route">
							<span className="plan-route-n" aria-hidden="true">
								{index + 1}
							</span>
							<div className="plan-route-main">
								<p className="plan-route-title">{task.title}</p>
								<p className="plan-route-agent">
									<AgentGlyph harness={harness} size={11} inline />
									<span className="plan-agent-name">{agent.name}</span>
									<span className="tone-dim"> · {agent.model}{agent.effort ? ` · ${agent.effort} effort` : ""}</span>
									{agent.unattended ? <UnattendedTag /> : null}
								</p>
								{problem ? <p className="plan-route-problem">Can't be placed: {problem}</p> : null}
								{wait ? <p className="plan-route-wait">If approved now: {wait}</p> : null}
							</div>
							<ul className="plan-route-places" aria-label={`Places for ${task.title}`}>
								<li>
									<span className="plan-place-name">{placeWord(route.prefer)}</span>
									{route.inherited ? <span className="tone-faint"> the feature's</span> : null}
									<SecretsTag sent={secrets(route.prefer)} />
								</li>
								{route.alternatives.map((name) => (
									<li key={name} className={overflow ? undefined : "plan-route-unused"}>
										<span className="tone-faint">or </span>
										<span className="plan-place-name">{placeWord(name)}</span>
										{overflow ? <SecretsTag sent={secrets(name)} /> : <span className="tone-faint"> not used: overflow off</span>}
									</li>
								))}
							</ul>
						</li>
					);
				})}
			</ol>
			<p className="plan-routes-note">
				This platform always gets the repository's secrets; a machine gets them only while its <strong>Send saved secrets</strong> switch is on, on{" "}
				<a className="link" {...linkProps({ name: "machines" })}>
					Machines
				</a>
				.
			</p>
		</div>
	);
}

/**
 * A subtask the feature could not place once it got there (question kind "placement_refused",
 * blueprint.ts `askPlacement`): a machine was removed, its owner's policy changed, or it lacks what the
 * subtask needs. Three answers: revise the placement (the planner files the remaining subtasks again;
 * a place picked here goes to it as the owner's note), retry the approved places (after the owner
 * changed what refused it), or give up the subtask: it is cancelled, and the feature re-plans or stops.
 */
export function PlacementQuestion({ view, question, review, acting, when }: { view: ItemView; question: ItemQuestion; review: PlanReview; acting: PlanActing; when: ReactNode }) {
	const ids = { title: useId(), note: useId() };
	const about = refusedSubtask(view.plan ?? null, question.text);
	const task = about?.task ?? null;
	const [revising, setRevising] = useState(false);
	const [draft, setDraft] = useState<PlaceDraft>(() => (task ? placeDraftOf(task) : { prefer: null, allow: [] }));
	const [note, setNote] = useState("");
	const busy = acting.busy !== null;
	const offered = (id: string) => question.choices.find((choice) => choice.id === id) ?? null;
	const revise = offered("revise");
	const again = offered("again");
	const giveUp = offered("give_up");
	const machines = review.machines;
	const parent = parentPlaceName(view.place, machines);
	const overflow = view.plan?.overflow === true;
	const route = task ? routeWords(task, parent, overflow) : null;
	const moved = task !== null && placeChanged(task, draft);
	const picked = task && moved ? withPlace(task, draft) : null;
	const check = picked && machines ? placementFit(picked, view.place, overflow, machines) : null;
	const pickRefused = check && "refused" in check ? check.refused : null;
	const pickWait = check && "wait" in check ? check.wait : null;
	const row: PlaceRow = { machines, parent, overflow, draft, problem: pickRefused, wait: null, ahead: pickWait, secrets: (name) => secretsFor(name, view.placementReview, machines), onPlace: setDraft };
	const send = (choice: "revise" | "again" | "give_up") => {
		const words = [
			...(picked ? [`Run “${picked.title}” on ${placeWord(draft.prefer ?? parent)}${draft.allow.length ? `, or ${draft.allow.map(placeWord).join(", ")}` : ""}.`] : []),
			...(note.trim() ? [note.trim()] : []),
		].join(" ").slice(0, MAX_NOTE_CHARS);
		return acting.act({ kind: "answer", question: question.id, choice, ...(choice === "revise" && words ? { note: words } : {}) });
	};
	return (
		<section className="item-question placement-question" aria-labelledby={ids.title}>
			<p className="item-question-head" id={ids.title}>
				It asks you
				<span className="item-question-when">{when}</span>
			</p>
			<p className="item-question-text">{task ? <>“{task.title}” can't be placed</> : "A subtask can't be placed"}</p>
			<dl className="placement-question-facts">
				<div className="plan-place-problem">
					<dt>refused</dt>
					<dd role="alert">{about?.reason ?? question.text}</dd>
				</div>
				{route ? (
					<div className="plan-place">
						<dt>approved</dt>
						<dd>
							<strong className="plan-place-name">{placeWord(route.prefer)}</strong>
							{route.inherited ? <span className="tone-faint"> as the feature</span> : null}
							{route.alternatives.length > 0 ? (
								<span className={overflow ? "plan-place-alt" : "plan-place-alt tone-faint"}>
									{" "}
									or {route.alternatives.map(placeWord).join(", ")}
									{overflow ? null : " · overflow off"}
								</span>
							) : null}
						</dd>
					</div>
				) : null}
			</dl>

			{revising && task ? (
				<div className="placement-revise">
					<dl className="placement-question-facts">
						<SubtaskPlace task={task} child={null} row={row} editing disabled={busy} />
					</dl>
					<div>
						<label className="label" htmlFor={ids.note}>
							A note to the planner<span className="label-optional">optional</span>
						</label>
						<textarea id={ids.note} className="input textarea item-note" value={note} maxLength={MAX_NOTE_CHARS - 200} onChange={(event) => setNote(event.target.value)} readOnly={busy} />
					</div>
					<div className="item-choices">
						<button type="button" className="button button-primary" disabled={busy || pickRefused !== null} onClick={() => void send("revise")} aria-describedby={`${ids.title}-revise`}>
							{acting.busy === "revise" ? "Sending…" : "Ask for a revised plan"}
						</button>
						<button type="button" className="button button-quiet" disabled={busy} onClick={() => setRevising(false)}>
							Back
						</button>
					</div>
					<p className="field-note" id={`${ids.title}-revise`}>
						{pickRefused
							? "Choose a place that can take it."
							: picked
								? "The planner files the remaining subtasks again with this place; the new plan comes to you for approval."
								: "Pick where it should run, or leave the place to the planner. The new plan comes to you for approval."}
					</p>
				</div>
			) : (
				<>
					<div className="item-choices">
						{revise && task ? (
							<button type="button" className="button button-primary" disabled={busy} onClick={() => setRevising(true)}>
								{revise.label}…
							</button>
						) : null}
						{again ? (
							<button type="button" className={`button ${revise && task ? "button-outline" : "button-primary"}`} disabled={busy} onClick={() => void send("again")}>
								{acting.busy === "again" ? "Checking…" : again.label}
							</button>
						) : null}
						{giveUp ? (
							<button type="button" className="button button-quiet" disabled={busy} onClick={() => void send("give_up")}>
								{acting.busy === "give_up" ? "Sending…" : giveUp.label}
							</button>
						) : null}
					</div>
					<p className="field-note">
						Retry once you have changed what refused it, on{" "}
						<a className="link" {...linkProps({ name: "machines" })}>
							Machines
						</a>
						. Giving up cancels the subtask; the planner then revises what is left for you to approve, or the feature stops.
					</p>
				</>
			)}
			{acting.error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{acting.error}</span>
				</p>
			) : null}
		</section>
	);
}
