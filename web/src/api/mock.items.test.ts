/**
 * The mock's work items and API tokens: what the item screens are looked at with, by hand and here. It
 * answers as the server's user actor says it does (contract.ts, `UserActions.listItems` to `revokeApiToken`).
 */
import { MAX_API_TOKENS, type ItemSummary, type Verdict, type Verified, type VerifiedCheck } from "@contract";
import { describe, expect, it } from "vitest";
import type { GateEvidence } from "../../../server/src/factory/types";
import { ciSentence as serverCiSentence, verdictOf, verdictWords } from "../../../server/src/factory/verdict";
import { createMockClient } from "./mock";
import { ciSentence, seededVerdicts, verdictSaid, type MockItemsState, type SeedVerdict } from "./mock-items";

const auth = { token: "mock:chatgpt:u_items:ada@example.com", profile: { uid: "u_items", email: "ada@example.com", demo: false } };
const make = (items?: MockItemsState) => createMockClient({ pace: 0, items });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** What the gate would have recorded for a seeded verdict: the user's checks as listed, and the repository's own beside them. */
function gateOf(seed: SeedVerdict): GateEvidence | null {
	if (seed.gate.state === null) return null;
	const check = (name: string, whose: VerifiedCheck["whose"], status: VerifiedCheck["status"], sentBack: number): VerifiedCheck => ({ name, command: `run ${name}`, whose, status, exitCode: status === "passed" ? 0 : 1, durationMs: 1000, sentBack });
	const checks = [...seed.gate.required.map((one) => check(one.name, "user", one.status, one.sentBack)), ...Array.from({ length: seed.repositoryChecks ?? 0 }, (_, index) => check(`own ${index + 1}`, "repository", "passed", 0))];
	const verified: Verified = { turn: 1, state: seed.gate.state, run: checks.length > 0 ? { turn: 1, at: 0, checks } : null, unrun: [], replaced: false, changedAfter: false, ...(seed.gate.unneeded ? { unneeded: seed.gate.unneeded } : {}) };
	return { outcome: seed.gate.state === "stopped" ? "stopped" : "succeeded", verified, flags: seed.flags };
}

describe("the mock's work items", () => {
	it("offers work items unless told not to, and without them refuses every item and API token call but the limits", async () => {
		expect((await make().info()).items).toBe(true);
		const off = make("off");
		expect((await off.info()).items).toBeUndefined();
		const user = off.user(auth);
		const calls = [user.listItems(), user.item("it_any"), user.createItem({ repository: { id: 1 }, title: "A", body: "" }), user.actOnItem("it_any", { kind: "cancel" }), user.apiTokens(), user.createApiToken({ name: "A", scopes: ["items:read"] }), user.revokeApiToken("tok_any")];
		for (const call of calls) await expect(call).rejects.toMatchObject({ reason: "items_off" });
		// The ceiling on running agents is every agent's, so it is still answered.
		expect((await user.factoryLimits()).runningTurns).toBeGreaterThan(0);
		off.dispose();
	});

	it("seeds every state, and a wait for every waiting item", async () => {
		const mock = make();
		const list = await mock.user(auth).listItems();
		expect(new Set(list.map((item) => item.state))).toEqual(new Set(["draft", "queued", "working", "waiting", "review", "done", "failed", "cancelled"]));
		for (const item of list) expect(item.wait !== null).toBe(item.state === "waiting");
		// A question is always a wait for the person, with the question's text.
		for (const item of list.filter((one) => one.question)) expect(item.wait).toMatchObject({ reason: item.question?.kind === "budget" ? "budget" : "person", sentence: item.question?.text, retryAt: null });
		expect(new Set(list.flatMap((item) => (item.question ? [item.question.kind] : [])))).toEqual(new Set(["no_change", "publish_refused", "ci_timeout", "rounds", "budget", "turn_refused"]));
		expect(new Set(list.flatMap((item) => (item.verdict ? [item.verdict.result] : [])))).toEqual(new Set(["pass", "fail", "incomplete", "unverified"]));
		mock.dispose();
	});

	it("answers an item's page with its log and verdicts, and refuses one that is not the user's", async () => {
		const mock = make();
		const user = mock.user(auth);
		const twice = (await user.listItems()).find((item) => item.title === "Add a health check endpoint") as ItemSummary;
		const view = await user.item(twice.id);
		expect(view.verdicts.map((verdict) => verdict.run)).toEqual([1, 2]);
		expect(view.events.some((event) => event.step === null && event.said.startsWith("Sent back"))).toBe(true);
		await expect(user.item("it_nothere")).rejects.toMatchObject({ reason: "item_not_found" });
		mock.dispose();
	});

	it("sends a run's caps and a verdict's sentences, as the server does", async () => {
		const mock = make();
		const user = mock.user(auth);
		const views = await Promise.all((await user.listItems()).map((item) => user.item(item.id)));
		for (const view of views) {
			if (view.run) expect(view.run.caps).toEqual({ plan: 3, gate: 2, ci: 2, conflict: 1 });
			// One is stored before verdicts carried their sentences, and has none.
			for (const verdict of view.verdicts) if ((verdict as Partial<Verdict>).said) expect(verdict.said.flags).toHaveLength(verdict.flags.length);
		}
		const said = new Set(views.flatMap((view) => view.verdicts.flatMap((verdict) => ((verdict as Partial<Verdict>).said ? [verdict.said.ci] : []))));
		expect(said).toContain("CI passed (3 checks).");
		expect(said).toContain("CI failed: lint.");
		expect([...said].some((line) => line.startsWith("CI was not read: GitHub does not let the platform see this repository's checks (“Resource not accessible by integration”)."))).toBe(true);
		mock.dispose();
	});

	it("words CI in every state as the server does", () => {
		const runs: Verdict["ci"]["runs"] = [
			{ name: "build", app: "github-actions", conclusion: "success", url: "https://github.com/a/b/actions/runs/1" },
			{ name: "lint", app: "github-actions", conclusion: "failure", url: "https://github.com/a/b/actions/runs/2" },
			{ name: "deploy", app: "status", conclusion: "error", url: "https://example.com/deploy" },
		];
		const states: Verdict["ci"][] = [
			{ state: "passed", runs: runs.slice(0, 1), said: null },
			{ state: "passed", runs: [...runs, ...runs], said: null },
			{ state: "failed", runs: [...runs, ...runs], said: null },
			{ state: "not_run", runs: [], said: "The job was not started because recent account payments have failed." },
			{ state: "none", runs: [], said: null },
			{ state: "skipped", runs: runs.slice(0, 1), said: null },
			{ state: "skipped", runs, said: null },
			{ state: "timed_out", runs, said: null },
			{ state: "unread", runs: [], said: null },
			{ state: "unread", runs, said: "GitHub listed more checks than the platform reads, and none of those it read failed" },
			{ state: "not_permitted", runs: [], said: null },
			{ state: "not_permitted", runs: [], said: "Resource not accessible by integration" },
		];
		for (const ci of states) expect(ciSentence(ci)).toBe(serverCiSentence(ci));
	});

	it("holds every seeded verdict to the server's rule and words: CI decides, and checks are optional", () => {
		const seeded = seededVerdicts();
		for (const seed of seeded) {
			const gate = gateOf(seed);
			const verdict = verdictOf({ id: "v", item: "it", run: seed.run, head: "0".repeat(40), at: 0, place: { kind: "hosted" }, gate, ci: seed.ci, acceptance: [], mergeable: seed.mergeable });
			expect({ result: verdict.result, said: verdictSaid(seed) }).toEqual({ result: seed.result, said: verdictWords(verdict, gate) });
		}
		// The cases CI decides, each seeded: no checks and CI passed is ready; checks that passed stand in for CI not read; neither is not verified.
		const words = seeded.map(verdictSaid);
		expect(words).toContain("Ready for review. No checks are set for this repository; CI decides. CI passed (3 checks).");
		expect(words).toContain("Your checks passed; CI has not been read. The 2 checks that applied passed when the agent's turn 1 ended. CI could not be read: GitHub did not answer while the platform waited for it. The pull request's own page shows its CI.");
		expect(words).toContain("Not verified. No checks are set for this repository; CI decides. CI could not be read: GitHub did not answer while the platform waited for it. The pull request's own page shows its CI.");
		expect(words).toContain("Not verified. No checks are set for this repository; CI decides. CI could not be read in full: GitHub listed more checks than the platform reads, and none of those it read failed. The pull request's own page shows its CI.");
		expect(words).toContain("Ready for review. The check that applied passed when the agent's turn 1 ended. CI ran, and nothing in it passed: its 2 checks were skipped, cancelled or neutral.");
		expect(words).toContain("Needs a look. No checks are set for this repository; CI decides. CI passed (3 checks). Test files were deleted or renamed away: test/export-csv.test.ts.");
	});

	it("logs each handed-over verdict in the server's words, and keeps one stored before verdicts had sentences", async () => {
		const mock = make();
		const user = mock.user(auth);
		const views = await Promise.all((await user.listItems()).map((item) => user.item(item.id)));
		const handoffs = views.flatMap((view) => view.events.filter((event) => event.step?.kind === "handoff").map((event) => event.said));
		const seeded = seededVerdicts().map(verdictSaid);
		for (const said of handoffs) expect(seeded).toContain(said);
		// The gate's line is the server's: no checks set is pushed for CI, never "published as unverified".
		const lines = views.flatMap((view) => view.events.map((event) => event.said));
		expect(lines).toContain("No checks are set for this repository: the work is pushed for CI to verify.");
		expect(lines.some((line) => line.includes("published as unverified"))).toBe(false);
		mock.dispose();
	});

	it("files an item once per key, starts it, and tells the live feed", async () => {
		const mock = make("none");
		const user = mock.user(auth);
		const seen: ItemSummary[][] = [];
		const close = user.watch({ onSessions: () => undefined, onItems: (list) => seen.push(list) });
		await tick();
		const input = { repository: { id: 7101 }, title: "Cache the station list", body: "Once per run.", acceptance: ["Read once."], start: true, idempotencyKey: "key-1" };
		const first = await user.createItem(input);
		const again = await user.createItem(input);
		expect(again.id).toBe(first.id);
		expect(first).toMatchObject({ state: "queued", source: "web", place: { kind: "hosted" } });
		expect(seen.at(-1)?.map((item) => item.id)).toEqual([first.id]);
		await expect(user.createItem({ ...input, title: "Another" })).rejects.toMatchObject({ reason: "idempotency_key_reused" });
		await expect(user.createItem({ ...input, idempotencyKey: undefined, place: { kind: "machine", machineId: "m_nas" } })).rejects.toMatchObject({ reason: "bad_input" });
		close();
		mock.dispose();
	});

	it("allows each action only in its state, and says why otherwise", async () => {
		const mock = make();
		const user = mock.user(auth);
		const list = await user.listItems();
		const draft = list.find((item) => item.state === "draft") as ItemSummary;
		await expect(user.actOnItem(draft.id, { kind: "retry" })).rejects.toMatchObject({ reason: "item_conflict" });
		expect((await user.actOnItem(draft.id, { kind: "start" })).state).toBe("queued");
		const asking = list.find((item) => item.question?.kind === "rounds") as ItemSummary;
		const question = asking.question?.id ?? "";
		expect((await user.actOnItem(asking.id, { kind: "answer", question, choice: "give_up", note: "Not now." })).state).toBe("failed");
		await expect(user.actOnItem(asking.id, { kind: "answer", question, choice: "give_up" })).rejects.toMatchObject({ reason: "item_conflict" });
		const failed = await user.actOnItem(asking.id, { kind: "retry" });
		expect(failed.run?.n).toBe(2);
		mock.dispose();
	});

	it("keeps API tokens up to the limit, and shows a token's value only when it is made", async () => {
		const mock = make("none");
		const user = mock.user(auth);
		expect(await user.apiTokens()).toEqual([]);
		const made = await user.createApiToken({ name: "Script", scopes: ["items:create"] });
		expect(made.secret).toMatch(/^wlp_[0-9a-f]{40}$/);
		expect(JSON.stringify(await user.apiTokens())).not.toContain(made.secret);
		expect(await user.revokeApiToken(made.token.id)).toEqual([]);
		mock.dispose();
		const full = make("full");
		expect(await full.user(auth).apiTokens()).toHaveLength(MAX_API_TOKENS);
		await expect(full.user(auth).createApiToken({ name: "One more", scopes: ["items:read"] })).rejects.toMatchObject({ reason: "too_many_tokens" });
		full.dispose();
	});

	it("fails every read in the failed state", async () => {
		const mock = make("failed");
		await expect(mock.user(auth).listItems()).rejects.toMatchObject({ code: "network" });
		await expect(mock.user(auth).factoryLimits()).rejects.toMatchObject({ code: "network" });
		mock.dispose();
	});
});
