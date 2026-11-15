/**
 * The real `PlatformClient`: the three actors of contract.ts over `rivetkit/client` (3.1.1), and the
 * platform's information over plain HTTP (`GET PLATFORM_INFO_PATH` on the platform's address, which
 * any of the servers answers; it is not an actor).
 *
 * Nothing else in the web app imports RivetKit. The backend did not exist when this was written, so
 * everything here that rests on a reading of the docs rather than on a running server is marked
 * ASSUMPTION and listed again at the bottom of the file.
 *
 * How it talks to the actors:
 * - Actors are addressed by name and key through the untyped client (`client.getOrCreate(name, key)`),
 *   because the server's registry type is not part of the contract. Arguments and results are typed
 *   here from contract.ts.
 * - `login` is called without parameters. `user` and `agentSession` get the
 *   connection parameter `{ token }` on every handle, which RivetKit sends both when a connection
 *   opens and with each stateless action call.
 * - Actions are stateless calls on the handle (HTTP). The two live feeds each hold one connection
 *   (WebSocket) for events; the state a feed starts from (`listSessions`, `snapshot`) is fetched over
 *   that same connection, so it is ordered with the events that follow it.
 * - RivetKit reconnects a dropped connection by itself and subscribes to the events again. Events
 *   broadcast while it was down are lost, so on every "connected" the feed fetches the whole state
 *   again and hands it over (`onSessions`, `onSnapshot`); the screen rebuilds from it.
 */
import {
	DEFAULT_ENDPOINT,
	DEFAULT_PLATFORM_URL,
	PLATFORM_INFO_PATH,
	type PlatformInfo,
	type AgentSessionActions,
	type AgentSessionEvents,
	type AuthResult,
	type LoginActions,
	type SessionSnapshot,
	type SessionSummary,
	type TimelineItem,
	type UserActions,
	type UserEvents,
} from "@contract";
import { createClient, type ActorConn, type ActorConnStatus, type ActorHandle } from "rivetkit/client";
import { PlatformError, type ConnectionState, type PlatformClient, type SessionApi, type SessionFeed, type UserApi, type UserFeed } from "./client";

/**
 * The server's registry type is not part of the contract, so the actor definition is `any`: RivetKit
 * then types a handle's actions and a connection's events loosely, and this file types them from
 * contract.ts instead (`call`, and the annotated event callbacks).
 */
type Untyped = any;
type Handle = ActorHandle<Untyped>;
type Conn = ActorConn<Untyped>;

/** The actor names, as the server's registry is expected to register them. ASSUMPTION 1. */
const ACTOR = { login: "login", user: "user", agentSession: "agentSession" } as const;

/** Error codes a server might use for a refused token. ASSUMPTION 5. */
const UNAUTHORIZED_CODES = new Set(["unauthorized", "unauthenticated", "forbidden", "invalid_token", "token_expired", "bad_token", "auth"]);

/**
 * How long an action may take. RivetKit retries an endpoint that does not answer for as long as it
 * is asked to, so without a limit a call to a server that is down would never settle.
 */
const ACTION_TIMEOUT_MS = 30_000;
/** How long a feed may take to open before the screen is told the server is not answering. */
const CONNECT_PATIENCE_MS = 12_000;

/** What an action of a contract interface resolves to. */
type ResultOf<A, K extends keyof A> = A[K] extends (...args: never[]) => Promise<infer R> ? R : never;

/** Calls one action through a stateless handle or a connection, typed from the contract's interface. */
async function call<A, K extends keyof A & string>(target: Handle | Conn, endpoint: string, name: K, ...args: A[K] extends (...args: infer P) => unknown ? P : never): Promise<ResultOf<A, K>> {
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// The first call of a page load is `info`: it is how the app learns the server is not there, so it waits less.
	const limit = name === "info" ? CONNECT_PATIENCE_MS : ACTION_TIMEOUT_MS;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new PlatformError("network", `The server at ${endpoint} did not answer.`));
			abort.abort();
		}, limit);
	});
	try {
		// `action({ name, args })` is the raw form of `handle.name(...args)`; it exists on both.
		const result: Promise<ResultOf<A, K>> = target.action({ name, args, signal: abort.signal });
		return await Promise.race([result, timeout]);
	} catch (error) {
		throw toPlatformError(error, endpoint);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * An address without the namespace and token it may carry (`https://namespace:pk_...@api.rivet.dev`),
 * for messages. The token is a public one, but it has no business on the screen.
 */
export function displayAddress(address: string): string {
	try {
		const url = new URL(address);
		url.username = "";
		url.password = "";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return address;
	}
}

/**
 * Where the platform's HTTP routes are: VITE_WLP_API when it is set; otherwise, in development, the
 * Rivet endpoint's host on the platform's port, so that a browser on another machine pointed at
 * `http://host:6420` finds them at `http://host:6440`.
 */
export function platformUrl(endpoint: string, configured: string | undefined = import.meta.env.VITE_WLP_API): string {
	if (configured) return configured.replace(/\/+$/, "");
	try {
		const url = new URL(endpoint);
		const local = new URL(DEFAULT_PLATFORM_URL);
		if (url.port === "6420") return `${url.protocol}//${url.hostname}:${local.port}`;
	} catch {
		// Falls through to the default.
	}
	return DEFAULT_PLATFORM_URL;
}

/** `GET PLATFORM_INFO_PATH`. Refusals and failures have the shape of RivetKit's errors, and are read as those are. */
async function fetchInfo(api: string): Promise<PlatformInfo> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), CONNECT_PATIENCE_MS);
	try {
		const response = await fetch(`${api}${PLATFORM_INFO_PATH}`, { signal: abort.signal, headers: { accept: "application/json" } });
		const body: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			if (isRivetError(body)) throw toPlatformError(body, api);
			throw new PlatformError("internal", `The server at ${api} answered ${response.status}.`);
		}
		return body as PlatformInfo;
	} catch (error) {
		if (abort.signal.aborted) throw new PlatformError("network", `The server at ${api} did not answer.`, { cause: error });
		throw toPlatformError(error, api);
	} finally {
		clearTimeout(timer);
	}
}

export function createRivetClient(endpoint: string = import.meta.env.VITE_WLP_ENDPOINT || DEFAULT_ENDPOINT, api: string = platformUrl(endpoint)): PlatformClient {
	// `devtools` defaults to true on localhost and injects a script from the endpoint; the app does not want it.
	const client = createClient({ endpoint, devtools: false });
	// What messages name; the endpoint itself may carry a namespace and a token.
	const shown = displayAddress(endpoint);

	// One sign-in attempt at a time; `start`, `finish` and `demo` must reach the same actor.
	let attemptId: string | null = null;
	const login = () => {
		attemptId ??= crypto.randomUUID();
		return client.getOrCreate<Untyped>(ACTOR.login, [attemptId]);
	};

	// ASSUMPTION 2: `params` on the handle is what `onBeforeConnect` receives, for `.connect()` and for stateless actions alike.
	const userHandle = (auth: AuthResult) => client.getOrCreate<Untyped>(ACTOR.user, [auth.profile.uid], { params: { token: auth.token } });
	// ASSUMPTION 3: a session's actor is created by `user.createSession`, so the web app only ever looks it up.
	const sessionHandle = (auth: AuthResult, sessionId: string) => client.get<Untyped>(ACTOR.agentSession, [auth.profile.uid, sessionId], { params: { token: auth.token } });

	/**
	 * A connection that keeps a feed alive: `load` runs on every "connected" (the first and each
	 * reconnect); `live` tells the event handlers whether what they receive follows the loaded state.
	 */
	function feedConnection(handle: Handle, report: (state: ConnectionState, error?: PlatformError) => void, load: (conn: Conn, isCurrent: () => boolean) => Promise<void>): { conn: Conn; reload: () => void; close: () => void } {
		const conn = handle.connect();
		let closed = false;
		let everConnected = false;
		/** The screen was told the feed failed; RivetKit's further attempts are not reported until one succeeds. */
		let reportedFailure = false;
		let generation = 0;
		let lastError: PlatformError | null = null;

		const reload = () => {
			const mine = ++generation;
			const isCurrent = () => !closed && mine === generation;
			load(conn, isCurrent).catch((error: unknown) => {
				if (!isCurrent()) return;
				const failure = toPlatformError(error, shown);
				// A connection that drops during the load is retried by RivetKit; anything else is final.
				if (conn.connStatus === "connected") report("failed", failure);
				else lastError = failure;
			});
		};

		const onStatus = (status: ActorConnStatus) => {
			if (closed) return;
			if (status === "connected") {
				everConnected = true;
				reportedFailure = false;
				reload();
			} else if (status === "idle") {
				// RivetKit gave up: the open was refused (a bad token, a destroyed actor). `onError` said why.
				generation++;
				reportedFailure = true;
				report("failed", lastError ?? new PlatformError("network", `The connection to ${shown} could not be opened.`));
			} else {
				generation++;
				if (!reportedFailure) report(everConnected ? "reconnecting" : "connecting");
			}
		};

		const offs = [
			conn.onStatusChange(onStatus),
			conn.onError((error) => {
				if (closed) return;
				lastError = toPlatformError(error, shown);
				// Whatever RivetKit does next (it may keep retrying), these two will not get better by waiting.
				if (lastError.code === "unauthorized" || lastError.code === "not_found") {
					generation++;
					reportedFailure = true;
					report("failed", lastError);
				}
			}),
		];
		report("connecting");
		// The connection opens by itself; if it is already open, the status callback will not fire for it.
		if (conn.connStatus === "connected") onStatus("connected");
		// RivetKit keeps trying a server that does not answer. Say so after a while; if it does connect
		// later, "connected" follows and the screen recovers.
		const patience = setTimeout(() => {
			if (closed || everConnected || reportedFailure) return;
			reportedFailure = true;
			report("failed", lastError ?? new PlatformError("network", `The server at ${shown} is not answering.`));
		}, CONNECT_PATIENCE_MS);

		return {
			conn,
			reload,
			close: () => {
				closed = true;
				clearTimeout(patience);
				for (const off of offs) off();
				conn.dispose().catch(() => undefined);
			},
		};
	}

	function userApi(auth: AuthResult): UserApi {
		const handle = userHandle(auth);
		const act = <K extends keyof UserActions & string>(name: K, ...args: Parameters<UserActions[K]>) => call<UserActions, K>(handle, shown, name, ...(args as never));
		return {
			me: () => act("me"),
			chatgpt: () => act("chatgpt"),
			listSessions: () => act("listSessions"),
			createSession: (input) => act("createSession", input),
			renameSession: (id, title) => act("renameSession", id, title),
			deleteSession: (id) => act("deleteSession", id),
			watch(feed: UserFeed) {
				let live = false;
				const feedConn = feedConnection(
					handle,
					(state, error) => {
						if (state !== "connected") live = false;
						feed.onConnection?.(state, error);
					},
					async (conn, isCurrent) => {
						live = false;
						const sessions = await call<UserActions, "listSessions">(conn, shown, "listSessions");
						if (!isCurrent()) return;
						feed.onConnection?.("connected");
						feed.onSessions(sessions);
						live = true;
					},
				);
				// ASSUMPTION 4: an event broadcast as `c.broadcast("sessions", list)` arrives as `on("sessions", (list) => ...)`.
				const off = feedConn.conn.on("sessions" satisfies keyof UserEvents, (sessions: SessionSummary[]) => {
					if (live) feed.onSessions(sessions);
				});
				return () => {
					off();
					feedConn.close();
				};
			},
		};
	}

	function sessionApi(auth: AuthResult, sessionId: string): SessionApi {
		const handle = sessionHandle(auth, sessionId);
		const act = <K extends keyof AgentSessionActions & string>(name: K, ...args: Parameters<AgentSessionActions[K]>) => call<AgentSessionActions, K>(handle, shown, name, ...(args as never));
		const reloads = new Set<() => void>();
		return {
			prompt: (input) => act("prompt", input),
			answer: (input) => act("answer", input),
			stopCall: (input) => act("stopCall", input),
			stop: () => act("stop"),
			changes: () => act("changes"),
			diff: () => act("diff"),
			resync() {
				for (const reload of reloads) reload();
			},
			open(feed: SessionFeed) {
				let live = false;
				// Stored items that arrive while the snapshot is on its way. They are replayed after it; the
				// reducer drops the ones the snapshot already holds, by `seq`. Deltas cannot be told apart
				// that way and are dropped: the durable event that ends each stream carries the whole value.
				let early: TimelineItem[] = [];
				const feedConn = feedConnection(
					handle,
					(state, error) => {
						if (state !== "connected") live = false;
						feed.onConnection(state, error);
					},
					async (conn, isCurrent) => {
						live = false;
						early = [];
						const snapshot: SessionSnapshot = await call<AgentSessionActions, "snapshot">(conn, shown, "snapshot");
						if (!isCurrent()) return;
						feed.onConnection("connected");
						// A server without questions sends no `question`: read it as none.
						feed.onSnapshot({ ...snapshot, question: snapshot.question ?? null });
						for (const item of early) feed.onItem(item);
						early = [];
						live = true;
					},
				);
				const { conn } = feedConn;
				const offs = [
					conn.on("item" satisfies keyof AgentSessionEvents, (item: AgentSessionEvents["item"]) => {
						if (live) feed.onItem(item);
						else early.push(item);
					}),
					conn.on("delta" satisfies keyof AgentSessionEvents, (delta: AgentSessionEvents["delta"]) => {
						if (live) feed.onDelta(delta);
					}),
					conn.on("summary" satisfies keyof AgentSessionEvents, (summary: AgentSessionEvents["summary"]) => {
						if (live) feed.onSummary(summary);
					}),
					// ASSUMPTION 9. One that arrives before the snapshot is dropped, like a delta: by ASSUMPTION 7
					// the snapshot is newer, and unlike an item a question has no `seq` to tell. The snapshot's
					// `question` is the whole truth after every (re)connect, so one settled during a gap disappears.
					conn.on("question" satisfies keyof AgentSessionEvents, (question: AgentSessionEvents["question"] | undefined) => {
						if (live) feed.onQuestion(question ?? null);
					}),
				];
				reloads.add(feedConn.reload);
				return () => {
					reloads.delete(feedConn.reload);
					for (const off of offs) off();
					feedConn.close();
				};
			},
		};
	}

	return {
		kind: "rivet",
		endpoint: shown,
		info: () => fetchInfo(api),
		login: {
			start: () => call<LoginActions, "start">(login(), shown, "start"),
			finish: async (pastedUrl) => {
				const result = await call<LoginActions, "finish">(login(), shown, "finish", pastedUrl);
				attemptId = null;
				return result;
			},
			demo: async () => {
				const result = await call<LoginActions, "demo">(login(), shown, "demo");
				attemptId = null;
				return result;
			},
		},
		user: userApi,
		session: sessionApi,
		dispose() {
			client.dispose().catch(() => undefined);
		},
	};
}

/**
 * What RivetKit throws, as the screens want it. A `UserError` thrown in an actor arrives as an
 * `ActorError` (RivetKit's `RivetError`) with `group: "user"`, the `code` it was given (or the
 * default) and its message; any other error thrown in an actor arrives with `group: "rivetkit"`,
 * `code: "internal_error"` and a generic message.
 */
export function toPlatformError(error: unknown, endpoint: string): PlatformError {
	if (error instanceof PlatformError) return error;
	if (isRivetError(error)) {
		const { group, code, message } = error;
		if (UNAUTHORIZED_CODES.has(code)) return new PlatformError("unauthorized", message || "This sign-in is no longer accepted. Sign in again.", { cause: error });
		if (code === "not_found" || (group === "actor" && code.startsWith("destroyed"))) return new PlatformError("not_found", "There is no agent at this address.", { cause: error });
		// ASSUMPTION 10: the UserError's own code (`no_question`, `turn_running`) arrives as `code`.
		if (group === "user") return new PlatformError("user", message, { cause: error, reason: code });
		if (group === "client") return new PlatformError("network", `The server at ${endpoint} could not be reached.`, { cause: error });
		if (code === "internal_error") return new PlatformError("internal", "The server hit an internal error. Its log has the details.", { cause: error });
		return new PlatformError("internal", message || "The server refused the request.", { cause: error });
	}
	// `fetch` rejects with a TypeError when nothing answers.
	if (error instanceof TypeError) return new PlatformError("network", `The server at ${endpoint} could not be reached.`, { cause: error });
	return new PlatformError("internal", error instanceof Error && error.message !== "" ? error.message : "Something went wrong.", { cause: error });
}

/** Structural, like `RivetError.isRivetError`: an error decoded from the wire need not be an instance. */
function isRivetError(error: unknown): error is { group: string; code: string; message: string } {
	return typeof error === "object" && error !== null && "group" in error && typeof error.group === "string" && "code" in error && typeof error.code === "string" && "message" in error && typeof error.message === "string";
}

/*
 * ASSUMPTIONS to check against the running backend
 *
 * 1. Actor names. The registry registers the actors as `login`, `user`, `agentSession`
 *    (`setup({ use: { login, user, agentSession } })`), with keys [attemptId], [uid], [uid, sessionId].
 * 2. Parameters. `{ params: { token } }` given to `getOrCreate` / `get` reaches the actor's
 *    `onBeforeConnect(c, params)` both for `.connect()` and for a stateless `handle.action(...)`.
 * 3. Creation. `login` and `user` may be created by the client's `getOrCreate`. An
 *    `agentSession` is created by the server in `user.createSession`; the client uses `get`, and an
 *    unknown session fails with group "actor", code "not_found".
 * 4. Events. `c.broadcast("item", item)` (one argument) arrives as `conn.on("item", (item) => ...)`;
 *    `on` returns the function that unsubscribes; the names are "sessions" (user) and "item",
 *    "delta", "summary" (agentSession). Subscriptions survive a reconnect (RivetKit resends them).
 * 5. Errors. A `UserError` arrives with `group: "user"` and its message intact, through both the
 *    stateless handle and a connection. A refused token is recognised by its `code` only: one of
 *    UNAUTHORIZED_CODES above. A UserError with another code and the same meaning would be shown as
 *    an ordinary message instead of signing the user out.
 * 6. Connection status. "connected" is reported on the first open and on every reconnect;
 *    "disconnected" / "connecting" in between; "idle" when RivetKit stops retrying, after `onError`
 *    was called with the reason. An error thrown in `onBeforeConnect` reaches `conn.onError` as a
 *    RivetError whose `code` is the UserError's code (its message may be "Connection closed: ...").
 * 7. Ordering. The response of `snapshot()` called over the connection is delivered before the
 *    events broadcast after the actor computed it. Items that arrive earlier are buffered and
 *    replayed (deduplicated by `seq`), deltas that arrive earlier are dropped.
 * 8. Encoding. The default ("bare") carries the contract's plain JSON values unchanged, including
 *    `null`, nested objects with unknown fields (`WindlassEvent`) and numbers above 2^31 (`at`).
 * 9. Questions. The event is named "question" and carries the `PendingQuestion`, or `null` (an
 *    `undefined` argument is read as `null`), as its one argument; `snapshot()` carries `question` (a
 *    missing field is read as `null`). A "question" event that arrives while the snapshot is on its way
 *    is dropped (see 7). `answer`, `stopCall` and the steering `prompt` are actions with these names and
 *    one object argument each, as contract.ts declares them; `prompt` resolves with `{ turn, steered }`.
 * 10. Error codes. A UserError thrown with a code (`no_question`, `turn_running`) arrives with
 *    `group: "user"` and that `code`; the web app keeps it as `PlatformError.reason` and acts on those
 *    two. Since `toPlatformError` checks UNAUTHORIZED_CODES first, a UserError must not use those codes.
 */
