/**
 * A work item's page: where a person decides whether to trust a pull request they did not watch being
 * made. It says, each at a glance: where the item is and what it waits for, what it asks, what ran
 * (the run and its step, and the log), what the verdict rests on (CI first, which decides; the user's
 * checks where they set any; the flags; the criteria left to the person), and what it cost against its
 * budget.
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
 */
import { MAX_NOTE_CHARS, type ChoiceId, type ItemAction, type ItemBudget, type ItemEvent, type ItemQuestion, type ItemView, type StepKind, type Verdict } from "@contract";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { hasReason } from "../api/client";
import { Dialog } from "../components/Dialog";
import { InlineMarkdown } from "../components/Blocks";
import { ArrowLeftIcon, ChevronIcon, ExternalIcon, WarnIcon } from "../components/Icons";
import { absoluteTime, compact, plural, relativeTime, sandboxTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { ItemGlyph, STATE_WORD, VerdictWord } from "./Items";

/** The steps in words. Planning is not offered yet; the rest are every step a run goes through. */
const STEP_WORD: Record<StepKind, string> = {
	refine: "Planning",
	implement: "Implementing",
	gate: "Checks",
	publish: "Pushing",
	ci: "Waiting for CI",
	ci_fix: "Fixing CI",
	conflict: "Merging the base",
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
};

/** Steps that are a turn of the agent, or a push: a second attempt of one is worth saying. Waits on GitHub count every poll as an attempt, which is not. */
const TRIED: ReadonlySet<StepKind> = new Set(["refine", "implement", "ci_fix", "conflict", "publish"]);

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

	const reload = useCallback(() => {
		const mine = ++asked.current;
		client
			.user(auth)
			.item(id)
			.then(
				(view) => {
					if (mine !== asked.current) return;
					shown.current = view.revision;
					setState({ view, error: null, missing: false });
				},
				(failure: unknown) => mine === asked.current && setState((now) => ({ view: now.view, error: explain(failure), missing: hasReason(failure, "item_not_found") })),
			);
	}, [client, auth, explain, id]);

	const replace = useCallback((view: ItemView) => {
		asked.current += 1;
		shown.current = view.revision;
		setState({ view, error: null, missing: false });
	}, []);

	useEffect(() => {
		if (!enabled) return;
		reload();
		let connected = false;
		const close = client.user(auth).watch({
			onSessions: () => undefined,
			onItems: (list) => {
				const summary = list.find((item) => item.id === id);
				if (summary && summary.revision > shown.current) reload();
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
			<span className="crumb-title" aria-current="page">
				{view?.title ?? "Work item"}
			</span>
		</nav>
	);
}

// ---- acting on it -------------------------------------------------------------------------------

interface Acting {
	/** The action in flight, by its kind (or the chosen answer's id). */
	busy: string | null;
	error: string | null;
	act(action: ItemAction): Promise<boolean>;
}

function useActing(id: string, onDone: (view: ItemView) => void): Acting {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const act = async (action: ItemAction) => {
		setBusy(action.kind === "answer" ? action.choice : action.kind);
		setError(null);
		try {
			onDone(await client.user(auth).actOnItem(id, action));
			setBusy(null);
			return true;
		} catch (failure) {
			setError(explain(failure));
			setBusy(null);
			return false;
		}
	};
	return { busy, error, act };
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
			text = "A draft: nothing runs until you start it.";
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

/** The run it is in, or ended last: its step, and the rounds of fixing used of what a run allows. */
function RunFacts({ run, events, asks, now }: { run: NonNullable<ItemView["run"]>; events: ItemEvent[]; asks: boolean; now: number }) {
	const { step, rounds, caps } = run;
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
						<span>
							after your checks {rounds.gate} of {caps.gate}
						</span>
						<span>
							after CI {rounds.ci} of {caps.ci}
						</span>
						<span>
							merging the base {rounds.conflict} of {caps.conflict}
						</span>
					</span>
				</dd>
			</div>
		</dl>
	);
}

// ---- what it asks -------------------------------------------------------------------------------

const BUDGET_FIELDS: Array<{ key: keyof ItemBudget; label: string; unit: string; toInput(value: number): string; fromInput(text: string): number; spelled(value: number): string }> = [
	{ key: "tokens", label: "Tokens", unit: "millions", toInput: (value) => String(Number((value / 1e6).toFixed(2))), fromInput: (text) => Math.round(Number(text) * 1e6), spelled: compact },
	{ key: "turns", label: "Turns", unit: "", toInput: String, fromInput: (text) => Math.round(Number(text)), spelled: String },
	{ key: "activeSeconds", label: "Working time", unit: "hours", toInput: (value) => String(Number((value / 3600).toFixed(2))), fromInput: (text) => Math.round(Number(text) * 3600), spelled: sandboxTime },
	{ key: "hostedSeconds", label: "Hosted sandbox time", unit: "hours", toInput: (value) => String(Number((value / 3600).toFixed(2))), fromInput: (text) => Math.round(Number(text) * 3600), spelled: sandboxTime },
];

/** The new budget, for "Raise the limit and go on" on a budget question: each figure as it is, to be raised where it was reached. */
function RaiseBudget({ view, busy, onRaise, onBack }: { view: ItemView; busy: boolean; onRaise(budget: Partial<ItemBudget>): void; onBack(): void }) {
	const [values, setValues] = useState(() => Object.fromEntries(BUDGET_FIELDS.map((field) => [field.key, field.toInput(view.budget[field.key])])) as Record<keyof ItemBudget, string>);
	const base = useId();
	const parsed = BUDGET_FIELDS.map((field) => ({ field, value: field.fromInput(values[field.key]) }));
	const bad = parsed.some(({ value }) => !Number.isFinite(value) || value <= 0);
	const short = parsed.filter(({ field, value }) => view.spent[field.key] >= view.budget[field.key] && value <= view.spent[field.key]);
	const changed = Object.fromEntries(parsed.filter(({ field, value }) => value !== view.budget[field.key]).map(({ field, value }) => [field.key, value])) as Partial<ItemBudget>;
	return (
		<div className="item-raise">
			<div className="item-raise-fields">
				{BUDGET_FIELDS.map((field) => {
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
			<p className="field-note">For this item only. {short.length > 0 ? `Raise ${short.map(({ field }) => field.label.toLowerCase()).join(" and ")} above what is used, or it stops again at once.` : ""}</p>
			<div className="item-choices">
				<button type="button" className="button button-primary" disabled={busy || bad || short.length > 0 || Object.keys(changed).length === 0} onClick={() => onRaise(changed)}>
					{busy ? "Sending…" : "Raise and go on"}
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
	const [note, setNote] = useState("");
	const [raising, setRaising] = useState(false);
	const ids = { title: useId(), note: useId() };
	const busy = acting.busy !== null;
	const answer = (choice: ChoiceId, budget?: Partial<ItemBudget>) => acting.act({ kind: "answer", question: question.id, choice, ...(note.trim() === "" ? {} : { note: note.trim() }), ...(budget ? { budget } : {}) });
	return (
		<section className="item-question" aria-labelledby={ids.title}>
			<p className="item-question-head" id={ids.title}>
				It asks you
				<span className="item-question-when">
					<When at={question.askedAt} now={now} />
				</span>
			</p>
			<p className="item-question-text">{question.text}</p>
			{raising ? (
				<RaiseBudget view={view} busy={acting.busy === "raise"} onRaise={(budget) => answer("raise", budget)} onBack={() => setRaising(false)} />
			) : (
				<>
					<div>
						<label className="label" htmlFor={ids.note}>
							A note to the agent<span className="label-optional">optional</span>
						</label>
						<textarea id={ids.note} className="input textarea item-note" value={note} maxLength={MAX_NOTE_CHARS} onChange={(event) => setNote(event.target.value)} readOnly={busy} />
					</div>
					<div className="item-choices">
						{question.choices.map((choice, index) => (
							<button
								key={choice.id}
								type="button"
								className={`button ${index === 0 ? "button-primary" : choice.id === "give_up" ? "button-quiet" : "button-outline"}`}
								disabled={busy}
								onClick={() => (choice.id === "raise" && question.kind === "budget" ? setRaising(true) : answer(choice.id))}
							>
								{acting.busy === choice.id ? "Sending…" : choice.label}
							</button>
						))}
					</div>
				</>
			)}
			<Failure error={acting.error} />
		</section>
	);
}

// ---- what the verdict rests on ------------------------------------------------------------------

const CHECK_WORD: Record<Verdict["gate"]["required"][number]["status"], string> = { passed: "passed", failed: "failed", timed_out: "timed out", could_not_start: "could not start", interrupted: "was interrupted" };
const CHECK_TONE: Record<Verdict["gate"]["required"][number]["status"], string> = { passed: "good", failed: "bad", timed_out: "bad", could_not_start: "warn", interrupted: "warn" };
const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

/** A run's conclusions that are a failure (server/src/factory/verdict.ts, `FAILING_CONCLUSIONS`): `error` is a commit status that errored. */
const FAILING_CONCLUSIONS = ["failure", "timed_out", "startup_failure", "action_required", "error"];

/** CI's tone: a failure is bad; CI that was not read, or not in full, or had not finished is a quiet warning; passed and none are plain facts. */
const CI_TONE: Partial<Record<Verdict["ci"]["state"], string>> = { failed: "tone-bad", not_permitted: "tone-warn", timed_out: "tone-warn", unread: "tone-warn" };

/** What the gate said when none of the user's checks is listed. */
function gateWords(gate: Verdict["gate"]): string {
	switch (gate.state) {
		case null:
			return "No record of the checks for this commit.";
		case "passed":
			return "None of yours ran; the repository's own checks passed.";
		case "unresolved":
			return "None of yours ran; the repository's own checks did not pass.";
		case "not_needed":
			return gate.unneeded?.on === "run" ? "No check needed to run again: they had passed on this state of the work." : "No check verified this state of the work.";
		case "none_set":
			return "None saved for this repository. CI decides.";
		case "off":
			return "The repository's own file turned verification off.";
		case "emptied":
			return "The repository's own file names an empty list of checks.";
		case "no_sandbox":
			return "Checks could not run in this sandbox.";
		case "not_handed":
			return "Your checks could not be handed to the agent's sandbox.";
		case "not_in_force":
			return "No checks were in force.";
		case "stopped":
			return "The turn was stopped before its checks finished.";
		case "failed":
			return "The turn failed before its checks finished.";
	}
}

function VerdictBlock({ verdict, view, now }: { verdict: Verdict; view: ItemView; now: number }) {
	const { gate, ci } = verdict;
	const { said } = verdict;
	return (
		<article className="item-verdict-block">
			<p className="item-verdict-head">
				<VerdictWord verdict={{ result: verdict.result, flags: verdict.flags, ci: verdict.ci.state }} />
				<span className="agent-meta">
					<span>at {verdict.head.slice(0, 7)}</span>
					<span>
						<When at={verdict.at} now={now} />
					</span>
					{view.verdicts.length > 1 ? <span>the {ordinal(verdict.run)} run</span> : null}
				</span>
			</p>
			<dl className="usage-facts item-facts">
				<div>
					<dt>CI</dt>
					<dd>
						<InlineMarkdown className={CI_TONE[ci.state]} text={said.ci} />
						{ci.runs.length > 0 ? (
							<ul className="item-checks">
								{ci.runs.map((run) => (
									<li key={`${run.app}/${run.name}`}>
										<a className="item-check-name item-link" href={run.url} target="_blank" rel="noreferrer">
											{run.name}
											<ExternalIcon size={10} />
										</a>{" "}
										<span className={run.conclusion === "success" ? "tone-good" : run.conclusion === "" ? "tone-dim" : FAILING_CONCLUSIONS.includes(run.conclusion) ? "tone-bad" : "tone-dim"}>{run.conclusion === "" ? "still running" : run.conclusion.replace(/_/g, " ")}</span>
										{run.app === "github-actions" ? null : <span className="tone-dim"> · {run.app === "status" ? "a commit status" : run.app}</span>}
									</li>
								))}
							</ul>
						) : null}
					</dd>
				</div>
				<div>
					<dt>Your checks</dt>
					<dd>
						{gate.required.length === 0 ? (
							gateWords(gate)
						) : (
							<ul className="item-checks">
								{gate.required.map((check) => (
									<li key={check.name}>
										<span className="item-check-name">{check.name}</span> <span className={`tone-${CHECK_TONE[check.status]}`}>{CHECK_WORD[check.status]}</span>
										{check.sentBack > 0 ? <span className="tone-dim">, after the agent was sent back {times(check.sentBack)}</span> : null}
									</li>
								))}
							</ul>
						)}
					</dd>
				</div>
				{verdict.flags.length > 0 ? (
					<div>
						<dt>To look at</dt>
						<dd>
							<ul className="item-checks">
								{verdict.flags.map((flag, index) => (
									<li key={flag.kind}>
										<span className="tone-warn">
											<InlineMarkdown text={said.flags[index] ?? flag.kind} />:
										</span> <code className="item-paths">{flag.where.join(", ")}</code>
									</li>
								))}
							</ul>
						</dd>
					</div>
				) : null}
				{verdict.acceptance.length > 0 ? (
					<div>
						<dt>For you to check</dt>
						<dd>
							<ul className="item-criteria-list">
								{verdict.acceptance.map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
							<span className="usage-gloss">No machine checked these.</span>
						</dd>
					</div>
				) : null}
				<div>
					<dt>Merging</dt>
					<dd className={verdict.mergeable === false ? "tone-warn" : undefined}>
						{verdict.mergeable === false ? "GitHub says the pull request conflicts with its base." : verdict.mergeable ? "GitHub says it can be merged." : "GitHub had not said whether it can be merged."}
					</dd>
				</div>
			</dl>
		</article>
	);
}

function Verdicts({ view, now }: { view: ItemView; now: number }) {
	const [open, setOpen] = useState(false);
	const earlier = useId();
	const latest = view.verdicts[view.verdicts.length - 1];
	const before = view.verdicts.slice(0, -1).reverse();
	return (
		<section className="usage-section" aria-labelledby="item-verdict">
			<h2 className="usage-title" id="item-verdict">
				Verdict
			</h2>
			<p className="usage-lede">What the pushed work rests on: CI on the pushed commit, your checks where you set them, and what was seen in the changes; never the agent's words. A verdict merges nothing.</p>
			{latest === undefined ? (
				<p className="usage-empty">None yet: a verdict is made when the work is handed over.</p>
			) : (
				<>
					<VerdictBlock verdict={latest} view={view} now={now} />
					{before.length > 0 ? (
						<>
							<p className="agents-fold items-fold">
								<button type="button" className="link machine-toggle" aria-expanded={open} aria-controls={earlier} onClick={() => setOpen((value) => !value)}>
									<ChevronIcon size={11} className="machine-chevron" />
									{open ? "Hide the earlier verdicts" : `Show ${plural(before.length, "earlier verdict")}`}
								</button>
							</p>
							<div id={earlier} hidden={!open}>
								{before.map((verdict) => (
									<VerdictBlock key={verdict.id} verdict={verdict} view={view} now={now} />
								))}
							</div>
						</>
					) : null}
				</>
			)}
		</section>
	);
}

// ---- what it cost -------------------------------------------------------------------------------

function Cost({ view }: { view: ItemView }) {
	const rows = BUDGET_FIELDS.filter((field) => field.key !== "hostedSeconds" || view.place.kind === "hosted");
	return (
		<section className="usage-section" aria-labelledby="item-cost">
			<h2 className="usage-title" id="item-cost">
				Cost so far
			</h2>
			<dl className="usage-facts item-facts item-cost">
				{rows.map((field) => {
					const spent = view.spent[field.key];
					const budget = view.budget[field.key];
					const reached = spent >= budget;
					return (
						<div key={field.key}>
							<dt>{field.label}</dt>
							<dd className="usage-number">
								{field.spelled(spent)} <span className="tone-faint">of {field.spelled(budget)}</span>
							</dd>
							<dd className="item-cost-meter">
								<span className="usage-meter" aria-hidden="true">
									<span className={`usage-meter-used${reached ? " item-meter-reached" : ""}`} style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} />
								</span>
								{reached ? <span className="tone-warn">reached</span> : null}
							</dd>
						</div>
					);
				})}
			</dl>
			<p className="usage-note">Working time counts only while the item works: waiting for a turn, for CI or for you does not.</p>
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
			<p className="item-event-said">
				<InlineMarkdown text={event.said} />
				{person ? <span className="tone-faint"> · {event.by === `person:${uid}` ? "you" : "a person"}</span> : null}
			</p>
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

// ---- the page -----------------------------------------------------------------------------------

export function Item({ page }: { page: ItemPage }) {
	const now = useNow(30_000);
	const { view } = page;
	const acting = useActing(view?.id ?? "", page.replace);
	const [dialog, setDialog] = useState<"cancel" | "send_back" | null>(null);

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
	const { repository } = view;

	return (
		<main className="home usage repo item">
			<header className="home-head">
				<div className="repo-head">
					<p className="eyebrow">work item · {view.source === "api" ? "from the API" : "from the web"}</p>
					<h1 className="display display-small item-title">{view.title}</h1>
					<p className="home-account repo-facts">
						<a className="repo-link" {...linkProps({ name: "repository", id: repository.id })}>
							{repository.owner}/{repository.name}
						</a>
						<span className="repo-fact">into {view.task.base}</span>
						{view.pullRequest ? (
							<a className="repo-link" href={view.pullRequest.url} target="_blank" rel="noreferrer">
								Pull request #{view.pullRequest.number}
								<ExternalIcon size={11} />
							</a>
						) : null}
						<a className="repo-link" {...linkProps({ name: "session", id: view.sessionId })}>
							Open the agent
						</a>
						<span className="repo-fact tone-dim" title={absoluteTime(view.createdAt)}>
							filed {relativeTime(view.createdAt, now)}
						</span>
					</p>
				</div>
				<div className="item-actions">
					{view.state === "draft" ? (
						<button type="button" className="button button-primary" onClick={() => acting.act({ kind: "start" })} disabled={busy}>
							{acting.busy === "start" ? "Starting…" : "Start"}
						</button>
					) : null}
					{view.state === "failed" ? (
						<button type="button" className="button button-primary" onClick={() => acting.act({ kind: "retry" })} disabled={busy}>
							{acting.busy === "retry" ? "Starting…" : "Retry"}
						</button>
					) : null}
					{view.state === "review" ? (
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
			{dialog === null && !view.question ? <Failure error={acting.error} /> : null}

			<section className="usage-section item-where" aria-label="Where it is">
				{/* A question is where the item is: its own block says so, with when it was asked. */}
				{view.question ? <Question key={view.question.id} view={view} question={view.question} acting={acting} now={now} /> : <Now view={view} now={now} />}
				{view.run ? <RunFacts run={view.run} events={view.events} asks={view.question !== null} now={now} /> : null}
			</section>

			<Verdicts view={view} now={now} />
			<Cost view={view} />

			<section className="usage-section" aria-labelledby="item-task">
				<h2 className="usage-title" id="item-task">
					The task
				</h2>
				{view.task.body ? <p className="item-body-text">{view.task.body}</p> : <p className="usage-empty">Only the title was given.</p>}
				{view.task.acceptance.length > 0 ? (
					<>
						<p className="machine-label item-task-label">Acceptance criteria</p>
						<ul className="item-criteria-list">
							{view.task.acceptance.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					</>
				) : null}
			</section>

			<Log view={view} now={now} />

			{dialog === "cancel" ? <CancelDialog view={view} acting={acting} onClose={() => setDialog(null)} /> : null}
			{dialog === "send_back" ? <SendBackDialog view={view} acting={acting} onClose={() => setDialog(null)} /> : null}
		</main>
	);
}
