/**
 * The mock repeats what the server says about a user's limits, and the web app repeats how the server
 * spells a length of time: both are held against server/src/usage.ts here.
 */
import { describe, expect, it } from "vitest";
import type { UsageNumbers } from "@contract";
import { allowanceRefusal, freedNote, sandboxRefusal, spellSeconds } from "../../../server/src/usage";
import { sandboxTime } from "../lib/format";
import { MOCK_FREED_NOTE, createMockClient, mockAllowanceRefusal, mockSandboxRefusal } from "./mock";

const day = Date.UTC(2026, 10, 17);
const numbers = (patch: Partial<UsageNumbers>): UsageNumbers => ({
	at: day + 9 * 3_600_000,
	day: "2026-11-17",
	resetsAt: day + 86_400_000,
	allowanceSeconds: 7200,
	usedSeconds: 7200,
	heldSeconds: 0,
	leftSeconds: 0,
	startSeconds: 30,
	sandboxes: { kept: 5, limit: 5 },
	...patch,
});

describe("the mock's words about a user's limits", () => {
	it("are the server's", () => {
		for (const sample of [
			numbers({}),
			numbers({ usedSeconds: 6300, heldSeconds: 900 }),
			numbers({ usedSeconds: 7188, leftSeconds: 12 }),
			numbers({ usedSeconds: 6880, heldSeconds: 300, leftSeconds: 20 }),
		]) {
			expect(mockAllowanceRefusal(sample)).toBe(allowanceRefusal(sample));
		}
		expect(mockSandboxRefusal(numbers({}))).toBe(sandboxRefusal(numbers({})));
		expect(mockSandboxRefusal(numbers({ sandboxes: { kept: 1, limit: 1 } }))).toBe(
			sandboxRefusal(numbers({ sandboxes: { kept: 1, limit: 1 } })),
		);
		expect(MOCK_FREED_NOTE).toBe(freedNote("copied"));
	});

	it("spell a length of time as the server does", () => {
		for (const seconds of [0, 1, 45, 60, 245, 599, 600, 725, 3599, 3600, 6600, 7200, 86_400])
			expect(sandboxTime(seconds)).toBe(spellSeconds(seconds));
	});
});

describe("the mock's usage", () => {
	const auth = {
		token: "mock:user:u_usage:ada@example.com",
		profile: { uid: "u_usage", email: "ada@example.com", demo: false },
	};

	it("adds up: what the agents ran is the day's total, and the day is the last of the history", async () => {
		const client = createMockClient({ pace: 0 });
		const view = await client.user(auth).usage();
		expect(view.today.reduce((sum, row) => sum + row.seconds, 0)).toBe(view.usedSeconds);
		expect(view.today.reduce((sum, row) => sum + row.heldSeconds, 0)).toBe(view.heldSeconds);
		expect(view.leftSeconds).toBe((view.allowanceSeconds ?? 0) - view.usedSeconds - view.heldSeconds);
		expect(view.days.at(-1)).toEqual({ day: view.day, seconds: view.usedSeconds });
		expect(view.days.some(entry => entry.seconds === view.allowanceSeconds)).toBe(true);
		expect(view.kept.length).toBe(view.sandboxes.kept);
		client.dispose();
	});

	it("refuses a prompt on a day that is used up, and an agent without a sandbox when no place is left", async () => {
		const used = createMockClient({ pace: 0, usage: "used" });
		await expect(used.session(auth, "suite").prompt({ text: "go on" })).rejects.toMatchObject({
			reason: "allowance_used",
		});
		used.dispose();
		const full = createMockClient({ pace: 0, usage: "full" });
		await expect(full.session(auth, "scratch").prompt({ text: "start" })).rejects.toMatchObject({
			reason: "too_many_sandboxes",
		});
		const before = await full.user(auth).usage();
		const after = await full.user(auth).freeSandbox("suite");
		expect(after.sandboxes.kept).toBe(before.sandboxes.kept - 1);
		expect(after.kept.some(sandbox => sandbox.sessionId === "suite")).toBe(false);
		full.dispose();
	});
});
