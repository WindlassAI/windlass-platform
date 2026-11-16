/**
 * The mock `PlatformClient`: the whole backend in memory, with no network.
 *
 * It serves a user with a handful of sessions in different states, the six sandbox profiles, and
 * plays the recorded `windlass --json` runs in fixtures/windlass-events/ as turns with their real
 * timing. Events are split the way contract.ts describes: durable events and `notice`,
 * `workspace.changes`, `cli.summary` are stored as timeline items; `text.delta`, `reasoning.delta`,
 * `tool.input.delta` and `tool.progress` are broadcast as deltas and kept in `pending` only until the
 * next durable event. `stop()` interrupts a turn the way Windlass winds one down.
 *
 * Interactive turns: a prompt about the network plays the ACP approval recording up to its question
 * and waits (`question`, status "waiting"); `answer()` carries on with the approved or the declined
 * recording, and a question nobody answers is declined by the platform after `questionTimeoutMs`.
 * A prompt sent while a turn runs steers it, and `stopCall()` stops one running call.
 *
 * A project's MCP server: a prompt with the word "mcp" plays a repository whose `.windlass/config.json`
 * names the server "harbor". The question about it is put before the turn's first event and holds the
 * turn; "start" and "not now" each leave the platform's line and the turn carries on, and nobody
 * answering is "not now". An approved definition is not asked about again in that session. With
 * "variable" in the prompt the definition reads a variable that is not set (the question says so, and
 * an approval ends in the line that the server did not start); with "late", Windlass reports the
 * server while the turn runs, so with a network word as well the tool call's question arrives while
 * the server's is open: the server's steps aside and is put again after it. The words are
 * server/src/server-question.ts's, repeated here (Question.server.test.ts compares the two).
 *
 * An approval is remembered for the user and the session's project (its repository, or the session
 * itself), as the server remembers it, and here the mock plays the deployment and not local Docker,
 * whose profiles it lists: Windlass's own record stays in the sandbox it was made in, so a second
 * session on the same repository is spared the question by the platform's record, with the line that
 * says so. The panel's list comes from `servers()`, and `approveServer()` and `forgetServer()` change
 * the record. Two seeded sessions on acme/harbor share one approval, and one of them shows every
 * state: a server that runs, one that waits and one that could not start. `mockNextServers()` makes
 * the next of those calls fail.
 *
 * GitHub: the deployment has a GitHub App, the signed-in ChatGPT user starts connected and the demo
 * user does not. Connecting sends the browser to the address the real server would send it back to
 * (`#github=<ticket>`), so the way back is the real one; whether a user is connected is kept in
 * localStorage, since the page reloads on the way. A few seeded sessions were launched on repositories
 * of the connection, with and without a pull request. `publish()` takes a moment, empties the list of
 * changed files and writes the timeline's line. `mockNextGithub()` makes the next call fail as GitHub
 * can, and `createMockClient({ github: false })` plays a deployment with no GitHub App.
 *
 * The world is rebuilt from the token on every page load, so the seeded sessions keep their IDs
 * across a reload and sessions created by hand do not survive one.
 */
import {
	MAX_PROMPT_CHARS,
	MAX_RUNNING_SESSIONS,
	MAX_TITLE_CHARS,
	type AuthResult,
	type ChatgptStatus,
	type CreateSessionInput,
	type GithubAccount,
	type GithubBranchList,
	type GithubConnection,
	type GithubRepository,
	type GithubRepositoryList,
	type GithubStatus,
	type LiveDelta,
	type LoginStart,
	type PendingQuestion,
	type PlatformInfo,
	type PromptInput,
	type PublishMessage,
	type PublishResult,
	type PublishState,
	type PullRequestInfo,
	type SandboxProfile,
	type SessionRepository,
	type SessionServer,
	type SessionServers,
	type SessionSnapshot,
	type SessionSummary,
	type TimelineItem,
	type TurnOutcome,
	type TurnUsage,
	type UserProfile,
	type WindlassEvent,
	type WorkspaceFile,
	MAX_NOTE_CHARS,
} from "@contract";
import { PlatformError, type PlatformClient, type SessionApi, type SessionFeed, type UserApi, type UserFeed } from "./client";
import { isDurable, isLive, schedule, splitRuns, turnEnded, withSummary } from "./feed";
import { fixture } from "./fixtures";

export interface MockOptions {
	/** Multiplies every wait: 1 is real time, 0 makes everything happen at once (still asynchronously). */
	pace?: number;
	now?: () => number;
	/** The address of the app, for the mock sign-in page. */
	origin?: string;
	/** How long a question waits before the platform declines it. Shorter than the real one by default. */
	questionTimeoutMs?: number;
	/** False plays a deployment with no GitHub App: nothing of GitHub is offered. */
	github?: boolean;
}

/** What the next call about GitHub fails with, for looking at each failure by hand. */
export type MockGithubFailure =
	/** The repositories cannot be listed. */
	| "list"
	/** The browser comes back from GitHub with a refusal. */
	| "connect"
	/** A push that GitHub refuses: no write access, a protected branch, a repository that is gone. */
	| "denied"
	| "protected"
	| "gone";

export interface MockClient extends PlatformClient {
	/** Drops every live feed for `ms`, then reconnects them, as a network interruption would. */
	simulateDrop(ms: number): void;
	/**
	 * Makes the next `answer()` go wrong, for looking at the error by hand: "elsewhere" answers the
	 * question as another tab would have, then refuses with `no_question`; "error" fails as a request
	 * that never reached the server would, and leaves the question waiting.
	 */
	mockNextAnswer(kind: "elsewhere" | "error"): void;
	/** Makes the next call about GitHub of that kind fail (`__wlpMock.mockNextGithub("protected")`, then push). */
	mockNextGithub(kind: MockGithubFailure): void;
	/**
	 * Makes the next call about a project's MCP servers fail, for looking at the panel's errors by hand:
	 * "list" the reading of the list, "approve" and "forget" the action (`__wlpMock.mockNextServers("forget")`,
	 * then Forget). "slow" makes every one of these calls take ten seconds, for the next ten seconds.
	 */
	mockNextServers(kind: "list" | "approve" | "forget" | "slow"): void;
}

/** The mock's question timeout: long enough to answer, short enough to watch the platform decline. */
export const MOCK_QUESTION_TIMEOUT_MS = 3 * 60_000;

// ---------------------------------------------------------------------------------------------
// What the mock serves
// ---------------------------------------------------------------------------------------------

/** The profiles as server/src/sandbox/profiles.ts has them, word for word (mock.test.ts compares the two). */
export const MOCK_PROFILES: SandboxProfile[] = [
	{
		id: "docker-windlass-sandbox",
		name: "Docker + Windlass sandbox",
		summary: "A container of its own, and every command the agent runs is sandboxed again by Windlass: no network, and the session's access token is out of its reach. Your ChatGPT sign-in is never in the container.",
		layers: ["Docker container (non-root, no capabilities, resource limits)", "Windlass's bubblewrap sandbox around each command (no network, writes only in the workspace, credentials hidden)"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadAccessToken: false,
		available: true,
	},
	{
		id: "docker-hardened",
		name: "Docker, hardened",
		summary: "A container under Docker's default seccomp and AppArmor profiles; commands run directly in it, with network, and can read the session's access token, which lasts about an hour and cannot be renewed. Your ChatGPT sign-in is never in the container.",
		layers: ["Docker container (default seccomp and AppArmor, non-root, no capabilities, resource limits)"],
		approval: "full",
		commandNetwork: true,
		commandsCanReadAccessToken: true,
		available: true,
	},
	{
		id: "e2b",
		name: "E2B",
		summary: "A Firecracker microVM hosted by E2B.",
		layers: ["E2B microVM"],
		approval: "auto",
		commandNetwork: true,
		commandsCanReadAccessToken: false,
		available: false,
		unavailableReason: "This server runs its sandboxes on local Docker. E2B is built: a server started with WLP_SANDBOX=e2b, an E2B API key and the E2B template (README, \"E2B\") offers it in place of the Docker profiles, and says there what it promises.",
	},
	{
		id: "daytona",
		name: "Daytona",
		summary: "A workspace hosted by Daytona.",
		layers: ["Daytona workspace"],
		approval: "auto",
		commandNetwork: true,
		commandsCanReadAccessToken: false,
		available: false,
		unavailableReason: "Not built here yet: it needs a Daytona provider in the sandbox layer, a Daytona image with Windlass in it and a Daytona account. Windlass no longer stands in the way: a session there would be handed a short-lived access token, as the Docker sessions are, and the sign-in would stay on the platform.",
	},
	{
		id: "firecracker",
		name: "Firecracker microVM",
		summary: "A microVM per session on this host.",
		layers: ["Firecracker microVM (KVM)"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadAccessToken: false,
		available: false,
		unavailableReason: "Not built here: it needs a host with KVM, a guest image with Windlass in it and a guest agent to run commands in the VM, and this deployment has none of them. A session there would be handed a short-lived access token, as the Docker sessions are.",
	},
	{
		id: "agentos",
		name: "agentOS",
		summary: "Rivet's agentOS, where the agent's tools run through a remote execution interface.",
		layers: ["agentOS runtime"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadAccessToken: false,
		available: false,
		unavailableReason: "agentOS cannot run the Windlass executable, and Windlass's tools would have to work through agentOS's remote execution interface, which they do not. Handing a session an access token changes nothing about that.",
	},
];

// ---- GitHub ---------------------------------------------------------------------------------

const GITHUB = { slug: "windlass-mock", url: "https://github.com" };
const GITHUB_NOT_CONNECTED = "GitHub is not connected any more. Connect GitHub again from the account menu, then try once more.";

const GITHUB_ACCOUNTS: GithubAccount[] = [
	{ installationId: 61001, login: "ada", kind: "user", manageUrl: "https://github.com/settings/installations/61001" },
	{ installationId: 61002, login: "acme", kind: "organization", manageUrl: "https://github.com/organizations/acme/settings/installations/61002" },
];

interface MockRepository extends Omit<GithubRepository, "pushedAt"> {
	/** How long ago it was pushed to, in hours. */
	pushedHoursAgo: number;
	branches: string[];
}

const mockRepository = (id: number, owner: string, name: string, visibility: "private" | "public", pushedHoursAgo: number, branches: string[] = [], canPush = true): MockRepository => ({
	id,
	owner,
	name,
	private: visibility === "private",
	defaultBranch: "main",
	canPush,
	pushedHoursAgo,
	branches: ["main", ...branches],
});

const GITHUB_REPOSITORIES: MockRepository[] = [
	mockRepository(7101, "acme", "harbor", "private", 2, ["fix/tide-tables", "release/2.4", "release/2.3"]),
	mockRepository(7102, "ada", "tide-tables", "public", 5, ["gh-pages"]),
	mockRepository(7103, "acme", "lighthouse-docs", "public", 26, ["next"]),
	mockRepository(7104, "ada", "dotfiles", "private", 70),
	mockRepository(7105, "acme", "quay", "private", 96, ["develop"], false),
	mockRepository(7106, "acme", "signal-flags", "private", 150, ["v2"]),
	mockRepository(7107, "ada", "windlass-notes", "private", 200),
	mockRepository(7108, "acme", "charts", "private", 340, ["soundings"]),
	mockRepository(7109, "acme", "harbor-infrastructure", "private", 500, ["staging", "production"]),
	mockRepository(7110, "ada", "knots", "public", 900),
	mockRepository(7111, "acme", "ballast", "private", 1400, [], false),
	mockRepository(7112, "acme", "a-repository-with-a-rather-long-name-for-testing-how-it-clips", "private", 2600),
];

const sessionRepository = (owner: string, name: string, branch = "main"): SessionRepository => {
	const found = GITHUB_REPOSITORIES.find((repository) => repository.owner === owner && repository.name === name);
	return { provider: "github", id: found?.id ?? 0, owner, name, branch, private: found?.private ?? true, url: `${GITHUB.url}/${owner}/${name}` };
};

const MODELS = ["gpt-6.1-sol", "gpt-6-luna"];
const EFFORTS = ["low", "medium", "high"];
const REDIRECT_PREFIX = "http://127.0.0.1:1455/auth/callback";

interface WorkspaceChange {
	status: string;
	diff: string;
}

/** The rest of a turn that stops at a question: one recording per kind of answer. */
interface QuestionScript {
	approved: WindlassEvent[];
	declined: WindlassEvent[];
	/** Set when a subagent asks: the first line of its task. */
	subagent?: string;
}

/** A server the project's configuration names, as a prompt's words choose it. */
interface MockServer {
	name: string;
	/** Stands for Windlass's mark of the definition: an approval is for it. */
	fingerprint: string;
	argv: string[];
	/** Variables the definition reads that are not set in the sandbox. */
	unset: string[];
	/** Reported while the turn runs, instead of before its prompt goes. */
	late: boolean;
}

interface Script {
	/** For a turn with a question: everything up to and including its `approval.requested`. */
	events: WindlassEvent[];
	question?: QuestionScript;
	/** The project's server that waits for the user's approval in this turn. */
	server?: MockServer;
	/** Slows the recording down (2 plays it at half speed). */
	stretch?: number;
	workspace?: Record<string, WorkspaceChange>;
	/** The platform could not run the turn at all: no Windlass events, an "error" outcome with this message. */
	platformFailure?: string;
}

const run = (name: string, index = 0): WindlassEvent[] => splitRuns(fixture(name))[index] ?? [];

const ADD_TS_DIFF = `diff --git a/src/add.ts b/src/add.ts
index 3b1f0c2..9d2e7aa 100644
--- a/src/add.ts
+++ b/src/add.ts
@@ -1,3 +1,3 @@
 export function add(a: number, b: number) {
-  return a - b
+  return a + b
 }
`;

const CHECKS_DIFF = `diff --git a/add.ts b/add.ts
index 1c9a0f4..5e8b7d1 100644
--- a/add.ts
+++ b/add.ts
@@ -1 +1 @@
-export const add = (a: number, b: number) => a - b
+export const add = (a: number, b: number) => a + b
`;

const TEST_DIFF = `diff --git a/a.test.ts b/a.test.ts
index 77c41de..0b9f3a2 100644
--- a/a.test.ts
+++ b/a.test.ts
@@ -1,7 +1,7 @@
 import { expect, test } from "bun:test"
 import { add } from "./add.ts"

 test("adds two numbers", () => {
-  expect(add(1, 1)).toBe(3)
+  expect(add(1, 1)).toBe(2)
 })

@@ -14,6 +14,10 @@ test("adds negative numbers", () => {
   expect(add(-1, -1)).toBe(-2)
 })

+test("adds zero", () => {
+  expect(add(0, 0)).toBe(0)
+})
+
 test("is commutative", () => {
   expect(add(2, 3)).toBe(add(3, 2))
 })
`;

const MADE_DIFF = `diff --git a/made.txt b/made.txt
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/made.txt
@@ -0,0 +1 @@
+hello
`;

/**
 * The ACP approval recordings as a question script: the shared start up to the question, then the
 * approved or declined rest. The two runs have their own message IDs; the declined rest is given the
 * approved run's, since it continues the same call. The second message steered in while a command ran
 * is the recorder's, not the user's: it is left out, and the user's own steers are added by `prompt()`.
 */
function questionScript(subagent?: string): Script {
	const approved = withSummary(fixture("acp-approval-approved"));
	const declined = withSummary(fixture("acp-approval-denied"));
	const asked = (events: WindlassEvent[]) => events.findIndex((event) => event.type === "approval.requested");
	const messageOf = (events: WindlassEvent[]) => String((events[asked(events)]?.data ?? {}).messageId);
	const from = messageOf(declined);
	const to = messageOf(approved);
	const rest = (events: WindlassEvent[], rename: boolean) =>
		events
			.slice(asked(events) + 1)
			.filter((event) => !event.type.startsWith("inbox."))
			.map((event) => {
				if (!rename || event.data?.messageId !== from) return event;
				return { ...event, data: { ...event.data, messageId: to } };
			});
	return { events: approved.slice(0, asked(approved) + 1), question: { approved: rest(approved, false), declined: rest(declined, true), subagent }, stretch: 1.4 };
}

const SCRIPTS = {
	fix: { events: run("demo-find-and-fix-a-failing-test"), workspace: { "src/add.ts": { status: " M", diff: ADD_TS_DIFF } } },
	parallel: { events: run("demo-two-parallel-tool-calls") },
	checks: { events: run("demo-the-checks-fail-the-model-fixes-the-code-and-they-pass"), workspace: { "add.ts": { status: " M", diff: CHECKS_DIFF } } },
	steps: { events: run("demo-several-steps-in-one-turn"), workspace: { "a.test.ts": { status: " M", diff: TEST_DIFF } } },
	build: { events: run("demo-a-long-build-command") },
	answer: { events: run("demo-two-turns-in-one-session", 0) },
	answerAgain: { events: run("demo-two-turns-in-one-session", 1) },
	sandboxed: { events: run("real-scripted-bwrap"), workspace: { "made.txt": { status: "??", diff: MADE_DIFF } } },
	refused: { events: run("real-scripted-hardened") },
	usageLimit: { events: run("demo-a-non-retryable-error-usage-limit") },
	signedOut: { events: run("demo-a-non-retryable-error-authentication") },
	cancelled: { events: run("demo-cancel-while-one-tool-is-running") },
	network: questionScript(),
	subagentNetwork: questionScript("Check what the API's health endpoint returns"),
	crash: { events: [], platformFailure: "The sandbox stopped responding and the turn was abandoned. Nothing it had written was lost; send the prompt again to carry on." },
} satisfies Record<string, Script>;

type ScriptName = keyof typeof SCRIPTS;

/** What an unrecognised prompt plays, in turn. */
const ROTATION: ScriptName[] = ["fix", "parallel", "checks", "steps", "build", "answer"];

function chooseScript(text: string, rotation: number): ScriptName {
	const words = text.toLowerCase();
	if (/usage|limit|quota/.test(words)) return "usageLimit";
	if (/sign.?in|signed out|auth/.test(words)) return "signedOut";
	if (/crash/.test(words)) return "crash";
	if (/\b(network|fetch|download|curl|https?|headers?|website|url)\b/.test(words)) return /subagent/.test(words) ? "subagentNetwork" : "network";
	if (/refus|approv|unattended|without the sandbox/.test(words)) return "refused";
	if (/sandbox/.test(words)) return "sandboxed";
	if (/build|slow|long|stop|cancel/.test(words)) return "build";
	if (/parallel|both files/.test(words)) return "parallel";
	if (/check/.test(words)) return "checks";
	if (/\d\s*[+*-]\s*\d/.test(words)) return "answer";
	return ROTATION[rotation % ROTATION.length] ?? "fix";
}

const SERVER_FILE = "/workspace/.windlass/config.json";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The server a prompt's words say the project names: "mcp", with "variable" for one that cannot start and "late" for one reported mid-turn. */
function chooseServer(text: string): MockServer | null {
	const words = text.toLowerCase();
	if (!/\bmcp\b/.test(words)) return null;
	const unset = /\bvariables?\b/.test(words) ? ["HARBOR_TOKEN"] : [];
	return { name: "harbor", fingerprint: unset.length > 0 ? "748df09716dce52c" : "81498df752b8ef7d", argv: ["python3", "tools/harbor_mcp.py"], unset, late: /\blate\b/.test(words) };
}

/** What an approval is remembered for, as server/src/server-approvals.ts names it: the session's repository, or the session itself. */
export interface MockProject {
	key: string;
	kind: SessionServers["project"]["kind"];
	label: string;
}

export function mockProject(summary: Pick<SessionSummary, "id" | "repoUrl" | "repository">): MockProject {
	if (summary.repository) return { key: `github:${summary.repository.id}`, kind: "github", label: `${summary.repository.owner}/${summary.repository.name}` };
	if (summary.repoUrl) return { key: `address:${summary.repoUrl}`, kind: "address", label: summary.repoUrl.replace(/^https:\/\//, "").replace(/\/$/, "") };
	return { key: `session:${summary.id}`, kind: "session", label: "this session" };
}

/** Where the server runs and what it can reach, for the two Docker profiles and a demo session or not. */
function mockReach(profile: SandboxProfile, demo: boolean): string {
	const data = demo ? "Windlass's own data. A demo session has no access token there." : "Windlass's own data, including the session's access token, which lasts about an hour and cannot be renewed.";
	return profile.approval === "full"
		? `It runs in this session's container, as the agent's commands do here: like them, it has the network and can read ${data}`
		: `It runs in this session's container, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read ${data}`;
}

/** What approving does and how far it is remembered, where Windlass's own record stays in the sandbox. */
function mockApproving(project: MockProject, when: "now" | "next", remote = false): string {
	const does = when === "next" ? (remote ? "Approving lets Windlass connect to it from this session's next turn" : "Approving starts it with this session's next turn") : remote ? "Approving lets Windlass connect to it now" : "Approving starts it now";
	return project.kind === "session"
		? `${does} and is remembered for 30 days for exactly this definition, for this session, which has no repository: a sandbox that replaces this one ${remote ? "connects" : "starts it"} without asking, until you forget the approval in the session's panel.`
		: `${does} and is remembered for 30 days for exactly this definition: your sessions on ${project.label} then ${remote ? "connect" : "start it"} without asking, until you forget the approval in a session's panel.`;
}

const MOCK_COVERS = "It is an approval of this command, not of the files it runs: a later commit can change those without a new question.";

const commandLine = (argv: readonly string[]) => argv.map((argument) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`)).join(" ");

/**
 * The question about a project's server as server/src/server-question.ts words it where Windlass's
 * data is the sandbox's own, so that what is remembered beyond it is the platform's record: for the
 * two Docker profiles, a demo session or not, a definition that reads variables which are not set,
 * and a project that is a repository or the session itself.
 */
export function mockServerQuestion(server: Pick<MockServer, "name" | "argv" | "unset">, profile: SandboxProfile, demo: boolean, project: MockProject): Pick<PendingQuestion, "title" | "subject" | "details" | "choices"> {
	const names = server.unset.length <= 1 ? server.unset.join("") : `${server.unset.slice(0, -1).join(", ")} and ${server.unset[server.unset.length - 1]}`;
	const missing =
		server.unset.length === 0
			? []
			: [
					server.unset.length === 1
						? `It will not start yet: its definition reads the variable ${names}, which is not set in the sandbox, and the platform cannot set variables for a session yet.`
						: `It will not start yet: its definition reads the variables ${names}, which are not set in the sandbox, and the platform cannot set variables for a session yet.`,
				];
	return {
		title: `Start this project's MCP server "${server.name}"?`,
		subject: commandLine(server.argv),
		details: [mockReach(profile, demo), mockApproving(project, "now"), MOCK_COVERS, ...missing],
		choices: [
			{ id: "start", label: "Start it for this project", approve: true, remembers: project.kind === "session" ? "exactly this definition, for this session, for 30 days" : `exactly this definition, for your sessions on ${project.label}, for 30 days` },
			{ id: "not_now", label: "Not now", approve: false, remembers: null },
		],
	};
}

/** The same question as the panel puts it before an approval between turns (the server's `serverPanelWords`). */
export function mockPanelWords(server: Pick<SessionServer, "name" | "remote">, profile: SandboxProfile, demo: boolean, project: MockProject): NonNullable<SessionServer["asks"]> {
	if (server.remote) {
		return {
			title: `Connect to this project's MCP server "${server.name}"?`,
			details: [
				"Nothing is started: Windlass reaches it at that address from this session's container, outside its sandbox around commands, and what the agent sends it leaves the container.",
				mockApproving(project, "next", true),
				"It is an approval of this address, not of what answers there.",
			],
		};
	}
	return { title: `Start this project's MCP server "${server.name}"?`, details: [mockReach(profile, demo), mockApproving(project, "next"), MOCK_COVERS] };
}

/** What forgetting does and leaves, as the server says it where Windlass's own record stays in the sandbox. */
export const MOCK_FORGETTING = "Forgetting holds for the next session or sandbox. Where the server already started, Windlass's own record still starts it, and a running one is not stopped.";

/** How long ago, as the server's lines say it: "a moment ago", "5 minutes ago", "3 days ago". */
function agoWords(ms: number): string {
	if (ms < 60_000) return "a moment ago";
	const plural = (value: number, unit: string) => (value === 1 ? `1 ${unit}` : `${value} ${unit}s`);
	if (ms >= 2 * 24 * HOUR || (ms >= 24 * HOUR && ms % (24 * HOUR) === 0)) return `${plural(Math.round(ms / (24 * HOUR)), "day")} ago`;
	if (ms >= 2 * HOUR || (ms >= HOUR && ms % HOUR === 0)) return `${plural(Math.round(ms / HOUR), "hour")} ago`;
	return `${plural(Math.round(ms / MINUTE), "minute")} ago`;
}

/** A server of a session's project as the session last heard of it: `SessionServer` without what the user's record adds. */
type MockKnown = Omit<SessionServer, "approval" | "earlier" | "asks">;

interface MockApproval {
	project: string;
	name: string;
	fingerprint: string;
	approvedAt: number;
	expiresAt: number;
}

const APPROVAL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface RunningCall {
	messageId: string;
	callId: string;
	startedAt: number | null;
	progress: string;
}

interface Run {
	turn: number;
	startedAt: number;
	timer: ReturnType<typeof setTimeout> | null;
	stopping: boolean;
	executionId: string | null;
	openStep: string | null;
	steps: number;
	usage: TurnUsage | null;
	text: Map<string, string>;
	calls: Map<string, RunningCall>;
	/** The steps being played and the index of the next one, so that playing can skip ahead. */
	plan: Step[];
	next: number;
	/** Steers enqueued and not yet delivered: their Windlass message IDs. */
	steers: string[];
	/** Calls the user stopped: what the recording still has of them is not played. */
	cancelled: Set<string>;
	/** Set after a call was stopped: what the model says next instead of what the recording says. */
	replaceText: string | null;
}

interface MockSession {
	summary: SessionSummary;
	/** The title was given by hand, so the first prompt does not replace it. */
	titled: boolean;
	windlassSessionId: string | null;
	windlassSeq: number;
	timeline: TimelineItem[];
	pending: LiveDelta[];
	seq: number;
	feeds: Set<SessionFeed>;
	run: Run | null;
	files: Map<string, WorkspaceChange>;
	pauseTimer: ReturnType<typeof setTimeout> | null;
	question: PendingQuestion | null;
	/** Declines the question when nobody answers it. */
	questionTimer: ReturnType<typeof setTimeout> | null;
	/** Carries the turn on once the question is answered. */
	resume: ((choice: string, note: string | null) => void) | null;
	/** A server's question that stepped aside for a tool call's, with what carries on once it is answered. */
	aside: { question: PendingQuestion; resume: (choice: string, note: string | null) => void } | null;
	/** The definitions of project servers started in this session's sandbox: Windlass keeps its own record there, so it starts them again unasked. */
	startedServers: Set<string>;
	/** The project's servers as the session last heard of them, for its panel. */
	servers: MockKnown[];
	/** True once the platform pushed the session's branch. */
	pushed: boolean;
}

interface World {
	profile: UserProfile;
	sessions: Map<string, MockSession>;
	feeds: Set<UserFeed>;
	rotation: number;
	github: GithubConnection | null;
	/** The number the next pull request gets. */
	nextPull: number;
	/** The user's remembered approvals of projects' servers. */
	approvals: MockApproval[];
}

interface Step {
	/** Milliseconds after the previous step. */
	wait: number;
	run: () => void;
	/** The call this step settles (`messageId/callId`), for skipping ahead when it is stopped. */
	settles?: string;
}

export function createMockClient(options: MockOptions = {}): MockClient {
	const pace = options.pace ?? 1;
	const questionTimeout = options.questionTimeoutMs ?? MOCK_QUESTION_TIMEOUT_MS;
	let nextAnswer: "elsewhere" | "error" | null = null;
	let nextGithub: MockGithubFailure | null = null;
	let nextServers: "list" | "approve" | "forget" | null = null;
	/** Until when the calls about a project's servers are slow. */
	let slowServersUntil = 0;
	const serversLatency = (ms: number) => latency(realNow() < slowServersUntil ? 10_000 : ms);
	const githubOn = options.github !== false;
	const realNow = options.now ?? (() => Date.now());
	const origin = options.origin ?? (typeof location === "undefined" ? "http://localhost:5173" : location.origin);
	/** Set while history is being written in the past (the seeded sessions). */
	let clock: number | null = null;
	const now = () => clock ?? realNow();

	const worlds = new Map<string, World>();
	const attempt: { state: string; expiresAt: number } = { state: "", expiresAt: 0 };
	let disposed = false;
	const timers = new Set<ReturnType<typeof setTimeout>>();

	const later = (ms: number, action: () => void): ReturnType<typeof setTimeout> => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (!disposed) action();
		}, ms * pace);
		timers.add(timer);
		return timer;
	};
	const cancel = (timer: ReturnType<typeof setTimeout> | null) => {
		if (timer === null) return;
		clearTimeout(timer);
		timers.delete(timer);
	};
	/** The time a request takes. */
	const latency = (ms = 140) => new Promise<void>((resolve) => later(ms, resolve));

	// ---- identity -------------------------------------------------------------------------------

	const tokenFor = (profile: UserProfile) => `mock:${profile.demo ? "demo" : "chatgpt"}:${profile.uid}:${profile.email ?? ""}`;

	function worldOf(auth: AuthResult): World {
		const [scheme, kind, uid, email] = auth.token.split(":");
		if (scheme !== "mock" || !uid || uid !== auth.profile.uid || (kind !== "demo" && kind !== "chatgpt")) {
			throw new PlatformError("unauthorized", "This sign-in is no longer accepted. Sign in again.");
		}
		let world = worlds.get(uid);
		if (!world) {
			world = { profile: { uid, email: email || null, demo: kind === "demo" }, sessions: new Map(), feeds: new Set(), rotation: 0, github: null, nextPull: 41, approvals: [] };
			// Whoever signed in with ChatGPT starts connected; the demo user connects by hand. A choice made since is kept.
			const kept = recall(`wlp.mock.github.${uid}`);
			if (githubOn && (kept === "1" || (kept === null && kind === "chatgpt"))) world.github = connectionFor(world.profile);
			worlds.set(uid, world);
			seed(world);
		}
		return world;
	}

	// ---- GitHub ---------------------------------------------------------------------------------

	/** What survives the reload of going to GitHub and back: nothing else of the mock does. */
	function recall(key: string): string | null {
		try {
			return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	function keep(key: string, value: string): void {
		try {
			if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
		} catch {
			// Storage is unavailable: the connection lasts until the page is reloaded.
		}
	}

	function connectionFor(profile: UserProfile): GithubConnection {
		const login = profile.email?.split("@")[0] || "ada";
		return { login, accounts: GITHUB_ACCOUNTS.map((account) => (account.kind === "user" ? { ...account, login } : account)), connectedAt: now() - 9 * 24 * HOUR };
	}

	function requireGithub(world: World): GithubConnection {
		if (!githubOn) throw new PlatformError("user", "This deployment has no GitHub App, so GitHub cannot be connected here.", { reason: "github_off" });
		if (!world.github) throw new PlatformError("user", "GitHub is not connected. Connect GitHub first.", { reason: "github_not_connected" });
		return world.github;
	}

	const describeRepository = ({ pushedHoursAgo, branches: _branches, ...repository }: MockRepository): GithubRepository => ({ ...repository, pushedAt: now() - pushedHoursAgo * HOUR });

	const branchFor = (session: MockSession) => {
		const words = session.summary.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
		return `windlass/${words || "agent"}-${session.summary.id.replace(/[^A-Za-z0-9]/g, "").slice(-6)}`;
	};

	function publishStateOf(session: MockSession): PublishState {
		const repository = session.summary.repository ?? null;
		if (!repository) return { repository: null, pullRequest: null, branch: "", changes: null, draft: { title: "", body: "" }, blocked: null };
		const status = session.summary.status;
		const answer = [...session.timeline].reverse().find((item) => item.kind === "windlass" && item.event.type === "text.ended");
		const said = answer?.kind === "windlass" ? String((answer.event.data ?? {}).text ?? "").trim() : "";
		const prompt = [...session.timeline].reverse().find((item) => item.kind === "user" && !item.steer);
		const files = [...session.files.keys()].sort();
		const body = said !== "" ? (said.length > 600 ? `${said.slice(0, 600).trim()}…` : said) : files.length > 0 ? `Changed files:\n${files.map((path) => `- ${path}`).join("\n")}` : "";
		const title = session.pushed && prompt?.kind === "user" ? openingWords(prompt.text) : session.summary.title;
		return {
			repository,
			pullRequest: session.summary.pullRequest ?? null,
			branch: session.summary.pullRequest?.branch ?? branchFor(session),
			changes: status !== "idle" || session.summary.sandbox === "none" ? null : session.files.size > 0,
			draft: { title: title.replace(/…$/, ""), body },
			blocked: !githubOn
				? "This deployment has no GitHub App any more, so the platform cannot push."
				: status !== "idle"
					? "Wait for the turn to end: the platform does not push while the agent is working."
					: session.summary.sandbox === "none"
						? "The sandbox is created on the first prompt. Until then there is nothing to push."
						: null,
		};
	}

	// ---- sessions -------------------------------------------------------------------------------

	const profileOf = (session: MockSession): SandboxProfile => MOCK_PROFILES.find((profile) => profile.id === session.summary.profile) ?? (MOCK_PROFILES[0] as SandboxProfile);

	const listOf = (world: World): SessionSummary[] => [...world.sessions.values()].map((session) => session.summary).sort((a, b) => b.createdAt - a.createdAt);

	function setSummary(world: World, session: MockSession, patch: Partial<SessionSummary>): void {
		session.summary = { ...session.summary, ...patch };
		for (const feed of session.feeds) feed.onSummary(session.summary);
		const list = listOf(world);
		for (const feed of world.feeds) feed.onSessions(list);
	}

	function addSession(world: World, input: { id: string; title: string; titled: boolean; profile: SessionSummary["profile"]; model: string; repoUrl: string | null; repository?: SessionRepository | null }): MockSession {
		const at = now();
		const repository = input.repository ?? null;
		const session: MockSession = {
			summary: {
				id: input.id,
				title: input.title,
				profile: input.profile,
				model: input.model,
				repoUrl: repository ? `${repository.url}.git` : input.repoUrl,
				...(repository ? { repository, pullRequest: null } : {}),
				createdAt: at,
				updatedAt: at,
				status: "idle",
				turns: 0,
				lastOutcome: null,
				sandbox: "none",
			},
			titled: input.titled,
			windlassSessionId: null,
			windlassSeq: 0,
			timeline: [],
			pending: [],
			seq: 0,
			feeds: new Set(),
			run: null,
			files: new Map(),
			pauseTimer: null,
			question: null,
			questionTimer: null,
			resume: null,
			aside: null,
			startedServers: new Set(),
			servers: [],
			pushed: false,
		};
		world.sessions.set(input.id, session);
		return session;
	}

	function store(session: MockSession, item: DistributiveOmit<TimelineItem, "seq" | "at">): void {
		const stored = { ...item, seq: ++session.seq, at: now() } as TimelineItem;
		session.timeline.push(stored);
		for (const feed of session.feeds) feed.onItem(stored);
	}

	/** One event of `windlass --json`, stored or broadcast as contract.ts says. */
	function emit(session: MockSession, turn: number, event: WindlassEvent): void {
		track(session, event);
		if (isLive(event)) {
			const delta: LiveDelta = { turn, event };
			session.pending.push(delta);
			for (const feed of session.feeds) feed.onDelta(delta);
			return;
		}
		// `pending` is the streaming output since the last durable event.
		if (isDurable(event)) session.pending = [];
		store(session, { turn, kind: "windlass", event });
	}

	function track(session: MockSession, event: WindlassEvent): void {
		const state = session.run;
		if (!state) return;
		const data = (event.data ?? event) as Record<string, unknown>;
		const messageId = typeof data.messageId === "string" ? data.messageId : "";
		const key = `${messageId}/${typeof data.callId === "string" ? data.callId : ""}`;
		switch (event.type) {
			case "execution.started":
				state.executionId = String(data.executionId);
				break;
			case "step.started":
				state.openStep = messageId;
				state.steps += 1;
				break;
			case "step.ended":
			case "step.failed": {
				state.openStep = null;
				const usage = data.usage as TurnUsage | null;
				if (usage) state.usage = addUsage(state.usage, usage);
				break;
			}
			case "text.delta":
				state.text.set(messageId, (state.text.get(messageId) ?? "") + String(data.text));
				break;
			case "text.ended":
				state.text.delete(messageId);
				break;
			case "tool.called":
				state.calls.set(key, { messageId, callId: String(data.callId), startedAt: null, progress: "" });
				break;
			case "tool.started": {
				const call = state.calls.get(key);
				if (call) call.startedAt = now();
				break;
			}
			case "tool.progress": {
				const call = state.calls.get(key);
				if (call) call.progress = String(data.text);
				break;
			}
			case "tool.settled":
				state.calls.delete(key);
				break;
		}
	}

	/** A recorded event as this session's Windlass would have written it now. */
	function restamp(session: MockSession, turn: number, event: WindlassEvent, prompt: string): WindlassEvent {
		const copy = structuredClone(event);
		copy.sessionId = session.windlassSessionId ?? undefined;
		const data = (copy.data ?? copy) as Record<string, unknown>;
		if (typeof data.messageId === "string") data.messageId = stampId(turn, data.messageId);
		if (isDurable(copy)) {
			copy.seq = ++session.windlassSeq;
			copy.time = now();
		}
		if (copy.type === "inbox.enqueued" && data.origin === null) data.content = [{ type: "text", text: prompt }];
		if (copy.type === "step.started") data.model = session.summary.model;
		return copy;
	}

	/** Everything a turn does, as timed steps. The same plan is run at once for history and on timers for a live turn. */
	function plan(world: World, session: MockSession, input: PromptInput, script: Script): Step[] {
		const turn = session.summary.turns + 1;
		const steps: Step[] = [];
		const first = session.windlassSessionId === null;

		steps.push({
			wait: 0,
			run: () => {
				const model = input.model ?? session.summary.model;
				session.run = { turn, startedAt: now(), timer: null, stopping: false, executionId: null, openStep: null, steps: 0, usage: null, text: new Map(), calls: new Map(), plan: [], next: 0, steers: [], cancelled: new Set(), replaceText: null };
				cancel(session.pauseTimer);
				session.pauseTimer = null;
				store(session, { turn, kind: "user", text: input.text, model, effort: input.effort ?? null });
				const title = !session.titled && session.summary.turns === 0 ? openingWords(input.text) : session.summary.title;
				setSummary(world, session, { status: "starting", model, title, updatedAt: now() });
			},
		});
		if (session.summary.sandbox === "none") {
			steps.push({ wait: 350, run: () => store(session, { turn, kind: "platform", level: "info", text: `Creating sandbox: ${profileOf(session).name}` }) });
			if (session.summary.repoUrl !== null) {
				const repoUrl = session.summary.repoUrl;
				const picked = session.summary.repository;
				const what = picked ? `${picked.owner}/${picked.name} at ${picked.branch}` : repoUrl;
				steps.push({ wait: 900, run: () => store(session, { turn, kind: "platform", level: "info", text: `Cloning ${what}` }) });
			}
		} else if (session.summary.sandbox === "paused") {
			steps.push({ wait: 350, run: () => store(session, { turn, kind: "platform", level: "info", text: "Resuming the paused sandbox" }) });
		}
		steps.push({
			wait: 700,
			run: () => {
				if (first && script.platformFailure === undefined) session.windlassSessionId = `ses_${hex(24)}`;
				setSummary(world, session, { status: "running", sandbox: "running" });
			},
		});

		if (script.platformFailure !== undefined) {
			const message = script.platformFailure;
			steps.push({ wait: 2600, run: () => store(session, { turn, kind: "platform", level: "error", text: "The sandbox stopped answering." }) });
			steps.push({ wait: 400, run: () => finish(world, session, { outcome: "error", exitCode: null, steps: null, usage: null, cachedShare: null, message }) });
			return steps;
		}

		// Windlass writes `session.created` and freezes its prompt once per session, not once per run.
		const events = script.events.filter((event) => first || (event.type !== "session.created" && event.type !== "baseline.set"));
		const server = script.server;
		if (server && !server.late) {
			// What waits is asked about before Windlass gets the prompt: the turn's events follow the answer.
			steps.push({ wait: 500, run: () => askServer(world, session, turn, server, true, () => play(session, eventSteps(world, session, turn, events, input, script))) });
			return steps;
		}
		steps.push(...eventSteps(world, session, turn, events, input, script));
		return steps;
	}

	/** Recorded events as timed steps: emitted as they are, with the turn's end and its question. */
	function eventSteps(world: World, session: MockSession, turn: number, events: WindlassEvent[], input: PromptInput, script: Script): Step[] {
		const stretch = script.stretch ?? 1;
		const offsets = schedule(events);
		return events.map((event, index): Step => {
			const wait = ((offsets[index] ?? 0) - (offsets[index - 1] ?? 0)) * stretch;
			const data = (event.data ?? event) as Record<string, unknown>;
			const key = `${stampId(turn, String(data.messageId))}/${String(data.callId)}`;
			if (event.type === "cli.summary") {
				return {
					wait,
					run: () => {
						emit(session, turn, restamp(session, turn, event, input.text));
						const ended = turnEnded(event, { seq: 0, at: 0, turn });
						for (const [path, change] of Object.entries(script.workspace ?? {})) session.files.set(path, change);
						finish(world, session, { outcome: ended.outcome, exitCode: ended.exitCode, steps: ended.steps, usage: ended.usage, cachedShare: ended.cachedShare, message: null, durationMs: clock === null ? undefined : ended.durationMs });
					},
				};
			}
			if (event.type === "approval.requested" && script.question) {
				const rest = script.question;
				return {
					wait,
					run: () => {
						const stamped = restamp(session, turn, event, input.text);
						emit(session, turn, stamped);
						ask(world, session, turn, stamped, input, script, rest);
					},
				};
			}
			return {
				wait,
				settles: event.type === "tool.settled" ? key : undefined,
				run: () => {
					const state = session.run;
					// What the recording still has of a call the user stopped did not happen.
					if (state?.cancelled.has(key) && (event.type === "tool.progress" || event.type === "tool.settled")) return;
					// Steered messages reach the model where a step begins.
					if (event.type === "step.started") deliverSteers(session, turn);
					// A server Windlass reports while the turn runs: its question does not hold the turn.
					if (event.type === "step.started" && script.server?.late && state?.steps === 0) askServer(world, session, turn, script.server, false, null);
					if (state?.replaceText != null && event.type === "text.delta") return;
					const stamped = restamp(session, turn, event, input.text);
					if (state?.replaceText != null && event.type === "text.ended") {
						(stamped.data as Record<string, unknown>).text = state.replaceText;
						state.replaceText = null;
					}
					emit(session, turn, stamped);
				},
			};
		});
	}

	/** A Windlass event written now, by this session's Windlass. */
	function windlassEvent(session: MockSession, type: string, data: Record<string, unknown>): WindlassEvent {
		return { type, v: 1, data, sessionId: session.windlassSessionId ?? undefined, seq: ++session.windlassSeq, time: now() };
	}

	function deliverSteers(session: MockSession, turn: number): void {
		const state = session.run;
		if (!state) return;
		for (const messageId of state.steers.splice(0)) emit(session, turn, windlassEvent(session, "inbox.delivered", { messageId }));
	}

	function broadcastQuestion(session: MockSession): void {
		for (const feed of session.feeds) feed.onQuestion(session.question);
	}

	// ---- a project's MCP servers ------------------------------------------------------------------

	/** The user's approval of exactly this definition for the session's project, when one is remembered and has not run out. */
	function approvalOf(world: World, session: MockSession, name: string, fingerprint: string | null): MockApproval | null {
		const project = mockProject(session.summary).key;
		return world.approvals.find((approval) => approval.project === project && approval.name === name && approval.fingerprint === fingerprint && approval.expiresAt > now()) ?? null;
	}

	/** Tells the session's clients that what it knows of its project's servers, or of their approvals, changed. */
	function serversChanged(world: World, session: MockSession): void {
		const changedAt = Math.max(now(), (session.summary.servers?.changedAt ?? 0) + 1);
		setSummary(world, session, { servers: session.servers.length === 0 ? undefined : { count: session.servers.length, changedAt } });
	}

	/** Keeps what Windlass says of one server of the project. */
	function know(world: World, session: MockSession, server: MockKnown): void {
		const at = session.servers.findIndex((known) => known.name === server.name);
		if (at >= 0) session.servers[at] = server;
		else session.servers.push(server);
		serversChanged(world, session);
	}

	/** What Windlass makes of a definition it may start. */
	function startedAs(server: MockServer): MockKnown {
		const failed = server.unset.length > 0;
		return {
			name: server.name,
			subject: commandLine(server.argv),
			remote: false,
			file: SERVER_FILE,
			state: failed ? "failed" : "running",
			tools: failed ? null : 2,
			reason: failed ? `the environment variable ${server.unset[0]} named in its env is not set` : null,
			fingerprint: server.fingerprint,
			at: now(),
		};
	}

	function remember(world: World, session: MockSession, name: string, fingerprint: string): void {
		const project = mockProject(session.summary).key;
		world.approvals = world.approvals.filter((approval) => !(approval.project === project && approval.name === name && approval.fingerprint === fingerprint));
		world.approvals.push({ project, name, fingerprint, approvedAt: now(), expiresAt: now() + APPROVAL_MS });
	}

	/** The session's servers as its panel shows them (the server's `serversView`). */
	function serversOf(world: World, session: MockSession): SessionServers {
		const project = mockProject(session.summary);
		const mine = world.approvals.filter((approval) => approval.project === project.key && approval.expiresAt > now()).sort((a, b) => b.approvedAt - a.approvedAt);
		const times = (approval: MockApproval | null) => (approval === null ? null : { approvedAt: approval.approvedAt, expiresAt: approval.expiresAt });
		return {
			project: { kind: project.kind, label: project.label },
			servers: session.servers.map((server) => {
				const named = mine.filter((approval) => approval.name === server.name);
				const approval = (server.fingerprint === null ? named[0] : named.find((one) => one.fingerprint === server.fingerprint)) ?? null;
				const earlier = approval === null ? (named[0] ?? null) : null;
				const waits = server.state === "waiting" && server.fingerprint !== null && approval === null;
				return { ...server, approval: times(approval), ...(earlier === null ? {} : { earlier: times(earlier) }), ...(waits ? { asks: mockPanelWords(server, profileOf(session), world.profile.demo, project) } : {}) };
			}),
			forgetting: MOCK_FORGETTING,
		};
	}

	/**
	 * Puts the question about a project's server, unless Windlass's own record in this session's sandbox
	 * starts it, or the user's approval of exactly this definition is remembered for the project: then
	 * it starts without the question, and the line says why. `carryOn` plays the turn once it is settled,
	 * for a question put before the turn's events; a question put while the turn runs has none.
	 */
	function askServer(world: World, session: MockSession, turn: number, server: MockServer, holdsTurn: boolean, carryOn: (() => void) | null): void {
		const named = `the MCP server "${server.name}"`;
		const agentHas = holdsTurn ? "The agent has them from this turn on." : "The turn was already running: the agent is told of them at its next step.";
		if (session.startedServers.has(server.fingerprint)) {
			know(world, session, startedAs(server));
			carryOn?.();
			return;
		}
		const remembered = approvalOf(world, session, server.name, server.fingerprint);
		if (remembered) {
			session.startedServers.add(server.fingerprint);
			const ago = agoWords(now() - remembered.approvedAt);
			if (server.unset.length > 0) {
				store(session, { turn, kind: "platform", level: "warn", text: `You approved ${named} for this project ${ago}, but it did not start: the environment variable ${server.unset[0]} named in its env is not set. The platform cannot set variables for a session yet.` });
			} else {
				store(session, { turn, kind: "platform", level: "info", text: `Started ${named} because you approved it for this project ${ago}: 2 tools. ${agentHas}` });
			}
			know(world, session, startedAs(server));
			carryOn?.();
			return;
		}
		know(world, session, { ...startedAs(server), state: "waiting", tools: null, reason: null });
		const askedAt = now();
		const question: PendingQuestion = {
			id: `q_${hex(16)}`,
			turn,
			messageId: "",
			callId: "",
			...mockServerQuestion(server, profileOf(session), world.profile.demo, mockProject(session.summary)),
			subagent: null,
			askedAt,
			expiresAt: askedAt + questionTimeout,
			server: { name: server.name, file: SERVER_FILE, remote: false, unset: server.unset, holdsTurn },
		};
		const resume = (choice: string): void => {
			if (choice === "start") {
				session.startedServers.add(server.fingerprint);
				remember(world, session, server.name, server.fingerprint);
				if (server.unset.length > 0) {
					store(session, { turn, kind: "platform", level: "warn", text: `Approved ${named} for this project, but it did not start: the environment variable ${server.unset[0]} named in its env is not set. The platform cannot set variables for a session yet.` });
				} else {
					store(session, { turn, kind: "platform", level: "info", text: `Started ${named} for this project: 2 tools. ${agentHas}` });
				}
				know(world, session, startedAs(server));
			} else if (choice === "not_now") {
				store(session, { turn, kind: "platform", level: "info", text: `Left ${named} stopped. If the agent tries to use it, it is told that the server waits for you; your next message asks again.` });
			}
			carryOn?.();
		};
		putServer(world, session, question, resume);
	}

	/** Shows a server's question, the first time and again after it stood aside, with a new time to answer in. */
	function putServer(world: World, session: MockSession, question: PendingQuestion, resume: (choice: string, note: string | null) => void): void {
		const shownAt = now();
		session.question = { ...question, expiresAt: shownAt + questionTimeout };
		session.resume = resume;
		broadcastQuestion(session);
		if (question.server?.holdsTurn) setSummary(world, session, { status: "waiting", updatedAt: now() });
		session.questionTimer = later(Math.max(0, shownAt + questionTimeout - realNow()), () => {
			if (session.question?.id !== question.id) return;
			store(session, { turn: question.turn, kind: "platform", level: "warn", text: `Nobody answered about the MCP server "${question.server?.name ?? ""}" within ${minutes(questionTimeout)}, so it stays stopped. Your next message asks again.` });
			settle(world, session, "expired", null);
		});
	}

	/** The turn reached its question: it waits for an answer, or for the platform to decline. */
	function ask(world: World, session: MockSession, turn: number, requested: WindlassEvent, input: PromptInput, script: Script, rest: QuestionScript): void {
		// A tool call's question comes first: a server's steps aside and is put again after it.
		if (session.question?.server && session.resume) {
			session.aside = { question: session.question, resume: session.resume };
			cancel(session.questionTimer);
			session.questionTimer = null;
			session.question = null;
			session.resume = null;
		}
		const data = (requested.data ?? {}) as Record<string, unknown>;
		const asked = (data.question ?? {}) as { title?: string; subject?: string; details?: string[]; choices?: Array<{ id: string; label: string; approve: boolean; remembers: string | null; grants?: unknown[] }> };
		const choices = asked.choices ?? [];
		const askedAt = now();
		session.question = {
			id: `q_${hex(16)}`,
			turn,
			messageId: String(data.messageId),
			callId: String(data.callId),
			title: asked.title ?? "",
			subject: asked.subject ?? "",
			details: asked.details ?? [],
			choices: choices.map(({ id, label, approve, remembers }) => ({ id, label, approve, remembers })),
			subagent: rest.subagent ?? null,
			askedAt,
			expiresAt: askedAt + questionTimeout,
		};
		broadcastQuestion(session);
		setSummary(world, session, { status: "waiting", updatedAt: now() });

		session.resume = (choiceId, note) => {
			const choice = choices.find((candidate) => candidate.id === choiceId);
			const approve = choice?.approve === true;
			const events = (approve ? rest.approved : rest.declined).map((event) => {
				if (event.type === "approval.answered") return { ...event, data: { ...event.data, choice: choiceId, approve, note, grants: (choice?.grants ?? []).map((grant) => ({ ...(grant as object), seq: session.windlassSeq + 1 })) } };
				if (event.type === "tool.settled" && !approve && event.data?.messageId === data.messageId && event.data?.callId === data.callId) {
					const output = note === null ? "Not run: the user declined this call." : `Not run: the user declined this call. Their note: ${note}`;
					return { ...event, data: { ...event.data, output } };
				}
				return event;
			});
			play(session, eventSteps(world, session, turn, events, input, script));
		};
		// History is written in the past; the timer is real time from now.
		session.questionTimer = later(Math.max(0, askedAt + questionTimeout - realNow()), () => {
			const question = session.question;
			if (!question) return;
			store(session, {
				turn,
				kind: "platform",
				level: "warn",
				text: `Nobody answered within ${minutes(questionTimeout)}, so the platform declined the call.`,
				code: "question_expired",
				call: { messageId: question.messageId, callId: question.callId },
			});
			settle(world, session, question.choices.find((choice) => !choice.approve)?.id ?? "deny", null);
		});
	}

	/** The question is answered: it goes, and the turn carries on. */
	function settle(world: World, session: MockSession, choice: string, note: string | null): void {
		const resume = session.resume;
		withdraw(session);
		if (!resume || !session.run) return;
		setSummary(world, session, { status: "running", updatedAt: now() });
		resume(choice, note);
		const aside = session.aside;
		if (aside && session.run && session.question === null) {
			session.aside = null;
			putServer(world, session, aside.question, aside.resume);
		}
	}

	/** The question goes without an answer (or before its answer is played). */
	function withdraw(session: MockSession): void {
		cancel(session.questionTimer);
		session.questionTimer = null;
		session.resume = null;
		if (session.question === null) return;
		session.question = null;
		broadcastQuestion(session);
	}

	function finish(
		world: World,
		session: MockSession,
		end: { outcome: TurnOutcome; exitCode: number | null; steps: number | null; usage: TurnUsage | null; cachedShare: number | null; message: string | null; durationMs?: number },
	): void {
		const state = session.run;
		if (!state) return;
		// A server's question put while the turn ran goes with the turn; a turn that was stopped took it away without a word.
		const unanswered = session.question?.server ?? session.aside?.question.server;
		if (unanswered) store(session, { turn: state.turn, kind: "platform", level: "info", text: `The turn ended before anyone answered about the MCP server "${unanswered.name}". Your next message asks again.` });
		session.aside = null;
		withdraw(session);
		session.run = null;
		session.pending = [];
		store(session, {
			turn: state.turn,
			kind: "turn.ended",
			outcome: end.outcome,
			exitCode: end.exitCode,
			steps: end.steps,
			durationMs: end.durationMs ?? now() - state.startedAt,
			usage: end.usage,
			cachedShare: end.cachedShare,
			message: end.message,
		});
		setSummary(world, session, { status: "idle", turns: state.turn, lastOutcome: end.outcome, updatedAt: now() });
		// An idle sandbox is suspended after a while, and the timeline says so as the server's does; its files stay.
		if (clock === null) {
			session.pauseTimer = later(2 * MINUTE, () => {
				if (session.run !== null || session.summary.sandbox !== "running") return;
				store(session, { turn: state.turn, kind: "platform", level: "info", text: "Suspended the sandbox after 2 minutes without use; the next prompt resumes it." });
				setSummary(world, session, { sandbox: "paused" });
			});
		}
	}

	function play(session: MockSession, steps: Step[], index = 0): void {
		const state = session.run;
		const step = steps[index];
		if (!step || (index > 0 && (!state || state.stopping))) return;
		const proceed = () => {
			step.run();
			if (session.run) {
				session.run.plan = steps;
				session.run.next = index + 1;
			}
			play(session, steps, index + 1);
		};
		if (index === 0) proceed();
		else if (session.run) session.run.timer = later(step.wait, proceed);
	}

	/** Runs a whole turn at once, as history that began at `at`. */
	function playInstantly(steps: Step[], at: number): void {
		let time = at;
		for (const step of steps) {
			time += step.wait;
			clock = time;
			step.run();
		}
		clock = null;
	}

	/** Winds a running turn down the way Windlass does when the user stops it. */
	function interrupt(world: World, session: MockSession): void {
		const state = session.run;
		if (!state || state.stopping) return;
		state.stopping = true;
		cancel(state.timer);
		// A question still waiting is withdrawn: nobody can answer it any more.
		session.aside = null;
		withdraw(session);
		setSummary(world, session, { status: "stopping" });
		const turn = state.turn;
		const windlass = (type: string, data: Record<string, unknown>): WindlassEvent => windlassEvent(session, type, data);

		if (state.executionId === null) {
			// Windlass had not started: there is nothing of its own to wind down.
			state.timer = later(300, () => {
				store(session, { turn, kind: "platform", level: "info", text: "Stopped before Windlass started." });
				finish(world, session, { outcome: "interrupted", exitCode: null, steps: null, usage: null, cachedShare: null, message: null });
			});
			return;
		}

		const executionId = state.executionId;
		const steps: Step[] = [{ wait: 120, run: () => emit(session, turn, windlass("execution.interrupt_requested", { executionId, reason: "user" })) }];
		// The visible part of an unfinished answer is kept.
		for (const [messageId, text] of state.text) steps.push({ wait: 40, run: () => emit(session, turn, windlass("text.ended", { messageId, text, providerData: null })) });
		for (const call of state.calls.values()) {
			steps.push({
				wait: 380,
				run: () => {
					const seconds = call.startedAt === null ? 0 : Math.max(1, Math.round((now() - call.startedAt) / 1000));
					const output = call.startedAt === null ? "Not run: the user stopped the response before this call started." : `Stopped by the user after ${seconds} s. Output so far:\n${call.progress}`;
					emit(session, turn, windlass("tool.settled", { messageId: call.messageId, callId: call.callId, outcome: call.startedAt === null ? "not_started" : "error", output, truncation: null, attachments: [], display: null }));
				},
			});
		}
		if (state.openStep !== null) {
			const messageId = state.openStep;
			steps.push({ wait: 40, run: () => emit(session, turn, windlass("step.failed", { messageId, error: { kind: "interrupted", reason: "user" }, usage: null })) });
		}
		steps.push({
			wait: 40,
			run: () => emit(session, turn, windlass("synthetic.appended", { messageId: `msg_t${turn}_s1`, origin: "interrupt", content: [{ type: "text", text: "The user stopped the previous response before it finished." }] })),
		});
		steps.push({ wait: 40, run: () => emit(session, turn, windlass("execution.interrupted", { executionId, reason: "user" })) });
		steps.push({
			wait: 60,
			run: () => {
				const usage = state.usage;
				const cachedShare = usage && usage.inputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 1000) / 1000 : null;
				emit(session, turn, { type: "cli.summary", sessionId: session.windlassSessionId ?? undefined, executionId, outcome: "interrupted", steps: state.steps, summaryCalls: 0, requests: state.steps, durationMs: now() - state.startedAt, usage, cachedShare });
				finish(world, session, { outcome: "interrupted", exitCode: 130, steps: state.steps, usage, cachedShare, message: null });
			},
		});
		const runNext = (index: number) => {
			const step = steps[index];
			if (!step) return;
			state.timer = later(step.wait, () => {
				step.run();
				runNext(index + 1);
			});
		};
		runNext(0);
	}

	/** Stops one running call the way Windlass does: the request, then the call settles, and the turn goes on. */
	function stopOneCall(session: MockSession, messageId: string, callId: string): { stopped: boolean; message: string | null } {
		const state = session.run;
		if (!state || state.stopping) throw new PlatformError("user", "No turn is running.");
		const key = `${messageId}/${callId}`;
		const call = state.calls.get(key);
		if (!call) return { stopped: false, message: "That call is no longer running." };
		if (call.startedAt === null) return { stopped: false, message: "That call has not started, so there is nothing to stop yet." };
		if (state.cancelled.has(key)) return { stopped: false, message: "This call is already being stopped." };
		state.cancelled.add(key);
		const turn = state.turn;
		cancel(state.timer);
		emit(session, turn, windlassEvent(session, "tool.cancel_requested", { messageId, callId }));
		const startedAt = call.startedAt;
		state.timer = later(450, () => {
			if (session.run !== state || state.stopping) return;
			const seconds = Math.max(1, Math.round((now() - startedAt) / 1000));
			const output = `${call.progress === "" ? "" : `${call.progress}\n`}[Stopped by the user after ${seconds} s]`;
			emit(session, turn, windlassEvent(session, "tool.settled", { messageId, callId, outcome: "error", output, truncation: null, attachments: [], display: { exitCode: null, signal: "SIGTERM", timedOut: false, interrupted: "user", durationMs: now() - startedAt } }));
			state.replaceText = "You stopped that command before it finished, so I don't have its result. Tell me if you want me to run it again or try something else.";
			// Skip what the recording still had of the call.
			const settledAt = state.plan.findIndex((step, index) => index >= state.next && step.settles === key);
			play(session, state.plan, settledAt >= 0 ? settledAt + 1 : state.next);
		});
		return { stopped: true, message: null };
	}

	// ---- the seeded sessions --------------------------------------------------------------------

	function seed(world: World): void {
		const start = realNow();
		const history = (
			id: string,
			title: string,
			profile: SessionSummary["profile"],
			ago: number,
			turns: Array<{ text: string; script: ScriptName; effort?: string }>,
			extra: { repoUrl?: string; sandbox?: SessionSummary["sandbox"]; model?: string; repository?: SessionRepository; pull?: Pick<PullRequestInfo, "number" | "state"> & { hoursAgo: number; clean?: boolean } } = {},
		): MockSession => {
			clock = start - ago;
			const session = addSession(world, { id, title, titled: true, profile, model: extra.model ?? (MODELS[0] as string), repoUrl: extra.repoUrl ?? null, repository: githubOn ? extra.repository : undefined });
			let at = start - ago;
			for (const turn of turns) {
				const steps = plan(world, session, { text: turn.text, effort: turn.effort }, SCRIPTS[turn.script]);
				playInstantly(steps, at);
				at = (session.timeline.at(-1)?.at ?? at) + 40_000;
			}
			clock = null;
			if (session.pauseTimer !== null) cancel(session.pauseTimer);
			session.summary = { ...session.summary, sandbox: extra.sandbox ?? (turns.length === 0 ? "none" : "paused") };
			const repository = session.summary.repository;
			if (repository && extra.pull) {
				// Pushed earlier: the pull request is there, and what was pushed then no longer differs from the last commit.
				const branch = branchFor(session);
				const pushedAt = start - extra.pull.hoursAgo * HOUR;
				session.pushed = true;
				session.summary = { ...session.summary, pullRequest: { number: extra.pull.number, url: `${repository.url}/pull/${extra.pull.number}`, state: extra.pull.state, title, branch, base: repository.branch, pushedAt } };
				if (extra.pull.clean) session.files.clear();
				session.timeline.push({ seq: ++session.seq, at: pushedAt, turn: session.summary.turns, kind: "platform", level: "info", text: `Opened pull request #${extra.pull.number} in ${repository.owner}/${repository.name} from ${branch}, with 1 file.` });
			}
			return session;
		};

		history("scratch", "New agent", "docker-windlass-sandbox", 5 * 24 * HOUR, []).titled = false;
		history("deps", "Upgrade the dependencies", "docker-hardened", 3 * 24 * HOUR, [{ text: "Upgrade the dependencies to their latest minor versions and crash if anything breaks.", script: "crash" }], { sandbox: "none", repoUrl: "https://github.com/acme/harbor.git" });
		history("suite", "Run the whole test suite", "docker-windlass-sandbox", 2 * 24 * HOUR, [{ text: "Run the whole test suite and fix the failing test.", script: "cancelled", effort: "medium" }]);
		history("changelog", "Tidy the changelog", "docker-windlass-sandbox", 26 * HOUR, [{ text: "Tidy the changelog for the release.", script: "usageLimit" }], { model: MODELS[1], repository: sessionRepository("acme", "lighthouse-docs"), pull: { number: 7, state: "merged", hoursAgo: 25, clean: true } });
		history("checks", "Make add() pass its checks", "docker-windlass-sandbox", 21 * HOUR, [{ text: "Fix the failing test.", script: "checks", effort: "high" }], { repository: sessionRepository("acme", "harbor", "release/2.4"), pull: { number: 38, state: "open", hoursAgo: 20 } });
		history("unattended", "Run a command with nobody to approve it", "docker-hardened", 3 * HOUR, [{ text: "check the sandbox", script: "refused" }]);
		history("probe", "Check what the sandbox allows", "docker-windlass-sandbox", 2 * HOUR, [{ text: "check the sandbox", script: "sandboxed" }]);
		history(
			"add-test",
			"Fix the failing add test",
			"docker-windlass-sandbox",
			38 * MINUTE,
			[
				{ text: "The add test is failing. Find out why and fix it.", script: "fix", effort: "low" },
				{ text: "What is 1 + 1, to be sure?", script: "answer" },
			],
			{ sandbox: "running", repository: sessionRepository("ada", "tide-tables") },
		);

		// One agent waits on a question when the user arrives: it asked half a minute ago.
		const asking = history("headers", "Check the site's response headers", "docker-windlass-sandbox", 14 * MINUTE, [{ text: "What is 1 + 1, to be sure?", script: "answer" }], { sandbox: "running" });
		playInstantly(plan(world, asking, { text: "Fetch the response headers of example.com and tell me what server it runs.", effort: "low" }, SCRIPTS.network), start - 30_000);
		clock = null;

		// One agent is at work when the user arrives: a second turn, a long build, played slowly.
		const building = history("harbor-build", "Check the release build", "docker-windlass-sandbox", 6 * MINUTE, [{ text: "Fix the failing test.", script: "steps" }], { sandbox: "running", repoUrl: "https://github.com/acme/harbor.git", repository: sessionRepository("acme", "harbor") });
		play(building, plan(world, building, { text: "Run the full build and the tests, and tell me if they pass.", effort: "medium" }, { ...SCRIPTS.build, stretch: 7 }));

		// acme/harbor names MCP servers. The user approved "harbor" three days ago in one session, so the other
		// started it unasked; "docs" was left for later, and "tracker" was approved and could not start.
		const checks = world.sessions.get("checks");
		if (checks) {
			const project = mockProject(checks.summary).key;
			const approvedAt = start - 3 * 24 * HOUR - 40 * MINUTE;
			const harbor: MockKnown = { name: "harbor", subject: "python3 tools/harbor_mcp.py", remote: false, file: SERVER_FILE, state: "running", tools: 2, reason: null, fingerprint: "81498df752b8ef7d", at: start - 21 * HOUR };
			world.approvals.push({ project, name: "harbor", fingerprint: "81498df752b8ef7d", approvedAt, expiresAt: approvedAt + APPROVAL_MS });
			world.approvals.push({ project, name: "tracker", fingerprint: "c07b1e5a94d3f268", approvedAt: start - 21 * HOUR, expiresAt: start - 21 * HOUR + APPROVAL_MS });
			checks.startedServers.add("81498df752b8ef7d");
			checks.servers = [
				harbor,
				{ name: "docs", subject: "https://docs.acme.example/mcp", remote: true, file: SERVER_FILE, state: "waiting", tools: null, reason: null, fingerprint: "e4d1a80c93f6b275", at: start - 21 * HOUR },
				{
					name: "tracker",
					subject: "npx -y @acme/tracker-mcp --stdio --project 'Harbor 2.4'",
					remote: false,
					file: SERVER_FILE,
					state: "failed",
					tools: null,
					reason: "the environment variable TRACKER_TOKEN named in its env is not set",
					fingerprint: "c07b1e5a94d3f268",
					at: start - 21 * HOUR,
				},
			];
			checks.summary = { ...checks.summary, servers: { count: checks.servers.length, changedAt: start - 21 * HOUR } };
			// Launched on the same repository through the connection: the same project, and so the same approval.
			if (mockProject(building.summary).key === project) {
				building.startedServers.add("81498df752b8ef7d");
				building.servers = [{ ...harbor, at: start - 6 * MINUTE }];
				building.summary = { ...building.summary, servers: { count: 1, changedAt: start - 6 * MINUTE } };
			}
		}
	}

	// ---- the interface --------------------------------------------------------------------------

	function userApi(auth: AuthResult): UserApi {
		const world = () => worldOf(auth);
		return {
			async me() {
				await latency();
				return world().profile;
			},
			async chatgpt(): Promise<ChatgptStatus> {
				await latency(220);
				const { profile } = world();
				return profile.demo ? { connected: false, email: null, accessExpiresAt: null } : { connected: true, email: profile.email, accessExpiresAt: now() + 52 * MINUTE };
			},
			async listSessions() {
				await latency();
				return listOf(world());
			},
			async createSession(input: CreateSessionInput) {
				await latency(260);
				const profile = MOCK_PROFILES.find((candidate) => candidate.id === input.profile);
				if (!profile) throw new PlatformError("user", "There is no such sandbox.");
				if (!profile.available) throw new PlatformError("user", `${profile.name} cannot be used yet. ${profile.unavailableReason ?? ""}`.trim());
				if (input.model !== undefined && !MODELS.includes(input.model)) throw new PlatformError("user", `There is no model called ${input.model}.`);
				const repoUrl = input.repoUrl?.trim() || null;
				if (repoUrl !== null && !/^https:\/\/\S+$/.test(repoUrl)) throw new PlatformError("user", "The repository must be an https address.");
				let repository: SessionRepository | null = null;
				if (input.repository) {
					requireGithub(world());
					const found = GITHUB_REPOSITORIES.find((candidate) => candidate.id === input.repository?.id);
					if (!found) throw new PlatformError("user", "That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again.");
					repository = sessionRepository(found.owner, found.name, input.repository.branch ?? found.defaultBranch);
				}
				const title = input.title?.trim() ?? "";
				if (title.length > MAX_TITLE_CHARS) throw new PlatformError("user", `A title can be at most ${MAX_TITLE_CHARS} characters.`);
				const session = addSession(world(), { id: hex(10), title: title || "New agent", titled: title !== "", profile: profile.id, model: input.model ?? (MODELS[0] as string), repoUrl, repository });
				setSummary(world(), session, {});
				return session.summary;
			},
			async renameSession(id: string, title: string) {
				await latency();
				const session = world().sessions.get(id);
				if (!session) throw new PlatformError("not_found", "That agent no longer exists.");
				const trimmed = title.trim();
				if (trimmed === "") throw new PlatformError("user", "A title cannot be empty.");
				if (trimmed.length > MAX_TITLE_CHARS) throw new PlatformError("user", `A title can be at most ${MAX_TITLE_CHARS} characters.`);
				session.titled = true;
				setSummary(world(), session, { title: trimmed });
				return session.summary;
			},
			async deleteSession(id: string) {
				await latency(300);
				const session = world().sessions.get(id);
				if (!session) return;
				cancel(session.run?.timer ?? null);
				cancel(session.pauseTimer);
				withdraw(session);
				session.run = null;
				world().sessions.delete(id);
				for (const feed of session.feeds) feed.onConnection("failed", new PlatformError("not_found", "This agent was deleted."));
				session.feeds.clear();
				const list = listOf(world());
				for (const feed of world().feeds) feed.onSessions(list);
			},
			async github(): Promise<GithubStatus> {
				await latency(200);
				if (!githubOn) throw new PlatformError("user", "This deployment has no GitHub App, so GitHub cannot be connected here.", { reason: "github_off" });
				return { connection: world().github };
			},
			async githubConnect(page: string): Promise<{ url: string }> {
				await latency(420);
				const { profile } = world();
				if (!githubOn) throw new PlatformError("user", "This deployment has no GitHub App, so GitHub cannot be connected here.", { reason: "github_off" });
				const failing = nextGithub === "connect";
				if (failing) nextGithub = null;
				// Where the real server sends the browser back to once GitHub has answered: the web app, with a ticket.
				const mock = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("mock");
				return { url: `${page}/${mock !== null ? `?mock=${encodeURIComponent(mock)}` : ""}#${failing ? "github-error=denied" : `github=mock.${profile.uid}`}` };
			},
			async githubComplete(ticket: string): Promise<GithubStatus> {
				await latency(380);
				const current = world();
				if (!ticket.startsWith("mock.")) throw new PlatformError("user", "This link to connect GitHub is not valid any more. Connect GitHub again.", { reason: "github_ticket" });
				if (ticket !== `mock.${current.profile.uid}`) throw new PlatformError("user", "This GitHub connection was started from another Windlass account, so it was not added to yours. Connect GitHub again from here.", { reason: "github_ticket" });
				current.github = { ...connectionFor(current.profile), connectedAt: now() };
				keep(`wlp.mock.github.${current.profile.uid}`, "1");
				return { connection: current.github };
			},
			async githubDisconnect(): Promise<GithubStatus> {
				await latency(260);
				const current = world();
				current.github = null;
				keep(`wlp.mock.github.${current.profile.uid}`, "0");
				return { connection: null };
			},
			async githubRepositories(query: string): Promise<GithubRepositoryList> {
				await latency(query === "" ? 420 : 260);
				requireGithub(world());
				if (nextGithub === "list") {
					nextGithub = null;
					throw new PlatformError("user", "GitHub could not be reached. Try again in a moment.", { reason: "github_unreachable" });
				}
				const wanted = query.trim().toLowerCase();
				// As the server orders them: a name that begins with what was typed first, then the most recently pushed.
				const rank = (repository: MockRepository) => (wanted === "" || repository.name.toLowerCase().startsWith(wanted) || `${repository.owner}/${repository.name}`.toLowerCase().startsWith(wanted) ? 0 : 1);
				const matching = GITHUB_REPOSITORIES.filter((repository) => `${repository.owner}/${repository.name}`.toLowerCase().includes(wanted)).sort((a, b) => rank(a) - rank(b) || a.pushedHoursAgo - b.pushedHoursAgo);
				return { repositories: matching.map(describeRepository), more: false };
			},
			async githubBranches(repositoryId: number): Promise<GithubBranchList> {
				await latency(320);
				requireGithub(world());
				const found = GITHUB_REPOSITORIES.find((repository) => repository.id === repositoryId);
				if (!found) throw new PlatformError("user", "That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again.");
				return { branches: found.branches, defaultBranch: found.defaultBranch, more: false };
			},
			watch(feed: UserFeed) {
				let closed = false;
				feed.onConnection?.("connecting");
				later(120, () => {
					if (closed) return;
					try {
						const current = world();
						current.feeds.add(feed);
						feed.onConnection?.("connected");
						feed.onSessions(listOf(current));
					} catch (error) {
						feed.onConnection?.("failed", asPlatformError(error));
					}
				});
				return () => {
					closed = true;
					worlds.get(auth.profile.uid)?.feeds.delete(feed);
				};
			},
		};
	}

	const snapshotOf = (session: MockSession): SessionSnapshot => ({
		summary: session.summary,
		profile: profileOf(session),
		windlassSessionId: session.windlassSessionId,
		timeline: [...session.timeline],
		pending: [...session.pending],
		question: session.question,
	});

	function sessionApi(auth: AuthResult, id: string): SessionApi {
		const find = (): { world: World; session: MockSession } => {
			const world = worldOf(auth);
			const session = world.sessions.get(id);
			if (!session) throw new PlatformError("not_found", "There is no agent at this address.");
			return { world, session };
		};
		return {
			open(feed: SessionFeed) {
				let closed = false;
				feed.onConnection("connecting");
				later(160, () => {
					if (closed) return;
					try {
						const { session } = find();
						session.feeds.add(feed);
						feed.onConnection("connected");
						feed.onSnapshot(snapshotOf(session));
					} catch (error) {
						feed.onConnection("failed", asPlatformError(error));
					}
				});
				return () => {
					closed = true;
					worlds.get(auth.profile.uid)?.sessions.get(id)?.feeds.delete(feed);
				};
			},
			resync() {
				later(60, () => {
					const session = worlds.get(auth.profile.uid)?.sessions.get(id);
					if (session) for (const feed of session.feeds) feed.onSnapshot(snapshotOf(session));
				});
			},
			async prompt(input: PromptInput) {
				await latency(180);
				const { world, session } = find();
				const text = input.text.trim();
				if (text === "") throw new PlatformError("user", "Write something for the agent to do.");
				if (text.length > MAX_PROMPT_CHARS) throw new PlatformError("user", `A prompt can be at most ${MAX_PROMPT_CHARS.toLocaleString("en")} characters.`);
				const status = session.summary.status;
				if (status === "starting") throw new PlatformError("user", "The agent is still starting. Send this again once it is working.", { reason: "turn_running" });
				if (status === "stopping") throw new PlatformError("user", "The turn is stopping. Send this again once it has stopped.", { reason: "turn_running" });
				if ((status === "running" || status === "waiting") && session.run) {
					// A message to a running turn steers it: stored as a steer, delivered at the next step.
					const turn = session.run.turn;
					store(session, { turn, kind: "user", text, model: session.summary.model, effort: null, steer: true });
					const messageId = `msg_${hex(24)}`;
					emit(session, turn, windlassEvent(session, "inbox.enqueued", { messageId, origin: null, delivery: "steer", content: [{ type: "text", text }] }));
					session.run.steers.push(messageId);
					setSummary(world, session, { updatedAt: now() });
					return { turn, steered: true };
				}
				const running = [...world.sessions.values()].filter((other) => other.summary.status !== "idle").length;
				if (running >= MAX_RUNNING_SESSIONS) throw new PlatformError("user", `${MAX_RUNNING_SESSIONS} of your agents are already working. Wait for one to finish, or stop one.`);
				if (input.model !== undefined && !MODELS.includes(input.model)) throw new PlatformError("user", `There is no model called ${input.model}.`);
				const name = chooseScript(text, world.rotation);
				if (ROTATION[world.rotation % ROTATION.length] === name) world.rotation += 1;
				// A second plain answer in one session uses the recording's second run.
				const recording: Script = name === "answer" && session.windlassSessionId !== null ? SCRIPTS.answerAgain : SCRIPTS[name];
				const server = chooseServer(text);
				const script: Script = server ? { ...recording, server } : recording;
				const turn = session.summary.turns + 1;
				play(session, plan(world, session, { ...input, text }, script));
				return { turn, steered: false };
			},
			async answer(input: { questionId: string; choice: string; note?: string }) {
				await latency(220);
				const { world, session } = find();
				const forced = nextAnswer;
				nextAnswer = null;
				if (forced === "error") throw new PlatformError("network", "The server did not answer, so your answer was not sent. Try again.");
				const question = session.question;
				if (forced === "elsewhere" && question) settle(world, session, question.choices.find((choice) => choice.approve)?.id ?? "once", null);
				// A server's question that stands aside for a tool call's can still be answered.
				const aside = session.aside;
				if (aside && aside.question.id === input.questionId && aside.question.choices.some((choice) => choice.id === input.choice)) {
					session.aside = null;
					aside.resume(input.choice, null);
					return;
				}
				if (!session.question || session.question.id !== input.questionId) {
					throw new PlatformError("user", forced === "elsewhere" ? "This question was already answered in another tab." : "This question is no longer waiting for an answer: it was answered elsewhere, it expired, or the turn was stopped.", { reason: "no_question" });
				}
				if (!session.question.choices.some((choice) => choice.id === input.choice)) throw new PlatformError("user", "That is not one of the question's answers.");
				const note = input.note?.trim() ?? "";
				if (note.length > MAX_NOTE_CHARS) throw new PlatformError("user", `A note can be at most ${MAX_NOTE_CHARS} characters.`);
				settle(world, session, input.choice, note === "" ? null : note);
			},
			async stopCall(input: { messageId: string; callId: string }) {
				await latency(120);
				const { session } = find();
				return stopOneCall(session, input.messageId, input.callId);
			},
			async stop() {
				await latency(90);
				const { world, session } = find();
				interrupt(world, session);
			},
			async changes(): Promise<WorkspaceFile[]> {
				await latency(200);
				const { session } = find();
				return [...session.files.entries()].map(([path, change]) => ({ path, status: change.status })).sort((a, b) => a.path.localeCompare(b.path));
			},
			async diff() {
				await latency(320);
				const { session } = find();
				return [...session.files.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, change]) => change.diff)
					.join("");
			},
			async publishState(): Promise<PublishState> {
				await latency(240);
				return publishStateOf(find().session);
			},
			async servers(): Promise<SessionServers> {
				const forced = nextServers === "list";
				if (forced) nextServers = null;
				await serversLatency(180);
				if (forced) throw new PlatformError("network", "The server did not answer, so the project's MCP servers could not be read. Try again.");
				const { world, session } = find();
				return serversOf(world, session);
			},
			async approveServer(name: string, fingerprint: string): Promise<SessionServers> {
				const forced = nextServers === "approve";
				if (forced) nextServers = null;
				await serversLatency(260);
				if (forced) throw new PlatformError("user", "The approval could not be remembered. Try again.");
				const { world, session } = find();
				const server = session.servers.find((known) => known.name === name);
				if (!server) throw new PlatformError("user", "This session's project no longer names an MCP server of that name.", { reason: "server_gone" });
				if (server.state !== "waiting" || server.fingerprint !== fingerprint) {
					throw new PlatformError("user", `The MCP server "${name}" no longer waits with the definition shown here. Read the list again and look at it once more.`, { reason: "server_changed" });
				}
				// A question about it is open: this answers it, and the server starts now.
				const aside = session.aside;
				if (session.question?.server?.name === name) settle(world, session, "start", null);
				else if (aside?.question.server?.name === name) {
					session.aside = null;
					aside.resume("start", null);
				} else {
					remember(world, session, name, fingerprint);
					store(session, { turn: session.summary.turns, kind: "platform", level: "info", text: `Approved the MCP server "${name}" for this project in the session's panel. ${server.remote ? "Windlass connects to it" : "It starts"} with the next turn.` });
					serversChanged(world, session);
				}
				return serversOf(world, session);
			},
			async forgetServer(name: string): Promise<SessionServers> {
				const forced = nextServers === "forget";
				if (forced) nextServers = null;
				await serversLatency(220);
				if (forced) throw new PlatformError("user", "The approval could not be forgotten. Try again.");
				const { world, session } = find();
				const project = mockProject(session.summary).key;
				const kept = world.approvals.filter((approval) => !(approval.project === project && approval.name === name));
				if (kept.length < world.approvals.length) {
					world.approvals = kept;
					store(session, { turn: session.summary.turns, kind: "platform", level: "info", text: `Forgot your approval of the MCP server "${name}" for this project. The next session or sandbox asks again; where it already started, Windlass's own record still starts it.` });
					serversChanged(world, session);
				}
				return serversOf(world, session);
			},
			async publish(message: PublishMessage): Promise<PublishResult> {
				// A commit, a push and a call to GitHub: it takes a moment.
				await latency(1700);
				const { world, session } = find();
				const repository = session.summary.repository;
				if (!repository) throw new PlatformError("user", "This agent does not work on a repository of your GitHub connection, so there is nowhere to push.", { reason: "publish_blocked" });
				const blocked = publishStateOf(session).blocked;
				if (blocked) throw new PlatformError("user", blocked, { reason: "publish_blocked" });
				if (message.title.trim() === "") throw new PlatformError("user", "Give the commit a title.", { reason: "bad_message" });
				if (!world.github) throw new PlatformError("user", GITHUB_NOT_CONNECTED, { reason: "github_gone" });
				const name = `${repository.owner}/${repository.name}`;
				const current = session.summary.pullRequest ?? null;
				const open = current !== null && (current.state === "open" || current.state === "draft") ? current : null;
				const branch = current?.branch ?? branchFor(session);
				const failure = nextGithub;
				if (failure === "denied" || failure === "protected" || failure === "gone") {
					nextGithub = null;
					const sentence = {
						denied: `${world.github.login} can read ${name} on GitHub but not write to it, so the platform cannot push there for you. Ask an owner of ${repository.owner} for write access, then push again.`,
						protected: `GitHub refused the push: a rule of ${name} protects branches named like ${branch}. Let the GitHub App create such branches in the repository's branch rules, then push again.`,
						gone: `${name} is no longer on GitHub, or the GitHub App can no longer see it. Check that the repository exists and that the app's installation on ${repository.owner} still includes it.`,
					}[failure];
					throw new PlatformError("user", sentence, { reason: failure === "gone" ? "github_gone" : "github_denied" });
				}
				const files = session.files.size;
				if (files === 0) {
					throw new PlatformError("user", open ? `There is nothing to push: ${branch} at GitHub already has everything in the workspace.` : `There is nothing to open a pull request with: the workspace has no changes and no commit that ${repository.branch} does not have.`, { reason: "publish_failed" });
				}
				const what = files === 1 ? "1 file" : `${files} files`;
				let pull: PullRequestInfo;
				if (open) {
					pull = { ...open, pushedAt: now() };
					store(session, { turn: session.summary.turns, kind: "platform", level: "info", text: `Pushed ${what} to ${branch}; pull request #${open.number} is updated.` });
				} else {
					const number = world.nextPull++;
					pull = { number, url: `${repository.url}/pull/${number}`, state: "open", title: message.title.trim(), branch, base: repository.branch, pushedAt: now() };
					store(session, { turn: session.summary.turns, kind: "platform", level: "info", text: `Opened pull request #${number} in ${name} from ${branch}, with ${what}.` });
				}
				// Committed: nothing differs from the last commit any more.
				session.files.clear();
				session.pushed = true;
				setSummary(world, session, { pullRequest: pull, updatedAt: now() });
				return { state: publishStateOf(session), opened: !open };
			},
		};
	}

	return {
		kind: "mock",
		endpoint: null,
		async info(): Promise<PlatformInfo> {
			await latency(120);
			return { demoEnabled: true, windlassVersion: "0.1.0", profiles: MOCK_PROFILES, models: MODELS, efforts: EFFORTS, ...(githubOn ? { github: GITHUB } : {}) };
		},
		login: {
			async start(): Promise<LoginStart> {
				await latency(400);
				attempt.state = hex(16);
				attempt.expiresAt = now() + 10 * MINUTE;
				const query = new URLSearchParams({ mock: "1", state: attempt.state, redirect_uri: REDIRECT_PREFIX });
				return { url: `${origin}/mock/authorize?${query}`, redirectPrefix: REDIRECT_PREFIX, expiresAt: attempt.expiresAt };
			},
			async finish(pastedUrl: string): Promise<AuthResult> {
				await latency(700);
				if (attempt.state === "") throw new PlatformError("user", "This sign-in attempt is not known. Start again.");
				if (now() > attempt.expiresAt) throw new PlatformError("user", "This sign-in attempt has expired. Start again.");
				const pasted = pastedUrl.trim();
				if (!pasted.startsWith(REDIRECT_PREFIX)) throw new PlatformError("user", `That is not the address the sign-in ends on. It starts with ${REDIRECT_PREFIX}.`);
				let params: URLSearchParams;
				try {
					params = new URL(pasted).searchParams;
				} catch {
					throw new PlatformError("user", "That is not a whole address. Copy everything in the address bar.");
				}
				const refused = params.get("error");
				if (refused !== null) throw new PlatformError("user", `OpenAI did not approve the sign-in (${refused}).`);
				if (!params.get("code")) throw new PlatformError("user", "That address has no sign-in code in it. Copy the whole address, including everything after the question mark.");
				if (params.get("state") !== attempt.state) throw new PlatformError("user", "That address belongs to another sign-in attempt. Start again.");
				attempt.state = "";
				const profile: UserProfile = { uid: "u_ada", email: "ada@example.com", demo: false };
				return { token: tokenFor(profile), profile };
			},
			async demo(): Promise<AuthResult> {
				await latency(500);
				const profile: UserProfile = { uid: `demo_${hex(8)}`, email: null, demo: true };
				return { token: tokenFor(profile), profile };
			},
		},
		user: userApi,
		session: sessionApi,
		dispose() {
			disposed = true;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		},
		mockNextAnswer(kind) {
			nextAnswer = kind;
		},
		mockNextGithub(kind) {
			nextGithub = kind;
		},
		mockNextServers(kind) {
			if (kind === "slow") slowServersUntil = realNow() + 10_000;
			else nextServers = kind;
		},
		simulateDrop(ms: number) {
			for (const world of worlds.values()) {
				for (const feed of world.feeds) feed.onConnection?.("reconnecting");
				for (const session of world.sessions.values()) for (const feed of session.feeds) feed.onConnection("reconnecting");
			}
			setTimeout(() => {
				for (const world of worlds.values()) {
					for (const feed of world.feeds) {
						feed.onConnection?.("connected");
						feed.onSessions(listOf(world));
					}
					for (const session of world.sessions.values()) {
						for (const feed of session.feeds) {
							feed.onConnection("connected");
							feed.onSnapshot(snapshotOf(session));
						}
					}
				}
			}, ms);
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function asPlatformError(error: unknown): PlatformError {
	return error instanceof PlatformError ? error : new PlatformError("internal", "Something went wrong.", { cause: error });
}

function addUsage(a: TurnUsage | null, b: TurnUsage): TurnUsage {
	if (!a) return { ...b };
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		reasoningTokens: a.reasoningTokens + b.reasoningTokens,
	};
}

function hex(length: number): string {
	const bytes = new Uint8Array(Math.ceil(length / 2));
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, length);
}

/** The demo recordings reuse "a1", "u1" in every run; real message IDs are unique in a session. */
function stampId(turn: number, messageId: string): string {
	return messageId.startsWith("msg_") ? messageId : `msg_t${turn}_${messageId}`;
}

/** 180000 → "3 minutes". */
function minutes(ms: number): string {
	const value = Math.round(ms / 60_000);
	if (value >= 1) return `${value} ${value === 1 ? "minute" : "minutes"}`;
	const seconds = Math.round(ms / 1000);
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** A title from a prompt's opening words. */
export function openingWords(text: string): string {
	const line = text.trim().split("\n", 1)[0] ?? "";
	if (line.length <= 56) return line || "New agent";
	const cut = line.slice(0, 56);
	const space = cut.lastIndexOf(" ");
	return `${space > 24 ? cut.slice(0, space) : cut}…`;
}
