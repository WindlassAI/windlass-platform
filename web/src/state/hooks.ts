import { availableCatalog } from "../../../server/src/sandbox/harnesses.js";
import { monthState } from "../lib/hosted";
import type { AccountSettings, ChatgptStatus, FactoryLimits, MachineSummary, ModelProviderStatus, ModelList, SessionSummary, UsageNumbers } from "@contract";
import type { HarnessOptions } from "@contract";
import type { Catalogs } from "../lib/subtask-agents";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ConnectionState, PlatformError } from "../api/client";
import { useApp, useAuth } from "./app";
import { createSessionStore, type SessionState } from "./sessionStore";

/** Refresh the checked model catalogs when returning from Settings. */
export const PROVIDERS_CHANGED = "wlp-model-providers-changed";

function watchModelChanges(read: (isCurrent: () => boolean) => void) {
	// Ignore replies superseded by a refresh or by unmounting.
	let version = 0;
	const refresh = () => {
		const request = ++version;
		read(() => request === version);
	};
	refresh();
	window.addEventListener("focus", refresh);
	window.addEventListener(PROVIDERS_CHANGED, refresh);
	return () => {
		version++;
		window.removeEventListener("focus", refresh);
		window.removeEventListener(PROVIDERS_CHANGED, refresh);
	};
}

export function useHostedProviders(enabled = true) {
	const { client } = useApp();
	const auth = useAuth();
	const [providers, setProviders] = useState<ModelProviderStatus[] | null>(null);
	useEffect(() => {
		if (!enabled) return;
		return watchModelChanges(isCurrent => {
			client.user(auth).modelProviders().then(
				rows => { if (isCurrent()) setProviders(rows); },
				() => { if (isCurrent()) setProviders([]); },
			);
		});
	}, [client, auth, enabled]);
	return providers;
}

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
	error: string | null;
	reading: boolean;
	reload(): void;
	replace(settings: AccountSettings): void;
}

export function useAccount(): AccountState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<Pick<AccountState, "settings" | "error" | "reading">>({ settings: null, error: null, reading: true });
	// A saved replacement also invalidates reads already in flight.
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
	error: string | null;
	reading: boolean;
}

export function useModels(): ModelsState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<ModelsState>({ list: null, error: null, reading: true });
	useEffect(() => {
		setState({ list: null, error: null, reading: true });
		return watchModelChanges(isCurrent => {
			client.user(auth).models().then(
				list => isCurrent() && setState({ list, error: null, reading: false }),
				(failure: unknown) => isCurrent() && setState({ list: null, error: explain(failure), reading: false }),
			);
		});
	}, [client, auth, explain]);
	return state;
}

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
		let version = 0;
		const stop = watchModelChanges(() => {
			const mine = ++version;
			client.user(auth).chatgpt().then(
				value => { if (mine === version) { setStatus(value); setError(null); } },
				failure => { if (mine === version) setError(explain(failure)); },
			);
		});
		return () => { version++; stop(); };
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

const ALLOWANCE_EVERY_MS = 60_000;

/** Refresh after a turn or refusal, and while running time accrues. Hide stale figures after a failed read. */
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

/** Fetch each machine catalog once per digest. */
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
