/**
 * The mock's GitHub: what the interface is developed against must behave as the server does, in the
 * ways the interface depends on. The server's own behaviour is checked by scripts/github-check.ts and
 * scripts/e2e.ts.
 */
import type { AuthResult, TimelineItem } from "@contract";
import { afterEach, describe, expect, it } from "vitest";
import { readGithubReturn } from "../state/github";
import { PlatformError, type SessionFeed } from "./client";
import { createMockClient, type MockClient } from "./mock";

const ada: AuthResult = { token: "mock:chatgpt:u_ada:ada@example.com", profile: { uid: "u_ada", email: "ada@example.com", demo: false } };
const demo: AuthResult = { token: "mock:demo:demo_1:", profile: { uid: "demo_1", email: null, demo: true } };

let client: MockClient | null = null;
const make = (options: Parameters<typeof createMockClient>[0] = {}): MockClient => {
	client = createMockClient({ pace: 0, origin: "http://localhost:5193", ...options });
	return client;
};
afterEach(() => {
	client?.dispose();
	client = null;
});

/** What a call was refused with. */
async function refusal(call: Promise<unknown>): Promise<PlatformError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof PlatformError) return error;
		throw error;
	}
	throw new Error("the call was not refused");
}

/** The session's stored items as they arrive, like the session screen's feed. */
function items(mock: MockClient, auth: AuthResult, id: string): TimelineItem[] {
	const seen: TimelineItem[] = [];
	const feed: SessionFeed = { onSnapshot: () => undefined, onItem: (item) => seen.push(item), onDelta: () => undefined, onSummary: () => undefined, onQuestion: () => undefined, onConnection: () => undefined };
	mock.session(auth, id).open(feed);
	return seen;
}

describe("the mock's GitHub", () => {
	it("says the deployment has a GitHub App, and can play one that has none", async () => {
		expect((await make().info()).github).toEqual({ slug: "windlass-mock", url: "https://github.com" });
		const off = make({ github: false });
		expect((await off.info()).github).toBeUndefined();
		expect((await refusal(off.user(ada).github())).reason).toBe("github_off");
		expect((await off.user(ada).listSessions()).every((session) => !session.repository)).toBe(true);
	});

	it("starts a ChatGPT user connected and a demo user not, and connects through the address the server would send the browser back to", async () => {
		const mock = make();
		expect((await mock.user(ada).github()).connection?.accounts.map((account) => `${account.login} (${account.kind})`)).toEqual(["ada (user)", "acme (organization)"]);
		expect((await mock.user(demo).github()).connection).toBeNull();
		expect((await refusal(mock.user(demo).githubRepositories(""))).reason).toBe("github_not_connected");

		const { url } = await mock.user(demo).githubConnect("http://localhost:5193");
		const back = readGithubReturn(new URL(url).hash);
		expect(back).toEqual({ ticket: "mock.demo_1" });
		// Another user's browser can do nothing with it.
		expect((await refusal(mock.user(ada).githubComplete("mock.demo_1"))).reason).toBe("github_ticket");
		expect((await mock.user(demo).githubComplete("mock.demo_1")).connection?.login).toBe("ada");
		expect((await mock.user(demo).githubDisconnect()).connection).toBeNull();

		mock.mockNextGithub("connect");
		const refused = readGithubReturn(new URL((await mock.user(demo).githubConnect("http://localhost:5193")).url).hash);
		expect(refused).toEqual({ error: "GitHub was not connected: the authorization was declined at GitHub." });
	});

	it("reads what the address says of a return from GitHub, and nothing else", () => {
		expect(readGithubReturn("#github=gh1.abc.def")).toEqual({ ticket: "gh1.abc.def" });
		expect(readGithubReturn("#github-error=not_yours")).toEqual({ error: "That installation is not one your GitHub account can reach, so it was not connected." });
		expect(readGithubReturn("#github-error=something_new")).toEqual({ error: "Connecting GitHub did not work. Try again." });
		expect(readGithubReturn("#details")).toBeNull();
		expect(readGithubReturn("")).toBeNull();
	});

	it("lists repositories: the most recently pushed first, a name that begins with the search before one that contains it", async () => {
		const user = make().user(ada);
		const all = await user.githubRepositories("");
		expect(all.repositories.slice(0, 3).map((repository) => `${repository.owner}/${repository.name}`)).toEqual(["acme/harbor", "ada/tide-tables", "acme/lighthouse-docs"]);
		const found = await user.githubRepositories("HAR");
		expect(found.repositories.map((repository) => repository.name)).toEqual(["harbor", "harbor-infrastructure", "charts"]);
		expect((await user.githubRepositories("no-such")).repositories).toEqual([]);
		expect(all.repositories.find((repository) => repository.name === "quay")?.canPush).toBe(false);
		expect(await user.githubBranches(7101)).toEqual({ branches: ["main", "fix/tide-tables", "release/2.4", "release/2.3"], defaultBranch: "main", more: false });
		client?.mockNextGithub("list");
		expect((await refusal(user.githubRepositories(""))).message).toBe("GitHub could not be reached. Try again in a moment.");
	});

	it("launches an agent on a repository and records what it was launched on", async () => {
		const user = make().user(ada);
		const session = await user.createSession({ profile: "docker-windlass-sandbox", repository: { id: 7101, branch: "release/2.4" } });
		expect(session.repository).toEqual({ provider: "github", id: 7101, owner: "acme", name: "harbor", branch: "release/2.4", private: true, url: "https://github.com/acme/harbor" });
		expect(session.repoUrl).toBe("https://github.com/acme/harbor.git");
		expect(session.pullRequest).toBeNull();
		const pasted = await user.createSession({ profile: "docker-windlass-sandbox", repoUrl: "https://github.com/someone/public.git" });
		expect(pasted.repository).toBeUndefined();
	});

	it("opens a pull request, then pushes to the same one, with one line in the timeline for each", async () => {
		const mock = make();
		const session = mock.session(ada, "add-test");
		const seen = items(mock, ada, "add-test");
		const before = await session.publishState();
		expect(before).toMatchObject({ pullRequest: null, changes: true, blocked: null, branch: "windlass/fix-the-failing-add-test-ddtest", draft: { title: "Fix the failing add test" } });

		const opened = await session.publish({ title: "Fix the failing add test", body: "It subtracted." });
		expect(opened.opened).toBe(true);
		expect(opened.state.pullRequest).toMatchObject({ number: 41, state: "open", branch: before.branch, base: "main", url: "https://github.com/ada/tide-tables/pull/41" });
		expect(opened.state.changes).toBe(false);
		expect(await session.changes()).toEqual([]);
		expect(seen.at(-1)).toMatchObject({ kind: "platform", level: "info", text: "Opened pull request #41 in ada/tide-tables from windlass/fix-the-failing-add-test-ddtest, with 1 file. Its description reports: nothing verified." });
		expect((await mock.user(ada).listSessions()).find((one) => one.id === "add-test")?.pullRequest?.number).toBe(41);
		expect((await refusal(session.publish({ title: "Again", body: "" }))).message).toBe("There is nothing to push: windlass/fix-the-failing-add-test-ddtest at GitHub already has everything in the workspace.");

		// The session that has an open pull request and a changed file pushes to it.
		const checks = mock.session(ada, "checks");
		const pushed = await checks.publish({ title: "Follow up", body: "" });
		expect(pushed.opened).toBe(false);
		expect(pushed.state.pullRequest?.number).toBe(38);
		// Its repository has checks saved, and the pull request carries what its description says of them, in a few words.
		expect(pushed.state.pullRequest?.verified).toBe("1 check passed");
		expect(opened.state.pullRequest?.verified).toBe("nothing verified");
	});

	it("says each refusal in the server's sentence, and refuses while a turn runs", async () => {
		const mock = make();
		const session = mock.session(ada, "add-test");
		mock.mockNextGithub("protected");
		const guarded = await refusal(session.publish({ title: "x", body: "" }));
		expect(guarded.reason).toBe("github_denied");
		expect(guarded.message).toContain("protects branches named like windlass/fix-the-failing-add-test-ddtest");
		mock.mockNextGithub("denied");
		expect((await refusal(session.publish({ title: "x", body: "" }))).message).toContain("can read ada/tide-tables on GitHub but not write to it");
		mock.mockNextGithub("gone");
		expect((await refusal(session.publish({ title: "x", body: "" }))).reason).toBe("github_gone");
		// Nothing was pushed by any of them.
		expect((await session.publishState()).pullRequest).toBeNull();

		const running = mock.session(ada, "harbor-build");
		expect((await running.publishState()).blocked).toBe("Wait for the turn to end: the platform does not push while the agent is working.");
		expect((await refusal(running.publish({ title: "x", body: "" }))).reason).toBe("publish_blocked");

		await mock.user(ada).githubDisconnect();
		expect((await refusal(session.publish({ title: "x", body: "" }))).message).toBe("GitHub is not connected any more. Connect GitHub again from the account menu, then try once more.");
	});
});
