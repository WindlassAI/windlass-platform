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
import type { CheckConclusion, ChildPlacement, ReviewRecommendation } from "../contract.js";
import type { AgentReport } from "../agent-publish.js";
import type { ChoiceId, ItemBudget, ItemEvent, ItemQuestion, ItemReview, ItemRun, ItemState, ItemStep, ItemTask, SandboxPlace, TurnOutcome, Verdict, VerdictRun, Verified, VerifiedFlag, Wait, Waiting } from "../contract.js";
import type { ReviewerTaskInput } from "./reviewer-task.js";
import type { CiReading, CiState } from "../github/ci.js";

// What the web sees of these is in the contract; they are named here as the factory's modules use them.
export type { ChoiceId, FactoryLimits, ItemBudget, ItemEvent, ItemState, QuestionKind, StepKind, Verdict, VerdictRun, Wait, WaitReason, Waiting } from "../contract.js";

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
	/** The turn that produced the work about to be published, including across publish retries. */
	gate: (GateEvidence & { turn: string }) | null;
	ci: CiProgress | null;
	review: RunReview | null;
}

/** A blocking finding of a review, as the next round's reviewer must answer it (`earlier` blocks). */
export interface EarlierFinding {
	id: string;
	/** The finding it continues, through every round: what "the same changes again" compares. */
	root: string;
	title: string;
	text: string;
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
}

/** The work as the item was given it (`ItemTask`). */
export type Task = ItemTask;

export interface FeatureJob {
	/** Current attempt attached to a creation request by the parent actor. */
	dispatchKey?: string;
	route?: PlacementRoute;
	warm?: string[];
	placement?: ChildPlacement;
	failure?: string | null;
	cancelRequested?: boolean;
	id: string;
	task: import("../contract.js").PlanSubtask;
	state: import("../contract.js").ItemState;
	spent: ItemBudget;
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
	feedbackReplans?: number;
	/**
	 * What the planner had spent, closing work and subtasks left out, when the latest feedback re-plan began.
	 * Planning counts its share from here, so each feedback re-plan gets a share of its own; the feature budget
	 * and its closing reserve still bound it.
	 */
	planningBase?: ItemBudget;
	/** Closing work is charged to the feature, outside its planner allowance. */
	beforeClosing?: ItemBudget;
	closingSpend?: ItemBudget;
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
	forceSplit?: boolean;
	seed?: string;
	childBase?: string;
	cancelAfterIntegration?: boolean;
	approvedPlan?: import("../contract.js").FeaturePlan;
	approvedAllocation?: ItemBudget;
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
	/** §3.2: "approve" runs step 0 first. */
	plan: "none" | "approve";
	/** Absent on items persisted before second review was available. */
	reviewer?: { on: true } | { off: "deployment" | "profile" };
	place: SandboxPlace;
	machineRemoved: boolean;
	budget: ItemBudget;
	spent: ItemBudget;
	/** Absent for items filed before agents could be chosen: Windlass. */
	agent?: import("../contract.js").ItemAgent;
	/** Since when the item is "working": active time (§2.4) is the sum of such stretches. */
	workingSince: number | null;
	run: Run | null;
	pr: { number: number; url: string } | null;
	/** The commit pushed last. */
	head: string | null;
	question: Question | null;
}

// ---------------------------------------------------------------------------------------------
// Questions (§9)
// ---------------------------------------------------------------------------------------------

/** What stopped a run (§2.4), for a "rounds" or "budget" question: what "raise" lifts. */
export type StopCause = "repeated" | "plan" | "gate" | "ci" | "conflict" | "review" | "interruptions" | keyof ItemBudget;

/** A question as the contract shows it (`ItemQuestion`), and what answering it goes on with. */
export interface Question extends ItemQuestion {
	cause: StopCause | null;
	/** The turn that was about to start when the question was asked: what "raise" and "again" go on with. */
	resume: TurnPlan | null;
}

/** base is the target branch. The actor supplies its pinned SHA to reviewerTask. */
export type ReviewCheckout = { head: string; base: string; pr: number };
export type ReviewerInput = Pick<ReviewerTaskInput, "round" | "task" | "pr" | "head" | "previousHead" | "verdictWords" | "records" | "filings"> & { verdictId: string; earlier: EarlierFinding[] };
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
	/** False: another attempt of the current step (after an interruption). */
	newStep: boolean;
	/** The round counter the turn uses (§2.4); "interruptions": the step's cut-off turns, counted when they end. */
	charge: "plan" | "gate" | "ci" | "conflict" | "review" | "interruptions" | null;
	/** For a fix turn: the failure it is for (§2.1 step 5). */
	fingerprint: string | null;
	/** For a conflict turn: the base branch to fetch into the workspace first. */
	fetchBase: string | null;
}

// ---------------------------------------------------------------------------------------------
// Facts and effects
// ---------------------------------------------------------------------------------------------

/** The owner's explicit retry replays this delivery, including a conflict step's base fetch. */
export interface ItemProviderRefusal extends ProviderRefusal {
	accountKey?: string;
	placeName?: string;
	retry: Pick<TurnPlan, "text" | "fetchBase">;
}

/** Who caused a fact a person or GitHub caused (§1.3): "person:<uid>". Facts from the platform have none. */
export type Cause = string;

/** What the agent's turn used: tokens of this turn (`turnTokens`), and the sandbox seconds the ledger holds for the item's session so far (`ledgerSeconds`). */
export interface TurnSpend {
	/** Counted against the item's token budget: none where the agent's tokens are not (budget.ts, `agentTurn`). */
	tokens: number;
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
	| { kind: "feature_seed"; at: number; key: string; sha: string }
	| { kind: "feature_ready"; at: number; key: string; head: string; pr: NonNullable<FactoryItem["pr"]> }
	| { kind: "cancel_subtask"; key: string; by: string; at: number }
	| { kind: "child_notice"; integratedHead?: string; at: number; child: string; state: FactoryItem["state"]; spent: ItemBudget }
	| { kind: "place_child"; at: number; key: string; inventory: PlacementInventory }
	| { kind: "placement_wait"; at: number; child: string; key: string; sentence: string; refused?: boolean; dailyCap?: boolean; providerUntil?: number; accountKey?: string }
	| { kind: "child_update"; placement?: ChildPlacement; failure?: string | null; at: number; key: string; child: string; state: FactoryItem["state"]; spent: ItemBudget; report: string; head: string | null }
	| { kind: "integrated"; at: number; key: string }
	| { kind: "feature_problem"; at: number; key: string; reason: string; rebase?: boolean }
	| { kind: "file_plan"; at: number; key: string; plan: unknown }
	| { kind: "edit_plan"; at: number; by: string; version: number; plan: unknown }
	| { kind: "approve_plan"; inventory?: PlacementInventory; at: number; by: string; version: number }
	| { kind: "run_single"; at: number; by: string }
	| { kind: "start"; at: number; by: Cause }
	| { kind: "machine_removed"; at: number }
	| { kind: "cancel"; at: number; by: Cause }
	/** A failed item, again (§1.3 "person retry"). */
	| { kind: "retry"; at: number; by: Cause }
	/** "Send back" with a note, from review. */
	| { kind: "send_back"; at: number; by: Cause; note: string }
	| { kind: "answer"; inventory?: PlacementInventory; at: number; by: Cause; question: string; choice: ChoiceId; note?: string; budget?: Partial<ItemBudget> }
	/** The turn of `key` cannot start yet (`admit`). Sent again when the reason or its numbers change. */
	| { kind: "provider_retry"; key: string; at: number; plan: TurnPlan; loginChanged?: boolean }
	| { kind: "turn_waiting"; at: number; key: string; wait: Wait }
	| { kind: "turn_started"; at: number; key: string }
	/** The session's answer to `check_turn`: that turn still runs. `key` is the check's. */
	| { kind: "turn_running"; at: number; key: string }
	| {
			kind: "turn_ended";
			at: number;
			key: string;
			outcome: TurnOutcome;
			verified: Verified | null;
			flags: VerifiedFlag[];
			/** Whether there is something to push: the workspace or local commits differ from what GitHub has of the branch (from the base, before the first push). */
			changes: boolean;
			/** What the agent filed. A string can arrive from a session outbox written before structured reports. */
			report: AgentReport | string | null;
			/** A push made by the host tool can precede the item's publish step. */
			pushedHead?: string | null;
			/**
			 * Set when the session refused the turn before the agent ran, for a reason trying again will not
			 * cure (today: its sandbox's Windlass is too old for the platform): the session's sentence for a
			 * person. Absent for a turn that ran, or was cut off.
			 */
			refused?: string | null;
			providerRefusal?: ItemProviderRefusal;
			spend: TurnSpend;
	  }
	| { kind: "review_ended"; at: number; key: string; outcome: TurnOutcome; review: ItemReview | null; said: string | null; refused?: string | null; providerRefusal?: ItemProviderRefusal; spend: TurnSpend }
	/** `openItems`: the user's items not done, failed or cancelled; it sets how often CI is polled. */
	| { kind: "published"; at: number; key: string; head: string; pr: { number: number; url: string } | null; openItems: number; webhooks: boolean }
	/** `transient`: a network error, retried; otherwise GitHub refused (a moved branch, a protected one, `.github/workflows`). */
	| { kind: "publish_failed"; at: number; key: string; said: string; transient: boolean }
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
	| { kind: "dispatch"; key: string; at?: number }
	/** Put a message in the session's inbox; it starts a turn when a slot and a lease are granted. */
	| { kind: "deliver"; key: string; text: string; feedbackQuote?: TurnPlan["feedbackQuote"]; agent: "planner" | "summary" | null; maxSteps: number; fetchBase: string | null; to?: "review"; checkout?: ReviewCheckout; reviewerInput?: ReviewerInput }
	/** The turn of `key` is not wanted any more: take it out of the inbox, or stop it. */
	| { kind: "release_review"; key: string; run: number; to: "review" }
	| { kind: "withdraw"; key: string; to?: "review" }
	/** Ask the session whether the turn of `turn` still runs; it answers `turn_running` with `key`, or `turn_ended`. */
	| { kind: "check_turn"; key: string; turn: string; at: number; to?: "review" }
	/** Commit and push the session's branch, then open or update its pull request with the agent's report and the verified section. */
	| { kind: "publish"; key: string; at?: number }
	| { kind: "poll_ci"; key: string; head: string; at: number; notBefore?: number }
	| { kind: "poll_pr"; key: string; pr: number; at: number }
	/** Record the question and show it ("Needs you"). */
	| { kind: "ask"; question: Question }
	/** Record the verdict, request a review from the item's person, and put the verdict line on the pull request. */
	| ({ kind: "handoff"; key: string; verdict: Verdict; words: string; continuedIn?: number; reviewDone?: true } & HandoffReview);

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
	/** Store beside the item before performing the outbox. This effect never goes to GitHub. */
	storeVerdict?: VerdictEffect;
	effects: Effect[];
	/** Entries for the item's event log (§1.2 `events`), in the order they happened. */
	events: ItemEvent[];
}
