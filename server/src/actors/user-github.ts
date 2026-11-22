import type { RawAccess } from "rivetkit/db";
import type { GithubId } from "../contract.js";
import type { StoredConnection, StoredInstallation } from "../github/repos.js";
import { MAX_GITHUB_ACCOUNTS } from "../github/state.js";
import { updateGithubAccount } from "./github-account.js";

type Ctx = {
	db: RawAccess;
	vars: { github: StoredConnection | null; githubWriting: Promise<void> };
	client(): any;
};

export type InstallationChange =
	| { kind: "attach"; installation: StoredInstallation; senderId: GithubId | null }
	| { kind: "remove"; installationId: GithubId };

function queueGithub(c: Ctx, work: () => Promise<void>) {
	const run = c.vars.githubWriting.then(work);
	c.vars.githubWriting = run.catch(() => {});
	return run;
}

async function save(c: Ctx, uid: string, next: StoredConnection | null, refresh = false) {
	await updateGithubAccount(c, uid, c.vars.github, next, async () => {
		if (next) await c.db.execute("INSERT OR REPLACE INTO github (id, connection, updated_at) VALUES (1, ?, ?)", JSON.stringify(next), next.connectedAt);
		else await c.db.execute("DELETE FROM github");
		c.vars.github = next;
	}, refresh);
}

export function replaceGithubConnection(c: Ctx, uid: string, next: StoredConnection | null) {
	return queueGithub(c, () => save(c, uid, next));
}

export function syncGithubWebhooks(c: Ctx, uid: string) {
	return queueGithub(c, async () => {
		const current = c.vars.github;
		if (current?.webhookLinked) await updateGithubAccount(c, uid, current, current, undefined, true);
		else if (current) await save(c, uid, { ...current, webhookLinked: true });
	});
}

export function updateGithubInstallation(c: Ctx, uid: string, change: InstallationChange) {
	return queueGithub(c, async () => {
		// Directory lookups may race a disconnect or a connection to a different GitHub account.
		const current = c.vars.github;
		if (!current?.webhookLinked) return;
		let installations: StoredInstallation[];
		if (change.kind === "remove") {
			installations = current.installations.filter(i => i.id !== change.installationId);
			if (installations.length === current.installations.length) return;
		} else {
			const { installation, senderId } = change;
			const own = installation.account.type === "User" && installation.account.id === current.user.id;
			if (!own && current.user.id !== senderId) return;
			const index = current.installations.findIndex(i => i.id === installation.id);
			installations = [...current.installations];
			if (index >= 0) installations[index] = installation;
			else if (installations.length < MAX_GITHUB_ACCOUNTS) installations.push(installation);
			else return;
		}
		await save(c, uid, { ...current, installations, refreshedAt: Date.now() }, true);
	});
}
