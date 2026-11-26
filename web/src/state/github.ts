/**
 * The user's GitHub connection, as every part of the interface that shows it shares it: the account
 * menu, the start composer and a session's panel. One state per signed-in user, asked for once and
 * changed by connecting and disconnecting.
 *
 * Connecting happens in a popup window, so the page and what the start composer holds never unload.
 * GitHub sends that window back to the web app's own address with what happened in the address's
 * fragment, `#github=<ticket>` or `#github-error=<code>`, as the server's callback always did
 * (server/src/github/connect.ts: the same state, the same callback). There the window does nothing but
 * hand the fragment to the page that opened it (`relayGithubReturn`) and close: `postMessage` to its
 * opener, at this origin only. The opener takes a message only from this origin, only from a window it
 * opened, and only of that shape (`githubMessageHash`), and finishes as a return always did: the ticket
 * goes to the user's actor, which checks that it is this user's. A window closed before GitHub answered
 * leaves things as they were, and says so.
 *
 * Where the browser blocks the popup, connecting leaves the page instead: the browser goes to GitHub and
 * comes back to this page. What the user was doing is kept in the tab's storage before they leave
 * (which screen, and what the start composer held), and `completeGithubReturn` picks it up again when
 * the page loads: it takes the fragment out of the address, hands the ticket to the user's actor, and
 * goes back to that screen. Where the result is said (`notice`) depends on where the user started: in
 * the start composer, or on the account: Settings' GitHub section, or the account menu, which opens for it
 * on any other page.
 */
import type { AuthResult, GithubStatus, ItemMode } from "@contract";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { errorMessage, type PlatformClient } from "../api/client";
import { navigate, parseRoute, type Route } from "../lib/router";
import { useApp, useAuth } from "./app";

export interface GithubNotice {
	tone: "good" | "bad";
	text: string;
	/** Where it is shown: in the start composer's repository picker, or on the account (Settings, or the account menu elsewhere). */
	where: "launch" | "account";
}

export interface GithubState {
	/** Null until it was asked for. */
	status: GithubStatus | null;
	loading: boolean;
	error: string | null;
	/** What is under way: leaving for GitHub, waiting on GitHub in the popup window, finishing after the return, forgetting the connection. */
	busy: "leaving" | "popup" | "finishing" | "disconnecting" | null;
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

/**
 * What the start composer held when its user left for GitHub: the task, a pasted address, and each
 * choice its user made there. Null and "" where they made none, so that the defaults stand in again on
 * the way back. `place` is "platform" for this platform, or a machine's id. `kind` is whether it was
 * starting an agent or filing a work item, with that item's acceptance criteria.
 */
export interface LaunchDraft {
	title?: string | null;
	prompt: string;
	repoUrl: string;
	profile: string | null;
	model: string;
	effort: string;
	place: string | null;
	harness: string | null;
	mode: string | null;
	kind: "agent" | "item" | null;
	itemMode?: ItemMode;
	criteria: string;
}

export function takeLaunchDraft(): LaunchDraft | null {
	const draft = take<Partial<LaunchDraft>>(DRAFT_KEY);
	if (typeof draft !== "object" || draft === null) return null;
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	const chosen = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
	return { ...(typeof draft.title === "string" && { title: draft.title }), prompt: text(draft.prompt), repoUrl: text(draft.repoUrl), profile: chosen(draft.profile), model: text(draft.model), effort: text(draft.effort), place: chosen(draft.place), harness: chosen(draft.harness), mode: chosen(draft.mode), kind: draft.kind === "agent" || draft.kind === "item" ? draft.kind : null, ...(draft.kind === "item" && (draft.itemMode === "single" || draft.itemMode === "orchestrate") && { itemMode: draft.itemMode }), criteria: text(draft.criteria) };
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

// ---- the popup window ----------------------------------------------------------------------------

/** The popup's name, and the type of the one message it sends. */
const POPUP_NAME = "wlp-github";
const MESSAGE_TYPE = "wlp.github.return";
/** How often the opener looks whether the popup was closed, and how long it waits for a message after. */
const POPUP_WATCH_MS = 500;
const POPUP_GRACE_MS = 600;

/** The popup that is open, where its result is said, and the watch on it. */
let popup: { window: Window; where: GithubNotice["where"]; timer: ReturnType<typeof setInterval>; done: boolean } | null = null;

/** Whether a window is this page's own origin: reading another origin's location throws. */
function sameOrigin(other: Window, self: Window): boolean {
	try {
		return other.location.origin === self.location.origin;
	} catch {
		return false;
	}
}

/**
 * In the popup, on its way back from GitHub: hands the fragment to the page that opened it, at this
 * origin only, takes it out of the address, and closes. True when it did, and the app is not started
 * here. A page with no opener of this origin (the redirect, or a link opened by hand) finishes the
 * return itself, as it always did.
 */
export function relayGithubReturn(self: Window = window): boolean {
	if (readGithubReturn(self.location.hash) === null) return false;
	const opener = self.opener as Window | null;
	if (!opener || opener === self || !sameOrigin(opener, self)) return false;
	const hash = self.location.hash;
	self.history.replaceState(null, "", self.location.pathname + self.location.search);
	opener.postMessage({ type: MESSAGE_TYPE, hash }, self.location.origin);
	self.close();
	return true;
}

/**
 * The fragment a message carries, when the message is the popup's: from this origin, from a window this
 * page opened, and of that shape. Null for anything else, which is ignored.
 */
export function githubMessageHash(event: Pick<MessageEvent, "origin" | "source" | "data">, self: Window = window): string | null {
	if (event.origin !== self.location.origin) return null;
	const source = event.source as Window | null;
	if (!source || typeof (source as { postMessage?: unknown }).postMessage !== "function") return null;
	let opened: boolean;
	try {
		opened = source.opener === self;
	} catch {
		return null;
	}
	if (!opened) return null;
	const data = event.data as { type?: unknown; hash?: unknown } | null;
	if (typeof data !== "object" || data === null || data.type !== MESSAGE_TYPE || typeof data.hash !== "string") return null;
	return readGithubReturn(data.hash) === null ? null : data.hash;
}

/** The popup window, opened at once in the click that asked for it (a browser blocks one opened later). Null when it was blocked. */
function openPopup(): Window | null {
	const width = 640;
	const height = 760;
	const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
	const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 3));
	let opened: Window | null = null;
	try {
		opened = window.open("about:blank", POPUP_NAME, `popup,width=${width},height=${height},left=${left},top=${top}`);
	} catch {
		return null;
	}
	if (!opened) return null;
	try {
		// While the address is asked for: a dark page that says what is coming, not a white flash.
		opened.document.title = "Connecting GitHub…";
		opened.document.body.style.cssText = "margin:0;display:grid;place-items:center;height:100vh;background:#0b0c0e;color:#9a9ca3;font:14px system-ui,sans-serif";
		opened.document.body.textContent = "Opening GitHub…";
	} catch {
		// Another origin's page is already in a window of this name: it is navigated all the same.
	}
	return opened;
}

function stopWatching(): void {
	if (popup) clearInterval(popup.timer);
	popup = null;
}

/** Watches the popup: a window closed without a message leaves things as they were, and says so. */
function watchPopup(client: PlatformClient, auth: AuthResult, explain: (error: unknown) => string, opened: Window, where: GithubNotice["where"]): void {
	stopWatching();
	const watch = { window: opened, where, done: false, timer: setInterval(() => {
		if (!opened.closed || watch.done) return;
		clearInterval(watch.timer);
		// The message is posted just before the window closes: a moment for it to arrive.
		setTimeout(() => {
			if (watch.done || popup !== watch) return;
			popup = null;
			if (state.busy === "popup" || state.busy === "leaving") set({ busy: null, notice: { tone: "bad", text: "GitHub was not connected: its window was closed before it finished.", where } });
			// What the connection is now, in case it was finished elsewhere meanwhile.
			load(client, auth, explain);
		}, POPUP_GRACE_MS);
	}, POPUP_WATCH_MS) };
	popup = watch;
}

/** Who a message from the popup is finished for: the page's client and user, as the newest `useGithub` saw them. */
let receiver: { client: PlatformClient; auth: AuthResult; explain: (error: unknown) => string } | null = null;
let listening = false;

/** One listener for the page, however many parts of it show the connection: a return is finished once. */
function listen(client: PlatformClient, auth: AuthResult, explain: (error: unknown) => string): void {
	receiver = { client, auth, explain };
	if (listening) return;
	listening = true;
	window.addEventListener("message", (event) => {
		if (receiver) onGithubMessage(receiver.client, receiver.auth, receiver.explain, event);
	});
}

/** Takes a message from the popup: finishes the return it carries, where the popup was opened from. */
function onGithubMessage(client: PlatformClient, auth: AuthResult, explain: (error: unknown) => string, event: MessageEvent): void {
	const hash = githubMessageHash(event);
	if (hash === null) return;
	const where = popup?.where ?? "account";
	if (popup) popup.done = true;
	stopWatching();
	finishReturn(client, auth, explain, hash, where);
}

/**
 * Finishes a return from GitHub, when the page was loaded with one. Returns the screen to show next.
 * The fragment leaves the address at once: a ticket is good once, and has no place in the history.
 */
function completeGithubReturn(client: PlatformClient, auth: AuthResult, explain: (error: unknown) => string): void {
	if (!readGithubReturn(location.hash)) return;
	const hash = location.hash;
	history.replaceState(null, "", location.pathname + location.search);
	const from = take<Return>(RETURN_KEY);
	const where = from?.where === "launch" ? "launch" : "account";
	const route: Route | null = from && typeof from.path === "string" ? parseRoute(from.path) : null;
	if (route && (route.name === "new" || route.name === "session" || route.name === "home" || route.name === "repository")) navigate(route, { replace: true });
	finishReturn(client, auth, explain, hash, where);
}

/** Hands a return's ticket to the user's actor, or says why there is none, where the user started. */
function finishReturn(client: PlatformClient, auth: AuthResult, explain: (error: unknown) => string, hash: string, where: GithubNotice["where"]): void {
	const back = readGithubReturn(hash);
	if (!back) return;
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
	/**
	 * Connects GitHub in a popup window; where the browser blocks one, sends the page to GitHub. Call it in
	 * the click itself. `where` says where the result is shown; `draft` is what the start composer holds,
	 * kept for the way back when the page leaves.
	 */
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

	// The popup's message, whichever screen is showing when it comes.
	useEffect(() => {
		if (enabled) listen(client, auth, explain);
	}, [client, auth, enabled, explain]);

	useEffect(() => {
		if (!enabled) return;
		use(client, auth);
		// A page that was loaded with a return from GitHub finishes it; that answers what the connection is, too.
		if (readGithubReturn(location.hash)) completeGithubReturn(client, auth, explain);
		else if (state.status === null && !state.loading && state.busy === null && state.error === null) load(client, auth, explain);
	}, [client, auth, enabled, explain]);

	const connect = useCallback<Github["connect"]>(
		({ where, install, draft }) => {
			if (state.busy !== null) {
				// Asked again while its window is open: that window comes forward.
				if (state.busy === "popup" && popup && !popup.window.closed) popup.window.focus();
				return;
			}
			// Opened now, in the click: a browser blocks a window opened once the address has come back.
			const opened = openPopup();
			set({ busy: "leaving", notice: null });
			const mine = key;
			client
				.user(auth)
				.githubConnect(location.origin, install)
				.then(
					({ url }) => {
						if (mine !== key) return opened?.close();
						if (opened === null) {
							// Blocked: the page goes, and what the user was doing is kept for the way back.
							stash(RETURN_KEY, { path: location.pathname, where } satisfies Return);
							if (draft) stash(DRAFT_KEY, draft);
							location.assign(url);
							return;
						}
						if (opened.closed) {
							set({ busy: null, notice: { tone: "bad", text: "GitHub was not connected: its window was closed before it finished.", where } });
							return;
						}
						opened.location.href = url;
						set({ busy: "popup" });
						watchPopup(client, auth, explain, opened, where);
					},
					(error: unknown) => {
						opened?.close();
						set({ busy: null, notice: { tone: "bad", text: explain(error), where } });
					},
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
			set({ busy: null, notice: { tone: "bad", text: errorMessage(error), where: "account" } });
			explain(error);
		}
	}, [client, auth, explain]);

	const reload = useCallback(() => load(client, auth, explain), [client, auth, explain]);
	const dismiss = useCallback(() => {
		if (state.notice) set({ notice: null });
	}, []);

	return { ...current, enabled, url: info?.url ?? "https://github.com", connect, disconnect, reload, dismiss };
}
