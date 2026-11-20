/**
 * The mock's side of the account's settings: the defaults for new agents, the user's own MCP servers
 * and the secrets those read, and what a session's panel says of such a server after a turn. The
 * refusals are held against the server's own words, and what the mock keeps of a definition against
 * what the server keeps.
 */
import { describe, expect, it } from "vitest";
import { MAX_ACCOUNT_SECRETS, MAX_PERSONAL_SERVERS, type SandboxProfile } from "@contract";
import { accountSecretReach, accountSecretsNote } from "../../../server/src/account-secrets";
import { ServerProblem, cleanServerDefinition, cleanServerName, cleanUnasked } from "../../../server/src/personal-servers";
import { personalServerReach } from "../../../server/src/server-question";
import { PlatformError } from "./client";
import { MOCK_E2B_PROFILES, MOCK_PROFILES, createMockClient, mockCleanServer, mockPersonalReach } from "./mock";

const ada = { token: "mock:chatgpt:u_account:ada@example.com", profile: { uid: "u_account", email: "ada@example.com", demo: false } };
const make = (options: Parameters<typeof createMockClient>[0] = {}) => createMockClient({ pace: 0, ...options });

async function refusal(call: Promise<unknown>): Promise<PlatformError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof PlatformError) return error;
		throw error;
	}
	throw new Error("the call was not refused");
}

/** The server's sentence for a setting that is neither true nor false. */
function settingRefusal(): string {
	try {
		cleanUnasked("yes");
	} catch (error) {
		if (error instanceof ServerProblem) return error.message;
	}
	throw new Error("the server took the setting");
}

/** What the server makes of a name and a definition: what it keeps, or its refusal. */
function onServer(name: unknown, definition: unknown): { kept: unknown } | { refused: string } {
	try {
		return { kept: { name: cleanServerName(name), definition: cleanServerDefinition(definition) } };
	} catch (error) {
		if (error instanceof ServerProblem) return { refused: error.message };
		throw error;
	}
}
function onMock(name: unknown, definition: unknown): { kept: unknown } | { refused: string } {
	try {
		return { kept: mockCleanServer(name, definition) };
	} catch (error) {
		if (error instanceof PlatformError && error.reason === "bad_server") return { refused: error.message };
		throw error;
	}
}

describe("the mock's rules for a server of the user's own", () => {
	it("keeps and refuses what the server keeps and refuses, in the server's words", () => {
		const cases: Array<[unknown, unknown]> = [
			["tracker", { command: "tracker-mcp", args: ["--stdio"], env: { TRACKER_TOKEN: "${TRACKER_TOKEN}" } }],
			["docs.v2", { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, tools: { deny: ["delete_*"] }, timeoutSeconds: 90 }],
			["ordered", { protocol: "legacy", enabled: false, untrusted: false, startupTimeoutSeconds: 5, cwd: "tools", args: [], command: "x" }],
			["", { command: "x" }],
			["-dash", { command: "x" }],
			[`a${"b".repeat(64)}`, { command: "x" }],
			["windlass_platform", { command: "x" }],
			["Windlass_Platform.2", { command: "x" }],
			["a", null],
			["a", []],
			["a", {}],
			["a", { comand: "x" }],
			["a", { command: "x", url: "https://example.com/mcp" }],
			["a", { command: "x", headers: {} }],
			["a", { url: "https://example.com/mcp", env: {} }],
			["a", { url: "ftp://example.com/mcp" }],
			["a", { command: "" }],
			["a", { command: "x", args: [7] }],
			["a", { command: "x", env: { "1BAD": "v" } }],
			["a", { command: "x", tools: { only: [] } }],
			["a", { command: "x", tools: { allow: [""] } }],
			["a", { command: "x", timeoutSeconds: 3601 }],
			["a", { command: "x", startupTimeoutSeconds: 0 }],
			["a", { command: "x", untrusted: "no" }],
			["a", { command: "x", protocol: "newest" }],
			["a", { command: "x", args: ["y".repeat(9000)] }],
			["a", { command: "x\0" }],
		];
		for (const [name, definition] of cases) expect(onMock(name, definition), JSON.stringify([name, definition]).slice(0, 80)).toEqual(onServer(name, definition));
		// Both kinds are among the cases.
		expect(cases.filter(([name, definition]) => "kept" in onServer(name, definition))).toHaveLength(3);
	});

	it("says what such a server can reach in the words the server says it in, for every sandbox", () => {
		const profiles: SandboxProfile[] = [...MOCK_PROFILES, ...MOCK_E2B_PROFILES];
		expect(profiles.filter((profile) => profile.available).map(mockPersonalReach)).toEqual(personalServerReach(profiles));
	});
});

describe("the mock's account settings", () => {
	it("starts with nothing saved, and says what a server would reach in each sandbox the deployment can run", async () => {
		const mock = make();
		const settings = await mock.user(ada).account();
		expect(settings).toMatchObject({ defaults: { profile: null, model: null, updatedAt: null }, servers: [], limits: { servers: MAX_PERSONAL_SERVERS, secrets: MAX_ACCOUNT_SECRETS } });
		expect(settings.serverReach.map((reach) => reach.profile)).toEqual(MOCK_PROFILES.filter((profile) => profile.available).map((profile) => profile.id));
		expect(settings.serverReach[0]?.command).toContain("outside Windlass's sandbox around commands");
		expect((await mock.user(ada).accountSecrets("docker-windlass-sandbox")).secrets).toEqual([]);
		mock.dispose();
	});

	it("saves the defaults field by field, and refuses what the deployment does not offer", async () => {
		const mock = make();
		const user = mock.user(ada);
		expect(await user.saveAccountDefaults({ profile: "docker-hardened" })).toMatchObject({ profile: "docker-hardened", model: null });
		expect(await user.saveAccountDefaults({ model: "gpt-6-luna" })).toMatchObject({ profile: "docker-hardened", model: "gpt-6-luna" });
		expect((await refusal(user.saveAccountDefaults({ model: "gpt-3" }))).reason).toBe("bad_model");
		expect((await refusal(user.saveAccountDefaults({ profile: "daytona" }))).reason).toBe("bad_input");
		// A refused save changed nothing, and a repository's defaults are its own.
		expect((await user.account()).defaults).toMatchObject({ profile: "docker-hardened", model: "gpt-6-luna" });
		expect((await user.repository(7101)).defaults).toMatchObject({ profile: "docker-hardened", model: "gpt-6-luna" });
		expect((await user.repository(7110)).defaults).toMatchObject({ profile: null, model: null });
		await user.saveAccountDefaults({ profile: null });
		expect(await user.saveAccountDefaults({ model: null })).toEqual({ profile: null, model: null, updatedAt: null });
		mock.dispose();
	});

	it("adds, changes and deletes a server, and holds to the name and the limit", async () => {
		const mock = make();
		const user = mock.user(ada);
		const added = await user.savePersonalServer({ name: "tracker", definition: { command: "tracker-mcp", args: ["--stdio"], env: { TRACKER_TOKEN: "${TRACKER_TOKEN}" } } });
		expect(added.servers).toMatchObject([{ name: "tracker", remote: false, subject: "tracker-mcp --stdio", enabled: true, unasked: false, reads: [{ name: "TRACKER_TOKEN", saved: false }] }]);
		expect((await refusal(user.savePersonalServer({ name: "tracker", definition: { command: "other" } }))).reason).toBe("server_exists");
		expect((await refusal(user.savePersonalServer({ name: "nowhere", definition: { command: "x" }, existing: true }))).reason).toBe("server_not_found");
		expect((await refusal(user.savePersonalServer({ name: "windlass_platform", definition: { command: "x" } }))).reason).toBe("bad_server");
		const changed = await user.savePersonalServer({ name: "tracker", definition: { url: "https://tracker.example.com/mcp" }, unasked: true, existing: true });
		expect(changed.servers).toMatchObject([{ name: "tracker", remote: true, subject: "https://tracker.example.com/mcp", unasked: true, reads: [] }]);
		// Its tools run without asking only while its user says so: the setting is saved with each change, and is no key of the definition.
		expect(changed.servers[0]?.definition).toEqual({ url: "https://tracker.example.com/mcp" });
		expect((await refusal(user.savePersonalServer({ name: "tracker", definition: { command: "x" }, unasked: "yes" as never, existing: true }))).message).toBe(settingRefusal());
		expect((await user.savePersonalServer({ name: "tracker", definition: { url: "https://tracker.example.com/mcp" }, existing: true })).servers[0]?.unasked).toBe(false);
		for (let index = 1; index < MAX_PERSONAL_SERVERS; index += 1) await user.savePersonalServer({ name: `server-${index}`, definition: { command: "x" } });
		expect((await refusal(user.savePersonalServer({ name: "one-more", definition: { command: "x" } }))).reason).toBe("too_many_servers");
		// At the limit a saved one can still be changed.
		await user.savePersonalServer({ name: "tracker", definition: { command: "tracker-mcp" }, existing: true });
		expect((await user.deletePersonalServer("tracker")).servers).toHaveLength(MAX_PERSONAL_SERVERS - 1);
		mock.dispose();
	});

	it("lists the account's secrets without a value, with what each reaches and the repositories that have one of the name", async () => {
		const mock = make();
		const user = mock.user(ada);
		const value = "made-up-value-0123456789";
		const list = await user.saveAccountSecret("docker-windlass-sandbox", { name: "DEPLOY_KEY", value, scope: "setup" });
		expect(list.secrets).toMatchObject([{ name: "DEPLOY_KEY", scope: "setup", reach: { servers: true, commands: "no", note: null }, repositories: ["acme/harbor"] }]);
		expect(JSON.stringify([list, await user.account()])).not.toContain(value);
		// The repository's own list says that its secret stands in for the account's there.
		const harbor = await user.repositorySecrets(7101, "docker-windlass-sandbox");
		expect(harbor.secrets.filter((secret) => secret.account).map((secret) => secret.name)).toEqual(["DEPLOY_KEY"]);
		// What it reaches is the server's own word for it, in each kind of sandbox.
		for (const profile of [...MOCK_PROFILES, ...MOCK_E2B_PROFILES].filter((candidate) => candidate.available)) {
			const there = createMockClient({ pace: 0, sandbox: profile.id.startsWith("e2b") ? "e2b" : "docker" });
			const listed = await there.user(ada).saveAccountSecret(profile.id, { name: "TRACKER_TOKEN", value, scope: "setup" });
			expect(listed.secrets[0]?.reach, profile.id).toEqual(accountSecretReach("setup", profile));
			// Its scope alone is changed, as a repository's secret's is: it then reaches what the server says such a secret reaches there.
			const wide = await there.user(ada).saveAccountSecret(profile.id, { name: "TRACKER_TOKEN", scope: "agent" });
			expect(wide.secrets[0], profile.id).toMatchObject({ scope: "agent", reach: accountSecretReach("agent", profile) });
			expect(wide.secrets[0]?.reach, profile.id).toEqual({ servers: true, commands: "yes", note: null });
			there.dispose();
		}
		expect((await refusal(user.saveAccountSecret("docker-windlass-sandbox", { name: "PATH", value, scope: "setup" }))).reason).toBe("bad_secret");
		expect((await refusal(user.saveAccountSecret("docker-windlass-sandbox", { name: "SHORT", value: "abc", scope: "setup" }))).reason).toBe("bad_secret");
		for (let index = 1; index < MAX_ACCOUNT_SECRETS; index += 1) await user.saveAccountSecret("docker-windlass-sandbox", { name: `KEPT_${index}`, value, scope: "setup" });
		expect((await refusal(user.saveAccountSecret("docker-windlass-sandbox", { name: "ONE_MORE", value, scope: "setup" }))).reason).toBe("too_many_secrets");
		expect((await refusal(user.saveAccountSecret("docker-windlass-sandbox", { name: "NOT_SAVED", scope: "agent" }))).reason).toBe("secret_not_found");
		expect((await refusal(user.saveAccountSecret("docker-windlass-sandbox", { name: "KEPT_1", scope: "everyone" as never }))).reason).toBe("bad_secret");
		// A new value for a saved name is taken at the limit, and a deleted one makes room.
		await user.saveAccountSecret("docker-windlass-sandbox", { name: "DEPLOY_KEY", value, scope: "setup" });
		expect((await user.deleteAccountSecret("docker-windlass-sandbox", "DEPLOY_KEY")).secrets).toHaveLength(MAX_ACCOUNT_SECRETS - 1);
		mock.dispose();
	});

	it("lists the user's own servers in an agent's panel after its next turn, apart from the project's, with why one did not start", async () => {
		const mock = make();
		const user = mock.user(ada);
		await user.savePersonalServer({ name: "issues", definition: { command: "issues-mcp", env: { ISSUES_TOKEN: "${ISSUES_TOKEN}" } } });
		await user.savePersonalServer({ name: "wiki", definition: { url: "https://wiki.example.com/mcp" } });
		await user.savePersonalServer({ name: "off", definition: { command: "x", enabled: false } });
		const turn = async (profile: "docker-windlass-sandbox" | "docker-hardened") => {
			const session = await user.createSession({ profile });
			const api = mock.session(ada, session.id);
			await api.prompt({ text: "Say hello." });
			for (let waited = 0; (await user.listSessions()).find((one) => one.id === session.id)?.status !== "idle"; waited += 1) {
				if (waited > 400) throw new Error("the turn did not end");
				await new Promise((done) => setTimeout(done, 5));
			}
			return { api, summary: (await user.listSessions()).find((one) => one.id === session.id) };
		};

		// No secret is saved: the server that reads one does not start, and the one that reads none does.
		const first = await turn("docker-windlass-sandbox");
		expect(first.summary?.servers?.count).toBe(2);
		const before = await first.api.servers();
		expect(before.servers).toMatchObject([
			{ name: "issues", origin: "user", state: "failed", reason: "the environment variable ISSUES_TOKEN named in its env is not set", approval: null, fingerprint: null },
			{ name: "wiki", origin: "user", state: "running", remote: true, approval: null },
		]);
		expect(before.servers.every((server) => !("asks" in server))).toBe(true);
		expect(before.accountSecrets).toBeNull();

		// With the secret saved, a sandbox that exists has it from its next turn.
		await user.saveAccountSecret("docker-windlass-sandbox", { name: "ISSUES_TOKEN", value: "made-up-value-0123456789", scope: "setup" });
		await first.api.prompt({ text: "Say hello again." });
		for (let waited = 0; (await first.api.servers()).servers[0]?.state !== "running"; waited += 1) {
			if (waited > 400) throw new Error("the server did not start with the next turn");
			await new Promise((done) => setTimeout(done, 5));
		}

		// Where commands are not held in Windlass's sandbox, an account's secret for MCP servers only reaches no server, and the panel says why.
		const open = await turn("docker-hardened");
		const there = await open.api.servers();
		expect(there.servers.find((server) => server.name === "issues")).toMatchObject({ state: "failed" });
		expect(there.accountSecrets).toBe(accountSecretsNote(MOCK_PROFILES.find((profile) => profile.id === "docker-hardened") as SandboxProfile));
		expect(there.accountSecrets).toContain("only those that are also for the agent's commands");

		// Once its user says it may also go where the agent's commands could read it, the server that reads it starts there with the next turn.
		await user.saveAccountSecret("docker-hardened", { name: "ISSUES_TOKEN", scope: "agent" });
		await open.api.prompt({ text: "Again." });
		for (let waited = 0; (await open.api.servers()).servers.find((server) => server.name === "issues")?.state !== "running"; waited += 1) {
			if (waited > 400) throw new Error("the server did not start once its secret was also for the agent's commands");
			await new Promise((done) => setTimeout(done, 5));
		}
		for (let waited = 0; (await user.listSessions()).find((one) => one.id === open.summary?.id)?.status !== "idle"; waited += 1) {
			if (waited > 400) throw new Error("the turn did not end");
			await new Promise((done) => setTimeout(done, 5));
		}

		// A deleted server is gone from a session's list with its next turn.
		await user.deletePersonalServer("wiki");
		await open.api.prompt({ text: "Once more." });
		for (let waited = 0; (await open.api.servers()).servers.some((server) => server.name === "wiki"); waited += 1) {
			if (waited > 400) throw new Error("the deleted server stayed listed");
			await new Promise((done) => setTimeout(done, 5));
		}
		mock.dispose();
	});

	it("seeds two servers and two secrets where the page asks for them, and lists them in the agents that had a turn", async () => {
		const mock = make({ account: "seeded" });
		const user = mock.user(ada);
		const settings = await user.account();
		expect(settings.servers.map((server) => [server.name, server.remote, server.unasked, server.reads])).toEqual([
			["issues", false, true, [{ name: "ISSUES_TOKEN", saved: true }]],
			["wiki", true, false, [{ name: "WIKI_TOKEN", saved: false }]],
		]);
		expect((await user.accountSecrets("docker-windlass-sandbox")).secrets.map((secret) => [secret.name, secret.scope, secret.repositories])).toEqual([
			["DEPLOY_KEY", "setup", ["acme/harbor"]],
			["ISSUES_TOKEN", "agent", []],
		]);
		const checks = await mock.session(ada, "checks").servers();
		expect(checks.servers.map((server) => `${server.name}:${server.origin ?? "project"}`)).toEqual(["harbor:project", "docs:project", "tracker:project", "issues:user", "wiki:user"]);
		mock.dispose();
	});
});
