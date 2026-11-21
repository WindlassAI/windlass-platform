/**
 * An orchestrated work item's plan on its page (`ItemView.plan`): the spec the planner wrote, its
 * subtasks in order with what each depends on, the paths it owns, how it is checked and what it may
 * spend, and the total against what the feature may spend (three single items, less what is kept for
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
 */
import type { FeaturePlan, ItemAction, ItemBudget, ItemSummary, ItemView, MachineSummary, PlanSubtask, Waiting } from "@contract";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { singleAfterPlanning } from "../../../server/src/factory/feature-plan.js";
import { ChevronIcon, WarnIcon } from "../components/Icons";
import { ItemSpend } from "../components/ItemSpend";
import { Menu, type MenuItem, type MenuSpec } from "../components/ui/Menu";
import { Pill } from "../components/ui/Pill";
import { machineLabel } from "../lib/machines";
import { HOSTED, OWNER_REASON, needsWords, routeWords, secretsFor, nextSubtask, orchestratorOf, parentPlaceName, placeChanged, placeDraftOf, placedWords, placementProblem, placeWord, refusalFor, withPlace, type PlaceDraft } from "../lib/placement";
import { useApp } from "../state/app";
import { useMachines } from "./Machines";
import { budgetProblems, closingReserve, PLAN_FIELDS, subtaskFloor, subtaskPool, sumBudgets, type PlanField } from "../lib/feature";
import { linkProps } from "../lib/router";
import { ItemGlyph, ItemTrack, itemTrack, STATE_WORD } from "./Items";

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

type Drafts = Record<string, Record<keyof ItemBudget, string>>;

const placesOf = (plan: FeaturePlan): Record<string, PlaceDraft> => Object.fromEntries(plan.subtasks.map((task) => [task.key, placeDraftOf(task)]));

const draftsOf = (plan: FeaturePlan): Drafts => Object.fromEntries(plan.subtasks.map((task) => [task.key, Object.fromEntries(PLAN_FIELDS.map((field) => [field.key, field.toInput(task.budget[field.key])])) as Record<keyof ItemBudget, string>]));

/** The plan's budgets, questions and the actions on them, kept together so that its question card and its section agree. */
export function usePlanReview(view: ItemView | null, acting: PlanActing) {
	const plan = view?.plan ?? null;
	const open = view ? planOpen(view) : false;
	const [drafts, setDrafts] = useState<Drafts>(() => (plan ? draftsOf(plan) : {}));
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [places, setPlaces] = useState<Record<string, PlaceDraft>>(() => (plan ? placesOf(plan) : {}));
	const [overflow, setOverflow] = useState(plan?.overflow ?? false);
	const version = plan?.version ?? 0;
	// The user's machines: their names for the place menus, and their secrets switch for what the plan would send where.
	const { platform } = useApp();
	const machines = useMachines(platform.info?.machines != null && view?.mode === "orchestrate" && plan !== null && plan.status !== "superseded").list;
	// Another version is another plan: what was typed for the one before is not this one's.
	useEffect(() => {
		if (plan) {
			setDrafts(draftsOf(plan));
			setPlaces(placesOf(plan));
			setOverflow(plan.overflow ?? false);
		}
		setAnswers({});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [view?.id, version]);

	const parsed = useMemo(() => {
		const out: Record<string, ItemBudget> = {};
		for (const task of plan?.subtasks ?? []) {
			const draft = drafts[task.key];
			out[task.key] = Object.fromEntries(PLAN_FIELDS.map((field) => [field.key, draft ? field.fromInput(draft[field.key]) : task.budget[field.key]])) as unknown as ItemBudget;
		}
		return out;
	}, [plan, drafts]);

	const done = (view?.children ?? []).filter((child) => child.state === "done").map((child) => child.budget);
	const pool = plan && view ? subtaskPool(plan, view.spent, done) : null;
	const problems = plan && pool ? budgetProblems(plan.compare.singleBudget, pool, parsed) : { fields: {}, total: [], any: false };
	const budgetsChanged = plan ? plan.subtasks.some((task) => PLAN_FIELDS.some((field) => parsed[task.key]?.[field.key] !== task.budget[field.key])) : false;
	const answered = Object.entries(answers).filter(([, text]) => text.trim() !== "");
	const placesDirty = plan ? plan.subtasks.some((task) => places[task.key] !== undefined && placeChanged(task, places[task.key]!)) || overflow !== (plan.overflow ?? false) : false;
	const dirty = budgetsChanged || answered.length > 0 || placesDirty;
	/** A subtask as it would be saved: its budget and place as edited. */
	const edited = (task: PlanSubtask): PlanSubtask => {
		const place = places[task.key];
		const budgeted = { ...task, budget: parsed[task.key] ?? task.budget };
		return place && placeChanged(task, place) ? withPlace(budgeted, place) : budgeted;
	};
	const unanswered = plan ? plan.questions.filter((question) => !question.answer).length : 0;

	const save = () => {
		if (!plan) return Promise.resolve(false);
		const questions = plan.questions.map((question) => (answers[question.id]?.trim() ? { ...question, answer: answers[question.id]!.trim() } : question));
		const subtasks: PlanSubtask[] = plan.subtasks.map(edited);
		return acting.act({ kind: "edit_plan", version: plan.version, plan: { questions, spec: plan.spec, subtasks, singleSuggested: plan.singleSuggested, overflow } });
	};
	const approve = () => {
		if (view?.question?.kind === "single_suggested") return acting.act({ kind: "answer", question: view.question.id, choice: "run_single" });
		return plan ? acting.act({ kind: "approve_plan", version: plan.version }) : Promise.resolve(false);
	};
	const reset = () => {
		if (plan) {
			setDrafts(draftsOf(plan));
			setPlaces(placesOf(plan));
			setOverflow(plan.overflow ?? false);
		}
		setAnswers({});
	};

	return {
		plan,
		open,
		drafts,
		setDraft: (key: string, field: keyof ItemBudget, text: string) => setDrafts((now) => ({ ...now, [key]: { ...now[key]!, [field]: text } })),
		answers,
		setAnswer: (id: string, text: string) => setAnswers((now) => ({ ...now, [id]: text })),
		machines,
		places,
		setPlace: (key: string, draft: PlaceDraft) => setPlaces((now) => ({ ...now, [key]: draft })),
		overflow,
		setOverflow,
		edited,
		parsed,
		pool,
		problems,
		dirty,
		/** Questions with no answer saved and none typed. */
		unansweredLeft: plan ? plan.questions.filter((question) => !question.answer && !answers[question.id]?.trim()).length : 0,
		unanswered,
		save,
		approve,
		reset,
	};
}

export type PlanReview = ReturnType<typeof usePlanReview>;

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
	const blocked = review.problems.any ? "Fix the figures marked below first." : review.dirty ? "Save your changes, then approve this version." : review.unanswered > 0 ? `Answer ${review.unanswered === 1 ? "the question" : `the ${review.unanswered} questions`} and save first.` : null;
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
				<span className="plan-version"> Version {plan.version}</span>
			</p>

			{plan.subtasks.length > 0 ? <PlanRoutes view={view} plan={plan} machines={review.machines} refusal={refused} /> : null}

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
				{review.dirty ? (
					<>
						<button type="button" className="button button-primary" disabled={busy || review.problems.any} onClick={() => void review.save()}>
							{acting.busy === "edit_plan" ? "Saving…" : `Save as version ${plan.version + 1}`}
						</button>
						<button type="button" className="button button-quiet" disabled={busy} onClick={review.reset}>
							Discard changes
						</button>
					</>
				) : (
					<button type="button" className="button button-primary" disabled={busy || blocked !== null} onClick={() => void review.approve()} aria-describedby={blocked ? `${ids.title}-why` : undefined}>
						{single ? "Approve for one implementer" : acting.busy === "approve_plan" ? "Approving…" : `Approve version ${plan.version}`}
					</button>
				)}
				{single && !review.dirty && view.question.choices.some(option => option.id === "orchestrate_anyway") && (
					<button type="button" className="button button-outline" disabled={busy} onClick={() => void acting.act({ kind: "answer", question: view.question!.id, choice: "orchestrate_anyway" })}>
						Ask for subtasks
					</button>
				)}
				{refused && SINGLE_INSTEAD.test(refused) && !replan ? (
					<button type="button" className="button button-outline" disabled={busy || blocked !== null} onClick={() => void acting.act({ kind: "run_single" })}>
						{acting.busy === "run_single" ? "Starting…" : "Run as a single item"}
					</button>
				) : null}
				{revise && !review.dirty ? (
					<button type="button" className="button button-outline" disabled={busy} onClick={() => void acting.act({ kind: "answer", question: view.question!.id, choice: "revise" })}>
						{acting.busy === "revise" ? "Sending…" : "Ask for a new plan"}
					</button>
				) : null}
				{giveUp && !review.dirty ? (
					<button type="button" className="button button-quiet" disabled={busy} onClick={() => void acting.act({ kind: "answer", question: view.question!.id, choice: "give_up" })}>
						{acting.busy === "give_up" ? "Sending…" : giveUp.label}
					</button>
				) : null}
			</div>
			{blocked && !review.dirty ? (
				<p className="field-note" id={`${ids.title}-why`}>
					{blocked}
				</p>
			) : null}
			{!single && <p className="field-note">Sizing beyond one slot is not supported by current runners.</p>}
		</section>
	);
}

/** One of the plan's own questions: its options as a choice, or a line to write. */
function PlanAsk({ question, value, disabled, onChange }: { question: FeaturePlan["questions"][number]; value: string; disabled: boolean; onChange(text: string): void }) {
	const id = useId();
	if (question.answer) {
		return (
			<div className="plan-ask plan-ask-answered">
				<p className="plan-ask-text">{question.text}</p>
				<p className="plan-ask-answer">{question.answer}</p>
			</div>
		);
	}
	return (
		<div className="plan-ask">
			<p className="plan-ask-text" id={id}>
				{question.text}
			</p>
			{question.options?.length ? (
				<div className="segmented plan-ask-options" role="radiogroup" aria-labelledby={id}>
					{question.options.map((option) => (
						<label key={option} className={`segment${value === option ? " segment-chosen" : ""}`}>
							<input className="segment-radio" type="radio" name={id} value={option} checked={value === option} disabled={disabled} onChange={() => onChange(option)} />
							{option}
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
			<ItemSpend spent={view.spent} budget={view.mode === "single" ? view.budget : singleAfterPlanning(plan.compare.singleBudget, view.spent, view.budget)} fields={PLAN_FIELDS.filter(field => field.key !== "hostedSeconds")} />
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
	return (
		<section className="usage-section feature-plan" aria-labelledby={heading}>
			<h2 className="usage-title" id={heading}>
				The plan
				<span className="usage-count">
					v{plan.version} · {STATUS_WORD[plan.status]}
				</span>
			</h2>
			<PlanBody view={view} review={review} acting={acting} pool={pool} />
			{singleSpend}
		</section>
	);
}

function PlanBody({ view, review, acting, pool }: { view: ItemView; review: PlanReview; acting: PlanActing; pool: ItemBudget }) {
	const plan = review.plan!;
	const hosted = view.place.kind === "hosted";
	const fields = PLAN_FIELDS.filter((field) => hosted || field.key !== "hostedSeconds");
	const editing = review.open;
	const children = new Map((view.children ?? []).filter((child) => child.parent).map((child) => [child.parent!.key, child]));
	const single = plan.compare.singleBudget;
	const floor = subtaskFloor(single);
	const reserve = closingReserve(single);
	const total = sumBudgets(Object.values(review.parsed));
	const spent = view.children?.length ? sumBudgets(view.children.map(child => child.spent)) : null;
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
		problem: plan.status !== "proposed" ? null : ((review.places[task.key] && placeChanged(task, review.places[task.key]!) ? null : refusalFor(task, refusal)) ?? (machines ? placementProblem(review.edited(task), view.place, editing ? review.overflow : plan.overflow === true, machines) : null)),
		wait: task.key === waitingKey ? view.wait : null,
		secrets: (name) => secretsFor(name, view.placementReview, machines),
		onPlace: (draft) => review.setPlace(task.key, draft),
	});
	return (
		<>
			<p className="plan-goal">
				<Inline text={plan.spec.goal} />
			</p>

			<dl className="plan-spec">
				{plan.spec.requirements.length > 0 ? <SpecList term="Requirements" kind="requirements" lines={plan.spec.requirements} /> : null}
				{plan.spec.acceptance.length > 0 ? <SpecList term="Done when" kind="acceptance" lines={plan.spec.acceptance} /> : null}
				{plan.spec.outOfScope.length > 0 ? <SpecList term="Not in it" kind="out" lines={plan.spec.outOfScope} /> : null}
			</dl>

			{view.mode !== "single" && plan.subtasks.length > 0 ? (
				<div className="usage-card plan-card">
					<p className="plan-card-head">
						Subtasks <span className="plan-card-count">{plan.subtasks.length}, in order</span>
					</p>
					{placing || editing ? <FeaturePlacement parent={parentPlaceName(view.place, machines)} editing={editing} overflow={editing ? review.overflow : plan.overflow === true} disabled={acting.busy !== null} onOverflow={review.setOverflow} /> : null}
					<ol className="plan-tasks" aria-label="Subtasks">
						{plan.subtasks.map((task) => (
							<SubtaskRow key={task.key} task={task} place={placing || editing ? place(task) : null} n={numbers.get(task.key)!} numbers={numbers} child={children.get(task.key) ?? null} setAside={setAside} fields={fields} editing={editing} drafts={review.drafts[task.key]} problems={review.problems.fields[task.key] ?? {}} floor={floor} single={single} disabled={acting.busy !== null} onChange={(field, text) => review.setDraft(task.key, field, text)} />
						))}
					</ol>

					<div className="plan-total" aria-label="Allotted to subtasks">
						<p className="plan-total-head">Allotted to subtasks</p>
						<dl className="plan-total-figures">
							{fields.map((field) => {
								const over = review.problems.total.includes(field.key);
								const share = Math.min(100, (total[field.key] / Math.max(1, plan.budget[field.key])) * 100);
								const kept = Math.min(100 - share, (reserve[field.key] / Math.max(1, plan.budget[field.key])) * 100);
								return (
									<div key={field.key} className={over ? "plan-total-over" : undefined}>
										<dt>{field.label}</dt>
										<dd className="plan-total-number">
											{field.spelled(total[field.key])} <span className="tone-faint">of {field.spelled(pool[field.key])}</span>
										</dd>
										<dd>
											<span className="usage-meter plan-meter" aria-hidden="true">
												<span className={`usage-meter-used${over ? " item-meter-reached" : ""}`} style={{ width: `${share}%` }} />
												<span className="plan-meter-kept" style={{ width: `${kept}%` }} />
											</span>
										</dd>
										{spent && <dd className="tone-dim">Spent by subtasks: {field.spelled(spent[field.key])}</dd>}
										{over ? <dd className="plan-total-why tone-bad">over what the subtasks may share</dd> : null}
									</div>
								);
							})}
						</dl>
						<p className="usage-note plan-total-note">
							The feature may spend three single items ({PLAN_FIELDS[0]!.spelled(plan.budget.tokens)} tokens, {plan.budget.turns} turns). {PLAN_FIELDS[0]!.spelled(reserve.tokens)} tokens and {reserve.turns} turns are kept for the summary and the review; the hatched part of each bar. A subtask gets at most one single item ({PLAN_FIELDS[0]!.spelled(single.tokens)} tokens, {single.turns} turns).
						</p>
					</div>
				</div>
			) : null}
		</>
	);
}

/** One part of the spec: its name in the margin, its lines as a list, the first few shown and the rest behind "Show more". */
function SpecList({ term, kind, lines }: { term: string; kind: "requirements" | "acceptance" | "out"; lines: string[] }) {
	const [all, setAll] = useState(false);
	const list = useId();
	// Folding away a single line saves nothing: a part one longer than the shown lines is shown whole.
	const folds = lines.length > SPEC_SHOWN + 1;
	const shown = folds && !all ? lines.slice(0, SPEC_SHOWN) : lines;
	return (
		<div className={`plan-spec-part plan-spec-${kind}`}>
			<dt>
				{term}
				<span className="plan-spec-count">{lines.length}</span>
			</dt>
			<dd>
				<ul id={list}>
					{shown.map((line, index) => (
						<li key={index}>
							<Inline text={line} />
						</li>
					))}
				</ul>
				{folds ? (
					<button type="button" className="link plan-spec-more" aria-expanded={all} aria-controls={list} onClick={() => setAll((value) => !value)}>
						{all ? "Show fewer" : `Show ${lines.length - SPEC_SHOWN} more`}
					</button>
				) : null}
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

function SubtaskRow({ task, place, n, numbers, child, setAside, fields, editing, drafts, problems, floor, single, disabled, onChange }: { task: PlanSubtask; place: PlaceRow | null; n: number; numbers: Map<string, number>; child: ItemSummary | null; setAside: boolean; fields: PlanField[]; editing: boolean; drafts: Record<keyof ItemBudget, string> | undefined; problems: Partial<Record<keyof ItemBudget, string>>; floor: ItemBudget; single: ItemBudget; disabled: boolean; onChange(field: keyof ItemBudget, text: string): void }) {
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
						<span className="plan-task-after">
							after{" "}
							{task.dependsOn.map((key, index) => (
								<span key={key}>
									{index > 0 ? ", " : null}
									{numbers.has(key) ? `${numbers.get(key)} ` : null}
									<span className="plan-task-key">{key}</span>
								</span>
							))}
						</span>
					) : null}
				</div>
				<p className="plan-task-brief">{task.brief}</p>
				<dl className="plan-task-facts">
					<div>
						<dt>owns</dt>
						<dd className="plan-paths">
							{task.owns.map((path) => (
								<code key={path} className="plan-path">
									{path}
								</code>
							))}
						</dd>
					</div>
					<div>
						<dt>checked by</dt>
						<dd>
							<ul className="plan-checks">
								{task.acceptance.map((line, index) => (
									<li key={index}>
										<Inline text={line} />
									</li>
								))}
							</ul>
						</dd>
					</div>
					{place ? <SubtaskPlace task={task} child={child} row={place} editing={editing} disabled={disabled} /> : null}
				</dl>
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
	const reason = preferMoved ? (prefer === null ? null : OWNER_REASON) : task.place?.reason;
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
						<span className="plan-place-why">{child.placement.reason}</span>
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
						{reason ? <span className="plan-place-why">{reason}</span> : null}
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
			{row.problem && !child ? (
				<div className="plan-place-problem">
					<dt>can't place</dt>
					<dd role="alert">{row.problem}</dd>
				</div>
			) : null}
		</>
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
function PlanRoutes({ view, plan, machines, refusal }: { view: ItemView; plan: FeaturePlan; machines: MachineSummary[] | null; refusal: string | null }) {
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
					const problem = refusalFor(task, refusal) ?? (machines ? placementProblem(task, view.place, overflow, machines) : null);
					return (
						<li key={task.key} className="plan-route">
							<span className="plan-route-n" aria-hidden="true">
								{index + 1}
							</span>
							<div className="plan-route-main">
								<p className="plan-route-title">{task.title}</p>
								<p className="plan-route-why">{route.inherited ? "Names no place: it runs where the feature does." : route.reason}</p>
								{problem ? <p className="plan-route-problem">Can't be placed: {problem}</p> : null}
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
