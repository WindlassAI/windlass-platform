import { createHash, randomBytes } from "node:crypto";
import type { RawAccess } from "rivetkit/db";
import type { SlackIdentity } from "../contract/slack.js";

// Each workspace has its own database and serializes proof and link operations.
type IdentityDb = Pick<RawAccess, "execute">;
const PROOF_TTL_MS = 5 * 60_000;
export const isSlackTeam = (id: unknown): id is string => typeof id === "string" && /^T[A-Z0-9]{1,127}$/.test(id);
const isSlackUser = (id: unknown): id is string => typeof id === "string" && /^[UW][A-Z0-9]{1,127}$/.test(id);
const digest = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

export const IDENTITY_TABLES = [
	`CREATE TABLE IF NOT EXISTS slack_identity (uid TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE)`,
	`CREATE TABLE IF NOT EXISTS slack_proof (digest TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL)`,
];

/** The prefix is a routing hint, not proof of membership. */
export function proofTeam(ticket: string): string | null {
	return typeof ticket === "string" && ticket.length <= 172
		? /^(T[A-Z0-9]{1,127})\.([A-Za-z0-9_-]{43})$/.exec(ticket)?.[1] ?? null : null;
}

/** Only the caller delivering the private Slack response gets the bearer ticket. */
export async function issueProof(db: IdentityDb, teamId: string, userId: string): Promise<string> {
	if (!isSlackTeam(teamId) || !isSlackUser(userId)) throw new Error("Invalid Slack identity");
	const ticket = `${teamId}.${randomBytes(32).toString("base64url")}`;
	const now = Date.now();
	await db.execute("DELETE FROM slack_proof WHERE expires_at <= ?", now);
	await db.execute(`INSERT INTO slack_proof (digest, user_id, expires_at) VALUES (?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET digest = excluded.digest, expires_at = excluded.expires_at`, digest(ticket), userId, now + PROOF_TTL_MS);
	return ticket;
}

export async function redeemProof(db: IdentityDb, teamId: string, uid: string, ticket: string): Promise<SlackIdentity> {
	if (proofTeam(ticket) !== teamId) throw new Error("Invalid Slack proof");
	// Consume first so that even a conflicting claim cannot reuse the proof after unlink.
	const [proof] = await db.execute<{ user_id: string }>("DELETE FROM slack_proof WHERE digest = ? AND expires_at > ? RETURNING user_id", digest(ticket), Date.now());
	if (!proof) throw new Error("Invalid or expired Slack proof");
	await db.execute("INSERT INTO slack_identity (uid, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", uid, proof.user_id);
	const link = await linkedIdentity(db, teamId, uid);
	if (!link || link.userId !== proof.user_id) throw new Error("Slack identity link conflicts with an existing link");
	return link;
}

export async function linkedIdentity(db: IdentityDb, teamId: string, uid: string): Promise<SlackIdentity | null> {
	const [row] = await db.execute<{ user_id: string }>("SELECT user_id FROM slack_identity WHERE uid = ?", uid);
	return row ? { teamId, userId: row.user_id } : null;
}

export async function resolveIdentity(db: IdentityDb, userId: string): Promise<string | null> {
	const [row] = await db.execute<{ uid: string }>("SELECT uid FROM slack_identity WHERE user_id = ?", userId);
	return row?.uid ?? null;
}

export async function unlinkIdentity(db: IdentityDb, uid: string): Promise<void> {
	await db.execute("DELETE FROM slack_proof WHERE user_id IN (SELECT user_id FROM slack_identity WHERE uid = ?)", uid);
	await db.execute("DELETE FROM slack_identity WHERE uid = ?", uid);
}

export async function clearIdentity(db: IdentityDb): Promise<void> {
	await db.execute("DELETE FROM slack_proof");
	await db.execute("DELETE FROM slack_identity");
}
