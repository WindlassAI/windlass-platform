import type { AccountSettings, ChatgptStatus, SessionSummary, UsageNumbers } from "@contract";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

export interface AccountState {
	/** Null until it was read, and when it could not be. */
	settings: AccountSettings | null;
	/** Why it could not be read. */
	error: string | null;
	reading: boolean;
	/** Reads it again. */
	reload(): void;
	/** Takes the settings as an action answered them. */
	replace(settings: AccountSettings): void;
}

/** What the user keeps for their account, whatever the repository: read when the screen opens. */
export function useAccount(): AccountState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ settings: AccountSettings | null; error: string | null; reading: boolean }>({ settings: null, error: null, reading: true });
	const asked = useRef(0);

	const reload = useCallback(() => {
		const mine = ++asked.current;
		setState((now) => ({ ...now, reading: true }));
		client
			.user(auth)
			.account()
			.then(
				(settings) => mine === asked.current && setState({ settings, error: null, reading: false }),
				(failure: unknown) => mine === asked.current && setState((now) => ({ settings: now.settings, error: explain(failure), reading: false })),
			);
	}, [client, auth, explain]);

	useEffect(() => {
		reload();
		return () => {
			asked.current += 1;
		};
	}, [reload]);

	const replace = useCallback((settings: AccountSettings) => {
		asked.current += 1;
		setState({ settings, error: null, reading: false });
	}, []);
	return { ...state, reload, replace };
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

/** How often the numbers are asked for again while they are shown: a running sandbox moves them. */
const ALLOWANCE_EVERY_MS = 60_000;

/**
 * Today's sandbox time and the count of kept sandboxes: asked when the screen opens, every minute
 * after that, and whenever `key` changes (a turn ended, a prompt was refused). Null until they are
 * known and when they cannot be read: the screens then say nothing rather than something stale.
 */
export function useAllowance(key: unknown = 0): UsageNumbers | null {
	const { client } = useApp();
	const auth = useAuth();
	const [numbers, setNumbers] = useState<UsageNumbers | null>(null);
	useEffect(() => {
		let current = true;
		const read = () => {
			client
				.user(auth)
				.allowance()
				.then(
					(value) => current && setNumbers(value),
					() => current && setNumbers(null),
				);
		};
		read();
		const timer = setInterval(read, ALLOWANCE_EVERY_MS);
		return () => {
			current = false;
			clearInterval(timer);
		};
	}, [client, auth, key]);
	return numbers;
}

/** What is left of today's allowance for a new turn, as the screens say it. */
export type AllowanceState =
	/** No limit, or enough left to say nothing. */
	| "plenty"
	/** Less than USAGE_LOW_SHARE of the allowance is left. */
	| "low"
	/** Too little is left for a turn to start. */
	| "used";

export function allowanceState(numbers: UsageNumbers | null, lowShare: number): AllowanceState {
	if (numbers === null || numbers.allowanceSeconds === null || numbers.leftSeconds === null) return "plenty";
	if (numbers.leftSeconds < numbers.startSeconds) return "used";
	return numbers.leftSeconds < numbers.allowanceSeconds * lowShare ? "low" : "plenty";
}
