import { randomUUID } from "node:crypto";
import { actor } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import type { createClient } from "rivetkit/client";
import { mayUse, normalizeEmail } from "../access.js";
import { isActorGone } from "../actor-errors.js";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import { config, engineAdminToken, ownEngineEndpoint } from "../config.js";
import type { Identity } from "../platform-login.js";
import type { Registry } from "../registry.js";

export async function identityTables(sql: RawAccess) {
	await sql.execute("CREATE TABLE IF NOT EXISTS legacy (uid TEXT PRIMARY KEY, email TEXT NOT NULL)");
	await sql.execute("CREATE INDEX IF NOT EXISTS legacy_email ON legacy (email)");
	await sql.execute("CREATE TABLE IF NOT EXISTS initialized (id INTEGER PRIMARY KEY)");
	await sql.execute("CREATE TABLE IF NOT EXISTS identity (provider TEXT, sub TEXT, uid TEXT NOT NULL UNIQUE, PRIMARY KEY(provider, sub))");
}

// The profile lives in each user actor. Snapshot those profiles once, before assigning any new uid.
async function indexLegacy(sql: RawAccess, client: ReturnType<typeof createClient<Registry>>) {
	if ((await sql.execute("SELECT id FROM initialized LIMIT 1")).length) return;
	await sql.execute("DELETE FROM legacy");
	const url = new URL(ownEngineEndpoint());
	const token = engineAdminToken() ?? (decodeURIComponent(url.password) || process.env.RIVET_TOKEN || "default");
	url.username = "";
	url.password = "";
	url.pathname = url.pathname.replace(/\/$/, "") + "/actors";
	url.searchParams.set("namespace", config.engine.namespace);
	url.searchParams.set("name", "user");
	do {
		const response = await fetch(url, { headers: { authorization: "Bearer " + token }, redirect: "error", signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error("Cannot read existing accounts (HTTP " + response.status + ")");
		const page = await response.json() as { actors: { key: string }[]; pagination: { cursor: string | null } };
		for (const { key } of page.actors) {
			if (!/^u_[A-Za-z0-9_-]{1,62}$/.test(key)) continue;
			let email: string | null;
			try {
				email = normalizeEmail(await client.user.get([key], { params: serviceParams() }).internalProfileEmail());
			} catch (error) {
				if (isActorGone(error)) continue;
				throw error;
			}
			if (email) await sql.execute("INSERT OR REPLACE INTO legacy (uid,email) VALUES (?,?)", key, email);
		}
		if (!page.pagination.cursor) break;
		url.searchParams.set("cursor", page.pagination.cursor);
	} while (true);
	await sql.execute("INSERT INTO initialized VALUES (1)");
}

export async function resolveIdentity(sql: RawAccess, { provider, sub, email }: Identity): Promise<string | null> {
	for (;;) {
		const [known] = await sql.execute<{ uid: string }>("SELECT uid FROM identity WHERE provider = ? AND sub = ?", provider, sub);
		if (known) return known.uid;
		const [legacy] = await sql.execute<{ uid: string }>(`SELECT MIN(uid) AS uid FROM legacy WHERE email = ?
			HAVING COUNT(*) = 1 AND MIN(uid) NOT IN (SELECT uid FROM identity)`, email);
		const uid = legacy?.uid ?? "u_" + randomUUID();
		if (!mayUse({ uid, email, demo: false }, config.access)) return null;
		const inserted = await sql.execute("INSERT INTO identity (provider,sub,uid) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING uid", provider, sub, uid);
		if (inserted.length) return uid;
		// Another login claimed either the identity or its legacy uid while we checked admission.
	}
}

export const accountIdentities = actor({
	onBeforeConnect: internalConnection,
	db: db({ onMigrate: identityTables }),
	createVars: () => ({ indexing: null as Promise<void> | null }),
	actions: {
		internalResolve: async (c, identity: Identity): Promise<string | null> => {
			requireServiceFor(c, "call");
			c.vars.indexing ??= indexLegacy(c.db, c.client() as ReturnType<typeof createClient<Registry>>).catch(error => {
				c.vars.indexing = null;
				throw error;
			});
			await c.vars.indexing;
			return resolveIdentity(c.db, identity);
		},
	},
});
