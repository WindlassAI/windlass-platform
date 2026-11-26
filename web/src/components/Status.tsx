/** How a session's state is shown: a glyph that moves when work is happening, and a word. */
import type { SessionStatus, SessionSummary, TurnOutcome } from "@contract";
import { AskIcon, CheckIcon, CrossIcon, Mark, PauseIcon, RingIcon, StopIcon, WarnIcon } from "./Icons";

export const STATUS_WORD: Record<SessionStatus, string> = { idle: "idle", starting: "starting", running: "working", waiting: "needs you", stopping: "stopping", paused: "paused" };

export const OUTCOME_WORD: Record<TurnOutcome, string> = {
	succeeded: "done",
	unresolved: "done, checks unresolved",
	failed: "failed",
	stopped: "stopped",
	interrupted: "interrupted",
	error: "error",
};

export const OUTCOME_TONE: Record<TurnOutcome, "good" | "warn" | "bad" | "dim"> = {
	succeeded: "good",
	unresolved: "warn",
	failed: "bad",
	stopped: "warn",
	interrupted: "warn",
	error: "bad",
};

export function StatusGlyph({ status, size = 16 }: { status: SessionStatus; size?: number }) {
	if (status === "running") return <Mark size={size + 2} turning className="status-glyph status-running" />;
	if (status === "starting") return <span className="status-glyph status-starting" style={{ width: size, height: size }} aria-hidden="true" />;
	if (status === "stopping") return <StopIcon size={size} className="status-glyph status-stopping" />;
	// Waiting on the user: still, not turning. Nothing moves until they answer.
	if (status === "waiting") return <AskIcon size={size} className="status-glyph status-waiting" />;
	// Paused: the turn is not over, and resumes by itself. Still, like waiting.
	if (status === "paused") return <PauseIcon size={size} className="status-glyph status-paused" />;
	return <RingIcon size={size} className="status-glyph status-idle" />;
}

export function StatusBadge({ status }: { status: SessionStatus }) {
	return (
		<span className={`status-badge status-badge-${status}`} title={status === "waiting" ? "A question waits for your answer" : status === "paused" ? "The turn is paused and resumes by itself" : undefined}>
			<StatusGlyph status={status} size={14} />
			{STATUS_WORD[status]}
		</span>
	);
}

export function OutcomeGlyph({ outcome, size = 14 }: { outcome: TurnOutcome; size?: number }) {
	const tone = OUTCOME_TONE[outcome];
	if (outcome === "succeeded") return <CheckIcon size={size} className={`tone-${tone}`} />;
	if (outcome === "failed" || outcome === "error") return <CrossIcon size={size} className={`tone-${tone}`} />;
	if (outcome === "unresolved") return <WarnIcon size={size} className={`tone-${tone}`} />;
	return <StopIcon size={size} className={`tone-${tone}`} />;
}

const SANDBOX_WORD: Record<SessionSummary["sandbox"], string> = { none: "no sandbox yet", running: "sandbox running", paused: "sandbox paused" };

/** `asOf`: the state is only the last one reported, at that time (its machine is offline). */
export function SandboxState({ state, asOf }: { state: SessionSummary["sandbox"]; asOf?: string }) {
	return (
		<span className={`sandbox-state sandbox-state-${state}${asOf ? " sandbox-state-stale" : ""}`} title={asOf}>
			<span className="sandbox-state-dot" aria-hidden="true" />
			{SANDBOX_WORD[state]}{asOf && " when last seen"}
		</span>
	);
}
