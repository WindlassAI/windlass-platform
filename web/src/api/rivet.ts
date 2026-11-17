/**
 * The real `PlatformClient`: the three actors of contract.ts over `rivetkit/client` (3.1.1), and the
 * platform's information over plain HTTP (`GET PLATFORM_INFO_PATH` on the platform's address, which
 * any of the servers answers; it is not an actor).
 *
 * Where the actors are reached, and with which token, is asked of the same address when the client is
 * made (connection.ts): the RivetKit client is created once that answer is there, and gets its token
 * from a function, so a token that runs out is replaced without a new client and without a reload.
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
	type UsageNumbers,
	type UserActions,
	type UserEvents,
} from "@contract";
import { createClient, type ActorConn, type ActorConnStatus, type ActorHandle } from "rivetkit/client";
import { PlatformError, type ConnectionState, type PlatformClient, type SessionApi, type SessionFeed, type UserApi, type UserFeed } from "./client";
import { CONNECT_PATIENCE_MS, ConnectionSource, getPlatform } from "./connection";
import { isRefusedConnectionToken, toPlatformError } from "./errors";

export { toPlatformError };

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

/**
 * How long an action may take. RivetKit retries an endpoint that does not answer for as long as it
 * is asked to, so without a limit a call to a server that is down would never settle.
 */
const ACTION_TIMEOUT_MS = 30_000;
/** A push commits, pushes and opens a pull request before it answers: the server gives it two minutes. */
const PUBLISH_TIMEOUT_MS = 125_000;

/** What an action of a contract interface resolves to. */
type ResultOf<A, K extends keyof A> = A[K] extends (...args: never[]) => Promise<infer R> ? R : never;

/** Makes something once, when it is first asked for, and again after a failure. */
function lazy<T>(make: () => Promise<T>): () => Promise<T> {
	let made: Promise<T> | null = null;
	return () => {
		if (!made) {
			const mine = make();
			made = mine;
			mine.catch(() => {
				if (made === mine) made = null;
			});
		}
		return made;
	};
}

/**
 * An address without the namespace and token it may carry (`https://namespace:token@host`), for
 * messages: neither has any business on the screen.
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

/** The address the built web app was loaded from: where the platform's server is when it serves the web app itself. */
function servedFrom(): string | undefined {
	return import.meta.env.PROD && typeof location !== "undefined" ? location.origin : undefined;
}

/**
 * Where the platform's HTTP routes are: VITE_WLP_API when it is set. Otherwise a built web app asks the
 * address it was loaded from, since the platform's server can serve the web app itself (WLP_WEB_DIR),
 * and so needs nothing set at build time. In development it is the Rivet endpoint's host on the
 * platform's port, so that a browser on another machine pointed at `http://host:6420` finds them at
 * `http://host:6440`.
 */
export function platformUrl(endpoint: string, configured: string | undefined = import.meta.env.VITE_WLP_API, page: string | undefined = servedFrom()): string {
	if (configured) return configured.replace(/\/+$/, "");
	if (page) return page;
	try {
		const url = new URL(endpoint);
		const local = new URL(DEFAULT_PLATFORM_URL);
		if (url.port === "6420") return `${url.protocol}//${url.hostname}:${local.port}`;
	} catch {
		// Falls through to the default.
	}
	return DEFAULT_PLATFORM_URL;
}

/**
 * `built` is the Rivet endpoint the app was built with (`VITE_WLP_ENDPOINT`), used when the server
 * names none, as a development server does; `api` is the platform's address, which is asked for the
 * connection as soon as the client is made, beside the platform's information.
 */
export function createRivetClient(built: string = import.meta.env.VITE_WLP_ENDPOINT || DEFAULT_ENDPOINT, api: string = platformUrl(built), source: ConnectionSource = new ConnectionSource({ api })): PlatformClient {
	// What messages name; the endpoint itself may carry a namespace and a token.
	let shown = displayAddress(built);

	const connect = lazy(async () => {
		const connection = await source.connection();
		const endpoint = connection.endpoint ?? built;
		shown = displayAddress(endpoint);
		return createClient({
			endpoint,
			// The server's namespace goes with the server's endpoint; an endpoint the app was built with says its own.
			...(connection.endpoint !== null ? { namespace: connection.namespace } : {}),
			// Asked before every request and every WebSocket open, and again when the engine refuses the answer.
			...(connection.tokens ? { getToken: source.token } : {}),
			// `devtools` defaults to true on localhost and injects a script from the endpoint; the app does not want it.
			devtools: false,
		});
	});
	// A server that is not there is said by `info`, and by whatever asks for the client next.
	connect().catch(() => undefined);

	/**
	 * Calls one action through a stateless handle or a connection, typed from the contract's interface.
	 * An action the engine refuses for its token (`auth.token_expired`: the browser's clock runs behind,
	 * so RivetKit took the token for good) is sent once more: the engine refused it before any actor saw
	 * it, and RivetKit has fetched the next token by the time the refusal is thrown.
	 */
	async function call<A, K extends keyof A & string>(target: Handle | Conn | Promise<Handle>, name: K, ...args: A[K] extends (...args: infer P) => unknown ? P : never): Promise<ResultOf<A, K>> {
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// The first call of a page load is `info`: it is how the app learns the server is not there, so it waits less.
		const limit = name === "info" ? CONNECT_PATIENCE_MS : name === "publish" ? PUBLISH_TIMEOUT_MS : ACTION_TIMEOUT_MS;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				// While the connection is still being asked for, what is not answering is the platform's own address.
				reject(source.failure() ?? new PlatformError("network", `The server at ${shown} did not answer.`));
				abort.abort();
			}, limit);
		});
		// `action({ name, args })` is the raw form of `handle.name(...args)`; it exists on both.
		const send = async (): Promise<ResultOf<A, K>> => (await target).action({ name, args, signal: abort.signal });
		try {
			const result = send().catch((error: unknown) => {
				if (!isRefusedConnectionToken(error) || abort.signal.aborted) throw error;
				return send();
			});
			return await Promise.race([result, timeout]);
		} catch (error) {
			throw toPlatformError(error, shown);
		} finally {
			clearTimeout(timer);
		}
	}

	// One sign-in attempt at a time; `start`, `finish` and `demo` must reach the same actor.
	let attemptId: string | null = null;
	const login = async () => {
		const client = await connect();
		attemptId ??= crypto.randomUUID();
		return client.getOrCreate<Untyped>(ACTOR.login, [attemptId]);
	};

	// ASSUMPTION 2: `params` on the handle is what `onBeforeConnect` receives, for `.connect()` and for stateless actions alike.
	const userHandle = (auth: AuthResult) => lazy(async () => (await connect()).getOrCreate<Untyped>(ACTOR.user, [auth.profile.uid], { params: { token: auth.token } }));
	// ASSUMPTION 3: a session's actor is created by `user.createSession`, so the web app only ever looks it up.
	const sessionHandle = (auth: AuthResult, sessionId: string) => lazy(async () => (await connect()).get<Untyped>(ACTOR.agentSession, [auth.profile.uid, sessionId], { params: { token: auth.token } }));

	/**
	 * A connection that keeps a feed alive: `load` runs on every "connected" (the first and each
	 * reconnect); `live` tells the event handlers whether what they receive follows the loaded state.
	 * The connection is opened once the client is there; `listen` subscribes to its events and returns
	 * what unsubscribes.
	 */
	function feedConnection(
		handle: () => Promise<Handle>,
		report: (state: ConnectionState, error?: PlatformError) => void,
		load: (conn: Conn, isCurrent: () => boolean) => Promise<void>,
		listen: (conn: Conn) => Array<() => void>,
	): { reload: () => void; close: () => void } {
		let conn: Conn | null = null;
		let closed = false;
		let everConnected = false;
		/** The screen was told the feed failed; RivetKit's further attempts are not reported until one succeeds. */
		let reportedFailure = false;
		let generation = 0;
		let lastError: PlatformError | null = null;
		let offs: Array<() => void> = [];

		const reload = () => {
			const open = conn;
			if (!open) return;
			const mine = ++generation;
			const isCurrent = () => !closed && mine === generation;
			load(open, isCurrent).catch((error: unknown) => {
				if (!isCurrent()) return;
				const failure = toPlatformError(error, shown);
				// A connection that drops during the load is retried by RivetKit; anything else is final.
				if (open.connStatus === "connected") report("failed", failure);
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

		report("connecting");
		handle().then(
			(found) => {
				if (closed) return;
				const opened: Conn = found.connect();
				conn = opened;
				offs = [
					...listen(opened),
					opened.onStatusChange(onStatus),
					opened.onError((error) => {
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
				// The connection opens by itself; if it is already open, the status callback will not fire for it.
				if (opened.connStatus === "connected") onStatus("connected");
			},
			(error: unknown) => {
				// The server refused to say how to connect: asking again will not change that.
				if (closed) return;
				reportedFailure = true;
				report("failed", toPlatformError(error, shown));
			},
		);
		// RivetKit keeps trying a server that does not answer, and the connection is asked for as long.
		// Say so after a while; if it does connect later, "connected" follows and the screen recovers.
		const patience = setTimeout(() => {
			if (closed || everConnected || reportedFailure) return;
			reportedFailure = true;
			report("failed", lastError ?? source.failure() ?? new PlatformError("network", `The server at ${shown} is not answering.`));
		}, CONNECT_PATIENCE_MS);

		return {
			reload,
			close: () => {
				closed = true;
				clearTimeout(patience);
				for (const off of offs) off();
				conn?.dispose().catch(() => undefined);
			},
		};
	}

	function userApi(auth: AuthResult): UserApi {
		const handle = userHandle(auth);
		const act = <K extends keyof UserActions & string>(name: K, ...args: Parameters<UserActions[K]>) => call<UserActions, K>(handle(), name, ...(args as never));
		return {
			me: () => act("me"),
			chatgpt: () => act("chatgpt"),
			listSessions: () => act("listSessions"),
			createSession: (input) => act("createSession", input),
			renameSession: (id, title) => act("renameSession", id, title),
			deleteSession: (id) => act("deleteSession", id),
			github: () => act("github"),
			githubConnect: (origin, install) => act("githubConnect", { origin, install }),
			githubComplete: (ticket) => act("githubComplete", ticket),
			githubDisconnect: () => act("githubDisconnect"),
			githubRepositories: (query, fresh) => act("githubRepositories", query, fresh),
			githubBranches: (repositoryId) => act("githubBranches", repositoryId),
			repositorySetup: (repositoryId) => act("repositorySetup", repositoryId),
			saveRepositorySetup: (repositoryId, command) => act("saveRepositorySetup", { repositoryId, command }),
			repositorySecrets: (repositoryId, profile, sessionId) => act("repositorySecrets", { repositoryId, profile, sessionId }),
			saveRepositorySecret: (repositoryId, profile, secret, sessionId) => act("saveRepositorySecret", { repositoryId, profile, sessionId, ...secret }),
			deleteRepositorySecret: (repositoryId, profile, name, sessionId) => act("deleteRepositorySecret", { repositoryId, profile, sessionId, name }),
			repository: (repositoryId) => act("repository", repositoryId),
			githubRepository: (repositoryId) => act("githubRepository", repositoryId),
			saveRepositoryDefaults: (repositoryId, change) => act("saveRepositoryDefaults", { repositoryId, ...change }),
			forgetRepositoryApproval: (repositoryId, name) => act("forgetRepositoryApproval", { repositoryId, name }),
			forgetRepository: (repositoryId) => act("forgetRepository", repositoryId),
			savedRepositories: () => act("savedRepositories"),
			allowance: () => act("allowance"),
			usage: () => act("usage"),
			freeSandbox: (sessionId) => act("freeSandbox", sessionId),
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
						const sessions = await call<UserActions, "listSessions">(conn, "listSessions");
						if (!isCurrent()) return;
						feed.onConnection?.("connected");
						feed.onSessions(sessions);
						live = true;
					},
					// ASSUMPTION 4: an event broadcast as `c.broadcast("sessions", list)` arrives as `on("sessions", (list) => ...)`.
					(conn) => [
						conn.on("sessions" satisfies keyof UserEvents, (sessions: SessionSummary[]) => {
							if (live) feed.onSessions(sessions);
						}),
						conn.on("usage" satisfies keyof UserEvents, (numbers: UsageNumbers) => {
							if (live) feed.onUsage?.(numbers);
						}),
					],
				);
				return () => feedConn.close();
			},
		};
	}

	function sessionApi(auth: AuthResult, sessionId: string): SessionApi {
		const handle = sessionHandle(auth, sessionId);
		const act = <K extends keyof AgentSessionActions & string>(name: K, ...args: Parameters<AgentSessionActions[K]>) => call<AgentSessionActions, K>(handle(), name, ...(args as never));
		const reloads = new Set<() => void>();
		return {
			prompt: (input) => act("prompt", input),
			answer: (input) => act("answer", input),
			stopCall: (input) => act("stopCall", input),
			stop: () => act("stop"),
			changes: () => act("changes"),
			diff: () => act("diff"),
			publishState: () => act("publishState"),
			publish: (message) => act("publish", { message }),
			setPublishUnasked: (unasked) => act("setPublishUnasked", { unasked }),
			servers: () => act("servers"),
			approveServer: (name, fingerprint) => act("approveServer", { name, fingerprint }),
			forgetServer: (name) => act("forgetServer", { name }),
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
						const snapshot: SessionSnapshot = await call<AgentSessionActions, "snapshot">(conn, "snapshot");
						if (!isCurrent()) return;
						feed.onConnection("connected");
						// A server without questions sends no `question`: read it as none.
						feed.onSnapshot({ ...snapshot, question: snapshot.question ?? null });
						for (const item of early) feed.onItem(item);
						early = [];
						live = true;
					},
					(conn) => [
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
					],
				);
				reloads.add(feedConn.reload);
				return () => {
					reloads.delete(feedConn.reload);
					feedConn.close();
				};
			},
		};
	}

	return {
		kind: "rivet",
		// The address the app was built with until the server has named the one to use.
		get endpoint() {
			return shown;
		},
		info: () => getPlatform<PlatformInfo>(api, PLATFORM_INFO_PATH),
		login: {
			start: () => call<LoginActions, "start">(login(), "start"),
			finish: async (pastedUrl) => {
				const result = await call<LoginActions, "finish">(login(), "finish", pastedUrl);
				attemptId = null;
				return result;
			},
			demo: async () => {
				const result = await call<LoginActions, "demo">(login(), "demo");
				attemptId = null;
				return result;
			},
		},
		user: userApi,
		session: sessionApi,
		dispose() {
			source.close();
			connect().then(
				(client) => client.dispose().catch(() => undefined),
				() => undefined,
			);
		},
	};
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
 *    UNAUTHORIZED_CODES (errors.ts). A UserError with another code and the same meaning would be shown as
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
