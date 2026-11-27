/**
 * What pays for a user's model requests (`CredentialRef`): saved API keys (keys.ts) and connected
 * subscription plans (plans.ts). Both live sealed in the user's actor and reach a turn only through a
 * model relay, which gets the secret for one request (`internalCredential`, transit.ts). A ChatGPT plan's
 * secret is its current access token, from the user's sign-in holder (actors/user/signin.ts).
 */

import { UserError } from "rivetkit";
import type { ConnectDecision } from "../actors/connect-codes.js";
import { type HasClient, modelKeyCaller, planConnectCaller } from "../actors/internal.js";
import { requireServiceFor, requireUser, serviceParams } from "../auth.js";
import {
	isModelProvider,
	type CredentialRef,
	type ModelPlans,
	type ModelPlanStatus,
	type PlanProvider,
} from "../contract.js";
import type { DefaultsDb } from "../repository-defaults.js";
import { serverSealer } from "../signin/seal.js";
import { connectCodeDigest, connectTransitSubject } from "./connect-code.js";
import { keyGeneration, MODEL_PROVIDER_TABLES, providerStatuses, savedKey, savedModelKeys } from "./keys.js";
import type { HostedCredential } from "../sandbox/harnesses.js";
import {
	claudePlanCheck,
	connectPlan,
	MODEL_PLAN_TABLES,
	PlanProblem,
	planGeneration,
	planRefs,
	planProviderOf,
	plansAllowed,
	planStatuses,
	recordAgentModels,
	removePlan,
	savedPlan,
} from "./plans.js";
import { type OpenedCredential, sealCredentialTransit } from "./transit.js";

export const CREDENTIAL_TABLES = [...MODEL_PROVIDER_TABLES, ...MODEL_PLAN_TABLES];

type Context = Parameters<typeof requireUser>[0] & { db: DefaultsDb };

/**
 * The ChatGPT plan as the user actor's sign-in holder serves it (actors/user/signin.ts `chatgptPlan`): its current
 * access token (refreshed by the holder, which alone keeps the refresh token), a check, and forgetting it.
 */
export interface ChatgptPlan {
	token(): Promise<OpenedCredential | null>;
	check(): Promise<void>;
	forget(): Promise<void>;
}
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
			? plans
					.filter(p => p.ok)
					.map(p => ({ provider: p.provider, plan: true as const, checkedAt: p.checkedAt, models: p.models }))
			: []),
	];
}

/** The secret behind a reference and its generation (and a ChatGPT plan's token's expiry), or null when none is saved and usable. */
function saved(db: DefaultsDb, uid: string, ref: Saved, chatgpt: ChatgptPlan | undefined) {
	if (!ref.plan) return savedKey(db, uid, ref.provider);
	const provider = planProviderOf(ref.provider);
	if (provider !== "openai") return savedPlan(db, uid, provider);
	return plansAllowed(uid) && chatgpt ? chatgpt.token() : null;
}

async function decideConnect(c: HasClient, uid: string, userCode: unknown, approve: boolean): Promise<void> {
	const digest = connectCodeDigest.ofUserCode(userCode);
	if (!digest) throw new UserError("That is not a connect code. It looks like KQ2M-8XF4.", { code: "bad_input" });
	const decided: ConnectDecision = await c
		.client()
		.connectCodes.getOrCreate(["codes"], { params: serviceParams() })
		.internalDecide(digest, uid, approve);
	if (decided === "rate_limited")
		throw new UserError("Too many codes did not match. Wait ten minutes, then run the command again.", {
			code: "rate_limited",
		});
	if (decided === "not_found")
		throw new UserError("That code expired or was already used. Run the command in your terminal again.", {
			code: "connect_code_not_found",
		});
}

export const credentialActions = {
	async modelPlans(c: Context): Promise<ModelPlans> {
		const { uid } = requireUser(c);
		return { allowed: plansAllowed(uid), plans: await planStatuses(c.db) };
	},
	/** Approves the connect request whose code the user's terminal shows: that terminal may now hand over its token. */
	async approvePlanConnect(c: Context & HasClient, userCode: unknown): Promise<void> {
		const { uid } = requireUser(c);
		if (!plansAllowed(uid))
			throw new UserError("Connecting a plan is not available on this account.", { code: "plans_off" });
		await decideConnect(c, uid, userCode, true);
	},
	async denyPlanConnect(c: Context & HasClient, userCode: unknown): Promise<void> {
		const { uid } = requireUser(c);
		await decideConnect(c, uid, userCode, false);
	},
	async removeModelPlan(c: Context, raw: PlanProvider, chatgpt?: ChatgptPlan): Promise<void> {
		requireUser(c);
		const provider = planProviderOf(raw);
		if (provider === "openai") await chatgpt?.forget();
		else await removePlan(c.db, provider);
	},
	/** Asks the plan's provider again who it belongs to and, for a ChatGPT plan, which models it offers. */
	async recheckModelPlan(c: Context, raw: PlanProvider, chatgpt?: ChatgptPlan): Promise<ModelPlanStatus | null> {
		const { uid } = requireUser(c);
		const provider = planProviderOf(raw);
		if (provider === "openai") await chatgpt?.check();
		else {
			try {
				await claudePlanCheck(c.db, uid);
			} catch (error) {
				if (error instanceof PlanProblem) throw new UserError(error.message, { code: error.code });
				throw error;
			}
		}
		return (await planStatuses(c.db)).find(p => p.provider === provider) ?? null;
	},
	/** A hosted turn that paid with a plan reports the models its agent offered at the session's start (`recordAgentModels`). */
	async internalPlanModels(c: Context, raw: unknown, ids: unknown): Promise<boolean> {
		requireServiceFor(c, modelKeyCaller(c.key[0]!));
		const ref = raw as Partial<CredentialRef> | null;
		if (!ref?.plan || typeof ref.generation !== "string" || !Array.isArray(ids)) return false;
		return recordAgentModels(c.db, planProviderOf(ref.provider), ref.generation, ids);
	},
	/** The connect route hands over a plan's token, sealed for this user and the request it took. */
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
	async internalCredential(c: Context, raw: unknown, nonce: string, chatgpt?: ChatgptPlan): Promise<string | null> {
		const uid = c.key[0]!;
		requireServiceFor(c, modelKeyCaller(uid));
		const ref = savedRefOf(raw);
		if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
			throw new UserError("Invalid credential request nonce.", { code: "bad_nonce" });
		const found = await saved(c.db, uid, ref, chatgpt);
		return found && sealCredentialTransit(uid, ref, nonce, found);
	},
};
