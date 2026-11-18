/** How the list of agents is grouped and folded, which pull requests a repository's page lists, and what a new agent on a repository starts with. */
import { describe, expect, it } from "vitest";
import type { ModelList, PlatformInfo, SandboxProfile, SessionRepository, SessionSummary } from "@contract";
import { GROUP_SHOWN, LONE_GROUP_SHOWN, NO_REPOSITORY, foldGroup, groupSessions, layerChoices, openPulls, sessionsOn, shownLimit, startingChoices, startingModel, startingProfile } from "./repositories";

const repository = (id: number, owner: string, name: string, branch = "main"): SessionRepository => ({ provider: "github", id, owner, name, branch, private: true, url: `https://github.com/${owner}/${name}` });
const harbor = repository(7101, "acme", "harbor");
const tides = repository(7102, "ada", "tide-tables");

let made = 0;
function session(patch: Partial<SessionSummary> = {}): SessionSummary {
	made += 1;
	return { id: `s${made}`, title: `Agent ${made}`, profile: "docker-windlass-sandbox", model: "gpt-6.1-sol", repoUrl: null, createdAt: made, updatedAt: made, status: "idle", turns: 0, lastOutcome: null, sandbox: "none", ...patch };
}

describe("the list of agents, grouped", () => {
	it("puts agents under their repository, the repository used last first, and those on none last", () => {
		const sessions = [
			session({ id: "old-harbor", repository: harbor, updatedAt: 100 }),
			session({ id: "tides", repository: tides, updatedAt: 300 }),
			session({ id: "plain", updatedAt: 900 }),
			session({ id: "pasted", repoUrl: "https://github.com/acme/harbor.git", updatedAt: 950 }),
			session({ id: "new-harbor", repository: harbor, updatedAt: 500 }),
		];
		const groups = groupSessions(sessions);
		expect(groups.map((group) => group.key)).toEqual(["github:7101", "github:7102", NO_REPOSITORY]);
		expect(groups.map((group) => group.sessions.map((one) => one.id))).toEqual([["new-harbor", "old-harbor"], ["tides"], ["pasted", "plain"]]);
		// A pasted address is not a repository of the connection, whatever it points at: it has no page.
		expect(groups[2]?.repository).toBeNull();
	});

	it("goes by GitHub's id, so a renamed repository stays one group, under the name its newest agent has", () => {
		const groups = groupSessions([session({ repository: harbor, createdAt: 10, updatedAt: 900 }), session({ repository: { ...harbor, owner: "acme-co", name: "haven" }, createdAt: 20, updatedAt: 100 })]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.repository?.name).toBe("haven");
	});

	it("counts who is at work and who waits, and handles a list with nothing in it", () => {
		const [group] = groupSessions([session({ repository: harbor, status: "running" }), session({ repository: harbor, status: "waiting" }), session({ repository: harbor })]);
		expect([group?.working, group?.waiting]).toEqual([2, 1]);
		expect(groupSessions([])).toEqual([]);
	});

	it("stays readable with twenty repositories and a hundred agents: every agent in exactly one group, in a stable order", () => {
		const sessions = Array.from({ length: 100 }, (_, index) => session({ repository: repository(8000 + (index % 20), "acme", `repo-${index % 20}`), updatedAt: 1_000 + ((index * 37) % 100) }));
		const groups = groupSessions(sessions);
		expect(groups).toHaveLength(20);
		expect(groups.flatMap((group) => group.sessions).length).toBe(100);
		expect(groups.map((group) => group.usedAt)).toEqual([...groups.map((group) => group.usedAt)].sort((a, b) => b - a));
		expect(groupSessions([...sessions].reverse()).map((group) => group.key)).toEqual(groups.map((group) => group.key));
		const shown = groups.reduce((sum, group) => sum + foldGroup(group.sessions, shownLimit(groups.length)).shown.length, 0);
		expect(shown).toBe(100);
	});
});

describe("a long group, folded", () => {
	const idle = (count: number) => Array.from({ length: count }, () => session());

	it("shows a short group whole, and never hides only one or two", () => {
		expect(foldGroup(idle(GROUP_SHOWN), GROUP_SHOWN)).toMatchObject({ hidden: 0 });
		const nearly = foldGroup(idle(GROUP_SHOWN + 2), GROUP_SHOWN);
		expect([nearly.shown.length, nearly.hidden]).toEqual([GROUP_SHOWN + 2, 0]);
	});

	it("says how many of a hundred are hidden, and what is shown and hidden adds up", () => {
		const folded = foldGroup(idle(100), GROUP_SHOWN);
		expect([folded.shown.length, folded.hidden]).toEqual([GROUP_SHOWN, 100 - GROUP_SHOWN]);
	});

	it("never hides an agent that is working or waiting, wherever it stands", () => {
		const sessions = [...idle(30), session({ id: "busy", status: "running" }), ...idle(30), session({ id: "asks", status: "waiting" })];
		const folded = foldGroup(sessions, GROUP_SHOWN);
		expect(folded.shown.map((one) => one.id).slice(GROUP_SHOWN)).toEqual(["busy", "asks"]);
		expect(folded.hidden).toBe(60 - GROUP_SHOWN);
	});

	it("gives a list with one group more room than each of several", () => {
		expect([shownLimit(0), shownLimit(1), shownLimit(2), shownLimit(20)]).toEqual([LONE_GROUP_SHOWN, LONE_GROUP_SHOWN, GROUP_SHOWN, GROUP_SHOWN]);
	});
});

describe("a repository's page", () => {
	const pull = (number: number, state: "open" | "draft" | "merged" | "closed", pushedAt: number) => ({ number, url: `https://github.com/acme/harbor/pull/${number}`, state, title: `Pull ${number}`, branch: `windlass/${number}`, base: "main", pushedAt });
	const sessions = [
		session({ id: "a", repository: harbor, pullRequest: pull(38, "open", 100), updatedAt: 5 }),
		session({ id: "b", repository: harbor, pullRequest: pull(39, "merged", 300), updatedAt: 9 }),
		session({ id: "c", repository: harbor, pullRequest: pull(41, "draft", 200), updatedAt: 7 }),
		session({ id: "d", repository: harbor, pullRequest: null }),
		session({ id: "e", repository: tides, pullRequest: pull(3, "open", 900) }),
		session({ id: "f" }),
	];

	it("lists that repository's agents, the most recently used first", () => {
		expect(sessionsOn(sessions, 7101).map((one) => one.id)).toEqual(["b", "c", "a", "d"]);
		expect(sessionsOn(sessions, 7999)).toEqual([]);
	});

	it("lists the pull requests of its agents that are open or drafts, the most recently pushed first", () => {
		expect(openPulls(sessions, 7101).map(({ pull: one, session: by }) => `${one.number}:${by.id}`)).toEqual(["41:c", "38:a"]);
		expect(openPulls(sessions, 7102).map(({ pull: one }) => one.number)).toEqual([3]);
	});
});

describe("what a new agent on a repository starts with", () => {
	const profile = (id: string, available: boolean): SandboxProfile => ({ id: id as SandboxProfile["id"], name: `The ${id} sandbox`, summary: "", layers: [], approval: "auto", commandNetwork: false, commandsCanReadAccessToken: false, available });
	const info: Pick<PlatformInfo, "profiles"> = { profiles: [profile("docker-windlass-sandbox", true), profile("docker-hardened", true), profile("e2b", false)] };
	const plan = (source: ModelList["source"] = "account"): ModelList => ({ source, models: ["gpt-6.1-sol", "gpt-6-luna"].map((id) => ({ id, name: null, efforts: ["low"] })), defaultModel: "gpt-6.1-sol", fetchedAt: source === "account" ? 1 : null });
	const models = plan();

	it("is the repository's defaults where the deployment still offers them", () => {
		const choices = startingChoices({ profile: "docker-hardened", model: "gpt-6-luna", updatedAt: 1 }, info, models);
		expect(choices).toEqual({ profile: "docker-hardened", model: "gpt-6-luna", ignored: { profile: null, model: null } });
		expect(startingProfile(null, choices, info)).toBe("docker-hardened");
		expect(startingModel("", choices, models)).toBe("gpt-6-luna");
	});

	it("leaves out a default the deployment no longer has or cannot run, and says so", () => {
		const gone = startingChoices({ profile: "firecracker", model: "gpt-5.5-terra", updatedAt: 1 }, info, models);
		expect([gone.profile, gone.model]).toEqual([null, null]);
		expect(gone.ignored.profile).toContain('"firecracker"');
		expect(gone.ignored.model).toContain("gpt-5.5-terra");
		const cannot = startingChoices({ profile: "e2b", model: null, updatedAt: 1 }, info, models);
		expect(cannot.profile).toBeNull();
		expect(cannot.ignored.profile).toContain("The e2b sandbox");
		// The form then starts where it would without a default.
		expect(startingProfile(null, gone, info)).toBe("docker-windlass-sandbox");
		expect(startingModel("", gone, models)).toBe("gpt-6.1-sol");
	});

	it("lets the user's own choice in the form come first, for that agent", () => {
		const choices = startingChoices({ profile: "docker-hardened", model: "gpt-6-luna", updatedAt: 1 }, info, models);
		expect(startingProfile("docker-windlass-sandbox", choices, info)).toBe("docker-windlass-sandbox");
		expect(startingModel("gpt-6.1-sol", choices, models)).toBe("gpt-6.1-sol");
		// A choice that cannot be used is no choice.
		expect(startingProfile("e2b", choices, info)).toBe("docker-hardened");
		expect(startingModel("gpt-3", choices, models)).toBe("gpt-6-luna");
	});

	it("goes by the repository's default, then the account's, then the deployment's, each field by itself", () => {
		const account = startingChoices({ profile: "docker-hardened", model: "gpt-6-luna", updatedAt: 1 }, info, models, "account");
		// A repository that says nothing leaves both to the account.
		const open = layerChoices(startingChoices(null, info, models), account);
		expect(open).toEqual({ profile: "docker-hardened", model: "gpt-6-luna", from: { profile: "account", model: "account" } });
		// One that saves only a model leaves the sandbox to the account.
		const half = layerChoices(startingChoices({ profile: null, model: "gpt-6.1-sol", updatedAt: 1 }, info, models), account);
		expect(half).toEqual({ profile: "docker-hardened", model: "gpt-6.1-sol", from: { profile: "account", model: "repository" } });
		expect([startingProfile(null, half, info), startingModel("", half, models)]).toEqual(["docker-hardened", "gpt-6.1-sol"]);
		// The user's own choice in the form comes before both.
		expect([startingProfile("docker-windlass-sandbox", half, info), startingModel("gpt-6-luna", half, models)]).toEqual(["docker-windlass-sandbox", "gpt-6-luna"]);
		// Without either, the deployment's first.
		const none = layerChoices(startingChoices(null, info, models), startingChoices(null, info, models, "account"));
		expect(none.from).toEqual({ profile: null, model: null });
		expect([startingProfile(null, none, info), startingModel("", none, models)]).toEqual(["docker-windlass-sandbox", "gpt-6.1-sol"]);
	});

	it("holds a model against the user's own list, says of a stand-in that it only stands in, and judges nothing before the list is known", () => {
		const saved = { profile: null, model: "gpt-7-nova", updatedAt: 1 };
		// The plan's list has another default than its first model: that one is what a launch starts on.
		const luna = { ...models, defaultModel: "gpt-6-luna" };
		expect(startingModel("", startingChoices(null, info, luna), luna)).toBe("gpt-6-luna");
		// A stand-in may lack a model the plan has: the default is left out for now, and the sentence says why.
		expect(startingChoices(saved, info, plan("unavailable")).ignored.model).toBe("The default model, gpt-7-nova, is not in the list that stands in for your plan's models, so it is ignored for now.");
		expect(startingChoices(saved, info, plan("signed-out"), "account").ignored.model).toMatch(/^Your account's default model, gpt-7-nova, is not in the list that stands in/);
		expect(startingChoices(saved, info, plan("demo")).ignored.model).toBe("The default model, gpt-7-nova, is not offered here any more, so it is ignored.");
		// Until the list is read nothing is said of the model, and the sandbox is judged all the same.
		const early = startingChoices({ profile: "docker-hardened", model: "gpt-7-nova", updatedAt: 1 }, info, null);
		expect(early).toEqual({ profile: "docker-hardened", model: null, ignored: { profile: null, model: null } });
		expect(startingModel("gpt-7-nova", early, null)).toBe("gpt-7-nova");
		expect(startingModel("", early, null)).toBe("");
	});

	it("passes over a default that cannot be used, of the repository or of the account, and says whose it was", () => {
		const account = startingChoices({ profile: "e2b", model: "gpt-5.5-terra", updatedAt: 1 }, info, models, "account");
		expect([account.profile, account.model]).toEqual([null, null]);
		expect(account.ignored.profile).toMatch(/^Your account's default sandbox, The e2b sandbox, cannot be used/);
		expect(account.ignored.model).toBe("Your account's default model, gpt-5.5-terra, is not among the models your ChatGPT plan offers now, so it is ignored.");
		// The repository's unusable default gives way to the account's usable one, and the other way round.
		const usable = startingChoices({ profile: "docker-hardened", model: null, updatedAt: 1 }, info, models, "account");
		const gone = startingChoices({ profile: "firecracker", model: "gpt-6-luna", updatedAt: 1 }, info, models);
		expect(gone.ignored.profile).toMatch(/^The default sandbox/);
		expect(layerChoices(gone, usable)).toEqual({ profile: "docker-hardened", model: "gpt-6-luna", from: { profile: "account", model: "repository" } });
		expect(layerChoices(gone, account)).toEqual({ profile: null, model: "gpt-6-luna", from: { profile: null, model: "repository" } });
	});

	it("is the deployment's first sandbox and the default of the user's models without defaults, and nothing before either is known", () => {
		const none = startingChoices(null, info, models);
		expect([startingProfile(null, none, info), startingModel("", none, models)]).toEqual(["docker-windlass-sandbox", "gpt-6.1-sol"]);
		expect(startingChoices({ profile: "docker-hardened", model: "gpt-6-luna", updatedAt: 1 }, null, null)).toEqual(none);
		expect([startingProfile(null, none, null), startingModel("", none, null)]).toEqual([null, ""]);
	});
});
