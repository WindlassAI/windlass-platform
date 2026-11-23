/**
 * The types the factory's pure modules share (Plans "software factory"): the work item as its actor
 * stores it, the facts that reach it, the effects it asks for, the verdict, budgets and limits.
 *
 *   blueprint.ts   the step machine: (item, fact) → (item, effects, events)
 *   verdict.ts     the verdict of §8, from what the session verified, the flags and CI
 *   budget.ts      an item's budget (§4.3) and whether a turn may start where it runs (§4.2)
 *   github/ci.ts   what GitHub says of a commit's CI
 *
 * None of them reads a clock, stores anything or talks to anything: every time comes in on a fact.
 */

import type { ProviderRefusal } from "../provider-refusal.js";
import type { PlacementRoute, PlacementInventory } from "./placement.js";
import type { CheckConclusion, ChildPlacement, FeatureRepository, IntegrationView, ReviewRecommendation } from "../contract.js";
import type { AgentAsk, AgentReport } from "../agent-publish.js";
import type { OutOfMemory } from "../sandbox/api.js";
import type { ChoiceId, HostedSize, ItemBudget, ItemSpend, ItemEvent, ItemQuestion, ItemReview, ItemRun, ItemState, ItemStep, ItemTask, SandboxPlace, TurnOutcome, Verdict, VerdictRun, Verified, VerifiedFlag, Wait, Waiting } from "../contract.js";
import type { PersonDecision, ReviewerTaskInput } from "./reviewer-task.js";
import type { CancelledJob, CiReading, CiState } from "../github/ci.js";

// What the web sees of these is in the contract; they are named here as the factory's modules use them.
export type { ChoiceId, FactoryLimits, ItemBudget, ItemSpend, ItemEvent, ItemState, QuestionKind, StepKind, Verdict, VerdictRun, Wait, WaitReason, Waiting } from "../contract.js";

// ---------------------------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------------------------

export type TurnStepKind = "summary" | "refine" | "implement" | "ci_fix" | "conflict" | "review" | "review_fix";

/** A step as the contract has it (`ItemStep`): a turn step's next delivery, a publish's retry and every poll of a wait step is a new attempt, so a fact about an earlier one is recognised by its key and ignored. */
export type Step = ItemStep;

/** What the gate read from the turn that ended last (§2.1 step 2). */
export interface GateEvidence {
	outcome: TurnOutcome;
	verified: Verified | null;
	flags: VerifiedFlag[];
}

/** CI of the head that was pushed last. */
export interface CiProgress {
	/** Older item rows predate webhook polling. */
	webhooks?: boolean;
	lastReadState?: CiState;
	head: string;
	/** When it was pushed: CI's waits (CI_POLLING) count from here. */
	since: number;
	/** Evidence from the latest poll, cleared when a fresh reading is unavailable or still due. */
	last: { state: Exclude<CiState, "retry">; runs: VerdictRun[]; said: string | null } | null;
	mergeable: boolean | null;
	/**
	 * What the gate recorded of the work at `head`, kept from when it was pushed: a later turn that
	 * pushed nothing (a fix whose checks failed again) is not evidence for this commit.
	 */
	gate: GateEvidence | null;
	/**
	 * The commit the pull request's branch was at when GitHub was last asked, when that is not `head`: pushed there by someone
	 * other than the agent, and verified by nothing. Null while the pull request holds `head`, or GitHub did not say.
	 */
	moved: string | null;
	/** The id of the verdict handed over for `head`, made again when the pull request moves after it. */
	handed: string | null;
	/** Original handoff, restored if the PR returns to the reviewed head. */
	secondReview: HandoffReview | null;
}

/** One attempt of the blueprint (§1.2 `runs`): what the contract shows (`ItemRun`), and what the gate and CI read. */
export interface Run extends ItemRun {
	/** The fingerprint of the last failure a fix turn was started for. */
	lastFailure: string | null;
	/**
	 * Every failure a fix turn was started for in this run, by fingerprint (the stuck detector, blueprint.ts
	 * `nextTurn`): the same one again stops the run and asks. Absent on runs stored before: `lastFailure` only.
	 */
	failures?: string[];
	/** Set while the workspace is pushed for "Hand it over as it is" (blueprint.ts `answer`): it is handed over once pushed. */
	handOver?: true;
	/** The turn that produced the work about to be published, including across publish retries. */
	gate: (GateEvidence & { turn: string }) | null;
	ci: CiProgress | null;
	review: RunReview | null;
	/** Questions the builder asked the person in this run (`ask_person`), shown in its log. Absent on runs stored before the tool: none. */
	asks?: number;
}

/** A blocking finding of a review, as the next round's reviewer must answer it (`earlier` blocks). */
export interface EarlierFinding {
	id: string;
	/** The finding it continues, through every round: what "the same changes again" compares. */
	root: string;
	title: string;
	text: string;
	/** Carried by a review that said it is not fixed, without filing it again: that review's "earlier" text. */
	notFixed?: string | null;
}

/**
 * The second review of the run's pushed head (R4). Fields after `prReads` are absent on rows stored before
 * reviews could send the builder back: read them as round 1, with nothing earlier.
 */
export interface RunReview {
	verdictId: string;
	head: string;
	refiles: number;
	prReads?: number;
	/** 1 for the run's first review; one more after each round of fixes. */
	round?: number;
	/** The head the round before reviewed. */
	previousHead?: string | null;
	/** The round before's blocking findings, which this round answers. */
	earlier?: EarlierFinding[];
	/** This round's blocking findings, once filed: the next round's `earlier`. */
	open?: EarlierFinding[];
	/** The fingerprint of the blocking roots a fix was last started for. */
	lastOpen?: string | null;
	/** This round's filing, once filed: what "Hand it over as it is" keeps. */
	filed?: { id: string } & CheckReview;
	/** The run's last filing before this round, which this round's head has none of until it files. */
	before?: { id: string } & CheckReview;
}

/** The work as the item was given it (`ItemTask`). */
export type Task = ItemTask;

/**
 * A repository of a cross-repo feature as its item keeps it (`FeatureRepoView` on its page): bound at
 * filing, then its seed, its feature branch's draft PR, the head the platform last fast-forwarded it to,
 * and what GitHub said of the PR when it was last read. The primary's seed, PR and head are also the
 * item's own (`seed`, `pr`, `head`).
 */
export interface FeatureRepoState extends FeatureRepository {
	seed?: string;
	marker?: string;
	head?: string | null;
	pr?: { number: number; url: string } | null;
	draft?: boolean;
	prState?: "open" | "draft" | "merged" | "closed" | null;
	prHead?: string | null;
	mergedCommit?: string | null;
	/** When GitHub says the PR merged (`merged_at`, ms): the merge order is judged by these, not by when each was read. */
	mergedAt?: number | null;
	/** Set (the reading's time) while this merge's order waits on a fresh reading of a prerequisite not seen merged yet. */
	orderPending?: number | null;
}

/** A cross-repo feature's combined run (`IntegrationView`). `charged`: its time is on the ledger. */
export interface IntegrationRun extends IntegrationView {
	dispatchedAt: number | null;
	runId: string | null;
	/** Same-input retries of a run that did not finish for the runner's sake. */
	retries: number;
	charged: boolean;
}

export type JoinResult = { key: string } & ({ head: string } | { reason: string; conflict: boolean });

export interface FeatureJob {
	/** Immutable tip from which this child branches, after repository setup at the original seed. */
	start?: string | null;
	/** Current attempt attached to a creation request by the parent actor. */
	dispatchKey?: string;
	dispatchedAt?: number;
	startedAt?: number;
	wait?: string;
	placementRefusal?: string;
	/** Last serialized integration result, retained so a restarted child can receive it again. */
	join?: JoinResult;
	route?: PlacementRoute;
	warm?: string[];
	placement?: ChildPlacement;
	failure?: string | null;
	cancelRequested?: boolean;
	id: string;
	task: import("../contract.js").PlanSubtask;
	state: import("../contract.js").ItemState;
	spent: ItemSpend;
	/** The subtask's budget as its item last said it: its plan's, and what the person gave it since. Absent until it said. */
	budget?: ItemBudget;
	head: string | null;
	report: string;
}

export interface FeedbackInput {
	ids: string[];
	text: string;
	fingerprint: string;
	others: boolean;
	by: string;
	writers?: string[];
}

export interface FeedbackDecision {
	ids: string[];
	state: "held" | "question" | "taken" | "declined";
	reason: string;
	run?: number;
	plan?: number;
}

export interface FactoryItem {
	/** One rerun request per commit. Keep the original job ids to distinguish a fresh attempt from a delayed listing. */
	ciReruns?: Record<string, { jobs: CancelledJob[]; reported?: boolean }>;
	/**
	 * The person's own words to the work since it was filed, oldest first, the newest kept (`RULES.personDecisions`): their
	 * send-back notes, their answers' notes and their own feedback on GitHub. The second reviewer is given them as the person's
	 * decisions (reviewer-task.ts), so that it does not ask for one to be undone.
	 */
	decisions?: PersonDecision[];
	/** A cross-repo feature's repositories, the primary first. Absent: the one repository of `task`. */
	repos?: FeatureRepoState[];
	integration?: IntegrationRun;
	feedbackReplans?: number;
	/**
	 * A feature's own token allowance: what its planner, its summary and its review may spend, apart from its
	 * subtasks. It starts at one item's budget (`singleBudget`) and grows by what the person gives it. The
	 * feature's budget is this and its subtasks' budgets together (blueprint.ts `featureTotal`). Absent on a
	 * feature stored before it was kept: `singleBudget.tokens`.
	 */
	ownTokens?: number;
	/** Turns counted toward the backstop from here (`RULES.turnBackstop`): set when the person lets the item go on past it. */
	backstopFrom?: number;
	feedback?: {
		held: string[] | null;
		heldText: string;
		heldFingerprint: string;
		heldWriters: string[];
		heldOthers: boolean;
		awaiting: FeedbackInput | null;
		taken: string[];
		runs: Record<string, number>;
		othersRuns: number;
		lastIds: string[];
	};
	/** Checks opened by this run, including a handed head reopened for rework. */
	pendingChecks?: { sha: string; existingOnly: boolean; feedback?: boolean; /** Reviewed in this round, which asked for changes: completed by the head a later round hands over. */ reviewRound?: number }[];
	lastReverifyAt?: number;
	routes?: Record<string, PlacementRoute>;
	placement?: ChildPlacement;
	jobs?: FeatureJob[];
	joining?: { child: string; key: string };
	stoppedJob?: string;
	retryChildren?: boolean;
	forceSplit?: boolean;
	seed?: string;
	childBase?: string;
	/** The feature commit after this child's successful join. Its own pushed head stays on the child. */
	integratedHead?: string;
	cancelAfterIntegration?: boolean;
	approvedPlan?: import("../contract.js").FeaturePlan;
	mode?: import("../contract.js").ItemMode;
	singleBudget?: ItemBudget;
	filedTurn?: string;
	replans?: number;
	featurePlan?: import("../contract.js").FeaturePlan;
	parent?: NonNullable<import("../contract.js").ItemSummary["parent"]>;
	id: string;
	/** Increased by every change; the actor stores a state only over the revision it read. */
	revision: number;
	state: ItemState;
	/** Set exactly when `state` is "waiting". */
	wait: Waiting | null;
	task: Task;
	/**
	 * Where outside text in `task` came from (untrusted.ts): an issue written by someone other than the person
	 * who filed it, and for a subtask its feature's sources and the reports of the subtasks before it.
	 * Every turn that hands the agent the task says so. Absent: the task is the person's own.
	 */
	untrusted?: string[];
	/**
	 * The sources of someone else's text (untrusted.ts, `thirdParty`) the person chose to run anyway on
	 * "Docker, hardened" ("Run it anyway"), where no agent can contain what such text talks it into: a
	 * turn whose such sources are all here goes there labelled only. A subtask starts with its feature's.
	 * Absent: none.
	 */
	unsandboxed?: string[];
	/** Absent on items persisted before second review was available. */
	reviewer?: { on: true } | { off: "deployment" | "profile" | "feature" };
	place: SandboxPlace;
	machineRemoved: boolean;
	budget: ItemBudget;
	spent: ItemSpend;
	/** Absent for items filed before agents could be chosen: Windlass. */
	agent?: import("../contract.js").ItemAgent;
	/** Since when the item is "working": active time (§2.4) is the sum of such stretches. */
	workingSince: number | null;
	/** When it last entered done, failed or cancelled; absent while it is not ended, and on items that ended before this was kept. */
	endedAt?: number;
	run: Run | null;
	pr: { number: number; url: string } | null;
	/** The commit pushed last. */
	head: string | null;
	question: Question | null;
}

// ---------------------------------------------------------------------------------------------
// Questions (§9)
// ---------------------------------------------------------------------------------------------

/**
 * What stopped a run (§2.4), for a "rounds" or "budget" question: what "raise" lifts. "repeated": the same
 * failure twice (the stuck detector); "turns": the backstop on an item's turns; "interruptions": a step cut
 * off again and again by deploys or restarts. The others of older stored questions are answered as "repeated".
 */
export type StopCause = "repeated" | "turns" | "interruptions" | "plan" | "gate" | "ci" | "conflict" | "review" | "sandboxes" | keyof ItemBudget;

/** A question as the contract shows it (`ItemQuestion`), and what answering it goes on with. */
export interface Question extends ItemQuestion {
	cause: StopCause | null;
	/** The turn that was about to start when the question was asked: what "raise" and "again" go on with. */
	resume: TurnPlan | null;
}

/** base is the target branch. The actor supplies its pinned SHA to reviewerTask. */
export type ReviewCheckout = { head: string; base: string; pr: number };
export type ReviewerInput = Pick<ReviewerTaskInput, "round" | "task" | "pr" | "head" | "previousHead" | "verdictWords" | "records" | "filings" | "decisions"> & { verdictId: string; earlier: EarlierFinding[] };
export type CheckReview = { recommendation: ReviewRecommendation; blocking: number };
export type HandoffReview = { review: string; reviewNone: null; assessment?: CheckReview } | { review: null; reviewNone: string };

/** A turn the blueprint is about to deliver. */
export interface TurnPlan {
	kind: TurnStepKind;
	/** Absent on builder plans, including resume plans saved before reviewer sessions. */
	to?: "work" | "review";
	checkout?: ReviewCheckout | null;
	text: string;
	/** Range occupied by the quoted batch. A held batch's line locations are rendered against the head at handoff. */
	feedbackQuote?: { head: string | null; start: number; length: number };
	/** False: another attempt of the current step. */
	newStep: boolean;
	/** The round the turn counts in (`Run.rounds`, shown and never capped); "interruptions": the step's cut-off turns, counted when they end. */
	charge: "plan" | "gate" | "ci" | "conflict" | "review" | "interruptions" | null;
	/** For a fix turn: the failure it is for (§2.1 step 5). */
	fingerprint: string | null;
	/** For a conflict turn: the base branch to fetch into the workspace first. */
	fetchBase: string | null;
	/**
	 * Where the outside text in `text` came from, in the person's words ("CI logs of abc1234"): text the
	 * platform does not vouch for. The session's Windlass is told, and its session is tainted from that turn
	 * on (untrusted.ts). Absent or empty: the platform's own sentences and the item's person's words only.
	 */
	untrusted?: string[];
}

// ---------------------------------------------------------------------------------------------
// Facts and effects
// ---------------------------------------------------------------------------------------------

/** The owner's explicit retry replays this delivery, including a conflict step's base fetch. */
export interface ItemProviderRefusal extends ProviderRefusal {
	accountKey?: string;
	placeName?: string;
	retry: Pick<TurnPlan, "text" | "fetchBase" | "untrusted">;
}

/** A turn the session did not start on "Docker, hardened" for someone else's text, whatever the agent (untrusted.ts, `untrustedTurn`). */
export interface UntrustedRefusal {
	sources: string[];
	retry: Pick<TurnPlan, "text" | "fetchBase" | "untrusted">;
}

/** Who caused a fact a person or GitHub caused (§1.3): "person:<uid>". Facts from the platform have none. */
export type Cause = string;

/** What the agent's turn used: tokens of this turn (`turnTokens`), and the sandbox seconds the ledger holds for the item's session so far (`ledgerSeconds`). */
export interface TurnSpend {
	/** Counted against the item's token budget, cost-weighted (budget.ts `weightedTokens`): none where the agent's tokens are not (budget.ts, `agentTurn`). */
	tokens: number;
	/** The same tokens as reported, cached input at full count. Absent where none are counted, and on outbox rows stored before: `tokens`. */
	rawTokens?: number;
	hostedSeconds: number;
	/** What a machine harness reported of the turn. Absent for Windlass. */
	agent?: AgentTurn;
}

/** What a machine harness (Claude Code, OpenCode) reported of one turn. */
export interface AgentTurn {
	/** Tokens it reported; null where it reported none. */
	reported: number | null;
	/** Whether they count against the item's token budget (harnesses.ts, `itemTokens`). */
	counted: boolean;
	/** Its conversation's cost so far. */
	cost: { amount: number; currency: string } | null;
	/** Claude Code's 5-hour window, % used, at the turn's start and end. */
	fiveHour: { start: number; end: number } | null;
}

export type Fact =
	| ({ kind: "github_feedback"; at: number } & FeedbackInput)
	| { kind: "reverify"; at: number; head: string }
	/** `repo`: a cross-repo feature's repository, by alias; absent: the one repository. */
	| { kind: "feature_seed"; at: number; key: string; sha: string; repo?: string }
	| { kind: "feature_ready"; at: number; key: string; head: string; pr: NonNullable<FactoryItem["pr"]>; repo?: string }
	/** A cross-repo feature's combined run was asked of GitHub (`runId` once GitHub named it). */
	| { kind: "integration_started"; at: number; key: string; attempt: number; runId: string | null; url: string | null }
	/** What the combined run came to, or that it could not be started or read (`unavailable`). `seconds`: how long it ran. */
	| { kind: "integration_read"; at: number; key: string; attempt: number; state: "queued" | "running" | "passed" | "failed" | "cancelled" | "timed_out" | "unavailable"; url: string | null; said: string | null; seconds?: number }
	/** A cross-repo feature's pull request in `repo`, as GitHub said it: whether it merged, into which commit. */
	/** A cross-repo feature's pull request in `repo` cannot be read any more: the App lost access, or the repository or PR is gone. */
	| { kind: "repo_pr_lost"; at: number; key: string; repo: string; said: string }
	| { kind: "repo_pr_read"; at: number; key: string; repo: string; state: "open" | "draft" | "merged" | "closed"; prHead: string | null; mergedCommit: string | null; /** `merged_at` (ms), null when GitHub did not say. */ mergedAt?: number | null }
	| { kind: "cancel_subtask"; key: string; by: string; at: number }
	| { kind: "claim_join"; at: number; child: string; key: string }
	| { kind: "finish_join"; at: number; child: string; result: JoinResult }
	| { kind: "child_notice"; integratedHead?: string; at: number; child: string; state: FactoryItem["state"]; spent: ItemSpend; budget?: ItemBudget }
	| { kind: "place_child"; child?: string; at: number; key: string; inventory: PlacementInventory }
	| { kind: "placement_wait"; at: number; child: string; key: string; sentence: string; refused?: boolean; dailyCap?: boolean; providerUntil?: number; accountKey?: string }
	| { kind: "child_update"; startedAt?: number; wait?: string; placement?: ChildPlacement; failure?: string | null; at: number; key: string; child: string; state: FactoryItem["state"]; spent: ItemSpend; budget?: ItemBudget; report: string; head: string | null }
	| { kind: "integrated"; head?: string; at: number; key: string }
	| { kind: "feature_problem"; at: number; key: string; reason: string; rebase?: boolean }
	| { kind: "file_plan"; at: number; key: string; plan: unknown }
	| { kind: "edit_plan"; at: number; by: string; version: number; plan: unknown }
	/** `agents`: the subtasks whose agent works without asking that the person confirmed (`ItemAction`). */
	| { kind: "approve_plan"; inventory?: PlacementInventory; at: number; by: string; version: number; agents?: string[]; bases?: Record<string, string> }
	| { kind: "run_single"; at: number; by: string }
	| { kind: "start"; at: number; by: Cause }
	| { kind: "machine_removed"; at: number }
	| { kind: "cancel"; at: number; by: Cause }
	/** A failed item, again (§1.3 "person retry"). */
	| { kind: "retry"; at: number; by: Cause }
	/** "Send back" with a note, from review. */
	| { kind: "send_back"; at: number; by: Cause; note: string }
	| { kind: "answer"; inventory?: PlacementInventory; at: number; by: Cause; question: string; choice: ChoiceId; note?: string; budget?: Partial<ItemBudget>; agents?: string[] }
	/** The turn of `key` cannot start yet (`admit`). Sent again when the reason or its numbers change. */
	| { kind: "provider_retry"; key: string; at: number; plan: TurnPlan; loginChanged?: boolean }
	| { kind: "turn_waiting"; at: number; key: string; wait: Wait }
	| { kind: "session_deleted"; at: number; key: string }
	| { kind: "turn_started"; at: number; key: string }
	/** The session's answer to `check_turn`: that turn still runs. `key` is the check's. */
	| { kind: "turn_running"; at: number; key: string }
	/** The turn of `key` is paused, not ended: its machine went away mid-turn (`since`). It resumes by itself when the machine is back. */
	| { kind: "turn_paused"; at: number; key: string; since: number; machine: string | null }
	/** The paused turn of `key` runs again: its machine came back after `offlineMs`. */
	| { kind: "turn_resumed"; at: number; key: string; offlineMs: number }
	/** The paused turn of `key` has waited for its machine since `since`, long enough (WLP_MACHINE_AWAY_ASK_MS) to ask the person once. */
	| { kind: "machine_away"; at: number; key: string; since: number; machine: string | null }
	| {
			kind: "turn_ended";
			at: number;
			key: string;
			outcome: TurnOutcome;
			/** The configured limit when the harness ended this turn at its step limit. */
			stepLimit?: number;
			verified: Verified | null;
			flags: VerifiedFlag[];
			/** Whether there is something to push: the workspace or local commits differ from what GitHub has of the branch (from the base, before the first push). */
			changes: boolean;
			/** What the agent filed. A string can arrive from a session outbox written before structured reports. */
			report: AgentReport | string | null;
			/** The question the builder asked its person in the turn (`ask_person`), cleaned by the session. */
			asked?: AgentAsk | null;
			/** A push made by the host tool can precede the item's publish step. */
			pushedHead?: string | null;
			/**
			 * Set when the session refused the turn before the agent ran, for a reason trying again will not
			 * cure (today: its sandbox's Windlass is too old for the platform): the session's sentence for a
			 * person. Absent for a turn that ran, or was cut off.
			 */
			refused?: string | null;
			/**
			 * With `refused`, when the session refused it on "Docker, hardened" for someone else's text: those
			 * sources, and the turn as it was delivered, to run anyway.
			 */
			untrustedRefusal?: UntrustedRefusal;
			providerRefusal?: ItemProviderRefusal;
			/**
			 * Set when the agent asked to leave its sandbox and the platform refused it and stopped the turn
			 * (Codex on "Docker + Windlass sandbox"): the platform's note, never the agent's words.
			 */
			escaped?: string;
			/**
			 * Set when the session could not prepare the turn's sandbox (connect, resume, its network, a clone): the
			 * session's sentence. The agent never ran, so it is no cut-off: the step is tried once more, then the person is asked.
			 */
			sandboxFailed?: string;
			/**
			 * Set when the turn's hosted sandbox ran out of memory (E2B's metrics, or its kernel killed programs for
			 * memory): how much of how much, in MiB, and the size. The item asks whether to go on in a larger one.
			 */
			outOfMemory?: OutOfMemory;
			spend: TurnSpend;
	  }
	| { kind: "review_ended"; at: number; key: string; outcome: TurnOutcome; stepLimit?: number; review: ItemReview | null; said: string | null; refused?: string | null; providerRefusal?: ItemProviderRefusal; /** As `turn_ended`'s. */ sandboxFailed?: string; outOfMemory?: OutOfMemory; spend: TurnSpend }
	/** The session's sandbox was removed for "Start on a fresh sandbox" (`fresh_sandbox` effect): `plan` runs next, in a new one. */
	| { kind: "sandbox_freed"; at: number; key: string; plan: TurnPlan }
	/** `openItems`: the user's items not done, failed or cancelled; it sets how often CI is polled. */
	| { kind: "published"; at: number; key: string; head: string; pr: { number: number; url: string } | null; openItems: number; webhooks: boolean }
	/** `transient`: a network error, retried; otherwise GitHub refused (a moved branch, a protected one, `.github/workflows`). */
	| { kind: "publish_failed"; at: number; key: string; said: string; transient: boolean }
	| { kind: "ci_rerun_started"; at: number; key: string; head: string; jobs: CancelledJob[]; openItems: number }
	| { kind: "ci_rerun_result"; at: number; head: string; accepted: string[]; said: string }
	/** `prHead`: the commit the pull request's branch is at, as GitHub said it with the reading; null when it did not. */
	| { kind: "ci_read"; at: number; key: string; head: string; reading: CiReading; mergeable: boolean | null; prHead: string | null; openItems: number; webhooks: boolean }
	| { kind: "pr_read"; at: number; key: string; state: "open" | "draft" | "merged" | "closed"; prHead: string | null; webhooks: boolean }
	/** The ledger has counted more hosted sandbox time for the item's session (it settles after a turn ends, and then while nothing else happens). */
	| { kind: "spent"; at: number; hostedSeconds: number };

/**
 * What the item actor does after storing the item. Every effect has a key that names it exactly once:
 * the actor stores the effects with the state in one write and performs each by its key, so one that
 * is performed again after a crash or a deploy is the same request (§2.5). `at`: not before then.
 */
export type VerifiedCheckEffect = {
	kind: "verified_check";
	key: string;
	run: number;
	step: NonNullable<ItemEvent["step"]>;
	startedAt: number;
	changedAt: number;
	verdictId: string | null;
	title: string;
	summary: string;
	existingOnly?: boolean;
} & ({ state: "in_progress"; conclusion: null } | { state: "completed"; conclusion: CheckConclusion });

export type Effect =
	| VerifiedCheckEffect
	| { kind: "provider_retry"; key: string; at: number; plan: TurnPlan }
	| { kind: "cancel_children"; key: string; ids: string[] }
	| { kind: "notify_integrated"; key: string; head: string }
	| { kind: "integrate"; key: string; head: string }
	| { kind: "describe_feature"; key: string }
	/** A cross-repo feature: write the managed section that links its pull requests on each of them. */
	| { kind: "link_prs"; key: string }
	/** A cross-repo feature: start its combined run on `heads`, by alias. */
	| { kind: "integration"; key: string; attempt: number; heads: Record<string, string> }
	| { kind: "poll_integration"; key: string; attempt: number; at: number }
	/** A cross-repo feature: read its pull request in `repo`. */
	| { kind: "poll_repo_pr"; key: string; repo: string; pr: number; at: number }
	| { kind: "dispatch"; child?: string; key: string; at?: number }
	/** Put a message in the session's inbox; it starts a turn when a slot and a lease are granted. */
	| { kind: "deliver"; key: string; text: string; feedbackQuote?: TurnPlan["feedbackQuote"]; agent: "planner" | "summary" | null; maxSteps: number; fetchBase: string | null; /** A builder's turn: the questions its run may still ask (`ask_person`). */ asksLeft?: number; to?: "review"; checkout?: ReviewCheckout; reviewerInput?: ReviewerInput; /** `TurnPlan.untrusted`; for a reviewer's turn, always some. Absent: none. */ untrusted?: string[]; /** Every source of someone else's in `untrusted` is in `FactoryItem.unsandboxed`. */ unsandboxed?: true; /** A builder's turn that goes on with its step: the prompt for an agent without the step's conversation (session-inbox.ts `Delivery.fresh`). */ fresh?: { text: string; untrusted: string[]; unsandboxed?: true } }
	/** The turn of `key` is not wanted any more: take it out of the inbox, or stop it. */
	| { kind: "release_review"; key: string; run: number; to: "review" }
	| { kind: "withdraw"; key: string; to?: "review" }
	/** Remove the session's sandbox (the person chose a fresh one); `sandbox_freed` with `plan` follows. */
	| { kind: "fresh_sandbox"; key: string; plan: TurnPlan; to?: "review"; /** "Start on a larger sandbox": the size of the new one. */ hostedSize?: HostedSize }
	/** Ask the session whether the turn of `turn` still runs; it answers `turn_running` with `key`, or `turn_ended`. */
	| { kind: "check_turn"; key: string; turn: string; at: number; to?: "review" }
	/** Commit and push the session's branch, then open or update its pull request with the agent's report and the verified section. */
	| { kind: "publish"; key: string; at?: number }
	| { kind: "rerun_ci"; key: string; head: string; jobs: CancelledJob[]; openItems: number }
	| { kind: "poll_ci"; key: string; head: string; at: number; notBefore?: number }
	| { kind: "poll_pr"; key: string; pr: number; at: number }
	/** Record the question and show it ("Needs you"). */
	| { kind: "ask"; question: Question }
	/** Record the verdict, request a review from the item's person, and put the verdict line on the pull request. */
	| ({ kind: "handoff"; key: string; verdict: Verdict; words: string; continuedIn?: number; reviewDone?: true;
		/** The run's last review asked for changes (or for the person), and no review was filed for the head handed over. */
		unfinished?: true } & HandoffReview);

/** A transaction-only effect, consumed before the actor performs any deliveries. */
export interface VerdictEffect {
	kind: "verdict";
	verdict: Verdict;
	words: string;
}

export interface Outcome {
	feedback?: FeedbackDecision[];
	/** The same object as given when the fact changed nothing. */
	item: FactoryItem;
	/** The id of the review filing this fact's review turn filed and the blueprint took (any round, handed over or not): the actor keeps it with the item. */
	tookReview?: string;
	/** Store beside the item before performing the outbox. This effect never goes to GitHub. */
	storeVerdict?: VerdictEffect;
	effects: Effect[];
	/** Entries for the item's event log (§1.2 `events`), in the order they happened. */
	events: ItemEvent[];
}
