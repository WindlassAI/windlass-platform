import type { RawAccess } from "rivetkit/db";
import type { GithubId } from "../contract.js";
import { GithubError, type GithubApp } from "../github/app.js";
import { GithubProblem, problemOf, type StoredConnection } from "../github/repos.js";
import { MAX_GITHUB_ACCOUNTS, activeInstallations, openGithubGrant, sealGithubGrant } from "../github/state.js";
import { updateGithubAccount } from "./github-account.js";

type Ctx = {
	db: RawAccess;
	vars: { github: StoredConnection | null; githubWriting: Promise<void> };
	client(): any;
};
const COOLDOWN_MS = 60_000;
type Hint = { installationId: GithubId; accounts: GithubId[] };
const reconnect = () => new GithubProblem("github_denied", "Connect GitHub again in Settings to refresh your installations.");

function queueGithub(c: Ctx, work: () => Promise<void>) {
	const run = c.vars.githubWriting.then(work);
	c.vars.githubWriting = run.catch(() => {});
	return run;
}

async function storedGrant(c: Ctx) {
	const [row] = await c.db.execute<{ sealed: string | null; refresh_after: number; retry_at: number }>("SELECT sealed, refresh_after, retry_at FROM github_grant WHERE id = 1");
	return row;
}

/** Called under the user's GitHub queue so a refresh, token rotation and disconnect cannot cross. */
async function save(c: Ctx, uid: string, next: StoredConnection | null, grant?: { sealed?: string }) {
	await updateGithubAccount(c, uid, c.vars.github, next, async () => {
		await c.db.transaction(async tx => {
			if (next) await tx.execute("INSERT OR REPLACE INTO github VALUES (1, ?, ?)", JSON.stringify(next), next.connectedAt);
			else await tx.execute("DELETE FROM github");
			if (grant?.sealed) await tx.execute("INSERT OR REPLACE INTO github_grant (id, sealed) VALUES (1, ?)", grant.sealed);
			else if (grant) await tx.execute("DELETE FROM github_grant");
		});
		c.vars.github = next;
	}, grant === undefined && !!c.vars.github?.webhookLinked);
}

export function replaceGithubConnection(c: Ctx, uid: string, app: GithubApp, next: StoredConnection | null, sealed?: string) {
	return queueGithub(c, async () => {
		const previous = c.vars.github;
		const old = await storedGrant(c);
		const incoming = sealed && next ? openGithubGrant(uid, next.user.id, sealed) : null;
		await save(c, uid, next, { sealed });
		if (old?.sealed && previous) {
			// A damaged/retired key must not prevent a user from replacing or deleting a connection.
			try {
				const { accessToken } = openGithubGrant(uid, previous.user.id, old.sealed);
				if (accessToken !== incoming?.accessToken) await app.forgetUserToken(accessToken);
			} catch { console.warn("github.user_token.delete_failed"); }
		}
	});
}

export function syncGithubWebhooks(c: Ctx, uid: string) {
	return queueGithub(c, async () => {
		const current = c.vars.github;
		if (current?.webhookLinked) await updateGithubAccount(c, uid, current, current, undefined, true);
		else if (current) await save(c, uid, { ...current, webhookLinked: true });
	});
}

export function refreshGithubInstallations(c: Ctx, uid: string, app: GithubApp, hint?: Hint) {
	return queueGithub(c, async () => {
		const connection = c.vars.github;
		if (!connection) return;
		if (hint && !hint.accounts.includes(connection.user.id) && !connection.installations.some(i => i.id === hint.installationId)) return;
		const saved = await storedGrant(c);
		if (saved && !saved.sealed) {
			if (hint) return;
			throw reconnect();
		}
		if (saved && Date.now() < saved.retry_at) throw new GithubProblem("github_unreachable", "GitHub asked the platform to wait before trying again.");
		if (!hint) {
			if (!saved) throw reconnect();
			if (Date.now() < saved.refresh_after) return;
			await c.db.execute("UPDATE github_grant SET refresh_after = ? WHERE id = 1", Date.now() + COOLDOWN_MS);
		}

		let installations;
		try {
			if (saved?.sealed) {
				let grant = openGithubGrant(uid, connection.user.id, saved.sealed);
				if (grant.refreshToken && grant.expiresAt !== null && grant.expiresAt <= Date.now() + 60_000) {
					grant = await app.refreshUserGrant(grant.refreshToken);
					// GitHub invalidates the previous pair immediately. Save its replacement before listing.
					await c.db.execute("UPDATE github_grant SET sealed = ? WHERE id = 1", sealGithubGrant(uid, connection.user.id, grant));
				}
				installations = activeInstallations(await app.userInstallations(grant.accessToken));
			} else if (hint) {
				const verified = await app.verifiedInstallation(hint.installationId, connection.user);
				installations = connection.installations.filter(i => i.id !== hint.installationId);
				if (verified) installations.push(...activeInstallations([verified]));
				installations = installations.slice(0, MAX_GITHUB_ACCOUNTS);
			} else throw reconnect();
		} catch (error) {
			if (saved && error instanceof GithubError && error.rateLimited) {
				const delay = Number(error.headers.get("retry-after")) * 1000;
				const reset = Number(error.headers.get("x-ratelimit-reset")) * 1000;
				const retryAt = Math.max(Date.now() + (delay || COOLDOWN_MS), reset || 0);
				await c.db.execute("UPDATE github_grant SET retry_at = ? WHERE id = 1", retryAt);
			}
			if (saved && error instanceof GithubError && (error.status === 401 || error.status === 400 && /refresh token/i.test(error.said))) {
				await save(c, uid, { ...connection, installations: [], refreshedAt: Date.now() });
				// Keep the row to distinguish revoked consent from a pre-upgrade connection.
				await c.db.execute("UPDATE github_grant SET sealed = NULL WHERE id = 1");
				if (hint) return;
				throw reconnect();
			}
			throw problemOf(error, connection.user.login);
		}
		await save(c, uid, { ...connection, installations, refreshedAt: Date.now() });
	});
}
