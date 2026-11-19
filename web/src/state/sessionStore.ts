/**
 * One open session: the feed from the client, folded by the timeline reducer into what the session
 * screen draws. A plain store (no React) so it can be tested and so a burst of streaming deltas
 * becomes one render per frame.
 */
import type { PendingQuestion, SandboxProfile, SessionSnapshot, SessionSummary } from "@contract";
import type { ConnectionState, PlatformError, SessionApi } from "../api/client";
import { applyDelta, applyItem, emptyView, fromSnapshot, type SessionView } from "../lib/timeline";

export interface SessionState {
	/** "loading" until the first snapshot; "missing" when there is no such session; "failed" when it cannot be opened. */
	phase: "loading" | "ready" | "missing" | "failed";
	connection: ConnectionState;
	error: PlatformError | null;
	summary: SessionSummary | null;
	profile: SandboxProfile | null;
	view: SessionView;
	/** The question the turn in progress waits on: from the snapshot, then from the `question` event. */
	question: PendingQuestion | null;
	/** Counts the turns that ended while the session was open: the changes list reloads when it moves. */
	turnsEnded: number;
	/** For a session on one of the user's machines, what its banner says of the machine: from the snapshot, then from the `machine` event. */
	machine: SessionSnapshot["machine"];
}

export interface SessionStore {
	getState(): SessionState;
	subscribe(listener: () => void): () => void;
	/** Opens the feed. Returns the function that closes it. */
	start(): () => void;
}

const frame = (run: () => void): void => {
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
	else setTimeout(run, 0);
};

export function createSessionStore(api: SessionApi): SessionStore {
	let state: SessionState = { phase: "loading", connection: "connecting", error: null, summary: null, profile: null, view: emptyView(), question: null, turnsEnded: 0, machine: undefined };
	const listeners = new Set<() => void>();
	let scheduled = false;
	let resyncing = false;

	const set = (patch: Partial<SessionState>) => {
		state = { ...state, ...patch };
		if (scheduled) return;
		scheduled = true;
		frame(() => {
			scheduled = false;
			for (const listener of listeners) listener();
		});
	};

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start() {
			return api.open({
				onSnapshot(snapshot) {
					resyncing = false;
					set({ phase: "ready", error: null, summary: snapshot.summary, profile: snapshot.profile, view: fromSnapshot(snapshot), question: snapshot.question ?? null, machine: snapshot.machine });
				},
				onItem(item) {
					if (state.phase !== "ready") return;
					const view = applyItem(state.view, item);
					if (view === state.view) return;
					set({ view, turnsEnded: item.kind === "turn.ended" ? state.turnsEnded + 1 : state.turnsEnded });
					// Items were lost between the last one and this one: rebuild from a fresh snapshot.
					if (view.gap && !resyncing) {
						resyncing = true;
						api.resync();
					}
				},
				onDelta(delta) {
					if (state.phase === "ready") set({ view: applyDelta(state.view, delta) });
				},
				onSummary(summary) {
					set({ summary });
				},
				onQuestion(question) {
					set({ question });
				},
				onMachine(machine) {
					set({ machine });
				},
				onConnection(connection, error) {
					if (connection !== "failed") {
						set({ connection });
						return;
					}
					const missing = error?.code === "not_found";
					set({ connection, error: error ?? null, phase: missing ? "missing" : state.phase === "ready" ? "ready" : "failed" });
				},
			});
		},
	};
}
