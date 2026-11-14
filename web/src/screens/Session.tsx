/** One agent: the conversation and composer in the main column, the session's facts beside it. */
import { useCallback, useMemo, useState } from "react";
import { Composer } from "../components/Composer";
import { Conversation } from "../components/Conversation";
import { ArrowLeftIcon, Mark, WarnIcon } from "../components/Icons";
import { InteractiveProvider, QuestionDock, useQuestionFlow, type Interactive } from "../components/Question";
import { SidePanel } from "../components/SidePanel";
import { StatusBadge } from "../components/Status";
import { linkProps } from "../lib/router";
import type { ToolBlock } from "../lib/timeline";
import { useApp, useAuth } from "../state/app";
import { takeHandover } from "../state/handover";
import { useSession } from "../state/hooks";

/** What the top bar shows for a session: the way back, its title and state. */
export function SessionCrumb({ title, status }: { title: string | null; status: Parameters<typeof StatusBadge>[0]["status"] | null }) {
	return (
		<nav className="crumb" aria-label="Where you are">
			<a className="crumb-back" {...linkProps({ name: "home" })}>
				<ArrowLeftIcon size={14} />
				<span>Agents</span>
			</a>
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
			{status !== null ? <StatusBadge status={status} /> : null}
		</nav>
	);
}

export function Session({ sessionId, state }: { sessionId: string; state: ReturnType<typeof useSession> }) {
	const { client, platform, explain } = useApp();
	const auth = useAuth();
	const api = useMemo(() => client.session(auth, sessionId), [client, auth, sessionId]);
	const handover = useMemo(() => takeHandover(sessionId), [sessionId]);
	const [suggestion, setSuggestion] = useState<{ key: number; text: string } | null>(null);
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
	const interactive = useMemo<Interactive>(() => ({ flow, stopCall: online ? stopCall : null }), [flow, stopCall, online]);

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

	return (
		<main className="session">
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
				<QuestionDock flow={flow} />
				<Composer
					status={summary.status}
					online={online}
					models={platform.info?.models ?? [summary.model]}
					efforts={platform.info?.efforts ?? []}
					model={summary.model}
					initial={handover}
					suggestion={suggestion}
					onSend={async (input) => {
						try {
							await api.prompt(input);
						} catch (failure) {
							// `explain` signs out on a refused token; the composer reads the rest itself (`turn_running`).
							explain(failure);
							throw failure;
						}
					}}
					onStop={async () => {
						try {
							await api.stop();
						} catch (failure) {
							throw new Error(explain(failure));
						}
					}}
				/>
				<a className="to-details" href="#details">
					Session details, tokens and changes
				</a>
			</div>
			<SidePanel sessionId={sessionId} summary={summary} profile={profile} view={view} turnsEnded={state.turnsEnded} />
		</main>
	);
}
