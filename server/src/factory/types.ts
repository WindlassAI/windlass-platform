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

import type { ChoiceId, ItemBudget, ItemEvent, ItemQuestion, ItemRun, ItemState, ItemStep, ItemTask, SandboxPlace, TurnOutcome, Verdict, VerdictRun, Verified, VerifiedFlag, Wait, Waiting } from "../contract.js";
import type { CiReading, CiState } from "../github/ci.js";

// What the web sees of these is in the contract; they are named here as the factory's modules use them.
export type { ChoiceId, FactoryLimits, ItemBudget, ItemEvent, ItemState, QuestionKind, StepKind, Verdict, VerdictRun, Wait, WaitReason, Waiting } from "../contract.js";

// ---------------------------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------------------------

export type TurnStepKind = "refine" | "implement" | "ci_fix" | "conflict";

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
	head: string;
	/** When it was pushed: CI's waits (CI_POLLING) count from here. */
	since: number;
	/** The last reading that said something, as the verdict needs it; null before the first. */
	last: { state: Exclude<CiState, "retry">; runs: VerdictRun[]; said: string | null } | null;
	mergeable: boolean | null;
}

/** One attempt of the blueprint (§1.2 `runs`): what the contract shows (`ItemRun`), and what the gate and CI read. */
export interface Run extends ItemRun {
	/** The fingerprint of the last failure a fix turn was started for. */
	lastFailure: string | null;
	gate: GateEvidence | null;
	ci: CiProgress | null;
}

/** The work as the item was given it (`ItemTask`). */
export type Task = ItemTask;

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

/** What stopped a run (§2.4), for a "rounds" or "budget" question: what "raise" lifts. */
export type StopCause = "repeated" | "plan" | "gate" | "ci" | "conflict" | "interruptions" | keyof ItemBudget;

/** A question as the contract shows it (`ItemQuestion`), and what answering it goes on with. */
export interface Question extends ItemQuestion {
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

export interface Outcome {
	/** The same object as given when the fact changed nothing. */
	item: FactoryItem;
	effects: Effect[];
	/** Entries for the item's event log (§1.2 `events`), in the order they happened. */
	events: ItemEvent[];
}
