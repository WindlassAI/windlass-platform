/** githubAccount[githubUserId]. Only a service action can populate, read or clear the link. */
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { requireServiceFor, serviceParams } from "../auth.js";
import type { StoredConnection } from "../github/repos.js";

// A deployment that has never enabled webhooks performs no directory calls. The marker lives
// with the connection so disabling webhooks can still remove a link previously written.
type DirectoryConnection = StoredConnection & { webhookLinked?: boolean };

type Link = { uid: string; login: string; installations: number[]; at: number };

export const githubAccount = actor({
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS link (id INTEGER PRIMARY KEY CHECK (id = 1), uid TEXT NOT NULL, login TEXT NOT NULL, installations TEXT NOT NULL, at INTEGER NOT NULL)");
	} }),
	actions: {
		internalLink: async (c, link: Link) => {
			requireServiceFor(c, "call");
			const old = await c.db.transaction(async tx => {
				const [old] = await tx.execute<{ uid: string }>("SELECT uid FROM link");
				await tx.execute("INSERT OR REPLACE INTO link VALUES (1, ?, ?, ?, ?)", link.uid, link.login, JSON.stringify(link.installations), link.at);
				return old?.uid;
			});
			if (old && old !== link.uid) console.log(`github.account.relinked github=${c.key[0]} from=${old} to=${link.uid}`);
		},
		internalUnlink: async (c, uid: string) => {
			requireServiceFor(c, "call");
			await c.db.execute("DELETE FROM link WHERE uid = ?", uid);
		},
		internalWho: async (c): Promise<{ uid: string; installations: number[] } | null> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ uid: string; installations: string }>("SELECT uid, installations FROM link");
			return row ? { uid: row.uid, installations: JSON.parse(row.installations) } : null;
		},
	},
});

/** The next connect repairs a missed link. Directory availability never fails the ticket flow. */
export async function updateGithubAccount(c: { client(): any }, uid: string, previous: DirectoryConnection | null, next: DirectoryConnection | null) {
	const account = (id: number) => c.client().githubAccount.getOrCreate([String(id)], { params: serviceParams() });
	if (previous?.webhookLinked && (!next?.webhookLinked || previous.user.id !== next.user.id)) {
		try { await account(previous.user.id).internalUnlink(uid); }
		catch { console.warn(`github.account.unlink_failed github=${previous.user.id} uid=${uid}`); }
	}
	if (next?.webhookLinked) {
		try {
			await account(next.user.id).internalLink({ uid, login: next.user.login, installations: next.installations.map(i => i.id), at: next.connectedAt } satisfies Link);
		} catch { console.warn(`github.account.link_failed github=${next.user.id} uid=${uid}`); }
	}
}
