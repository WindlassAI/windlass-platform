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

import type { CheckStatus, SandboxPlace, TurnOutcome, Verified, VerifiedFlag } from "../contract.js";
import type { CiReading, CiState } from "../github/ci.js";

// ---------------------------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------------------------

/** §1.3. "waiting" always comes with a `Waiting` that says for what. */
export type ItemState = "draft" | "queued" | "working" | "waiting" | "review" | "done" | "failed" | "cancelled";

/**
 * What a waiting item waits for (§1.3; `children` and `dependency` come with slices 4 and 6).
 * "person" and "budget" have an open question; the others end by themselves.
 */
export type WaitReason = "capacity" | "machine" | "review_cap" | "ci" | "person" | "budget";

/** A wait as a person reads it (§4.5): one reason, a sentence with its numbers, and when it is next tried. */
export interface Wait {
	reason: WaitReason;
	sentence: string;
	/** When whoever holds the wait tries again; null for a wait only a person ends. */
	retryAt: number | null;
}

export interface Waiting extends Wait {
	/** Since when the item waits for this reason. */
	since: number;
}

/** §2.1. `gate` and `handoff` are code and are entered and left on the same fact. */
export type StepKind = "refine" | "implement" | "gate" | "publish" | "ci" | "ci_fix" | "conflict" | "handoff" | "merged";
export type TurnStepKind = "refine" | "implement" | "ci_fix" | "conflict";

export interface Step {
	/** Dense within its run, from 1. */
	n: number;
	kind: StepKind;
	/**
	 * From 1. A turn step's next delivery (after an interruption, or to go on after an answer), a
	 * publish's retry and every poll of a wait step is a new attempt: the step's key names one attempt,
	 * so a fact about an earlier one is recognised and ignored.
	 */
	attempt: number;
	startedAt: number;
	/** For a turn step: delivered to the session's inbox, started, or null once it ended. */
	turn: "delivered" | "started" | null;
	/** How many times the session was asked whether the turn still runs (§2.2's fallback): names the last ask. */
	checks: number;
	/** Times this step's turn was cut off (§2.4: at most 3; not rounds). */
	interruptions: number;
}

/** What the gate read from the turn that ended last (§2.1 step 2). */
export interface GateEvidence {
	outcome: TurnOutcome;
	verified: Verified | null;
	flags: VerifiedFlag[];
}

/** CI of the head that was pushed last. */
export interface CiProgress {
	head: string;
	/** When it was pushed: CI's waits (CI_POLLING) count from here. */
	since: number;
	/** The last reading that said something, as the verdict needs it; null before the first. */
	last: { state: Exclude<CiState, "retry">; runs: VerdictRun[]; said: string | null } | null;
	mergeable: boolean | null;
}

/** One attempt of the blueprint (§1.2 `runs`). */
export interface Run {
	n: number;
	startedAt: number;
	endedAt: number | null;
	/** Why it ended other than by handing over: "cancelled", "retried", or the question's cause given up on. */
	stopReason: string | null;
	step: Step;
	/** Rounds used in this run (§2.4); `plan` counts every refine turn. */
	rounds: { plan: number; gate: number; ci: number; conflict: number };
	/** The fingerprint of the last failure a fix turn was started for. */
	lastFailure: string | null;
	gate: GateEvidence | null;
	ci: CiProgress | null;
}

/** The work as the item was given it. `base` is the branch its pull request goes into. */
export interface Task {
	title: string;
	body: string;
	acceptance: string[];
	base: string;
}

export interface FactoryItem {
	id: string;
	/** Increased by every change; the actor stores a state only over the revision it read. */
	revision: number;
	state: ItemState;
	/** Set exactly when `state` is "waiting". */
	wait: Waiting | null;
	task: Task;
	/** §3.2: "approve" runs step 0 first. */
	plan: "none" | "approve";
	place: SandboxPlace;
	budget: ItemBudget;
	spent: ItemBudget;
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

export type QuestionKind = "plan_approval" | "rounds" | "budget" | "no_change" | "publish_refused" | "ci_timeout";

/**
 *   approve     the plan is approved: implement it
 *   revise      plan again, with the person's note
 *   raise       "Raise the limit and go on": the round counter that stopped is reset, or the budget raised
 *   retry       "Retry from scratch": a new run
 *   again       try the same thing again (a turn that changed nothing, a refused push)
 *   wait        keep waiting for CI
 *   hand_over   hand the pull request to the person as it is, with its verdict
 *   give_up     the item fails
 */
export type ChoiceId = "approve" | "revise" | "raise" | "retry" | "again" | "wait" | "hand_over" | "give_up";

/** What stopped a run (§2.4), for a "rounds" or "budget" question: what "raise" lifts. */
export type StopCause = "repeated" | "plan" | "gate" | "ci" | "conflict" | "interruptions" | keyof ItemBudget;

export interface Question {
	/** Unique within the item. */
	id: string;
	kind: QuestionKind;
	text: string;
	choices: Array<{ id: ChoiceId; label: string }>;
	askedAt: number;
	cause: StopCause | null;
	/** The turn that was about to start when the question was asked: what "raise" and "again" go on with. */
	resume: TurnPlan | null;
}

/** A turn the blueprint is about to deliver. */
export interface TurnPlan {
	kind: TurnStepKind;
	text: string;
	/** False: another attempt of the current step (after an interruption). */
	newStep: boolean;
	/** The round counter the turn uses (§2.4); "interruptions": the step's cut-off turns, counted when they end. */
	charge: "plan" | "gate" | "ci" | "conflict" | "interruptions" | null;
	/** For a fix turn: the failure it is for (§2.1 step 5). */
	fingerprint: string | null;
	/** For a conflict turn: the base branch to fetch into the workspace first. */
	fetchBase: string | null;
}

// ---------------------------------------------------------------------------------------------
// Facts and effects
// ---------------------------------------------------------------------------------------------

/** Who caused a fact a person or GitHub caused (§1.3): "person:<uid>". Facts from the platform have none. */
export type Cause = string;

/** What the agent's turn used: tokens of this turn (`turnTokens`), and the sandbox seconds the ledger holds for the item's session so far (`ledgerSeconds`). */
export interface TurnSpend {
	tokens: number;
	hostedSeconds: number;
}

export type Fact =
	| { kind: "start"; at: number; by: Cause }
	| { kind: "cancel"; at: number; by: Cause }
	/** A failed item, again (§1.3 "person retry"). */
	| { kind: "retry"; at: number; by: Cause }
	/** "Send back" with a note, from review. */
	| { kind: "send_back"; at: number; by: Cause; note: string }
	| { kind: "answer"; at: number; by: Cause; question: string; choice: ChoiceId; note?: string; budget?: Partial<ItemBudget> }
	/** The turn of `key` cannot start yet (`admit`). Sent again when the reason or its numbers change. */
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
			/** What the agent filed with `report`, in words; for a refine step, the plan. */
			report: string | null;
			spend: TurnSpend;
	  }
	/** `openItems`: the user's items not done, failed or cancelled; it sets how often CI is polled. */
	| { kind: "published"; at: number; key: string; head: string; pr: { number: number; url: string }; openItems: number }
	/** `transient`: a network error, retried; otherwise GitHub refused (a moved branch, a protected one, `.github/workflows`). */
	| { kind: "publish_failed"; at: number; key: string; said: string; transient: boolean }
	| { kind: "ci_read"; at: number; key: string; head: string; reading: CiReading; mergeable: boolean | null; openItems: number }
	| { kind: "pr_read"; at: number; key: string; state: "open" | "draft" | "merged" | "closed" };

/**
 * What the item actor does after storing the item. Every effect has a key that names it exactly once:
 * the actor stores the effects with the state in one write and performs each by its key, so one that
 * is performed again after a crash or a deploy is the same request (§2.5). `at`: not before then.
 */
export type Effect =
	/** Put a message in the session's inbox; it starts a turn when a slot and a lease are granted. */
	| { kind: "deliver"; key: string; text: string; agent: "planner" | null; maxSteps: number; fetchBase: string | null }
	/** The turn of `key` is not wanted any more: take it out of the inbox, or stop it. */
	| { kind: "withdraw"; key: string }
	/** Ask the session whether the turn of `turn` still runs; it answers `turn_running` with `key`, or `turn_ended`. */
	| { kind: "check_turn"; key: string; turn: string; at: number }
	/** Commit and push the session's branch, then open or update its pull request with the agent's report and the verified section. */
	| { kind: "publish"; key: string; at?: number }
	| { kind: "poll_ci"; key: string; head: string; at: number }
	| { kind: "poll_pr"; key: string; pr: number; at: number }
	/** Record the question and show it ("Needs you"). */
	| { kind: "ask"; question: Question }
	/** Record the verdict, request a review from the item's person, and put the verdict line on the pull request. */
	| { kind: "handoff"; key: string; verdict: Verdict };

/** An entry of the item's event log (§1.2 `events`), in the order it happened. */
export interface ItemEvent {
	at: number;
	/** "person:<uid>" or "platform". */
	by: string;
	step: { run: number; n: number; kind: StepKind; attempt: number } | null;
	said: string;
}

export interface Outcome {
	/** The same object as given when the fact changed nothing. */
	item: FactoryItem;
	effects: Effect[];
	events: ItemEvent[];
}

// ---------------------------------------------------------------------------------------------
// Budgets and limits (§4.2, §4.3)
// ---------------------------------------------------------------------------------------------

/** An item's budget, and what it has spent in the same units. Hosted seconds count only where the item's sandbox is hosted. */
export interface ItemBudget {
	tokens: number;
	turns: number;
	activeSeconds: number;
	hostedSeconds: number;
}

/** The factory's settings (WLP_FACTORY_*; decisions 6–8), per user where the owner raised them. */
export interface FactoryLimits {
	/** Running turns per user, the factory's and the person's own. */
	runningTurns: number;
	/** Of those, the factory's. */
	factoryTurns: number;
	/** Hosted sandboxes of the user running at once. */
	hostedRunning: number;
	/** Items in review at which new items wait. */
	reviewCap: number;
	/** A new item's budget. */
	item: ItemBudget;
}

// ---------------------------------------------------------------------------------------------
// The verdict (§8, without `review`)
// ---------------------------------------------------------------------------------------------

export interface VerdictRun {
	name: string;
	app: string;
	conclusion: string;
	url: string;
}

export interface Verdict {
	id: string;
	item: string;
	run: number;
	head: string;
	at: number;
	place: "hosted" | "machine";
	attestedBy: "platform" | `machine:${string}`;
	result: "pass" | "fail" | "incomplete" | "unverified";
	gate: {
		state: Verified["state"] | null;
		/** The user's checks in the run the work rests on. */
		required: Array<{ name: string; status: CheckStatus; sentBack: number }>;
		unneeded?: Verified["unneeded"];
	};
	/**
	 * "not_permitted": GitHub would not show the platform this repository's CI (`said` is GitHub's
	 * words); "timed_out": still running when the person had it handed over.
	 */
	ci: { state: "passed" | "failed" | "none" | "timed_out" | "not_permitted"; runs: VerdictRun[]; said: string | null };
	flags: VerifiedFlag[];
	acceptance: string[];
	mergeable: boolean | null;
}
