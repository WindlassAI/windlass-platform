import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { requireServiceFor } from "./auth.js";
import { config } from "./config.js";
import type { FactoryLimits } from "./contract.js";
import { ATTACHMENT_LIMITS } from "./factory/attachments.js";

const ranges = {
	runningTurns: [1, 100], factoryTurns: [1, 100], hostedRunning: [1, 100], reviewCap: [1, 1000],
	featureMultiplier: [1, 100], dailyTokens: [1, Number.MAX_SAFE_INTEGER],
	githubItemsPerDay: [1, 1_000_000], githubDrafts: [1, 1_000_000],
	"item.tokens": [1, 1_000_000_000], "item.turns": [1, 1000],
	"item.activeSeconds": [1, 7 * 86400], "item.hostedSeconds": [1, 7 * 86400],
	"attachments.bytes": [1, ATTACHMENT_LIMITS.bytes], "attachments.perItem": [1, 1_000_000],
	"attachments.accountBytes": [1, Number.MAX_SAFE_INTEGER], "attachments.days": [1, 36500],
	dailySeconds: [60, 86400], maxKept: [1, 1000],
} as const;
type Key = keyof typeof ranges;
type Overrides = Partial<Record<Key, number | null>>;
type Db = Pick<RawAccess, "execute">;
export const LIMITS_AUDIT_TABLE = `CREATE TABLE IF NOT EXISTS limit_changes (
	id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operator TEXT NOT NULL, setting TEXT NOT NULL,
	old_value INTEGER, new_value INTEGER, overrides TEXT NOT NULL)`;

export function effectiveUserLimits(overrides: Overrides) {
	const defaults = config.factory;
	const value = (key: Key, fallback: number) => overrides[key] ?? fallback;
	const item = { ...defaults.item }, attachments = { ...defaults.attachments };
	for (const key of Object.keys(item) as (keyof typeof item)[]) item[key] = value(`item.${key}`, item[key]);
	for (const key of Object.keys(attachments) as (keyof typeof attachments)[]) attachments[key] = value(`attachments.${key}`, attachments[key]);
	const runningTurns = value("runningTurns", defaults.runningTurns);
	const factory: FactoryLimits = {
		runningTurns, factoryTurns: Math.min(value("factoryTurns", defaults.factoryTurns), runningTurns - 1),
		hostedRunning: value("hostedRunning", defaults.hostedRunning), reviewCap: value("reviewCap", defaults.reviewCap),
		featureMultiplier: value("featureMultiplier", defaults.featureMultiplier), dailyTokens: overrides.dailyTokens === undefined ? defaults.dailyTokens : overrides.dailyTokens,
		githubItemsPerDay: value("githubItemsPerDay", defaults.githubItemsPerDay), githubDrafts: value("githubDrafts", defaults.githubDrafts),
		item, attachments,
	};
	const usage = { ...config.usage };
	for (const key of ["dailySeconds", "maxKept"] as const) if (overrides[key] !== undefined) usage[key] = overrides[key];
	return { factory, usage };
}

export async function readUserLimits(db: Db) {
	const [row] = await db.execute<{ id: number; overrides: string }>("SELECT id, overrides FROM limit_changes ORDER BY id DESC LIMIT 1");
	const overrides: Overrides = row ? JSON.parse(row.overrides) : {};
	return { id: row?.id ?? 0, overrides };
}
export type UserLimits = Awaited<ReturnType<typeof readUserLimits>>;
export type LimitAuditRow = { id: number; at: number; operator: string; setting: Key; old_value: number | null; new_value: number | null; overrides: string };
export type LimitChange = { operator: string; key: string; value: number | "default" | "unlimited" };

function setting(limits: ReturnType<typeof effectiveUserLimits>, key: Key) {
	if (key === "dailySeconds" || key === "maxKept") return limits.usage[key];
	if (key.startsWith("item.")) return limits.factory.item[key.slice(5) as keyof FactoryLimits["item"]];
	if (key.startsWith("attachments.")) return limits.factory.attachments[key.slice(12) as keyof FactoryLimits["attachments"]];
	return limits.factory[key as Exclude<keyof FactoryLimits, "item" | "attachments">];
}

export function limitsSubject(uid: string, operator: string) {
	if (typeof operator !== "string" || !/^[A-Za-z0-9_.@-]{1,128}$/.test(operator)) throw new UserError("Invalid operator identity.", { code: "bad_input" });
	return `limits:${encodeURIComponent(uid)}:${operator}`;
}

/** The new snapshot and its audit record are the same row. Independent edits serialize in SQLite. */
export async function changeUserLimit(c: { key: string[]; conn?: { params: unknown } | null; db: Pick<RawAccess, "transaction"> }, input: LimitChange) {
	requireServiceFor(c, limitsSubject(c.key[0]!, input?.operator));
	if (!Object.hasOwn(ranges, input.key)) throw new UserError("Unknown limit.", { code: "bad_input" });
	const key = input.key as Key;
	const [min, max] = ranges[key];
	const { value } = input;
	if (value !== "default" && !(value === "unlimited" && (key === "dailyTokens" || key === "dailySeconds" || key === "maxKept")) &&
		(typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max))
		throw new UserError(`Use an integer from ${min} to ${max}, or default.`, { code: "bad_input" });
	return c.db.transaction(async tx => {
		const before = await readUserLimits(tx);
		const overrides = { ...before.overrides };
		if (value === "default") delete overrides[key];
		else overrides[key] = value === "unlimited" ? null : value;
		if (before.overrides[key] === overrides[key]) return before;
		const after = effectiveUserLimits(overrides);
		const [row] = await tx.execute<{ id: number }>("INSERT INTO limit_changes(at, operator, setting, old_value, new_value, overrides) VALUES(?,?,?,?,?,?) RETURNING id",
			Date.now(), input.operator, key, setting(effectiveUserLimits(before.overrides), key), setting(after, key), JSON.stringify(overrides));
		return { id: row!.id, overrides };
	}, { name: "limits.change" });
}
