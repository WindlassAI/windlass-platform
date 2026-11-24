import { availableCatalog } from "../../../server/src/sandbox/harnesses.js";
import { monthState } from "../lib/hosted";
import type { AccountSettings, ChatgptStatus, FactoryLimits, MachineSummary, ModelList, SessionSummary, UsageNumbers } from "@contract";
import type { HarnessOptions } from "@contract";
import type { Catalogs } from "../lib/subtask-agents";
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

export interface ModelsState {
	/** Null until it was read, and when it could not be. */
	list: ModelList | null;
	/** Why it could not be read. */
	error: string | null;
	reading: boolean;
}

/**
 * The models the user may choose and the efforts of each: read when a screen that offers them opens.
 * The server keeps the list for an hour and answers within a few seconds whatever ChatGPT does, with
 * the plan's list or a stand-in, and says which.
 */
export function useModels(): ModelsState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<ModelsState>({ list: null, error: null, reading: true });
	useEffect(() => {
		let current = true;
		setState({ list: null, error: null, reading: true });
		client
			.user(auth)
			.models()
			.then(
				(list) => current && setState({ list, error: null, reading: false }),
				(failure: unknown) => current && setState({ list: null, error: explain(failure), reading: false }),
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain]);
	return state;
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

/** The user's effective Factory limits: read once when the screen opens. `enabled` false asks nothing, as `useItems`. */
export function useFactoryLimits(enabled = true): { value: FactoryLimits | null; error: string | null } {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [limits, setLimits] = useState<{ value: FactoryLimits | null; error: string | null }>({ value: null, error: null });
	useEffect(() => {
		if (!enabled) return;
		let current = true;
		client
			.user(auth)
			.factoryLimits()
			.then(
				(value) => current && setLimits({ value, error: null }),
				(failure: unknown) => current && setLimits({ value: null, error: explain(failure) }),
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, enabled]);
	return limits;
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
export function useAllowance(key: unknown = 0, enabled = true): UsageNumbers | null {
	const { client } = useApp();
	const auth = useAuth();
	const [numbers, setNumbers] = useState<UsageNumbers | null>(null);
	useEffect(() => {
		if (!enabled) return;
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
	}, [client, auth, key, enabled]);
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
	// With a plan, the month's hosted minutes are the allowance (lib/hosted.ts); a day's limit the operator set still counts.
	const month = monthState(numbers);
	if (month === "used") return "used";
	if (numbers === null || numbers.allowanceSeconds === null || numbers.leftSeconds === null) return month;
	if (numbers.leftSeconds < numbers.startSeconds) return "used";
	return numbers.leftSeconds < numbers.allowanceSeconds * lowShare ? "low" : "plenty";
}

/**
 * The catalogs of every agent the user's machines report, fetched once per digest: the models and
 * efforts a subtask's agent may choose there, as the server checks a child's session against them.
 */
export function useCatalogs(machines: readonly MachineSummary[] | null): Catalogs {
	const { client } = useApp();
	const auth = useAuth();
	const [catalogs, setCatalogs] = useState<Record<string, HarnessOptions>>({});
	const wanted = (machines ?? []).flatMap((machine) => (machine.harnesses ?? []).filter((entry) => entry.optionsDigest && entry.id !== "codex").map((entry) => ({ machineId: machine.machineId, id: entry.id as "claude" | "opencode", digest: entry.optionsDigest! })));
	const keys = wanted.map((one) => `${one.machineId}/${one.id}/${one.digest}`).join(" ");
	useEffect(() => {
		let current = true;
		for (const one of wanted) {
			const key = `${one.machineId}/${one.id}/${one.digest}`;
			if (catalogs[key]) continue;
			client.user(auth).machineCatalog(one).then((options) => current && options && setCatalogs((now) => ({ ...now, [key]: options })), () => undefined);
		}
		return () => {
			current = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, auth, keys]);
	const out: Catalogs = {};
	for (const one of wanted) {
		const options = availableCatalog(catalogs[`${one.machineId}/${one.id}/${one.digest}`], machines?.find(m => m.machineId === one.machineId)?.harnesses?.find(h => h.id === one.id));
		if (options) (out[one.machineId] ??= {})[one.id] = options;
	}
	return out;
}
