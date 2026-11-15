/**
 * The user's GitHub connection, as every part of the interface that shows it shares it: the account
 * menu, the launch form and a session's panel. One state per signed-in user, asked for once and
 * changed by connecting and disconnecting.
 *
 * Connecting leaves the page: the browser goes to GitHub and comes back to the web app's own address
 * with what happened in the address's fragment, `#github=<ticket>` or `#github-error=<code>`. So what
 * the user was doing is kept in the tab's storage before they leave (which screen, and what the launch
 * form held), and `completeGithubReturn` picks it up again when the page loads: it takes the fragment
 * out of the address, hands the ticket to the user's actor, and goes back to that screen. Where the
 * result is said (`notice`) depends on where the user started: in the launch form, or in the account
 * menu, which opens for it.
 */
import type { AuthResult, GithubStatus } from "@contract";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { errorMessage, type PlatformClient } from "../api/client";
import { navigate, parseRoute, type Route } from "../lib/router";
import { useApp, useAuth } from "./app";

export interface GithubNotice {
	tone: "good" | "bad";
	text: string;
	/** Where it is shown: beside the repository field of the launch form, or in the account menu. */
	where: "launch" | "menu";
}

export interface GithubState {
	/** Null until it was asked for. */
	status: GithubStatus | null;
	loading: boolean;
	error: string | null;
	/** What is under way: leaving for GitHub, finishing after the return, forgetting the connection. */
	busy: "leaving" | "finishing" | "disconnecting" | null;
	notice: GithubNotice | null;
}

const EMPTY: GithubState = { status: null, loading: false, error: null, busy: null, notice: null };

let key = "";
let state: GithubState = EMPTY;
const listeners = new Set<() => void>();

function set(patch: Partial<GithubState>): void {
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
}

/** A state belongs to one user of one backend: another's starts empty. */
function use(client: PlatformClient, auth: AuthResult): void {
	const next = `${client.kind}:${auth.profile.uid}`;
	if (next === key) return;
	key = next;
	state = EMPTY;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

// ---- what is kept across the visit to GitHub ---------------------------------------------------

const RETURN_KEY = "wlp.github.return";
const DRAFT_KEY = "wlp.new-agent.draft";

interface Return {
	path: string;
	where: GithubNotice["where"];
}

function stash(storageKey: string, value: unknown): void {
	try {
		sessionStorage.setItem(storageKey, JSON.stringify(value));
	} catch {
		// Storage is unavailable: the user comes back to the list of agents, with an empty form.
	}
}

function take<T>(storageKey: string): T | null {
	try {
		const text = sessionStorage.getItem(storageKey);
		sessionStorage.removeItem(storageKey);
		return text === null ? null : (JSON.parse(text) as T);
	} catch {
		return null;
	}
}

/** What the launch form held when its user left for GitHub. */
export interface LaunchDraft {
	profile: string | null;
	model: string;
	title: string;
	prompt: string;
	repoUrl: string;
}

export function takeLaunchDraft(): LaunchDraft | null {
	const draft = take<Partial<LaunchDraft>>(DRAFT_KEY);
	if (typeof draft !== "object" || draft === null) return null;
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	return { profile: typeof draft.profile === "string" ? draft.profile : null, model: text(draft.model), title: text(draft.title), prompt: text(draft.prompt), repoUrl: text(draft.repoUrl) };
}

// ---- actions ------------------------------------------------------------------------------------

function load(client: PlatformClient, auth: AuthResult, explain: (error: unknown) => string): void {
	const mine = key;
	set({ loading: true, error: null });
	client
		.user(auth)
		.github()
		.then(
			(status) => mine === key && set({ status, loading: false }),
			(error: unknown) => mine === key && set({ loading: false, error: explain(error) }),
		);
}

/** Why GitHub sent the browser back without a connection, in a sentence. The codes are the server's (github/connect.ts). */
const RETURN_ERRORS: Record<string, string> = {
	state: "That link to connect GitHub is not valid any more. Connect GitHub again.",
	used: "That link to connect GitHub was already used. Connect GitHub again if it is not connected.",
	denied: "GitHub was not connected: the authorization was declined at GitHub.",
	code: "GitHub did not accept the authorization. Connect GitHub again.",
	not_yours: "That installation is not one your GitHub account can reach, so it was not connected.",
	pending: "The GitHub App is not installed yet. If you asked an organization for it, an owner has to approve the request first; connect GitHub again once it is installed.",
	unreachable: "GitHub could not be reached. Try again in a moment.",
};

/** What the address's fragment says of a return from GitHub, or null when it says nothing of one. */
export function readGithubReturn(hash: string): { ticket: string } | { error: string } | null {
	const ticket = /^#github=(.+)$/.exec(hash);
	if (ticket?.[1]) return { ticket: ticket[1] };
	const error = /^#github-error=([a-z_]+)$/.exec(hash);
	if (error?.[1]) return { error: RETURN_ERRORS[error[1]] ?? "Connecting GitHub did not work. Try again." };
	return null;
}

/**
 * Finishes a return from GitHub, when the page was loaded with one. Returns the screen to show next.
 * The fragment leaves the address at once: a ticket is good once, and has no place in the history.
 */
function completeGithubReturn(client: PlatformClient, auth: AuthResult, explain: (error: unknown) => string): void {
	const back = readGithubReturn(location.hash);
	if (!back) return;
	history.replaceState(null, "", location.pathname + location.search);
	const from = take<Return>(RETURN_KEY);
	const where = from?.where === "launch" ? "launch" : "menu";
	const route: Route | null = from && typeof from.path === "string" ? parseRoute(from.path) : null;
	if (route && (route.name === "new" || route.name === "session" || route.name === "home")) navigate(route, { replace: true });
	use(client, auth);
	if ("error" in back) {
		// Nothing was connected; what the connection is now is still to be asked.
		set({ notice: { tone: "bad", text: back.error, where } });
		load(client, auth, explain);
		return;
	}
	const mine = key;
	set({ busy: "finishing", notice: null });
	client
		.user(auth)
		.githubComplete(back.ticket)
		.then(
			(status) => {
				if (mine !== key) return;
				const accounts = status.connection?.accounts.map((account) => account.login) ?? [];
				set({ status, busy: null, loading: false, error: null, notice: { tone: "good", text: `GitHub connected as ${status.connection?.login ?? "you"}${accounts.length > 0 ? `, for ${list(accounts)}` : ""}.`, where } });
			},
			(error: unknown) => mine === key && set({ busy: null, notice: { tone: "bad", text: explain(error), where } }),
		);
}

/** "ada", "ada and acme", "ada, acme and two more". */
function list(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
	return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export interface Github extends GithubState {
	/** Whether this deployment has a GitHub App at all. Without one nothing of GitHub is shown. */
	enabled: boolean;
	/** Where GitHub is, for links: "https://github.com". */
	url: string;
	/** Sends the browser to GitHub. `where` says where the result is shown on the way back; `draft` is what the launch form holds. */
	connect(options: { where: GithubNotice["where"]; install?: boolean; draft?: LaunchDraft }): void;
	disconnect(): Promise<void>;
	reload(): void;
	dismiss(): void;
}

/** The connection, live. The first use asks for it; every use sees the same one. */
export function useGithub(): Github {
	const { client, platform, explain } = useApp();
	const auth = useAuth();
	const info = platform.info?.github ?? null;
	const enabled = info !== null;
	use(client, auth);
	const current = useSyncExternalStore(subscribe, () => state);

	useEffect(() => {
		if (!enabled) return;
		use(client, auth);
		// A page that was loaded with a return from GitHub finishes it; that answers what the connection is, too.
		if (readGithubReturn(location.hash)) completeGithubReturn(client, auth, explain);
		else if (state.status === null && !state.loading && state.busy === null && state.error === null) load(client, auth, explain);
	}, [client, auth, enabled, explain]);

	const connect = useCallback<Github["connect"]>(
		({ where, install, draft }) => {
			if (state.busy !== null) return;
			set({ busy: "leaving", notice: null });
			client
				.user(auth)
				.githubConnect(location.origin, install)
				.then(
					({ url }) => {
						stash(RETURN_KEY, { path: location.pathname, where } satisfies Return);
						if (draft) stash(DRAFT_KEY, draft);
						location.assign(url);
					},
					(error: unknown) => set({ busy: null, notice: { tone: "bad", text: explain(error), where } }),
				);
		},
		[client, auth, explain],
	);

	const disconnect = useCallback(async () => {
		if (state.busy !== null) return;
		set({ busy: "disconnecting", notice: null });
		try {
			set({ status: await client.user(auth).githubDisconnect(), busy: null });
		} catch (error) {
			set({ busy: null, notice: { tone: "bad", text: errorMessage(error), where: "menu" } });
			explain(error);
		}
	}, [client, auth, explain]);

	const reload = useCallback(() => load(client, auth, explain), [client, auth, explain]);
	const dismiss = useCallback(() => {
		if (state.notice) set({ notice: null });
	}, []);

	return { ...current, enabled, url: info?.url ?? "https://github.com", connect, disconnect, reload, dismiss };
}
