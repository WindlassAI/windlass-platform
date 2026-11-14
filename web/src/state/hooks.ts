import type { ChatgptStatus, SessionSummary } from "@contract";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ConnectionState, PlatformError } from "../api/client";
import { useApp, useAuth } from "./app";
import { createSessionStore, type SessionState } from "./sessionStore";

/** The current time, refreshed every `intervalMs` while mounted. */
export function useNow(intervalMs: number, active = true): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs, active]);
	return now;
}

export interface SessionsState {
	/** Null until the list first arrives. */
	sessions: SessionSummary[] | null;
	connection: ConnectionState;
	error: PlatformError | null;
}

/** The user's sessions, live. */
export function useSessions(): SessionsState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<SessionsState>({ sessions: null, connection: "connecting", error: null });
	useEffect(() => {
		setState({ sessions: null, connection: "connecting", error: null });
		return client.user(auth).watch({
			onSessions: (sessions) => setState((current) => ({ ...current, sessions })),
			onConnection: (connection, error) => {
				if (error) explain(error);
				setState((current) => ({ ...current, connection, error: error ?? null }));
			},
		});
	}, [client, auth, explain]);
	return state;
}

/** The ChatGPT connection of a real user; null for the demo user and until it is known. */
export function useChatgpt(): { status: ChatgptStatus | null; error: string | null } {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [status, setStatus] = useState<ChatgptStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (auth.profile.demo) return;
		let current = true;
		client
			.user(auth)
			.chatgpt()
			.then(
				(value) => current && setStatus(value),
				(failure: unknown) => current && setError(explain(failure)),
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain]);
	return { status, error };
}

/** One session, live: its store is opened on mount and closed on unmount. */
export function useSession(sessionId: string): SessionState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const store = useMemo(() => createSessionStore(client.session(auth, sessionId)), [client, auth, sessionId]);
	useEffect(() => store.start(), [store]);
	const state = useSyncExternalStore(store.subscribe, store.getState);
	useEffect(() => {
		if (state.error) explain(state.error);
	}, [state.error, explain]);
	return state;
}
