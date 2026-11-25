// @vitest-environment jsdom
/**
 * The question about an MCP server a project's configuration names: its words in every sandbox
 * profile, what the mock plays of it, and how the question control shows it.
 */
import type { AuthResult, PendingQuestion, SandboxProfile, TimelineItem } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILES, e2bProfile } from "../../../server/src/sandbox/profiles";
import type { TurnServerQuestion } from "../../../server/src/sandbox/api";
import { projectOf } from "../../../server/src/server-approvals";
import { forgettingWords, serverApprovedNote, serverExpiredNote, serverForgottenNote, serverNotNowNote, serverPanelApprovedNote, serverPanelWords, serverQuestionWords, serverRecalledNote, serverUnansweredNote } from "../../../server/src/server-question";
import type { SessionFeed } from "../api/client";
import { secretReach } from "../../../server/src/repo-secrets";
import { createMockClient, MOCK_FORGETTING, MOCK_PROFILES, mockPanelWords, mockProject, mockSecretReach, mockServerQuestion, type MockClient } from "../api/mock";
import { applyItem, emptyView, type SessionView, type TurnView } from "../lib/timeline";
import { Turn } from "./Blocks";
import { InteractiveProvider, QuestionCard, QuestionDock, type QuestionFlow } from "./Question";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const profile = (id: string): SandboxProfile => PROFILES.find((candidate) => candidate.id === id) as SandboxProfile;
/** What an approval is remembered for: a repository of the GitHub connection, a pasted address, and a session that has neither. */
const repo = projectOf({ sessionId: "s_1", repoUrl: "https://github.com/acme/harbor.git", repo: { id: 7101, owner: "acme", name: "harbor" } });
const pasted = projectOf({ sessionId: "s_1", repoUrl: "https://example.com/acme/harbor.git" });
const own = projectOf({ sessionId: "s_1", repoUrl: null });
const SAVE_HARBOR_TOKEN = "Save a secret named HARBOR_TOKEN for acme/harbor, under Secrets in this session's panel: it is handed over from the next turn.";
const COVERS = "It is an approval of this command, not of the files it runs: a later commit can change those without a new question.";
const harbor = (extra: Partial<TurnServerQuestion> = {}): TurnServerQuestion => ({ name: "harbor", fingerprint: "81498df752b8ef7d", argv: ["python3", "tools/harbor_mcp.py"], url: null, file: "/workspace/.windlass/config.json", unset: [], holdsTurn: true, ...extra });

// ---------------------------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------------------------

describe("the question's words", () => {
	it("say what the server can do that the agent's commands cannot, where Windlass sandboxes commands", () => {
		const words = serverQuestionWords(harbor(), { profile: profile("docker-windlass-sandbox"), demo: false, dataInSandbox: false, project: repo });
		expect(words.title).toBe('Start this project\'s MCP server "harbor"?');
		expect(words.subject).toBe("python3 tools/harbor_mcp.py");
		// On Docker Windlass's own record is in the data all of the user's sessions share: it reaches further than the repository.
		expect(words.details).toEqual([
			"It runs in this session's container, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read Windlass's own data, including the session's access token and any replacement during the turn. Each token lasts about an hour from issue.",
			"Approving starts it now and is remembered for 30 days for exactly this definition, in all your sessions: they share Windlass's data.",
			COVERS,
		]);
		expect(words.choices).toEqual([
			{ id: "start", label: "Start it for this project", approve: true, remembers: "exactly this definition, for your sessions, for 30 days" },
			{ id: "not_now", label: "Not now", approve: false, remembers: null },
		]);
	});

	it("say that it has what the agent's commands have, where they run directly in the container", () => {
		const words = serverQuestionWords(harbor(), { profile: profile("docker-hardened"), demo: false, dataInSandbox: false, project: own });
		expect(words.details[0]).toBe("It runs in this session's container, as the agent's commands do here: like them, it has the network and can read Windlass's own data, including the session's access token and any replacement during the turn. Each token lasts about an hour from issue.");
	});

	it("promise nothing of commands on E2B before its check has passed, and are certain of the server", () => {
		const words = serverQuestionWords(harbor(), { profile: e2bProfile({ windlassSandbox: false }), demo: false, dataInSandbox: true, project: repo });
		expect(words.details).toEqual([
			"It runs in this session's microVM and is never inside Windlass's sandbox around commands, whether or not that sandbox works here: it has the network and can read Windlass's own data, including the session's access token and any replacement during the turn. Each token lasts about an hour from issue.",
			"Approving starts it now and is remembered for 30 days for exactly this definition: your sessions on acme/harbor then start it without asking, until you forget the approval in a session's panel.",
			COVERS,
		]);
		expect(words.choices[0]?.remembers).toBe("exactly this definition, for your sessions on acme/harbor, for 30 days");
	});

	it("say how far an approval is remembered where Windlass's data is the sandbox's own: the repository, its address, or the session", () => {
		const context = { profile: e2bProfile({ windlassSandbox: true }), demo: false, dataInSandbox: true };
		const byAddress = serverQuestionWords(harbor(), { ...context, project: pasted });
		expect(byAddress.details[1]).toBe("Approving starts it now and is remembered for 30 days for exactly this definition: your sessions on example.com/acme/harbor.git then start it without asking, until you forget the approval in a session's panel.");
		expect(byAddress.choices[0]?.remembers).toBe("exactly this definition, for your sessions on example.com/acme/harbor.git, for 30 days");
		const alone = serverQuestionWords(harbor(), { ...context, project: own });
		expect(alone.details[1]).toBe(
			"Approving starts it now and is remembered for 30 days for exactly this definition, for this session, which has no repository: a sandbox that replaces this one starts it without asking, until you forget the approval in the session's panel.",
		);
		expect(alone.choices[0]?.remembers).toBe("exactly this definition, for this session, for 30 days");
		expect(alone.details[2]).toBe(COVERS);
	});

	it("word the question for the panel, where an approval starts the server with the next turn", () => {
		const context = { profile: e2bProfile({ windlassSandbox: true }), demo: false, dataInSandbox: true, project: repo };
		expect(serverPanelWords({ name: "harbor", remote: false }, context)).toEqual({
			title: 'Start this project\'s MCP server "harbor"?',
			details: [
				"It runs in this session's microVM, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read Windlass's own data, including the session's access token and any replacement during the turn. Each token lasts about an hour from issue.",
				"Approving starts it with this session's next turn and is remembered for 30 days for exactly this definition: your sessions on acme/harbor then start it without asking, until you forget the approval in a session's panel.",
				COVERS,
			],
		});
		expect(serverPanelWords({ name: "docs", remote: true }, { ...context, project: own })).toEqual({
			title: 'Connect to this project\'s MCP server "docs"?',
			details: [
				"Nothing is started: Windlass reaches it at that address from this session's microVM, outside its sandbox around commands, and what the agent sends it leaves the microVM.",
				"Approving lets Windlass connect to it from this session's next turn and is remembered for 30 days for exactly this definition, for this session, which has no repository: a sandbox that replaces this one connects without asking, until you forget the approval in the session's panel.",
				"It is an approval of this address, not of what answers there.",
			],
		});
		expect(serverPanelWords({ name: "harbor", remote: false }, { ...context, profile: profile("docker-hardened"), dataInSandbox: false }).details[1]).toBe(
			"Approving starts it with this session's next turn and is remembered for 30 days for exactly this definition, in all your sessions: they share Windlass's data.",
		);
	});

	it("say the same as the first Docker profile on E2B where Windlass's sandbox is promised, of a microVM", () => {
		const words = serverQuestionWords(harbor(), { profile: e2bProfile({ windlassSandbox: true }), demo: false, dataInSandbox: true, project: repo });
		expect(words.details[0]).toBe(
			"It runs in this session's microVM, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read Windlass's own data, including the session's access token and any replacement during the turn. Each token lasts about an hour from issue.",
		);
	});

	it("claim no access token for a demo session, which is handed none", () => {
		const context = { demo: true, dataInSandbox: false, project: repo };
		expect(serverQuestionWords(harbor(), { ...context, profile: profile("docker-windlass-sandbox") }).details[0]).toBe(
			"It runs in this session's container, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read Windlass's own data. A demo session has no access token there.",
		);
		expect(serverQuestionWords(harbor(), { ...context, profile: profile("docker-hardened") }).details[0]).toBe("It runs in this session's container, as the agent's commands do here: like them, it has the network and can read Windlass's own data. A demo session has no access token there.");
		expect(serverQuestionWords(harbor(), { ...context, dataInSandbox: true, profile: e2bProfile({ windlassSandbox: false }) }).details[0]).toBe(
			"It runs in this session's microVM and is never inside Windlass's sandbox around commands, whether or not that sandbox works here: it has the network and can read Windlass's own data. A demo session has no access token there.",
		);
	});

	it("name the variables that are not set, and quote an argument that is not plain text", () => {
		const one = serverQuestionWords(harbor({ unset: ["HARBOR_TOKEN"], argv: ["bash", "-c", "tracker serve --port 80"] }), { profile: profile("docker-windlass-sandbox"), demo: false, dataInSandbox: false, project: repo, secrets: [] });
		expect(one.subject).toBe("bash -c 'tracker serve --port 80'");
		expect(one.details[3]).toBe(`It will not start yet: its definition reads the variable HARBOR_TOKEN, which is not set where Windlass runs. ${SAVE_HARBOR_TOKEN}`);
		// A session with no repository: where its sandbox gives the account's secrets to MCP servers, one of those sets the variable.
		const alone = serverQuestionWords(harbor({ unset: ["HARBOR_TOKEN"] }), { profile: profile("docker-windlass-sandbox"), demo: false, dataInSandbox: false, project: own, secrets: null });
		expect(alone.details[3]).toBe("It will not start yet: its definition reads the variable HARBOR_TOKEN, which is not set where Windlass runs. A variable is set by saving a secret for a repository of your GitHub connection, and this session is not on one. A secret of your account under that name, saved in your settings, sets it for MCP servers too.");
		const three = serverQuestionWords(harbor({ unset: ["A", "B", "C"] }), { profile: profile("docker-hardened"), demo: false, dataInSandbox: false, project: own, secrets: null });
		expect(three.details[3]).toBe(
			"It will not start yet: its definition reads the variables A, B and C, which are not set where Windlass runs. A variable is set by saving a secret for a repository of your GitHub connection, and this session is not on one. A secret of your account under that name, saved in your settings, sets it for MCP servers in this sandbox if it is also for the agent's commands.",
		);
	});

	it("say which saved secrets approving hands over, and why a saved one is still not set where the sandbox keeps it from MCP servers", () => {
		const context = { profile: profile("docker-windlass-sandbox"), demo: false, dataInSandbox: false, project: repo };
		// Handed to Windlass: the definition reads it, so approving gives it to the server.
		const given = serverQuestionWords(harbor({ secrets: ["HARBOR_TOKEN"] }), { ...context, secrets: [{ name: "HARBOR_TOKEN", scope: "setup" }] });
		expect(given.details[3]).toBe("Its definition reads the secret HARBOR_TOKEN saved for this repository: approving gives its value to the server.");
		const sent = serverQuestionWords(harbor({ name: "docs", argv: null, url: "https://docs.example.com/mcp", secrets: ["DOCS_TOKEN", "DOCS_KEY"] }), { ...context, secrets: [] });
		expect(sent.details[3]).toBe("Its definition reads the secrets DOCS_TOKEN and DOCS_KEY saved for this repository: approving sends their values to that address.");
		// Where commands are not sandboxed, a secret for the setup command and MCP servers stays out of Windlass's environment whatever its name.
		const open = serverQuestionWords(harbor({ unset: ["HARBOR_TOKEN"] }), { ...context, profile: profile("docker-hardened"), secrets: [{ name: "HARBOR_TOKEN", scope: "setup" }] });
		expect(open.details[3]).toContain("A secret named HARBOR_TOKEN is saved for acme/harbor. MCP servers are not given it in this sandbox: the agent's commands run there without Windlass's sandbox");
	});

	it("word a server that is reached at an address as one that is not started", () => {
		const words = serverQuestionWords(harbor({ name: "docs", argv: null, url: "https://docs.example.com/mcp", unset: ["DOCS_TOKEN"] }), { profile: profile("docker-windlass-sandbox"), demo: false, dataInSandbox: true, project: repo, secrets: [] });
		expect(words.title).toBe('Connect to this project\'s MCP server "docs"?');
		expect(words.subject).toBe("https://docs.example.com/mcp");
		expect(words.details).toEqual([
			"Nothing is started: Windlass reaches it at that address from this session's container, outside its sandbox around commands, and what the agent sends it leaves the container.",
			"Approving lets Windlass connect to it now and is remembered for 30 days for exactly this definition: your sessions on acme/harbor then connect without asking, until you forget the approval in a session's panel.",
			"It is an approval of this address, not of what answers there.",
			"It cannot be reached yet: its definition reads the variable DOCS_TOKEN, which is not set where Windlass runs. Save a secret named DOCS_TOKEN for acme/harbor, under Secrets in this session's panel: it is handed over from the next turn.",
		]);
		expect(words.choices[0]?.label).toBe("Connect for this project");
	});

	it("give each outcome one plain line", () => {
		expect(serverApprovedNote(harbor(), { state: "running", tools: 2 })).toEqual({ level: "info", text: 'Started the MCP server "harbor" for this project: 2 tools. The agent has them from this turn on.' });
		expect(serverApprovedNote(harbor({ holdsTurn: false }), { state: "running", tools: 1 }).text).toBe('Started the MCP server "harbor" for this project: 1 tool. The turn was already running: the agent is told of them at its next step.');
		expect(serverApprovedNote(harbor(), { state: "running", tools: 0 }).text).toBe('Started the MCP server "harbor" for this project: no tools.');
		expect(serverApprovedNote(harbor(), { state: "starting" }).text).toBe('Approved the MCP server "harbor" for this project. It is still starting; the agent is told of its tools once it runs.');
		expect(serverApprovedNote(harbor({ unset: ["HARBOR_TOKEN"] }), { state: "failed", reason: "the environment variable HARBOR_TOKEN named in its env is not set" }, SAVE_HARBOR_TOKEN)).toEqual({
			level: "warn",
			text: `Approved the MCP server "harbor" for this project, but it did not start: the environment variable HARBOR_TOKEN named in its env is not set. ${SAVE_HARBOR_TOKEN}`,
		});
		expect(serverApprovedNote(harbor(), { state: "failed", reason: "the server process exited with code 1; stderr ends with:\nno such file." }).text).toBe(
			'Approved the MCP server "harbor" for this project, but it did not start: the server process exited with code 1; stderr ends with: no such file. Windlass tries again by itself.',
		);
		expect(serverApprovedNote(harbor(), { state: "changed" }).text).toBe('The definition of the MCP server "harbor" changed while it was asked about, so nothing was started. The new definition is asked about.');
		expect(serverNotNowNote(harbor())).toBe('Left the MCP server "harbor" stopped. If the agent tries to use it, it is told that the server waits for you; your next message asks again.');
		expect(serverExpiredNote(harbor(), "10 minutes")).toBe('Nobody answered about the MCP server "harbor" within 10 minutes, so it stays stopped. Your next message asks again.');
		expect(serverUnansweredNote(harbor())).toBe('The turn ended before anyone answered about the MCP server "harbor". Your next message asks again.');
	});

	it("give a server started from the user's record one plain line that says why nobody was asked, and when they approved", () => {
		expect(serverRecalledNote(harbor(), { state: "running", tools: 2 }, "3 days ago")).toEqual({ level: "info", text: 'Started the MCP server "harbor" because you approved it for this project 3 days ago: 2 tools. The agent has them from this turn on.' });
		expect(serverRecalledNote(harbor({ holdsTurn: false }), { state: "running", tools: 1 }, "a moment ago").text).toBe(
			'Started the MCP server "harbor" because you approved it for this project a moment ago: 1 tool. The turn was already running: the agent is told of them at its next step.',
		);
		expect(serverRecalledNote(harbor(), { state: "running", tools: 0 }, "2 hours ago").text).toBe('Started the MCP server "harbor" because you approved it for this project 2 hours ago: no tools.');
		expect(serverRecalledNote(harbor({ name: "docs", argv: null, url: "https://docs.example.com/mcp" }), { state: "running", tools: 4 }, "3 days ago").text).toBe(
			'Connected to the MCP server "docs" because you approved it for this project 3 days ago: 4 tools. The agent has them from this turn on.',
		);
		expect(serverRecalledNote(harbor(), { state: "starting" }, "3 days ago").text).toBe('The MCP server "harbor" is starting because you approved it for this project 3 days ago; the agent is told of its tools once it runs.');
		expect(serverRecalledNote(harbor({ unset: ["HARBOR_TOKEN"] }), { state: "failed", reason: "the environment variable HARBOR_TOKEN named in its env is not set" }, "3 days ago", SAVE_HARBOR_TOKEN)).toEqual({
			level: "warn",
			text: `You approved the MCP server "harbor" for this project 3 days ago, but it did not start: the environment variable HARBOR_TOKEN named in its env is not set. ${SAVE_HARBOR_TOKEN}`,
		});
		expect(serverRecalledNote(harbor(), { state: "failed", reason: "the server process exited with code 1." }, "3 days ago").text).toBe('You approved the MCP server "harbor" for this project 3 days ago, but it did not start: the server process exited with code 1. Windlass tries again by itself.');
		expect(serverRecalledNote(harbor(), { state: "changed" }, "3 days ago").text).toBe('The definition of the MCP server "harbor" changed as it was being started, so nothing was started. The new definition is asked about.');
		expect(serverRecalledNote(harbor(), { state: "refused", reason: "the engine did not answer" }, "3 days ago").text).toBe('Windlass did not take your earlier approval of the MCP server "harbor": the engine did not answer. Your next message tries again.');
	});

	it("say what the panel did, and what forgetting leaves, for each place Windlass keeps its own record", () => {
		expect(serverPanelApprovedNote({ name: "harbor", remote: false })).toBe('Approved the MCP server "harbor" for this project in the session\'s panel. It starts with the next turn.');
		expect(serverPanelApprovedNote({ name: "docs", remote: true })).toBe('Approved the MCP server "docs" for this project in the session\'s panel. Windlass connects to it with the next turn.');
		expect(serverForgottenNote({ name: "harbor" }, { dataInSandbox: true })).toBe('Forgot your approval of the MCP server "harbor" for this project. The next session or sandbox asks again; where it already started, Windlass\'s own record still starts it.');
		expect(serverForgottenNote({ name: "harbor" }, { dataInSandbox: false })).toBe('Forgot your approval of the MCP server "harbor" for this project. Windlass\'s own record, which all your sessions share here, still starts it until 30 days after it was last approved.');
		expect(forgettingWords({ dataInSandbox: true })).toBe("Forgetting holds for the next session or sandbox. Where the server already started, Windlass's own record still starts it, and a running one is not stopped.");
		expect(forgettingWords({ dataInSandbox: false })).toBe("Forgetting holds once Windlass's own record has run out, 30 days after the server was last approved: all your sessions share that record here. A running server is not stopped.");
		// A repository's settings, where hardened Docker sandboxes keep Windlass data of their own and the Windlass sandbox profile shares it.
		const mixed = forgettingWords({ dataInSandbox: false, hardenedOwnData: true });
		expect(mixed).toContain("With the Docker + Windlass sandbox profile, forgetting holds once Windlass's own record has run out");
		expect(mixed).toContain("A hardened Docker sandbox has Windlass data of its own, so there it holds for the next session or sandbox.");
		expect(forgettingWords({ dataInSandbox: true, hardenedOwnData: true })).toBe(forgettingWords({ dataInSandbox: true }));
	});

	it("has the mock say what a secret reaches word for word as the server does, for every kind of sandbox", () => {
		const kinds = [profile("docker-windlass-sandbox"), profile("docker-hardened"), e2bProfile({ windlassSandbox: false }), e2bProfile({ windlassSandbox: true })];
		for (const kind of kinds) {
			for (const scope of ["setup", "agent"] as const) {
				expect(mockSecretReach(scope, kind)).toEqual(secretReach(scope, kind));
			}
		}
	});

	it("has the mock list a repository's secrets for the sandbox it is asked about: the selected sandbox profile", async () => {
		const client = createMockClient({ pace: 0, origin: "http://localhost:5173" });
		const user = client.user({ token: "mock:user:u_ada:ada@example.com", profile: { uid: "u_ada", email: "ada@example.com", demo: false } });
		const sentences = (list: { secrets: Array<{ name: string; reach: { note: string | null } }> }) => Object.fromEntries(list.secrets.map((secret) => [secret.name, secret.reach.note !== null]));
		expect(sentences(await user.repositorySecrets(7101, "docker-windlass-sandbox"))).toEqual({ DEPLOY_KEY: false, NPM_TOKEN: false, PREVIEW_HOST: false, SENTRY_DSN: false });
		expect(sentences(await user.repositorySecrets(7101, "docker-hardened"))).toEqual({ DEPLOY_KEY: false, NPM_TOKEN: true, PREVIEW_HOST: false, SENTRY_DSN: true });
		client.dispose();
	});

	it("are repeated by the mock word for word, for the profiles, sessions and projects it plays", () => {
		// The mock plays a deployment whose sandboxes keep Windlass's data to themselves, on the profiles of local Docker.
		const projects = [
			{ mine: mockProject({ id: "s_1", repoUrl: "https://github.com/acme/harbor.git", repository: { provider: "github", id: 7101, owner: "acme", name: "harbor", branch: "main", private: true, url: "https://github.com/acme/harbor" } }), theirs: repo },
			{ mine: mockProject({ id: "s_1", repoUrl: "https://example.com/acme/harbor.git" }), theirs: pasted },
			{ mine: mockProject({ id: "s_1", repoUrl: null }), theirs: own },
		];
		for (const { mine: project, theirs } of projects) {
			expect(project).toEqual(theirs);
			for (const id of ["docker-windlass-sandbox", "docker-hardened"]) {
				const mine = MOCK_PROFILES.find((candidate) => candidate.id === id) as SandboxProfile;
				for (const demo of [true, false]) {
					// The mock plays a repository no secret of that name is saved for; a session without one can have none.
					const context = { profile: profile(id), demo, dataInSandbox: true, project: theirs, secrets: theirs.kind === "github" ? [] : null };
					for (const unset of [[], ["HARBOR_TOKEN"], ["A", "B"]]) {
						const server = harbor({ unset, argv: ["python3", "tools/harbor_mcp.py", "it's here"] });
						expect(mockServerQuestion({ name: server.name, argv: server.argv as string[], unset }, mine, demo, project)).toEqual(serverQuestionWords(server, context));
					}
					for (const remote of [false, true]) expect(mockPanelWords({ name: "harbor", remote }, mine, demo, project)).toEqual(serverPanelWords({ name: "harbor", remote }, context));
				}
			}
		}
		expect(MOCK_FORGETTING).toBe(forgettingWords({ dataInSandbox: true }));
	});
});

// ---------------------------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------------------------

describe("the mock's server question", () => {
	let client: MockClient;
	let auth: AuthResult;

	const after = async <T>(ms: number, promise: Promise<T>): Promise<T> => {
		await vi.advanceTimersByTimeAsync(ms);
		return promise;
	};

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
		client = createMockClient({ origin: "http://localhost:5173" });
		// Signed in with ChatGPT: a session whose turns are handed an access token, which the question has to name.
		const started = await after(1000, client.login.start());
		auth = await after(1000, client.login.finish(`${started.redirectPrefix}?code=abc&state=${new URL(started.url).searchParams.get("state")}`));
	});

	afterEach(() => {
		client.dispose();
		vi.useRealTimers();
	});

	async function session() {
		const summary = await after(500, client.user(auth).createSession({ profile: "docker-windlass-sandbox" }));
		const api = client.session(auth, summary.id);
		const record = { items: [] as TimelineItem[], questions: [] as Array<PendingQuestion | null>, question: null as PendingQuestion | null, statuses: [] as string[] };
		const feed: SessionFeed = {
			onSnapshot: (snapshot) => {
				record.question = snapshot.question;
			},
			onItem: (item) => {
				record.items.push(item);
			},
			onDelta: () => undefined,
			onSummary: (summary) => {
				if (record.statuses.at(-1) !== summary.status) record.statuses.push(summary.status);
			},
			onQuestion: (question) => {
				record.questions.push(question);
				record.question = question;
			},
			onConnection: () => undefined,
		};
		api.open(feed);
		await vi.advanceTimersByTimeAsync(500);
		const lines = () => record.items.flatMap((item) => (item.kind === "platform" && item.text.includes("MCP server") ? [item.text] : []));
		const windlass = (turn: number) => record.items.filter((item) => item.kind === "windlass" && item.turn === turn).length;
		const ended = (turn: number) => record.items.some((item) => item.kind === "turn.ended" && item.turn === turn);
		const until = async (what: () => boolean) => {
			for (let waited = 0; !what(); waited += 50) {
				if (waited > 10 * 60_000) throw new Error("the mock did not get there");
				await vi.advanceTimersByTimeAsync(50);
			}
		};
		return { api, record, lines, windlass, ended, until };
	}

	it("asks before the turn's first event, and holds the turn", async () => {
		const { api, record, windlass, until } = await session();
		await after(300, api.prompt({ text: "List the berths with the mcp server" }));
		await until(() => record.question !== null);
		const question = record.question as PendingQuestion;
		expect(question).toMatchObject({ turn: 1, messageId: "", callId: "", title: 'Start this project\'s MCP server "harbor"?', subject: "python3 tools/harbor_mcp.py", subagent: null });
		expect(question.server).toEqual({ name: "harbor", file: "/workspace/.windlass/config.json", remote: false, unset: [], holdsTurn: true });
		expect(question.expiresAt - question.askedAt).toBe(3 * 60_000);
		expect(record.statuses.at(-1)).toBe("waiting");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(windlass(1)).toBe(0);
	});

	it("starts the server on a yes, says when the agent has its tools, and does not ask about that definition again", async () => {
		const { api, record, lines, windlass, ended, until } = await session();
		await after(300, api.prompt({ text: "List the berths with the mcp server" }));
		await until(() => record.question !== null);
		await after(400, api.answer({ questionId: (record.question as PendingQuestion).id, choice: "start" }));
		expect(record.question).toBeNull();
		expect(lines()).toEqual(['Started the MCP server "harbor" for this project: 2 tools. The agent has them from this turn on.']);
		await until(() => ended(1));
		expect(windlass(1)).toBeGreaterThan(0);
		expect(record.statuses.slice(-3)).toEqual(["waiting", "running", "idle"]);
		await after(300, api.prompt({ text: "And again with the mcp server" }));
		await until(() => ended(2));
		expect(record.questions).toHaveLength(2);
	});

	it('leaves it stopped on "not now", and asks again with the next message', async () => {
		const { api, record, lines, ended, until } = await session();
		await after(300, api.prompt({ text: "List the berths with the mcp server" }));
		await until(() => record.question !== null);
		await after(400, api.answer({ questionId: (record.question as PendingQuestion).id, choice: "not_now" }));
		expect(lines()).toEqual(['Left the MCP server "harbor" stopped. If the agent tries to use it, it is told that the server waits for you; your next message asks again.']);
		await until(() => ended(1));
		await after(300, api.prompt({ text: "Try the mcp server once more" }));
		await until(() => record.question !== null);
		expect((record.question as PendingQuestion).turn).toBe(2);
	});

	it('settles a question nobody answers as "not now", and the turn goes on', async () => {
		const { api, record, lines, ended, until } = await session();
		await after(300, api.prompt({ text: "List the berths with the mcp server" }));
		await until(() => record.question !== null);
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(record.question).toBeNull();
		expect(lines()).toEqual(['Nobody answered about the MCP server "harbor" within 3 minutes, so it stays stopped. Your next message asks again.']);
		await until(() => ended(1));
		expect(record.statuses.slice(-3)).toEqual(["waiting", "running", "idle"]);
	});

	it("says which variable is not set, in the question and after an approval", async () => {
		const { api, record, lines, until } = await session();
		await after(300, api.prompt({ text: "Use the mcp server that needs a variable" }));
		await until(() => record.question !== null);
		const question = record.question as PendingQuestion;
		expect(question.server?.unset).toEqual(["HARBOR_TOKEN"]);
		// The session has no repository of the GitHub connection, so there is nowhere to save the variable.
		expect(question.details[3]).toBe("It will not start yet: its definition reads the variable HARBOR_TOKEN, which is not set where Windlass runs. A variable is set by saving a secret for a repository of your GitHub connection, and this session is not on one. A secret of your account under that name, saved in your settings, sets it for MCP servers too.");
		await after(400, api.answer({ questionId: question.id, choice: "start" }));
		expect(lines()).toEqual(['Approved the MCP server "harbor" for this project, but it did not start: the environment variable HARBOR_TOKEN named in its env is not set. A variable is set by saving a secret for a repository of your GitHub connection, and this session is not on one. A secret of your account under that name, saved in your settings, sets it for MCP servers too.']);
	});

	it("lets a tool call's question come first: the server's steps aside, is put again after it, and goes with the turn", async () => {
		const { api, record, lines, ended, until } = await session();
		await after(300, api.prompt({ text: "Fetch the headers of example.com; the mcp server comes late" }));
		await until(() => record.question !== null);
		const server = record.question as PendingQuestion;
		expect(server.server?.holdsTurn).toBe(false);
		expect(record.statuses.at(-1)).toBe("running");
		await until(() => record.question !== null && record.question.server === undefined);
		const call = record.question as PendingQuestion;
		expect(record.statuses.at(-1)).toBe("waiting");
		await after(400, api.answer({ questionId: call.id, choice: "once" }));
		expect(record.questions.map((question) => question?.id ?? null)).toEqual([server.id, call.id, null, server.id]);
		expect((record.question as PendingQuestion).expiresAt).toBeGreaterThan(server.expiresAt);
		await until(() => ended(1));
		expect(record.question).toBeNull();
		expect(lines()).toEqual(['The turn ended before anyone answered about the MCP server "harbor". Your next message asks again.']);
	});

	it("takes an answer to a server's question that stands aside", async () => {
		const { api, record, lines, until } = await session();
		await after(300, api.prompt({ text: "Fetch the headers of example.com; the mcp server comes late" }));
		await until(() => record.question !== null);
		const server = record.question as PendingQuestion;
		await until(() => record.question !== null && record.question.server === undefined);
		const call = record.question as PendingQuestion;
		await after(400, api.answer({ questionId: server.id, choice: "start" }));
		expect(record.question?.id).toBe(call.id);
		expect(lines()).toEqual(['Started the MCP server "harbor" for this project: 2 tools. The turn was already running: the agent is told of them at its next step.']);
	});
});

// ---------------------------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------------------------

describe("the question control", () => {
	let host: HTMLElement;
	let root: Root;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.useRealTimers();
	});

	const now = Date.parse("2026-11-15T12:00:00Z");
	const words = serverQuestionWords(harbor(), { profile: profile("docker-windlass-sandbox"), demo: false, dataInSandbox: false, project: repo });
	const about = (server: Partial<NonNullable<PendingQuestion["server"]>> = {}): PendingQuestion => ({
		id: "q_1",
		turn: 1,
		messageId: "",
		callId: "",
		...words,
		subagent: null,
		askedAt: now,
		expiresAt: now + 10 * 60_000,
		server: { name: "harbor", file: "/workspace/.windlass/config.json", remote: false, unset: [], holdsTurn: true, ...server },
	});
	const call: PendingQuestion = {
		id: "q_2",
		turn: 1,
		messageId: "m1",
		callId: "c1",
		title: "Allow network access for this command?",
		subject: "curl -sI https://example.com",
		details: ["With network access the command can send anything it can read to any host."],
		choices: [
			{ id: "once", label: "Allow once", approve: true, remembers: null },
			{ id: "deny", label: "Decline", approve: false, remembers: null },
		],
		subagent: null,
		askedAt: now,
		expiresAt: now + 10 * 60_000,
	};
	const flowFor = (question: PendingQuestion | null, answer = vi.fn()): QuestionFlow => ({ question, sending: null, error: null, gone: null, note: "", setNote: () => undefined, answer, inlineInView: false, setInlineInView: () => undefined });
	const text = (selector: string) => [...host.querySelectorAll(selector)].map((node) => node.textContent?.replace(/\s+/g, " ").trim());

	it("shows a server's question as the same control: the command, where it is defined, what to know, two answers and no note", () => {
		const answer = vi.fn();
		act(() => root.render(createElement(QuestionCard, { question: about(), flow: flowFor(about(), answer) })));
		expect(text(".q-title")).toEqual(['The platform asks: Start this project\'s MCP server "harbor"?']);
		expect(text(".q-subject")).toEqual(["python3 tools/harbor_mcp.py"]);
		expect(host.querySelector(".q-subject")?.getAttribute("aria-label")).toBe("The command that starts it");
		expect(text(".q-where")).toEqual(["defined in /workspace/.windlass/config.json"]);
		expect(text(".q-details p")).toEqual(words.details);
		expect(text(".q-countdown")).toEqual(["stays stopped in 10:00"]);
		expect(host.querySelector(".q-countdown")?.getAttribute("title")).toMatch(/^If nobody answers by .*, the server stays stopped and the turn goes on without it\.$/);
		const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
		expect(buttons.map((button) => button.textContent)).toEqual(["Start it for this project, remembers exactly this definition, for your sessions, for 30 days", "Not now"]);
		expect(host.querySelector(".q-note-open, .q-note")).toBeNull();
		act(() => buttons[0]?.click());
		expect(answer).toHaveBeenCalledWith(about().choices[0]);
	});

	it("says what running out means for a question that does not hold the turn, and for a server that is only reached", () => {
		act(() => root.render(createElement(QuestionCard, { question: about({ holdsTurn: false }), flow: flowFor(null) })));
		expect(host.querySelector(".q-countdown")?.getAttribute("title")).toMatch(/, the server stays stopped\.$/);
		act(() => root.render(createElement(QuestionCard, { question: about({ remote: true }), flow: flowFor(null) })));
		expect(text(".q-countdown")).toEqual(["stays unconnected in 10:00"]);
		expect(host.querySelector(".q-subject")?.getAttribute("aria-label")).toBe("The address it is reached at");
		act(() => root.render(createElement(QuestionCard, { question: about(), flow: flowFor(null) })));
		act(() => {
			vi.advanceTimersByTime(10 * 60_000 + 1000);
		});
		expect(text(".q-countdown")).toEqual(["Leaving it stopped now…"]);
	});

	it("leaves the file to the full form in the dock, and keeps a tool call's question as it was", () => {
		act(() => root.render(createElement(QuestionDock, { flow: flowFor(about()) })));
		expect(host.querySelector(".q-dock")?.getAttribute("aria-label")).toBe("The agent is waiting for your answer");
		expect(host.querySelector(".q-where")).toBeNull();
		expect(host.querySelector(".q-details")).toBeNull();
		expect(text(".q-choice")).toHaveLength(2);
		act(() => root.render(createElement(QuestionDock, { flow: flowFor(about({ holdsTurn: false })) })));
		expect(host.querySelector(".q-dock")?.getAttribute("aria-label")).toBe("A question is waiting for your answer");
		act(() => root.render(createElement(QuestionCard, { question: call, flow: flowFor(call) })));
		expect(text(".q-title")).toEqual(["The agent asks: Allow network access for this command?"]);
		expect(text(".q-countdown")).toEqual(["declines in 10:00"]);
		expect(host.querySelector(".q-where")).toBeNull();
		expect(text(".q-note-open")).toEqual(["add a note"]);
	});

	it("stands at the end of its turn in the conversation, after the platform's lines", () => {
		let view: SessionView = emptyView();
		const items: TimelineItem[] = [
			{ seq: 1, at: now, turn: 1, kind: "user", text: "List the berths", model: "gpt-6.1-sol", effort: null },
			{ seq: 2, at: now, turn: 1, kind: "platform", level: "info", text: "Creating sandbox: Docker + Windlass sandbox" },
		];
		for (const item of items) view = applyItem(view, item);
		const flow = flowFor(about());
		act(() => root.render(createElement(InteractiveProvider, { value: { flow, stopCall: null }, children: createElement(Turn, { turn: view.turns[0] as TurnView }) })));
		const blocks = [...host.querySelectorAll(".turn > *")].map((node) => node.className);
		expect(blocks.slice(0, 3)).toEqual(["block block-user", "block block-platform", "q-inline block block-question"]);
		expect(host.querySelector(".q-inline")?.id).toBe("question-q_1");
		// Its outcome is a line of the platform's, where the question stood.
		view = applyItem(view, { seq: 3, at: now, turn: 1, kind: "platform", level: "info", text: serverNotNowNote(harbor()) });
		act(() => root.render(createElement(InteractiveProvider, { value: { flow: flowFor(null), stopCall: null }, children: createElement(Turn, { turn: view.turns[0] as TurnView }) })));
		expect(host.querySelector(".q-inline")).toBeNull();
		expect(text(".block-platform").at(-1)).toContain('Left the MCP server "harbor" stopped.');
	});
});
