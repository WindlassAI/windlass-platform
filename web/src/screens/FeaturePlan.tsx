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
 */
import type { FeaturePlan, ItemAction, ItemBudget, ItemSummary, ItemView, PlanSubtask } from "@contract";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronIcon, WarnIcon } from "../components/Icons";
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

const PLAN_QUESTIONS = new Set(["plan_approval", "replan_approval"]);

/** Whether the plan is the one its item asks about now: its budgets and questions can be changed, and it approved. */
export function planOpen(view: ItemView): boolean {
	return view.mode === "orchestrate" && view.plan?.status === "proposed" && PLAN_QUESTIONS.has(view.question?.kind ?? "");
}

type Drafts = Record<string, Record<keyof ItemBudget, string>>;

const draftsOf = (plan: FeaturePlan): Drafts => Object.fromEntries(plan.subtasks.map((task) => [task.key, Object.fromEntries(PLAN_FIELDS.map((field) => [field.key, field.toInput(task.budget[field.key])])) as Record<keyof ItemBudget, string>]));

/** The plan's budgets, questions and the actions on them, kept together so that its question card and its section agree. */
export function usePlanReview(view: ItemView | null, acting: PlanActing) {
	const plan = view?.plan ?? null;
	const open = view ? planOpen(view) : false;
	const [drafts, setDrafts] = useState<Drafts>(() => (plan ? draftsOf(plan) : {}));
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const version = plan?.version ?? 0;
	// Another version is another plan: what was typed for the one before is not this one's.
	useEffect(() => {
		if (plan) setDrafts(draftsOf(plan));
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
	const dirty = budgetsChanged || answered.length > 0;
	const unanswered = plan ? plan.questions.filter((question) => !question.answer).length : 0;

	const save = () => {
		if (!plan) return Promise.resolve(false);
		const questions = plan.questions.map((question) => (answers[question.id]?.trim() ? { ...question, answer: answers[question.id]!.trim() } : question));
		const subtasks: PlanSubtask[] = plan.subtasks.map((task) => ({ ...task, budget: parsed[task.key] ?? task.budget }));
		return acting.act({ kind: "edit_plan", version: plan.version, plan: { questions, spec: plan.spec, subtasks, singleSuggested: plan.singleSuggested, overflow: plan.overflow } });
	};
	const approve = () => (plan ? acting.act({ kind: "approve_plan", version: plan.version }) : Promise.resolve(false));
	const reset = () => {
		if (plan) setDrafts(draftsOf(plan));
		setAnswers({});
	};

	return {
		plan,
		open,
		drafts,
		setDraft: (key: string, field: keyof ItemBudget, text: string) => setDrafts((now) => ({ ...now, [key]: { ...now[key]!, [field]: text } })),
		answers,
		setAnswer: (id: string, text: string) => setAnswers((now) => ({ ...now, [id]: text })),
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
				{replan ? "A subtask stopped. Review the revised plan" : "Review the plan"}: {tasks} subtasks, {PLAN_FIELDS[0]!.spelled(totalTokens)} tokens of the {PLAN_FIELDS[0]!.spelled(plan.budget.tokens)} the feature may spend.
				<span className="plan-version"> Version {plan.version}</span>
			</p>

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
						{acting.busy === "approve_plan" ? "Approving…" : `Approve version ${plan.version}`}
					</button>
				)}
				{refused && SINGLE_INSTEAD.test(refused) && !replan ? (
					<button type="button" className="button button-outline" disabled={busy} onClick={() => void acting.act({ kind: "run_single" })}>
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
	const numbers = new Map(plan.subtasks.map((task, index) => [task.key, index + 1]));
	const setAside = plan.status === "superseded";
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
			{plan.singleSuggested ? <p className="plan-single">The planner suggests one item instead: {plan.singleSuggested}</p> : null}

			{view.mode !== "single" && plan.subtasks.length > 0 ? (
				<div className="usage-card plan-card">
					<p className="plan-card-head">
						Subtasks <span className="plan-card-count">{plan.subtasks.length}, in order</span>
					</p>
					<ol className="plan-tasks" aria-label="Subtasks">
						{plan.subtasks.map((task) => (
							<SubtaskRow key={task.key} task={task} n={numbers.get(task.key)!} numbers={numbers} child={children.get(task.key) ?? null} setAside={setAside} fields={fields} editing={editing} drafts={review.drafts[task.key]} problems={review.problems.fields[task.key] ?? {}} floor={floor} single={single} disabled={acting.busy !== null} onChange={(field, text) => review.setDraft(task.key, field, text)} />
						))}
					</ol>

					<div className="plan-total" aria-label="What the subtasks spend together">
						<p className="plan-total-head">Together</p>
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

function SubtaskRow({ task, n, numbers, child, setAside, fields, editing, drafts, problems, floor, single, disabled, onChange }: { task: PlanSubtask; n: number; numbers: Map<string, number>; child: ItemSummary | null; setAside: boolean; fields: PlanField[]; editing: boolean; drafts: Record<keyof ItemBudget, string> | undefined; problems: Partial<Record<keyof ItemBudget, string>>; floor: ItemBudget; single: ItemBudget; disabled: boolean; onChange(field: keyof ItemBudget, text: string): void }) {
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
					<span className="plan-task-word tone-faint">{editing ? "planned" : setAside ? "not run" : "not started"}</span>
				)}
			</div>
		</li>
	);
}
