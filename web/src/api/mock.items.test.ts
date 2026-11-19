/**
 * The mock's work items and API tokens: what the item screens are looked at with, by hand and here. It
 * answers as the server's user actor says it does (contract.ts, `UserActions.listItems` to `revokeApiToken`).
 */
import { MAX_API_TOKENS, type ItemSummary } from "@contract";
import { describe, expect, it } from "vitest";
import { createMockClient } from "./mock";
import type { MockItemsState } from "./mock-items";

const auth = { token: "mock:chatgpt:u_items:ada@example.com", profile: { uid: "u_items", email: "ada@example.com", demo: false } };
const make = (items?: MockItemsState) => createMockClient({ pace: 0, items });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the mock's work items", () => {
	it("seeds every state, and a wait for every waiting item", async () => {
		const mock = make();
		const list = await mock.user(auth).listItems();
		expect(new Set(list.map((item) => item.state))).toEqual(new Set(["draft", "queued", "working", "waiting", "review", "done", "failed", "cancelled"]));
		for (const item of list) expect(item.wait !== null).toBe(item.state === "waiting");
		// A question is always a wait for the person, with the question's text.
		for (const item of list.filter((one) => one.question)) expect(item.wait).toMatchObject({ reason: item.question?.kind === "budget" ? "budget" : "person", sentence: item.question?.text, retryAt: null });
		expect(new Set(list.flatMap((item) => (item.question ? [item.question.kind] : [])))).toEqual(new Set(["no_change", "publish_refused", "ci_timeout", "rounds", "budget"]));
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
