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
export async function updateGithubAccount(c: { client(): any }, uid: string, previous: StoredConnection | null, next: StoredConnection | null, save?: () => Promise<void>) {
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
			await account(next.user.id).internalLink({ uid, login: next.user.login, installations: ids, at: next.connectedAt } satisfies Link);
		} catch { console.warn(`github.account.link_failed github=${next.user.id} uid=${uid}`); }
	}
}
