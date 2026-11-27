/** Pay with (server/src/pay-with.ts): its storage in the user's actor and the rule a hosted turn will follow. */
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import type { PayWithChoice } from "../server/src/contract.js";
import {
	PAY_WITH_HARNESSES,
	PAY_WITH_TABLE,
	PayWithProblem,
	payWithFor,
	payWithPatchOf,
	readPayWith,
	savePayWith,
} from "../server/src/pay-with.js";

function account() {
	const sql = new DatabaseSync(":memory:");
	sql.exec(PAY_WITH_TABLE);
	const db = {
		async execute<Row>(query: string, ...args: unknown[]) {
			return sql.prepare(query).all(...(args as SQLInputValue[])) as Row[];
		},
	};
	return { sql, db };
}

test("the plan agents come from the harness records", () => {
	assert.deepEqual([...PAY_WITH_HARNESSES], ["claude", "codex"]);
});

test("an account that saved nothing has the defaults", async () => {
	const { db } = account();
	assert.deepEqual(await readPayWith(db), [
		{ harness: "claude", payWith: "plan-then-key", whenLimited: null, updatedAt: null },
		{ harness: "codex", payWith: "plan-then-key", whenLimited: null, updatedAt: null },
	]);
});

test("a saved choice is read back, and saving again replaces it", async () => {
	const { db } = account();
	const saved = await savePayWith(db, { harness: "codex", payWith: "plan", whenLimited: "ask" }, 1000);
	assert.deepEqual(saved[1], { harness: "codex", payWith: "plan", whenLimited: "ask", updatedAt: 1000 });
	assert.equal(saved[0]?.updatedAt, null, "the other agent keeps its defaults");
	await savePayWith(db, { harness: "codex", payWith: "key", whenLimited: null }, 2000);
	assert.deepEqual((await readPayWith(db))[1], {
		harness: "codex",
		payWith: "key",
		whenLimited: null,
		updatedAt: 2000,
	});
});

test("input that names no plan agent or choice is refused", () => {
	assert.deepEqual(payWithPatchOf({ harness: "claude", payWith: "plan-then-key" }), {
		harness: "claude",
		payWith: "plan-then-key",
		whenLimited: null,
	});
	for (const raw of [
		null,
		{ harness: "opencode", payWith: "key", whenLimited: null },
		{ harness: "windlass", payWith: "key", whenLimited: null },
		{ harness: "claude", payWith: "both", whenLimited: null },
		{ harness: "claude", payWith: "plan", whenLimited: "never" },
	])
		assert.throws(() => payWithPatchOf(raw), PayWithProblem, JSON.stringify(raw));
});

test("a stored row that is no longer valid reads as the defaults", async () => {
	const { db, sql } = account();
	sql.exec("INSERT INTO pay_with VALUES ('claude', 'both', NULL, 5), ('codex', 'plan', 'never', 6)");
	for (const choice of await readPayWith(db)) assert.equal(choice.updatedAt, null);
});

test("payWithFor: what pays, and what a limited plan does", () => {
	const choice = (
		harness: "claude" | "codex",
		payWith: PayWithChoice["payWith"],
		whenLimited: PayWithChoice["whenLimited"],
	) => ({
		harness,
		payWith,
		whenLimited,
		updatedAt: 1,
	});
	const cases: Array<
		[string, PayWithChoice[], Parameters<typeof payWithFor>[1], "item" | "interactive", boolean, object]
	> = [
		["defaults: an item waits", [], "claude", "item", true, { payWith: "plan-then-key", whenLimited: "wait" }],
		["defaults: a session asks", [], "claude", "interactive", true, { payWith: "plan-then-key", whenLimited: "ask" }],
		["no key: always waits", [], "codex", "interactive", false, { payWith: "plan-then-key", whenLimited: "wait" }],
		[
			"a chosen rule beats the defaults",
			[choice("claude", "plan-then-key", "key")],
			"claude",
			"item",
			true,
			{ payWith: "plan-then-key", whenLimited: "key" },
		],
		[
			"no key beats a chosen rule",
			[choice("claude", "plan-then-key", "key")],
			"claude",
			"item",
			false,
			{ payWith: "plan-then-key", whenLimited: "wait" },
		],
		[
			"plan only never switches",
			[choice("codex", "plan", "ask")],
			"codex",
			"interactive",
			true,
			{ payWith: "plan", whenLimited: "wait" },
		],
		[
			"key only",
			[choice("codex", "key", "ask")],
			"codex",
			"interactive",
			true,
			{ payWith: "key", whenLimited: "wait" },
		],
		[
			"another agent's choice is not this one's",
			[choice("codex", "key", null)],
			"claude",
			"item",
			true,
			{ payWith: "plan-then-key", whenLimited: "wait" },
		],
		["an agent no plan pays for", [], "opencode", "interactive", true, { payWith: "key", whenLimited: "wait" }],
		["Windlass", [], "windlass", "item", true, { payWith: "key", whenLimited: "wait" }],
	];
	for (const [name, choices, harness, origin, hasKey, expected] of cases)
		assert.deepEqual(payWithFor(choices, harness, origin, hasKey), expected, name);
});
