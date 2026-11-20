/** One immutable uid per verified email. The actor key is SHA-256 of the normalized email. */
import { createHash } from "node:crypto";
import { actor } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import type { createClient } from "rivetkit/client";
import { normalizeEmail } from "../access.js";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import { config } from "../config.js";
import type { Registry } from "../registry.js";
import type { ChatgptAccount } from "../sandbox/api.js";
import { uidOfAccount } from "../signin/material.js";
import { isActorGone } from "./internal.js";

async function owner(db: RawAccess): Promise<string | null> {
	const [row] = await db.execute<{ uid: string }>("SELECT uid FROM owner WHERE id = 1");
	return row?.uid ?? null;
}

export const accountEmail = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (c.key.length !== 1 || !/^[0-9a-f]{64}$/.test(c.key[0])) c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), uid TEXT NOT NULL)");
	} }),
	actions: {
		internalClaim: async (c, candidate: string): Promise<string> => {
			requireServiceFor(c, "call");
			// Whoever inserts first wins. Even if a caller dies before the read, a retry returns that same uid.
			await c.db.execute("INSERT INTO owner (id, uid) VALUES (1, ?) ON CONFLICT (id) DO NOTHING", candidate);
			return (await owner(c.db))!;
		},
		internalOwner: async (c): Promise<string | null> => {
			requireServiceFor(c, "call");
			return owner(c.db);
		},
	},
});

type Context = { client(): unknown };

function directory(c: Context) {
	return (c.client() as ReturnType<typeof createClient<Registry>>).accountEmail;
}

const keyOf = (email: string) => [createHash("sha256").update(email).digest("hex")];

export async function claimAccountUid(c: Context, account: ChatgptAccount): Promise<string> {
	const email = normalizeEmail(account.email);
	if (email === null) return uidOfAccount(account.sub);
	const candidate = config.accountEmails.get(email) ?? uidOfAccount(account.sub);
	return directory(c).getOrCreate(keyOf(email), { params: serviceParams() }).internalClaim(candidate);
}

/** Adoption can consult an existing link, but only a finished login can establish it. */
export async function ownerOfAccount(c: Context, account: ChatgptAccount): Promise<string | null> {
	const email = normalizeEmail(account.email);
	if (email === null) return uidOfAccount(account.sub);
	// Without a link yet (a sign-in saved before the directory existed), the operator's seed for this email
	// decides, and otherwise the subject's own uid, as before the directory: neither can name another person.
	const unlinked = config.accountEmails.get(email) ?? uidOfAccount(account.sub);
	try {
		return (await directory(c).get(keyOf(email), { params: serviceParams() }).internalOwner()) ?? unlinked;
	} catch (error) {
		if (isActorGone(error)) return unlinked;
		throw error;
	}
}
