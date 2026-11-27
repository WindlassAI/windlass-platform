/**
 * A user's connected subscription plans: today a Claude plan, connected with the long-lived token
 * `claude setup-token` prints. The token is sealed here and never leaves the platform: hosted Claude Code
 * turns get a relay placeholder, and the relay route opens the token per request (credentials/index.ts).
 */

import { randomUUID } from "node:crypto";
import { UserError } from "rivetkit";
import { config } from "../config.js";
import { isPlanProvider, validPlanToken, PLAN_NAMES, type ModelPlanStatus, type PlanProvider } from "../contract.js";
import type { DefaultsDb } from "../repository-defaults.js";
import { serverSealer } from "../signin/seal.js";

export const MODEL_PLAN_TABLES = [
	`CREATE TABLE IF NOT EXISTS model_plan (
		provider TEXT PRIMARY KEY, sealed TEXT NOT NULL, generation TEXT NOT NULL, account TEXT,
		added_at INTEGER NOT NULL, checked_at INTEGER, check_ok INTEGER NOT NULL DEFAULT 0
	)`,
];

type PlanRow = {
	provider: PlanProvider;
	account: string | null;
	added_at: number;
	checked_at: number | null;
	check_ok: number;
};
const STATUS_COLUMNS = "provider, account, added_at, checked_at, check_ok";

const status = (row: PlanRow): ModelPlanStatus => ({
	provider: row.provider,
	account: row.account,
	addedAt: row.added_at,
	checkedAt: row.checked_at,
	ok: !!row.check_ok,
});

const subject = (uid: string, provider: PlanProvider) => JSON.stringify([uid, provider]);

/** Whether this user may connect plans and run turns on them (WLP_PLAN_USERS). */
export function plansAllowed(uid: string): boolean {
	return config.plans === "all" || config.plans.has(uid);
}

export function planProviderOf(raw: unknown): PlanProvider {
	if (!isPlanProvider(raw)) throw new UserError("Unknown plan.", { code: "bad_provider" });
	return raw;
}

const PLAN_TIERS: Record<string, string> = {
	claude_max: "Max",
	claude_pro: "Pro",
	claude_team: "Team",
	claude_enterprise: "Enterprise",
};

/**
 * Asks Anthropic whose plan the token is, the way Claude Code reads its own profile. Null when Anthropic
 * refused it; throws when Anthropic could not be asked. The answer can echo the token, so only the
 * account's email and tier are read from it.
 */
async function claudeAccount(token: string): Promise<string | null> {
	const origin = (process.env.WLP_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
	const res = await fetch(origin + "/api/oauth/profile", {
		headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
		redirect: "error",
		signal: AbortSignal.timeout(8_000),
	});
	if (res.status === 401 || res.status === 403) {
		await res.body?.cancel();
		return null;
	}
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error("Plan check unavailable");
	}
	const body = (await res.json()) as {
		account?: { email?: unknown };
		organization?: { organization_type?: unknown };
	};
	const email = typeof body.account?.email === "string" ? body.account.email.slice(0, 200) : null;
	const type = body.organization?.organization_type;
	const tier = typeof type === "string" ? PLAN_TIERS[type] : undefined;
	return [email, tier].filter(Boolean).join(" · ") || PLAN_NAMES.anthropic;
}

export class PlanProblem extends Error {
	constructor(
		message: string,
		readonly code: "bad_plan_token" | "plan_refused" | "plan_check_unavailable" | "plans_off",
	) {
		super(message);
	}
}

/** Checks a plan token with its provider and saves it under a new generation, ending every lease of the old one. */
export async function connectPlan(
	db: DefaultsDb,
	uid: string,
	provider: PlanProvider,
	token: unknown,
): Promise<ModelPlanStatus> {
	if (!plansAllowed(uid)) throw new PlanProblem("Connecting a plan is not available on this account.", "plans_off");
	if (!validPlanToken(provider, token))
		throw new PlanProblem("That's not a setup token. It starts with sk-ant-oat01-.", "bad_plan_token");
	let account: string | null;
	try {
		account = await claudeAccount(token);
	} catch {
		throw new PlanProblem("Anthropic could not be reached to check the plan. Try again.", "plan_check_unavailable");
	}
	if (account === null)
		throw new PlanProblem("Anthropic did not accept that token. Run claude setup-token again.", "plan_refused");
	const now = Date.now();
	const [row] = await db.execute<PlanRow>(
		`INSERT INTO model_plan (provider, sealed, generation, account, added_at, checked_at, check_ok)
		VALUES (?, ?, ?, ?, ?, ?, 1)
		ON CONFLICT(provider) DO UPDATE SET sealed=excluded.sealed, generation=excluded.generation, account=excluded.account,
		added_at=excluded.added_at, checked_at=excluded.checked_at, check_ok=1 RETURNING ${STATUS_COLUMNS}`,
		provider,
		serverSealer().seal("model-plan", subject(uid, provider), token),
		randomUUID(),
		account,
		now,
		now,
	);
	return status(row!);
}

export async function planStatuses(db: DefaultsDb): Promise<ModelPlanStatus[]> {
	return (await db.execute<PlanRow>(`SELECT ${STATUS_COLUMNS} FROM model_plan ORDER BY provider`)).map(status);
}

export async function removePlan(db: DefaultsDb, provider: PlanProvider): Promise<void> {
	await db.execute("DELETE FROM model_plan WHERE provider = ?", provider);
}

/** The usable plan's generation: a turn pins it without opening the token. Null while plans are off for the user. */
export async function planGeneration(db: DefaultsDb, uid: string, provider: PlanProvider): Promise<string | null> {
	if (!plansAllowed(uid)) return null;
	const [row] = await db.execute<{ generation: string }>(
		"SELECT generation FROM model_plan WHERE provider = ? AND check_ok=1",
		provider,
	);
	return row?.generation ?? null;
}

/** The usable plans' generations, for a turn to pin one without opening its token. None while plans are off for the user. */
export async function planRefs(db: DefaultsDb, uid: string): Promise<{ provider: PlanProvider; generation: string }[]> {
	if (!plansAllowed(uid)) return [];
	return db.execute("SELECT provider, generation FROM model_plan WHERE check_ok=1 ORDER BY provider");
}

/** The plan's token and generation, resealed under the current key when it was sealed with an older one. */
export async function savedPlan(db: DefaultsDb, uid: string, provider: PlanProvider) {
	if (!plansAllowed(uid)) return null;
	const [row] = await db.execute<{ sealed: string; generation: string }>(
		"SELECT sealed, generation FROM model_plan WHERE provider = ? AND check_ok=1",
		provider,
	);
	if (!row) return null;
	const sealer = serverSealer();
	const owner = subject(uid, provider);
	const token = sealer.open("model-plan", owner, row.sealed);
	if (!sealer.isCurrent(row.sealed)) {
		await db.execute(
			"UPDATE model_plan SET sealed = ? WHERE provider = ? AND sealed = ?",
			sealer.seal("model-plan", owner, token),
			provider,
			row.sealed,
		);
	}
	return { secret: token, generation: row.generation };
}
