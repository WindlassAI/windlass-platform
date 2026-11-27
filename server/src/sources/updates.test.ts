/**
 * Run from server with npx tsx --test src/sources/updates.test.ts.
 *
 * updates.golden.json holds transitions recorded from the Linear, Jira, Slack and webhook checks with the effect code
 * before the update stream (the per-source blocks in work-item.ts): the item before and after (only the fields the
 * blocks read), the fact, and the source effects they made. The stream and its renderers must make the same rows.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { FactoryItem } from "../factory/types.js";
import { sourceEffects } from "./effects.js";
import { SOURCE_IDS, type SourceBinding } from "./types.js";
import { itemUpdates } from "./updates.js";

interface Recorded {
	where: "take" | "create";
	/** Which legacy field the item had, and GitHub's reaction target: all the renderers read of the binding. */
	meta: { github?: { reactionTarget?: string }; linear?: object; jira?: object; slack?: object };
	before: FactoryItem;
	next: FactoryItem;
	fact?: { kind: string };
	handoff?: boolean;
	slackUser?: string;
	issueGone?: boolean;
	url: string;
	effects: unknown[];
}

const recorded: Recorded[] = JSON.parse(readFileSync(new URL("./updates.golden.json", import.meta.url), "utf8"));

/** As stored: JSON, with Linear's random comment ids made equal. */
const rows = (effects: unknown[]) =>
	JSON.parse(JSON.stringify(effects), (key, value) => (key === "commentId" ? "*" : value)) as unknown[];

/** The recorded binding fields as the bindings the renderers take. */
const bindingsOf = ({ meta }: Recorded) => ({
	bindings: SOURCE_IDS.flatMap(source =>
		meta[source as keyof Recorded["meta"]]
			? [{ ref: { source }, extra: { ...meta.github } } as unknown as SourceBinding]
			: [],
	),
});

function effectsOf(r: Recorded) {
	if (r.where === "create")
		return sourceEffects(bindingsOf(r), [...itemUpdates(null, r.before), ...itemUpdates(r.before, r.next)], r.next, {
			url: r.url,
		});
	const updates = itemUpdates(r.before, r.next, r.fact, {
		handoff: r.handoff,
		...(r.slackUser && { by: { source: "slack", person: r.slackUser } }),
	});
	return sourceEffects(bindingsOf(r), updates, r.next, { url: r.url, issueGone: r.issueGone });
}

test("the golden transitions cover every source that posts back", () => {
	const kinds = new Set(recorded.flatMap(r => r.effects.map(e => (e as { kind: string }).kind)));
	for (const kind of ["issue_comment", "feedback_ack", "linear_write", "jira_comment", "slack_write"])
		assert.ok(kinds.has(kind), kind);
	for (const source of ["github", "linear", "jira", "slack"] as const)
		assert.ok(recorded.filter(r => r.meta[source] && r.effects.length).length >= 3, source);
});

test("each recorded transition makes the same effect rows as before", () => {
	for (const [i, r] of recorded.entries())
		assert.deepEqual(rows(effectsOf(r)), rows(r.effects), `transition ${i} (${r.where}, ${r.fact?.kind ?? "-"})`);
});

test("a cross-repo feature is handed over when its run reaches merged, without the hand-off flag", () => {
	const pr = { number: 1, url: "https://github.com/o/a/pull/1" };
	const step = (kind: string, n: number) => ({ n: 1, step: { n, attempt: 1, kind }, ci: {} });
	const repos = [{ alias: "a" }, { alias: "b" }];
	const before = { id: "i_x", revision: 4, state: "waiting", question: null, pr, run: step("ci", 4), repos };
	const next = { ...before, revision: 5, state: "review", run: step("merged", 6) };
	const effects = (b: object, n: object) =>
		rows(
			sourceEffects(
				bindingsOf({ meta: { linear: {} } } as Recorded),
				itemUpdates(b as FactoryItem, n as FactoryItem, { kind: "ci_read" }),
				n as FactoryItem,
				{
					url: "https://windlass.example/items/i_x",
				},
			),
		);
	assert.deepEqual(effects(before, next), [
		{ kind: "linear_write", key: "handed over", commentId: "*", pr: pr.url },
		{ kind: "linear_write", key: "review_handover" },
	]);
	assert.deepEqual(effects({ ...before, repos: [repos[0]] }, { ...next, repos: [repos[0]] }), [], "one repository");
	assert.deepEqual(effects(next, { ...next, revision: 6 }), [], "already merged");
});
