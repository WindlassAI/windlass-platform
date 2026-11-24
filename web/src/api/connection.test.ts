import type { PlatformConnection } from "@contract";
import { describe, expect, it } from "vitest";
import { PlatformError } from "./client";
import { ConnectionSource, getPlatform } from "./connection";
import { isRefusedConnectionToken, toPlatformError } from "./errors";

const API = "http://platform.test";
const HOUR = 60 * 60 * 1000;

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A stand-in for the server's `/platform/connection`: each request takes the next of `answers`, and the
 * last one repeats. An answer is a Response, a function that makes one, or an Error for a server that
 * cannot be reached. `clock` is the browser's, moved by hand; waits between attempts move it too.
 */
function world(answers: Array<Response | Error | (() => Response)>, startAt = 1_000_000) {
	const state = { now: startAt, requests: [] as string[], waits: [] as number[], onWait: () => undefined as void };
	const fetcher: typeof fetch = async (input) => {
		state.requests.push(String(input));
		const next = answers[Math.min(state.requests.length - 1, answers.length - 1)];
		if (next instanceof Error) throw next;
		return typeof next === "function" ? next() : (next as Response).clone();
	};
	const source = new ConnectionSource({
		api: API,
		fetch: fetcher,
		now: () => state.now,
		sleep: async (ms) => {
			state.onWait();
			state.waits.push(ms);
			state.now += ms;
		},
	});
	return { state, source };
}

function connection(token: string | null, validForMs = HOUR, endpoint: string | null = "https://engine.test"): PlatformConnection {
	return { endpoint, namespace: "default", token: token === null ? null : { token, expiresAt: 0, validForMs } };
}

describe("the connection the server hands out", () => {
	it("is asked for once, and its token is used until shortly before it runs out", async () => {
		const { state, source } = world([json(200, connection("first")), json(200, connection("second"))]);
		expect(await source.connection()).toEqual({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		// RivetKit asks before every request: none of them reaches the server.
		for (let i = 0; i < 5; i++) expect(await source.token({ forceRefresh: false })).toBe("first");
		state.now += HOUR - 61_000;
		expect(await source.token({ forceRefresh: false })).toBe("first");
		expect(state.requests).toEqual([`${API}/platform/connection`]);
		// Inside the last minute the next one is fetched.
		state.now += 2_000;
		expect(await source.token({ forceRefresh: false })).toBe("second");
		expect(state.requests.length).toBe(2);
		// What the client is made with does not change with the token.
		expect(await source.connection()).toEqual({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		expect(state.requests.length).toBe(2);
	});

	it("after a day with the tab open, the next request gets a new token without a reload", async () => {
		const { state, source } = world([json(200, connection("monday")), json(200, connection("tuesday"))]);
		await source.connection();
		state.now += 24 * HOUR;
		expect(await source.token({ forceRefresh: false })).toBe("tuesday");
		expect(state.requests.length).toBe(2);
	});

	it("fetches the next token when the engine refused the one in hand, however much it had left", async () => {
		const { state, source } = world([json(200, connection("first")), json(200, connection("second"))]);
		await source.connection();
		expect(await source.token({ forceRefresh: true })).toBe("second");
		expect(state.requests.length).toBe(2);
		expect(await source.token({ forceRefresh: false })).toBe("second");
		expect(state.requests.length).toBe(2);
	});

	it("shares one request among everything that asks at the same time", async () => {
		const { state, source } = world([json(200, connection("first")), json(200, connection("second"))]);
		await source.connection();
		state.now += 2 * HOUR;
		const tokens = await Promise.all([source.token({ forceRefresh: false }), source.token({ forceRefresh: true }), source.token({ forceRefresh: false })]);
		expect(tokens).toEqual(["second", "second", "second"]);
		expect(state.requests.length).toBe(2);
	});

	it("counts a token's life from when it was asked for, not by the browser's clock", async () => {
		// A clock set years ahead: the token's own expiry (`expiresAt`, and the JWT's `exp`) is long past by it.
		const { state, source } = world([json(200, { ...connection("first"), token: { token: "first", expiresAt: 1_700_000_000_000, validForMs: HOUR } }), json(200, connection("second"))], 4_000_000_000_000);
		await source.connection();
		state.now += 30 * 60 * 1000;
		expect(await source.token({ forceRefresh: false })).toBe("first");
		expect(state.requests.length).toBe(1);
	});

	it("renews a short-lived token after three quarters of its life", async () => {
		const { state, source } = world([json(200, connection("first", 60_000)), json(200, connection("second", 60_000))]);
		await source.connection();
		state.now += 44_000;
		expect(await source.token({ forceRefresh: false })).toBe("first");
		state.now += 2_000;
		expect(await source.token({ forceRefresh: false })).toBe("second");
	});

	it("keeps asking a server that cannot be reached, more and more slowly, and says what it met meanwhile", async () => {
		const down = new TypeError("Failed to fetch");
		const { state, source } = world([json(200, connection("first")), down, down, json(503, { group: "platform", code: "connection_unavailable", message: "The server could not prepare a connection to the agents. Try again in a moment." }), json(200, connection("second"))]);
		await source.connection();
		state.now += 2 * HOUR;
		const seen: Array<string | null> = [];
		state.onWait = () => void seen.push(source.failure()?.message ?? null);
		expect(await source.token({ forceRefresh: false })).toBe("second");
		expect(state.waits).toEqual([500, 1_000, 2_000]);
		expect(seen).toEqual([`The server at ${API} could not be reached.`, `The server at ${API} could not be reached.`, "The server could not prepare a connection to the agents. Try again in a moment."]);
		expect(source.failure()).toBeNull();
	});

	it("waits fifteen seconds at most between attempts", async () => {
		const down = new TypeError("Failed to fetch");
		const { state, source } = world([...Array<Error>(9).fill(down), json(200, connection("first"))]);
		await source.connection();
		expect(state.waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000]);
	});

	it("does not ask again after a refusal, and says it as the server did", async () => {
		const { state, source } = world([json(403, { group: "user", code: "origin_not_allowed", message: "This origin is not allowed to connect." })]);
		const error = await source.connection().catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(PlatformError);
		expect((error as PlatformError).message).toBe("This origin is not allowed to connect.");
		expect(state.requests.length).toBe(1);
		expect(state.waits).toEqual([]);
		// The next call asks anew: the refusal is not kept.
		await source.connection().catch(() => undefined);
		expect(state.requests.length).toBe(2);
	});

	it("refuses an answer that is not a connection", async () => {
		for (const body of [null, {}, { endpoint: 5, namespace: "default", token: null }, { endpoint: null, namespace: "default", token: { token: "", expiresAt: 0, validForMs: 5 } }, { endpoint: null, namespace: "default", token: "abc" }]) {
			const { state, source } = world([json(200, body)]);
			const error = (await source.connection().catch((thrown: unknown) => thrown)) as PlatformError;
			expect(error.message).toBe(`The server at ${API} did not say how to connect.`);
			expect(state.waits).toEqual([]);
		}
	});

	it("takes no token for an answer: a development server's engine asks for none", async () => {
		const { state, source } = world([json(200, connection(null, HOUR, null))]);
		expect(await source.connection()).toEqual({ endpoint: null, namespace: "default", tokens: false });
		expect(state.requests.length).toBe(1);
	});

	it("stops asking once it is closed", async () => {
		const { state, source } = world([new TypeError("Failed to fetch")]);
		const waiting = source.connection().catch((thrown: unknown) => thrown);
		source.close();
		expect(await waiting).toBeInstanceOf(PlatformError);
		expect(state.requests.length).toBe(1);
	});
});

describe("the platform's routes", () => {
	it("answer with the body, or with the server's own refusal", async () => {
		const ok: typeof fetch = async () => json(200, { demoEnabled: true });
		expect(await getPlatform(API, "/platform/info", ok)).toEqual({ demoEnabled: true });
		const refused: typeof fetch = async () => json(403, { group: "user", code: "origin_not_allowed", message: "This origin is not allowed to connect." });
		await expect(getPlatform(API, "/platform/info", refused)).rejects.toMatchObject({ code: "user", message: "This origin is not allowed to connect." });
		const plain: typeof fetch = async () => new Response("Not found\n", { status: 404 });
		await expect(getPlatform(API, "/platform/info", plain)).rejects.toMatchObject({ code: "internal", message: `The server at ${API} answered 404.` });
		const down: typeof fetch = async () => {
			throw new TypeError("Failed to fetch");
		};
		await expect(getPlatform(API, "/platform/info", down)).rejects.toMatchObject({ code: "network", message: `The server at ${API} could not be reached.` });
	});
});

describe("a request that meets the platform restarting", () => {
	it("is told apart from a real internal error", () => {
		expect(toPlatformError({ group: "guard", code: "actor_stopped_while_waiting", message: "" }, "https://engine.test")).toMatchObject({ code: "restarting", message: "The platform is restarting. Trying again…" });
		expect(toPlatformError(new Error("HTTP request error: Request failed: TypeError: Failed to fetch"), "https://engine.test")).toMatchObject({ code: "restarting" });
		expect(toPlatformError(new Error("HTTP request error: Internal Server Error (500):\n"), "https://engine.test")).toMatchObject({ code: "internal" });
	});
});

describe("what the engine refuses", () => {
	it("is told apart from a sign-in the platform refuses, which shares the code", () => {
		const engine = { group: "auth", code: "token_expired", message: "Authentication token has expired." };
		const platform = { group: "user", code: "invalid_token", message: "Your sign-in is not valid any more. Sign in again." };
		expect(isRefusedConnectionToken(engine)).toBe(true);
		expect(isRefusedConnectionToken({ ...engine, code: "invalid_token" })).toBe(true);
		expect(isRefusedConnectionToken({ ...engine, code: "insufficient_permissions" })).toBe(false);
		expect(isRefusedConnectionToken(platform)).toBe(false);
		// The engine's refusal never signs the user out; the platform's does.
		expect(toPlatformError(engine, "https://engine.test")).toMatchObject({ code: "network", message: "The connection to https://engine.test could not be renewed." });
		expect(toPlatformError({ ...engine, code: "insufficient_permissions" }, "https://engine.test")).toMatchObject({ code: "internal", message: "The server at https://engine.test refused the connection." });
		expect(toPlatformError(platform, "https://engine.test")).toMatchObject({ code: "unauthorized", message: "Your sign-in is not valid any more. Sign in again." });
	});
});
