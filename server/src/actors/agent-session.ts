// agentSession owns one sandbox and its turns, keyed by [uid, sessionId].
// The active turn holds credentials in memory. The timeline queue commits redacted items
// and runner receipts in order so reconnects resume after the last durable sequence.
import { spareProfile, spareRecipe, type SpareRecipe, type SpareSetup } from "../runner/spare-recipe.js";
import { fileReadiness } from "../factory/readiness-filing.js";
import { refHead } from "../github/feature.js";
import { canReuseSnapshot, DEFERRED_INPUTS, digest, snapshotGeneration, snapshotWriter, type SnapshotRequest } from "../sandbox/snapshot-key.js";
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
import { db } from "rivetkit/db";
import { assertOrigin, authenticate, clientError, describeError, isSandboxUserError, checkGeneration, disconnectRevoked, requireService, requireServiceFor } from "../auth.js";
import { config, snapshotsFor } from "../config.js";
import {
	generatedSessionTitle,
	isMachineIdName,
	machineLabel,
	type LiveDelta,
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
	type SessionServers,
	type SessionSnapshot,
	type SetRequestedSecretInput,
	type SessionSummary,
	SETUP_OUTPUT_CHARS,
	type TimelineItem,
	type TurnOutcome,
	type TurnUsage,
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
import type { ModelKeySpend, BlockedNetwork, NetworkBlockedItem } from "../contract.js";
import { blockedHostNote, hostsForTurn } from "../repository-network.js";
import { GithubError, githubApp, type InstallationToken } from "../github/app.js";
import { cloneCommand, WORKSPACE_GIT_START, actuallyPushed, changedReviewPaths, checkoutPreparedReviewBase, checkoutReview, readOnlyReview, materializeInput, removeInputs } from "../github/git.js";
import { INPUTS_DIRECTORY } from "../factory/cross-repo.js";
import { OFFLINE_REPOSITORY } from "../runner/egress.js";
import { HOSTED_OFFLINE_REPOSITORY, isHostName } from "../sandbox/hosted-network.js";
import { type PublishEvidence, BaseMergeConflict, updateBranchFromBase, PullProblem, type Published, type StoredRepository, branchFor, cloneRepository, describePull, hasUnpushedWork, openFromPushed, publishWork, pushWork, putOnWork, refreshPull } from "../github/publish.js";
import { GithubProblem, problemOf, resolveBoundRepository, type StoredConnection } from "../github/repos.js";
import { ModelProblem, checkEffort, chosenModel, plannerEffort, standInModels } from "../account-models.js";
import type { OutOfMemory, RunTurnInput, RunTurnResult, SandboxHandle, SandboxLayer, TurnCheckpoint, TurnPublishRequest } from "../sandbox/api.js";
import { MachineUnreachable, machineActor } from "../sandbox/runner-layer.js";
import { forgetConversation, migrateJournal, readCheckpoint, readConversation } from "../runner/journal.js";
import { runSetupCommand, stopCutOffSetup, stopLeftoverSetup } from "../sandbox/setup.js";
import { ACCOUNT_SECRET_PROJECT, type OpenedAccountSecret, accountSecretsFor, accountSecretsNote, turnEnvironment } from "../account-secrets.js";
import { unaskedNote } from "../personal-servers.js";
import { type CommandSandbox, NO_REDACTION, type OpenedSecret, type Redactor, SecretRedactor, SecretProblem, MAX_SECRET_REQUESTS, secretRequestLimit, validRequestedSecretName, cleanSecretValue, sealSecret, commandSandbox, openSecret, setupEnvironment } from "../repo-secrets.js";
import { projectOf } from "../server-approvals.js";
import { SERVER_START, type ServerQuestionContext, serverApprovedNote, serverForgottenNote, serverPanelApprovedNote, serverRecalledNote, unsetRemedy } from "../server-question.js";
import { OutputTail, lastLines, setupProjectOf } from "../setup-command.js";
import { Attempts, type Submission, SubmissionProblem, isRepeat, submissionOf } from "../submissions.js";
import { VerificationLog, groupReviewPaths } from "../verified.js";
import { serverSealer } from "../signin/seal.js";
import { agentTurn, turnTokens } from "../factory/budget.js";
import { cutTurnUsage, cutTurnUsageNote, reportedModelUsage, usesPlatformModel, UNCHECKED_IDLE_NOTE, UNCHECKED_TURN_NOTE, USAGE_UNAVAILABLE, allowanceRefusal, closingReports, freedNote, foundStoppedAt, holdDeadline, hostedLimitsApply, idleSuspendedNote, sandboxRefusal, stoppedBy, stretchSeconds, turnStoppedNote } from "../usage.js";
import { judgeChecks } from "../environments.js";
import { outputExcerpt } from "../factory/check-environment.js";
import { runBaseTests, type BaseTestResult, type NamedTests } from "../factory/base-tests.js";
import { PlatformChecks } from "../sandbox/platform-checks.js";
import { itemActor, modelKeyActor, grantIsValid, type EnvironmentBuildReport, type EnvironmentBuildResult, type ReserveAnswer, type SealedSecrets, secretsActor, sessionSandboxInput, type SessionCreateInput, userActor } from "./internal.js";
import { attachmentStore, uploadShots } from "../sandbox/attach.js";
import { REPORT_TAKEN, askPerson, requestSecret, secretRequestNotice } from "../agent-publish.js";
import { RULES } from "../factory/blueprint.js";
import { DATA_DIR } from "../sandbox/provider.js";
import { planReviewOf } from "../factory/autonomy.js";
import { reviewerTask } from "../factory/reviewer-task.js";
import { accountKey, type AccountLocation } from "./provider-accounts.js";
import { resetTime, type LimitEvent, type UsageObservation } from "../provider-usage.js";
import { type ProviderRefusal, limitObservation, publicUsageEvent, refusalMessage, stepRefusal, turnRefusal } from "../provider-refusal.js";
import type { FeedbackNotice } from "./github-inbox.js";
import { batchText, feedbackWords, fits, oversizedFeedback } from "../factory/feedback.js";
import { recentSubject } from "../factory/intake.js";
import { untrustedTurn, unmarkedNote, untrustedWords } from "../factory/untrusted.js";
import { earlierContext, fileReport, fileReview, NO_REPO_SHOTS, ReviewCommands } from "../factory/review.js";
import type { Fact } from "../factory/types.js";
import { DeploymentFull, ENVIRONMENT_SLOT_WAIT, PLATFORM_RESTART, SandboxConnectionLost, sandboxConnectionLost, observeSandbox } from "../sandbox/api.js";
import { remoteLease, type RemoteLease } from "../sandbox/relay-leases.js";
import { StartClock, keepStartTimes, startTimesLog } from "../start-times.js";
import { AcpPromptRequired } from "../sandbox/acp-harness.js";
import { initialSessionModes } from "../sandbox/profiles.js";
import { codexModes, innerModesReason, SANDBOX_ESCAPE_REFUSED } from "../sandbox/codex-modes.js";
import { windlassProvider, hostedKeyMessage, hostedProvider, selectedKey, usableKeys, withSettingsKeys, harnessName, itemModeOf, itemSignInChanged, itemSignInMessage, machineHarness, machineHarnesses, initialHarnessModels, machineLoginMessage } from "../sandbox/harnesses.js";
import { stepLimitNote } from "../sandbox/platform-steps.js";
import { capabilitiesOf, harnessOf } from "../sandbox/harness.js";
import { privateSessionData } from "../sandbox/session-data.js";
import type { ItemPublishAnswer } from "./work-item.js";
import { fetchBase, sessionRepository } from "../github/publish.js";
import { CRASHES_ALLOWED, type PauseReason, type TurnRun, type TurnCredential, addUsage, crashCount, pausedLine, resumePrompt, restartShellResult, resumedLine, segmentLimit, sessionWholeTask } from "./turn-resume.js";
import { ConversationLost } from "../runner/channel.js";
import { type EndedFact, type InboxRow, reviewEndedFactOf, INBOX_TABLES, itemTurnText, OUTBOX_ACTION, deliveryOf, endedFact, endedFactOf, flushOutbox, inboxRow, machineUnavailable, markEnded, markTaken, publishReceipt, queueMessage, receive, rememberPublish, requestTurn, requeue, rowOfTurn, sendOutbox, settleTokenReceipts, turnFlags, waitingRows, withdrawWaiting } from "./session-inbox.js";
import { persist, note, append, serial, writeItems, insertItems, keepDelta, acpRecorder, onWindlassEvent, writeMeta } from "./agent-session/timeline.js";
import { orNull, RECALL_WAIT_MS, str, takeQuestion, duration, abortTurn, askQuestion, askServer, serverKey, ago, rememberServer, knowServers, sealTurn, sessionServers, serverApprovals, serversChanged } from "./agent-session/questions.js";
import type { Ctx, SessionMeta, HeldSecrets, ActiveTurn, WorkspaceCopy, PublishAnswer, Asked, PromptAnswer, FeedbackPrompt, SessionVars } from "./agent-session/state.js";
import { runnerLink, layerOf, machineOf, durableTurns, isRunnerSocket } from "./agent-session/runner.js";
import { publish, repositoryOf, summaryOf, report } from "./agent-session/summary.js";
import { restoreBackup, platformNotes, saveBackup, removeBackup } from "./agent-session/workspace.js";

export { acpRecorder } from "./agent-session/timeline.js";

const CLONE_TIMEOUT_MS = 3 * 60 * 1000;
/** How long one turn may run before the platform stops it. WLP_TURN_TIMEOUT_MS overrides it. */
const TURN_TIMEOUT_MS = config.turnTimeoutMs;
const GIT_TIMEOUT_MS = 30 * 1000;
const MAX_DIFF_CHARS = 400_000;
/** How long a positive ChatGPT sign-in check is trusted before a prompt asks again. */
const SIGNED_IN_FRESH_MS = 5 * 60 * 1000;
/** How long shutdown waits for a stopped turn to wind down. */
const STOP_WAIT_MS = 10_000;
/** How long the end of a turn waits for the `user` actor to take the new summary. */
const REPORT_WAIT_MS = 5_000;
/** A slow machine actor may delay profile availability, but the session timeline must still open. */
const PROFILE_WAIT_MS = 2_000;

// Reserve shutdown time for both SQLite saves after the bounded waits.
export const SHUTDOWN_GRACE_MS = 20_000;
const SUSPEND_WAIT_MS = 4_000;
const SETTLE_WAIT_MS = 2_000;
const SLEEP_MARGIN_MS = 4_000;
if (STOP_WAIT_MS + SUSPEND_WAIT_MS + SETTLE_WAIT_MS + SLEEP_MARGIN_MS > SHUTDOWN_GRACE_MS) {
	throw new Error("The waits of going to sleep add up to more than the shutdown grace period.");
}

/** How long a setup run's output gathers before it is sent on, and how much of it makes it go at once. */
const SETUP_FLUSH_MS = 120;
const SETUP_FLUSH_CHARS = 8_000;
const SIGN_IN_REMEDY = "Sign in with ChatGPT again, then send the prompt once more.";
const WINDLASS_OUTCOMES: readonly TurnOutcome[] = ["succeeded", "unresolved", "failed", "stopped", "interrupted"];

/** Agent-session sockets can outlive a browser login and can be served on a different host. */
async function sessionCaller(c: { key: string[]; client(): unknown }, params: unknown) {
	const caller = authenticate(c.key, params);
	if (caller.kind === "user") checkGeneration(caller, await userActor(c, c.key[0]).internalTokenGeneration());
	return caller;
}

/** The caller, who must be the session's user; answers with their id. */
async function requireSessionUser(c: { key: string[]; vars: SessionVars; client(): unknown; conn?: { params: unknown } | null }): Promise<string> {
	const caller = await sessionCaller(c, c.conn?.params);
	if (caller.kind !== "user") throw new UserError("This action is for users.", { code: "forbidden" });
	if (c.vars.meta?.readiness) throw new UserError("Open Repo setup on the repository overview.", { code: "forbidden" });
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

function liveMeta(c: Ctx): SessionMeta {
	const meta = c.vars.meta;
	if (!meta || c.vars.destroying) throw new UserError("That agent does not exist.", { code: "session_not_found" });
	return meta;
}

function noteSandbox(c: Ctx, meta: SessionMeta, state: SessionMeta["sandbox"], use: string | null = useOf(meta), pausedAt?: number): void {
	// Close only the metered use the state read observed. A new hold may have arrived meanwhile.
	if (state !== "running" && meta.meter && !c.vars.turn && !c.vars.accepting) void closeMeter(c, meta, "found", use, pausedAt);
	if (meta.sandbox === state) return;
	meta.sandbox = state;
	publish(c);
	void persist(c);
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

// Status must avoid the workspace index lock while the agent runs Git.
export const STATUS_COMMAND = `${WORKSPACE_GIT_START}\ngit --no-optional-locks status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all`;

// Include untracked files through a private temporary index.
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

// Report each blocked host once per restricted sandbox.
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
export async function readyRecipe(c: Ctx, meta: SessionMeta, secrets: HeldSecrets | null, plan: SnapshotPlan | null, purpose: "claim" | "seed" | "resume" = "claim", getApp = githubApp): Promise<SpareRecipe | undefined> {
	if (!meta.repoUrl || !spareProfile(meta.profile, meta.harness) || meta.environmentBuild ||
		(purpose !== "resume" && (meta.windlassSessionId || meta.pushedHead)) || meta.origin?.role === "reviewer" || meta.origin?.owns !== undefined || plan?.writer) return;
	if (!meta.repo) return spareRecipe({ url: meta.repoUrl }) ? { url: meta.repoUrl } : undefined;
	const repo = meta.repo, project = setupProjectOf(meta), app = getApp();
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

function usesScreenshotImage(meta: SessionMeta, sandbox: SandboxHandle, allowed = false): boolean {
	return sessionSandboxInput(meta, allowed).screenshots === true && (meta.place.kind === "hosted" || sandbox.runnerScreenshots === true);
}

/** Connects to the session's sandbox for a turn, creating it (and cloning the repository) when needed. */
async function openSandbox(c: Ctx, meta: SessionMeta, turn: number, signal: AbortSignal, layer: SandboxLayer, secrets: HeldSecrets | null, allowSnapshot = true): Promise<SandboxHandle> {
	let plan: SnapshotPlan | null = null;
	let recipe: SpareRecipe | undefined;
	let ready = false;
	// A setup cut off with the server is being stopped: let it finish first, or it could stop this turn's processes.
	await c.vars.setupReap;
	// Preserve hosts allowed after this turn read the repository list.
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
	// Accept positive ownership evidence only. Older runners may omit it.
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
			// Claim the place at creation if the reservation did not already claim it.
			const place = await userActor(c, meta.uid).internalClaimPlace(meta.sessionId, meta.hostedSize);
			if (!place.ok) throw new TurnProblem("numbers" in place ? sandboxRefusal(place.numbers) : "The agent was deleted.");
			if (applySandboxClamp(meta, place.clampedSize, text => note(c, turn, "info", text))) {
				await persist(c);
				// The previous sandbox disappeared, or the plan changed since the reserve. Trade its hold at the new weight.
				await holdSandbox(c, meta, false);
			}
		}
		// In the user's words: where, and Strict or Open. The provider and its layers are in the panel's "How it's isolated".
		const isolation = layer.sandboxes.profile(meta.profile).name;
		note(c, turn, "info", meta.place.kind === "hosted" ? `Starting a hosted sandbox (${isolation})` : `Starting on ${meta.machineName ? `‘${meta.machineName}’` : "your machine"} (${isolation})`);
		// Hold the layer before awaiting the create. Concurrent deletion can invalidate actor state.
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
			mirrorRepo: !meta.readiness && meta.repo ? String(meta.repo.id) : undefined, ...connectOptions(meta) });
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
		if (!handle) throw new SandboxConnectionLost("The new sandbox disappeared right after it was created.");
		c.vars.startClock?.sandbox(Date.now() - making, true, handle.runnerStart);
		// The repository's environment at this place: its image went missing (stale, build again), or it has none yet (build one).
		if (!meta.environmentBuild && meta.repo && secrets?.snapshotSetup && canReuseSnapshot(snapshotsFor(meta.place), meta.harness, secrets.opened.length)) {
			const kind = secrets.environment?.usable ? (plan && !handle.snapshot ? "missed" : null) : "cold";
			if (kind) void c.keepAwake(userActor(c, meta.uid).internalEnvironmentNudge(meta.sessionId, kind, usesScreenshotImage(meta, handle, secrets.screenshots)).catch(() => undefined));
		}
		// Recorded for this sandbox from what it has, not from what the provider would make now.
		meta.ownDataSandbox = handle.ownData ? id : null;
		if (meta.windlassSessionId && (await privateSessionData(meta, layer.sandboxes, id))) {
			// Restore memory before starting the agent in its replacement sandbox.
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

	// A requested review opens its own read-only tree, without running repository setup.
	if (meta.readiness || active?.item?.row.checkout?.requested) return handle;

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

type MachineFacts = import("./machine.js").MachineFacts;
type OfferedHarness = NonNullable<NonNullable<MachineFacts["report"]>["harnesses"]>[number];

export async function turnCredential(c: Ctx, meta: SessionMeta, offered: OfferedHarness | undefined, model: string, signal?: AbortSignal, pinned?: TurnCredential): Promise<TurnCredential> {
	if (pinned) {
		const key = pinned.key;
		if (key && meta.place.kind === "machine" && machineHarness(meta.harness) && !offered?.keyRelay)
			throw new UserError("This runner cannot relay the Settings key for the paused turn.", { code: "harness_signed_out" });
		if (key && await modelKeyActor(c, meta.uid).internalModelKeyGeneration(key.provider) !== key.generation)
			throw new UserError("The Settings key for this turn changed or was removed. Start a new turn.", { code: "harness_signed_out" });
		return pinned;
	}
	const hosted = meta.place.kind === "hosted";
	const harness = meta.harness ?? "windlass";
	if (harness === "windlass") {
		const provider = windlassProvider(model);
		if (!provider) return { model };
		const generation = await modelKeyActor(c, meta.uid).internalModelKeyGeneration(provider);
		if (!generation) throw new UserError(hostedKeyMessage(harness, model), { code: "harness_signed_out" });
		return { model, key: { provider, generation } };
	}
	if (!hosted && !offered?.keyRelay) return { model };
	const keyActor = modelKeyActor(c, meta.uid);
	const [keys, source] = await Promise.all([keyActor.internalModelKeys(), meta.place.kind === "machine" ? keyActor.internalCredentialSource(meta.place.machineId, harness) : null]);
	// On a machine its own sign-in serves its providers first, unless the owner chose keys (`usableKeys`).
	const providers = hosted || !offered ? keys.map(k => k.provider) : usableKeys(offered, keys.map(k => k.provider), source ?? undefined);
	if (harness === "opencode" && model === "default") {
		if (meta.place.kind === "machine" && providers.length)
			model = await runnerLink(c, meta.place.machineId).request("openCodeDefault", { providers }, { signal });
		else if (hosted) model = meta.harnessModels?.defaultModel ?? model;
	}
	const provider = hosted ? hostedProvider(harness, model, providers) : selectedKey(harness, model, providers);
	if (hosted && !provider) throw new UserError(hostedKeyMessage(harness, model), { code: "harness_signed_out" });
	const key = keys.find(k => k.provider === provider);
	// An explicit switch to a key, or a fallback from a filed key, uses this turn's billing method.
	if (offered && meta.origin && (meta.origin.filedWithKey || (key && source === "key"))) {
		const effective = withSettingsKeys(offered, provider ? [provider] : []);
		return { model, key, itemSignIn: effective.method };
	}
	return { model, key };
}

/** Persist admission before any server forwards the request. A resumed segment inherits the balance. */
export function takeTurnRequest(c: Ctx, meta: SessionMeta, run: TurnRun, active: ActiveTurn) {
	return serial(c, async () => {
		if (active.controller.signal.aborted || meta.run !== run || c.vars.turn !== active || !run.remainingRequests) return false;
		run.remainingRequests--;
		await c.db.execute("UPDATE meta SET data = json_set(data, '$.run.remainingRequests', ?) WHERE id = 1", run.remainingRequests);
		return true;
	});
}

function itemSignInRefusal(meta: SessionMeta, facts: MachineFacts, offered: OfferedHarness | undefined, credential: TurnCredential) {
	const machine = machineHarness(meta.harness);
	if (!machine || !facts.report) return null;
	if (!offered) return `This machine does not offer ${machine.name}.`;
	const effective = withSettingsKeys(offered, credential.key ? [credential.key.provider] : []);
	return itemSignInMessage(machine, facts.name, effective.signIn) ?? itemSignInChanged(machine, facts.name, credential.itemSignIn ?? meta.origin?.signIn, effective.method);
}

// Acquire before awaiting. Idle cleanup cannot run while a reader, publisher or turn owns the sandbox.
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

// Reading a paused workspace restarts its idle clock.
function markUsed(c: Ctx, meta: SessionMeta): void {
	if (c.vars.turn) return;
	meta.lastUsedAt = Date.now();
	delete meta.pauseNow;
	armMeter(c, meta);
	void c.keepAwake(armIdle(c, meta));
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

// A setup command can write a secret to a file. Redact the diff before caching it.
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

// Reuse the saved workspace between turns. A live read may need to resume the sandbox.
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

// Sweep only this session's orphaned sandboxes. A create may finish after its actor disappears.
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

/** How long GitHub's word on the pull request's state is taken before it is asked again. */
const PULL_FRESH_MS = 20_000;

/** What clients see of the repository: all of it but the installation, which is the platform's own matter. */
// Open sealed values only in this session and keep plaintext out of metadata and timeline items.
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
	if ((meta.readiness || meta.origin?.role === "reviewer") && (closed.length || shut.length || sealed.project !== project?.key)) throw new TurnProblem("The platform could not read all saved secrets to redact this review.");
	if (capabilitiesOf(meta.harness).events === "acp" && (closed.length || shut.length)) throw new TurnProblem("The platform could not read all saved values to redact the harness session.");
	// Every value is taken out of what is shown, also one of the account's that a secret of the repository stands in for.
	return {
		unopened: turn === null ? unopened : [],
		requestedNames: sealed.requestedNames,
		snapshotSetup: project && sealed.project === project.key ? sealed.snapshotSetup : undefined,
		environment: project && sealed.project === project.key ? sealed.environment : undefined,
		screenshots: sealed.screenshots === true,
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

/** The user's GitHub connection as their actor has it now: asked each time, so a connection that was removed stops working at once. */
function githubConnection(c: Ctx, meta: SessionMeta): Promise<StoredConnection | null> {
	return userActor(c, meta.uid).internalGithubConnection();
}

/** The work item owns its parent link, including for older sessions without owned-path metadata. */
async function childSetupSeed(c: Ctx, meta: SessionMeta): Promise<string | undefined> {
	if (!meta.origin || meta.origin.role === "reviewer") return undefined;
	return (await itemActor(c, meta.uid, meta.origin.itemId).internalSetupSeed("child")) ?? undefined;
}

// Scope the clone token to the resolved repository and revoke it after clone.
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

// Run setup on the base before switching to the session's published work.
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

// Run the saved setup on each new clone. Record failures for the next prompt without failing the turn.
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
	if (result.cleanupPending && !meta.environmentBuild) throw new TurnProblem("The platform could not stop leftover setup processes. Send the prompt again to retry cleanup.");
	if (meta.environmentBuild) {
		const report = await buildEnvironment(c, meta, turn, sandbox, signal, secrets, plan, layer, { result, output, original: original ?? null, command });
		c.vars.environmentResult ??= report;
	}
}

// Setup and environment failures block promotion. A check that fails on the base code is recorded with the image.
async function buildEnvironment(c: Ctx, meta: SessionMeta, turn: number, sandbox: SandboxHandle, signal: AbortSignal, secrets: HeldSecrets | null, plan: SnapshotPlan | null, layer: SandboxLayer,
	setup: { result: Awaited<ReturnType<typeof runSetupCommand>>; output: string; original: string | null; command: string }): Promise<EnvironmentBuildReport> {
	const commit = setup.original ?? meta.repo?.baseSha ?? "";
	const base: EnvironmentBuildResult = { finishedAt: null, commit: /^[a-f0-9]{40}$/.test(commit) ? commit : "", image: sandbox.image ?? "", ...(usesScreenshotImage(meta, sandbox, secrets?.screenshots) && { screenshots: true }), checks: [], failure: null, snapshot: false };
	// Builds own a fresh sandbox. A recorded memory kill is a failure even if its connection also broke.
	const memoryFailure = async (): Promise<EnvironmentBuildResult | null> => {
		const events = await sandbox.memoryEvents?.().catch(() => null);
		const exhausted = events ? events.oomKills > 0 : await sandbox.memoryPeak?.(meta.turnStartedAt ?? meta.createdAt).catch(() => null);
		return sandbox.outOfMemory || exhausted
			? { ...base, failure: { kind: "setup", check: null, line: "The build ran out of memory.", excerpt: "" } } : null;
	};
	if (setup.result.state !== "succeeded" || setup.result.cleanupPending) {
		const memory = await memoryFailure();
		if (memory) return memory;
		const commandFailed = setup.result.state === "timed_out" || (setup.result.exitCode !== null && setup.result.exitCode !== 0);
		if (!commandFailed && (signal.aborted || setup.result.state === "stopped" || setup.result.connectionLost ||
			await layer.sandboxes.state(sandbox.id).catch(() => null) === "none")) return { interrupted: true };
		const how = setup.result.state === "timed_out" ? "ran out of time" : setup.result.exitCode !== null ? `exited with ${setup.result.exitCode}` : "did not finish";
		return { ...base, finishedAt: Date.now(), failure: { kind: "setup", check: null, line: `The setup command ${how}.`, excerpt: outputExcerpt(setup.output) } };
	}
	const checks = secrets?.checks ?? [];
	// Files the checks write (build outputs, caches the repository ignores) stay; tracked files they change go back.
	const unavailable = (error: unknown) => {
		if (sandboxConnectionLost(error)) throw error;
		return null;
	};
	const clean = (await sandbox.run("git status --porcelain", { cwd: sandbox.cwd, timeoutMs: 60_000, signal }).catch(unavailable))?.stdout.trim() === "";
	note(c, turn, "info", checks.length ? `Validating: running ${checks.length === 1 ? "the saved check" : `the ${checks.length} saved checks`}.` : "No checks are saved, so the environment is validated by its setup alone.");
	const ran = await new PlatformChecks(sandbox, checks, () => undefined, { agent: "the build", redactor: secrets?.redactor, signal }).runAll();
	const judged = judgeChecks(ran);
	for (const r of judged.checks) note(c, turn, r.status === "passed" ? "info" : "warn", `${r.name}: ${r.status.replace("_", " ")}${r.environment ? ` (the sandbox could not run it: ${r.environment.replace("_", " ")})` : ""}.`);
	const done = { ...base, checks: judged.checks, ...(judged.codeFailures.length && { codeFailures: judged.codeFailures }) };
	if (ran.some(r => r.status !== "passed") || signal.aborted) {
		const memory = await memoryFailure();
		if (memory) return memory;
		if (judged.failure && ran.some(r => r.name === judged.failure?.check && (r.status === "timed_out" || r.exitCode !== null))) {
			return { ...done, finishedAt: Date.now(), failure: judged.failure };
		}
		if (ran.some(r => r.status === "interrupted") || signal.aborted ||
			(ran.some(r => r.status === "could_not_start" || (r.status === "failed" && r.exitCode === null)) &&
				await layer.sandboxes.state(sandbox.id).catch(() => null) === "none")) return { interrupted: true };
	}
	if (judged.failure) return { ...done, finishedAt: Date.now(), failure: judged.failure };
	if (clean) await sandbox.run("git reset -q --hard HEAD && git clean -fdq", { cwd: sandbox.cwd, timeoutMs: 120_000, signal }).catch(unavailable);
	if (signal.aborted) return { interrupted: true };
	// A quick setup is validated, and keeps no image: starting cold costs little more than starting from one.
	if (setup.result.durationMs < config.snapshotMinSetupMs) return { ...done, finishedAt: Date.now() };
	const saveFailed = (line: string): EnvironmentBuildReport => signal.aborted ? { interrupted: true }
		: { ...done, finishedAt: Date.now(), failure: { kind: "save", check: null, line, excerpt: "" } };
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
	const saved = await layer.sandboxes.saveSnapshot(sandbox.id, { ...plan.key, inputs, commit: setup.original, created: began }).catch(unavailable);
	if (!saved && (signal.aborted || await layer.sandboxes.state(sandbox.id).catch(() => null) === "none")) return { interrupted: true };
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

// A clean worktree can still hold unpublished commits.
async function unpushedWork(c: Ctx, meta: SessionMeta, repo: StoredRepository, files: WorkspaceFile[] | null): Promise<boolean | null> {
	if (c.vars.turn || !meta.sandboxId) return null;
	if (files && files.length > 0) return true;
	const key = `${meta.turns}:${repo.baseSha ?? ""}:${meta.pushedHead ?? ""}:${meta.sandboxId}`;
	if (c.vars.unpushed?.key === key) return c.vars.unpushed.value;
	// Cache the observation only for the turn and push head it describes.
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
	meta.updatedAt = Date.now();
	publish(c);
	void persist(c);
}

/** A push's line in the timeline: what went where, in the words of the other platform notes. */
function publishedLine(repo: StoredRepository, pull: PullRequestInfo, opened: boolean, files: number | null): string {
	const what = files === null ? "the work" : files === 0 ? "the agent's commits" : files === 1 ? "1 file" : `${files} files`;
	if (opened) return `Opened pull request #${pull.number} in ${repo.owner}/${repo.name} from ${pull.branch}${files === null ? "" : `, with ${what}`}.`;
	return `Pushed ${what} to ${pull.branch}; pull request #${pull.number} is updated.`;
}

async function evidenceOf(c: Ctx, meta: SessionMeta, during: number | null): Promise<PublishEvidence> {
	const held = c.vars.turn?.secrets ?? (await readSecrets(c, meta, null));
	return { verified: meta.verified ?? null, during, checks: held.checks, redact: (text) => held.redactor.text(text), machine: machineOf(meta) };
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

// The caller owns the publishing lock so a second push cannot race this one.
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

/** A push's line for a request of the agent's, which may also have given an open pull request another title and description. */
function agentPublishedLine(repo: StoredRepository, published: Published): string {
	const { pull } = published;
	if (!published.pushed && published.retitled) return `Gave pull request #${pull.number} the title and description the agent wrote; there was nothing new to push.`;
	const line = publishedLine(repo, pull, published.opened, published.committedFiles);
	return published.retitled ? `${line.replace(/\.$/, "")}, with the title and description the agent wrote.` : line;
}

// A publish question shares the tool-call question slot and ends with the request or turn.
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

// Only publish the session's repository and branch. Approval scope depends on the caller's isolation.
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

// An agent push can race turn closure. Track it until the commit, push and receipt finish.
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

// Fetch the session's configured base using a repository-scoped read token.
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

/** How long the user's meter may take to answer before a prompt gives up on it, and a running sandbox goes on without the answer. */
const METER_WAIT_MS = 10_000;
/** How long after a call to the meter that failed, or that found the session in the middle of something, the session looks again. */
const METER_RETRY_MS = 15_000;
/** How long after the moment the provider stops an unused sandbox the session asks whether it did. */
const IDLE_STOP_MARGIN_MS = 3_000;
/** How many reports of sandbox time a session keeps to send again. */
const MAX_UNSETTLED = 20;

// Identify the use by its reservation so a stale stop cannot settle its replacement.
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

// A carried hold is valid only while its use and sandbox generation still match.
function carriedOver(c: Ctx, meta: SessionMeta): boolean {
	const carried = c.vars.carried;
	return carried !== null && carried.use === useOf(meta) && carried.gen === c.vars.sandboxGen;
}

// Write the request ID before reserving time. Reuse it if the response is lost. Call only from inside `metered`.
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
	// A carried hold may have stopped at the provider before this actor woke.
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

// Acquire time and any new place before starting the sandbox.
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

// Bound renewal by the provider's idle timeout as well as the user's hold.
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

// Recheck the observed use after reading the provider. Another operation may have replaced the hold.
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

// Stop the active turn before its sandbox consumes unreserved time.
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

// Suspend first so settlement uses the actual pause time when the provider supplies one.
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

// Keep the settlement until the user's meter acknowledges its idempotent receipt.
// Call only from inside `metered`: it does not take the queue itself.
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

// A provider-observed stop can precede the actor's own clock.
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

// An idle sandbox that stays running still needs a hold.
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

// Inspect the provider before charging time that elapsed while the actor slept.
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

// Reconcile a lost reservation response before a new turn can ask for another hold.
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

/** How long a check that failed, or found a prompt being accepted, waits before it looks again. */
const IDLE_RETRY_MS = 60_000;

// Never remove a user's machine sandbox merely because this actor was idle.
function removedWhenIdle(meta: SessionMeta): boolean {
	return meta.place.kind === "hosted";
}

/** When the sandbox is next due: to be suspended while it runs, to be removed while it exists. Null when there is none. */
function idleDue(meta: SessionMeta): number | null {
	if (!meta.sandboxId) return null;
	if (meta.sandbox === "running") return meta.lastUsedAt + (meta.pauseNow ? 0 : config.idleSuspendMs);
	return removedWhenIdle(meta) ? meta.lastUsedAt + config.idleDestroyMs : null;
}

// Serialize schedule replacement so an older request cannot cancel a newer idle check.
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
		startNextFeedback(c, meta);
		// A build reports once its turn has closed: the user's actor deletes the session on it.
		if (meta.readiness) reportAssessment(c, meta);
		if (meta.environmentBuild) {
			const result = c.vars.environmentResult ?? { interrupted: true };
			void c.keepAwake(userActor(c, meta.uid).internalEnvironmentResult(meta.sessionId, result).catch(error =>
				c.log.warn({ msg: "could not report the environment build", error: describeError(error) })));
		}
	}
}

function reportAssessment(c: Ctx, meta: SessionMeta) {
	void c.keepAwake(userActor(c, meta.uid).internalReadinessResult(meta.sessionId, meta.readiness?.result ?? null).catch(error =>
		c.log.warn({ msg: "could not save the readiness assessment", error: describeError(error) })));
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
	if (meta.place.kind === "hosted" && billing(meta.uid)) return userActor(c, meta.uid).internalHostedSizes();
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

function refuseItemPolicy(item: ActiveTurn["item"], reason: string): never {
	if (item) {
		item.refused = reason;
		item.policyRefusal = true;
	}
	throw new TurnProblem(reason);
}

function secretRequestHandler(
	c: Ctx, meta: SessionMeta, turn: number, item: ActiveTurn["item"],
	redactor: Redactor, acp: boolean, isOpen: () => boolean,
): NonNullable<RunTurnInput["onRequestSecret"]> {
	return async (request, withdrawn) => {
		const refuse = async (message: string) => {
			const scope = item ? item.row.key.split(":").slice(0, 2).join(":") : "session";
			if (meta.secretRefusalRun !== scope) {
				meta.secretRefusalRun = scope;
				note(c, turn, "warn", "A secret request was refused.");
				await persist(c);
			}
			return message;
		};
		const validate = () => requestSecret(request.arguments, !!item?.asked || !!meta.secretRequest, !!meta.secretRequestBlocked || !!meta.tainted, redactor);
		if (!isOpen() || withdrawn.aborted) return "The call ended. Nothing was recorded.";
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
					await writeMeta(c, meta);
				}
			}
			if (!problem && !taken.request) problem = taken.told;
			if (!problem) problem = await secretsActor(c, meta.uid, meta.sessionId).internalRequestedSecretConflict(meta.sessionId, name);
		} catch {
			problem = "The platform could not check this secret request. Try again.";
		}
		if (!isOpen() || withdrawn.aborted) return "The call ended. Nothing was recorded.";
		if (problem) return refuse(problem);
		// Another tool call or a third-party event may have landed during the lookups.
		const current = validate();
		if (!current.request) return refuse(current.told);
		const notice = secretRequestNotice(acp, !setupProjectOf(meta));
		const secretRequest = { ...current.request, notice, id: String(turn) };
		meta.secretRequest = secretRequest;
		append(c, { turn, kind: "platform", level: "info", text: `A secret was requested for ${name}.\n${notice}`, secretRequest });
		await persist(c);
		return current.told;
	};
}

async function executeTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn, text: string, release: () => void, machine: ReturnType<typeof machineActor> | null): Promise<void> {
	const startedAt = Date.now();
	const turn = active.number;
	const effort = active.effort;
	// A work item keeps its profile's approval (Windlass), or its agent's mode for the profile that never asks (harnesses.ts, `itemModes`).
	const mode = meta.origin ? itemModeOf(meta.harness, meta.profile) : meta.mode;
	const reviewer = meta.origin?.role === "reviewer";
	const checkout = active.item?.row.checkout;
	const requested = checkout?.requested;
	const critic = reviewer && active.item?.row.agent === "critic";
	// Apply the same untrusted-source policy to an original prompt and its resume fallback.
	let untrusted = active.item?.row.untrusted ?? active.untrusted ?? meta.run?.untrusted ?? [];
	let outsideText = untrusted.length > 0 || !!active.item?.row.fresh?.untrusted.length;
	let handling = untrustedTurn({ agent: meta.harness ?? "windlass", profile: meta.profile, untrusted, unsandboxed: active.item?.row.unsandboxed });
	/** Refuses the turn on "Docker, hardened" for someone else's text in `retryText`; the item asks, and can run it anyway. */
	const refuseUntrusted = (item: ActiveTurn["item"], stop: Extract<typeof handling, { kind: "stop" }>, retryText: string): never => {
		if (!item) {
			const reason = `The GitHub feedback prompt was not run because commands run directly in the sandbox and the prompt contains ${stop.sources.join(", ")}. You can review the feedback and send your own instructions.`;
			note(c, turn, "warn", reason);
			throw new TurnProblem(reason);
		}
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
	// Reattached runner channels can lose their grace period during slot acquisition.
	let lossesAtStart: number | null = active.reattach ? 0 : null;
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
	const account: AccountLocation = { place: meta.place.kind === "machine" ? meta.place.machineId : "hosted", harness: meta.harness ?? "windlass" as const };
	let generation: string | null = null;
	let itemSignIn = run?.credential?.itemSignIn ?? meta.origin?.signIn;
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
			if (meta.environmentBuild) c.vars.environmentResult ??= { finishedAt: Date.now(), commit: "", image: "", checks: [], snapshot: false,
				failure: { kind: "setup", check: null, line: "The build ran out of time.", excerpt: "" } };
			abortTurn(c, meta, active);
		}, limitMs);

		layer = await layerOf(c, meta);
		// A person's turn is checked when it is sent; nobody sends an item's. Refused before the sandbox opens: the item asks, with the login hint.
		const facts = meta.place.kind === "machine" && machineHarness(meta.harness) ? await runnerLink(c, meta.place.machineId).facts() : null;
		const offered = facts?.report?.harnesses?.find(h => h.id === meta.harness);
		const credential = active.credential ?? await turnCredential(c, meta, offered, meta.model, signal, run?.credential).catch(error => {
			if (!(error instanceof UserError) || error.code !== "harness_signed_out") throw error;
			return refuseItemPolicy(active.item, error.message);
		});
		const { model, key } = credential;
		itemSignIn = credential.itemSignIn ?? meta.origin?.signIn;
		if (run) {
			run.credential = credential;
			if (key && meta.place.kind === "hosted") run.remainingRequests ??= config.modelRelay.turnRequests;
			await writeMeta(c, meta);
		}
		const takeRequest = run?.remainingRequests !== undefined ? () => takeTurnRequest(c, meta, run, active) : undefined;
		const signedOut = active.item && facts ? itemSignInRefusal(meta, facts, offered, credential) : null;
		if (signedOut) refuseItemPolicy(active.item, signedOut);
		// Refuse unsafe outside text before acquiring secrets or opening the sandbox.
		if (handling.kind === "stop") refuseUntrusted(active.item, handling, active.item?.row.text ?? text);
		// Before anything is started: the setup command and Windlass are handed them, and what either says is shown without them.
		active.secrets ??= await readSecrets(c, meta, turn);
		for (const text of active.secrets.unopened.splice(0)) note(c, turn, "warn", text);
		opening = true;
		const sandbox = await openSandbox(c, meta, turn, signal, layer, active.secrets, !requested && !meta.readiness);
		opening = false;
		clock.opened();
		// A build's turn ends here: it starts no agent (`buildEnvironment` ran in the setup).
		if (meta.environmentBuild) {
			c.vars.environmentResult ??= signal.aborted ? { interrupted: true } : { finishedAt: Date.now(), commit: "", image: sandbox.image ?? "", checks: [], snapshot: false,
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
			// After an OOM restart, offer a larger size when available. Otherwise continue at the current size.
			active.item.outOfMemory = withLarger(sandbox.outOfMemory, await resizeOptions(c, meta, layer));
			if (active.item.outOfMemory.larger) throw new TurnProblem(sandbox.notice ?? outOfMemoryWords(sandbox.outOfMemory));
		}
		// What the turn is handed goes by what the session's harness can do, asked of this sandbox's.
		account.provider = key?.provider;
		generation = key?.generation ?? await userActor(c, meta.uid).internalProviderGeneration(account).catch(() => {
			c.log.warn({ msg: "Provider login generation unavailable for this turn" });
			return null;
		});
		const harness = harnessOf(layer, meta.harness ?? "windlass");
		const caps = await harness.capabilities(sandbox);
		const profile = layer.sandboxes.profile(meta.profile);
		const platformTool = (tool: (typeof caps.platformTools)[number]) => caps.platformTools.includes(tool);
		// The plan critic needs the restricted Windlass profile. Every reviewer needs its filing tool.
		if (reviewer && ((critic && !caps.restrictedReview) || (!critic && !checkout) || !platformTool(critic ? "file_plan_review" : "file_review"))) {
			const reason = "The reviewer’s filing tool is unavailable.";
			if (active.item) active.item.refused = reason;
			throw new TurnProblem(reason);
		}
		if (meta.readiness && (!caps.restrictedReview || !platformTool("report"))) throw new TurnProblem("The read-only setup tools are unavailable.");
		if (meta.demo && !caps.demo) throw new TurnProblem("This agent's harness has no demo mode.");
		if (active.item) await itemTurnStarted(c, meta, active.item, sandbox, turn);
		// Windlass freezes tools at the first prompt. Start summaries fresh, but resume a paused segment's conversation.
		const summary = active.item?.row.agent === "summary";
		if (summary !== !!meta.summaryConversation || (summary && !active.resume)) {
			meta.windlassSessionId = null;
			meta.summaryConversation = summary || undefined;
		}
		// Read after the sandbox is open: a sandbox made in place of a lost one has the session only when its copy was restored.
		resumed = critic || requested ? null : meta.windlassSessionId;
		// Reuse the task when its saved conversation did not survive replacement.
		if (active.resume && run?.prompted) {
			const whole = await wholeTask(c, meta, active, turn);
			outsideText ||= whole.untrusted.length > 0;
			const wholeHandling = untrustedTurn({
				agent: meta.harness ?? "windlass", profile: meta.profile, untrusted: whole.untrusted,
				currentSources: active.item ? whole.untrusted : untrusted, unsandboxed: whole.unsandboxed,
			});
			if (resumed) {
				untrusted = [];
				handling = untrustedTurn({ agent: meta.harness ?? "windlass", profile: meta.profile, untrusted, unsandboxed: active.item?.row.unsandboxed });
				if (wholeHandling.kind !== "stop") fresh = { prompt: whole.text, ...(wholeHandling.kind === "marked" && { untrusted: wholeHandling.sources }) };
			} else {
				text = whole.text;
				untrusted = whole.untrusted;
				handling = wholeHandling;
				if (handling.kind === "stop") refuseUntrusted(active.item, handling, whole.text);
				note(c, turn, "info", "The agent no longer has its earlier conversation of this turn, so it was given the whole task again.");
			}
		} else if (active.item) {
			// Without the previous conversation, continuing requires the whole task.
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
			...(key && { modelKey: { sessionId: meta.sessionId, key, takeRequest } }),
			prompt: text, mode, planMode:active.planMode, windlassSessionId: resumed ?? undefined, model, effort: effort ?? undefined, signal,
			onQuestion: active.item || meta.readiness ? undefined : (question, withdrawn) => askQuestion(c, meta, active, question, withdrawn),
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
		const planner = !!meta.readiness || critic || planning || item?.row.agent === "summary";
		// Told once, to whichever agent takes the next prompt: what setup left, and whether the workspace is a new one.
		const notes = platformNotes(meta, reviewer);
		const store = item ? attachmentStore() : null;
		if (planning) text += `\n\nSet needs.screenshots only for subtasks that change what users see and whose repository allows screenshots (${item.crossRepoPlan ? "the primary" : "this"} repository ${held.screenshots ? "allows" : "does not allow"} them).`;
		// A builder can reconnect to a sandbox created before a setting changed.
		const browser = !!item && !requested && caps.reportScreenshots && usesScreenshotImage(meta, sandbox, held.screenshots)
			&& (await sandbox.run("test -x /usr/local/bin/wlp-shot", { signal, timeoutMs: 5000 })).exitCode === 0;
		const unavailable = held.screenshots ? "Screenshots are unavailable in this sandbox. File without screenshots." : NO_REPO_SHOTS;
		let filings = Promise.resolve("");
		const setup = meta.readiness;
		const onReport: RunTurnInput["onReport"] = setup ? async (request, withdrawn) => {
			if (!open || withdrawn.aborted || setup.result) return "These setup checks have already been filed.";
			const answer = fileReadiness(request.arguments, held.redactor, report => { setup.result = report; });
			if (setup.result) await persist(c);
			return answer;
		} : item && !planning && !reviewer && platformTool("report") ? (request, withdrawn) => {
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
		const onRequestSecret: RunTurnInput["onRequestSecret"] = !planner && !reviewer && (!item || typeof item.row.asksLeft === "number") && platformTool("request_secret")
			? secretRequestHandler(c, meta, turn, item, held.redactor, caps.events === "acp", () => open)
			: undefined;
		// Only a builder with a remaining question allowance may ask its owner.
		const onAsk: RunTurnInput["onAsk"] = item && !planner && !reviewer && typeof item.row.asksLeft === "number" && platformTool("ask_person") ? (request, withdrawn) => {
			if (!open || withdrawn.aborted) return "The call ended. Nothing was recorded.";
			const taken = askPerson(request.arguments, { already: !!item.asked || !!meta.secretRequest, left: item.row.asksLeft ?? 0 }, held.redactor);
			if (taken.asked) item.asked = taken.asked;
			note(c, turn, taken.asked ? "info" : "warn", taken.said);
			return taken.told;
		} : undefined;
		// Repository tools remain bound to this session. MCP calls can originate anywhere in the container.
		const repoTools = !planner && !reviewer && !!meta.repo && githubApp() !== null;
		const onPush: RunTurnInput["onPush"] = repoTools && platformTool("push") ? (request) => tracked(agentPush(c, meta, active, sandbox, request)) : undefined;
		const onFetchBase: RunTurnInput["onFetchBase"] = repoTools && platformTool("fetch_base") ? (request) => agentFetchBase(c, meta, active, sandbox, request) : undefined;
		lossesAtStart ??= c.vars.runner?.channel.losses ?? null;
		agentStarted = true;
		const screenshots = browser && !!store;
		const listed: ReviewRecord[] = [];
		const commands = new ReviewCommands(held.redactor);
		let uiChanged = false;
		let filingFiles: (() => { read(path: string, sha: string): Promise<string>; close(): Promise<void> }) | null = null;
		let storedBrief: string | null = null;
		if (setup) {
			const app = githubApp(), repo = meta.repo, connection = await githubConnection(c, meta);
			if (!app || !repo || !connection) throw new TurnProblem("The repository connection is unavailable.");
			const { installation, repository } = await sessionRepository(app, connection, repo, "read");
			const { owner, name } = repository;
			common.reviewDirectory = await app.withToken(installation.id, { repositoryId: repo.id, permissions: { contents: "read", metadata: "read" } },
				token => readOnlyReview(sandbox, app.cloneUrl(owner, name), token, setup.commit, setup.commit, signal, true), { revokeAfter: true });
		}
		if (reviewer && (checkout || critic) && item) {
			const repo = meta.repo;
			const app = githubApp();
			if (!repo || !app || (!meta.cloned && !requested)) throw new ReviewRefused("the base clone is unavailable");
			const connection = await githubConnection(c, meta);
			if (!connection) throw new ReviewRefused("the repository connection is unavailable");
			const resolved = requested ? await resolveBoundRepository(app, connection, requested.repositoryId, requested.installationId, "read") : await sessionRepository(app, connection, repo, "read");
			const scope = { repositoryId: resolved.repository.id, permissions: { contents: "read", metadata: "read" } } as const;
			const { owner, name } = resolved.repository;
			let directory = meta.cloneDirectory ?? ".";
			if (checkout && requested) {
				directory = await app.withToken(resolved.installation.id, scope, token => readOnlyReview(sandbox, app.cloneUrl(owner, name), token, checkout.head, checkout.baseSha, signal), { revokeAfter: true });
				common.reviewDirectory = directory;
			} else if (checkout) await app.withToken(resolved.installation.id, scope, token => checkoutReview(sandbox, app.cloneUrl(owner, name), token, directory, checkout.pr, checkout.head, signal), { revokeAfter: true });
			if (caps.events === "windlass") {
				// Setup must not seed approvals in a reviewer's private data directory.
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
			}
			if (critic) {
				const list = `git -C ${shellQuote(directory)} ls-tree -r --name-only -z HEAD` +
					(item.crossRepoPlan ? ` && find ${shellQuote(INPUTS_DIRECTORY)} -mindepth 2 -type f -print0` : "");
				const tree = await sandbox.run(list, { signal, timeoutMs: 10000 });
				if (tree.exitCode !== 0 || tree.timedOut || tree.aborted || !tree.stdout.endsWith("\0")) throw new TurnProblem("The critic could not read the tracked repository tree.");
				text += "\n\nTracked repository tree: " + JSON.stringify(tree.stdout.split("\0").slice(0, -1));
			}
			if (checkout) {
				const paths = await changedReviewPaths(sandbox, directory, checkout.baseSha, checkout.head, !!requested);
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
				const brief = reviewerTask(held.redactor.deep({ ...checkout, mcp: caps.events === "acp", reviewDirectory: common.reviewDirectory, changed: groupReviewPaths(paths), uiChanged, manifestsChanged, screenshots }), listed, held.redactor.text(text));
				storedBrief = held.redactor.text(itemPrompt(item.row));
				text = brief;
			}
		}
		let calls = 0;
		const onReview: RunTurnInput["onReview"] = reviewer && item && checkout && filingFiles && platformTool("file_review") ? (request, withdrawn) => {
			const openFiles = filingFiles;
			const file = async () => {
				if (!open || withdrawn.aborted) return "The review call ended.";
				const args = request.arguments;
				if (request.via !== "mcp" && args?.commands === true) {
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
					meta.review = {
						...result.filing, id: item.row.key, run: Number(item.row.key.split(":")[1]), round: checkout.round,
						head: checkout.head, base: checkout.baseSha, verdictId: checkout.verdictId,
						by: { sessionId: meta.sessionId, model: meta.model, via: request.via ?? (caps.events === "windlass" ? "host" : "mcp"), commandSandbox: commandSandbox(profile) },
						at: Date.now(), state: "filed", said: null,
					};
					await persist(c);
				}
				item.said = result.answer;
				return result.answer;
			};
			filings = filings.then(file, file).catch(() => "The platform could not finish filing this review. Try again.");
			return tracked(filings);
		} : undefined;
		const launchInput = (): RunTurnInput => ({
			...common,
			prompt: notes.text + text,
			...(fresh && { fresh: { ...fresh, prompt: notes.text + fresh.prompt } }),
			checks: planner || reviewer ? [] : held.checks,
			maxSteps: reviewer ? RULES.reviewMaxSteps : active.item?.row.maxSteps,
			onReview, onReport, onAsk, onRequestSecret, onPush, onFetchBase,
		});
		if (!signal.aborted && caps.events === "acp") {
			// These agents take no marker: the text is labelled in the prompt, and the timeline says so once.
			if (handling.kind === "labelled") unmarked(handling.note);
			result = await harness.runTurn(sandbox, {
				...launchInput(),
				...(item && { unattended: true }),
				// Over MCP a publish is always put to the person, never "for this session": any process in the container may have asked.
				onPublish: repoTools && !item && platformTool("publish") ? (request, withdrawn) => tracked(agentPublish(c, meta, active, sandbox, "none", request, withdrawn)) : undefined,
				secrets: { env: Object.fromEntries((reviewer ? [] : meta.repo ? held.opened : held.account)
					.filter(s => s.scope === "agent" && held.requestedNames?.includes(s.name)).map(s => [s.name, s.value])),
					withholdEnv: [], passEnv: [], redactor: held.redactor },
				// ACP checks are run by the platform after the agent's prompt ends.
				forceChecks: item?.row.agent === "run_checks",
				onChecks: (event, said) => {
					if (event.type === "synthetic.appended" && event.data?.origin === "check_report") meta.secretRequestBlocked = true;
					active.checks.note(event);
					if (open && said) note(c, turn, said.level, said.text);
				},
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
			// Told of no source (above): the timeline says once that the text went labelled only.
			if (handling.kind === "labelled") unmarked(handling.note);
			result = await harness.runTurn(sandbox, {
				...launchInput(),
				// Windlass gets the secrets that keep to their scope in this sandbox, the repository's and the account's, with the names its commands are and are not to have; every saved value is taken out of what it says.
				secrets: { ...turnEnvironment(planner || reviewer ? [] : held.opened, planner || reviewer ? [] : held.account, profile), redactor: held.redactor },
				// Disable unasked personal-server calls once outside text taints the session.
				servers: planner || reviewer ? [] : (untrusted.length || meta.tainted) ? held.servers.map(server => ({ ...server, unasked: false })) : held.servers,
				// Windlass's question about a tool of one whose tools run without asking: the layer answers it, and the timeline says for whom and why.
				onUnasked: (call) => {
					if (open) note(c, turn, "info", unaskedNote(str(call.server)), { code: "question_allowed", call: { messageId: str(call.messageId), callId: str(call.callId) } });
				},
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
				planner,
				repoSetup: !!meta.readiness,
				clearPlanner,
				crossRepoPlan: planning && item?.crossRepoPlan === true,
				onPlan: planning && item ? (request) => tracked(itemActor(c, meta.uid, item.row.itemId).internalFilePlan({ key: item.row.key, plan: held.redactor.deep(request.arguments) })) : undefined,
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
						onWindlassEvent(c, meta, turn, event, key);
					} catch (error) {
						c.log.error({ msg: "could not record a Windlass event", error: describeError(error) });
					}
				},
				onPublish: repoTools && !active.item && platformTool("publish") ? (request, withdrawn) => tracked(agentPublish(c, meta, active, sandbox, commandSandbox(profile), request, withdrawn)) : undefined,
				// The project's own MCP servers, which Windlass leaves stopped until the user says otherwise; nobody can say so in an item's turn.
				onServerQuestion: meta.readiness ? async () => false : active.item
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
					// Save new approvals only after Windlass accepts them. Recalled approvals do not renew the grant.
					if (!recalled && (outcome.state === "running" || outcome.state === "starting" || outcome.state === "failed")) void rememberServer(c, meta, named);
				},
				onServers: (said) => {
					if (open) knowServers(c, meta, said);
				},
			});
			// On a checks-only delivery run every saved command the native diff-based gate omitted.
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
		if (meta.environmentBuild && !c.vars.environmentResult) {
			if (opening && isSandboxUserError(error) && error.message === ENVIRONMENT_SLOT_WAIT) {
				c.vars.environmentResult = { waiting: ENVIRONMENT_SLOT_WAIT };
			} else if (signal.aborted || sandboxConnectionLost(error) ||
				(opening && meta.sandboxId && await layer?.sandboxes.state(meta.sandboxId).catch(() => null) === "none")) {
				c.vars.environmentResult = { interrupted: true };
			} else {
				c.vars.environmentResult = { finishedAt: Date.now(), commit: "", image: "", checks: [], snapshot: false,
					failure: { kind: "setup", check: null, line: "The build could not start its sandbox.", excerpt: "" } };
			}
		}
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
			// Only failures preparing the sandbox count here. Capacity, connectivity and policy refusals are classified separately.
			if (active.item && opening && !active.item.refused && !(error instanceof TurnProblem) && !(error instanceof DeploymentFull) && !(error instanceof MachineUnreachable)) active.item.sandboxFailed = clean(isSandboxUserError(error) ? error.message : describeError(error));
			if (error instanceof TurnProblem) c.log.warn({ msg: "turn failed", session: meta.sessionId, turn, error: clean(error.message) });
			else c.log.error({ msg: "turn failed", session: meta.sessionId, turn, error: clean(error instanceof Error ? (error.stack ?? error.message) : String(error)) });
		}
	}
	try {
		await active.finishNetwork?.();
	} finally {
		// The image outlives its source. Dispose of the build here even if its result never reaches the user actor.
		if (meta.environmentBuild && layer) await destroySessionSandboxes(c, meta).catch(error =>
			c.log.warn({ msg: "could not remove the environment build sandbox", error: describeError(error) }));
	}
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
	// Losing the runner pauses the turn unless another stop already won.
	const lostLink = (lossesAtStart !== null && (c.vars.runner?.channel.losses ?? 0) > lossesAtStart)
		|| ((agentStarted || active.resume !== undefined || active.item?.started === true) && (thrown instanceof ConversationLost || (thrown instanceof MachineUnreachable && thrown.reason === "offline")));
	if (run && meta.place.kind === "machine" && !signal.aborted && lostLink) active.pausing ??= "machine";
	// A turn that ended by itself just as the server went away has ended: only one that was cut short pauses.
	const ownEnd = !!result && !result.aborted && (capabilitiesOf(meta.harness).events === "acp" ? !!result.acp?.stopReason && result.acp.stopReason !== "cancelled" : !!result.summary && result.summary.outcome !== "interrupted");
	const pausing = !!active.pausing && !!run && meta.run === run && !c.vars.destroying && !active.item?.withdrawn && !active.outOfTime && (active.pausing === "machine" || !ownEnd);
	// A paused segment retains its original OOM counter for comparison on resume.
	if (!pausing && used && !active.item?.outOfMemory) await noteTurnMemory(c, meta, active, used, memoryAtStart, turnBegan, turn);
	const segmentUsage = usageOf(result?.summary?.usage) ?? result?.acp?.tokens ?? null;
	const modelKey = capabilitiesOf(meta.harness).events === "acp" && account.provider && generation && segmentUsage ? { provider: account.provider, generation, tokens: turnTokens(segmentUsage) } : undefined;
	if (pausing && active.pausing && run) {
		try {
			await pauseTurn(c, meta, active, active.pausing, segmentUsage, modelKey, result);
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
		const usage = addUsage(run?.usage ?? null, segmentUsage);
		// Settle all reported requests before this turn's completion can admit more work.
		if (usesPlatformModel(meta.harness, meta.model)) {
			await serial(c, () => writeItems(c));
			await sendOutbox(c, meta.uid);
		}
		let outcome: TurnOutcome;
		let stepLimit: number | undefined;
		let message: string | null = null;
		if (resumed && result?.resumed === false && result.windlassSessionId) note(c, turn, fresh ? "info" : "warn", fresh ? `${harnessName(meta.harness)} could not continue its saved conversation, so it was given the whole task again.` : `${harnessName(meta.harness)} could not continue the conversation; the files are as they were.`);
		if (caps.events === "acp") {
			const reason = result?.acp?.stopReason;
			if (result?.acp && result.windlassSessionId) meta.harnessModels = result.acp.models;
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
			if (failure?.reason === "auth_required" && account.provider) {
				outcome = "error";
				message = `Check your ${account.provider} key in Settings. ${said}`.trim();
			} else if (failure?.reason === "auth_required") {
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
				// A token-refresh failure belongs to the platform even when Windlass supplies a generic failure.
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
			if (!result?.acp && result?.failure?.reason === "auth_required" && message) {
				if (account.provider || refusal.message.includes("WINDLASS_ACCESS_TOKEN_FILE")) refusal.message = message;
				else if (!refusal.message.includes(SIGN_IN_REMEDY)) refusal.message += ` ${SIGN_IN_REMEDY}`;
			}
			const redactor = active.secrets?.redactor;
			const safe = redactor?.deep(refusal) ?? refusal;
			message = refusalMessage(safe);
			if (active.item) {
				const { text, fetchBase } = active.item.row;
				active.item.providerRefusal = { ...safe, accountKey: generation === null ? undefined : accountKey(account, generation), placeName: meta.place.kind === "hosted" ? "hosted" : meta.machineName ?? undefined, retry: { text: redactor?.text(text) ?? text, fetchBase, ...(active.item.row.untrusted.length && { untrusted: active.item.row.untrusted }) } };
			} else if (safe.kind === "invalid_request" || safe.kind.startsWith("model_")) {
				message += " You can change the model or reasoning effort with your next prompt.";
			}
		}
		if (result?.windlassSessionId && (result.acp || outcome !== "error")) meta.windlassSessionId = result.windlassSessionId;

		// Snapshot before publishing completion. If the snapshot fails, invalidate the previous copy.
		if (used && !meta.readiness) {
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
			...(modelKey && { modelKey }),
			...(caps.usage === "context" ? { context: result?.acp?.usage ?? null } : {}),
			...(caps.events === "acp" && meta.windlassSessionId ? { sessionId: meta.windlassSessionId } : {}),
			cachedShare: typeof summary?.cachedShare === "number" ? summary.cachedShare : null,
			message,
			verified,
		});
		if (reviewer && layer && meta.sandboxId) {
			try {
				if (active.item && (critic || requested || active.item.withdrawn || active.item.refused || meta.review?.id === active.item.row.key)) {
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
		// Probe unpublished commits before idle suspension.
		const unpushed = !reviewer && !meta.readiness && meta.repo && used ? await unpushedWork(c, meta, meta.repo, c.vars.workspace?.files ?? null).catch(() => null) : null;
		// The agent had the platform publish in this turn, before the turn's checks ran, and nothing changed since: the pull request's description is told what they came to.
		if (active.published && unpushed === false && used) await describeAfterTurn(c, meta, used, turn);
		if (active.item) await itemTurnEnded(c, meta, active.item, { outcome, itemSignIn, stepLimit, verified, used, unpushed, usage, checks: active.secrets?.checks ?? [], acp: result?.acp });
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
	// A requested review and a second review share this session. Re-admit a delivery that found it busy.
	if (reviewer && !c.vars.turn) {
		const next = (await waitingRows(c.db)).find(row => row.key !== active.item?.row.key);
		if (next) void c.keepAwake(askForSlot(c, meta, next));
	}
}

// Update the verified section after an agent push only while the current head still matches its receipt.
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

// A surviving machine process must reattach to its persisted conversation and checkpoint.
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

// Persist the last acknowledged frame and checkpoint before detaching a runner kept through sleep.
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

/** How often a turn that waits for its machine looks whether it is back, besides the wake the machine itself sends. */
const MACHINE_RECHECK_MS = 5 * 60_000;
/** The item's check of a started delivery also repairs a long pause, independently of the session's wakes. */
const STALE_PAUSE_MS = 15 * 60_000;
const stalePause = (paused: NonNullable<TurnRun["paused"]>) => Date.now() - paused.at >= STALE_PAUSE_MS;

/** A long pause on a machine that answers but cannot take the turn back ends it as interrupted. */
async function staleOnline(c: Ctx, meta: SessionMeta, paused: NonNullable<TurnRun["paused"]>): Promise<boolean> {
	return stalePause(paused) && meta.place.kind === "machine" && (await runnerLink(c, meta.place.machineId).facts()).status === "online";
}
/** How soon a resume that could not happen (the user's actor or the layer did not answer) is tried again. */
const RESUME_RETRY_MS = 60_000;
/** The most messages held for a paused turn. */
const MAX_HELD = 20;

/** Whether this session's turns pause and resume instead of being cut short. */
function resumesTurns(meta: SessionMeta): boolean {
	return config.turnResume.enabled && !meta.environmentBuild && !meta.readiness;
}

function newRun(meta: SessionMeta, turn: number, effort: string | null, planMode: boolean, now: number, fromSeq: number): TurnRun | null {
	if (!resumesTurns(meta)) return null;
	return { turn, effort, ...(planMode && { planMode: true }), activeMs: 0, segmentAt: now, fromSeq, usage: null, resumes: 0, crashes: 0 };
}

// Refresh the wake while running. A process crash cannot schedule one from onSleep.
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

// A pause preserves the turn number and emits no terminal receipt.
async function pauseTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn, reason: PauseReason, usage: TurnUsage | null, modelKey: ModelKeySpend | undefined, result: RunTurnResult | null): Promise<void> {
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
	note(c, turn, "info", pausedLine(reason, meta.machineName), { code: "turn_paused", modelKey });
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

// Return an item's slot while its machine is offline. Its resume requests a new grant.
async function machinePaused(c: Ctx, meta: SessionMeta, run: TurnRun): Promise<void> {
	const paused = run.paused;
	if (!paused || meta.place.kind !== "machine") return;
	const row = await rowOfTurn(c.db, run.turn);
	if (row && !paused.told) {
		await serial(c, async () => {
			if (meta.run !== run || run.paused !== paused || paused.told) return;
			await c.db.transaction(async tx => {
				if (row.slot) {
					await tx.execute("UPDATE inbox SET slot = NULL WHERE key = ? AND state = 'started'", row.key);
					await queueMessage(tx, { to: "user", done: { slot: row.slot, key: row.key } });
				}
				await queueMessage(tx, { to: "item", itemId: row.itemId, fact: { kind: "turn_paused", at: Date.now(), key: row.key, since: paused.at, machine: meta.machineName } });
				// A second restart must recover the same ownership as the inbox and outbox.
				await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify({ ...meta, run: { ...run, paused: { ...paused, slotFreed: true, told: true } } }));
			}, { name: "inbox.paused" });
			paused.slotFreed = true;
			paused.told = true;
		});
		await flushOutbox(c, meta.uid);
		await c.schedule.at(paused.at + config.turnResume.machineAskMs, "internalMachineAsk").catch(() => undefined);
	}
	if (meta.run !== run || run.paused !== paused) return;
	const alreadyOnline = await machineActor(() => c.client(), meta.uid, meta.place.machineId).pausedSession(meta.sessionId, true).catch((error: unknown) => c.log.warn({ msg: "could not ask the machine to wake this session when it is back", error: describeError(error) }));
	await armResumeCheck(c, paused, alreadyOnline ? 1_000 : MACHINE_RECHECK_MS);
}

/** A queued slot or a lost reconnect notification must not be the session's last chance to resume. */
async function armResumeCheck(c: Ctx, paused: NonNullable<TurnRun["paused"]>, delay: number): Promise<void> {
	const now = Date.now();
	const at = now + delay;
	if (paused.lookAt && now < paused.lookAt && paused.lookAt <= at) return;
	await c.schedule.at(at, "internalResumeTurn");
	paused.lookAt = at;
}

/** The original prompt of a personal turn interrupted before its agent received the task. */
async function originalPrompt(c: Ctx, turn: number): Promise<string> {
	const [first] = await c.db.execute<{ item: string }>("SELECT item FROM timeline WHERE turn = ? AND kind = 'user' ORDER BY seq LIMIT 1", turn);
	const item = first ? (JSON.parse(first.item) as TimelineItem) : null;
	return item?.kind === "user" ? item.text : "";
}

// A lost conversation needs the original task, including its untrusted sources.
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

// Resume the same turn only after admission succeeds again.
async function resumePaused(c: Ctx, meta: SessionMeta, granted: string | null = null): Promise<boolean> {
	const run = meta.run;
	if (!run?.paused || meta.status !== "paused" || c.vars.turn || c.vars.accepting || c.vars.resuming || c.vars.stopping || c.vars.destroying || c.vars.publishing) return false;
	// A graceful pause resumes WLP_TURN_RESUME_DELAY_MS after it at the earliest (whichever server is up then): its wake comes then.
	if (run.paused.reason === "restart" && Date.now() < run.paused.at + config.turnResume.delayMs) {
		await c.schedule.at(run.paused.at + config.turnResume.delayMs, "internalResumeTurn").catch(() => undefined);
		return false;
	}
	let settled!: () => void;
	c.vars.resuming = new Promise<void>(resolve => { settled = resolve; });
	let release: (() => void) | null = takeSandbox(c);
	let requested: { key: string; slot: string } | null = null;
	try {
		if (c.vars.idling) await c.vars.idling.catch(() => undefined);
		const row = await rowOfTurn(c.db, run.turn);
		if (meta.place.kind === "machine") {
			const link = runnerLink(c, meta.place.machineId);
			const facts = await link.facts();
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
			// Control can be online while the session socket is still unreachable. Keep the original
			// pause time until a socket answers, so failed attempts cannot reset the watchdog.
			try {
				await link.ready();
			} catch (error) {
				if (row && error instanceof MachineUnreachable && await staleOnline(c, meta, run.paused) && meta.run === run && run.paused) {
					await endPausedTurn(c, meta, "interrupted", "The machine is online but its runner could not reconnect this turn. The item was told to recover the interrupted step.");
					return false;
				}
				throw error;
			}
			if (meta.run !== run || !run.paused || c.vars.stopping) return false;
		}
		let slot = row?.slot ?? null;
		if (row && (run.paused.slotFreed || !row.slot)) {
			// Asked for again, ahead of the turns that came since: the grant comes back here (`takeDelivered`).
			if (granted === null) {
				// The queue answers a duplicate request with the held slot. Don't reclaim the
				// old one while the outbox can still release it.
				const releasing = await c.db.execute("SELECT 1 FROM outbox WHERE json_extract(message, '$.done.key') = ? LIMIT 1", row.key);
				if (releasing.length) {
					await armResumeCheck(c, run.paused, RESUME_RETRY_MS);
					return false;
				}
				// Shutdown can lose the old segment's machine-slot release. Its own reservation
				// would count against the factory's free-slot check, before it could reclaim it.
				if (meta.place.kind === "machine") await machineActor(() => c.client(), meta.uid, meta.place.machineId).releaseSlot(meta.sessionId, run.turn);
				const answer = await requestTurn(c, meta.uid, row, null, meta.turnStartedAt ?? run.paused.at);
				if (!answer.granted) {
					if (meta.run !== run || !run.paused) return false;
					if (await staleOnline(c, meta, run.paused)) {
						await userActor(c, meta.uid).internalWithdrawTurn({ sessionId: meta.sessionId, key: row.key });
						if (meta.run === run && run.paused) await endPausedTurn(c, meta, "interrupted", "The machine is online but the paused turn could not reclaim its slot. The item was told to retry the step.");
					} else if (run.paused) await armResumeCheck(c, run.paused, MACHINE_RECHECK_MS);
					return false;
				}
				granted = answer.slot;
				requested = { key: row.key, slot: granted };
			}
			slot = granted;
		}
		if (hostedLimitsApply(meta.place)) {
			// A scheduled resume may beat the wake's inspection, or come long after it. Settle a VM that
			// actually paused at its provider timestamp before taking the new hold. A warm VM counts through the gap.
			const runningAt = await refreshSandbox(c, meta, true);
			await holdSandbox(c, meta, true, runningAt);
		}
		const paused = run.paused;
		if (meta.run !== run || !paused || meta.status !== "paused" || c.vars.turn || c.vars.destroying) return false;
		const now = Date.now();
		const pausedMs = Math.max(0, now - paused.at);
		const original = row?.text ?? (run.prompted ? "" : await originalPrompt(c, run.turn));
		// Store the new slot before publishing an active turn. A failed write leaves a
		// paused turn to retry, and a restart can ask the queue for the same grant.
		if (row && (slot !== row.slot || paused.told)) await serial(c, () => c.db.transaction(async tx => {
			if (meta.run !== run || run.paused !== paused) return;
			if (slot !== row.slot) await tx.execute("UPDATE inbox SET slot = ? WHERE key = ? AND state = 'started'", slot, row.key);
			if (paused.told) await queueMessage(tx, { to: "item", itemId: row.itemId, fact: { kind: "turn_resumed", at: now, key: row.key, offlineMs: pausedMs } });
		}, { name: "inbox.resumed" }));
		if (meta.run !== run || run.paused !== paused || c.vars.stopping || c.vars.destroying) return false;
		requested = null;
		// Include messages held during the asynchronous slot handoff.
		const held = run.held ?? [];
		const text = run.prompted ? resumePrompt(paused.reason, held, run.stoppedCommand) : [original, ...held].join("\n\n");
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
		// The wake after a crash, before anything of the segment runs: one that crashes at once is found again too (the loop guard counts it).
		await c.schedule.at(now + config.turnResume.heartbeatMs, "internalResumeTurn").catch(() => undefined);
		await persist(c);
		// Said once what was resumed is stored: a crash before this leaves the turn paused, as it was.
		console.log(`[wlp] turn.resumed session=${meta.sessionId} turn=${run.turn} reason=${paused.reason} paused_ms=${pausedMs} resumes=${run.resumes} prompted=${run.prompted === true}`);
		if (row && paused.told) await flushOutbox(c, meta.uid).catch(() => sendOutbox(c, meta.uid));
		if (paused.reason === "machine" && meta.place.kind === "machine") void machineActor(() => c.client(), meta.uid, meta.place.machineId).pausedSession(meta.sessionId, false).catch(() => undefined);
		active.done = c.keepAwake(runTurn(c, meta, active, text, release));
		release = null;
		return true;
	} catch (error) {
		c.log.warn({ msg: "could not resume the paused turn", session: meta.sessionId, error: describeError(error) });
		if (error instanceof UserError && ["allowance_used", "too_many_sandboxes"].includes(String(error.code))) {
			await endPausedTurn(c, meta, "interrupted", `This turn could not resume: ${error.message}`);
		} else if (!c.vars.stopping && !c.vars.destroying && meta.run?.paused) {
			await armResumeCheck(c, meta.run.paused, RESUME_RETRY_MS).catch(error => c.log.warn({ msg: "could not schedule a paused turn retry", error: describeError(error) }));
		}
		return false;
	} finally {
		if (requested) await giveBack(c, meta, requested.key, requested.slot).catch(error => c.log.warn({ msg: "could not return an unused resume grant", error: describeError(error) }));
		c.vars.resuming = null;
		settled();
		release?.();
	}
}

// Closing a paused turn needs no sandbox process.
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
	startNextFeedback(c, meta);
}

// Treat a crashed active turn as interrupted. Keep its recorded progress and cap repeated crash resumes.
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
	meta.updatedAt = Math.max(meta.updatedAt, run.paused.at);
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

// Remember acceptance synchronously with the prompt so concurrent retries observe the same result.
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
	return queued.finally(() => {
		if (c.vars.nextPrompt === queued) {
			delete c.vars.nextPrompt;
			startNextFeedback(c, meta);
		}
	});
}

// An absent runner socket does not necessarily mean the machine is offline.
function machineAway(c: Ctx, meta: SessionMeta): boolean {
	return meta.place.kind === "machine" && c.vars.runner?.channel.connected !== true;
}

// Steering belongs to the running turn and does not acquire another slot.
async function steerTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn | null, message: string, submission: Submission | null): Promise<PromptAnswer> {
	if (usesPlatformModel(meta.harness, meta.model)) {
		const wait = await userActor(c, meta.uid).internalDailyTokenWait();
		if (wait) throw new UserError(wait, { code: "daily_token_cap" });
	}
	const control = active?.control;
	const next = (turn: number) => {
		// An item's steps start its turns: a note that misses this one goes with the item's next.
		if (meta.origin) throw new UserError("The turn cannot take the note now.", { code: "steer_unavailable" });
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

// Accept one prompt at a time across admission and sandbox waits.
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

/** GitHub feedback needs its own turn so the harness receives the prompt and its trust marker together. */
function startNextFeedback(c: Ctx, meta: SessionMeta) {
	const prompt = meta.githubFeedback?.pending;
	if (!prompt || meta.status !== "idle" || c.vars.turn || c.vars.accepting || c.vars.nextPrompt) return;
	if (c.vars.publishing || c.vars.savingSecret || c.vars.stopping || c.vars.destroying) return;
	void c.keepAwake(startPrompt(c, meta, prompt, prompt, null).catch(error => {
		note(c, meta.turns, "warn", `Could not start the GitHub feedback prompt: ${describeError(error)}`);
		return persist(c);
	}));
}

async function startPrompt(c: Ctx, meta: SessionMeta, input: PromptInput, message: string | FeedbackPrompt, submission: Submission | null): Promise<PromptAnswer> {
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
		const requested = input.model || model;
		let credential: ActiveTurn["credential"];
		if (caps.events === "windlass" && windlassProvider(requested)) credential = await turnCredential(c, meta, undefined, requested);
		if (caps.events === "windlass" && meta.windlassSessionId && windlassProvider(requested) !== windlassProvider(meta.model))
			throw new UserError("Start a new Windlass session to change providers.", { code: "bad_model" });
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
		const facts = meta.place.kind === "machine" && (meta.repoUrl || caps.signIn.includes("machine"))
			? await runnerLink(c, meta.place.machineId).facts() : null;
		if (meta.repoUrl && facts?.report?.egress === "none") throw new UserError(OFFLINE_REPOSITORY, { code: "bad_input" });
		// The operator can change WLP_E2B_NETWORK between a session's launch and its turn.
		if (meta.repoUrl && meta.place.kind === "hosted" && (await layerOf(c, meta)).sandboxes.egress?.() === "none") throw new UserError(HOSTED_OFFLINE_REPOSITORY, { code: "bad_input" });
		if (caps.signIn.includes("machine") && facts) {
			const offered = facts.report?.harnesses?.find(entry => entry.id === meta.harness);
			if (!offered) throw new UserError(`This machine does not offer ${harnessName(meta.harness)}.`, { code: "bad_input" });
			if (offered.id === "codex" && !codexModes(meta.profile, offered.modes ?? []).some(m => m.id === meta.mode))
				throw new UserError(offered.modeReason ?? innerModesReason, {code:"bad_input"});
			if (offered.signIn === "none") {
				const keys = offered.keyRelay ? await modelKeyActor(c, meta.uid).internalModelKeys() : [];
				if (withSettingsKeys(offered, keys.map(k => k.provider), model).signIn === "none")
					throw new UserError(machineLoginMessage(machineHarnesses[offered.id], facts.name), { code: "harness_signed_out" });
			}
		} else if (meta.place.kind === "hosted" && caps.events === "acp") {
			credential = await turnCredential(c, meta, undefined, model);
		} else if (!credential?.key && !meta.demo && !meta.environmentBuild && Date.now() >= c.vars.signedInUntil) {
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
		if (usesPlatformModel(meta.harness, model)) {
			await settleTokenReceipts(c, meta.uid).catch(() => {
				throw new UserError("Your previous turn’s model usage could not be settled. Try again in a moment.", { code: "usage_unavailable" });
			});
		}
		const claim = await userActor(c, meta.uid).internalAcquireRun(meta.sessionId, model);
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

		// Deliveries can merge into the pending prompt while admission awaits a slot.
		const text = typeof message === "string" ? message : message.text;
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
		if (meta.run && credential) meta.run.credential = credential;
		let untrusted: string[] | undefined;
		if (typeof message !== "string") {
			const reviewers = message.entries.filter(e => e.access !== "owner").map(e => e.author);
			untrusted = [...new Set(reviewers)].map(who => untrustedWords.feedback("@" + who));
			delete meta.githubFeedback!.pending;
		}
		if (meta.run && untrusted?.length) meta.run.untrusted = untrusted;
		append(c, { turn, kind: "user", text: shown, model, effort, ...(untrusted?.length && { untrusted }) });
		publish(c);

		const active: ActiveTurn = { number: turn, credential, effort, untrusted, controller: new AbortController(), done: Promise.resolve(), control: null, question: null, unsettled: new Set(), aside: [], recalled: new Map(), stopping: false, closed: false, planMode: capabilitiesOf(meta.harness).planMode && input.planMode === true, secrets: held, checks: new VerificationLog(), publishes: new Set() };
		c.vars.turn = active;
		// The turn's first step writes the session, and the key with it.
		const answer = remember(meta, submission, { turn, steered: false });
		active.done = c.keepAwake(runTurn(c, meta, active, text, release));
		release = null;
		return answer;
	} catch (error) {
		if (meta.githubFeedback?.pending === message) delete meta.githubFeedback.pending;
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
		startNextFeedback(c, meta);
	}
}

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

// Claim the delivery and its slot before opening a turn. A replay of the grant must reuse them.
async function takeDelivered(c: Ctx, meta: SessionMeta, key: string, slot: string): Promise<void> {
	// The queue can send a grant while a reconnect or the item's poll is requesting the same
	// slot. Re-read ownership after that attempt before deciding to take it or give it back.
	await c.vars.resuming;
	const row = await inboxRow(c.db, key);
	if (row?.state === "started" && row.slot === slot) return;
	// A turn paused while its machine was away, whose slot was given back: this grant is its slot again.
	if (row?.state === "started" && meta.run?.paused && (meta.run.paused.slotFreed || !row.slot) && row.turn === meta.run.turn) {
		if (!(await resumePaused(c, meta, slot))) {
			await c.vars.resuming;
			if ((await inboxRow(c.db, key))?.slot !== slot) await giveBack(c, meta, key, slot);
		}
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
			if (meta.sandboxId && (row.checkout.requested || meta.reviewRun !== run || meta.reviewBase !== row.checkout.baseSha)) {
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

// Pin every input repository to the head resolved with its own scoped token.
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
		const base = item.row.fetchBase;
		try {
			await fetchBase(app, await githubConnection(c, meta), base === meta.repo.branch ? meta.repo : { ...meta.repo, branch: base }, sandbox);
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

// Persist the item's terminal fact before sending it, so a lost acknowledgement can be retried.
async function itemTurnEnded(c: Ctx, meta: SessionMeta, item: NonNullable<ActiveTurn["item"]>, ended: { outcome: TurnOutcome; itemSignIn: TurnCredential["itemSignIn"]; stepLimit?: number; verified: Verified | null; used: SandboxHandle | null; unpushed: boolean | null; usage: TurnUsage | null; checks: RepositoryCheck[]; acp?: RunTurnResult["acp"] }): Promise<void> {
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
	const agent = agentTurn(meta.harness, ended.usage, ended.acp?.usage, ended.acp?.fiveHourAtStart, ended.itemSignIn);
	if (meta.origin?.role === "reviewer") {
		fact = { ...reviewEndedFactOf(row.key, ended.outcome, meta.review, item.said ?? null, item.refused ?? null, ended.usage, agent), ...(item.planReview && { planReview: item.planReview }) };
	} else {
		const flags = ended.used && meta.repo ? await turnFlags(ended.used, meta.repo.baseSha ?? null, ended.checks, ended.verified, meta.origin?.owns).catch(() => []) : [];
		// Not known (git said nothing): taken as changed, and the push says whether there was anything. What the agent pushed itself in the turn is a change too.
		const changed = ended.unpushed !== false || (meta.pushedHead ?? null) !== item.pushedAtStart;
		// Until publication, only a confirmed push of this turn's complete work identifies its report.
		const pushedHead = ended.unpushed === false && meta.pushedHead !== item.pushedAtStart && meta.pushedHead === meta.platformPushed ? meta.pushedHead : null;
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

	// Only the user actor signs a create grant for this exact session key.
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
				...(input.readiness && { readiness: input.readiness }),
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
			resuming: null,
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
				// Capture the turn before the stop signal fires: RivetKit may already have released c.vars.
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
		if (cut && meta.environmentBuild) {
			void c.keepAwake(userActor(c, meta.uid).internalEnvironmentResult(meta.sessionId, { interrupted: true }).catch(error =>
				c.log.warn({ msg: "could not report the interrupted environment build", error: describeError(error) })));
		}
		if (cut || meta.status === "paused") {
			await persist(c);
			publish(c);
		}
		meta.setupRunning = null;
		if (meta.readiness && meta.turns && meta.status === "idle") reportAssessment(c, meta);
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
				.then(() => resumePaused(c, meta))
				.then(() => startNextFeedback(c, meta)),
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

	// Verify the runner hello synchronously before accepting any of its frames.
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
					// A stop checkpoint is provisional until a real item occupies its seq.
					const end = c.vars.unwritten[0]?.seq ?? c.vars.nextSeq;
					const rows = await c.db.execute<{ item: string }>("SELECT item FROM timeline WHERE seq < ? ORDER BY seq", end);
					// Reading pending items under the same serial queue closes the gap after the SQLite snapshot.
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
				startNextFeedback(c, meta);
			}
		},

		internalGithubFeedback: async (c, notice: FeedbackNotice): Promise<boolean> => {
			requireServiceFor(c, "call");
			const meta = liveMeta(c);
			if (meta.origin || meta.environmentBuild || meta.repo?.id !== notice.repositoryId || meta.pull?.number !== notice.pr) return false;
			const feedback = meta.githubFeedback ??= { seen: [] };
			feedback.seen = feedback.seen.filter(e => recentSubject(e.at));
			const seen = new Set(feedback.seen.map(e => e.id));
			const entries = notice.entries.filter(e => !seen.has(e.id));
			if (entries.length) {
				const eligible = entries.filter(e => !oversizedFeedback(e));
				if (eligible.length !== entries.length) note(c, meta.turns, "warn", "GitHub feedback was not run. " + feedbackWords.oversized);
				const { taken, rest } = fits(eligible, feedback.pending?.entries);
				if (rest.length) note(c, meta.turns, "warn", "GitHub feedback beyond the pending batch limit was not run.");
				if (taken.length) {
					const prompt = feedback.pending ??= { entries: [], text: "" };
					prompt.entries.push(...taken);
					prompt.text = "Address the feedback that fits this change on the same branch. Explain any points you leave open.\n\n"
						+ batchText(prompt.entries, { pr: notice.pr, head: meta.pushedHead, session: true });
				}
				feedback.seen.push(...entries.map(({ id, at }) => ({ id, at })));
			}
			await writeMeta(c, meta);
			startNextFeedback(c, meta);
			return true;
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

		// Take and settle synchronously so concurrent answers cannot both succeed.
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
					meta.updatedAt = Date.now();
					c.vars.pullCheckedAt = meta.updatedAt;
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
					startNextFeedback(c, meta);
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
				startNextFeedback(c, meta);
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


		// One scheduled wake covers heartbeat recovery and a paused turn waiting for its machine.
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

		internalOwnerNote: async (c, input: { itemId: string; text: string }): Promise<boolean> => {
			requireService(c);
			const meta = liveMeta(c);
			if (!meta.origin || meta.origin.itemId !== input?.itemId || meta.origin.role === "reviewer" || meta.origin.planCritic || typeof input.text !== "string") throw new UserError("That note is not this session's.", { code: "bad_input" });
			const turn = c.vars.turn;
			if (!turn || turn.closed) return false;
			try {
				await steerTurn(c, meta, turn, input.text, null);
				return true;
			} catch (error) {
				if (error instanceof UserError && error.code === "steer_unavailable") return false;
				throw error;
			}
		},


		/** Whether this actor's process holds a turn's relay lease, and its current token: not held, the turn has ended. */
		internalModelRelay: (c, input: { nonce: string; request: string; consume?: boolean }): Promise<RemoteLease> => {
			requireService(c);
			const nonce = typeof input?.nonce === "string" ? input.nonce : "";
			return remoteLease(nonce, c.key[0], c.key[1], input.request, input.consume);
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
			const paused = meta.status === "paused" && meta.run?.paused && row.turn === meta.run.turn ? meta.run.paused : null;
			// The item's check also repairs a long pause, independently of the session's own wakes.
			if (paused && stalePause(paused) && !c.vars.resuming) {
				console.log(`[wlp] turn.pause_check session=${meta.sessionId} turn=${row.turn} paused_ms=${Date.now() - paused.at}`);
				void c.keepAwake(resumePaused(c, meta));
			}
			if (paused || c.vars.resuming) return { kind: "turn_running", at: Date.now(), key: String(input.check) };
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


		internalSummary: (c): SessionSummary => {
			requireService(c);
			return summaryOf(liveMeta(c));
		},

		internalAssessRepository: async (c, text: string): Promise<void> => {
			requireServiceFor(c, "call");
			const meta = liveMeta(c);
			if (!meta.readiness) throw new UserError("This session cannot run setup checks.", { code: "bad_input" });
			if (!meta.turns && !c.vars.turn && !c.vars.accepting) await startPrompt(c, meta, { text }, text, null);
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
			if (meta.place.kind === "hosted" && hostedSize && billing(meta.uid) && !(await userActor(c, meta.uid).internalHostedSizes()).includes(hostedSize)) {
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
