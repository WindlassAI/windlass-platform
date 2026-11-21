/**
 * One agent: the conversation and composer in the main column, the session's facts beside it.
 *
 * An agent on one of the user's machines says so beside its title, and above the composer says when
 * that machine is offline, stopped answering in the middle of a turn, or was removed. What the session
 * last found is in its snapshot (`SessionSnapshot.machine`) and then in its `machine` event, each time
 * that changes. Whether the machine is offline or gone is also in the user's live list of machines,
 * which is read for such a session only.
 *
 * A work item's agent (`SessionSummary.item`) is the item's: the server takes no prompt for it, so
 * the page has no composer, and says in its place that the item's steps send its prompts, with the
 * way to the item (`ItemNote`). What the server does allow there stays: Stop while a turn runs, a tool
 * call's stop, the answers to its questions, and the panel's pull request and servers.
 *
 * An agent of another harness than Windlass (Claude Code, on one of the user's machines) says which
 * beside its title, and the page draws only what that harness does: its tool calls cannot be stopped
 * one by one, and the composer offers the models it offered. Where its machine says Claude Code is not
 * signed in, the line above the composer says so and signs it in from the page (components/ClaudeSignIn.tsx).
 */
import { USAGE_LOW_SHARE, type MachineSummary, type SandboxPlace, type SessionSnapshot, type SessionSummary, type UsageNumbers } from "@contract";
import { useCallback, useMemo, useState } from "react";
import { ClaudeSignIn } from "../components/ClaudeSignIn";
import { Composer, ItemNote } from "../components/Composer";
import { Conversation } from "../components/Conversation";
import { ArrowLeftIcon, Mark, PullRequestIcon, WarnIcon } from "../components/Icons";
import { InteractiveProvider, QuestionDock, useQuestionFlow, type Interactive } from "../components/Question";
import { acpHarnessName, harnessModelsOf, sessionModelWords } from "../lib/acp";
import { currentMode, sessionModes } from "../lib/modes";
import { SidePanel } from "../components/SidePanel";
import { STATUS_WORD, StatusBadge, StatusGlyph } from "../components/Status";
import { Tooltip } from "../components/ui";
import { clockDuration, localTime, sandboxTime } from "../lib/format";
import { linkProps } from "../lib/router";
import type { ToolBlock } from "../lib/timeline";
import { useApp, useAuth } from "../state/app";
import { takeHandover } from "../state/handover";
import { allowanceState, useAllowance, useModels, useNow, type useSession } from "../state/hooks";
import { requestPublish, setPanelHidden, usePanelHidden } from "../state/sessionChrome";
import { clockTime, useMachines } from "./Machines";
import { machineLabel } from "../lib/machines";

/** How long a turn waits for a machine that stopped answering before it ends: the grace of the runner's channel on the server. */
const MACHINE_GRACE_MS = 10 * 60_000;

/**
 * The machine a session runs on, from the user's live list of machines: undefined for a hosted session
 * and while the list is not known, null once it is known and the machine is not in it (it was removed).
 */
export function useSessionMachine(place: SandboxPlace | undefined): MachineSummary | null | undefined {
	const machineId = place?.kind === "machine" ? place.machineId : null;
	const { list } = useMachines(machineId !== null);
	if (machineId === null || list === null) return undefined;
	return list.find((machine) => machine.machineId === machineId) ?? null;
}

function PanelIcon({ size = 16 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
			<rect x="2" y="2.75" width="12" height="10.5" rx="2" />
			<path d="M10 3v10" />
		</svg>
	);
}

/** The state beside the title: while a turn runs or waits on you, a pill with how long the turn has run; otherwise the plain badge. */
function CrumbState({ status, since }: { status: SessionSummary["status"]; since: number | null }) {
	const live = status === "running" || status === "starting" || status === "waiting";
	const now = useNow(1000, live && since !== null);
	if (!live) return <StatusBadge status={status} />;
	const waiting = status === "waiting";
	return (
		<span className={`crumb-pill crumb-pill-${status}`} role="status" title={waiting ? "A question waits for your answer" : undefined}>
			<StatusGlyph status={status} size={13} />
			<span>{STATUS_WORD[status]}</span>
			{since !== null ? <span className="crumb-pill-time">{clockDuration(now - since)}</span> : null}
		</span>
	);
}

/** The way out from the bar: "Publish pull request" asks the panel to open its dialog; an open pull request is a link to it. */
function BarPublish({ summary }: { summary: SessionSummary }) {
	const pull = summary.pullRequest ?? null;
	if (!summary.repository || summary.item) return null;
	if (pull && pull.state !== "closed") {
		return (
			<a className="bar-button bar-pull" href={pull.url} target="_blank" rel="noreferrer" title={`${pull.title} · ${pull.state}`}>
				<PullRequestIcon size={14} />
				<span>#{pull.number}</span>
				<span className="bar-pull-state">{pull.state}</span>
			</a>
		);
	}
	const busy = summary.status !== "idle";
	return (
		<Tooltip content={busy ? "Available when this turn ends" : "Commit, push and open a pull request"}>
			<button type="button" className="bar-button" onClick={() => (busy ? undefined : requestPublish(summary.id))} aria-disabled={busy || undefined}>
				<PullRequestIcon size={14} />
				<span className="bar-button-label">Publish pull request</span>
			</button>
		</Tooltip>
	);
}

/** The model and the mode, after what runs the session. */
function CrumbModel({ summary }: { summary: SessionSummary }) {
	const { platform } = useApp();
	const profile = platform.info?.profiles.find((one) => one.id === summary.profile);
	return (
		<>
			<span>{sessionModelWords(summary)}</span>
			{profile ? <span>{currentMode(summary, profile).name}</span> : null}
		</>
	);
}

/** Shows or hides the side panel, on a screen wide enough to have it beside the conversation. */
function PanelToggle() {
	const hidden = usePanelHidden();
	return (
		<Tooltip content={hidden ? "Show the session's details" : "Hide the session's details"}>
			<button type="button" className={`bar-icon panel-toggle${hidden ? "" : " bar-icon-on"}`} onClick={() => setPanelHidden(!hidden)} aria-pressed={!hidden} aria-label="Session details">
				<PanelIcon />
			</button>
		</Tooltip>
	);
}

/**
 * What the top bar shows for a session: the way back, its repository, its title and state, and on the
 * right what runs it and the way out. A work item's session is part of its item, and the way back is to
 * the item. `summary`, once known, adds the repository, the turn's time, the facts and the actions.
 */
export function SessionCrumb({ title, status, place, machine, item, harness, summary = null }: { title: string | null; status: Parameters<typeof StatusBadge>[0]["status"] | null; place?: SandboxPlace; machine?: MachineSummary | null; item?: { id: string }; harness?: SessionSummary["harness"]; summary?: SessionSummary | null }) {
	const harnessName = acpHarnessName({ harness });
	const machineName = machine ? machineLabel(machine) : null;
	const repository = summary?.repository ?? null;
	const live = summary !== null && (summary.status === "running" || summary.status === "starting" || summary.status === "waiting");
	return (
		<>
			<nav className="crumb" aria-label="Where you are">
				<a className="crumb-back" {...linkProps(item ? { name: "item", id: item.id } : { name: "home" })}>
					<ArrowLeftIcon size={14} />
					<span>{item ? "Work item" : "Agents"}</span>
				</a>
				{repository && !item ? (
					<>
						<span className="crumb-sep" aria-hidden="true">
							/
						</span>
						<a className="crumb-repo" {...linkProps({ name: "repository", id: repository.id })} title={`${repository.owner}/${repository.name}`}>
							{repository.name}
						</a>
					</>
				) : null}
				{title !== null ? (
					<>
						<span className="crumb-sep" aria-hidden="true">
							/
						</span>
						<h1 className="crumb-title" title={title}>
							{title}
						</h1>
					</>
				) : null}
				{status !== null ? <CrumbState status={status} since={live ? summary.updatedAt : null} /> : null}
			</nav>
			<div className="crumb-end">
				<p className="crumb-facts">
					{place?.kind === "machine" ? <span className="chip crumb-place">{harnessName ? `${harnessName} on ${machineName ? `“${machineName}”` : "your machine"}` : `On ${machineName ?? "your machine"}`}</span> : summary ? <span>{harnessName ?? "Windlass"}</span> : null}
					{summary ? <CrumbModel summary={summary} /> : null}
				</p>
				{summary ? <BarPublish summary={summary} /> : null}
				{summary ? <PanelToggle /> : null}
			</div>
		</>
	);
}

/**
 * What the banner above the composer says of the session's machine; null when it answers. The snapshot
 * says what the session last found, the live list whether the machine is offline now or gone; a machine
 * the list says came back after what the snapshot found is not reported.
 */
function machineNote(reach: SessionSnapshot["machine"], machine: MachineSummary | null | undefined, sandbox: SessionSummary["sandbox"], now: number, item = false): { text: string; removed: boolean } | null {
	if (reach?.state === "removed" || machine === null) return { removed: true, text: `This agent's machine was removed. Its files were there.${item ? "" : " Start a new agent to go on."}` };
	const named = machine ? `Your machine "${machineLabel(machine)}"` : "Your machine";
	const back = reach != null && machine?.status === "online" && machine.since >= reach.since;
	if (reach?.state === "not_answering" && !back) {
		return { removed: false, text: `${named} is not answering since ${clockTime(reach.since, now)}. The turn goes on when it is back, or stops at ${clockTime(reach.since + MACHINE_GRACE_MS, now)}.` };
	}
	const offline = machine?.status === "offline" ? machine.since : reach?.state === "offline" && !back ? reach.since : null;
	if (offline === null) return null;
	return { removed: false, text: `${named} is offline since ${clockTime(offline, now)}.${sandbox === "none" ? "" : " The agent's files are there."}${item ? "" : " Send a prompt once it is back."}` };
}

/** What the composer says about the user's limits before a prompt runs into one; null while there is nothing to say. */
function limitNote(numbers: UsageNumbers | null, summary: SessionSummary): string | null {
	if (numbers === null) return null;
	const left = allowanceState(numbers, USAGE_LOW_SHARE);
	const resets = localTime(numbers.resetsAt);
	if (left === "used") {
		return summary.status === "idle"
			? `Today's sandbox time is used up, so a turn cannot start before ${resets}.`
			: "Today's sandbox time is nearly used up: this turn is stopped when the time it holds is over, with its files kept.";
	}
	if (left === "low" && numbers.leftSeconds !== null) return `${sandboxTime(numbers.leftSeconds)} of today's sandbox time is left. A turn that runs longer is stopped; the allowance is whole again at ${resets}.`;
	const { kept, limit } = numbers.sandboxes;
	if (summary.sandbox === "none" && limit !== null && kept >= limit) return `You keep ${limit} sandboxes, the most an account may have, so this agent cannot start until one is freed.`;
	return null;
}

/** `machine`: the machine the session runs on, as `useSessionMachine` says. */
export function Session({ sessionId, state, machine }: { sessionId: string; state: ReturnType<typeof useSession>; machine?: MachineSummary | null }) {
	const { client, explain } = useApp();
	const models = useModels();
	const auth = useAuth();
	const api = useMemo(() => client.session(auth, sessionId), [client, auth, sessionId]);
	const handover = useMemo(() => takeHandover(sessionId), [sessionId]);
	const [suggestion, setSuggestion] = useState<{ key: number; text: string } | null>(null);
	// Asked again when a turn starts or ends, and when a prompt was refused: each moves what is left of the day.
	const [refusals, setRefusals] = useState(0);
	const allowance = useAllowance(`${state.turnsEnded}:${state.summary?.status ?? ""}:${refusals}`);
	const online = state.connection === "connected";
	const flow = useQuestionFlow(api, state.phase === "ready" ? state.question : null, explain);
	const stopCall = useCallback(
		async (block: ToolBlock) => {
			try {
				return await api.stopCall({ messageId: block.messageId, callId: block.callId });
			} catch (failure) {
				throw new Error(explain(failure));
			}
		},
		[api, explain],
	);
	const setMode = useCallback(
		async (mode: string) => {
			try {
				await api.setMode(mode);
			} catch (failure) {
				explain(failure);
				throw failure;
			}
		},
		[api, explain],
	);
	const stop = useCallback(async () => {
		try {
			await api.stop();
		} catch (failure) {
			throw new Error(explain(failure));
		}
	}, [api, explain]);
	// A harness other than Windlass cannot stop one call of a turn: only the turn.
	const harness = state.summary ? acpHarnessName(state.summary) : null;
	const panelHidden = usePanelHidden();
	const interactive = useMemo<Interactive>(() => ({ flow, stopCall: online && harness === null ? stopCall : null }), [flow, stopCall, online, harness]);

	if (state.phase === "missing") {
		return (
			<main className="state state-page">
				<Mark size={56} />
				<h1 className="display display-small">No agent at this address</h1>
				<p>It may have been deleted, or the address is not one of yours.</p>
				<a className="button button-outline" {...linkProps({ name: "home" })}>
					Back to your agents
				</a>
			</main>
		);
	}

	if (state.phase === "failed") {
		return (
			<main className="state state-page state-error" role="alert">
				<WarnIcon size={28} />
				<h1 className="display display-small">This agent could not be opened</h1>
				<p>{state.error?.message ?? "The server could not be reached."}</p>
				<button type="button" className="button button-outline" onClick={() => location.reload()}>
					Try again
				</button>
			</main>
		);
	}

	if (state.phase === "loading" || !state.summary || !state.profile) {
		return (
			<main className="session session-loading" aria-busy="true" aria-label="Opening the agent">
				<div className="session-main">
					<div className="conversation-inner">
						<span className="skeleton skeleton-title" style={{ width: "38%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "64%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "52%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						<span className="skeleton skeleton-title" style={{ width: "72%" }} />
					</div>
				</div>
				<aside className="panel">
					<span className="skeleton skeleton-title" style={{ width: "40%" }} />
					<span className="skeleton skeleton-meta" style={{ width: "80%" }} />
					<span className="skeleton skeleton-meta" style={{ width: "70%" }} />
					<span className="skeleton skeleton-meta" style={{ width: "76%" }} />
				</aside>
			</main>
		);
	}

	const { summary, profile, view } = state;
	const reach = summary.place.kind === "machine" ? machineNote(state.machine, machine, summary.sandbox, Date.now(), summary.item !== undefined) : null;

	return (
		<main className={`session${panelHidden ? " session-panel-hidden" : ""}`}>
			<div className="session-main">
				{state.connection === "reconnecting" ? (
					<p className="banner banner-warn" role="status">
						<WarnIcon size={14} />
						The connection dropped. Reconnecting; what you see may be behind.
					</p>
				) : state.connection === "failed" ? (
					<p className="banner banner-bad" role="alert">
						<WarnIcon size={14} />
						{state.error?.message ?? "The connection was lost."}
						<button type="button" className="link" onClick={() => location.reload()}>
							Reload
						</button>
					</p>
				) : null}
				<InteractiveProvider value={interactive}>
					<Conversation view={view} summary={summary} profile={profile} onSuggest={(text) => setSuggestion((current) => ({ key: (current?.key ?? 0) + 1, text }))} />
				</InteractiveProvider>
				{reach ? (
					<p className={`banner ${reach.removed ? "banner-bad" : "banner-warn"}`} role="status">
						<WarnIcon size={14} />
						{reach.text}
					</p>
				) : null}
				{summary.harness === "claude" && machine ? (
					<ClaudeSignIn machine={machine} className="banner session-signin">
						Claude Code: not signed in on “{machineLabel(machine)}”, so this agent cannot run a turn.
					</ClaudeSignIn>
				) : null}
				<QuestionDock flow={flow} />
				{summary.item ? (
					<ItemNote item={summary.item} status={summary.status} online={online} onStop={stop} />
				) : (
					<Composer
						status={summary.status}
						online={online}
						models={harness === null ? models.list : harnessModelsOf(summary)}
						model={summary.model}
						harness={harness}
						modes={sessionModes(summary, profile)}
						mode={summary.mode}
						onMode={setMode}
						initial={handover}
						suggestion={suggestion}
						limitNote={summary.place.kind === "machine" ? null : limitNote(allowance, summary)}
						closed={reach?.removed ? "Its machine was removed, so this agent cannot run again." : null}
						onSend={async (input) => {
							try {
								await api.prompt(input);
							} catch (failure) {
								setRefusals((value) => value + 1);
								// `explain` signs out on a refused token; the composer reads the rest itself (`turn_running`, `steer_unavailable`).
								explain(failure);
								throw failure;
							}
						}}
						onStop={stop}
					/>
				)}
				<a className="to-details" href="#details">
					Session details, tokens and changes
				</a>
			</div>
			<SidePanel sessionId={sessionId} summary={summary} profile={profile} view={view} turnsEnded={state.turnsEnded} question={flow.question} />
		</main>
	);
}
