/**
 * Check of the factory's pure modules (server/src/factory/) and of the CI reader (server/src/github/ci.ts).
 * Nothing here runs an actor, a sandbox or the real GitHub. Run with:
 *
 *   cd server && npx tsx ../scripts/factory-check.ts
 *
 * Runs of the blueprint are tables of facts, each row with what the design (Plans "software factory"
 * §1.3, §2.1, §2.4, §4.5, §8) says must follow: the item's state, what it waits for, and the effects
 * asked for, in order. Every table is driven twice: as written, and with every fact delivered a second
 * time right after itself, which must change nothing and ask for nothing (§2.5).
 *
 * The CI reader runs against the GitHub stand-in, with real scoping of its installation tokens.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AgentReport } from "../server/src/agent-publish.js";
import type { ItemReview, ReviewRecommendation, UsageNumbers, Verified, VerifiedCheck } from "../server/src/contract.js";
import type { CiReading } from "../server/src/github/ci.js";
import type { Effect, Fact, FactoryItem, ItemState, Outcome, Verdict, WaitReason } from "../server/src/factory/types.js";
import { GithubStandin } from "./github-standin.js";

const scratch = mkdtempSync(join(tmpdir(), "wlp-factory-check-"));
// Set before the server's modules are loaded: they read their configuration when they are.
process.env.WLP_SECRET = `check-secret-${randomBytes(16).toString("hex")}`;
process.env.RIVETKIT_STORAGE_PATH = join(scratch, "storage");
for (const name of Object.keys(process.env)) if (name.startsWith("WLP_GITHUB_")) delete process.env[name];
mkdirSync(process.env.RIVETKIT_STORAGE_PATH, { recursive: true });

const { advance, createItem, currentKey } = await import("../server/src/factory/blueprint.js");
const { admit, budgetStop, FACTORY_DEFAULTS, retryAt } = await import("../server/src/factory/budget.js");
const { gateResult, verdictOf, verdictWords, verdictCi } = await import("../server/src/factory/verdict.js");
const { CI_POLLING, readCi, ciState, LOG_TAIL_CHARS, LOG_TAIL_LINES } = await import("../server/src/github/ci.js");
const { GithubApp, GithubError } = await import("../server/src/github/app.js");

const output: string[] = [];
const print = (line: string) => {
	output.push(line);
	console.log(line);
};
let failures = 0;
let passes = 0;
function expect(name: string, ok: boolean, detail = ""): void {
	if (ok) passes += 1;
	else failures += 1;
	print(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `${ok ? "  (" : "  -- "}${detail}${ok ? ")" : ""}` : ""}`);
}

// ---------------------------------------------------------------------------------------------
// Evidence, as the session reports it
// ---------------------------------------------------------------------------------------------

const check = (name: string, status: VerifiedCheck["status"], output?: string, whose: VerifiedCheck["whose"] = "user"): VerifiedCheck => ({ name, command: `npm run ${name}`, whose, required: whose === "user", status, exitCode: status === "passed" ? 0 : 1, durationMs: 1000, sentBack: status === "passed" ? 0 : 3, ...(output ? { output } : {}) });
const verified = (state: Verified["state"], checks: VerifiedCheck[], extra: Partial<Verified> = {}): Verified => ({ turn: 1, state, run: checks.length === 0 ? null : { turn: 1, at: 0, checks }, unrun: [], replaced: false, changedAfter: false, ...extra });
const PASSED = verified("passed", [check("test", "passed"), check("lint", "passed")]);
const FAILING = verified("unresolved", [check("test", "failed", "FAIL src/add.test.ts\nError: expected 3, got -1"), check("lint", "passed")], { unresolved: { reason: "max_rounds", said: null } });

type Run = { name: string; state: "pending" | "passed" | "failed" | "neutral"; log?: string };
const ciRead = (runs: Run[]): CiReading => ({
	kind: "read",
	head: "",
	runs: runs.map((run, index) => ({ name: run.name, app: "github-actions", state: run.state, conclusion: run.state === "passed" ? "success" : run.state === "failed" ? "failure" : run.state === "neutral" ? "skipped" : "in_progress", url: `https://github.invalid/run/${index}`, summary: "", jobId: String(index + 1) })),
	truncated: false,
	logs: runs.filter((run) => run.log !== undefined).map((run) => ({ name: run.name, untrusted: true as const, text: run.log ?? "", truncated: false })),
});

// ---------------------------------------------------------------------------------------------
// Driving the blueprint
// ---------------------------------------------------------------------------------------------

const MINUTE = 60_000;
/** 20:00 UTC: the day's allowance starts again four hours later. */
const T0 = Date.UTC(2026, 10, 19, 20, 0);
const MIDNIGHT = Date.UTC(2026, 10, 20, 0, 0);

interface Keys {
	key: string;
	/** The key of the last `check_turn`. */
	check: string;
	question: string;
}
type FactBody = Fact extends infer F ? (F extends Fact ? Omit<F, "at"> : never) : never;
interface Row {
	fact: (keys: Keys) => FactBody;
	/** When it happens: ms after the row before (a minute unless said), or `at` exactly. */
	after?: number;
	at?: number;
	state: ItemState;
	wait?: WaitReason;
	effects: Array<Effect["kind"] | "verdict">;
	unchanged?: true;
	/** Anything more the design says of this row: null when it holds, otherwise what is wrong. */
	also?: (outcome: Outcome) => string | null;
}

const H = (n: number) => `${String(n).repeat(40).slice(0, 40)}`;
const started = (): Row["fact"] => (k) => ({ kind: "turn_started", key: k.key });
const ended = (outcome: "succeeded" | "unresolved" | "interrupted" | "stopped", evidence: Verified | null, more: { changes?: boolean; report?: AgentReport | string; tokens?: number } = {}): Row["fact"] => (k) => ({
	kind: "turn_ended",
	key: k.key,
	outcome,
	verified: evidence,
	flags: [],
	changes: more.changes ?? true,
	report: more.report ?? null,
	spend: { tokens: more.tokens ?? 100_000, hostedSeconds: 0 },
});
const published = (head: string): Row["fact"] => (k) => ({ kind: "published", key: k.key, head, pr: { number: 7, url: "https://github.invalid/pull/7" }, openItems: 1 });
const ci = (head: string, reading: CiReading, mergeable: boolean | null = true): Row["fact"] => (k) => ({ kind: "ci_read", prHead: null, key: k.key, head, reading: reading.kind === "read" ? { ...reading, head } : reading, mergeable, openItems: 1 });
const answer = (choice: Extract<Fact, { kind: "answer" }>["choice"], more: { note?: string; budget?: Partial<FactoryItem["budget"]> } = {}): Row["fact"] => (k) => ({ kind: "answer", by: "person:u1", question: k.question, choice, ...more });

const { reviewerAllowed } = await import("../server/src/factory/review.js");
const { e2bProfile, e2bOpenProfile, PROFILES } = await import("../server/src/sandbox/profiles.js");
for (const [label, place, profile, allowed] of [
	["hosted e2b", { kind: "hosted" }, e2bProfile({ windlassSandbox: true }), true],
	["unconfirmed e2b", { kind: "hosted" }, e2bProfile({ windlassSandbox: false }), false],
	["e2b-open", { kind: "hosted" }, e2bOpenProfile({ offered: true }), false],
	["docker-hardened", { kind: "hosted" }, PROFILES.find(p => p.id === "docker-hardened")!, false],
	["personal machine", { kind: "machine", machineId: "machine" }, e2bProfile({ windlassSandbox: true }), false],
] as const) expect(`reviewer profile: ${label}`, reviewerAllowed(place, profile) === allowed);

function newItem(more: { reviewer?: FactoryItem["reviewer"]; plan?: "approve"; budget?: Partial<FactoryItem["budget"]> } = {}): FactoryItem {
	return createItem({
		id: "i_00000000000000aa",
		task: { title: "Fix add()", body: "add(1, 2) returns -1.", acceptance: ["add(1, 2) is 3"], base: "main" },
		plan: more.plan,
		reviewer: more.reviewer ?? { off: "deployment" },
		place: { kind: "hosted" },
		budget: { ...FACTORY_DEFAULTS.item, ...more.budget },
	});
}

function drive(name: string, start: FactoryItem, rows: Row[]): void {
	for (const doubled of [false, true]) {
		let item = start;
		let at = T0;
		let lastCheck = "";
		let ok = true;
		for (const [index, row] of rows.entries()) {
			at = row.at ?? at + (row.after ?? MINUTE);
			const keys: Keys = { key: currentKey(item) ?? "", check: lastCheck, question: item.question?.id ?? "" };
			const fact = { at, ...row.fact(keys) } as Fact;
			const outcome = advance(item, fact);
			const kinds = [...(outcome.storeVerdict ? [outcome.storeVerdict.kind] : []), ...outcome.effects.map((effect) => effect.kind)];
			const wrong = [
				row.unchanged && (outcome.item !== item || outcome.events.length > 0) ? "the ignored fact changed the item or its log" : null,
				outcome.item.state !== row.state ? `state ${outcome.item.state}, not ${row.state}` : null,
				(outcome.item.wait?.reason ?? undefined) !== row.wait ? `waits for ${outcome.item.wait?.reason ?? "nothing"}, not ${row.wait ?? "nothing"}` : null,
				kinds.join(",") !== row.effects.join(",") ? `effects [${kinds.join(", ")}], not [${row.effects.join(", ")}]` : null,
				row.also?.(outcome) ?? null,
			].filter((text) => text !== null);
			if (wrong.length > 0) {
				ok = false;
				expect(`${name}${doubled ? " (every fact twice)" : ""}: row ${index + 1}, ${fact.kind}`, false, wrong.join("; "));
				break;
			}
			if (doubled) {
				const again = advance(outcome.item, fact);
				if (again.item !== outcome.item || again.effects.length > 0 || again.events.length > 0 || again.storeVerdict) {
					ok = false;
					expect(`${name}: row ${index + 1}, ${fact.kind} delivered twice changes nothing`, false, `effects [${again.effects.map((effect) => effect.kind).join(", ")}]`);
					break;
				}
			}
			for (const effect of outcome.effects) if (effect.kind === "check_turn") lastCheck = effect.key;
			item = outcome.item;
		}
		if (ok) expect(`${name}${doubled ? " (every fact twice)" : ""}`, true, `${rows.length} facts`);
	}
}

/** Picks one effect of an outcome. */
const effect = <K extends Effect["kind"]>(outcome: Outcome, kind: K) => outcome.effects.find((candidate): candidate is Extract<Effect, { kind: K }> => candidate.kind === kind);
const holds = (ok: boolean, otherwise: string) => (ok ? null : otherwise);

// ---------------------------------------------------------------------------------------------
// Runs of the blueprint
// ---------------------------------------------------------------------------------------------

print("\n== blueprint");

const toReview: Row[] = [
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
	{ fact: published(H(1)), state: "waiting", wait: "ci", effects: ["poll_ci"], also: (o) => holds(effect(o, "poll_ci")?.at === o.item.run?.ci?.since! + 60_000, "the first poll is a minute after the push") },
	{ fact: ci(H(1), ciRead([{ name: "build", state: "pending" }])), after: 60_000, state: "waiting", wait: "ci", effects: ["poll_ci"], also: (o) => holds(/0 of 1 checks finished/.test(o.item.wait?.sentence ?? ""), "the wait says how far CI is") },
	{
		fact: ci(H(1), ciRead([{ name: "build", state: "passed" }])),
		after: 60_000,
		state: "review",
		effects: ["handoff", "poll_pr"],
		also: (o) => {
			const verdict = effect(o, "handoff")?.verdict;
			const words = effect(o, "handoff")?.words;
			if (!words || !o.events.some((event) => event.step?.kind === "handoff" && event.said === words)) return "the handoff did not carry the logged verdict sentence";
			return holds(verdict?.result === "pass" && verdict.head === H(1) && verdict.attestedBy === "platform" && verdict.ci.state === "passed" && verdict.acceptance[0] === "add(1, 2) is 3", `the verdict is a pass at the pushed head: ${JSON.stringify(verdict)}`);
		},
	},
];

drive("the plain run: implement, checks pass, publish, CI passes, review, merged", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"], also: (o) => holds(effect(o, "deliver")?.text.includes("add(1, 2) is 3") === true && effect(o, "deliver")?.maxSteps === 60, "the task and its criteria go to the agent, with 60 steps") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: (k) => ({ kind: "turn_running", key: k.check }), after: 5 * MINUTE, state: "working", effects: ["check_turn"] },
	...toReview,
	{ fact: (k) => ({ kind: "pr_read", prHead: null, key: k.key, state: "open" }), after: 10 * MINUTE, state: "review", effects: ["poll_pr"] },
	{ fact: (k) => ({ kind: "pr_read", prHead: null, key: k.key, state: "merged" }), after: 10 * MINUTE, state: "done", effects: [] },
]);

drive("a required check fails at first and passes after a fix turn", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("unresolved", FAILING), state: "working", effects: ["deliver", "check_turn"], also: (o) => holds(/still failing: test\b/.test(effect(o, "deliver")?.text ?? "") && o.item.run?.rounds.gate === 1, "a continue-fixing turn names the failing check") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	...toReview,
]);

const failedGate = (name: string, output: string) => ended("unresolved", verified("unresolved", [check(name, "failed", output)]));
drive("a third distinct required-check failure asks the person after two fix turns", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("unresolved", FAILING), state: "working", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: failedGate("lint", "Unused import"), state: "working", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: failedGate("typecheck", "Missing return value"), state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "rounds" && o.item.question.cause === "gate", "the gate ran out of fix turns") },
]);

const failingCi = (log: string) => ciRead([{ name: "build", state: "passed" }, { name: "e2e", state: "failed", log }]);
const ciFix: Row[] = [
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
];
const pushedAndFailed = (head: string, log: string): Row[] => [
	{ fact: published(head), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{
		fact: ci(head, failingCi(log)),
		after: 60_000,
		state: "working",
		effects: ["deliver", "check_turn"],
		also: (o) => {
			const text = effect(o, "deliver")?.text ?? "";
			return holds(text.includes("untrusted") && text.includes(log) && text.includes("e2e"), "a CI fix turn has the failing check and its log, marked untrusted");
		},
	},
	...ciFix,
];
const begun: Row[] = [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
];

print("\n== the advisory second review");

const reviewHead = H(1);
const toCi: Row[] = [...begun, { fact: published(reviewHead), state: "waiting", wait: "ci", effects: ["poll_ci"] }];
const reviewerOn = () => newItem({ reviewer: { on: true } });
const ciPassed = ciRead([{ name: "build", state: "passed" }]);
const publishedVerdict = `${newItem().id}:1:5:1`;

function reviewStarts(reading: CiReading, after = MINUTE): Row {
	return {
		fact: ci(reviewHead, reading), after, state: "working", effects: ["verdict", "deliver", "check_turn"],
		also: (o) => {
			const saved = o.storeVerdict;
			const delivery = effect(o, "deliver");
			const input = delivery?.reviewerInput;
			const pending = o.item.run?.review;
			if (saved?.verdict.id !== publishedVerdict || saved.verdict.head !== reviewHead || saved.verdict.id !== delivery?.key) return "the stored verdict is not the first attempt at this head";
			if (pending?.verdictId !== saved.verdict.id || pending.head !== reviewHead || o.item.run?.ci?.handed !== saved.verdict.id) return "the run lost the verdict given to the reviewer";
			if (o.item.run?.step.kind !== "review" || delivery?.to !== "review" || effect(o, "check_turn")?.to !== "review") return "delivery and watchdog must reach the reviewer's session";
			if (!isDeepStrictEqual(delivery.checkout, { head: reviewHead, base: "main", pr: 7 }) || delivery.maxSteps !== 40 || delivery.agent !== null) return "wrong reviewer checkout, agent or turn limit";
			if (input?.verdictId !== saved.verdict.id || input.verdictWords !== saved.words || input.filings !== 4) return "the review lacks its verdict or filing limit";
			if (!isDeepStrictEqual(input.task, o.item.task) || input.pr !== 7 || input.head !== reviewHead || input.round !== 1 || input.previousHead !== null || input.earlier.length) return "the input is not for the first review of this task and PR";
			if (input.records[0]?.ref !== "check/0" || (saved.verdict.ci.runs.length && !input.records.some(r => r.ref === "ci/0"))) return "the review lacks its platform records";
			return holds(o.events.some(e => e.said === "A second agent reviews 1111111."), "the review start was not logged");
		},
	};
}

const reviewing = [...toCi, reviewStarts(ciPassed)];
const emptyCi: CiReading = { kind: "read", head: reviewHead, runs: [], truncated: false, logs: [] };
const earlyCi = (reading: CiReading): Row => ({ fact: ci(reviewHead, reading), after: CI_POLLING.noneAfterMs - 1, state: "waiting", wait: "ci", effects: ["poll_ci"] });
const skipped = ciRead([{ name: "build", state: "neutral" }]);
drive("review: passed CI starts the second agent", reviewerOn(), reviewing);
drive("review: no CI waits until the deadline", reviewerOn(), [...toCi, earlyCi(emptyCi), reviewStarts(emptyCi, 1)]);
drive("review: skipped CI waits until the deadline", reviewerOn(), [...toCi, earlyCi(skipped), reviewStarts(skipped, 1)]);
drive("review: unreadable CI permission", reviewerOn(), [...toCi, reviewStarts({ kind: "not_permitted", said: "access denied" })]);
drive("review: incomplete CI listing", reviewerOn(), [...toCi, reviewStarts({ ...emptyCi, truncated: true })]);

type ReviewEnd = Extract<FactBody, { kind: "review_ended" }>;
function endReview(overrides: Partial<Omit<ReviewEnd, "kind">> = {}): Row["fact"] {
	return ({ key }) => ({ kind: "review_ended", key, outcome: "succeeded", review: null, said: null, spend: { tokens: 19, hostedSeconds: 7 }, ...overrides });
}
function filing(recommendation: ReviewRecommendation, id = publishedVerdict): ItemReview {
	const blocks: ItemReview["blocks"] = [{ kind: "summary", text: "Reviewed." }];
	if (recommendation === "changes_requested") blocks.push({ kind: "finding", id: "r1.f1", root: "r1.f1", severity: "blocking", title: "Off by one", text: "Wrong line.", at: [], refs: [] });
	if (recommendation === "needs_person") blocks.push({ kind: "question", text: "Should the range include its end?" });
	return {
		id, run: 1, round: 1, head: reviewHead, base: H(2), verdictId: publishedVerdict, by: { sessionId: "second", model: "test" }, at: T0 + 7 * MINUTE,
		state: "filed", said: null, recommendation, records: [], notes: [], screenshots: [],
		blocks,
	};
}
const refresh = (fact: Row["fact"]): Row => ({ fact, state: "waiting", wait: "ci", effects: ["poll_ci"] });
const freshCi = ci(reviewHead, ciPassed);
for (const [recommendation, words] of [["approve", "approves"], ["changes_requested", "asks for changes (1 blocking)"], ["needs_person", "needs you"]] as const) {
	drive(`review: filed ${recommendation} hands over`, reviewerOn(), [...reviewing, {
		...refresh(endReview({ review: filing(recommendation) })),
		also: o => holds(o.events.some(e => e.said === `The second review of 1111111: ${words}.`), "expected the recommendation in the log"),
	}, {
		fact: freshCi, state: "review", effects: ["handoff", "poll_pr"],
		also: (o) => {
			const handed = effect(o, "handoff");
			return holds(handed?.review === publishedVerdict && handed.reviewNone === null && handed.verdict.id === publishedVerdict && handed.verdict.result === "pass" &&
				o.item.spent.tokens === 100_019 && o.item.spent.turns === 2 && o.item.spent.hostedSeconds === 7, "expected the filed review on the original verdict, its recommendation and exactly one turn's spend");
		},
	}]);
}

function handoverWithout(fact: Row["fact"], reason: string): Row {
	return { fact, state: "review", effects: ["handoff", "poll_pr"], also: (o) => {
		const handoff = effect(o, "handoff");
		return holds(handoff?.review === null && handoff.reviewNone === reason && o.events.some(e => e.said.startsWith("No second review:")), `expected handover because ${reason}`);
	} };
}
for (const [name, reviewer, reason] of [
	["deployment off", { off: "deployment" }, "turned off for this deployment"],
	["profile off", { off: "profile" }, "in this sandbox the reviewer's commands would run with the network"],
] as const) {
	drive(`review: ${name}`, newItem({ reviewer }), [...toCi, handoverWithout(ci(reviewHead, ciPassed), reason)]);
}
const movedReading: Row["fact"] = ({ key }) => ({ kind: "ci_read", key, head: reviewHead, reading: { ...emptyCi, head: reviewHead }, mergeable: true, openItems: 1, prHead: H(2) });
drive("review: a machine item hands over after CI without a reviewer turn", { ...reviewerOn(), place: { kind: "machine", machineId: "local" } }, [
	...toCi, handoverWithout(freshCi, "in this sandbox the reviewer's commands would run with the network"),
]);
drive("review: a rerun that fails during review changes the platform verdict", reviewerOn(), [...reviewing,
	refresh(endReview({ review: filing("approve") })),
	{ fact: ci(reviewHead, failingCi("rerun failed")), state: "review", effects: ["handoff", "poll_pr"],
		also: o => holds(effect(o, "handoff")?.verdict.result === "fail" && effect(o, "handoff")?.review === publishedVerdict, "expected fresh failure alongside the pinned filing") },
]);
drive("review: a moved PR skips the reviewer", reviewerOn(), [...toCi, handoverWithout(movedReading, "the pull request moved after the agent pushed")]);
drive("review: a branch name cannot pin the checkout", reviewerOn(), [...begun,
	{ fact: published("work"), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	handoverWithout(ci("work", ciPassed), "the push did not identify the commit to review"),
]);

function retryReview(fact: Row["fact"], instruction: string, interruptions: number): Row {
	return { fact, state: "working", effects: ["deliver", "check_turn"], also: (o) => {
		const retry = effect(o, "deliver");
		return holds(retry?.to === "review" && retry.checkout?.head === reviewHead && retry.reviewerInput?.verdictId === publishedVerdict && retry.text.includes(instruction) &&
			o.item.run?.step.n === 5 && o.item.run.step.interruptions === interruptions && effect(o, "check_turn")?.to === "review", "expected another attempt of the same review, with the original checkout, verdict and retry instruction");
	} };
}
const reviewCutOff = (outcome: ReviewEnd["outcome"], n: number) => retryReview(endReview({ outcome, review: filing("approve") }), "You were interrupted.", n);
const personHandover = (reading = freshCi) => [refresh(answer("hand_over")), handoverWithout(reading, "handed over as it is, as you asked")];
drive("review: three cutoffs ask the person", reviewerOn(), [...reviewing, reviewCutOff("failed", 1), reviewCutOff("stopped", 2), {
	fact: endReview({ outcome: "interrupted" }), state: "waiting", wait: "person", effects: ["ask"],
	also: o => holds(o.item.question?.cause === "interruptions" && o.item.question.choices.some(c => c.id === "hand_over"), "expected the interruptions question with hand over"),
}, ...personHandover()]);
const refile = retryReview(endReview({ said: "missing summary" }), 'File it now with file_review. The reported reason (quoted data): "missing summary"', 0);
drive("review: two empty completions hand over", reviewerOn(), [...reviewing, refile,
	refresh(endReview()), handoverWithout(freshCi, "The reviewer did not file a review the platform could read."),
]);
drive("review: one refile survives an intervening error", reviewerOn(), [...reviewing, refile, reviewCutOff("error", 1),
	refresh(endReview()), handoverWithout(freshCi, "The reviewer did not file a review the platform could read."),
]);
drive("review: a later filing keeps the first verdict id", reviewerOn(), [...reviewing, refile, refresh(keys => endReview({ review: filing("approve", keys.key) })(keys)), {
	fact: freshCi, state: "review", effects: ["handoff", "poll_pr"],
	also: o => holds(effect(o, "handoff")?.review === `${o.item.id}:1:5:2` && effect(o, "handoff")?.verdict.id === publishedVerdict, "expected attempt two's filing on attempt one's verdict"),
}]);
drive("review: a filing for another head is unreadable", reviewerOn(), [...reviewing,
	retryReview(endReview({ review: { ...filing("approve"), head: H(2) } }), "File it now", 0),
]);
drive("review: refusal hands over even on an error outcome", reviewerOn(), [...reviewing,
	refresh(endReview({ outcome: "error", refused: "This sandbox cannot run the reviewer." })), handoverWithout(freshCi, "This sandbox cannot run the reviewer."),
]);

const budgetReview: Row = { fact: ci(reviewHead, ciPassed), state: "waiting", wait: "budget", effects: ["verdict", "ask"], also: o =>
	holds(o.storeVerdict?.verdict.id === publishedVerdict && o.item.question?.cause === "turns" && o.item.question.choices.some(c => c.id === "hand_over"), "expected the pinned verdict and budget question before delivery") };
const tight = () => newItem({ reviewer: { on: true }, budget: { turns: 1 } });
drive("review: out of budget can hand over", tight(), [...toCi, budgetReview, ...personHandover()]);
drive("review: raising the budget admits the pinned review", tight(), [...toCi, budgetReview,
	retryReview(answer("raise", { budget: { turns: 3 } }), "", 0),
]);
drive("review: stale attempts and wrong completion facts are inert", reviewerOn(), [...toCi,
	{ fact: endReview(), state: "waiting", wait: "ci", effects: [], unchanged: true },
	reviewStarts(ciPassed),
	{ fact: ended("succeeded", PASSED), state: "working", effects: [], unchanged: true },
	reviewCutOff("interrupted", 1),
	{ fact: endReview({ key: publishedVerdict }), state: "working", effects: [], unchanged: true },
]);
drive("review: watchdog and cancellation reach the reviewer", reviewerOn(), [...reviewing,
	{ fact: k => ({ kind: "turn_waiting", key: k.key, wait: { reason: "capacity", sentence: "Waiting for a slot for the reviewer.", retryAt: null } }), state: "waiting", wait: "capacity", effects: [] },
	{ fact: started(), state: "working", effects: ["check_turn"], also: o => holds(effect(o, "check_turn")?.to === "review", "started reviewer turn checked on builder") },
	{ fact: k => ({ kind: "turn_running", key: k.check }), state: "working", effects: ["check_turn"], also: o => holds(effect(o, "check_turn")?.to === "review", "running reviewer turn checked on builder") },
	{ fact: () => ({ kind: "cancel", by: "person:u1" }), state: "cancelled", effects: ["withdraw"], also: o => holds(effect(o, "withdraw")?.to === "review", "cancel withdrew the builder") },
]);
drive("review: CI timeout can hand over directly", reviewerOn(), [...toCi,
	{ fact: ci(reviewHead, ciRead([{ name: "build", state: "pending" }])), after: CI_POLLING.timeoutMs, state: "waiting", wait: "person", effects: ["ask"] },
	...personHandover(),
]);
drive("review: a rounds question can hand over failing CI", reviewerOn(), [...begun,
	...pushedAndFailed(reviewHead, "build failed"),
	{ fact: published(H(2)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(2), failingCi("build failed")), state: "waiting", wait: "person", effects: ["ask"], also: o => holds(o.item.question?.cause === "repeated", "expected a rounds question") },
	...personHandover(ci(H(2), failingCi("build failed"))),
]);
const prAt = (sha: string): Row["fact"] => ({ key }) => ({ kind: "pr_read", key, state: "open", prHead: sha });
drive("review: moving away and back updates the same verdict", reviewerOn(), [...reviewing,
	refresh(endReview({ review: filing("approve") })),
	{ fact: freshCi, state: "review", effects: ["handoff", "poll_pr"] },
	...[H(2), reviewHead].flatMap((head): Row[] => [{ fact: prAt(head), state: "review", effects: ["poll_ci"] }, { fact: keys => ({ ...freshCi(keys), prHead: head }), state: "review", effects: ["handoff", "poll_pr"], also: o => {
		const update = effect(o, "handoff");
		return holds(update?.reviewDone === true && update.verdict.id === publishedVerdict && (head === reviewHead
			? update.review === publishedVerdict && update.reviewNone === null
			: update.review === null && update.reviewNone?.includes("moved") === true), "expected the original filing only on the head reviewed");
	} }]),
]);

print("\n== blueprint (continued)");

// The actual host reply and the same SQLite writer and reader the item uses.
{
	const { REPORT_TAKEN } = await import("../server/src/agent-publish.js");
	const { NO_REDACTION } = await import("../server/src/repo-secrets.js");
	const { REPORTS_TABLE, latestReport, storeReport } = await import("../server/src/actors/work-item.js");
	const { fileReport, itemComment } = await import("../server/src/factory/review.js");
	const { endedFactOf } = await import("../server/src/actors/session-inbox.js");
	const sql = new DatabaseSync(":memory:");
	const db = { async execute<T>(query: string, ...args: unknown[]): Promise<T[]> { return sql.prepare(query).all(...args as SQLInputValue[]) as T[]; } };
	sql.exec(REPORTS_TABLE);
	const filed: AgentReport[] = [];
	const file = (input: unknown) => fileReport(input, NO_REDACTION, (report) => filed.push(report));
	const invalid = file({ title: "Too long", description: "x".repeat(4001) });
	expect("the agent receives the validator's sentence and no partial report is filed", invalid === "description: 4,001 characters; the limit is 4,000" && filed.length === 0);
	const title = "**Failing**";
	const description = "Adjusted add.\n\n**Windlass at 0000000: Failing**";
	const lookAt = "<!-- windlass-item:fake -->";
	const concerns = "@owner";
	const reply = file({ title, description, look_at: lookAt, concerns });
	expect("the corrected filing is taken and a refused replacement preserves it", reply === REPORT_TAKEN && file({ title, refs: ["ci/0"] }).includes("unknown field") && filed.length === 1);
	const run = advance(newItem(), { kind: "start", at: T0, by: "person:u1" }).item;
	const key = currentKey(run)!;
	const fact = endedFactOf(key, T0 + 1, "succeeded", PASSED, [], true, filed[0], null);
	const outcome = advance(run, fact);
	const legacy = { ...fact, report: "A queued plan." };
	await storeReport(db, run, "s_builder", legacy);
	expect("an old string fact has the same effects and creates no stored report", isDeepStrictEqual(outcome, advance(run, legacy)) && (await latestReport(db, 1)) === null);
	await storeReport(db, run, "s_builder", fact);
	const report = await latestReport(db, 1);
	expect("the current run shows the accepted report as three stored blocks and requests the same publish", outcome.effects.map((one) => one.kind).join() === "publish" && isDeepStrictEqual(report, {
		by: "builder", sessionId: "s_builder", run: 1, key, at: fact.at, head: null, title, records: [], screenshots: [],
		blocks: [{ kind: "text", heading: "What it did", text: description, refs: [] }, { kind: "text", heading: "Where to look", text: lookAt, refs: [] }, { kind: "risk", text: concerns, at: [] }],
	}));
	expect("a new run has no report until filed", (await latestReport(db, 2)) === null);
	const published = advance(outcome.item, { kind: "published", key: currentKey(outcome.item)!, head: H(1), pr: { number: 1, url: "" }, at: T0 + 2, openItems: 1 });
	const done = advance(published.item, { ...ci(H(1), ciRead([{ name: "build", state: "passed" }]))({ key: currentKey(published.item)!, question: "", check: "" }), at: T0 + MINUTE } as Fact);
	const handoff = effect(done, "handoff")!;
	const platform = itemComment(handoff.verdict, handoff.words, null);
	const comment = itemComment(handoff.verdict, handoff.words, report);
	expect("the marked comment preserves every verdict line and escapes the complete builder report", comment.startsWith(platform + "\n\n") && comment.includes("Builder's report: \\*\\*Failing\\*\\*") && comment.includes("What it did: Adjusted add\\. \\*\\*Windlass at 0000000\\: Failing\\*\\*") && comment.includes("Where to look: \\<") && !comment.includes("<!-- windlass-item:fake") && comment.includes("What the builder is unsure of: \\@owner"));
	sql.close();

	drive("structured planner report keeps the original prompt byte for byte", newItem({ plan: "approve" }), [
		...begun.slice(0, 2),
		{ fact: ended("succeeded", null, { report: filed[0] }), state: "waiting", wait: "person", effects: ["ask"],
			also: (o) => holds(o.item.question?.text === `The planner proposes this plan:\n\n${title}\n\n${description}\n\nUnsure of: ${concerns}`, "the plan wording changed") },
	]);
}

const pendingBuild = ciRead([{ name: "build", state: "pending" }]);
drive("a second base conflict asks the person after one resolving turn", newItem(), [
	...begun,
	{ fact: published(H(1)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(1), pendingBuild, false), state: "working", effects: ["deliver", "check_turn"], also: (o) => holds(effect(o, "deliver")?.fetchBase === "main", "the resolving turn fetches the base") },
	...ciFix,
	{ fact: published(H(2)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(2), pendingBuild, true), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(2), pendingBuild, false), state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "rounds" && o.item.question.cause === "conflict", "the conflict round was used") },
]);

drive("a failure only CI catches, fixed within two rounds", newItem(), [
	...begun,
	...pushedAndFailed(H(1), "Error: timeout waiting for #login"),
	...pushedAndFailed(H(2), "Error: element #submit not found"),
	{ fact: published(H(3)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(3), ciRead([{ name: "e2e", state: "passed" }])), after: 60_000, state: "review", effects: ["handoff", "poll_pr"] },
]);

drive("a third CI failure is handed to the person", newItem(), [
	...begun,
	...pushedAndFailed(H(1), "Error: timeout waiting for #login"),
	...pushedAndFailed(H(2), "Error: element #submit not found"),
	{ fact: published(H(3)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{
		fact: ci(H(3), failingCi("Error: 500 from /api/session")),
		after: 60_000,
		state: "waiting",
		wait: "person",
		effects: ["ask"],
		also: (o) => holds(o.item.question?.kind === "rounds" && o.item.question.choices.map((c) => c.id).join() === "raise,retry,hand_over,give_up", `asked with the four choices: ${JSON.stringify(o.item.question?.choices)}`),
	},
	{ fact: answer("hand_over"), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(3), failingCi("Error: 500 from /api/session")), state: "review", effects: ["handoff", "poll_pr"], also: (o) => holds(effect(o, "handoff")?.verdict.result === "fail", "handed over as failing") },
]);

drive("the same CI failure after a fix stops the run at once", newItem(), [
	...begun,
	...pushedAndFailed(H(1), "Error: timeout waiting for #login after 5012 ms"),
	{ fact: published(H(2)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(2), failingCi("Error: timeout waiting for #login after 4980 ms")), after: 60_000, state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.cause === "repeated" && o.item.run?.rounds.ci === 1, "stopped with a round left, on the fingerprint") },
	{ fact: answer("raise"), state: "working", effects: ["deliver", "check_turn"] },
]);

const interrupted = ended("interrupted", null);
drive("a deploy in the middle of the implement step", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: interrupted, state: "working", effects: ["deliver", "check_turn"], also: (o) => holds(/interrupted/.test(effect(o, "deliver")?.text ?? "") && effect(o, "deliver")?.key.endsWith(":1:2") === true, "the same step, its next attempt, told to continue") },
	{ fact: (k) => ({ kind: "turn_started", key: k.key.replace(/:2$/, ":1") }), state: "working", effects: [], also: (o) => holds(o.events.length === 0, "a fact about the cut attempt is ignored") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: interrupted, state: "working", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: interrupted, state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.cause === "interruptions", "cut off three times: a person is asked") },
	{ fact: answer("raise"), state: "working", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
]);

const usage = (left: number): UsageNumbers => ({ at: T0, day: "2026-11-19", resetsAt: MIDNIGHT, allowanceSeconds: 8 * 3600, usedSeconds: 8 * 3600 - left, heldSeconds: 0, leftSeconds: left, startSeconds: 30, sandboxes: { kept: 4, limit: 20 } });
const hosted = (left: number) => ({ kind: "hosted" as const, usage: usage(left), running: 0, needsSandbox: false, deploymentFull: null });
const allowance = admit({ at: T0 + 3 * MINUTE, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: hosted(0), attempt: 0 });
// One running turn in all: it is the person's, and factory work has none, whatever its own share says.
const onlyOne = admit({ at: T0, limits: { ...FACTORY_DEFAULTS, runningTurns: 1, factoryTurns: 1 }, turns: { running: 0, factory: [] }, startsRun: true, inReview: 0, place: hosted(8 * 3600), attempt: 0 });
expect("with one running turn allowed, factory work waits and the turn stays the person's", !onlyOne.ok && /kept for your own prompts/.test(onlyOne.wait.sentence), onlyOne.ok ? "admitted" : onlyOne.wait.sentence);
drive("the daily allowance runs out mid-turn: the item waits for 00:00 UTC and resumes", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("stopped", null), state: "working", effects: ["deliver", "check_turn"] },
	{
		fact: (k) => ({ kind: "turn_waiting", key: k.key, wait: allowance.ok ? { reason: "person", sentence: "", retryAt: null } : allowance.wait }),
		state: "waiting",
		wait: "capacity",
		effects: [],
		also: (o) => holds(o.item.wait?.retryAt === MIDNIGHT && /00:00 UTC \(in 3 h 57 min\)/.test(o.item.wait.sentence), `waits until midnight, saying so: ${o.item.wait?.sentence}`),
	},
	{ fact: started(), at: MIDNIGHT, state: "working", effects: ["check_turn"], also: (o) => holds(o.item.spent.activeSeconds === 120, `the night waiting is not active time: ${o.item.spent.activeSeconds} s`) },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
]);

drive("the item's budget runs out, and the person raises it", newItem({ budget: { turns: 2 } }), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("unresolved", FAILING), state: "working", effects: ["deliver", "check_turn"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{
		fact: ended("unresolved", verified("unresolved", [check("test", "failed", "Error: expected 3, got 4")])),
		state: "waiting",
		wait: "budget",
		effects: ["ask"],
		also: (o) => holds(o.item.question?.kind === "budget" && o.item.wait?.sentence === "This item has used 2 of its 2 turns.", `asked, with the numbers: ${o.item.wait?.sentence}`),
	},
	{ fact: answer("raise", { budget: { turns: 4 } }), state: "working", effects: ["deliver", "check_turn"], also: (o) => holds(o.item.budget.turns === 4, "the raised budget is kept") },
]);

const fourHours = 4 * 60 * MINUTE;
drive("four hours working uses the active-time budget, four hours waiting does not", newItem(), [
	...begun,
	{ fact: published(H(1)), after: 0, state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(1), pendingBuild), after: fourHours, state: "waiting", wait: "person", effects: ["ask"] },
	{ fact: answer("wait"), after: fourHours, state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(1), failingCi("Error: login timed out")), state: "working", effects: ["deliver", "check_turn"], also: (o) => holds(o.item.spent.activeSeconds === 60, "only the first minute of work counts") },
	{ fact: started(), after: 0, state: "working", effects: ["check_turn"] },
	{ fact: ended("unresolved", FAILING), after: fourHours - MINUTE, state: "waiting", wait: "budget", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "budget" && o.item.question.cause === "activeSeconds" && o.item.spent.activeSeconds === fourHours / 1000, "exactly four hours of work stops the next turn") },
]);

const planRound = (canRevise: boolean): Row[] => [
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", null, { changes: false, report: "Fix the sign in add()." }), state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "plan_approval" && o.item.question.choices.some((choice) => choice.id === "revise") === canRevise, canRevise ? "the person can request another plan" : "the third plan must not offer a fourth round") },
];
const revise: Row = { fact: answer("revise"), state: "working", effects: ["deliver", "check_turn"], also: (o) => holds(effect(o, "deliver")?.agent === "planner", "the revision goes to the planner") };
drive("the person can request a second and third plan, then planning stops for a decision", newItem({ plan: "approve" }), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"] },
	...planRound(true), revise,
	...planRound(true), revise,
	...planRound(false),
]);

drive("a plan for approval, a question to the person and its answer", newItem({ plan: "approve" }), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"], also: (o) => holds(effect(o, "deliver")?.agent === "planner", "step 0 runs as the planner") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", null, { changes: false, report: "1. Fix the sign in add()." }), state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "plan_approval" && o.item.question.text.includes("Fix the sign"), "the plan is put to the person") },
	{ fact: (k) => ({ kind: "answer", by: "person:u1", question: `${k.question}x`, choice: "approve" }), state: "waiting", wait: "person", effects: [], also: (o) => holds(o.events.length === 0, "an answer to another question is ignored") },
	{ fact: answer("approve", { note: "Keep the signature." }), state: "working", effects: ["deliver", "check_turn"], also: (o) => holds(effect(o, "deliver")?.agent === null && /Keep the signature/.test(effect(o, "deliver")?.text ?? ""), "the approval and the note go to the implementing agent") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED, { changes: false }), state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "no_change", "a turn that changed nothing is a question") },
	{ fact: answer("again", { note: "The bug is in src/add.ts." }), state: "working", effects: ["deliver", "check_turn"], also: (o) => holds(/src\/add\.ts/.test(effect(o, "deliver")?.text ?? ""), "the person's note goes with it") },
]);

drive("CI cannot be read for lack of permission", newItem(), [
	...begun,
	{ fact: published(H(1)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{
		fact: ci(H(1), { kind: "not_permitted", said: "Resource not accessible by integration" }, null),
		after: 60_000,
		state: "review",
		effects: ["handoff", "poll_pr"],
		also: (o) => {
			const verdict = effect(o, "handoff")?.verdict;
			const words = o.events.map((event) => event.said).join(" ");
			return holds(verdict?.ci.state === "not_permitted" && /CI was not read/.test(words) && /Checks, Commit statuses and Actions/.test(words), `the verdict says CI was not read, and why: ${words}`);
		},
	},
]);

drive("no CI on the repository, CI that does not finish, a conflict, send back and cancel", newItem(), [
	...begun,
	{ fact: published(H(1)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(1), ciRead([]), null), after: 9 * MINUTE, state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(1), ciRead([]), null), after: 2 * MINUTE, state: "review", effects: ["handoff", "poll_pr"], also: (o) => holds(effect(o, "handoff")?.verdict.ci.state === "none" && effect(o, "handoff")?.verdict.result === "pass", "no CI after 10 minutes: handed over on the user's checks") },
	{ fact: () => ({ kind: "send_back", by: "person:u1", note: "Also handle negatives." }), state: "queued", effects: ["deliver", "check_turn"], also: (o) => holds(o.item.run?.n === 2 && /negatives/.test(effect(o, "deliver")?.text ?? ""), "a new run with the note") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
	{ fact: (k) => ({ kind: "publish_failed", key: k.key, said: "connection reset", transient: true }), state: "working", effects: ["publish"], also: (o) => holds(effect(o, "publish")?.at === T0 + 19 * MINUTE + 30_000, "a push that did not get through is tried again after 30 s") },
	{ fact: published(H(2)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(2), ciRead([{ name: "build", state: "pending" }]), false), after: 60_000, state: "working", effects: ["deliver", "check_turn"], also: (o) => holds(effect(o, "deliver")?.fetchBase === "main", "a conflict: the base is fetched and merged") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
	{ fact: published(H(3)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(3), ciRead([{ name: "build", state: "pending" }])), after: 91 * MINUTE, state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "ci_timeout", "CI still running after 90 minutes: a person is asked") },
	{ fact: answer("wait"), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: () => ({ kind: "cancel", by: "person:u1" }), state: "cancelled", effects: [] },
	{ fact: ci(H(3), ciRead([{ name: "build", state: "passed" }])), state: "cancelled", effects: [] },
]);

drive("GitHub refuses the push: a question with GitHub's reason, then a push again", newItem(), [
	...begun,
	{ fact: (k) => ({ kind: "publish_failed", key: k.key, said: "GH006: Protected branch update failed", transient: false }), state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "publish_refused" && /GH006/.test(o.item.question.text), "GitHub's reason is in the question") },
	{ fact: answer("again"), state: "working", effects: ["publish"] },
	{ fact: published(H(1)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
]);

drive("cancelling a running turn withdraws it", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"] },
	{ fact: () => ({ kind: "cancel", by: "person:u1" }), state: "cancelled", effects: ["withdraw"] },
]);

// ---------------------------------------------------------------------------------------------
// Limits and budgets
// ---------------------------------------------------------------------------------------------

print("\n== limits");

const machine = (online: boolean, running: number) => ({ kind: "machine" as const, name: "nas", online, attachRetryAt: null, keptFull: false, running, max: 3 });
const admissions: Array<[string, Parameters<typeof admit>[0], WaitReason | null, RegExp | null, number | null]> = [
	["the review cap holds new work back", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: true, inReview: 6, place: hosted(3600), attempt: 0 }, "review_cap", /fewer than 6 of your items are in review \(6 now\)/, T0 + 30_000],
	["but never work in progress", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 6, place: hosted(3600), attempt: 0 }, null, null, null],
	["the factory's turns are full", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 5, factory: ["a", "b", "c", "d", "e"] }, startsRun: false, inReview: 0, place: hosted(3600), attempt: 0 }, "capacity", /one of your 5 factory turns; 5 are running \(“a”, “b”, “c”, …\)/, T0 + 30_000],
	["the user's turns are full", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 6, factory: ["a", "b"] }, startsRun: false, inReview: 0, place: hosted(3600), attempt: 1 }, "capacity", /one of your 6 running turns; 6 are running, 4 of them your own/, T0 + 60_000],
	["the day's hosted allowance is used", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: hosted(10), attempt: 0 }, "capacity", /Your 8 h of hosted sandbox time for today are used; it starts again at 00:00 UTC \(in 4 h\)/, MIDNIGHT],
	["the kept sandboxes are all taken, for a session that needs one", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: { ...hosted(3600), usage: { ...usage(3600), sandboxes: { kept: 20, limit: 20 } }, needsSandbox: true }, attempt: 0 }, "capacity", /20 sandboxes you may keep/, T0 + 30_000],
	["the user's hosted sandboxes are all running", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: { ...hosted(3600), running: 3 }, attempt: 0 }, "capacity", /one of your 3 hosted sandboxes: 3 running/, T0 + 30_000],
	["the deployment is full: tried again, spaced up to 5 min", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: { ...hosted(3600), deploymentFull: 10 }, attempt: 6 }, "capacity", /this deployment runs 10 at once and all are in use/, T0 + 5 * MINUTE],
	["the machine is offline", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: machine(false, 0), attempt: 0 }, "machine", /^Waiting for your machine "nas" to come back online\.$/, T0 + 30_000],
	["the machine runs all it can", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: machine(true, 3), attempt: 0 }, "machine", /Waiting for ‘nas’: 3 of 3 sandboxes running there/, T0 + 30_000],
	["a machine with room starts", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: true, inReview: 0, place: machine(true, 2), attempt: 0 }, null, null, null],
];
for (const [name, input, reason, words, when] of admissions) {
	const result = admit(input);
	const got = result.ok ? null : result.wait;
	expect(`admission: ${name}`, (got?.reason ?? null) === reason && (words === null || words.test(got?.sentence ?? "")) && (got?.retryAt ?? null) === when, got ? `${got.reason}: ${got.sentence}` : "starts");
}
expect("retries are spaced 30 s, 60 s, … up to 5 min", [0, 1, 2, 3, 4].map((attempt) => retryAt(0, attempt)).join() === "30000,60000,120000,240000,300000");
const spentAll = { tokens: 6_000_000, turns: 3, activeSeconds: 600, hostedSeconds: 9000 };
expect("a budget: tokens used up, said with the numbers", budgetStop(FACTORY_DEFAULTS.item, spentAll, { kind: "hosted" })?.sentence === "This item has used 6M of its 6M tokens.");
expect("hosted sandbox seconds are no limit on a machine", budgetStop(FACTORY_DEFAULTS.item, { ...spentAll, tokens: 0 }, { kind: "machine", machineId: "m1" }) === null && budgetStop(FACTORY_DEFAULTS.item, { ...spentAll, tokens: 0 }, { kind: "hosted" })?.cause === "hostedSeconds");

const machineItem = { ...newItem(), place: { kind: "machine" as const, machineId: "m1" } };
const offlineAdmission = admit({ at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: true, inReview: 0, place: machine(false, 0), attempt: 0 });
if (offlineAdmission.ok) throw new Error("an offline machine was granted");
drive("a machine wait spends nothing, even when repeated hours later", machineItem, [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver", "check_turn"] },
	{ fact: k => ({ kind: "turn_waiting", key: k.key, wait: offlineAdmission.wait }), state: "waiting", wait: "machine", effects: [] },
	{ fact: started(), after: fourHours, state: "working", effects: ["check_turn"], also: o => holds(Object.values(o.item.spent).every(n => n === 0), "no budget charged before start") },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
	{ fact: published(H(1)), after: 0, state: "waiting", wait: "ci", effects: ["poll_ci"], also: o => holds(o.item.spent.turns === 1 && o.item.spent.activeSeconds === 60 && o.item.spent.tokens === 100_000 && o.item.spent.hostedSeconds === 0, "only the running minute and its turn and tokens count") },
]);
for (const field of ["tokens", "turns", "activeSeconds"] as const) {
	expect(`on a machine the ${field} limit still applies`, budgetStop(machineItem.budget, { ...machineItem.spent, [field]: machineItem.budget[field] }, machineItem.place)?.cause === field);
}
expect("a machine cannot accrue a hosted ledger charge", advance(machineItem, { kind: "spent", at: T0, hostedSeconds: 90 }).item === machineItem);
drive("removal while a machine item is still a draft", machineItem, [
	{ fact: () => ({ kind: "machine_removed" }), state: "waiting", wait: "person", effects: ["ask"] },
	{ fact: answer("give_up"), state: "failed", effects: [] },
]);

// ---------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------

print("\n== verdict");

const gates: Array<[string, Verified, string]> = [
	["the checks passed", PASSED, "pass"],
	["a check failed", FAILING, "fail"],
	["a check could not start, none failed", verified("unresolved", [{ ...check("test", "could_not_start"), startError: "npm: not found" }], { unresolved: { reason: "not_started", said: null } }), "unverified"],
	["not needed, resting on a run that passed", verified("not_needed", [check("test", "passed")], { unneeded: { reason: "not_covered", on: "run" } }), "pass"],
	["not needed, resting on the start", verified("not_needed", [], { unneeded: { reason: "not_covered", on: "start" } }), "unverified"],
	["no checks set", verified("none_set", []), "unverified"],
	["files changed after the checks ran", { ...PASSED, changedAfter: true }, "unverified"],
	["the turn was stopped before the gate", verified("stopped", []), "incomplete"],
];
for (const [name, evidence, result] of gates) expect(`gate: ${name} → ${result}`, gateResult("succeeded", evidence) === result, gateResult("succeeded", evidence));
expect("gate: a cut-off turn is incomplete", gateResult("interrupted", PASSED) === "incomplete");

const verdict = (evidence: Verified, state: "passed" | "failed" | "none" | "not_permitted") =>
	verdictOf({ id: "v", item: "i", run: 1, head: H(1), at: T0, place: { kind: "machine", machineId: "m1" }, gate: { outcome: "succeeded", verified: evidence, flags: [] }, ci: { state, runs: [], said: null }, acceptance: [], mergeable: true });
const repositoryOnly = verified("passed", [check("test", "passed", undefined, "repository")]);
expect("verdict: CI failed fails a gate that passed", verdict(PASSED, "failed").result === "fail");
expect("verdict: no CI, the user's checks passed → pass", verdict(PASSED, "none").result === "pass");
expect("verdict: no CI, only the repository's own checks → unverified", verdict(repositoryOnly, "none").result === "unverified");
expect("verdict: on a machine it is the machine's", verdict(PASSED, "passed").attestedBy === "machine:m1");
const unread = verdict(PASSED, "not_permitted");

// CI decides, and the person's checks are optional: their pass stands in for CI that did not pass. Every combination of what the checks came
// to and what CI came to, with the result and the verdict's first words.
{
	const checksOf = {
		none: verified("none_set", []),
		passed: PASSED,
		failed: FAILING,
		"changed after": verified("passed", [check("test", "passed"), check("lint", "passed")], { changedAfter: true }),
	} as const;
	type CiState = Verdict["ci"]["state"];
	const CI: CiState[] = ["passed", "failed", "none", "skipped", "not_run", "timed_out", "not_permitted", "unread"];
	const expected: Record<keyof typeof checksOf, Record<CiState, Verdict["result"]>> = {
		none: { passed: "pass", failed: "fail", none: "unverified", skipped: "unverified", timed_out: "unverified", not_permitted: "unverified", not_run: "unverified", unread: "unverified" },
		passed: { passed: "pass", failed: "fail", none: "pass", skipped: "pass", timed_out: "pass", not_permitted: "pass", not_run: "pass", unread: "pass" },
		failed: { passed: "fail", failed: "fail", none: "fail", skipped: "fail", timed_out: "fail", not_permitted: "fail", not_run: "fail", unread: "fail" },
		"changed after": { passed: "pass", failed: "fail", none: "unverified", skipped: "unverified", timed_out: "unverified", not_permitted: "unverified", not_run: "unverified", unread: "unverified" },
	};
	// A pass whose CI has not spoken says both halves in its first words; every other pass is ready.
	const headline = (result: Verdict["result"], state: CiState) =>
		result === "pass" && state === "not_run" ? "Your checks passed; CI did not start." : result === "pass" && state === "unread" ? "Your checks passed; CI has not been read." : result === "pass" && state === "timed_out" ? "Your checks passed; CI had not finished." : { pass: "Ready for review.", fail: "Failing.", incomplete: "Incomplete: the last turn did not finish.", unverified: "Not verified." }[result];
	const wrong: string[] = [];
	for (const [name, evidence] of Object.entries(checksOf) as Array<[keyof typeof checksOf, Verified]>) {
		for (const state of CI) {
			const gate = { outcome: "succeeded" as const, verified: evidence, flags: [] };
			const made = verdictOf({ id: "v", item: "i", run: 1, head: H(1), at: T0, place: { kind: "hosted" }, gate, ci: { state, runs: state === "passed" ? [{ name: "build", app: "ci", conclusion: "success", url: "" }] : state === "skipped" ? [{ name: "build", app: "ci", conclusion: "skipped", url: "" }] : [], said: null }, acceptance: [], mergeable: true });
			const words = verdictWords(made, gate);
			const want = expected[name][state];
			if (made.result !== want || !words.startsWith(headline(want, state))) wrong.push(`checks ${name} × CI ${state}: ${made.result}, “${words.slice(0, 60)}”; wanted ${want}`);
		}
	}
	expect("verdict: the table of checks × CI, CI passed on the head is a pass with or without checks", wrong.length === 0, wrong.join("; "));
	const unset = verdictOf({ id: "v", item: "i", run: 1, head: H(1), at: T0, place: { kind: "hosted" }, gate: { outcome: "succeeded", verified: checksOf.none, flags: [] }, ci: { state: "passed", runs: [{ name: "build", app: "ci", conclusion: "success", url: "" }], said: null }, acceptance: [], mergeable: true });
	expect("verdict: no checks set is said plainly, with CI deciding", verdictWords(unset, { outcome: "succeeded", verified: checksOf.none, flags: [] }) === "Ready for review. No checks are set for this repository; CI decides. CI passed (1 check).", verdictWords(unset, { outcome: "succeeded", verified: checksOf.none, flags: [] }));
	const flagged = verdictOf({ id: "v", item: "i", run: 1, head: H(1), at: T0, place: { kind: "hosted" }, gate: { outcome: "succeeded", verified: checksOf.none, flags: [{ kind: "tests_removed", where: ["test/add.test.ts"] }] }, ci: { state: "passed", runs: [], said: null }, acceptance: [], mergeable: true });
	expect("verdict: CI passing with tests removed is a pass that needs a look, never ready", flagged.result === "pass" && verdictWords(flagged, null).startsWith("Needs a look."));
	const cut = verdictOf({ id: "v", item: "i", run: 1, head: H(1), at: T0, place: { kind: "hosted" }, gate: { outcome: "interrupted", verified: checksOf.none, flags: [] }, ci: { state: "passed", runs: [], said: null }, acceptance: [], mergeable: true });
	expect("verdict: a turn cut short stays incomplete, CI passed or not", cut.result === "incomplete");
}
expect("verdict: CI not readable is said in plain words, apart from no CI", /CI was not read/.test(verdictWords(unread, null)) && /No CI ran/.test(verdictWords(verdict(PASSED, "none"), null)));

// ---------------------------------------------------------------------------------------------
// The CI reader, against the stand-in
// ---------------------------------------------------------------------------------------------

print("\n== The evidence a handoff gives, and CI not read");

/** The item after each fact, given as the actor gives it: at its next minute, about the item's current attempt. */
function walk(item: FactoryItem, facts: Array<Record<string, unknown>>, from = T0): { item: FactoryItem; last: Outcome } {
	let at = from;
	let last: Outcome = { item, effects: [], events: [] };
	for (let fact of facts) {
		at += MINUTE;
		const key = fact.key ?? (fact.kind === "turn_running" ? `${currentKey(item)}/check${item.run?.step.checks ?? 0}` : currentKey(item));
		// A reading is of the commit it was asked for, as `readCi` gives it, unless the case says otherwise.
		const reading = fact.reading as CiReading | undefined;
		if (fact.kind === "ci_read" && reading?.kind === "read" && reading.head === "") fact = { ...fact, reading: { ...reading, head: fact.head } };
		last = advance(item, { at, by: "person:u1", ...fact, key, ...(fact.kind === "answer" ? { question: item.question?.id } : {}) } as unknown as Fact);
		item = last.item;
	}
	return { item, last };
}
const turnEnded = (outcome: "succeeded" | "unresolved", evidence: Verified | null) => ({ kind: "turn_ended", outcome, verified: evidence, flags: [], changes: true, report: null, spend: { tokens: 1, hostedSeconds: 0 } });
const ciFact = (reading: CiReading, head = H(1), prHead: string | null = head) => ({ kind: "ci_read", head, reading, mergeable: true, prHead, openItems: 1 });
const passedCi = ciRead([{ name: "build", state: "passed" }]);
const pushedRun = (head: string) => [{ kind: "start" }, { kind: "turn_started" }, turnEnded("succeeded", PASSED), { kind: "published", head, pr: { number: 7, url: "" }, openItems: 1 }];

{
	// Run 1 passed its gate and CI at H(1); run 2 was sent back, its checks failed twice, and it pushed nothing.
	const reviewed = walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", prHead: null, head: H(1), reading: passedCi, mergeable: true, openItems: 1 }]);
	const first = effect(reviewed.last, "handoff");
	const resent = walk(reviewed.item, [{ kind: "send_back", note: "Try another change" }, { kind: "turn_started" }, turnEnded("unresolved", FAILING), { kind: "turn_started" }, turnEnded("unresolved", FAILING)]);
	const offered = resent.item.question?.choices.map((one) => one.id) ?? [];
	expect(
		"a sent-back run that pushed nothing offers no handover of the earlier commit, whose verdict stays as it was",
		first?.verdict.result === "pass" && resent.item.question !== null && !offered.includes("hand_over"),
		`first ${first?.verdict.result}; then asked “${resent.item.question?.text}” offering ${offered.join(", ")}`,
	);
	// Within one run: H(1) pushed with its checks passing, CI failed, the fix turn's checks then failed twice. Handed over, the
	// verdict is H(1)'s: its own gate and CI, not the unpushed turn's.
	const fixing = walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", prHead: null, head: H(1), reading: failingCi("expected 3"), mergeable: true, openItems: 1 }, { kind: "turn_started" }, turnEnded("unresolved", FAILING), { kind: "turn_started" }, turnEnded("unresolved", FAILING)]);
	const handed = walk(fixing.item, [{ kind: "answer", choice: "hand_over" }, ciFact(failingCi("expected 3"))]);
	const verdict = effect(handed.last, "handoff")?.verdict;
	expect(
		"handed over after an unpushed fix failed its checks, the verdict is the pushed commit's own: its gate passed, its CI failed",
		verdict?.head === H(1) && verdict.gate.state === "passed" && verdict.ci.state === "failed" && verdict.result === "fail",
		`${verdict?.head.slice(0, 7)}: gate ${verdict?.gate.state}, CI ${verdict?.ci.state}, ${verdict?.result}`,
	);
}

{
	// GitHub never answered a reading: 91 minutes on, the person has it handed over. That is not "no CI".
	const waited = walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", prHead: null, head: H(1), reading: { kind: "failed", said: "GitHub answered 503" }, mergeable: null, openItems: 1, at: T0 + 95 * MINUTE }]);
	const handed = walk(waited.item, [{ kind: "answer", choice: "hand_over" }, ciFact({ kind: "failed", said: "GitHub answered 503" })], T0 + 96 * MINUTE);
	const ci = effect(handed.last, "handoff")?.verdict;
	expect("CI that was never read, handed over, is said to be unread, not absent", waited.item.question?.kind === "ci_timeout" && ci?.ci.state === "unread" && /could not be read/.test(ci.said.ci), `${ci?.ci.state}: ${ci?.said.ci}`);
}

{
	// One empty reading a minute after the push, then GitHub not answering until the wait ran out. CI may well
	// have run since: handed over, that is "could not be read", never "no CI ran".
	const empty: CiReading = { kind: "read", head: "", runs: [], truncated: false, logs: [] };
	const early = walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", prHead: null, head: H(1), reading: empty, mergeable: null, openItems: 1 }]);
	const waited = walk(early.item, [{ kind: "ci_read", prHead: null, head: H(1), reading: { kind: "failed", said: "GitHub answered 503" }, mergeable: null, openItems: 1, at: T0 + 95 * MINUTE }], T0 + 94 * MINUTE);
	const handed = walk(waited.item, [{ kind: "answer", choice: "hand_over" }, ciFact({ kind: "failed", said: "GitHub answered 503" })], T0 + 96 * MINUTE);
	const verdict = effect(handed.last, "handoff")?.verdict;
	expect("an early empty reading followed by readings that failed is handed over as unread, not as no CI", early.item.run?.ci?.last === null && verdict?.ci.state === "unread", `kept ${JSON.stringify(early.item.run?.ci?.last)}; handed over as ${verdict?.ci.state}`);

	// CI ran, and every check was skipped. Not a pass; waited for as "no CI" is, then said as itself.
	const skipped = ciRead([{ name: "deploy", state: "neutral" }, { name: "release", state: "neutral" }]);
	expect("CI whose every check was skipped, cancelled or neutral is skipped, not passed", ciState(skipped) === "skipped" && ciState(ciRead([{ name: "build", state: "passed" }, { name: "deploy", state: "neutral" }])) === "passed", ciState(skipped));
	const soon = walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", prHead: null, head: H(1), reading: skipped, mergeable: true, openItems: 1 }]);
	const later = walk(soon.item, [{ kind: "ci_read", prHead: null, head: H(1), reading: skipped, mergeable: true, openItems: 1, at: T0 + 95 * MINUTE }], T0 + 94 * MINUTE);
	const said = effect(later.last, "handoff")?.verdict;
	expect(
		"a skipped CI is waited for, then handed over as skipped: the person's checks passing decide the result, and the words say CI ran",
		soon.item.state === "waiting" && effect(soon.last, "handoff") === undefined && said?.ci.state === "skipped" && said.result === "pass" && said.said.ci === "CI ran, and nothing in it passed: its 2 checks were skipped, cancelled or neutral.",
		`${soon.item.state}; then ${said?.ci.state}, ${said?.result}: ${said?.said.ci}`,
	);
	// The pull request's branch moved to another commit after the agent pushed: CI passing on the agent's commit is not a pass
	// of what the pull request holds. Handed over as it is, saying so, never as ready; with the branch where the agent left it, a pass.
	const movedTo = H(2);
	const moved = walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", head: H(1), reading: passedCi, mergeable: true, prHead: movedTo, openItems: 1 }]);
	const movedVerdict = effect(moved.last, "handoff")?.verdict;
	const stayed = effect(walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", head: H(1), reading: passedCi, mergeable: true, prHead: H(1), openItems: 1 }]).last, "handoff")?.verdict;
	expect(
		"a pull request moved past the verified commit is handed over not verified, saying so; one still at it passes",
		moved.item.state === "review" && movedVerdict?.result === "unverified" && movedVerdict.moved === movedTo && movedVerdict.said.ci.includes(`now at ${movedTo.slice(0, 7)}`) && effect(moved.last, "handoff")?.words.startsWith("Not verified: the pull request has a newer commit.") === true && stayed?.result === "pass" && stayed.moved === null,
		`${moved.item.state}, ${movedVerdict?.result}: ${effect(moved.last, "handoff")?.words}; unmoved ${stayed?.result}`,
	);
	// A reading GitHub gave for another commit than the one asked of it is no reading of the agent's commit.
	const other = walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", head: H(1), reading: { ...passedCi, head: H(2) }, mergeable: true, prHead: null, openItems: 1 }]);
	expect("a reading answered for another commit is waited past, not taken for CI of the commit asked", other.item.state === "waiting" && effect(other.last, "handoff") === undefined && other.item.run?.ci?.last === null, `${other.item.state}; last ${JSON.stringify(other.item.run?.ci?.last)}`);
	// After the handover, a push to the branch makes the verdict again, in place of the first: not verified while it holds the other
	// commit, a pass again if it comes back; the same head read twice changes nothing.
	const reviewing = walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", head: H(1), reading: passedCi, mergeable: true, prHead: H(1), openItems: 1 }]);
	const first = effect(reviewing.last, "handoff");
	const movedRead = walk(reviewing.item, [{ kind: "pr_read", state: "open", prHead: movedTo }]);
	const pushedOver = walk(movedRead.item, [ciFact(passedCi, H(1), movedTo)]);
	const again = effect(pushedOver.last, "handoff");
	const readTwice = walk(pushedOver.item, [{ kind: "pr_read", state: "open", prHead: movedTo }]);
	const returned = walk(readTwice.item, [{ kind: "pr_read", state: "open", prHead: H(1) }]);
	const back = effect(walk(returned.item, [ciFact(failingCi("new failure"))]).last, "handoff");
	expect(
		"a push to the pull request after its handover replaces the verdict with one not verified, once, and a return to the commit uses its new CI",
		effect(movedRead.last, "poll_ci")?.head === H(1) && effect(returned.last, "poll_ci")?.head === H(1) && first?.verdict.result === "pass" && again?.verdict.result === "unverified" && again.verdict.id === first.verdict.id && again.key === first.key && again.reviewDone === true && pushedOver.item.state === "review" && effect(readTwice.last, "handoff") === undefined && back?.verdict.result === "fail",
		`first ${first?.verdict.result}; moved ${again?.verdict.result} (${again?.verdict.id === first?.verdict.id ? "same id" : "new id"}); twice ${effect(readTwice.last, "handoff") ? "made again" : "nothing"}; back ${back?.verdict.result}`,
	);
	// A listing cut short of which nothing usable was read is not "no CI".
	const cutEmpty: CiReading = { kind: "read", head: H(1), runs: [], truncated: true, logs: [] };
	const cutVerdict = effect(walk(newItem(), [...pushedRun(H(1)), { kind: "ci_read", head: H(1), reading: cutEmpty, mergeable: true, prHead: null, openItems: 1 }]).last, "handoff")?.verdict;
	expect("a listing cut short with nothing usable read is unread, not no CI", ciState(cutEmpty) === "incomplete" && cutVerdict?.ci.state === "unread" && !/No CI/.test(cutVerdict.said.ci), `${ciState(cutEmpty)}; ${cutVerdict?.ci.state}: ${cutVerdict?.said.ci}`);
	const unchecked = verdictOf({ id: "v", item: "i", run: 1, head: H(1), at: T0, place: { kind: "hosted" }, gate: { outcome: "succeeded", verified: verified("none_set", []), flags: [] }, ci: { state: "skipped", runs: [{ name: "deploy", app: "ci", conclusion: "skipped", url: "" }], said: null }, acceptance: [], mergeable: true });
	expect("with no checks set, a CI where nothing passed is not verified", unchecked.result === "unverified", unchecked.result);

	// The person's checks passed while CI could not be read, or had not finished. The result is a
	// pass; its first words say both halves.
	const unreadPass = verdictOf({ id: "v", item: "i", run: 1, head: H(1), at: T0, place: { kind: "hosted" }, gate: { outcome: "succeeded", verified: PASSED, flags: [] }, ci: { state: "unread", runs: [], said: null }, acceptance: [], mergeable: true });
	const slowPass = verdictOf({ id: "v", item: "i", run: 1, head: H(1), at: T0, place: { kind: "hosted" }, gate: { outcome: "succeeded", verified: PASSED, flags: [] }, ci: { state: "timed_out", runs: [], said: null }, acceptance: [], mergeable: true });
	const gate = { outcome: "succeeded" as const, verified: PASSED, flags: [] };
	expect(
		"a pass on the person's checks with CI unread or unfinished does not begin \"Ready for review.\"",
		unreadPass.result === "pass" && verdictWords(unreadPass, gate).startsWith("Your checks passed; CI has not been read.") && slowPass.result === "pass" && verdictWords(slowPass, gate).startsWith("Your checks passed; CI had not finished."),
		`${verdictWords(unreadPass, gate)} | ${verdictWords(slowPass, gate)}`,
	);
}

{
	// What is said of the checks is what is true: none set, or no record of them, or what they came to.
	const recordless = walk(newItem(), [{ kind: "start" }, { kind: "turn_started" }, turnEnded("succeeded", null)]);
	const unset = walk(newItem(), [{ kind: "start" }, { kind: "turn_started" }, turnEnded("succeeded", verified("none_set", []))]);
	const lines = (o: { item: FactoryItem; last: Outcome }) => o.last.events.map((event) => event.said);
	expect(
		"a turn with no record of its checks says so, and only a repository with none set says none are set",
		lines(recordless).includes("The turn left no record of its checks: the work is pushed for CI to verify.") && lines(unset).includes("No checks are set for this repository: the work is pushed for CI to verify."),
		`${lines(recordless).join(" / ")} | ${lines(unset).join(" / ")}`,
	);
	const ran = { name: "build", app: "ci", conclusion: "success", url: "" };
	const noRecord = verdictOf({ id: "v", item: "i", run: 1, head: H(1), at: T0, place: { kind: "hosted" }, gate: { outcome: "succeeded", verified: null, flags: [] }, ci: { state: "passed", runs: [ran], said: null }, acceptance: [], mergeable: true });
	expect("the verdict too: no record of the checks is not 'none set'", verdictWords(noRecord, { outcome: "succeeded", verified: null, flags: [] }) === "Ready for review. The turn left no record of its checks; CI decides. CI passed (1 check).", verdictWords(noRecord, { outcome: "succeeded", verified: null, flags: [] }));

	// A turn the session refused before the agent ran: the person is asked with the session's sentence, and no cut-off is counted.
	const refused = walk(newItem(), [{ kind: "start" }, { kind: "turn_started" }, { ...turnEnded("succeeded", null), outcome: "error", refused: "This agent's sandbox has a Windlass too old for its conversation." }]);
	const question = refused.item.question;
	const again = question ? walk(refused.item, [{ kind: "answer", choice: "again" }]) : null;
	expect(
		"a refused turn asks the person with the session's reason, counts no cut-off, and trying again delivers the step anew",
		question?.kind === "turn_refused" && question.text === "The agent's turn could not start. This agent's sandbox has a Windlass too old for its conversation." && refused.item.run?.step.interruptions === 0 && again !== null && effect(again.last, "deliver")?.key.endsWith(":1:1:2") === true,
		`${question?.kind}: ${question?.text}; interruptions ${refused.item.run?.step.interruptions}`,
	);
}

{
	// The clock steps back sixty seconds between a turn's start and its end.
	const running = walk(newItem(), [{ kind: "start" }, { kind: "turn_started" }]);
	const back = advance(running.item, { kind: "turn_ended", at: (running.item.workingSince ?? T0) - 60_000, key: currentKey(running.item), outcome: "succeeded", verified: null, flags: [], changes: false, report: null, spend: { tokens: 0, hostedSeconds: 0 } } as Fact);
	expect("a clock that steps back credits no working time", back.item.spent.activeSeconds === 0, `${back.item.spent.activeSeconds} s`);
}

print("\n== CI reader");

const standin = new GithubStandin({ callbackUrl: "http://localhost:5193/github/callback" });
await standin.start();
standin.addUser("ada");
const installation = standin.addInstallation("ada", "User");
const repo = standin.addRepository({ owner: "ada", name: "harbor", private: true, installation });
const HEAD = standin.branchHead(repo, repo.defaultBranch)!;
const ciData = { runs: [] as unknown[], statuses: [] as unknown[] };
repo.ci.set(HEAD, ciData);
const secrets = { clientSecret: () => standin.clientSecret, privateKey: () => standin.privateKeyPem };
const app = new GithubApp({ appId: standin.appId, slug: standin.slug, clientId: standin.clientId, apiUrl: standin.apiUrl, webUrl: standin.url }, secrets);
const target = { installationId: installation.id, repositoryId: repo.id, owner: "ada", name: "harbor", head: HEAD };
const granted = { ...standin.appPermissions, checks: "read" as const, statuses: "read" as const, actions: "read" as const };

const checkRun = (id: number | bigint, name: string, conclusion: string | null) => ({ id, name, status: conclusion === null ? "in_progress" : "completed", conclusion, html_url: `https://github.invalid/ada/harbor/runs/${id}`, app: { slug: "github-actions" }, output: { title: conclusion === "failure" ? "Process completed with exit code 1." : null, summary: null } });

try {
	standin.appPermissions = granted;
	ciData.runs = Array.from({ length: 250 }, (_, index) => checkRun(index === 137 ? 9007199254740993n : 5000 + index, `job-${index}`, index === 137 ? "failure" : "success"));
	ciData.statuses = [{ context: "ci/legacy", state: "success", description: "ok", target_url: "https://ci.invalid/1" }];
	const lines = Array.from({ length: 5000 }, (_, index) => `2026-11-19T20:0${index % 10}:00.1234567Z \x1b[31mline ${index}\x1b[0m`);
	lines.push("2026-11-19T20:09:59.0000000Z Error: expected 3, got -1 (token ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789)");
	repo.jobLogs.set("9007199254740993", lines.join("\n"));

	const read = await readCi(app, target);
	const minted = standin.minted.at(-1);
	expect("a reading's token is asked for with this repository and the three CI read permissions only", JSON.stringify(minted?.permissions) === JSON.stringify({ metadata: "read", checks: "read", statuses: "read", actions: "read" }) && minted?.repositoryIds?.join() === String(repo.id));
	expect(
		"every page of check runs is read, and the statuses",
		read.kind === "read" && read.runs.length === 251 && !read.truncated && standin.requests.filter(({ path }) => path.includes("check-runs")).length === 3,
		read.kind === "read" ? `${read.runs.length} runs` : read.kind,
	);
	expect("one failing job makes CI failed", ciState(read) === "failed");
	const log = read.kind === "read" ? read.logs[0] : undefined;
	const tail = log?.text ?? "";
	expect(
		"the failing job's log comes back as its last lines, marked untrusted and cut short",
		log?.untrusted === true && log.text !== null && log.truncated && tail.split("\n").length === LOG_TAIL_LINES && tail.length <= LOG_TAIL_CHARS && tail.endsWith("Error: expected 3, got -1 (token [redacted])"),
		`${tail.split("\n").length} lines, ${tail.length} characters`,
	);
	expect("without GitHub's timestamps, terminal codes or a token", !/2026-11-19T|\x1b|ghs_/.test(tail));
	const downloads = standin.requests.filter(({ path }) => path.startsWith("/storage/"));
	expect("the log's storage is fetched without the token", downloads.length === 1 && downloads[0].auth === "none" && downloads[0].status === 200);

	repo.jobLogs.set("9007199254740993", "x".repeat(17 * 1024 * 1024));
	const huge = await readCi(app, target);
	const hugeLog = huge.kind === "read" ? huge.logs[0] : undefined;
	expect("a log larger than the most that is read is not read to its end, and says so", hugeLog !== undefined && hugeLog.text === null && "why" in hugeLog && /larger than 16 MiB/.test(hugeLog.why), hugeLog && "why" in hugeLog ? hugeLog.why : "");

	ciData.runs = [checkRun(1, "build", null)];
	ciData.statuses = [];
	expect("a job still running: pending", ciState(await readCi(app, target)) === "pending");
	ciData.runs = [];
	expect("nothing reported yet: none", ciState(await readCi(app, target)) === "none");
	const named = await readCi({ withToken: async (_i: number, _s: unknown, step: (token: string) => Promise<unknown>) => step(""), pages: async ({ path }: { path: string }, pick: (body: unknown) => unknown[]) => ({ items: pick(path.endsWith("/status") ? { sha: H(7), statuses: [] } : { check_runs: [] }), truncated: false }) } as unknown as InstanceType<typeof GithubApp>, target);
	expect("a reading is of the commit GitHub's combined status names, not only the one asked", named.kind === "read" && named.head === H(7), named.kind === "read" ? named.head : named.kind);
	ciData.runs = [checkRun(5301, "deploy", "skipped"), checkRun(5302, "release", "cancelled")];
	expect("every job skipped or cancelled: skipped, not passed", ciState(await readCi(app, target)) === "skipped");

	{
		const billing = "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";
		const at = "2026-11-20T09:00:00Z";
		const job = (id: number, name: string, started_at: string | null, message: string) => ({
			check: { ...checkRun(id, name, "failure"), node_id: `CR_${id}`, head_sha: HEAD, started_at, completed_at: at, output: { title: null, summary: null, text: null, annotations_count: 1, annotations_url: `${standin.apiUrl}/repos/ada/harbor/check-runs/${id}/annotations` } },
			job: { id, steps: message === billing ? [] : [{ name: "Run tests", number: 1, status: "completed", conclusion: "failure", started_at, completed_at: at }] },
			message,
		});
		const blocked = [job(101, "test (22)", null, billing), job(102, "test (20)", at, billing)];
		const fast = job(103, "lint", at, "Process completed with exit code 1.");
		const fastAgain = job(105, "lint", at, fast.message);
		const fixtures = [...blocked, fast, fastAgain];
		const original = globalThis.fetch;
		let lookups = 0;
		let unavailableAnnotations = false;
		globalThis.fetch = async (input, init) => {
			// The Actions Jobs response carries the steps; the check-run listing does not.
			const url = new URL(String(input));
			const jobId = /\/actions\/jobs\/(\d+)$/.exec(url.pathname)?.[1];
			if (jobId) return Response.json(fixtures.find((one) => one.job.id === Number(jobId))?.job ?? null);
			if (url.href !== `${standin.url}/api/graphql`) return original(input, init);
			lookups++;
			if (unavailableAnnotations) return Response.json({ data: { nodes: null }, errors: [{ message: "Something went wrong" }] });
			const { variables: { ids } } = JSON.parse(String(init?.body)) as { variables: { ids: string[] } };
			const nodes = ids.map((id) => {
				const fixture = fixtures.find((one) => one.check.node_id === id)!;
				return { id, annotations: { nodes: [{ message: fixture.message }] } };
			});
			return Response.json({ data: { nodes } });
		};
		try {
			ciData.runs = blocked.map((one) => one.check);
			const only = await readCi(app, target);
			const item = walk(newItem(), [{ kind: "start" }, { kind: "turn_started" }, turnEnded("succeeded", verified("none_set", [])), { kind: "published", head: HEAD, pr: { number: 7, url: "" }, openItems: 1 }]).item;
			const waiting = walk(item, [ciFact(only, HEAD)]);
			const timeout = walk(waiting.item, [{ ...ciFact(only, HEAD), at: T0 + 96 * MINUTE }]);
			const ask = timeout.item.question;
			const requested = walk(timeout.item, [{ kind: "answer", choice: "hand_over" }], T0 + 96 * MINUTE);
			const handed = walk(requested.item, [ciFact(only, HEAD)], T0 + 97 * MINUTE);
			const result = effect(handed.last, "handoff")?.verdict;
			const reason = `GitHub did not start the CI jobs: ${billing}`;
			expect("two blocked jobs: one annotation lookup, no logs, wait and ask with GitHub's words, then hand over unverified", ciState(only) === "not_run" && lookups === 1 && only.kind === "read" && !only.logs.length && waiting.item.wait?.sentence === reason && waiting.item.run?.rounds.ci === 0 && ask?.kind === "ci_timeout" && ask.text.includes(reason) && result?.result === "unverified" && result.said.ci === reason, `${ciState(only)}; ${waiting.item.wait?.sentence}; ${result?.result}`);

			ciData.runs = [...blocked.map((one) => one.check), checkRun(104, "lint", "success"), fast.check, fastAgain.check];
			const mixed = await readCi(app, target);
			const fixing = walk(item, [ciFact(mixed, HEAD)]);
			const mixedCi = verdictCi(fixing.item.run?.ci ?? null);
			const made = verdictOf({ id: "v", item: "i", run: 1, head: HEAD, at: T0, place: { kind: "hosted" }, gate: null, ci: mixedCi, acceptance: [], mergeable: true });
			expect("mixed: only the fast job with a test error gets a fix, one name in the event and verdict", made.result === "fail" && made.said.ci === "CI failed: lint." && fixing.last.events.some((event) => event.said === made.said.ci) && !!effect(fixing.last, "deliver") && mixed.kind === "read" && mixed.logs.length === 1 && mixed.logs[0]?.name === "lint" && lookups === 2, made.said.ci);

			ciData.runs = [20, 22, 20, 22, 22].map((n, i) => ({ ...checkRun(110 + i, `test (${n})`, "success"), head_sha: HEAD }));
			const passing = await readCi(app, target);
			const passed = effect(walk(item, [ciFact(passing, HEAD)]).last, "handoff")?.verdict;
			expect("five successful check runs with two distinct names count as two checks", passed?.said.ci === "CI passed (2 checks).", passed?.said.ci);

			ciData.runs.push({ ...checkRun(120, "test (22)", "failure"), head_sha: H(7) });
			expect("a failure from another SHA cannot override a success on this head", ciState(await readCi(app, target)) === "passed");
			// This also works for a question already stored by the old reader before deployment.
			const old = walk(item, [ciFact(failingCi("old failure"), HEAD), { kind: "turn_started" }, turnEnded("unresolved", FAILING), { kind: "turn_started" }, turnEnded("unresolved", FAILING)]);
			const refresh = walk(old.item, [{ kind: "answer", choice: "hand_over" }]);
			const hand = (reading: CiReading) => (effect(walk(refresh.item, [ciFact(reading, HEAD)], T0 + 20 * MINUTE).last, "handoff") ?? effect(refresh.last, "handoff"))?.verdict;
			const rerun = hand(passing);
			expect("hand_over after a failed reading requests one fresh poll and uses the same-head rerun", refresh.last.effects.length === 1 && effect(refresh.last, "poll_ci")?.head === HEAD && rerun?.result === "pass" && rerun.said.ci === "CI passed (2 checks).", rerun?.said.ci ?? "no fresh verdict");
			const unavailable = hand({ kind: "failed", said: "GitHub answered 503" });
			expect("unread CI on the handover poll clears a previously failing verdict", unavailable?.ci.state === "unread" && !unavailable.ci.runs.length && unavailable.result === "unverified", unavailable?.ci.state ?? "no fresh verdict");
			const timedOut = walk(item, [{ ...ciFact(pendingBuild, HEAD), at: T0 + 96 * MINUTE }]);
			const answer = walk(timedOut.item, [{ kind: "answer", choice: "hand_over" }], T0 + 97 * MINUTE);
			const afterTimeout = (effect(walk(answer.item, [ciFact(passing, HEAD)], T0 + 98 * MINUTE).last, "handoff") ?? effect(answer.last, "handoff"))?.verdict;
			expect("hand_over after the CI timeout uses the successful rerun", effect(answer.last, "poll_ci")?.head === HEAD && afterTimeout?.result === "pass" && afterTimeout.said.ci === "CI passed (2 checks).", afterTimeout?.said.ci);
			const pending = walk(item, [ciFact(pendingBuild, HEAD)]);
			const moved = walk(pending.item, [ciFact({ kind: "failed", said: "GitHub answered 503" }, HEAD, H(7))]);
			const movedCi = effect(moved.last, "handoff")?.verdict.ci;
			expect("automatic handover on a moved PR uses the current unread poll", movedCi?.state === "unread" && !movedCi.runs.length, movedCi?.state);

			unavailableAnnotations = true;
			ciData.runs = blocked.map((one) => one.check);
			const ambiguous = await readCi(app, target);
			expect("missing annotations leave suspected blocked jobs unread", ciState(ambiguous) === "retry", ciState(ambiguous));
			ciData.runs.push(checkRun(130, "build", "failure"));
			const known = await readCi(app, target);
			expect("a confirmed failure still counts if another job's annotation is unread", known.kind === "read" && ciState(known) === "failed" && known.logs.length === 1 && known.logs[0].name === "build", known.kind === "read" ? known.logs.map((log) => log.name).join(", ") : known.kind);
		} finally {
			globalThis.fetch = original;
		}
	}

	// More check runs than are read (ten pages): the ones read passed, the one that failed is past them. Not a pass.
	ciData.runs = Array.from({ length: 1001 }, (_, index) => checkRun(7000 + index, `job-${index}`, index === 1000 ? "failure" : "success"));
	const partial = await readCi(app, target);
	expect("a listing cut short with no failure among what was read is incomplete, not passed", partial.kind === "read" && partial.truncated && ciState(partial) === "incomplete", partial.kind === "read" ? `${partial.runs.length} read, truncated ${partial.truncated}` : partial.kind);
	const cut = advance(
		advance(advance(advance(advance(newItem(), { kind: "start", at: T0, by: "person:u1" }).item, { kind: "turn_started", at: T0, key: "i_00000000000000aa:1:1:1" }).item, { ...(ended("succeeded", PASSED)({ key: "i_00000000000000aa:1:1:1", check: "", question: "" }) as Extract<Fact, { kind: "turn_ended" }>), at: T0 }).item, { kind: "published", at: T0, key: "i_00000000000000aa:1:3:1", head: HEAD, pr: { number: 1, url: "" }, openItems: 1 }).item,
		{ kind: "ci_read", prHead: null, at: T0 + MINUTE, key: "i_00000000000000aa:1:4:1", head: HEAD, reading: partial, mergeable: null, openItems: 1 },
	);
	const said = effect(cut, "handoff")?.verdict;
	expect("handed over, it says CI was not read in full, and claims no pass of it", said?.ci.state === "unread" && /not read in full|could not be read in full/.test(said.said.ci) && !/CI passed/.test(said.said.ci), `${said?.ci.state}: ${said?.said.ci}`);
	ciData.runs = [];

	// GitHub limits the request for the reading's token itself, with a Retry-After: a wait, not a missing permission.
	const minting = new (class extends GithubApp {
		override async installationToken(): Promise<never> {
			throw new GithubError(403, "You have exceeded a secondary rate limit.", "could not get a token for the installation", new Headers({ "retry-after": "60" }));
		}
	})(app.settings, secrets);
	const mintLimited = await readCi(minting, target);
	expect("a rate limit on the reading's token is a wait, not a refusal of permission", mintLimited.kind === "rate_limited" && ciState(mintLimited) === "retry", JSON.stringify(mintLimited));


	const withoutChecks = new (class extends GithubApp {
		override installationToken() {
			return super.installationToken(installation.id, { repositoryId: repo.id, permissions: { metadata: "read", statuses: "read", actions: "read" } });
		}
	})(app.settings, secrets);
	const forbidden = await readCi(withoutChecks, target);
	expect("a token scoped without checks gets not_permitted from the check-runs endpoint", forbidden.kind === "not_permitted" && ciState(forbidden) === "not_permitted" && forbidden.said === "Resource not accessible by integration" && standin.requests.at(-1)?.status === 403, forbidden.kind);
	const reset = Math.floor(Date.now() / 1000) + 600;
	standin.ciRateLimit = { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, message: "API rate limit exceeded for installation ID 1." };
	const limited = await readCi(app, target);
	expect("a 403 for the rate limit is a wait until its reset", limited.kind === "rate_limited" && limited.retryAt === reset * 1000 && ciState(limited) === "retry", JSON.stringify(limited));
	standin.ciRateLimit = { status: 429, headers: { "retry-after": "30" }, message: "You have exceeded a secondary rate limit." };
	const before = Date.now();
	const secondary = await readCi(app, target);
	expect("a secondary limit waits as long as GitHub says", secondary.kind === "rate_limited" && secondary.retryAt >= before + 30_000 && secondary.retryAt <= Date.now() + 30_000);
	standin.ciRateLimit = null;

	standin.appPermissions = { metadata: "read", contents: "write", pull_requests: "write" };
	const ungranted = await readCi(app, target);
	expect("an app without the CI permissions (decision 2 not granted): not permitted, with GitHub's reason", ungranted.kind === "not_permitted" && /permissions/.test(ungranted.said), JSON.stringify(ungranted));
	const handed = advance(
		advance(advance(advance(advance(newItem(), { kind: "start", at: T0, by: "person:u1" }).item, { kind: "turn_started", at: T0, key: "i_00000000000000aa:1:1:1" }).item, { ...(ended("succeeded", PASSED)({ key: "i_00000000000000aa:1:1:1", check: "", question: "" }) as Extract<Fact, { kind: "turn_ended" }>), at: T0 }).item, {
			kind: "published",
			at: T0,
			key: "i_00000000000000aa:1:3:1",
			head: HEAD,
			pr: { number: 1, url: "" },
			openItems: 1,
		}).item,
		{ kind: "ci_read", prHead: null, at: T0 + MINUTE, key: "i_00000000000000aa:1:4:1", head: HEAD, reading: ungranted, mergeable: null, openItems: 1 },
	);
	expect("that reading, given to the blueprint, hands the item over saying CI was not read", handed.item.state === "review" && effect(handed, "handoff")?.verdict.ci.state === "not_permitted");
	standin.appPermissions = granted;

	standin.down = true;
	const down = await readCi(app, target);
	expect("GitHub unreachable: failed, tried again at the next poll", down.kind === "failed" && ciState(down) === "retry", JSON.stringify(down));
	standin.down = false;
} finally {
	await standin.stop();
}

expect("nothing printed here holds a token", !output.some((line) => /gh[sopu]_[A-Za-z0-9]{8,}/.test(line)));
print(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
