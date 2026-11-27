/**
 * A user's tokens for the platform's HTTP API (api-routes.ts): what a script sends as
 * `Authorization: Bearer wlp_…` to file a work item or read one (Plans "software factory", slice 1).
 *
 * A token is `wlp_<uid>.<secret>`: the secret is 32 random bytes (base64url), and the user's id is in
 * front of it so that whichever server takes the request knows which `user` actor to ask, without a
 * directory of every token. Only that actor can say whether the token is good: it keeps one row per
 * token with the token's SHA-256 and never the token, so whoever reads its storage cannot use one. A
 * token whose id names another user is simply unknown there. The value is shown once, when it is
 * made; a token works until it is revoked, which deletes its row.
 *
 * Each token has scopes (`ApiTokenScope`): `items:create` files items, `items:read` reads them.
 */

import { createHash, randomBytes } from "node:crypto";
import type { RawAccess } from "rivetkit/db";
import { type ApiToken, type ApiTokenScope, MAX_API_TOKENS, MAX_TITLE_CHARS } from "./contract.js";

export const API_TOKENS_TABLE = `
	CREATE TABLE IF NOT EXISTS api_token (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		scopes TEXT NOT NULL,
		digest TEXT NOT NULL UNIQUE,
		created_at INTEGER NOT NULL,
		used_at INTEGER,
		window_count INTEGER NOT NULL DEFAULT 0
	)
`;

const PREFIX = "wlp_";
const SCOPES: readonly ApiTokenScope[] = ["items:create", "items:read"];
/** A user id as the platform makes them (signin/material.ts): letters, digits, `_` and `-`. */
const UID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
/** The token use displayed on Settings and the admission counter share a UTC minute. */
export const API_TOKEN_WINDOW_MS = 60_000;

export class ApiTokenProblem extends Error {
	constructor(
		readonly code: "bad_input" | "too_many_tokens",
		message: string,
	) {
		super(message);
	}
}

const digestOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** The user a token names, and its digest; null for anything that is not shaped as a token. Says nothing of whether it is good. */
export function tokenOwner(token: unknown): { uid: string; digest: string } | null {
	if (typeof token !== "string" || !token.startsWith(PREFIX)) return null;
	const dot = token.indexOf(".", PREFIX.length);
	const uid = token.slice(PREFIX.length, dot);
	if (dot < 0 || !UID.test(uid) || !SECRET.test(token.slice(dot + 1))) return null;
	return { uid, digest: digestOf(token) };
}

/** The bearer token of an HTTP request, if it sends one. */
export function bearerOf(request: Request): string | null {
	const header = request.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	return match ? (match[1] ?? null) : null;
}

type Row = { id: string; name: string; scopes: string; created_at: number; used_at: number | null };

function tokenOf(row: Row): ApiToken {
	return {
		id: row.id,
		name: row.name,
		scopes: JSON.parse(row.scopes) as ApiTokenScope[],
		createdAt: row.created_at,
		usedAt: row.used_at,
	};
}

export async function listApiTokens(db: RawAccess): Promise<ApiToken[]> {
	const rows = await db.execute<Row>(
		"SELECT id, name, scopes, created_at, used_at FROM api_token ORDER BY created_at DESC, id",
	);
	return rows.map(tokenOf);
}

function cleanInput(input: unknown): { name: string; scopes: ApiTokenScope[] } {
	const given = (typeof input === "object" && input !== null ? input : {}) as { name?: unknown; scopes?: unknown };
	const name = typeof given.name === "string" ? given.name.replace(/\s+/g, " ").trim() : "";
	if (name === "" || name.length > MAX_TITLE_CHARS)
		throw new ApiTokenProblem("bad_input", `Name the token, in at most ${MAX_TITLE_CHARS} characters.`);
	const scopes = Array.isArray(given.scopes) ? [...new Set(given.scopes)] : [];
	if (
		scopes.length === 0 ||
		!scopes.every((scope): scope is ApiTokenScope => SCOPES.includes(scope as ApiTokenScope))
	) {
		throw new ApiTokenProblem("bad_input", `Choose what the token may do: ${SCOPES.join(", ")}.`);
	}
	return { name, scopes: SCOPES.filter(scope => scopes.includes(scope)) };
}

/**
 * Makes a token for `uid`. The row goes in by one statement that counts the user's tokens in the same
 * step, so tokens made at the same moment cannot pass MAX_API_TOKENS together.
 */
export async function createApiToken(
	db: RawAccess,
	uid: string,
	input: unknown,
	now: number,
): Promise<{ token: ApiToken; secret: string }> {
	const { name, scopes } = cleanInput(input);
	const secret = `${PREFIX}${uid}.${randomBytes(32).toString("base64url")}`;
	const id = `tok_${randomBytes(8).toString("hex")}`;
	await db.execute(
		"INSERT INTO api_token (id, name, scopes, digest, created_at, used_at) SELECT ?, ?, ?, ?, ?, NULL WHERE (SELECT COUNT(*) FROM api_token) < ?",
		id,
		name,
		JSON.stringify(scopes),
		digestOf(secret),
		now,
		MAX_API_TOKENS,
	);
	const [row] = await db.execute<Row>("SELECT id, name, scopes, created_at, used_at FROM api_token WHERE id = ?", id);
	if (!row)
		throw new ApiTokenProblem(
			"too_many_tokens",
			`You have ${MAX_API_TOKENS} API tokens, which is the most. Revoke one first.`,
		);
	return { token: tokenOf(row), secret };
}

export async function revokeApiToken(db: RawAccess, id: unknown): Promise<void> {
	if (typeof id === "string") await db.execute("DELETE FROM api_token WHERE id = ?", id);
}

/** Authorize and charge in one write on the owning actor, even for simultaneous GET and POST. */
export async function useApiToken(
	db: RawAccess,
	digest: string,
	scope: ApiTokenScope,
	now: number,
	limit: number,
): Promise<"accepted" | "limited" | "invalid"> {
	const minute = Math.floor(now / API_TOKEN_WINDOW_MS) * API_TOKEN_WINDOW_MS;
	const authorized = "digest = ? AND EXISTS (SELECT 1 FROM json_each(scopes) WHERE value = ?)";
	const rows = await db.execute(
		`UPDATE api_token SET used_at = ?,
		window_count = CASE WHEN used_at = ? THEN window_count + 1 ELSE 1 END
		WHERE ${authorized} AND (used_at IS NOT ? OR window_count < ?) RETURNING id`,
		minute,
		minute,
		digest,
		scope,
		minute,
		limit,
	);
	if (rows.length) return "accepted";
	const valid = await db.execute(`SELECT id FROM api_token WHERE ${authorized}`, digest, scope);
	return valid.length ? "limited" : "invalid";
}
