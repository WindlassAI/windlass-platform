/** githubAccount[githubUserId]. Only a service action can populate, read or clear the link. */
import type { GithubId } from "../contract.js";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { githubIdKey } from "../github/events.js";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import type { StoredConnection } from "../github/repos.js";

type Link = { uid: string; login: string; installations: GithubId[]; at: number };

export const githubAccount = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (!githubIdKey(c.key)) c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS link (id INTEGER PRIMARY KEY CHECK (id = 1), uid TEXT NOT NULL, login TEXT NOT NULL, installations TEXT NOT NULL, at INTEGER NOT NULL)");
		await db.execute("CREATE TABLE IF NOT EXISTS connected_users (uid TEXT PRIMARY KEY)");
		await db.execute("INSERT OR IGNORE INTO connected_users SELECT uid FROM link");
	} }),
	actions: {
		internalLink: async (c, link: Link) => {
			requireServiceFor(c, "call");
			const old = await c.db.transaction(async tx => {
				await tx.execute("INSERT OR IGNORE INTO connected_users VALUES (?)", link.uid);
				const [old] = await tx.execute<{ uid: string }>("SELECT uid FROM link");
				await tx.execute("INSERT OR REPLACE INTO link VALUES (1, ?, ?, ?, ?)", link.uid, link.login, JSON.stringify(link.installations), link.at);
				return old?.uid;
			});
			if (old && old !== link.uid) console.log(`github.account.relinked github=${c.key[0]} from=${old} to=${link.uid}`);
		},
		internalRefresh: async (c, uid: string, ids: GithubId[]) => {
			requireServiceFor(c, "call");
			await c.db.transaction(async tx => {
				await tx.execute("INSERT OR IGNORE INTO connected_users VALUES (?)", uid);
				await tx.execute("UPDATE link SET installations = ? WHERE uid = ?", JSON.stringify(ids), uid);
			});
		},
		internalUnlink: async (c, uid: string) => {
			requireServiceFor(c, "call");
			await c.db.transaction(async tx => {
				await tx.execute("DELETE FROM connected_users WHERE uid = ?", uid);
				await tx.execute("DELETE FROM link WHERE uid = ?", uid);
			});
		},
		// Issue intake uses the latest link. Installation events reach every platform account connected to the same GitHub user.
		internalUsers: async (c): Promise<string[]> => {
			requireServiceFor(c, "call");
			return (await c.db.execute<{ uid: string }>("SELECT uid FROM connected_users")).map(r => r.uid);
		},
		internalWho: async (c): Promise<{ uid: string; installations: GithubId[] } | null> => {
			requireServiceFor(c, "call");
			const [row] = await c.db.execute<{ uid: string; installations: string }>("SELECT uid, installations FROM link");
			return row ? { uid: row.uid, installations: JSON.parse(row.installations) } : null;
		},
	},
});

export async function setGithubInstallations(c: { client(): any }, uid: string, ids: GithubId[]) {
	await c.client().githubHooks.getOrCreate(["app"], { params: serviceParams() }).internalSetInstallations(uid, ids);
}

/** Revoke removed installations before committing the user's change and admit new ones only after.
 * An interrupted grant is repaired from the saved connection on wake. */
export async function updateGithubAccount(c: { client(): any }, uid: string, previous: StoredConnection | null, next: StoredConnection | null, save?: () => Promise<void>, refresh = false) {
	const ids = next?.webhookLinked ? next.installations.map(i => i.id) : [];
	if (previous?.webhookLinked) {
		const retained = previous.installations.filter(i => ids.includes(i.id));
		if (retained.length !== previous.installations.length || !next?.webhookLinked)
			await setGithubInstallations(c, uid, retained.map(i => i.id));
	}
	await save?.();
	if (next?.webhookLinked) await setGithubInstallations(c, uid, ids);
	const account = (id: GithubId) => c.client().githubAccount.getOrCreate([String(id)], { params: serviceParams() });
	if (previous?.webhookLinked && (!next?.webhookLinked || previous.user.id !== next.user.id)) {
		try { await account(previous.user.id).internalUnlink(uid); }
		catch { console.warn(`github.account.unlink_failed github=${previous.user.id} uid=${uid}`); }
	}
	if (next?.webhookLinked) {
		try {
			if (refresh) await account(next.user.id).internalRefresh(uid, ids);
			else await account(next.user.id).internalLink({ uid, login: next.user.login, installations: ids, at: next.connectedAt } satisfies Link);
		} catch (error) {
			if (refresh) throw error;
			console.warn(`github.account.link_failed github=${next.user.id} uid=${uid}`);
		}
	}
}
