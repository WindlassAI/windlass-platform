/**
 * Work items in lists: on a repository's page, its items grouped by where each is, with the way to
 * file a new one; on the home page, the items that ask their person something ("Needs you").
 *
 * The list is the user's actor's (`listItems`): read when a screen opens, replaced whenever the actor
 * says an item changed (the user's live feed, `onItems`), and read again when that feed comes back
 * after a drop, since what was said meanwhile is lost. Nothing is asked on a timer. Every sentence a
 * row shows of why an item waits is the server's (`Waiting.sentence`), shown as it was written.
 */
import { MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_TITLE_CHARS, type CreateItemInput, type ItemState, type ItemSummary, type Verdict, type VerifiedFlag } from "@contract";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Dialog } from "../components/Dialog";
import { AskIcon, ChevronIcon, CrossIcon, ExternalIcon, Mark, MergedIcon, PullRequestIcon, RingIcon, StopIcon, WarnIcon } from "../components/Icons";
import { absoluteTime, count, plural, relativeTime } from "../lib/format";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { useApp, useAuth } from "../state/app";

export interface ItemsState {
	/** Null until it was read, and when it could not be. */
	list: ItemSummary[] | null;
	/** Why it could not be read the last time it was asked for. */
	error: string | null;
	reload(): void;
}

/** The user's work items: read when the screen opens, then as the user's actor sends them, and again after the live feed was down. */
export function useItems(): ItemsState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ list: ItemSummary[] | null; error: string | null }>({ list: null, error: null });
	const asked = useRef(0);

	const reload = useCallback(() => {
		const mine = ++asked.current;
		setState((now) => ({ list: now.list, error: null }));
		client
			.user(auth)
			.listItems()
			.then(
				(list) => mine === asked.current && setState({ list, error: null }),
				(failure: unknown) => mine === asked.current && setState((now) => ({ list: now.list, error: explain(failure) })),
			);
	}, [client, auth, explain]);

	useEffect(() => {
		reload();
		let connected = false;
		const close = client.user(auth).watch({
			onSessions: () => undefined,
			onItems: (list) => {
				asked.current += 1;
				setState({ list, error: null });
			},
			onConnection: (connection) => {
				if (connection !== "connected") return;
				// What the actor sent while the feed was down is lost: the list is read again when it is back.
				if (connected) reload();
				connected = true;
			},
		});
		return () => {
			asked.current += 1;
			close();
		};
	}, [client, auth, reload]);

	return { ...state, reload };
}

// ---- the words for an item, shared by its row and its page -------------------------------------

/** The groups of a repository's page, in the plan's words, in the order they stand. */
export const STATE_WORD: Record<ItemState, string> = { draft: "Draft", queued: "Queued", working: "Working", waiting: "Waiting", review: "In review", done: "Done", failed: "Failed", cancelled: "Cancelled" };

/** A verdict in one or two words (server/src/factory/verdict.ts, `verdictWords`): a pass with flags needs a look, never "ready". */
export function verdictWord(verdict: Pick<Verdict, "result"> & { flags: VerifiedFlag[] }): { word: string; tone: "good" | "warn" | "bad" | "dim" } {
	switch (verdict.result) {
		case "pass":
			return verdict.flags.length > 0 ? { word: "Needs a look", tone: "warn" } : { word: "Ready for review", tone: "good" };
		case "fail":
			return { word: "Failing", tone: "bad" };
		case "incomplete":
			return { word: "Incomplete", tone: "warn" };
		case "unverified":
			return { word: "Not verified", tone: "dim" };
	}
}

export function VerdictWord({ verdict }: { verdict: NonNullable<ItemSummary["verdict"]> }) {
	const { word, tone } = verdictWord(verdict);
	return <span className={`outcome item-verdict tone-${tone}`}>{word}</span>;
}

/** Where an item is, as a glyph: still unless a turn of it runs, and in the calm hue when it asks its person. */
export function ItemGlyph({ item }: { item: Pick<ItemSummary, "state" | "question"> }) {
	switch (item.state) {
		case "working":
			return <Mark size={18} turning className="status-glyph status-running" />;
		case "waiting":
			return item.question ? <AskIcon size={16} className="status-glyph status-waiting" /> : <span className="item-glyph-waiting" aria-hidden="true" />;
		case "queued":
			return <span className="item-glyph-waiting" aria-hidden="true" />;
		case "review":
			return <PullRequestIcon size={16} className="tone-accent" />;
		case "done":
			return <MergedIcon size={16} className="tone-good" />;
		case "failed":
			return <CrossIcon size={16} className="tone-bad" />;
		case "cancelled":
			return <StopIcon size={16} className="tone-faint" />;
		case "draft":
			return <RingIcon size={16} className="status-glyph status-idle" />;
	}
}

/** Why the item is where it is, in a line: the server's sentence while it waits, and what ended it. */
function rowWhy(item: ItemSummary): string | null {
	if (item.state === "waiting" && item.wait) return item.wait.sentence;
	if (item.state === "draft") return "Not started.";
	if (item.state === "queued") return "Started; waiting for its first turn.";
	return null;
}

/** One item as a row of a list. `repository`: the row stands under no repository's name, so it says which. */
export function ItemRow({ item, now, repository = false, why }: { item: ItemSummary; now: number; repository?: boolean; why?: ReactNode }) {
	const asks = item.question !== null;
	const line = why ?? rowWhy(item);
	return (
		<li className={`agent-row item-row${item.state === "working" || asks ? " agent-row-active" : ""}${asks ? " agent-row-waiting" : ""}`}>
			<span className="agent-glyph">
				<ItemGlyph item={item} />
			</span>
			<div className="agent-main">
				<a className="agent-title" {...linkProps({ name: "item", id: item.id })}>
					{item.title}
					{asks ? <span className="visually-hidden"> (waiting for your answer)</span> : null}
				</a>
				{line ? <p className="item-row-why">{line}</p> : null}
				<p className="agent-meta">
					{repository ? (
						<span className="agent-repo">
							{item.repository.owner}/{item.repository.name}
						</span>
					) : (
						<span className="agent-repo">into {item.repository.branch}</span>
					)}
					{item.pullRequest ? (
						<span>
							<a className="item-pull" href={item.pullRequest.url} target="_blank" rel="noreferrer">
								#{item.pullRequest.number}
								<ExternalIcon size={10} />
							</a>
						</span>
					) : null}
					{item.source === "api" ? <span>from the API</span> : null}
				</p>
			</div>
			<div className="agent-state">{item.verdict ? <VerdictWord verdict={item.verdict} /> : null}</div>
			<time className="agent-time" dateTime={new Date(item.updatedAt).toISOString()} title={absoluteTime(item.updatedAt)}>
				{relativeTime(item.updatedAt, now)}
			</time>
		</li>
	);
}

// ---- a repository's items -----------------------------------------------------------------------

const SHOWN: ItemState[] = ["draft", "queued", "working", "waiting", "review", "failed"];
const FOLDED: ItemState[] = ["done", "cancelled"];

function Group({ state, items, now }: { state: ItemState; items: ItemSummary[]; now: number }) {
	const heading = useId();
	return (
		<div className="items-group">
			<h3 className="items-group-head" id={heading}>
				{STATE_WORD[state]}
				<span className="items-group-count">{count(items.length)}</span>
			</h3>
			<ul className="agents" aria-labelledby={heading}>
				{items.map((item) => (
					<ItemRow key={item.id} item={item} now={now} />
				))}
			</ul>
		</div>
	);
}

/** The "Work items" section of a repository's page. `launchable`: new work can be filed on it now. */
export function RepositoryItems({ repositoryId, name, base, launchable, now }: { repositoryId: number; name: string; base: string | null; launchable: boolean; now: number }) {
	const items = useItems();
	const [filing, setFiling] = useState(false);
	const [open, setOpen] = useState(false);
	const ended = useId();
	const mine = items.list?.filter((item) => item.repository.id === repositoryId) ?? null;
	const of = (state: ItemState) => mine?.filter((item) => item.state === state) ?? [];
	const folded = FOLDED.flatMap((state) => of(state));

	return (
		<section className="usage-section" aria-labelledby="repo-items">
			<h2 className="usage-title" id="repo-items">
				Work items
				{mine && mine.length > 0 ? <span className="usage-count">{mine.length}</span> : null}
				<button type="button" className="link secret-add" onClick={() => setFiling(true)} disabled={!launchable} title={launchable ? undefined : "No work can be filed on this repository now"}>
					New work item…
				</button>
			</h2>
			<p className="usage-lede">An agent works on each by itself: your checks and CI verify the work, and it is handed to you as a pull request with what the verdict rests on. Merging it is yours.</p>
			{mine === null ? (
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
					<div className="usage-loading" aria-busy="true" aria-label="Loading the work items">
						<span className="skeleton skeleton-title" style={{ width: "34%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
					</div>
				)
			) : mine.length === 0 ? (
				<p className="usage-empty">No work item on this repository yet.{launchable ? " File one with New work item." : ""}</p>
			) : (
				<>
					{items.error ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{items.error} What is shown may be behind.</span>
						</p>
					) : null}
					{SHOWN.map((state) => (of(state).length > 0 ? <Group key={state} state={state} items={of(state)} now={now} /> : null))}
					{folded.length > 0 ? (
						<>
							<p className="agents-fold items-fold">
								<button type="button" className="link machine-toggle" aria-expanded={open} aria-controls={ended} onClick={() => setOpen((value) => !value)}>
									<ChevronIcon size={11} className="machine-chevron" />
									{open ? "Hide the ended ones" : `Show ${plural(folded.length, "ended item")}`}
								</button>
								{open ? null : <span>{FOLDED.filter((state) => of(state).length > 0).map((state) => `${of(state).length} ${STATE_WORD[state].toLowerCase()}`).join(", ")}</span>}
							</p>
							<div id={ended} hidden={!open}>
								{FOLDED.map((state) => (of(state).length > 0 ? <Group key={state} state={state} items={of(state)} now={now} /> : null))}
							</div>
						</>
					) : null}
				</>
			)}
			{filing ? <NewItemDialog repositoryId={repositoryId} name={name} base={base} onClose={() => setFiling(false)} /> : null}
		</section>
	);
}

/** Filing a work item: what to do, and what a person will check. It runs on a hosted sandbox. */
function NewItemDialog({ repositoryId, name, base, onClose }: { repositoryId: number; name: string; base: string | null; onClose(): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [criteria, setCriteria] = useState("");
	const [start, setStart] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const last = useRef<Submission | null>(null);
	const ids = { form: useId(), title: useId(), body: useId(), criteria: useId(), criteriaNote: useId() };
	const acceptance = criteria
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const tooMany = acceptance.length > MAX_ACCEPTANCE_CRITERIA;
	const tooLong = acceptance.some((line) => line.length > MAX_NOTE_CHARS);
	const ready = title.trim() !== "" && !tooMany && !tooLong && body.length <= MAX_ITEM_BODY_CHARS;

	const file = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready || busy) return;
		const input: Omit<CreateItemInput, "idempotencyKey"> = { repository: { id: repositoryId }, title: title.trim(), body: body.trim(), acceptance, start };
		// Every attempt of the same form is one submission: a call that was answered late is not taken twice.
		const submission = submissionOf(JSON.stringify(input), last.current);
		last.current = submission;
		setBusy(true);
		setError(null);
		try {
			const item = await client.user(auth).createItem({ ...input, idempotencyKey: submission.idempotencyKey });
			last.current = null;
			onClose();
			navigate({ name: "item", id: item.id });
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title="New work item"
			lede={
				<>
					On {name}, as a pull request into {base ?? "its default branch"}. It runs on a hosted sandbox.
				</>
			}
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" form={ids.form} className="button button-primary" disabled={!ready || busy}>
						{busy ? "Filing…" : start ? "File and start" : "File as a draft"}
					</button>
				</>
			}
		>
			<form id={ids.form} className="item-form" onSubmit={file}>
				<div>
					<label className="label" htmlFor={ids.title}>
						Title
					</label>
					<input id={ids.title} className="input" value={title} maxLength={MAX_TITLE_CHARS} onChange={(event) => setTitle(event.target.value)} readOnly={busy} data-autofocus />
				</div>
				<div>
					<label className="label" htmlFor={ids.body}>
						What to do
					</label>
					<textarea id={ids.body} className="input textarea item-body" value={body} maxLength={MAX_ITEM_BODY_CHARS} onChange={(event) => setBody(event.target.value)} readOnly={busy} />
					<p className="field-note">The agent is given this and the title as your own words.</p>
				</div>
				<div>
					<label className="label" htmlFor={ids.criteria}>
						Acceptance criteria<span className="label-optional">optional</span>
					</label>
					<textarea id={ids.criteria} className={`input textarea item-criteria${tooMany || tooLong ? " input-invalid" : ""}`} value={criteria} onChange={(event) => setCriteria(event.target.value)} readOnly={busy} aria-describedby={ids.criteriaNote} aria-invalid={tooMany || tooLong || undefined} />
					<p className={`field-note${tooMany || tooLong ? " tone-bad" : ""}`} id={ids.criteriaNote}>
						{tooMany
							? `At most ${MAX_ACCEPTANCE_CRITERIA}; there are ${acceptance.length}.`
							: tooLong
								? `Each is at most ${count(MAX_NOTE_CHARS)} characters.`
								: "One per line. The agent is given them, and the verdict lists them for you to check: no machine checks them."}
					</p>
				</div>
				<label className={`check${start ? " check-on" : ""}`}>
					<input className="check-input" type="checkbox" checked={start} disabled={busy} onChange={(event) => setStart(event.target.checked)} />
					<span className="check-box" aria-hidden="true" />
					<span className="check-text">
						<span className="check-name">Start now</span>
						<span className="check-means">{start ? "It starts as soon as one of your factory turns and a sandbox are free; until then it waits, and says for what." : "It is kept as a draft until you start it from its page."}</span>
					</span>
				</label>
				{error ? (
					<p className="callout callout-bad" role="alert">
						<WarnIcon />
						<span>{error}</span>
					</p>
				) : null}
			</form>
		</Dialog>
	);
}

// ---- the home page's "Needs you" ----------------------------------------------------------------

/** The items that ask their person something, across repositories, the longest waiting first. Nothing when there is none. */
export function NeedsYou({ now }: { now: number }) {
	const { list } = useItems();
	const asking = (list ?? []).filter((item) => item.question !== null).sort((a, b) => (a.question?.askedAt ?? 0) - (b.question?.askedAt ?? 0));
	if (asking.length === 0) return null;
	return (
		<section className="agent-group needs-you" aria-labelledby="needs-you">
			<h2 className="agent-group-head" id="needs-you">
				<span className="agent-group-name">Needs you</span>
				<span className="agent-group-count">{plural(asking.length, "work item")} asking</span>
			</h2>
			<ul className="agents">
				{asking.map((item) => (
					<ItemRow key={item.id} item={item} now={now} repository why={item.question?.text} />
				))}
			</ul>
		</section>
	);
}
