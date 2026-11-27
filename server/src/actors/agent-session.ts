// agentSession owns one sandbox and its turns, keyed by [uid, sessionId].
// The active turn holds credentials in memory. The timeline queue commits redacted items
// and runner receipts in order so reconnects resume after the last durable sequence.
import { SETUP_TURN_MS } from "./user-readiness.js";
import { isGuide } from "../repo-setup/guide-check.js";
import { SetupPhase } from "../repo-setup/phase.js";
import { REVIEW_MS, PUBLISH_MS, reviewSetup } from "../repo-setup/review.js";
import { publishSetup, type SetupTurn } from "../repo-setup/publish.js";
import { privateLine, type AcceptedDraft } from "../repo-setup/filing.js";
import { openNote } from "../repo-setup/notes.js";
import { fileReadiness } from "../factory/readiness-filing.js";
import { digest } from "../sandbox/snapshot-key.js";
import { setTimeout as delay } from "node:timers/promises";
import { actor, event, UserError } from "rivetkit";
import {
	PUBLISH_SESSION,
	publishUnaskedProblem,
	publishAsksEveryTime,
	oldSandbox,
} from "../agent-publish.js";
import { db } from "rivetkit/db";
import { assertOrigin, authenticate, clientError, describeError, isSandboxUserError, checkGeneration, disconnectRevoked, requireService, requireServiceFor } from "../auth.js";
import { config } from "../config.js";
import {
	generatedSessionTitle,
	promptTitle,
	isMachineIdName,
	machineLabel,
	type LiveDelta,
	type ReviewRecord,
	MAX_NOTE_CHARS,
	MAX_PROMPT_CHARS,
	MAX_REMEMBERED_SUBMISSIONS,
	type PendingQuestion,
	type PromptInput,
	type PublishMessage,
	type PublishResult,
	type PublishState,
	type HostAllowed,
	type RepositoryCheck,
	type SessionServers,
	type SessionSnapshot,
	type SetRequestedSecretInput,
	type SessionSummary,
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
import { billing } from "../billing/config.js";
import type { BlockedNetwork, NetworkBlockedItem } from "../contract.js";
import { GithubError, githubApp, type InstallationToken } from "../github/app.js";
import { changedReviewPaths, checkoutReview, readOnlyReview, materializeInput, removeInputs } from "../github/git.js";
import { INPUTS_DIRECTORY } from "../factory/cross-repo.js";
import { OFFLINE_REPOSITORY } from "../runner/egress.js";
import { HOSTED_OFFLINE_REPOSITORY, isHostName } from "../sandbox/hosted-network.js";
import { BaseMergeConflict, describePull, openFromPushed } from "../github/publish.js";
import { GithubProblem, problemOf, resolveBoundRepository } from "../github/repos.js";
import { runPlace } from "../factory/resolve-run.js";
import { ModelProblem, checkEffort, chosenModel, standInModels } from "../account-models.js";
import type { OutOfMemory, RunTurnInput, RunTurnResult, SandboxHandle, SandboxLayer, TurnCheckpoint } from "../sandbox/api.js";
import { MachineUnreachable, machineActor } from "../sandbox/runner-layer.js";
import { forgetConversation, migrateJournal, readCheckpoint, readConversation } from "../runner/journal.js";
import { stopCutOffSetup } from "../sandbox/setup.js";
import { ACCOUNT_SECRET_PROJECT, accountSecretsFor, accountSecretsNote, turnEnvironment } from "../account-secrets.js";
import { unaskedNote } from "../personal-servers.js";
import { NO_REDACTION, type Redactor, SecretProblem, MAX_SECRET_REQUESTS, secretRequestLimit, validRequestedSecretName, cleanSecretValue, sealSecret, commandSandbox } from "../repo-secrets.js";
import { projectOf } from "../server-approvals.js";
import { SERVER_START, type ServerQuestionContext, serverApprovedNote, serverForgottenNote, serverPanelApprovedNote, serverRecalledNote, unsetRemedy } from "../server-question.js";
import { setupProjectOf } from "../setup-command.js";
import { Attempts, type Submission, SubmissionProblem, isRepeat, submissionOf } from "../submissions.js";
import { VerificationLog, groupReviewPaths } from "../verified.js";
import { serverSealer } from "../signin/seal.js";
import { agentTurn, turnTokens } from "../factory/budget.js";
import { cutTurnUsage, cutTurnUsageNote, reportedModelUsage, usesPlatformModel, freedNote, hostedLimitsApply } from "../usage.js";
import { type BaseTestResult, type NamedTests } from "../factory/base-tests.js";
import { PlatformChecks } from "../sandbox/platform-checks.js";
import { itemActor, modelKeyActor, grantIsValid, secretsActor, type SessionCreateInput, userActor } from "./internal.js";
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
import { DeploymentFull, ENVIRONMENT_SLOT_WAIT, PLATFORM_RESTART, sandboxConnectionLost } from "../sandbox/api.js";
import { remoteLease, type RemoteLease } from "../sandbox/relay-leases.js";
import { StartClock, keepStartTimes, startTimesLog } from "../start-times.js";
import { AcpPromptRequired } from "../sandbox/acp-harness.js";
import { initialSessionModes } from "../sandbox/profiles.js";
import { codexModes, innerModesReason, SANDBOX_ESCAPE_REFUSED } from "../sandbox/codex-modes.js";
import { windlassProvider, hostedKeyMessage, hostedProvider, selectedKey, machinePayerProblem, withSettingsKeys, harnessName, itemModeOf, itemSignInChanged, itemSignInMessage, machineHarness, machineHarnesses, initialHarnessModels, machineLoginMessage } from "../sandbox/harnesses.js";
import { stepLimitNote } from "../sandbox/platform-steps.js";
import { capabilitiesOf, harnessOf } from "../sandbox/harness.js";
import { privateSessionData } from "../sandbox/session-data.js";
import type { ItemPublishAnswer } from "./work-item.js";
import { fetchBase, sessionRepository } from "../github/publish.js";
import { CRASHES_ALLOWED, type TurnRun, type TurnCredential, addUsage, pausedLine, resumePrompt, restartShellResult, resumedLine, segmentLimit } from "./turn-resume.js";
import { ConversationLost } from "../runner/channel.js";
import { type EndedFact, type InboxRow, reviewEndedFactOf, INBOX_TABLES, itemTurnText, OUTBOX_ACTION, deliveryOf, endedFact, endedFactOf, flushOutbox, inboxRow, machineUnavailable, markEnded, markTaken, publishReceipt, queueMessage, receive, rememberPublish, requestTurn, requeue, rowOfTurn, sendOutbox, settleTokenReceipts, turnChanges, waitingRows, withdrawWaiting } from "./session-inbox.js";
import { persist, note, append, serial, writeItems, acpRecorder, onWindlassEvent, writeMeta } from "./agent-session/timeline.js";
import { str, takeQuestion, duration, abortTurn, askQuestion, askServer, serverKey, ago, rememberServer, knowServers, sealTurn, sessionServers, serverApprovals, serversChanged } from "./agent-session/questions.js";
import type { Ctx, SessionMeta, ActiveTurn, PromptAnswer, FeedbackPrompt, SessionVars } from "./agent-session/state.js";
import { runnerLink, layerOf, machineOf, durableTurns, isRunnerSocket } from "./agent-session/runner.js";
import { publish, summaryOf, report } from "./agent-session/summary.js";
import { platformNotes, saveBackup, removeBackup, dropWorkspace } from "./agent-session/workspace.js";
import { shellQuote } from "../util.js";
import { tail, TurnProblem, githubConnection, ReviewRefused, itemPrompt, within, takeSandbox, sandboxChanged, busy } from "./agent-session/common.js";
import { readSecrets, sessionRedactor } from "./agent-session/secrets.js";
import { usesScreenshotImage, childSetupSeed } from "./agent-session/setup.js";
import { metered, takeHold, removeSandbox, noteSandbox, closeMeter, useOf, meterAfterTurn, armIdle, holdSandbox, settleWokenAsk, wakeMeter, sleepMeter, leaveUsage, idleCheck, releasePlace } from "./agent-session/meter.js";
import { openSandbox, destroySessionSandboxes, copyWorkspace, refreshSandbox, workspaceView, readFiles, readDiff, sweepSandboxes } from "./agent-session/sandbox.js";
import { agentPush, agentFetchBase, agentPublish, unpushedWork, evidenceOf, checkPull, publishStateOf, cleanMessage, publishingSettled, PUBLISH_WAIT_MS, verifiedLine, PublishRefused, publishBlocked, publishSession, testSessionBase } from "./agent-session/publish.js";
import { heartbeat, wholeTask, pauseTurn, machinePaused, staleOnline, armResumeCheck, MACHINE_RECHECK_MS, originalPrompt, newRun, markPausing, resumesTurns, crashPause, stalePause } from "./agent-session/pause.js";

export { acpRecorder } from "./agent-session/timeline.js";
export { applySandboxClamp } from "./agent-session/meter.js";
export { STATUS_COMMAND, DIFF_COMMAND, observeNetwork, spareHead, readySetupItems, readyRecipe, canSeedOnResume } from "./agent-session/sandbox.js";
export { recordPushHead } from "./agent-session/publish.js";

/** How long one turn may run before the platform stops it. WLP_TURN_TIMEOUT_MS overrides it. */
const TURN_TIMEOUT_MS = config.turnTimeoutMs;
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

function liveMeta(c: Ctx): SessionMeta {
	const meta = c.vars.meta;
	if (!meta || c.vars.destroying) throw new UserError("That agent does not exist.", { code: "session_not_found" });
	return meta;
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
	const keyActor = modelKeyActor(c, meta.uid);
	const [keys, source] = await Promise.all([keyActor.internalModelKeys(), meta.place.kind === "machine" ? keyActor.internalCredentialSource(meta.place.machineId, harness) : null]);
	const payer = source ?? "machine";
	const providers = hosted || payer === "key" ? keys.map(k => k.provider) : [];
	if (!hosted && meta.origin && !meta.origin.payer)
		throw new UserError("This item did not record who pays for its agent. Choose the payer on Machines and file a new item to use it.", { code: "harness_signed_out" });
	if (!hosted && meta.origin && meta.origin.payer !== payer)
		throw new UserError("The selected payer changed. Restore the item's payer on Machines or file a new item.", { code: "harness_signed_out" });
	if (!hosted) {
		const itemMachine = meta.origin?.kind === "item" ? c.vars.runner?.known?.name || meta.machineName || "your machine" : undefined;
		const problem = offered ? machinePayerProblem(offered, model, payer, providers, itemMachine) : "The selected machine agent is unavailable.";
		if (problem) throw new UserError(problem, { code: "harness_signed_out" });
	}
	if (harness === "opencode" && model === "default") {
		if (meta.place.kind === "machine" && providers.length)
			model = await runnerLink(c, meta.place.machineId).request("openCodeDefault", { providers }, { signal });
		else if (hosted) model = meta.harnessModels?.defaultModel ?? model;
	}
	const provider = hosted ? hostedProvider(harness, model, providers) : selectedKey(harness, model, providers);
	if ((hosted || payer === "key") && !provider) throw new UserError(hostedKeyMessage(harness, model), { code: "harness_signed_out" });
	const key = keys.find(k => k.provider === provider);
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
	void c.keepAwake(userActor(c, meta.uid).internalReadinessResult(meta.sessionId, meta.readiness!.attempt, meta.readiness?.result ?? meta.readiness?.error ?? null, meta.readiness?.diagnosis ?? null).catch(error =>
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
	const setupPhase = meta.readiness?.draft ? new SetupPhase(meta.model, s => active.secrets?.redactor.text(s) ?? s) : null;
	let setupStage: "agent" | "publish" | "record" = "agent";
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
		const draftBudget = meta.readiness?.draft?.answers ? Math.min(SETUP_TURN_MS, REVIEW_MS) : SETUP_TURN_MS;
		const turnBudget = meta.readiness?.draft ? draftBudget + REVIEW_MS + PUBLISH_MS : meta.readiness ? SETUP_TURN_MS : TURN_TIMEOUT_MS;
		const limitMs = segmentLimit(turnBudget, config.turnResume.floorMs, run);
		if (run) {
			run.segmentAt = Date.now();
			heartbeat(c, true);
		}
		// The deadline the sandbox is told (the turn-deadline hook) is this segment's: what is left, with the floor.
		turnEndsAt = Date.now() + limitMs;
		limit = setTimeout(() => {
			if (!open) return;
			const ran = run && run.resumes > 0 ? `This turn ran for ${duration(run.activeMs + limitMs)}, not counting the time it was paused; the limit is ${duration(turnBudget)}, so it was stopped.` : `This turn ran for ${duration(turnBudget)}, which is the limit, so it was stopped.`;
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
		if (meta.readiness && (!caps.restrictedReview || !platformTool(meta.readiness.draft ? "file_repo_setup" : "report") || (meta.readiness.draft && !platformTool("file_repo_setup_review")))) throw new TurnProblem("The read-only setup tools are unavailable.");
		if (meta.demo && !caps.demo) throw new TurnProblem("This agent's harness has no demo mode.");
		if (active.item) await itemTurnStarted(c, meta, active.item, sandbox, turn, credential, effort);
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
		if (meta.origin?.subtaskScreenshots && (!browser || !store))
			refuseItemPolicy(item, !held.screenshots ? "Enable screenshots for this repository and deployment, then retry." :
				!store ? "Configure screenshot storage, then retry." : "The sandbox lacks a working screenshot tool. Check the pinned image and the runner’s --screenshots flag.");
		const unavailable = held.screenshots ? "Screenshots are unavailable in this sandbox. File without screenshots." : NO_REPO_SHOTS;
		let filings = Promise.resolve("");
		const setup = meta.readiness;
		const onReport: RunTurnInput["onReport"] = setup && !setup.draft ? async (request, withdrawn) => {
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
					if (meta.origin?.subtaskScreenshots && !filed.screenshots.length) throw new Error("This part requires screenshot evidence.");
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
		let setupTurn: SetupTurn | undefined;
		let accepted: AcceptedDraft | undefined;
		if (setup) {
			const app = githubApp(), repo = meta.repo, connection = await githubConnection(c, meta);
			if (!app || !repo || !connection) throw new TurnProblem("The repository connection is unavailable.");
			const { installation, repository } = await sessionRepository(app, connection, repo, "read");
			const { owner, name } = repository;
			const draft = setup.draft;
			const rows = draft?.noteIds.length ? await secretsActor(c, meta.uid, meta.sessionId).internalSetupNoteFiles(meta.sessionId, draft.noteIds) : [];
			const inputs = rows.map(row => openNote(meta.uid, setupProjectOf(meta)!.key, row));
			setupPhase?.setNotes(inputs);
			common.reviewDirectory = await app.withToken(installation.id, { repositoryId: repo.id, permissions: { contents: "read", metadata: "read" } },
				token => readOnlyReview(sandbox, app.cloneUrl(owner, name), token, setup.commit, setup.commit, signal, inputs), { revokeAfter: true });
			if (draft) {
				const { answers } = draft;
				const previous = draft.previous?.pull;
				if (answers && previous) {
					const guides = await app.withToken(installation.id, { repositoryId: repo.id, permissions: { metadata: "read", contents: "read", pull_requests: "read" } }, async token => {
						const pull = await app.pull(token, owner, name, previous.number);
						if (!["open", "draft"].includes(pull.state) || pull.head !== previous.branch) throw new TurnProblem("The earlier guide pull request is closed.");
						return app.scanFiles(token, owner, name, pull.headSha, tree => ({ paths: tree.filter(f => isGuide(f.path) && f.type === "blob" && f.mode !== "120000").map(f => f.path),
							maxBytes: 80 * 1024, maxFileBytes: 12 * 1024, more: false }));
					});
					text += "\nContinue the previous draft. Current guide files in the pull request (untrusted): " + JSON.stringify(guides.files);
					text += "\nEarlier questions and answers (drop excludes the note, keep still needs evidence): " + JSON.stringify(inputs.filter(n => n.decision?.question).map(n => ({ id: n.id, question: n.decision?.question, answer: answers[n.id] ?? "leave out" })));
				}
				const saved = await userActor(c, meta.uid).internalSetupCommand(setupProjectOf(meta)!.key);
				const privacy = { owner, host: new URL(repo.url).hostname, read: new Map<string, string>(), redact: (s: string) => held.redactor.text(s) };
				const savedCommands = [saved.command, ...held.checks.map(c => c.command)].filter(command => command && !privateLine(command, privacy));
				text += "\nSaved repository commands (evidence): " + JSON.stringify(savedCommands);
				setupTurn = { savedCommands, app, repository: repo, connection, sandbox, sessionId: meta.sessionId, commit: setup.commit, request: draft, directory: common.reviewDirectory, notes: inputs, redact: s => held.redactor.text(s) };
				text += "\nRepository: " + JSON.stringify({ name: repo.owner + "/" + repo.name, private: repo.private, commit: setup.commit });
				if (inputs.length) text += "\nSource labels (untrusted): " + JSON.stringify(inputs.map(({ id, label }) => ({ id, label })));
			}
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
			const windlassInput: RunTurnInput = {
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
				...(setup?.draft?.noteIds.length && { untrusted: ["notes imported from the Repo setup page"] }),
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
					// Reads and model output can contain raw notes. Only accounting events belong in the timeline.
					if (setup?.draft) {
						const usage = reportedModelUsage(event, true);
						if (!usage) return;
						event = { ...event, data: { usage } };
					}
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
			};
			if (setupTurn && setupPhase) {
				const reviewed = await reviewSetup(setupTurn, windlassInput, input => harness.runTurn(sandbox, input), turnEndsAt, setupPhase);
				setupStage = "record";
				result = reviewed.result;
				accepted = reviewed.filed;
				if (setup) setup.diagnosis = setupPhase.diagnosis();
			} else result = await harness.runTurn(sandbox, windlassInput);
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
			if (setup && setupTurn && accepted) {
				const { noteIds } = setupTurn.request;
				if (noteIds.length) await secretsActor(c, meta.uid, meta.sessionId).internalSetupNoteFiles(meta.sessionId, noteIds);
				setupStage = "publish";
				const publication = await publishSetup(setupTurn, accepted, AbortSignal.any([signal, AbortSignal.timeout(PUBLISH_MS)]));
				setupStage = "record";
				await userActor(c, meta.uid).internalSetupPublished(meta.sessionId, publication, accepted.decisions, meta.repo!.installationId, setupTurn.commit);
				setup.result = accepted.score;
				await persist(c);
			}
		}
	} catch (error) {
		thrown = error;
		if (meta.readiness && setupPhase) {
			const why = error instanceof GithubError && meta.repo ? problemOf(error, meta.repo.owner, meta.repo.name).message
				: error instanceof Error ? error.message : "Run setup again.";
			if (setupStage === "agent") {
				const diagnosis = setupPhase.diagnosis();
				meta.readiness.error = setupPhase.clean(why, 360);
				meta.readiness.diagnosis = diagnosis;
				const skills = { ...diagnosis.skills, filings: diagnosis.skills.filings.map(({ proposals, refusedLines, ...summary }) => summary) };
				c.log.warn({ msg: "repo setup phase failed", session: meta.sessionId, turn, error: meta.readiness.error, ...diagnosis, skills });
			} else {
				meta.readiness.error = (setupStage === "publish" ? "The guides could not be published. " : "Repo setup could not save the result. ") + setupPhase.clean(why);
			}
			error = thrown = new TurnProblem(meta.readiness.error);
		}
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
/** How soon a resume that could not happen (the user's actor or the layer did not answer) is tried again. */
const RESUME_RETRY_MS = 60_000;
/** The most messages held for a paused turn. */
const MAX_HELD = 20;

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
		if (turn === 1 && !meta.titleIsTyped && !meta.origin) meta.title = promptTitle(shown);
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
		// The owner approved one implementer in the planner's workspace.
		if (meta.origin?.afterPlanning && !row.agent && !row.checkout) {
			const build = meta.origin.afterPlanning;
			if (build.model !== meta.model) meta.windlassSessionId = null;
			meta.model = build.model;
			meta.origin.effort = build.effort ?? undefined;
			delete meta.origin.afterPlanning;
		}
		const effort = meta.origin?.effort ?? null;
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
async function itemTurnStarted(c: Ctx, meta: SessionMeta, item: NonNullable<ActiveTurn["item"]>, sandbox: SandboxHandle, turn: number, credential: TurnCredential, effort: string | null): Promise<void> {
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
	const role = item.row.agent === "summary" || item.row.agent === "critic" || item.row.agent === "planner" ? item.row.agent
		: meta.origin?.role === "reviewer" ? "reviewer" : undefined;
	const fact: Fact = { kind: "turn_started", at: Date.now(), key: item.row.key, role, actual: {
		place: runPlace(meta.place), agent: meta.harness ?? "windlass", model: credential.model, effort,
		profile: meta.profile, size: meta.place.kind === "machine" ? meta.origin?.size ?? 1 : meta.hostedSize ?? null, payer: credential.key ? "key" : meta.harness && meta.harness !== "windlass" ? "machine" : "windlass",
		payerSource: meta.origin?.payerSource } };
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
		const changes = ended.used && meta.repo ? await turnChanges(ended.used, meta.repo.baseSha ?? null, ended.checks, ended.verified, meta.origin?.owns).catch(() => ({ flags: [] })) : { flags: [] };
		// Not known (git said nothing): taken as changed, and the push says whether there was anything. What the agent pushed itself in the turn is a change too.
		const changed = ended.unpushed !== false || (meta.pushedHead ?? null) !== item.pushedAtStart;
		// Until publication, only a confirmed push of this turn's complete work identifies its report.
		const pushedHead = ended.unpushed === false && meta.pushedHead !== item.pushedAtStart && meta.pushedHead === meta.platformPushed ? meta.pushedHead : null;
		fact = { ...endedFactOf(row.key, Date.now(), ended.outcome, ended.verified, changes.flags, changed, item.report, ended.usage, agent, item.asked), ...changes, ...(meta.secretRequest && { secret: { name: meta.secretRequest.name, why: meta.secretRequest.why, notice: meta.secretRequest.notice } }), pushedHead, ...(row.agent === "summary" && item.said && { reportProblem: item.said }), ...(item.refused ? { refused: item.refused, policyRefusal: item.policyRefusal } : {}), ...(item.refused && item.untrustedRefusal && { untrustedRefusal: item.untrustedRefusal }), ...(item.escaped && { escaped: item.escaped }) };
	}
	if (fact.kind === "turn_ended" && meta.origin?.subtaskScreenshots && ended.outcome === "succeeded" && !item.asked && !meta.secretRequest && !item.report?.screenshots.length) {
		fact.refused = "This part requires a report with screenshot evidence. Retry the part to capture it.";
		fact.policyRefusal = true;
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
		if (meta?.origin && meta.place.kind === "machine" && machineHarness(meta.harness) && !meta.origin.payer) {
			const origin = meta.origin as typeof meta.origin & { filedWithKey?: true };
			if (origin.filedWithKey) origin.payer = "key";
			else if (origin.signIn === "subscription" || origin.signIn === "chatgpt") origin.payer = "machine";
			delete origin.filedWithKey;
		}
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

		internalSandboxReclaimed: async (c, said: string): Promise<void> => {
			requireService(c);
			note(c, liveMeta(c).turns, "info", said);
			await persist(c);
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

		internalPublish: async (c, input: { key: string; title: string; body: string; blockedNetwork?: BlockedNetwork; branchOnly?: boolean; updateFromBase?: { head: string; at: number; baseTip?: string } }): Promise<ItemPublishAnswer> => {
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

		internalAssessRepository: async (c, text: string, continuation?: NonNullable<SessionCreateInput["readiness"]>): Promise<void> => {
			requireServiceFor(c, "call");
			const meta = liveMeta(c);
			if (!meta.readiness) throw new UserError("This session cannot run setup checks.", { code: "bad_input" });
			if (continuation) {
				if (!continuation.draft?.answers || meta.status !== "idle" || meta.sandboxId || c.vars.turn || c.vars.accepting) throw new UserError("The earlier setup turn is still finishing.", { code: "sandbox_busy" });
				if (meta.readiness.attempt === continuation.attempt) return;
				meta.readiness = continuation;
				meta.windlassSessionId = null;
				await startPrompt(c, meta, { text, model: meta.readiness.model, effort: meta.readiness.effort }, text, null);
			} else if (!meta.turns && !c.vars.turn && !c.vars.accepting) await startPrompt(c, meta, { text, model: meta.readiness.model, effort: meta.readiness.effort }, text, null);
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
		internalFreeSandbox: async (c, throughReviewRun?: number, hostedSize?: HostedSize, automatic?: { reason: string; cutoff?: number }): Promise<{ freed: boolean; sizeUnavailable?: HostedSize }> => {
			requireService(c);
			const meta = liveMeta(c);
			if (c.vars.idling) await c.vars.idling.catch(() => undefined);
			if (automatic?.cutoff !== undefined && Math.max(meta.updatedAt, meta.lastUsedAt) >= automatic.cutoff) return { freed: false };
			if (throughReviewRun != null && (meta.origin?.role !== "reviewer" || (meta.reviewRun ?? 0) > throughReviewRun)) return { freed: false };
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
					await removeSandbox(c, meta, id, throughReviewRun == null ? freedNote(memory, automatic?.reason) : "Released the reviewer’s sandbox for the finished run.");
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
