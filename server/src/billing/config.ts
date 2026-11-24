/**
 * Whether the deployment takes payment for plans, and with which provider (docs/billing.md).
 *
 *   WLP_BILLING_PROVIDER         unset or empty: billing is off (no plans, the deployment's limits). "dodo": Dodo Payments
 *   WLP_BILLING_GRACE_DAYS       how long Pro's limits last after a failed payment (7)
 *
 * Dodo Payments:
 *   WLP_DODO_API_KEY             the API key (a secret)
 *   WLP_DODO_WEBHOOK_SECRET      the webhook endpoint's signing secret, whsec_… (a secret)
 *   WLP_DODO_ENVIRONMENT         test_mode (the default) or live_mode
 *   WLP_DODO_PRODUCT_PRO_MONTHLY the Pro subscription product billed monthly, pdt_…
 *   WLP_DODO_PRODUCT_PRO_YEARLY  the Pro subscription product billed yearly, pdt_…
 *   WLP_DODO_METER_EVENT         the overage meter's event name (hosted_minutes)
 *
 * A provider that is named and missing a setting stops the server at start, with the setting's name and no value.
 */

import { DodoProvider } from "./dodo.js";
import type { BillingProvider } from "./provider.js";

export interface BillingConfig {
	provider: BillingProvider;
	graceMs: number;
}

export function readBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig | null {
	const name = (env.WLP_BILLING_PROVIDER ?? "").trim().toLowerCase();
	if (name === "" || name === "off") return null;
	const graceDays = Number(env.WLP_BILLING_GRACE_DAYS ?? 7);
	if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60) throw new Error("WLP_BILLING_GRACE_DAYS must be a whole number of days from 0 to 60.");
	const graceMs = graceDays * 86_400_000;
	if (name !== "dodo") throw new Error(`WLP_BILLING_PROVIDER must be "dodo" or unset; got "${name.slice(0, 32)}".`);
	const need = (key: string) => {
		const value = (env[key] ?? "").trim();
		if (value === "") throw new Error(`${key} must be set when WLP_BILLING_PROVIDER=dodo.`);
		return value;
	};
	const environment = (env.WLP_DODO_ENVIRONMENT ?? "test_mode").trim();
	if (environment !== "test_mode" && environment !== "live_mode") throw new Error('WLP_DODO_ENVIRONMENT must be "test_mode" or "live_mode".');
	const meterEvent = (env.WLP_DODO_METER_EVENT ?? "hosted_minutes").trim();
	if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(meterEvent)) throw new Error("WLP_DODO_METER_EVENT must be a meter's event name: letters, digits and _ . : -.");
	return {
		graceMs,
		provider: new DodoProvider({
			apiKey: need("WLP_DODO_API_KEY"),
			webhookSecret: need("WLP_DODO_WEBHOOK_SECRET"),
			environment,
			products: { month: need("WLP_DODO_PRODUCT_PRO_MONTHLY"), year: need("WLP_DODO_PRODUCT_PRO_YEARLY") },
			meterEvent,
		}),
	};
}

let read: { value: BillingConfig | null } | null = null;

/** The deployment's billing, read once. Null: billing is off. */
export function billing(): BillingConfig | null {
	read ??= { value: readBillingConfig() };
	return read.value;
}
