/**
 * The mock's side of a repository's page: what is kept for a repository, the defaults for new agents,
 * the remembered approvals and forgetting them, what GitHub says of a repository, and the repositories
 * something is saved for. The refusals are held against the server's own words.
 */
import { describe, expect, it } from "vitest";
import type { ModelList, SandboxProfile, TimelineItem } from "@contract";
import { ChecksProblem, cleanChecks } from "../../../server/src/repository-checks";
import { DefaultsProblem, cleanDefaults } from "../../../server/src/repository-defaults";
import { PlatformError, type SessionFeed } from "./client";
import { MOCK_FORGETTING, MOCK_PROFILES, createMockClient } from "./mock";

const ada = { token: "mock:chatgpt:u_repo:ada@example.com", profile: { uid: "u_repo", email: "ada@example.com", demo: false } };
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

function serverRefusal(raw: unknown, profiles: readonly SandboxProfile[], models: ModelList): { code: string; message: string } {
	try {
		cleanDefaults(raw, profiles, models);
	} catch (error) {
		if (error instanceof DefaultsProblem) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error("the server took it");
}

describe("the mock's repository page", () => {
	it("gathers what is kept for a repository, and nothing of a secret but how many there are", async () => {
		const mock = make();
		const view = await mock.user(ada).repository(7101);
		expect(view).toMatchObject({ id: 7101, name: "acme/harbor", defaults: { profile: "docker-hardened", model: "gpt-6-luna" }, forgetting: MOCK_FORGETTING, saved: { setup: true, secrets: 4 } });
		expect(view.approvals.map((approval) => approval.name)).toEqual(["tracker", "harbor"]);
		expect(view.approvals.every((approval) => approval.definitions === 1 && approval.expiresAt > approval.approvedAt)).toBe(true);
		expect(JSON.stringify(view)).not.toMatch(/NPM_TOKEN|value|sealed/);
		// A repository nothing is saved for has a page all the same, with nothing on it.
		expect(await mock.user(ada).repository(7110)).toMatchObject({ name: null, defaults: { profile: null, model: null, updatedAt: null }, approvals: [], saved: { setup: false, secrets: 0 } });
		mock.dispose();
	});

	it("saves a default field by field, and keeps nothing once both are cleared", async () => {
		const mock = make();
		const user = mock.user(ada);
		expect(await user.saveRepositoryDefaults(7103, { model: "gpt-6-luna" })).toMatchObject({ profile: null, model: "gpt-6-luna" });
		expect(await user.saveRepositoryDefaults(7103, { profile: "docker-hardened" })).toMatchObject({ profile: "docker-hardened", model: "gpt-6-luna" });
		expect(await user.saveRepositoryDefaults(7103, {})).toMatchObject({ profile: "docker-hardened", model: "gpt-6-luna" });
		expect(await user.saveRepositoryDefaults(7103, { model: null })).toMatchObject({ profile: "docker-hardened", model: null });
		expect(await user.saveRepositoryDefaults(7103, { profile: null })).toEqual({ screenshots: true, profile: null, model: null, updatedAt: null });
		expect((await user.savedRepositories()).some((repository) => repository.id === 7103)).toBe(false);
		// Something saved for a repository no agent is on is listed under the name GitHub has for it.
		await user.saveRepositoryDefaults(7110, { model: "gpt-6-luna" });
		expect((await user.savedRepositories()).find((repository) => repository.id === 7110)?.name).toBe("ada/knots");
		mock.dispose();
	});

	it("refuses a sandbox the deployment does not offer and a model that is not among the user's, in the server's words", async () => {
		const mock = make();
		const user = mock.user(ada);
		const models = await user.models();
		for (const change of [{ profile: "firecracker" as const }, { profile: "nowhere" as never }, { model: "gpt-3" }]) {
			const refused = await refusal(user.saveRepositoryDefaults(7101, change));
			const server = serverRefusal(change, MOCK_PROFILES, models);
			expect([refused.reason, refused.message]).toEqual([server.code, server.message]);
		}
		expect((await user.repository(7101)).defaults).toMatchObject({ profile: "docker-hardened", model: "gpt-6-luna" });
		mock.dispose();
	});

	it("keeps a repository's checks as one list, saved whole, and refuses what Windlass would not take in the server's words", async () => {
		const mock = make();
		const user = mock.user(ada);
		expect((await user.repositoryChecks(7101)).checks).toEqual([
			{ name: "test", command: "npm test" },
			{ name: "types", command: "npm run typecheck", when: ["src/**/*.ts"], timeoutSeconds: 300 },
		]);
		expect((await user.repository(7101)).saved.checks).toBe(2);
		expect(await user.repositoryChecks(7103)).toEqual({ checks: [], updatedAt: null });
		const saved = await user.saveRepositoryChecks(7103, [{ name: " lint ", command: " npm run lint\r\n", when: [" src/** ", ""], showOutput: true }]);
		expect(saved.checks).toEqual([{ name: "lint", command: "npm run lint", when: ["src/**"], showOutput: true }]);
		expect(saved.checks).toEqual(cleanChecks([{ name: " lint ", command: " npm run lint\r\n", when: [" src/** ", ""], showOutput: true }]));
		for (const list of [
			[{ name: "", command: "npm test" }],
			[{ name: "has space", command: "npm test" }],
			[{ name: "test", command: "" }],
			[{ name: "test", command: "a" }, { name: "test", command: "b" }],
			[{ name: "test", command: "npm test", timeoutSeconds: 0 }],
			[{ name: "test", command: "npm test", when: ["!src/**"] }],
			Array.from({ length: 21 }, (_, index) => ({ name: `c${index}`, command: "true" })),
		]) {
			const refused = await refusal(user.saveRepositoryChecks(7103, list));
			let server = "";
			try {
				cleanChecks(list);
			} catch (error) {
				if (error instanceof ChecksProblem) server = error.message;
			}
			expect([refused.reason, refused.message]).toEqual(["bad_checks", server]);
		}
		// What was saved before a refusal is still there; an empty list saves none, and deleting what is saved takes the checks too.
		expect((await user.repositoryChecks(7103)).checks).toHaveLength(1);
		expect(await user.saveRepositoryChecks(7103, [])).toEqual({ checks: [], updatedAt: null });
		expect((await user.forgetRepository(7101)).saved).toEqual({ setup: false, secrets: 0, checks: 0 });
		expect((await user.repositoryChecks(7101)).checks).toEqual([]);
		mock.dispose();
	});

	it("says on a turn's closing item what the work rests on: the checks that ran, whose they are, and the ones that did not apply", async () => {
		const mock = make();
		/** The last closing item of a session's timeline, as a client that opens the session is handed it. */
		const lastEnd = async (id: string) => {
			const timeline = await new Promise<TimelineItem[]>((resolve) => {
				const feed: SessionFeed = { onSnapshot: (snapshot) => resolve(snapshot.timeline), onItem: () => undefined, onDelta: () => undefined, onSummary: () => undefined, onQuestion: () => undefined, onConnection: () => undefined };
				mock.session(ada, id).open(feed);
			});
			return timeline.filter((item) => item.kind === "turn.ended").at(-1);
		};
		const ended = await lastEnd("checks");
		expect(ended?.kind === "turn.ended" ? ended.verified : null).toMatchObject({
			state: "passed",
			run: { turn: 1, checks: [{ name: "test", command: "npm test", whose: "user", status: "passed", sentBack: 1 }] },
			unrun: [{ name: "types", command: "npm run typecheck" }],

			changedAfter: false,
		});
		// A session on a repository nothing is saved for says that nothing was set.
		const other = await lastEnd("add-test");
		expect(other?.kind === "turn.ended" ? other.verified : null).toMatchObject({ state: "none_set", run: null, unrun: [] });
		mock.dispose();
	});

	it("keeps a default the user's plan stopped offering as it was saved", async () => {
		const mock = make();
		expect((await mock.user(ada).repository(7102)).defaults).toMatchObject({ profile: null, model: "gpt-5.5-terra" });
		expect((await mock.user(ada).models()).models.map((model) => model.id)).not.toContain("gpt-5.5-terra");
		mock.dispose();
	});

	it("forgets an approval from the page, and the session that had it is asked about again", async () => {
		const mock = make();
		const user = mock.user(ada);
		const held = (await mock.session(ada, "checks").servers()).servers.find((server) => server.name === "harbor");
		expect(held?.approval).not.toBeNull();
		const view = await user.forgetRepositoryApproval(7101, "harbor");
		expect(view.approvals.map((approval) => approval.name)).toEqual(["tracker"]);
		expect((await mock.session(ada, "checks").servers()).servers.find((server) => server.name === "harbor")?.approval).toBeNull();
		// Forgetting what is not remembered changes nothing.
		expect((await user.forgetRepositoryApproval(7101, "harbor")).approvals).toEqual(view.approvals);
		mock.dispose();
	});

	it("says what GitHub makes of a repository: one it covers, and one it no longer does", async () => {
		const mock = make();
		const user = mock.user(ada);
		expect(await user.githubRepository(7105)).toMatchObject({ id: 7105, owner: "acme", name: "quay", canPush: false, defaultBranch: "main" });
		expect((await refusal(user.githubRepository(7190))).reason).toBe("github_gone");
		// What is saved for the one that is gone is still there, under the name it had.
		expect(await user.repository(7190)).toMatchObject({ name: "acme/old-pier", saved: { setup: true, secrets: 1 } });
		await user.githubDisconnect();
		expect((await refusal(user.githubRepository(7105))).reason).toBe("github_not_connected");
		expect((await refusal(make({ github: false }).user(ada).githubRepository(7105))).reason).toBe("github_off");
		mock.dispose();
	});

	it("names the repositories something is saved for, and deleting what is saved for one takes it off the list", async () => {
		const mock = make();
		const user = mock.user(ada);
		expect((await user.savedRepositories()).map((repository) => `${repository.id} ${repository.name}`)).toEqual(["7101 acme/harbor", "7190 acme/old-pier", "7105 acme/quay", "7102 ada/tide-tables"]);
		const emptied = await user.forgetRepository(7190);
		expect(emptied).toMatchObject({ defaults: { profile: null, model: null }, approvals: [], saved: { setup: false, secrets: 0, checks: 0 } });
		expect((await user.repositorySetup(7190)).command).toBe("");
		expect((await user.repositorySecrets(7190, "docker-windlass-sandbox")).secrets).toEqual([]);
		expect((await user.savedRepositories()).some((repository) => repository.id === 7190)).toBe(false);
		// The two independent agents stay when the repository settings are forgotten.
		await user.forgetRepository(7101);
		expect((await user.listSessions()).filter((session) => session.repository?.id === 7101 && !session.item)).toHaveLength(2);
		expect(await make({ github: false }).user(ada).savedRepositories()).toEqual([]);
		mock.dispose();
	});
});
