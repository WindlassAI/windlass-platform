import type { HostedMonth, PlanInfo } from "@contract";
import { describe, expect, it } from "vitest";
import { createMockClient } from "../api/mock";
import { allowanceState } from "../state/hooks";
import { monthReset, monthSentence, monthState } from "./hosted";

const month = (used: number, over: Partial<HostedMonth> = {}): HostedMonth => ({
	month: "2026-11", resetsAt: Date.UTC(2026, 11, 1), includedSeconds: 7200, limitSeconds: 7200,
	usedSeconds: used * 60, heldSeconds: 0, leftSeconds: Math.max(0, 7200 - used * 60), plan: "free", ...over,
});
const pro: PlanInfo = { id: "pro", name: "Pro", monthlyCents: 1500, yearlyCents: 14_400, machines: 10, hostedMinutes: 1800, hostedRunning: 5, keptSandboxes: 10, sizes: ["small", "standard", "large"], crossRepo: true, githubItemsPerDay: 100, overageCentsPer1000: 600 };

describe("the month's hosted minutes", () => {
	it("is plenty without a month, low near the limit, used at it", () => {
		expect(monthState(null)).toBe("plenty");
		expect(monthState({ startSeconds: 30 })).toBe("plenty");
		expect(monthState({ hosted: month(30), startSeconds: 30 })).toBe("plenty");
		expect(monthState({ hosted: month(97), startSeconds: 30 })).toBe("low");
		expect(monthState({ hosted: month(120), startSeconds: 30 })).toBe("used");
	});

	it("says N of 120 near the limit, and the ways on at it", () => {
		expect(monthSentence({ hosted: month(97), startSeconds: 30 }, pro)).toBe("You've used 97 of 120 hosted minutes this month. Your own machines are never counted.");
		const stop = monthSentence({ hosted: month(120), startSeconds: 30 }, pro)!;
		expect(stop).toContain("can't start until 1 December");
		expect(stop).toContain("own machines");
		expect(stop).toContain("Pro for 1,800 a month");
		const capped = monthSentence({ hosted: month(5133, { plan: "pro", includedSeconds: 108_000, limitSeconds: 307_980, leftSeconds: 0 }), startSeconds: 30 }, pro)!;
		expect(capped).toContain("spend cap");
		expect(capped).not.toContain("move to Pro");
		expect(monthReset(month(0))).toBe("1 December");
	});

	it("says what launching does at the limit, where agents are launched", () => {
		const free = monthSentence({ hosted: month(120), startSeconds: 30 }, pro, { launch: true })!;
		expect(free).toBe("You've used all 120 hosted minutes this month. A hosted agent launched now is created, and waits until 1 December; one on your own machine starts at once, and is never counted. Or move to Pro for 1,800 a month.");
		const capped = monthSentence({ hosted: month(5133, { plan: "pro", includedSeconds: 108_000, limitSeconds: 307_980, leftSeconds: 0 }), startSeconds: 30 }, pro, { launch: true })!;
		expect(capped).toContain("your spend cap included");
		expect(capped).toContain("Or raise your spend cap in Settings.");
		expect(monthSentence({ hosted: month(97), startSeconds: 30 }, pro, { launch: true })).toBe(monthSentence({ hosted: month(97), startSeconds: 30 }, pro));
	});

	it("is what stops a turn where a plan sets it, with no daily allowance", () => {
		const numbers = { at: 0, day: "2026-11-23", resetsAt: 0, allowanceSeconds: null, usedSeconds: 0, heldSeconds: 0, leftSeconds: null, startSeconds: 30, sandboxes: { kept: 0, limit: 2 } };
		expect(allowanceState({ ...numbers, hosted: month(120) }, 0.2)).toBe("used");
		expect(allowanceState({ ...numbers, hosted: month(97) }, 0.2)).toBe("low");
		expect(allowanceState(numbers, 0.2)).toBe("plenty");
	});
});

describe("the mock's billing", () => {
	it("is off unless asked for, as a deployment without billing", async () => {
		const client = createMockClient({ pace: 0 });
		expect((await client.info()).billing).toBeUndefined();
		const auth = await client.login.demo();
		expect(await client.user(auth).billing()).toEqual({ enabled: false });
		expect((await client.user(auth).allowance()).hosted).toBeUndefined();
	});

	it("shows the yearly stop, its reset date and the way to monthly Pro", async () => {
		const start = Date.UTC(2026, 10, 5, 12);
		const client = createMockClient({ pace: 0, billing: "free", now: () => start });
		const user = client.user(await client.login.demo());
		await user.billingCheckout({ period: "year", origin: "http://app.test" });
		const hosted = (await user.allowance()).hosted!;
		expect(hosted.resetsAt).toBe(Date.UTC(2026, 11, 5, 12));
		expect(hosted.limitSeconds).toBe(1800 * 60);
		await expect(user.setOverageCap({ cents: 500 })).rejects.toThrow("Yearly Pro");
		const stop = monthSentence({ hosted: { ...hosted, usedSeconds: hosted.limitSeconds, leftSeconds: 0 }, startSeconds: 30 }, pro);
		expect(stop).toContain("period ending 5 December");
		expect(stop).toContain("monthly Pro");
		expect(stop).not.toContain("spend cap");
	});

	it("plays Free, then Pro after a checkout, with the cap held to $0 to $20", async () => {
		const client = createMockClient({ pace: 0, billing: "free", origin: "http://app.test" });
		expect((await client.info()).billing?.plans.map((plan) => plan.id)).toEqual(["free", "pro"]);
		const user = client.user(await client.login.demo());
		const free = await user.billing();
		expect(free.enabled && free.plan).toBe("free");
		expect((await user.allowance()).hosted?.includedSeconds).toBe(7200);
		const { url } = await user.billingCheckout({ period: "month", origin: "http://app.test" });
		expect(url.startsWith("http://app.test/settings")).toBe(true);
		const paid = await user.billing();
		expect(paid.enabled && paid.plan).toBe("pro");
		await expect(user.setOverageCap({ cents: 2001 })).rejects.toThrow();
		const lowered = await user.setOverageCap({ cents: 500 });
		expect(lowered.enabled && lowered.capCents).toBe(500);
	});
});
