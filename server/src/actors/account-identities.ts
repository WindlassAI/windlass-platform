import { randomUUID } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { mayUse } from "../access.js";
import { internalConnection, requireServiceFor } from "../auth.js";
import { config } from "../config.js";
import type { LinkedLogin, LoginProvider } from "../contract.js";
import { loginIssuer, type Identity } from "../platform-login.js";

export async function identityTables(sql: RawAccess) {
	await sql.execute(
		"CREATE TABLE IF NOT EXISTS login_identity (provider TEXT NOT NULL, issuer TEXT NOT NULL, sub TEXT NOT NULL, uid TEXT NOT NULL, PRIMARY KEY(provider, issuer, sub), UNIQUE(uid, provider, issuer))",
	);
	const columns = await sql.execute<{ name: string }>("PRAGMA table_info(login_identity)");
	for (const column of ["display", "name", "avatar"]) {
		if (!columns.some(known => known.name === column))
			await sql.execute(`ALTER TABLE login_identity ADD COLUMN ${column} TEXT`);
	}
	// The old directory did not record whether an assignment was based on an email match.
	await sql.execute("DROP TABLE IF EXISTS identity");
	await sql.execute("DROP TABLE IF EXISTS legacy");
	await sql.execute("DROP TABLE IF EXISTS initialized");
	await sql.execute(
		"CREATE TABLE IF NOT EXISTS login_budget (bucket TEXT PRIMARY KEY, minute INTEGER NOT NULL, used INTEGER NOT NULL)",
	);
}

export async function resolveIdentity(
	sql: RawAccess,
	{ provider, issuer, sub, email, display = null, name = null, avatar = null }: Identity,
): Promise<string | null> {
	const key = [provider, issuer, sub];
	const [known] = await sql.execute<{ uid: string }>(
		"UPDATE login_identity SET display=?, name=?, avatar=? WHERE provider=? AND issuer=? AND sub=? RETURNING uid",
		display,
		name,
		avatar,
		...key,
	);
	if (known) return known.uid;
	const uid = "u_" + randomUUID();
	if (!mayUse({ uid, email, demo: false }, config.access)) return null;
	const [row] = await sql.execute<{ uid: string }>(
		`INSERT INTO login_identity (provider,issuer,sub,uid,display,name,avatar) VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(provider,issuer,sub) DO UPDATE SET display=excluded.display, name=excluded.name, avatar=excluded.avatar RETURNING uid`,
		...key,
		uid,
		display,
		name,
		avatar,
	);
	return row.uid;
}

type Linked = Pick<Identity, "provider" | "issuer" | "sub" | "display" | "name" | "avatar">;

async function linkIdentity(sql: RawAccess, uid: string, { provider, issuer, sub, display, name, avatar }: Linked) {
	const [row] = await sql.execute(
		`INSERT INTO login_identity (provider,issuer,sub,uid,display,name,avatar) VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(provider,issuer,sub) DO UPDATE SET display=COALESCE(excluded.display, login_identity.display),
			name=COALESCE(excluded.name, login_identity.name), avatar=COALESCE(excluded.avatar, login_identity.avatar) WHERE uid=excluded.uid
		ON CONFLICT DO NOTHING RETURNING uid`,
		provider,
		issuer,
		sub,
		uid,
		display ?? null,
		name ?? null,
		avatar ?? null,
	);
	if (!row) throw new UserError("That login identity or provider is already linked.", { code: "identity_linked" });
}

function requireCurrentIssuer({ provider, issuer }: Pick<Identity, "provider" | "issuer">) {
	if (!issuer || loginIssuer(provider) !== issuer)
		throw new UserError("The login provider changed. Start again.", { code: "invalid_callback" });
}

async function linked(sql: RawAccess, uid: string): Promise<LinkedLogin[]> {
	const rows = await sql.execute<{
		provider: LoginProvider;
		issuer: string;
		display: string | null;
		name: string | null;
		avatar: string | null;
	}>("SELECT provider,issuer,display,name,avatar FROM login_identity WHERE uid=?", uid);
	return rows
		.filter(row => row.issuer === loginIssuer(row.provider))
		.map(({ provider, display, name, avatar }) => ({ provider, display, name, avatar }));
}

async function admitLogin(sql: RawAccess, address: string, perAddress: number, total: number) {
	return sql.transaction(async tx => {
		const minute = Math.floor(Date.now() / 60_000);
		await tx.execute("DELETE FROM login_budget WHERE minute<>?", minute);
		for (const [key, limit] of [
			["total", total],
			["ip:" + address, perAddress],
		] as const) {
			const used = await tx.execute<{ used: number }>("SELECT used FROM login_budget WHERE bucket=?", key);
			if ((used[0]?.used ?? 0) >= limit) return false;
		}
		await tx.execute(
			"INSERT INTO login_budget VALUES ('total',?,1),(?,?,1) ON CONFLICT(bucket) DO UPDATE SET used=used+1",
			minute,
			"ip:" + address,
			minute,
		);
		return true;
	});
}

export const accountIdentities = actor({
	onBeforeConnect: internalConnection,
	db: db({ onMigrate: identityTables }),
	actions: {
		internalAdmit: (c, address: string): Promise<boolean> => {
			requireServiceFor(c, "call");
			return admitLogin(c.db, address, config.httpLimits.loginAddress, config.httpLimits.loginTotal);
		},
		internalResolve: (c, identity: Identity): Promise<string | null> => {
			requireServiceFor(c, "call");
			requireCurrentIssuer(identity);
			return resolveIdentity(c.db, identity);
		},
		internalLink: (c, uid: string, identity: Linked): Promise<void> => {
			requireServiceFor(c, "call");
			requireCurrentIssuer(identity);
			return linkIdentity(c.db, uid, identity);
		},
		internalLinked: (c, uid: string): Promise<LinkedLogin[]> => {
			requireServiceFor(c, "call");
			return linked(c.db, uid);
		},
		internalUnlink: (c, uid: string, provider: LoginProvider): Promise<void> => {
			requireServiceFor(c, "call");
			return c.db.transaction(async tx => {
				const methods = await linked(tx, uid);
				if (!methods.some(method => method.provider === provider)) return;
				if (methods.length < 2) throw new UserError("Link another login method first.", { code: "last_login" });
				await tx.execute(
					"DELETE FROM login_identity WHERE uid=? AND provider=? AND issuer=?",
					uid,
					provider,
					loginIssuer(provider),
				);
			});
		},
	},
});
