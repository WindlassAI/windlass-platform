import { spareProfile, spareRecipe, type SpareRecipe, type SpareSetup } from "../runner/spare-recipe.js";
import { refHead } from "../github/feature.js";
/**
 * `agentSession`, key [uid, sessionId]: one agent, its sandbox, its timeline and its turns.
 *
 * Stored in SQLite: one row with the session's settings and state (`meta`), and the timeline, one row
 * per item, numbered by a dense `seq`. In memory only: the turn in progress, the items not written
 * yet, and the streaming deltas a client that connects mid-turn still needs (`pending`).
 *
 * Actions interleave at every `await`, so the rules are:
 *   - `meta`, the `seq` counter and "is a turn running" live in memory and change in synchronous steps;
 *   - every write to SQLite goes through one queue (`serial`), so rows land in the order they were made
 *     and a snapshot reads a timeline no write is in the middle of.
 *
 * A turn in progress can be talked to. Windlass may ask a question (a tool call that needs approval):
 * the question lives on the turn's own record in memory and nowhere else, so it cannot outlast the
 * turn, a sleep or a restart; `answer()` settles it, as does the platform when nobody answers in time.
 * `prompt()` during a turn steers it, and `stopCall()` stops one running tool call.
 *
 * Windlass has a second question, which it does not put itself: whether to start an MCP server the
 * project's own configuration names (server-question.ts). The sandbox layer asks Windlass what waits
 * before the turn's prompt goes, and the question is put to the user in the same place and settled by
 * the same `answer()`. A tool call's question comes first: a server's steps aside for it and is put
 * again afterwards. What became of it is a line in the timeline; Windlass has no event for it.
 *
 * An approval is remembered for the user beyond the sandbox Windlass keeps it in (server-approvals.ts):
 * the user's `user` actor holds it, for the session's project and exactly that definition. Before a
 * server's question is put, the session asks there, and a remembered approval starts the server
 * without the question, with one line that says so. What Windlass says of the project's servers is
 * kept with the session (`meta.servers`), for the side panel, where an approval is seen, given and
 * taken back (`servers`, `approveServer`, `forgetServer`).
 *
 * A session on a repository of the user's GitHub connection runs that repository's setup command, when
 * the user saved one (setup-command.ts): once in each new sandbox, after the clone and before Windlass
 * is started there. The session reads the command from the user's `user` actor at that moment and
 * from nowhere else, runs it through the sandbox layer (sandbox/setup.ts), and keeps the run in the
 * timeline: an item when it starts, its output as deltas, an item when it has ended. A run that did
 * not succeed does not fail the turn; the agent is told of it once, before its next prompt.
 *
 * Such a session is also handed the secrets the user saved for the repository (repo-secrets.ts). A
 * turn reads them from the user's `user` actor when it starts, sealed, opens them here, and holds the
 * values on its own record in memory (`ActiveTurn.secrets`): they go when the turn does, and are
 * never part of `meta`, the timeline or a log. The setup command gets all of them, Windlass those
 * the session's sandbox lets it keep to their scope, and every value is taken out of what the turn
 * leaves behind: the sandbox layer does it for what Windlass and the setup command say, and `append`
 * does it once more for every item the turn adds to the timeline, whoever wrote it. The copy of the
 * workspace's diff is treated the same, since a setup command may have written a value to a file.
 *
 * A sandbox nobody uses is suspended, and after longer removed (config.idleSuspendMs, idleDestroyMs),
 * by the actor's own durable schedule (`c.schedule`): it holds while the actor sleeps and across a
 * restart, and wakes the actor when it is due. The check never touches a turn in progress or one being
 * accepted, and a prompt waits for a suspend or removal under way, then resumes or recreates the sandbox.
 *
 * The agent can ask the platform to publish the session's work (agent-publish.ts): a tool the sandbox
 * layer offers it for a turn of a session on a repository of the GitHub connection, as a tool the
 * platform runs itself (Windlass's host tools). A request is the engine's call of that tool. The
 * session checks what it holds, asks the user in the place of a tool call's question unless the
 * session lets the agent publish unasked (`meta.publishUnasked`: chosen at launch, changed in the
 * panel, turned on by "Allow for this session"), publishes exactly as `publish()` does, to the
 * session's branch and pull request and nowhere else, and resolves with what the agent is told. What
 * became of it is a line in the timeline. The agent can also push the session's branch whenever it
 * wants, unasked, and have the base fetched to rebase onto (`agentPush`, `agentFetchBase`), in a
 * person's session and in a work item's, where `report` takes the place of `publish`. A sandbox
 * whose Windlass takes no host tools is from before them, which no sandbox the platform makes is:
 * a turn there fails with a sentence (`oldSandbox`), and is not worked around.
 *
 * The time a hosted sandbox runs is counted against its user's daily allowance, and the sandbox
 * is one of those the user keeps (usage.ts). The user's `user` actor decides both, so the session
 * asks there: before its sandbox is created or started it takes a hold of sandbox time, and with it
 * a place when it has no sandbox; while the sandbox runs it trades each hold for the next when it is
 * over; when the sandbox stops, by the session's doing or its own, it reports what ran. The stretch
 * being counted is in `meta.meter`, so it outlasts a sleep and a restart. When the allowance is used
 * up, a turn that runs is stopped at the end of its hold, with a line that says so, and its sandbox
 * is suspended with its files as they are.
 *
 * A prompt can come with the key of its submission (submissions.ts; docs/architecture.md, "A message sent twice"):
 * the session takes a key once. The keys of its newest messages are in `meta.submissions`, each with
 * what its prompt was answered, kept in the synchronous step that takes the message, so a prompt with
 * one of them is answered from there before anything is awaited and adds nothing; a prompt that is
 * still being decided has its later attempts wait for it (`SessionVars.attempts`).
 *
 * Codes of the UserErrors the contract's actions throw, besides those of auth.ts:
 *   session_not_found   the session was deleted, or never properly created
 *   empty_prompt, prompt_too_long, bad_effort, bad_model   `prompt()`: its input
 *   chatgpt_required    `prompt()`: the user has no ChatGPT sign-in
 *   too_many_running    `prompt()`: as many of the user's hosted sessions are busy as they may have (never for one on a machine of theirs)
 *   allowance_used      `prompt()`, `changes()`, `diff()`, `publish()`: too little of the user's sandbox time is left today for a turn or a paused sandbox to start
 *   too_many_sandboxes  `prompt()`: the session needs a sandbox and its user keeps as many as they may
 *   usage_unavailable   the same four: the user's sandbox time could not be checked, so nothing was started
 *   steer_unavailable   `prompt()`: a turn is in progress and cannot take the message now
 *   turn_running        `prompt()` during a push, or `stopCall()` when the session’s machine is not answering
 *   bad_idempotency_key, idempotency_key_reused   `prompt()`: its key is no key, or came with another text before
 *   bad_answer, note_too_long   `answer()`: its input
 *   no_question         `answer()`: that question is not pending (any more)
 *   bad_choice          `answer()`: the question does not offer that choice
 *   bad_call            `stopCall()`: its input
 *   no_turn             `stopCall()`: no turn is running
 *   sandbox_error, internal_error   a failure of the sandbox layer, with or without a sentence for the user
 *   publish_blocked, github_gone, github_denied, publish_failed, bad_message   `publish()` (contract.ts)
 *   bad_input           `setPublishUnasked()`: its input (`publish_blocked` for a session without a connected repository)
 *   bad_server          `approveServer()`, `forgetServer()`: their input
 *   server_gone, server_changed   `approveServer()`: the session knows no such server, or it does not wait with that definition
 *   machine_unreachable `internalDestroy()` (the user's `deleteSession`): the machine's actor could not record the removal of the sandbox
 */

import { canReuseSnapshot, canSaveSnapshot, DEFERRED_INPUTS, digest, snapshotGeneration, snapshotWriter, snapshotPrompt, type SnapshotRequest } from "../sandbox/snapshot-key.js";

import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { actor, event, UserError } from "rivetkit";
import {
	PUBLISH_DENY,
	PUBLISH_SESSION,
	PUBLISH_WITHDRAWN,
	type PublishAllowed,
	publishAllowedWords,
	publishDeclined,
	publishFailed,
	publishQuestionWords,
	publishRequest,
	publishUnanswered,
	publishUnaskedProblem,
	publishAsksEveryTime,
	publishedForAgent,
	oldSandbox,
	agentPushedLine,
	callLine,
	fetchedForAgent,
	nothingToPush,
	pushRequest,
	pushedForAgent,
} from "../agent-publish.js";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, authenticate, clientError, describeError, isSandboxUserError, checkGeneration, disconnectRevoked, requireService, requireServiceFor } from "../auth.js";
import { config, snapshotsFor } from "../config.js";
import {
	generatedSessionTitle,
	isMachineIdName,
	machineLabel,
	type AcpUpdate,
	type ModelList,
	type LiveDelta,
	type ItemReview,
	type ReviewRecord,
	MAX_NOTE_CHARS,
	MAX_PROMPT_CHARS,
	MAX_PUBLISH_BODY_CHARS,
	MAX_PUBLISH_TITLE_CHARS,
	MAX_REMEMBERED_SUBMISSIONS,
	type PendingQuestion,
	type PromptInput,
	type PublishMessage,
	type PublishResult,
	type PublishState,
	type HostAllowed,
	type PullRequestInfo,
	type RepositoryCheck,
	type SandboxPlace,
	type SandboxProfileId,
	type SessionServers,
	type SessionSnapshot,
	type SetRequestedSecretInput,
	type SessionStatus,
	type SessionSummary,
	type StartTimes,
	SETUP_OUTPUT_CHARS,
	type TimelineItem,
	type TurnOutcome,
	type TurnUsage,
	type UsageNumbers,
	type Verified,
	type WindlassEvent,
	type WorkspaceFile,
	WIDE_HOSTS,
	largerHostedSize,
	type HostedSize,
	isHostedSize,
	outOfMemoryWords,
} from "../contract.js";
import { emptyNetwork, limitNetwork, unionNetwork, watchNetwork } from "../blocked-network.js";
import { billing } from "../billing/config.js";
import type { BlockedNetwork, NetworkBlockedItem } from "../contract.js";
import { blockedHostNote, hostsForTurn } from "../repository-network.js";
import { GithubError, githubApp, type InstallationToken } from "../github/app.js";
import { cloneCommand, WORKSPACE_GIT_START, actuallyPushed, changedReviewPaths, checkoutPreparedReviewBase, checkoutReview, materializeInput, removeInputs } from "../github/git.js";
import { INPUTS_DIRECTORY } from "../factory/cross-repo.js";
import { OFFLINE_REPOSITORY } from "../runner/egress.js";
import { HOSTED_OFFLINE_REPOSITORY, isHostName } from "../sandbox/e2b/network.js";
import { type PublishEvidence, BaseMergeConflict, updateBranchFromBase, PullProblem, type Published, type StoredRepository, branchFor, cloneRepository, describePull, hasUnpushedWork, openFromPushed, publishWork, pushWork, putOnWork, refreshPull } from "../github/publish.js";
import { GithubProblem, problemOf, resolveBoundRepository, resolveRepository, type StoredConnection } from "../github/repos.js";
import { layerFor } from "../layer.js";
import { ModelProblem, checkEffort, chosenModel, plannerEffort, standInModels } from "../account-models.js";
import type { AccessToken, OutOfMemory, RunTurnInput, RunTurnResult, SandboxHandle, SandboxLayer, TurnAnswer, TurnCheckpoint, TurnControl, TurnPersonalServer, TurnPublishRequest, TurnQuestion, TurnServer, TurnServerQuestion } from "../sandbox/api.js";
import { RUNNER_SOCKET, MachineUnreachable, RunnerLink, machineActor } from "../sandbox/runner-layer.js";
import type { ConversationRecord } from "../runner/channel.js";
import { OutgoingJournal, forgetConversation, migrateJournal, readCheckpoint, readConversation, saveCheckpoint, saveReceived } from "../runner/journal.js";
import { runSetupCommand, stopCutOffSetup, stopLeftoverSetup } from "../sandbox/setup.js";
import { ACCOUNT_SECRET_PROJECT, type OpenedAccountSecret, accountSecretsFor, accountSecretsNote, turnEnvironment } from "../account-secrets.js";
import { unaskedNote } from "../personal-servers.js";
import { type CommandSandbox, NO_REDACTION, type OpenedSecret, type Redactor, SecretRedactor, SecretProblem, MAX_SECRET_REQUESTS, secretRequestLimit, validRequestedSecretName, cleanSecretValue, sealSecret, commandSandbox, openSecret, setupEnvironment } from "../repo-secrets.js";
import { type KnownServer, type ServerApproval, knownServers, projectOf, sameServers, serversView } from "../server-approvals.js";
import {
	SERVER_START,
	type ServerQuestionContext,
	forgettingWords,
	serverApprovedNote,
	serverExpiredNote,
	serverForgottenNote,
	serverNotNowNote,
	serverPanelApprovedNote,
	serverPanelWords,
	serverQuestionWords,
	serverRecalledNote,
	serverUnansweredNote,
	unsetRemedy,
} from "../server-question.js";
import { OutputTail, type UnfinishedSetup, lastLines, setupNote, setupProjectOf } from "../setup-command.js";
import { Attempts, type Submission, SubmissionProblem, isRepeat, submissionOf } from "../submissions.js";
import { VerificationLog, groupReviewPaths } from "../verified.js";
import { serverSealer } from "../signin/seal.js";
import { agentTurn, turnTokens } from "../factory/budget.js";
import { cutTurnUsage, cutTurnUsageNote, reportedModelUsage, usesPlatformModel, type HoldReport, type OpenStretch, type PendingAsk, UNCHECKED_IDLE_NOTE, UNCHECKED_TURN_NOTE, USAGE_UNAVAILABLE, allowanceRefusal, closingReports, freedNote, foundStoppedAt, holdDeadline, hostedLimitsApply, idleSuspendedNote, sandboxRefusal, stoppedBy, stretchSeconds, turnStoppedNote } from "../usage.js";
import { judgeChecks } from "../environments.js";
import { outputExcerpt } from "../factory/check-environment.js";
import { runBaseTests, type BaseTestResult, type NamedTests } from "../factory/base-tests.js";
import { PlatformChecks } from "../sandbox/platform-checks.js";
import { itemActor, grantIsValid, type EnvironmentBuildOrigin, type EnvironmentBuildResult, type ReserveAnswer, type SealedSecrets, secretsActor, sessionSandboxInput, type SessionCreateInput, userActor } from "./internal.js";
import type { AgentAsk, AgentReport } from "../agent-publish.js";
import { attachmentStore, uploadShots } from "../sandbox/attach.js";
import { REPORT_TAKEN, askPerson, requestSecret, secretRequestNotice } from "../agent-publish.js";
import { RULES } from "../factory/blueprint.js";
import { DATA_DIR } from "../sandbox/provider.js";
import { planReviewOf, type PlanReview } from "../factory/autonomy.js";
import { reviewerTask } from "../factory/reviewer-task.js";
import { resetTime, windlassAccountKey, type LimitEvent, type UsageObservation } from "../provider-usage.js";
import { type ProviderRefusal, limitObservation, publicUsageEvent, refusalMessage, stepRefusal, turnRefusal } from "../provider-refusal.js";
import { untrustedTurn, unmarkedNote } from "../factory/untrusted.js";
import { earlierContext, fileReport, fileReview, NO_REPO_SHOTS, REVIEW_PROFILE_REASON, ReviewCommands, reviewerAllowed } from "../factory/review.js";
import type { Fact, ItemProviderRefusal, UntrustedRefusal } from "../factory/types.js";
import { DeploymentFull, PLATFORM_RESTART, observeSandbox } from "../sandbox/api.js";
import { leaseState } from "../sandbox/relay-leases.js";
import { StartClock, keepStartTimes, startTimesLog } from "../start-times.js";
import { ACP_ITEM_LIMIT, boundedAcpItem, jsonPrefix } from "./acp-item.js";
import { AcpPromptRequired } from "../sandbox/acp-harness.js";
import { initialSessionModes } from "../sandbox/profiles.js";
import { codexModes, innerModesReason, SANDBOX_ESCAPE_REFUSED } from "../sandbox/codex-modes.js";
import { harnessName, itemModeOf, itemSignInChanged, itemSignInMessage, machineHarness, machineHarnesses, initialHarnessModels, machineLoginMessage, sessionCapabilities } from "../sandbox/harnesses.js";
import { stepLimitNote } from "../sandbox/platform-steps.js";
import { type HarnessId, capabilitiesOf, harnessOf } from "../sandbox/harness.js";
import { privateSessionData } from "../sandbox/session-data.js";
import type { ItemPublishAnswer } from "./work-item.js";
import { fetchBase, sessionRepository } from "../github/publish.js";
import { CRASHES_ALLOWED, type PauseReason, type TurnRun, addUsage, crashCount, pausedLine, resumePrompt, restartShellResult, resumedLine, segmentLimit, sessionWholeTask } from "./turn-resume.js";
import { ConversationLost } from "../runner/channel.js";
import { type EndedFact, type InboxRow, reviewEndedFactOf, INBOX_TABLES, itemTurnText, OUTBOX_ACTION, deliveryOf, endedFact, endedFactOf, flushOutbox, inboxRow, machineUnavailable, markEnded, markTaken, publishReceipt, queueMessage, receive, rememberPublish, requestTurn, requeue, rowOfTurn, sendOutbox, settleTokenReceipts, turnFlags, waitingRows, withdrawWaiting } from "./session-inbox.js";

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

const CLONE_TIMEOUT_MS = 3 * 60 * 1000;
/** How long one turn may run before the platform stops it. WLP_TURN_TIMEOUT_MS overrides it. */
const TURN_TIMEOUT_MS = config.turnTimeoutMs;
const GIT_TIMEOUT_MS = 30 * 1000;
const MAX_DIFF_CHARS = 400_000;
/** Timeline rows per INSERT statement. */
const WRITE_BATCH = 100;
/** Items wait at most this long before they are written, or until this many have gathered. */
const FLUSH_DELAY_MS = 400;
const FLUSH_AT = 200;
/** The most streaming deltas kept for late joiners; the oldest go first. */
const MAX_PENDING = 5_000;
/** How long a positive ChatGPT sign-in check is trusted before a prompt asks again. */
const SIGNED_IN_FRESH_MS = 5 * 60 * 1000;
/** How long shutdown waits for a stopped turn to wind down. */
const STOP_WAIT_MS = 10_000;
/** How long the end of a turn waits for the `user` actor to take the new summary. */
const REPORT_WAIT_MS = 5_000;
/** A slow machine actor may delay profile availability, but the session timeline must still open. */
const PROFILE_WAIT_MS = 2_000;

/**
 * Going to sleep has to be over before the server exits. On SIGTERM RivetKit drains every actor at
 * once and exits after SHUTDOWN_GRACE_MS (registry.ts), whether or not they are done. `onSleep` waits
 * for these, one after the other:
 *
 *   | Step                                           | Wait            | ms     |
 *   |------------------------------------------------|-----------------|--------|
 *   | stop the turn, which closes it in the timeline | STOP_WAIT_MS    | 10 000 |
 *   | save the timeline and the session              | (SQLite)        | small  |
 *   | suspend the sandbox                            | SUSPEND_WAIT_MS |  4 000 |
 *   | set the idle check, report the summary and     | SETTLE_WAIT_MS  |  2 000 |
 *   | what the sandbox ran of its hold               |                 |        |
 *   | save again                                     | (SQLite)        | small  |
 *
 *   STOP_WAIT_MS + SUSPEND_WAIT_MS + SETTLE_WAIT_MS + SLEEP_MARGIN_MS <= SHUTDOWN_GRACE_MS
 *
 * The margin is for the two saves and RivetKit's own work after `onSleep`. The session's own
 * `sleepGracePeriod` is longer and does not bind on shutdown. A suspend that is not done in time is
 * left to the provider: E2B pauses the sandbox at its own timeout, and Docker finishes the stop it
 * was asked for. The idle check and the report that do not finish are not needed: the check set
 * before stays until a new one is stored, and the next report brings the user's list up to date.
 * What the sandbox ran is kept with the session when it cannot be reported in time, and reported when
 * the session is next awake (`sendUnsettled`).
 */
export const SHUTDOWN_GRACE_MS = 20_000;
const SUSPEND_WAIT_MS = 4_000;
const SETTLE_WAIT_MS = 2_000;
const SLEEP_MARGIN_MS = 4_000;
if (STOP_WAIT_MS + SUSPEND_WAIT_MS + SETTLE_WAIT_MS + SLEEP_MARGIN_MS > SHUTDOWN_GRACE_MS) {
	throw new Error("The waits of going to sleep add up to more than the shutdown grace period.");
}
/** How long a turn waits for the `user` actor to say whether a server's approval is remembered, before it asks the user instead. */
const RECALL_WAIT_MS = 10_000;

/** How long a setup run's output gathers before it is sent on, and how much of it makes it go at once. */
const SETUP_FLUSH_MS = 120;
const SETUP_FLUSH_CHARS = 8_000;

const DELTA_TYPES = new Set(["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"]);
const SIGN_IN_REMEDY = "Sign in with ChatGPT again, then send the prompt once more.";
const WINDLASS_OUTCOMES: readonly TurnOutcome[] = ["succeeded", "unresolved", "failed", "stopped", "interrupted"];

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface SessionMeta {
	secretRequest?: SessionSnapshot["secretRequest"];
	/** Plain sessions have no item run. Count requests and remember skipped names across their turns. */
	secretAsks?: number;
	secretRefusalRun?: string;
	declinedSecrets?: string[];
	/** The current conversation has seen outside text, including turns on harnesses without a taint marker. */
	secretRequestBlocked?: boolean;
	size?: number;
	/** A session that only builds the repository's prepared environment (user-environments.ts): one turn, no agent. */
	environmentBuild?: EnvironmentBuildOrigin;
	/** The validated environment the current sandbox started from (SessionSummary.environment); null once it has another. */
	environment?: SessionSummary["environment"] | null;
	/** Hosted, where the layer offers sizes: what its sandboxes are made in. A sandbox keeps its size; another is a new sandbox. */
	hostedSize?: HostedSize;
	/** The sandbox whose running out of memory a turn's end noted: its restart at the next connect is not asked about again. */
	memoryNoted?: string;
	uid: string;
	sessionId: string;
	demo: boolean;
	title: string;
	/** Set by a person at creation or rename. Absent on older sessions. */
	titleIsTyped?: boolean;
	place: SandboxPlace;
	profile: SandboxProfileId;
	model: string;
	mode: string;
	availableModes: SessionSummary["availableModes"];
	/** The last few turns' start times (start-times.ts), oldest first. Absent on sessions that have had no turn since. */
	startTimes?: StartTimes[];
	repoUrl: string | null;
	createdAt: number;
	updatedAt: number;
	status: SessionStatus;
	turns: number;
	lastOutcome: TurnOutcome | null;
	/** The sandbox this session was given, kept when it turns out to be gone so the next turn can say so. */
	sandboxId: string | null;
	sandbox: "none" | "running" | "paused";
	/**
	 * The sandbox whose Windlass data directory is a volume of its own, as its provider said when it was
	 * made (`SandboxHandle.ownData`): that data goes with it. Another id, or none, is a sandbox whose data
	 * is the user's shared volume.
	 */
	ownDataSandbox?: string | null;
	/**
	 * Why the session's sandbox hands the account's secrets to no MCP server, or to some only, as its
	 * last turn found it (account-secrets.ts, `accountSecretsNote`); null where it hands them all over.
	 * Said in the panel beside the user's own servers.
	 */
	accountSecrets?: string | null;
	/** Whether `repoUrl` has been cloned into the current sandbox. */
	cloned: boolean;
	/** The agent this session runs. Absent means Windlass. */
	harness?: HarnessId;
	harnessModels?: ModelList | null;
	/** The harness's own conversation id, kept across turns. */
	windlassSessionId: string | null;
	/** True for a conversation opened with the feature summary's tool list. */
	summaryConversation?: true;
	turnStartedAt: number | null;
	/** When this session was created, last ran a turn, or last used its workspace. */
	lastUsedAt: number;
	/** The idle check the durable schedule holds: its id, and when it fires. */
	idleCheck?: { id: string; at: number } | null;
	/** The last turn ended on an approval nobody answered in a hosted sandbox: the sandbox pauses at once, not after the idle time. */
	pauseNow?: true;
	/** Set when the session was launched on a repository of the user's GitHub connection (`repoUrl` is its address). */
	repo?: StoredRepository | null;
	/** The branch the platform pushes the session's work to: named when it first pushes, and kept. */
	publishBranch?: string;
	/**
	 * The commit the session's branch at GitHub is at, as far as the session knows: its last push, or
	 * what a new sandbox's clone found there (someone else's commit, maybe). What "nothing new" is told by.
	 */
	pushedHead?: string | null;
	/**
	 * The commit the platform itself last pushed to that branch, by any of its pushes. The only commit a
	 * push of the agent's, or of an item's step, may replace when the branch was rebased (github/git.ts
	 * `pushScript`'s lease): never one someone else pushed. Absent for a session from before it was kept.
	 */
	platformPushed?: string | null;
	/** Whether the workspace had commits GitHub lacks when it was last asked, and what that answer was for (`unpushedWork`). */
	unpushed?: { key: string; value: boolean } | null;
	/** The session's pull request, as GitHub last described it. */
	pull?: PullRequestInfo | null;
	/** What the session's work rests on since its last turn ended (verified.ts): what a pull request's description is given. */
	verified?: Verified | null;
	/**
	 * Whether the agent may have the platform publish without the user being asked each time
	 * (`SessionSummary.publishUnasked`). Absent or false: each request is put to the user.
	 */
	publishUnasked?: boolean;
	/**
	 * The copy of Windlass's session that is kept outside the sandbox, where sessions live in the sandbox
	 * and a bucket is configured (sandbox/backup.ts): which Windlass session it is of, the archive's size
	 * and hash, which a restore is checked against, and the turn it was saved after. Null or absent: none.
	 */
	backup?: { windlassSessionId: string; size: number; sha256: string; at: number; turn: number } | null;
	/** The last turn that may have changed Windlass's session. The copy is behind while its `turn` is lower. */
	memoryTurn?: number;
	/** Set once the session's data was too large to copy and the timeline said so: nothing is packed again while the limit is no higher. */
	backupStopped?: { size: number; limit: number } | null;
	/** Windlass's memory was restored into a new sandbox, and it has not yet been told that the workspace is a fresh one. */
	freshWorkspace?: boolean;
	/** The timeline said once that text from someone else went to this session's agent as labelled text only (factory/untrusted.ts). */
	untrustedUnmarkedNoted?: boolean;
	/** Windlass said this session's conversation holds untrusted content (`taint.noticed`), and has not cleared it since. */
	tainted?: boolean;
	/**
	 * The MCP servers the project's configuration names, as Windlass last described them to a turn of this
	 * session (server-approvals.ts). Absent or empty: it named none, or no turn has asked yet.
	 */
	servers?: KnownServer[];
	/** When `servers`, or what is remembered of their approvals through this session, last changed. */
	serversChangedAt: number;
	/**
	 * Set when the repository was cloned into the current sandbox and its setup command has not been run
	 * there: the clone's directory, relative to the workspace. Sessions cloned before there were setup
	 * commands have none: a sandbox the agent has worked in is not set up after the fact.
	 */
	setupDue?: string | null;
	/**
	 * The hosts the network list of the session's repository allowed when a turn last read it, and any
	 * allowed from here since (repository-network.ts): every connect to a hosted sandbox adds them to the
	 * deployment's. Absent: none.
	 */
	networkHosts?: string[];
	/** The blocked hosts the timeline named for the sandbox it has now: each is named once per sandbox (`noteBlockedHosts`). */
	hostsNoted?: string[];
	/** Lifetime totals and a monotone receipt for the item actor. */
	blocked?: { revision: number; network: BlockedNetwork };
	snapshotCommit?: string | null;
	cloneDirectory?: string;
	/** A cross-repo feature's planning turn put its other repositories' trees in the workspace (`planningInputs`). */
	planningInputs?: true;
	/** The setup run in progress, as its starting item has it. Still set when the actor wakes: the run was cut off with its server. */
	setupRunning?: { id: string; command: string; limitMs: number } | null;
	/** A setup run in the current sandbox that did not succeed, of which the agent has not been told yet. */
	setupUnfinished?: UnfinishedSetup | null;
	/**
	 * Set when a sandbox made in place of a lost one was cloned for a session that had pushed: the clone
	 * is on the base, where the setup command runs, and is to be put on the session's `branch` at the
	 * commit GitHub had (`at`) only after it (`putWorkspaceOnWork`), in the clone's `directory`. Kept until
	 * that is done, so a turn cut off in between does not run the setup on the branch next time.
	 */
	workDue?: { branch: string; at?: string; directory: string; setupBase?: string; setUp?: boolean } | null;
	/** The workspace was put on the session's branch after a setup run on the base, and the agent has not been told that its branch's dependencies were not installed by it. */
	setupOnBase?: { branch: string; base: string } | null;
	/**
	 * The stretch of the sandbox running that is being counted (usage.ts): the hold the session has of
	 * its user's sandbox time, and since when it runs. Null or absent while the sandbox does not run.
	 */
	meter?: OpenStretch | null;
	/** What the sandbox ran of holds that the user's actor has not been told yet: told again when the session is next awake. */
	unsettled?: HoldReport[];
	/**
	 * The hold asked for last, stored before it was asked for, until its answer comes (usage.ts,
	 * `PendingAsk`): an answer that was lost, before a sleep or not, does not leave a hold nobody settles.
	 */
	meterAsked?: PendingAsk | null;
	/**
	 * The messages that were taken with a key (submissions.ts), the newest MAX_REMEMBERED_SUBMISSIONS:
	 * the key, the digest of the text it came with, and what the prompt was answered. A prompt that
	 * comes with one of these keys is that message again: it is answered from here and adds nothing.
	 * A key older than these is forgotten, and a prompt with it is a new message. Absent in a session
	 * no message came to with a key.
	 */
	submissions?: Array<Submission & PromptAnswer>;
	/** Set for a work item's session: its turns come from the item's deliveries (session-inbox.ts), and no person prompts it. Absent: a person's. */
	origin?: SessionCreateInput["origin"];
	review?: ItemReview;
	reviewBase?: string;
	/** The run that owns this checkout. Late cleanup for an earlier run cannot free it. */
	reviewRun?: number;
	/** For a session on one of the user's machines: the machine's name at launch. */
	machineName: string | null;
	/** What the item's agent last filed with `report`: the pull request's title and description. */
	report?: (AgentReport & { run: number }) | null;
	/**
	 * With WLP_TURN_RESUME, the running turn's own record (turn-resume.ts): what pausing and resuming it
	 * needs. Set when a turn is accepted, removed when it ends. `paused` in it, with status "paused": the
	 * turn waits to resume.
	 */
	run?: TurnRun | null;
}

/** What `prompt()` answers: the turn the message is in, and whether it was steered into one that ran. */
type PromptAnswer = { turn: number; steered: boolean };

/** A question put to the user: the copy the clients see, and the ways to settle the layer's promise. */
interface Asked {
	pending: PendingQuestion;
	/** Declines it for the platform when nobody answers. Unset while a server's question stands aside. */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Each settles the promise the layer waits on; only the first call of either does anything. */
	answer(answer: TurnAnswer): void;
	decline(note?: string): void;
	/** A question about a project's server only: shows it, the first time and again after it stood aside, with a new time to answer in. */
	put?(): void;
	/** A question about a project's server only: the definition it is about. */
	server?: { name: string; fingerprint: string };
}

/** How a question about a request of the agent's to publish ended. */
type PublishAnswer =
	| { kind: "allowed"; how: "once" | "session" }
	/** `note` is what the user wrote for the agent. */
	| { kind: "declined"; note?: string }
	| { kind: "expired" }
	/** The call or the turn ended before anyone answered. */
	| { kind: "withdrawn" };

interface ActiveTurn {
	/** The turn is being stopped so that it pauses instead of ending (`pauseTurn`): its server is going away, or its machine went. */
	pausing?: PauseReason;
	/** A segment that resumes a paused turn (`resumePaused`): why it paused, for how long, and what the person sent meanwhile. */
	resume?: { reason: PauseReason; pausedMs: number; held: string[] };
	finishNetwork?: () => Promise<void>;
	/** What the turn would need to be taken up again by a restarted server (`RunTurnInput.onCheckpoint`), read with each timeline write. */
	checkpoint?: () => TurnCheckpoint | null;
	/** A turn a restarted server takes up: its process goes on (`RunTurnInput.reattach`). */
	reattach?: TurnCheckpoint;
	planMode?: boolean;
	openAcp?: () => NewItem | null;
	/** A user choice queued for the next prompt takes precedence over this turn’s ACP updates. */
	modeQueued?: boolean;
	number: number;
	effort: string | null;
	controller: AbortController;
	done: Promise<void>;
	/** The layer's handle for steering the turn and stopping one call; null until Windlass has started it. */
	control: TurnControl | null;
	/** The question the turn waits on. It is held here and nowhere else: when the turn goes, so does it. */
	question: Asked | null;
	/** The questions of this turn whose promise the layer may still be waiting on. */
	unsettled: Set<Asked>;
	/**
	 * Questions about the project's servers that are open and not shown: one that stepped aside for a
	 * tool call's question, or one that came while another was shown. Put again, oldest first, when
	 * `question` is free.
	 */
	aside: Asked[];
	/**
	 * The definitions (`<name>:<fingerprint>`) this turn had Windlass start from the user's remembered
	 * approval, without putting the question, each with that approval: the line about it says so.
	 */
	recalled: Map<string, ServerApproval>;
	/** True once the turn is being stopped: no question is put any more. */
	stopping: boolean;
	/** True once the turn is being closed: nothing of it can be steered, stopped or answered any more. */
	closed: boolean;
	/**
	 * The secrets of the session's repository and of its user's account, with their values, and the
	 * user's own MCP servers, for this turn. Held here and nowhere else: not in `meta`, not in SQLite.
	 * Null until they were read.
	 */
	secrets: HeldSecrets | null;
	/** What Windlass's events say of this turn's checks (verified.ts). */
	checks: VerificationLog;
	/** True once the platform published or pushed for the agent in this turn: what it pushed had not been through the turn's checks. */
	published?: boolean;
	/** The agent's requests to publish or push that are being handled: the turn does not close under a push. */
	publishes: Set<Promise<string>>;
	/** True once the turn was stopped because its user's sandbox time for the day is used up: its sandbox is suspended when it has closed. */
	outOfTime?: boolean;
	/**
	 * Set for a turn taken from the inbox: its row, with the slot the user's turn queue gave it; what the
	 * agent reported in it; and, when the sandbox layer refused to start a sandbox because the
	 * deployment's are all in use, that cap: the delivery then waits again instead of ending.
	 * `pushedAtStart` is the commit the platform had last pushed when the turn was taken: one the agent
	 * pushed itself since counts as a change of this turn's, whatever the workspace says at its end.
	 */
	item?: { row: InboxRow & { slot: string }; report: AgentReport | null; /** The question the agent asked its person in this turn (`ask_person`): at most one. */ asked?: AgentAsk | null; full: number | null; machineAway?: MachineUnreachable["reason"]; withdrawn?: boolean; started: boolean; /** A cross-repo feature's planning turn: its other repositories' trees are in place (`planningInputs`). */ crossRepoPlan?: boolean; planReview?: PlanReview; said?: string; pushedAtStart: string | null; policyRefusal?: true; refused?: string | null; /** With `refused`: someone else's text on "Docker, hardened" (factory/untrusted.ts). */ untrustedRefusal?: UntrustedRefusal; providerRefusal?: ItemProviderRefusal; /** Codex asked to leave its sandbox, and the turn was stopped: the platform's note. */ escaped?: string; /** The turn's sandbox could not be prepared (`openSandbox` threw): what went wrong. */ sandboxFailed?: string; /** Its sandbox ran out of memory in or before this turn. */ outOfMemory?: OutOfMemory };
}

/**
 * What a turn holds of what its user saved: the repository's secrets with their values, the
 * account's secrets with theirs, the user's own MCP servers, and what takes every one of those
 * values out of text.
 */
interface HeldSecrets {
	requestedNames?: string[];
	/** Read before the turn had a number (the prompt's own row is redacted with them): what could not be opened, for the turn to tell once. */
	unopened: string[];
	snapshotSetup?: SealedSecrets["snapshotSetup"];
	environment?: SealedSecrets["environment"];
	screenshots: boolean;
	/** The repository's; none for a session that is not on a repository of the GitHub connection. */
	opened: OpenedSecret[];
	/** The account's, all of them: one whose name a secret of the repository has is not handed over (account-secrets.ts). */
	account: OpenedAccountSecret[];
	/** The user's own MCP servers, as Windlass's configuration takes them. */
	servers: TurnPersonalServer[];
	/** The checks the user saved for the session's repository (repository-checks.ts); none for a session that is not on one. */
	checks: RepositoryCheck[];
	/** The hosts its repository's network list allows (repository-network.ts); absent when the user's actor did not say. */
	network?: string[];
	/** When they were asked for: a host allowed from the session after this is not in them (`SessionVars.hostsAllowed`). */
	networkAt?: number;
	redactor: Redactor;
}

/** Agent-session sockets can outlive a browser login and can be served on a different host. */
async function sessionCaller(c: { key: string[]; client(): unknown }, params: unknown) {
	const caller = authenticate(c.key, params);
	if (caller.kind === "user") checkGeneration(caller, await userActor(c, c.key[0]).internalTokenGeneration());
	return caller;
}

/** The caller, who must be the session's user; answers with their id. */
async function requireSessionUser(c: { key: string[]; client(): unknown; conn?: { params: unknown } | null }): Promise<string> {
	const caller = await sessionCaller(c, c.conn?.params);
	if (caller.kind !== "user") throw new UserError("This action is for users.", { code: "forbidden" });
	return caller.profile.uid;
}

async function maySubscribe(c: Parameters<typeof requireSessionUser>[0]): Promise<boolean> {
	try {
		await requireSessionUser(c);
		return true;
	} catch {
		return false;
	}
}

interface SessionVars {
	savingSecret?: boolean;
	/** Null for an actor that `user` did not create: it rejects everything and removes itself. */
	meta: SessionMeta | null;
	/** A build session's result, once its setup and checks ran (`buildEnvironment`); reported when its turn has closed. */
	environmentResult?: EnvironmentBuildResult;
	nextSeq: number;
	/** Timeline items not yet in SQLite, in `seq` order. */
	unwritten: TimelineItem[];
	flushTimer: ReturnType<typeof setTimeout> | null;
	/** True while a write of the waiting items is queued and has not started. */
	flushQueued: boolean;
	/** The tail of the write queue. */
	serial: Promise<unknown>;
	pending: LiveDelta[];
	turn: ActiveTurn | null;
	/** True while `prompt` is deciding, so a second prompt cannot slip in between its awaits. */
	accepting: boolean;
	/** The prompts with a key that are being decided: another attempt of one of them ends as it does (submissions.ts). */
	attempts: Attempts<PromptAnswer>;
	/** Admission of the last ordinary ACP prompt, including follow-ups waiting for their own turns. */
	nextPrompt?: Promise<PromptAnswer>;
	destroying: boolean;
	/** True once the actor is going to sleep or being destroyed. */
	stopping: boolean;
	reporting: Promise<void> | null;
	reportAgain: boolean;
	/** Still closing this inbox row after the agent itself went idle. */
	closingItem?: string;
	signedInUntil: number;
	/** A suspend or removal of the idle sandbox under way; a prompt or a read of the workspace waits for it. */
	idling: Promise<void> | null;
	/**
	 * How many operations have the session's sandbox now (`takeSandbox`): a prompt from its acceptance to
	 * the end of its turn, a push, a read of the workspace, and the suspend, removal or free that `idling`
	 * names. While any has it, nothing suspends or removes the sandbox (`busy`). This instance's only: an
	 * operation goes with the instance, and so does its count.
	 */
	sandboxOps: number;
	/** The one check of named tests on the item’s base running in this sandbox. */
	baseTest?: string;
	/** The copy of the workspace taken when the last turn ended; undefined until it is read from SQLite. */
	workspace: WorkspaceCopy | null | undefined;
	/** The tail of the queue that sets the idle check, so two of them cannot cross. */
	arming: Promise<void>;
	/** True while the platform commits and pushes the workspace: no turn starts under it, and no second push. */
	publishing: boolean;
	/** The key of the delivery `takeDelivered` is taking, while it does: the same delivery sent again meanwhile leaves its slot alone. */
	delivering?: string | null;
	/** When GitHub was last asked about the session's pull request. */
	pullCheckedAt: number;
	/** Whether the workspace has commits GitHub lacks, as last read from the sandbox, and what it was read for. */
	unpushed: { key: string; value: boolean | null } | null;
	/** Fires when the running sandbox's hold is over, or when an unused sandbox would have stopped by itself (`armMeter`). */
	meterTimer: ReturnType<typeof setTimeout> | null;
	/** The tail of the queue of calls to the user's meter: a hold is traded or settled by one of them at a time. */
	metering: Promise<unknown>;
	/**
	 * `Sandboxes.idleStopMs` of this session's own layer, read when it takes a hold or wakes, for the
	 * meter's timer. Lost with the instance and read again: nothing is settled from it before then.
	 */
	idleStopMs: number | null;
	/**
	 * Counts the creates, connects, suspends and destroys of the session's sandbox. A read of the
	 * sandbox's state that was asked before the count moved describes a sandbox that is no more, and is
	 * dropped. This instance's only: a read in flight goes with it.
	 */
	sandboxGen: number;
	/**
	 * The stretch the session's stored state had open as the actor woke (its `useOf`), with the
	 * `sandboxGen` of then, until the sandbox's real state is known (`wakeMeter`). Its sandbox may have
	 * stopped by itself while no server counted it: see `carriedOver`.
	 */
	carried: { use: string; gen: number } | null;
	/**
	 * For a session on one of its user's machines: the conversation with the machine's runner, over its
	 * socket to this actor. This instance's alone, never stored: one that wakes starts a new one.
	 */
	runner: RunnerLink | null;
	/**
	 * With WLP_RUNNER_DURABLE_TURNS, the writer that stores the runner conversation's outgoing frames
	 * (runner/journal.ts), and the conversation read back when the actor woke with a turn to take up.
	 */
	journal: OutgoingJournal | null;
	restored: ConversationRecord | null;
	/** When the wake that takes a machine turn up after a crash was last scheduled (`armTakeUp`). */
	takeUpArmedAt: number;
	/** True while a paused turn is being resumed (`resumePaused`): nothing else takes the session meanwhile. */
	resuming: boolean;
	/** Re-arms the wake that resumes the running turn after a crash (`heartbeat`); null between turns. */
	heartbeat: ReturnType<typeof setInterval> | null;
	/** The stop of a setup cut off with the server (`stopCutOffSetup`): a turn waits for it before it uses the sandbox. */
	setupReap: Promise<void> | null;
	/** The running turn's start clock (start-times.ts), which `openSandbox` tells when the sandbox and the workspace are ready. */
	startClock: StartClock | null;
	/**
	 * The hosts allowed from this session (`allowHost`), with when: a turn whose list of hosts was read
	 * before one of them keeps it all the same (`openSandbox`). This instance's only: a turn that starts
	 * on another reads the list after the click.
	 */
	hostsAllowed: Map<string, number>;
}

/** What the helpers below need of an actor context; every hook's and action's `c` fits. */
interface Ctx {
	vars: SessionVars;
	db: RawAccess;
	key: string[];
	log: { info(entry: unknown): void; warn(entry: unknown): void; error(entry: unknown): void };
	broadcast(name: string, ...args: unknown[]): void;
	// biome-ignore lint/suspicious/noExplicitAny: the registry's type would be circular here
	client(): any;
	keepAwake<T>(promise: Promise<T>): Promise<T>;
	schedule: { at(timestamp: number, action: string, ...args: unknown[]): Promise<string>; cancel(id: string): Promise<boolean> };
}

type NewItem =
	| Omit<NetworkBlockedItem, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "user" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "platform" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "acp" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "windlass" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "setup" }>, "seq" | "at">
	| Omit<Extract<TimelineItem, { kind: "turn.ended" }>, "seq" | "at">;

/** A failure of a turn whose message is fit to show as it is. */
class TurnProblem extends Error {}

/** A confirmed checkout or policy failure. Transport and provider failures use the interruption budget. */
class ReviewRefused extends TurnProblem {}

/** How long the panel's publish waits for a push under way before it says so: well inside the action's own limit. */
const PUBLISH_WAIT_MS = 60_000;

/** Resolves true once no push of the platform's is under way (`c.vars.publishing`), false when `ms` ran out first. */
async function publishingSettled(c: Ctx, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	while (c.vars.publishing) {
		if (Date.now() >= until) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return true;
}

/** `publishSession`'s refusal for a GitHub problem, with whether trying again later can cure it: GitHub was out of reach, or the push took too long. */
class PublishRefused extends UserError {
	constructor(
		message: string,
		code: string,
		readonly transient: boolean,
	) {
		super(message, { code });
	}
}

function layerOf(c: Ctx, meta: SessionMeta): Promise<SandboxLayer> {
	return layerFor(meta.place, c.key[0]!, meta.place.kind === "machine" ? runnerLink(c, meta.place.machineId) : null);
}

/** The session's link to its machine's runner, made the first time the session needs the machine. */
function runnerLink(c: Ctx, machineId: string): RunnerLink {
	if (!c.vars.runner) {
		const [uid, sessionId] = c.key as [string, string];
		const client = c.client();
		c.vars.runner = new RunnerLink(
			{ uid, sessionId, machineId, machineName: c.vars.meta?.machineName },
			machineActor(() => client, uid, machineId),
			(reason) => {
				console.log(`[wlp] runner.conversation_ended session=${sessionId} machine=${machineId}: ${reason}`);
			},
			// What the banner says of the machine, to an open page, each time it changes. Not while stopping:
			// RivetKit refuses a broadcast then ("Actor stopping"), and the link's `close()` notes too.
			(reach) => {
				if (!c.vars.stopping) c.broadcast("machine", reach);
			},
			durableTurns(c) ? { from: c.vars.restored, onDirty: () => conversationDirty(c) } : undefined,
		);
		c.vars.restored = null;
	}
	return c.vars.runner;
}

/** WLP_RUNNER_DURABLE_TURNS: a machine session keeps its runner conversation and its turn's protocol state (runner/journal.ts). */
function durableTurns(c: Ctx): boolean {
	return config.machines?.durableTurns === true && c.vars.meta?.place.kind === "machine";
}

/** How often a turn that can be taken up after a crash re-arms the wake that would take it up. */
const TAKE_UP_ARM_MS = 60_000;

/** The runner conversation has something to store: frames to write ahead, or more received than committed. */
function conversationDirty(c: Ctx): void {
	const journal = c.vars.journal ??= new OutgoingJournal(c.db, () => c.vars.runner?.channel ?? null, () => {
		// What was received is committed with the timeline it produced: a write comes soon, items or not.
		const channel = c.vars.runner?.channel;
		if (channel && channel.receivedCount > 0) scheduleWrite(c, true);
	});
	journal.dirty();
}

/**
 * While a machine turn can be taken up, a wake is kept scheduled a minute ahead: a server that crashed
 * runs no `onSleep`, and this brings the session back within the runner's grace on whichever server
 * is up. A wake with nothing to take up does nothing.
 */
function armTakeUp(c: Ctx): void {
	const now = Date.now();
	if (c.vars.stopping || now - c.vars.takeUpArmedAt < TAKE_UP_ARM_MS / 2) return;
	c.vars.takeUpArmedAt = now;
	void c.schedule.at(now + TAKE_UP_ARM_MS, "internalTakeUp").catch((error: unknown) => c.log.warn({ msg: "could not schedule the wake that takes a machine turn up after a crash", error: describeError(error) }));
}

/** The runner's own socket to the session: it proves itself in its first frame, not with a user's token. */
function isRunnerSocket(request: Request | undefined): boolean {
	return request !== undefined && new URL(request.url).pathname === `/websocket/${RUNNER_SOCKET}`;
}

function summaryOf(meta: SessionMeta): SessionSummary {
	return {
		id: meta.sessionId,
		...(meta.harness ? { harness: meta.harness } : {}),
		capabilities: sessionCapabilities(meta.harness),
		...(meta.harnessModels !== undefined ? { harnessModels: meta.harnessModels } : {}),
		title: meta.title,
		place: meta.place,
		profile: meta.profile,
		...(meta.hostedSize && { hostedSize: meta.hostedSize }),
		model: meta.model,
		mode: meta.mode,
		availableModes: meta.availableModes,
		repoUrl: meta.repoUrl,
		...(meta.repo ? { repository: repositoryOf(meta.repo), pullRequest: meta.pull ?? null, publishUnasked: meta.publishUnasked === true } : {}),
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		status: meta.status,
		...(meta.status === "paused" && meta.run?.paused ? { paused: { reason: meta.run.paused.reason, since: meta.run.paused.at, held: meta.run.held?.length ?? 0 } } : {}),
		turns: meta.turns,
		lastOutcome: meta.lastOutcome,
		...(meta.startTimes?.length ? { startTimes: meta.startTimes } : {}),
		sandbox: meta.sandbox,
		...(meta.servers && meta.servers.length > 0 ? { servers: { count: meta.servers.length, changedAt: meta.serversChangedAt } } : {}),
		...(meta.origin ? { item: { id: meta.origin.itemId, role: meta.origin.role ?? "builder", ...(meta.origin.planCritic && { planCritic: true }) } } : {}),
		...(meta.environmentBuild ? { environmentBuild: true as const } : {}),
		...(meta.environment ? { environment: meta.environment } : {}),
	};
}

function liveMeta(c: Ctx): SessionMeta {
	const meta = c.vars.meta;
	if (!meta || c.vars.destroying) throw new UserError("That agent does not exist.", { code: "session_not_found" });
	return meta;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/** Runs `job` after every job queued before it, whether those succeeded or not. */
function serial<T>(c: Ctx, job: () => Promise<T>): Promise<T> {
	const run = c.vars.serial.then(job, job);
	c.vars.serial = run.catch(() => undefined);
	return run;
}

async function insertItems(db: Pick<RawAccess, "execute">, batch: TimelineItem[]): Promise<void> {
	await db.execute(
		`INSERT OR REPLACE INTO timeline (seq, turn, kind, at, item) VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
		...batch.flatMap(item => [item.seq, item.turn, item.kind, item.at, JSON.stringify(item)]),
	);
}

/** Writes the waiting items, a batch per statement. Only ever called from inside the queue. */
async function writeItems(c: Ctx): Promise<void> {
	if (c.vars.runner?.durable) return writeDurably(c);
	const waiting = c.vars.unwritten;
	while (waiting.length > 0) {
		const batch = waiting.slice(0, WRITE_BATCH);
		const meta = c.vars.meta;
		const receipts = meta && usesPlatformModel(meta.place, meta.harness) ? batch.flatMap(item => {
			if (item.kind !== "windlass") return [];
			const tokens = turnTokens(reportedModelUsage(item.event));
			return Number.isSafeInteger(tokens) && tokens > 0 ? [{ seq: item.seq, at: item.at, tokens }] : [];
		}) : [];
		const network = batch.some(item => item.kind === "network.blocked") ? meta?.blocked : undefined;
		if (receipts.length || network) {
			// These are the model requests summed by the turn summary. Keep their original UTC day
			// and sequence number, including when a turn is interrupted or a delivery is retried.
			await c.db.transaction(async tx => {
				await insertItems(tx, batch);
				for (const receipt of receipts) await queueMessage(tx, { to: "tokens", receipt });
				if (network && meta) {
					await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
					if (meta.origin) await queueMessage(tx, { to: "network", itemId: meta.origin.itemId, ...network });
				}
			}, { name: "timeline.usage" });
			if (!c.vars.stopping && (receipts.length || meta?.origin)) await flushOutbox(c, meta!.uid).catch(() => sendOutbox(c, meta!.uid));
		} else await insertItems(c.db, batch);
		// Items made meanwhile were added behind the batch.
		waiting.splice(0, batch.length);
	}
}

/**
 * `writeItems` for a machine session whose runner conversation is kept (runner/journal.ts): what was
 * received, the timeline it produced and the turn's checkpoint, read in one synchronous step and written
 * in one transaction, and only then acknowledged to the runner. A server that stops at any moment has
 * either all of it or none: the runner sends again whatever is past the stored count, so each of its
 * messages is taken once.
 */
async function writeDurably(c: Ctx): Promise<void> {
	const channel = c.vars.runner!.channel;
	const waiting = c.vars.unwritten;
	// From here to the transaction nothing is awaited: the count, the items and the checkpoint say the same moment.
	const conversation = channel.conversationId;
	const received = channel.receivedCount;
	const turn = c.vars.turn;
	const checkpoint = turn?.checkpoint?.() ?? null;
	const items = waiting.slice();
	const meta = c.vars.meta;
	let flush = false;
	let stored = false;
	await c.db.transaction(async tx => {
		for (let at = 0; at < items.length; at += WRITE_BATCH) {
			const batch = items.slice(at, at + WRITE_BATCH);
			const receipts = meta && usesPlatformModel(meta.place, meta.harness) ? batch.flatMap(item => {
				if (item.kind !== "windlass") return [];
				const tokens = turnTokens(reportedModelUsage(item.event));
				return Number.isSafeInteger(tokens) && tokens > 0 ? [{ seq: item.seq, at: item.at, tokens }] : [];
			}) : [];
			const network = batch.some(item => item.kind === "network.blocked") ? meta?.blocked : undefined;
			await insertItems(tx, batch);
			for (const receipt of receipts) await queueMessage(tx, { to: "tokens", receipt });
			if (network && meta) {
				await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
				if (meta.origin) await queueMessage(tx, { to: "network", itemId: meta.origin.itemId, ...network });
			}
			if (receipts.length || (network && meta?.origin)) flush = true;
		}
		// While a process waits to be taken up, the output kept for it is in no item yet: nothing of it counts as stored.
		if (c.vars.runner?.holding) return;
		stored = await saveReceived(tx, conversation, received);
		// A checkpoint goes with the timeline of its moment; none (the turn is not one to take up) takes the old one out.
		await saveCheckpoint(tx, turn?.number ?? 0, checkpoint);
	}, { name: "timeline.durable" });
	waiting.splice(0, items.length);
	if (stored) channel.committed(conversation, received);
	if (checkpoint) armTakeUp(c);
	if (flush && !c.vars.stopping) await flushOutbox(c, meta!.uid).catch(() => sendOutbox(c, meta!.uid));
}

/** Brings SQLite up to date with memory: the waiting items and the meta row. Never throws. */
function persist(c: Ctx): Promise<void> {
	if (c.vars.flushTimer) {
		clearTimeout(c.vars.flushTimer);
		c.vars.flushTimer = null;
	}
	return serial(c, async () => {
		await writeItems(c);
		// Cancel can outlive the actor's shutdown grace. Save the current run at the next
		// sequence number without closing it to live clients. Its next real item replaces
		// this row; on wake MAX(seq) includes it as the final text before interruption.
		const partial = c.vars.turn?.stopping && c.vars.turn.openAcp?.();
		if (partial) await insertItems(c.db, [numberItem(c, partial)]);
		if (c.vars.meta) await c.db.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(c.vars.meta));
	}).catch((error) => {
		// The items stay in `unwritten`, so the next write tries again and snapshots still show them.
		c.log.error({ msg: "could not write the session to SQLite", error: describeError(error) });
	});
}

function queueWrite(c: Ctx): void {
	if (c.vars.flushQueued) return;
	c.vars.flushQueued = true;
	void serial(c, async () => {
		c.vars.flushQueued = false;
		await writeItems(c);
	}).catch((error) => {
		c.log.error({ msg: "could not write the timeline to SQLite", error: describeError(error) });
	});
}

/** A turn can produce thousands of items: they are written in batches, shortly after they are made. `always`: a durable conversation's count is due, items or not. */
function scheduleWrite(c: Ctx, always = false): void {
	if (c.vars.flushQueued) return;
	if (always && c.vars.unwritten.length === 0 && !c.vars.flushTimer) {
		c.vars.flushTimer = setTimeout(() => {
			c.vars.flushTimer = null;
			queueWrite(c);
		}, FLUSH_DELAY_MS);
		return;
	}
	if (c.vars.unwritten.length >= FLUSH_AT) {
		queueWrite(c);
		return;
	}
	if (c.vars.flushTimer) return;
	c.vars.flushTimer = setTimeout(() => {
		c.vars.flushTimer = null;
		queueWrite(c);
	}, FLUSH_DELAY_MS);
}

function numberItem(c: Ctx, item: NewItem, at = Date.now()): TimelineItem {
	// Network observations scrub their free text before aggregation. Keep protocol enum values intact.
	const redactor = c.vars.turn?.secrets?.redactor;
	const numbered = { ...(redactor && item.kind !== "network.blocked" ? redactor.deep(item) : item), seq: c.vars.nextSeq, at } as TimelineItem;
	return numbered.kind === "acp" ? boundedAcpItem(numbered) : numbered;
}

/**
 * Adds an item to the timeline: numbers it, announces it, and queues it for SQLite. Synchronous. While
 * a turn holds its repository's secrets, their values are taken out of every text of the item first,
 * whatever wrote it: nothing a turn adds to the timeline carries one.
 */
function append(c: Ctx, item: NewItem, at?: number): TimelineItem {
	const full = numberItem(c, item, at);
	c.vars.nextSeq += 1;
	c.vars.unwritten.push(full);
	c.broadcast("item", full);
	scheduleWrite(c);
	return full;
}

function note(
	c: Ctx,
	turn: number,
	level: "info" | "warn" | "error",
	text: string,
	mark: { code: "question_expired" | "question_allowed"; call: { messageId: string; callId: string } } | { code: "turn_paused" | "turn_resumed" } | null = null,
): void {
	append(c, { turn, kind: "platform", level, text, ...(mark ?? {}) });
}

// ---------------------------------------------------------------------------------------------
// Announcing
// ---------------------------------------------------------------------------------------------

/** Sends summaries to the `user` actor until the newest one has been sent. */
async function reportLoop(c: Ctx): Promise<void> {
	// Yields first, so that `report` has stored this promise before the loop can possibly end.
	await Promise.resolve();
	try {
		while (c.vars.reportAgain && c.vars.meta) {
			c.vars.reportAgain = false;
			try {
				await userActor(c, c.vars.meta.uid).internalSessionChanged(summaryOf(c.vars.meta));
			} catch (error) {
				c.log.warn({ msg: "could not report the session's summary to its user", error: describeError(error) });
			}
		}
	} finally {
		// In the same step as the loop's last check: a `report` that comes later starts a new loop.
		c.vars.reporting = null;
	}
}

/** Sends the newest summary to the `user` actor; calls that arrive meanwhile collapse into one more. */
function report(c: Ctx): Promise<void> {
	c.vars.reportAgain = true;
	if (c.vars.reporting) return c.vars.reporting;
	const loop = reportLoop(c);
	c.vars.reporting = loop;
	// The report is short; holding the actor awake for it keeps the user's list from going stale.
	// During shutdown nothing new can be held awake: `onSleep` waits for the report itself.
	if (!c.vars.stopping) void c.keepAwake(loop);
	return loop;
}

/** Tells connected clients and the `user` actor that the summary changed. */
function publish(c: Ctx): void {
	const meta = c.vars.meta;
	if (!meta) return;
	c.broadcast("summary", summaryOf(meta));
	void report(c);
}

function noteSandbox(c: Ctx, meta: SessionMeta, state: SessionMeta["sandbox"], use: string | null = useOf(meta), pausedAt?: number): void {
	// Found stopped without the session having stopped it: the stretch being counted ended with it. A turn settles when it closes.
	// `use` is the meter's when the state was asked for: a hold taken while the answer came is not the one found stopped.
	if (state !== "running" && meta.meter && !c.vars.turn && !c.vars.accepting) void closeMeter(c, meta, "found", use, pausedAt);
	if (meta.sandbox === state) return;
	meta.sandbox = state;
	publish(c);
	void persist(c);
}

// ---------------------------------------------------------------------------------------------
// The streaming state kept for clients that connect mid-turn
// ---------------------------------------------------------------------------------------------

function keepDelta(vars: SessionVars, delta: LiveDelta): void {
	vars.pending.push(delta);
	if (vars.pending.length > MAX_PENDING) vars.pending.splice(0, vars.pending.length - MAX_PENDING + 500);
}

/**
 * Drops the deltas a durable event makes redundant: the event carries what they were building up to.
 * `text.ended` replaces the message's text deltas, `reasoning.ended` its reasoning deltas, `tool.called`
 * a call's input deltas, `tool.settled` a call's progress, and the end of a step everything of its message.
 */
function settleDeltas(vars: SessionVars, durable: WindlassEvent): void {
	if (vars.pending.length === 0) return;
	const data = durable.data ?? {};
	const messageId = data.messageId;
	const callId = data.callId;
	let redundant: (event: WindlassEvent) => boolean;
	switch (durable.type) {
		case "text.ended":
			redundant = (event) => event.type === "text.delta" && event.messageId === messageId;
			break;
		case "reasoning.ended":
			redundant = (event) => event.type === "reasoning.delta" && event.messageId === messageId;
			break;
		case "tool.called":
			redundant = (event) => event.type === "tool.input.delta" && event.messageId === messageId && event.callId === callId;
			break;
		case "tool.settled":
			redundant = (event) => (event.type === "tool.progress" || event.type === "tool.input.delta") && event.messageId === messageId && event.callId === callId;
			break;
		case "step.ended":
		case "step.failed":
			redundant = (event) => event.messageId === messageId;
			break;
		case "execution.succeeded":
		case "execution.failed":
		case "execution.interrupted":
			redundant = () => true;
			break;
		default:
			return;
	}
	vars.pending = vars.pending.filter((delta) => !("event" in delta && redundant(delta.event)));
}

/** One durable item per contiguous run of text; a reconnect sees the same prefix as live clients. */
export function acpRecorder(c: Ctx, turn: number) {
	type TextKind = "agent_message_chunk" | "agent_thought_chunk";
	let run: { kind: TextKind; key: string; text: string; remaining: number; truncated: boolean } | null = null;
	let items = 0;
	let warned = false;
	function admit(): boolean {
		if (items < MAX_PENDING) {
			items++;
			return true;
		}
		if (!warned) note(c, turn, "warn", `Further ACP updates were omitted after ${MAX_PENDING.toLocaleString("en-US")} timeline items in this turn.`);
		warned = true;
		return false;
	}
	function textUpdate(kind: TextKind, text: string): AcpUpdate {
		return { sessionUpdate: kind, content: { type: "text", text } };
	}
	function current(): NewItem | null {
		if (!run) return null;
		return { turn, kind: "acp", messageKey: run.key, update: textUpdate(run.kind, run.text), ...(run.truncated && { truncated: true }) };
	}
	if (c.vars.turn) c.vars.turn.openAcp = current;
	function flush() {
		const item = current();
		if (!run || !item) return;
		const { key } = run;
		run = null;
		c.vars.pending = c.vars.pending.filter(delta => !("acp" in delta && delta.messageKey === key));
		append(c, item);
	}
	return {
		flush,
		update(update: AcpUpdate) {
			const kind = update.sessionUpdate;
			if ((kind === "agent_message_chunk" || kind === "agent_thought_chunk") && update.content?.type === "text" && typeof update.content.text === "string") {
				if (run?.kind !== kind) {
					flush();
					if (!admit()) return;
					const key = `acp-${turn}-${c.vars.nextSeq}`;
					// Other timeline events can advance seq before flush. Reserve both numbers and the marker now.
					const envelope = { turn, kind: "acp", messageKey: key, update: textUpdate(kind, ""), seq: Number.MAX_SAFE_INTEGER, at: Number.MAX_SAFE_INTEGER, truncated: true };
					run = { kind, key, text: "", remaining: ACP_ITEM_LIMIT - JSON.stringify(envelope).length, truncated: false };
				}
				if (run.truncated) return;
				const piece = jsonPrefix(update.content.text, run.remaining);
				run.truncated = piece.text.length < update.content.text.length;
				if (!piece.text) return;
				run.remaining -= piece.size;
				run.text += piece.text;
				c.broadcast("delta", { turn, acp: textUpdate(kind, piece.text), messageKey: run.key });
				const pending = { turn, messageKey: run.key, acp: textUpdate(kind, run.text) };
				const last = c.vars.pending.at(-1);
				if (last && "acp" in last && last.messageKey === run.key) c.vars.pending[c.vars.pending.length - 1] = pending;
				else keepDelta(c.vars, pending);
				return;
			}
			flush();
			if (admit()) append(c, { turn, kind: "acp", update });
		},
	};
}

function onWindlassEvent(c: Ctx, meta: SessionMeta, turn: number, event: WindlassEvent): void {
	if (typeof event !== "object" || event === null || typeof event.type !== "string") return;
	if (typeof event.sessionId === "string" && event.sessionId !== "" && meta.windlassSessionId !== event.sessionId) {
		// Remembered at once: if this turn is lost, the next one can still continue Windlass's session.
		meta.windlassSessionId = event.sessionId;
		// Another session of Windlass's: nothing is recorded in it yet.
	}
	if (DELTA_TYPES.has(event.type)) {
		const delta: LiveDelta = { turn, event };
		keepDelta(c.vars, delta);
		c.broadcast("delta", delta);
		return;
	}
	settleDeltas(c.vars, event);
	append(c, { turn, kind: "windlass", event });
}

// ---------------------------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------------------------

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * `git status`, without taking a lock an agent's own git command could trip over. Like every git of the
 * platform's in the workspace, after `WORKSPACE_GIT_START` (github/git.ts): it runs outside Windlass's
 * sandbox, so a repository whose configuration would make git start a program is not run in at all.
 */
export const STATUS_COMMAND = `${WORKSPACE_GIT_START}\ngit --no-optional-locks status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all`;

/**
 * `git diff` against the last commit with new files included. The equivalent of `git add -N .` is done
 * in the private repository, using its copy of the files and index.
 */
export const DIFF_COMMAND = [
	WORKSPACE_GIT_START,
	"git add -N . >/dev/null",
	// Without a commit there is nothing to compare with but the empty tree.
	"if git rev-parse -q --verify HEAD >/dev/null; then base=HEAD; else base=4b825dc642cb6eb9a060e54bf8d69288fbee4904; fi",
	`git --no-pager diff --no-color --no-ext-diff --no-textconv --ignore-submodules=all "$base" | head -c ${MAX_DIFF_CHARS}`,
].join("\n");

function parseStatus(output: string): WorkspaceFile[] {
	const files: WorkspaceFile[] = [];
	const fields = output.split("\0");
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (field.length < 4) continue;
		const status = field.slice(0, 2);
		files.push({ path: field.slice(3), status });
		// A rename or copy is followed by the path it came from.
		if (status.includes("R") || status.includes("C")) index += 1;
	}
	return files;
}

function tail(text: string, lines = 6, chars = 800): string {
	const kept = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line !== "")
		.slice(-lines)
		.join("\n");
	return kept.length > chars ? kept.slice(-chars) : kept;
}

interface SnapshotPlan {
	writer: boolean;
	key: SnapshotRequest;
	commit: string;
	defaultBranch: string;
	command: string;
	updatedAt: number | null;
}
async function setupRevision(app: NonNullable<ReturnType<typeof githubApp>>, connection: StoredConnection, repo: StoredRepository, revision: string) {
	const resolved = await sessionRepository(app, connection, repo, "read");
	const { owner, name, defaultBranch } = resolved.repository;
	const inputs = await app.withToken(resolved.installation.id, { repositoryId: repo.id, permissions: { metadata: "read", contents: "read" } },
		token => app.setupInputs(token, owner, name, revision), { revokeAfter: true });
	return { ...inputs, defaultBranch };
}

async function snapshotPlan(c: Ctx, meta: SessionMeta, secrets: HeldSecrets | null, layer: SandboxLayer): Promise<SnapshotPlan | null> {
	if (!secrets?.snapshotSetup || !layer.sandboxes.hasSnapshot || !canReuseSnapshot(snapshotsFor(meta.place), meta.harness, secrets.opened.length)) return null;
	const repo = meta.repo, project = setupProjectOf(meta), app = githubApp();
	if (!project || !app || !repo) return null;
	try {
		const saved = secrets.snapshotSetup, command = saved.command;
		const revision = meta.origin?.role === "reviewer" ? meta.reviewBase : meta.origin?.childBranch?.start ?? repo.branch;
		if (!revision) return null;
		const key = { repo: String(repo.id), attempt: randomBytes(16).toString("hex"), generation: snapshotGeneration(String(repo.id), saved.updatedAt, saved.connectedAt) };
		// A build always starts cold, and is the only kind of session that saves an image (environments.ts).
		if (meta.environmentBuild) {
			if (meta.pushedHead || meta.windlassSessionId) return null;
			return { key: { ...key, inputs: DEFERRED_INPUTS }, commit: "", defaultBranch: repo.branch, writer: true, command, updatedAt: saved.updatedAt };
		}
		// Only a validated environment's image is started from: one that is not ready and current at this place, or not
		// there at all, leaves the session to start cold, as it would with none.
		if (!secrets.environment?.usable || !saved.previouslySaved || !(await layer.sandboxes.hasSnapshot(meta.uid, key.repo))) return null;
		const connection = await githubConnection(c, meta);
		if (!connection || connection.connectedAt !== saved.connectedAt) return null;
		const { commit, dependencies, defaultBranch } = await setupRevision(app, connection, repo, revision);
		if (!dependencies) return null;
		return { writer: false, key: { ...key, inputs: digest([dependencies, saved.command]) },
			commit, defaultBranch, command, updatedAt: saved.updatedAt };
	} catch { return null; } // A missing permission, truncated tree or unavailable API still allows a normal clone.
}

async function restorePrepared(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, plan: SnapshotPlan | null, validated?: SealedSecrets["environment"]) {
	const source = sandbox.snapshot, repo = meta.repo, app = githubApp();
	if (!source || !repo || !app || !plan || source.attempt !== plan.key.attempt || source.repo !== plan.key.repo || source.inputs !== plan.key.inputs || source.generation !== plan.key.generation) return false;
	const work = meta.origin?.role !== "reviewer" && meta.pushedHead ? meta.publishBranch : null;
	const connection = await githubConnection(c, meta);
	if (!connection || snapshotGeneration(String(repo.id), plan.updatedAt, connection.connectedAt) !== source.generation) return false;
	const fetchedWork = await fetchBase(app, connection, repo, sandbox, work);
	let head: string;
	if (meta.origin?.role === "reviewer") {
		const pinned = await checkoutPreparedReviewBase(sandbox, repo.branch, plan.commit);
		if (!pinned.ok) return false;
		head = pinned.marks.get("work") ?? "";
		if (head !== plan.commit) return false;
		repo.baseSha = plan.commit;
	} else if (meta.origin?.childBranch) {
		head = await putOnWork(sandbox, ".", meta.origin.childBranch.name, meta.origin.childBranch.start);
		repo.baseSha = head;
	} else head = await putOnWork(sandbox, ".", repo.branch);
	if (head !== plan.commit) {
		// The branch moved during startup. Decide using the immutable tree we actually checked out.
		const latest = await setupRevision(app, connection, repo, head);
		if (latest.commit !== head || digest([latest.dependencies, plan.command]) !== source.inputs) return false;
	}
	const saved = await userActor(c, meta.uid).internalSetupCommand(setupProjectOf(meta)!.key);
	if (saved.command !== plan.command || saved.updatedAt !== plan.updatedAt) return false;
	if (work && fetchedWork) meta.workDue = { branch: work, directory: "." };
	else if (work) {
		meta.pushedHead = null;
		note(c, turn, "warn", `${work} is no longer at GitHub, so the workspace starts from ${repo.branch} again. Work that was only on that branch is not in it.`);
	}
	c.vars.unpushed = null;
	meta.cloneDirectory = ".";
	meta.cloned = true;
	meta.setupDue = null;
	meta.snapshotCommit = source.commit;
	meta.environment = validated?.usable ? { commit: validated.commit, validatedAt: validated.validatedAt, checks: validated.checks } : null;
	note(c, turn, "info", meta.environment
		? `Started from a validated environment: setup and ${meta.environment.checks === 1 ? "the saved check" : `${meta.environment.checks} saved checks`} passed at ${meta.environment.commit.slice(0, 12)} on ${new Date(meta.environment.validatedAt).toISOString()}.`
		: `Started from a prepared sandbox. Setup ran at ${source.commit} on ${new Date(source.created).toISOString()}.`);
	await persist(c);
	return true;
}

/** What every connect to the session's sandbox is told: the hosts its repository's network list allows, for a hosted one. */
function connectOptions(meta: SessionMeta): { network?: string[] } {
	return meta.place.kind === "hosted" && meta.networkHosts && meta.networkHosts.length > 0 ? { network: meta.networkHosts } : {};
}

/** How many blocked hosts the timeline names for one sandbox. */
const MAX_HOSTS_NOTED = 40;

/**
 * Names in the timeline each host a command in the session's hosted sandbox looked up and could not
 * reach (the sandbox's `blockedHosts`, from its lookup stub), once per sandbox, and files them as
 * requests on its repository's network list. Only where the deployment's hosted sandboxes are
 * `restricted`, where a list can help. Never throws: it only reports.
 */
async function noteBlockedHosts(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, layer: SandboxLayer, observed: (hosts: string[]) => void): Promise<void> {
	if (meta.place.kind !== "hosted" || !sandbox.blockedHosts || layer.sandboxes.egress?.() !== "restricted") return;
	const allowed = new Set(meta.networkHosts ?? []);
	const noted = new Set(meta.hostsNoted ?? []);
	if (noted.size >= MAX_HOSTS_NOTED) return;
	let found: string[];
	try {
		// What was named already is left out before the stub's log is cut to its first names, so it cannot hide a later one.
		found = await sandbox.blockedHosts([...allowed, ...noted]);
	} catch (error) {
		c.log.warn({ msg: "could not read which hosts the sandbox could not reach", error: describeError(error) });
		return;
	}
	const named = found.filter((host) => !allowed.has(host) && !noted.has(host) && (!c.vars.turn?.secrets || c.vars.turn.secrets.redactor.text(host) === host)).slice(0, MAX_HOSTS_NOTED - noted.size);
	if (named.length === 0) return;
	observed(named);
	meta.hostsNoted = [...noted, ...named];
	const project = setupProjectOf(meta);
	for (const host of named) append(c, { turn, kind: "platform", level: "warn", text: blockedHostNote(host, project?.label ?? null), code: "host_blocked", host, ...(project ? { repository: true } : {}) });
	if (meta.hostsNoted.length >= MAX_HOSTS_NOTED) note(c, turn, "info", `This sandbox's timeline names at most ${MAX_HOSTS_NOTED} hosts its commands could not reach, and has named them; it names no more until the agent has a new sandbox.`);
	console.log(`[wlp] network.blocked session=${meta.sessionId} hosts=${named.length}`);
	if (project) {
		const filed = await userActor(c, meta.uid)
			.internalNetworkRequests({ sessionId: meta.sessionId, hosts: named })
			.catch((error: unknown) => {
				c.log.warn({ msg: "could not file the blocked hosts as requests", error: describeError(error) });
				return null;
			});
		// The requests already waiting are kept over new ones: what a command looks up cannot push out a host a person may want.
		const left: string[] = filed?.full ?? [];
		if (left.length > 0) note(c, turn, "info", `${left.length === 1 ? "1 host was" : `${left.length} hosts were`} not filed as a request for ${project.label}: it has as many waiting as it keeps. Allow or dismiss some in its network list to make room.`);
	}
	void persist(c);
}

/** Only the first version consumes a sequence number. A replacement is durable before its live event.
 * The session totals and the item's outbox receipt commit alongside the same timeline version. */
function blockedRecorder(c: Ctx, meta: SessionMeta, turn: number) {
	const before = meta.blocked?.network ?? emptyNetwork();
	let row: NetworkBlockedItem | undefined;
	let saved = JSON.stringify(emptyNetwork());
	return async (snapshot: BlockedNetwork) => {
		const network = limitNetwork(before, snapshot);
		const signature = JSON.stringify(network);
		if (signature === saved) return;
		const blocked = { revision: (meta.blocked?.revision ?? 0) + 1, network: unionNetwork(before, network) };
		if (!row) {
			meta.blocked = blocked;
			row = append(c, { kind: "network.blocked", revision: blocked.revision, turn, ...network }) as NetworkBlockedItem;
			await serial(c, () => writeItems(c));
		} else {
			const item = { ...row, ...network, revision: blocked.revision };
			await serial(c, async () => {
				await writeItems(c);
				await c.db.transaction(async tx => {
					await insertItems(tx, [item]);
					await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify({ ...meta, blocked }));
					if (meta.origin) await queueMessage(tx, { to: "network", itemId: meta.origin.itemId, ...blocked });
				}, { name: "session.network" });
				meta.blocked = blocked;
			});
			c.broadcast("networkBlocked", item);
			if (meta.origin) await flushOutbox(c, meta.uid);
		}
		saved = signature;
	};
}

export async function observeNetwork(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, layer: SandboxLayer) {
	const proxy = sandbox.blockedNetwork?.bind(sandbox);
	const dns = meta.place.kind === "hosted" && sandbox.blockedHosts && layer.sandboxes.egress?.() === "restricted";
	if (!proxy && !dns) return;
	const save = blockedRecorder(c, meta, turn);
	const lookups = emptyNetwork();
	let broker: string | undefined;
	let previousBrokers = emptyNetwork(), current = emptyNetwork();
	return watchNetwork(async () => {
		if (proxy) {
			const retained = meta.blocked?.network.hosts.map(({ host, port }) => ({ host, port })) ?? [];
			const snapshot = await proxy(turn, retained);
			if (broker && broker !== snapshot.broker) previousBrokers = unionNetwork(previousBrokers, current);
			broker = snapshot.broker;
			const redactor = c.vars.turn?.secrets?.redactor;
			const name = c.vars.runner?.known?.name || meta.machineName || (meta.place.kind === "machine" ? meta.place.machineId : "");
			current = { overflow: snapshot.overflow, hosts: snapshot.hosts.map(entry => {
				const host = entry.host && redactor && redactor.text(entry.host) !== entry.host ? null : entry.host;
				return { ...entry, host, machineNames: [redactor?.text(name) ?? name], allow: entry.reason === "machine_policy" && host && isHostName(host) ? "machine" : "never" };
			}) };
			await save(unionNetwork(previousBrokers, current));
		} else {
			const before = lookups.hosts.length;
			await noteBlockedHosts(c, meta, turn, sandbox, layer, names => {
				const at = Date.now();
				for (const host of names) lookups.hosts.push({ host, port: null, reason: "unlisted", allow: setupProjectOf(meta) ? "repository" : "deployment", count: 1, firstAt: at, lastAt: at });
			});
			await save(lookups);
			return lookups.hosts.length > before;
		}
	}, error => c.log.warn({ msg: "could not read blocked network requests", error: describeError(error) }), () => c.vars.stopping || c.vars.destroying);
}

/** Apply the account's size decision once, even if both the hold and the place claim observe the downgrade. */
export function applySandboxClamp(meta: Pick<SessionMeta, "hostedSize">, size: HostedSize | undefined, notify: (text: string) => void): boolean {
	if (!size || meta.hostedSize === size) return false;
	meta.hostedSize = size;
	notify(`This agent's next sandbox is ${size}: large sandboxes are part of Pro.`);
	return true;
}

// An empty pool still needs an authorized seed. Repeated cold creates for the same
// branch can reuse its head briefly. A claim always observes the head afresh.
let lastSpareHead: { key: string; commit: string; until: number } | undefined;
export async function spareHead(key: string, seedOnly: boolean, read: () => Promise<string>) {
	if (seedOnly && lastSpareHead?.key === key && Date.now() < lastSpareHead.until) return lastSpareHead.commit;
	const commit = await read();
	lastSpareHead = { key, commit, until: Date.now() + 30_000 };
	return commit;
}

export function readySetupItems(turn: number, recipe: NonNullable<SpareRecipe["connected"]>, setup: SpareSetup) {
	const item = { turn, kind: "setup" as const, id: `su_${randomBytes(6).toString("hex")}`, command: recipe.command,
		limitMs: recipe.timeoutMs, output: "", truncated: false };
	return [
		{ ...item, state: "started" as const, at: setup.startedAt, exitCode: null, durationMs: null },
		{ ...item, state: "succeeded" as const, at: setup.startedAt + setup.durationMs, exitCode: 0, durationMs: setup.durationMs },
	];
}

/** Resolve the current permission and immutable base outside the machine. A mirror alone
 * cannot establish either. Only the ordinary base checkout can run setup in advance. */
async function readyRecipe(c: Ctx, meta: SessionMeta, secrets: HeldSecrets | null, plan: SnapshotPlan | null, purpose: "claim" | "seed" | "resume" = "claim"): Promise<SpareRecipe | undefined> {
	if (!meta.repoUrl || !spareProfile(meta.profile, meta.harness) || meta.environmentBuild ||
		(purpose !== "resume" && (meta.windlassSessionId || meta.pushedHead)) || meta.origin?.role === "reviewer" || meta.origin?.owns !== undefined || plan?.writer) return;
	if (!meta.repo) return spareRecipe({ url: meta.repoUrl }) ? { url: meta.repoUrl } : undefined;
	const repo = meta.repo, project = setupProjectOf(meta), app = githubApp();
	if (!project || !app || !secrets || secrets.opened.length || secrets.unopened.length || await childSetupSeed(c, meta)) return;
	const connection = await githubConnection(c, meta);
	if (!connection) return;
	const saved = await userActor(c, meta.uid).internalSetupCommand(project.key);
	const { installation, repository } = await sessionRepository(app, connection, repo, "read");
	const key = digest([meta.uid, connection.connectedAt, installation.id, repo.id, repo.branch]);
	const commit = plan?.commit || await spareHead(key, purpose === "seed", () => app.withToken(installation.id, { repositoryId: repo.id, permissions: { metadata: "read", contents: "read" } },
		token => refHead(app, token, repository.owner, repository.name, repo.branch), { revokeAfter: true }));
	const recipe = { url: app.cloneUrl(repository.owner, repository.name), connected: { repo: String(repo.id), branch: repo.branch, commit,
		command: saved.command?.trim() ?? "", timeoutMs: config.setupTimeoutMs, generation: snapshotGeneration(String(repo.id), saved.updatedAt, connection.connectedAt) } };
	return spareRecipe(recipe) ? recipe : undefined;
}

// Restart seeds describe a base checkout. A repository with a usable environment will
// supply its prepared image selection on the next create.
export function canSeedOnResume(meta: Pick<SessionMeta, "place" | "repoUrl">, environment: HeldSecrets["environment"]) {
	return meta.place.kind === "machine" && !!meta.repoUrl && !environment?.usable;
}

/** Connects to the session's sandbox for a turn, creating it (and cloning the repository) when needed. */
async function openSandbox(c: Ctx, meta: SessionMeta, turn: number, signal: AbortSignal, layer: SandboxLayer, secrets: HeldSecrets | null, allowSnapshot = true): Promise<SandboxHandle> {
	let plan: SnapshotPlan | null = null;
	let recipe: SpareRecipe | undefined;
	let ready = false;
	// A setup cut off with the server is being stopped: let it finish first, or it could stop this turn's processes.
	await c.vars.setupReap;
	// What the repository's network list allows now: this turn's connect sets the sandbox's network to it. A host
	// allowed from the session after the list was read is kept: `allowHost` put it in `networkHosts` already.
	if (secrets?.network !== undefined) {
		const hosts = hostsForTurn(secrets.network, secrets.networkAt ?? 0, c.vars.hostsAllowed);
		meta.networkHosts = meta.place.kind === "hosted" && hosts.length > 0 ? hosts : undefined;
	}
	const connecting = Date.now();
	let handle = meta.sandboxId ? await layer.sandboxes.connect(meta.sandboxId, {
		...connectOptions(meta),
		...(allowSnapshot && canSeedOnResume(meta, secrets?.environment) && {
			spareSeed: () => readyRecipe(c, meta, secrets, null, "resume"),
			screenshots: sessionSandboxInput(meta, secrets?.screenshots).screenshots,
		}),
	}) : undefined;
	if (handle) c.vars.startClock?.sandbox(Date.now() - connecting, false);
	sandboxChanged(c);
	// An actor stopped between a create and its first connect learns it here. Only a yes is taken: a
	// runner downgraded since says nothing of a sandbox the newer one made with a volume of its own.
	if (handle?.ownData) meta.ownDataSandbox = handle.id;
	if (handle) {
		if (meta.sandbox === "paused") note(c, turn, "info", "Resuming sandbox");
		if (handle.notice) note(c, turn, "warn", handle.notice);
		noteSandbox(c, meta, "running");
	} else {
		if (meta.sandboxId) {
			note(c, turn, "warn", "The sandbox this agent was working in no longer exists, so the files it had there are gone. Starting again in a new sandbox.");
			meta.sandbox = "none";
			meta.cloned = false;
		}
		const making = Date.now();
		// What is known of a setup run, and of the Windlass that was asked, was the old sandbox's.
		meta.accountSecrets = null;
		meta.snapshotCommit = null;
		meta.environment = null;
		meta.setupDue = null;
		meta.setupRunning = null;
		meta.setupUnfinished = null;
		meta.workDue = null;
		meta.setupOnBase = null;
		meta.hostsNoted = undefined;
		await dropWorkspace(c);
		// The session holds its turn here, so it is making no other sandbox: one the provider has for it is one it never heard of.
		await sweepSandboxes(c, meta, layer);
		if (hostedLimitsApply(meta.place)) {
			// The place is claimed where the sandbox is made: the hold's reserve asked for one only if the session
			// had no sandbox then, and the one it had may have been found gone above.
			const place = await userActor(c, meta.uid).internalClaimPlace(meta.sessionId, meta.hostedSize);
			if (!place.ok) throw new TurnProblem("numbers" in place ? sandboxRefusal(place.numbers) : "The agent was deleted.");
			if (applySandboxClamp(meta, place.clampedSize, text => note(c, turn, "info", text))) {
				await persist(c);
				// The previous sandbox disappeared, or the plan changed since the reserve. Trade its hold at the new weight.
				await holdSandbox(c, meta, false);
			}
		}
		note(c, turn, "info", "Creating sandbox");
		// Held before the wait: a delete that finished meanwhile leaves no actor state to read (`c.vars` throws once it has
		// stopped), and the sandbox would be left behind, paused and holding one of the person's places. So it goes first.
		const vars = c.vars;
		plan = allowSnapshot ? await snapshotPlan(c, meta, secrets, layer) : null;
		const fromSnapshot = plan ? { ...plan.key, writer: plan.writer } : undefined;
		const id = await layer.sandboxes.create({ ...sessionSandboxInput(meta, secrets?.screenshots), fromSnapshot,
			...(allowSnapshot && meta.place.kind === "machine" && meta.repoUrl && { spareRecipe: async (ready: number) => {
				const candidate = await readyRecipe(c, meta, secrets, plan, ready === 0 ? "seed" : "claim");
				// A spare may finish after an empty report. Revalidate before accepting that claim.
				if (ready > 0) recipe = candidate;
				return candidate;
			} }),
			mirrorRepo: meta.repo ? String(meta.repo.id) : undefined, ...connectOptions(meta) });
		console.log(`[wlp] sandbox.created id=${id} session=${meta.sessionId}`);
		if (vars.destroying) {
			await layer.sandboxes.destroy(id);
			throw new TurnProblem("The agent was deleted.");
		}
		meta.sandboxId = id;
		sandboxChanged(c);
		meta.sandbox = "running";
		publish(c);
		await persist(c);
		if (c.vars.destroying) {
			// The session was deleted while its sandbox was being made.
			await layer.sandboxes.destroy(id);
			throw new TurnProblem("The agent was deleted.");
		}
		handle = await layer.sandboxes.connect(id, connectOptions(meta));
		if (!handle) throw new TurnProblem("The new sandbox disappeared right after it was created.");
		c.vars.startClock?.sandbox(Date.now() - making, true, handle.runnerStart);
		// The repository's environment at this place: its image went missing (stale, build again), or it has none yet (build one).
		if (!meta.environmentBuild && meta.repo && secrets?.snapshotSetup && canReuseSnapshot(snapshotsFor(meta.place), meta.harness, secrets.opened.length)) {
			const kind = secrets.environment?.usable ? (plan && !handle.snapshot ? "missed" : null) : "cold";
			if (kind) void c.keepAwake(userActor(c, meta.uid).internalEnvironmentNudge(meta.sessionId, kind).catch(() => undefined));
		}
		// Recorded for this sandbox from what it has, not from what the provider would make now.
		meta.ownDataSandbox = handle.ownData ? id : null;
		if (meta.windlassSessionId && (await privateSessionData(meta, layer.sandboxes, id))) {
			// Windlass's own session went with the old sandbox. Its copy is put into the new one before anything
			// else happens there; without one, asking for the session would only fail the turn.
			if (!capabilitiesOf(meta.harness).backups || !(await restoreBackup(c, meta, turn, handle, layer))) {
				meta.windlassSessionId = null;
				meta.backup = null;
				note(c, turn, "info", "The agent's memory of the conversation went with the old sandbox, so it starts this turn without it.");
			}
		}
		// Where Windlass's session outlives the sandbox, the agent remembers files this new workspace does not have, and is told.
		if (meta.windlassSessionId && !(await privateSessionData(meta, layer.sandboxes, id))) meta.freshWorkspace = true;
	}

	if (!meta.cloned && handle.readyKey) {
		// A replayed create (or connect after an actor restart) must agree with today's recipe too.
		recipe ??= allowSnapshot ? await readyRecipe(c, meta, secrets, plan).catch(() => undefined) : undefined;
		if (!recipe || digest([recipe]) !== handle.readyKey || (!handle.snapshot && recipe.connected?.command && !handle.readySetup)) {
			await layer.sandboxes.destroy(handle.id);
			meta.sandboxId = null;
			await persist(c);
			return openSandbox(c, meta, turn, signal, layer, secrets, false);
		}
		if (!handle.snapshot) {
			if (meta.repo && recipe.connected) meta.repo.baseSha = recipe.connected.commit;
			if (recipe.connected?.command && handle.readySetup) {
				for (const item of readySetupItems(turn, recipe.connected, handle.readySetup)) append(c, item, item.at);
			}
			meta.cloneDirectory = ".";
			meta.setupDue = null;
			meta.cloned = true;
			await persist(c);
		}
		ready = true;
	}

	if (!meta.cloned && handle.snapshot) {
		// A restarted actor can find the container before it recorded the successful refresh.
		if (!await restorePrepared(c, meta, turn, handle, plan, secrets?.environment).catch(() => false)) {
			await layer.sandboxes.destroy(handle.id);
			meta.sandboxId = null;
			meta.cloned = false;
			await persist(c);
			if (!allowSnapshot) throw new TurnProblem("Could not replace the prepared sandbox.");
			return openSandbox(c, meta, turn, signal, layer, secrets, false);
		}
	}

	if (ready) note(c, turn, "info", "Started from a ready sandbox.");
	const active = c.vars.turn;
	if (active) active.finishNetwork = await observeNetwork(c, meta, turn, handle, layer);

	// A repository of the user's GitHub connection is cloned with a token of the platform's own (below).
	if (meta.repo && !meta.cloned && !signal.aborted && !(await cloneConnected(c, meta, turn, handle, signal))) return handle;
	// What a setup run that was cut off with its server left running is not the agent's to find at work.
	if (meta.setupUnfinished?.state === "interrupted" && !signal.aborted) await stopLeftoverSetup(handle);
	// The repository's setup command, once in this sandbox, before Windlass is started in it, on the base; only then the session's branch.
	if (meta.repo && meta.cloned && typeof meta.setupDue === "string" && !signal.aborted) {
		await runSetup(c, meta, turn, handle, signal, secrets, plan, layer);
	}
	if (meta.origin?.role !== "reviewer" && meta.repo && meta.workDue && !signal.aborted) await putWorkspaceOnWork(c, meta, turn, handle);
	if (meta.repoUrl && !meta.cloned && !signal.aborted) {
		note(c, turn, "info", `Cloning ${meta.repoUrl}`);
		const cloned = await handle.run(cloneCommand(meta.repoUrl), { timeoutMs: CLONE_TIMEOUT_MS, signal });
		if (cloned.aborted || signal.aborted) return handle;
		if (cloned.timedOut) throw new TurnProblem(`Cloning ${meta.repoUrl} took longer than ${CLONE_TIMEOUT_MS / 60_000} minutes and was stopped.`);
		if (cloned.exitCode !== 0) {
			const why = tail(cloned.stderr || cloned.stdout, 4, 500);
			throw new TurnProblem(`Cloning ${meta.repoUrl} failed${why ? `: ${why}` : ` (exit code ${cloned.exitCode}).`}`);
		}
		meta.cloned = true;
		void persist(c);
	}
	return handle;
}

// ---------------------------------------------------------------------------------------------
// The copy of Windlass's session outside the sandbox
// ---------------------------------------------------------------------------------------------

function megabytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * Puts the copy of Windlass's session into the sandbox that was just made in place of a lost one. True
 * when the agent can go on in that session: the timeline then says so, and how far the copy reaches
 * when it is behind. False when there is no copy of that session or it could not be restored: the
 * caller starts a new Windlass session. It takes no abort signal: a restore that is cut off would leave
 * a sandbox nobody restores again, and it is a matter of seconds. Never throws.
 */
/**
 * Put before the user's prompt, for any agent, on the first turn it takes after its memory was
 * restored into a new sandbox. It remembers the files it made, and the new workspace has none of them:
 * unless it is told, it acts on what is no longer there. Only then: a sandbox that was paused has its
 * files, and a Windlass session that starts anew remembers none. The timeline keeps the prompt as the
 * user wrote it, and has its own line about the restore.
 */
const FRESH_WORKSPACE =
	"[A note from the platform, not from the user: the sandbox you were working in has been replaced by a new one. Your memory of this conversation was carried over, but the workspace was not: it is a fresh one. A repository that was cloned has been cloned again, with whatever of your work had been pushed to its branch; anything else you created or changed earlier is not in it. Look at what is there before you rely on earlier work.]\n\n";

/**
 * Why an item's turn on a machine harness cannot start: the machine's last report does not offer the
 * agent, does not say it is signed in (`signIn` "token", as filing requires), or names another sign-in
 * method than the item was filed with, which would count its tokens differently (`itemSignInChanged`).
 * Null where it can, and for Windlass. A machine that cannot be asked is left to the turn, which waits for it.
 */
async function itemSignInRefusal(c: Ctx, meta: SessionMeta): Promise<string | null> {
	const machine = machineHarness(meta.harness);
	if (!machine || meta.place.kind !== "machine") return null;
	const facts = await runnerLink(c, meta.place.machineId).facts().catch(() => null);
	if (!facts?.report) return null;
	const offered = facts.report.harnesses?.find(entry => entry.id === machine.id);
	if (!offered) return `This machine does not offer ${machine.name}.`;
	return itemSignInMessage(machine, facts.name, offered.signIn) ?? itemSignInChanged(machine, facts.name, meta.origin?.signIn, offered.method);
}

/**
 * The platform's notes before a turn's prompt, for any agent, in a person's session and an item's alike:
 * that the workspace was made from a prepared image, that it is a new one, that the setup command did
 * not succeed in it, or that the setup ran on the base. Each is told once, with the first prompt the
 * agent takes after it became true (`told`). A reviewer is told only of the prepared image: its brief
 * says what it needs of the workspace.
 */
function platformNotes(meta: SessionMeta, reviewer: boolean): { text: string; told(): void } {
	const prepared = meta.snapshotCommit ?? null;
	const fresh = !reviewer && meta.freshWorkspace === true;
	const unfinished = reviewer ? null : meta.setupUnfinished ?? null;
	const onBase = reviewer ? null : meta.setupOnBase ?? null;
	return {
		text: (prepared ? snapshotPrompt(prepared) : "") + (fresh ? FRESH_WORKSPACE : "") + (unfinished ? setupNote(unfinished) : "") + (onBase ? setupOnBaseNote(onBase) : ""),
		told() {
			if (fresh) meta.freshWorkspace = false;
			if (unfinished && meta.setupUnfinished === unfinished) meta.setupUnfinished = null;
			if (prepared && meta.snapshotCommit === prepared) meta.snapshotCommit = null;
			if (onBase && meta.setupOnBase === onBase) meta.setupOnBase = null;
		},
	};
}

async function restoreBackup(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, layer: SandboxLayer): Promise<boolean> {
	const backups = layer.backups;
	const saved = meta.backup;
	const session = meta.windlassSessionId;
	// Without a bucket nothing was ever copied, and nothing is said of it.
	if (!backups || !session) return false;
	if (!saved || saved.windlassSessionId !== session) {
		console.log(`[wlp] backup.none session=${meta.sessionId} turn=${turn}: ${saved ? "the copy is of an earlier Windlass session" : "no copy of the session was saved"}`);
		return false;
	}
	try {
		const restored = await backups.restore(sandbox, { uid: meta.uid, sessionId: meta.sessionId }, saved, session);
		if (restored.outcome !== "restored") {
			console.warn(`[wlp] backup.restore_failed session=${meta.sessionId} turn=${turn}: ${restored.outcome === "missing" ? "the bucket has no copy of the session" : restored.reason}`);
			return false;
		}
		console.log(`[wlp] backup.restored session=${meta.sessionId} turn=${turn} bytes=${saved.size} ms=${restored.ms} saved_after_turn=${saved.turn}`);
	} catch (error) {
		c.log.warn({ msg: "could not restore the copy of Windlass's session", session: meta.sessionId, error: describeError(error) });
		return false;
	}
	// What came back was small enough to copy: it is copied again from this turn on.
	meta.backupStopped = null;
	meta.freshWorkspace = true;
	// A turn whose copy could not be saved, or was too large to keep, is not in what came back.
	const missed = (meta.memoryTurn ?? saved.turn) > saved.turn ? Math.max(1, turn - 1 - saved.turn) : 0;
	if (missed === 0) note(c, turn, "info", "Restored the agent's memory of the conversation into the new sandbox.");
	else note(c, turn, "warn", `Restored the agent's memory of the conversation into the new sandbox, without the last ${missed === 1 ? "turn: no copy of it" : `${missed} turns: no copy of them`} could be saved.`);
	return true;
}

/**
 * Copies Windlass's session out of the sandbox when a turn has ended: the turn's process is gone, so
 * nothing has the files open. The session's record of the copy is what a later restore is checked
 * against. A save that fails is not tried again by itself: the next turn's save copies the whole
 * session again, and trying later would mean starting a sandbox that was suspended to cost nothing.
 * The user is told nothing then; it matters only if the sandbox is lost before a save works, and the
 * restore says so. A session too large to copy is said once. Never throws.
 */
async function saveBackup(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, layer: SandboxLayer): Promise<void> {
	const backups = layer.backups;
	const session = meta.windlassSessionId;
	if (!backups || !(await privateSessionData(meta, layer.sandboxes, sandbox.id)) || !session) return;
	// Until a copy is saved below, the one there is, if any, is behind this turn.
	meta.memoryTurn = turn;
	// A session that is going away needs no copy, and an actor that is stopping has no time for one.
	if (c.vars.stopping || c.vars.destroying) return;
	const stopped = meta.backupStopped;
	// Windlass's log only grows: what was too large is not packed again to find that out.
	if (stopped && backups.maxBytes <= stopped.limit) return;
	try {
		const saved = await backups.save(sandbox, { uid: meta.uid, sessionId: meta.sessionId });
		if (saved.outcome === "saved") {
			meta.backup = { windlassSessionId: session, ...saved.backup, turn };
			meta.backupStopped = null;
			console.log(`[wlp] backup.saved session=${meta.sessionId} turn=${turn} bytes=${saved.backup.size} ms=${saved.ms}`);
		} else if (saved.outcome === "too_large") {
			console.log(`[wlp] backup.too_large session=${meta.sessionId} turn=${turn} bytes=${saved.size} limit=${saved.limit}`);
			const earlier = meta.backup?.windlassSessionId === session;
			if (!stopped) {
				note(
					c,
					turn,
					"warn",
					`The agent's memory of the conversation has grown to ${megabytes(saved.size)}, and the platform keeps a copy of at most ${megabytes(saved.limit)}, so it is no longer copied out of the sandbox. If this sandbox is lost, the agent ${earlier ? "will not remember the conversation from here on" : "starts without its memory of the conversation"}.`,
				);
			}
			meta.backupStopped = { size: saved.size, limit: saved.limit };
		} else if (saved.outcome === "failed") {
			console.warn(`[wlp] backup.save_failed session=${meta.sessionId} turn=${turn}: ${saved.reason}`);
		}
	} catch (error) {
		c.log.warn({ msg: "could not copy Windlass's session out of the sandbox", session: meta.sessionId, error: describeError(error) });
	}
}

/** The sessions whose copy was removed already, or handed to the `user` actor, so that a delete asks the bucket once. */
const backupRemoved = new WeakSet<SessionMeta>();

/**
 * Removes the session's copy from the bucket, for a session that is deleted. Asked whether or not the
 * session recorded a copy: a save that was cut off may have left one. Tried three times; a copy that
 * is still there after that is handed to the user's `user` actor, which outlives this one and tries
 * again later. Only when that cannot be told is the object named in the log, for whoever looks after
 * the bucket. Never throws.
 */
async function removeBackup(c: Ctx, meta: SessionMeta): Promise<void> {
	if (backupRemoved.has(meta)) return;
	try {
		const layer = await layerOf(c, meta);
		if (!layer.backups || (!meta.backup && !(await privateSessionData(meta, layer.sandboxes, meta.sandboxId)))) return;
		for (let attempt = 1; ; attempt += 1) {
			try {
				await layer.backups.remove({ uid: meta.uid, sessionId: meta.sessionId });
				backupRemoved.add(meta);
				meta.backup = null;
				console.log(`[wlp] backup.removed session=${meta.sessionId}`);
				return;
			} catch (error) {
				if (attempt >= 3) {
					console.warn(`[wlp] backup.remove_retry uid=${meta.uid} session=${meta.sessionId} try=${attempt}: ${describeError(error)}`);
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
		}
		await userActor(c, meta.uid).internalRemoveBackupLater(meta.sessionId);
		backupRemoved.add(meta);
	} catch (error) {
		console.error(`[wlp] backup.remove_failed uid=${meta.uid} session=${meta.sessionId}: the copy of this deleted session's Windlass data may still be in the bucket (${describeError(error)})`);
	}
}

/**
 * Takes the session's sandbox for an operation that uses it, in the synchronous step that decides to
 * start it; the release it returns gives it back (once, however often it is called). An operation that
 * changes the sandbox (suspend, removal, free) takes it only when nothing else has it, and sets `idling`,
 * which the others wait for once they have taken it. A turn, a push, a read of the workspace, and the
 * factory's delivery into a session, take this one guard: an idle check that falls due under any of them
 * leaves the sandbox as it is and looks again later.
 */
function takeSandbox(c: Ctx): () => void {
	c.vars.sandboxOps += 1;
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		c.vars.sandboxOps -= 1;
	};
}

/** Whether an operation has the session's sandbox now (`takeSandbox`). */
function busy(c: Ctx): boolean {
	return c.vars.sandboxOps > 0;
}

/**
 * Reading the workspace through the sandbox starts a paused one, so it counts as using it: the idle
 * times start again, and a check is set for the sandbox that now runs.
 */
function markUsed(c: Ctx, meta: SessionMeta): void {
	if (c.vars.turn) return;
	meta.lastUsedAt = Date.now();
	delete meta.pauseNow;
	armMeter(c, meta);
	void c.keepAwake(armIdle(c, meta));
}

/** The changed files of the workspace and their diff, as they were when it was last read. */
interface WorkspaceCopy {
	files: WorkspaceFile[];
	diff: string;
}

/** Null when git could not say. */
async function readFiles(c: Ctx, sandbox: SandboxHandle): Promise<WorkspaceFile[] | null> {
	const status = await sandbox.run(STATUS_COMMAND, { timeoutMs: GIT_TIMEOUT_MS });
	if (status.exitCode !== 0) {
		c.log.warn({ msg: "git status failed in the sandbox", exitCode: status.exitCode, stderr: tail(status.stderr, 3, 300) });
		return null;
	}
	return parseStatus(status.stdout);
}

/**
 * Null when git could not say. A file may hold the value of one of the repository's secrets (a setup
 * command that wrote a registry's token into a configuration file): the diff is shown and stored
 * without it. The file itself has it, and so does a push of it.
 */
async function readDiff(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle): Promise<string | null> {
	const redactor = await sessionRedactor(c, meta);
	const diff = await sandbox.run(DIFF_COMMAND, { timeoutMs: GIT_TIMEOUT_MS });
	if (diff.exitCode !== 0 && diff.stdout === "") {
		c.log.warn({ msg: "git diff failed in the sandbox", exitCode: diff.exitCode, stderr: redactor.text(tail(diff.stderr, 3, 300)) });
		return null;
	}
	// Cut after the values are out: a cut through one would leave its beginning.
	const text = redactor.text(diff.stdout);
	return text.length > MAX_DIFF_CHARS ? text.slice(0, MAX_DIFF_CHARS) : text;
}

/** Reads the workspace from a running sandbox and keeps the copy. Null, and no copy kept, when it could not be read. Never throws. */
async function copyWorkspace(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle): Promise<WorkspaceCopy | null> {
	try {
		const files = await readFiles(c, sandbox);
		const diff = files === null ? null : await readDiff(c, meta, sandbox);
		if (files === null || diff === null) return null;
		const copy: WorkspaceCopy = { files, diff };
		await c.db.execute("INSERT OR REPLACE INTO workspace (id, files, diff) VALUES (1, ?, ?)", JSON.stringify(files), diff);
		c.vars.workspace = copy;
		return copy;
	} catch (error) {
		c.log.warn({ msg: "could not copy the workspace's changes", error: describeError(error) });
		return null;
	}
}

async function savedWorkspace(c: Ctx): Promise<WorkspaceCopy | null> {
	if (c.vars.workspace !== undefined) return c.vars.workspace;
	const [row] = await c.db.execute<{ files: string; diff: string }>("SELECT files, diff FROM workspace WHERE id = 1");
	c.vars.workspace = row ? { files: JSON.parse(row.files) as WorkspaceFile[], diff: row.diff } : null;
	return c.vars.workspace;
}

/** Forgets the copy: the workspace it was taken from is gone, or changed without a new copy. Never throws. */
async function dropWorkspace(c: Ctx): Promise<void> {
	c.vars.workspace = null;
	await c.db.execute("DELETE FROM workspace").catch((error: unknown) => {
		c.log.warn({ msg: "could not forget the copy of the workspace", error: describeError(error) });
	});
}

/**
 * What `changes` and `diff` answer from: null without a sandbox. Only a turn changes the workspace, so
 * between turns the copy taken when the last one ended is exact, and answering from it starts no paused
 * sandbox: looking at a session costs nothing. During a turn, and where there is no copy (a session from
 * before the copies, or a turn that ended without one), the sandbox itself is read.
 */
async function workspaceView(c: Ctx, meta: SessionMeta): Promise<WorkspaceCopy | { sandbox: SandboxHandle } | null> {
	if (c.vars.idling) await c.vars.idling.catch(() => undefined);
	if (!meta.sandboxId) return null;
	if (!c.vars.turn) {
		const saved = await savedWorkspace(c);
		if (saved) return saved;
	}
	const { sandboxes } = await layerOf(c, meta);
	// Starting a paused sandbox to read it uses its user's sandbox time, as a turn does: refused when none is left.
	// So does a stretch carried over a wake: it is settled where it can have ended, and the read takes a hold of its own.
	if (!c.vars.turn && (!meta.meter || carriedOver(c, meta))) await holdSandbox(c, meta, true);
	const sandbox = await sandboxes.connect(meta.sandboxId, connectOptions(meta));
	sandboxChanged(c);
	if (!sandbox) {
		noteSandbox(c, meta, "none");
		return null;
	}
	noteSandbox(c, meta, "running");
	if (c.vars.turn) return { sandbox };
	markUsed(c, meta);
	return (await copyWorkspace(c, meta, sandbox)) ?? { sandbox };
}

/**
 * Destroys the sandboxes the provider has for this session other than `meta.sandboxId`: ones whose
 * create was cut off by a crash, or outlasted a shutdown, so the session never learnt their id (the
 * provider names the session on each). The session is their only owner. Hosted places only: there they
 * cost money, and the list is the provider's own; a machine's list is its last report. Never throws.
 */
async function sweepSandboxes(c: Ctx, meta: SessionMeta, layer: SandboxLayer): Promise<void> {
	if (!hostedLimitsApply(meta.place)) return;
	try {
		for (const listed of await layer.sandboxes.list(meta.uid)) {
			if (listed.sessionId !== meta.sessionId || listed.id === meta.sandboxId) continue;
			await layer.sandboxes.destroy(listed.id);
			console.log(`[wlp] sandbox.swept id=${listed.id} session=${meta.sessionId}`);
		}
	} catch (error) {
		c.log.warn({ msg: "could not remove the sandboxes the session did not know of", session: meta.sessionId, error: describeError(error) });
	}
}

/** Machine removals must be durable before a delete succeeds, even if the runner is offline. */
async function destroySessionSandboxes(c: Ctx, meta: SessionMeta): Promise<void> {
	if (meta.place.kind === "machine") {
		await runnerLink(c, meta.place.machineId).removeSessionSandboxes(meta.sandboxId);
		sandboxChanged(c);
		meta.sandboxId = null;
		meta.sandbox = "none";
		return;
	}
	if (meta.sandboxId) {
		try {
			const { sandboxes } = await layerOf(c, meta);
			await sandboxes.destroy(meta.sandboxId);
			sandboxChanged(c);
			console.log(`[wlp] sandbox.destroyed id=${meta.sandboxId} session=${meta.sessionId}`);
			meta.sandboxId = null;
			meta.sandbox = "none";
		} catch (error) {
			c.log.error({ msg: "could not destroy the sandbox", sandbox: meta.sandboxId, error: describeError(error) });
		}
	}
	await layerOf(c, meta).then((layer) => sweepSandboxes(c, meta, layer), () => undefined);
}

/** The session's sandbox was created, connected to, suspended or destroyed: a state read asked before then is out of date. */
function sandboxChanged(c: Ctx): void {
	c.vars.sandboxGen += 1;
}

/** Asks the sandbox layer what state the sandbox is really in. */
async function refreshSandbox(c: Ctx, meta: SessionMeta, required = false): Promise<number | undefined> {
	const id = meta.sandboxId;
	if (!id) return;
	const gen = c.vars.sandboxGen;
	// The stretch the answer is about: a read or a push that takes a fresh hold meanwhile has its own, which this answer does not close.
	const use = useOf(meta);
	try {
		const { sandboxes } = await layerOf(c, meta);
		const observed = await observeSandbox(sandboxes, id);
		// A prompt that woke the actor may have resumed the sandbox while this was asked: "paused" is then the sandbox it was, not the one that runs.
		if (c.vars.sandboxGen === gen) {
			noteSandbox(c, meta, observed.state, use, observed.pausedAt);
			if (useOf(meta) === use) {
				c.vars.carried = null;
				if (sandboxes.observe && observed.state === "running") return Date.now();
			}
		}
	} catch (error) {
		c.log.warn({ msg: "could not read the sandbox's state", error: describeError(error) });
		if (required) throw error;
	}
}

// ---------------------------------------------------------------------------------------------
// A repository of the user's GitHub connection: its clone, and the pull request
// ---------------------------------------------------------------------------------------------

/** How long GitHub's word on the pull request's state is taken before it is asked again. */
const PULL_FRESH_MS = 20_000;

/** What clients see of the repository: all of it but the installation, which is the platform's own matter. */
/**
 * What the session's user saved that a turn needs, read from their `user` actor and opened here, for
 * one turn or for one reading of the workspace: the secrets of the session's repository and its
 * checks (none for a session that is not on a repository of the GitHub connection), the secrets of
 * the account, and the user's own MCP servers. The caller's token names this user and this session, and the actor answers
 * with the secrets of the repository it knows the session to be on. Throws a TurnProblem when they
 * cannot be read: with values it does not know, the platform could hand nothing over and take
 * nothing out of what it shows, so nothing is started.
 */
async function readSecrets(c: Ctx, meta: SessionMeta, turn: number | null): Promise<HeldSecrets> {
	const project = setupProjectOf(meta);
	const networkAt = Date.now();
	const sealed = await orNull(secretsActor(c, meta.uid, meta.sessionId).internalSessionSecrets(meta.sessionId, meta.place.kind === "hosted" ? snapshotsFor(meta.place) : config.snapshots && !!config.machines?.identity), RECALL_WAIT_MS);
	if (sealed === null) {
		throw new TurnProblem(`${project ? `The secrets saved for ${project.label} and for your account` : "The secrets saved for your account"} could not be read. Nothing was started, because without them the platform could not take their values out of what it shows. Try again.`);
	}
	const sealer = serverSealer();
	// What could not be opened, told on the turn's timeline: now, or by the turn that takes these (`HeldSecrets.unopened`).
	const unopened: string[] = [];
	const opened: OpenedSecret[] = [];
	const closed: string[] = [];
	if (project && sealed.project === project.key) {
		for (const secret of sealed.secrets) {
			try {
				opened.push({ name: secret.name, scope: secret.scope, value: openSecret(sealer, meta.uid, project.key, secret.name, secret.sealed) });
			} catch {
				closed.push(secret.name);
			}
		}
	}
	if (project && closed.length > 0) {
		console.error(`[wlp] secret.unreadable uid=${meta.uid} session=${meta.sessionId} project=${project.key} names=${closed.join(",")}: sealed with another key than this server's, or changed in storage`);
		unopened.push(`${closed.length === 1 ? `The secret ${closed[0]}` : `The secrets ${closed.join(", ")}`} saved for ${project.label} could not be opened by this server, so ${closed.length === 1 ? "it is" : "they are"} not handed over. Save ${closed.length === 1 ? "it" : "them"} again under Secrets in the session's panel.`);
	}
	const account: OpenedAccountSecret[] = [];
	const shut: string[] = [];
	for (const secret of sealed.account?.secrets ?? []) {
		try {
			account.push({ name: secret.name, scope: secret.scope, value: openSecret(sealer, meta.uid, ACCOUNT_SECRET_PROJECT, secret.name, secret.sealed) });
		} catch {
			shut.push(secret.name);
		}
	}
	if (shut.length > 0) {
		console.error(`[wlp] secret.unreadable uid=${meta.uid} session=${meta.sessionId} project=${ACCOUNT_SECRET_PROJECT} names=${shut.join(",")}: sealed with another key than this server's, or changed in storage`);
		unopened.push(`${shut.length === 1 ? `Your account's secret ${shut[0]}` : `Your account's secrets ${shut.join(", ")}`} could not be opened by this server, so ${shut.length === 1 ? "it is" : "they are"} not handed over. Save ${shut.length === 1 ? "it" : "them"} again in your settings.`);
	}
	if (turn !== null) for (const text of unopened) note(c, turn, "warn", text);
	if (meta.origin?.role === "reviewer" && (closed.length || shut.length || sealed.project !== project?.key)) throw new TurnProblem("The platform could not read all saved secrets to redact this review.");
	if (capabilitiesOf(meta.harness).events === "acp" && (closed.length || shut.length)) throw new TurnProblem("The platform could not read all saved values to redact the harness session.");
	// Every value is taken out of what is shown, also one of the account's that a secret of the repository stands in for.
	return {
		unopened: turn === null ? unopened : [],
		requestedNames: sealed.requestedNames,
		snapshotSetup: project && sealed.project === project.key ? sealed.snapshotSetup : undefined,
		environment: project && sealed.project === project.key ? sealed.environment : undefined,
		// Off for the whole deployment wins over the repository's choice, also for a sandbox made before it was turned off.
		screenshots: sealed.screenshots === true && config.factory.screenshots,
		opened: sealed.redactOnly ? [] : opened,
		account: sealed.redactOnly ? [] : account,
		servers: (sealed.account?.servers ?? []).map(({ name, definition, unasked }) => ({ name, definition, unasked })),
		checks: project && sealed.project === project.key ? (sealed.checks ?? []) : [],
		...(sealed.network !== undefined && { network: project && sealed.project === project.key ? sealed.network : [], networkAt }),
		redactor: new SecretRedactor([...opened, ...account]),
	};
}

/** What takes the saved values of the repository and of the account out of text now: the running turn's, or one read for this once. */
async function sessionRedactor(c: Ctx, meta: SessionMeta): Promise<Redactor> {
	const held = c.vars.turn?.secrets ?? (await readSecrets(c, meta, null));
	return held.redactor;
}

function repositoryOf(repo: StoredRepository): NonNullable<SessionSummary["repository"]> {
	return { provider: repo.provider, id: repo.id, owner: repo.owner, name: repo.name, branch: repo.branch, private: repo.private, url: repo.url };
}

/** The user's GitHub connection as their actor has it now: asked each time, so a connection that was removed stops working at once. */
function githubConnection(c: Ctx, meta: SessionMeta): Promise<StoredConnection | null> {
	return userActor(c, meta.uid).internalGithubConnection();
}

/** The work item owns its parent link, including for older sessions without owned-path metadata. */
async function childSetupSeed(c: Ctx, meta: SessionMeta): Promise<string | undefined> {
	if (!meta.origin || meta.origin.role === "reviewer") return undefined;
	return (await itemActor(c, meta.uid, meta.origin.itemId).internalSetupSeed("child")) ?? undefined;
}

/**
 * Clones the session's repository into the sandbox that was just made, with a token GitHub issued for
 * reading that one repository; it is given to the one `git clone` and revoked after it (github/git.ts).
 * False when the turn was stopped meanwhile. Throws a TurnProblem that says what is in the way.
 */
async function cloneConnected(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, signal: AbortSignal): Promise<boolean> {
	const repo = meta.repo;
	if (!repo) return true;
	const app = githubApp();
	if (!app) throw new ReviewRefused(`This agent was launched on ${repo.owner}/${repo.name} through your GitHub connection, and this deployment has no GitHub App any more to clone it with.`);
	// Child sessions keep the feature branch as their publishing base. Setup uses its immutable seed,
	// even after siblings have integrated or this child needs to recover its own published branch.
	const childSeed = await childSetupSeed(c, meta);
	const pinnedBase = meta.origin?.role === "reviewer" ? meta.reviewBase : childSeed;
	const work = meta.origin?.role === "reviewer" ? undefined : (meta.pushedHead && meta.publishBranch) || (childSeed ? repo.branch : undefined);
	note(c, turn, "info", `Cloning ${repo.owner}/${repo.name} at ${pinnedBase ?? repo.branch}`);
	try {
		const cloned = await cloneRepository(app, await githubConnection(c, meta), repo, sandbox, signal, work, pinnedBase, meta.uid);
		if (!cloned || signal.aborted) return false;
		const directory = /^(?!\.\.$)[A-Za-z0-9._-]+$/.test(cloned.directory) ? cloned.directory : ".";
		if (cloned.workAt && work) {
			meta.workDue = { branch: cloned.workGone ? repo.branch : work, at: cloned.workAt, directory, setupBase: childSeed };
		}
		if (cloned.workGone) {
			meta.pushedHead = null;
			note(c, turn, "warn", `${work} is no longer at GitHub, so the workspace starts from ${repo.branch} again. Work that was only on that branch is not in it.`);
		}
		c.vars.unpushed = null;
		// The new clone has not been set up: the repository's setup command is due, where the clone is.
		meta.setupDue = directory;
		meta.cloneDirectory = directory;
	} catch (error) {
		if (error instanceof GithubProblem) {
			if (meta.origin?.role === "reviewer") throw error;
			throw new TurnProblem(error.message);
		}
		throw error;
	}
	meta.cloned = true;
	void persist(c);
	return true;
}

/**
 * Puts the new sandbox's clone on the session's branch, after the setup command ran on the base
 * (`meta.workDue`). Whatever was pushed to the branch since, by anyone, is in the workspace then: it is
 * what the next push starts from. The saved work records whether setup ran in this sandbox: then what the
 * branch changed in its dependencies was not installed by it, and the agent is told so with its next
 * prompt. Throws a TurnProblem when git could not do it: nothing is started, and the next turn tries
 * again, without running the setup a second time.
 */
async function putWorkspaceOnWork(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle): Promise<void> {
	const due = meta.workDue;
	const repo = meta.repo;
	if (!due || !repo) return;
	const child = meta.origin?.childBranch;
	const fresh = !meta.pushedHead && child ? child : null;
	const branch = fresh?.name ?? due.branch;
	let head: string;
	try {
		head = await putOnWork(sandbox, due.directory, branch, fresh?.start);
	} catch (error) {
		throw new TurnProblem(`The new sandbox could not be put on ${branch}, so nothing was started (${describeError(error)}). Send the prompt again.`);
	}
	meta.workDue = null;
	if (child) repo.baseSha = child.start;
	if (!fresh && branch !== repo.branch) meta.pushedHead = head;
	c.vars.unpushed = null;
	const base = due.setupBase ?? repo.branch;
	// Every agent is told, in a person's session and in an item's alike (`platformNotes`).
	if (due.setUp) meta.setupOnBase = { branch, base };
	note(c, turn, "info", `Put the workspace on ${branch} at ${head.slice(0, 7)}.${due.setUp ? ` The setup command ran on ${base} before that, so what the branch changed in its dependencies is not installed.` : ""}`);
	await persist(c);
}

/** What the agent is told, once, after its workspace was put on its branch past a setup run on the base. */
const setupOnBaseNote = (where: { branch: string; base: string }) =>
	`[A note from the platform, not from the user: in this new sandbox the repository's setup command ran on ${where.base}, before the workspace was put on your branch ${where.branch}; it never runs on what a session pushed. What your branch added or changed in its dependencies is not installed: install it with your own commands if you need it.]\n\n`;

/** One piece of a setup run's output, to connected clients and to those that connect while it runs. */
function setupOutput(c: Ctx, turn: number, id: string, text: string): void {
	const delta: LiveDelta = { turn, event: { type: "setup.output", id, text: text.length > SETUP_OUTPUT_CHARS ? text.slice(-SETUP_OUTPUT_CHARS) : text } };
	c.broadcast("delta", delta);
	// Kept as one delta per run, the end of the output so far: a client that connects late shows what the others do.
	const last = c.vars.pending.at(-1);
	if (last && "event" in last && last.event.type === "setup.output" && last.event.id === id) {
		const joined = `${str(last.event.text)}${text}`;
		c.vars.pending[c.vars.pending.length - 1] = { turn, event: { type: "setup.output", id, text: joined.length > SETUP_OUTPUT_CHARS ? joined.slice(-SETUP_OUTPUT_CHARS) : joined } };
	} else {
		keepDelta(c.vars, delta);
	}
}

/**
 * Runs the setup command the user saved for the session's repository, in the sandbox that was just
 * cloned into. It is read from the user's `user` actor here, each time: that is the only place a
 * setup command comes from. Once its processes are gone, the turn goes on: a run that did not succeed
 * is in the timeline, and is told to the agent with its next prompt (`meta.setupUnfinished`). It is
 * marked as done for this sandbox before it starts, so a server that stops under it does not make
 * the next turn run it a second time. True when a command ran. A command that could not be read refuses
 * the turn (a TurnProblem), and stays due: going on would let the agent change the workspace, or the
 * workspace be put on the session's branch (`meta.workDue`), before the next turn runs the setup there,
 * with the network and the repository's secrets, on what the agent wrote.
 */
async function runSetup(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, signal: AbortSignal, secrets: HeldSecrets | null, plan: SnapshotPlan | null, layer: SandboxLayer): Promise<void> {
	const project = setupProjectOf(meta);
	const directory = meta.setupDue;
	if (!project || typeof directory !== "string") return;
	const saved = await orNull(userActor(c, meta.uid).internalSetupCommand(project.key), RECALL_WAIT_MS);
	if (signal.aborted) return;
	// It stays due, and nothing of the turn is started: the setup only ever runs before the agent's first turn in the sandbox.
	if (saved === null) throw new TurnProblem(`The setup command for ${project.label} could not be read, so nothing was started in the new sandbox. Send the prompt again.`);
	meta.setupDue = null;
	const command = typeof saved.command === "string" ? saved.command.trim() : "";
	if (command === "") {
		void persist(c);
		return;
	}

	const handed = (secrets?.opened ?? []).filter(secret => meta.origin?.role !== "reviewer" || secret.scope === "setup");
	if (handed.length > 0) note(c, turn, "info", `The setup command is handed ${handed.length === 1 ? "the secret" : `the ${handed.length} secrets`} saved for ${project.label}, as environment variables: ${handed.map((secret) => secret.name).join(", ")}.`);
	const id = `su_${randomBytes(6).toString("hex")}`;
	const limitMs = config.setupTimeoutMs;
	meta.setupRunning = { id, command, limitMs };
	if (meta.workDue) meta.workDue.setUp = true;
	append(c, { turn, kind: "setup", id, command, state: "started", exitCode: null, durationMs: null, limitMs, output: "", truncated: false });
	await persist(c);

	const tail = new OutputTail();
	let waiting = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		clearTimeout(timer);
		timer = undefined;
		if (waiting === "") return;
		const text = waiting;
		waiting = "";
		setupOutput(c, turn, id, text);
	};
	// Sample the pristine checkout before setup can change HEAD or the dependency files.
	const eligible = plan?.writer && directory === "." && meta.repo?.branch === plan.defaultBranch && !meta.workDue && !meta.windlassSessionId
		&& snapshotWriter(meta.origin) && handed.length === 0 && saved.updatedAt === plan.updatedAt && command === plan.command;
	// cloneRepository confirmed this immutable checkout against GitHub before setup started.
	const original = eligible ? meta.repo?.baseSha : null;
	const result = await runSetupCommand(sandbox, {
		command,
		cwd: directory === "." ? sandbox.cwd : `${sandbox.cwd}/${directory}`,
		timeoutMs: limitMs,
		signal,
		secretEnv: setupEnvironment(handed),
		redactor: secrets?.redactor,
		onOutput: (text) => {
			tail.push(text);
			waiting += text;
			if (waiting.length >= SETUP_FLUSH_CHARS) flush();
			else timer ??= setTimeout(flush, SETUP_FLUSH_MS);
		},
	});
	clearTimeout(timer);
	const output = tail.text;
	// The ending item carries the output: the deltas that built it up are not needed any more.
	c.vars.pending = c.vars.pending.filter((delta) => !("event" in delta && delta.event.type === "setup.output" && delta.event.id === id));
	meta.setupRunning = null;
	append(c, { turn, kind: "setup", id, command, state: result.state, exitCode: result.exitCode, durationMs: result.durationMs, limitMs, output, truncated: tail.truncated });
	if (result.problem !== null) note(c, turn, "warn", `The setup command for ${project.label} could not be run. ${result.problem}`);
	meta.setupUnfinished = result.state === "succeeded" ? null : { command, state: result.cleanupPending ? "interrupted" : result.state, exitCode: result.exitCode, limitMs, output: lastLines(result.problem === null ? output : `${output}\n${result.problem}`) };
	console.log(`[wlp] setup.ran session=${meta.sessionId} sandbox=${sandbox.id} project=${project.key} state=${result.state} exit=${result.exitCode ?? "none"} ms=${result.durationMs}`);
	await persist(c);
	if (result.cleanupPending) throw new TurnProblem("The platform could not stop leftover setup processes. Send the prompt again to retry cleanup.");
	if (meta.environmentBuild) c.vars.environmentResult = await buildEnvironment(c, meta, turn, sandbox, signal, secrets, plan, layer, { result, output, original: original ?? null, command });
}

/**
 * A build session's work after its setup ran (environments.ts): every saved check once, then the image, saved only
 * when setup and every check passed. A failed build saves nothing, so the snapshot store keeps the last ready image.
 * Never throws: what went wrong is the result.
 */
async function buildEnvironment(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, signal: AbortSignal, secrets: HeldSecrets | null, plan: SnapshotPlan | null, layer: SandboxLayer,
	setup: { result: Awaited<ReturnType<typeof runSetupCommand>>; output: string; original: string | null; command: string }): Promise<EnvironmentBuildResult> {
	const commit = setup.original ?? meta.repo?.baseSha ?? "";
	const base: EnvironmentBuildResult = { finishedAt: null, commit: /^[a-f0-9]{40}$/.test(commit) ? commit : "", image: sandbox.image ?? "", checks: [], failure: null, snapshot: false };
	if (setup.result.state !== "succeeded") {
		const how = setup.result.state === "timed_out" ? "ran out of time" : setup.result.exitCode !== null ? `exited with ${setup.result.exitCode}` : "did not finish";
		return { ...base, finishedAt: Date.now(), failure: { kind: "setup", check: null, line: `The setup command ${how}.`, excerpt: outputExcerpt(setup.output) } };
	}
	const checks = secrets?.checks ?? [];
	// Files the checks write (build outputs, caches the repository ignores) stay; tracked files they change go back.
	const clean = (await sandbox.run("git status --porcelain", { cwd: sandbox.cwd, timeoutMs: 60_000, signal }).catch(() => null))?.stdout.trim() === "";
	note(c, turn, "info", checks.length ? `Validating: running ${checks.length === 1 ? "the saved check" : `the ${checks.length} saved checks`}.` : "No checks are saved, so the environment is validated by its setup alone.");
	const ran = await new PlatformChecks(sandbox, checks, () => undefined, { agent: "the build", redactor: secrets?.redactor, signal }).runAll();
	const judged = judgeChecks(ran);
	for (const r of judged.checks) note(c, turn, r.status === "passed" ? "info" : "warn", `${r.name}: ${r.status.replace("_", " ")}${r.environment ? ` (the sandbox could not run it: ${r.environment.replace("_", " ")})` : ""}.`);
	const done = { ...base, checks: judged.checks, ...(judged.codeFailures.length && { codeFailures: judged.codeFailures }) };
	if (signal.aborted) return { ...done, finishedAt: Date.now(), failure: { kind: "setup", check: null, line: "The build was stopped.", excerpt: "" } };
	if (judged.failure) return { ...done, finishedAt: Date.now(), failure: judged.failure };
	if (clean) await sandbox.run("git reset -q --hard HEAD && git clean -fdq", { cwd: sandbox.cwd, timeoutMs: 120_000, signal }).catch(() => undefined);
	// A quick setup is validated, and keeps no image: starting cold costs little more than starting from one.
	if (setup.result.durationMs < config.snapshotMinSetupMs) return { ...done, finishedAt: Date.now() };
	const saveFailed = (line: string): EnvironmentBuildResult => ({ ...done, finishedAt: Date.now(), failure: { kind: "save", check: null, line, excerpt: "" } });
	if (!plan || !setup.original || !layer.sandboxes.saveSnapshot || (plan.commit && setup.original !== plan.commit)) return saveFailed("This place cannot keep a prepared sandbox of this repository.");
	const project = setupProjectOf(meta);
	const [current, connection] = await Promise.all([
		project ? orNull(userActor(c, meta.uid).internalSetupCommand(project.key), RECALL_WAIT_MS) : null,
		githubConnection(c, meta).catch(() => null),
	]);
	// The setup was changed, or GitHub reconnected, while it ran: what it made is not the current one's.
	if (!project || !current || !connection || current.command !== plan.command || snapshotGeneration(plan.key.repo, current.updatedAt, connection.connectedAt) !== plan.key.generation)
		return saveFailed("The setup command or the GitHub connection changed while it ran.");
	let inputs = plan.key.inputs;
	if (inputs === DEFERRED_INPUTS) {
		const app = githubApp(), repo = meta.repo;
		const revision = app && repo ? await setupRevision(app, connection, repo, setup.original).catch(() => null) : null;
		if (!revision?.dependencies || revision.commit !== setup.original || revision.defaultBranch !== repo?.branch) return saveFailed("The repository has no lockfile the platform can key a prepared sandbox on.");
		inputs = digest([revision.dependencies, setup.command]);
	}
	const began = Date.now();
	note(c, turn, "info", judged.codeFailures.length ? `The sandbox ran every check; ${judged.codeFailures.join(", ")} failed on the base commit's code. Saving the prepared sandbox.` : "Every check passed. Saving the prepared sandbox.");
	const saved = await layer.sandboxes.saveSnapshot(sandbox.id, { ...plan.key, inputs, commit: setup.original, created: began }).catch(() => false);
	if (!saved) return saveFailed("The prepared sandbox could not be saved here: the place's storage limits, or its free disk, left no room.");
	await userActor(c, meta.uid).internalSnapshotSaved(project.key, plan.updatedAt, connection.connectedAt, meta.place.kind === "hosted" ? "hosted" : meta.place.machineId).catch(() => undefined);
	note(c, turn, "info", `Saved the prepared sandbox in ${Math.round((Date.now() - began) / 1000)} seconds.`);
	return { ...done, finishedAt: Date.now(), snapshot: true };
}

/** Shortens `text` to about `limit` characters, at the end of a paragraph or a sentence where there is one. */
function brief(text: string, limit: number): string {
	const clean = text.replace(/\r/g, "").trim();
	if (clean.length <= limit) return clean;
	const cut = clean.slice(0, limit);
	const paragraph = cut.lastIndexOf("\n\n");
	const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
	if (paragraph > limit / 3) return cut.slice(0, paragraph).trim();
	if (sentence > limit / 3) return cut.slice(0, sentence + 1).trim();
	return `${cut.slice(0, cut.lastIndexOf(" ") > limit / 2 ? cut.lastIndexOf(" ") : limit).trim()}…`;
}

/**
 * A message to start from. The title is the session's for the first push and the latest prompt's
 * opening words after it; the body is the agent's last answer, kept short, or the changed files.
 */
async function draftMessage(c: Ctx, meta: SessionMeta, files: WorkspaceFile[] | null): Promise<PublishMessage> {
	const rows = await serial(c, async () => {
		await writeItems(c).catch(() => undefined);
		return c.db.execute<{ item: string }>("SELECT item FROM timeline WHERE kind IN ('windlass', 'user') ORDER BY seq DESC LIMIT 400");
	}).catch(() => []);
	let answer = "";
	let prompt = "";
	for (const row of rows) {
		const item = JSON.parse(row.item) as TimelineItem;
		if (answer === "" && item.kind === "windlass" && item.event.type === "text.ended") answer = str(item.event.data?.text).trim();
		if (prompt === "" && item.kind === "user" && item.steer !== true) prompt = item.text;
		if (answer !== "" && prompt !== "") break;
	}
	// Until there is a pull request the title is the session's: a push whose pull request GitHub refused is no reason for another.
	const first = !meta.pull;
	const title = (first || prompt === "" ? meta.title : titleFrom(prompt)).replace(/…$/, "").trim().slice(0, MAX_PUBLISH_TITLE_CHARS);
	let body = brief(answer, 600);
	if (body === "" && files && files.length > 0) {
		const listed = files.slice(0, 10).map((file) => `- ${file.path}`);
		if (files.length > listed.length) listed.push(`- and ${files.length - listed.length} more`);
		body = `Changed files:\n${listed.join("\n")}`;
	}
	return { title: title === "" ? "Changes from Windlass" : title, body };
}

/** Why nothing can be pushed right now, or null. */
function publishBlocked(c: Ctx, meta: SessionMeta): string | null {
	if (meta.origin?.role === "reviewer") return "The reviewer cannot publish.";
	if (!githubApp()) return "This deployment has no GitHub App any more, so the platform cannot push.";
	if (c.vars.turn || c.vars.accepting || meta.status !== "idle") return "Wait for the turn to end: the platform does not push while the agent is working.";
	if (c.vars.publishing) return "A push is under way.";
	if (!meta.sandboxId) return "The sandbox is created on the first prompt. Until then there is nothing to push.";
	return null;
}

/**
 * Whether the workspace has something GitHub does not. The files that differ from the last commit are
 * known from the copy taken when the last turn ended. Commits of the agent's own are known to git
 * only, which is asked when the sandbox is running anyway and never by starting one; the answer is
 * kept until a turn or a push changes it.
 */
async function unpushedWork(c: Ctx, meta: SessionMeta, repo: StoredRepository, files: WorkspaceFile[] | null): Promise<boolean | null> {
	if (c.vars.turn || !meta.sandboxId) return null;
	if (files && files.length > 0) return true;
	const key = `${meta.turns}:${repo.baseSha ?? ""}:${meta.pushedHead ?? ""}:${meta.sandboxId}`;
	if (c.vars.unpushed?.key === key) return c.vars.unpushed.value;
	// Only a turn or a push changes the answer, and the key names both: what was found while the sandbox
	// ran still holds while it is paused, so a paused sandbox is not started to be asked again.
	if (meta.unpushed?.key === key) return meta.unpushed.value;
	let value: boolean | null = null;
	// Under the sandbox's guard from the read of its state to the end: an idle suspend in between would be undone by the connect, uncounted.
	const release = takeSandbox(c);
	try {
		const { sandboxes } = await layerOf(c, meta);
		if (!c.vars.idling && (!hostedLimitsApply(meta.place) || meta.meter) && (await sandboxes.state(meta.sandboxId)) === "running") {
			const sandbox = await sandboxes.connect(meta.sandboxId, connectOptions(meta));
			sandboxChanged(c);
			if (sandbox && !c.vars.turn) value = await hasUnpushedWork(sandbox, repo.baseSha ?? null, meta.pushedHead ?? null);
		}
	} catch (error) {
		c.log.warn({ msg: "could not read whether the workspace has commits to push", error: describeError(error) });
	} finally {
		release();
	}
	if (value !== null) {
		c.vars.unpushed = { key, value };
		meta.unpushed = { key, value };
		void persist(c);
	}
	return value;
}

async function publishStateOf(c: Ctx, meta: SessionMeta): Promise<PublishState> {
	const repo = meta.repo;
	if (!repo) return { repository: null, pullRequest: null, branch: "", changes: null, draft: { title: "", body: "" }, blocked: null, pushed: null };
	const files = c.vars.turn ? null : ((await savedWorkspace(c))?.files ?? null);
	const [changes, draft] = await Promise.all([unpushedWork(c, meta, repo, files), draftMessage(c, meta, files)]);
	return { repository: repositoryOf(repo), pullRequest: meta.pull ?? null, branch: meta.publishBranch ?? branchFor(meta.title, meta.sessionId), changes, draft, blocked: publishBlocked(c, meta), pushed: meta.pushedHead ?? null };
}

/** Asks GitHub what became of the pull request, at most every few seconds; a change goes to every client with the summary. */
async function checkPull(c: Ctx, meta: SessionMeta): Promise<void> {
	const app = githubApp();
	const { repo, pull } = meta;
	if (!app || !repo || !pull || Date.now() - c.vars.pullCheckedAt < PULL_FRESH_MS) return;
	c.vars.pullCheckedAt = Date.now();
	const current = await refreshPull(app, await githubConnection(c, meta), repo, pull);
	if (meta.pull !== pull || (current.state === pull.state && current.title === pull.title)) return;
	meta.pull = current;
	publish(c);
	void persist(c);
}

/** A push's line in the timeline: what went where, in the words of the other platform notes. */
function publishedLine(repo: StoredRepository, pull: PullRequestInfo, opened: boolean, files: number | null): string {
	const what = files === null ? "the work" : files === 0 ? "the agent's commits" : files === 1 ? "1 file" : `${files} files`;
	if (opened) return `Opened pull request #${pull.number} in ${repo.owner}/${repo.name} from ${pull.branch}${files === null ? "" : `, with ${what}`}.`;
	return `Pushed ${what} to ${pull.branch}; pull request #${pull.number} is updated.`;
}

/**
 * What a pull request's description is to say was verified (verified.ts): what the session's work
 * rests on since its last turn ended, and the user's checks as they are saved now. `during` names
 * the turn that is running, for a push the agent asked for: its checks have not run.
 */
async function evidenceOf(c: Ctx, meta: SessionMeta, during: number | null): Promise<PublishEvidence> {
	const held = c.vars.turn?.secrets ?? (await readSecrets(c, meta, null));
	return { verified: meta.verified ?? null, during, checks: held.checks, redact: (text) => held.redactor.text(text), machine: machineOf(meta) };
}

/** For a session on one of the user's machines, that machine as a question or a pull request names it: by the name kept at launch. */
function machineOf(meta: SessionMeta): { name: string | null } | null {
	return meta.place.kind === "machine" ? { name: meta.machineName } : null;
}

/** Test a copy of the pinned base in the builder's existing sandbox, under its ordinary usage hold. */
async function testSessionBase(c: Ctx, meta: SessionMeta, repo: StoredRepository, input: { base: string; tests: NamedTests }): Promise<BaseTestResult> {
	const release = takeSandbox(c);
	try {
		if (c.vars.idling) await c.vars.idling.catch(() => undefined);
		if (!meta.sandboxId || c.vars.turn || c.vars.publishing) return "unknown";
		const { sandboxes } = await layerOf(c, meta);
		if (!meta.meter || carriedOver(c, meta)) await holdSandbox(c, meta, true);
		const sandbox = await sandboxes.connect(meta.sandboxId, connectOptions(meta));
		sandboxChanged(c);
		if (!sandbox) return "unknown";
		noteSandbox(c, meta, "running");
		markUsed(c, meta);
		const cwd = meta.cloneDirectory && meta.cloneDirectory !== "." ? sandbox.cwd + "/" + meta.cloneDirectory : sandbox.cwd;
		if ((await sandbox.run(`GIT_NO_REPLACE_OBJECTS=1 git cat-file -e ${input.base}^{commit}`, { cwd, timeoutMs: 10_000 })).exitCode !== 0) {
			const app = githubApp();
			if (!app) return "unknown";
			await fetchBase(app, await githubConnection(c, meta), { ...repo }, sandbox);
		}
		const isolated = sandboxes.profile(meta.profile).approval !== "full" || !!meta.tainted || !!machineHarness(meta.harness)?.sandboxedOn.includes(meta.profile);
		return await runBaseTests(sandbox, cwd, input.base, input.tests, isolated);
	} finally {
		release();
		markUsed(c, meta);
	}
}

/** After a push's line in the timeline: what the pull request's description now says was verified, in its few words. */
const verifiedLine = (pull: PullRequestInfo) => ` Its description reports: ${pull.verified}.`;

/**
 * Commits, pushes and opens the pull request, for `publish()` and a work item's step. The caller has
 * checked that nothing is in the way. `shownIsEnough` for the item's step: its agent may have pushed
 * everything itself (`agentPush`), and then an open pull request is only described again.
 */
async function publishSession(c: Ctx, meta: SessionMeta, repo: StoredRepository, message: PublishMessage, itemPublish = false, branchOnly = false, blockedNetwork?: BlockedNetwork, updateFromBase?: { head: string; at: number }): Promise<PublishResult> {
	const app = githubApp();
	if (!app || !meta.sandboxId) throw new UserError(publishBlocked(c, meta) ?? "There is nothing to push yet.", { code: "publish_blocked" });
	// A suspend or removal of the idle sandbox finishes first, as before a prompt.
	if (c.vars.idling) await c.vars.idling.catch(() => undefined);
	const { sandboxes } = await layerOf(c, meta);
	// A push starts a paused sandbox, which uses its user's sandbox time; a stretch carried over a wake is settled as for a read (`workspaceView`).
	if (!meta.meter || carriedOver(c, meta)) await holdSandbox(c, meta, true);
	const sandbox = meta.sandboxId ? await sandboxes.connect(meta.sandboxId, connectOptions(meta)) : undefined;
	sandboxChanged(c);
	if (!sandbox) {
		noteSandbox(c, meta, "none");
		throw new UserError("The sandbox with this agent's files is gone, so there is nothing to push. The next prompt starts a new one from the repository.", { code: "publish_blocked" });
	}
	noteSandbox(c, meta, "running");
	// Pushing uses the sandbox: the idle times count from here, and again from when it is done.
	markUsed(c, meta);
	const branch = meta.publishBranch ?? branchFor(meta.title, meta.sessionId);
	meta.publishBranch = branch;
	try {
		// An item's step pushes over the platform's own last push where its agent rebased and did not push; the panel's never forces.
		if (branchOnly || updateFromBase) {
			const evidence = await evidenceOf(c, meta, null);
			const input = { app, connection: await githubConnection(c, meta), repository: repo, sandbox, sessionId: meta.sessionId, branch, pushed: meta.pushedHead ?? null, lease: meta.platformPushed ?? null, redact: evidence.redact };
			const pushed = updateFromBase ? await updateBranchFromBase(input, updateFromBase) : await pushWork(input, message.title);
			if (pushed.workspaceChanged || !pushed.head) throw new UserError("Git did not confirm the checked item commit.", { code: "publish_failed" });
			recordPushHead(meta, sandbox, pushed.head);
			return { state: await afterPublish(c, meta, sandbox), opened: false };
		}
		const published = await publishWork({ app, connection: await githubConnection(c, meta), repository: repo, sandbox, sessionId: meta.sessionId, branch, pull: meta.pull ?? null, pushed: meta.pushedHead ?? null, lease: itemPublish ? (meta.platformPushed ?? null) : null, message, blockedNetwork, shownIsEnough: itemPublish, retitle: itemPublish, keepTitle: itemPublish, evidence: await evidenceOf(c, meta, null) });
		if (published.head) published.pushed = recordPushHead(meta, sandbox, published.head);
		meta.pull = published.pull;
		meta.updatedAt = Date.now();
		c.vars.pullCheckedAt = Date.now();
		// Nothing pushed is the item's step after its agent pushed everything itself: the pull request was only described again.
		const line = published.pushed || published.opened ? publishedLine(repo, published.pull, published.opened, published.committedFiles) : `${published.pull.branch} at GitHub already had the agent's work; pull request #${published.pull.number} is described again.`;
		note(c, meta.turns, "info", `${line}${verifiedLine(published.pull)}`);
		console.log(`[wlp] github.published session=${meta.sessionId} repository=${repo.id} pull=${published.pull.number} opened=${published.opened}`);
		return { state: await afterPublish(c, meta, sandbox), opened: published.opened };
	} catch (error) {
		// The push went through and the pull request did not: what is at GitHub is remembered, so the next try only opens it.
		if (error instanceof PullProblem && error.head) recordPushHead(meta, sandbox, error.head);
		await afterPublish(c, meta, sandbox).catch(() => undefined);
		if (error instanceof GithubProblem) {
			console.warn(`[wlp] github.publish_failed session=${meta.sessionId} repository=${repo.id}: ${error.code}`);
			throw new PublishRefused(error.message, error.code === "github_gone" || error.code === "github_denied" ? error.code : "publish_failed", error.code === "github_unreachable");
		}
		throw error;
	}
}

/** After a push, or one that failed half way: the commit changed what differs from the last commit, so the copy is taken again. */
async function afterPublish(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle): Promise<PublishState> {
	c.vars.unpushed = null;
	if (!c.vars.turn && !((await copyWorkspace(c, meta, sandbox)) ?? null)) await dropWorkspace(c);
	markUsed(c, meta);
	publish(c);
	await persist(c);
	return publishStateOf(c, meta);
}

/** An observed remote head is useful for the next probe. Only a confirmed ref update grants a lease. */
export function recordPushHead(meta: Pick<SessionMeta, "pushedHead" | "platformPushed">, sandbox: SandboxHandle, head: string): boolean {
	meta.pushedHead = head;
	if (!actuallyPushed(sandbox, head)) return false;
	meta.platformPushed = head;
	return true;
}

/** The message of a push as the client sent it, checked. */
function cleanMessage(input: unknown): PublishMessage {
	const message = (typeof input === "object" && input !== null ? (input as { message?: unknown }).message : null) as { title?: unknown; body?: unknown } | null;
	if (typeof message !== "object" || message === null || typeof message.title !== "string" || (message.body !== undefined && message.body !== null && typeof message.body !== "string")) {
		throw new UserError("Give the commit a title.", { code: "bad_message" });
	}
	const title = message.title.replace(/\s+/g, " ").trim();
	const body = typeof message.body === "string" ? message.body.replace(/\r/g, "").trim() : "";
	if (title === "") throw new UserError("Give the commit a title.", { code: "bad_message" });
	if (title.length > MAX_PUBLISH_TITLE_CHARS) throw new UserError(`The title is ${title.length} characters long; the limit is ${MAX_PUBLISH_TITLE_CHARS}.`, { code: "bad_message" });
	if (body.length > MAX_PUBLISH_BODY_CHARS) throw new UserError(`The description is ${body.length} characters long; the limit is ${MAX_PUBLISH_BODY_CHARS}.`, { code: "bad_message" });
	return { title, body };
}

// ---------------------------------------------------------------------------------------------
// A turn's question
// ---------------------------------------------------------------------------------------------

function duration(ms: number): string {
	const plural = (count: number, unit: string) => (count === 1 ? `1 ${unit}` : `${count} ${unit}s`);
	if (ms >= 2 * 86_400_000 || (ms >= 86_400_000 && ms % 86_400_000 === 0)) return plural(Math.round(ms / 86_400_000), "day");
	if (ms >= 2 * 3_600_000 || (ms >= 3_600_000 && ms % 3_600_000 === 0)) return plural(Math.round(ms / 3_600_000), "hour");
	if (ms >= 60_000) {
		const minutes = Math.round(ms / 60_000);
		return minutes === 1 ? "1 minute" : `${minutes} minutes`;
	}
	const seconds = Math.max(1, Math.round(ms / 1000));
	return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

/** What the sandbox layer hands over is typed, but it is another module's word: nothing is assumed of it. */
function str(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/**
 * Takes the turn's pending question away: clients are told, and a session that was waiting counts as
 * running again. Synchronous, so of two callers exactly one gets the question. The caller settles the
 * layer's promise and publishes the summary.
 */
function takeQuestion(c: Ctx, meta: SessionMeta, active: ActiveTurn): Asked | null {
	const asked = active.question;
	if (!asked) return null;
	active.question = null;
	clearTimeout(asked.timer);
	if (meta.status === "waiting") meta.status = "running";
	c.broadcast("question", null);
	// A server's question that stood aside is put again, unless the turn is on its way out.
	if (!active.closed && !active.stopping) active.aside.shift()?.put?.();
	return asked;
}

/**
 * The layer's `onQuestion`: makes the question visible, turns the session to `waiting`, and returns
 * the promise that `answer()`, the timeout, a stop or the turn's end settles.
 */
function askQuestion(c: Ctx, meta: SessionMeta, active: ActiveTurn, question: TurnQuestion, withdrawn: AbortSignal): Promise<TurnAnswer> {
	const choices = (Array.isArray(question?.choices) ? question.choices : []).map((choice) => ({
		id: str(choice?.id),
		label: str(choice?.label) || str(choice?.id),
		approve: choice?.approve === true,
		remembers: typeof choice?.remembers === "string" && choice.remembers !== "" ? choice.remembers : null,
	}));
	// "deny" is Windlass's own id for it; a rejection declines a question that has no such choice.
	const refusal = choices.find((choice) => choice.id === "deny" && !choice.approve) ?? choices.find((choice) => !choice.approve);
	const declined = (why?: string): Promise<TurnAnswer> =>
		refusal ? Promise.resolve({ choice: refusal.id, note: why }) : Promise.reject(new Error(why ?? "the question was declined"));
	const title = str(question?.title) || "Allow this tool call?";

	if (active.closed || active.controller.signal.aborted || withdrawn.aborted) return declined();
	if (active.question?.put) {
		// A tool call's question comes first, as in Windlass's own interfaces: the call waits on it and the turn
		// with it, while a server only stays stopped. The server's question steps aside and is put again after this one.
		const aside = active.question;
		clearTimeout(aside.timer);
		aside.timer = undefined;
		active.question = null;
		active.aside.unshift(aside);
		if (meta.status === "waiting") meta.status = "running";
	} else if (active.question) {
		// Windlass asks one question at a time, and the contract shows one. A second one is not left to hang.
		note(c, active.number, "warn", `${meta.harness && meta.harness !== "windlass" ? machineHarnesses[meta.harness].name : "Windlass"} asked "${title}" while another question was waiting for an answer, so it was declined.`);
		return declined("Another question was waiting for the user's answer, so the platform declined this call. Ask again if it is still needed.");
	}

	const now = Date.now();
	const pending: PendingQuestion = {
		id: `q_${randomBytes(8).toString("hex")}`,
		turn: active.number,
		messageId: str(question.messageId),
		callId: str(question.callId),
		title,
		subject: str(question.subject),
		details: Array.isArray(question.details) ? question.details.map(str) : [],
		choices,
		subagent: typeof question.subagent === "string" && question.subagent !== "" ? question.subagent : null,
		askedAt: now,
		expiresAt: now + questionWait(meta),
	};
	return new Promise<TurnAnswer>((resolve, reject) => {
		const settled = (): void => {
			withdrawn.removeEventListener("abort", onWithdrawn);
			active.unsettled.delete(asked);
		};
		const wait = questionWait(meta);
		const asked: Asked = {
			pending,
			timer: setTimeout(() => {
				// Nobody answered: the turn must not wait for ever, and the model should know why it was refused.
				if (active.question !== asked) return;
				takeQuestion(c, meta, active);
				// A hosted sandbox runs, and costs, while it waits: the turn ends, and the sandbox pauses at once (`pauseNow`).
				const hosted = hostedLimitsApply(meta.place);
				note(c, active.number, "warn", hosted
					? `Nobody answered "${pending.title}" within ${duration(wait)}, so the turn was ended and its sandbox paused. Send a prompt to go on.`
					: `Nobody answered "${pending.title}" within ${duration(wait)}, so it was declined.`, {
					code: "question_expired",
					call: { messageId: pending.messageId, callId: pending.callId },
				});
				if (hosted) meta.pauseNow = true;
				publish(c);
				void persist(c);
				asked.decline(`Nobody answered within ${duration(wait)}, so the platform declined this call for the user.`);
				if (hosted) abortTurn(c, meta, active);
			}, wait),
			answer: (answer) => {
				settled();
				resolve(answer);
			},
			decline: (why) => {
				settled();
				if (refusal) resolve({ choice: refusal.id, note: why });
				else reject(new Error(why ?? "the question was withdrawn"));
			},
		};
		// The harness withdrew this question or stopped the turn.
		function onWithdrawn(): void {
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			asked.decline();
		}
		withdrawn.addEventListener("abort", onWithdrawn, { once: true });
		active.unsettled.add(asked);
		active.question = asked;
		if (meta.status === "running") meta.status = "waiting";
		c.broadcast("question", pending);
		publish(c);
		void persist(c);
	});
}

/**
 * The user's approvals of projects' servers, kept beyond the sandbox Windlass keeps its own in: they
 * are in the user's `user` actor (server-approvals.ts), which every session of the user reaches from
 * whichever server it runs on. `approved` is asked before the question is put, and an approval of
 * exactly that definition for this session's project starts the server without asking; `remember` is
 * told when the user approves and Windlass took it. Like Windlass's own record, it does not outlast a
 * change of the definition, and it runs out 30 days after the user approved.
 */
const serverApprovals = {
	/** The approvals remembered for this session's project that have not run out, the newest first. */
	of(c: Ctx, meta: SessionMeta): Promise<ServerApproval[]> {
		return userActor(c, meta.uid).internalServerApprovals(projectOf(meta).key);
	},
	async approved(c: Ctx, meta: SessionMeta, question: Pick<TurnServerQuestion, "name" | "fingerprint">): Promise<ServerApproval | null> {
		if (question.name === "" || question.fingerprint === "") return null;
		const approvals = await serverApprovals.of(c, meta);
		return approvals.find((approval) => approval.name === question.name && approval.fingerprint === question.fingerprint) ?? null;
	},
	async remember(c: Ctx, meta: SessionMeta, question: Pick<TurnServerQuestion, "name" | "fingerprint">): Promise<void> {
		const project = projectOf(meta);
		await userActor(c, meta.uid).internalServerApprove({ project: project.key, label: project.label, name: question.name, fingerprint: question.fingerprint });
	},
	async forget(c: Ctx, meta: SessionMeta, name: string): Promise<number> {
		return (await userActor(c, meta.uid).internalServerForget({ project: projectOf(meta).key, name })).forgotten;
	},
};

const serverKey = (question: Pick<TurnServerQuestion, "name" | "fingerprint">) => `${question.name}:${question.fingerprint}`;

/** `promise`'s value, or null when it fails or takes longer than `ms`. */
function orNull<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise.catch(() => null), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]).finally(() => clearTimeout(timer));
}

/** Says that what the session knows of its project's servers, or of their approvals, changed: clients ask `servers()` again. */
function serversChanged(c: Ctx, meta: SessionMeta): void {
	const now = Date.now();
	meta.serversChangedAt = meta.serversChangedAt >= now ? meta.serversChangedAt + 1 : now;
	publish(c);
	void persist(c);
}

/** The layer's `onServers`: keeps what Windlass says of the project's servers, for the side panel. */
function knowServers(c: Ctx, meta: SessionMeta, said: TurnServer[]): void {
	const known = meta.servers ?? [];
	const next = knownServers(known, Array.isArray(said) ? said : [], Date.now());
	if (sameServers(known, next)) return;
	meta.servers = next;
	serversChanged(c, meta);
}

/** Keeps the user's yes for the session's project. A failure costs one more question in another session, and is logged. */
function rememberServer(c: Ctx, meta: SessionMeta, question: Pick<TurnServerQuestion, "name" | "fingerprint">): Promise<void> {
	const work = serverApprovals.remember(c, meta, question).then(
		() => serversChanged(c, meta),
		(error: unknown) => c.log.warn({ msg: "could not remember the approval of a project's MCP server", session: meta.sessionId, server: question.name, error: describeError(error) }),
	);
	return c.vars.stopping ? work : c.keepAwake(work);
}

/** When the user approved, in the words of a line: "3 days ago". */
function ago(ms: number): string {
	return ms < 60_000 ? "a moment ago" : `${duration(ms)} ago`;
}

/** The session's servers as the side panel shows them: what the session kept, and what the user's record says of each. */
async function sessionServers(c: Ctx, meta: SessionMeta): Promise<SessionServers> {
	const known = meta.servers ?? [];
	const { sandboxes } = await layerOf(c, meta);
	// A session whose project names no server asks nobody: the user's own have no approval.
	const approvals = known.some((server) => server.origin !== "user") ? await serverApprovals.of(c, meta) : [];
	const project = projectOf(meta);
	const context: ServerQuestionContext = { profile: sandboxes.profile(meta.profile), demo: meta.demo, dataInSandbox: await privateSessionData(meta, sandboxes, meta.sandboxId), project, machine: machineOf(meta), hostedEgress: meta.place.kind === "hosted" ? sandboxes.egress?.() : undefined };
	const view = serversView(project, known, approvals, forgettingWords(context), (server) => serverPanelWords(server, context));
	// Why a server of the user's own that reads an account's secret does not start here, where that is so.
	return known.some((server) => server.origin === "user") ? { ...view, accountSecrets: meta.accountSecrets ?? null } : view;
}

/**
 * The layer's `onServerQuestion`: puts the question about a server the project's configuration names,
 * and returns the promise that `answer()`, the timeout, a stop or the turn's end settles: true to
 * start it. One asked before the prompt went (`holdsTurn`) turns the session to `waiting`, as a tool
 * call's does; one asked while the turn runs leaves it running. While a tool call's question is shown,
 * this one waits behind it. Where the user's approval of exactly this definition is remembered for the
 * session's project, nothing is put: the answer is yes, and the turn's line says why.
 */
async function askServer(c: Ctx, meta: SessionMeta, active: ActiveTurn, context: ServerQuestionContext, given: TurnServerQuestion, withdrawn: AbortSignal): Promise<boolean> {
	const gone = () => active.closed || active.stopping || active.controller.signal.aborted || withdrawn.aborted;
	const argv = Array.isArray(given?.argv) ? given.argv.map(str) : null;
	const question: TurnServerQuestion = {
		name: str(given?.name),
		fingerprint: str(given?.fingerprint),
		argv,
		url: argv === null ? str(given?.url) : null,
		file: typeof given?.file === "string" && given.file !== "" ? given.file : null,
		unset: Array.isArray(given?.unset) ? given.unset.map(str) : [],
		secrets: Array.isArray(given?.secrets) ? given.secrets.map(str) : [],
		holdsTurn: given?.holdsTurn === true,
	};
	if (gone()) return false;
	// The user's own record first. Should it not answer in time, the user is asked, which is never wrong.
	const recalled = await orNull(serverApprovals.approved(c, meta, question), RECALL_WAIT_MS);
	if (gone()) return false;
	if (recalled) {
		active.recalled.set(serverKey(question), recalled);
		return true;
	}

	const words = serverQuestionWords(question, context);
	const now = Date.now();
	return new Promise<boolean>((resolve) => {
		let done = false;
		let shown = false;
		const settle = (start: boolean): void => {
			if (done) return;
			done = true;
			withdrawn.removeEventListener("abort", onWithdrawn);
			active.unsettled.delete(asked);
			const at = active.aside.indexOf(asked);
			if (at >= 0) active.aside.splice(at, 1);
			clearTimeout(asked.timer);
			resolve(start);
		};
		const asked: Asked = {
			pending: {
				id: `q_${randomBytes(8).toString("hex")}`,
				turn: active.number,
				messageId: "",
				callId: "",
				title: words.title,
				subject: words.subject,
				details: words.details,
				choices: words.choices,
				subagent: null,
				askedAt: now,
				expiresAt: now + config.questionTimeoutMs,
				server: { name: question.name, file: question.file, remote: argv === null, unset: question.unset, holdsTurn: question.holdsTurn },
			},
			timer: undefined,
			server: { name: question.name, fingerprint: question.fingerprint },
			answer: (answer) => {
				if (done) return;
				const start = answer.choice === SERVER_START;
				// A yes gets its line, and is remembered, when Windlass has said what became of the server (`onServerApproved`).
				if (!start) note(c, active.number, "info", serverNotNowNote(question));
				settle(start);
			},
			decline: () => settle(false),
			put: () => {
				// Put again after it stood aside, it has the whole time to be answered in once more.
				if (shown) asked.pending = { ...asked.pending, expiresAt: Date.now() + config.questionTimeoutMs };
				shown = true;
				asked.timer = setTimeout(() => {
					// Nobody answered: "not now", and the turn goes on without the server.
					if (active.question !== asked) return;
					takeQuestion(c, meta, active);
					note(c, active.number, "warn", serverExpiredNote(question, duration(config.questionTimeoutMs)));
					publish(c);
					void persist(c);
					settle(false);
				}, Math.max(0, asked.pending.expiresAt - Date.now()));
				active.question = asked;
				if (question.holdsTurn && meta.status === "running") meta.status = "waiting";
				c.broadcast("question", asked.pending);
				publish(c);
				void persist(c);
			},
		};
		// The layer withdrew the question: the turn was stopped, or ended under a question put while it ran.
		function onWithdrawn(): void {
			if (done) return;
			if (!active.stopping && !active.controller.signal.aborted) note(c, active.number, "info", serverUnansweredNote(question));
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			settle(false);
		}
		withdrawn.addEventListener("abort", onWithdrawn, { once: true });
		active.unsettled.add(asked);
		if (active.question) active.aside.push(asked);
		else asked.put?.();
	});
}

// ---------------------------------------------------------------------------------------------
// The agent asks the platform to publish
// ---------------------------------------------------------------------------------------------


/** A push's line for a request of the agent's, which may also have given an open pull request another title and description. */
function agentPublishedLine(repo: StoredRepository, published: Published): string {
	const { pull } = published;
	if (!published.pushed && published.retitled) return `Gave pull request #${pull.number} the title and description the agent wrote; there was nothing new to push.`;
	const line = publishedLine(repo, pull, published.opened, published.committedFiles);
	return published.retitled ? `${line.replace(/\.$/, "")}, with the title and description the agent wrote.` : line;
}

/**
 * Puts the question about a request of the agent's to publish, and resolves with how it ended. It
 * stands where a tool call's question stands and is settled by the same `answer()`; like a server's
 * question it waits behind a question that is showing and steps aside for a tool call's. Nobody
 * answering in time declines it, as with a tool call's question: the turn does not wait for ever.
 */
function askPublish(c: Ctx, meta: SessionMeta, active: ActiveTurn, request: TurnPublishRequest, words: ReturnType<typeof publishQuestionWords>, withdrawn: AbortSignal): Promise<PublishAnswer> {
	const gone = () => active.closed || active.stopping || active.controller.signal.aborted || withdrawn.aborted;
	if (gone()) return Promise.resolve({ kind: "withdrawn" });
	const now = Date.now();
	return new Promise<PublishAnswer>((resolve) => {
		let done = false;
		let shown = false;
		const settle = (answer: PublishAnswer): void => {
			if (done) return;
			done = true;
			withdrawn.removeEventListener("abort", onWithdrawn);
			active.unsettled.delete(asked);
			const at = active.aside.indexOf(asked);
			if (at >= 0) active.aside.splice(at, 1);
			clearTimeout(asked.timer);
			resolve(answer);
		};
		const asked: Asked = {
			pending: {
				id: `q_${randomBytes(8).toString("hex")}`,
				turn: active.number,
				messageId: request.messageId,
				callId: request.callId,
				title: words.title,
				subject: words.subject,
				details: words.details,
				choices: words.choices,
				subagent: null,
				askedAt: now,
				expiresAt: now + config.questionTimeoutMs,
				publish: words.publish,
			},
			timer: undefined,
			answer: (answer) => settle(answer.choice === PUBLISH_DENY ? { kind: "declined", note: answer.note } : { kind: "allowed", how: answer.choice === PUBLISH_SESSION ? "session" : "once" }),
			decline: () => settle({ kind: "withdrawn" }),
			put: () => {
				// Put again after it stood aside, it has the whole time to be answered in once more.
				if (shown) asked.pending = { ...asked.pending, expiresAt: Date.now() + config.questionTimeoutMs };
				shown = true;
				asked.timer = setTimeout(() => {
					if (active.question !== asked) return;
					takeQuestion(c, meta, active);
					publish(c);
					void persist(c);
					settle({ kind: "expired" });
				}, Math.max(0, asked.pending.expiresAt - Date.now()));
				active.question = asked;
				if (meta.status === "running") meta.status = "waiting";
				c.broadcast("question", asked.pending);
				publish(c);
				void persist(c);
			},
		};
		// The call ended, or the turn did: nobody waits for the answer.
		function onWithdrawn(): void {
			if (done) return;
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			settle({ kind: "withdrawn" });
		}
		withdrawn.addEventListener("abort", onWithdrawn, { once: true });
		active.unsettled.add(asked);
		if (active.question) active.aside.push(asked);
		else asked.put?.();
	});
}

/**
 * The layer's `onPublish`: a request of the agent's that the platform publish the session's work.
 * Resolves with what the agent is told. What the request holds is the model's text: it is checked
 * and the repository's saved secrets are taken out before anyone is shown it or GitHub gets it
 * (agent-publish.ts). It goes to the session's branch and the session's pull request, by the same
 * `publishWork` a push from the panel uses, so what that refuses is refused here. Unless the
 * session lets the agent publish unasked, the user is asked first; and always where the profile
 * does not hold the agent's commands in Windlass's sandbox (`profileCommands`), or the request came
 * over MCP (`request.via`, from an endpoint in the container), since a request there may be a
 * command's. Never rejects.
 */
async function agentPublish(c: Ctx, meta: SessionMeta, active: ActiveTurn, sandbox: SandboxHandle, profileCommands: CommandSandbox, request: TurnPublishRequest, withdrawn: AbortSignal): Promise<string> {
	const turn = active.number;
	// A call over MCP may be any process's in the container: it is asked about as where commands are not sandboxed, whatever the profile.
	const commands: CommandSandbox = request.via === "mcp" ? "none" : profileCommands;
	const said = (line: string) => callLine(request.via, line);
	const repo = meta.repo;
	const app = githubApp();
	if (!repo || !app) return "Not published. This session has no repository of the user's GitHub connection to publish to.";
	const branch = meta.publishBranch ?? branchFor(meta.title, meta.sessionId);
	const checked = publishRequest(request.arguments, { branch, base: repo.branch }, active.secrets?.redactor ?? NO_REDACTION);
	if (!checked.ok) {
		note(c, turn, "warn", said(checked.said));
		return checked.told;
	}
	// One at a time, as from the panel: a second request meanwhile is told to wait for the first.
	if (c.vars.publishing) {
		note(c, turn, "info", said("The agent asked to publish while an earlier request of its was still being handled, so this one was refused."));
		return "Not published. An earlier request to publish is still being handled. Wait for its result before you ask again.";
	}
	c.vars.publishing = true;
	try {
		let allowed: PublishAllowed = "unasked";
		if (meta.publishUnasked !== true || commands !== "windlass") {
			const open = meta.pull && (meta.pull.state === "open" || meta.pull.state === "draft") ? meta.pull : null;
			const words = publishQuestionWords({ repository: `${repo.owner}/${repo.name}`, branch, base: repo.branch, message: checked.message, open, sandbox: commands, ...(request.via && { via: request.via }) });
			const answer = await askPublish(c, meta, active, request, words, withdrawn);
			if (answer.kind === "withdrawn") return PUBLISH_WITHDRAWN;
			if (answer.kind === "expired") {
				const unanswered = publishUnanswered(words.title, duration(config.questionTimeoutMs));
				note(c, turn, "warn", said(unanswered.said));
				return unanswered.told;
			}
			if (answer.kind === "declined") {
				const declined = publishDeclined(answer.note);
				note(c, turn, "info", said(declined.said));
				return declined.told;
			}
			allowed = answer.how;
			if (answer.how === "session" && commands === "windlass") {
				meta.publishUnasked = true;
				publish(c);
				void persist(c);
			}
		}

		meta.publishBranch = branch;
		try {
			const published = await publishWork({ app, connection: await githubConnection(c, meta), repository: repo, sandbox, sessionId: meta.sessionId, branch, pull: meta.pull ?? null, pushed: meta.pushedHead ?? null, message: checked.message, retitle: true, evidence: await evidenceOf(c, meta, turn) });
			if (published.head) published.pushed = recordPushHead(meta, sandbox, published.head);
			meta.pull = published.pull;
			meta.updatedAt = Date.now();
			c.vars.pullCheckedAt = Date.now();
			// What went out had not been through this turn's checks: the description is written again when the turn has ended.
			active.published = true;
			note(c, turn, "info", said(`${publishAllowedWords(allowed)} ${agentPublishedLine(repo, published)} ${published.pull.url}`));
			console.log(`[wlp] github.published session=${meta.sessionId} repository=${repo.id} pull=${published.pull.number} opened=${published.opened} by=agent asked=${allowed !== "unasked"}`);
			return publishedForAgent({ repository: `${repo.owner}/${repo.name}`, pull: published.pull, opened: published.opened, pushed: published.pushed, retitled: published.retitled, files: published.committedFiles });
		} catch (error) {
			// The push went through and the pull request did not: what is at GitHub is remembered, as after a push from the panel.
			if (error instanceof PullProblem && error.head) recordPushHead(meta, sandbox, error.head);
			if (!(error instanceof GithubProblem)) c.log.error({ msg: "could not publish for the agent", session: meta.sessionId, turn, error: describeError(error) });
			else console.warn(`[wlp] github.publish_failed session=${meta.sessionId} repository=${repo.id}: ${error.code} by=agent`);
			const failed = publishFailed(allowed, error instanceof GithubProblem ? error.message : "The platform could not push the work. Try again.");
			note(c, turn, "warn", said(failed.said));
			return failed.told;
		} finally {
			// The commit changed what differs from the last commit, and what GitHub lacks: both are read again when the turn ends.
			c.vars.unpushed = null;
			publish(c);
			await persist(c);
		}
	} catch (error) {
		c.log.error({ msg: "could not handle the agent's request to publish", session: meta.sessionId, turn, error: describeError(error) });
		return "Not published. The platform could not handle the request. Tell the user; do not try another way to publish.";
	} finally {
		c.vars.publishing = false;
	}
}

/**
 * The layer's `onPush`: the agent pushes the session's branch. Resolves with what the agent is told;
 * never rejects. It commits what is uncommitted with the agent's message and pushes, as a publish
 * does (`pushWork`, the same code), and opens or changes no pull request; an open one has its
 * section written again for the work as it is now, which says the turn's checks have not run yet
 * (`evidenceOf` with the turn), and once more from the turn's checks when the turn has ended
 * (`active.published`, `describeAfterTurn`).
 *
 * Never asked about, in any profile, attended or not, whatever "Let the agent publish without asking"
 * says. A call that a command made in the agent's name, where commands can (agent-publish.ts) and over
 * MCP, whose endpoint any process in the container may reach (platform-tools.ts), gains nothing by it: it pushes the workspace, which any command can already change, to the session's own
 * branch, which the platform names (the agent names no branch, so the default branch is out of reach),
 * under a lease that replaces only the platform's own last push and never a commit anyone else
 * pushed (git.ts `pushScript`).
 *
 * The call is this turn's: it is refused once the turn is closing. One at a time with a publish
 * (`c.vars.publishing`), decided and taken in one step, and under the sandbox's guard (`takeSandbox`).
 * Over MCP a turn may make at most `MCP_LIMITS.push` (platform-tools.ts), and each line in the
 * timeline says the call may not have been the agent's (`callLine`).
 */
async function agentPush(c: Ctx, meta: SessionMeta, active: ActiveTurn, sandbox: SandboxHandle, request: TurnPublishRequest): Promise<string> {
	const turn = active.number;
	const said = (line: string) => callLine(request.via, line);
	const repo = meta.repo;
	const app = githubApp();
	if (!repo || !app) return "Not pushed. This session has no repository of the user's GitHub connection to push to.";
	if (active.closed || c.vars.turn !== active) return "Not pushed. The turn this call was made in has ended.";
	const branch = meta.publishBranch ?? branchFor(meta.title, meta.sessionId);
	const checked = pushRequest(request.arguments, { branch, title: meta.title }, active.secrets?.redactor ?? NO_REDACTION);
	if (!checked.ok) {
		note(c, turn, "warn", said(checked.said));
		return checked.told;
	}
	if (c.vars.publishing) {
		note(c, turn, "info", said("The agent asked to push while an earlier push or request to publish was still being handled, so this one was refused."));
		return "Not pushed. An earlier push or request to publish is still being handled. Wait for its result before you push again.";
	}
	c.vars.publishing = true;
	const release = takeSandbox(c);
	meta.publishBranch = branch;
	// What the platform itself pushed last is all the push may replace: the agent's rebase of its own branch, nothing anyone else pushed.
	const lease = meta.platformPushed ?? null;
	try {
		const pushed = await pushWork({ app, connection: await githubConnection(c, meta), repository: repo, sandbox, sessionId: meta.sessionId, branch, pushed: meta.pushedHead ?? null, lease, redact: (text) => (active.secrets?.redactor ?? NO_REDACTION).text(text) }, checked.commit);
		if (pushed.pushed && pushed.head) pushed.pushed = recordPushHead(meta, sandbox, pushed.head);
		if (pushed.workspaceChanged) {
			const line = `GitHub has ${pushed.head} on ${branch}. The workspace Git state could not be synchronized after the push. Use fetch_base and reconcile the branch before pushing again.`;
			active.published = true;
			note(c, turn, "warn", said(line));
			return line;
		}
		if (!pushed.pushed) {
			note(c, turn, "info", said(`The agent asked to push; ${branch} at GitHub already had everything in the workspace.`));
			return nothingToPush(branch);
		}
		meta.updatedAt = Date.now();
		// What went out had not been through this turn's checks: an open pull request's section is written again when the turn has ended.
		active.published = true;
		const open = meta.pull && (meta.pull.state === "open" || meta.pull.state === "draft") ? meta.pull : null;
		const described = open ? await describePull({ app, connection: await githubConnection(c, meta), repository: repo, sandbox, pull: open, evidence: await evidenceOf(c, meta, turn) }) : null;
		if (described && meta.pull === open) meta.pull = described;
		c.vars.pullCheckedAt = Date.now();
		const shown = described ?? open;
		note(c, turn, "info", said(agentPushedLine({ branch, head: pushed.head, forced: pushed.forced, pull: shown })));
		console.log(`[wlp] github.pushed session=${meta.sessionId} repository=${repo.id} by=agent forced=${pushed.forced}`);
		return pushedForAgent({ branch, head: pushed.head, forced: pushed.forced, files: pushed.committedFiles, pull: shown });
	} catch (error) {
		if (!(error instanceof GithubProblem)) c.log.error({ msg: "could not push for the agent", session: meta.sessionId, turn, error: describeError(error) });
		else console.warn(`[wlp] github.push_failed session=${meta.sessionId} repository=${repo.id}: ${error.code} by=agent`);
		const why = error instanceof GithubProblem ? error.message : "The platform could not push the work. Try again.";
		note(c, turn, "warn", said(`The agent asked to push, and it did not go through: ${why}`));
		return `Not pushed. ${why}`;
	} finally {
		// The commit changed what differs from the last commit, and what GitHub lacks: both are read again when the turn ends.
		c.vars.unpushed = null;
		c.vars.publishing = false;
		release();
		publish(c);
		await persist(c);
	}
}

/**
 * The layer's `onFetchBase`: the session's base branch, as it is at GitHub now, fetched into the
 * workspace as `origin/<base>` with a token that may only read (`fetchBase`, as for an item's turn
 * that merges it), for the agent to rebase onto and push again. Never asked about: it reads. Under
 * the sandbox's guard; refused once the turn is closing. Resolves with what the agent is told.
 */
async function agentFetchBase(c: Ctx, meta: SessionMeta, active: ActiveTurn, sandbox: SandboxHandle, request: TurnPublishRequest): Promise<string> {
	const said = (line: string) => callLine(request.via, line);
	const repo = meta.repo;
	const app = githubApp();
	if (!repo || !app) return "Not fetched. This session has no repository of the user's GitHub connection.";
	if (active.closed || c.vars.turn !== active) return "Not fetched. The turn this call was made in has ended.";
	const release = takeSandbox(c);
	try {
		// The session's own branch too, once the platform has pushed it: what others pushed there, for the agent to merge.
		await fetchBase(app, await githubConnection(c, meta), repo, sandbox, meta.publishBranch ?? null);
		note(c, active.number, "info", said(`Fetched ${repo.branch} from GitHub into the workspace as origin/${repo.branch}, as the agent asked.`));
		return fetchedForAgent(repo.branch, meta.publishBranch ?? null);
	} catch (error) {
		const why = error instanceof GithubProblem ? error.message : describeError(error);
		note(c, active.number, "warn", said(`${repo.branch} could not be fetched from GitHub for the agent: ${why}`));
		return `Not fetched. ${error instanceof GithubProblem ? why : "The platform could not fetch it. Try again."}`;
	} finally {
		release();
	}
}

/** How long a turn's question waits for its answer: shorter in a hosted sandbox, which runs while it waits. */
function questionWait(meta: SessionMeta): number {
	return hostedLimitsApply(meta.place) ? config.hostedQuestionTimeoutMs : config.questionTimeoutMs;
}

/** Stops the turn. The question it may be waiting on goes first: nobody can answer a turn that is ending. */
function abortTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn): void {
	active.stopping = true;
	if (takeQuestion(c, meta, active)) {
		publish(c);
		void persist(c);
	}
	const shutdown = active.pausing === "restart" && meta.place.kind === "hosted" && (meta.harness ?? "windlass") === "windlass";
	active.controller.abort(shutdown ? PLATFORM_RESTART : undefined);
}

/** Closes the turn to steering, stopping one call and answering, and leaves no question behind. Never throws. */
function sealTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn): void {
	active.closed = true;
	active.control = null;
	try {
		takeQuestion(c, meta, active);
		for (const asked of [...active.unsettled]) asked.decline();
	} catch (error) {
		active.question = null;
		c.log.error({ msg: "could not withdraw the turn's question", error: describeError(error) });
	}
}

// ---------------------------------------------------------------------------------------------
// The sandbox's time and place (usage.ts)
// ---------------------------------------------------------------------------------------------

/** How long the user's meter may take to answer before a prompt gives up on it, and a running sandbox goes on without the answer. */
const METER_WAIT_MS = 10_000;
/** How long after a call to the meter that failed, or that found the session in the middle of something, the session looks again. */
const METER_RETRY_MS = 15_000;
/** How long after the moment the provider stops an unused sandbox the session asks whether it did. */
const IDLE_STOP_MARGIN_MS = 3_000;
/** How many reports of sandbox time a session keeps to send again. */
const MAX_UNSETTLED = 20;

/**
 * What a decision to stop counting names: the use of the sandbox the open hold was taken for
 * (`OpenStretch.use`). It is read in the synchronous step that decides, and the queued settlement goes
 * ahead only while the meter is still that use's: a hold a turn, a read or a push took after the
 * decision is theirs, whatever the decision found. Null when nothing is being counted.
 */
function useOf(meta: SessionMeta): string | null {
	return meta.meter?.use ?? null;
}

/** Runs `job` after every call to the user's meter queued before it. */
function metered<T>(c: Ctx, job: () => Promise<T>): Promise<T> {
	const run = c.vars.metering.then(job, job);
	c.vars.metering = run.catch(() => undefined);
	return run;
}

/** `promise`, or a rejection when it takes longer than `ms`. */
function inTime<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * Whether the open stretch is the one the session's stored state had as the actor woke, and nothing
 * has created, resumed, suspended or removed the sandbox since (`c.vars.carried`): what it ran after
 * the server that counted it went away is not known until the wake's read of the sandbox's state.
 */
function carriedOver(c: Ctx, meta: SessionMeta): boolean {
	const carried = c.vars.carried;
	return carried !== null && carried.use === useOf(meta) && carried.gen === c.vars.sandboxGen;
}

/**
 * Asks the user's meter for a hold, in trade for the one the session has when it has one, with what
 * the sandbox ran of that. On a yes the stretch goes on in the new hold from this moment. Null when
 * the meter did not answer. Only ever called from inside the meter's queue.
 */
async function takeHold(c: Ctx, meta: SessionMeta, fresh: boolean, observedUntil?: number): Promise<ReserveAnswer | null> {
	// Reports the book has not had go first: one for a hold it still has open would be counted in full once another is taken.
	if (meta.unsettled?.length) await sendUnsettled(c, meta);
	const open = meta.meter ?? null;
	// The same id, from the same moment, until an answer comes: a request that arrived and whose answer did
	// not is not a second hold, and the stretch goes on in it from when it was asked, not from the retry.
	const asked = meta.meterAsked ?? { id: `h_${randomBytes(8).toString("hex")}`, at: Date.now() };
	const now = asked.at;
	if (!meta.meterAsked) {
		// Stored before it is sent: a sleep, a crash or another node after this still knows what may be open.
		meta.meterAsked = asked;
		await persist(c);
	}
	// A fresh hold is for a use that starts now. A stretch carried over a wake that nobody has looked at
	// since may have ended long before, when the provider stopped the unused sandbox by itself: it is
	// traded at the latest moment the sandbox can have run, as a "found" close would count it, and not
	// up to the wake. Decided in the step that sends it.
	const until = open && fresh && carriedOver(c, meta) ? stoppedBy(open, meta.lastUsedAt, c.vars.idleStopMs, now) : now;
	let answer: ReserveAnswer;
	try {
		answer = await inTime(
			userActor(c, meta.uid).internalReserve({ id: asked.id, sessionId: meta.sessionId, hostedSize: meta.hostedSize ?? "small", keep: !meta.sandboxId, fresh, settle: open ? { hold: open.hold, seconds: stretchSeconds(open, until), observedUntil } : undefined }),
			METER_WAIT_MS,
		);
	} catch (error) {
		c.log.warn({ msg: "the user's sandbox time could not be asked for", session: meta.sessionId, error: describeError(error) });
		// With nothing running, nothing was started on it: a hold the book may have opened is reported at 0 s before the next is asked for.
		if (!meta.meter && meta.meterAsked === asked) {
			meta.unsettled = [...(meta.unsettled ?? []), { hold: asked.id, seconds: 0 }].slice(-MAX_UNSETTLED);
			meta.meterAsked = null;
			void persist(c);
		}
		return null;
	}
	meta.meterAsked = null;
	void persist(c);
	if (answer.ok) {
		applySandboxClamp(meta, answer.clampedSize, text => note(c, c.vars.turn?.number ?? 0, "info", text));
		// A renewal goes on with the use the hold was for; anything that starts takes a use of its own.
		const use = !fresh && open ? open.use : answer.hold.id;
		meta.meter = { hold: answer.hold.id, since: now, seconds: answer.hold.seconds, use, ...(open?.seen ? { seen: open.seen } : {}) };
		void persist(c);
	}
	return answer;
}

/**
 * Before the session's sandbox is created or started, and before a turn starts in one that runs:
 * takes a hold of its user's sandbox time, and a place among the sandboxes the user keeps when the
 * session has none. Throws the UserError a client is shown when a limit refuses it, and when the
 * user's actor does not answer: nothing is started on a count nobody could check. A sandbox that runs
 * then goes on to the end of the hold it has.
 */
function holdSandbox(c: Ctx, meta: SessionMeta, fresh: boolean, observedUntil?: number): Promise<void> {
	if (!hostedLimitsApply(meta.place)) return Promise.resolve();
	return metered(c, async () => {
		c.vars.idleStopMs = (await layerOf(c, meta)).sandboxes.idleStopMs;
		const answer = await takeHold(c, meta, fresh, observedUntil);
		armMeter(c, meta);
		if (answer === null) throw new UserError(USAGE_UNAVAILABLE, { code: "usage_unavailable" });
		if (answer.ok) return;
		if (answer.reason === "allowance") throw new UserError(allowanceRefusal(answer.numbers), { code: "allowance_used" });
		if (answer.reason === "sandboxes") throw new UserError(sandboxRefusal(answer.numbers), { code: "too_many_sandboxes" });
		throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
	});
}

/**
 * Sets the timer for the moment the session next has to look at its sandbox's time: when its hold is
 * over, or, with no turn in it, when the provider would have stopped the sandbox by itself. Not before
 * `notBefore`. Nothing is set while the sandbox does not run, or once the actor is on its way out.
 */
function armMeter(c: Ctx, meta: SessionMeta, notBefore = 0): void {
	if (c.vars.meterTimer) clearTimeout(c.vars.meterTimer);
	c.vars.meterTimer = null;
	const open = meta.meter;
	if (!open || c.vars.stopping || c.vars.destroying) return;
	let at = open.since + open.seconds * 1000;
	const idleStopMs = c.vars.idleStopMs;
	if (idleStopMs !== null && !c.vars.turn) {
		at = Math.min(at, Math.max(Math.max(open.since, meta.lastUsedAt) + idleStopMs + IDLE_STOP_MARGIN_MS, (open.seen ?? 0) + METER_RETRY_MS));
	}
	c.vars.meterTimer = setTimeout(
		() => {
			// As with the actor's abort signal: RivetKit may have let go of the actor's state by now, and reading it then throws.
			try {
				c.vars.meterTimer = null;
				if (c.vars.stopping || c.vars.destroying || c.vars.meta !== meta) return;
				void c.keepAwake(meterTick(c, meta));
			} catch {
				// The actor is stopping: `onSleep` settles what is open.
			}
		},
		Math.max(0, Math.max(at, notBefore) - Date.now()),
	);
}

/**
 * The timer's visit. A sandbox with no turn in it that the provider has stopped by itself has its
 * stretch settled, up to the moment it can have run to. One whose hold is over trades it for the
 * next; when the meter does not answer, the sandbox goes on and the meter is asked again shortly
 * (the hold it has is counted in full by the meter itself if that never works); and when the day's
 * allowance gives no more, the sandbox stops (`outOfTime`).
 */
function meterTick(c: Ctx, meta: SessionMeta): Promise<void> {
	return metered(c, async () => {
		const open = meta.meter;
		if (!open || c.vars.stopping || c.vars.destroying || c.vars.meta !== meta) return;
		const id = meta.sandboxId;
		const unused = !busy(c);
		const idleStopMs = c.vars.idleStopMs;
		if (id && unused && idleStopMs !== null && Date.now() >= Math.max(open.since, meta.lastUsedAt) + idleStopMs) {
			const gen = c.vars.sandboxGen;
			const read = await layerOf(c, meta)
				.then(({ sandboxes }) => observeSandbox(sandboxes, id))
				.catch(() => null);
			// A sandbox resumed or suspended while it was asked about is not the one the answer describes.
			const observed = c.vars.sandboxGen === gen ? read : null;
			if (observed?.state === "running") open.seen = Date.now();
			else if (observed !== null && !busy(c)) {
				const until = stoppedBy(open, meta.lastUsedAt, idleStopMs, Date.now(), observed.pausedAt);
				await settleStretch(c, meta, until, useOf(meta), observed.pausedAt);
				noteSandbox(c, meta, observed.state);
				void armIdle(c, meta);
				return;
			}
		}
		if (Date.now() < open.since + open.seconds * 1000) {
			armMeter(c, meta);
			return;
		}
		const answer = await takeHold(c, meta, false);
		// Without an answer the sandbox goes on, still counted by the book, until shortly before the hold runs out there; then it stops.
		const deadline = holdDeadline(open.since, open.seconds);
		if (answer !== null && !answer.ok && answer.reason === "allowance") outOfTime(c, meta, turnStoppedNote(answer.numbers), idleSuspendedNote(answer.numbers));
		else if (answer === null && Date.now() >= deadline) {
			console.log(`[wlp] usage.unchecked_stop session=${meta.sessionId}: its sandbox time could not be checked before its hold ran out`);
			outOfTime(c, meta, UNCHECKED_TURN_NOTE, UNCHECKED_IDLE_NOTE);
		} else armMeter(c, meta, answer?.ok ? 0 : Math.min(Date.now() + METER_RETRY_MS, deadline));
	});
}

/**
 * The sandbox may not run on: the day's allowance cannot cover it, or its time could not be checked
 * before its hold ran out. A turn that runs is stopped, with a line that says why (`turnText`), and its
 * sandbox is suspended once the turn has closed (`meterAfterTurn`); a sandbox with no turn in it is
 * suspended now (`idleText`). Either way its files stay as they are.
 */
function outOfTime(c: Ctx, meta: SessionMeta, turnText: string, idleText: string): void {
	const active = c.vars.turn;
	if (active) {
		if (active.outOfTime || active.closed) return;
		active.outOfTime = true;
		note(c, active.number, "warn", turnText);
		console.log(`[wlp] usage.turn_stopped session=${meta.sessionId} turn=${active.number}: its sandbox may not run on`);
		abortTurn(c, meta, active);
		return;
	}
	void c.keepAwake(suspendOutOfTime(c, meta, idleText));
}

/**
 * Suspends the sandbox because no sandbox time is left for it to run on, and settles its stretch.
 * `text` is the timeline's line; null when the turn that was stopped has said it. While a prompt is
 * being accepted, or something else has the sandbox, it is left for the timer's next visit. Never throws.
 */
async function suspendOutOfTime(c: Ctx, meta: SessionMeta, text: string | null): Promise<void> {
	const id = meta.sandboxId;
	if (!id || c.vars.stopping || c.vars.destroying) return;
	if (busy(c)) {
		armMeter(c, meta, Date.now() + METER_RETRY_MS);
		return;
	}
	// Set in the same step as the checks above: from here a prompt waits for it.
	const release = takeSandbox(c);
	const work = (async () => {
		const { sandboxes } = await layerOf(c, meta);
		await sandboxes.suspend(id);
		sandboxChanged(c);
		console.log(`[wlp] sandbox.suspended_out_of_time id=${id} session=${meta.sessionId}`);
		meta.sandbox = "paused";
		const use = useOf(meta);
		if (text !== null) note(c, meta.turns, "info", text);
		await closeMeter(c, meta, "now", use);
		publish(c);
		await persist(c);
	})();
	c.vars.idling = work;
	try {
		await work;
	} catch (error) {
		c.log.error({ msg: "could not suspend the sandbox when its user's sandbox time was used up", sandbox: id, error: describeError(error) });
		armMeter(c, meta, Date.now() + METER_RETRY_MS);
	} finally {
		c.vars.idling = null;
		release();
	}
	await armIdle(c, meta);
}

/**
 * The stretch ended at `until`: what the sandbox ran of its hold is the session's to report. It is
 * kept with the session first and sent then, so a report that does not get through is sent again
 * when the session is next awake. Only ever called from inside the meter's queue.
 */
async function settleStretch(c: Ctx, meta: SessionMeta, until: number, use: string | null, observedUntil?: number): Promise<void> {
	const open = meta.meter;
	if (!open || useOf(meta) !== use) return;
	meta.meter = null;
	if (c.vars.meterTimer) clearTimeout(c.vars.meterTimer);
	c.vars.meterTimer = null;
	// A renewal whose answer never came ends with the stretch it was to continue.
	meta.unsettled = [...(meta.unsettled ?? []), ...closingReports(open, meta.meterAsked ?? null, until, observedUntil)].slice(-MAX_UNSETTLED);
	meta.meterAsked = null;
	void persist(c);
	await sendUnsettled(c, meta);
}

/** Sends the reports the user's actor has not had. One that does not get through stays for the next time. Never throws. */
async function sendUnsettled(c: Ctx, meta: SessionMeta): Promise<void> {
	for (const report of [...(meta.unsettled ?? [])]) {
		try {
			await inTime(userActor(c, meta.uid).internalSettle({ sessionId: meta.sessionId, ...report }), METER_WAIT_MS);
		} catch (error) {
			c.log.warn({ msg: "could not report the sandbox's time to its user; it is reported again when the session is next awake", session: meta.sessionId, hold: report.hold, error: describeError(error) });
			return;
		}
		meta.unsettled = (meta.unsettled ?? []).filter((other) => other !== report);
		void persist(c);
	}
}

/**
 * The session's sandbox does not run any more: settles the stretch that was being counted. "now" when
 * the session stopped it itself; "found" when the session finds it stopped, and it can have run until
 * the provider's own timeout at the latest, and no longer than the hold it had. `use` is what the
 * caller decided about (`useOf`), read when it decided: a turn that ended without a sandbox, or a state
 * read from before a wake, must not settle the hold of a prompt that came meanwhile. Never throws.
 */
function closeMeter(c: Ctx, meta: SessionMeta, how: "now" | "found", use: string | null, pausedAt?: number): Promise<void> {
	const at = Date.now();
	if (use === null) return Promise.resolve();
	return metered(c, async () => {
		const open = meta.meter;
		if (!open || useOf(meta) !== use) return;
		// The provider's timeout is asked of this session's layer every time: a server that has not asked yet must not count to now.
		const until = how === "now" ? at : foundStoppedAt(open, meta.lastUsedAt, (await layerOf(c, meta)).sandboxes.idleStopMs, at, pausedAt);
		await settleStretch(c, meta, until, use, pausedAt);
	}).catch((error) => {
		c.log.warn({ msg: "could not settle the sandbox's time", session: meta.sessionId, error: describeError(error) });
	});
}

/** The session has no sandbox any more: its place among the sandboxes its user keeps is free. Never throws; a place that is not given back is found when the count is held against the provider's list. */
async function releasePlace(c: Ctx, meta: SessionMeta): Promise<void> {
	if (!hostedLimitsApply(meta.place)) return;
	await inTime(userActor(c, meta.uid).internalRelease(meta.sessionId), METER_WAIT_MS).catch((error) => {
		c.log.warn({ msg: "could not give the sandbox's place back to its user", session: meta.sessionId, error: describeError(error) });
	});
}

/**
 * A turn has closed: what follows for the sandbox's time and place. `use` is the meter's when the turn
 * ended, read before a new prompt could be taken: one that came in the turn's last steps has a hold
 * and a place of its own. Never throws.
 */
async function meterAfterTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn, use: string | null): Promise<void> {
	try {
		if (!meta.sandboxId || meta.sandbox !== "running") {
			await closeMeter(c, meta, "now", use);
			// A turn that ended without a sandbox, because none could be made, holds no place; unless a prompt that came since is making one.
			if (!meta.sandboxId && !c.vars.turn && !c.vars.accepting && !c.vars.destroying) await releasePlace(c, meta);
		} else if (active.outOfTime) {
			await suspendOutOfTime(c, meta, null);
		} else {
			armMeter(c, meta);
		}
	} catch (error) {
		c.log.warn({ msg: "could not look after the sandbox's time when the turn ended", session: meta.sessionId, error: describeError(error) });
	}
}

/**
 * When the actor wakes: a stretch that was open when it went away, a sandbox that runs with nobody
 * counting it (one from before sandbox time was counted, or one that went on under a server that
 * stopped), and reports that never arrived. Called once the sandbox's real state is known. `use` is
 * the meter's as the actor woke, read before anything was awaited: the prompt that woke it may have
 * taken a hold since, which is that prompt's to settle. Never throws.
 */
async function wakeMeter(c: Ctx, meta: SessionMeta, use: string | null): Promise<void> {
	// The sandbox's state was read (`refreshSandbox`): from here the stretch is settled as found, or goes on.
	c.vars.carried = null;
	if (!hostedLimitsApply(meta.place)) return;
	try {
		c.vars.idleStopMs = (await layerOf(c, meta)).sandboxes.idleStopMs;
		const running = meta.sandboxId !== null && meta.sandbox === "running";
		if (use !== null && !running) await closeMeter(c, meta, "found", use);
		else if (meta.meter) armMeter(c, meta);
		else if (running && !busy(c)) {
			const answer = await metered(c, () => takeHold(c, meta, false));
			armMeter(c, meta);
			if (answer !== null && !answer.ok && answer.reason === "allowance") await suspendOutOfTime(c, meta, idleSuspendedNote(answer.numbers));
		}
		await metered(c, () => sendUnsettled(c, meta));
	} catch (error) {
		c.log.warn({ msg: "could not take up the sandbox's time again", session: meta.sessionId, error: describeError(error) });
	}
}

/**
 * As the actor wakes, before any call can ask for a hold: a hold asked for with nothing running, whose
 * answer never came because the server stopped under the request, is reported at 0 s, as `takeHold`
 * reports one whose answer did not come in time. Nothing was started on it. Asked again instead, it
 * would be the waking prompt's hold, counted from before the server went away, and with no prompt it
 * would wait until the book counted it in full. One asked for while the sandbox was stored as running
 * may have had the sandbox run in it, and is asked again as before.
 */
function settleWokenAsk(c: Ctx, meta: SessionMeta): void {
	const asked = meta.meterAsked;
	if (!asked || meta.meter || (meta.sandboxId !== null && meta.sandbox === "running")) return;
	meta.unsettled = [...(meta.unsettled ?? []), { hold: asked.id, seconds: 0 }].slice(-MAX_UNSETTLED);
	meta.meterAsked = null;
	void persist(c);
}

/** Going to sleep: the timer goes, and a sandbox that was suspended has its stretch settled. One that could not be suspended keeps its hold, which the meter counts by itself. */
function sleepMeter(c: Ctx, meta: SessionMeta): Promise<void> {
	if (c.vars.meterTimer) clearTimeout(c.vars.meterTimer);
	c.vars.meterTimer = null;
	return meta.sandboxId && meta.sandbox === "running" ? Promise.resolve() : closeMeter(c, meta, "now", useOf(meta));
}

/** The sessions that have settled and given back what they had as they were deleted, so that it is done once. */
const usageLeft = new WeakSet<SessionMeta>();

/** The session is deleted: its sandbox's stretch is settled and its place given back. Never throws. */
async function leaveUsage(c: Ctx, meta: SessionMeta): Promise<void> {
	if (usageLeft.has(meta)) return;
	usageLeft.add(meta);
	if (c.vars.meterTimer) clearTimeout(c.vars.meterTimer);
	c.vars.meterTimer = null;
	await closeMeter(c, meta, "now", useOf(meta));
	await releasePlace(c, meta);
}

/**
 * Removes the session's sandbox with its files; the session stays, and its next prompt starts a new
 * one. For a sandbox nobody used for long, and for one its user frees to make room for another.
 */
async function removeSandbox(c: Ctx, meta: SessionMeta, id: string, text: string): Promise<void> {
	const { sandboxes } = await layerOf(c, meta);
	await sandboxes.destroy(id);
	sandboxChanged(c);
	meta.sandboxId = null;
	meta.sandbox = "none";
	const use = useOf(meta);
	meta.cloned = false;
	meta.setupDue = null;
	meta.setupUnfinished = null;
	meta.workDue = null;
	meta.setupOnBase = null;
	meta.snapshotCommit = null;
	await dropWorkspace(c);
	note(c, meta.turns, "info", text);
	await closeMeter(c, meta, "now", use);
	await releasePlace(c, meta);
}

// ---------------------------------------------------------------------------------------------
// An idle sandbox
// ---------------------------------------------------------------------------------------------

/** How long a check that failed, or found a prompt being accepted, waits before it looks again. */
const IDLE_RETRY_MS = 60_000;

/**
 * Whether a sandbox nobody used for long is removed. Not on one of the user's machines (design
 * decision 4): it costs the platform nothing there, and it is the user's to remove.
 */
function removedWhenIdle(meta: SessionMeta): boolean {
	return meta.place.kind === "hosted";
}

/** When the sandbox is next due: to be suspended while it runs, to be removed while it exists. Null when there is none. */
function idleDue(meta: SessionMeta): number | null {
	if (!meta.sandboxId) return null;
	if (meta.sandbox === "running") return meta.lastUsedAt + (meta.pauseNow ? 0 : config.idleSuspendMs);
	return removedWhenIdle(meta) ? meta.lastUsedAt + config.idleDestroyMs : null;
}

/**
 * Sets the durable schedule to look at the session when its sandbox is next due, not before `notBefore`.
 * A check already set for that moment is kept; one set for another is replaced. A later look
 * (`notBefore`, from a check that found the sandbox taken or failed) keeps a check set for sooner: what
 * had the sandbox set it since, as a read that resumed it does for its idle time from then, and the
 * queue may run that arming before this one. Queued, so two calls cannot both schedule; never rejects.
 */
function armIdle(c: Ctx, meta: SessionMeta, notBefore = 0): Promise<void> {
	const run = c.vars.arming.then(async () => {
		if (c.vars.destroying || c.vars.meta !== meta) return;
		const due = idleDue(meta);
		const at = due === null ? null : Math.max(due, notBefore);
		const current = meta.idleCheck ?? null;
		// A check whose time has passed was taken by the schedule already. One that was cut off before it set
		// the next (a deploy or a crash while it ran) would otherwise stand for ever, the wake's repair included.
		const armed = current !== null && current.at > Date.now() ? current : null;
		if (armed?.at === at || (armed === null && at === null)) return;
		if (notBefore > 0 && armed !== null && at !== null && armed.at < at) return;
		meta.idleCheck = at === null ? null : { id: await c.schedule.at(at, "internalIdle"), at };
		// Written before the old one is cancelled: a crash in between leaves the old one, which still works.
		await persist(c);
		if (current) await c.schedule.cancel(current.id).catch(() => false);
	});
	c.vars.arming = run.catch((error) => {
		c.log.warn({ msg: "could not schedule the idle check of the sandbox", error: describeError(error) });
	});
	return c.vars.arming;
}

/** The durable schedule's visit: suspends or removes the sandbox when it is due, then sets the next visit. */
async function idleCheck(c: Ctx, meta: SessionMeta): Promise<void> {
	// A turn in progress, or one waiting on the user's answer, is never cut off: its end sets the next check.
	if (c.vars.turn || meta.status !== "idle") {
		console.log(`[wlp] sandbox.idle_kept session=${meta.sessionId} status=${meta.status}`);
		return;
	}
	// Something has the sandbox (a prompt being accepted, a push, a read of the workspace, a suspend): it
	// is not taken from under it, and the check comes back, since what has it may set none.
	if (busy(c)) {
		console.log(`[wlp] sandbox.idle_busy session=${meta.sessionId}`);
		await armIdle(c, meta, Date.now() + IDLE_RETRY_MS);
		return;
	}
	const id = meta.sandboxId;
	const since = meta.lastUsedAt;
	const now = Date.now();
	const remove = id !== null && removedWhenIdle(meta) && now >= since + config.idleDestroyMs;
	const pauseNow = meta.pauseNow === true;
delete meta.pauseNow;
const suspend = id !== null && !remove && meta.sandbox === "running" && (pauseNow || now >= since + config.idleSuspendMs);
	let retry = 0;
	if (id && (remove || suspend)) {
		// Set in the same step as the checks above: from here a prompt waits for it.
		const release = takeSandbox(c);
		const work = (async () => {
			const { sandboxes } = await layerOf(c, meta);
			if (remove) {
				await removeSandbox(c, meta, id, `Removed the sandbox and its files after ${duration(config.idleDestroyMs)} without use; the next prompt starts a new one.`);
				console.log(`[wlp] sandbox.idle_removed id=${id} session=${meta.sessionId}`);
			} else {
				const state = await sandboxes.state(id);
				if (state === "running") {
					await sandboxes.suspend(id);
					sandboxChanged(c);
					console.log(`[wlp] sandbox.idle_suspended id=${id} session=${meta.sessionId}`);
					meta.sandbox = "paused";
					const use = useOf(meta);
					note(c, meta.turns, "info", pauseNow ? "Paused the sandbox: its turn ended on a question nobody answered. The next prompt resumes it." : `Suspended the sandbox after ${duration(config.idleSuspendMs)} without use; the next prompt resumes it.`);
					await closeMeter(c, meta, "now", use);
				} else {
					// Paused by a sleep, or gone: nothing to suspend, and nothing to say.
					meta.sandbox = state;
					await closeMeter(c, meta, "found", useOf(meta));
				}
			}
			publish(c);
			await persist(c);
		})();
		c.vars.idling = work;
		try {
			await work;
		} catch (error) {
			c.log.error({ msg: remove ? "could not remove the idle sandbox" : "could not suspend the idle sandbox", sandbox: id, error: describeError(error) });
			retry = Date.now() + IDLE_RETRY_MS;
		} finally {
			c.vars.idling = null;
			release();
		}
	}
	await armIdle(c, meta, retry);
}

// ---------------------------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------------------------

function usageOf(value: unknown): TurnUsage | null {
	if (typeof value !== "object" || value === null) return null;
	const { inputTokens, cachedInputTokens, outputTokens, reasoningTokens } = value as Record<string, unknown>;
	if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
	return {
		inputTokens,
		cachedInputTokens: typeof cachedInputTokens === "number" ? cachedInputTokens : 0,
		outputTokens,
		reasoningTokens: typeof reasoningTokens === "number" ? reasoningTokens : 0,
	};
}

/** Why Windlass produced no result, from its exit code (see its user guide, "Exit codes") and stderr. */
function failureMessage(result: RunTurnResult): string {
	const said = tail(result.stderrTail ?? "");
	let what: string;
	if (result.timedOut) what = "Windlass ran past the time limit and was stopped";
	else if (result.exitCode === null) what = "Windlass was killed before it finished";
	else if (result.exitCode === 2) what = "Windlass refused to start (exit code 2: an option, the model or the session was not accepted)";
	else if (result.exitCode === 0) what = "Windlass ended without reporting a result";
	else what = `Windlass ended without a result (exit code ${result.exitCode})`;
	return said ? `${what}:\n${said}` : `${what}.`;
}

function titleFrom(prompt: string): string {
	const text = prompt.replace(/\s+/g, " ").trim();
	let title = "";
	for (const word of text.split(" ").slice(0, 8)) {
		const next = title === "" ? word : `${title} ${word}`;
		if (next.length > 60) break;
		title = next;
	}
	if (title === "") title = text.slice(0, 60);
	return title.length < text.length ? `${title}…` : title;
}

function itemPrompt(row: InboxRow): string {
	return row.checkout && !row.text ? `Review pull request #${row.checkout.pr} at ${row.checkout.head.slice(0, 7)} against the task and its acceptance criteria.` : row.text;
}

/** Runs one accepted turn to its `turn.ended`. `release` gives back the sandbox its acceptance took (`takeSandbox`). Never rejects. */
async function runTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn, text: string, release: () => void): Promise<void> {
	const machine = meta.place.kind === "machine" ? machineActor(() => c.client(), meta.uid, meta.place.machineId) : null;
	// A turn that can be resumed keeps its wake from the start, while its sandbox is still being had as well.
	if (meta.run?.turn === active.number) heartbeat(c, true);
	try {
		await executeTurn(c, meta, active, text, release, machine);
	} finally {
		if (machine) await machine.releaseSlot(meta.sessionId, active.number).catch(error =>
			c.log.warn({ msg: "could not release machine turn slot", error: describeError(error) }));
		// A build reports once its turn has closed: the user's actor deletes the session on it.
		if (meta.environmentBuild) {
			const result = c.vars.environmentResult ?? { finishedAt: Date.now(), commit: "", image: "", checks: [], snapshot: false, failure: { kind: "setup" as const, check: null, line: "The build could not start its sandbox.", excerpt: "" } };
			void c.keepAwake(userActor(c, meta.uid).internalEnvironmentResult(meta.sessionId, result).catch(error =>
				c.log.warn({ msg: "could not report the environment build", error: describeError(error) })));
		}
	}
}

/** The turn's start clock: at the first output (or the turn's end) it keeps the record on the session, shows it, and logs it. */
function startClock(c: Ctx, meta: SessionMeta, turn: number, waited: number | null): StartClock {
	const place = meta.profile.startsWith("e2b") ? "e2b" : meta.place.kind === "machine" ? "machine" : "hosted";
	return new StartClock(turn, meta.harness ?? "windlass", place, waited, (times) => {
		meta.startTimes = keepStartTimes(meta.startTimes, times);
		console.log(startTimesLog(meta.sessionId, times));
		publish(c);
		void persist(c);
	});
}

async function resizeOptions(c: Ctx, meta: SessionMeta, layer: SandboxLayer): Promise<HostedSize[]> {
	if (meta.place.kind === "hosted" && billing()) return userActor(c, meta.uid).internalHostedSizes();
	return layer.sandboxes.sizes?.().map(size => size.id) ?? [];
}

function withLarger(memory: OutOfMemory, offered: HostedSize[]): OutOfMemory {
	return { ...memory, larger: largerHostedSize(memory.size ?? "large", offered) ?? undefined };
}

/** Compare the sandbox's own kill counts over the turn. A silent E2B guest can also be diagnosed from its provider's samples. */
export async function noteTurnMemory(c: Ctx, meta: SessionMeta, active: ActiveTurn, sandbox: SandboxHandle, start: { oomKills: number; totalMiB: number } | null, began: number, turn: number): Promise<void> {
	if (!start) return;
	try {
		const end = await sandbox.memoryEvents?.().catch(() => null);
		const killed = end ? end.oomKills - start.oomKills : 0;
		if (end && killed <= 0) return;
		const peak = (await sandbox.memoryPeak?.(began).catch(() => null)) ?? null;
		if (peak === null && !end) return;
		const hosted = meta.place.kind === "hosted";
		const memory: OutOfMemory = peak ?? { usedMiB: end!.totalMiB, totalMiB: end!.totalMiB, ...(hosted && meta.hostedSize && { size: meta.hostedSize }) };
		const layer = hosted ? await layerOf(c, meta) : null;
		const offered = layer ? await resizeOptions(c, meta, layer) : undefined;
		const what = end ? ` Its kernel stopped ${killed === 1 ? "a program" : `${killed} programs`} to free memory during this turn: a command that ended with "Killed" or exit code 137 was one of them.` : " It stopped answering commands.";
		note(c, turn, "warn", `${outOfMemoryWords(memory, offered, meta.place.kind)}${what}`);
		const allocation = hosted ? `size=${meta.hostedSize ?? "small"} used=${memory.usedMiB}` : "place=machine";
		console.log(`[wlp] sandbox.out_of_memory session=${meta.sessionId} turn=${turn} ${allocation} total=${memory.totalMiB} killed=${killed}`);
		if (active.item) active.item.outOfMemory = offered ? withLarger(memory, offered) : memory;
		// Its next connect finds it silent and restarts it: the item has been told of this sandbox's memory already.
		meta.memoryNoted = sandbox.id;
	} catch (error) {
		c.log.warn({ msg: "could not read the sandbox's memory at the turn's end", error: String(error) });
	}
}

async function executeTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn, text: string, release: () => void, machine: ReturnType<typeof machineActor> | null): Promise<void> {
	const startedAt = Date.now();
	const turn = active.number;
	const effort = active.effort;
	// A work item keeps its profile's approval (Windlass), or its agent's mode for the profile that never asks (harnesses.ts, `itemModes`).
	const mode = meta.origin ? itemModeOf(meta.harness, meta.profile) : meta.mode;
	const reviewer = meta.origin?.role === "reviewer";
	const checkout = active.item?.row.checkout;
	const critic = reviewer && active.item?.row.agent === "critic";
	// Where the outside text of an item's turn came from, and the one rule for every agent of how it goes (factory/untrusted.ts):
	// marked for Windlass where it can contain commands once told, labelled only otherwise, and on "Docker, hardened" someone
	// else's stops the turn until the person chose to run it anyway (`unsandboxed`).
	let untrusted = active.item?.row.untrusted ?? [];
	let outsideText = untrusted.length > 0 || !!active.item?.row.fresh?.untrusted.length;
	let handling = untrustedTurn({ agent: meta.harness ?? "windlass", profile: meta.profile, untrusted, unsandboxed: active.item?.row.unsandboxed });
	/** Refuses the turn on "Docker, hardened" for someone else's text in `retryText`; the item asks, and can run it anyway. */
	const refuseUntrusted = (item: NonNullable<ActiveTurn["item"]>, stop: Extract<typeof handling, { kind: "stop" }>, retryText: string): never => {
		item.refused = stop.reason;
		item.untrustedRefusal = { sources: stop.sources, retry: { text: retryText, fetchBase: item.row.fetchBase, untrusted } };
		throw new TurnProblem(stop.reason);
	};
	const unmarked = (text: string) => {
		if (meta.untrustedUnmarkedNoted) return;
		meta.untrustedUnmarkedNoted = true;
		note(c, turn, "warn", text);
		void persist(c);
	};
	const signal = active.controller.signal;
	/** The turn's own record (WLP_TURN_RESUME): its segments, its limit across pauses, and what pausing it needs. */
	const run = meta.run?.turn === turn ? meta.run : null;
	/** The runner conversation's losses when the agent started (`ServerChannel.losses`): more at its end, and the machine went away mid-turn. */
	let lossesAtStart: number | null = null;
	let agentStarted = false;
	let thrown: unknown = null;
	/** What a resumed turn's agent is given instead of its "carry on" should its saved session be gone after all. */
	let fresh: RunTurnInput["fresh"];
	/** Told the first time the agent says anything: from then on a resume continues its conversation of this turn. */
	const prompted = () => {
		if (!run || run.prompted) return;
		run.prompted = true;
		void persist(c);
	};
	let resumed = meta.windlassSessionId;
	let layer: SandboxLayer | null = null;
	let result: RunTurnResult | null = null;
	let problem: string | null = null;
	let lastStepRefusal: ProviderRefusal | null = null;
	const account = { place: meta.place.kind === "machine" ? meta.place.machineId : "hosted", harness: meta.harness ?? "windlass" as const };
	let generation: string | null = null;
	const observe = async (observation: UsageObservation) => {
		if (generation !== null) await userActor(c, meta.uid).internalObserveUsage(account, generation, observation)
			.catch(() => c.log.warn({ msg: "Could not record provider usage" }));
	};
	// Coalesce successive readings by window while an actor write is in flight.
	const pendingLimits = new Map<string, LimitEvent>();
	let writingLimits: Promise<void> | null = null;
	const recordLimit = (event: LimitEvent) => {
		if (event.status === "rejected" || pendingLimits.get(event.window.kind)?.status !== "rejected")
			pendingLimits.set(event.window.kind, event);
		writingLimits ??= (async () => {
			while (pendingLimits.size) {
				const next = pendingLimits.values().next().value!;
				pendingLimits.delete(next.window.kind);
				await observe({ kind: "event", event: next });
			}
			writingLimits = null;
		})();
	};
	const acpTimeline = acpRecorder(c, turn);
	let events = 0;
	let open = true;
	let used: SandboxHandle | null = null;
	/** While `openSandbox` runs: an error then is the sandbox's, not the agent's (`sandboxFailed`). */
	let opening = false;
	/** When the turn's limit stops it, ms since the epoch: set when its clock starts. */
	let turnEndsAt = Date.now() + TURN_TIMEOUT_MS;
	/** `TurnSandbox.memoryEvents` when the sandbox was opened. */
	let memoryAtStart: { oomKills: number; totalMiB: number } | null = null;
	const turnBegan = Date.now();
	/** The meter's use when the turn ended (`meterAfterTurn`). */
	let meterUse: string | null = null;
	/** A request of the agent's to publish or push, kept until it is handled: the turn does not close under it. */
	const tracked = (work: Promise<string>): Promise<string> => {
		active.publishes.add(work);
		void work.finally(() => active.publishes.delete(work));
		return work;
	};
	// A turn that never ends would hold its sandbox, and one of the user's running slots, for ever.
	let limit: ReturnType<typeof setTimeout> | undefined;
	let clock: StartClock | null = null;
	try {
		await persist(c);
		const waiting = Date.now();
		if (machine && meta.place.kind === "machine") {
			let announced = false;
			for (;;) {
				signal.throwIfAborted();
				const slot = await machine.turnSlot(meta.sessionId, turn, meta.size ?? meta.origin?.size ?? 1);
				signal.throwIfAborted();
				if (slot.state === "granted") break;
				if (slot.state === "unsupported") throw new TurnProblem("This runner does not support sizing beyond one slot.");
				if (slot.state === "offline" || slot.state === "removed") throw runnerLink(c, meta.place.machineId).away(slot.state);
				if (!announced && slot.state === "waiting") {
					const size = slot.size ?? 1;
					const waiting = slot.behind ? "Waiting behind an earlier turn" : `Waiting for ${size} free slot${size === 1 ? "" : "s"}`;
					const free = slot.max === null ? "" : `; ${Math.max(0, slot.max - slot.busy)} of ${slot.max} free`;
					note(c, turn, "info", `${waiting} on ${meta.machineName ? `‘${meta.machineName}’` : "your machine"}${free}.`);
					announced = true;
				}
				await delay(1000, undefined, { signal });
			}
		}
		clock = c.vars.startClock = startClock(c, meta, turn, machine ? Date.now() - waiting : null);
		// A resumed turn has what is left of its limit, never less than the floor: the time it was paused does not count.
		const limitMs = segmentLimit(TURN_TIMEOUT_MS, config.turnResume.floorMs, run);
		if (run) {
			run.segmentAt = Date.now();
			heartbeat(c, true);
		}
		// The deadline the sandbox is told (the turn-deadline hook) is this segment's: what is left, with the floor.
		turnEndsAt = Date.now() + limitMs;
		limit = setTimeout(() => {
			if (!open) return;
			const ran = run && run.resumes > 0 ? `This turn ran for ${duration(run.activeMs + limitMs)}, not counting the time it was paused; the limit is ${duration(TURN_TIMEOUT_MS)}, so it was stopped.` : `This turn ran for ${duration(TURN_TIMEOUT_MS)}, which is the limit, so it was stopped.`;
			note(c, turn, "warn", ran);
			abortTurn(c, meta, active);
		}, limitMs);

		layer = await layerOf(c, meta);
		if (reviewer && meta.harness && meta.harness !== "windlass") throw new TurnProblem("A work item's reviewer runs only with Windlass.");
		// A person's turn is checked when it is sent; nobody sends an item's. Refused before the sandbox opens: the item asks, with the login hint.
		const signedOut = active.item ? await itemSignInRefusal(c, meta) : null;
		if (signedOut) {
			active.item!.refused = signedOut;
			active.item!.policyRefusal = true;
			throw new TurnProblem(signedOut);
		}
		if (reviewer && ((!checkout && !critic) || !reviewerAllowed(meta.place, layer.sandboxes.profile(meta.profile)))) {
			const reason = REVIEW_PROFILE_REASON;
			if (active.item) active.item.refused = reason;
			throw new TurnProblem(reason);
		}
		// Someone else's text where no agent can contain what it talks the agent into ("Docker, hardened"): refused before anything
		// starts, unless the person chose to run it anyway. The item asks, and can run this very turn ("Run it anyway").
		if (active.item && handling.kind === "stop") refuseUntrusted(active.item, handling, active.item.row.text);
		// Before anything is started: the setup command and Windlass are handed them, and what either says is shown without them.
		active.secrets ??= await readSecrets(c, meta, turn);
		for (const text of active.secrets.unopened.splice(0)) note(c, turn, "warn", text);
		opening = true;
		const sandbox = await openSandbox(c, meta, turn, signal, layer, active.secrets);
		opening = false;
		clock.opened();
		// A build's turn ends here: it starts no agent (`buildEnvironment` ran in the setup).
		if (meta.environmentBuild) {
			c.vars.environmentResult ??= { finishedAt: Date.now(), commit: "", image: sandbox.image ?? "", checks: [], snapshot: false,
				failure: { kind: meta.cloned ? "setup" : "clone", check: null, line: meta.cloned ? "The setup command did not run." : "The repository could not be cloned.", excerpt: "" } };
			throw new TurnProblem("The environment build ended.");
		}
		used = sandbox;
		// The sandbox’s own kill count, to compare at the end of the turn.
		memoryAtStart = (await sandbox.memoryEvents?.().catch(() => null)) ?? null;
		// A resumed turn in the same sandbox measures from where its first segment there began: a pause is no fresh start.
		if (run?.memory?.sandboxId === sandbox.id) memoryAtStart = { oomKills: run.memory.oomKills, totalMiB: run.memory.totalMiB };
		else if (run && memoryAtStart) run.memory = { sandboxId: sandbox.id, ...memoryAtStart };
		if (sandbox.outOfMemory && active.item && meta.memoryNoted !== sandbox.id) {
			// It had run out of memory before this turn, and was restarted: in the same size the same commands run it out again,
			// so a work item asks its person first, where a larger size is offered. A person's own agent goes on: they read the note.
			active.item.outOfMemory = withLarger(sandbox.outOfMemory, await resizeOptions(c, meta, layer));
			if (active.item.outOfMemory.larger) throw new TurnProblem(sandbox.notice ?? outOfMemoryWords(sandbox.outOfMemory));
		}
		// What the turn is handed goes by what the session's harness can do, asked of this sandbox's.
		generation = await userActor(c, meta.uid).internalProviderGeneration(account).catch(() => {
			c.log.warn({ msg: "Provider login generation unavailable for this turn" });
			return null;
		});
		const harness = harnessOf(layer, meta.harness ?? "windlass");
		const caps = await harness.capabilities(sandbox);
		const platformTool = (tool: (typeof caps.platformTools)[number]) => caps.platformTools.includes(tool);
		// A reviewer runs only in the restricted session with its filing tool: a harness that has not both does not start one.
		if (reviewer && (!caps.restrictedReview || !platformTool(critic ? "file_plan_review" : "file_review"))) {
			const reason = REVIEW_PROFILE_REASON;
			if (active.item) active.item.refused = reason;
			throw new TurnProblem(reason);
		}
		if (meta.demo && !caps.demo) throw new TurnProblem("This agent's harness has no demo mode.");
		if (active.item) await itemTurnStarted(c, meta, active.item, sandbox, turn);
		// Windlass freezes model-visible tools at the first prompt. Resuming the planner does not
		// add report to that baseline. Switch conversations at the summary boundary, retaining the workspace
		// and the platform timeline. Each summary retry starts fresh. A paused segment resumes its conversation.
		const summary = active.item?.row.agent === "summary";
		if (summary !== !!meta.summaryConversation || (summary && !active.resume)) {
			meta.windlassSessionId = null;
			meta.summaryConversation = summary || undefined;
		}
		// Read after the sandbox is open: a sandbox made in place of a lost one has the session only when its copy was restored.
		resumed = critic ? null : meta.windlassSessionId;
		// A turn that resumes after a pause: its agent goes on with a short "carry on" when it has its conversation of the turn,
		// and is given the whole task when it has not (a new sandbox, a memory that was lost); also when the saved session turns
		// out to be gone only once the agent is asked for it (`fresh`). The whole task's sources go by the same rule as any turn's.
		if (active.resume && run?.prompted) {
			const whole = await wholeTask(c, meta, active, turn);
			outsideText ||= whole.untrusted.length > 0;
			const wholeHandling = untrustedTurn({ agent: meta.harness ?? "windlass", profile: meta.profile, untrusted: whole.untrusted, unsandboxed: whole.unsandboxed });
			if (resumed) {
				untrusted = [];
				handling = untrustedTurn({ agent: meta.harness ?? "windlass", profile: meta.profile, untrusted, unsandboxed: active.item?.row.unsandboxed });
				if (wholeHandling.kind !== "stop") fresh = { prompt: whole.text, ...(wholeHandling.kind === "marked" && { untrusted: wholeHandling.sources }) };
			} else {
				text = whole.text;
				untrusted = whole.untrusted;
				handling = wholeHandling;
				if (active.item && handling.kind === "stop") refuseUntrusted(active.item, handling, whole.text);
				note(c, turn, "info", "The agent no longer has its earlier conversation of this turn, so it was given the whole task again.");
			}
		} else if (active.item) {
			// A step that goes on, in an agent that has no conversation of it (a new sandbox, a memory that was lost): "continue
			// from where you were" would mean nothing to it, so it is given the step's whole task instead.
			const chosen = itemTurnText(active.item.row, text, resumed);
			if (chosen.fresh) {
				// The whole task's sources are its own (a GitHub issue's text), and go by the same rule as any turn's.
				text = chosen.text;
				untrusted = chosen.untrusted;
				handling = untrustedTurn({ agent: meta.harness ?? "windlass", profile: meta.profile, untrusted, unsandboxed: chosen.unsandboxed });
				if (handling.kind === "stop") refuseUntrusted(active.item, handling, chosen.text);
				note(c, turn, "info", "The agent no longer has its earlier conversation of this step, so it was given the whole task again.");
			}
		}
		if (!signal.aborted && meta.status === "starting") {
			meta.status = "running";
			publish(c);
			void persist(c);
		}
		const common: RunTurnInput = {
			prompt: text, mode, planMode:active.planMode, windlassSessionId: resumed ?? undefined, model: meta.model, effort: effort ?? undefined, signal,
			onQuestion: active.item ? undefined : (question, withdrawn) => askQuestion(c, meta, active, question, withdrawn),
			onControl: control => { if (open) active.control = control; },
			// A machine turn whose conversation is kept: what it would need to be taken up after a restart, read with each timeline write.
			...(c.vars.runner?.durable && {
				onCheckpoint: (read: () => TurnCheckpoint | null) => { if (open) active.checkpoint = read; },
				...(active.reattach && { reattach: active.reattach }),
			}),
			onStartMark: (point, ms) => clock?.mark(point, ms),
			onAcpUpdate: update => {
				if (!open) return;
				prompted();
				if (update.sessionUpdate === "usage_update" && update.rateLimit) recordLimit(update.rateLimit);
				if (caps.events === "acp") acpTimeline.update(update);
				const title = generatedSessionTitle(update, { typed: meta.titleIsTyped, item: meta.origin }, active.secrets?.redactor);
				if (title && title !== meta.title) meta.title = title;
				else if (update.sessionUpdate === "current_mode_update" && !active.modeQueued && meta.mode !== update.currentModeId) meta.mode = update.currentModeId;
				else return;
				publish(c);
				void persist(c);
			},
		};
		const item = active.item;
		const held = active.secrets;
		const planning = item?.row.agent === "planner";
		const planner = critic || planning || item?.row.agent === "summary";
		// Told once, to whichever agent takes the next prompt: what setup left, and whether the workspace is a new one.
		const notes = platformNotes(meta, reviewer);
		const store = item ? attachmentStore() : null;
		// A builder can reconnect to a sandbox created before a setting changed.
		const browser = !!item && caps.reportScreenshots && held.screenshots
			&& (meta.place.kind !== "machine" || sandbox.runnerScreenshots === true)
			&& (await sandbox.run("test -x /usr/local/bin/wlp-shot", { signal, timeoutMs: 5000 })).exitCode === 0;
		const unavailable = held.screenshots ? "Screenshots are unavailable in this sandbox. File without screenshots." : NO_REPO_SHOTS;
		let filings = Promise.resolve("");
		// A builder's platform tools (platform-tools.ts): the same handlers for every agent, which takes them by host tools (Windlass) or MCP (the others).
		// A work item's agent files its report, which the platform puts on the pull request it pushes itself.
		const onReport: RunTurnInput["onReport"] = item && !planning && !reviewer && platformTool("report") ? (request, withdrawn) => {
			const file = async () => {
				if (!open || withdrawn.aborted) return "The report call ended. File it again.";
				if (!browser && Array.isArray(request.arguments?.screenshots) && request.arguments.screenshots.length) return unavailable;
				const top = meta.cloneDirectory === "." ? sandbox.cwd : `${sandbox.cwd}/${meta.cloneDirectory}`;
				const owner = { by: "builder" as const, uid: meta.uid, sessionId: meta.sessionId, itemId: item.row.itemId, key: item.row.key };
				return fileReport(request.arguments, held.redactor, (filed, answer) => {
					if (!open || withdrawn.aborted) throw new Error("The report call ended.");
					item.report = filed;
					meta.report = { ...filed, run: Number(item.row.key.split(":")[1]) };
					note(c, turn, "info", `The agent filed its report: “${filed.title}”.${answer === REPORT_TAKEN ? "" : " " + answer}`);
				}, store && browser ? shots => uploadShots(sandbox, top, shots, owner, userActor(c, meta.uid), store, withdrawn) : null);
			};
			filings = filings.then(file, file).catch(() => "The platform could not finish filing this report. File it again.");
			if (summary) filings = filings.then(answer => {
				if (!item.report) item.said = held.redactor.text(answer).slice(0, 400);
				return answer;
			});
			return tracked(filings);
		} : undefined;
		meta.secretRequestBlocked = outsideText || ((!!resumed || !!active.resume) && !!meta.secretRequestBlocked);
		const onRequestSecret: RunTurnInput["onRequestSecret"] = !planner && !reviewer && (!item || typeof item.row.asksLeft === "number") && platformTool("request_secret") ? async (request, withdrawn) => {
			const refuse = async (message: string) => {
				const scope = item ? item.row.key.split(":").slice(0, 2).join(":") : "session";
				if (meta.secretRefusalRun !== scope) {
					meta.secretRefusalRun = scope;
					note(c, turn, "warn", "A secret request was refused.");
					await persist(c);
				}
				return message;
			};
			const validate = () => requestSecret(request.arguments, !!item?.asked || !!meta.secretRequest, !!meta.secretRequestBlocked || !!meta.tainted, held.redactor);
			if (!open || withdrawn.aborted) return "The call ended. Nothing was recorded.";
			const taken = validate();
			const name = taken.request?.name ?? "";
			let problem: string | null;
			try {
				if (item) {
					problem = await itemActor(c, meta.uid, item.row.itemId).internalSecretRequestLimit(item.row.key, name);
				} else {
					const attempts = meta.secretAsks ?? 0;
					problem = secretRequestLimit(name, attempts, meta.declinedSecrets ?? [], "session");
					if (attempts < MAX_SECRET_REQUESTS) {
						meta.secretAsks = attempts + 1;
						await serial(c, () => c.db.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta)));
					}
				}
				if (!problem && !taken.request) problem = taken.told;
				if (!problem) problem = await secretsActor(c, meta.uid, meta.sessionId).internalRequestedSecretConflict(meta.sessionId, name);
			} catch {
				problem = "The platform could not check this secret request. Try again.";
			}
			if (!open || withdrawn.aborted) return "The call ended. Nothing was recorded.";
			if (problem) return refuse(problem);
			// Another tool call or a third-party event may have landed during the lookups.
			const current = validate();
			if (!current.request) return refuse(current.told);
			const notice = secretRequestNotice(caps.events === "acp", !setupProjectOf(meta));
			const secretRequest = { ...current.request, notice, id: String(turn) };
			meta.secretRequest = secretRequest;
			append(c, { turn, kind: "platform", level: "info", text: `A secret was requested for ${name}.\n${notice}`, secretRequest });
			await persist(c);
			return current.told;
		} : undefined;
		// A builder asks its person a question; the item asks it when the turn ends. Never the planner, the summary or the reviewer,
		// and only on a delivery that says how many the run has left.
		const onAsk: RunTurnInput["onAsk"] = item && !planner && !reviewer && typeof item.row.asksLeft === "number" && platformTool("ask_person") ? (request, withdrawn) => {
			if (!open || withdrawn.aborted) return "The call ended. Nothing was recorded.";
			const taken = askPerson(request.arguments, { already: !!item.asked || !!meta.secretRequest, left: item.row.asksLeft ?? 0 }, held.redactor);
			if (taken.asked) item.asked = taken.asked;
			note(c, turn, taken.asked ? "info" : "warn", taken.said);
			return taken.told;
		} : undefined;
		// Where there is a repository to publish to and an app to do it with, the agent may publish (a person's session), push
		// its branch and have the base fetched to rebase onto (a person's session and an item's alike). The same handlers for
		// every agent; over MCP each call may be any process's in the container (platform-tools.ts), which the handlers go by.
		const repoTools = !planner && !reviewer && !!meta.repo && githubApp() !== null;
		const onPush: RunTurnInput["onPush"] = repoTools && platformTool("push") ? (request) => tracked(agentPush(c, meta, active, sandbox, request)) : undefined;
		const onFetchBase: RunTurnInput["onFetchBase"] = repoTools && platformTool("fetch_base") ? (request) => agentFetchBase(c, meta, active, sandbox, request) : undefined;
		lossesAtStart = c.vars.runner?.channel.losses ?? null;
		agentStarted = true;
		if (!signal.aborted && caps.events === "acp") {
			// These agents take no marker: the text is labelled in the prompt, and the timeline says so once.
			if (handling.kind === "labelled") unmarked(handling.note);
			result = await harness.runTurn(sandbox, {
				...common,
				prompt: notes.text + text,
				...(fresh && { fresh: { ...fresh, prompt: notes.text + fresh.prompt } }),
				...(item && { unattended: true }),
				onReport,
				onAsk,
				onRequestSecret,
				// Over MCP a publish is always put to the person, never "for this session": any process in the container may have asked.
				onPublish: repoTools && !item && platformTool("publish") ? (request, withdrawn) => tracked(agentPublish(c, meta, active, sandbox, "none", request, withdrawn)) : undefined,
				onPush,
				onFetchBase,
				secrets: { env: Object.fromEntries((meta.repo ? held.opened : held.account)
					.filter(s => s.scope === "agent" && held.requestedNames?.includes(s.name)).map(s => [s.name, s.value])),
					withholdEnv: [], passEnv: [], redactor: held.redactor },
				// The checks the user saved for the repository: the platform runs them when the agent ends its prompt (platform-checks.ts),
				// and records them as Windlass's gate would be; and the step limit, which the platform counts (platform-steps.ts).
				checks: planner || reviewer ? [] : held.checks,
				forceChecks: item?.row.agent === "run_checks",
				onChecks: (event, said) => {
					if (event.type === "synthetic.appended" && event.data?.origin === "check_report") meta.secretRequestBlocked = true;
					active.checks.note(event);
					if (open && said) note(c, turn, said.level, said.text);
				},
				maxSteps: reviewer ? RULES.reviewMaxSteps : active.item?.row.maxSteps,
				harnessModels: meta.harnessModels,
				onAcpNote: text => {
					if (open) note(c, turn, "warn", text);
				},
				onEffortFallback: fallback => {
					if (open) note(c, turn, "info", `The selected model uses its default effort${fallback && fallback !== "default" ? ` (“${fallback}”)` : ""}.`);
				},
				onAcpModes: (chosen, offered, fallbackFrom) => {
					if (!open) return;
					meta.availableModes = offered;
					if (!active.modeQueued) meta.mode = chosen;
					if (fallbackFrom !== undefined) note(c, turn, "info", `${machineHarnesses[meta.harness as keyof typeof machineHarnesses].name} does not offer “${fallbackFrom}” here. Using its current mode “${chosen}”.`);
					publish(c);
					void persist(c);
				},
			});
			// The agent took the prompt once it answered it.
			if (result.acp?.stopReason) notes.told();
		} else if (!signal.aborted) {
			// What the question about a project's server has to say depends on where this session runs.
			const profile = layer.sandboxes.profile(meta.profile);
			// Resume keeps a named agent until explicitly switched. The inbox also records planners from before this handoff was supported.
			const clearPlanner = !!(resumed && active.item && !planner && !reviewer &&
				(await c.db.execute("SELECT 1 FROM inbox WHERE agent IN ('planner', 'summary') AND turn IS NOT NULL LIMIT 1")).length);
			const servers: ServerQuestionContext = {
				profile,
				demo: meta.demo,
				dataInSandbox: await privateSessionData(meta, layer.sandboxes, sandbox.id),
				project: projectOf(meta),
				machine: machineOf(meta),
				hostedEgress: meta.place.kind === "hosted" ? layer.sandboxes.egress?.() : undefined,
				// Null for a session that is not on a repository of the GitHub connection: it can have none.
				secrets: setupProjectOf(meta) ? held.opened.map(({ name, scope }) => ({ name, scope })) : null,
				accountSecrets: accountSecretsFor(held.account, held.opened).map((secret) => secret.name),
			};
			// What the panel says of the account's secrets goes by this sandbox, as the list of the repository's does.
			meta.accountSecrets = accountSecretsNote(profile);
			const screenshots = browser && !!store;
			const listed: ReviewRecord[] = [];
			const commands = new ReviewCommands(held.redactor);
			let uiChanged = false;
			let filingFiles: (() => { read(path: string, sha: string): Promise<string>; close(): Promise<void> }) | null = null;
			let storedBrief: string | null = null;
			if (reviewer && (checkout || critic) && item) {
				const repo = meta.repo;
				const app = githubApp();
				if (!repo || !app || !meta.cloned) throw new ReviewRefused("the base clone is unavailable");
				const connection = await githubConnection(c, meta);
				if (!connection) throw new ReviewRefused("the repository connection is unavailable");
				const resolved = await resolveRepository(app, connection, repo.id, "read");
				const scope = { repositoryId: repo.id, permissions: { contents: "read", metadata: "read" } } as const;
				const { owner, name } = resolved.repository;
				const directory = meta.cloneDirectory ?? ".";
				if (checkout) await app.withToken(resolved.installation.id, scope, token => checkoutReview(sandbox, app.cloneUrl(owner, name), token, directory, checkout.pr, checkout.head, signal), { revokeAfter: true });
				// Windlass starts a project server with a remembered grant before it asks the platform.
				// The private data directory starts empty; fail closed if setup populated its grants.
				const grants = `${DATA_DIR}/approvals`;
				const grantCheck = await sandbox.run(`set -eu
test ! -L '${grants}'
if test -e '${grants}'; then
  test -d '${grants}'
  found=$(find '${grants}' -mindepth 1 -print -quit)
  test -z "$found"
fi`, { signal, timeoutMs: 5000 });
				if (grantCheck.aborted || grantCheck.timedOut) throw new TurnProblem("checking the saved project approvals was interrupted");
				if (grantCheck.exitCode !== 0) throw new ReviewRefused("could not establish that Windlass has no saved project approvals");
				if (critic) {
					const list = `git -C ${shellQuote(directory)} ls-tree -r --name-only -z HEAD` +
						(item.crossRepoPlan ? ` && find ${shellQuote(INPUTS_DIRECTORY)} -mindepth 2 -type f -print0` : "");
					const tree = await sandbox.run(list, { signal, timeoutMs: 10000 });
					if (tree.exitCode !== 0 || tree.timedOut || tree.aborted || !tree.stdout.endsWith("\0")) throw new TurnProblem("The critic could not read the tracked repository tree.");
					text += "\n\nTracked repository tree: " + JSON.stringify(tree.stdout.split("\0").slice(0, -1));
				}
				if (checkout) {
					const paths = await changedReviewPaths(sandbox, directory, checkout.baseSha, checkout.head);
					filingFiles = () => {
						let issued: InstallationToken | undefined;
						return {
							async read(path, sha) {
								issued ??= await app.installationToken(resolved.installation.id, scope);
								return app.fileAt(issued.token, owner, name, path, sha);
							},
							async close() { if (issued) await app.revoke(issued); },
						};
					};
					uiChanged = paths.some(path => /\.(tsx|jsx|vue|svelte|css|scss|html)$|^(web|app|pages|components|src\/ui)\//i.test(path));
					const manifestsChanged = paths.some(path => /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock[^/]*|requirements[^/]*\.txt|pyproject\.toml|uv\.lock|poetry\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Gemfile[^/]*)$/.test(path));
					const brief = reviewerTask(held.redactor.deep({ ...checkout, changed: groupReviewPaths(paths), uiChanged, manifestsChanged, screenshots }), listed, held.redactor.text(text));
					storedBrief = held.redactor.text(itemPrompt(item.row));
					text = brief;
				}
			}
			let calls = 0;
			// Told of no source (above): the timeline says once that the text went labelled only.
			if (handling.kind === "labelled") unmarked(handling.note);
			result = await harness.runTurn(sandbox, {
				...common,
				// Windlass gets the secrets that keep to their scope in this sandbox, the repository's and the account's, with the names its commands are and are not to have; every saved value is taken out of what it says.
				secrets: { ...turnEnvironment(planner || reviewer ? [] : held.opened, planner || reviewer ? [] : held.account, profile), redactor: held.redactor },
				// The user's own MCP servers, which Windlass starts without asking: they are the user's, saved for every session.
				// In an item's turn nobody watches, a tainted session's calls of the user's servers are Windlass's to refuse: none is answered unasked.
				servers: planner || reviewer ? [] : item && (untrusted.length || meta.tainted) ? held.servers.map(server => ({ ...server, unasked: false })) : held.servers,
				// The checks the user saved for the repository: Windlass runs them before it calls the turn done, as required checks.
				checks: planner || reviewer ? [] : held.checks,
				// Windlass's question about a tool of one whose tools run without asking: the layer answers it, and the timeline says for whom and why.
				onUnasked: (call) => {
					if (open) note(c, turn, "info", unaskedNote(str(call.server)), { code: "question_allowed", call: { messageId: str(call.messageId), callId: str(call.callId) } });
				},
				prompt: notes.text + text,
				...(fresh && { fresh: { ...fresh, prompt: notes.text + fresh.prompt } }),
				maxSteps: reviewer ? RULES.reviewMaxSteps : active.item?.row.maxSteps,
				// A command's timeout is held to what is left of the turn (windlass-config.ts `TURN_TIME_HOOK`).
				endsAt: turnEndsAt,
				...(handling.kind === "marked" && ((sources) => ({ untrusted: sources, onUntrustedUnmarked: () => { if (open) unmarked(unmarkedNote(sources)); } }))(handling.sources)),
				// Once Windlass says the session is tainted, also part way through this turn, nobody is there to answer for the user's servers.
				...(item && { unaskedUntilTainted: true }),
				reportScreenshots: browser,
				onPlanReview: critic && item ? async (request, withdrawn) => {
					if (withdrawn.aborted || item.planReview) return "This critic filing is closed.";
					const review = planReviewOf(held.redactor.deep(request.arguments));
					if (!review) return "File approve or revise and up to twelve concise findings. Revision needs a concrete finding.";
					item.planReview = review;
					return "Plan review filed. End your turn.";
				} : undefined,
				onReview: reviewer && item && checkout && filingFiles && platformTool("file_review") ? (request, withdrawn) => {
					const openFiles = filingFiles;
					const file = async () => {
						if (!open || withdrawn.aborted) return "The review call ended.";
						const args = request.arguments;
						if (args?.commands === true) {
							if (Object.keys(args).length !== 1) return "A command lookup takes only the commands field. No filing was used.";
							return "Completed shell commands in call order: " + (commands.records().map(r => r.ref).join(", ") || "none");
						}
						if (calls >= RULES.reviewFilings) return "No more filings in this turn. The platform keeps the last review it accepted. End your turn.";
						calls++;
						const owner = { by: "reviewer" as const, uid: meta.uid, sessionId: meta.sessionId, itemId: item.row.itemId, key: item.row.key };
						const top = meta.cloneDirectory === "." ? sandbox.cwd : `${sandbox.cwd}/${meta.cloneDirectory}`;
						const files = openFiles();
						const result = await fileReview(args, { records: listed, commands: commands.records(), earlier: earlierContext(checkout.earlier), round: checkout.round, redactor: held.redactor }, checkout.baseSha, checkout.head, screenshots, files.read,
							store ? shots => uploadShots(sandbox, top, shots, owner, userActor(c, meta.uid), store, withdrawn) : null, browser ? undefined : unavailable).finally(files.close);
						if (result.retryFree) calls--;
						if (!open || withdrawn.aborted) return "The review call ended.";
						if (result.filing) {
							if (uiChanged && !result.filing.screenshots.length) result.filing.notes.push("UI files changed; no screenshots.");
							meta.review = { ...result.filing, id: item.row.key, run: Number(item.row.key.split(":")[1]), round: checkout.round, head: checkout.head, base: checkout.baseSha, verdictId: checkout.verdictId, by: { sessionId: meta.sessionId, model: meta.model }, at: Date.now(), state: "filed", said: null };
							await persist(c);
						}
						item.said = result.answer;
						return result.answer;
					};
					filings = filings.then(file, file).catch(() => "The platform could not finish filing this review. Try again.");
					return tracked(filings);
				} : undefined,
				planner,
				clearPlanner,
				crossRepoPlan: planning && item?.crossRepoPlan === true,
				onPlan: planning && item ? (request) => tracked(itemActor(c, meta.uid, item.row.itemId).internalFilePlan({ key: item.row.key, plan: held.redactor.deep(request.arguments) })) : undefined,
				onReport,
				onAsk,
				onRequestSecret,
				script: meta.demo ? layer.windlass.demoScript(text, turn) : undefined,
				onEvent: (event) => {
					if (!open) return;
					events += 1;
					prompted();
					try {
						// Windlass echoes the submitted brief in this event. Keep its receipt, with the same short text as the user row.
						if (storedBrief !== null && event.type === "inbox.enqueued" && event.data?.origin === null) {
							event = { ...event, data: { ...event.data, content: [{ type: "text", text: storedBrief }] } };
							storedBrief = null;
						}
						if (signal.reason === PLATFORM_RESTART && run) {
							const result = restartShellResult(event);
							if (result !== event) run.stoppedCommand = true;
							event = result;
						}
						event = publicUsageEvent(event, lastStepRefusal);
						lastStepRefusal = stepRefusal(lastStepRefusal, event);
						if (event.type === "step.failed" && lastStepRefusal?.retryAfterMs !== undefined)
							lastStepRefusal.resetsAt = resetTime(Date.now() + lastStepRefusal.retryAfterMs);
						if (reviewer) commands.note(event);
						// Kept at once: Windlass says it once per session, and a later turn's servers go by it.
						if ((event.type === "taint.noticed" || event.type === "taint.cleared") && meta.tainted !== (event.type === "taint.noticed")) {
							meta.tainted = event.type === "taint.noticed";
							void persist(c);
						}
						active.checks.note(event);
						onWindlassEvent(c, meta, turn, event);
					} catch (error) {
						c.log.error({ msg: "could not record a Windlass event", error: describeError(error) });
					}
				},
				onPublish: repoTools && !active.item && platformTool("publish") ? (request, withdrawn) => tracked(agentPublish(c, meta, active, sandbox, commandSandbox(profile), request, withdrawn)) : undefined,
				onPush,
				onFetchBase,
				// The project's own MCP servers, which Windlass leaves stopped until the user says otherwise; nobody can say so in an item's turn.
				onServerQuestion: active.item
					? async (question) => {
							note(c, turn, "info", `The project's MCP server “${str(question?.name)}” was not started: a work item's turn has nobody to approve it.`);
							return false;
						}
					: (question, withdrawn) => askServer(c, meta, active, servers, question, withdrawn),
				onServerApproved: (question, outcome) => {
					const named = { name: str(question?.name), fingerprint: str(question?.fingerprint) };
					const recalled = active.recalled.get(serverKey(named));
					const remedy = unsetRemedy(Array.isArray(question?.unset) ? question.unset.map(str) : [], servers);
					const said = recalled ? serverRecalledNote(question, outcome, ago(Date.now() - recalled.approvedAt), remedy) : serverApprovedNote(question, outcome, remedy);
					note(c, turn, said.level, said.text);
					// The user's yes is kept once Windlass took it: a definition that had changed, or an approval that
					// never reached Windlass, is not one. Using a remembered approval does not renew it.
					if (!recalled && (outcome.state === "running" || outcome.state === "starting" || outcome.state === "failed")) void rememberServer(c, meta, named);
				},
				onServers: (said) => {
					if (open) knowServers(c, meta, said);
				},
			});
			// The native engine selects checks from the turn's diff even on a checks-only delivery.
			// Run all saved commands on the final tree if its own gate did not record them here.
			if (item?.row.agent === "run_checks" && result.summary?.outcome === "succeeded" && !result.failure && !signal.aborted) {
				const evidence = active.checks.verified(turn, held.checks, result.checks, meta.verified ?? null);
				const forced = new VerificationLog();
				const gate = new PlatformChecks(sandbox, held.checks, (event, said) => {
					forced.note(event);
					if (said) note(c, turn, said.level, said.text);
				}, { agent: "Windlass", redactor: held.redactor, signal, force: true, isolated: profile.approval !== "full" || !!meta.tainted || handling.kind === "marked" });
				await gate.finishNativeTurn(evidence);
				if (gate.ended !== null) active.checks = forced;
				if (signal.aborted) result.aborted = true;
			}
			// Windlass took the prompt if it said anything at all; a turn that never reached it is told again.
			if (events > 0) notes.told();
		}
	} catch (error) {
		thrown = error;
		const failure = checkout && meta.repo && error instanceof GithubError ? problemOf(error, meta.repo.owner, meta.repo.name) : error;
		if (checkout && active.item && !signal.aborted && (failure instanceof ReviewRefused || (failure instanceof GithubProblem && (failure.code === "github_denied" || failure.code === "github_gone")))) {
			const reason = active.secrets?.redactor.text(failure.message) ?? failure.message;
			active.item.refused = `The reviewer's checkout of ${checkout.head.slice(0, 7)} failed: ${reason}`;
		}
		if (active.item && !active.item.started && error instanceof MachineUnreachable) active.item.machineAway = error.reason;
		if (active.item && error instanceof DeploymentFull) active.item.full = error.limit;
		if (!signal.aborted) {
			// An error's text is the sandbox's or the provider's: the repository's saved values are taken out of it before it is logged or shown.
			const clean = (text: string) => active.secrets?.redactor.text(text) ?? text;
			problem = clean(error instanceof TurnProblem || isSandboxUserError(error) ? error.message : `The sandbox failed: ${describeError(error)}`);
			// The sandbox could not be prepared (connect, resume, its network, a clone): the agent never ran. A deployment that
			// is full or a machine away have their own handling above; a turn the session refused is no sandbox's fault.
			if (active.item && opening && !active.item.refused && !(error instanceof TurnProblem) && !(error instanceof DeploymentFull) && !(error instanceof MachineUnreachable)) active.item.sandboxFailed = clean(isSandboxUserError(error) ? error.message : describeError(error));
			if (error instanceof TurnProblem) c.log.warn({ msg: "turn failed", session: meta.sessionId, turn, error: clean(error.message) });
			else c.log.error({ msg: "turn failed", session: meta.sessionId, turn, error: clean(error instanceof Error ? (error.stack ?? error.message) : String(error)) });
		}
	}
	await active.finishNetwork?.();
	// A turn that ended before its agent's first output keeps what it measured.
	clock?.finish();
	if (c.vars.startClock === clock) c.vars.startClock = null;
	acpTimeline.flush();
	open = false;
	clearTimeout(limit);
	// From here on the turn takes no message, no answer and no stop of a call, and has no question.
	sealTurn(c, meta, active);
	// A push for the agent that was under way when the turn ended is finished first: the turn does not close under it.
	if (active.publishes.size > 0) await Promise.allSettled([...active.publishes]);
	// The machine went away under the turn (its conversation was lost, or it could not be had for a resume): the turn pauses
	// until it is back instead of ending. Not when the turn was stopped meanwhile, by its person or its limit.
	const lostLink = (lossesAtStart !== null && (c.vars.runner?.channel.losses ?? 0) > lossesAtStart)
		|| ((agentStarted || active.resume !== undefined || active.item?.started === true) && (thrown instanceof ConversationLost || (thrown instanceof MachineUnreachable && thrown.reason === "offline")));
	if (run && meta.place.kind === "machine" && !signal.aborted && lostLink) active.pausing ??= "machine";
	// A turn that ended by itself just as the server went away has ended: only one that was cut short pauses.
	const ownEnd = !!result && !result.aborted && (capabilitiesOf(meta.harness).events === "acp" ? !!result.acp?.stopReason && result.acp.stopReason !== "cancelled" : !!result.summary && result.summary.outcome !== "interrupted");
	const pausing = !!active.pausing && !!run && meta.run === run && !c.vars.destroying && !active.item?.withdrawn && !active.outOfTime && (active.pausing === "machine" || !ownEnd);
	// The sandbox's memory is read at the turn's end, not at a pause: a server going away, or a machine away, is no guest that
	// stopped answering. The resumed segment compares with the same start (`TurnRun.memory`).
	if (!pausing && used && !active.item?.outOfMemory) await noteTurnMemory(c, meta, active, used, memoryAtStart, turnBegan, turn);
	if (pausing && active.pausing && run) {
		try {
			await pauseTurn(c, meta, active, active.pausing, usageOf(result?.summary?.usage) ?? result?.acp?.tokens ?? null, result);
		} catch (error) {
			c.log.error({ msg: "could not pause the turn", error: describeError(error) });
		}
		release();
		return;
	}
	heartbeat(c, false);

	try {
		const caps = capabilitiesOf(meta.harness);
		const summary = result?.summary ?? null;
		// Windlass's summary event, or what an ACP agent answered its prompt with; with what the turn's earlier segments used.
		const usage = addUsage(run?.usage ?? null, usageOf(summary?.usage) ?? result?.acp?.tokens ?? null);
		// Settle all reported requests before this turn's completion can admit more work.
		if (usesPlatformModel(meta.place, meta.harness)) {
			await serial(c, () => writeItems(c));
			await sendOutbox(c, meta.uid);
		}
		let outcome: TurnOutcome;
		let stepLimit: number | undefined;
		let message: string | null = null;
		if (caps.events === "acp") {
			const reason = result?.acp?.stopReason;
			if (result?.acp && result.windlassSessionId) meta.harnessModels = result.acp.models;
			if (resumed && result?.resumed === false && result.windlassSessionId) note(c, turn, fresh ? "info" : "warn", fresh ? `${harnessName(meta.harness)} could not continue its saved conversation, so it was given the whole task again.` : `${harnessName(meta.harness)} could not continue the conversation; the files are as they were.`);
			if (result?.failure || problem) {
				outcome = "error";
				message = result?.failure?.message ?? problem;
				// Codex asked to leave its sandbox (acp-harness.ts): the step ends, and the item asks with the platform's note.
				if (result?.failure?.reason === SANDBOX_ESCAPE_REFUSED && active.item) active.item.escaped = result.failure.message;
			} else if (result?.acp?.stepLimit !== undefined && !result.aborted && !signal.aborted) {
				// The platform stopped the turn at its step limit (platform-steps.ts), as Windlass stops at its own.
				outcome = "unresolved";
				stepLimit = result.acp.stepLimit;
				note(c, turn, "warn", stepLimitNote(harnessName(meta.harness), stepLimit));
			} else if (reason === "cancelled" || result?.aborted || signal.aborted) outcome = "stopped";
			// Checks the platform ran still failed, or could not start: the turn ends as Windlass's does then.
			else if (reason === "end_turn") outcome = result?.acp?.checks === "unresolved" ? "unresolved" : "succeeded";
			else if (reason === "max_tokens" || reason === "max_turn_requests") outcome = "unresolved";
			else if (reason === "refusal") outcome = "failed";
			else { outcome = "error"; message = `${harnessName(meta.harness)} ended without a recognized stop reason.`; }
		} else if (result?.aborted || (!result && signal.aborted)) {
			outcome = "interrupted";
		} else if (result) {
			const failure = result.failure ?? null;
			// Windlass's own sentence about it; the layer may hand it over without a capital.
			const said = failure ? str(failure.message).trim().replace(/^[a-z]/, (letter) => letter.toUpperCase()) : "";
			const reported = summary?.outcome as TurnOutcome | undefined;
			if (failure?.reason === "auth_required") {
				// No sign-in, one that could not be refreshed, or an access token the provider rejected: the remedy is the same.
				outcome = "error";
				message = `ChatGPT did not accept the saved sign-in. ${SIGN_IN_REMEDY}`;
				// The next prompt asks the sandbox layer about the sign-in instead of trusting an earlier answer.
				c.vars.signedInUntil = 0;
			} else if (failure?.reason === "session_not_found") {
				outcome = "error";
				meta.windlassSessionId = null;
				message = `${said || "Windlass no longer has the session this agent was working in."}\nThe next prompt starts a new Windlass session; the files in the workspace are still there.`;
			} else if (failure?.reason === "host_tools_required") {
				outcome = "error";
				message = oldSandbox(meta.place.kind);
				if (active.item) active.item.refused = message;
			} else if (reported !== undefined && WINDLASS_OUTCOMES.includes(reported)) {
				// Windlass's own outcome stands. If the turn failed, its events in the timeline say how.
				outcome = reported;
				if (typeof summary?.stepLimit === "number") stepLimit = summary.stepLimit;
				// Unless the platform failed it: the turn's access token ran out and could not be replaced. Windlass's
				// events say that in words meant for whoever hands the token in; the sandbox layer's sentence is for the user.
				if (failure?.reason === "token_unavailable" && said) message = said;
			} else if (failure) {
				outcome = "error";
				const stderr = tail(result.stderrTail ?? "");
				message = said || failureMessage(result);
				if (said && stderr && !said.includes(stderr)) message = `${said}\n${stderr}`;
			} else {
				outcome = "error";
				message = failureMessage(result);
				if (result.exitCode === 2 && resumed && events === 0) {
					// Most likely Windlass no longer has the session we asked it to continue.
					meta.windlassSessionId = null;
					message += "\nThe next prompt starts a new Windlass session.";
				}
			}
		} else {
			outcome = reviewer && !active.item?.refused ? "interrupted" : "error";
			message = problem ?? "The turn could not be run.";
		}
		await writingLimits;
		const refusal = turnRefusal(outcome, result, lastStepRefusal);
		const limitReading = limitObservation(refusal, Date.now());
		if (limitReading) await observe(limitReading);
		else if (outcome === "succeeded") await observe({ kind: "success", at: Date.now(), startedAt });
		if (refusal) {
			// Windlass describes a handed-in token to its host. Use the sandbox layer's remedy for its owner.
			if (result?.failure?.reason === "auth_required" && message) {
				if (refusal.message.includes("WINDLASS_ACCESS_TOKEN_FILE")) refusal.message = message;
				else if (!refusal.message.includes(SIGN_IN_REMEDY)) refusal.message += ` ${SIGN_IN_REMEDY}`;
			}
			const redactor = active.secrets?.redactor;
			const safe = redactor?.deep(refusal) ?? refusal;
			message = refusalMessage(safe);
			if (active.item) {
				const { text, fetchBase } = active.item.row;
				active.item.providerRefusal = { ...safe, accountKey: generation === null ? undefined : windlassAccountKey(generation), placeName: meta.place.kind === "hosted" ? "hosted" : meta.machineName ?? undefined, retry: { text: redactor?.text(text) ?? text, fetchBase, ...(active.item.row.untrusted.length && { untrusted: active.item.row.untrusted }) } };
			} else if (safe.kind === "invalid_request" || safe.kind.startsWith("model_")) {
				message += " You can change the model or reasoning effort with your next prompt.";
			}
		}
		if (result?.windlassSessionId && (result.acp || outcome !== "error")) meta.windlassSessionId = result.windlassSessionId;

		// The turn may have changed the workspace: a new copy, taken before the turn is reported as ended so
		// that whoever asks then gets it. Without one (the actor is stopping, or git failed) the old copy is
		// wrong, and the next read goes to the sandbox.
		if (used) {
			// Windlass's session is copied out of the sandbox meanwhile, when Windlass ran: both only read.
			const saving = caps.backups && result && layer ? saveBackup(c, meta, turn, used, layer) : undefined;
			const copied = reviewer || c.vars.stopping || c.vars.destroying ? null : await copyWorkspace(c, meta, used);
			if (!copied) await dropWorkspace(c);
			await saving;
		}

		// What the session's work rests on now, from what Windlass recorded of this turn's checks; a turn the platform could not run failed before any.
		const saved = reviewer ? [] : active.secrets?.checks ?? [];
		let verified = caps.checks === "none" ? null : active.checks.verified(turn, saved, result?.checks, meta.verified ?? null);
		if (outcome === "error" && verified?.state === "stopped") verified = { ...verified, state: "failed" };
		meta.verified = verified;

		// Report the resumed segment before publishing turn.ended. A warm sandbox still needs a hold for its idle time.
		if (active.resume && used && !reviewer && meta.sandbox === "running" && meta.meter && !active.outOfTime) {
			const answer = await metered(c, () => takeHold(c, meta, false));
			if (answer && !answer.ok && answer.reason === "allowance") active.outOfTime = true;
		}

		c.vars.pending = [];
		append(c, {
			turn,
			kind: "turn.ended",
			outcome,
			exitCode: result?.exitCode ?? null,
			steps: typeof summary?.steps === "number" ? summary.steps : typeof result?.acp?.steps === "number" ? result.acp.steps : null,
			// A turn that was paused ran in segments: their running time, without the pauses.
			durationMs: run && run.resumes > 0 ? run.activeMs + (Date.now() - run.segmentAt) : typeof summary?.durationMs === "number" ? summary.durationMs : Date.now() - startedAt,
			usage,
			...(caps.usage === "context" ? { context: result?.acp?.usage ?? null } : {}),
			...(caps.events === "acp" && meta.windlassSessionId ? { sessionId: meta.windlassSessionId } : {}),
			cachedShare: typeof summary?.cachedShare === "number" ? summary.cachedShare : null,
			message,
			verified,
		});
		if (reviewer && layer && meta.sandboxId) {
			try {
				if (active.item && (critic || active.item.withdrawn || active.item.refused || meta.review?.id === active.item.row.key)) {
					await removeSandbox(c, meta, meta.sandboxId, "Removed the reviewer’s checkout at the end of its turn.");
				} else if (meta.sandbox === "running") {
					await layer.sandboxes.suspend(meta.sandboxId);
					noteSandbox(c, meta, "paused");
					await closeMeter(c, meta, "now", useOf(meta));
				}
			} catch (error) {
				c.log.warn({ msg: "could not close the reviewer sandbox; item cleanup or idle accounting will retry", error: describeError(error) });
			}
		}
		meta.status = "idle";
		meta.lastOutcome = outcome;
		meta.updatedAt = Date.now();
		meta.lastUsedAt = meta.updatedAt;
		meta.turnStartedAt = null;
		meta.run = null;
		// In the step that lets the next prompt in: what this turn leaves to settle is the hold it has now.
		meterUse = useOf(meta);
		c.vars.closingItem = active.item?.row.key;
		c.vars.turn = null;
		publish(c);
		if (outcome === "error") await refreshSandbox(c, meta);
		// Asked now, while the sandbox still runs: the side panel then knows whether GitHub lacks anything
		// without starting a sandbox that has been paused since.
		const unpushed = !reviewer && meta.repo && used ? await unpushedWork(c, meta, meta.repo, c.vars.workspace?.files ?? null).catch(() => null) : null;
		// The agent had the platform publish in this turn, before the turn's checks ran, and nothing changed since: the pull request's description is told what they came to.
		if (active.published && unpushed === false && used) await describeAfterTurn(c, meta, used, turn);
		if (active.item) await itemTurnEnded(c, meta, active.item, { outcome, stepLimit, verified, used, unpushed, usage, checks: active.secrets?.checks ?? [], acp: result?.acp });
		await persist(c);
		await within(c.vars.reporting, REPORT_WAIT_MS);
	} catch (error) {
		// Whatever went wrong while closing the turn, the session must not stay "running".
		c.log.error({ msg: "could not close the turn cleanly", error: describeError(error) });
		meta.status = "idle";
		meta.lastUsedAt = Date.now();
		meta.turnStartedAt = null;
		meta.run = null;
		if (c.vars.turn === active) meterUse = useOf(meta);
		c.vars.turn = null;
		c.vars.pending = [];
		publish(c);
		await persist(c);
	}
	delete c.vars.closingItem;
	// Given back before what follows the turn for its time: a sandbox out of time is suspended there.
	release();
	await meterAfterTurn(c, meta, active, meterUse);
	// The idle times count from here.
	await armIdle(c, meta);
}

/**
 * Writes what a turn's checks came to into the description of the session's pull request, for a
 * turn in which the platform published for the agent: what went out then had not been checked,
 * and said so. Only where the workspace holds nothing GitHub lacks, so that what is said is said
 * of what the pull request shows. Never throws.
 */
async function describeAfterTurn(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle, turn: number): Promise<void> {
	const app = githubApp();
	const { repo, pull } = meta;
	if (!app || !repo || !pull) return;
	try {
		const described = await describePull({ app, connection: await githubConnection(c, meta), repository: repo, sandbox, pull, evidence: await evidenceOf(c, meta, null) });
		if (described === null || meta.pull !== pull) return;
		meta.pull = described;
		note(c, turn, "info", `The description of pull request #${described.number} now says what this turn's checks came to: ${described.verified}.`);
		publish(c);
	} catch (error) {
		c.log.warn({ msg: "could not write what the turn's checks came to into the pull request", session: meta.sessionId, error: describeError(error) });
	}
}

/** Waits for `promise`, but no longer than `ms`. Never rejects. */
async function within(promise: Promise<unknown> | null, ms: number): Promise<void> {
	if (!promise) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise.catch(() => undefined),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		}),
	]);
	clearTimeout(timer);
}

/**
 * On wake, a machine turn whose server stopped while it ran: with its conversation and checkpoint in
 * storage (runner/journal.ts), the runner may still have its process, within its grace. The process is
 * held before anything can ask for the runner's socket, and the turn runs again from `executeTurn`
 * with the checkpoint, which takes the process up instead of starting one. False when there is nothing
 * to take up; what was stored is then forgotten, and the turn is cut short as always.
 */
async function takeUpTurn(c: Ctx, meta: SessionMeta): Promise<boolean> {
	if (meta.place.kind !== "machine") return false;
	try {
		const [conversation, saved] = durableTurns(c) ? await Promise.all([readConversation(c.db), readCheckpoint<TurnCheckpoint>(c.db)]) : [null, null];
		if (!conversation || !saved || saved.turn !== meta.turns || saved.data.harness !== (meta.harness ?? "windlass") || c.vars.runner) {
			await forgetConversation(c.db);
			return false;
		}
		c.vars.restored = conversation;
		const link = runnerLink(c, meta.place.machineId);
		if (!link.hold(saved.data.process)) {
			link.close();
			c.vars.runner = null;
			await forgetConversation(c.db);
			return false;
		}
		const row = await rowOfTurn(c.db, meta.turns);
		const run = row ? Number(row.key.split(":")[1]) : null;
		const active: ActiveTurn = {
			number: meta.turns, effort: null, controller: new AbortController(), done: Promise.resolve(), control: null, question: null, unsettled: new Set(), aside: [], recalled: new Map(), stopping: false, closed: false, secrets: null, checks: new VerificationLog(), publishes: new Set(),
			reattach: saved.data,
			...(row && { item: { row: { ...row, slot: row.slot ?? "" }, report: meta.report && meta.report.run === run ? meta.report : null, full: null, started: true, pushedAtStart: meta.pushedHead ?? null } }),
		};
		c.vars.turn = active;
		console.log(`[wlp] turn.take_up session=${meta.sessionId} turn=${meta.turns} machine=${meta.place.machineId}: the server stopped while the turn ran; taking its process up again`);
		active.done = c.keepAwake(runTurn(c, meta, active, "", takeSandbox(c)).finally(() => {
			// A process the turn never took up (it could not go on) is stopped on the runner.
			c.vars.runner?.release();
		}));
		return true;
	} catch (error) {
		c.log.warn({ msg: "could not take up the machine turn after the restart; it is cut short", error: describeError(error) });
		return false;
	}
}

/** Whether going to sleep keeps the running turn for the next server: a machine turn that can be taken up, on a runner that keeps it through the grace. */
function keepsTurn(c: Ctx): boolean {
	const link = c.vars.runner;
	return !!link?.durable && link.known?.report?.resumableConversation === true && !!c.vars.turn?.checkpoint?.();
}

/**
 * `onSleep` for a turn the runner keeps (`keepsTurn`): nothing is stopped. The timeline, the count of
 * what was received and the checkpoint are stored, the frames being written ahead with them, and the
 * socket is let go without ending the conversation; the runner keeps the process through its grace,
 * and a wake shortly after takes it up on whichever server is up. False when the turn is not one to keep.
 */
async function keepTurn(c: Ctx): Promise<boolean> {
	if (!keepsTurn(c)) return false;
	const link = c.vars.runner!;
	await persist(c);
	await c.vars.journal?.settle();
	await c.schedule.at(Date.now() + 3_000, "internalTakeUp").catch(() => undefined);
	c.vars.journal?.close();
	link.abandon();
	console.log(`[wlp] turn.kept session=${c.key[1]} turn=${c.vars.turn?.number}: the runner keeps the turn's process through the restart`);
	return true;
}

// ---------------------------------------------------------------------------------------------
// Pause and resume (WLP_TURN_RESUME, turn-resume.ts)
// ---------------------------------------------------------------------------------------------

/** How often a turn that waits for its machine looks whether it is back, besides the wake the machine itself sends. */
const MACHINE_RECHECK_MS = 5 * 60_000;
/** How soon a resume that could not happen (the user's actor or the layer did not answer) is tried again. */
const RESUME_RETRY_MS = 60_000;
/** The most messages held for a paused turn. */
const MAX_HELD = 20;

/** Whether this session's turns pause and resume instead of being cut short. */
function resumesTurns(meta: SessionMeta): boolean {
	return config.turnResume.enabled && !meta.environmentBuild;
}

function newRun(meta: SessionMeta, turn: number, effort: string | null, planMode: boolean, now: number, fromSeq: number): TurnRun | null {
	if (!resumesTurns(meta)) return null;
	return { turn, effort, ...(planMode && { planMode: true }), activeMs: 0, segmentAt: now, fromSeq, usage: null, resumes: 0, crashes: 0 };
}

/**
 * While a turn runs, a wake is kept scheduled ahead of it (WLP_TURN_HEARTBEAT_MS): a server that crashed runs no
 * `onSleep`, and this brings the session back on whichever server is up, where `onWake` pauses the turn and resumes it.
 * A wake that finds the turn running does nothing.
 */
function heartbeat(c: Ctx, on: boolean): void {
	if (c.vars.heartbeat) clearInterval(c.vars.heartbeat);
	c.vars.heartbeat = null;
	if (!on) return;
	const arm = () => {
		try {
			if (c.vars.stopping) return;
			void c.schedule.at(Date.now() + config.turnResume.heartbeatMs, "internalResumeTurn").catch((error: unknown) => c.log.warn({ msg: "could not schedule the wake that resumes the turn after a crash", error: describeError(error) }));
		} catch {
			// The actor is going away: its turn pauses in `onSleep`, or its next wake finds it.
		}
	};
	arm();
	c.vars.heartbeat = setInterval(arm, Math.max(1_000, Math.floor(config.turnResume.heartbeatMs / 2)));
}

/** A turn the server stops from under it pauses instead of ending, unless its person or the platform was already stopping it. */
function markPausing(c: Ctx, meta: SessionMeta): void {
	const active = c.vars.turn;
	if (!active || !resumesTurns(meta) || meta.run?.turn !== active.number || active.stopping || active.closed || c.vars.destroying || active.item?.withdrawn) return;
	active.pausing ??= "restart";
}

/**
 * The turn stops running but does not end: the same turn number, no `turn.ended`, nothing to the item (it sees a turn
 * that still runs). What it ran and used so far is kept with the turn's record, and a wake is scheduled: a server that is
 * up then resumes it. A machine's turn waits for the machine (`machinePaused`).
 */
async function pauseTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn, reason: PauseReason, usage: TurnUsage | null, result: RunTurnResult | null): Promise<void> {
	const run = meta.run!;
	const turn = active.number;
	const now = Date.now();
	heartbeat(c, false);
	run.activeMs += Math.max(0, now - run.segmentAt);
	run.usage = addUsage(run.usage, usage);
	run.paused = { reason, at: now };
	if (result?.windlassSessionId) meta.windlassSessionId = result.windlassSessionId;
	// What the turn wrote to Windlass's session was not copied out of the sandbox: the copy is behind it.
	if (meta.backup) meta.memoryTurn = turn;
	note(c, turn, "info", pausedLine(reason, meta.machineName), { code: "turn_paused" });
	c.vars.pending = [];
	meta.status = "paused";
	meta.lastUsedAt = now;
	meta.updatedAt = now;
	c.vars.turn = null;
	publish(c);
	console.log(`[wlp] turn.paused session=${meta.sessionId} turn=${turn} reason=${reason} active_ms=${run.activeMs}`);
	if (reason === "machine") await machinePaused(c, meta, run);
	await persist(c);
	if (reason === "restart") await c.schedule.at(now + config.turnResume.delayMs, "internalResumeTurn").catch((error: unknown) => c.log.warn({ msg: "could not schedule the wake that resumes the turn", error: describeError(error) }));
}

/**
 * A turn paused because its machine went away: an item's turn slot goes back to the queue (other items run meanwhile)
 * and the item is told it waits, with no failure and no question; the machine is told to wake the session when its
 * runner is back; and the session looks by itself now and then, in case that wake is lost. After
 * WLP_MACHINE_AWAY_ASK_MS the item asks its person once (`internalMachineAsk`).
 */
async function machinePaused(c: Ctx, meta: SessionMeta, run: TurnRun): Promise<void> {
	const paused = run.paused;
	if (!paused || meta.place.kind !== "machine") return;
	const row = await rowOfTurn(c.db, run.turn);
	if (row && !paused.told) {
		const slot = paused.slotFreed ? null : row.slot;
		await serial(c, () => c.db.transaction(async (tx) => {
			if (slot) {
				await tx.execute("UPDATE inbox SET slot = NULL WHERE key = ? AND state = 'started'", row.key);
				await queueMessage(tx, { to: "user", done: { slot, key: row.key } });
			}
			await queueMessage(tx, { to: "item", itemId: row.itemId, fact: { kind: "turn_paused", at: Date.now(), key: row.key, since: paused.at, machine: meta.machineName } });
		}, { name: "inbox.paused" }));
		paused.slotFreed = true;
		paused.told = true;
		await flushOutbox(c, meta.uid);
		await c.schedule.at(paused.at + config.turnResume.machineAskMs, "internalMachineAsk").catch(() => undefined);
	}
	await machineActor(() => c.client(), meta.uid, meta.place.machineId).pausedSession(meta.sessionId, true).catch((error: unknown) => c.log.warn({ msg: "could not ask the machine to wake this session when it is back", error: describeError(error) }));
	// One look at a time: every wake of the session (an item's check of its turn, the machine's) would otherwise add one.
	const now = Date.now();
	if ((paused.lookAt ?? 0) <= now) {
		paused.lookAt = now + MACHINE_RECHECK_MS;
		await c.schedule.at(paused.lookAt, "internalResumeTurn").catch(() => undefined);
	}
}

/** The words of the turn that is resumed: its own prompt when the agent never had it, with what was held for it. */
async function resumeText(c: Ctx, meta: SessionMeta, run: TurnRun, row: InboxRow | null, reason: PauseReason, held: string[], stoppedCommand: boolean): Promise<string> {
	if (run.prompted) return resumePrompt(reason, held, stoppedCommand);
	if (row) return row.text;
	const [first] = await c.db.execute<{ item: string }>("SELECT item FROM timeline WHERE turn = ? AND kind = 'user' ORDER BY seq LIMIT 1", run.turn);
	const item = first ? (JSON.parse(first.item) as TimelineItem) : null;
	const prompt = item?.kind === "user" ? item.text : "";
	return held.length ? `${prompt}\n\n${held.join("\n\n")}` : prompt;
}

/**
 * The whole task of a resumed turn whose agent no longer has its conversation of it: an item's comes with its delivery
 * (`itemTurnText`, or the step's own text when the delivery carries none); a person's session's is rebuilt from the
 * timeline (`sessionWholeTask`).
 */
async function wholeTask(c: Ctx, meta: SessionMeta, active: ActiveTurn, turn: number): Promise<{ text: string; untrusted: string[]; unsandboxed?: boolean }> {
	const item = active.item;
	if (item) {
		const chosen = itemTurnText(item.row, item.row.text, null);
		if (chosen.fresh) return chosen;
		return { text: `Your earlier conversation of this step is gone, and so is any work that was not saved in the workspace. Check what the workspace holds now, then do the step from the start:\n\n${itemPrompt(item.row)}`, untrusted: item.row.untrusted, unsandboxed: item.row.unsandboxed };
	}
	await serial(c, () => writeItems(c)).catch(() => undefined);
	const rows = await c.db.execute<{ item: string }>(
		"SELECT item FROM timeline WHERE turn <= ? AND (kind IN ('user', 'turn.ended') OR (kind = 'windlass' AND json_extract(item, '$.event.type') IN ('text.ended', 'workspace.changes')) OR (kind = 'acp' AND json_extract(item, '$.update.sessionUpdate') = 'agent_message_chunk')) ORDER BY seq",
		turn,
	);
	const timeline = rows.map((row) => JSON.parse(row.item) as TimelineItem);
	return sessionWholeTask(timeline, turn, active.resume?.held ?? []);
}

/**
 * Runs a paused turn again, as a new segment of the same turn, once the place can be had: on wake, on its scheduled
 * wake, when its machine is back, or with the turn slot granted again (`granted`) to an item's turn that gave its slot
 * back. True when it was resumed (a granted slot is then its). Never throws.
 */
async function resumePaused(c: Ctx, meta: SessionMeta, granted: string | null = null): Promise<boolean> {
	const run = meta.run;
	if (!run?.paused || meta.status !== "paused" || c.vars.turn || c.vars.accepting || c.vars.resuming || c.vars.stopping || c.vars.destroying || c.vars.publishing) return false;
	// A graceful pause resumes WLP_TURN_RESUME_DELAY_MS after it at the earliest (whichever server is up then): its wake comes then.
	if (run.paused.reason === "restart" && Date.now() < run.paused.at + config.turnResume.delayMs) {
		await c.schedule.at(run.paused.at + config.turnResume.delayMs, "internalResumeTurn").catch(() => undefined);
		return false;
	}
	c.vars.resuming = true;
	let release: (() => void) | null = takeSandbox(c);
	try {
		if (c.vars.idling) await c.vars.idling.catch(() => undefined);
		const row = await rowOfTurn(c.db, run.turn);
		if (meta.place.kind === "machine") {
			const facts = await runnerLink(c, meta.place.machineId).facts().catch(() => null);
			if (meta.run !== run || !run.paused) return false;
			if (facts?.status === "removed") {
				await endPausedTurn(c, meta, "stopped", "This agent's machine was removed while the turn was paused, so the turn ended. Its files were there.");
				return false;
			}
			if (facts?.status !== "online") {
				// A turn paused for a restart whose machine is away meanwhile waits for the machine.
				if (run.paused.reason === "restart") {
					run.paused.reason = "machine";
					note(c, run.turn, "info", pausedLine("machine", meta.machineName), { code: "turn_paused" });
					publish(c);
				}
				await machinePaused(c, meta, run);
				await persist(c);
				return false;
			}
		}
		let slot = row?.slot ?? null;
		if (row && run.paused.slotFreed) {
			// Asked for again, ahead of the turns that came since: the grant comes back here (`takeDelivered`).
			if (granted === null) {
				const answer = await requestTurn(c, meta.uid, row, null, meta.turnStartedAt ?? run.paused.at);
				if (!answer.granted) return false;
				granted = answer.slot;
			}
			slot = granted;
		}
		if (hostedLimitsApply(meta.place)) {
			// A scheduled resume may beat the wake's inspection, or come long after it. Settle a VM that
			// actually paused at its provider timestamp before taking the new hold. A warm VM counts through the gap.
			const runningAt = await refreshSandbox(c, meta, true);
			await holdSandbox(c, meta, true, runningAt);
		}
		// Nothing awaited from here: the turn is taken up again in this step.
		const paused = run.paused;
		if (meta.run !== run || !paused || meta.status !== "paused" || c.vars.turn || c.vars.destroying) return false;
		const now = Date.now();
		const pausedMs = Math.max(0, now - paused.at);
		const held = run.held ?? [];
		const stoppedCommand = run.stoppedCommand === true;
		delete run.stoppedCommand;
		run.resumes += 1;
		run.fromSeq = c.vars.nextSeq;
		run.segmentAt = now;
		run.paused = null;
		run.held = [];
		meta.status = "starting";
		meta.updatedAt = now;
		note(c, run.turn, "info", resumedLine(paused.reason, pausedMs, duration), { code: "turn_resumed" });
		const key = row ? Number(row.key.split(":")[1]) : null;
		const active: ActiveTurn = {
			number: run.turn, effort: run.effort, ...(run.planMode && { planMode: true }), controller: new AbortController(), done: Promise.resolve(), control: null, question: null, unsettled: new Set(), aside: [], recalled: new Map(), stopping: false, closed: false, secrets: null, checks: new VerificationLog(), publishes: new Set(),
			resume: { reason: paused.reason, pausedMs, held },
			...(row && { item: { row: { ...row, slot: slot ?? "" }, report: meta.report && meta.report.run === key ? meta.report : null, full: null, started: true, pushedAtStart: meta.pushedHead ?? null } }),
		};
		c.vars.turn = active;
		publish(c);
		if (row && slot !== row.slot) await serial(c, () => c.db.execute("UPDATE inbox SET slot = ? WHERE key = ? AND state = 'started'", slot, row.key));
		if (row && paused.told) await serial(c, () => queueMessage(c.db, { to: "item", itemId: row.itemId, fact: { kind: "turn_resumed", at: now, key: row.key, offlineMs: pausedMs } }));
		// The wake after a crash, before anything of the segment runs: one that crashes at once is found again too (the loop guard counts it).
		await c.schedule.at(now + config.turnResume.heartbeatMs, "internalResumeTurn").catch(() => undefined);
		await persist(c);
		// Said once what was resumed is stored: a crash before this leaves the turn paused, as it was.
		console.log(`[wlp] turn.resumed session=${meta.sessionId} turn=${run.turn} reason=${paused.reason} paused_ms=${pausedMs} resumes=${run.resumes} prompted=${run.prompted === true}`);
		if (row && paused.told) await flushOutbox(c, meta.uid);
		if (paused.reason === "machine" && meta.place.kind === "machine") void machineActor(() => c.client(), meta.uid, meta.place.machineId).pausedSession(meta.sessionId, false).catch(() => undefined);
		const text = await resumeText(c, meta, run, row, paused.reason, held, stoppedCommand);
		active.done = c.keepAwake(runTurn(c, meta, active, text, release));
		release = null;
		return true;
	} catch (error) {
		c.log.warn({ msg: "could not resume the paused turn", session: meta.sessionId, error: describeError(error) });
		if (error instanceof UserError && ["allowance_used", "too_many_sandboxes"].includes(String(error.code))) {
			await endPausedTurn(c, meta, "interrupted", `This turn could not resume: ${error.message}`);
		} else if (!c.vars.stopping && !c.vars.destroying && meta.run?.paused && (meta.run.paused.lookAt ?? 0) <= Date.now()) {
			meta.run.paused.lookAt = Date.now() + RESUME_RETRY_MS;
			await c.schedule.at(meta.run.paused.lookAt, "internalResumeTurn").catch(() => undefined);
		}
		return false;
	} finally {
		c.vars.resuming = false;
		release?.();
	}
}

/**
 * Ends a turn that is paused, with nothing running: its person stopped it, its item withdrew it, its machine was removed,
 * or it could not be resumed. The turn ends as any does: a `turn.ended`, and the item's fact.
 */
async function endPausedTurn(c: Ctx, meta: SessionMeta, outcome: "stopped" | "interrupted", message: string | null): Promise<void> {
	const run = meta.run;
	const turn = run?.turn ?? meta.turns;
	const now = Date.now();
	const usage = run?.usage ?? null;
	const machine = run?.paused?.reason === "machine";
	heartbeat(c, false);
	if (message) note(c, turn, outcome === "stopped" ? "info" : "warn", message);
	append(c, { turn, kind: "turn.ended", outcome, exitCode: null, steps: null, durationMs: run?.activeMs ?? 0, usage, cachedShare: null, message: null, verified: meta.verified ?? null });
	meta.status = "idle";
	meta.lastOutcome = outcome;
	meta.updatedAt = now;
	meta.lastUsedAt = now;
	meta.turnStartedAt = null;
	meta.run = null;
	publish(c);
	console.log(`[wlp] turn.paused_ended session=${meta.sessionId} turn=${turn} outcome=${outcome}`);
	const row = await rowOfTurn(c.db, turn);
	if (row) await finishItemTurn(c, meta, row, meta.origin?.role === "reviewer" ? reviewEndedFactOf(row.key, outcome, meta.review, null, null, usage) : endedFactOf(row.key, now, outcome, meta.verified ?? null, [], true, null, usage));
	else await persist(c);
	if (machine && meta.place.kind === "machine") void machineActor(() => c.client(), meta.uid, meta.place.machineId).pausedSession(meta.sessionId, false).catch(() => undefined);
	await armIdle(c, meta);
}

/**
 * On wake, a turn whose server crashed under it (no `onSleep` ran): it is paused as one that was stopped would have
 * been, from what the timeline kept of it. False instead when the loop guard trips: the server stopped more than
 * CRASHES_ALLOWED times in a row while resuming it, with nothing done in between; the caller then cuts it short, and
 * that counts as one of the item's cut-offs.
 */
async function crashPause(c: Ctx, meta: SessionMeta): Promise<boolean> {
	const run = meta.run!;
	const turn = run.turn;
	const rows = await c.db.execute<{ kind: string; at: number; item: string }>("SELECT kind, at, item FROM timeline WHERE turn = ? AND seq >= ? ORDER BY seq", turn, run.fromSeq);
	const events: WindlassEvent[] = [];
	let progressed = false;
	for (const row of rows) {
		if (row.kind === "acp") progressed = true;
		if (row.kind !== "windlass") continue;
		const item = JSON.parse(row.item) as TimelineItem;
		if (item.kind !== "windlass") continue;
		events.push(item.event);
		if (item.event.type === "text.ended" || reportedModelUsage(item.event) !== null) progressed = true;
	}
	const lastAt = rows.length ? rows[rows.length - 1].at : run.segmentAt;
	run.activeMs += Math.max(0, lastAt - run.segmentAt);
	run.usage = addUsage(run.usage, cutTurnUsage(events));
	run.crashes = crashCount(run.crashes, progressed);
	console.log(`[wlp] turn.crashed session=${meta.sessionId} turn=${turn} crashes=${run.crashes} progressed=${progressed}`);
	if (run.crashes > CRASHES_ALLOWED) return false;
	run.paused = { reason: "restart", at: Math.max(lastAt, run.segmentAt) };
	if (meta.backup) meta.memoryTurn = turn;
	note(c, turn, "info", "The server stopped while this turn was running; it will resume by itself.", { code: "turn_paused" });
	meta.status = "paused";
	meta.updatedAt = Date.now();
	return true;
}

/** A message for a paused turn: kept with the turn, shown as held, and given to the agent when the turn resumes. */
async function holdMessage(c: Ctx, meta: SessionMeta, input: PromptInput, text: string, submission: Submission | null): Promise<PromptAnswer> {
	const redactor = await sessionRedactor(c, meta).catch(() => NO_REDACTION);
	const run = meta.run;
	// It resumed, or ended, while the secrets were read: the message goes as it would have then.
	if (meta.status !== "paused" || !run?.paused || c.vars.turn) return takePrompt(c, meta, input, text, submission);
	if ((run.held?.length ?? 0) >= MAX_HELD) throw new UserError(`${MAX_HELD} messages are held for this turn already; it takes more once it has resumed.`, { code: "steer_unavailable" });
	const shown = redactor.text(text);
	run.held = [...(run.held ?? []), shown];
	append(c, { turn: run.turn, kind: "user", text: shown, model: meta.model, effort: run.effort, steer: true, held: true });
	meta.updatedAt = Date.now();
	publish(c);
	const answer = remember(meta, submission, { turn: run.turn, steered: true });
	await persist(c);
	return answer;
}

/** Stops the turn in progress, if any, and waits (a bounded time) until it has closed itself. */
async function stopTurn(c: Ctx): Promise<void> {
	const turn = c.vars.turn;
	if (!turn) return;
	if (c.vars.meta) abortTurn(c, c.vars.meta, turn);
	else turn.controller.abort();
	await persist(c);
	await within(turn.done, STOP_WAIT_MS);
}

/** What a key belongs to in a session, in the words of a refusal (submissions.ts). */
const KEYED = "message to this agent";

/**
 * Keeps the key a message was taken with, and what its prompt is answered, in the same synchronous
 * step that took the message: from here a prompt with that key is this message again. Stored with the
 * session's next write, which the caller sees to.
 */
function remember(meta: SessionMeta, submission: Submission | null, answer: PromptAnswer): PromptAnswer {
	if (submission) meta.submissions = [...(meta.submissions ?? []), { ...submission, ...answer }].slice(-MAX_REMEMBERED_SUBMISSIONS);
	return answer;
}

/** Serialize ACP prompt admissions so two refused steers cannot both start the same next turn. */
function queuePrompt(c: Ctx, meta: SessionMeta, input: PromptInput, message: string, submission: Submission | null): Promise<PromptAnswer> {
	const previous = c.vars.nextPrompt;
	const start = async () => {
		while (c.vars.turn) await c.vars.turn.done;
		return startPrompt(c, meta, input, message, submission);
	};
	const queued = previous ? previous.then(start, start) : start();
	c.vars.nextPrompt = queued;
	return queued.finally(() => { if (c.vars.nextPrompt === queued) delete c.vars.nextPrompt; });
}

/**
 * Whether the session's machine is out of reach now: a session on a machine whose runner has no socket
 * to it. What the turn's layer sends then waits in the link's queue until the runner is back, so an
 * action that would wait on it (a steer, a stop of one call) is refused at once instead of at its
 * time limit, after which the message would still arrive, and arrive twice if it was sent again.
 */
function machineAway(c: Ctx, meta: SessionMeta): boolean {
	return meta.place.kind === "machine" && c.vars.runner?.channel.connected !== true;
}

/**
 * `prompt()` while a turn is in progress: the message goes into that turn. It takes no new turn, no
 * running slot and no title, and it is stored only once Windlass has admitted it.
 */
async function steerTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn | null, message: string, submission: Submission | null): Promise<PromptAnswer> {
	if (usesPlatformModel(meta.place, meta.harness)) {
		const wait = await userActor(c, meta.uid).internalDailyTokenWait();
		if (wait) throw new UserError(wait, { code: "daily_token_cap" });
	}
	const control = active?.control;
	const next = (turn: number) => {
		note(c, turn, "info", "Sent when this turn ends.");
		return queuePrompt(c, meta, { text: message }, message, submission);
	};
	if (active?.closed && capabilitiesOf(meta.harness).events === "acp") return next(active.number);
	const stopping = meta.status === "stopping" || active?.controller.signal.aborted === true || active?.closed === true;
	if (!active || !control || stopping || (meta.status !== "running" && meta.status !== "waiting")) {
		const state = stopping ? "is being stopped" : "is still starting";
		throw new UserError(`The turn ${state} and cannot take a message right now. Try again in a moment.`, { code: "steer_unavailable" });
	}
	// Refused before anything is sent or kept: queued behind a dead link, the message would arrive whenever the machine is back.
	if (machineAway(c, meta)) throw new UserError("Your machine is not answering, so the message was not sent. Send it again when it is back.", { code: "steer_unavailable" });
	try {
		await control.steer(message);
	} catch (error) {
		if (error instanceof AcpPromptRequired) return next(active.number);
		c.log.warn({ msg: "a running turn did not take a steered message", session: meta.sessionId, turn: active.number, error: describeError(error) });
		const why = isSandboxUserError(error) ? ` ${error.message}` : "";
		throw new UserError(`The running turn could not take the message.${why} Try again in a moment.`, { code: "steer_unavailable" });
	}
	if (active.closed && capabilitiesOf(meta.harness).events !== "acp") {
		// The turn ended while Windlass was taking the message; nothing can be added to a closed turn.
		throw new UserError("The turn ended just as the message arrived. Try again in a moment.", { code: "steer_unavailable" });
	}
	const shown = active.secrets?.redactor.text(message) ?? message;
	append(c, { turn: active.number, kind: "user", text: shown, model: meta.model, effort: active.effort, steer: true });
	meta.updatedAt = Date.now();
	publish(c);
	const answer = remember(meta, submission, { turn: active.number, steered: true });
	// A key is stored with its message, not when the turn next writes the session: a server that stops in between must not forget it.
	if (submission) void persist(c);
	return answer;
}

/**
 * Takes a prompt whose text was checked: into the turn in progress, or as a new turn, which it starts.
 * It waits on the user's actor and on the sandbox layer before the message is taken, and other calls
 * run meanwhile; the message is taken, and its key kept (`remember`), in one synchronous step at the
 * end, or the prompt is refused and nothing of it is kept.
 */
async function takePrompt(c: Ctx, meta: SessionMeta, input: PromptInput, text: string, submission: Submission | null): Promise<PromptAnswer> {
	// A paused turn takes no new turn: the message is held, and given to the agent when the turn resumes.
	if (meta.status === "paused" && meta.run?.paused && !c.vars.turn) return holdMessage(c, meta, input, text, submission);
	// A turn in progress takes the message itself; `model` and `effort` are for a turn that starts.
	if (input.planMode !== undefined && (!capabilitiesOf(meta.harness).planMode || typeof input.planMode !== "boolean")) throw new UserError(`${harnessName(meta.harness)} has no plan mode.`, {code:"bad_input"});
	if ((c.vars.turn || c.vars.accepting) && capabilitiesOf(meta.harness).events === "acp" && (input.model || input.effort || input.planMode)) throw new UserError("Choose the model and effort when starting a turn.", { code: "bad_input" });
	if (c.vars.turn || c.vars.accepting) return await steerTurn(c, meta, c.vars.turn, text, submission);
	if (capabilitiesOf(meta.harness).events === "acp") return queuePrompt(c, meta, input, text, submission);
	return startPrompt(c, meta, input, text, submission);
}

async function startPrompt(c: Ctx, meta: SessionMeta, input: PromptInput, text: string, submission: Submission | null): Promise<PromptAnswer> {
	// The platform is committing and pushing the workspace: the agent does not start under it.
	if (c.vars.publishing) throw new UserError("The platform is pushing this agent's work to GitHub. Send the prompt again in a moment.", { code: "turn_running" });

	const effort = input.effort === undefined || input.effort === null || input.effort === "" ? null : input.effort;

	// Nothing was awaited since the check above, so this prompt is the only one past it.
	c.vars.accepting = true;
	// The sandbox is this prompt's from here, and its turn's to the end: no idle check takes it meanwhile.
	let release: (() => void) | null = takeSandbox(c);
	let claimed = false;
	/** The running slot's claim, by the name (a generation) the user's actor gave it; null where there is no lease (a machine's session). */
	let claimName: number | null = null;
	try {
		// A suspend or removal of the idle sandbox finishes first; the turn then resumes or recreates it.
		if (c.vars.idling) await c.vars.idling.catch(() => undefined);
		const caps = capabilitiesOf(meta.harness);
		let model = meta.model;
		const switches = input.model !== undefined && input.model !== null && input.model !== "";
		if (switches || effort !== null) {
			// Held against the user's own models, and the effort against the ones the turn's model accepts. The demo's scripted model has the stand-in.
			const models = caps.models === "harness" ? meta.harnessModels ?? initialHarnessModels() : meta.demo ? standInModels("demo") : await userActor(c, meta.uid).internalModels();
			try {
				if (switches) model = chosenModel(models, input.model);
				if (effort !== null) {
					// The adapter reports a new model's efforts only after selection.
					const checkOnSelection = caps.models === "harness" && (model !== meta.model ||
						(meta.turns === 0 && model !== models.defaultModel && !models.models.find(m => m.id === model)?.efforts.length));
					if (!checkOnSelection || typeof effort !== "string" || effort.length > 64) checkEffort(models, model, effort);
				}
			} catch (error) {
				if (error instanceof ModelProblem) throw new UserError(error.message, { code: error.code });
				throw error;
			}
		}

		// The owner can change egress between session creation and its first prompt.
		const facts = meta.place.kind === "machine" && (meta.repoUrl || caps.signIn === "machine")
			? await runnerLink(c, meta.place.machineId).facts() : null;
		if (meta.repoUrl && facts?.report?.egress === "none") throw new UserError(OFFLINE_REPOSITORY, { code: "bad_input" });
		// The operator can change WLP_E2B_NETWORK between a session's launch and its turn.
		if (meta.repoUrl && meta.place.kind === "hosted" && (await layerOf(c, meta)).sandboxes.egress?.() === "none") throw new UserError(HOSTED_OFFLINE_REPOSITORY, { code: "bad_input" });
		if (caps.signIn === "machine" && facts) {
			const offered = facts.report?.harnesses?.find(entry => entry.id === meta.harness);
			if (!offered) throw new UserError(`This machine does not offer ${harnessName(meta.harness)}.`, { code: "bad_input" });
			if (offered.id === "codex" && !codexModes(meta.profile, offered.modes ?? []).some(m => m.id === meta.mode))
				throw new UserError(offered.modeReason ?? innerModesReason, {code:"bad_input"});
			if (offered.signIn === "none") throw new UserError(machineLoginMessage(machineHarnesses[offered.id], facts.name), { code: "harness_signed_out" });
		} else if (!meta.demo && !meta.environmentBuild && Date.now() >= c.vars.signedInUntil) {
			const { logins } = await layerOf(c, meta);
			if (!(await logins.status(meta.uid))) {
				throw new UserError("Sign in with ChatGPT first: this agent needs your account to run.", { code: "chatgpt_required" });
			}
			c.vars.signedInUntil = Date.now() + SIGNED_IN_FRESH_MS;
		}

		// The user row and default title are published before the agent starts, for every agent. Scrub them with the same secrets as its output.
		const held = await readSecrets(c, meta, null).catch(error => {
			if (error instanceof TurnProblem) throw new UserError(error.message, { code: "secrets_unavailable" });
			throw error;
		});
		if (usesPlatformModel(meta.place, meta.harness)) {
			await settleTokenReceipts(c, meta.uid).catch(() => {
				throw new UserError("Your previous turn’s model usage could not be settled. Try again in a moment.", { code: "usage_unavailable" });
			});
		}
		const claim = await userActor(c, meta.uid).internalAcquireRun(meta.sessionId);
		if (!claim.known || c.vars.destroying) throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
		if (!claim.ok) {
			if (claim.dailyTokenWait) throw new UserError(claim.dailyTokenWait, { code: "daily_token_cap" });
			throw new UserError(`You already have ${claim.running === 1 ? "1 agent" : `${claim.running} agents`} working on this platform, the most it runs for you at once. Agents on your machines don't count. Wait for one to finish, or stop one.`, { code: "too_many_running" });
		}
		claimed = true;
		claimName = claim.claim;
		// Time for the sandbox to run on, and a place for one the session does not have: refused here, before anything is started.
		await holdSandbox(c, meta, true);
		if (c.vars.destroying) throw new UserError("That agent does not exist any more.", { code: "session_not_found" });

		const shown = held.redactor.text(text);
		// Accepted. From here to the return nothing is awaited.
		const turn = meta.turns + 1;
		const now = Date.now();
		if (meta.secretRequest) (meta.declinedSecrets ??= []).push(meta.secretRequest.name);
		delete meta.secretRequest;
		meta.turns = turn;
		meta.model = model;
		meta.status = "starting";
		delete meta.pauseNow;
		meta.updatedAt = now;
		meta.turnStartedAt = now;
		if (turn === 1 && !meta.titleIsTyped && !meta.origin) meta.title = titleFrom(shown);
		meta.run = newRun(meta, turn, effort, capabilitiesOf(meta.harness).planMode && input.planMode === true, now, c.vars.nextSeq);
		append(c, { turn, kind: "user", text: shown, model, effort });
		publish(c);

		const active: ActiveTurn = { number: turn, effort, controller: new AbortController(), done: Promise.resolve(), control: null, question: null, unsettled: new Set(), aside: [], recalled: new Map(), stopping: false, closed: false, planMode: capabilitiesOf(meta.harness).planMode && input.planMode === true, secrets: held, checks: new VerificationLog(), publishes: new Set() };
		c.vars.turn = active;
		// The turn's first step writes the session, and the key with it.
		const answer = remember(meta, submission, { turn, steered: false });
		active.done = c.keepAwake(runTurn(c, meta, active, text, release));
		release = null;
		return answer;
	} catch (error) {
		if (!c.vars.turn && meta.status !== "idle") {
			meta.status = "idle";
			meta.turnStartedAt = null;
		}
		if (claimed) {
			publish(c);
			// The place among the user's running sessions is handed back now (`internalReleaseRun`), by the claim's name, so that
			// a late one cannot free a newer claim. One that does not arrive while the user's actor is away leaves it
			// to the launch check, a minute after the claim.
			if (claimName !== null) {
				const released = userActor(c, meta.uid)
					.internalReleaseRun({ sessionId: meta.sessionId, claim: claimName, summary: summaryOf(meta) })
					.then(
						() => undefined,
						(failure: unknown) => c.log.warn({ msg: "could not give back the running slot", error: describeError(failure) }),
					);
				if (!c.vars.stopping) void c.keepAwake(released);
			}
		} else if (!(error instanceof UserError)) void report(c);
		throw clientError(c.log, error, "The prompt could not be started. Try again.");
	} finally {
		c.vars.accepting = false;
		release?.();
	}
}

// ---------------------------------------------------------------------------------------------
// A work item's turns (session-inbox.ts)
// ---------------------------------------------------------------------------------------------

/** Asks the user's turn queue for a slot for a waiting delivery, and takes the turn when it is granted at once. Never throws. */
async function askForSlot(c: Ctx, meta: SessionMeta, row: InboxRow, deploymentFull: number | null = null): Promise<void> {
	try {
		const answer = await requestTurn(c, meta.uid, row, deploymentFull);
		if (answer.granted) await takeDelivered(c, meta, row.key, answer.slot);
	} catch (error) {
		// The item asks again whether its turn runs; a delivery sent again asks again.
		c.log.warn({ msg: "could not ask the user's turn queue for a slot", key: row.key, error: describeError(error) });
	}
}

/** Gives a slot back to the queue, through the outbox. */
async function giveBack(c: Ctx, meta: SessionMeta, key: string, slot: string): Promise<void> {
	await serial(c, () => queueMessage(c.db, { to: "user", done: { slot, key } }));
	await flushOutbox(c, meta.uid);
}

/**
 * Takes the turn of a delivery the queue gave a slot to, as `takePrompt` takes a person's prompt: the
 * grant is the running slot, so none is asked for. The receipt is one transaction: the inbox row says
 * which turn took it and with which slot, with the session's meta and the turn's first item. A grant
 * that finds nothing to take, or a session busy with something else, gives its slot back; a turn that
 * cannot have its sandbox time gives it back and asks again, and waits with the queue's sentence.
 * Never throws.
 */
async function takeDelivered(c: Ctx, meta: SessionMeta, key: string, slot: string): Promise<void> {
	const row = await inboxRow(c.db, key);
	if (row?.state === "started" && row.slot === slot) return;
	// A turn paused while its machine was away, whose slot was given back: this grant is its slot again.
	if (row?.state === "started" && meta.run?.paused?.slotFreed && row.turn === meta.run.turn) {
		if (!(await resumePaused(c, meta, slot))) await giveBack(c, meta, key, slot);
		return;
	}
	// The same delivery sent again (a call that failed is sent again) while this session takes or runs it: the slot is that turn's, and stays.
	if (c.vars.delivering === key || c.vars.turn?.item?.row.key === key) return;
	if (row?.state !== "waiting" || c.vars.turn || c.vars.accepting || c.vars.publishing || c.vars.destroying) {
		await giveBack(c, meta, key, slot);
		return;
	}
	c.vars.accepting = true;
	c.vars.delivering = key;
	// The sandbox is this delivery's from here, and its turn's to the end, as for a person's prompt.
	let release: (() => void) | null = takeSandbox(c);
	try {
		if (c.vars.idling) await c.vars.idling.catch(() => undefined);
		// Confirm the session socket before recording a turn. An online control socket alone cannot run it.
		if (meta.place.kind === "machine") await runnerLink(c, meta.place.machineId).ready();
		if (meta.sandboxId && meta.cloned && typeof meta.setupDue === "string" && !meta.workDue?.setupBase && await childSetupSeed(c, meta)) {
			// An older server left setup pending on an unpinned child checkout. No agent has run there yet.
			await removeSandbox(c, meta, meta.sandboxId, "Recreating the subtask sandbox to run setup at the feature’s base commit.");
		}
		if (row.checkout) {
			const run = Number(row.key.split(":")[1]);
			if (meta.sandboxId && (meta.reviewRun !== run || meta.reviewBase !== row.checkout.baseSha)) {
				await removeSandbox(c, meta, meta.sandboxId, "Setting up a fresh checkout for the new review.");
			}
			meta.reviewRun = run;
			meta.reviewBase = row.checkout.baseSha;
		}
		const planning = row.agent === "planner" || row.agent === "summary";
		// The item's own effort (`CreateItemInput.effort`) for every turn of it; otherwise a planner's is high where its model offers it, a builder's the agent's default.
		const effort = meta.origin?.effort ?? (planning ? plannerEffort((await userActor(c, meta.uid).internalModels()).models, meta.model) : null);
		await holdSandbox(c, meta, true);
		if (c.vars.destroying) throw new UserError("That agent does not exist any more.", { code: "session_not_found" });
		// The row is claimed before anything of the turn is: a withdrawal that came while the sandbox was being had leaves no
		// waiting row to claim, and the slot goes back with nothing started. Nothing else takes a turn meanwhile (`accepting`).
		const turn = meta.turns + 1;
		const claimed = await c.db.execute<{ key: string }>("UPDATE inbox SET state = 'started', turn = ?, slot = ? WHERE key = ? AND state = 'waiting' RETURNING key", turn, slot, key);
		if (claimed.length === 0) {
			console.log(`[wlp] inbox.withdrawn_while_taken session=${meta.sessionId} key=${key}`);
			await giveBack(c, meta, key, slot);
			return;
		}
		// Accepted. From here to the transaction nothing is awaited.
		const now = Date.now();
		delete meta.secretRequest;
		meta.turns = turn;
		meta.status = "starting";
		delete meta.pauseNow;
		meta.updatedAt = now;
		meta.turnStartedAt = now;
		meta.run = newRun(meta, turn, effort, false, now, c.vars.nextSeq);
		const first = append(c, { turn, kind: "user", text: itemPrompt(row), model: meta.model, effort });
		publish(c);
		const active: ActiveTurn = { number: turn, effort, controller: new AbortController(), done: Promise.resolve(), control: null, question: null, unsettled: new Set(), aside: [], recalled: new Map(), stopping: false, closed: false, secrets: null, checks: new VerificationLog(), publishes: new Set(), item: { row: { ...row, state: "started", turn, slot }, report: null, full: null, started: false, pushedAtStart: meta.pushedHead ?? null } };
		c.vars.turn = active;
		await serial(c, () =>
			c.db.transaction(async (tx) => {
				await tx.execute("INSERT OR REPLACE INTO timeline (seq, turn, kind, at, item) VALUES (?, ?, ?, ?, ?)", first.seq, first.turn, first.kind, first.at, JSON.stringify(first));
				await markTaken(tx, key, turn, slot);
				await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
			}, { name: "inbox.take" }),
		).catch((error) => c.log.error({ msg: "could not store the receipt of the item's turn; its end is stored with the turn", error: describeError(error) }));
		active.done = c.keepAwake(runTurn(c, meta, active, row.text, release));
		release = null;
	} catch (error) {
		if (!c.vars.turn && meta.status !== "idle") {
			meta.status = "idle";
			meta.turnStartedAt = null;
		}
		c.log.warn({ msg: "the item's turn could not start; its slot is given back", key, error: describeError(error) });
		if (error instanceof MachineUnreachable) {
			await serial(c, () => c.db.transaction(tx => machineUnavailable(tx, row, slot, error.reason), { name: "inbox.machine" }));
			await flushOutbox(c, meta.uid);
			return;
		}
		await giveBack(c, meta, key, slot);
		// Refused for the user's sandbox time or kept sandboxes: asked again, the queue answers with the wait.
		if (error instanceof UserError && ["allowance_used", "too_many_sandboxes", "usage_unavailable"].includes(String(error.code))) void c.keepAwake(askForSlot(c, meta, row));
	} finally {
		c.vars.accepting = false;
		c.vars.delivering = null;
		release?.();
	}
}

/**
 * A cross-repo feature's planning turn reads its other repositories' base trees, each fetched with a read
 * token of that repository alone, through the installation bound to it at filing, one after the other,
 * and left read-only with no git directory (`materializeInput`). One that cannot be had refuses the turn:
 * the planner never plans against the primary alone. Any other turn of an item's builder session starts
 * without them.
 */
async function planningInputs(c: Ctx, meta: SessionMeta, item: NonNullable<ActiveTurn["item"]>, sandbox: SandboxHandle, turn: number): Promise<void> {
	if (meta.origin?.role !== "builder" && !meta.origin?.planCritic) return;
	const asked = item.row.agent === "planner" || item.row.agent === "critic" ? await itemActor(c, meta.uid, item.row.itemId).internalPlanningInputs(item.row.key) : null;
	if (!asked) {
		// Left by an earlier planning turn (a feature converted to one implementer runs its builder here next).
		if (meta.planningInputs && item.row.agent !== "summary") {
			// A builder never starts beside another repository's tree: one that cannot be removed refuses the turn.
			try {
				await removeInputs(sandbox, INPUTS_DIRECTORY);
			} catch (error) {
				item.refused = `This turn did not start: ${describeError(error)}.`;
				throw new TurnProblem(item.refused);
			}
			meta.planningInputs = undefined;
		}
		return;
	}
	meta.planningInputs = true;
	item.crossRepoPlan = true;
	const app = githubApp();
	const refuse = (why: string, policyRefusal = false) => {
		if (policyRefusal) item.policyRefusal = true;
		item.refused = `The planner reads every repository of the feature, and ${why}. Nothing was planned.`;
		throw new TurnProblem(item.refused);
	};
	if (!app) return refuse("this deployment has no GitHub App", true);
	const connection = await githubConnection(c, meta);
	if (!connection) return refuse("the GitHub connection is gone", true);
	for (const input of asked.inputs) {
		const label = `${input.owner}/${input.name}`;
		if (!input.sha) return refuse(`no base commit was recorded for ${label}`, true);
		try {
			const resolved = await resolveBoundRepository(app, connection, input.repositoryId, input.installationId, "read");
			const url = app.cloneUrl(resolved.repository.owner, resolved.repository.name);
			await app.withToken(input.installationId, { repositoryId: input.repositoryId, permissions: { contents: "read", metadata: "read" } },
				token => materializeInput(sandbox, token, { url, branch: input.baseRef, sha: input.sha!, directory: asked.directory, alias: input.alias }), { revokeAfter: true });
			note(c, turn, "info", `Read ${label} at ${input.sha.slice(0, 7)} into ${asked.directory}/${input.alias}, read-only, for the planner.`);
		} catch (error) {
			if (error instanceof TurnProblem) throw error;
			return refuse(`${label} could not be read: ${error instanceof GithubProblem ? error.message : describeError(error)}`,
				error instanceof GithubProblem && (error.code === "github_denied" || error.code === "github_gone"));
		}
	}
}

/** The item's turn has its sandbox: the base is fetched for a turn that merges it, and the item is told the turn started. */
async function itemTurnStarted(c: Ctx, meta: SessionMeta, item: NonNullable<ActiveTurn["item"]>, sandbox: SandboxHandle, turn: number): Promise<void> {
	if (item.started) return;
	item.started = true;
	const app = githubApp();
	if (item.row.fetchBase !== null && meta.repo && app) {
		const base = meta.repo.branch;
		try {
			await fetchBase(app, await githubConnection(c, meta), meta.repo, sandbox);
			note(c, turn, "info", `Fetched ${base} from GitHub into the workspace as origin/${base}, for the agent to merge.`);
		} catch (error) {
			note(c, turn, "warn", `${base} could not be fetched from GitHub for the agent to merge: ${error instanceof GithubProblem ? error.message : describeError(error)}`);
		}
	}
	await planningInputs(c, meta, item, sandbox, turn);
	const fact: Fact = { kind: "turn_started", at: Date.now(), key: item.row.key };
	await serial(c, () => queueMessage(c.db, { to: "item", itemId: item.row.itemId, fact }));
	await flushOutbox(c, meta.uid);
}

/**
 * The item's turn has ended: the item is told how, with what the gate needs (the turn's verification,
 * the observations on its changes, whether there is anything to push, the agent's report, the tokens it
 * used), and its slot is given back, both in one transaction with the meta. A turn whose sandbox could
 * not be had because the deployment's are all in use waits for a slot again instead.
 */
async function itemTurnEnded(c: Ctx, meta: SessionMeta, item: NonNullable<ActiveTurn["item"]>, ended: { outcome: TurnOutcome; stepLimit?: number; verified: Verified | null; used: SandboxHandle | null; unpushed: boolean | null; usage: TurnUsage | null; checks: RepositoryCheck[]; acp?: RunTurnResult["acp"] }): Promise<void> {
	const { row } = item;
	if ((item.full !== null || item.machineAway) && !item.started) {
		await serial(c, () =>
			c.db.transaction(async (tx) => {
				if (item.machineAway) await machineUnavailable(tx, row, row.slot, item.machineAway);
				else await requeue(tx, row.key, row.slot);
				await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
			}, { name: "inbox.requeue" }),
		);
		await flushOutbox(c, meta.uid);
		if (!item.machineAway) void c.keepAwake(askForSlot(c, meta, { ...row, state: "waiting", turn: null, slot: null }, item.full));
		return;
	}
	let fact: EndedFact;
	if (meta.origin?.role === "reviewer") {
		fact = { ...reviewEndedFactOf(row.key, ended.outcome, meta.review, item.said ?? null, item.refused ?? null, ended.usage), ...(item.planReview && { planReview: item.planReview }) };
	} else {
		const flags = ended.used && meta.repo ? await turnFlags(ended.used, meta.repo.baseSha ?? null, ended.checks, ended.verified, meta.origin?.owns).catch(() => []) : [];
		// Not known (git said nothing): taken as changed, and the push says whether there was anything. What the agent pushed itself in the turn is a change too.
		const changed = ended.unpushed !== false || (meta.pushedHead ?? null) !== item.pushedAtStart;
		// Until publication, only a confirmed push of this turn's complete work identifies its report.
		const pushedHead = ended.unpushed === false && meta.pushedHead !== item.pushedAtStart && meta.pushedHead === meta.platformPushed ? meta.pushedHead : null;
		const agent = agentTurn(meta.harness, ended.usage, ended.acp?.usage, ended.acp?.fiveHourAtStart, meta.origin?.signIn);
		fact = { ...endedFactOf(row.key, Date.now(), ended.outcome, ended.verified, flags, changed, item.report, ended.usage, agent, item.asked), ...(meta.secretRequest && { secret: { name: meta.secretRequest.name, why: meta.secretRequest.why, notice: meta.secretRequest.notice } }), pushedHead, ...(row.agent === "summary" && item.said && { reportProblem: item.said }), ...(item.refused ? { refused: item.refused, policyRefusal: item.policyRefusal } : {}), ...(item.refused && item.untrustedRefusal && { untrustedRefusal: item.untrustedRefusal }), ...(item.escaped && { escaped: item.escaped }) };
	}
	if (ended.stepLimit !== undefined) fact.stepLimit = ended.stepLimit;
	if (item.providerRefusal) fact.providerRefusal = item.providerRefusal;
	if (item.sandboxFailed) fact.sandboxFailed = item.sandboxFailed;
	if (item.outOfMemory) fact.outOfMemory = item.outOfMemory;
	if (attachmentStore()) {
		// If the server stops after the ledger commits but before the outbox commits, retry the same keep list.
		await serial(c, () => c.db.execute("INSERT OR REPLACE INTO attachment_filing VALUES (?,?)", row.key, JSON.stringify(fact)));
	}
	await finishItemTurn(c, meta, row, fact);
}

async function finishItemTurn(c: Ctx, meta: SessionMeta, row: InboxRow, fallback: EndedFact): Promise<Fact> {
	const result = await serial(c, async () => {
		const previous = await endedFact(c.db, row.key);
		if (previous) return previous;
		const [pending] = await c.db.execute<{ data: string }>("SELECT data FROM attachment_filing WHERE key=?", row.key);
		const fact = pending ? JSON.parse(pending.data) as EndedFact : fallback;
		if (pending || (fact.kind === "review_ended" && attachmentStore())) {
			const ledger = userActor(c, meta.uid);
			const filing = fact.kind === "review_ended"
				? (["stopped", "failed", "interrupted", "error"].includes(fact.outcome) ? null : fact.review)
				: (typeof fact.report === "object" ? fact.report : null);
			const keep = filing?.screenshots.map(shot => shot.id) ?? [];
			const abandoned = await ledger.internalSettleAttachments({ sessionId: meta.sessionId, key: row.key, keep });
			for (const entry of abandoned) await ledger.internalReleaseAttachment(entry.id).catch(() => {});
		}
		await c.db.transaction(async tx => {
			await markEnded(tx, row, fact);
			await tx.execute("DELETE FROM attachment_filing WHERE key=?", row.key);
			await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
		}, { name: "inbox.end" });
		return fact;
	});
	await flushOutbox(c, meta.uid);
	return result;
}

/** Recover a completed filing across the ledger/outbox boundary, or report a cut-off turn. */
/** The Windlass events the timeline holds of one turn, in order. */
async function windlassEventsOf(c: Ctx, turn: number): Promise<WindlassEvent[]> {
	const events: WindlassEvent[] = [];
	for (const row of await c.db.execute<{ item: string }>("SELECT item FROM timeline WHERE turn = ? AND kind = 'windlass' ORDER BY seq", turn)) {
		const item = JSON.parse(row.item) as TimelineItem;
		if (item.kind === "windlass") events.push(item.event);
	}
	return events;
}

async function closeCutTurn(c: Ctx, meta: SessionMeta, row: InboxRow, usage: TurnUsage | null): Promise<Fact> {
	if (meta.origin?.role === "reviewer") return finishItemTurn(c, meta, row, reviewEndedFactOf(row.key, "interrupted", meta.review, null, null, usage));
	return finishItemTurn(c, meta, row, endedFactOf(row.key, Date.now(), "interrupted", meta.verified ?? null, [], true, null, usage));
}

// ---------------------------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------------------------

export const agentSession = actor({
	options: {
		name: "Agent session",
		icon: "robot",
		// A browser connection must read its generation from the user actor, which may be waking
		// and migrating its database after a restart. Allow that actor its migration window.
		onBeforeConnectTimeout: 30_000,
		// `changes`, `diff` and the internal destroy wait on the sandbox; a turn itself runs in the
		// background under `keepAwake` and is not bound by this.
		actionTimeout: 120_000,
		// Shutdown stops the turn, closes it in the timeline and pauses the sandbox.
		sleepGracePeriod: 25_000,
	},

	db: db({
		onMigrate: async (db) => {
			await db.execute("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
			await db.execute(`
				CREATE TABLE IF NOT EXISTS timeline (
					seq INTEGER PRIMARY KEY,
					turn INTEGER NOT NULL,
					kind TEXT NOT NULL,
					at INTEGER NOT NULL,
					item TEXT NOT NULL
				)
			`);
			await db.execute("CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK (id = 1), files TEXT NOT NULL, diff TEXT NOT NULL)");
			for (const table of INBOX_TABLES) await db.execute(table);
			const inboxColumns = await db.execute<{ name: string }>("PRAGMA table_info(inbox)");
			if (!inboxColumns.some(col => col.name === "checkout")) await db.execute("ALTER TABLE inbox ADD COLUMN checkout TEXT");
			// Rows from before `ask_person` have none: their turns are not offered it.
			if (!inboxColumns.some(col => col.name === "asks_left")) await db.execute("ALTER TABLE inbox ADD COLUMN asks_left INTEGER");
			// Rows from before the marker carry no sources: their turns go as they did.
			if (!inboxColumns.some(col => col.name === "untrusted")) await db.execute("ALTER TABLE inbox ADD COLUMN untrusted TEXT NOT NULL DEFAULT '[]'");
			if (!inboxColumns.some(col => col.name === "unsandboxed")) await db.execute("ALTER TABLE inbox ADD COLUMN unsandboxed INTEGER NOT NULL DEFAULT 0");
			// Rows from before it have no whole-task prompt: their turns go as they did.
			if (!inboxColumns.some(col => col.name === "fresh")) await db.execute("ALTER TABLE inbox ADD COLUMN fresh TEXT");
			await db.execute("CREATE TABLE IF NOT EXISTS attachment_filing (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
			await migrateJournal(db);
		},
	}),

	// Only `user` may create a session: its input carries a grant signed for exactly this key. An actor
	// made any other way (anyone can call getOrCreate) stays without a meta row and removes itself in
	// `onWake`. Throwing here would make the engine retry the start in a loop.
	onCreate: async (c, input: SessionCreateInput | undefined) => {
		try {
			if (!input || !grantIsValid(input.grant, c.key, "agentSession")) return;
			const meta: SessionMeta = {
				uid: c.key[0],
				sessionId: c.key[1],
				demo: input.demo === true,
				title: String(input.title),
				titleIsTyped: input.titleIsTyped === true,
				place: input.place,
				machineName: typeof input.machineName === "string" ? input.machineName : null,
				...(input.size && { size: input.size }),
				...(input.place.kind === "hosted" && isHostedSize(input.hostedSize) && { hostedSize: input.hostedSize }),
				harness: input.harness,
				profile: input.profile,
				...initialSessionModes(input.profile, input.harness, !!input.origin, input.codexModes ?? input.harnessOptions?.modes),
				...(input.harnessOptions && { harnessModels: initialHarnessModels(input.harnessOptions) }),
				...(input.mode !== undefined && { mode: input.mode }),
				model: String(input.model),
				repoUrl: typeof input.repoUrl === "string" ? input.repoUrl : null,
				repo: typeof input.repo === "object" && input.repo !== null ? input.repo : null,
				publishUnasked: typeof input.repo === "object" && input.repo !== null && input.publishUnasked === true,
				createdAt: input.createdAt,
				updatedAt: input.createdAt,
				lastUsedAt: input.createdAt,
				serversChangedAt: input.createdAt,
				status: "idle",
				turns: 0,
				lastOutcome: null,
				sandboxId: null,
				sandbox: "none",
				cloned: false,
				windlassSessionId: null,
				turnStartedAt: null,
				...(input.origin?.kind === "item" && typeof input.origin.itemId === "string" ? { origin: input.origin, ...(input.origin.childBranch && { publishBranch: input.origin.childBranch.name }) } : {}),
				...(!input.origin && typeof input.environmentBuild?.project === "string" && typeof input.environmentBuild.place === "string"
					? { environmentBuild: { project: input.environmentBuild.project, place: input.environmentBuild.place, screenshots: input.environmentBuild.screenshots === true } } : {}),
			};
			await c.db.execute("INSERT OR REPLACE INTO meta (id, data) VALUES (1, ?)", JSON.stringify(meta));
		} catch (error) {
			c.log.error({ msg: "could not initialise the session", error: describeError(error) });
		}
	},

	createVars: async (c): Promise<SessionVars> => {
		const [row] = await c.db.execute<{ data: string }>("SELECT data FROM meta WHERE id = 1");
		const [last] = await c.db.execute<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM timeline");
		const meta = row ? (JSON.parse(row.data) as SessionMeta) : null;
		if (meta?.place.kind === "machine" && typeof meta.machineName === "string" && isMachineIdName(meta.machineName)) {
			const system = await userActor(c, meta.uid).internalMachineSystem(meta.place.machineId).catch(() => null);
			meta.machineName = machineLabel({ name: meta.machineName, ...system });
		}
		return {
			meta,
			nextSeq: (last?.seq ?? 0) + 1,
			unwritten: [],
			flushTimer: null,
			flushQueued: false,
			serial: Promise.resolve(),
			pending: [],
			turn: null,
			accepting: false,
			attempts: new Attempts(),
			destroying: false,
			stopping: false,
			reporting: null,
			reportAgain: false,
			signedInUntil: 0,
			idling: null,
			sandboxOps: 0,
			workspace: undefined,
			arming: Promise.resolve(),
			publishing: false,
			pullCheckedAt: 0,
			unpushed: null,
			meterTimer: null,
			metering: Promise.resolve(),
			idleStopMs: null,
			sandboxGen: 0,
			carried: null,
			runner: null,
			journal: null,
			restored: null,
			takeUpArmedAt: 0,
			resuming: false,
			heartbeat: null,
			setupReap: null,
			startClock: null,
			hostsAllowed: new Map(),
		};
	},

	onWake: async (c) => {
		const meta = c.vars.meta;
		if (!meta) {
			c.destroy();
			return;
		}
		// Before anything is awaited, so before the call that woke the actor can ask for a hold.
		settleWokenAsk(c, meta);
		// The signal taken here is the actor's own; the one on an action's context stops firing once
		// the action has returned.
		c.abortSignal.addEventListener(
			"abort",
			() => {
				// RivetKit may have let go of the actor's state by the time the signal fires, and reading
				// `c.vars` then throws "Actor stopping". Thrown from a listener, that is an uncaught
				// error, which ends the whole server and every other session on it. A turn still
				// running then is stopped by `onSleep`.
				try {
					// A turn the runner keeps through the restart is not stopped: `onSleep` lets go of it (`keepsTurn`).
					// One that can be resumed pauses instead of ending (`markPausing`).
					if (c.vars.turn && !keepsTurn(c)) {
						markPausing(c, meta);
						abortTurn(c, meta, c.vars.turn);
					}
				} catch (error) {
					console.warn(`[wlp] session=${meta.sessionId}: the actor was already stopping when its abort signal fired (${describeError(error)})`);
				}
			},
			{ once: true },
		);

		// A turn running when the server went away: taken up where its process kept running (a machine's, M1), paused to
		// resume where it can be (WLP_TURN_RESUME), or cut short. One already paused resumes below.
		let cut = meta.status !== "idle" && meta.status !== "paused";
		let cutWords = "The server stopped while this turn was running, so the turn was cut short.";
		if (cut && (await takeUpTurn(c, meta))) {
			// The turn goes on: its process kept running on the machine, and the runner resumes the conversation.
			cut = false;
		} else if (cut && meta.status !== "stopping" && resumesTurns(meta) && meta.run?.turn === meta.turns) {
			if (await crashPause(c, meta)) cut = false;
			else cutWords = `The server stopped ${CRASHES_ALLOWED} times in a row while resuming this turn, with nothing done in between, so the turn was ended.`;
		}
		// A pause with no record of it (from a server without resume) is a turn cut short.
		if (meta.status === "paused" && !meta.run?.paused) cut = true;
		if (cut) {
			// The process that ran this turn is gone, and the turn with it; so is a question it was waiting on.
			const turn = meta.turns;
			note(c, turn, "warn", cutWords);
			const events = await windlassEventsOf(c, turn);
			// What the turn recorded before it was cut off says whether it changed the workspace after the checks last ran.
			if (capabilitiesOf(meta.harness).checks === "none") meta.verified = null;
			else {
				const cut = new VerificationLog();
				for (const event of events) cut.note(event);
				meta.verified = cut.cutOff(turn, meta.verified ?? null);
			}
			// The tokens its finished model requests reported: the turn row and an item's spend count them, as the account's ledger already did.
			const usage = cutTurnUsage(events);
			note(c, turn, "info", cutTurnUsageNote(usage));
			append(c, {
				turn,
				kind: "turn.ended",
				outcome: "interrupted",
				exitCode: null,
				steps: null,
				durationMs: meta.turnStartedAt ? Math.max(0, Date.now() - meta.turnStartedAt) : 0,
				usage,
				cachedShare: null,
				message: null,
				verified: meta.verified,
			});
			meta.status = "idle";
			meta.lastOutcome = "interrupted";
			meta.updatedAt = Date.now();
			meta.lastUsedAt = meta.updatedAt;
			meta.turnStartedAt = null;
			meta.run = null;
			// What that turn wrote to Windlass's session was not copied out of the sandbox: the copy is behind it.
			if (meta.backup) meta.memoryTurn = turn;
		}
		if (cut || meta.status === "paused") {
			// A setup run that was going then has no ending item, and is not run again: the agent is told.
			if (meta.setupRunning) {
				meta.setupUnfinished = { command: meta.setupRunning.command, state: "interrupted", exitCode: null, limitMs: meta.setupRunning.limitMs, output: "" };
				// What it started is still running in the sandbox: stop it now, not at the next prompt.
				const sandboxId = meta.sandboxId;
				if (sandboxId) c.vars.setupReap = c.keepAwake(layerOf(c, meta).then(({ sandboxes }) => stopCutOffSetup(sandboxes, sandboxId)).then(
					(swept) => { if (swept) console.log(`[wlp] setup.reaped session=${meta.sessionId} sandbox=${sandboxId}`); },
					(error: unknown) => c.log.warn({ msg: "could not stop a setup cut off with the server; the next turn stops it", sandbox: sandboxId, error: describeError(error) }),
				));
			}
		}
		if (cut) {
			const turn = meta.turns;
			const taken = await rowOfTurn(c.db, turn);
			if (taken) await closeCutTurn(c, meta, taken, cutTurnUsage(await windlassEventsOf(c, turn)));
		}
		if (cut || meta.status === "paused") {
			await persist(c);
			publish(c);
		}
		meta.setupRunning = null;
		// What the item or the turn queue was not told yet before the server stopped is sent now.
		void c.keepAwake(sendOutbox(c, meta.uid));
		// A grant lost with a server leaves a delivery waiting with nothing to move it: each waiting one is asked for again (the queue answers a key it granted with the same slot).
		void c.keepAwake(
			waitingRows(c.db).then(
				(rows) => Promise.all(rows.map((row) => askForSlot(c, meta, row))).then(() => undefined),
				(error: unknown) => c.log.warn({ msg: "could not read the deliveries that wait for a slot", error: describeError(error) }),
			),
		);
		// Repair a lost idle check when the actor wakes.
		const use = useOf(meta);
		c.vars.carried = use === null ? null : { use, gen: c.vars.sandboxGen };
		void c.keepAwake(
			refreshSandbox(c, meta)
				.then(() => wakeMeter(c, meta, use))
				.then(() => armIdle(c, meta))
				// A paused turn resumes once the sandbox's state is known.
				.then(() => resumePaused(c, meta)),
		);
	},

	onSleep: async (c) => {
		c.vars.stopping = true;
		// The wake after a crash is not needed by a turn that pauses here, or by one the runner keeps (M1's own wake).
		heartbeat(c, false);
		// The runner lets go of what it ran for this instance however the rest ends, a throw included.
		try {
			const meta = c.vars.meta;
			if (!meta) return;
			// A machine turn the runner keeps through the restart: stored where it is, and taken up on the next wake.
			if (await keepTurn(c)) return;
			// The order and the waits are what fits in the shutdown grace period (SHUTDOWN_GRACE_MS above).
			// A turn that can be resumed pauses instead of ending (`pauseTurn`), and a wake is scheduled for it.
			markPausing(c, meta);
			await stopTurn(c);
			await persist(c);
			if (meta.sandboxId && meta.sandbox === "running" && meta.status === "paused") {
				// Kept running for the turn that resumes in a moment: an E2B sandbox's own timeout
				// pauses it should no server take the turn up, and a warm one resumes without a pause and resume of its own.
				console.log(`[wlp] sandbox.kept_for_resume id=${meta.sandboxId} session=${meta.sessionId}`);
			} else if (meta.sandboxId && meta.sandbox === "running" && meta.place.kind === "machine") {
				// Asking would have the runner attach to this instance, whose sockets are refused from here
				// (`onWebSocket`); its runner stops the sandbox itself once no session is connected to it for its idle time.
				console.log(`[wlp] sandbox.suspend_skipped id=${meta.sandboxId} session=${meta.sessionId}: the machine's runner stops it after its idle time`);
			} else if (meta.sandboxId && meta.sandbox === "running") {
				const id = meta.sandboxId;
				// A suspend that ends after the wait goes on without the actor, whose state may be gone by then.
				let waiting = true;
				let ended = false;
				const suspended = layerOf(c, meta)
					.then(({ sandboxes }) => sandboxes.suspend(id))
					.then(
						() => {
							ended = true;
							if (!waiting) return;
							sandboxChanged(c);
							meta.sandbox = "paused";
							publish(c);
						},
						(error) => {
							ended = true;
							console.error(`[wlp] sandbox.suspend_failed id=${id} session=${meta.sessionId}: could not pause the sandbox while going to sleep (${describeError(error)})`);
						},
					);
				await within(suspended, SUSPEND_WAIT_MS);
				waiting = false;
				if (!ended) console.warn(`[wlp] sandbox.suspend_slow id=${id} session=${meta.sessionId}: not paused within ${SUSPEND_WAIT_MS / 1000} s of going to sleep; its provider stops it`);
			}
			// A paused sandbox is due for removal later: the schedule wakes the actor for it.
			await within(Promise.all([armIdle(c, meta), c.vars.reporting, sleepMeter(c, meta)]), SETTLE_WAIT_MS);
			await persist(c);
		} finally {
			c.vars.runner?.close();
		}
	},

	onDestroy: async (c) => {
		const alreadyDeleting = c.vars.destroying;
		c.vars.stopping = true;
		c.vars.destroying = true;
		heartbeat(c, false);
		try {
			const meta = c.vars.meta;
			if (!meta) return;
			await stopTurn(c);
			if (c.vars.flushTimer) clearTimeout(c.vars.flushTimer);
			if (meta.place.kind === "hosted" || !alreadyDeleting) {
				await destroySessionSandboxes(c, meta).catch(error => c.log.error({ msg: "could not remove the session's sandboxes", error: describeError(error) }));
			}
			await leaveUsage(c, meta);
			// After the sandbox, which is what uploads: nothing can put the copy back once it is removed.
			await removeBackup(c, meta);
		} finally {
			c.vars.runner?.close();
		}
	},

	events: {
		networkBlocked: event<NetworkBlockedItem>({ canSubscribe: (c) => maySubscribe(c) }),
		item: event<TimelineItem>({ canSubscribe: (c) => maySubscribe(c) }),
		delta: event<LiveDelta>({ canSubscribe: (c) => maySubscribe(c) }),
		summary: event<SessionSummary>({ canSubscribe: (c) => maySubscribe(c) }),
		question: event<PendingQuestion | null>({ canSubscribe: (c) => maySubscribe(c) }),
		machine: event<NonNullable<SessionSnapshot["machine"]>>({ canSubscribe: (c) => maySubscribe(c) }),
	},

	onBeforeConnect: async (c, params: unknown) => {
		assertOrigin(c);
		if (!isRunnerSocket(c.request)) await sessionCaller(c, params);
		if (!c.vars.meta) throw new UserError("That agent does not exist.", { code: "session_not_found" });
	},

	// The machine's runner, which this instance asked to attach. Its hello is checked by the channel,
	// synchronously (machines/ticket.ts); a socket this instance did not ask for has no ticket it knows.
	// A machine removed while only its control socket is down is not told to its sessions: its runner
	// learns of it when it next connects (about a minute, with backoff) and then drops every session;
	// until then it serves them. Accepted (`Prep/Fix batch 2 - brief.md`, item 5).
	onWebSocket: (c, ws) => {
		assertOrigin(c);
		const link = c.vars.runner;
		if (!isRunnerSocket(c.request) || !link || c.vars.stopping) {
			ws.close(1008, "Not expected");
			return;
		}
		link.socket(ws);
	},

	actions: {
		internalDisconnectRevoked: async (c, generation: number): Promise<void> => {
			requireServiceFor(c, "call");
			await disconnectRevoked(c.conns, generation);
		},
		snapshot: async (c): Promise<SessionSnapshot> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			try {
				const { sandboxes } = await layerOf(c, meta);
				if (c.vars.runner) await within(c.vars.runner.snapshotFacts(), PROFILE_WAIT_MS);
				const profile = sandboxes.profile(meta.profile);
				return await serial(c, async () => {
					await writeItems(c).catch((error) => c.log.error({ msg: "could not write the timeline", error: describeError(error) }));
					// A stop checkpoint is provisional while this instance is alive. If its
					// replacement failed to write, the in-memory item at that sequence wins.
					const end = c.vars.unwritten[0]?.seq ?? c.vars.nextSeq;
					const rows = await c.db.execute<{ item: string }>("SELECT item FROM timeline WHERE seq < ? ORDER BY seq", end);
					// No write can run between the read above and here, so what SQLite did not return is
					// exactly what still waits in memory.
					const timeline = rows.map((row) => JSON.parse(row.item) as TimelineItem);
					const last = timeline.length > 0 ? timeline[timeline.length - 1].seq : 0;
					for (const item of c.vars.unwritten) if (item.seq > last) timeline.push(item);
					return {
						summary: summaryOf(meta),
						profile,
						windlassSessionId: meta.windlassSessionId,
						timeline,
						pending: [...c.vars.pending],
						question: c.vars.turn?.question?.pending ?? null,
						...(!meta.origin && meta.secretRequest && { secretRequest: meta.secretRequest }),
						...(meta.place.kind === "machine" ? { machine: c.vars.runner?.reach() ?? null } : {}),
					};
				});
			} catch (error) {
				throw clientError(c.log, error, "The agent's timeline could not be read.");
			}
		},

		setMode: async (c, input: { mode: string }): Promise<SessionSummary> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (meta.origin) throw new UserError("A work item and its reviewer use the profile’s approval mode.", { code: "bad_input" });
			const mode = input?.mode;
			if (meta.harness === "codex" && meta.place.kind === "machine") {
				const facts = await runnerLink(c,meta.place.machineId).facts();
				const offered = facts.report?.harnesses?.find(h => h.id === "codex");
				if (!codexModes(meta.profile,offered?.modes ?? []).some(m => m.id === mode)) throw new UserError(offered?.modeReason ?? innerModesReason,{code:"bad_input"});
			}
			const beforeHarnessOpen = capabilitiesOf(meta.harness).events === "acp" && !meta.availableModes.length;
			if (typeof mode !== "string" || !mode.trim() || (!beforeHarnessOpen && !meta.availableModes.some(m => m.id === mode))) {
				throw new UserError("Choose a mode offered by this agent.", { code: "bad_input" });
			}
			if (c.vars.turn) c.vars.turn.modeQueued = true;
			meta.mode = mode;
			publish(c);
			await persist(c);
			return summaryOf(meta);
		},

		setRequestedSecret: async (c, input: SetRequestedSecretInput): Promise<void> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			const request = meta.secretRequest;
			if (!request || !validRequestedSecretName(input?.name) || input.name !== request.name || (!meta.origin && input.requestId !== request.id))
				throw new UserError("That secret request is no longer open.", { code: "no_question" });
			if (c.vars.savingSecret || c.vars.accepting || c.vars.nextPrompt || meta.status === "paused")
				throw new UserError("The session is busy. Try again when the turn has ended.", { code: "turn_running" });
			const project = setupProjectOf(meta)?.key ?? ACCOUNT_SECRET_PROJECT;
			let sealed: string;
			try {
				sealed = sealSecret(serverSealer(), meta.uid, project, request.name, cleanSecretValue(input.value));
			} catch (error) {
				if (error instanceof SecretProblem) throw new UserError(error.message, { code: "bad_secret" });
				throw error;
			}
			const save = { project, sealed, name: request.name, requestId: input.requestId };
			c.vars.savingSecret = true;
			try {
				if (meta.origin) {
					await itemActor(c, meta.uid, meta.origin.itemId).internalSetRequestedSecret(save);
				} else {
					if (c.vars.turn) await c.vars.turn.done;
					if (meta.secretRequest !== request || c.vars.accepting || meta.run?.paused)
						throw new UserError("That secret request is no longer open.", { code: "no_question" });
					await secretsActor(c, meta.uid, meta.sessionId).internalSaveRequestedSecret(meta.sessionId, save);
					delete meta.secretRequest;
					await persist(c);
					const text = `${request.name} is now set in your environment.`;
					await takePrompt(c, meta, { text }, text, null);
				}
			} finally {
				delete c.vars.savingSecret;
			}
		},

		prompt: async (c, input: PromptInput): Promise<PromptAnswer> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (c.vars.savingSecret) throw new UserError("The requested secret is being saved.", { code: "turn_running" });
			if (meta.origin) throw new UserError("This agent works for a work item, whose steps send its prompts. Answer the item, or send its work back with a note.", { code: "item_session" });
			if (meta.environmentBuild) throw new UserError("This session only builds the repository's prepared environment.", { code: "item_session" });
			if (typeof input !== "object" || input === null || typeof input.text !== "string" || input.text.trim() === "") {
				throw new UserError("Write what the agent should do.", { code: "empty_prompt" });
			}
			const text = input.text.trim();
			if (text.length > MAX_PROMPT_CHARS) {
				throw new UserError(`The prompt is ${text.length} characters long; the limit is ${MAX_PROMPT_CHARS}.`, { code: "prompt_too_long" });
			}
			// Without a key every prompt is a message of its own, as it always was.
			let attempt: Promise<PromptAnswer>;
			try {
				const submission = submissionOf(input.idempotencyKey, text);
				if (submission === null) return await takePrompt(c, meta, input, text, null);
				// Taken before: answered as it was then, whatever the session does now. Nothing was awaited, so this is decided before any other call runs.
				const taken = meta.submissions?.find((kept) => kept.key === submission.key);
				if (taken && isRepeat(taken, submission, KEYED)) return { turn: taken.turn, steered: taken.steered };
				// Being decided, or new: every attempt that arrives until it is taken or refused ends as this one does.
				attempt = c.vars.attempts.run(submission, KEYED, () => takePrompt(c, meta, input, text, submission));
			} catch (error) {
				if (error instanceof SubmissionProblem) throw new UserError(error.message, { code: error.code });
				throw error;
			}
			return await attempt;
		},

		stop: async (c): Promise<void> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			const turn = c.vars.turn;
			if (!turn) {
				// A paused turn has nothing running to stop: it ends now, and does not resume.
				if (meta.status === "paused" && meta.run?.paused) await endPausedTurn(c, meta, "stopped", "You stopped the paused turn, so it will not resume.");
				return;
			}
			turn.stopping = true;
			// A question the turn waits on is withdrawn with it: from here an answer finds nothing to answer.
			const withdrawn = takeQuestion(c, meta, turn);
			if (meta.status !== "stopping") {
				meta.status = "stopping";
				publish(c);
			} else if (withdrawn) {
				publish(c);
			}
			turn.controller.abort();
			await persist(c);
		},

		// Synchronous from the check to the settling, so of two answers sent at once exactly one finds
		// the question pending.
		answer: async (c, input: { questionId: string; choice: string; note?: string }): Promise<void> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (typeof input !== "object" || input === null || typeof input.questionId !== "string" || typeof input.choice !== "string") {
				throw new UserError("Choose one of the question's answers.", { code: "bad_answer" });
			}
			if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
				throw new UserError("The note must be text.", { code: "bad_answer" });
			}
			const note = typeof input.note === "string" ? input.note.trim() : "";
			if (note.length > MAX_NOTE_CHARS) {
				throw new UserError(`The note is ${note.length} characters long; the limit is ${MAX_NOTE_CHARS}.`, { code: "note_too_long" });
			}
			const active = c.vars.turn;
			// A server's question that stands aside for a tool call's is still open: whoever saw it may answer it.
			const asked = active?.question?.pending.id === input.questionId ? active.question : active?.aside.find((candidate) => candidate.pending.id === input.questionId);
			if (!active || !asked || active.stopping || active.closed) {
				throw new UserError("That question is not waiting for an answer any more.", { code: "no_question" });
			}
			if (asked.pending.messageId === "acp" && note) throw new UserError(`${harnessName(meta.harness)} takes a choice without a note.`, { code: "bad_input" });
			const choice = asked.pending.choices.find((candidate) => candidate.id === input.choice);
			if (!choice) {
				throw new UserError(`That is not one of the question's answers. Choose one of: ${asked.pending.choices.map((candidate) => candidate.label).join(", ")}`, { code: "bad_choice" });
			}
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			asked.answer({ choice: choice.id, note: note === "" ? undefined : note });
		},

		stopCall: async (c, input: { messageId: string; callId: string }): Promise<{ stopped: boolean; message: string | null }> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (typeof input !== "object" || input === null || typeof input.messageId !== "string" || input.messageId === "" || typeof input.callId !== "string" || input.callId === "") {
				throw new UserError("Say which tool call to stop.", { code: "bad_call" });
			}
			const active = c.vars.turn;
			const control = active?.control;
			if (!active || !control || active.closed) {
				throw new UserError("No turn is running, so there is no tool call to stop.", { code: "no_turn" });
			}
			// As for a steer: the request would wait for the machine. Stopping the whole turn (`stop`) waits for nothing and still works.
			if (machineAway(c, meta)) throw new UserError("Your machine is not answering, so the tool call was not stopped. Stop the turn instead, or try again when the machine is back.", { code: "turn_running" });
			try {
				const result = await control.cancelCall(input.messageId, input.callId);
				return { stopped: result?.stopped === true, message: typeof result?.message === "string" && result.message !== "" ? result.message : null };
			} catch (error) {
				if (active.closed) throw new UserError("The turn ended before the tool call could be stopped.", { code: "no_turn" });
				throw clientError(c.log, error, "The tool call could not be stopped. Try again.");
			}
		},

		changes: async (c): Promise<WorkspaceFile[]> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			// The sandbox is this read's until it is done: it may resume a paused one and read it.
			const release = takeSandbox(c);
			try {
				const view = await workspaceView(c, meta);
				if (view === null) return [];
				return "sandbox" in view ? ((await readFiles(c, view.sandbox)) ?? []) : view.files;
			} catch (error) {
				throw clientError(c.log, error, "The workspace's changes could not be read.");
			} finally {
				release();
			}
		},

		diff: async (c): Promise<string> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			const release = takeSandbox(c);
			try {
				const view = await workspaceView(c, meta);
				if (view === null) return "";
				return "sandbox" in view ? ((await readDiff(c, meta, view.sandbox)) ?? "") : view.diff;
			} catch (error) {
				throw clientError(c.log, error, "The workspace's diff could not be read.");
			} finally {
				release();
			}
		},

		publishState: async (c): Promise<PublishState> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			try {
				await checkPull(c, meta);
				return await publishStateOf(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The pull request's state could not be read.");
			}
		},

		publish: async (c, input: { message: PublishMessage }): Promise<PublishResult> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (meta.origin?.role === "reviewer") throw new UserError("The reviewer cannot publish.", { code: "reviewer" });
			const message = cleanMessage(input);
			const repo = meta.repo;
			if (!repo) throw new UserError("This agent does not work on a repository of your GitHub connection, so there is nowhere to push.", { code: "publish_blocked" });
			// A push under way (the agent's, or an item's step) is waited for, and the click goes on with what it pushed.
			if (c.vars.publishing && !(await publishingSettled(c, PUBLISH_WAIT_MS))) {
				throw new UserError("The agent is pushing its work right now. Open the pull request again in a moment.", { code: "publish_blocked" });
			}
			// While a turn runs the workspace is the agent's, and nothing of it is committed or pushed: with the branch pushed and no pull
			// request open, the pull request is opened from what is at GitHub. Decided and taken in this step, with nothing awaited since the wait.
			const app = githubApp();
			const busyTurn = c.vars.turn !== null || c.vars.accepting || meta.status !== "idle";
			const openPull = meta.pull && (meta.pull.state === "open" || meta.pull.state === "draft");
			if (busyTurn && app && meta.pushedHead && meta.publishBranch && !openPull && !c.vars.publishing) {
				c.vars.publishing = true;
				try {
					const pull = await c.keepAwake(openFromPushed({ app, connection: await githubConnection(c, meta), repository: repo, branch: meta.publishBranch, message, evidence: await evidenceOf(c, meta, c.vars.turn?.number ?? null) }));
					meta.pull = pull;
					c.vars.pullCheckedAt = Date.now();
					note(c, meta.turns, "info", `Opened pull request #${pull.number} in ${repo.owner}/${repo.name} from ${pull.branch}, from what the agent had pushed; the turn goes on.${verifiedLine(pull)}`);
					console.log(`[wlp] github.published session=${meta.sessionId} repository=${repo.id} pull=${pull.number} opened=true from=pushed`);
					publish(c);
					await persist(c);
					return { state: await publishStateOf(c, meta), opened: true };
				} catch (error) {
					if (error instanceof GithubProblem) throw new PublishRefused(error.message, error.code === "github_gone" || error.code === "github_denied" ? error.code : "publish_failed", error.code === "github_unreachable");
					throw clientError(c.log, error, "The pull request could not be opened. Try again.");
				} finally {
					c.vars.publishing = false;
				}
			}
			const blocked = publishBlocked(c, meta);
			if (blocked) throw new UserError(blocked, { code: "publish_blocked" });
			// Nothing was awaited since the check: this push is the only one past it.
			c.vars.publishing = true;
			const release = takeSandbox(c);
			try {
				return await c.keepAwake(publishSession(c, meta, repo, message));
			} catch (error) {
				throw clientError(c.log, error, "The work could not be pushed. Try again.");
			} finally {
				c.vars.publishing = false;
				release();
			}
		},

		setPublishUnasked: async (c, input: { unasked: boolean }): Promise<SessionSummary> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (typeof input !== "object" || input === null || typeof input.unasked !== "boolean") throw new UserError("Say whether the agent may publish without asking.", { code: "bad_input" });
			if (!meta.repo) throw new UserError("This agent does not work on a repository of your GitHub connection, so it has nowhere to publish to.", { code: "publish_blocked" });
			if (input.unasked) {
				if (!capabilitiesOf(meta.harness).platformTools.includes("publish")) throw new UserError("This agent has no publish tool. Publish from the panel.", { code: "publish_blocked" });
				// Its publish comes over MCP, which any process in the container may reach: it asks every time.
				if (meta.harness && meta.harness !== "windlass") throw new UserError(publishAsksEveryTime(harnessName(meta.harness)), { code: "publish_blocked" });
				const { sandboxes } = await layerOf(c, meta);
				const problem = publishUnaskedProblem(commandSandbox(sandboxes.profile(meta.profile)));
				if (problem !== null) throw new UserError(problem, { code: "publish_blocked" });
			}
			const active = c.vars.turn;
			// A request that is being asked about is allowed by turning this on, as by its own "Allow for this session".
			const asked = input.unasked && active && !active.stopping && !active.closed ? [active.question, ...active.aside].find((candidate) => candidate?.pending.publish !== undefined) : undefined;
			if (active && asked) {
				if (active.question === asked) takeQuestion(c, meta, active);
				meta.publishUnasked = true;
				asked.answer({ choice: PUBLISH_SESSION });
			} else if ((meta.publishUnasked === true) !== input.unasked) {
				meta.publishUnasked = input.unasked;
				note(c, meta.turns, "info", input.unasked ? "You let the agent publish this session's work without asking, in the session's panel." : "You turned off publishing without asking in the session's panel: the agent's next request to publish is put to you.");
			}
			publish(c);
			await persist(c);
			return summaryOf(meta);
		},

		servers: async (c): Promise<SessionServers> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			try {
				return await sessionServers(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The project's MCP servers could not be read.");
			}
		},

		approveServer: async (c, input: { name: string; fingerprint: string }): Promise<SessionServers> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (!capabilitiesOf(meta.harness).projectServerApproval) throw new UserError(`${harnessName(meta.harness)} does not take project MCP servers here.`, { code: "bad_server" });
			if (meta.origin?.role === "reviewer") throw new UserError("The reviewer cannot start MCP servers.", { code: "reviewer" });
			if (typeof input !== "object" || input === null || typeof input.name !== "string" || input.name === "" || typeof input.fingerprint !== "string" || input.fingerprint === "") {
				throw new UserError("Say which server to approve, and which definition of it.", { code: "bad_server" });
			}
			const server = (meta.servers ?? []).find((candidate) => candidate.name === input.name);
			if (!server) throw new UserError("This session's project no longer names an MCP server of that name.", { code: "server_gone" });
			// The approval is of the definition the user was shown: one the session has since seen change, start or go is not it.
			if (server.state !== "waiting" || server.fingerprint !== input.fingerprint) {
				throw new UserError(`The MCP server "${server.name}" no longer waits with the definition shown here. Read the list again and look at it once more.`, { code: "server_changed" });
			}
			try {
				const active = c.vars.turn;
				// A question about exactly this definition is open: this answers it, and the server starts now.
				const asked = active && !active.stopping && !active.closed ? [active.question, ...active.aside].find((candidate) => candidate?.server?.name === server.name && candidate.server.fingerprint === input.fingerprint) : undefined;
				if (active && asked) {
					if (active.question === asked) {
						takeQuestion(c, meta, active);
						publish(c);
						void persist(c);
					}
					asked.answer({ choice: SERVER_START });
				} else {
					// No Windlass runs between turns, and one that runs has asked about this definition already: the
					// approval is kept, and the next turn's Windlass is told of it before its prompt goes.
					await serverApprovals.remember(c, meta, { name: server.name, fingerprint: input.fingerprint });
					note(c, meta.turns, "info", serverPanelApprovedNote(server));
					serversChanged(c, meta);
				}
				return await sessionServers(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The approval could not be remembered. Try again.");
			}
		},

		forgetServer: async (c, input: { name: string }): Promise<SessionServers> => {
			await requireSessionUser(c);
			const meta = liveMeta(c);
			if (!capabilitiesOf(meta.harness).projectServerApproval) throw new UserError(`${harnessName(meta.harness)} does not take project MCP servers here.`, { code: "bad_server" });
			if (typeof input !== "object" || input === null || typeof input.name !== "string" || input.name === "" || input.name.length > 200) {
				throw new UserError("Say which server's approval to forget.", { code: "bad_server" });
			}
			try {
				const forgotten = await serverApprovals.forget(c, meta, input.name);
				if (forgotten > 0) {
					const { sandboxes } = await layerOf(c, meta);
					note(c, meta.turns, "info", serverForgottenNote({ name: input.name }, { dataInSandbox: await privateSessionData(meta, sandboxes, meta.sandboxId) }));
					serversChanged(c, meta);
				}
				return await sessionServers(c, meta);
			} catch (error) {
				throw clientError(c.log, error, "The approval could not be forgotten. Try again.");
			}
		},

		allowHost: async (c, input: { host: string }): Promise<HostAllowed> => {
			const by = await requireSessionUser(c);
			const meta = liveMeta(c);
			const host = typeof input?.host === "string" ? input.host.trim().toLowerCase().replace(/\.$/, "") : "";
			if (!isHostName(host)) throw new UserError("That is not an exact host name.", { code: "bad_network" });
			if (meta.place.kind !== "hosted") throw new UserError("A repository's network list is for hosted sandboxes, and this agent runs on a machine of yours: its runner's --egress settings say what it reaches.", { code: "bad_network" });
			const project = setupProjectOf(meta);
			if (!project) throw new UserError("This agent has no repository of your GitHub connection, so there is no list to allow a host in. The deployment's operator can allow it for every sandbox, in WLP_E2B_NETWORK_ALLOW.", { code: "bad_network" });
			const { sandboxes } = await layerOf(c, meta);
			// In `none` the list applies nowhere: saying it was allowed would promise a host nothing reaches.
			if (sandboxes.egress?.() === "none") throw new UserError(`This deployment gives hosted sandboxes no network but the model API (WLP_E2B_NETWORK=none), so a host allowed for ${project.label} would be reached by nothing here.`, { code: "bad_network" });
			if (sandboxes.egress?.() !== "restricted" || !sandboxes.setNetwork) throw new UserError("Repository network settings apply to restricted hosted sandboxes.", { code: "bad_network" });
			const answer = await userActor(c, meta.uid).internalAllowHost({ sessionId: meta.sessionId, host, by });
			if (!answer.allowed) {
				note(c, meta.turns, "info", `${host} was asked for: whoever changes the settings of ${project.label} can allow it there.`);
				return { network: answer.network, applied: false };
			}
			meta.networkHosts = answer.hosts.length > 0 ? answer.hosts : undefined;
			c.vars.hostsAllowed.set(host, Date.now());
			let applied = false;
			// At once only while a turn holds the sandbox, and so its time is on the meter: between turns a change
			// would start a paused sandbox, or push a running one's timeout out, with nothing counting it.
			const turn = c.vars.turn;
			if (meta.sandboxId && turn && !turn.closed) {
				try {
					applied = (await sandboxes.setNetwork?.(meta.sandboxId, meta.networkHosts ?? [])) ?? false;
				} catch (error) {
					c.log.warn({ msg: "could not change the running sandbox's network", error: describeError(error) });
				}
			}
			const wide = WIDE_HOSTS[host];
			note(c, meta.turns, "info", `${host} is allowed for ${project.label}. ${applied ? "This sandbox reaches it now; for the repository's other hosted agents it applies from the next turn." : "It applies from the next turn, in this agent's sandbox and the repository's other hosted agents'."}${wide ? ` ${wide}` : ""}`);
			await persist(c);
			return { network: answer.network, applied };
		},

		// --- called by the actor's own schedule only ------------------------------------------------

		/**
		 * Scheduled while a turn runs (`heartbeat`), after a graceful pause, and while a turn waits for its machine: a paused
		 * turn resumes if its place can be had. The wake itself pauses a turn a crash cut off (`crashPause`).
		 */
		internalResumeTurn: async (c): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const meta = c.vars.meta;
			if (meta && !c.vars.destroying) await resumePaused(c, meta);
		},

		/** Scheduled when an item's turn paused for its machine: if it still waits, the item asks its person once (`machine_away`). */
		internalMachineAsk: async (c): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
			const meta = c.vars.meta;
			const run = meta?.run;
			const paused = run?.paused;
			if (!meta || !run || !paused || paused.reason !== "machine" || paused.asked || Date.now() < paused.at + config.turnResume.machineAskMs) return;
			const row = await rowOfTurn(c.db, run.turn);
			if (!row) return;
			paused.asked = true;
			await serial(c, () => c.db.transaction(async (tx) => {
				await queueMessage(tx, { to: "item", itemId: row.itemId, fact: { kind: "machine_away", deadline: paused.at + config.turnResume.machineAskMs, at: Date.now(), key: row.key, since: paused.at, machine: meta.machineName } });
				await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify(meta));
			}, { name: "inbox.machine_away" }));
			await flushOutbox(c, meta.uid);
		},

		/** The session's machine is back (its runner said hello): a turn paused for it resumes. */
		internalMachineBack: async (c): Promise<void> => {
			requireService(c);
			const meta = c.vars.meta;
			if (meta && !c.vars.destroying) void c.keepAwake(resumePaused(c, meta));
		},

		/** Scheduled while a machine turn can be taken up after a crash (`armTakeUp`): the wake itself does the work (`takeUpTurn`). */
		internalTakeUp: async (c): Promise<void> => {
			if (!c.scheduledFire) throw new UserError("This action is internal.", { code: "forbidden" });
		},

		internalIdle: async (c): Promise<void> => {
			// RivetKit sets `scheduledFire` on the context of a call its schedule makes; a client cannot.
			const fire = c.scheduledFire;
			if (!fire) throw new UserError("This action is internal.", { code: "forbidden" });
			const meta = c.vars.meta;
			// The arming that set this check may not have stored its id yet: one set for a moment already past
			// (the wake's repair after a crash or a deploy cut a check off) fires before `schedule.at` has
			// answered, and judged then it would look replaced and be dropped, leaving the sandbox past its time.
			// The queue never rejects.
			await c.vars.arming;
			// Every firing is said, whatever the check then finds: one that finds the sandbox paused already does nothing else that shows.
			const superseded = meta?.idleCheck ? meta.idleCheck.id !== fire.id : false;
			console.log(`[wlp] schedule.fired session=${c.key[1]} action=internalIdle id=${fire.id} late_ms=${fire.firedAt - fire.scheduledAt}${superseded ? " superseded" : ""}`);
			if (!meta || c.vars.destroying) return;
			// A check that was replaced by a later one, and whose cancel did not reach it, does nothing.
			if (superseded) return;
			try {
				await idleCheck(c, meta);
			} catch (error) {
				c.log.error({ msg: "the idle check of the sandbox failed", error: describeError(error) });
			}
		},

		// --- the work item's inbox (session-inbox.ts) ------------------------------------------------

		internalDeliver: async (c, input: unknown): Promise<void> => {
			requireService(c);
			const meta = liveMeta(c);
			const delivery = deliveryOf(input);
			if (!delivery || meta.origin?.itemId !== delivery.itemId || !!meta.origin.planCritic !== (delivery.agent === "critic") || (meta.origin.role === "reviewer") !== Boolean(delivery.checkout || delivery.agent === "critic") || (delivery.checkout && (delivery.agent || delivery.fetchBase))) throw new UserError("That delivery is not this session's.", { code: "bad_input" });
			// Stored before the item is answered: from here the same delivery again adds nothing.
			await serial(c, () => receive(c.db, delivery, Date.now()));
			const row = await inboxRow(c.db, delivery.key);
			if (row?.state !== "waiting") return;
			// Answered once the queue holds the request too: a request that did not get there fails the delivery, which the item sends again.
			const answer = await requestTurn(c, meta.uid, row);
			if (answer.granted) void c.keepAwake(takeDelivered(c, meta, row.key, answer.slot));
		},

		// --- Windlass's model relay route (model-relay-route.ts), from another server process -----------

		/** Whether this actor's process holds a turn's relay lease, and its current token: not held, the turn has ended. */
		internalModelRelay: (c, input: { nonce: string }): { held: boolean; token: AccessToken | null } => {
			requireService(c);
			const nonce = typeof input?.nonce === "string" ? input.nonce : "";
			return leaseState(nonce, c.key[0], c.key[1]);
		},

		internalGrant: (c, input: { key: string; slot: string }): void => {
			requireService(c);
			const meta = liveMeta(c);
			if (typeof input?.key !== "string" || typeof input.slot !== "string") throw new UserError("A grant names a delivery and a slot.", { code: "bad_input" });
			void c.keepAwake(takeDelivered(c, meta, input.key, input.slot));
		},

		internalWithdraw: async (c, key: string): Promise<void> => {
			requireService(c);
			const meta = liveMeta(c);
			if (await serial(c, () => withdrawWaiting(c.db, String(key)))) {
				await userActor(c, meta.uid).internalWithdrawTurn({ sessionId: meta.sessionId, key: String(key) });
				return;
			}
			const active = c.vars.turn;
			if (active?.item?.row.key === key) {
				active.item.withdrawn = true;
				abortTurn(c, meta, active);
				return;
			}
			// The paused turn of that delivery ends where it is: the item does not want it any more.
			if (meta.status === "paused" && meta.run?.paused && (await rowOfTurn(c.db, meta.run.turn))?.key === key) await endPausedTurn(c, meta, "stopped", null);
		},

		internalCheckTurn: async (c, input: { turn: string; check: string }): Promise<Fact | null> => {
			requireService(c);
			const meta = liveMeta(c);
			const row = await inboxRow(c.db, String(input?.turn));
			// Polling for the turn end follows the same order as the outbox. A publish that follows
			// this answer must already have the session's final network receipt.
			if (meta.blocked && (await c.db.execute("SELECT 1 FROM outbox WHERE json_extract(message, '$.to') = 'network' LIMIT 1")).length) return null;
			if (row?.state === "ended") return await endedFact(c.db, row.key);
			if (row?.state !== "started") return null;
			if (c.vars.turn?.item?.row.key === row.key || c.vars.closingItem === row.key) return { kind: "turn_running", at: Date.now(), key: String(input.check) };
			// Paused, or being resumed: the turn is not over, and resumes by itself.
			if ((meta.status === "paused" && meta.run?.paused && row.turn === meta.run.turn) || c.vars.resuming) return { kind: "turn_running", at: Date.now(), key: String(input.check) };
			// Taken, and no turn of it runs here: the server stopped under it before its end was written.
			return await closeCutTurn(c, meta, row, row.turn === null ? null : cutTurnUsage(await windlassEventsOf(c, row.turn)));
		},

		internalBaseTests: async (c, input: { head: string; base: string; tests: NamedTests }): Promise<BaseTestResult | "pending"> => {
			requireService(c);
			const meta = liveMeta(c);
			const repo = meta.repo;
			if (meta.origin?.role !== "builder" || !repo || meta.pushedHead !== input.head || !/^[0-9a-f]{40}$/.test(input.base)) return "unknown";
			const key = digest([input.head, input.base, input.tests.runner, ...input.tests.names]);
			const [known] = await c.db.execute<{ result: BaseTestResult }>("SELECT result FROM base_test WHERE key=?", key);
			if (c.vars.baseTest === key) return "pending";
			if (known) return known.result;
			if (c.vars.baseTest) return "pending";
			c.vars.baseTest = key;
			// A sandbox check can outlast an actor RPC. The CI poll collects its receipt on the next reading.
			const check = async () => {
				const claimed = await c.db.execute("INSERT OR IGNORE INTO base_test VALUES (?, 'unknown') RETURNING key", key);
				if (!claimed.length) return;
				const result = await testSessionBase(c, meta, repo, input);
				await c.db.execute("UPDATE base_test SET result=? WHERE key=?", result, key);
			};
			void c.keepAwake(check().catch(() => { /* A lost attempt keeps its inconclusive receipt. */ }).finally(() => { delete c.vars.baseTest; }));
			return "pending";
		},

		internalPublish: async (c, input: { key: string; title: string; body: string; blockedNetwork?: BlockedNetwork; branchOnly?: boolean; updateFromBase?: { head: string; at: number } }): Promise<ItemPublishAnswer> => {
			requireService(c);
			const meta = liveMeta(c);
			if (meta.origin?.role === "reviewer") throw new UserError("The reviewer cannot publish.", { code: "reviewer" });
			// A push for this effect that went through and whose answer did not reach the item is answered as it was, and not pushed again.
			const known = await publishReceipt(c.db, String(input?.key ?? ""));
			if (known) return known;
			const repo = meta.repo;
			if (!repo) return { kind: "publish_failed", said: "the item's agent has no repository to push to", transient: false };
			const blocked = publishBlocked(c, meta);
			if (blocked) return { kind: "publish_failed", said: blocked, transient: true };
			c.vars.publishing = true;
			const release = takeSandbox(c);
			try {
				const report = meta.report?.run === Number(input.key.split(":")[1]) ? meta.report : null;
				const body = report ? [report.description, report.concerns ? `**What the agent is unsure of:** ${report.concerns}` : ""].filter((part) => part !== "").join("\n\n") : String(input?.body ?? "");
				const result = await c.keepAwake(publishSession(c, meta, repo, { title: report?.title || String(input?.title ?? meta.title), body }, true, input.branchOnly, input.blockedNetwork, input.updateFromBase));
				const pull = result.state.pullRequest;
				if (!input.branchOnly && !pull) return { kind: "publish_failed", said: "GitHub opened no pull request", transient: true };
				// The commit git said it pushed; where git says nothing (a sandbox layer without git), the branch names it.
				const answer = { kind: "published" as const, head: meta.pushedHead ?? pull!.branch, pr: pull ? { number: pull.number, url: pull.url } : null };
				await rememberPublish(c.db, String(input?.key ?? ""), answer);
				return answer;
			} catch (error) {
				// GitHub out of reach, or a push that took too long, is tried again by the item; any other refusal is its person's to decide.
				if (error instanceof BaseMergeConflict) return { kind: "base_conflict" };
				if (error instanceof UserError) return { kind: "publish_failed", said: error.message, transient: error instanceof PublishRefused && error.transient };
				return { kind: "publish_failed", said: describeError(error), transient: true };
			} finally {
				c.vars.publishing = false;
				release();
			}
		},

		[OUTBOX_ACTION]: async (c): Promise<void> => {
			const fire = c.scheduledFire;
			if (!fire) throw new UserError("This action is internal.", { code: "forbidden" });
			// One line per firing, so that a late or lost schedule shows in the logs.
			console.log(`[wlp] schedule.fired action=${OUTBOX_ACTION} session=${c.key[1]} late_ms=${fire.firedAt - fire.scheduledAt}`);
			const meta = c.vars.meta;
			if (meta) await sendOutbox(c, meta.uid);
		},

		// --- called by `user` only ---------------------------------------------------------------

		internalSummary: (c): SessionSummary => {
			requireService(c);
			return summaryOf(liveMeta(c));
		},

		internalBuildEnvironment: async (c): Promise<void> => {
			requireService(c);
			const meta = liveMeta(c);
			if (!meta.environmentBuild) throw new UserError("This session builds no environment.", { code: "bad_input" });
			// Its one turn: a second call (a retried request) finds it taken.
			if (meta.turns > 0 || c.vars.turn || c.vars.accepting) return;
			await startPrompt(c, meta, { text: "Build the prepared environment." }, "Build the prepared environment.", null);
		},

		internalRename: async (c, title: string): Promise<SessionSummary> => {
			requireService(c);
			const meta = liveMeta(c);
			meta.title = String(title);
			meta.titleIsTyped = true;
			// The caller is the `user` actor, which takes the summary from the return value.
			c.broadcast("summary", summaryOf(meta));
			await persist(c);
			return summaryOf(meta);
		},

		/**
		 * The user frees the session's sandbox to make room for another (usage.ts). It is removed as one
		 * that was not used for long is, the timeline says who did it and what became of the agent's
		 * memory, and the next prompt starts a new sandbox. Refused while the session works.
		 */
		internalFreeSandbox: async (c, throughReviewRun?: number, hostedSize?: HostedSize): Promise<{ freed: boolean; sizeUnavailable?: HostedSize }> => {
			requireService(c);
			const meta = liveMeta(c);
			if (c.vars.idling) await c.vars.idling.catch(() => undefined);
			if (throughReviewRun !== undefined && (meta.origin?.role !== "reviewer" || (meta.reviewRun ?? 0) > throughReviewRun)) return { freed: false };
			// A stored OOM choice can outlive Pro. Check again before touching the old sandbox.
			if (meta.place.kind === "hosted" && hostedSize && billing() && !(await userActor(c, meta.uid).internalHostedSizes()).includes(hostedSize)) {
				return { freed: false, sizeUnavailable: hostedSize };
			}
			if (c.vars.turn || c.vars.accepting || meta.status !== "idle") throw new UserError(`${meta.title} is working. Stop its turn first, then free its sandbox.`, { code: "sandbox_busy" });
			if (busy(c)) throw new UserError(`The platform is busy with the sandbox of ${meta.title}. Try again in a moment.`, { code: "sandbox_busy" });
			const id = meta.sandboxId;
			// Set in the same step as the checks above: from here a prompt waits for it.
			const release = takeSandbox(c);
			const work = (async () => {
				const layer = await layerOf(c, meta);
				if (id) {
					const memory = !meta.windlassSessionId ? null : !(await privateSessionData(meta, layer.sandboxes, id)) ? "kept" : layer.backups && meta.backup?.windlassSessionId === meta.windlassSessionId ? "copied" : "lost";
					await removeSandbox(c, meta, id, throughReviewRun === undefined ? freedNote(memory) : "Released the reviewer’s sandbox for the finished run.");
					console.log(`[wlp] sandbox.freed id=${id} session=${meta.sessionId}`);
				}
				// Under the same exclusion: what the provider still has for the session goes with it, by the session's
				// own hand (the user actor removes only what a session that is gone left). With no sandbox of its own,
				// its place is given back here too: `removeSandbox` did not run.
				await sweepSandboxes(c, meta, layer);
				if (!id) await releasePlace(c, meta);
				// A larger size for the next sandbox (a work item whose sandbox ran out of memory): only a new sandbox has another size.
				if (meta.place.kind === "hosted" && isHostedSize(hostedSize)) meta.hostedSize = hostedSize;
				publish(c);
				await persist(c);
			})();
			c.vars.idling = work;
			try {
				await work;
			} catch (error) {
				throw clientError(c.log, error, "The sandbox could not be freed. Try again.");
			} finally {
				c.vars.idling = null;
				release();
			}
			await armIdle(c, meta);
			return { freed: id !== null };
		},

		internalDestroy: async (c): Promise<void> => {
			requireService(c);
			c.vars.destroying = true;
			const meta = c.vars.meta;
			if (meta) {
				// Done here as well as in `onDestroy`, so that the caller can retry if the machine could not record the removals.
				await stopTurn(c);
				try {
					await serial(c, () => writeItems(c));
					await settleTokenReceipts(c, meta.uid);
					await destroySessionSandboxes(c, meta);
				} catch (error) {
					c.log.error({ msg: "could not record the session's sandbox removals", session: meta.sessionId, error: describeError(error) });
					c.vars.destroying = false;
					await persist(c);
					// What a turn stopped above could not set while the session was being destroyed.
					void armIdle(c, meta);
					throw new UserError("The agent could not finish settling its usage or removing its sandbox. Try again in a moment.", { code: "machine_unreachable" });
				}
				// What its sandbox ran is reported, and its place among the user's sandboxes given back.
				await leaveUsage(c, meta);
				// The copy of Windlass's session goes with the session, once the sandbox that uploads it is gone.
				await removeBackup(c, meta);
			}
			c.destroy();
		},
	},
});
