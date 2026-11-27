import type { RawAccess } from "rivetkit/db";
import type { GithubId } from "../contract.js";
import type { StoredConnection, StoredInstallation } from "../github/repos.js";
import { MAX_GITHUB_ACCOUNTS } from "../github/state.js";
import { updateGithubAccount } from "./github-account.js";
import type { ActorClient } from "./internal.js";

type Ctx = {
	db: RawAccess;
	vars: { github: StoredConnection | null; githubWriting: Promise<void> };
	client(): ActorClient;
	schedule: { after(duration: number, action: string, ...args: unknown[]): Promise<string> };
};

export type InstallationChange =
	| { kind: "attach"; installation: StoredInstallation; senderId: GithubId | null }
	| { kind: "remove"; installationId: GithubId }
	/** Some of the installation's repositories were removed from it. */
	| { kind: "repositories"; installationId: GithubId };

/** A directory update that failed after the connection was saved is tried again on this schedule, then left
 * to the next wake. The checks shorten the delays. */
export const GITHUB_SYNC = {
	action: "internalRetryGithubSync" as const,
	delays: [15_000, 60_000, 4 * 60_000, 15 * 60_000, 60 * 60_000],
};
export const GITHUB_SYNC_TABLE =
	"CREATE TABLE IF NOT EXISTS github_sync (id INTEGER PRIMARY KEY CHECK (id = 1), job TEXT NOT NULL, attempt INTEGER NOT NULL)";

function queueGithub(c: Ctx, work: () => Promise<void>) {
	const run = c.vars.githubWriting.then(work);
	c.vars.githubWriting = run.catch(() => {});
	return run;
}

async function persist(c: Ctx, next: StoredConnection | null) {
	if (next)
		await c.db.execute(
			"INSERT OR REPLACE INTO github (id, connection, updated_at) VALUES (1, ?, ?)",
			JSON.stringify(next),
			next.connectedAt,
		);
	else await c.db.execute("DELETE FROM github");
	c.vars.github = next;
}

/** The directory refused installations removed since they were read. The connection lets them go too. */
async function prune(c: Ctx, uid: string, dropped: GithubId[]) {
	const current = c.vars.github;
	if (!dropped.length || !current) return;
	const gone = new Set(dropped.map(String));
	await persist(c, {
		...current,
		installations: current.installations.filter(i => !gone.has(String(i.id))),
		refreshedAt: Date.now(),
	});
	console.log(`github.installations.removed_since_read uid=${uid} installations=${dropped.join(",")}`);
}

/** Throws when nothing was saved. Returns false when the connection was saved and a directory update after it failed. */
async function commit(
	c: Ctx,
	uid: string,
	next: StoredConnection | null,
	refresh = false,
	readAt?: number,
): Promise<boolean> {
	let saved = false;
	try {
		const dropped = await updateGithubAccount(
			c,
			uid,
			c.vars.github,
			next,
			async () => {
				await persist(c, next);
				saved = true;
			},
			refresh,
			readAt,
		);
		await prune(c, uid, dropped);
		return true;
	} catch (error) {
		if (!saved) throw error;
		console.warn(`github.directories.update_failed uid=${uid}`);
		return false;
	}
}

/** Starts a retry series unless one is running. A running series reads the latest connection on each try. */
async function armGithubSync(c: Ctx) {
	if ((await c.db.execute("SELECT 1 FROM github_sync")).length) return;
	const job = await c.schedule.after(GITHUB_SYNC.delays[0]!, GITHUB_SYNC.action, 1);
	await c.db.execute("INSERT OR REPLACE INTO github_sync VALUES (1, ?, 1)", job);
}

async function save(c: Ctx, uid: string, next: StoredConnection | null, refresh = false, readAt?: number) {
	if (!(await commit(c, uid, next, refresh, readAt))) await armGithubSync(c);
}

/** `readAt` is when GitHub listed the new connection's installations. */
export function replaceGithubConnection(c: Ctx, uid: string, next: StoredConnection | null, readAt?: number) {
	return queueGithub(c, () => save(c, uid, next, false, readAt));
}

/** Writes the saved connection to the directories again. False when that failed. */
async function sync(c: Ctx, uid: string): Promise<boolean> {
	const current = c.vars.github;
	if (!current) return true;
	if (!current.webhookLinked) return commit(c, uid, { ...current, webhookLinked: true });
	try {
		await prune(c, uid, await updateGithubAccount(c, uid, current, current, undefined, true));
		return true;
	} catch {
		console.warn(`github.directories.update_failed uid=${uid}`);
		return false;
	}
}

export function syncGithubWebhooks(c: Ctx, uid: string) {
	return queueGithub(c, async () => {
		if (!(await sync(c, uid))) await armGithubSync(c);
	});
}

/** One scheduled try of a retry series. The next try is armed before this one runs, and the last gives up. */
export function retryGithubSync(c: Ctx, uid: string, job: string, attempt: number) {
	return queueGithub(c, async () => {
		const [row] = await c.db.execute<{ job: string }>("SELECT job FROM github_sync");
		if (row?.job !== job) return;
		const delay = GITHUB_SYNC.delays[attempt];
		const next = delay === undefined ? null : await c.schedule.after(delay, GITHUB_SYNC.action, attempt + 1);
		if (next) await c.db.execute("UPDATE github_sync SET job = ?, attempt = ?", next, attempt + 1);
		let done = false;
		try {
			done = await sync(c, uid);
		} catch {
			console.warn(`github.directories.update_failed uid=${uid}`);
		}
		if (done || !next) await c.db.execute("DELETE FROM github_sync");
		if (!done)
			console.warn(`github.directories.${next ? "retrying" : "retries_exhausted"} uid=${uid} attempt=${attempt}`);
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
		} else if (change.kind === "repositories") {
			// Keep the installation. The new refreshedAt discards every server's older list of its repositories.
			if (!current.installations.some(i => i.id === change.installationId)) return;
			installations = current.installations;
		} else {
			const { installation, senderId } = change;
			// Only the owner of a personal account gets its installation. An organization's goes to the sender.
			if (
				installation.account.type === "User"
					? installation.account.id !== current.user.id
					: current.user.id !== senderId
			)
				return;
			const index = current.installations.findIndex(i => i.id === installation.id);
			installations = [...current.installations];
			if (index >= 0) installations[index] = installation;
			else if (installations.length < MAX_GITHUB_ACCOUNTS) installations.push(installation);
			else return;
		}
		await save(c, uid, { ...current, installations, refreshedAt: Date.now() }, true);
	});
}
