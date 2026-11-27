// @vitest-environment jsdom
/** The Factory board's columns: each item in exactly one, a feature as one card. */
import type { ItemState, ItemSummary, StepKind, WaitReason } from "@contract";
import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, boardCards, boardColumn } from "./board";

const STATES: ItemState[] = ["draft", "queued", "working", "waiting", "review", "done", "failed", "cancelled"];
const STEPS: Array<StepKind | undefined> = [
	undefined,
	"plan_review",
	"subtasks",
	"integration",
	"summary",
	"refine",
	"implement",
	"gate",
	"publish",
	"ci",
	"ci_fix",
	"run_checks",
	"conflict",
	"review",
	"review_fix",
	"handoff",
	"merged",
];
const WAITS: Array<WaitReason | undefined> = [
	undefined,
	"provider",
	"children",
	"capacity",
	"machine",
	"ci",
	"person",
	"budget",
	"integration",
	"sandboxes",
];
const REVIEWS: ItemSummary["review"][] = [
	null,
	{ state: "waiting", recommendation: null },
	{ state: "running", recommendation: null },
	{ state: "filed", recommendation: "approve" },
	{ state: "off", recommendation: null },
];

let made = 0;
function summary(fields: Partial<ItemSummary> = {}): ItemSummary {
	made += 1;
	return {
		id: `it_${made}`,
		title: `Item ${made}`,
		repository: { id: 1, owner: "acme", name: "harbor", branch: "main" },
		place: { kind: "hosted" },
		source: "web",
		origin: null,
		state: "working",
		wait: null,
		question: null,
		pullRequest: null,
		verdict: null,
		review: null,
		budget: { tokens: 1000, hostedSeconds: 60 },
		spent: { tokens: 0, hostedSeconds: 0, turns: 0, activeSeconds: 0 },
		sessionId: `se_${made}`,
		createdAt: made,
		updatedAt: made,
		revision: 1,
		...fields,
	} as ItemSummary;
}

const question = { kind: "agent_ask", text: "Which one?", askedAt: 5 } as unknown as ItemSummary["question"];
const wait = (reason: WaitReason) => ({ reason, sentence: `waits: ${reason}`, retryAt: null, since: 0 });

describe("the board's columns", () => {
	it("puts every item, whatever its state, step, wait, review and push, in exactly one column", () => {
		for (const state of STATES)
			for (const kind of STEPS)
				for (const reason of WAITS)
					for (const review of REVIEWS)
						for (const pushed of [false, true])
							for (const asks of [false, true])
								for (const reviewer of [true, false]) {
									const item = summary({
										state,
										review,
										question: asks ? question : null,
										wait: state === "waiting" && reason ? wait(reason) : null,
										pullRequest: pushed ? { number: 7, url: "u" } : null,
										step: kind
											? ({
													kind,
													startedAt: 0,
													turn: null,
													rounds: { gate: 0, ci: 0, conflict: 0 },
												} as unknown as ItemSummary["step"])
											: undefined,
									});
									const column = boardColumn(item, reviewer);
									expect(BOARD_COLUMNS).toContain(column);
									const cards = boardCards([item], [], reviewer);
									expect(BOARD_COLUMNS.filter(one => cards[one].some(card => card.item.id === item.id))).toEqual([
										column,
									]);
								}
	});

	it("reads the real progress: a question first, then state, then the run's step", () => {
		expect(boardColumn(summary({ state: "working", question, step: { kind: "ci" } as ItemSummary["step"] }))).toBe(
			"needs",
		);
		expect(boardColumn(summary({ state: "draft" }))).toBe("planning");
		expect(boardColumn(summary({ state: "queued" }))).toBe("planning");
		expect(boardColumn(summary({ state: "working", step: { kind: "plan_review" } as ItemSummary["step"] }))).toBe(
			"planning",
		);
		expect(boardColumn(summary({ state: "working", step: { kind: "implement" } as ItemSummary["step"] }))).toBe(
			"building",
		);
		expect(boardColumn(summary({ state: "working", step: { kind: "ci_fix" } as ItemSummary["step"] }))).toBe("ci");
		expect(boardColumn(summary({ state: "waiting", wait: wait("ci") }))).toBe("ci");
		expect(boardColumn(summary({ state: "waiting", wait: wait("capacity") }))).toBe("planning");
		expect(
			boardColumn(summary({ state: "waiting", wait: wait("capacity"), pullRequest: { number: 3, url: "u" } })),
		).toBe("ci");
		expect(boardColumn(summary({ state: "working", step: { kind: "review_fix" } as ItemSummary["step"] }))).toBe(
			"review",
		);
		expect(boardColumn(summary({ state: "working", step: { kind: "review_fix" } as ItemSummary["step"] }), false)).toBe(
			"ci",
		);
		expect(boardColumn(summary({ state: "review", review: { state: "running", recommendation: null } }))).toBe(
			"review",
		);
		expect(boardColumn(summary({ state: "review", review: { state: "running", recommendation: null } }), false)).toBe(
			"ready",
		);
		expect(boardColumn(summary({ state: "review", review: { state: "filed", recommendation: "approve" } }))).toBe(
			"ready",
		);
		for (const state of ["done", "failed", "cancelled"] as const) expect(boardColumn(summary({ state }))).toBe("ended");
	});

	it("shows a feature as one card, its open subtasks as parts, under Needs you while a part asks", () => {
		const feature = summary({ title: "Dark theme", mode: "orchestrate", state: "waiting", wait: wait("children") });
		const parent = { itemId: feature.id, key: "a", title: "Dark theme" };
		const running = summary({ title: "Theme switch", parent, state: "working" });
		const asking = summary({
			title: "Colours",
			parent: { ...parent, key: "b" },
			state: "waiting",
			wait: wait("person"),
			question,
		});
		// The list carries the asking part under "feature — part"; the feed's children carry both, unprefixed.
		const listed = { ...asking, title: "Dark theme — Colours" };
		const cards = boardCards([feature, listed], [running, asking]);
		const all = BOARD_COLUMNS.flatMap(column => cards[column]);
		expect(all.map(card => card.item.id)).toEqual([feature.id]);
		expect(cards.needs[0]?.parts.map(part => [part.title, Boolean(part.question)])).toEqual([
			["Theme switch", false],
			["Colours", true],
		]);
		// Without its question, it is building.
		expect(boardCards([feature], [running]).building.map(card => card.item.id)).toEqual([feature.id]);
	});

	it("keeps a part whose feature is filtered out as a card of its own", () => {
		const part = summary({
			title: "Feature — Colours",
			parent: { itemId: "it_gone", key: "b", title: "Feature" },
			question,
		});
		expect(boardCards([part], []).needs.map(card => card.item.id)).toEqual([part.id]);
	});
});
