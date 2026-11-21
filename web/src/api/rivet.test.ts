import type { AuthResult } from "@contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, PlatformError } from "./client";
import type { Connection, ConnectionSource } from "./connection";

/**
 * RivetKit's client, replaced by one that records how it was made and answers actions from a script.
 * What RivetKit itself does with `getToken` is read from its source (connection.ts says where); these
 * tests are about what this app does around it.
 */
const rivet = vi.hoisted(() => ({
	made: [] as Array<Record<string, unknown>>,
	/** What each action call does, in order; the last one repeats. */
	script: [] as Array<() => unknown>,
	calls: [] as string[],
	connects: 0,
	disposed: 0,
}));

vi.mock("rivetkit/client", () => {
	const handle = () => ({
		action: async ({ name }: { name: string }) => {
			rivet.calls.push(name);
			const next = rivet.script[Math.min(rivet.calls.length - 1, rivet.script.length - 1)];
			return next ? next() : undefined;
		},
		connect: () => {
			rivet.connects += 1;
			return {
				connStatus: "connected",
				on: () => () => undefined,
				onStatusChange: () => () => undefined,
				onError: () => () => undefined,
				action: async () => [],
				dispose: async () => {
					rivet.disposed += 1;
				},
			};
		},
	});
	return {
		createClient: (config: Record<string, unknown>) => {
			rivet.made.push(config);
			return { getOrCreate: handle, get: handle, dispose: async () => undefined };
		},
	};
});

const { createRivetClient } = await import("./rivet");

const AUTH: AuthResult = { token: "platform-token", profile: { uid: "u1", displayName: "Test", email: null, demo: true } } as unknown as AuthResult;
const EXPIRED = { group: "auth", code: "token_expired", message: "Authentication token has expired." };

/** A source that answers at once, or when `release` is called. */
function source(connection: Connection, held = false) {
	let release: () => void = () => undefined;
	const gate = held ? new Promise<void>((done) => (release = done)) : Promise.resolve();
	const fake = {
		connection: async () => {
			await gate;
			return connection;
		},
		token: async () => "engine-token",
		failure: () => null,
		close: () => undefined,
	};
	return { source: fake as unknown as ConnectionSource, token: fake.token, release };
}

const settle = () => new Promise<void>((done) => setTimeout(done, 0));

beforeEach(() => {
	rivet.made.length = 0;
	rivet.script.length = 0;
	rivet.calls.length = 0;
	rivet.connects = 0;
	rivet.disposed = 0;
});

describe("the RivetKit client", () => {
	it("is made from what the server says: its endpoint, its namespace, and a function for the token", async () => {
		const { source: from, token } = source({ endpoint: "https://engine.test", namespace: "production", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		await settle();
		expect(rivet.made).toEqual([{ endpoint: "https://engine.test", namespace: "production", disableMetadataLookup: true, getToken: token, devtools: false }]);
		expect(client.endpoint).toBe("https://engine.test");
	});

	it("is made as it always was when the server names no endpoint and hands out no token", async () => {
		const { source: from } = source({ endpoint: null, namespace: "default", tokens: false });
		const client = createRivetClient("http://localhost:6420", "http://localhost:6440", from);
		await settle();
		expect(rivet.made).toEqual([{ endpoint: "http://localhost:6420", devtools: false }]);
		expect(client.endpoint).toBe("http://localhost:6420");
	});

	it("is made once, whatever uses it", async () => {
		const { source: from } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		rivet.script.push(() => []);
		await client.user(AUTH).listSessions();
		await client.session(AUTH, "s1").stop();
		expect(rivet.made.length).toBe(1);
	});
});

describe("an action the engine refuses for its token", () => {
	it("is sent once more, and the user sees nothing of it", async () => {
		const { source: from } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		rivet.script.push(
			() => {
				throw EXPIRED;
			},
			() => ({ turn: 3, steered: false }),
		);
		expect(await client.session(AUTH, "s1").prompt({ text: "after a day" } as never)).toEqual({ turn: 3, steered: false });
		expect(rivet.calls).toEqual(["prompt", "prompt"]);
	});

	it("is not sent a third time, and its failure does not sign the user out", async () => {
		const { source: from } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		rivet.script.push(() => {
			throw EXPIRED;
		});
		const error = (await client
			.session(AUTH, "s1")
			.prompt({ text: "hello" } as never)
			.catch((thrown: unknown) => thrown)) as PlatformError;
		expect(rivet.calls).toEqual(["prompt", "prompt"]);
		expect(error.code).toBe("network");
		expect(error.message).toBe("The connection to https://engine.test could not be renewed.");
	});

	it("is not sent again for any other refusal", async () => {
		const { source: from } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true });
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		rivet.script.push(() => {
			throw { group: "user", code: "invalid_token", message: "Your sign-in is not valid any more. Sign in again." };
		});
		const error = (await client
			.user(AUTH)
			.me()
			.catch((thrown: unknown) => thrown)) as PlatformError;
		expect(rivet.calls).toEqual(["me"]);
		expect(error.code).toBe("unauthorized");
	});
});

describe("a feed", () => {
	it("opens once the connection is known", async () => {
		const { source: from, release } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true }, true);
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		const states: ConnectionState[] = [];
		const close = client.user(AUTH).watch({ onSessions: () => undefined, onConnection: (state) => states.push(state) });
		await settle();
		expect(states).toEqual(["connecting"]);
		expect(rivet.connects).toBe(0);
		release();
		await settle();
		expect(rivet.connects).toBe(1);
		expect(states).toEqual(["connecting", "connected"]);
		close();
		expect(rivet.disposed).toBe(1);
	});

	it("that is closed before the connection is known never opens", async () => {
		const { source: from, release } = source({ endpoint: "https://engine.test", namespace: "default", tokens: true }, true);
		const client = createRivetClient("http://localhost:6420", "http://platform.test", from);
		const close = client.user(AUTH).watch({ onSessions: () => undefined });
		close();
		release();
		await settle();
		expect(rivet.connects).toBe(0);
	});

	it("says so when the server refuses to say how to connect", async () => {
		const refused = { connection: () => Promise.reject(new Error("This origin is not allowed to connect.")), token: async () => "", failure: () => null, close: () => undefined } as unknown as ConnectionSource;
		const client = createRivetClient("http://localhost:6420", "http://platform.test", refused);
		const seen: Array<[ConnectionState, string | undefined]> = [];
		client.session(AUTH, "s1").open({
			onSnapshot: () => undefined,
			onItem: () => undefined,
			onDelta: () => undefined,
			onSummary: () => undefined,
			onQuestion: () => undefined,
			onConnection: (state, error) => seen.push([state, error?.message]),
		});
		await settle();
		expect(seen).toEqual([
			["connecting", undefined],
			["failed", "This origin is not allowed to connect."],
		]);
	});
});
