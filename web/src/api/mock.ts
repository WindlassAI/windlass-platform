import { machineDetails } from "../../../server/src/machines/details.js";
/**
 * The mock `PlatformClient`: the whole backend in memory, with no network.
 *
 * It serves a user with a handful of sessions in different states, the seven sandbox profiles, and
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
 * Usage: the deployment gives each user two hours of sandbox time a day and lets them keep twenty
 * sandboxes (the real default is five; the seeded sessions keep eight, and agents launched by hand need room). Today's time is made up for
 * the seeded sessions, a turn played here adds what it ran, and the last two weeks are a fixed
 * history with one day at the limit. Every sandbox that runs holds five minutes of the day. The
 * prices are E2B's, since the mock plays a deployment there. `mockUsage("low" | "used" | "full")`,
 * or `&usage=...` in the address, plays a day with little left, a day that is used up (a prompt is
 * refused as the server refuses it), and an account that keeps as many sandboxes as it may (a new
 * agent's first prompt is refused); `freeSandbox()` removes one. The sentences are
 * server/src/usage.ts's, repeated here (mock.usage.test.ts compares the two).
 *
 * What a user keeps for their account (docs/github-and-repositories.md, "Account settings") is here too: the defaults for new
 * agents, their own MCP servers and those servers' secrets, with the server's refusals in the
 * server's words. A session's panel lists the user's own servers beside its project's from its next
 * turn. With `account: "seeded"`, which the page asks for, the user has two servers and two secrets
 * saved, one of each under a name acme/harbor has a secret of its own for.
 *
 * The world is rebuilt from the token on every page load, so the seeded sessions keep their IDs
 * across a reload and sessions created by hand do not survive one.
 */
import { initialHarnessModels } from "../../../server/src/sandbox/harnesses.js";
import { initialSessionModes } from "../../../server/src/sandbox/profiles.js";
import { githubId } from "../../../server/src/github/ids.js";
import {
	MAX_IDEMPOTENCY_KEY_CHARS,
	MAX_PROMPT_CHARS,
	MAX_SECRET_NAME_CHARS,
	MAX_ACCOUNT_SECRETS,
	MAX_PERSONAL_SERVERS,
	MAX_SECRET_VALUE_BYTES,
	MAX_SECRETS_PER_REPOSITORY,
	MAX_SERVER_DEFINITION_BYTES,
	MAX_SERVER_NAME_CHARS,
	MAX_SETUP_COMMAND_CHARS,
	MAX_CHECKS_PER_REPOSITORY,
	MAX_CHECK_NAME_CHARS,
	MAX_CHECK_TIMEOUT_SECONDS,
	MIN_SECRET_VALUE_CHARS,
	MAX_TITLE_CHARS,
	generatedSessionTitle,
	MAX_MACHINES,
	CLAUDE_LAUNCH_MODES,
	type RepositoryCheck,
	type RepositoryChecks,
	type Verified,
	type AccountDefaults,
	type AccountSecrets,
	type AccountSettings,
	type AuthResult,
	type ChatgptStatus,
	type CreateSessionInput,
	type GithubId,
	type GithubAccount,
	type GithubBranchList,
	type GithubConnection,
	type GithubRepository,
	type GithubRepositoryList,
	type GithubStatus,
	type WindlassDelta,
	type AcpContext,
	type AcpUpdate,
	type HarnessId,
	type LiveDelta,
	type LoginStart,
	type ItemView,
	type MachineSummary,
	type ModelChoice,
	type ModelList,
	type PendingQuestion,
	type PersonalServer,
	type PersonalServerReach,
	type PlatformInfo,
	type PromptInput,
	type PublishMessage,
	type PublishResult,
	type PublishState,
	type PullRequestInfo,
	type RepositoryApproval,
	type RepositoryDefaults,
	type RepositorySecrets,
	type RepositorySetup,
	type RepositoryView,
	type SandboxProfile,
	type SandboxProfileId,
	type SavedRepository,
	type SecretReach,
	type SecretScope,
	type SessionRepository,
	type SessionServer,
	type SessionServers,
	type SessionSnapshot,
	type SessionSummary,
	type TimelineItem,
	type TurnOutcome,
	type TurnUsage,
	type UsageNumbers,
	listedSessions,
	type UsageView,
	type UserProfile,
	type WindlassEvent,
	type WorkspaceFile,
	MAX_NOTE_CHARS,
} from "@contract";
import { PlatformError, type PlatformClient, type SessionApi, type SessionFeed, type UserApi, type UserFeed } from "./client";
import { acpOutcome, acpRecorder, isDurable, isLive, isPermission, schedule, splitRuns, turnEnded, withSummary, type AcpPermission } from "./feed";
import { acpFixture } from "./acp-fixtures";
import { fixture } from "./fixtures";
import { unifiedDiff } from "../lib/acp";
import { createMockItems, MOCK_FACTORY_LIMITS, type MockItemsState } from "./mock-items";

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
	/** "e2b" plays a deployment on E2B that offers both of its profiles (`MOCK_E2B_PROFILES`). */
	sandbox?: "docker" | "e2b";
	/** How the user's day stands when the page loads (`MockUsageState`). Default "plenty". */
	usage?: MockUsageState;
	/** "seeded": the user has MCP servers of their own and secrets for them saved. Default "empty": nothing is saved for the account. */
	account?: "empty" | "seeded";
	/** "unavailable" plays a signed-in user whose plan's models could not be read: the stand-in list, which says so. Default "account": the plan's own. */
	models?: "account" | "unavailable";
	/** How the user's machines stand when the page loads (`MockMachineState`). Default "online". */
	machine?: MockMachineState;
	/** How the agent on the user's machine finds that machine when its page opens (`MockMachineSession`). Default "answering". */
	machineSession?: MockMachineSession;
	/** How the user's work items and API tokens stand when the page loads (mock-items.ts, `MockItemsState`). Default "all". */
	items?: MockItemsState;
	/** False plays a deployment without the second review (WLP_FACTORY_REVIEWER unset): platform info says so. Default true. */
	reviewer?: boolean;
}

/**
 * A day of sandbox time, for looking at each state by hand: "plenty" left, "low" (under a fifth of
 * the allowance is left, which a session says), "used" (nothing is left, and a prompt is refused), and
 * "full" (the user keeps as many sandboxes as they may, and an agent without one is refused its first prompt).
 */
export type MockUsageState = "plenty" | "low" | "used" | "full";

/**
 * The user's own machines, for looking at each state of the Machines page by hand (`?machine=`):
 * "none" (no machine yet), "online", "offline", "pairing" (confirmed, its runner not connected yet),
 * "outdated" (its runner is older than the platform serves), "docker" (its runner cannot reach Docker),
 * "clock" (its clock is minutes off), "key" (its key was used from a second place), "full" (as many
 * machines as an account may have), "unpublished" (no runner image is published yet, and no machine),
 * "stale" (the list is read once, then reading it again fails), "failed" (it cannot be read at all),
 * "loading" (it is never answered), "off" (the deployment offers no machines), and "unnamed" (beside "nas",
 * a machine whose runner runs in a container and reported the container's id for its host name). In the add dialog any
 * well-formed code is found, except ZZZZ-ZZZZ.
 */
export const MOCK_MACHINE_STATES = ["none", "online", "claude-signed-out", "offline", "pairing", "outdated", "docker", "clock", "key", "full", "unpublished", "stale", "failed", "loading", "off", "unnamed"] as const;
export type MockMachineState = (typeof MOCK_MACHINE_STATES)[number];

/**
 * How the agent seeded on the machine "nas" finds it (`?machineSession=`), for looking at each banner of
 * a session on a machine by hand: "answering"; "not_answering" (a turn is under way, and while its page
 * is open the machine stops answering after a few seconds and is back half a minute later, as the
 * session's `machine` event tells the page); "offline" (the machine went offline after the agent last used
 * it); "removed" (the agent's machine was removed, so it is not in the list). A prompt to an agent whose
 * machine is offline or removed fails at once with the server's sentence, as a turn that could not run.
 * Seeded where the user's machines are listed with "nas" as reported, and for "removed" wherever machines are offered.
 */
export const MOCK_MACHINE_SESSIONS = ["answering", "not_answering", "offline", "removed"] as const;
export type MockMachineSession = (typeof MOCK_MACHINE_SESSIONS)[number];

/** Claude Code as a runner started with `--harness claude` reports it (server/src/runner/control.ts, `report.harnesses`). */
const MOCK_CLAUDE = { id: "claude" as const, adapter: "claude-agent-acp 0.109.0", image: "sha256:3f9a1c0e7b5d2a8c6e4f1b9d7a5c3e1f0b8d6a4c2e0f9b7d5a3c1e8f6b4d2a0c", signIn: "token" as const };

/** Model and effort choices reported by the fixture machine. */
const MOCK_CLAUDE_MODELS: ModelList = {
	source: "harness",
	defaultModel: "default",
	fetchedAt: null,
	models: [
		{ id: "default", name: "Default (recommended)", efforts: [] },
		{ id: "opus", name: "Opus", efforts: ["low", "high", "max"] },
		{ id: "haiku", name: "Haiku", efforts: [] },
	],
};

/** What the mock's runners say they are, and what its platform asks of them. */
const MOCK_RUNNER_VERSION = "0.2.1";
const MOCK_MIN_RUNNER_VERSION = "0.2.0";
const MOCK_RUNNER_IMAGE = "registry.example.com/windlass-runner@sha256:6b1f0c2d9e4a8b7c3f5e1d0a9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b";

/** A machine's sandbox profiles as the server words them from its runner's report (server/src/runner/machine-profiles.ts): `docker` and `commandSandbox` are what failed, if anything. */
function mockMachineProfiles(name: string, failed: { docker?: string; commandSandbox?: string } = {}): SandboxProfile[] {
	const machine = `your machine "${name}"`;
	const layers = [`Your machine "${name}" (yours; the platform does not control it)`, "Docker container made by the runner (non-root, no capabilities, limits)"];
	const sandbox = failed.docker ?? failed.commandSandbox;
	const trust = "The platform does not control this machine. It receives the repository, the saved secrets you allow and a ChatGPT token that lasts about an hour. The checks and changes shown are what your machine reports.";
	return [
		{
			id: "docker-windlass-sandbox",
			name: `Docker + Windlass sandbox on ${machine}`,
			summary: `The agent runs in a container on ${machine}. As far as its runner reports, Windlass sandboxes each command, with no network and the session's access token out of reach. ${trust}`,
			layers: [...layers, "Windlass's bubblewrap sandbox around each command (as the runner reports)"],
			approval: "auto",
			commandNetwork: false,
			commandsCanReadAccessToken: false,
			available: sandbox === undefined,
			...(sandbox !== undefined ? { unavailableReason: sandbox } : {}),
		},
		{
			id: "docker-hardened",
			name: `Hardened Docker on ${machine}`,
			summary: `Commands run directly in a container on ${machine}, can reach its local network and can read the session's access token. ${trust}`,
			layers,
			approval: "full",
			commandNetwork: true,
			commandsCanReadAccessToken: true,
			available: failed.docker === undefined,
			...(failed.docker !== undefined ? { unavailableReason: failed.docker } : {}),
		},
	];
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
	/** Sets how the user's day of sandbox time stands (`__wlpMock.mockUsage("used")`, then send a prompt). */
	mockUsage(state: MockUsageState): void;
}

/** The mock deployment's limits: the allowance is the real default, the cap is above it so that the seeded sessions fit. */
export const MOCK_ALLOWANCE_SECONDS = 2 * 60 * 60;
export const MOCK_MAX_KEPT = 20;
const MOCK_HOLD_SECONDS = 5 * 60;
const MOCK_START_SECONDS = 30;
/** E2B's published price for the size the platform's template has. */
const MOCK_PRICE = { usdPerSecond: 0.0000185, basis: "1 vCPU and 1,024 MiB of memory at E2B's published prices" };
/** The thirteen days before today, the oldest first, in seconds: one of them at the limit. */
const MOCK_HISTORY = [0, 3_120, 5_460, 1_890, 0, 0, 4_410, 7_200, 2_280, 6_630, 960, 0, 3_870];
/** What the seeded sessions' sandboxes ran today, by session id; "probe" lost five minutes to a server that stopped under it. */
const MOCK_SPENT: Record<string, number> = { "add-test": 1_140, headers: 420, "harbor-build": 240, probe: 480, unattended: 360 };
const MOCK_UNREPORTED: Record<string, number> = { probe: 300 };

/** server/src/usage.ts, `spellSeconds`. */
function spellSeconds(total: number): string {
	const seconds = Math.max(0, Math.round(total));
	const hours = Math.floor(seconds / 3600);
	const whole = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	if (hours > 0) return whole === 0 ? `${hours} h` : `${hours} h ${whole} min`;
	if (whole >= 10 || (whole > 0 && rest === 0)) return `${whole} min`;
	if (whole > 0) return `${whole} min ${rest} s`;
	return `${seconds} s`;
}

const resetWords = (numbers: UsageNumbers) => `The allowance is whole again at 00:00 UTC, in ${spellSeconds(Math.max(60, Math.ceil((numbers.resetsAt - numbers.at) / 60_000) * 60))}.`;

/** server/src/usage.ts, `allowanceRefusal`. */
export function mockAllowanceRefusal(numbers: UsageNumbers): string {
	const allowance = spellSeconds(numbers.allowanceSeconds ?? 0);
	const used = spellSeconds(numbers.usedSeconds);
	const held = numbers.heldSeconds > 0 ? spellSeconds(numbers.heldSeconds) : null;
	const left = numbers.leftSeconds ?? 0;
	let said: string;
	if (left > 0) said = `Only ${spellSeconds(left)} of today's ${allowance} of sandbox time is left (${used} used${held === null ? "" : `, ${held} held for sandboxes that are running now`}), which is too little to start with, so nothing was started.`;
	else if (held === null) said = `Today's ${allowance} of sandbox time is used up, so nothing was started.`;
	else said = `Today's ${allowance} of sandbox time is all used or held: ${used} used, and ${held} held for sandboxes that are running now. Nothing was started.`;
	if (held !== null) said += " What a running sandbox does not use of its hold is free again when it stops.";
	return `${said} ${resetWords(numbers)}`;
}

/** server/src/usage.ts, `sandboxRefusal`. */
export function mockSandboxRefusal(numbers: UsageNumbers): string {
	const limit = numbers.sandboxes.limit ?? numbers.sandboxes.kept;
	return `You keep ${limit} ${limit === 1 ? "sandbox" : "sandboxes"}, the most an account may have, and this agent needs one of its own. Free one on the Usage page, which says what goes with it, or delete an agent you no longer need. Then send this again.`;
}

/** server/src/usage.ts, `freedNote`, for a deployment that keeps a copy of the agent's memory. */
export const MOCK_FREED_NOTE =
	"You freed this agent's sandbox on the Usage page: the files in its workspace are gone. The conversation stays, and the next prompt starts a new sandbox. The agent keeps its memory of the conversation, and is told that the workspace is a new one.";

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
		layers: ["Docker container (Docker’s seccomp profile with namespace and mount calls allowed, non-root, no capabilities, resource limits)", "Windlass's bubblewrap sandbox around each command (no network, writes only in the workspace and in a home of the session's own, credentials hidden)"],
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
		unavailableReason: "This server runs its sandboxes on local Docker. E2B is built: a server started with WLP_SANDBOX=e2b, an E2B API key and the E2B template (docs/operating.md, \"E2B\") offers it in place of the Docker profiles, and says there what it promises.",
	},
	{
		id: "e2b-open",
		name: "E2B, microVM only",
		summary: "A microVM of its own, hosted by E2B, and no sandbox inside it: the agent's commands run directly in the microVM without asking first, can reach any host on the network, can write outside the workspace, the home directory included, and can read the session's access token, which lasts about an hour and cannot be renewed. Once something from the web or an MCP server is in the conversation, Windlass sandboxes commands again and asks before one uses the network or writes outside the workspace; what is in the home directory by then is read-only for them, and what they add there is kept apart for the session. Your ChatGPT sign-in is never in the microVM.",
		layers: ["E2B microVM (Firecracker, hosted by E2B; commands run in it directly, as a non-root user)"],
		approval: "full",
		commandNetwork: true,
		commandsCanReadAccessToken: true,
		available: false,
		unavailableReason: "This server runs its sandboxes on local Docker; a server on E2B offers it where its operator sets WLP_E2B_OPEN_PROFILE=1.",
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

/**
 * The profiles as a server on E2B lists them with WLP_E2B_WINDLASS_SANDBOX=1 and WLP_E2B_OPEN_PROFILE=1,
 * word for word (`?sandbox=e2b`; mock.test.ts compares them with `profilesFor`).
 */
export const MOCK_E2B_PROFILES: SandboxProfile[] = MOCK_PROFILES.map((profile): SandboxProfile => {
	if (profile.id === "e2b") {
		return {
			id: "e2b",
			name: "E2B + Windlass sandbox",
			summary:
				"A microVM of its own, hosted by E2B, and every command the agent runs is sandboxed again by Windlass: no network, and the session's access token is out of its reach. Your ChatGPT sign-in is never in the microVM.",
			layers: ["E2B microVM (Firecracker, hosted by E2B; commands run as a non-root user)", "Windlass's bubblewrap sandbox around each command (no network, writes only in the workspace and in a home of the session's own, credentials hidden)"],
			approval: "auto",
			commandNetwork: false,
			commandsCanReadAccessToken: false,
			available: true,
		};
	}
	if (profile.id === "e2b-open") {
		const { unavailableReason: _, ...rest } = profile;
		return { ...rest, layers: [...profile.layers], available: true };
	}
	if (profile.id.startsWith("docker-")) {
		const { unavailableReason: _, ...rest } = profile;
		return { ...rest, layers: [...profile.layers], available: false, unavailableReason: "This deployment runs its sandboxes on E2B, so that every server machine can reach them; a local Docker container is out of reach of the other machines." };
	}
	return { ...profile, layers: [...profile.layers] };
});

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
/** What the signed-in user's ChatGPT plan offers: each model with its own efforts, and one that takes none. */
const MOCK_PLAN: ModelChoice[] = [
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
	{ id: "gpt-6-luna", name: null, efforts: ["low", "medium"] },
	{ id: "gpt-6-brisk", name: "GPT-6 Brisk", efforts: [] },
];
/** The platform's stand-in for a plan's models, as the server has it (`standInModels`, server/src/account-models.ts). */
export function mockStandInModels(source: Exclude<ModelList["source"], "account">): ModelList {
	const models = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"].map((id) => ({ id, name: null, efforts: ["low", "medium", "high", "xhigh", "max"] }));
	return { source, models, defaultModel: "gpt-6.1-sol", fetchedAt: null };
}
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
	/** With `platformFailure`: the sandbox's machine could not be reached, so the turn fails before its sandbox is opened. */
	unreachable?: boolean;
}

const run = (name: string, index = 0): WindlassEvent[] => splitRuns(fixture(name))[index] ?? [];

/**
 * The mock's stand-in for the platform answering one of its own tools (server/src/agent-publish.ts):
 * where a recording has it, the platform's line goes into the timeline and the call settles with what
 * the agent is told (`hostCall`). Never sent to a client.
 */
const MOCK_HOST_CALL = "mock.host_call";

/** A call of the platform's `push` or `fetch_base` in a scripted turn. `changed`: the files the turn changed by then, which the platform commits. */
interface MockHostCall {
	tool: "push" | "fetch_base";
	input: Record<string, unknown>;
	changed?: string[];
}

/**
 * A recorded run with calls of the platform's tools added before its last step, one step each, as a
 * model makes them once its work is done. They are marked, so that a session with no repository,
 * where the server offers no such tool, plays the run without them.
 */
function withHostCalls(events: WindlassEvent[], calls: MockHostCall[]): WindlassEvent[] {
	const last = events.findLastIndex((event) => event.type === "step.started");
	const usage = { inputTokens: 9300, cachedInputTokens: 9100, outputTokens: 28, reasoningTokens: 0 };
	const added = calls.flatMap((call, index): WindlassEvent[] => {
		const messageId = `h${index + 1}`;
		const callId = `call_${call.tool}`;
		const host = { messageId, callId, host: true };
		return [
			{ type: "step.started", v: 1, seq: 0, data: { ...host, attempt: 1, model: "gpt-test" } },
			{ type: "tool.called", v: 1, seq: 0, data: { ...host, name: call.tool, input: JSON.stringify(call.input), providerData: null } },
			{ type: "tool.started", v: 1, seq: 0, data: { ...host, effect: "read" } },
			{ type: MOCK_HOST_CALL, data: { ...host, tool: call.tool, branch: call.input.branch ?? null, changed: call.changed ?? [] } },
			{ type: "step.ended", v: 1, seq: 0, data: { ...host, finish: "tool_calls", usage } },
		];
	});
	const out = [...events.slice(0, last), ...added, ...events.slice(last)];
	// The turn's summary counts the added steps.
	return out.map((event) => (event.type === "cli.summary" && typeof event.steps === "number" ? { ...event, steps: event.steps + calls.length } : event));
}

const isHostEvent = (event: WindlassEvent): boolean => event.type === MOCK_HOST_CALL || (event.data ?? {}).host === true;

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
 * A long turn made up for the mock, not recorded: the agent reads its way round a repository, searches
 * it, edits three files, runs a test that fails, fixes it, runs the lint and the types, and ends in a
 * slow build. Many calls in a row, as a real agent makes them, so that a busy transcript can be seen
 * here. A prompt about the retry backoff plays it.
 */
function backoffRun(): WindlassEvent[] {
	const events: WindlassEvent[] = [];
	let time = 1794666100000;
	let seq = 0;
	let step = 0;
	let call = 0;
	const stored = (type: string, data: Record<string, unknown>, after: number) => {
		time += after;
		events.push({ type, v: 1, seq: ++seq, data, sessionId: "ses_demo", time });
	};
	const message = () => `a${step}`;
	const begin = (after = 200) => {
		step++;
		call = 0;
		stored("step.started", { messageId: message(), attempt: 1, model: "gpt-test" }, after);
	};
	const end = (finish: "tool_calls" | "stop" = "tool_calls") => stored("step.ended", { messageId: message(), finish, usage: { inputTokens: 4000 + step * 900, cachedInputTokens: 3200 + step * 850, outputTokens: 60, reasoningTokens: 12 } }, 60);
	const say = (text: string, after = 500) => stored("text.ended", { messageId: message(), text, providerData: null }, after);
	const think = (text: string) => stored("reasoning.ended", { messageId: message(), text, providerData: null }, 700);
	const tool = (name: string, input: Record<string, unknown>, effect: string, result: { output: string; display?: Record<string, unknown> | null; outcome?: string; ms?: number; progress?: string[] }) => {
		call++;
		const ids = { messageId: message(), callId: `call_${call}` };
		stored("tool.called", { ...ids, name, input: JSON.stringify(input), providerData: null }, 140);
		stored("tool.started", { ...ids, effect }, 40);
		const ms = result.ms ?? 220;
		const lines = result.progress ?? [];
		lines.forEach((_, index) => {
			time += Math.round(ms / (lines.length + 1));
			events.push({ type: "tool.progress", sessionId: "ses_demo", ...ids, text: lines.slice(0, index + 1).join("\n"), time });
		});
		stored("tool.settled", { ...ids, outcome: result.outcome ?? "success", output: result.output, truncation: null, attachments: [], display: result.display ?? null }, lines.length > 0 ? Math.round(ms / (lines.length + 1)) : ms);
	};
	const shell = (command: string, output: string, exitCode: number, ms: number, progress?: string[]) => tool("shell", { command }, "exec", { output, outcome: exitCode === 0 ? "success" : "error", display: { exitCode, signal: null, timedOut: false, interrupted: null, durationMs: ms }, ms, progress });
	const read = (path: string, lines: number) => tool("read", { path }, "read", { output: `1\t// ${path}\n…`, display: { path, offset: 1, lines, totalLines: lines } });
	const edit = (path: string, diff: string) => tool("edit", { path, old_string: "…", new_string: "…" }, "write", { output: `Edited ${path}: replaced 1 occurrence.`, display: { path, replacements: 1, diff } });

	stored("session.created", { cwd: "/repo", title: null, lineage: null, settings: { model: "gpt-test", reasoningEffort: "medium" } }, 0);
	stored("inbox.enqueued", { messageId: "u1", origin: null, delivery: "steer", content: [{ type: "text", text: "" }] }, 0);
	stored("execution.started", { executionId: "exe_1" }, 40);
	stored("inbox.delivered", { messageId: "u1" }, 80);

	begin();
	think("**Mapping the retry path**\n\nThe client retries in two places: the HTTP wrapper and the queue's consumer. I should read both before changing the delay.");
	say("I'll look at how the client retries requests before changing anything.");
	tool("glob", { pattern: "src/**/*.ts" }, "read", { output: "src/client/http.ts\nsrc/client/retry.ts\nsrc/client/retry.test.ts\nsrc/queue/consumer.ts", display: { files: 14 } });
	tool("grep", { pattern: "retry|backoff", path: "src" }, "read", { output: "src/client/http.ts:41:  return retry(() => send(request), policy)\nsrc/client/retry.ts:12:export function backoff(attempt: number) {", display: { matches: 9, files: 4, engine: "ripgrep" } });
	read("src/client/http.ts", 182);
	read("src/client/retry.ts", 64);
	end();

	begin();
	read("src/client/retry.test.ts", 120);
	read("src/queue/consumer.ts", 96);
	tool("grep", { pattern: "maxDelay", path: "src" }, "read", { output: "", display: { matches: 0, files: 0, engine: "ripgrep" } });
	read("package.json", 41);
	end();

	begin();
	say("The delay doubles with no ceiling, and the jitter is added after the point where a cap would apply. Capping it at 30 s and moving the jitter inside the cap.");
	edit("src/client/retry.ts", "--- a/src/client/retry.ts\n+++ b/src/client/retry.ts\n@@ -10,7 +10,9 @@\n+const MAX_DELAY_MS = 30_000\n+\n export function backoff(attempt: number) {\n-  const delay = BASE_MS * 2 ** attempt\n-  return delay + jitter()\n+  const delay = Math.min(BASE_MS * 2 ** attempt, MAX_DELAY_MS)\n+  return Math.min(delay + jitter(), MAX_DELAY_MS)\n }");
	edit("src/client/http.ts", "--- a/src/client/http.ts\n+++ b/src/client/http.ts\n@@ -39,3 +39,3 @@\n-  return retry(() => send(request), policy)\n+  return retry(() => send(request), { ...policy, maxDelayMs: 30_000 })\n");
	end();

	begin();
	shell("bun test src/client", "bun test v1.4.0\n\nsrc/client/retry.test.ts:\n✓ retry > gives up after five attempts\n✗ retry > waits longer each time [0.40ms]\n  error: expect(received).toBe(expected)\n  Expected: 64000\n  Received: 30000\n\n 11 pass\n 1 fail\n[Exit code 1]", 1, 2400);
	end();

	begin();
	say("One test expected the old, uncapped delay after six attempts. Updating it to the cap.");
	edit("src/client/retry.test.ts", "--- a/src/client/retry.test.ts\n+++ b/src/client/retry.test.ts\n@@ -22,5 +22,5 @@\n test(\"waits longer each time\", () => {\n-  expect(backoff(6)).toBe(64000)\n+  expect(backoff(6)).toBe(30000)\n })");
	shell("bun test src/client", "bun test v1.4.0\n\nsrc/client/retry.test.ts:\n✓ retry > gives up after five attempts\n✓ retry > waits longer each time\n\n 12 pass\n 0 fail", 0, 2100);
	end();

	begin();
	shell("bun run lint", "$ eslint src\n✔ No problems found", 0, 3100);
	shell("bun run typecheck", "$ tsc --noEmit", 0, 4200);
	end();

	begin();
	say("Now the full build and the whole suite.");
	const suite = ["$ tsc -p tsconfig.build.json", "$ bun build src/index.ts --outdir dist", "  dist/index.js  418.21 KB", "$ bun test", "bun test v1.4.0", ...["client/http", "client/retry", "queue/consumer", "queue/producer", "store/cache", "store/disk", "api/routes", "api/auth", "jobs/sweep", "jobs/export"].map((name, index) => `src/${name}.test.ts: ${[18, 12, 41, 27, 52, 33, 43, 21, 9, 16][index]} pass`), "", " 272 pass", " 0 fail", "Ran 272 tests across 10 files. [118.40s]"];
	shell("bun run build && bun test", suite.join("\n"), 0, 150_000, suite);
	end();

	begin();
	say("The delay is capped now, and everything passes.\n\n- **`src/client/retry.ts`**: `backoff()` stops at `MAX_DELAY_MS` (30 s), and the jitter stays inside the cap.\n- **`src/client/http.ts`**: the HTTP client passes the cap to `retry()`.\n- **`src/client/retry.test.ts`**: the test that expected 64 s after six attempts now expects the cap.\n\n`bun run lint`, `bun run typecheck`, the build and all 272 tests pass.", 900);
	end("stop");

	stored("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } }, 40);
	events.push({ type: "cli.summary", sessionId: "ses_demo", executionId: "exe_1", outcome: "succeeded", steps: step, summaryCalls: 0, requests: step, durationMs: time - 1794666100000, usage: { inputTokens: 58_000, cachedInputTokens: 51_200, outputTokens: 1480, reasoningTokens: 220 }, cachedShare: 0.883 });
	return events;
}

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
	backoff: { events: backoffRun(), workspace: { "src/client/retry.ts": { status: " M", diff: "" }, "src/client/http.ts": { status: " M", diff: "" }, "src/client/retry.test.ts": { status: " M", diff: "" } } },
	answer: { events: run("demo-two-turns-in-one-session", 0) },
	answerAgain: { events: run("demo-two-turns-in-one-session", 1) },
	sandboxed: { events: run("real-scripted-bwrap"), workspace: { "made.txt": { status: "??", diff: MADE_DIFF } } },
	refused: { events: run("real-scripted-hardened") },
	usageLimit: { events: run("demo-a-non-retryable-error-usage-limit") },
	signedOut: { events: run("demo-a-non-retryable-error-authentication") },
	cancelled: { events: run("demo-cancel-while-one-tool-is-running") },
	network: questionScript(),
	subagentNetwork: questionScript("Check what the API's health endpoint returns"),
	// Four subagents: one finishes, one fails, the user stops one, and one runs in the background. Played slowly enough to watch them run.
	subagents: { events: run("acp-subagents"), stretch: 3 },
	crash: { events: [], platformFailure: "The sandbox stopped responding and the turn was abandoned. Nothing it had written was lost; send the prompt again to carry on." },
	// The fix, then the base fetched and the branch pushed by the agent: the platform commits the changed file, so nothing is left to push.
	agentPush: { events: withHostCalls(run("demo-find-and-fix-a-failing-test"), [{ tool: "fetch_base", input: {} }, { tool: "push", input: { message: "Make add() add" }, changed: ["src/add.ts"] }]) },
	// The fix, then a push to the repository's default branch, which is refused: the change stays in the workspace.
	agentPushRefused: { events: withHostCalls(run("demo-find-and-fix-a-failing-test"), [{ tool: "push", input: { branch: "main", message: "Make add() add" } }]), workspace: { "src/add.ts": { status: " M", diff: ADD_TS_DIFF } } },
} satisfies Record<string, Script>;

type ScriptName = keyof typeof SCRIPTS;

/** The server's refusal of a prompt to a work item's agent (`prompt` in agent-session.ts), word for word. */
export const ITEM_SESSION_PROMPT = "This agent works for a work item, whose steps send its prompts. Answer the item, or send its work back with a note.";

/** What an unrecognised prompt plays, in turn. */
const ROTATION: ScriptName[] = ["fix", "parallel", "checks", "steps", "build", "answer"];

function chooseScript(text: string, rotation: number): ScriptName {
	const words = text.toLowerCase();
	if (/usage|limit|quota/.test(words)) return "usageLimit";
	if (/sign.?in|signed out|auth/.test(words)) return "signedOut";
	if (/crash/.test(words)) return "crash";
	if (/\bpush\b/.test(words)) return /\b(main|default branch)\b/.test(words) ? "agentPushRefused" : "agentPush";
	if (/\b(network|fetch|download|curl|https?|headers?|website|url)\b/.test(words)) return /subagent/.test(words) ? "subagentNetwork" : "network";
	if (/subagent/.test(words)) return "subagents";
	if (/backoff/.test(words)) return "backoff";
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

/** What would set a variable a definition reads, as server/src/server-question.ts says it of a variable no secret is saved for. */
function mockUnsetRemedy(unset: readonly string[], project: MockProject, profile: SandboxProfile): string {
	// One of the account's secrets sets the variable too: any, where this sandbox gives them all to MCP servers.
	if (project.kind !== "github") return `A variable is set by saving a secret for a repository of your GitHub connection, and this session is not on one. ${mockAccountSecretsNote(profile) === null ? "A secret of your account under that name, saved in your settings, sets it for MCP servers too." : "A secret of your account under that name, saved in your settings, sets it for MCP servers in this sandbox if it is also for the agent's commands."}`;
	const names = unset.length <= 1 ? unset.join("") : `${unset.slice(0, -1).join(", ")} and ${unset[unset.length - 1]}`;
	return unset.length === 1
		? `Save a secret named ${names} for ${project.label}, under Secrets in this session's panel: it is handed over from the next turn.`
		: `Save secrets named ${names} for ${project.label}, under Secrets in this session's panel: they are handed over from the next turn.`;
}

/** The names the server refuses for a secret (server/src/repo-secrets.ts, `isReservedName`). */
const MOCK_RESERVED = /^(?:(?:WLP|WINDLASS|LD|XDG|BUN|NODE|DOCKER|E2B|LC|BASH)_.*|PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TMPDIR|TMP|TEMP|LANG|LANGUAGE|TZ|TERM|HOSTNAME|IFS|ENV|SHLVL|_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|PAGER|GIT_PAGER|GIT_TERMINAL_PROMPT)$/i;

/** What the selected profile allows each secret scope to reach. */
export function mockSecretReach(scope: SecretScope, profile: Pick<SandboxProfile, "approval" | "commandNetwork" | "commandsCanReadAccessToken">, owner: "repository" | "account" = "repository"): SecretReach {
	// What is left of a secret that MCP servers are not given: a repository's goes to its setup command, an account's has none.
	const left = owner === "repository" ? "Only the setup command gets it." : "So nothing is given it there.";
	const sandbox = profile.approval === "full" ? "none" : !profile.commandNetwork && !profile.commandsCanReadAccessToken ? "windlass" : "unknown";
	if (scope === "agent") return { servers: true, commands: "yes", note: null };
	if (sandbox === "windlass") return { servers: true, commands: "no", note: null };
	return {
		servers: false,
		commands: "no",
		note:
			sandbox === "none"
				? `MCP servers are not given it in this sandbox: the agent's commands run there without Windlass's sandbox, where a command can read whatever Windlass was handed for an MCP server from Windlass's own process. ${left}`
				: `MCP servers are not given it in this sandbox: it has not been established that Windlass can sandbox the agent's commands there, and a command it cannot sandbox can read whatever Windlass was handed for an MCP server from Windlass's own process. ${left}`,
	};
}

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
						? `It will not start yet: its definition reads the variable ${names}, which is not set where Windlass runs. ${mockUnsetRemedy(server.unset, project, profile)}`
						: `It will not start yet: its definition reads the variables ${names}, which are not set where Windlass runs. ${mockUnsetRemedy(server.unset, project, profile)}`,
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

/** Why a sandbox hands MCP servers only some of the account's secrets, as server/src/account-secrets.ts says it (`accountSecretsNote`). */
function mockAccountSecretsNote(profile: Pick<SandboxProfile, "approval" | "commandNetwork" | "commandsCanReadAccessToken">): string | null {
	const only = "Of your account's secrets, MCP servers are given only those that are also for the agent's commands in this sandbox";
	if (profile.approval === "full") return `${only}: the agent's commands run here without Windlass's sandbox, where a command can read whatever Windlass was handed for an MCP server from Windlass's own process. A server that reads another one does not start.`;
	if (profile.commandNetwork || profile.commandsCanReadAccessToken) return `${only}: it has not been established that Windlass can sandbox the agent's commands here, and a command it cannot sandbox can read whatever Windlass was handed for an MCP server from Windlass's own process. A server that reads another one does not start.`;
	return null;
}

/** What a server of the user's own can reach where it runs, as server/src/server-question.ts says it (`personalServerReach`). */
export function mockPersonalReach(profile: SandboxProfile): PersonalServerReach {
	const machine = profile.id.startsWith("e2b") ? "microVM" : profile.id.startsWith("docker") ? "container" : "sandbox";
	const data = "Windlass's own data, including the session's access token, which lasts about an hour and cannot be renewed";
	const command =
		profile.approval === "full"
			? `It runs in a session's ${machine}, as the agent's commands do here: like them, it has the network and can read ${data}.`
			: !profile.commandNetwork && !profile.commandsCanReadAccessToken
				? `It runs in a session's ${machine}, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read ${data}.`
				: `It runs in a session's ${machine} and is never inside Windlass's sandbox around commands, whether or not that sandbox works here: it has the network and can read ${data}.`;
	return { profile: profile.id, name: profile.name, command, address: `Nothing is started: Windlass reaches it at that address from a session's ${machine}, outside its sandbox around commands, and what the agent sends it leaves the ${machine}.` };
}

/** The keys of one server in Windlass's configuration, as server/src/personal-servers.ts has them (`SERVER_KEYS`). */
const MOCK_SERVER_KEYS = ["command", "args", "cwd", "env", "url", "headers", "tools", "timeoutSeconds", "startupTimeoutSeconds", "untrusted", "enabled", "protocol"];

/**
 * A server's name and definition as the server would save them (server/src/personal-servers.ts,
 * `cleanServerName` and `cleanServerDefinition`): the same refusals in the same words, and what is
 * kept rebuilt from the keys Windlass knows.
 */
export function mockCleanServer(rawName: unknown, raw: unknown): { name: string; definition: Record<string, unknown> } {
	const bad = (message: string) => new PlatformError("user", message, { reason: "bad_server" });
	if (typeof rawName !== "string" || rawName === "") throw bad("A server needs a name.");
	if (rawName.length > MAX_SERVER_NAME_CHARS) throw bad(`A server's name can be at most ${MAX_SERVER_NAME_CHARS} characters long.`);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(rawName)) throw bad("A server's name is made of letters, digits, '_', '.' and '-', and starts with a letter or a digit.");
	if (rawName.toLowerCase().startsWith("windlass_platform")) throw bad("A name that begins with windlass_platform cannot be a server's: it is the platform's own, and a server by that name would pass for the platform's tools.");

	const isObject = (value: unknown): value is Record<string, unknown> => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	};
	const text = (value: unknown, key: string, nonEmpty: boolean): string => {
		if (typeof value !== "string" || (nonEmpty && value === "")) throw bad(`${key} must be ${nonEmpty ? "text that is not empty" : "text"}.`);
		if (value.includes("\0")) throw bad(`${key} holds a character that cannot be passed on.`);
		return value;
	};
	const textList = (value: unknown, key: string, nonEmpty: boolean): string[] => {
		if (!Array.isArray(value)) throw bad(`${key} must be a list of texts.`);
		return value.map((item, index) => text(item, `${key}[${index}]`, nonEmpty));
	};
	const textMap = (value: unknown, key: string, variables: boolean): Record<string, string> => {
		if (!isObject(value)) throw bad(`${key} must be an object whose values are texts.`);
		const map: Record<string, string> = {};
		for (const [name, item] of Object.entries(value)) {
			if (variables && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw bad(`${key} has a key that is not an environment variable's name: letters, digits and underscores, not starting with a digit.`);
			if (name === "" || name.includes("\0")) throw bad(`${key} has a key that cannot be passed on.`);
			map[name] = text(item, `${key}.${name}`, false);
		}
		return map;
	};
	const whole = (value: unknown, key: string, max: number): number => {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw bad(`${key} must be a whole number from 1 to ${max}.`);
		return value;
	};
	const flag = (value: unknown, key: string): boolean => {
		if (typeof value !== "boolean") throw bad(`${key} must be true or false.`);
		return value;
	};
	const unknownKey = (found: string[], known: string[], where: string): void => {
		const unknown = found.find((key) => !known.includes(key));
		if (unknown !== undefined) throw bad(`${where} has a key Windlass does not know, "${unknown.replace(/[^\x20-\x7e]/g, "?").slice(0, 40)}". It takes: ${known.join(", ")}.`);
	};

	if (!isObject(raw)) throw bad("A server's definition is an object, as Windlass's configuration takes it: a command to start, or an address to reach.");
	unknownKey(Object.keys(raw), MOCK_SERVER_KEYS, "The definition");
	const out: Record<string, unknown> = {};
	if (raw.command !== undefined) out.command = text(raw.command, "command", true);
	if (raw.args !== undefined) out.args = textList(raw.args, "args", false);
	if (raw.cwd !== undefined) out.cwd = text(raw.cwd, "cwd", true);
	if (raw.env !== undefined) out.env = textMap(raw.env, "env", true);
	if (raw.url !== undefined) {
		const url = text(raw.url, "url", true);
		let protocol = "";
		try {
			protocol = new URL(url).protocol;
		} catch {
			// Said below.
		}
		if (protocol !== "http:" && protocol !== "https:") throw bad("url must be an http or https address.");
		out.url = url;
	}
	if (raw.headers !== undefined) out.headers = textMap(raw.headers, "headers", false);
	if (raw.tools !== undefined) {
		if (!isObject(raw.tools)) throw bad("tools must be an object with allow and deny, each a list of tool names.");
		unknownKey(Object.keys(raw.tools), ["allow", "deny"], "tools");
		const tools: Record<string, string[]> = {};
		for (const key of ["allow", "deny"]) if (raw.tools[key] !== undefined) tools[key] = textList(raw.tools[key], `tools.${key}`, true);
		out.tools = tools;
	}
	if (raw.timeoutSeconds !== undefined) out.timeoutSeconds = whole(raw.timeoutSeconds, "timeoutSeconds", 3600);
	if (raw.startupTimeoutSeconds !== undefined) out.startupTimeoutSeconds = whole(raw.startupTimeoutSeconds, "startupTimeoutSeconds", 600);
	if (raw.untrusted !== undefined) out.untrusted = flag(raw.untrusted, "untrusted");
	if (raw.enabled !== undefined) out.enabled = flag(raw.enabled, "enabled");
	if (raw.protocol !== undefined) {
		if (typeof raw.protocol !== "string" || !["auto", "modern", "legacy"].includes(raw.protocol)) throw bad("protocol must be one of auto, modern, legacy.");
		out.protocol = raw.protocol;
	}
	if (out.command !== undefined && out.url !== undefined) throw bad("A definition has a command or a url, not both: a server is either started or reached.");
	if (out.command === undefined && out.url === undefined) throw bad("A definition needs a command (a server to start) or a url (a server to reach).");
	if (out.command !== undefined && out.headers !== undefined) throw bad("headers applies only to a server reached by a url.");
	if (out.url !== undefined) {
		const misplaced = ["args", "cwd", "env"].find((key) => out[key] !== undefined);
		if (misplaced !== undefined) throw bad(`${misplaced} applies only to a server started by a command.`);
	}
	const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
	if (bytes > MAX_SERVER_DEFINITION_BYTES) throw bad(`A server's definition can be at most ${MAX_SERVER_DEFINITION_BYTES.toLocaleString("en-US")} bytes long as JSON; this one is ${bytes.toLocaleString("en-US")}.`);
	return { name: rawName, definition: out };
}

/** The variables a definition reads: every `${NAME}` in the values of its `env` and `headers`, in order of first appearance. */
function mockDefinitionReads(definition: Record<string, unknown>): string[] {
	const names: string[] = [];
	for (const key of ["env", "headers"]) {
		const values = definition[key];
		if (typeof values !== "object" || values === null) continue;
		for (const value of Object.values(values)) {
			if (typeof value !== "string") continue;
			for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (match[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
		}
	}
	return names;
}

/** What forgetting does and leaves, as the server says it where Windlass's own record stays in the sandbox. */
/** The demo repository whose items show example screenshots has opted in. */
export const MOCK_SCREENSHOTS = [7101];

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
/** How long the mock says a repository's setup command may run. */
const MOCK_SETUP_LIMIT_MS = 10 * MINUTE;

/** One thing a Claude Code turn does, after `wait` ms: an ACP update (and what the mock changes with it), or a permission it asks, with what follows each kind of answer. */
type AcpEntry =
	| { wait: number; update: AcpUpdate; then?: () => void }
	| { wait: number; ask: AcpPermission["permission"]; allowed: AcpEntry[]; declined: AcpEntry[] };

interface AcpScript {
	entries: AcpEntry[];
	stopReason: string;
}

/** The fake ACP agent's scenarios that a prompt to a Claude Code agent can name, to see each played as it was recorded. */
const ACP_SCENARIOS = ["plain", "tools", "plan", "ask", "usage", "leaveplan"] as const;

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
	/** A Claude Code turn's: the platform's record of its ACP updates, and the context's fill it last said. */
	/** `modeQueued`: a mode was chosen during the turn, so the agent's own mode changes no longer move the session's (server/src/actors/agent-session.ts). */
	acp?: { recorder: ReturnType<typeof acpRecorder>; context: AcpContext | null; modeQueued?: boolean };
}

interface MockSession {
	summary: SessionSummary;
	/** A seeded work item's turn, played when its page is first opened rather than with every user's seeds (`seedItemSession`). */
	seededTurn?: () => void;
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
	/** The commit the branch is at on GitHub after the platform's last push, for the panel or for the agent (`PublishState.pushed`); null before any. */
	pushedHead: string | null;
	/** What the session's work rests on since its last turn ended, as the server keeps it (`Verified`). */
	verified: Verified | null;
	/** The messages that were taken with a key, by that key: the text, and what the prompt was answered. */
	submissions: Map<string, Taken<{ turn: number; steered: boolean }>>;
	/** For an agent on one of the user's machines: its sandbox profile as that machine offered it, and what the session last found of the machine (`SessionSnapshot.machine`). */
	machine?: { profile: SandboxProfile; reach: NonNullable<SessionSnapshot["machine"]> | null };
}

/** What was taken under a submission's key: what it came with, and what its first attempt was answered. */
interface Taken<Answer> {
	content: string;
	answer: Answer;
}

/** A submission's key as the server reads it (`IdempotencyKey`): null for none, a refusal for what is no key. */
function keyOf(raw: unknown): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string" || raw === "" || [...raw].length > MAX_IDEMPOTENCY_KEY_CHARS) {
		throw new PlatformError("user", `The key of a submission must be a text of 1 to ${MAX_IDEMPOTENCY_KEY_CHARS} characters. Leave it out to send without one.`, { reason: "bad_idempotency_key" });
	}
	return raw;
}

/** What the first attempt under `key` was answered, when this is that submission again; a refusal when the key came with something else. */
function takenUnder<Answer>(kept: Map<string, Taken<Answer>>, key: string | null, content: string, what: string): Answer | undefined {
	const first = key === null ? undefined : kept.get(key);
	if (first === undefined) return undefined;
	if (first.content !== content) throw new PlatformError("user", `The key this was sent with was already used for another ${what}, so this one was not taken. A new submission needs a key of its own.`, { reason: "idempotency_key_reused" });
	return first.answer;
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
	/** The setup commands the user saved, by GitHub's id for the repository. */
	setups: Map<GithubId, { command: string; updatedAt: number }>;
	/** The checks the user saved for a repository, by GitHub's id for it. */
	checks: Map<GithubId, { checks: RepositoryCheck[]; updatedAt: number }>;
	/** The secrets the user saved, by repository and name. A value is not kept at all: nothing here could show one. */
	secrets: Map<GithubId, Map<string, { scope: SecretScope; updatedAt: number }>>;
	/** What new agents on a repository start with, where the user said so, by GitHub's id for it. */
	defaults: Map<GithubId, { profile: SandboxProfileId | null; model: string | null; updatedAt: number }>;
	/** The repositories whose work items' agents can take screenshots, with when that was saved (`RepositoryDefaults.screenshots`). */
	screenshotsEnabled: Map<GithubId, number>;
	/** What a repository was called when something was last saved for it or GitHub was last asked: what names one that has no session. */
	names: Map<GithubId, string>;
	/** What the user keeps for their account, whatever the repository. A secret's value is not kept at all. */
	account: {
		defaults: { profile: SandboxProfileId | null; model: string | null; updatedAt: number } | null;
		servers: Map<string, { definition: Record<string, unknown>; unasked: boolean; updatedAt: number }>;
		secrets: Map<string, { scope: SecretScope; updatedAt: number }>;
	};
	/** The seconds of sandbox time counted today, by session: the seeded ones, and what the turns played here ran. */
	spent: Map<string, number>;
	/** The agents that were created with a key, by that key: what was asked for, and the agent's id. */
	created: Map<string, Taken<string>>;
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
	let usageState: MockUsageState = options.usage ?? "plenty";
	const profiles = options.sandbox === "e2b" ? MOCK_E2B_PROFILES : MOCK_PROFILES;
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
	// Work items, API tokens and the factory's limits live in mock-items.ts; an item's agent is made here, as `createSession` makes one.
	// On one of the user's machines, it takes the machines as they are listed now, and is told of every change of them.
	const items = createMockItems({
		state: options.items,
		reviewer: options.reviewer,
		now: () => realNow(),
		latency,
		later,
		feeds: (auth) => worldOf(auth).feeds,
		session: (auth, { profile, ...input }) => userApi(auth).createSession({ ...input, profile: profile ?? (profiles.find((candidate) => candidate.available) ?? profiles[0])?.id ?? "docker-windlass-sandbox" }),
		seededSession: (auth, item) => seedItemSession(auth, item),
		itemChanged: (auth, item) => {
			const world = worldOf(auth);
			const session = world.sessions.get(item.sessionId);
			if (!session) return;
			// A turn of the item runs while it works; its prompts are the item's, so nothing else starts one here.
			const status = item.state === "working" && item.run?.step.kind !== "review" ? "running" : "idle";
			if (session.summary.item?.id === item.id && session.summary.status === status) return;
			setSummary(world, session, { availableModes: [], item: { id: item.id, role: "builder" }, status, ...(status === "running" && session.summary.sandbox === "none" ? { sandbox: "running" as const } : {}) });
		},
		checks: (auth, repositoryId) => checksOf(worldOf(auth), repositoryId).checks.length,
		machines: (auth) => (machineState === "off" ? null : { list: machinesOf(auth).list, minRunnerVersion: MOCK_MIN_RUNNER_VERSION }),
	});

	// ---- identity -------------------------------------------------------------------------------

	const tokenFor = (profile: UserProfile) => `mock:${profile.demo ? "demo" : "chatgpt"}:${profile.uid}:${profile.email ?? ""}`;

	function worldOf(auth: AuthResult): World {
		const [scheme, kind, uid, email] = auth.token.split(":");
		if (scheme !== "mock" || !uid || uid !== auth.profile.uid || (kind !== "demo" && kind !== "chatgpt")) {
			throw new PlatformError("unauthorized", "This sign-in is no longer accepted. Sign in again.");
		}
		let world = worlds.get(uid);
		if (!world) {
			world = { profile: { uid, email: email || null, demo: kind === "demo" }, sessions: new Map(), feeds: new Set(), rotation: 0, github: null, nextPull: 41, approvals: [], setups: new Map(), checks: new Map(), secrets: new Map(), defaults: new Map(), screenshotsEnabled: new Map(MOCK_SCREENSHOTS.map((id) => [id, realNow() - 3 * 24 * HOUR])), names: new Map(), account: { defaults: null, servers: new Map(), secrets: new Map() }, spent: new Map(Object.entries(MOCK_SPENT)), created: new Map() };
			// Whoever signed in with ChatGPT starts connected; the demo user connects by hand. A choice made since is kept.
			const kept = recall(`wlp.mock.github.${uid}`);
			if (githubOn && (kept === "1" || (kept === null && kind === "chatgpt"))) world.github = connectionFor(world.profile);
			worlds.set(uid, world);
			seed(world);
			// The items, each with its agent session, are there with the agents (`seedItemSession`).
			items.prepare(auth);
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
		if (!repository) return { repository: null, pullRequest: null, branch: "", changes: null, draft: { title: "", body: "" }, blocked: null, pushed: null };
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
			pushed: session.pushedHead,
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

	const profileOf = (session: MockSession): SandboxProfile => session.machine?.profile ?? profiles.find((profile) => profile.id === session.summary.profile) ?? (MOCK_PROFILES[0] as SandboxProfile);

	const listOf = (world: World): SessionSummary[] => listedSessions([...world.sessions.values()].map((session) => session.summary)).sort((a, b) => b.createdAt - a.createdAt);

	function setSummary(world: World, session: MockSession, patch: Partial<SessionSummary>): void {
		session.summary = { ...session.summary, ...patch };
		for (const feed of session.feeds) feed.onSummary(session.summary);
		const list = listOf(world);
		for (const feed of world.feeds) feed.onSessions(list);
		// A sandbox that starts or stops changes what is held and kept.
		if (clock === null && (patch.sandbox !== undefined || patch.status !== undefined)) for (const feed of world.feeds) feed.onUsage?.(usageNumbers(world));
	}

	// ---- sandbox time and kept sandboxes --------------------------------------------------------

	/** What the day's state adds to the seeded time, so that "low" leaves fourteen minutes and "used" nothing. */
	function usageOffset(world: World, held: number): number {
		if (usageState !== "low" && usageState !== "used") return 0;
		let spent = 0;
		for (const seconds of world.spent.values()) spent += seconds;
		return Math.max(0, MOCK_ALLOWANCE_SECONDS - held - spent - (usageState === "low" ? 14 * 60 : 0));
	}

	// The day's time and the cap on kept sandboxes are the platform's own sandboxes': one on the user's machine is in neither.
	const runningSandboxes = (world: World) => [...world.sessions.values()].filter((session) => session.summary.place.kind === "hosted" && session.summary.sandbox === "running");
	const keptSandboxes = (world: World) => [...world.sessions.values()].filter((session) => session.summary.place.kind === "hosted" && session.summary.sandbox !== "none");

	function usageNumbers(world: World): UsageNumbers {
		const at = realNow();
		const held = runningSandboxes(world).length * MOCK_HOLD_SECONDS;
		let used = usageOffset(world, held);
		for (const seconds of world.spent.values()) used += seconds;
		const day = Math.floor(at / 86_400_000);
		return {
			at,
			day: new Date(day * 86_400_000).toISOString().slice(0, 10),
			resetsAt: (day + 1) * 86_400_000,
			allowanceSeconds: MOCK_ALLOWANCE_SECONDS,
			usedSeconds: used,
			heldSeconds: held,
			leftSeconds: Math.max(0, MOCK_ALLOWANCE_SECONDS - used - held),
			startSeconds: MOCK_START_SECONDS,
			sandboxes: { kept: keptSandboxes(world).length, limit: usageState === "full" ? Math.min(MOCK_MAX_KEPT, keptSandboxes(world).length) : MOCK_MAX_KEPT },
		};
	}

	function usageView(world: World): UsageView {
		const numbers = usageNumbers(world);
		const offset = usageOffset(world, numbers.heldSeconds);
		const today = [...world.sessions.values()]
			.map((session) => ({
				sessionId: session.summary.id,
				title: session.summary.title,
				// What the day's state adds is the busiest agent's.
				seconds: (world.spent.get(session.summary.id) ?? 0) + (session.summary.id === "add-test" ? offset : 0),
				unreportedSeconds: MOCK_UNREPORTED[session.summary.id] ?? 0,
				heldSeconds: session.summary.place.kind === "hosted" && session.summary.sandbox === "running" ? MOCK_HOLD_SECONDS : 0,
			}))
			.filter((row) => row.seconds > 0 || row.heldSeconds > 0)
			.sort((a, b) => b.seconds + b.heldSeconds - (a.seconds + a.heldSeconds));
		const firstDay = Math.floor(numbers.at / 86_400_000) - MOCK_HISTORY.length;
		return {
			...numbers,
			today,
			days: [...MOCK_HISTORY.map((seconds, index) => ({ day: new Date((firstDay + index) * 86_400_000).toISOString().slice(0, 10), seconds })), { day: numbers.day, seconds: numbers.usedSeconds }],
			kept: keptSandboxes(world)
				.map((session) => ({
					sessionId: session.summary.id,
					title: session.summary.title,
					state: session.summary.sandbox === "running" ? ("running" as const) : ("paused" as const),
					usedAt: session.summary.updatedAt,
					busy: session.summary.status !== "idle",
					repository: session.summary.repository ? `${session.summary.repository.owner}/${session.summary.repository.name}` : null,
					pushed: session.pushed,
				}))
				.sort((a, b) => b.usedAt - a.usedAt),
			price: MOCK_PRICE,
			memory: "copied",
		};
	}

	/**
	 * A seeded work item's own agent session, as the server makes one for every item
	 * (`SessionSummary.item`): titled as the item, on its repository and its place, with one turn
	 * played for an item that has run. Only the sandbox of an item at work is kept, and only those
	 * counted sandbox time today, so that the agents' own figures stay as they were seeded.
	 */
	function seedItemSession(auth: AuthResult, item: ItemView): string {
		const world = worldOf(auth);
		const id = `item-${item.id.slice(3)}`;
		clock = item.createdAt;
		const session = addSession(world, { id, title: item.title, titled: true, profile: "docker-windlass-sandbox", model: MODELS[0] as string, repoUrl: null, repository: githubOn ? item.repository : undefined });
		if (item.place.kind === "machine") {
			const { machineId } = item.place;
			const machine = machinesOf(auth).list.find((one) => one.machineId === machineId);
			const profile = machine?.profiles.find((one) => one.available) ?? (profiles[0] as SandboxProfile);
			session.summary = { ...session.summary, place: { kind: "machine", machineId } };
			session.machine = { profile, reach: machine ? null : { state: "removed", since: item.updatedAt } };
		}
		clock = null;
		const working = item.run?.step.turn === "started" && item.run.step.kind !== "review";
		if (item.reviewerSessionId) {
			const reviewer = addSession(world, { id: item.reviewerSessionId, title: item.title, titled: true, profile: session.summary.profile, model: session.summary.model, repoUrl: null, repository: session.summary.repository });
			const running = item.review?.state === "running";
			reviewer.summary = { ...reviewer.summary, availableModes: [], item: { id: item.id, role: "reviewer" }, status: running ? "running" : "idle", sandbox: running ? "running" : "none" };
			const last = item.reviews.at(-1);
			if (last) {
				reviewer.seededTurn = () => {
					// As the server's: the item sends its reviewer no text, and the brief is built in the sandbox, so the first prompt has none.
					playInstantly(plan(world, reviewer, { text: "" }, SCRIPTS.parallel), last.at);
					if (reviewer.pauseTimer !== null) cancel(reviewer.pauseTimer);
					reviewer.pauseTimer = null;
					reviewer.summary = { ...reviewer.summary, sandbox: "none" };
				};
			}
		}
		// The pull request the item's publish step opened is its session's, as the server's session keeps it; it is merged once the item is done.
		const pull: PullRequestInfo | null =
			item.pullRequest && session.summary.repository && item.state !== "cancelled" && item.state !== "failed"
				? { number: item.pullRequest.number, url: item.pullRequest.url, state: item.state === "done" ? "merged" : "open", title: item.title, branch: branchFor(session), base: item.repository.branch, pushedAt: item.updatedAt, verified: verifiedWords(session.verified) }
				: null;
		const settle = () => {
			if (session.pauseTimer !== null) cancel(session.pauseTimer);
			session.pauseTimer = null;
			session.summary = { ...session.summary, availableModes: [], item: { id: item.id, role: "builder" }, status: working ? "running" : "idle", sandbox: working ? "running" : "none", updatedAt: Math.max(session.summary.updatedAt, item.updatedAt), ...(pull ? { pullRequest: pull } : {}) };
		};
		settle();
		const run = item.run;
		if (run !== null && item.spent.turns > 0) {
			// What the list says of it is there at once; the turn itself is played when its page is opened.
			session.summary = { ...session.summary, turns: 1, lastOutcome: "succeeded" };
			session.seededTurn = () => {
				session.summary = { ...session.summary, turns: 0, lastOutcome: null };
				playInstantly(plan(world, session, { text: item.task.body || item.title }, SCRIPTS.answer), run.startedAt);
				settle();
			};
		}
		if (working && item.place.kind === "hosted") world.spent.set(id, Math.min(item.spent.hostedSeconds, 4 * 60));
		return id;
	}

	function addSession(world: World, input: { id: string; title: string; titled: boolean; profile: SessionSummary["profile"]; harness?: SessionSummary["harness"]; modes?: Pick<SessionSummary, "mode" | "availableModes">; model: string; repoUrl: string | null; repository?: SessionRepository | null; publishUnasked?: boolean }): MockSession {
		const at = now();
		const repository = input.repository ?? null;
		const session: MockSession = {
			summary: {
				id: input.id,
				title: input.title,
				place: { kind: "hosted" },
				profile: input.profile,
				harness: input.harness ?? "windlass",
				...(input.modes ?? initialSessionModes(input.profile, input.harness)),
				model: input.model,
				repoUrl: repository ? `${repository.url}.git` : input.repoUrl,
				...(repository ? { repository, pullRequest: null, publishUnasked: input.publishUnasked === true } : {}),
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
			submissions: new Map(),
			servers: [],
			pushed: false,
			pushedHead: null,
			verified: null,
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
			const delta: WindlassDelta = { turn, event };
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
		// A subagent's event is its own session's, written now too.
		if (copy.type === "child.event" && typeof copy.event === "object" && copy.event !== null) (copy.event as WindlassEvent).time = now();
		return copy;
	}

	/**
	 * The repository's setup command in the new sandbox: its starting item, what it prints, its ending
	 * item. A command with the word "fail" in it ends with exit code 1, so both endings can be looked at.
	 */
	function setupSteps(session: MockSession, turn: number, command: string): Step[] {
		const id = `su_${hex(6)}`;
		const fails = /\bfail/.test(command);
		const lines = fails ? ["npm warn deprecated glob@7.2.3", "npm error code E404", "npm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fcharts", "npm error A complete log of this run can be found in: /tmp/.cache/npm/_logs/debug-0.log"] : ["added 412 packages in 9s", "", "61 packages are looking for funding", "  run `npm fund` for details"];
		const item = { turn, kind: "setup" as const, id, command, limitMs: MOCK_SETUP_LIMIT_MS };
		let startedAt = 0;
		const steps: Step[] = [
			{
				wait: 500,
				run: () => {
					startedAt = now();
					store(session, { ...item, state: "started", exitCode: null, durationMs: null, output: "", truncated: false });
				},
			},
		];
		for (const line of lines) {
			steps.push({
				wait: 700,
				run: () => {
					const delta: WindlassDelta = { turn, event: { type: "setup.output", id, text: `${line}\n` } };
					session.pending.push(delta);
					for (const feed of session.feeds) feed.onDelta(delta);
				},
			});
		}
		steps.push({
			wait: 600,
			run: () => {
				session.pending = session.pending.filter((delta) => !("event" in delta && delta.event.type === "setup.output" && delta.event.id === id));
				store(session, { ...item, state: fails ? "failed" : "succeeded", exitCode: fails ? 1 : 0, durationMs: Math.max(0, now() - startedAt), output: `${lines.join("\n")}\n`, truncated: false });
			},
		});
		return steps;
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
		if (script.unreachable && script.platformFailure !== undefined) {
			const message = script.platformFailure;
			steps.push({ wait: 400, run: () => finish(world, session, { outcome: "error", exitCode: null, steps: null, usage: null, cachedShare: null, message }) });
			return steps;
		}
		if (session.summary.sandbox === "none") {
			steps.push({ wait: 350, run: () => store(session, { turn, kind: "platform", level: "info", text: `Creating sandbox: ${profileOf(session).name}` }) });
			if (session.summary.repoUrl !== null) {
				const repoUrl = session.summary.repoUrl;
				const picked = session.summary.repository;
				const what = picked ? `${picked.owner}/${picked.name} at ${picked.branch}` : repoUrl;
				steps.push({ wait: 900, run: () => store(session, { turn, kind: "platform", level: "info", text: `Cloning ${what}` }) });
				const setup = picked ? world.setups.get(picked.id) : undefined;
				if (setup) steps.push(...setupSteps(session, turn, setup.command));
			}
		} else if (session.summary.sandbox === "paused") {
			steps.push({ wait: 350, run: () => store(session, { turn, kind: "platform", level: "info", text: "Resuming the paused sandbox" }) });
		}
		steps.push({
			wait: 700,
			run: () => {
				if (first && script.platformFailure === undefined) session.windlassSessionId = `ses_${hex(24)}`;
				setSummary(world, session, { status: "running", sandbox: "running" });
				// Windlass starts the user's own MCP servers with the turn, as they are saved now.
				if (script.platformFailure === undefined) knowPersonal(world, session);
			},
		});

		if (script.platformFailure !== undefined) {
			const message = script.platformFailure;
			steps.push({ wait: 2600, run: () => store(session, { turn, kind: "platform", level: "error", text: "The sandbox stopped answering." }) });
			steps.push({ wait: 400, run: () => finish(world, session, { outcome: "error", exitCode: null, steps: null, usage: null, cachedShare: null, message }) });
			return steps;
		}

		// Windlass writes `session.created` and freezes its prompt once per session, not once per run.
		// The platform's own tools are offered only on a repository of the GitHub connection.
		const events = script.events.filter((event) => (first || (event.type !== "session.created" && event.type !== "baseline.set")) && (session.summary.repository || !isHostEvent(event)));
		const server = script.server;
		if (server && !server.late) {
			// What waits is asked about before Windlass gets the prompt: the turn's events follow the answer.
			steps.push({ wait: 500, run: () => askServer(world, session, turn, server, true, () => play(session, eventSteps(world, session, turn, events, input, script))) });
			return steps;
		}
		steps.push(...eventSteps(world, session, turn, events, input, script));
		return steps;
	}

	/**
	 * The platform answers a call of its `push` or `fetch_base`, as agent-session.ts `agentPush` and
	 * `agentFetchBase` do: its line in the timeline, then the call settles with what the agent is told.
	 * The push goes to the session's own branch, or is refused when the call names another; nobody is
	 * asked. It commits what the turn changed, so nothing differs from the last commit afterwards.
	 */
	function hostCall(world: World, session: MockSession, turn: number, event: WindlassEvent, prompt: string): void {
		const data = event.data ?? {};
		const repository = session.summary.repository;
		const say = (level: "info" | "warn", text: string) => store(session, { turn, kind: "platform", level, text });
		let output: string;
		if (!repository) {
			output = data.tool === "push" ? "Not pushed. This session has no repository of the user's GitHub connection to push to." : "Not fetched. This session has no repository of the user's GitHub connection.";
		} else if (data.tool === "fetch_base") {
			const base = repository.branch;
			say("info", `Fetched ${base} from GitHub into the workspace as origin/${base}, as the agent asked.`);
			output = `Fetched ${base} from GitHub into the workspace as origin/${base}. Rebase onto it (git rebase origin/${base}) or merge it, then call push.`;
		} else {
			const branch = session.summary.pullRequest?.branch ?? branchFor(session);
			const named = typeof data.branch === "string" ? data.branch.trim() : "";
			const changed = new Set([...session.files.keys(), ...(Array.isArray(data.changed) ? data.changed.map(String) : [])]);
			if (named !== "" && named !== branch) {
				say("warn", `The agent asked to push to ${JSON.stringify(named)}, which is not this session's branch (${branch}), so nothing was pushed.`);
				output = `Not pushed. This session's work can only go to the session's own branch, ${branch}; a request that names another branch is refused. Call the tool again without a branch.`;
			} else if (changed.size === 0 && session.pushedHead !== null) {
				say("info", `The agent asked to push; ${branch} at GitHub already had everything in the workspace.`);
				output = `Nothing to push: ${branch} at GitHub already has everything in the workspace.`;
			} else {
				const head = hex(40);
				session.files.clear();
				session.pushed = true;
				session.pushedHead = head;
				const current = session.summary.pullRequest ?? null;
				const open = current !== null && (current.state === "open" || current.state === "draft") ? { ...current, pushedAt: now(), verified: verifiedWords(session.verified) } : null;
				if (open) setSummary(world, session, { pullRequest: open, updatedAt: now() });
				say("info", `The agent pushed its work to ${branch} (${head.slice(0, 7)}).${open ? ` Pull request #${open.number} shows it; its description reports: ${open.verified}.` : ""}`);
				const files = changed.size === 0 ? " Nothing was uncommitted: your own commits went as they were." : ` The platform's commit holds ${changed.size === 1 ? "1 file" : `${changed.size} files`}.`;
				output = `Pushed to ${branch} (${head.slice(0, 7)}).${files}${open ? ` Pull request #${open.number} shows it: ${open.url}` : " No pull request was opened."}`;
			}
		}
		const settled: WindlassEvent = { type: "tool.settled", v: 1, seq: 0, data: { messageId: data.messageId, callId: data.callId, outcome: "success", output, truncation: null, attachments: [], display: null } };
		emit(session, turn, restamp(session, turn, settled, prompt));
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
			if (event.type === MOCK_HOST_CALL) return { wait, settles: key, run: () => hostCall(world, session, turn, event, input.text) };
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
	function windlassEvent(session: MockSession, type: string, data: Record<string, unknown>): WindlassEvent & { seq: number } {
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
				// One of the user's own is in their settings: nothing was approved, and nothing is asked.
				if (server.origin === "user") return { ...server, approval: null };
				const named = mine.filter((approval) => approval.name === server.name);
				const approval = (server.fingerprint === null ? named[0] : named.find((one) => one.fingerprint === server.fingerprint)) ?? null;
				const earlier = approval === null ? (named[0] ?? null) : null;
				const waits = server.state === "waiting" && server.fingerprint !== null && approval === null;
				return { ...server, approval: times(approval), ...(earlier === null ? {} : { earlier: times(earlier) }), ...(waits ? { asks: mockPanelWords(server, profileOf(session), world.profile.demo, project) } : {}) };
			}),
			forgetting: MOCK_FORGETTING,
			...(session.servers.some((server) => server.origin === "user") ? { accountSecrets: mockAccountSecretsNote(profileOf(session)) } : {}),
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
				store(session, { turn, kind: "platform", level: "warn", text: `You approved ${named} for this project ${ago}, but it did not start: the environment variable ${server.unset[0]} named in its env is not set. ${mockUnsetRemedy(server.unset, mockProject(session.summary), profileOf(session))}` });
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
					store(session, { turn, kind: "platform", level: "warn", text: `Approved ${named} for this project, but it did not start: the environment variable ${server.unset[0]} named in its env is not set. ${mockUnsetRemedy(server.unset, mockProject(session.summary), profileOf(session))}` });
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

	/**
	 * What the session's work rests on after a turn, as the server would say it of a turn like the
	 * mock's: the checks saved for the session's repository that have no file patterns ran and passed
	 * when the turn ended as done; the ones with patterns did not apply; a turn that was stopped or
	 * failed ran none, and what an earlier turn’s checks came to stands.
	 */
	function verifiedAfter(world: World, session: MockSession, turn: number, outcome: TurnOutcome): Verified {
		const saved = world.checks.get(session.summary.repository?.id ?? -1)?.checks ?? [];
		const before = session.verified;
		const ran = saved.filter((check) => check.when === undefined);
		const none = { unrun: saved.map(({ name, command }) => ({ name, command })), changedAfter: before?.run != null };
		if (outcome !== "succeeded" && outcome !== "unresolved") return { turn, state: outcome === "interrupted" || outcome === "stopped" ? "stopped" : "failed", run: before?.run ?? null, ...none };
		if (saved.length === 0) return { turn, state: "none_set", run: before?.run ?? null, ...none };
		// Windlass reports why no check was needed: the turn changed files, and none that a check covers. Without a run so far, the state they are measured from is the session's start.
		if (ran.length === 0) return { turn, state: "not_needed", unneeded: { reason: "not_covered", on: before?.run == null ? "start" : null }, run: before?.run ?? null, ...none, changedAfter: before?.changedAfter ?? false };
		const failing = outcome === "unresolved";
		// A turn whose script shows the agent being sent back with a failing check says how often, as the server counts it: by the harness's own messages, each of which a model call follows in these recordings.
		const reports = session.timeline.filter((item) => item.kind === "windlass" && item.turn === turn && item.event.type === "synthetic.appended" && item.event.data?.origin === "check_report").length;
		const checks = ran.map((check, index) => ({ name: check.name, command: check.command, whose: "user" as const, required: true, status: failing && index === 0 ? ("failed" as const) : ("passed" as const), exitCode: failing && index === 0 ? 1 : 0, durationMs: 4200 + index * 1900, sentBack: index === 0 ? (failing ? Math.max(reports, 3) : reports) : 0 }));
		const finished = session.timeline.findLast((item) => item.turn === turn && item.kind === "windlass" && item.event.type === "checks.finished");
		let seq = finished?.kind === "windlass" ? finished.event.seq : undefined;
		if (seq === undefined) {
			const event = windlassEvent(session, "checks.finished", { evidence: { checks: checks.map((check) => ({ ...check, origin: "session" })) } });
			emit(session, turn, event);
			seq = event.seq;
		}
		return {
			turn,
			state: failing ? "unresolved" : "passed",
			...(failing ? { unresolved: { reason: "max_rounds" as const, said: null } } : {}),
			run: { turn, seq, at: now(), checks },
			unrun: saved.filter((check) => check.when !== undefined).map(({ name, command }) => ({ name, command })),
			changedAfter: false,
		};
	}

	/** What a pull request's description says was verified, in the server's few words (server/src/verified.ts, `verifiedWords`). */
	function verifiedWords(verified: Verified | null): string {
		const here = verified !== null && verified.run !== null && verified.run.turn === verified.turn ? verified.run.checks : [];
		const count = `${here.length} ${here.length === 1 ? "check" : "checks"}`;
		const base =
			verified === null
				? "nothing verified"
				: verified.state === "passed"
					? `${count} passed`
					: verified.state === "unresolved"
						? `${here.filter((check) => check.status !== "passed").length} of ${count} failing`
						: verified.state === "not_needed"
							? verified.unneeded.reason === "not_covered"
								? "no check covers what changed"
								: "no check was needed"
							: verified.state === "stopped" || verified.state === "failed"
								? "checks did not run"
								: "nothing verified";
		return verified?.changedAfter ? `${base}, 1 thing to look at` : base;
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
			verified: (session.verified = verifiedAfter(world, session, state.turn, end.outcome)),
		});
		// What the turn's sandbox ran is counted for the day.
		if (clock === null && session.summary.place.kind === "hosted") world.spent.set(session.summary.id, (world.spent.get(session.summary.id) ?? 0) + Math.max(1, Math.round((now() - state.startedAt) / 1000)));
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

	// ---- a Claude Code agent's turns (ACP) --------------------------------------------------------

	/**
	 * Plays a Claude Code agent's turn as the server records one (`acpRecorder`): the user's prompt, the
	 * sandbox, then each ACP update after its wait, a question where the harness asks permission, and
	 * the turn's ending with the context's fill. `answered`: the answer a seeded turn's question had,
	 * which is then not asked.
	 */
	function acpTurn(world: World, session: MockSession, input: PromptInput, script: AcpScript, answered?: string): Step[] {
		const turn = session.summary.turns + 1;
		const model = input.model ?? session.summary.model;
		const fallback = input.effort !== undefined && model !== session.summary.model && !MOCK_CLAUDE_MODELS.models.find(m => m.id === model)?.efforts.includes(input.effort);
		const steps: Step[] = [
			{
				wait: 0,
				run: () => {
					session.run = { turn, startedAt: now(), timer: null, stopping: false, executionId: null, openStep: null, steps: 0, usage: null, text: new Map(), calls: new Map(), plan: [], next: 0, steers: [], cancelled: new Set(), replaceText: null };
					const run = session.run;
					run.acp = {
						context: null,
						recorder: acpRecorder(turn, {
							key: () => `acp-${turn}-${session.seq + 1}`,
							store: (item) => store(session, item),
							live: (delta, sofar) => {
								const at = session.pending.findIndex((one) => "acp" in one && one.messageKey === sofar.messageKey);
								if (at >= 0) session.pending[at] = sofar;
								else session.pending.push(sofar);
								for (const feed of session.feeds) feed.onDelta(delta);
							},
							ended: (key) => {
								session.pending = session.pending.filter((one) => !("acp" in one && one.messageKey === key));
							},
						}),
					};
					cancel(session.pauseTimer);
					session.pauseTimer = null;
					store(session, { turn, kind: "user", text: input.text, model, effort: fallback ? null : input.effort ?? null });
					if (fallback) store(session, { turn, kind: "platform", level: "info", text: "The selected model uses its default effort." });
					const title = !session.titled && session.summary.turns === 0 ? openingWords(input.text) : session.summary.title;
					setSummary(world, session, { status: "starting", model, title, updatedAt: now() });
				},
			},
		];
		if (session.summary.sandbox === "none") steps.push({ wait: 350, run: () => store(session, { turn, kind: "platform", level: "info", text: `Creating sandbox: ${profileOf(session).name}` }) });
		else if (session.summary.sandbox === "paused") steps.push({ wait: 350, run: () => store(session, { turn, kind: "platform", level: "info", text: "Resuming the paused sandbox" }) });
		steps.push({
			wait: 700,
			run: () => {
				session.windlassSessionId ??= `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
				setSummary(world, session, { status: "running", sandbox: "running" });
			},
		});
		steps.push(...acpSteps(world, session, turn, script.entries, script.stopReason, answered));
		return steps;
	}

	/** The steps of a run of ACP entries; at a question the rest waits for its answer, unless the turn was seeded with one. */
	function acpSteps(world: World, session: MockSession, turn: number, entries: AcpEntry[], stopReason: string, answered?: string): Step[] {
		const steps: Step[] = [];
		for (const [index, entry] of entries.entries()) {
			if ("update" in entry) {
				const update = entry.update;
				steps.push({
					wait: entry.wait,
					run: () => {
						const state = session.run?.acp;
						if (!state) return;
						const title = generatedSessionTitle(update, { typed: session.titled, item: session.summary.item });
						if (title && title !== session.summary.title) setSummary(world, session, { title });
						if (update.sessionUpdate === "usage_update" && typeof update.used === "number" && typeof update.size === "number") state.context = { used: update.used, size: update.size, cost: (update.cost as AcpContext["cost"] | undefined) ?? null };
						// Claude Code changed its own mode (leaving Plan, say): the session's follows, unless its user chose one during the turn.
						if (update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string" && !state.modeQueued && session.summary.mode !== update.currentModeId) setSummary(world, session, { mode: update.currentModeId });
						state.recorder.update(update);
						entry.then?.();
					},
				});
				continue;
			}
			const rest = entries.slice(index + 1);
			const allowed = (choice: string | undefined) => entry.ask.options.find((option) => option.optionId === choice)?.kind.startsWith("allow") === true;
			if (answered !== undefined) {
				steps.push(...acpSteps(world, session, turn, [...(allowed(answered) ? entry.allowed : entry.declined), ...rest], stopReason, answered));
				return steps;
			}
			steps.push({
				wait: entry.wait,
				run: () => {
					session.run?.acp?.recorder.flush();
					askAcp(world, session, turn, entry.ask, (choice) => play(session, [{ wait: 0, run: () => undefined }, ...acpSteps(world, session, turn, [...(allowed(choice) ? entry.allowed : entry.declined), ...rest], stopReason)]));
				},
			});
			return steps;
		}
		steps.push({ wait: 400, run: () => finishAcp(world, session, stopReason) });
		return steps;
	}

	/** Claude Code asks permission for a call (`session/request_permission`), as the server puts it to the user (server/src/sandbox/acp-harness.ts, `permission`). */
	function askAcp(world: World, session: MockSession, turn: number, ask: AcpPermission["permission"], onAnswer: (choice: string) => void): void {
		const askedAt = now();
		const title = typeof ask.toolCall.title === "string" ? ask.toolCall.title : "";
		const choices = ask.options.map((option) => ({ id: option.optionId, label: option.name, approve: option.kind.startsWith("allow"), remembers: option.kind === "allow_always" ? "for this conversation, as Claude Code keeps it" : null }));
		session.question = { id: `q_${hex(16)}`, turn, messageId: "acp", callId: ask.toolCall.toolCallId, title, subject: title, details: [], choices, subagent: null, askedAt, expiresAt: askedAt + questionTimeout };
		broadcastQuestion(session);
		setSummary(world, session, { status: "waiting", updatedAt: now() });
		session.resume = (choice) => onAnswer(choice);
		session.questionTimer = later(Math.max(0, askedAt + questionTimeout - realNow()), () => {
			const question = session.question;
			if (!question) return;
			store(session, { turn, kind: "platform", level: "warn", text: `Nobody answered within ${minutes(questionTimeout)}, so the platform declined the call.`, code: "question_expired", call: { messageId: question.messageId, callId: question.callId } });
			settle(world, session, ask.options.find((option) => option.kind === "reject_once")?.optionId ?? "reject", null);
		});
	}

	/** The turn's ending, as the server writes it for an ACP turn: the outcome from the stop reason, no gate, the context's fill. */
	function finishAcp(world: World, session: MockSession, stopReason: string): void {
		const state = session.run;
		if (!state) return;
		state.acp?.recorder.flush();
		withdraw(session);
		session.run = null;
		session.pending = [];
		const outcome = acpOutcome(stopReason);
		store(session, { turn: state.turn, kind: "turn.ended", outcome, exitCode: null, steps: null, durationMs: now() - state.startedAt, usage: null, cachedShare: null, message: null, verified: null, context: state.acp?.context ?? null });
		// Once it has run, the session has the models Claude Code listed.
		setSummary(world, session, { status: "idle", turns: state.turn, lastOutcome: outcome, updatedAt: now(), harnessModels: { ...MOCK_CLAUDE_MODELS, fetchedAt: now() } });
		if (clock === null) {
			session.pauseTimer = later(2 * MINUTE, () => {
				if (session.run !== null || session.summary.sandbox !== "running") return;
				store(session, { turn: state.turn, kind: "platform", level: "info", text: "Suspended the sandbox after 2 minutes without use; the next prompt resumes it." });
				setSummary(world, session, { sandbox: "paused" });
			});
		}
	}

	/** Stop: Claude Code is cancelled (`session/cancel`), and the turn ends as stopped. */
	function interruptAcp(world: World, session: MockSession): void {
		const state = session.run;
		if (!state || state.stopping) return;
		state.stopping = true;
		cancel(state.timer);
		withdraw(session);
		setSummary(world, session, { status: "stopping" });
		state.timer = later(500, () => {
			// The answer so far is kept, as the recorder stores it.
			state.stopping = false;
			finishAcp(world, session, "cancelled");
		});
	}

	/** What a Claude Code agent does for a prompt: a recorded scenario when the prompt names one, otherwise a small piece of work on the README. */
	function claudeScript(session: MockSession, text: string): AcpScript {
		const named = ACP_SCENARIOS.find((name) => new RegExp(`\\b${name}\\b`, "i").test(text));
		return named ? fixtureScript(acpFixture(`acp-claude-${named}`)) : workScript(session);
	}

	/**
	 * The README piece of work, from the recorded scenarios' parts: the plan scenario's plan, the plain
	 * scenario's thinking, the permission the ask scenario asks, around a read, an edit with its diff,
	 * and the tests. The edit changes the workspace, as the side panel then lists.
	 */
	function workScript(session: MockSession): AcpScript {
		const plain = acpFixture("acp-claude-plain").updates.filter((entry): entry is AcpUpdate => !isPermission(entry) && entry.sessionUpdate === "agent_thought_chunk");
		const plans = acpFixture("acp-claude-plan").updates.filter((entry): entry is AcpUpdate => !isPermission(entry));
		const ask = acpFixture("acp-claude-ask").updates.find(isPermission)?.permission.options ?? [];
		const ids = { read: `toolu_${hex(12)}`, edit: `toolu_${hex(12)}`, test: `toolu_${hex(12)}` };
		const chunks = (kind: "agent_message_chunk" | "agent_thought_chunk", text: string): AcpEntry[] => text.split(/(?<= )/).map((part) => ({ wait: 70, update: { sessionUpdate: kind, content: { type: "text", text: part } } }));
		const tool = (wait: number, update: Record<string, unknown>): AcpEntry => ({ wait, update: update as AcpUpdate });
		const readme = "# tide-tables\n\nTide tables for the harbour, as JSON.\n\n## Use\n\nnpm install\nnpm start\n";
		const changed = readme.replace("npm start\n", "npm start\n\n## Tests\n\nRun them with `npm test`.\n");
		const diff = unifiedDiff("/workspace/README.md", readme, changed);
		return {
			stopReason: "end_turn",
			entries: [
				...plain.map((update) => ({ wait: 90, update })),
				tool(200, { sessionUpdate: "session_info_update", title: "Document the README test command" }),
				{ wait: 400, update: plans[0] as AcpUpdate },
				tool(500, { sessionUpdate: "tool_call", toolCallId: ids.read, title: "Read README.md", kind: "read", status: "pending", rawInput: { file_path: "/workspace/README.md" } }),
				tool(300, { sessionUpdate: "tool_call_update", toolCallId: ids.read, status: "in_progress" }),
				tool(700, { sessionUpdate: "tool_call_update", toolCallId: ids.read, status: "completed", content: [{ type: "content", content: { type: "text", text: readme } }] }),
				{ wait: 300, update: plans[1] as AcpUpdate },
				tool(600, { sessionUpdate: "tool_call", toolCallId: ids.edit, title: "Edit README.md", kind: "edit", status: "pending", rawInput: { file_path: "/workspace/README.md", old_string: "npm start\n", new_string: "npm start\n\n## Tests\n\nRun them with `npm test`.\n" }, content: [{ type: "diff", path: "/workspace/README.md", oldText: readme, newText: changed }] }),
				tool(400, { sessionUpdate: "tool_call_update", toolCallId: ids.edit, status: "in_progress" }),
				{ ...tool(500, { sessionUpdate: "tool_call_update", toolCallId: ids.edit, status: "completed" }), then: () => session.files.set("README.md", { status: "M", diff }) },
				{ wait: 300, update: plans[2] as AcpUpdate },
				tool(500, { sessionUpdate: "tool_call", toolCallId: ids.test, title: "npm test", kind: "execute", status: "pending", rawInput: { command: "npm test", description: "Run the tests" } }),
				{
					wait: 300,
					ask: { toolCall: { toolCallId: ids.test, title: "npm test", kind: "execute" }, options: ask },
					allowed: [
						tool(300, { sessionUpdate: "tool_call_update", toolCallId: ids.test, status: "in_progress", content: [{ type: "content", content: { type: "text", text: "> tide-tables@1.4.0 test\n> node --test\n" } }] }),
						tool(2600, { sessionUpdate: "tool_call_update", toolCallId: ids.test, status: "in_progress", content: [{ type: "content", content: { type: "text", text: "> tide-tables@1.4.0 test\n> node --test\n\n✔ reads a day of tides (4ms)\n✔ rounds heights to the centimetre (1ms)\nℹ tests 12\nℹ pass 12\nℹ fail 0\n" } }] }),
						tool(400, { sessionUpdate: "tool_call_update", toolCallId: ids.test, status: "completed" }),
						{ wait: 300, update: plans[3] as AcpUpdate },
						{ wait: 200, update: { sessionUpdate: "usage_update", used: 82_000, size: 200_000, cost: { amount: 0.38, currency: "USD" } } },
						...chunks("agent_message_chunk", "I added a Tests section to the README saying the tests run with `npm test`, and ran them: all 12 pass."),
					],
					declined: [
						tool(300, { sessionUpdate: "tool_call_update", toolCallId: ids.test, status: "failed", content: [{ type: "content", content: { type: "text", text: "The user declined this command." } }] }),
						{ wait: 200, update: { sessionUpdate: "usage_update", used: 64_000, size: 200_000, cost: { amount: 0.29, currency: "USD" } } },
						...chunks("agent_message_chunk", "I added a Tests section to the README saying the tests run with `npm test`. I did not run them, since you declined the command."),
					],
				},
			],
		};
	}

	/** A recorded scenario as it was sent, a little slower than the fake agent sends it. */
	function fixtureScript(recorded: ReturnType<typeof acpFixture>): AcpScript {
		const entries: AcpEntry[] = recorded.updates.map((entry) => (isPermission(entry) ? { wait: 300, ask: entry.permission, allowed: [], declined: [] } : { wait: entry.sessionUpdate.endsWith("_chunk") ? 90 : 500, update: entry }));
		return { entries, stopReason: recorded.stopReason };
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
			extra: { repoUrl?: string; sandbox?: SessionSummary["sandbox"]; model?: string; repository?: SessionRepository; pull?: Pick<PullRequestInfo, "number" | "state"> & { hoursAgo: number; clean?: boolean }; machine?: NonNullable<MockSession["machine"]> & { machineId: string } } = {},
		): MockSession => {
			clock = start - ago;
			const session = addSession(world, { id, title, titled: true, profile, model: extra.model ?? (MODELS[0] as string), repoUrl: extra.repoUrl ?? null, repository: githubOn ? extra.repository : undefined });
			if (extra.machine) {
				// Before its turns play: they say which sandbox they ran in.
				session.summary = { ...session.summary, place: { kind: "machine", machineId: extra.machine.machineId } };
				session.machine = { profile: extra.machine.profile, reach: extra.machine.reach };
			}
			let at = start - ago;
			for (const turn of turns) {
				const steps = plan(world, session, { text: turn.text, effort: turn.effort }, SCRIPTS[turn.script]);
				playInstantly(steps, at);
				at = (session.timeline.at(-1)?.at ?? at) + 40_000;
			}
			clock = null;
			if (session.pauseTimer !== null) cancel(session.pauseTimer);
			const sandbox = extra.sandbox ?? (turns.length === 0 ? "none" : "paused");
			session.summary = { ...session.summary, sandbox };
			const repository = session.summary.repository;
			if (repository && extra.pull) {
				// Pushed earlier: the pull request is there, and what was pushed then no longer differs from the last commit.
				const branch = branchFor(session);
				const pushedAt = start - extra.pull.hoursAgo * HOUR;
				session.pushed = true;
				session.pushedHead = hex(40);
				const verified = verifiedWords(session.verified);
				session.summary = { ...session.summary, pullRequest: { number: extra.pull.number, url: `${repository.url}/pull/${extra.pull.number}`, state: extra.pull.state, title, branch, base: repository.branch, pushedAt, verified } };
				if (extra.pull.clean) session.files.clear();
				session.timeline.push({ seq: ++session.seq, at: pushedAt, turn: session.summary.turns, kind: "platform", level: "info", text: `Opened pull request #${extra.pull.number} in ${repository.owner}/${repository.name} from ${branch}, with 1 file. Its description reports: ${verified}.` });
			}
			return session;
		};

		// Checks are saved for acme/harbor, before its agents' turns are played: each turn's closing item says what they came to. One of them
		// has file patterns, and so does not apply to what the mock's turns change.
		world.checks.set(7101, {
			checks: [
				{ name: "test", command: "npm test" },
				{ name: "types", command: "npm run typecheck", when: ["src/**/*.ts"], timeoutSeconds: 300 },
			],
			updatedAt: start - 3 * 24 * HOUR - 40 * MINUTE,
		});
		history("scratch", "New agent", "docker-windlass-sandbox", 5 * 24 * HOUR, []).titled = false;
		history("deps", "Upgrade the dependencies", "docker-hardened", 3 * 24 * HOUR, [{ text: "Upgrade the dependencies to their latest minor versions and crash if anything breaks.", script: "crash" }], { sandbox: "none", repoUrl: "https://github.com/acme/harbor.git" });
		history("suite", "Run the whole test suite", "docker-windlass-sandbox", 2 * 24 * HOUR, [{ text: "Run the whole test suite and fix the failing test.", script: "cancelled", effort: "medium" }]);
		history("changelog", "Tidy the changelog", "docker-windlass-sandbox", 26 * HOUR, [{ text: "Tidy the changelog for the release.", script: "usageLimit" }], { model: MODELS[1], repository: sessionRepository("acme", "lighthouse-docs"), pull: { number: 7, state: "merged", hoursAgo: 25, clean: true } });
		history("checks", "Make add() pass its checks", "docker-windlass-sandbox", 21 * HOUR, [{ text: "Fix the failing test.", script: "checks", effort: "high" }], {
			repository: sessionRepository("acme", "harbor", "release/2.4"),
			pull: { number: 38, state: "open", hoursAgo: 20 },
		});
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

		// Three agents that pushed their own branch, or asked to, on acme/signal-flags: one pushed with no pull request open,
		// so "Open pull request" opens one from what is there; one pushed and then changed more; one named main, and was refused.
		history("agent-pushed", "Fix add() and push the branch", "docker-windlass-sandbox", 50 * MINUTE, [{ text: "The add test is failing. Fix it, bring in what changed on main, and push.", script: "agentPush", effort: "low" }], { repository: sessionRepository("acme", "signal-flags") });
		history(
			"agent-pushed-more",
			"Push the fix, then add a test",
			"docker-windlass-sandbox",
			75 * MINUTE,
			[
				{ text: "The add test is failing. Fix it and push.", script: "agentPush", effort: "low" },
				{ text: "Add a test for adding zero.", script: "steps" },
			],
			{ repository: sessionRepository("acme", "signal-flags") },
		);
		history("push-refused", "Fix add() and push it to main", "docker-windlass-sandbox", 90 * MINUTE, [{ text: "The add test is failing. Fix it and push it to main.", script: "agentPushRefused", effort: "low" }], { repository: sessionRepository("acme", "signal-flags") });

		// One agent waits on a question when the user arrives: it asked half a minute ago.
		const asking = history("headers", "Check the site's response headers", "docker-windlass-sandbox", 14 * MINUTE, [{ text: "What is 1 + 1, to be sure?", script: "answer" }], { sandbox: "running" });
		playInstantly(plan(world, asking, { text: "Fetch the response headers of example.com and tell me what server it runs.", effort: "low" }, SCRIPTS.network), start - 30_000);
		clock = null;

		// One agent is at work when the user arrives: a second turn, a long build, played slowly.
		const building = history("harbor-build", "Check the release build", "docker-windlass-sandbox", 6 * MINUTE, [{ text: "Fix the failing test.", script: "steps" }], { sandbox: "running", repoUrl: "https://github.com/acme/harbor.git", repository: sessionRepository("acme", "harbor") });
		play(building, plan(world, building, { text: "Run the full build and the tests, and tell me if they pass.", effort: "medium" }, { ...SCRIPTS.build, stretch: 7 }));

		// One agent on the user's machine "nas", which finds it as `?machineSession=` says; when its machine was removed, it was another one.
		if (machineSessionSeeded) {
			const removed = machineSession === "removed";
			const reach: NonNullable<MockSession["machine"]>["reach"] = removed ? { state: "removed", since: start - 2 * HOUR } : { state: "answering", since: start - 25 * MINUTE };
			const machine = { machineId: removed ? "m_old" : "m_nas", profile: mockMachineProfiles(removed ? "old-laptop" : "nas")[0] as SandboxProfile, reach };
			const onNas = history("nas-tests", "Run the tests on my machine", "docker-windlass-sandbox", 25 * MINUTE, [{ text: "The add test is failing. Find out why and fix it.", script: "fix", effort: "low" }], { sandbox: machineSession === "answering" ? "running" : "paused", machine });
			// A turn under way, which waits for the machine while it does not answer (`blipMachine`).
			if (machineSession === "not_answering") {
				onNas.summary = { ...onNas.summary, sandbox: "running" };
				play(onNas, plan(world, onNas, { text: "Run the full build and the tests, and tell me if they pass.", effort: "medium" }, { ...SCRIPTS.build, stretch: 40 }));
			}
		}

		// A Claude Code agent on "nas", which offers it: one turn that read, edited and tested, with a plan, and asked before the tests.
		if (machineSessionSeeded && machineSession !== "removed") {
			clock = start - 12 * MINUTE;
			const claude = addSession(world, { id: "nas-claude", title: "Add the test command to the README", titled: true, profile: "docker-hardened", harness: "claude", modes: { mode: "auto", availableModes: [...CLAUDE_LAUNCH_MODES] }, model: "default", repoUrl: null });
			claude.summary = { ...claude.summary, place: { kind: "machine", machineId: "m_nas" }, harnessModels: null };
			claude.machine = { profile: mockMachineProfiles("nas")[1] as SandboxProfile, reach: { state: "answering", since: start - 12 * MINUTE } };
			playInstantly(acpTurn(world, claude, { text: "Read the README and add a line to it saying what the tests command is; run the tests." }, workScript(claude), "allow-once"), start - 12 * MINUTE);
			clock = null;
			if (claude.pauseTimer !== null) cancel(claude.pauseTimer);
			claude.summary = { ...claude.summary, sandbox: "paused" };
		}

		// The user saved a setup command for acme/harbor some days ago: the launch form and the panel show it.
		world.setups.set(7101, { command: "npm ci", updatedAt: start - 3 * 24 * HOUR - 50 * MINUTE });
		// And four secrets: each scope under a name that looks like a credential and under one that does not, covering both kinds of names.
		world.secrets.set(
			7101,
			new Map([
				["NPM_TOKEN", { scope: "setup" as const, updatedAt: start - 3 * 24 * HOUR - 48 * MINUTE }],
				["SENTRY_DSN", { scope: "setup" as const, updatedAt: start - 26 * HOUR }],
				["DEPLOY_KEY", { scope: "agent" as const, updatedAt: start - 5 * HOUR }],
				["PREVIEW_HOST", { scope: "agent" as const, updatedAt: start - 40 * MINUTE }],
			]),
		);

		if (githubOn) {
			// New agents on acme/harbor start in the hardened container, on the second model: the launch form shows both once it is picked.
			world.defaults.set(7101, { profile: "docker-hardened", model: MODELS[1] as string, updatedAt: start - 2 * 24 * HOUR });
			// ada/tide-tables has a default model this deployment stopped offering: its page says so, and the launch form leaves it out.
			world.defaults.set(7102, { profile: null, model: "gpt-5.5-terra", updatedAt: start - 40 * 24 * HOUR });
			// acme/quay has a secret and no agent: the list of agents names it under the groups.
			world.secrets.set(7105, new Map([["QUAY_TOKEN", { scope: "setup" as const, updatedAt: start - 6 * 24 * HOUR }]]));
			world.names.set(7105, "acme/quay");
			// acme/old-pier is no longer among the repositories the connection covers. What was saved for it is still there.
			world.setups.set(7190, { command: "make deps", updatedAt: start - 60 * 24 * HOUR });
			world.secrets.set(7190, new Map([["PIER_KEY", { scope: "agent" as const, updatedAt: start - 60 * 24 * HOUR }]]));
			world.approvals.push({ project: "github:7190", name: "tides", fingerprint: "5b0c6a19d2e7f384", approvedAt: start - 12 * 24 * HOUR, expiresAt: start - 12 * 24 * HOUR + APPROVAL_MS });
			world.names.set(7190, "acme/old-pier");
		}

		// What the user keeps for their account: two MCP servers of their own, and two secrets. One server reads a secret
		// that is saved and runs; the other reads one that is not, and does not start. DEPLOY_KEY is a name acme/harbor has
		// a secret of its own for, so there the repository's is used.
		if (options.account === "seeded") {
			world.account.servers.set("issues", { definition: { command: "npx", args: ["-y", "@acme/issues-mcp", "--stdio"], env: { ISSUES_TOKEN: "${ISSUES_TOKEN}" } }, unasked: true, updatedAt: start - 9 * 24 * HOUR });
			world.account.servers.set("wiki", { definition: { url: "https://wiki.acme.example/mcp", headers: { Authorization: "Bearer ${WIKI_TOKEN}" } }, unasked: false, updatedAt: start - 2 * 24 * HOUR });
			world.account.secrets.set("ISSUES_TOKEN", { scope: "agent", updatedAt: start - 9 * 24 * HOUR });
			world.account.secrets.set("DEPLOY_KEY", { scope: "setup", updatedAt: start - 30 * 24 * HOUR });
			// The sessions that have a sandbox had a turn since: their panels list the servers as that turn found them.
			for (const session of world.sessions.values()) if (session.summary.sandbox !== "none" && session.summary.turns > 0) knowPersonal(world, session);
		}

		// acme/harbor names MCP servers. The user approved "harbor" three days ago in one session, so the other
		// started it unasked; "docs" was left for later, and "tracker" was approved and could not start.
		const checks = world.sessions.get("checks");
		/** The user's own servers a session already knows of: they stand after its project's. */
		const own = (session: MockSession) => session.servers.filter((server) => server.origin === "user");
		if (checks) {
			const project = mockProject(checks.summary).key;
			const approvedAt = start - 3 * 24 * HOUR - 40 * MINUTE;
			const harbor: MockKnown = { name: "harbor", subject: "python3 tools/harbor_mcp.py", remote: false, file: SERVER_FILE, state: "running", tools: 2, reason: null, fingerprint: "81498df752b8ef7d", at: start - 21 * HOUR };
			world.approvals.push({ project, name: "harbor", fingerprint: "81498df752b8ef7d", approvedAt, expiresAt: approvedAt + APPROVAL_MS });
			world.approvals.push({ project, name: "tracker", fingerprint: "c07b1e5a94d3f268", approvedAt: start - 21 * HOUR, expiresAt: start - 21 * HOUR + APPROVAL_MS });
			checks.startedServers.add("81498df752b8ef7d");
			const mine = own(checks);
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
			checks.servers.push(...mine);
			checks.summary = { ...checks.summary, servers: { count: checks.servers.length, changedAt: start - 21 * HOUR } };
			// Launched on the same repository through the connection: the same project, and so the same approval.
			if (mockProject(building.summary).key === project) {
				building.startedServers.add("81498df752b8ef7d");
				building.servers = [{ ...harbor, at: start - 6 * MINUTE }, ...own(building)];
				building.summary = { ...building.summary, servers: { count: building.servers.length, changedAt: start - 6 * MINUTE } };
			}
		}
	}

	// ---- setup commands of repositories -----------------------------------------------------------

	function setupOf(world: World, repositoryId: GithubId): RepositorySetup {
		const saved = world.setups.get(repositoryId);
		return { command: saved?.command ?? "", updatedAt: saved?.updatedAt ?? null, timeoutMs: MOCK_SETUP_LIMIT_MS };
	}

	function saveSetup(world: World, repositoryId: GithubId, raw: string): RepositorySetup {
		const command = raw.replace(/\r\n?/g, "\n").trim();
		if (command.length > MAX_SETUP_COMMAND_CHARS) throw new PlatformError("user", `The setup command is ${command.length} characters long; the limit is ${MAX_SETUP_COMMAND_CHARS}. Put a longer one in a script in the repository and run that.`, { reason: "bad_setup_command" });
		if (command === "") world.setups.delete(repositoryId);
		else world.setups.set(repositoryId, { command, updatedAt: now() });
		return setupOf(world, repositoryId);
	}

	// ---- checks of repositories -------------------------------------------------------------------

	function checksOf(world: World, repositoryId: GithubId): RepositoryChecks {
		const saved = world.checks.get(repositoryId);
		return { checks: saved?.checks ?? [], updatedAt: saved?.updatedAt ?? null };
	}

	/** Saves as the server does (server/src/repository-checks.ts): the same refusals in the same words, and the list whole. */
	function saveChecks(world: World, repositoryId: GithubId, raw: RepositoryCheck[]): RepositoryChecks {
		const refuse = (message: string): never => {
			throw new PlatformError("user", message, { reason: "bad_checks" });
		};
		if (raw.length > MAX_CHECKS_PER_REPOSITORY) refuse(`A repository can have ${MAX_CHECKS_PER_REPOSITORY} checks; this list has ${raw.length}.`);
		const checks: RepositoryCheck[] = [];
		for (const [index, input] of raw.entries()) {
			const name = input.name.trim();
			const which = name === "" ? `Check ${index + 1}` : `The check "${name.slice(0, MAX_CHECK_NAME_CHARS)}"`;
			if (name === "") refuse(`${which} needs a name.`);
			if (name.length > MAX_CHECK_NAME_CHARS || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) refuse(`${which} needs a name of letters, digits, "_", "." and "-" that starts with a letter or a digit, at most ${MAX_CHECK_NAME_CHARS} characters.`);
			if (checks.some((check) => check.name === name)) refuse(`Two checks are named "${name}". Give each its own name.`);
			const command = input.command.replace(/\r\n?/g, "\n").trim();
			if (command === "") refuse(`${which} needs a command.`);
			if (command.length > MAX_SETUP_COMMAND_CHARS) refuse(`${which} has a command of ${command.length} characters; the limit is ${MAX_SETUP_COMMAND_CHARS}. Put a longer one in a script in the repository and run that.`);
			const seconds = input.timeoutSeconds;
			if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_CHECK_TIMEOUT_SECONDS)) refuse(`${which} may run for 1 to ${MAX_CHECK_TIMEOUT_SECONDS} seconds.`);
			const when = (input.when ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern !== "");
			const negated = when.find((pattern) => pattern.startsWith("!"));
			if (negated !== undefined) refuse(`${which} has the file pattern "${negated}": a pattern cannot start with "!".`);
			checks.push({ name, command, ...(seconds === undefined ? {} : { timeoutSeconds: seconds }), ...(when.length === 0 ? {} : { when }), ...(input.showOutput === true ? { showOutput: true } : {}) });
		}
		if (checks.length === 0) world.checks.delete(repositoryId);
		else world.checks.set(repositoryId, { checks, updatedAt: now() });
		return checksOf(world, repositoryId);
	}

	// ---- secrets of repositories ------------------------------------------------------------------

	function secretsOf(world: World, repositoryId: GithubId, profileId: SandboxProfileId): RepositorySecrets {
		const profile = profiles.find((item) => item.id === profileId);
		if (!profile) throw new PlatformError("user", "Choose one of the listed sandboxes.", { reason: "bad_input" });
		const saved = [...(world.secrets.get(repositoryId) ?? new Map<string, { scope: SecretScope; updatedAt: number }>()).entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		return { profile: profile.id, secrets: saved.map(([name, secret]) => ({ name, scope: secret.scope, updatedAt: secret.updatedAt, reach: mockSecretReach(secret.scope, profile), ...(world.account.secrets.has(name) ? { account: true } : {}) })) };
	}

	/** Saves as the server does (server/src/repo-secrets.ts): the same refusals in the same words. The value is looked at and dropped. */
	function saveSecret(world: World, repositoryId: GithubId, secret: { name: string; value?: string; scope: SecretScope }): void {
		const { name, scope } = secret;
		checkSecretName(name);
		if (scope !== "setup" && scope !== "agent") throw badSecret("A secret is for the setup command and MCP servers, or for the agent's commands as well.");
		const saved = world.secrets.get(repositoryId) ?? new Map<string, { scope: SecretScope; updatedAt: number }>();
		if (secret.value === undefined) {
			if (!saved.has(name)) throw new PlatformError("user", `No secret named ${name} is saved for this repository.`, { reason: "secret_not_found" });
		} else {
			checkSecretValue(secret.value);
			if (!saved.has(name) && saved.size >= MAX_SECRETS_PER_REPOSITORY) throw new PlatformError("user", `A repository can have at most ${MAX_SECRETS_PER_REPOSITORY} secrets. Delete one first.`, { reason: "too_many_secrets" });
		}
		saved.set(name, { scope, updatedAt: now() });
		world.secrets.set(repositoryId, saved);
	}

	const badSecret = (message: string) => new PlatformError("user", message, { reason: "bad_secret" });

	/** A secret's name, a repository's or the account's, as the server takes it (`cleanSecretName`). */
	function checkSecretName(name: unknown): asserts name is string {
		if (typeof name !== "string" || name === "") throw badSecret("A secret needs a name.");
		if (name.length > MAX_SECRET_NAME_CHARS) throw badSecret(`A secret's name can be at most ${MAX_SECRET_NAME_CHARS} characters long.`);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw badSecret("A secret's name is an environment variable's: letters, digits and underscores, not starting with a digit.");
		if (MOCK_RESERVED.test(name)) throw badSecret(`${name} cannot be a secret's name: the sandbox or Windlass relies on a variable of that name.`);
	}

	/** A secret's value as the server takes it (`cleanSecretValue`). It is looked at and dropped. */
	function checkSecretValue(raw: unknown): void {
		if (typeof raw !== "string") throw badSecret("A secret's value must be text.");
		const value = raw.replace(/\r\n?/g, "\n");
		if (value.trim().length < MIN_SECRET_VALUE_CHARS) throw badSecret(`A secret's value must be at least ${MIN_SECRET_VALUE_CHARS} characters long: a shorter one could not be taken out of what the platform shows.`);
		const bytes = new TextEncoder().encode(value).length;
		if (bytes > MAX_SECRET_VALUE_BYTES) throw badSecret(`A secret's value can be at most ${MAX_SECRET_VALUE_BYTES.toLocaleString("en-US")} bytes long; this one is ${bytes.toLocaleString("en-US")}.`);
	}

	// ---- a repository's page ---------------------------------------------------------------------

	/** As the server names a repository without asking GitHub: by the newest session on it, then by what was noted when something was saved. */
	function repositoryNameOf(world: World, repositoryId: GithubId): string | null {
		const newest = listOf(world).find((summary) => summary.repository?.id === repositoryId)?.repository;
		return newest ? `${newest.owner}/${newest.name}` : (world.names.get(repositoryId) ?? null);
	}

	/** As the server does when something is saved for a repository nothing names yet: GitHub is asked what it is called, where the connection covers it. */
	function nameAtSave(world: World, repositoryId: GithubId): void {
		if (repositoryNameOf(world, repositoryId) !== null || !githubOn || !world.github) return;
		const found = GITHUB_REPOSITORIES.find((repository) => repository.id === repositoryId);
		if (found) world.names.set(repositoryId, `${found.owner}/${found.name}`);
	}

	function defaultsOf(world: World, repositoryId: GithubId): RepositoryDefaults {
		const saved = world.defaults.get(repositoryId);
		const enabled = world.screenshotsEnabled.get(repositoryId);
		const updatedAt = saved || enabled !== undefined ? Math.max(saved?.updatedAt ?? 0, enabled ?? 0) : null;
		return { screenshots: enabled !== undefined, profile: saved?.profile ?? null, model: saved?.model ?? null, updatedAt };
	}

	function repositoryViewOf(world: World, repositoryId: GithubId): RepositoryView {
		const approvals = new Map<string, RepositoryApproval>();
		const mine = world.approvals.filter((approval) => approval.project === `github:${repositoryId}` && approval.expiresAt > now()).sort((a, b) => b.approvedAt - a.approvedAt);
		for (const approval of mine) {
			const listed = approvals.get(approval.name);
			if (listed) listed.definitions += 1;
			else approvals.set(approval.name, { name: approval.name, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt, definitions: 1 });
		}
		return {
			id: repositoryId,
			name: repositoryNameOf(world, repositoryId),
			defaults: defaultsOf(world, repositoryId),
			approvals: [...approvals.values()],
			forgetting: MOCK_FORGETTING,
			saved: { setup: world.setups.has(repositoryId), secrets: world.secrets.get(repositoryId)?.size ?? 0, checks: world.checks.get(repositoryId)?.checks.length ?? 0 },
		};
	}

	/** Saves as the server does (server/src/repository-defaults.ts): the same refusals in the same words, and only the fields that are named. */
	function saveDefaults(world: World, repositoryId: GithubId, { screenshots, ...change }: { screenshots?: boolean; profile?: SandboxProfileId | null; model?: string | null }): RepositoryDefaults {
		if (screenshots !== undefined && typeof screenshots !== "boolean") throw new PlatformError("user", "Screenshots must be true or false.", { reason: "bad_input" });
		const next = changedDefaults(world.defaults.get(repositoryId) ?? null, change, modelsFor(world.profile));
		if (next === null) world.defaults.delete(repositoryId);
		else world.defaults.set(repositoryId, next);
		if (screenshots === false) world.screenshotsEnabled.delete(repositoryId);
		if (screenshots === true) world.screenshotsEnabled.set(repositoryId, now());
		return defaultsOf(world, repositoryId);
	}

	/** What is saved after a change, for a repository or for the account: null when nothing is left. */
	/** The models the signed-in user may choose: the plan's as it was read when the page loaded, or the stand-in for the demo and where the address says the plan could not be read. */
	const listedAt = realNow();
	function modelsFor(profile: UserProfile): ModelList {
		if (profile.demo) return mockStandInModels("demo");
		if (options.models === "unavailable") return mockStandInModels("unavailable");
		return { source: "account", models: MOCK_PLAN.map((model) => ({ ...model, efforts: [...model.efforts] })), defaultModel: MODELS[0] as string, fetchedAt: listedAt - 12 * MINUTE };
	}
	/** A model a client named, held against the user's list as the server holds it. */
	function checkModel(models: ModelList, model: string): void {
		if (models.models.some((candidate) => candidate.id === model)) return;
		const names = models.models.map((candidate) => candidate.id).join(", ");
		throw new PlatformError("user", models.source === "account" ? `That model is not among the ones your ChatGPT plan offers. Choose one of: ${names}` : `That model is not offered. Choose one of: ${names}`, { reason: "bad_model" });
	}

	function changedDefaults(before: { profile: SandboxProfileId | null; model: string | null; updatedAt: number } | null, change: { profile?: SandboxProfileId | null; model?: string | null }, models: ModelList): { profile: SandboxProfileId | null; model: string | null; updatedAt: number } | null {
		const saved = before ?? { profile: null, model: null, updatedAt: 0 };
		const next = { ...saved };
		if (change.profile !== undefined) {
			const chosen = change.profile === null ? null : profiles.find((profile) => profile.id === change.profile);
			if (chosen === undefined) throw new PlatformError("user", "Choose one of the listed sandboxes.", { reason: "bad_input" });
			if (chosen !== null && !chosen.available) throw new PlatformError("user", `${chosen.name} cannot be chosen yet. ${chosen.unavailableReason ?? ""}`.trim(), { reason: "bad_input" });
			next.profile = chosen?.id ?? null;
		}
		if (change.model !== undefined) {
			if (change.model !== null) checkModel(models, change.model);
			next.model = change.model;
		}
		if (change.profile === undefined && change.model === undefined) return before;
		return next.profile === null && next.model === null ? null : { ...next, updatedAt: now() };
	}

	// ---- the account's settings -------------------------------------------------------------------

	function accountDefaultsOf(world: World): AccountDefaults {
		const saved = world.account.defaults;
		return { profile: saved?.profile ?? null, model: saved?.model ?? null, updatedAt: saved?.updatedAt ?? null };
	}

	function accountOf(world: World): AccountSettings {
		const servers = [...world.account.servers.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		return {
			defaults: accountDefaultsOf(world),
			servers: servers.map(([name, server]): PersonalServer => {
				const remote = typeof server.definition.url === "string";
				const argv = remote ? [] : [String(server.definition.command ?? ""), ...(Array.isArray(server.definition.args) ? server.definition.args.map(String) : [])];
				return {
					name,
					definition: server.definition,
					remote,
					subject: remote ? String(server.definition.url) : commandLine(argv),
					enabled: server.definition.enabled !== false,
					unasked: server.unasked,
					reads: mockDefinitionReads(server.definition).map((read) => ({ name: read, saved: world.account.secrets.has(read) })),
					updatedAt: server.updatedAt,
				};
			}),
			serverReach: profiles.filter((profile) => profile.available).map(mockPersonalReach),
			limits: { servers: MAX_PERSONAL_SERVERS, definitionBytes: MAX_SERVER_DEFINITION_BYTES, secrets: MAX_ACCOUNT_SECRETS },
		};
	}

	/** The account's secrets as the server lists them (server/src/account-secrets.ts): no value, what each reaches, and the repositories that have one of the name. */
	function accountSecretsOf(world: World, profileId: SandboxProfileId): AccountSecrets {
		const profile = profiles.find((candidate) => candidate.id === profileId);
		if (!profile) throw new PlatformError("user", "Choose one of the listed sandboxes.", { reason: "bad_input" });
		const saved = [...world.account.secrets.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		return {
			profile: profile.id,
			secrets: saved.map(([name, secret]) => ({
				name,
				scope: secret.scope,
				updatedAt: secret.updatedAt,
				reach: mockSecretReach(secret.scope, profile, "account"),
				repositories: [...world.secrets.entries()]
					.filter(([, secrets]) => secrets.has(name))
					.map(([id]) => repositoryNameOf(world, id) ?? `repository ${id}`)
					.sort((a, b) => a.localeCompare(b)),
			})),
		};
	}

	/**
	 * The user's own servers as a turn's Windlass starts them, kept with what the session knows of its
	 * servers: running, or failed where the definition reads a variable the turn is not handed. A
	 * variable is handed where a secret of the repository or of the account sets it and this sandbox
	 * gives that secret to MCP servers. A server the project names too is the project's.
	 */
	function knowPersonal(world: World, session: MockSession): void {
		const profile = profileOf(session);
		const repository = session.summary.repository ? world.secrets.get(session.summary.repository.id) : undefined;
		const handed = (name: string) => {
			const theirs = repository?.get(name);
			if (theirs) return mockSecretReach(theirs.scope, profile).servers;
			const mine = world.account.secrets.get(name);
			return mine !== undefined && mockSecretReach(mine.scope, profile, "account").servers;
		};
		const before = session.servers;
		const projects = before.filter((server) => server.origin !== "user");
		const own: MockKnown[] = [];
		for (const [name, server] of [...world.account.servers.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
			if (server.definition.enabled === false || projects.some((known) => known.name === name)) continue;
			const remote = typeof server.definition.url === "string";
			const unset = mockDefinitionReads(server.definition).find((read) => !handed(read));
			const argv = remote ? [] : [String(server.definition.command ?? ""), ...(Array.isArray(server.definition.args) ? server.definition.args.map(String) : [])];
			const known: MockKnown = {
				name,
				origin: "user",
				subject: remote ? String(server.definition.url) : commandLine(argv),
				remote,
				file: null,
				state: unset === undefined ? "running" : "failed",
				tools: unset === undefined ? 3 : null,
				reason: unset === undefined ? null : `the environment variable ${unset} named in its ${remote ? "headers" : "env"} is not set`,
				fingerprint: null,
				at: now(),
			};
			const same = before.find((one) => one.origin === "user" && one.name === name && one.subject === known.subject && one.state === known.state && one.reason === known.reason);
			own.push(same ?? known);
		}
		const next = [...projects, ...own];
		if (next.length === before.length && next.every((server, index) => server === before[index])) return;
		session.servers = next;
		serversChanged(world, session);
	}

	// ---- the user's own machines ------------------------------------------------------------------

	/** One user's machines and the codes they looked up, made the first time either is asked about. */
	interface MockMachines {
		list: MachineSummary[];
		/** The codes this user looked up, normalised, with the machine confirming one made. */
		claims: Map<string, string | null>;
		/** When this user looked a code up, for the limit of five in ten minutes. */
		lookups: number[];
		loginAttempts: number[];
		logins: Map<string, number>;
		/** For `stale`: whether the user's connection dropped yet, after which the list can no longer be read. */
		dropped: "no" | "soon" | "yes";
	}

	const machineState: MockMachineState = options.machine ?? "online";
	const machineSession: MockMachineSession = options.machineSession ?? "answering";
	// The agent on "nas" is seeded where "nas" is listed as its runner reported it, and, when its machine was removed, wherever machines are offered.
	const machineSessionSeeded = machineSession === "removed" ? machineState !== "off" : !["none", "unpublished", "off", "pairing"].includes(machineState);
	const machineSets = new Map<string, MockMachines>();

	function machinesOf(auth: AuthResult): MockMachines {
		const world = worldOf(auth);
		let set = machineSets.get(world.profile.uid);
		if (!set) {
			set = { list: seedMachines(machineState), claims: new Map(), lookups: [], loginAttempts: [], logins: new Map(), dropped: "no" };
			machineSets.set(world.profile.uid, set);
		}
		return set;
	}

	/** The list as the server answers it: each sandbox named by its agent's title now, none for an agent that was deleted. */
	function machinesView(auth: AuthResult): MachineSummary[] {
		const world = worldOf(auth);
		return machinesOf(auth).list.map((machine) => ({ ...machine, warnings: machine.warnings.map((warning) => ({ ...warning })), sandboxes: machine.sandboxes.map((sandbox) => ({ ...sandbox, title: world.sessions.get(sandbox.sessionId)?.summary.title ?? null })) }));
	}

	function machinesChanged(auth: AuthResult): void {
		const list = machinesView(auth);
		for (const feed of worldOf(auth).feeds) feed.onMachines?.(list);
		items.machinesChanged(auth);
	}

	function machineOf(auth: AuthResult, machineId: string): MachineSummary {
		const machine = machinesOf(auth).list.find((one) => one.machineId === machineId);
		if (!machine) throw new PlatformError("user", "That machine is not one of yours. It may have been removed in another tab.", { reason: "machine_not_found" });
		return machine;
	}

	/**
	 * For an agent on one of the user's machines: the sentence its turn fails with when the machine cannot
	 * be reached, as server/src/sandbox/runner-layer.ts words it, and null when it can. What it found is
	 * kept for the session's snapshot, as the server's link notes it.
	 */
	function machineUnreachable(auth: AuthResult, session: MockSession): string | null {
		const { place } = session.summary;
		if (place.kind !== "machine") return null;
		const machine = machinesOf(auth).list.find((one) => one.machineId === place.machineId);
		const state = machine === undefined ? "removed" : machine.status === "online" ? "answering" : "offline";
		if (state !== "offline" || session.machine?.reach?.state !== "not_answering") noteReach(session, state);
		if (machine === undefined) return "This agent's machine was removed. Its files were there. Start a new agent to go on.";
		if (state === "offline") return `Your machine "${machine.name}" is offline. The agent's files are there; send the prompt again when it is back.`;
		return null;
	}

	/** What the session finds of its machine, kept for its snapshot and told to its open pages when it changes, as the server's link does. */
	function noteReach(session: MockSession, state: NonNullable<SessionSnapshot["machine"]>["state"]): void {
		if (!session.machine || session.machine.reach?.state === state) return;
		const reach = { state, since: realNow() };
		session.machine.reach = reach;
		for (const feed of session.feeds) feed.onMachine?.(reach);
	}

	/** Sessions whose machine is stopping answering or coming back (`blipMachine`). */
	const blipping = new Set<MockSession>();

	/**
	 * With `?machineSession=not_answering`, once the agent's page is open: its machine stops answering in
	 * the middle of the turn, and comes back half a minute later. The machine's status changes with it.
	 */
	function blipMachine(auth: AuthResult, session: MockSession): void {
		const { place } = session.summary;
		if (machineSession !== "not_answering" || place.kind !== "machine" || blipping.has(session)) return;
		blipping.add(session);
		const status = (to: MachineSummary["status"]) => {
			const machine = machinesOf(auth).list.find((one) => one.machineId === place.machineId);
			if (!machine) return;
			Object.assign(machine, { status: to, since: realNow() });
			machinesChanged(auth);
		};
		later(4_000, () => {
			noteReach(session, "not_answering");
			status("offline");
			later(30_000, () => {
				status("online");
				noteReach(session, "answering");
				blipping.delete(session);
			});
		});
	}

	/** The user's live feeds drop and come back, as `simulateDrop` does for everything. */
	function dropUserFeeds(auth: AuthResult): void {
		const world = worldOf(auth);
		for (const feed of world.feeds) feed.onConnection?.("reconnecting");
		later(600, () => {
			for (const feed of world.feeds) {
				feed.onConnection?.("connected");
				feed.onSessions(listOf(world));
			}
		});
	}

	function machinesOn(): void {
		if (machineState === "off") throw new PlatformError("user", "This deployment does not run agents on machines of your own.", { reason: "machines_off" });
	}

	const WORKSHOP_NO_BUBBLEWRAP = "Unprivileged user namespaces are turned off on this kernel (kernel.apparmor_restrict_unprivileged_userns=1), so bubblewrap cannot start.";

	/** The machines a state starts with. Their sandboxes name the seeded agents; titles are looked up when the list is read. */
	function seedMachines(state: MockMachineState): MachineSummary[] {
		const at = realNow();
		const nas = (patch: Partial<MachineSummary>): MachineSummary => ({
			machineId: "m_nas",
			name: "nas",
			os: "Linux",
			arch: "arm64",
			runnerVersion: MOCK_RUNNER_VERSION,
			status: "online",
			since: at - 3 * HOUR,
			agents: 3,
			sandboxes: [
				...(machineSessionSeeded && machineSession !== "removed" ? [{ sessionId: "nas-tests", title: null, state: machineSession === "offline" ? ("paused" as const) : ("running" as const), usedAt: at - 3 * MINUTE }] : []),
				{ sessionId: "gone", title: null, state: "paused", usedAt: at - 4 * 24 * HOUR },
			],
			commandSandbox: { ok: true },
			freeDiskBytes: 61.4e9,
			profiles: mockMachineProfiles(patch.name ?? "nas"),
			sendSecrets: true, whenToUse: "Build and test", tags: ["big-build"], host: { cpus: 8, sandboxCpus: 4, memoryBytes: 16 * 2**30, memoryFreeBytes: 8 * 2**30, load1: 1 }, turns: { running: 0, queued: 0, max: 2 },
			warnings: [],
			harnesses: [{ ...MOCK_CLAUDE, options: { models: MOCK_CLAUDE_MODELS.models, defaultModel: MOCK_CLAUDE_MODELS.defaultModel, modes: [...CLAUDE_LAUNCH_MODES], checkedAt: at } }],
			...patch,
		});
		switch (state) {
			case "none":
			case "unpublished":
			case "off":
				return [];
			case "offline":
				return [nas({ status: "offline", since: at - 47 * MINUTE })];
			// The agent on "nas" finds it offline: the machine went offline after the agent last used it.
			case "online":
				return [nas({
					...(machineSession === "offline" && { status: "offline", since: at - 12 * MINUTE }),
				})];
			case "claude-signed-out":
				return [nas({ harnesses: [{ ...MOCK_CLAUDE, signIn: "none" }] })];
			case "pairing":
				return [nas({ status: "waiting", since: at - 4 * MINUTE, agents: 0, sandboxes: [], commandSandbox: null, freeDiskBytes: null, profiles: [], harnesses: undefined })];
			case "outdated":
				return [nas({ status: "offline", since: at - 12 * MINUTE, runnerVersion: "0.1.0", warnings: [{ kind: "outdated" }] })];
			case "docker":
				return [nas({ warnings: [{ kind: "docker", reason: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" }], profiles: mockMachineProfiles("nas", { docker: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" }) })];
			case "clock":
				return [nas({ warnings: [{ kind: "clock", offsetSeconds: 7 * 60 + 12 }] })];
			case "key":
				return [nas({ warnings: [{ kind: "key", at: at - 25 * MINUTE }] })];
			case "full":
				return [
					nas({}),
					nas({
						machineId: "m_workshop",
						name: "workshop",
						arch: "x64",
						status: "offline",
						since: at - 2 * 24 * HOUR,
						agents: 1,
						sandboxes: [{ sessionId: "workshop-gone", title: null, state: "paused", usedAt: at - 2 * 24 * HOUR }],
						commandSandbox: { ok: false, reason: WORKSHOP_NO_BUBBLEWRAP },
						profiles: mockMachineProfiles("workshop", { commandSandbox: WORKSHOP_NO_BUBBLEWRAP }),
						freeDiskBytes: 3.2e9,
						sendSecrets: false,
						// Its runner was started with --harness claude, and nobody signed Claude Code in there.
						harnesses: [{ ...MOCK_CLAUDE, signIn: "none" }],
					}),
					// Its owner started its runner with --max-running 2 --max-sandboxes 6; the others have no limit.
					nas({ machineId: "m_build", name: "build-box", arch: "x64", since: at - 20 * MINUTE, agents: 0, sandboxes: [], freeDiskBytes: 402e9, maxRunning: 2, maxSandboxes: 6, harnesses: undefined }),
				];
			case "unnamed":
				return [
					nas({}),
					// Its runner runs in a container, so the host name it reported is the container's id.
					nas({ machineId: "m_container", name: "f892b469d6c5", arch: "x64", since: at - 2 * HOUR, agents: 0, sandboxes: [], freeDiskBytes: 118e9, harnesses: undefined }),
				];
			default:
				return [nas({})];
		}
	}

	/** A code as the server reads it: case, spaces and dashes do not matter, O reads as 0 and I and L as 1. */
	const pairingCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

	function lookUp(auth: AuthResult, code: string): string {
		const set = machinesOf(auth);
		const clean = pairingCode(code);
		// Asked again for a code that made a machine, the answer is that machine.
		if (set.claims.get(clean)) return clean;
		if (set.list.length >= MAX_MACHINES) throw new PlatformError("user", `An account can connect up to ${MAX_MACHINES} machines. Remove one to add another.`, { reason: "too_many_machines" });
		if (set.claims.has(clean)) return clean;
		const at = realNow();
		set.lookups = set.lookups.filter((when) => when > at - 10 * MINUTE);
		if (set.lookups.length >= 5) throw new PlatformError("user", "Five codes were tried in the last ten minutes. Wait a few minutes, then try again.", { reason: "too_many_claims" });
		set.lookups.push(at);
		if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(clean) || clean === "ZZZZZZZZ") throw new PlatformError("user", "No machine is waiting with that code. A code lasts ten minutes: check the one the runner printed last.", { reason: "pairing_not_found" });
		set.claims.set(clean, null);
		return clean;
	}

	/** The calls of the Machines page. A machine paired here waits for its runner, which connects a few seconds later. */
	function machineCalls(auth: AuthResult): Pick<UserApi, "machines" | "claimMachine" | "confirmMachine" | "removeMachine" | "setMachineDetails" | "setMachineSecrets" | "startClaudeLogin" | "finishClaudeLogin" | "cancelClaudeLogin"> {
		function loginMachine(id: string) {
			machinesOn();
			const set = machinesOf(auth);
			const at = realNow();
			set.loginAttempts = set.loginAttempts.filter(t => t > at - 10 * MINUTE);
			if (set.loginAttempts.length >= 12) throw new PlatformError("user", "Too many Claude sign-in requests.", { reason: "rate_limited" });
			set.loginAttempts.push(at);
			const machine = machineOf(auth, id);
			if (machine.status !== "online") throw new PlatformError("user", "The machine is offline.", { reason: "machine_not_connected" });
			if (!machine.harnesses?.some(h => h.id === "claude")) throw new PlatformError("user", "This machine does not offer Claude Code.", { reason: "claude_unavailable" });
			if ((set.logins.get(id) ?? 0) <= at) set.logins.delete(id);
			return { machine, logins: set.logins };
		}
		return {
			async machines() {
				machinesOn();
				const set = machinesOf(auth);
				if (machineState === "loading") await new Promise<never>(() => undefined);
				await latency(260);
				if (machineState === "failed" || set.dropped === "yes") throw new PlatformError("network", "The platform could not be reached. Check your connection.");
				// The list is read; then the user's connection drops for a moment, and reading it again after that fails.
				if (machineState === "stale" && set.dropped === "no") {
					set.dropped = "soon";
					later(1500, () => {
						set.dropped = "yes";
						dropUserFeeds(auth);
					});
				}
				return machinesView(auth);
			},
			async claimMachine({ code }) {
				machinesOn();
				await latency(420);
				lookUp(auth, code);
				return { name: "workstation", os: "Linux", arch: "x64", runnerVersion: MOCK_RUNNER_VERSION };
			},
			async confirmMachine({ code }) {
				machinesOn();
				await latency(520);
				const set = machinesOf(auth);
				const clean = lookUp(auth, code);
				const made = set.claims.get(clean);
				if (made) return machinesView(auth).find((one) => one.machineId === made) ?? machineOf(auth, made);
				const machineId = `m_${hex(12)}`;
				set.claims.set(clean, machineId);
				set.list.push({ machineId, name: "workstation", os: "Linux", arch: "x64", runnerVersion: MOCK_RUNNER_VERSION, status: "waiting", since: realNow(), agents: 0, sandboxes: [], commandSandbox: null, freeDiskBytes: null, profiles: [], sendSecrets: true, warnings: [] });
				machinesChanged(auth);
				later(4000, () => {
					const machine = machinesOf(auth).list.find((one) => one.machineId === machineId);
					if (!machine || machine.status !== "waiting") return;
					Object.assign(machine, { status: "online", since: realNow(), commandSandbox: { ok: true }, freeDiskBytes: 212e9 });
					machinesChanged(auth);
				});
				return machinesView(auth).find((one) => one.machineId === machineId) as MachineSummary;
			},
			async startClaudeLogin({ machineId }) {
				const { logins } = loginMachine(machineId);
				if (logins.has(machineId)) throw new PlatformError("user", "A Claude Code sign-in is already pending.", { reason: "claude_login_failed" });
				const expiresAt = realNow() + 10 * MINUTE;
				logins.set(machineId, expiresAt);
				return { url: "https://claude.example.invalid/authorize", expiresAt };
			},
			async finishClaudeLogin({ machineId, code }) {
				const { machine, logins } = loginMachine(machineId);
				if (!logins.delete(machineId)) throw new PlatformError("user", "No Claude Code sign-in is pending.", { reason: "claude_login_failed" });
				if (code !== "mock-approval") throw new PlatformError("user", "The mock approval code is mock-approval.", { reason: "claude_login_failed" });
				machine.harnesses = machine.harnesses!.map(h => ({ ...h, signIn: "token" }));
				machinesChanged(auth);
				return { signedIn: true };
			},
			async cancelClaudeLogin({ machineId }) {
				loginMachine(machineId).logins.delete(machineId);
				return { cancelled: true };
			},
			async removeMachine({ machineId }) {
				machinesOn();
				await latency(380);
				machineOf(auth, machineId);
				const set = machinesOf(auth);
				set.list = set.list.filter((one) => one.machineId !== machineId);
				machinesChanged(auth);
				return machinesView(auth);
			},
			async setMachineDetails(input) {
				machinesOn();
				const machine = machineOf(auth, input.machineId);
				try { Object.assign(machine, machineDetails(input)); } catch (error) { throw new PlatformError("user", (error as Error).message, { reason: "bad_input" }); }
				machinesChanged(auth);
				return machinesView(auth);
			},
			async setMachineSecrets({ machineId, send }) {
				machinesOn();
				await latency(240);
				machineOf(auth, machineId).sendSecrets = send;
				machinesChanged(auth);
				return machinesView(auth);
			},
		};
	}

	// ---- the interface --------------------------------------------------------------------------

	function userApi(auth: AuthResult): UserApi {
		const world = () => worldOf(auth);
		return {
			...machineCalls(auth),
			...items.calls(auth),
			async me() {
				await latency();
				return world().profile;
			},
			async chatgpt(): Promise<ChatgptStatus> {
				await latency(220);
				const { profile } = world();
				return profile.demo ? { connected: false, email: null, accessExpiresAt: null } : { connected: true, email: profile.email, accessExpiresAt: now() + 52 * MINUTE };
			},
			async models(): Promise<ModelList> {
				await latency(200);
				return modelsFor(world().profile);
			},
			async listSessions() {
				await latency();
				return listOf(world());
			},
			async createSession({ idempotencyKey, ...input }: CreateSessionInput) {
				await latency(260);
				// With a key, the agent its first attempt made, for as long as that agent exists.
				const key = keyOf(idempotencyKey);
				const made = world().sessions.get(takenUnder(world().created, key, JSON.stringify(input), "agent") ?? "");
				if (made) return made.summary;
				// On one of the user's machines, the sandboxes are the ones its runner last reported.
				const machine = input.place?.kind === "machine" ? machineOf(auth, input.place.machineId) : null;
				const profile = (machine ? machine.profiles : profiles).find((candidate) => candidate.id === input.profile);
				if (!profile) throw new PlatformError("user", "There is no such sandbox.");
				if (!profile.available) throw new PlatformError("user", `${profile.name} cannot be used yet. ${profile.unavailableReason ?? ""}`.trim());
				const options = machine?.harnesses?.find(entry => entry.id === "claude")?.options;
				const harness: HarnessId = input.harness ?? "windlass";
				if (harness !== "windlass") {
					if (!machine) throw new PlatformError("user", "Claude Code runs only on a machine of yours.", { reason: "bad_input" });
					if (input.profile !== "docker-hardened") throw new PlatformError("user", "Claude Code requires the docker-hardened profile.", { reason: "bad_input" });
					if (input.publishUnasked) throw new PlatformError("user", "Claude Code has no publish tool. Publish from the session panel.", { reason: "bad_input" });
					if (!machine.harnesses?.some((offered) => offered.id === harness)) throw new PlatformError("user", "This machine does not offer Claude Code.", { reason: "bad_input" });
				}
				const models = harness === "claude" ? initialHarnessModels(options) : modelsFor(world().profile);
				if (input.model) {
					if (harness === "claude" && options && !models.models.some(m => m.id === input.model)) throw new PlatformError("user", "Choose a model offered by this machine.", { reason: "bad_input" });
					checkModel(models, input.model);
				}
				const modes = initialSessionModes(profile.id, harness);
				if (harness === "claude") modes.availableModes = options?.modes ?? [...CLAUDE_LAUNCH_MODES];
				if (input.mode !== undefined) {
					if (!modes.availableModes.some(m => m.id === input.mode)) throw new PlatformError("user", "Choose a mode offered by this agent.", { reason: "bad_input" });
					modes.mode = input.mode;
				}
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
				if (repository && input.setupCommand !== undefined) saveSetup(world(), repository.id, input.setupCommand);
				const session = addSession(world(), { id: hex(10), title: title || "New agent", titled: title !== "", profile: profile.id, harness, modes, model: input.model || models.defaultModel, repoUrl, repository, publishUnasked: repository !== null && input.publishUnasked === true });
				if (harness === "claude" && options) session.summary = { ...session.summary, harnessModels: models };
				if (machine) {
					session.summary = { ...session.summary, place: { kind: "machine", machineId: machine.machineId } };
					session.machine = { profile, reach: null };
					machine.agents += 1;
					machinesChanged(auth);
				}
				setSummary(world(), session, {});
				if (key !== null) world().created.set(key, { content: JSON.stringify(input), answer: session.summary.id });
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
			async repositorySetup(repositoryId: GithubId): Promise<RepositorySetup> {
				await latency(180);
				return setupOf(world(), repositoryId);
			},
			async saveRepositorySetup(repositoryId: GithubId, command: string): Promise<RepositorySetup> {
				await latency(320);
				nameAtSave(world(), repositoryId);
				return saveSetup(world(), repositoryId, command);
			},
			async repositoryChecks(repositoryId: GithubId): Promise<RepositoryChecks> {
				await latency(180);
				return checksOf(world(), repositoryId);
			},
			async saveRepositoryChecks(repositoryId: GithubId, checks: RepositoryCheck[]): Promise<RepositoryChecks> {
				await latency(320);
				nameAtSave(world(), repositoryId);
				return saveChecks(world(), repositoryId, checks);
			},
			async repositorySecrets(repositoryId: GithubId, profile: SandboxProfileId): Promise<RepositorySecrets> {
				await latency(200);
				return secretsOf(world(), repositoryId, profile);
			},
			async saveRepositorySecret(repositoryId: GithubId, profile: SandboxProfileId, secret: { name: string; value?: string; scope: SecretScope }): Promise<RepositorySecrets> {
				await latency(340);
				nameAtSave(world(), repositoryId);
				saveSecret(world(), repositoryId, secret);
				return secretsOf(world(), repositoryId, profile);
			},
			async deleteRepositorySecret(repositoryId: GithubId, profile: SandboxProfileId, name: string): Promise<RepositorySecrets> {
				await latency(280);
				world().secrets.get(repositoryId)?.delete(name);
				if (world().secrets.get(repositoryId)?.size === 0) world().secrets.delete(repositoryId);
				return secretsOf(world(), repositoryId, profile);
			},
			async repository(repositoryId: GithubId): Promise<RepositoryView> {
				await latency(180);
				return repositoryViewOf(world(), repositoryId);
			},
			async githubRepository(repositoryId: GithubId): Promise<GithubRepository> {
				await latency(380);
				requireGithub(world());
				if (nextGithub === "list") {
					nextGithub = null;
					throw new PlatformError("user", "GitHub could not be reached. Try again in a moment.", { reason: "github_unreachable" });
				}
				const found = nextGithub === "gone" ? undefined : GITHUB_REPOSITORIES.find((repository) => repository.id === repositoryId);
				if (nextGithub === "gone") nextGithub = null;
				if (!found) throw new PlatformError("user", "That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again.", { reason: "github_gone" });
				// GitHub said what it is called now: what is saved for it goes by that name.
				world().names.set(repositoryId, `${found.owner}/${found.name}`);
				return describeRepository(found);
			},
			async saveRepositoryDefaults(repositoryId: GithubId, change: { screenshots?: boolean; profile?: SandboxProfileId | null; model?: string | null }): Promise<RepositoryDefaults> {
				await latency(300);
				nameAtSave(world(), repositoryId);
				return saveDefaults(world(), repositoryId, change);
			},
			async forgetRepositoryApproval(repositoryId: GithubId, name: string): Promise<RepositoryView> {
				await serversLatency(360);
				if (nextServers === "forget") {
					nextServers = null;
					throw new PlatformError("user", "The approval could not be forgotten. Try again.");
				}
				const current = world();
				current.approvals = current.approvals.filter((approval) => !(approval.project === `github:${repositoryId}` && approval.name === name));
				return repositoryViewOf(current, repositoryId);
			},
			async forgetRepository(repositoryId: GithubId): Promise<RepositoryView> {
				await latency(420);
				const current = world();
				current.secrets.delete(repositoryId);
				current.setups.delete(repositoryId);
				current.checks.delete(repositoryId);
				current.defaults.delete(repositoryId);
				current.screenshotsEnabled.delete(repositoryId);
				current.approvals = current.approvals.filter((approval) => approval.project !== `github:${repositoryId}`);
				current.names.delete(repositoryId);
				return repositoryViewOf(current, repositoryId);
			},
			async account(): Promise<AccountSettings> {
				await latency(180);
				return accountOf(world());
			},
			async saveAccountDefaults(change: { profile?: SandboxProfileId | null; model?: string | null }): Promise<AccountDefaults> {
				await latency(300);
				const current = world();
				// The same rules as a repository's defaults.
				current.account.defaults = changedDefaults(current.account.defaults, change, modelsFor(current.profile));
				return accountDefaultsOf(current);
			},
			async savePersonalServer(server: { name: string; definition: unknown; unasked?: boolean; existing?: boolean }): Promise<AccountSettings> {
				await latency(320);
				const current = world();
				const { name, definition } = mockCleanServer(server.name, server.definition);
				if (server.unasked !== undefined && typeof server.unasked !== "boolean") throw new PlatformError("user", "Whether a server's tools run without asking is true or false.", { reason: "bad_server" });
				const saved = current.account.servers.has(name);
				if (server.existing === true) {
					if (!saved) throw new PlatformError("user", `No server named ${name} is saved any more. Add it again.`, { reason: "server_not_found" });
				} else {
					if (saved) throw new PlatformError("user", `A server named ${name} is saved already. Change that one, or give this one another name.`, { reason: "server_exists" });
					if (current.account.servers.size >= MAX_PERSONAL_SERVERS) throw new PlatformError("user", `An account can keep ${MAX_PERSONAL_SERVERS} MCP servers, and yours has that many. Delete one first.`, { reason: "too_many_servers" });
				}
				current.account.servers.set(name, { definition, unasked: server.unasked === true, updatedAt: now() });
				return accountOf(current);
			},
			async deletePersonalServer(name: string): Promise<AccountSettings> {
				await latency(280);
				world().account.servers.delete(name);
				return accountOf(world());
			},
			async accountSecrets(profile: SandboxProfileId): Promise<AccountSecrets> {
				await latency(200);
				return accountSecretsOf(world(), profile);
			},
			async saveAccountSecret(profile: SandboxProfileId, secret: { name: string; value?: string; scope: SecretScope }): Promise<AccountSecrets> {
				await latency(340);
				const current = world();
				// The rules of a repository's secret for the name, the scope and the value; without a value, only the scope changes.
				checkSecretName(secret.name);
				if (secret.scope !== "setup" && secret.scope !== "agent") throw new PlatformError("user", "A secret is for the setup command and MCP servers, or for the agent's commands as well.", { reason: "bad_secret" });
				if (secret.value === undefined) {
					if (!current.account.secrets.has(secret.name)) throw new PlatformError("user", `No secret named ${secret.name} is saved for your account.`, { reason: "secret_not_found" });
				} else {
					checkSecretValue(secret.value);
					if (!current.account.secrets.has(secret.name) && current.account.secrets.size >= MAX_ACCOUNT_SECRETS) {
						throw new PlatformError("user", `An account can keep ${MAX_ACCOUNT_SECRETS} secrets, and yours has that many. Delete one first.`, { reason: "too_many_secrets" });
					}
				}
				current.account.secrets.set(secret.name, { scope: secret.scope, updatedAt: now() });
				return accountSecretsOf(current, profile);
			},
			async deleteAccountSecret(profile: SandboxProfileId, name: string): Promise<AccountSecrets> {
				await latency(280);
				world().account.secrets.delete(name);
				return accountSecretsOf(world(), profile);
			},
			async savedRepositories(): Promise<SavedRepository[]> {
				await latency(200);
				const current = world();
				// A deployment that never had a GitHub App has nothing saved for a repository.
				if (!githubOn) return [];
				const ids = new Set<GithubId>([...current.setups.keys(), ...current.checks.keys(), ...current.secrets.keys(), ...current.defaults.keys(), ...current.screenshotsEnabled.keys()]);
				for (const approval of current.approvals) {
					const id = githubId(/^github:([1-9][0-9]*)$/.exec(approval.project)?.[1]);
					if (id !== null && approval.expiresAt > now()) ids.add(id);
				}
				return [...ids]
					.map((id) => ({ id, name: repositoryNameOf(current, id) }))
					.sort((a, b) => Number(a.name === null) - Number(b.name === null) || (a.name ?? "").localeCompare(b.name ?? "") || String(a.id).localeCompare(String(b.id), "en", { numeric: true }));
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
				return { repositories: matching.map(describeRepository), more: false, incomplete: false };
			},
			async githubBranches(repositoryId: GithubId): Promise<GithubBranchList> {
				await latency(320);
				requireGithub(world());
				const found = GITHUB_REPOSITORIES.find((repository) => repository.id === repositoryId);
				if (!found) throw new PlatformError("user", "That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again.");
				return { branches: found.branches, defaultBranch: found.defaultBranch, more: false };
			},
			async allowance(): Promise<UsageNumbers> {
				await latency(160);
				return usageNumbers(world());
			},
			async usage(): Promise<UsageView> {
				await latency(320);
				return usageView(world());
			},
			async freeSandbox(sessionId: string): Promise<UsageView> {
				await latency(700);
				const session = world().sessions.get(sessionId);
				if (!session || session.summary.sandbox === "none") return usageView(world());
				if (session.summary.status !== "idle") throw new PlatformError("user", `${session.summary.title} is working. Stop its turn first, then free its sandbox.`, { reason: "sandbox_busy" });
				cancel(session.pauseTimer);
				session.pauseTimer = null;
				session.files.clear();
				store(session, { turn: session.summary.turns, kind: "platform", level: "info", text: MOCK_FREED_NOTE });
				setSummary(world(), session, { sandbox: "none" });
				return usageView(world());
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
		...(session.summary.place.kind === "machine" ? { machine: session.machine?.reach ?? null } : {}),
	});

	function sessionApi(auth: AuthResult, id: string): SessionApi {
		const find = (): { world: World; session: MockSession } => {
			const world = worldOf(auth);
			const session = world.sessions.get(id);
			if (!session) throw new PlatformError("not_found", "There is no agent at this address.");
			const turn = session.seededTurn;
			if (turn) {
				delete session.seededTurn;
				turn();
			}
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
						blipMachine(auth, session);
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
				// As the server: a work item's agent takes its prompts from the item's steps only, and this is asked before anything else.
				if (session.summary.item) throw new PlatformError("user", ITEM_SESSION_PROMPT, { reason: "item_session" });
				const text = input.text.trim();
				if (text === "") throw new PlatformError("user", "Write something for the agent to do.");
				if (text.length > MAX_PROMPT_CHARS) throw new PlatformError("user", `A prompt can be at most ${MAX_PROMPT_CHARS.toLocaleString("en")} characters.`);
				// With a key, a message that was taken before is answered as it was then, and nothing is added.
				const key = keyOf(input.idempotencyKey);
				const taken = takenUnder(session.submissions, key, text, "message to this agent");
				if (taken) return taken;
				const take = (answer: { turn: number; steered: boolean }) => {
					if (key !== null) session.submissions.set(key, { content: text, answer });
					return answer;
				};
				const status = session.summary.status;
				if (status === "starting") throw new PlatformError("user", "The agent is still starting. Send this again once it is working.", { reason: "steer_unavailable" });
				if (status === "stopping") throw new PlatformError("user", "The turn is stopping. Send this again once it has stopped.", { reason: "steer_unavailable" });
				if ((status === "running" || status === "waiting") && session.run && session.summary.harness === "claude") {
					// Claude Code takes it through its steering extension: the server stores it as a steer.
					if (input.model !== undefined || input.effort !== undefined) throw new PlatformError("user", "Choose the model and effort when starting a turn.", { reason: "bad_input" });
					const turn = session.run.turn;
					store(session, { turn, kind: "user", text, model: session.summary.model, effort: null, steer: true });
					setSummary(world, session, { updatedAt: now() });
					return take({ turn, steered: true });
				}
				if ((status === "running" || status === "waiting") && session.run) {
					// A message to a running turn steers it: stored as a steer, delivered at the next step.
					const turn = session.run.turn;
					store(session, { turn, kind: "user", text, model: session.summary.model, effort: null, steer: true });
					const messageId = `msg_${hex(24)}`;
					emit(session, turn, windlassEvent(session, "inbox.enqueued", { messageId, origin: null, delivery: "steer", content: [{ type: "text", text }] }));
					session.run.steers.push(messageId);
					setSummary(world, session, { updatedAt: now() });
					return take({ turn, steered: true });
				}
				// The ceiling on working agents is the deployment's (`FactoryLimits.runningTurns`) and the platform's sandboxes': one on the user's machine is neither counted nor refused.
				const hosted = session.summary.place.kind === "hosted";
				// A work item's turn counts wherever it runs (server/src/actors/user.ts, `internalAcquireRun`).
				const running = [...world.sessions.values()].filter((other) => other.summary.status !== "idle" && (other.summary.item !== undefined || other.summary.place.kind === "hosted")).length;
				if (hosted && running >= MOCK_FACTORY_LIMITS.runningTurns) throw new PlatformError("user", `You already have ${running} ${running === 1 ? "agent" : "agents"} working, which is your limit. Wait for one to finish, or stop one.`, { reason: "too_many_running" });
				// A Claude Code agent's turn: the models are the ones it listed, and the machine's report says whether it is signed in.
				if (session.summary.harness === "claude") {
					const unreachable = machineUnreachable(auth, session);
					const place = session.summary.place;
					const machine = place.kind === "machine" ? machinesOf(auth).list.find((one) => one.machineId === place.machineId) : undefined;
					const offered = machine?.harnesses?.find((one) => one.id === "claude");
					if (unreachable === null && !offered) throw new PlatformError("user", "This machine does not offer Claude Code.", { reason: "bad_input" });
					if (unreachable === null && offered?.signIn === "none") throw new PlatformError("user", `Claude Code on “${machine?.name ?? "your machine"}” is not signed in. Run windlass-runner login claude there.`, { reason: "harness_signed_out" });
					const listed = session.summary.harnessModels ?? null;
					if (input.model !== undefined && !(listed?.models ?? [{ id: "default" }]).some((one) => one.id === input.model)) throw new PlatformError("user", `Claude Code offers no model "${input.model}".`, { reason: "bad_model" });
					if ((!input.model || input.model === session.summary.model) && input.effort !== undefined && !(listed?.models.find((one) => one.id === (input.model ?? session.summary.model))?.efforts ?? []).includes(input.effort)) throw new PlatformError("user", "Claude Code offered no such effort.", { reason: "bad_effort" });
					const turn = session.summary.turns + 1;
					if (unreachable !== null) {
						play(session, plan(world, session, { ...input, text }, { events: [], platformFailure: unreachable, unreachable: true }));
						return take({ turn, steered: false });
					}
					play(session, acpTurn(world, session, { ...input, text }, claudeScript(session, text)));
					return take({ turn, steered: false });
				}
				const models = modelsFor(world.profile);
				if (input.model !== undefined) checkModel(models, input.model);
				// An effort is held against the ones the turn's model accepts; of a model the list does not have nothing is said.
				const efforts = models.models.find((candidate) => candidate.id === (input.model ?? session.summary.model))?.efforts;
				if (input.effort !== undefined && efforts !== undefined && !efforts.includes(input.effort)) {
					throw new PlatformError("user", efforts.length === 0 ? `${input.model ?? session.summary.model} takes no reasoning effort. Leave the effort at its default.` : `The effort for ${input.model ?? session.summary.model} must be one of: ${efforts.join(", ")}`, { reason: "bad_effort" });
				}
				// The user's two limits, as the server holds a prompt to them: time for the sandbox to run on, and a place for one the agent does not have. Not on the user's own machine.
				const numbers = usageNumbers(world);
				if (hosted && (numbers.leftSeconds ?? 0) < numbers.startSeconds) throw new PlatformError("user", mockAllowanceRefusal(numbers), { reason: "allowance_used" });
				if (hosted && session.summary.sandbox === "none" && numbers.sandboxes.limit !== null && numbers.sandboxes.kept >= numbers.sandboxes.limit) throw new PlatformError("user", mockSandboxRefusal(numbers), { reason: "too_many_sandboxes" });
				// A machine that cannot be reached fails the turn at once, with the server's sentence, as the server's turn does when its sandbox cannot be opened.
				const unreachable = machineUnreachable(auth, session);
				if (unreachable !== null) {
					const turn = session.summary.turns + 1;
					play(session, plan(world, session, { ...input, text }, { events: [], platformFailure: unreachable, unreachable: true }));
					return take({ turn, steered: false });
				}
				const name = chooseScript(text, world.rotation);
				if (ROTATION[world.rotation % ROTATION.length] === name) world.rotation += 1;
				// A second plain answer in one session uses the recording's second run.
				const recording: Script = name === "answer" && session.windlassSessionId !== null ? SCRIPTS.answerAgain : SCRIPTS[name];
				const server = chooseServer(text);
				const script: Script = server ? { ...recording, server } : recording;
				const turn = session.summary.turns + 1;
				play(session, plan(world, session, { ...input, text }, script));
				return take({ turn, steered: false });
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
				if (session.question.messageId === "acp" && note !== "") throw new PlatformError("user", "Claude Code takes a choice without a note.", { reason: "bad_input" });
				if (note.length > MAX_NOTE_CHARS) throw new PlatformError("user", `A note can be at most ${MAX_NOTE_CHARS} characters.`);
				settle(world, session, input.choice, note === "" ? null : note);
			},
			async stopCall(input: { messageId: string; callId: string }) {
				await latency(120);
				const { session } = find();
				if (session.summary.harness === "claude") return { stopped: false, message: "Claude Code cannot stop one call. Stop the turn instead." };
				return stopOneCall(session, input.messageId, input.callId);
			},
			async stop() {
				await latency(90);
				const { world, session } = find();
				if (session.summary.harness === "claude") interruptAcp(world, session);
				else interrupt(world, session);
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
				// Nothing new: refused, unless the branch is pushed and no pull request was opened from it, which is then opened from what is there (github/publish.ts `publishWork`).
				const fromPushed = files === 0 && current === null && session.pushedHead !== null;
				if (files === 0 && !fromPushed) {
					throw new PlatformError("user", open ? `There is nothing to push: ${branch} at GitHub already has everything in the workspace.` : `There is nothing to open a pull request with: the workspace has no changes and no commit that ${repository.branch} does not have.`, { reason: "publish_failed" });
				}
				const what = fromPushed ? "the agent's commits" : files === 1 ? "1 file" : `${files} files`;
				let pull: PullRequestInfo;
				// The description's section is written with every push: what it says in a few words is kept with the pull request.
				const verified = verifiedWords(session.verified);
				if (open) {
					pull = { ...open, pushedAt: now(), verified };
					store(session, { turn: session.summary.turns, kind: "platform", level: "info", text: `Pushed ${what} to ${branch}; pull request #${open.number} is updated. Its description reports: ${verified}.` });
				} else {
					const number = world.nextPull++;
					pull = { number, url: `${repository.url}/pull/${number}`, state: "open", title: message.title.trim(), branch, base: repository.branch, pushedAt: now(), verified };
					store(session, { turn: session.summary.turns, kind: "platform", level: "info", text: `Opened pull request #${number} in ${name} from ${branch}, with ${what}. Its description reports: ${verified}.` });
				}
				// Committed: nothing differs from the last commit any more.
				session.files.clear();
				session.pushed = true;
				if (!fromPushed) session.pushedHead = hex(40);
				setSummary(world, session, { pullRequest: pull, updatedAt: now() });
				return { state: publishStateOf(session), opened: !open };
			},
			async setMode(mode: string): Promise<SessionSummary> {
				await latency();
				const { world, session } = find();
				if (session.summary.item || !session.summary.availableModes.some(m => m.id === mode)) throw new PlatformError("user", "Choose a mode offered by this agent.", { reason: "bad_input" });
				if (session.run?.acp) session.run.acp.modeQueued = true;
				setSummary(world, session, { mode });
				return session.summary;
			},
			async setPublishUnasked(unasked: boolean): Promise<SessionSummary> {
				await latency();
				const { world, session } = find();
				if (!session.summary.repository) throw new PlatformError("user", "This agent does not work on a repository of your GitHub connection, so it has nowhere to publish to.", { reason: "publish_blocked" });
				if ((session.summary.publishUnasked === true) !== unasked) {
					store(session, {
						turn: session.summary.turns,
						kind: "platform",
						level: "info",
						text: unasked ? "You let the agent publish this session's work without asking, in the session's panel." : "You turned off publishing without asking in the session's panel: the agent's next request to publish is put to you.",
					});
					setSummary(world, session, { publishUnasked: unasked });
				}
				return session.summary;
			},
		};
	}

	return {
		kind: "mock",
		endpoint: null,
		async info(): Promise<PlatformInfo> {
			await latency(120);
			const machines = machineState === "off" ? {} : { machines: { minRunnerVersion: MOCK_MIN_RUNNER_VERSION, runnerImage: machineState === "unpublished" ? null : MOCK_RUNNER_IMAGE, platformUrl: origin } };
			return { demoEnabled: true, windlassVersion: "0.4.0", profiles, ...(githubOn ? { github: GITHUB } : {}), ...machines, ...(options.items === "off" ? {} : { items: { reviewer: options.reviewer !== false, orchestrate: true } }) };
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
		mockUsage(state) {
			usageState = state;
			for (const world of worlds.values()) for (const feed of world.feeds) feed.onUsage?.(usageNumbers(world));
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
