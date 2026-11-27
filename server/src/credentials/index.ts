/**
 * What pays for a user's model requests (`CredentialRef`): saved API keys (keys.ts) and connected
 * subscription plans (plans.ts). Both live sealed in the user's actor and reach a turn only through the
 * platform model relay, which opens the secret for one request (`internalCredential`, transit.ts).
 */

import { UserError } from "rivetkit";
import { modelKeyCaller, planConnectCaller } from "../actors/internal.js";
import { requireServiceFor, requireUser } from "../auth.js";
import {
	isModelProvider,
	type CredentialRef,
	type ModelPlans,
	type ModelPlanStatus,
	type PlanProvider,
} from "../contract.js";
import type { DefaultsDb } from "../repository-defaults.js";
import { serverSealer } from "../signin/seal.js";
import { connectCodeDigest, issueConnectCode, connectTransitSubject } from "./connect-code.js";
import { keyGeneration, MODEL_PROVIDER_TABLES, providerStatuses, savedKey, savedModelKeys } from "./keys.js";
import type { HostedCredential } from "../sandbox/harnesses.js";
import {
	connectPlan,
	MODEL_PLAN_TABLES,
	PlanProblem,
	planGeneration,
	planRefs,
	planProviderOf,
	plansAllowed,
	planStatuses,
	removePlan,
	savedPlan,
} from "./plans.js";
import { sealCredentialTransit } from "./transit.js";

export const CREDENTIAL_TABLES = [...MODEL_PROVIDER_TABLES, ...MODEL_PLAN_TABLES];

type Context = Parameters<typeof requireUser>[0] & { db: DefaultsDb };
type Saved = Omit<CredentialRef, "generation">;

function savedRefOf(raw: unknown): Saved {
	const ref = raw as Partial<Saved> | null;
	if (!ref || !isModelProvider(ref.provider) || (ref.plan !== undefined && ref.plan !== true))
		throw new UserError("Invalid credential reference.", { code: "bad_provider" });
	if (ref.plan) planProviderOf(ref.provider);
	return ref.plan ? { provider: ref.provider, plan: true } : { provider: ref.provider };
}

/** What this user's hosted turns can pay with: the checked keys, and the checked plans while plans are on for them. */
export async function hostedCredentials(db: DefaultsDb, uid: string): Promise<HostedCredential[]> {
	const [keys, plans] = await Promise.all([providerStatuses(db), planStatuses(db)]);
	return [
		...keys.filter(k => k.ok),
		...(plansAllowed(uid)
			? plans.filter(p => p.ok).map(p => ({ provider: p.provider, plan: true as const, checkedAt: p.checkedAt }))
			: []),
	];
}

/** The secret behind a reference and its generation, or null when none is saved and usable. */
function saved(db: DefaultsDb, uid: string, ref: Saved) {
	return ref.plan ? savedPlan(db, uid, planProviderOf(ref.provider)) : savedKey(db, uid, ref.provider);
}

export const credentialActions = {
	async modelPlans(c: Context): Promise<ModelPlans> {
		const { uid } = requireUser(c);
		return { allowed: plansAllowed(uid), plans: await planStatuses(c.db) };
	},
	/** A one-time code for the connect command, which hands the plan's token to this user. */
	async startPlanConnect(
		c: Context & Parameters<typeof issueConnectCode>[0],
		raw: PlanProvider,
	): Promise<{ code: string; expiresAt: number }> {
		const { uid } = requireUser(c);
		const provider = planProviderOf(raw);
		if (!plansAllowed(uid))
			throw new UserError("Connecting a plan is not available on this account.", { code: "plans_off" });
		const issued = await issueConnectCode(c, uid, provider);
		if (!issued)
			throw new UserError("Too many connect codes are open. Use one, or wait ten minutes.", { code: "rate_limited" });
		return issued;
	},
	async removeModelPlan(c: Context, raw: PlanProvider): Promise<void> {
		requireUser(c);
		await removePlan(c.db, planProviderOf(raw));
	},
	/** The connect route hands over a plan's token, sealed for this user and the code it redeemed. */
	async internalConnectPlan(c: Context, raw: PlanProvider, digest: string, sealed: string): Promise<ModelPlanStatus> {
		const uid = c.key[0]!;
		requireServiceFor(c, planConnectCaller(uid));
		const provider = planProviderOf(raw);
		const code = connectCodeDigest.parse(digest);
		const token = serverSealer().open("transit", connectTransitSubject(uid, provider, code), sealed);
		try {
			return await connectPlan(c.db, uid, provider, token);
		} catch (error) {
			if (error instanceof PlanProblem) throw new UserError(error.message, { code: error.code });
			throw error;
		}
	},
	/** Everything a hosted turn can pay with, each pinned to its generation: checked keys, then usable plans. */
	async internalHostedCredentials(c: Context): Promise<CredentialRef[]> {
		const uid = c.key[0]!;
		requireServiceFor(c, modelKeyCaller(uid));
		const [keys, plans] = await Promise.all([savedModelKeys(c.db), planRefs(c.db, uid)]);
		return [...keys, ...plans.map(p => ({ ...p, plan: true as const }))];
	},
	async internalCredentialGeneration(c: Context, raw: unknown): Promise<string | null> {
		const uid = c.key[0]!;
		requireServiceFor(c, modelKeyCaller(uid));
		const ref = savedRefOf(raw);
		return ref.plan ? planGeneration(c.db, uid, planProviderOf(ref.provider)) : keyGeneration(c.db, ref.provider);
	},
	/** The relay route asks for the secret per request; it is sealed for that request's nonce, for a minute. */
	async internalCredential(c: Context, raw: unknown, nonce: string): Promise<string | null> {
		const uid = c.key[0]!;
		requireServiceFor(c, modelKeyCaller(uid));
		const ref = savedRefOf(raw);
		if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
			throw new UserError("Invalid credential request nonce.", { code: "bad_nonce" });
		const found = await saved(c.db, uid, ref);
		return found && sealCredentialTransit(uid, ref, nonce, found.secret, found.generation);
	},
};
