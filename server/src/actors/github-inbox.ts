/** githubInbox[installationId] and githubHooks["app"]. Only service actions write or read rows.
 * A scheduled action must be fired by the engine. An empty actor has no work and arms no timer.
 */
import { recentSubject } from "../factory/intake.js";
import { cleanFeedback } from "../factory/feedback.js";
import type { InstallationChange } from "./user-github.js";
import type { GithubUser } from "../github/app.js";
import type { FeedbackEntry, GithubId } from "../contract.js";
import { decimalId, githubId } from "../github/ids.js";
import { actor } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { internalConnection, requireServiceFor, serviceParams } from "../auth.js";
import { githubConfig } from "../config.js";
import { githubApp, GithubError } from "../github/app.js";
import { isAddressed, githubIdKey, type Delivery } from "../github/events.js";

// https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
// Redeliveries have "the same" delivery GUID. This is the inbox primary key.
// https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
// "GitHub does not automatically redeliver failed deliveries." Requests are available for three days.
const DAY = 86_400_000;
const SWEEP = 10 * 60_000;
const FIRST_RETRY = 15_000;
/** Servers' clocks may differ this much. A removal this close to a list's read is taken as later. */
const CLOCK_SKEW = 60_000;
/** Inbox rows are kept seven days, so no older event can be retried against an installation's state. */
const STATE_KEPT = 7 * DAY;
type Vars = { writing: Promise<unknown>; draining: boolean; drainAgain: boolean };
type Ctx = {
	key: string[]; db: RawAccess; vars: Vars; client(): any;
	keepAwake<T>(work: Promise<T>): Promise<T>;
	schedule: { at(time: number, action: string): Promise<string>; cancel(id: string): Promise<boolean> };
};
const vars = (): Vars => ({ writing: Promise.resolve(), draining: false, drainAgain: false });
function queued<T>(c: Ctx, work: () => Promise<T>): Promise<T> {
	const run = c.vars.writing.then(work);
	c.vars.writing = run.catch(() => undefined);
	return run;
}

// Called under the actor's write queue. Make the replacement durable before cancelling its predecessor.
async function arm(c: Ctx, at: number | null, action: string) {
	const [old] = await c.db.execute<{ id: string; at: number }>("SELECT id, at FROM timer");
	if (at === null) {
		if (!old) return;
		await c.db.execute("DELETE FROM timer");
	} else {
		if (old?.at === at && at > Date.now()) return;
		const id = await c.schedule.at(Math.max(Date.now(), at), action);
		await c.db.execute("INSERT OR REPLACE INTO timer VALUES (1, ?, ?)", id, at);
	}
	if (old) await c.schedule.cancel(old.id).catch(() => false);
}
const TIMER = "CREATE TABLE IF NOT EXISTS timer (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, at INTEGER NOT NULL)";

async function refreshInstallation(d: Delivery, c: Ctx) {
	console.log(`github.installation event=${d.event}.${d.action} installation=${d.installationId} delivery=${d.guid}`);
	if (d.event !== "installation" && d.event !== "installation_repositories") return;
	const params = { params: serviceParams() };
	const hooks = c.client().githubHooks.getOrCreate(["app"], params);
	let change: InstallationChange;
	let users: Set<string>;
	if (d.event === "installation" && ["suspend", "deleted"].includes(d.action)) {
		// A missed suspension redelivered after its unsuspend would be received last. GitHub's current state decides.
		const app = d.action === "suspend" ? githubApp() : null;
		if (app && await app.activeInstallation(d.installationId)) {
			await hooks.internalInstallationActive(d.installationId, d.at);
			return;
		}
		change = { kind: "remove", installationId: d.installationId };
		// One write records the removal and reads the linked users, so a connection linked after it is refused.
		users = new Set(await hooks.internalInstallationRemoved(d.installationId, d.at));
	} else if (d.event === "installation_repositories" && d.action === "removed") {
		// Only the listed repositories left. The installation stays, and the next read lists what is left.
		change = { kind: "repositories", installationId: d.installationId };
		users = new Set(await hooks.internalInstallationUsers(d.installationId));
	} else {
		const attach = d.event === "installation" ? ["created", "new_permissions_accepted", "unsuspend"].includes(d.action) : d.action === "added";
		if (!attach) return;
		const app = githubApp();
		if (!app) throw new Error("GitHub App unavailable.");
		const installation = await app.activeInstallation(d.installationId);
		if (!installation) return;
		await hooks.internalInstallationActive(d.installationId, d.at);
		const { id, account, htmlUrl } = installation;
		const senderId = d.data.senderId ?? null;
		change = { kind: "attach", installation: { id, account, htmlUrl }, senderId };
		users = new Set();
		// A personal account's installation belongs to that account's owner, whoever sent the event.
		const candidate = account.type === "User" ? account.id : senderId;
		if (candidate !== null) {
			try {
				const connected: string[] = await c.client().githubAccount.get([String(candidate)], params).internalUsers();
				for (const uid of connected) users.add(uid);
			} catch (error) { if (!missingActor(error)) throw error; }
		}
	}
	// Each actor checks its current connection again, in case it was replaced since the lookup.
	let retry = false;
	for (const uid of users) {
		try { await c.client().user.get([uid], params).internalUpdateGithubInstallation(change); }
		catch (error) { if (!missingActor(error)) retry = true; }
	}
	if (retry) throw new Error("An installation refresh could not finish");
}
function missingActor(error: unknown): boolean {
	const e = error as { group?: string; code?: string } | null;
	return e?.group === "actor" && e.code === "not_found";
}

/**
 * The repository's default branch moved (a push, or a pull request merged into it): each user whose prepared
 * environments of it are watched builds again once the pushes settle (user-environments.ts `pushed`). Never throws:
 * a build is no reason to retry the delivery.
 */
async function environmentPush(d: Delivery, c: Ctx): Promise<"no item" | void> {
	if (!d.repositoryId || !(d.event === "push" || (d.event === "pull_request" && d.data.toDefault))) return "no item";
	const params = { params: serviceParams() };
	let users: string[] = [];
	try { users = await c.client().githubRepository.get([String(d.repositoryId)], params).internalEnvironmentUsers(); }
	catch { return "no item"; }
	for (const uid of users) await c.client().user.get([uid], params).internalEnvironmentPushed(d.repositoryId).catch(() => undefined);
	if (!users.length) return "no item";
}

async function nudgeItems(d: Delivery, c: Ctx): Promise<"no item" | void> {
	if (!d.repositoryId || !(d.event === "check_run" || d.event === "check_suite" || d.event === "status" || d.event === "pull_request")) return "no item";
	const subject = d.event === "pull_request" ? { kind: "pr" as const, pr: d.data.pr } : { kind: "ci" as const, head: d.data.head };
	const directory = c.client().githubRepository.get([String(d.repositoryId)], { params: serviceParams() });
	let matches: { uid: string; itemId: string }[];
	try {
		matches = await directory.internalFind({ ...subject, installationId: d.installationId });
	} catch (error) {
		if (missingActor(error)) return "no item";
		throw error;
	}
	let waiting = false;
	let retry = false;
	for (const { uid, itemId } of matches) {
		const item = c.client().workItem.get([uid, itemId], { params: serviceParams() });
		try {
			const binding = { repositoryId: d.repositoryId, installationId: d.installationId };
			const woke = d.event === "check_run" && d.action === "rerequested"
				? await item.internalReverify({ ...binding, head: d.data.head })
				: await item.internalGithubNudge({ ...subject, ...binding });
			if (woke) waiting = true;
		} catch (error) {
			if (missingActor(error) || (error as { code?: string })?.code === "item_not_found") await directory.internalForget(itemId);
			else retry = true;
		}
	}
	if (retry) throw new Error("A work item could not be reached");
	if (!waiting) return "no item";
}
export type FeedbackSubject = {
	kind: "review" | "review_comment" | "issue_comment"; id: string; sender: GithubUser; association: string;
};
export type FeedbackNotice = { installationId: GithubId; repositoryId: GithubId; pr: number; entries: FeedbackEntry[]; denied?: string; approval?: { id: string; author: string } };
export const feedbackId = (subject: FeedbackSubject) => subject.kind + ":" + subject.id;

/**
 * Both webhook and poll go through this preflight and authoritative subject read. Who may send the item
 * back is decided as issue intake decides it: someone GitHub says may write to the repository (the
 * collaborator permission API, with the App's token); the item's own person (their linked account) is
 * told apart from others with write access.
 * `author_association` decides nothing: GitHub reckons it for the reader, and to an App a private
 * organisation member, the organisation's owner among them, can read as CONTRIBUTOR or NONE.
 */
export async function readFeedback(c: Pick<Ctx, "client">, uid: string, target: Pick<FeedbackNotice, "installationId" | "repositoryId" | "pr">, subject: FeedbackSubject, pollingOwner?: GithubId): Promise<FeedbackNotice | null> {
	const { repositoryId, installationId, pr } = target;
	const denied = { ...target, entries: [], denied: feedbackId(subject) };
	const params = { params: serviceParams() };
	// Without webhooks there is no account directory. The poll has already resolved
	// this item's own connection against its bound installation and repository.
	let owner = pollingOwner === subject.sender.id;
	if (pollingOwner === undefined) {
		try {
			const link = await c.client().githubAccount.get([String(subject.sender.id)], params).internalWho();
			owner = link?.uid === uid && link.installations.includes(installationId);
		} catch (e) { if (!missingActor(e)) throw e; }
	}
	// The item's person needs write access too, as issue intake asks of them: an owner GitHub has since shut out sends nothing back.
	if (await c.client().githubRepository.get([String(repositoryId)], params).internalIssuePermission(installationId, subject.sender) !== "write") return denied;
	const app = githubApp();
	if (!app) throw new Error("GitHub App unavailable.");
	try {
		return await app.withToken(installationId, { repositoryId, permissions: { metadata: "read", pull_requests: "read" } }, async token => {
			const repo = await app.repositoryById(token, repositoryId);
			if (repo.id !== repositoryId) return null;
			const entry = (kind: FeedbackEntry["kind"], id: string, body: string, at: number, url: string, author: string): FeedbackEntry => ({
				id, author, access: owner ? "owner" : "write", kind, body: cleanFeedback(body).slice(0, 16000), at, url, commit: null, path: null, line: null,
			});
			const valid = (r: { author: GithubUser; at: number }) => r.author.id === subject.sender.id && recentSubject(r.at);
			if (subject.kind === "issue_comment") {
				const r = await app.issueCommand(token, repo, pr, subject.id);
				if (!r || !valid(r)) return null;
				const note = isAddressed(r.body, app.settings.slug);
				if (note === null) return null;
				const url = app.repositoryUrl(repo.owner, repo.name) + "/pull/" + pr + "#issuecomment-" + subject.id;
				return { ...target, entries: [entry("issue_comment", feedbackId(subject), note, r.at, url, r.author.login)] };
			}
			const review = subject.kind === "review";
			const r = review ? await app.review(token, repo, pr, subject.id) : await app.reviewComment(token, repo, pr, subject.id);
			if (!r || !valid(r)) return null;
			if (review && r.state === "approved") return { ...target, entries: [], approval: { id: feedbackId(subject), author: r.author.login } };
			const requested = review && r.state === "changes_requested";
			if (review && !requested && r.state !== "commented") return null;
			const body = requested ? r.body : isAddressed(r.body, app.settings.slug);
			if (body === null) return null;
			const entries = [{ ...entry(review ? requested ? "changes_requested" : "commented" : "review_comment", feedbackId(subject), body, r.at, r.url, r.author.login), commit: r.commit, path: r.path, line: r.line }];
			if (review) for (const line of await app.reviewComments(token, repo, pr, r.id)) {
				if (!valid(line)) continue;
				entries.push({ ...entry("review_comment", "review_comment:" + line.id, line.body, line.at, line.url, line.author.login), commit: line.commit, path: line.path, line: line.line });
			}
			return { ...target, entries };
		});
	} catch (e) {
		if (e instanceof GithubError && [404, 410].includes(e.status)) return null;
		throw e;
	}
}

/** Separate, durable acknowledgements: retrying a POST never re-admits a prompt.
 * GitHub deduplicates a user's identical reactions; a reply marker also covers a
 * lost POST response or a process stop before the local receipt was committed. */
async function feedbackEffect(c: Ctx, target: Pick<FeedbackNotice, "installationId" | "repositoryId" | "pr">, subject: string, kind: "eyes" | "reply") {
	const key = JSON.stringify([target.repositoryId, target.pr, subject, kind]);
	const [done] = await c.db.execute("SELECT 1 FROM feedback_effects WHERE key=?", key);
	if (done) return;
	const [count] = await c.db.execute<{ n: number }>("SELECT count(*) AS n FROM feedback_effects");
	if (count.n >= 20_000) throw new Error("Feedback acknowledgement capacity reached.");
	const app = githubApp();
	if (!app) throw new Error("GitHub App unavailable.");
	const [resource, id] = subject.split(":") as ["issue_comment" | "review_comment", string];
	await app.withToken(target.installationId, { repositoryId: target.repositoryId, permissions: { metadata: "read", ...(kind === "reply" ? { pull_requests: "read" as const } : {}), [kind === "reply" || resource === "issue_comment" ? "issues" : "pull_requests"]: "write" } }, async token => {
		const repo = await app.repositoryById(token, target.repositoryId);
		if (repo.id !== target.repositoryId) throw new Error("Wrong acknowledgement repository.");
		if (kind === "eyes") {
			try { await app.react(token, repo, { kind: resource, id }, "eyes"); }
			catch (error) { if (!(error instanceof GithubError && [404, 410].includes(error.status))) throw error; }
		} else {
			// A webhook's isPullRequest flag is only a routing hint, not proof that
			// this issue thread is a PR. Never explain session routing on an issue.
			try { await app.pull(token, repo.owner, repo.name, target.pr); }
			catch (error) { if (error instanceof GithubError && [404, 410].includes(error.status)) return; throw error; }
			const marker = "<!-- windlass:unmatched-pr -->";
			const comments = await app.issueComments(token, repo.owner, repo.name, target.pr, true);
			if (!comments.some(comment => comment.author === app.settings.slug + "[bot]" && comment.body.includes(marker))) await app.createIssueComment(token, repo.owner, repo.name, target.pr,
				"No Windlass session or work item is associated with this pull request. " + marker, "explain unmatched pull request feedback");
		}
	});
	await c.db.execute("INSERT OR IGNORE INTO feedback_effects VALUES (?, ?)", key, Date.now());
}

async function prFeedback(d: Delivery, c: Ctx): Promise<"no item" | void> {
	if (!d.repositoryId || (d.event !== "pull_request_review" && d.event !== "pull_request_review_comment" && d.event !== "issue_comment")) return "no item";
	const data = d.data;
	const target = { installationId: d.installationId, repositoryId: d.repositoryId, pr: "pr" in data ? data.pr : data.issue };
	const subject: FeedbackSubject = { sender: data.sender, association: data.sender.association,
		kind: "reviewId" in data ? "review" : "pr" in data ? "review_comment" : "issue_comment", id: "reviewId" in data ? data.reviewId : data.commentId };
	const params = { params: serviceParams() };
	const receipt = JSON.stringify([target.repositoryId, target.pr, feedbackId(subject)]);
	const [taken] = await c.db.execute<{ entries: string }>("SELECT entries FROM feedback_taken WHERE key=?", receipt);
	if (taken) {
		for (const id of JSON.parse(taken.entries) as string[]) await feedbackEffect(c, target, id, "eyes");
		return;
	}
	// Creating an empty directory is safe: absence is not a failed lookup. All other
	// directory/actor failures remain retryable and must never become an unmatched reply.
	const directory = c.client().githubRepository.getOrCreate([String(d.repositoryId)], params);
	const matches = await directory.internalFind({ pr: target.pr, installationId: d.installationId });
	let itemOwned = false;
	for (const { itemId, uid } of matches) {
		try {
			const notice = await readFeedback(c, uid, target, subject);
			if (notice) await c.client().workItem.get([uid, itemId], params).internalGithubFeedback(notice);
			itemOwned = true;
		} catch (error) {
			if (!missingActor(error) && (error as { code?: string })?.code !== "item_not_found") throw error;
			await directory.internalForget(itemId);
		}
	}
	// Item feedback keeps its own batching and acknowledgements. Never also send it
	// to a personal turn, even if an obsolete competing registration exists.
	if (itemOwned) return;
	const sessions = await directory.internalFindSession({ installationId: d.installationId, pr: target.pr });
	for (const { sessionId, uid } of sessions) {
		const notice = await readFeedback(c, uid, target, subject);
		if (!notice || !notice.entries.length) return;
		const [count] = await c.db.execute<{ n: number }>("SELECT count(*) AS n FROM feedback_taken");
		if (count.n >= 20_000) throw new Error("Feedback receipt capacity reached.");
		let taken = false;
		try { taken = await c.client().agentSession.get([uid, sessionId], params).internalGithubFeedback(notice); }
		catch (error) { if (!missingActor(error)) throw error; }
		if (!taken) { await directory.internalForgetSession(sessionId); continue; }
		const comments = notice.entries.filter(entry => entry.kind === "issue_comment" || entry.kind === "review_comment").map(entry => entry.id);
		await c.db.execute("INSERT OR IGNORE INTO feedback_taken VALUES (?, ?, ?)", receipt, JSON.stringify(comments), Date.now());
		for (const id of comments) await feedbackEffect(c, target, id, "eyes");
		return;
	}
	const notice = await readFeedback(c, "", target, subject);
	if (!notice?.entries.length) return "no item";
	await feedbackEffect(c, target, "unmatched", "reply");
}

async function issueDelivery(d: Delivery, c: Ctx): Promise<"no item" | void> {
	if (!d.repositoryId || (d.event !== "issues" && d.event !== "issue_comment")) return "no item";
	const { sender, issue } = d.data;
	const params = { params: serviceParams() };
	if (d.event === "issue_comment" || d.action === "labeled") {
		// Who may file is decided by the sender's linked account and GitHub's permission (github-intake.ts), never by `author_association`.
		if (d.event === "issue_comment" && d.data.isPullRequest) return "no item";
		let link;
		try { link = await c.client().githubAccount.get([String(sender.id)], params).internalWho(); }
		catch (error) { if (!missingActor(error)) throw error; }
		if (!link?.installations.includes(d.installationId)) {
			console.log(`github.intake.unlinked installation=${d.installationId} delivery=${d.guid}`);
			return "no item";
		}
		await c.client().user.get([link.uid], params).internalGithubIntake({ installationId: d.installationId, repositoryId: d.repositoryId, issue, senderId: sender.id,
			...(d.event === "issue_comment" ? { via: "mention", commentId: d.data.commentId } : { via: "label", label: d.data.label }) });
		return;
	}
	if (d.action === "reopened") return "no item";
	const directory = c.client().githubRepository.get([String(d.repositoryId)], params);
	try {
		const matches = await directory.internalFind({ issue, installationId: d.installationId });
		for (const { uid, itemId } of matches) await c.client().workItem.get([uid, itemId], params).internalGithubIssue({
			installationId: d.installationId, repositoryId: d.repositoryId, issue, action: d.action, senderId: sender.id });
		if (!matches.length) return "no item";
	} catch (error) { if (missingActor(error)) return "no item"; throw error; }
}
export const HANDLERS: Partial<Record<Delivery["event"], (delivery: Delivery, c: Ctx) => void | Promise<void | "no item">>> = {
	issues: issueDelivery,
	issue_comment: (d, c) => d.event === "issue_comment" && d.data.isPullRequest ? prFeedback(d, c) : issueDelivery(d, c),
	pull_request_review: prFeedback,
	pull_request_review_comment: prFeedback,
	check_run: nudgeItems,
	check_suite: nudgeItems,
	status: nudgeItems,
	pull_request: async (d, c) => { await environmentPush(d, c); return nudgeItems(d, c); },
	push: environmentPush,
	installation: refreshInstallation,
	installation_repositories: refreshInstallation,
};

type Row = { guid: string; event: Delivery["event"]; action: string; repository: string | null; data: string; received_at: number; attempts: number };

async function armInbox(c: Ctx) {
	const [row] = await c.db.execute<{ at: number | null }>(`SELECT min(at) AS at FROM (
		SELECT min(received_at) + ? AS at FROM deliveries UNION ALL
		SELECT min(next_at) FROM deliveries WHERE state = 'received' UNION ALL
		SELECT next_at FROM hook_start WHERE started = 0)`, 7 * DAY);
	const due = row?.at;
	// Due work is already being drained. Leave a watchdog if the node stops during a handler.
	await arm(c, due == null ? null : due <= Date.now() ? Date.now() + FIRST_RETRY : due, "internalDue");
}

async function drainDue(c: Ctx) {
	await c.db.execute("DELETE FROM feedback_effects WHERE at <= ?", Date.now() - 7 * DAY);
	await c.db.execute("DELETE FROM feedback_taken WHERE at <= ?", Date.now() - 7 * DAY);
	await queued(c, () => c.db.execute("DELETE FROM deliveries WHERE received_at <= ?", Date.now() - 7 * DAY));
	// Retry the singleton handoff after an engine outage, even if no further delivery arrives.
	const [start] = await c.db.execute("SELECT 1 FROM hook_start WHERE started = 0 AND next_at <= ?", Date.now());
	if (start && githubConfig().webhook) {
		try {
			await c.client().githubHooks.getOrCreate(["app"], { params: serviceParams() }).internalStart();
			await queued(c, () => c.db.execute("UPDATE hook_start SET started = 1"));
		} catch {
			await queued(c, () => c.db.execute("UPDATE hook_start SET next_at = ?", Date.now() + FIRST_RETRY));
		}
	} else if (start) {
		await queued(c, () => c.db.execute("UPDATE hook_start SET next_at = ?", Date.now() + SWEEP));
	}
	while (true) {
		const [row] = await c.db.execute<Row>("SELECT guid, event, action, CAST(repository AS TEXT) AS repository, data, received_at, attempts FROM deliveries WHERE state = 'received' AND next_at <= ? ORDER BY received_at, rowid LIMIT 1", Date.now());
		if (!row) break;
		const attempts = row.attempts + 1;
		let state = "done", said = "", next = 0;
		try {
			const handler = HANDLERS[row.event];
			if (handler) {
				// Older inbox rows have safe numeric comment and review IDs.
				const data = JSON.parse(row.data, (key, value) => key === "commentId" || key === "reviewId" ? decimalId(value) : value);
				const ignored = await handler({ guid: row.guid, event: row.event, action: row.action, installationId: githubId(c.key[0])!, repositoryId: githubId(row.repository), data, at: row.received_at }, c);
				if (ignored) { state = "ignored"; said = ignored; }
			} else { state = "ignored"; said = "no handler yet"; }
		} catch {
			said = "handler failed"; // thrown errors can contain delivery text
			state = attempts >= 8 ? "failed" : "received";
			next = Date.now() + Math.min(30 * 60_000, FIRST_RETRY * 2 ** (attempts - 1));
		}
		await queued(c, () => c.db.execute("UPDATE deliveries SET state = ?, said = ?, next_at = ?, attempts = ? WHERE guid = ?", state, said, next, attempts, row.guid));
		if (state === "ignored") console.log(`github.delivery.ignored(${said}) event=${row.event} installation=${c.key[0]} delivery=${row.guid}`);
		if (state === "failed") console.warn(`github.delivery.failed event=${row.event} installation=${c.key[0]} delivery=${row.guid}`);
	}
}

async function drain(c: Ctx) {
	if (c.vars.draining) {
		c.vars.drainAgain = true;
		return;
	}
	c.vars.draining = true;
	try {
		// A receive can finish while the wake pass is inspecting an empty inbox.
		do {
			c.vars.drainAgain = false;
			await drainDue(c);
		} while (c.vars.drainAgain);
	} finally {
		c.vars.draining = false;
		await queued(c, () => armInbox(c));
	}
}

function runDrain(c: Ctx) {
	void c.keepAwake(drain(c).catch(() => console.warn("github.inbox.drain_failed")));
}

export const githubInbox = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (!githubIdKey(c.key)) c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS deliveries (guid TEXT PRIMARY KEY, event TEXT NOT NULL, action TEXT NOT NULL, repository INTEGER, data TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, said TEXT NOT NULL)");
		await db.execute("CREATE INDEX IF NOT EXISTS delivery_due ON deliveries(state, next_at)");
		await db.execute("CREATE INDEX IF NOT EXISTS delivery_age ON deliveries(received_at)");
		await db.execute(TIMER);
		await db.execute("CREATE TABLE IF NOT EXISTS feedback_effects (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
		await db.execute("CREATE TABLE IF NOT EXISTS feedback_taken (key TEXT PRIMARY KEY, entries TEXT NOT NULL, at INTEGER NOT NULL)");
		await db.execute("CREATE TABLE IF NOT EXISTS hook_start (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), started INTEGER NOT NULL, next_at INTEGER NOT NULL)");
	} }),
	createVars: vars,
	onWake: runDrain,
	actions: {
		internalReceive: async (c, d: Delivery): Promise<"stored" | "duplicate" | "busy"> => {
			requireServiceFor(c, "call");
			if (String(d.installationId) !== c.key[0] || c.key.length !== 1) throw new Error("Wrong installation inbox.");
			const result = await queued(c, async () => {
				const result = await c.db.transaction(async tx => {
					await tx.execute("DELETE FROM deliveries WHERE received_at <= ?", Date.now() - 7 * DAY);
					if ((await tx.execute("SELECT 1 FROM deliveries WHERE guid = ?", d.guid)).length) return "duplicate";
					const [count] = await tx.execute<{ waiting: number; total: number }>("SELECT count(*) AS total, count(CASE WHEN state = 'received' THEN 1 END) AS waiting FROM deliveries");
					if (count.waiting >= 2_000) return "busy";
					if (count.total >= 20_000) {
						// Preserve waiting work. Prefer reclaiming a completed/ignored row to a failed row.
						await tx.execute("DELETE FROM deliveries WHERE rowid = (SELECT rowid FROM deliveries WHERE state <> 'received' ORDER BY (state = 'failed'), received_at, rowid LIMIT 1)");
					}
					const rows = await tx.execute("INSERT OR IGNORE INTO deliveries VALUES (?, ?, ?, ?, ?, ?, 'received', 0, ?, '') RETURNING guid",
						d.guid, d.event, d.action, d.repositoryId, JSON.stringify(d.data), d.at, d.at);
					await tx.execute("INSERT OR IGNORE INTO hook_start VALUES (1, 0, 0)");
					return rows.length ? "stored" : "duplicate";
				});
				// A wake is durable before acknowledging. A duplicate also repairs a lost schedule.
				if (result !== "busy") await armInbox(c);
				return result;
			});
			if (result === "stored") console.log(`github.delivery.stored event=${d.event}${d.action ? "." + d.action : ""} installation=${d.installationId} delivery=${d.guid}`);
			if (result !== "busy") runDrain(c);
			return result;
		},
		internalKnows: async (c, guid: string) => {
			requireServiceFor(c, "call");
			return (await c.db.execute("SELECT 1 FROM deliveries WHERE guid = ? AND received_at > ?", guid, Date.now() - 7 * DAY)).length !== 0;
		},
		internalDue: async c => {
			if (!c.scheduledFire) requireServiceFor(c, "call");
			await queued(c, () => armInbox(c));
			await drain(c);
		},
	},
});

async function linked(db: RawAccess, installation: GithubId) {
	return (await db.execute("SELECT 1 FROM installation_links WHERE installation = ? LIMIT 1", installation)).length > 0;
}

async function sweep(c: Ctx) {
	const app = githubApp();
	if (!app || !githubConfig().webhook) return;
	const [window] = await c.db.execute<{ last_at: number; started_at: number; cursor: string | null }>("SELECT last_at, started_at, cursor FROM sweeps");
	if (!window) return;
	const now = Date.now();
	const started = window.started_at || now;
	const since = Math.max(window.last_at - 60_000, now - 3 * DAY);
	await c.db.execute("DELETE FROM redelivered WHERE at <= ?", now - 4 * DAY);
	await c.db.execute("DELETE FROM pending_redelivery WHERE at <= ?", now - 3 * DAY);
	let cursor = window.cursor ?? undefined;
	for (let page = 0; page < 3; page++) {
		const batch = await app.hookDeliveries({ cursor, status: "failure" });
		const inWindow = batch.deliveries.filter(d => d.at >= since);
		const next = inWindow.length === batch.deliveries.length ? batch.cursor : null;
		// Advance the cursor with the durable candidates. A full installation cannot pin the scan
		// to its own page, and excess work survives a restart between ten-minute ticks.
		await c.db.transaction(async tx => {
			await tx.execute(`INSERT OR IGNORE INTO pending_redelivery (guid, delivery, installation, at)
				SELECT d.value ->> 'guid', d.value ->> 'id', d.value ->> 'installationId', d.value ->> 'at'
				FROM json_each(?) d
				WHERE EXISTS (SELECT 1 FROM installation_links WHERE installation = d.value ->> 'installationId')
				AND NOT EXISTS (SELECT 1 FROM redelivered WHERE guid = d.value ->> 'guid')`, JSON.stringify(inWindow));
			if (next) await tx.execute("UPDATE sweeps SET cursor = ?, started_at = ?", next, started);
			else await tx.execute("UPDATE sweeps SET last_at = ?, started_at = 0, cursor = NULL", started);
		});
		if (!next) break;
		cursor = next;
	}

	// One candidate per installation before any installation gets a second. Continue after
	// the last installation served so even more than 50 active installations get a turn.
	const candidates = await c.db.execute<{ guid: string; delivery: string; installation: string }>(`
		SELECT guid, delivery, CAST(installation AS TEXT) AS installation FROM pending_redelivery
		ORDER BY row_number() OVER (PARTITION BY installation ORDER BY at, length(delivery), delivery),
			pending_redelivery.installation <= coalesce((SELECT installation FROM redelivery_turn), 0), pending_redelivery.installation
		LIMIT 50`);
	const unavailable = new Set<string>();
	for (const d of candidates) {
		if (unavailable.has(d.installation)) continue;
		if (!await linked(c.db, d.installation)) continue;
		const inbox = c.client().githubInbox.getOrCreate([String(d.installation)], { params: serviceParams() });
		await c.db.execute("INSERT OR REPLACE INTO redelivery_turn VALUES (1, ?)", d.installation);
		let known: boolean;
		try { known = await inbox.internalKnows(d.guid); }
		catch {
			unavailable.add(d.installation);
			continue;
		}
		if (known) {
			await c.db.execute("DELETE FROM pending_redelivery WHERE guid = ?", d.guid);
			continue;
		}
		// Reserve before POST. Recheck membership after the actor call, in the same transaction.
		const reserved = await c.db.transaction(async tx => {
			if (!await linked(tx, d.installation)) return false;
			return (await tx.execute("INSERT OR IGNORE INTO redelivered VALUES (?, ?) RETURNING guid", d.guid, now)).length > 0;
		});
		if (reserved) {
			try {
				await app.redeliver(d.delivery);
			} catch (error) {
				unavailable.add(d.installation);
				if (error instanceof GithubError && error.status >= 400 && error.status < 500) {
					await c.db.execute("DELETE FROM redelivered WHERE guid = ?", d.guid);
					continue; // GitHub refused this request. Leave it for the next sweep.
				}
				// An ambiguous response keeps its reservation in case the POST reached GitHub.
			}
		}
		await c.db.execute("DELETE FROM pending_redelivery WHERE guid = ?", d.guid);
	}
	if (unavailable.size) console.warn(`github.webhook.redelivery_unavailable installations=${unavailable.size}`);
}

async function runSweep(c: Ctx) {
	// Even a tick that overlaps a slow sweep has consumed its schedule. Replace it first.
	await queued(c, () => arm(c, Date.now() + SWEEP, "internalSweep"));
	if (c.vars.draining) return;
	c.vars.draining = true;
	try {
		await sweep(c);
	} finally { c.vars.draining = false; }
}

export const githubHooks = actor({
	onBeforeConnect: internalConnection,
	onCreate: c => { if (c.key.length !== 1 || c.key[0] !== "app") c.destroy(); },
	db: db({ onMigrate: async db => {
		await db.execute(TIMER);
		await db.execute("CREATE TABLE IF NOT EXISTS sweeps (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_at INTEGER NOT NULL, started_at INTEGER NOT NULL, cursor TEXT)");
		await db.execute("CREATE TABLE IF NOT EXISTS installation_links (installation INTEGER NOT NULL, uid TEXT NOT NULL, PRIMARY KEY (installation, uid))");
		await db.execute("CREATE INDEX IF NOT EXISTS links_by_user ON installation_links(uid)");
		// The latest removal or activation seen for an installation, by the time its event was received.
		await db.execute("CREATE TABLE IF NOT EXISTS installation_state (installation INTEGER PRIMARY KEY, removed INTEGER NOT NULL, at INTEGER NOT NULL)");
		const pending = "CREATE TABLE IF NOT EXISTS pending_redelivery (guid TEXT PRIMARY KEY, delivery TEXT NOT NULL, installation INTEGER NOT NULL, at INTEGER NOT NULL)";
		await db.execute(pending);
		const columns = await db.execute<{ name: string; type: string }>("PRAGMA table_info(pending_redelivery)");
		if (columns.some(c => c.name === "delivery" && c.type === "INTEGER")) {
			await db.execute("ALTER TABLE pending_redelivery RENAME TO old_pending_redelivery");
			await db.execute(pending);
			// The old reader stored 0 for every unsafe ID. Re-list the three-day window to recover them.
			await db.execute("INSERT INTO pending_redelivery SELECT guid, CAST(delivery AS TEXT), installation, at FROM old_pending_redelivery WHERE delivery BETWEEN 1 AND 9007199254740991");
			await db.execute("UPDATE sweeps SET last_at = 0, started_at = 0, cursor = NULL");
			await db.execute("DROP TABLE old_pending_redelivery");
		}
		await db.execute("CREATE INDEX IF NOT EXISTS pending_by_installation ON pending_redelivery(installation, at, length(delivery), delivery)");
		await db.execute("CREATE TABLE IF NOT EXISTS redelivery_turn (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), installation INTEGER NOT NULL)");
		await db.execute("CREATE TABLE IF NOT EXISTS redelivered (guid TEXT PRIMARY KEY, at INTEGER NOT NULL)");
	} }),
	createVars: vars,
	onWake: async c => {
		if (!(await c.db.execute("SELECT 1 FROM sweeps")).length) return;
		const [timer] = await c.db.execute<{ at: number }>("SELECT at FROM timer");
		if (!timer || timer.at <= Date.now()) void c.keepAwake(runSweep(c).catch(() => console.warn("github.webhook.sweep_failed")));
	},
	actions: {
		/** Links the user to the installations, except one removed since the list was read. Returns the ids linked.
		 * `readAt` is when GitHub listed them all as active. Without it, any recorded removal wins. */
		internalSetInstallations: async (c, uid: string, ids: GithubId[], readAt?: number): Promise<GithubId[]> => {
			requireServiceFor(c, "call");
			return c.db.transaction(async tx => {
				const removed = new Set((await tx.execute<{ installation: string; at: number }>(`SELECT CAST(s.installation AS TEXT) AS installation, s.at
					FROM installation_state s JOIN json_each(?) d ON s.installation = d.value WHERE s.removed = 1`, JSON.stringify(ids)))
					.filter(r => readAt === undefined || r.at >= readAt - CLOCK_SKEW).map(r => r.installation));
				const accepted = ids.filter(id => !removed.has(String(id)));
				// A list read well after a removal shows the installation active again, as after a lifted suspension.
				if (readAt !== undefined) await tx.execute(`UPDATE installation_state SET removed = 0, at = ? WHERE removed = 1 AND at < ?
					AND installation IN (SELECT value FROM json_each(?))`, readAt, readAt - CLOCK_SKEW, JSON.stringify(accepted));
				const old = await tx.execute<{ installation: string }>("DELETE FROM installation_links WHERE uid = ? RETURNING CAST(installation AS TEXT) AS installation", uid);
				await tx.execute("INSERT OR IGNORE INTO installation_links SELECT value, ? FROM json_each(?)", uid, JSON.stringify(accepted));
				for (const { installation } of old) {
					await tx.execute(`DELETE FROM pending_redelivery WHERE installation = ?
						AND NOT EXISTS (SELECT 1 FROM installation_links WHERE installation = ?)`, installation, installation);
				}
				return accepted;
			});
		},
		/** Records a removal received at `at` and returns the users to drop it from. A later activation wins. */
		internalInstallationRemoved: async (c, installation: GithubId, at: number): Promise<string[]> => {
			requireServiceFor(c, "call");
			return c.db.transaction(async tx => {
				await tx.execute("DELETE FROM installation_state WHERE at <= ?", Date.now() - STATE_KEPT);
				await tx.execute(`INSERT INTO installation_state VALUES (?, 1, ?) ON CONFLICT(installation)
					DO UPDATE SET removed = 1, at = excluded.at WHERE excluded.at >= installation_state.at`, installation, at);
				const [state] = await tx.execute<{ removed: number }>("SELECT removed FROM installation_state WHERE installation = ?", installation);
				if (!state?.removed) return [];
				return (await tx.execute<{ uid: string }>("SELECT uid FROM installation_links WHERE installation = ?", installation)).map(r => r.uid);
			});
		},
		internalInstallationActive: async (c, installation: GithubId, at: number) => {
			requireServiceFor(c, "call");
			await c.db.execute(`INSERT INTO installation_state VALUES (?, 0, ?) ON CONFLICT(installation)
				DO UPDATE SET removed = 0, at = excluded.at WHERE excluded.at > installation_state.at`, installation, at);
		},
		internalInstallationUsers: async (c, installation: GithubId): Promise<string[]> => {
			requireServiceFor(c, "call");
			const rows = await c.db.execute<{ uid: string }>("SELECT uid FROM installation_links WHERE installation = ?", installation);
			return rows.map(r => r.uid);
		},
		internalLinked: async (c, installation: GithubId) => {
			requireServiceFor(c, "call");
			return linked(c.db, installation);
		},
		internalStart: async c => {
			requireServiceFor(c, "call");
			if (c.key.length !== 1 || c.key[0] !== "app") throw new Error("Wrong webhook sweep key.");
			await queued(c, async () => {
				await c.db.execute("INSERT OR IGNORE INTO sweeps VALUES (1, 0, 0, NULL)");
				if (!(await c.db.execute("SELECT 1 FROM timer")).length) await arm(c, Date.now() + SWEEP, "internalSweep");
			});
		},
		internalSweep: async c => {
			if (!c.scheduledFire) requireServiceFor(c, "call");
			if (c.key.length !== 1 || c.key[0] !== "app" || !(await c.db.execute("SELECT 1 FROM sweeps")).length) return;
			await runSweep(c);
		},
	},
});
