/**
 * A work item's page: where a person decides whether to trust a pull request they did not watch being
 * made. It says, each at a glance: where the item is and what it waits for, what it asks, what ran
 * (the run and its step, and the log), whether the pull request is ready and what is open (the Checks
 * panel: CI, the user's checks, the second review, feedback from GitHub, the flags), and what it cost
 * against its budget.
 *
 * Everything is the user's actor's (`ItemView`): read when the page opens, and again when the item's
 * revision in the user's live feed (`onItems`) is higher than the one shown, and when that feed comes
 * back after a drop. Nothing is asked on a timer. Every sentence about why it waits, what it asks and
 * what happened is the server's, shown as it was written; the agent's and the person's words in it
 * are plain text, never links.
 *
 * Actions are offered where `ItemAction` allows them: Start (a draft), Cancel (anything not ended),
 * Retry (a failed item), Send back (in review), and the open question's answers. The server refuses
 * one the item no longer allows with `item_conflict` and says why; that sentence is shown.
 *
 * An item filed from a GitHub issue says so under its title, with the issue's link, who filed it and,
 * where someone else wrote the issue, who wrote it. A draft of such an item (`origin.issue.trusted`
 * false) holds a snapshot of that person's text: its page shows the task first, as plain text, with
 * one line that says whose words they are, and Start stands under it rather than in the header.
 *
 * An item on one of the user's machines (`place`) says which, from the user's live list of machines.
 * Hosted sandbox time is no limit of such an item: its cost and the new budget for "Give it more"
 * leave it out. Once its machine was removed, the item can only be handed over or given up: the page
 * offers neither Retry nor Send back, and no note to an agent that cannot work any more.
 */
import { MAX_NOTE_CHARS, type ChoiceId, type ItemAction, type ItemBudget, type ItemEvent, type ItemQuestion, type ItemReport, type ItemSummary, type ItemView, type SessionSummary, type StepKind, type Verdict } from "@contract";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { hasReason, PlatformError } from "../api/client";
import { ITEM_MODE_WORDS } from "../lib/feature";
import { Inline, PlacementQuestion, PlanQuestion, PlanSection, planOpen, usePlanReview, type PlanActing } from "./FeaturePlan";
import { ItemSpend } from "../components/ItemSpend";
import { agentFacts, agentLine } from "../lib/item-agent";
import { Dialog } from "../components/Dialog";
import { InlineMarkdown, Output } from "../components/Blocks";
import { LongText } from "../components/Fold";
import { ArrowLeftIcon, ChevronIcon, ExternalIcon, InfoIcon, WarnIcon } from "../components/Icons";
import { ReviewBlocks } from "../components/ReviewBlocks";
import { useScreenshotLinks, type ScreenshotLinks } from "../components/Screenshots";
import { ItemNetwork } from "../components/ItemNetwork";
import type { AllowHostContext } from "../components/BlockedNetwork";
import { reviewShots } from "../components/SecondReview";
import { ItemChecks } from "./ItemChecks";
import { absoluteTime, compact, plural, relativeTime, sandboxTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useNow, useSessions } from "../state/hooks";
import { ItemGlyph, ItemRow, ItemStages, STATE_WORD } from "./Items";
import { useSessionMachine } from "./Session";
import { machineLabel } from "../lib/machines";
import { AgentGlyph } from "../components/ui/Pill";
import { childrenBehind } from "../lib/subtasks";
import { showsSubtasks, SubtasksBlock, SubtaskStrip } from "./Subtasks";

/** The steps in words. Planning is not offered yet; the rest are every step a run goes through. */
const STEP_WORD: Record<StepKind, string> = {
	subtasks: "Subtasks", integration: "Testing the repositories together", summary: "Feature summary",
	refine: "Planning",
	implement: "Implementing",
	gate: "Checks",
	publish: "Pushing",
	ci: "Waiting for CI",
	ci_fix: "Fixing CI",
	run_checks: "Running local checks",
	conflict: "Merging the base",
	review: "Second review",
	review_fix: "Fixing the review",
	handoff: "Handed over",
	merged: "Waiting for the merge",
};

/** What a working item is doing at each step. */
const STEP_DOING: Partial<Record<StepKind, string>> = {
	refine: "Its agent plans the work.",
	implement: "Its agent works on the task.",
	ci_fix: "Its agent works on what CI reported.",
	conflict: "Its agent merges the base into its branch.",
	gate: "The platform reads what the checks of the last turn found.",
	publish: "The platform pushes the work and opens or updates the pull request.",
	review: "A second agent reviews the pushed commit in its own sandbox.",
	review_fix: "Its agent works on the second review's blocking findings.",
};

/** Steps that are a turn of the agent, or a push: a second attempt of one is worth saying. Waits on GitHub count every poll as an attempt, which is not. */
const TRIED: ReadonlySet<StepKind> = new Set(["refine", "implement", "ci_fix", "conflict", "publish", "review", "review_fix"]);

const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const ordinal = (n: number) => ORDINAL[n - 1] ?? `${n}th`;

/** A time of day, with the day when it is not today: "14:02", "17 Nov, 14:02". */
function clockTime(at: number, now: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	return date.toDateString() === new Date(now).toDateString() ? time : `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

function When({ at, now }: { at: number; now: number }) {
	return (
		<time dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>
			{clockTime(at, now)}
		</time>
	);
}

// ---- reading it ---------------------------------------------------------------------------------

interface ItemPage {
	/** Null until it was read. */
	view: ItemView | null;
	/** Why it could not be read; `missing` when it is not the user's. */
	error: string | null;
	missing: boolean;
	reload(): void;
	replace(view: ItemView): void;
}

/** One item: read when the page opens, and again when the user's feed says it changed or comes back after a drop. `enabled` false asks nothing, as `useItems`. */
export function useItem(id: string, enabled = true): ItemPage {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ view: ItemView | null; error: string | null; missing: boolean }>({ view: null, error: null, missing: false });
	const asked = useRef(0);
	const shown = useRef(-1);
	// What the page holds of the feature's subtasks, or of itself as one: the feed's open subtasks are read against it.
	const held = useRef<{ parentId: string | null; children: Pick<ItemSummary, "id" | "revision" | "state">[] }>({ parentId: null, children: [] });
	const hold = (view: ItemView) => {
		shown.current = view.revision;
		held.current = view.parent ? { parentId: view.parent.itemId, children: [view] } : { parentId: view.id, children: view.children ?? [] };
	};

	const reload = useCallback(() => {
		const mine = ++asked.current;
		client
			.user(auth)
			.item(id)
			.then(
				(view) => {
					if (mine !== asked.current) return;
					hold(view);
					setState({ view, error: null, missing: false });
				},
				(failure: unknown) => mine === asked.current && setState((now) => ({ view: now.view, error: explain(failure), missing: hasReason(failure, "item_not_found") })),
			);
	}, [client, auth, explain, id]);

	const replace = useCallback((view: ItemView) => {
		asked.current += 1;
		hold(view);
		setState({ view, error: null, missing: false });
	}, []);

	useEffect(() => {
		if (!enabled) return;
		reload();
		let connected = false;
		const close = client.user(auth).watch({
			onSessions: () => undefined,
			onItems: (feed) => {
				const summary = feed.open.find((item) => item.id === id) ?? feed.ended.find((item) => item.id === id) ?? feed.children?.find((item) => item.id === id);
				// A feature's subtasks, or the subtask itself, changed: a subtask is in the feed while it is open, and its page reads it again once it ended.
				const { parentId, children } = held.current;
				const behind = parentId !== null && childrenBehind(parentId, parentId === id ? children : children.filter((child) => child.id === id), parentId === id ? feed.children : feed.children?.filter((child) => child.id === id));
				if ((summary && summary.revision > shown.current) || behind) reload();
			},
			onConnection: (connection) => {
				if (connection !== "connected") return;
				if (connected) reload();
				connected = true;
			},
		});
		return () => {
			asked.current += 1;
			close();
		};
	}, [client, auth, id, reload, enabled]);

	return { ...state, reload, replace };
}

/** What the top bar shows on this page: the way back to its repository, and which item it is. */
export function ItemCrumb({ view }: { view: ItemView | null }) {
	const repository = view?.repository ?? null;
	return (
		<nav className="crumb" aria-label="Where you are">
			<a className="crumb-back" {...linkProps(repository ? { name: "repository", id: repository.id } : { name: "home" })}>
				<ArrowLeftIcon size={14} />
				<span>{repository ? `${repository.owner}/${repository.name}` : "Agents"}</span>
			</a>
			<span className="crumb-sep" aria-hidden="true">
				/
			</span>
			{view?.parent ? (
				<>
					<a className="crumb-repo crumb-feature" {...linkProps({ name: "item", id: view.parent.itemId })} title={view.parent.title}>
						{view.parent.title}
					</a>
					<span className="crumb-sep" aria-hidden="true">
						/
					</span>
				</>
			) : null}
			<span className="crumb-title" aria-current="page">
				{view?.title ?? "Work item"}
			</span>
		</nav>
	);
}

// ---- acting on it -------------------------------------------------------------------------------

interface Acting extends PlanActing {}

/** `onConflict`: the server refused an action because the item moved on (`item_conflict`); the page reads it again. */
function useActing(id: string, onDone: (view: ItemView) => void, onConflict?: (kind: string) => void): Acting {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [failed, setFailed] = useState<Acting["failed"]>(null);
	const act = async (action: ItemAction) => {
		setBusy(action.kind === "answer" ? action.choice : action.kind);
		setError(null);
		setFailed(null);
		try {
			onDone(await client.user(auth).actOnItem(id, action));
			setBusy(null);
			return true;
		} catch (failure) {
			setError(explain(failure));
			setFailed({ kind: action.kind, reason: failure instanceof PlatformError ? (failure.reason ?? null) : null });
			setBusy(null);
			if (hasReason(failure, "item_conflict")) onConflict?.(action.kind);
			return false;
		}
	};
	return { busy, error, failed, act };
}

function Failure({ error }: { error: string | null }) {
	if (!error) return null;
	return (
		<p className="callout callout-bad" role="alert">
			<WarnIcon />
			<span>{error}</span>
		</p>
	);
}

/** Cancelling: what stops, and what stays on GitHub. */
function CancelDialog({ view, acting, onClose }: { view: ItemView; acting: Acting; onClose(): void }) {
	const busy = acting.busy === "cancel";
	return (
		<Dialog
			title="Cancel this work item?"
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={() => acting.act({ kind: "cancel" }).then((done) => done && onClose())} disabled={busy}>
						{busy ? "Cancelling…" : "Cancel item"}
					</button>
				</>
			}
		>
			<p>
				Nothing more is done for <strong>{view.title}</strong>
				{view.state === "working" ? ", and the turn that runs is stopped" : ""}. {view.pullRequest ? `Pull request #${view.pullRequest.number} stays open on GitHub until you close it there.` : "No pull request was opened for it."} Its agent and the log stay.
			</p>
			<Failure error={acting.error} />
		</Dialog>
	);
}

/** Sending work back: the note is what the agent is given; it goes on on the same branch. */
function SendBackDialog({ view, acting, onClose }: { view: ItemView; acting: Acting; onClose(): void }) {
	const [note, setNote] = useState("");
	const ids = { form: useId(), note: useId() };
	const busy = acting.busy === "send_back";
	const send = (event: FormEvent) => {
		event.preventDefault();
		if (note.trim() === "" || busy) return;
		acting.act({ kind: "send_back", note: note.trim() }).then((done) => done && onClose());
	};
	return (
		<Dialog
			title="Send it back"
			lede="Its agent gets your note and works on the same branch. The pull request is updated, and the work gets a new verdict."
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" form={ids.form} className="button button-primary" disabled={note.trim() === "" || busy}>
						{busy ? "Sending…" : "Send back"}
					</button>
				</>
			}
		>
			<form id={ids.form} className="item-form" onSubmit={send}>
				<div>
					<label className="label" htmlFor={ids.note}>
						What to change
					</label>
					<textarea id={ids.note} className="input textarea" value={note} maxLength={MAX_NOTE_CHARS} onChange={(event) => setNote(event.target.value)} readOnly={busy} data-autofocus />
					{view.pullRequest ? <p className="field-note">A review left on pull request #{view.pullRequest.number} is not read: say here what the agent should know.</p> : null}
				</div>
				<Failure error={acting.error} />
			</form>
		</Dialog>
	);
}

// ---- where it is --------------------------------------------------------------------------------

/** Where the item is now, in a sentence or two: the server's while it waits, and the log's last line once it ended. */
function Now({ view, now }: { view: ItemView; now: number }) {
	const last = view.events[view.events.length - 1] ?? null;
	const step = view.run?.step ?? null;
	let text: string;
	let when: ReactNode = null;
	switch (view.state) {
		case "draft":
			text = readFirst(view) ? "A draft: read its task below, then start it." : "A draft: nothing runs until you start it.";
			break;
		case "queued":
			text = "Started: it waits for its first turn.";
			break;
		case "working":
			text = (step && STEP_DOING[step.kind]) ?? "It is being worked on.";
			if (step) when = <span>since <When at={step.startedAt} now={now} /></span>;
			break;
		case "waiting":
			text = view.wait?.sentence ?? "It waits.";
			if (view.wait) {
				when = (
					<>
						<span>
							since <When at={view.wait.since} now={now} />
						</span>
						{view.wait.retryAt === null ? null : (
							<span>
								tried again at <When at={view.wait.retryAt} now={now} />
							</span>
						)}
					</>
				);
			}
			break;
		case "review":
			text = "Handed to you. The pull request waits for your review; the platform never merges it. When it is merged or closed on GitHub, the item says so.";
			break;
		default:
			text = last?.said ?? STATE_WORD[view.state];
			if (last) when = <span><When at={last.at} now={now} /></span>;
	}
	return (
		<div className={`item-now item-now-${view.state}${view.question ? " item-now-asks" : ""}`}>
			<span className="item-now-glyph">
				<ItemGlyph item={view} />
			</span>
			<div>
				<p className="item-now-state">
					{STATE_WORD[view.state]}
					{view.state === "working" && step ? <span className="item-now-step">{STEP_WORD[step.kind]}</span> : null}
				</p>
				<p className="item-now-text">{text}</p>
				{when ? <p className="agent-meta item-now-when">{when}</p> : null}
			</div>
		</div>
	);
}

/** The builder's sandbox started from a validated environment (SessionSummary.environment): said in one short fact. */
export function ValidatedEnvironment({ environment, now }: { environment: SessionSummary["environment"] | undefined; now: number }) {
	if (!environment) return null;
	return (
		<span className="repo-fact tone-dim" title={`Setup and ${environment.checks === 1 ? "the saved check" : `${environment.checks} saved checks`} passed at ${environment.commit.slice(0, 12)}, ${absoluteTime(environment.validatedAt)}`}>
			from a validated environment ({relativeTime(environment.validatedAt, now)})
		</span>
	);
}

/**
 * The run it is in, or ended last: its step, and the rounds of fixing it took. Rounds are not capped: a run stops when the
 * same failure comes back or its budget is used, and asks. The second review's fixes are shown once there were some.
 */
export function RunFacts({ run, events, asks, now }: { run: NonNullable<ItemView["run"]>; events: ItemEvent[]; asks: boolean; now: number }) {
	const { step, rounds } = run;
	const sentBack = events.filter((event) => event.step === null && event.said.startsWith("Sent back")).length;
	return (
		<dl className="usage-facts item-facts">
			<div>
				<dt>Run</dt>
				<dd>
					The {ordinal(run.n)}
					{run.n > 1 ? (sentBack > 0 ? `, after it was sent back ${sentBack === 1 ? "once" : plural(sentBack, "time")}` : ", after a retry") : ""}; started <When at={run.startedAt} now={now} />
					{run.endedAt !== null ? (
						<>
							, ended <When at={run.endedAt} now={now} />
						</>
					) : null}
				</dd>
			</div>
			{run.endedAt === null ? (
				<div>
					<dt>{asks ? "Stopped at" : "Step"}</dt>
					<dd>
						{STEP_WORD[step.kind]}
						{TRIED.has(step.kind) && step.attempt > 1 ? `, ${ordinal(step.attempt)} try` : ""}
						{step.turn === "delivered" ? <span className="tone-dim"> · its turn waits to start</span> : step.turn === "started" ? <span className="tone-dim"> · its turn runs</span> : null}
					</dd>
				</div>
			) : null}
			<div>
				<dt>Fixes</dt>
				<dd>
					<span className="item-rounds">
						<span>after your checks {rounds.gate}</span>
						<span>after CI {rounds.ci}</span>
						<span>merging the base {rounds.conflict}</span>
						{(rounds.review ?? 0) > 0 ? <span>after the second review {rounds.review}</span> : null}
					</span>
				</dd>
			</div>
		</dl>
	);
}

// ---- what it asks -------------------------------------------------------------------------------

const BUDGET_FIELDS: Array<{ key: keyof ItemBudget; label: string; unit: string; toInput(value: number): string; fromInput(text: string): number; spelled(value: number): string }> = [
	{ key: "tokens", label: "Tokens", unit: "millions, cost-weighted", toInput: (value) => String(Number((value / 1e6).toFixed(2))), fromInput: (text) => Math.round(Number(text) * 1e6), spelled: compact },
	{ key: "hostedSeconds", label: "Hosted sandbox time", unit: "hours", toInput: (value) => String(Number((value / 3600).toFixed(2))), fromInput: (text) => Math.round(Number(text) * 3600), spelled: sandboxTime },
];

/** The figures of an item's budget that limit it: hosted sandbox time only for an item on a hosted sandbox. */
const budgetFields = (view: Pick<ItemView, "place">) => BUDGET_FIELDS.filter((field) => field.key !== "hostedSeconds" || view.place.kind === "hosted");

/** Another amount than the question's "Give it N more": the new budget, each figure as it is, raised where it was reached. */
function RaiseBudget({ view, busy, onRaise, onBack }: { view: ItemView; busy: boolean; onRaise(budget: Partial<ItemBudget>): void; onBack(): void }) {
	const fields = budgetFields(view);
	const [values, setValues] = useState(() => Object.fromEntries(fields.map((field) => [field.key, field.toInput(view.budget[field.key])])) as Record<keyof ItemBudget, string>);
	const base = useId();
	const parsed = fields.map((field) => ({ field, value: field.fromInput(values[field.key]) }));
	const bad = parsed.some(({ value }) => !Number.isFinite(value) || value <= 0);
	const short = parsed.filter(({ field, value }) => view.spent[field.key] >= view.budget[field.key] && value <= view.spent[field.key]);
	const changed = Object.fromEntries(parsed.filter(({ field, value }) => value !== view.budget[field.key]).map(({ field, value }) => [field.key, value])) as Partial<ItemBudget>;
	return (
		<div className="item-raise">
			<div className="item-raise-fields">
				{fields.map((field) => {
					const reached = view.spent[field.key] >= view.budget[field.key];
					return (
						<div key={field.key}>
							<label className="label" htmlFor={`${base}-${field.key}`}>
								{field.label}
								{field.unit ? <span className="label-optional">{field.unit}</span> : null}
							</label>
							<input id={`${base}-${field.key}`} className={`input input-mono${reached && short.some((one) => one.field === field) ? " input-invalid" : ""}`} inputMode="decimal" value={values[field.key]} readOnly={busy} onChange={(event) => setValues((now) => ({ ...now, [field.key]: event.target.value }))} />
							<p className={`field-note${reached ? " tone-warn" : ""}`}>
								{field.spelled(view.spent[field.key])} used{reached ? ", the limit" : ""}
							</p>
						</div>
					);
				})}
			</div>
			<p className="field-note">For this item only{view.parent ? "; what you give a subtask adds to its feature's budget" : ""}. It goes on in the same session and sandbox. {short.length > 0 ? `Raise ${short.map(({ field }) => field.label.toLowerCase()).join(" and ")} above what is used, or it stops again at once.` : ""}</p>
			<div className="item-choices">
				<button type="button" className="button button-primary" disabled={busy || bad || short.length > 0 || Object.keys(changed).length === 0} onClick={() => onRaise(changed)}>
					{busy ? "Sending…" : "Give it this and go on"}
				</button>
				<button type="button" className="button button-quiet" onClick={onBack} disabled={busy}>
					Back
				</button>
			</div>
		</div>
	);
}

/** The open question: its text, its answers, and a note to the agent with any of them. */
function Question({ view, question, acting, now }: { view: ItemView; question: ItemQuestion; acting: Acting; now: number }) {
	// No agent is left to read a note once its machine was removed.
	const noted = !["machine_removed", "feedback_feature", "feedback_more"].includes(question.kind);
	const [note, setNote] = useState("");
	const [raising, setRaising] = useState(false);
	const ids = { title: useId(), note: useId(), asked: useId() };
	const busy = acting.busy !== null;
	// The agent's own question: its words are the reply's subject, and the reply is the note, so the note is needed.
	const asked = question.kind === "agent_ask" ? question.asked ?? null : null;
	const replying = question.kind === "agent_ask";
	const answer = (choice: ChoiceId, budget?: Partial<ItemBudget>) => acting.act({ kind: "answer", question: question.id, choice, ...(!noted || note.trim() === "" ? {} : { note: note.trim() }), ...(budget ? { budget } : {}) });
	return (
		<section className="item-question" aria-labelledby={ids.title}>
			<p className="item-question-head" id={ids.title}>
				It asks you
				<span className="item-question-when">
					<When at={question.askedAt} now={now} />
				</span>
			</p>
			<LongText lines={6} className="item-question-text">
				{question.text}
			</LongText>
			{question.check ? <EnvironmentCheck check={question.check} /> : null}
			{question.kind === "sandboxes" ? (
				<p className="item-question-text">
					<a className="link" {...linkProps({ name: "usage" })}>
						Free a sandbox on Usage
					</a>
				</p>
			) : null}
			{asked ? <AgentAsked id={ids.asked} asked={asked} busy={busy} onPick={setNote} /> : null}
			{raising ? (
				<RaiseBudget view={view} busy={acting.busy === "raise"} onRaise={(budget) => answer("raise", budget)} onBack={() => setRaising(false)} />
			) : (
				<>
					{noted ? (
						<div>
							<label className="label" htmlFor={ids.note}>
								{replying ? "Your answer" : <>A note to the agent<span className="label-optional">optional</span></>}
							</label>
							<textarea id={ids.note} className="input textarea item-note" value={note} maxLength={MAX_NOTE_CHARS} onChange={(event) => setNote(event.target.value)} readOnly={busy} required={replying} aria-describedby={asked ? ids.asked : undefined} />
						</div>
					) : null}
					<div className="item-choices">
						{question.choices.filter(choice => !view.parent || choice.id !== "hand_over").flatMap((choice, index) => [
							<button
								key={choice.id}
								type="button"
								className={`button ${index === 0 ? "button-primary" : choice.id === "give_up" ? "button-quiet" : "button-outline"}`}
								disabled={busy || (choice.id === "reply" && note.trim() === "")}
								onClick={() => answer(choice.id)}
							>
								{acting.busy === choice.id ? "Sending…" : choice.label}
							</button>,
							// "Give it N more" at another figure: beside it, before the other choices.
							...(choice.id === "raise" && question.kind === "budget"
								? [
										<button key="amount" type="button" className="button button-quiet" disabled={busy} onClick={() => setRaising(true)}>
											Another amount…
										</button>,
									]
								: []),
						])}
					</div>
				</>
			)}
			<Failure error={acting.error} />
		</section>
	);
}

/** A check the sandbox could not run (`check_environment`): its command and the end of what it printed, as the session shows a check's result. */
function EnvironmentCheck({ check }: { check: NonNullable<ItemQuestion["check"]> }) {
	return (
		<section className="item-check" aria-label={`The check ${check.name}`}>
			<ul className="check-list">
				<li>
					<WarnIcon size={13} className="tone-warn" />
					<span className="check-name">{check.name}</span>
					<code>{check.command}</code>
					<span className="tone-warn">
						could not run{check.exitCode !== null && check.exitCode !== 0 ? `, exit ${check.exitCode}` : ""}
					</span>
				</li>
			</ul>
			{check.excerpt !== "" ? <Output text={check.excerpt} tail label={`Output of ${check.name}`} limit={12} /> : null}
		</section>
	);
}

/**
 * The agent's question in its own words. They are the agent's, and what it read (the repository, an issue) may have steered
 * them, so they are shown as a quotation of the agent's: plain text, never Markdown or links, apart from the platform's own
 * words. An option fills the answer box; nothing is answered until the person sends it.
 */
function AgentAsked({ id, asked, busy, onPick }: { id: string; asked: NonNullable<ItemQuestion["asked"]>; busy: boolean; onPick: (text: string) => void }) {
	// Options of a sentence's length stack as full-width rows rather than wrapping as pills.
	const stacked = asked.options.some((option) => option.length > LONG_OPTION);
	return (
		<figure className="item-asked" id={id}>
			<figcaption className="item-asked-who">
				The agent wrote this. Its words may follow what it read in the repository or an issue: read them as its words, not the platform's.
			</figcaption>
			<LongText lines={6} as="blockquote" className="item-asked-text">
				{asked.text}
			</LongText>
			{asked.options.length > 0 ? (
				<div className={`item-asked-options${stacked ? " item-asked-options-stacked" : ""}`} role="group" aria-label="Answers the agent suggests">
					<span className="item-asked-options-label">It suggests</span>
					{asked.options.map((option) => (
						<button key={option} type="button" className="button button-outline button-small item-asked-option" disabled={busy} onClick={() => onPick(option)} title="Put this in your answer">
							{option}
						</button>
					))}
				</div>
			) : null}
		</figure>
	);
}

/** An option longer than this stacks all of a question's options as rows. */
const LONG_OPTION = 40;

// ---- what the agent says ------------------------------------------------------------------------

/** The verdict a report's references are read against: the one at the commit it was filed at, else its run's last, else none. */
function verdictFor(report: ItemReport, verdicts: Verdict[]): Verdict | null {
	const at = report.head === null ? undefined : verdicts.findLast((verdict) => verdict.head === report.head);
	return at ?? verdicts.findLast((verdict) => verdict.run === report.run) ?? null;
}

/** The agent that made the change, in its own words: below the checks, labelled as its own, and never what the verdict rests on. */
function Report({ view, report, links, now }: { view: ItemView; report: ItemReport; links: ScreenshotLinks; now: number }) {
	const latest = view.verdicts[view.verdicts.length - 1];
	const earlierRun = view.run !== null && report.run !== view.run.n;
	const earlierCommit = !earlierRun && report.head !== null && latest !== undefined && latest.head !== report.head;
	const shots = report.screenshots ?? [];
	return (
		<section className="usage-section" aria-labelledby="item-report">
			<h2 className="usage-title" id="item-report">
				From the agent that made the change
			</h2>
			<p className="usage-lede">{earlierRun ? `From its report in the ${ordinal(report.run)} run. ` : ""}Its own words, filed with its report: the checks above do not rest on them.</p>
			<article className="item-verdict-block">
				<p className="item-verdict-head">
					<span className="item-report-title">{report.title}</span>
					<span className="agent-meta">
						<span>
							filed <When at={report.at} now={now} />
						</span>
						{earlierRun ? <span>the {ordinal(report.run)} run</span> : null}
						{report.head !== null ? <span>at {report.head.slice(0, 7)}</span> : <span>before a push</span>}
						{earlierCommit ? <span>an earlier commit than the verdict's</span> : null}
					</span>
				</p>
				<ReviewBlocks blocks={report.blocks} records={report.records ?? []} verdict={verdictFor(report, view.verdicts)} author="The agent" screenshots={{ shots, links }} />
			</article>
		</section>
	);
}

// ---- what it cost -------------------------------------------------------------------------------

/** What an item spent that no budget of its holds: its turns and its working time, said and not metered. */
function spendFacts(view: ItemView): { label: string; value: string }[] {
	return [
		{ label: "Turns", value: plural(view.spent.turns, "turn") },
		{ label: "Working time", value: sandboxTime(view.spent.activeSeconds) },
	];
}

function Cost({ view, now }: { view: ItemView; now: number }) {
	const step = view.run?.step;
	const rows = budgetFields(view);
	const hosted = view.place.kind === "hosted";
	return (
		<section className="usage-section" aria-labelledby="item-cost">
			<h2 className="usage-title" id="item-cost">
				Cost so far
			</h2>
			<p className="usage-note">
				Built by <AgentGlyph harness={view.agent?.harness ?? "windlass"} size={11} inline />
				{agentLine(view.agent)}.
			</p>
			{view.state === "working" && view.spent.turns === 0 && step?.turn === "started" && (
				<p className="usage-note">Spend is counted when the running turn ends. This step started {sandboxTime((now - step.startedAt) / 1000)} ago.</p>
			)}
			<ItemSpend spent={view.spent} budget={view.budget} fields={rows} agent={view.agent} />
			{[...spendFacts(view), ...agentFacts(view.agent)].length > 0 ? (
				<dl className="usage-facts item-facts">
					{[...spendFacts(view), ...agentFacts(view.agent)].map((fact) => (
						<div key={fact.label}>
							<dt>{fact.label}</dt>
							<dd className="usage-number">{fact.value}</dd>
						</div>
					))}
				</dl>
			) : null}
			<p className="usage-note">
				Tokens count cost-weighted: an input token read from the prompt cache counts as a tenth. When the budget is used, the item asks you for more and keeps its work.{" "}
				{hosted
					? "Working time counts only while the item works: waiting for a turn, for CI or for you does not."
					: "Working time counts only while the item works: waiting for a turn, for your machine, for CI or for you does not. On your machine it costs no hosted time."}
			</p>
		</section>
	);
}

// ---- what happened ------------------------------------------------------------------------------

interface RunPart {
	run: number;
	events: ItemEvent[];
}

/** The log in runs. An entry outside any step (started, sent back) belongs to the run that follows it; one after every step, to the last. */
function partsOf(events: ItemEvent[]): RunPart[] {
	const runs: Array<number | null> = events.map((event) => event.step?.run ?? null);
	let next: number | null = null;
	for (let index = runs.length - 1; index >= 0; index--) runs[index] = next = runs[index] ?? next;
	const parts: RunPart[] = [];
	events.forEach((event, index) => {
		const run = runs[index] ?? parts[parts.length - 1]?.run ?? 1;
		const last = parts[parts.length - 1];
		if (last?.run === run) last.events.push(event);
		else parts.push({ run, events: [event] });
	});
	return parts;
}

function LogEntry({ event, now, uid }: { event: ItemEvent; now: number; uid: string }) {
	const person = event.by.startsWith("person:");
	return (
		<li className="item-event">
			<span className="item-event-time">
				<When at={event.at} now={now} />
			</span>
			<span className="item-event-step">{event.step ? STEP_WORD[event.step.kind] : ""}</span>
			<LongText lines={2} className="item-event-said">
				<InlineMarkdown text={event.said} />
				{person ? <span className="tone-faint"> · {event.by === `person:${uid}` ? "you" : "a person"}</span> : null}
			</LongText>
			{/* The agent's own question, kept after it was answered: its words in plain text, as `AgentAsked` shows them. */}
			{event.asked ? (
				<figure className="item-event-asked">
					<figcaption className="item-asked-who">The agent asked:</figcaption>
					<blockquote className="item-asked-text">{event.asked}</blockquote>
				</figure>
			) : null}
		</li>
	);
}

function Log({ view, now }: { view: ItemView; now: number }) {
	const auth = useAuth();
	const parts = partsOf(view.events);
	const [open, setOpen] = useState<Set<number>>(() => new Set());
	const current = parts[parts.length - 1]?.run ?? 0;
	const runs = new Set(parts.map((part) => part.run)).size;
	return (
		<section className="usage-section" aria-labelledby="item-log">
			<h2 className="usage-title" id="item-log">
				What happened
				{view.events.length > 0 ? <span className="usage-count">{view.events.length}</span> : null}
			</h2>
			{parts.length === 0 ? (
				<p className="usage-empty">Nothing yet: it has not been started.</p>
			) : (
				parts.map((part, index) => {
					const folded = part.run !== current && !open.has(index);
					const id = `item-run-${index}`;
					return (
						<div key={index} className="item-log-run">
							{runs > 1 ? (
								<p className="items-group-head item-log-head">
									{part.run === current ? `The ${ordinal(part.run)} run` : (
										<button type="button" className="link machine-toggle" aria-expanded={!folded} aria-controls={id} onClick={() => setOpen((now) => new Set(now.has(index) ? [...now].filter((one) => one !== index) : [...now, index]))}>
											<ChevronIcon size={11} className="machine-chevron" />
											The {ordinal(part.run)} run
										</button>
									)}
									<span className="items-group-count">{plural(part.events.length, "entry", "entries")}</span>
								</p>
							) : null}
							<ol className="item-log" id={id} hidden={folded}>
								{part.events.map((event, at) => (
									<LogEntry key={at} event={event} now={now} uid={auth.profile.uid} />
								))}
							</ol>
						</div>
					);
				})
			)}
		</section>
	);
}

// ---- where it came from, and what it asks the agent to do ---------------------------------------

/** A draft from an issue someone else wrote: its task is that person's text, which its person reads before starting it. */
const readFirst = (item: Pick<ItemView, "state" | "origin">) => item.state === "draft" && item.origin?.issue.trusted === false;

/** The issue an item was filed from, under its title: its link, who filed it, and who wrote it where that is someone else. */
function IssueOrigin({ origin }: { origin: NonNullable<ItemView["origin"]> }) {
	const { issue, sender } = origin;
	return (
		<p className="home-account item-origin">
			<span>
				From{" "}
				<a className="item-link" href={issue.url} target="_blank" rel="noreferrer">
					issue #{issue.number}
					<ExternalIcon size={10} />
				</a>
				, {issue.trusted ? `filed by @${sender}.` : `written by @${issue.author} and filed by @${sender}.`}
			</span>
		</p>
	);
}

/** What the agent is given, as it is given it: plain text, never Markdown or links. */
/** `codeSpans`: `code` in the criteria drawn in the mono face; not for text shown as the agent will be given it. */
function TaskText({ task, codeSpans = false }: { task: ItemView["task"]; codeSpans?: boolean }) {
	return (
		<>
			{task.body ? (
				<LongText lines={6} className="item-body-text">
					{task.body}
				</LongText>
			) : (
				<p className="usage-empty">Only the title was given.</p>
			)}
			{task.acceptance.length > 0 ? (
				<>
					<p className="machine-label item-task-label">Acceptance criteria</p>
					<ul className="item-criteria-list">
						{task.acceptance.map((line) => (
							<li key={line}>{codeSpans ? <Inline text={line} /> : line}</li>
						))}
					</ul>
				</>
			) : null}
		</>
	);
}

/** A draft's task in someone else's words: whose they are, the text itself, and Start under it. */
function ReadFirst({ view, acting }: { view: ItemView; acting: Acting }) {
	const author = view.origin?.issue.author ?? "";
	return (
		<section className="usage-section" aria-labelledby="item-task">
			<h2 className="usage-title" id="item-task">
				The task
			</h2>
			<div className="item-read">
				<p className="callout callout-info">
					<InfoIcon />
					<span>The text below was written by @{author} on GitHub, not by you. Starting the item gives the agent this text, as it is shown here.</span>
				</p>
				<div className="item-snapshot">
					<TaskText task={view.task} />
				</div>
				<div className="item-choices">
					<button type="button" className="button button-primary" onClick={() => acting.act({ kind: "start" })} disabled={acting.busy !== null}>
						{acting.busy === "start" ? "Starting…" : "Start"}
					</button>
				</div>
				<Failure error={acting.error} />
			</div>
		</section>
	);
}

// ---- the page -----------------------------------------------------------------------------------

/**
 * "Allow for this repository" on the item's Network block, sent through its builder's session, whose
 * repository is the item's. None for a feature over several repositories, which names no repository for
 * a host, or before the item has a session.
 */
function useAllowHost(view: ItemView | null): AllowHostContext | null {
	const { client, explain } = useApp();
	const auth = useAuth();
	const sessionId = view?.sessionId ?? "";
	const several = (view?.repositories?.length ?? 1) > 1;
	const repositoryId = view?.repository.id ?? null;
	const allow = useCallback(
		async (host: string) => {
			try {
				return await client.session(auth, sessionId).allowHost(host);
			} catch (failure) {
				throw new Error(explain(failure));
			}
		},
		[client, auth, sessionId, explain],
	);
	return useMemo(() => (several || !sessionId || repositoryId === null ? null : { allow, repositoryId }), [several, sessionId, repositoryId, allow]);
}

export function Item({ page }: { page: ItemPage }) {
	const now = useNow(30_000);
	const { sessions } = useSessions();
	const { view } = page;
	// A plan action refused because the plan moved on: the page reads the item again, and its card says so until the next action.
	const [conflicted, setConflicted] = useState(false);
	const acting = useActing(
		view?.id ?? "",
		(next) => {
			setConflicted(false);
			page.replace(next);
		},
		(kind) => {
			if (kind === "edit_plan" || kind === "approve_plan") setConflicted(true);
			page.reload();
		},
	);
	// Both agents' screenshots, the builder's and the second reviewer's: their links are asked in one question.
	const links = useScreenshotLinks(view?.id ?? "", view ? [...(view.report?.screenshots ?? []), ...view.reviews.flatMap(reviewShots)] : []);
	const [dialog, setDialog] = useState<"cancel" | "send_back" | null>(null);
	const review = usePlanReview(view, acting);
	// Undefined for a hosted item and while the list is read; null once its machine is known to be removed.
	const machine = useSessionMachine(view?.place);
	const { platform } = useApp();
	const allowContext = useAllowHost(view);
	// A subtask's feature, for its siblings: read as the feature's own page is, and kept current by the feed.
	const feature = useItem(view?.parent?.itemId ?? "", Boolean(view?.parent));

	if (view === null) {
		return (
			<main className="home usage repo item">
				<section className="usage-section">
					{page.error ? (
						<div className="state state-error" role="alert">
							<WarnIcon size={22} />
							<h2>{page.missing ? "This work item is not one of yours" : "The work item could not be loaded"}</h2>
							<p>{page.error}</p>
							{page.missing ? (
								<a className="button button-outline" {...linkProps({ name: "home" })}>
									Back to your agents
								</a>
							) : (
								<button type="button" className="button button-outline" onClick={page.reload}>
									Try again
								</button>
							)}
						</div>
					) : (
						<div className="usage-loading" aria-busy="true" aria-label="Loading the work item">
							<span className="skeleton skeleton-title" style={{ width: "44%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						</div>
					)}
				</section>
			</main>
		);
	}

	const ended = view.state === "done" || view.state === "cancelled";
	const busy = acting.busy !== null;
	const reviewer = platform.info?.items?.reviewer !== false;
	const { repository } = view;
	const reading = readFirst(view);

	return (
		<main className="home usage repo item">
			<header className="home-head">
				<div className="repo-head">
					<p className="eyebrow">
						{view.parent ? (
							<>
								subtask of{" "}
								<a className="eyebrow-link" {...linkProps({ name: "item", id: view.parent.itemId })}>
									{view.parent.title}
								</a>
							</>
						) : (
							<>
								{view.mode === "orchestrate" ? "Plan first" : view.plan ? "Plan first · one implementer" : "Quick"} · {view.source === "github" ? "from GitHub" : view.source === "api" ? "from the API" : "from the web"}
							</>
						)}
					</p>
					<h1 className="display display-small item-title">{view.title}</h1>
					{view.parent && feature.view?.plan ? <SubtaskStrip plan={feature.view.plan} children={feature.view.children ?? []} current={view.parent.key} /> : null}
					<p className="home-account repo-facts">
						<a className="repo-link" {...linkProps({ name: "repository", id: repository.id })}>
							{repository.owner}/{repository.name}
						</a>
						<span className="repo-fact">into {view.task.base}</span>
						{view.place.kind === "machine" ? <span className="repo-fact">{machine === null ? "on a machine that was removed" : machine ? `on your machine “${machineLabel(machine)}”` : "on your machine"}</span> : view.placement ? <span className="repo-fact">runs on {view.placement.name}</span> : null}
						{view.pullRequest ? (
							<a className="repo-link" href={view.pullRequest.url} target="_blank" rel="noreferrer">
								Pull request #{view.pullRequest.number}
								<ExternalIcon size={11} />
							</a>
						) : null}
						<a className="repo-link" {...linkProps({ name: "session", id: view.sessionId })} title="What its agent did, turn by turn">
							Open the agent
						</a>
						<ValidatedEnvironment environment={sessions?.find((s) => s.id === view.sessionId)?.environment} now={now} />
						{view.reviewerSessionId ? (
							<a className="repo-link" {...linkProps({ name: "session", id: view.reviewerSessionId })}>
								Open the reviewer
							</a>
						) : null}
						<span className="repo-fact tone-dim" title={absoluteTime(view.createdAt)}>
							filed {relativeTime(view.createdAt, now)}
						</span>
						{view.endedAt !== undefined ? (
							<span className="repo-fact tone-dim" title={absoluteTime(view.endedAt)}>
								ended {relativeTime(view.endedAt, now)}
							</span>
						) : null}
					</p>
					{!view.parent && !view.plan ? <p className="field-note">{ITEM_MODE_WORDS[view.mode ?? "single"].description}</p> : null}
					{view.origin ? <IssueOrigin origin={view.origin} /> : null}
				</div>
				<div className="item-actions">
					{view.state === "draft" && !reading ? (
						<button type="button" className="button button-primary" onClick={() => acting.act({ kind: "start" })} disabled={busy}>
							{acting.busy === "start" ? "Starting…" : "Start"}
						</button>
					) : null}
					{view.state === "failed" && (view.canRetry ?? (!view.parent && view.mode !== "orchestrate")) && machine !== null ? (
						<button type="button" className="button button-primary" onClick={() => acting.act({ kind: "retry" })} disabled={busy}>
							{acting.busy === "retry" ? "Starting…" : "Retry"}
						</button>
					) : null}
					{view.mode !== "orchestrate" && view.state === "review" && machine !== null ? (
						<button type="button" className="button button-outline" onClick={() => setDialog("send_back")} disabled={busy}>
							Send back…
						</button>
					) : null}
					{ended ? null : (
						<button type="button" className="button button-quiet" onClick={() => setDialog("cancel")} disabled={busy}>
							Cancel…
						</button>
					)}
				</div>
			</header>

			{page.error ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>{page.error} What is shown may be behind.</span>
				</p>
			) : null}
			{dialog === null && !view.question && !reading ? <Failure error={acting.error} /> : null}
			{conflicted && !planOpen(view) ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>The plan changed while you read it, and is no longer waiting for approval. What is shown now is the latest.</span>
				</p>
			) : null}

			<section className="usage-section item-where" aria-label="Where it is">
				<ItemStages item={view} reviewer={reviewer} step={view.run?.step.kind ?? null} />
				{/* A question is where the item is: its own block says so, with when it was asked. */}
				{view.question && planOpen(view) ? (
					<PlanQuestion view={view} review={review} acting={acting} conflicted={conflicted} when={<When at={view.question.askedAt} now={now} />} />
				) : view.question?.kind === "placement_refused" && view.plan ? (
					<PlacementQuestion key={view.question.id} view={view} question={view.question} review={review} acting={acting} when={<When at={view.question.askedAt} now={now} />} />
				) : view.question ? (
					<Question key={view.question.id} view={view} question={view.question} acting={acting} now={now} />
				) : showsSubtasks(view) ? (
					<SubtasksBlock plan={view.plan!} children={view.children ?? []} now={now} />
				) : (
					<Now view={view} now={now} />
				)}
				{view.run ? <RunFacts run={view.run} events={view.events} asks={view.question !== null} now={now} /> : null}
			</section>

			{view.plan ? (
				<div id={`feature-plan-${view.plan.version}`}><PlanSection view={view} review={review} acting={acting} /></div>
			) : view.children?.length ? (
				<section className="usage-section" aria-label="Subtasks">
					<h2 className="usage-title">Subtasks</h2>
					<ul className="agents">
						{view.children.map((child) => (
							<ItemRow key={child.id} item={child} now={now} why={child.question?.text} reviewer={false} />
						))}
					</ul>
				</section>
			) : null}
			{reading ? <ReadFirst view={view} acting={acting} /> : null}

			<ItemChecks view={view} links={links} when={(at) => <When at={at} now={now} />} />

			<ItemNetwork network={view.blockedNetwork} context={allowContext} now={now} />
			{view.report ? <Report view={view} report={view.report} links={links} now={now} /> : null}
			<Cost view={view} now={now} />

			{reading ? null : (
				<section className="usage-section" aria-labelledby="item-task">
					<h2 className="usage-title" id="item-task">
						The task
					</h2>
					<TaskText task={view.task} codeSpans />
				</section>
			)}

			<Log view={view} now={now} />

			{dialog === "cancel" ? <CancelDialog view={view} acting={acting} onClose={() => setDialog(null)} /> : null}
			{dialog === "send_back" ? <SendBackDialog view={view} acting={acting} onClose={() => setDialog(null)} /> : null}
		</main>
	);
}
