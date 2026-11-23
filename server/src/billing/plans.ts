/**
 * The plans a deployment with billing offers (WLP_BILLING_PROVIDER), and how a plan becomes the account's limits.
 *
 * A plan sets limits where the deployment's defaults would otherwise apply, and an operator's override of one user's
 * limit (set-user-limit.ts) still comes first: override, then plan, then the deployment (user-limits.ts). A deployment
 * with no billing has no plans, and every account has the deployment's limits, as before.
 *
 * Which plan applies is decided from the subscription's state and the clock (`effectivePlan`): Pro while its
 * subscription is active, or after a failed payment until the grace period ends; Free otherwise. Falling back to Free
 * deletes nothing: kept sandboxes, machines and items stay, and only what can start next is held to Free's limits.
 *
 * Team and Enterprise come later. They fit here as more `PlanId`s whose limits are pooled over an org's seats: a plan is
 * only a set of limits plus a price, and the subscription that pays for it says which one applies.
 */

import type { BillingPeriod, HostedSizeOption, PlanId, PlanInfo } from "../contract.js";

/** The weights a sandbox size counts with (billing/meter.ts). */
export type SandboxSize = "small" | "standard" | "large";

export const PLANS: Record<PlanId, PlanInfo> = {
	free: {
		id: "free", name: "Free", monthlyCents: 0, yearlyCents: null,
		machines: 3, hostedMinutes: 120, hostedRunning: 1, keptSandboxes: 2,
		sizes: ["small", "standard"], crossRepo: false, githubItemsPerDay: 20,
		overageCentsPer1000: null,
	},
	pro: {
		id: "pro", name: "Pro", monthlyCents: 1500, yearlyCents: 14_400,
		machines: 10, hostedMinutes: 1800, hostedRunning: 5, keptSandboxes: 10,
		sizes: ["small", "standard", "large"], crossRepo: true, githubItemsPerDay: 100,
		// $0.006 a hosted minute.
		overageCentsPer1000: 600,
	},
};

export const PLAN_LIST: PlanInfo[] = [PLANS.free, PLANS.pro];

/** The overage spend cap a new subscription starts with, and the most a user may set it to: $20 a month. */
export const DEFAULT_CAP_CENTS = 2000;
export const MAX_CAP_CENTS = 2000;

/** The minutes a spend cap pays for at a plan's overage price, whole minutes, rounded down: never more than the cap. */
export function capMinutes(plan: PlanInfo, capCents: number): number {
	if (plan.overageCentsPer1000 === null || capCents <= 0) return 0;
	return Math.floor((capCents * 1000) / plan.overageCentsPer1000);
}

/** What overage minutes cost, in cents, rounded up. */
export function overageCents(plan: PlanInfo, minutes: number): number {
	return plan.overageCentsPer1000 === null ? 0 : Math.ceil((minutes * plan.overageCentsPer1000) / 1000);
}

/** The account's subscription, as the provider's webhooks have told it (billing/account.ts keeps it). */
export interface BillingState {
	/** The plan the subscription is for; "free" without one. */
	plan: PlanId;
	status: "none" | "active" | "past_due" | "paused" | "ended";
	period: BillingPeriod | null;
	customerId: string | null;
	subscriptionId: string | null;
	periodStart: number | null;
	periodEnd: number | null;
	/** The last completed monthly Pro period, for late settlements after renewal. */
	previousPeriod: { start: number; end: number } | null;
	cancelAtPeriodEnd: boolean;
	/** Set at the first failed payment, and not moved by the ones after it: when Pro's limits stop. */
	graceUntil: number | null;
	capCents: number;
	/** The provider's time of the last event that changed this, ms: an older event that arrives late changes nothing. */
	eventAt: number;
}

export const NO_SUBSCRIPTION: BillingState = {
	plan: "free", status: "none", period: null, customerId: null, subscriptionId: null,
	periodStart: null, periodEnd: null, previousPeriod: null, cancelAtPeriodEnd: false, graceUntil: null, capCents: DEFAULT_CAP_CENTS, eventAt: 0,
};

/** The plan whose limits apply at `now`. */
export function effectivePlan(state: BillingState, now: number): PlanId {
	if (state.plan === "free") return "free";
	if (state.status === "active") return state.plan;
	if ((state.status === "past_due" || state.status === "paused") && state.graceUntil !== null && now < state.graceUntil) return state.plan;
	return "free";
}

/** Whether a sandbox of this size may be started on the plan. The sizes work fills in where a size is chosen. */
export function planAllowsSize(plan: PlanInfo | null, size: SandboxSize): boolean {
	return plan === null || plan.sizes.includes(size);
}

/** Sizes that both the deployment and this account offer. */
export function hostedSizesForPlan(listed: HostedSizeOption[], plan: PlanInfo | null): HostedSizeOption[] {
	return listed.filter(size => planAllowsSize(plan, size.id));
}

/**
 * The limits a plan sets, in the shape user-limits.ts folds between the operator's overrides and the deployment's
 * defaults. `monthlySeconds` is the most that may be used in a month: the included minutes, and with overage what the
 * cap pays for. The daily allowance gives way to the monthly one where a plan applies (`dailySeconds: null`).
 */
export interface PlanLimits {
	plan: PlanInfo;
	hostedRunning: number;
	githubItemsPerDay: number;
	maxKept: number;
	machines: number;
	includedSeconds: number;
	monthlySeconds: number;
}

export function planLimits(state: BillingState, now: number): PlanLimits {
	const plan = PLANS[effectivePlan(state, now)];
	return {
		plan,
		hostedRunning: plan.hostedRunning,
		githubItemsPerDay: plan.githubItemsPerDay,
		maxKept: plan.keptSandboxes,
		machines: plan.machines,
		includedSeconds: plan.hostedMinutes * 60,
		monthlySeconds: (plan.hostedMinutes + (state.period === "month" ? capMinutes(plan, state.capCents) : 0)) * 60,
	};
}
