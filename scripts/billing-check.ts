/**
 * Plans and billing on their own (server/src/billing/), with Dodo Payments faked in this process (dodo-fake.ts) and
 * the account's tables in an in-memory SQLite: no server, no network, no real provider.
 *
 *   cd server && npx tsx ../scripts/billing-check.ts
 *
 * What it holds to: no billing means the deployment's limits exactly as before; a plan sets limits and an operator's
 * override still wins; hosted time is weighted by size and counted per UTC calendar month; the month's minutes stop a
 * start at the plan's limit, and at the spend cap on Pro; webhooks verify, apply once, ignore stale and foreign events,
 * and map each Dodo event; a failed payment keeps Pro through the grace period and then falls back to Free with nothing
 * deleted; overage is never reported without a subscription, never past the cap and never twice.
 */

import "./check-secret.js";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { applyBillingEvent, billingTables, readBilling, reportOverage, setCapCents, overageMinutes } from "../server/src/billing/account.js";
import { billing, readBillingConfig } from "../server/src/billing/config.js";
import { DodoProvider, type DodoSettings } from "../server/src/billing/dodo.js";
import { meterPeriod, monthOf, shiftMonths, type MeterPeriod, sessionWeight, SIZE_WEIGHT } from "../server/src/billing/meter.js";
import { capMinutes, DEFAULT_CAP_CENTS, effectivePlan, NO_SUBSCRIPTION, planAllowsSize, PLANS, type BillingState } from "../server/src/billing/plans.js";
import type { BillingEvent } from "../server/src/billing/provider.js";
import { verify } from "../server/src/billing/standard-webhooks.js";
import { config } from "../server/src/config.js";
import { HOSTED_SIZES, HOSTED_SIZE_SPECS, largerHostedSize, MAX_MACHINES } from "../server/src/contract.js";
import { allowanceRefusal, DAY_MS, dayOf, UsageBook } from "../server/src/usage.js";
import { effectiveUserLimits } from "../server/src/user-limits.js";
import { delivery, FAKE_KEY, FAKE_SECRET, FakeDodo, paymentData, subscriptionData } from "./dodo-fake.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
}
async function rejects(promise: Promise<unknown>): Promise<unknown> {
	try { await promise; return null; } catch (error) { return error; }
}

/** RawAccess over node:sqlite, as the actor's database answers. */
function memoryDb() {
	const sqlite = new DatabaseSync(":memory:");
	const execute = async <T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> => {
		const statement = sqlite.prepare(sql);
		return statement.all(...(args as SQLInputValue[])) as T[];
	};
	const db = {
		execute,
		transaction: async <T>(run: (tx: { execute: typeof execute }) => Promise<T>) => {
			sqlite.exec("BEGIN");
			try { const value = await run({ execute }); sqlite.exec("COMMIT"); return value; } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
		},
	};
	return db as unknown as Parameters<typeof applyBillingEvent>[0];
}

const PRODUCTS = { month: "pdt_pro_month", year: "pdt_pro_year" };
const SETTINGS: DodoSettings = { apiKey: FAKE_KEY, webhookSecret: FAKE_SECRET, environment: "test_mode", products: PRODUCTS, meterEvent: "hosted_minutes" };
const GRACE = 7 * DAY_MS;
/** 2026-11-23 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 23, 12);
const event = (over: Partial<BillingEvent>): BillingEvent => ({ id: `e${Math.random()}`, kind: "active", occurredAt: NOW, uid: "u_check", customerId: "cus_1", subscriptionId: "sub_1", period: "month", periodStart: NOW, periodEnd: NOW + 30 * DAY_MS, cancelAtPeriodEnd: false, type: "subscription.active", ...over });
const pro = (over: Partial<BillingState> = {}): BillingState => ({ ...NO_SUBSCRIPTION, plan: "pro", status: "active", period: "month", periodStart: Date.UTC(2026, 10, 5, 12), periodEnd: Date.UTC(2026, 11, 5, 12), customerId: "cus_1", subscriptionId: "sub_1", ...over });

// --- Billing off: today's behaviour --------------------------------------------------------------------------------
{
	expect("no WLP_BILLING_PROVIDER: billing is off", readBillingConfig({}) === null);
	const off = effectiveUserLimits({});
	expect("billing off: the deployment's daily allowance and kept cap, no monthly minutes", off.usage.dailySeconds === config.usage.dailySeconds && off.usage.maxKept === config.usage.maxKept && off.usage.monthlySeconds === null && off.plan === null);
	expect("billing off: the deployment's hosted-at-once and filings a day, and MAX_MACHINES", off.factory.hostedRunning === config.factory.hostedRunning && off.factory.githubItemsPerDay === config.factory.githubItemsPerDay && off.machines === MAX_MACHINES);
	const book = new UsageBook(off.usage);
	expect("billing off: the numbers carry no month", book.numbers(NOW).hosted === undefined);
	expect("a provider that is named without its keys stops the server", (() => { try { readBillingConfig({ WLP_BILLING_PROVIDER: "dodo" }); return false; } catch (error) { return /WLP_DODO_API_KEY/.test(String(error)) && !/dodo_test/.test(String(error)); } })());
	expect("an unknown provider is refused", (() => { try { readBillingConfig({ WLP_BILLING_PROVIDER: "stripe" }); return false; } catch { return true; } })());
	const env = { WLP_BILLING_PROVIDER: "dodo", WLP_DODO_API_KEY: "k", WLP_DODO_WEBHOOK_SECRET: FAKE_SECRET, WLP_DODO_PRODUCT_PRO_MONTHLY: "a", WLP_DODO_PRODUCT_PRO_YEARLY: "b" };
	expect("dodo with its settings: test mode by default, seven days of grace", readBillingConfig(env)?.provider.name === "dodo" && readBillingConfig(env)?.graceMs === GRACE);
	expect("WLP_DODO_ENVIRONMENT takes test_mode or live_mode only", (() => { try { readBillingConfig({ ...env, WLP_DODO_ENVIRONMENT: "prod" }); return false; } catch { return true; } })());
}

// --- Plan to limits ------------------------------------------------------------------------------------------------
{
	const free = effectiveUserLimits({}, NO_SUBSCRIPTION, NOW);
	expect("Free: 120 hosted minutes a month, a hard stop, no daily allowance", free.usage.monthlySeconds === 120 * 60 && free.usage.includedSeconds === 120 * 60 && free.usage.dailySeconds === null);
	expect("Free: 1 hosted at once, 2 kept, 3 machines, 20 filings a day, no cross-repo", free.factory.hostedRunning === 1 && free.usage.maxKept === 2 && free.machines === 3 && free.factory.githubItemsPerDay === 20 && free.plan?.crossRepo === false);
	const paid = effectiveUserLimits({}, pro(), NOW);
	expect("Pro: 1,800 included and the $20 cap's 3,333 overage minutes", paid.usage.includedSeconds === 1800 * 60 && paid.usage.monthlySeconds === (1800 + 3333) * 60 && capMinutes(PLANS.pro, DEFAULT_CAP_CENTS) === 3333);
	expect("Pro: 5 at once, 10 kept, 10 machines, 100 filings a day, cross-repo and large", paid.factory.hostedRunning === 5 && paid.usage.maxKept === 10 && paid.machines === 10 && paid.factory.githubItemsPerDay === 100 && paid.plan?.crossRepo === true && paid.plan.sizes.includes("large"));
	const lowered = effectiveUserLimits({}, pro({ capCents: 300 }), NOW);
	expect("a lower cap pays for fewer minutes: $3 is 500", lowered.usage.monthlySeconds === (1800 + 500) * 60);
	const zero = effectiveUserLimits({}, pro({ capCents: 0 }), NOW);
	expect("a cap of 0 is a hard stop at the included minutes", zero.usage.monthlySeconds === 1800 * 60);
	const operator = effectiveUserLimits({ hostedRunning: 7, machines: 4, dailySeconds: 3600, hostedMinutes: 600, maxKept: null }, NO_SUBSCRIPTION, NOW);
	expect("an operator's override wins over the plan", operator.factory.hostedRunning === 7 && operator.machines === 4 && operator.usage.dailySeconds === 3600 && operator.usage.monthlySeconds === 600 * 60 && operator.usage.maxKept === null);
	expect("an operator's unlimited minutes have no monthly allowance", effectiveUserLimits({ hostedMinutes: null }, NO_SUBSCRIPTION, NOW).usage.monthlySeconds === null);
	expect("an operator's minutes on Pro still have the cap's overage", effectiveUserLimits({ hostedMinutes: 100 }, pro(), NOW).usage.monthlySeconds === (100 + 3333) * 60);
	expect("an ended subscription is Free", effectivePlan(pro({ status: "ended", plan: "free" }), NOW) === "free");
}

// --- Metering by size, and the month --------------------------------------------------------------------------------
{
	expect("weights: small 0.5, standard 1, large 2", SIZE_WEIGHT.small === 0.5 && SIZE_WEIGHT.standard === 1 && SIZE_WEIGHT.large === 2);
	expect("a session is weighted by its hosted size; one from before sizes as small", sessionWeight({ hostedSize: "large" }) === 2 && sessionWeight({ hostedSize: "standard" }) === 1 && sessionWeight({}) === 0.5 && sessionWeight(undefined) === 0.5);
	expect("Free has no large; Pro has all three; no billing allows any", !planAllowsSize(PLANS.free, "large") && planAllowsSize(PLANS.free, "standard") && planAllowsSize(PLANS.pro, "large") && planAllowsSize(null, "large"));
	const limits = { ...effectiveUserLimits({}, NO_SUBSCRIPTION, NOW).usage, holdSeconds: 900 };
	const book = new UsageBook(limits);
	const sizes: Record<string, number> = { s: SIZE_WEIGHT.small, m: SIZE_WEIGHT.standard, l: SIZE_WEIGHT.large };
	book.weightOf = (session) => sizes[session[0]!] ?? 1;
	book.reserve(NOW, { id: "s1", session: "small", fresh: true });
	book.settle(NOW + 600_000, { session: "small", hold: "s1", seconds: 600 });
	book.reserve(NOW, { id: "l1", session: "large", fresh: true });
	book.settle(NOW + 300_000, { session: "large", hold: "l1", seconds: 300 });
	expect("10 min small + 5 min large count 5 + 10 hosted minutes", book.usedInPeriod(meterPeriod(null, NOW)) === 300 + 600);
	expect("the day's real seconds are not weighted", book.usedOn(dayOf(NOW)) === 900);
	const numbers = book.numbers(NOW + 600_000);
	expect("the numbers carry the month: 15 of 120 used", numbers.hosted?.month === "2026-11" && numbers.hosted.usedSeconds === 900 && numbers.hosted.leftSeconds === 7200 - 900 && numbers.hosted.resetsAt === Date.UTC(2026, 11, 1));
	const tight = new UsageBook({ ...limits, monthlySeconds: 600 });
	tight.weightOf = () => SIZE_WEIGHT.large;
	const hold = tight.reserve(NOW, { id: "l2", session: "large", fresh: true });
	expect("a large sandbox is given half the real time of what is left", hold.ok && hold.hold.seconds === 300);

	// The session index can forget a deleted agent or change its size while an old hold is still open.
	const session = { hostedSize: "large" as "small" | "large" };
	const index = new Map([["agent", session]]);
	const history = new UsageBook({ ...limits, holdSeconds: 60, monthlySeconds: 240 });
	history.weightOf = id => sessionWeight(index.get(id));
	history.reserve(NOW, { id: "used", session: "agent" });
	history.reserve(NOW + 60_000, { id: "open", session: "agent", settle: { hold: "used", seconds: 60 } });
	index.delete("agent");
	expect("deleting a large agent keeps both its used minutes and its open hold at the monthly cap",
		history.month(NOW).usedSeconds === 120 && history.month(NOW).heldSeconds === 120 && !history.reserve(NOW + 60_000, { id: "other", session: "other" }).ok);
	history.sweep(NOW + DAY_MS);
	history.settle(NOW + DAY_MS, { session: "agent", hold: "open", seconds: 30 });
	expect("expiry and a late correction after deletion both use the original large hold's weight", history.month(NOW).usedSeconds === 180);

	session.hostedSize = "small";
	index.set("agent", session);
	const resize = new UsageBook({ ...limits, holdSeconds: 120, monthlySeconds: 180 });
	resize.weightOf = history.weightOf;
	resize.reserve(NOW, { id: "before", session: "agent" });
	session.hostedSize = "large";
	const after = resize.reserve(NOW + 120_000, { id: "after", session: "agent", settle: { hold: "before", seconds: 120 } });
	expect("resizing from small to large prices only the next hold at large", after.ok && after.hold.seconds === 60 &&
		resize.month(NOW).usedSeconds === 60 && resize.month(NOW).heldSeconds === 120);

	// The rollover: the last minutes of a month and the first of the next.
	const end = Date.UTC(2026, 10, 30, 23, 58);
	const roll = new UsageBook({ ...limits });
	const late = roll.reserve(end, { id: "r1", session: "x", fresh: true });
	expect("(the roll's holds are of the day's end)", late.ok);
	expect("a hold at 23:58 on the 30th stops at midnight", late.ok && late.hold.seconds === 120 && monthOf(late.hold.day * DAY_MS) === "2026-11");
	roll.settle(end + 120_000, { session: "x", hold: "r1", seconds: 120 });
	const next = roll.reserve(end + 120_000, { id: "r2", session: "x", fresh: true });
	expect("the hold after it is December's, from a whole allowance", next.ok && monthOf(next.hold.day * DAY_MS) === "2026-12" && roll.usedInPeriod(meterPeriod(null, end + 120_000)) === 0 && roll.usedInPeriod(meterPeriod(null, end)) === 120);
	expect("December's numbers start at 0 and reset on 1 January", roll.numbers(end + 121_000).hosted?.usedSeconds === 0 && roll.numbers(end + 121_000).hosted?.resetsAt === Date.UTC(2027, 0, 1));
	expect("Free resets on 1 January", meterPeriod(null, Date.UTC(2026, 11, 31, 23)).end === Date.UTC(2027, 0, 1));
}

// --- The hard stop on Free and the cap on Pro ----------------------------------------------------------------------
{
	const free = new UsageBook({ ...effectiveUserLimits({}, NO_SUBSCRIPTION, NOW).usage, holdSeconds: 3600 });
	free.weightOf = () => 1;
	const first = free.reserve(NOW, { id: "f1", session: "a", fresh: true });
	expect("Free: a hold is never more than what is left of 120 minutes", first.ok && first.hold.seconds === 3600);
	free.settle(NOW + 7_000_000, { session: "a", hold: "f1", seconds: 3600 });
	const second = free.reserve(NOW + 7_000_000, { id: "f2", session: "a", fresh: true });
	expect("the second hold is the rest: 60 minutes", second.ok && second.hold.seconds === 3600);
	free.settle(NOW + 7_000_000 + 3_600_000, { session: "a", hold: "f2", seconds: 3600 });
	const stop = free.reserve(NOW + 7_000_000 + 3_600_000, { id: "f3", session: "a", fresh: true });
	expect("at 120 of 120 nothing starts", !stop.ok && stop.reason === "allowance");
	const words = allowanceRefusal(free.numbers(NOW + 7_000_000 + 3_600_000));
	expect("the stop says N of 120, own machines and Pro", /120 of your 120 hosted minutes/.test(words) && /own machines/.test(words) && /Pro/.test(words) && /1 December/.test(words), words);

	const capped = new UsageBook({ ...effectiveUserLimits({}, pro({ capCents: 6 }), NOW).usage, holdSeconds: 3600 });
	capped.weightOf = () => 1;
	let clock = Date.UTC(2026, 10, 6), granted = 0, refused = false;
	for (let n = 0; n < 100 && !refused; n++) {
		const hold = capped.reserve(clock, { id: `p${n}`, session: "a", fresh: true });
		if (!hold.ok) { refused = true; break; }
		granted += hold.hold.seconds;
		clock += hold.hold.seconds * 1000;
		capped.settle(clock, { session: "a", hold: hold.hold.id, seconds: hold.hold.seconds });
	}
	expect("Pro with a 6¢ cap: 1,800 included + 10 overage minutes, and no more", granted === (1800 + 10) * 60, String(granted));
	expect("past the cap nothing starts: enforced on the server", refused);
	expect("the cap's stop says to raise the cap", /spend cap/.test(allowanceRefusal(capped.numbers(clock))));
	expect("overage minutes never pass what the cap pays for", overageMinutes(pro({ capCents: 6 }), (1800 + 50) * 60, 1800 * 60, NOW) === 10);
}

// --- Subscription-anniversary allowances ---------------------------------------------------------------------------
{
	const start = pro().periodStart!, end = pro().periodEnd!;
	const limits = effectiveUserLimits({ hostedMinutes: 2 }, pro(), start).usage;
	const book = new UsageBook({ ...limits, holdSeconds: 60 });
	book.reserve(start - 60_000, { id: "before", session: "a" });
	book.settle(start + 500, { session: "a", hold: "before", seconds: 60 });
	book.reserve(start, { id: "first", session: "a" });
	book.settle(start + 60_000, { session: "a", hold: "first", seconds: 60 });
	expect("midday signup excludes the preceding hold and 1 December does not reset Pro",
		book.month(Date.UTC(2026, 11, 1)).usedSeconds === 60 && book.month(start).resetsAt === end);
	const last = book.reserve(end - 10_000, { id: "last", session: "a" });
	book.sweep(end + DAY_MS);
	book.settle(end + DAY_MS, { session: "a", hold: "last", seconds: 7 });
	expect("a hold stops at the provider reset and a late correction stays with the original period",
		last.ok && last.hold.seconds === 10 && book.month(end).usedSeconds === 0 && book.month(end - 1).usedSeconds === 67);
	const jan = Date.UTC(2027, 0, 31, 13);
	const annual = pro({ period: "year", periodStart: jan, periodEnd: shiftMonths(jan, 12) });
	const yearly = new UsageBook(effectiveUserLimits({}, annual, jan).usage, { entries: [
		{ day: dayOf(jan), session: "s", hold: "h", kind: "used", weight: 1, seconds: 1800 * 60, at: jan + DAY_MS, startedAt: jan, note: null },
	] });
	const feb = Date.UTC(2027, 1, 28, 13);
	expect("yearly Pro stops at 1,800, suggests monthly Pro, and resets on the monthly anniversary",
		!yearly.reserve(jan + DAY_MS, { id: "refused", session: "s" }).ok && yearly.month(jan).limitSeconds === 1800 * 60 &&
		/monthly Pro/.test(allowanceRefusal(yearly.numbers(jan + DAY_MS))) && yearly.month(jan).resetsAt === feb &&
		yearly.month(feb).leftSeconds === 1800 * 60 && yearly.month(feb).resetsAt === Date.UTC(2027, 2, 31, 13));
}

// --- Webhooks -----------------------------------------------------------------------------------------------------
const fake = new FakeDodo();
const dodo = new DodoProvider(SETTINGS, fake.fetch, "https://test.dodopayments.com");
{
	const good = delivery("subscription.active", subscriptionData({ productId: PRODUCTS.month }));
	expect("a signed delivery verifies", verify(FAKE_SECRET, good.headers, good.body, Date.now()) !== null);
	expect("a changed body does not", dodo.parseWebhook(good.headers, good.body.replace("active", "expired"), Date.now()) === null);
	const wrong = delivery("subscription.active", subscriptionData({ productId: PRODUCTS.month }), { secret: `whsec_${Buffer.from("another").toString("base64")}` });
	expect("another secret's signature does not", dodo.parseWebhook(wrong.headers, wrong.body, Date.now()) === null);
	const old = delivery("subscription.active", subscriptionData({ productId: PRODUCTS.month }), { signedAt: Date.now() - 10 * 60_000 });
	expect("a delivery signed ten minutes ago is refused", dodo.parseWebhook(old.headers, old.body, Date.now()) === null);
	const multi = new Headers(good.headers);
	multi.set("webhook-signature", `v1,${Buffer.from("x").toString("base64")} ${good.headers.get("webhook-signature")}`);
	expect("any one of several signatures may match", dodo.parseWebhook(multi, good.body, Date.now()) !== null);

	const parse = (type: string, data: unknown) => {
		const d = delivery(type, data);
		return dodo.parseWebhook(d.headers, d.body, Date.now())!;
	};
	const month = subscriptionData({ productId: PRODUCTS.month });
	const [active] = parse("subscription.active", month);
	expect("subscription.active → active, monthly, with ids, renewal date and the uid", active?.kind === "active" && active.period === "month" && active.uid === "u_check" && active.customerId === "cus_1" && active.subscriptionId === "sub_1" && active.periodStart === Date.parse("2026-11-23T00:00:00Z") && active.periodEnd === Date.parse("2026-12-23T00:00:00Z"));
	expect("subscription.renewed → active; yearly by its product", parse("subscription.renewed", subscriptionData({ productId: PRODUCTS.year }))[0]?.period === "year");
	expect("subscription.updated with cancel at the next billing date → changed", parse("subscription.updated", subscriptionData({ productId: PRODUCTS.month, cancelAtNext: true }))[0]?.kind === "changed" && parse("subscription.updated", subscriptionData({ productId: PRODUCTS.month, cancelAtNext: true }))[0]?.cancelAtPeriodEnd === true);
	expect("subscription.plan_changed → changed", parse("subscription.plan_changed", month)[0]?.kind === "changed");
	expect("subscription.on_hold and .past_due → payment_failed", parse("subscription.on_hold", subscriptionData({ productId: PRODUCTS.month, status: "on_hold" }))[0]?.kind === "payment_failed" && parse("subscription.past_due", subscriptionData({ productId: PRODUCTS.month, status: "past_due" }))[0]?.kind === "payment_failed");
	expect("payment.failed of a subscription → payment_failed", parse("payment.failed", paymentData({ uid: "u_check" }))[0]?.kind === "payment_failed");
	expect("payment.failed of no subscription → nothing", parse("payment.failed", paymentData({ subscriptionId: null })).length === 0);
	for (const type of ["subscription.cancelled", "subscription.expired", "subscription.failed"]) expect(`${type} → ended`, parse(type, subscriptionData({ productId: PRODUCTS.month, status: "cancelled" }))[0]?.kind === "ended");
	const paused = parse("subscription.updated", subscriptionData({ productId: PRODUCTS.month, status: "paused" }))[0]!;
	const pausedDb = await memoryDbWithTables();
	await applyBillingEvent(pausedDb, event({}), NOW, GRACE);
	const grace = (await applyBillingEvent(pausedDb, { ...paused, occurredAt: NOW }, NOW, GRACE)).state;
	expect("an active subscription updated to paused keeps Pro through grace and falls back to Free at its end",
		grace.status === "paused" && effectivePlan(grace, NOW + GRACE - 1) === "pro" && effectivePlan(grace, NOW + GRACE) === "free");
	expect("subscription.updated to cancelled → ended", parse("subscription.updated", subscriptionData({ productId: PRODUCTS.month, status: "cancelled" }))[0]?.kind === "ended");
	expect("another product's subscription → nothing", parse("subscription.active", subscriptionData({ productId: "pdt_other" })).length === 0);
	expect("payment.succeeded and refunds → nothing", parse("payment.succeeded", paymentData({})).length === 0 && parse("refund.succeeded", {}).length === 0);
	expect("the uid on the customer's metadata is read too", parse("subscription.active", subscriptionData({ productId: PRODUCTS.month, uidOn: "customer" }))[0]?.uid === "u_check");
	expect("no metadata uid leaves the customer id for routing", parse("subscription.active", subscriptionData({ productId: PRODUCTS.month, uidOn: "none" }))[0]?.uid === null);
}

// --- Applying events: once, in order, grace then downgrade ----------------------------------------------------------
{
	const db = memoryDb();
	await billingTables(db);

	const first = event({ id: "e1" });
	expect("an activation is applied", (await applyBillingEvent(db, first, NOW, GRACE)).outcome === "applied" && effectivePlan(await readBilling(db), NOW) === "pro");
	expect("the same delivery again is a duplicate", (await applyBillingEvent(db, first, NOW, GRACE)).outcome === "duplicate");
	expect("an older event arriving late is stale", (await applyBillingEvent(db, event({ kind: "ended", occurredAt: NOW - 1000 }), NOW, GRACE)).outcome === "stale" && (await readBilling(db)).status === "active");
	expect("another customer's event changes nothing", (await applyBillingEvent(db, event({ customerId: "cus_2", kind: "ended", occurredAt: NOW + 1 }), NOW, GRACE)).outcome === "other_customer");
	expect("a second subscription while one runs changes nothing", (await applyBillingEvent(db, event({ subscriptionId: "sub_2", occurredAt: NOW + 1 }), NOW, GRACE)).outcome === "other_subscription");

	const failedAt = NOW + DAY_MS;
	await applyBillingEvent(db, event({ kind: "payment_failed", occurredAt: failedAt }), failedAt, GRACE);
	const failing = await readBilling(db);
	expect("a failed payment: past due, Pro until the grace ends", failing.status === "past_due" && failing.graceUntil === failedAt + GRACE && effectivePlan(failing, failedAt + GRACE - 1) === "pro");
	await applyBillingEvent(db, event({ kind: "payment_failed", occurredAt: failedAt + DAY_MS }), failedAt + DAY_MS, GRACE);
	expect("a second failure does not move the grace", (await readBilling(db)).graceUntil === failedAt + GRACE);
	expect("after the grace: Free's limits", effectivePlan(await readBilling(db), failedAt + GRACE) === "free" && effectiveUserLimits({}, await readBilling(db), failedAt + GRACE).usage.monthlySeconds === 120 * 60);
	const kept = new UsageBook(effectiveUserLimits({}, await readBilling(db), failedAt + GRACE).usage, { kept: Array.from({ length: 6 }, (_, i) => ({ session: `k${i}`, since: NOW })) });
	expect("nothing is deleted: the six kept sandboxes stay, only new ones wait", kept.kept().length === 6 && kept.atCap("new"));
	await applyBillingEvent(db, event({ kind: "active", occurredAt: failedAt + 9 * DAY_MS, type: "subscription.renewed" }), failedAt + 9 * DAY_MS, GRACE);
	expect("a payment that succeeds after all: active again, no grace", (await readBilling(db)).status === "active" && (await readBilling(db)).graceUntil === null);
	await applyBillingEvent(db, event({ kind: "ended", occurredAt: failedAt + 10 * DAY_MS }), failedAt + 10 * DAY_MS, GRACE);
	expect("ended: Free, the ids kept", effectivePlan(await readBilling(db), failedAt + 10 * DAY_MS) === "free" && (await readBilling(db)).customerId === "cus_1");
	const lateActivation = await applyBillingEvent(db, event({ subscriptionId: "old", occurredAt: NOW - 1 }), failedAt + 10 * DAY_MS, GRACE);
	expect("late activation of an old subscription leaves the newer cancellation in force", lateActivation.outcome === "stale" &&
		lateActivation.state.status === "ended" && lateActivation.state.subscriptionId === "sub_1" && lateActivation.state.eventAt === failedAt + 10 * DAY_MS);
	expect("a new subscription after it ended is taken", (await applyBillingEvent(db, event({ subscriptionId: "sub_3", occurredAt: failedAt + 11 * DAY_MS }), failedAt + 11 * DAY_MS, GRACE)).outcome === "applied" && (await readBilling(db)).subscriptionId === "sub_3");
	expect("a failed payment with no subscription changes nothing", (await applyBillingEvent(await memoryDbWithTables(), event({ kind: "payment_failed", subscriptionId: null, customerId: null }), NOW, GRACE)).outcome === "no_subscription");
	expect("the cap takes 0 to 2,000 cents only", (await setCapCents(db, 500)).capCents === 500 && (await rejects(setCapCents(db, 2001))) instanceof RangeError && (await rejects(setCapCents(db, 1.5))) instanceof RangeError);
}

async function memoryDbWithTables() {
	const db = memoryDb();
	await billingTables(db);
	return db;
}

// --- Overage reports ----------------------------------------------------------------------------------------------
{
	const db = memoryDb();
	await billingTables(db);
	const start = pro().periodStart!;
	let used = 1800 * 60;
	const input = (state: BillingState, now = NOW) => ({ uid: "u_check", state, now, usedSeconds: (period: MeterPeriod) => (period.start === start ? used : 0), includedSeconds: 1800 * 60 });
	expect("within the included minutes: nothing reported", (await reportOverage(db, dodo, input(pro()))).length === 0 && fake.ingested.size === 0);
	used = (1800 + 12.9) * 60;
	const sent = await reportOverage(db, dodo, input(pro()));
	expect("12.9 overage minutes: 12 reported, whole minutes rounded down", sent.length === 1 && sent[0]!.minutes === 12 && fake.minutes === 12);
	const call = fake.calls.at(-1)!;
	expect("the ingest is Dodo's shape: event_id, customer_id, event_name, metadata.minutes", call.path === "/events/ingest" && call.body.events[0].customer_id === "cus_1" && call.body.events[0].event_name === "hosted_minutes" && call.body.events[0].metadata.minutes === 12);
	expect("the same count again reports nothing", (await reportOverage(db, dodo, input(pro()))).length === 0 && fake.minutes === 12);
	used = (1800 + 20) * 60;
	fake.failNext = { status: 500, count: 1, took: true };
	const lost = await rejects(reportOverage(db, dodo, input(pro())));
	expect("a report taken whose answer was lost fails here…", lost !== null && fake.minutes === 20);
	expect("…and says nothing of what the provider's error said", !/jane|4242/.test(String(lost)), String(lost));
	await reportOverage(db, dodo, input(pro()));
	expect("…and sent again under the same id, it is counted once", fake.minutes === 20);
	used = (1800 + 25) * 60;
	fake.failNext = { status: 503, count: 1 };
	await rejects(reportOverage(db, dodo, input(pro())));
	used = (1800 + 30) * 60;
	await reportOverage(db, dodo, input(pro()));
	expect("a report refused is sent again first, then what came since", fake.minutes === 30);
	const before = fake.calls.length;
	expect("never for Free", (await reportOverage(db, dodo, input({ ...NO_SUBSCRIPTION, customerId: "cus_1" }))).length === 0);
	expect("never for an ended subscription", (await reportOverage(db, dodo, input(pro({ status: "ended", plan: "free" })))).length === 0);
	expect("never after the grace", (await reportOverage(db, dodo, input(pro({ status: "past_due", graceUntil: NOW - 1 })))).length === 0);
	expect("never without a subscription id", (await reportOverage(db, dodo, input(pro({ subscriptionId: null })))).length === 0 && fake.calls.length === before);
	used = (1800 + 10_000) * 60;
	await reportOverage(db, dodo, input(pro({ capCents: 30 })));
	expect("never past the cap: a 30¢ cap pays for 50 minutes", fake.minutes === 50);
	await reportOverage(db, dodo, input(pro({ capCents: 0 })));
	expect("a cap lowered under what was reported reports nothing more, and takes nothing back", fake.minutes === 50);
	const end = pro().periodEnd!;
	const renewed = (await applyBillingEvent(db, event({ periodStart: start, periodEnd: end }), NOW, GRACE)).state;
	await applyBillingEvent(db, event({ periodStart: end, periodEnd: shiftMonths(end, 1), occurredAt: end }), end, GRACE);
	const after = await readBilling(db);
	used = (1800 + 60) * 60;
	const rollover = await reportOverage(db, dodo, { ...input(after, end), usedSeconds: period => period.start === start ? used : 1810 * 60 });
	expect("5 December renewal reports the old remainder and the new overage under distinct period ids",
		renewed.periodStart === start && rollover.length === 2 && rollover[0]!.minutes === 10 && rollover[1]!.minutes === 10 &&
		rollover[0]!.eventId.includes(`sub_1_${start}_`) && rollover[1]!.eventId.includes(`sub_1_${end}_`) && fake.minutes === 70);
	const calls = fake.calls.length;
	expect("yearly Pro never sends an overage event", !(await reportOverage(db, dodo, input(pro({ period: "year" })))).length && fake.calls.length === calls);
}

// --- Checkout and the portal against the fake ------------------------------------------------------------------------
{
	const { url } = await dodo.createCheckout({ uid: "u_check", period: "year", customerId: "cus_1", returnUrl: "https://app.example/settings?billing=checkout#plan" });
	const call = fake.calls.at(-1)!;
	expect("checkout: POST /checkouts with the yearly product, return_url and the uid in metadata", call.path === "/checkouts" && call.body.product_cart[0].product_id === PRODUCTS.year && call.body.product_cart[0].quantity === 1 && call.body.return_url.startsWith("https://app.example/") && call.body.metadata.wlp_uid === "u_check" && call.body.customer.customer_id === "cus_1" && url.startsWith("https://test.checkout.dodopayments.com/"));
	await dodo.createCheckout({ uid: "u_check", period: "month", customerId: "cus_1", returnUrl: "https://app.example/settings" });
	expect("an existing customer is named by id", fake.calls.at(-1)!.body.customer.customer_id === "cus_1" && fake.calls.at(-1)!.body.product_cart[0].product_id === PRODUCTS.month);
	expect("the API key goes as a bearer token", fake.calls.at(-1)!.auth === `Bearer ${FAKE_KEY}`);
	const portal = await dodo.portalLink({ customerId: "cus_1", returnUrl: "https://app.example/settings#plan" });
	expect("portal: POST /customers/{id}/customer-portal/session?return_url, answers its link", fake.calls.at(-1)!.path === "/customers/cus_1/customer-portal/session" && fake.calls.at(-1)!.query.get("return_url") === "https://app.example/settings#plan" && portal.url.startsWith("https://test.customer.dodopayments.com/"));
	const bad = new DodoProvider({ ...SETTINGS, apiKey: "dodo_test_wrong" }, fake.fetch, "https://test.dodopayments.com");
	const refused = await rejects(bad.createCheckout({ uid: "u_check", period: "month", customerId: "cus_1", returnUrl: "https://app.example/" }));
	expect("a refused key throws with the status and no key", refused !== null && /401/.test(String(refused)) && !/dodo_test_wrong/.test(String(refused)));
	expect("test mode is test.dodopayments.com, live mode live.dodopayments.com", new URL((await import("../server/src/billing/dodo.js")).dodoBaseUrl("test_mode")).host === "test.dodopayments.com" && new URL((await import("../server/src/billing/dodo.js")).dodoBaseUrl("live_mode")).host === "live.dodopayments.com");
}

// Exercise the actor entry points, including their migration, durable rows and reload.
{
	Object.assign(process.env, { WLP_BILLING_PROVIDER: "dodo", WLP_DODO_API_KEY: FAKE_KEY, WLP_DODO_WEBHOOK_SECRET: FAKE_SECRET,
		WLP_DODO_PRODUCT_PRO_MONTHLY: PRODUCTS.month, WLP_DODO_PRODUCT_PRO_YEARLY: PRODUCTS.year });
	billing()!.provider = dodo;
	config.sandbox = "fake";
	const { user } = await import("../server/src/actors/user.js");
	const { agentSession } = await import("../server/src/actors/agent-session.js");
	const { serviceParams } = await import("../server/src/auth.js");
	const { issueUserToken } = await import("../server/src/tokens.js");
	const { getLayer } = await import("../server/src/layer.js");
	const db = memoryDb();
	const profile = { uid: "u_check", email: "billing@example.test", demo: false };
	const { billingCustomers } = await import("../server/src/billing/customer-index.js");
	const { webhookOwner } = await import("../server/src/billing/route.js");
	const { issueServiceToken } = await import("../server/src/tokens.js");
	const directoryDb = memoryDb();
	if (!("db" in billingCustomers.config)) throw new Error("Missing customer directory database");
	await billingCustomers.config.db.onMigrate(directoryDb as never);
	const directory = () => {
		const ctx = { db: directoryDb, key: ["dodo"], conn: { params: { token: issueServiceToken("billing") } } };
		return {
			claim: (id: string, uid: string) => billingCustomers.config.actions!.claim(ctx as never, id, uid),
			lookup: (id: string) => billingCustomers.config.actions!.lookup(ctx as never, id),
		};
	};
	const client = () => ({ billingCustomers: { getOrCreate: directory } });
	const base = { db, client, key: [profile.uid], broadcast: () => undefined };
	if (!("db" in user.config && "createVars" in user.config)) throw new Error("Missing account database");
	const { db: schema, createVars } = user.config;
	const reload = () => createVars({ ...base, client: () => { throw new Error("Directory unavailable during account load"); } } as never, undefined);
	await schema.onMigrate(db as never);
	// Old tables did not have the weight columns. Run the actual migration against them.
	for (const table of ["usage_entry", "usage_hold"]) {
		const columns = await db.execute<{ name: string }>(`PRAGMA table_info(${table})`);
		if (columns.some(c => c.name === "weight")) await db.execute(`ALTER TABLE ${table} DROP COLUMN weight`);
	}
	await db.execute("INSERT INTO usage_entry(day, session, hold, kind, seconds, at) VALUES(?, 'old', 'legacy', 'used', 10, ?)", dayOf(Date.now()), Date.now());
	await schema.onMigrate(db as never);
	const vars = await reload();
	const svc = { ...base, vars, conn: { params: serviceParams() } };
	const actions = user.config.actions!;
	const now = Date.now();
	expect("an entry without a recorded weight counts once from the start of its UTC day", vars.usage.usedInPeriod({ start: dayOf(now) * DAY_MS, end: dayOf(now) * DAY_MS + 1 }) === 10);
	vars.usage.limits.subscription = pro();
	expect("a missing opening instant excludes the row from a period starting later that day", vars.usage.usedInPeriod({ start: dayOf(now) * DAY_MS + 1, end: now + 1 }) === 0);
	// The session knows its new size before the index receives its summary.
	vars.sessions.set("agent", { id: "agent", hostedSize: "small" } as never);
	await actions.internalReserve(svc as never, { sessionId: "agent", id: "settled", hostedSize: "large" });
	await actions.internalReserve(svc as never, { sessionId: "agent", id: "open", hostedSize: "large", settle: { hold: "settled", seconds: 2 } });
	const restored = await reload();
	const open = restored.usage.holdOf("agent");
	expect("a reload without the session restores the weights of both SQLite rows", !!open &&
		restored.usage.month(now).usedSeconds === 14 && restored.usage.month(now).heldSeconds === open.seconds * 2);

	const layer = await getLayer();
	layer.sandboxes.sizes = () => HOSTED_SIZES.map(id => ({ id, ...HOSTED_SIZE_SPECS[id], usdPerHour: null }));
	const offered = () => actions.internalHostedSizes(svc as never);
	expect("Free offers a standard OOM upgrade from small and none from standard",
		largerHostedSize("small", await offered()) === "standard" && largerHostedSize("standard", await offered()) === null);
	vars.items.limits.billing = pro();
	expect("Pro offers the large OOM upgrade", largerHostedSize("standard", await offered()) === "large");
	vars.items.limits.billing = { ...NO_SUBSCRIPTION };
	const meta = { uid: profile.uid, hostedSize: "standard", sandboxId: "old-box", place: { kind: "hosted" }, status: "idle" };
	const session = { ...svc, vars: { meta }, client: () => ({ user: { get: () => ({ internalHostedSizes: offered }) } }) };
	const answer = await agentSession.config.actions!.internalFreeSandbox(session as never, undefined, "large");
	expect("an old Pro resize choice on Free preserves the sandbox and its size", answer.sizeUnavailable === "large" && !answer.freed &&
		meta.hostedSize === "standard" && meta.sandboxId === "old-box");

	const personal = { ...base, vars, conn: { params: { token: issueUserToken(profile, 0) } } };
	const checkout = () => actions.billingCheckout(personal as never, { period: "month", origin: config.origins[0]! });
	const calls = () => fake.calls.filter(call => call.path === "/checkouts").length;
	const before = calls();
	const [one, two] = await Promise.all([checkout(), checkout()]);
	personal.vars = await reload();
	const retry = await checkout();
	const customer = (await readBilling(db)).customerId!;
	const owner = await directory().lookup(customer);
	expect("checkout creates one customer, durably indexes its uid and passes the stored id on every checkout",
		fake.calls.filter(call => call.path === "/customers").length === 1 && customer === "cus_1" && owner === profile.uid &&
		fake.calls.findLast(call => call.path === "/checkouts")?.body.customer.customer_id === customer);
	expect("customer id routes without metadata, agreeing metadata routes, and conflicting metadata is dropped",
		webhookOwner(owner, null) === profile.uid && webhookOwner(owner, profile.uid) === profile.uid &&
		webhookOwner(owner, "u_other") === null && webhookOwner(null, profile.uid) === profile.uid &&
		await directory().claim(customer, "u_other") === profile.uid && await directory().lookup(customer) === profile.uid);
	expect("simultaneous checkouts and a retry after reload return one provider link", one.url === two.url && one.url === retry.url && calls() === before + 1);
	const [row] = await db.execute<{ session: string; opened_at: number }>("SELECT session, opened_at FROM billing_checkout");
	expect("the open checkout records its provider id and opening time", !!row && one.url.endsWith(row.session) && row.opened_at >= now);
	await db.execute("UPDATE billing_checkout SET opened_at = ?", Date.now() - 30 * 60_000);
	expect("an expired checkout can be replaced", (await checkout()).url !== one.url && calls() === before + 2);
	await applyBillingEvent(db, event({ occurredAt: now - 4 }), now - 4, GRACE);
	expect("an activation settles the checkout", (await db.execute("SELECT id FROM billing_checkout")).length === 0);
	await applyBillingEvent(db, event({ kind: "payment_failed", occurredAt: now - 3 }), now - 3, 0);
	personal.vars = await reload();
	expect("a past-due subscription after grace directs checkout to Manage billing", /Manage billing/.test(String(await rejects(checkout()))) && calls() === before + 2);
	const pause = delivery("subscription.paused", subscriptionData({ productId: PRODUCTS.month, status: "paused" }), { at: now - 3 });
	const pausedEvent = dodo.parseWebhook(pause.headers, pause.body, now)![0]!;
	const paused = (await applyBillingEvent(db, pausedEvent, now, GRACE)).state;
	personal.vars = await reload();
	expect("paused after failed payment preserves the expired grace and refuses checkout with the paused message",
		paused.status === "paused" && effectivePlan(paused, now) === "free" &&
		String(await rejects(checkout())).includes("Your subscription is paused. Open Manage billing in Settings."));
	const unpause = delivery("subscription.unpaused", subscriptionData({ productId: PRODUCTS.month }), { at: now - 2 });
	const resumed = (await applyBillingEvent(db, dodo.parseWebhook(unpause.headers, unpause.body, now)![0]!, now, GRACE)).state;
	expect("unpaused restores the same subscription to Pro", effectivePlan(resumed, now) === "pro" && resumed.subscriptionId === paused.subscriptionId && resumed.graceUntil === null);
	await applyBillingEvent(db, event({ kind: "ended", occurredAt: now - 2 }), now - 2, GRACE);
	personal.vars = await reload();
	expect("a provider-ended subscription permits a fresh checkout", (await checkout()).url !== retry.url && calls() === before + 3);
	await applyBillingEvent(db, event({ type: "subscription.on_hold", kind: "payment_failed", subscriptionId: "sub_new", occurredAt: now - 1 }), now - 1, GRACE);
	personal.vars = await reload();
	expect("a new subscription first seen on hold blocks checkout without granting Pro", effectivePlan(await readBilling(db), now) === "free" &&
		/Manage billing/.test(String(await rejects(checkout()))) && calls() === before + 3);
}

console.log(failed === 0 ? "\nAll billing checks passed." : `\n${failed} billing check(s) failed.`);
process.exitCode = failed === 0 ? 0 : 1;
