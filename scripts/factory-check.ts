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
import type { UsageNumbers, Verified, VerifiedCheck } from "../server/src/contract.js";
import type { CiReading } from "../server/src/github/ci.js";
import type { Effect, Fact, FactoryItem, ItemState, Outcome, WaitReason } from "../server/src/factory/types.js";
import { GithubStandin } from "./github-standin.js";

const scratch = mkdtempSync(join(tmpdir(), "wlp-factory-check-"));
// Set before the server's modules are loaded: they read their configuration when they are.
process.env.WLP_SECRET = `check-secret-${randomBytes(16).toString("hex")}`;
process.env.RIVETKIT_STORAGE_PATH = join(scratch, "storage");
for (const name of Object.keys(process.env)) if (name.startsWith("WLP_GITHUB_")) delete process.env[name];
mkdirSync(process.env.RIVETKIT_STORAGE_PATH, { recursive: true });

const { advance, createItem, currentKey } = await import("../server/src/factory/blueprint.js");
const { admit, budgetStop, FACTORY_DEFAULTS, retryAt } = await import("../server/src/factory/budget.js");
const { gateResult, verdictOf, verdictWords } = await import("../server/src/factory/verdict.js");
const { readCi, ciState, LOG_TAIL_CHARS, LOG_TAIL_LINES } = await import("../server/src/github/ci.js");
const { GithubApp } = await import("../server/src/github/app.js");

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

type Run = { name: string; state: "pending" | "passed" | "failed"; log?: string };
const ciRead = (runs: Run[]): CiReading => ({
	kind: "read",
	head: "",
	runs: runs.map((run, index) => ({ name: run.name, app: "github-actions", state: run.state, conclusion: run.state === "passed" ? "success" : run.state === "failed" ? "failure" : "in_progress", url: `https://github.invalid/run/${index}`, summary: "", jobId: index + 1 })),
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
	effects: Effect["kind"][];
	/** Anything more the design says of this row: null when it holds, otherwise what is wrong. */
	also?: (outcome: Outcome) => string | null;
}

const H = (n: number) => `${String(n).repeat(40).slice(0, 40)}`;
const started = (): Row["fact"] => (k) => ({ kind: "turn_started", key: k.key });
const ended = (outcome: "succeeded" | "unresolved" | "interrupted" | "stopped", evidence: Verified | null, more: { changes?: boolean; report?: string; tokens?: number } = {}): Row["fact"] => (k) => ({
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
const ci = (head: string, reading: CiReading, mergeable: boolean | null = true): Row["fact"] => (k) => ({ kind: "ci_read", key: k.key, head, reading: reading.kind === "read" ? { ...reading, head } : reading, mergeable, openItems: 1 });
const answer = (choice: Extract<Fact, { kind: "answer" }>["choice"], more: { note?: string; budget?: Partial<FactoryItem["budget"]> } = {}): Row["fact"] => (k) => ({ kind: "answer", by: "person:u1", question: k.question, choice, ...more });

function newItem(more: { plan?: "approve"; budget?: Partial<FactoryItem["budget"]> } = {}): FactoryItem {
	return createItem({
		id: "i_00000000000000aa",
		task: { title: "Fix add()", body: "add(1, 2) returns -1.", acceptance: ["add(1, 2) is 3"], base: "main" },
		plan: more.plan,
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
			const kinds = outcome.effects.map((effect) => effect.kind);
			const wrong = [
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
				if (again.item !== outcome.item || again.effects.length > 0) {
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
			return holds(verdict?.result === "pass" && verdict.head === H(1) && verdict.attestedBy === "platform" && verdict.ci.state === "passed" && verdict.acceptance[0] === "add(1, 2) is 3", `the verdict is a pass at the pushed head: ${JSON.stringify(verdict)}`);
		},
	},
];

drive("the plain run: implement, checks pass, publish, CI passes, review, merged", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver"], also: (o) => holds(effect(o, "deliver")?.text.includes("add(1, 2) is 3") === true && effect(o, "deliver")?.maxSteps === 60, "the task and its criteria go to the agent, with 60 steps") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: (k) => ({ kind: "turn_running", key: k.check }), after: 5 * MINUTE, state: "working", effects: ["check_turn"] },
	...toReview,
	{ fact: (k) => ({ kind: "pr_read", key: k.key, state: "open" }), after: 10 * MINUTE, state: "review", effects: ["poll_pr"] },
	{ fact: (k) => ({ kind: "pr_read", key: k.key, state: "merged" }), after: 10 * MINUTE, state: "done", effects: [] },
]);

drive("a required check fails at first and passes after a fix turn", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("unresolved", FAILING), state: "working", effects: ["deliver"], also: (o) => holds(/still failing: test\b/.test(effect(o, "deliver")?.text ?? "") && o.item.run?.rounds.gate === 1, "a continue-fixing turn names the failing check") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	...toReview,
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
		effects: ["deliver"],
		also: (o) => {
			const text = effect(o, "deliver")?.text ?? "";
			return holds(text.includes("untrusted") && text.includes(log) && text.includes("e2e"), "a CI fix turn has the failing check and its log, marked untrusted");
		},
	},
	...ciFix,
];
const begun: Row[] = [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
];

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
	{ fact: answer("hand_over"), state: "review", effects: ["handoff", "poll_pr"], also: (o) => holds(effect(o, "handoff")?.verdict.result === "fail", "handed over as failing") },
]);

drive("the same CI failure after a fix stops the run at once", newItem(), [
	...begun,
	...pushedAndFailed(H(1), "Error: timeout waiting for #login after 5012 ms"),
	{ fact: published(H(2)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(2), failingCi("Error: timeout waiting for #login after 4980 ms")), after: 60_000, state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.cause === "repeated" && o.item.run?.rounds.ci === 1, "stopped with a round left, on the fingerprint") },
	{ fact: answer("raise"), state: "working", effects: ["deliver"] },
]);

const interrupted = ended("interrupted", null);
drive("a deploy in the middle of the implement step", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: interrupted, state: "working", effects: ["deliver"], also: (o) => holds(/interrupted/.test(effect(o, "deliver")?.text ?? "") && effect(o, "deliver")?.key.endsWith(":1:2") === true, "the same step, its next attempt, told to continue") },
	{ fact: (k) => ({ kind: "turn_started", key: k.key.replace(/:2$/, ":1") }), state: "working", effects: [], also: (o) => holds(o.events.length === 0, "a fact about the cut attempt is ignored") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: interrupted, state: "working", effects: ["deliver"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: interrupted, state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.cause === "interruptions", "cut off three times: a person is asked") },
	{ fact: answer("raise"), state: "working", effects: ["deliver"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
]);

const usage = (left: number): UsageNumbers => ({ at: T0, day: "2026-11-19", resetsAt: MIDNIGHT, allowanceSeconds: 8 * 3600, usedSeconds: 8 * 3600 - left, heldSeconds: 0, leftSeconds: left, startSeconds: 30, sandboxes: { kept: 4, limit: 20 } });
const hosted = (left: number) => ({ kind: "hosted" as const, usage: usage(left), running: 0, needsSandbox: false, deploymentFull: null });
const allowance = admit({ at: T0 + 3 * MINUTE, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: hosted(0), attempt: 0 });
drive("the daily allowance runs out mid-turn: the item waits for 00:00 UTC and resumes", newItem(), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("stopped", null), state: "working", effects: ["deliver"] },
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
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("unresolved", FAILING), state: "working", effects: ["deliver"] },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{
		fact: ended("unresolved", verified("unresolved", [check("test", "failed", "Error: expected 3, got 4")])),
		state: "waiting",
		wait: "budget",
		effects: ["ask"],
		also: (o) => holds(o.item.question?.kind === "budget" && o.item.wait?.sentence === "This item has used 2 of its 2 turns.", `asked, with the numbers: ${o.item.wait?.sentence}`),
	},
	{ fact: answer("raise", { budget: { turns: 4 } }), state: "working", effects: ["deliver"], also: (o) => holds(o.item.budget.turns === 4, "the raised budget is kept") },
]);

drive("a plan for approval, a question to the person and its answer", newItem({ plan: "approve" }), [
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver"], also: (o) => holds(effect(o, "deliver")?.agent === "planner", "step 0 runs as the planner") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", null, { changes: false, report: "1. Fix the sign in add()." }), state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "plan_approval" && o.item.question.text.includes("Fix the sign"), "the plan is put to the person") },
	{ fact: (k) => ({ kind: "answer", by: "person:u1", question: `${k.question}x`, choice: "approve" }), state: "waiting", wait: "person", effects: [], also: (o) => holds(o.events.length === 0, "an answer to another question is ignored") },
	{ fact: answer("approve", { note: "Keep the signature." }), state: "working", effects: ["deliver"], also: (o) => holds(effect(o, "deliver")?.agent === null && /Keep the signature/.test(effect(o, "deliver")?.text ?? ""), "the approval and the note go to the implementing agent") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED, { changes: false }), state: "waiting", wait: "person", effects: ["ask"], also: (o) => holds(o.item.question?.kind === "no_change", "a turn that changed nothing is a question") },
	{ fact: answer("again", { note: "The bug is in src/add.ts." }), state: "working", effects: ["deliver"], also: (o) => holds(/src\/add\.ts/.test(effect(o, "deliver")?.text ?? ""), "the person's note goes with it") },
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
	{ fact: () => ({ kind: "send_back", by: "person:u1", note: "Also handle negatives." }), state: "queued", effects: ["deliver"], also: (o) => holds(o.item.run?.n === 2 && /negatives/.test(effect(o, "deliver")?.text ?? ""), "a new run with the note") },
	{ fact: started(), state: "working", effects: ["check_turn"] },
	{ fact: ended("succeeded", PASSED), state: "working", effects: ["publish"] },
	{ fact: (k) => ({ kind: "publish_failed", key: k.key, said: "connection reset", transient: true }), state: "working", effects: ["publish"], also: (o) => holds(effect(o, "publish")?.at === T0 + 19 * MINUTE + 30_000, "a push that did not get through is tried again after 30 s") },
	{ fact: published(H(2)), state: "waiting", wait: "ci", effects: ["poll_ci"] },
	{ fact: ci(H(2), ciRead([{ name: "build", state: "pending" }]), false), after: 60_000, state: "working", effects: ["deliver"], also: (o) => holds(effect(o, "deliver")?.fetchBase === "main", "a conflict: the base is fetched and merged") },
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
	{ fact: () => ({ kind: "start", by: "person:u1" }), state: "queued", effects: ["deliver"] },
	{ fact: () => ({ kind: "cancel", by: "person:u1" }), state: "cancelled", effects: ["withdraw"] },
]);

// ---------------------------------------------------------------------------------------------
// Limits and budgets
// ---------------------------------------------------------------------------------------------

print("\n== limits");

const machine = (online: boolean, running: number) => ({ kind: "machine" as const, name: "nas", online, since: Date.UTC(2026, 10, 19, 23, 10), running, max: 3 });
const admissions: Array<[string, Parameters<typeof admit>[0], WaitReason | null, RegExp | null, number | null]> = [
	["the review cap holds new work back", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: true, inReview: 6, place: hosted(3600), attempt: 0 }, "review_cap", /fewer than 6 of your items are in review \(6 now\)/, T0 + 30_000],
	["but never work in progress", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 6, place: hosted(3600), attempt: 0 }, null, null, null],
	["the factory's turns are full", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 5, factory: ["a", "b", "c", "d", "e"] }, startsRun: false, inReview: 0, place: hosted(3600), attempt: 0 }, "capacity", /one of your 5 factory turns; 5 are running \(“a”, “b”, “c”, …\)/, T0 + 30_000],
	["the user's turns are full", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 6, factory: ["a", "b"] }, startsRun: false, inReview: 0, place: hosted(3600), attempt: 1 }, "capacity", /one of your 6 running turns; 6 are running, 4 of them your own/, T0 + 60_000],
	["the day's hosted allowance is used", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: hosted(10), attempt: 0 }, "capacity", /Your 8 h of hosted sandbox time for today are used; it starts again at 00:00 UTC \(in 4 h\)/, MIDNIGHT],
	["the kept sandboxes are all taken, for a session that needs one", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: { ...hosted(3600), usage: { ...usage(3600), sandboxes: { kept: 20, limit: 20 } }, needsSandbox: true }, attempt: 0 }, "capacity", /20 sandboxes you may keep/, T0 + 30_000],
	["the user's hosted sandboxes are all running", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: { ...hosted(3600), running: 3 }, attempt: 0 }, "capacity", /one of your 3 hosted sandboxes: 3 running/, T0 + 30_000],
	["the deployment is full: tried again, spaced up to 5 min", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: { ...hosted(3600), deploymentFull: 10 }, attempt: 6 }, "capacity", /this deployment runs 10 at once and all are in use/, T0 + 5 * MINUTE],
	["the machine is offline", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: machine(false, 0), attempt: 0 }, "machine", /‘nas’ is offline since 23:10 UTC/, T0 + 30_000],
	["the machine runs all it can", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: false, inReview: 0, place: machine(true, 3), attempt: 0 }, "machine", /Waiting for ‘nas’: 3 of 3 sandboxes running there/, T0 + 30_000],
	["a machine with room starts", { at: T0, limits: FACTORY_DEFAULTS, turns: { running: 0, factory: [] }, startsRun: true, inReview: 0, place: machine(true, 2), attempt: 0 }, null, null, null],
];
for (const [name, input, reason, words, when] of admissions) {
	const result = admit(input);
	const got = result.ok ? null : result.wait;
	expect(`admission: ${name}`, (got?.reason ?? null) === reason && (words === null || words.test(got?.sentence ?? "")) && (got?.retryAt ?? null) === when, got ? `${got.reason}: ${got.sentence}` : "starts");
}
expect("retries are spaced 30 s, 60 s, … up to 5 min", [0, 1, 2, 3, 4].map((attempt) => retryAt(0, attempt)).join() === "30000,60000,120000,240000,300000");
const spentAll = { tokens: 4_000_000, turns: 3, activeSeconds: 600, hostedSeconds: 9000 };
expect("a budget: tokens used up, said with the numbers", budgetStop(FACTORY_DEFAULTS.item, spentAll, { kind: "hosted" })?.sentence === "This item has used 4M of its 4M tokens.");
expect("hosted sandbox seconds are no limit on a machine", budgetStop(FACTORY_DEFAULTS.item, { ...spentAll, tokens: 0 }, { kind: "machine", machineId: "m1" }) === null && budgetStop(FACTORY_DEFAULTS.item, { ...spentAll, tokens: 0 }, { kind: "hosted" })?.cause === "hostedSeconds");

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
expect("verdict: CI not readable is said in plain words, apart from no CI", /CI was not read/.test(verdictWords(unread, null)) && /No CI ran/.test(verdictWords(verdict(PASSED, "none"), null)));

// ---------------------------------------------------------------------------------------------
// The CI reader, against the stand-in
// ---------------------------------------------------------------------------------------------

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

const checkRun = (id: number, name: string, conclusion: string | null) => ({ id, name, status: conclusion === null ? "in_progress" : "completed", conclusion, html_url: `https://github.invalid/ada/harbor/runs/${id}`, app: { slug: "github-actions" }, output: { title: conclusion === "failure" ? "Process completed with exit code 1." : null, summary: null } });

try {
	standin.appPermissions = granted;
	ciData.runs = Array.from({ length: 250 }, (_, index) => checkRun(5000 + index, `job-${index}`, index === 137 ? "failure" : "success"));
	ciData.statuses = [{ context: "ci/legacy", state: "success", description: "ok", target_url: "https://ci.invalid/1" }];
	const lines = Array.from({ length: 5000 }, (_, index) => `2026-11-19T20:0${index % 10}:00.1234567Z \x1b[31mline ${index}\x1b[0m`);
	lines.push("2026-11-19T20:09:59.0000000Z Error: expected 3, got -1 (token ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789)");
	repo.jobLogs.set(5137, lines.join("\n"));

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

	repo.jobLogs.set(5137, "x".repeat(17 * 1024 * 1024));
	const huge = await readCi(app, target);
	const hugeLog = huge.kind === "read" ? huge.logs[0] : undefined;
	expect("a log larger than the most that is read is not read to its end, and says so", hugeLog !== undefined && hugeLog.text === null && "why" in hugeLog && /larger than 16 MiB/.test(hugeLog.why), hugeLog && "why" in hugeLog ? hugeLog.why : "");

	ciData.runs = [checkRun(1, "build", null)];
	ciData.statuses = [];
	expect("a job still running: pending", ciState(await readCi(app, target)) === "pending");
	ciData.runs = [];
	expect("nothing reported yet: none", ciState(await readCi(app, target)) === "none");

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
		{ kind: "ci_read", at: T0 + MINUTE, key: "i_00000000000000aa:1:4:1", head: HEAD, reading: ungranted, mergeable: null, openItems: 1 },
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
