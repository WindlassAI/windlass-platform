/**
 * Check of the Linear protocol boundary (server/src/linear/), without Linear: no Linear OAuth app exists
 * while this runs, and nothing here calls Linear. Run with:
 *
 *   pnpm --filter @windlass-platform/server exec tsx ../scripts/linear-protocol-check.ts
 *
 * Linear is played by scripts/linear-standin.ts: its authorization page, token endpoint, GraphQL API and
 * the signed deliveries of its webhooks, over real HTTP. No server and no actor runs here: what the
 * actors keep (the states that were issued, the deliveries taken in) is played by
 * `LinearConnectStore` and the route's `dispatch` in memory; the actors themselves are checked by linear-check.ts.
 *
 * What it shows: the configuration, and that without it the integration is off; the OAuth exchange as
 * the app's own user, with PKCE, a reused, forged and declined state, a person's token and a missing
 * scope refused; the identity, team (paged) and issue reads, and that nothing is ever written to Linear;
 * signed deliveries parsed by Linear's own transition fields (label gained, app assigned) and not by the
 * issue's current state; the assignee passed on as an id, for the owner to tell the app from a person; unrelated edits, removals and unassignment
 * ignored; unmapped teams and unknown workspaces ignored; and malformed, wrong, altered, stale, oversized
 * and unsigned deliveries refused before anything is dispatched. Nothing logged or answered to a browser
 * holds a credential.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { join } from "node:path";
import { LinearStandin } from "./linear-standin.js";

const scratch = mkdtempSync(join(tmpdir(), "wlp-linear-check-"));
// Set before the server's modules are loaded: they read their configuration when they are.
process.env.WLP_SECRET = `check-secret-${randomBytes(16).toString("hex")}`;
process.env.RIVETKIT_STORAGE_PATH = join(scratch, "storage");
process.env.WLP_WEB_ORIGINS = "http://localhost:5193";
for (const name of Object.keys(process.env)) if (name.startsWith("WLP_LINEAR_")) delete process.env[name];
mkdirSync(process.env.RIVETKIT_STORAGE_PATH, { recursive: true });

const { linearConfig, linearClientSecret } = await import("../server/src/config.js");
const { LinearApp, LinearError, challengeOf, newVerifier, linearApp, redactLinear } = await import("../server/src/linear/app.js");
const { linearCallbackResponse, openLinearTicket } = await import("../server/src/linear/connect.js");
const webhook = await import("../server/src/linear/webhook.js");
type LinearClaim = import("../server/src/linear/connect.js").LinearClaim;
type LinearConnectStore = import("../server/src/linear/connect.js").LinearConnectStore;
type LinearDelivery = import("../server/src/linear/webhook.js").LinearDelivery;
type LinearDispatch = import("../server/src/linear/webhook.js").LinearDispatch;

// What was logged: nothing in it may be a credential.
const logged: string[] = [];
for (const level of ["log", "warn", "error", "info"] as const) {
	console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
}
const say = (line: string) => process.stdout.write(`${line}\n`);
async function section(name: string, body: () => Promise<void> | void): Promise<void> {
	await body();
	say(`ok  ${name}`);
}

const ORIGIN = "http://localhost:5193";
const standin = await LinearStandin.start({ pageSize: 50 });
const secrets = { client: standin.clientSecret, signing: standin.signingSecret };

// ---- what the actors keep, in memory -----------------------------------------------------------

class MemoryConnectStore implements LinearConnectStore {
	readonly states = new Map<string, { uid: string; origin: string; verifier: string; used: boolean }>();

	begin(uid: string, app: InstanceType<typeof LinearApp>): { state: string; url: string } {
		const state = `state-${randomBytes(12).toString("hex")}`;
		const verifier = newVerifier();
		this.states.set(state, { uid, origin: ORIGIN, verifier, used: false });
		return { state, url: app.authorizeUrl(state, challengeOf(verifier)) };
	}

	async claim(state: string): Promise<LinearClaim> {
		const found = this.states.get(state);
		if (!found) return { ok: false, reason: "state", origin: null };
		if (found.used) return { ok: false, reason: "used", origin: found.origin };
		found.used = true;
		return { ok: true, uid: found.uid, nonce: state, origin: found.origin, verifier: found.verifier };
	}
}

/** The owner's side in memory: what `dispatchLinearDelivery` and `fileLinearDelivery` decide before an issue is read. */
class MemoryOwner {
	readonly workspaces = new Map<string, { appUserId: string; mapped: Set<string> }>();
	readonly received: LinearDelivery[] = [];
	dispatches = 0;
	unavailable = false;
	private readonly seen = new Set<string>();

	dispatch = async (delivery: LinearDelivery): Promise<LinearDispatch> => {
		this.dispatches += 1;
		if (this.unavailable) throw new Error("the owner's actor cannot be reached");
		const workspace = this.workspaces.get(delivery.workspaceId);
		if (!workspace?.mapped.has(delivery.teamId)) return "ignored";
		if (!delivery.label && delivery.assignedTo !== workspace.appUserId) return "ignored";
		if (this.seen.has(delivery.deliveryId)) return "duplicate";
		this.seen.add(delivery.deliveryId);
		this.received.push(delivery);
		return "taken";
	};
}

// ---- the platform's HTTP, for the deliveries ----------------------------------------------------

const hooks = new MemoryOwner();
const settings = { current: undefined as ReturnType<typeof linearConfig> | undefined };
const route = webhook.linearWebhookRoute({ dispatch: hooks.dispatch, settings: () => settings.current ?? linearConfig() });
const platform = createServer((request: IncomingMessage, response) => {
	void (async () => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const headers = new Headers();
		for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
		const body = request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks);
		const answer = await route(new Request(`http://localhost${request.url}`, { method: request.method, headers, body }));
		response.writeHead(answer?.status ?? 404, Object.fromEntries(answer?.headers ?? []));
		response.end(answer ? await answer.text() : "");
	})();
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const hookUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}${webhook.LINEAR_WEBHOOK_PATH}`;

const fullEnv = {
	WLP_LINEAR_CLIENT_ID: standin.clientId,
	WLP_LINEAR_CLIENT_SECRET: standin.clientSecret,
	WLP_LINEAR_WEBHOOK_SECRET: standin.signingSecret,
	WLP_LINEAR_API_URL: standin.url,
	WLP_LINEAR_URL: standin.url,
	WLP_LINEAR_REDIRECT_URL: standin.redirectUri,
};
const app = new LinearApp(linearConfig(fullEnv).app!, { clientSecret: () => linearClientSecret(fullEnv) });

// ---- configuration ------------------------------------------------------------------------------

await section("configuration: off without it, off with part of it, and no secret in what it holds", async () => {
	assert.deepEqual(linearConfig({}), { app: null, webhook: null, missing: [] });
	const partial = linearConfig({ WLP_LINEAR_CLIENT_ID: "abc", WLP_LINEAR_CLIENT_SECRET: "x" });
	assert.equal(partial.app, null);
	assert.deepEqual(partial.missing, ["WLP_LINEAR_WEBHOOK_SECRET"]);
	assert.throws(() => linearConfig({ ...fullEnv, WLP_LINEAR_WEBHOOK_SECRET: "short" }), /WLP_LINEAR_WEBHOOK_SECRET must be at least 32/);
	assert.throws(() => linearConfig({ ...fullEnv, WLP_LINEAR_CLIENT_ID: "has space" }), /WLP_LINEAR_CLIENT_ID/);
	assert.throws(() => linearConfig({ ...fullEnv, WLP_LINEAR_API_URL: "ftp://x" }), /WLP_LINEAR_API_URL/);
	assert.throws(() => linearConfig({ ...fullEnv, WLP_LINEAR_URL: "https://user:pw@linear.app" }), /WLP_LINEAR_URL/);

	const full = linearConfig(fullEnv);
	assert.equal(full.app?.clientId, standin.clientId);
	const dump = JSON.stringify(full) + JSON.stringify(Object.entries(full.webhook!)) + inspect(full, { depth: null });
	assert.ok(!dump.includes(secrets.client) && !dump.includes(secrets.signing), "a secret is in the configuration object");
	assert.deepEqual(full.webhook!.secrets, [standin.signingSecret]);
	const defaults = linearConfig({ WLP_LINEAR_CLIENT_ID: "abc", WLP_LINEAR_CLIENT_SECRET: "s", WLP_LINEAR_WEBHOOK_SECRET: "w".repeat(32) });
	assert.equal(defaults.app?.apiUrl, "https://api.linear.app");
	assert.equal(defaults.app?.webUrl, "https://linear.app");
	assert.match(defaults.app!.redirectUrl, /^http:\/\/localhost:\d+\/linear\/callback$/);
	assert.equal(linearConfig({ ...fullEnv, WLP_PUBLIC_URL: "https://wl.example.com", WLP_LINEAR_REDIRECT_URL: "" }).app?.redirectUrl, "https://wl.example.com/linear/callback");

	// The environment itself: nothing set, nothing there.
	assert.equal(linearApp(), null);
	assert.equal(linearClientSecret({}), null);
});

await section("without configuration the routes do not exist and nothing is dispatched", async () => {
	const response = await linearCallbackResponse(new Request(`${standin.redirectUri}?code=x&state=y`), { store: new MemoryConnectStore() });
	assert.equal(response.status, 404);
	settings.current = linearConfig({});
	const signed = standin.createIssue({ team: standin.addTeam("OFF"), labels: ["windlass"] });
	const answer = await standin.deliver(hookUrl, signed.payload);
	assert.equal(answer.status, 404);
	assert.equal(hooks.received.length, 0);
	assert.equal(hooks.dispatches, 0);
	settings.current = undefined;
});

// ---- OAuth ---------------------------------------------------------------------------------------

const store = new MemoryConnectStore();
const logLines: string[] = [];
const deps = { store, app, origins: [ORIGIN], log: (line: string) => void logLines.push(line) };
let connection: ReturnType<typeof openLinearTicket>;
for (let i = 1; i <= 120; i += 1) standin.addTeam(`T${i}`, `Team ${i}`);
const alpha = standin.teams.find((team) => team.key === "T1")!;
const beta = standin.teams.find((team) => team.key === "T2")!;
const unmapped = standin.teams.find((team) => team.key === "T3")!;

await section("OAuth as the app's own user: the address, the exchange, the identity and the teams", async () => {
	const begun = store.begin("u_owner", app);
	const url = new URL(begun.url);
	assert.equal(url.origin + url.pathname, `${standin.url}/oauth/authorize`);
	assert.equal(url.searchParams.get("actor"), "app");
	assert.equal(url.searchParams.get("scope"), "read,app:assignable");
	assert.equal(url.searchParams.get("client_id"), standin.clientId);
	assert.equal(url.searchParams.get("redirect_uri"), standin.redirectUri);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.ok(!begun.url.includes(standin.clientSecret), "the client secret is in the authorization address");

	const back = await standin.authorize(begun.url);
	const answer = await linearCallbackResponse(new Request(back), deps);
	assert.equal(answer.status, 302);
	const location = answer.headers.get("location")!;
	const landing = new URL(location);
	assert.equal(landing.origin + landing.pathname, `${ORIGIN}/settings`);
	assert.match(landing.hash, /^#linear=.+$/);
	const ticket = landing.hash.slice("#linear=".length);
	assert.throws(() => openLinearTicket("u_other", ticket));
	connection = openLinearTicket("u_owner", ticket);
	assert.ok(connection.token.accessToken.startsWith("lin_oauth_"));
	assert.ok(connection.token.refreshToken);
	assert.ok(connection.token.expiresAt! > Date.now() + 3600_000);
	assert.deepEqual(connection.token.scopes.sort(), ["app:assignable", "read"]);

	// The app user, not the human who clicked: the installer is not established, so it is not claimed.
	assert.equal(connection.identity.appUser.id, standin.appUser.id);
	assert.notEqual(connection.identity.appUser.id, standin.human.id);
	assert.equal(connection.identity.workspace.id, standin.workspace.id);
	assert.equal(connection.identity.installer, null);
	// Every team the token reaches, over several pages.
	const teams = await app.teams(connection.token.accessToken);
	assert.equal(teams.length, standin.teams.length);
	assert.ok(standin.teams.length > 100);
	assert.deepEqual(teams.find((team) => team.key === "T1"), { id: alpha.id, key: "T1", name: "Team 1" });
	const pages = standin.calls.filter((call) => call.includes("teams")).length;
	assert.ok(pages >= 3, `expected the teams to be paged, saw ${pages} calls`);
	// Credentials stay sealed in the fragment.
	for (const secret of [connection.token.accessToken, connection.token.refreshToken!, standin.clientSecret, standin.signingSecret]) assert.ok(!location.includes(secret));
	assert.ok(logLines.some((line) => line.includes("linear.connect.confirmed")));
});

await section("OAuth refusals: reused, forged and declined states; a wrong code; a person's token; a missing scope", async () => {
	const fragment = async (response: Response) => new URL(response.headers.get("location")!).hash;

	// Used twice: the second return of the same state is refused and nothing is recorded.
	const first = store.begin("u_owner", app);
	const returned = await standin.authorize(first.url);
	assert.match(await fragment(await linearCallbackResponse(new Request(returned), deps)), /^#linear=.+$/);
	assert.equal(await fragment(await linearCallbackResponse(new Request(returned), deps)), "#linear-error=used");

	// Forged: no such state, and none that is not a string.
	assert.equal(await fragment(await linearCallbackResponse(new Request(`${standin.redirectUri}?code=x&state=forged`), deps)), "#linear-error=state");
	assert.equal(await fragment(await linearCallbackResponse(new Request(`${standin.redirectUri}?code=x`), deps)), "#linear-error=state");

	// Declined at Linear.
	standin.consent = { approve: false };
	const declined = store.begin("u_owner", app);
	assert.equal(await fragment(await linearCallbackResponse(new Request(await standin.authorize(declined.url)), deps)), "#linear-error=denied");
	standin.consent = { approve: true };

	// A code that is not Linear's, and one used already: not accepted.
	const known = store.begin("u_owner", app);
	assert.equal(await fragment(await linearCallbackResponse(new Request(`${standin.redirectUri}?code=made-up&state=${known.state}`), deps)), "#linear-error=code");
	const replay = store.begin("u_owner", app);
	const replayUrl = await standin.authorize(replay.url);
	await linearCallbackResponse(new Request(replayUrl), deps);
	const second = store.begin("u_owner", app);
	assert.equal(await fragment(await linearCallbackResponse(new Request(`${standin.redirectUri}?code=${new URL(replayUrl).searchParams.get("code")}&state=${second.state}`), deps)), "#linear-error=code");

	// A different verifier than the challenge was made from.
	const pkce = store.begin("u_owner", app);
	const pkceBack = new URL(await standin.authorize(pkce.url));
	await assert.rejects(app.exchangeCode(pkceBack.searchParams.get("code")!, "not-the-verifier"), (error: unknown) => error instanceof LinearError && error.status === 400);

	// A token for a person, as when the authorization was made without actor=app.
	standin.consent = { approve: true, actor: "user" };
	const person = store.begin("u_owner", app);
	assert.equal(await fragment(await linearCallbackResponse(new Request(await standin.authorize(person.url)), deps)), "#linear-error=not_app");
	standin.consent = { approve: true };

	// Assignable not granted.
	const narrow = await LinearStandin.start({ grantScopes: (asked) => asked.filter((scope) => scope !== "app:assignable") });
	try {
		const narrowApp2 = new LinearApp({ clientId: narrow.clientId, apiUrl: narrow.url, webUrl: narrow.url, redirectUrl: narrow.redirectUri }, { clientSecret: () => narrow.clientSecret });
		const scoped = store.begin("u_owner", narrowApp2);
		const result = await linearCallbackResponse(new Request(await narrow.authorize(scoped.url)), { ...deps, app: narrowApp2 });
		assert.equal(await fragment(result), "#linear-error=scope");
	} finally {
		await narrow.close();
	}

	// A wrong client secret is Linear's refusal too, and says nothing of the secret.
	const wrong = new LinearApp(app.settings, { clientSecret: () => "wrong-secret-value" });
	const code = new URL(await standin.authorize(store.begin("u_owner", app).url)).searchParams.get("code")!;
	await assert.rejects(wrong.exchangeCode(code, null), (error: unknown) => error instanceof LinearError && error.status === 401 && !error.message.includes("wrong-secret-value"));

	// Linear unreachable.
	const dead = new LinearApp({ ...app.settings, apiUrl: "http://127.0.0.1:9" }, { clientSecret: () => standin.clientSecret });
	const lost = store.begin("u_owner", app);
	const lostBack = await standin.authorize(lost.url);
	assert.equal(await fragment(await linearCallbackResponse(new Request(lostBack), { ...deps, app: dead })), "#linear-error=unreachable");
	// A method other than GET is not a callback.
	assert.equal((await linearCallbackResponse(new Request(standin.redirectUri, { method: "POST" }), deps)).status, 405);
});

await section("refresh, expiry and reads: identity, teams and one issue, with nothing written", async () => {
	const token = connection.token;
	standin.expire(token.accessToken);
	await assert.rejects(app.identity(token.accessToken), (error: unknown) => error instanceof LinearError && error.unauthorized);
	const refreshed = await app.refresh(token.refreshToken!);
	assert.notEqual(refreshed.accessToken, token.accessToken);
	assert.ok(refreshed.refreshToken && refreshed.refreshToken !== token.refreshToken);
	await assert.rejects(app.refresh(token.refreshToken!), (error: unknown) => error instanceof LinearError && error.status === 400, "a refresh token works once");
	connection.token = refreshed;

	const identity = await app.identity(refreshed.accessToken);
	assert.equal(identity.appUser.id, standin.appUser.id);
	assert.equal((await app.teams(refreshed.accessToken)).length, standin.teams.length);

	const { issue } = standin.createIssue({ team: alpha, title: "Fix the thing", description: "Details\n- [ ] one", labels: ["windlass", "windlass:quick"], assignee: standin.appUser, creator: standin.stranger });
	const read = await app.issue(refreshed.accessToken, issue.id);
	assert.ok(read);
	assert.equal(read.identifier, issue.identifier);
	assert.equal(read.title, "Fix the thing");
	assert.equal(read.teamId, alpha.id);
	assert.equal(read.assigneeId, standin.appUser.id);
	assert.deepEqual(read.creator, { id: standin.stranger.id, name: "Sam Other" });
	assert.deepEqual(read.labels.map((label) => label.name).sort(), ["windlass", "windlass:quick"]);
	assert.equal(read.archived, false);
	issue.archived = true;
	assert.equal((await app.issue(refreshed.accessToken, issue.id))!.archived, true);
	assert.equal(await app.issue(refreshed.accessToken, randomUUID()), null);
	assert.equal(await app.issue(refreshed.accessToken, "not an id"), null);
	assert.deepEqual(standin.writes, [], "something was written to Linear");
	// A revoked token (the app was uninstalled) is told apart from an outage.
	standin.revoke(refreshed.accessToken);
	await assert.rejects(app.teams(refreshed.accessToken), (error: unknown) => error instanceof LinearError && error.unauthorized && !error.unreachable);
});

// ---- webhooks ------------------------------------------------------------------------------------

settings.current = linearConfig(fullEnv);
hooks.workspaces.set(standin.workspace.id, { appUserId: standin.appUser.id, mapped: new Set([alpha.id, beta.id]) });

async function fire(payload: Record<string, unknown> | string, options: Parameters<typeof standin.deliver>[2] = {}) {
	const before = hooks.received.length;
	const answer = await standin.deliver(hookUrl, payload, options);
	return { ...answer, dispatched: hooks.received.length - before, json: answer.body.startsWith("{") ? JSON.parse(answer.body) as Record<string, unknown> : {} };
}

await section("a signed trigger: a label on a new issue, the label gained later, the app assigned", async () => {
	const created = standin.createIssue({ team: alpha, title: "Labelled at birth", labels: ["windlass"], creator: standin.stranger, actor: standin.human });
	const one = await fire(created.payload);
	assert.equal(one.status, 202);
	assert.equal(one.dispatched, 1);
	const delivery = hooks.received.at(-1)!;
	assert.equal(delivery.deliveryId, one.deliveryId);
	assert.equal(delivery.workspaceId, standin.workspace.id);
	assert.equal(delivery.teamId, alpha.id);
	assert.equal(delivery.issueId, created.issue.id);
	assert.equal(delivery.label, true);
	assert.equal(delivery.assignedTo, null);
	assert.equal(delivery.actorId, standin.human.id);
	// Ids and the transition only: nothing of what the issue says goes on from a delivery.
	assert.deepEqual(Object.keys(delivery).sort(), ["actorId", "assignedTo", "deliveryId", "issueId", "label", "sentAt", "teamId", "workspaceId"]);

	// Gained by an update, with `windlass:quick`: Quick.
	const plain = standin.createIssue({ team: alpha });
	assert.equal((await fire(plain.payload)).dispatched, 0, "an issue with neither label is not a trigger");
	const gained = await fire(standin.updateIssue(plain.issue, { addLabels: ["windlass", "windlass:quick"] }));
	assert.equal(gained.dispatched, 1);
	assert.equal(hooks.received.at(-1)!.label, true);
	assert.equal(hooks.received.at(-1)!.assignedTo, null);

	// Assigned to the app user later, and at birth.
	const later = standin.createIssue({ team: beta });
	await fire(later.payload);
	const assigned = await fire(standin.updateIssue(later.issue, { assignee: standin.appUser }));
	assert.equal(assigned.dispatched, 1);
	assert.equal(hooks.received.at(-1)!.label, false);
	assert.equal(hooks.received.at(-1)!.assignedTo, standin.appUser.id);
	const born = standin.createIssue({ team: beta, assignee: standin.appUser });
	assert.equal((await fire(born.payload)).dispatched, 1);
	// Reassigned from someone else to the app: a transition too.
	const reassigned = standin.createIssue({ team: beta, assignee: standin.stranger });
	await fire(reassigned.payload);
	assert.equal((await fire(standin.updateIssue(reassigned.issue, { assignee: standin.appUser }))).dispatched, 1);
	// Both at once are one delivery with both transitions.
	const both = standin.createIssue({ team: beta, labels: ["windlass"], assignee: standin.appUser });
	await fire(both.payload);
	assert.deepEqual([hooks.received.at(-1)!.label, hooks.received.at(-1)!.assignedTo], [true, standin.appUser.id]);
	assert.equal(standin.deliveries.length > 0, true);
});

await section("the app is told from another assignee, a person included", async () => {
	const issue = standin.createIssue({ team: alpha });
	await fire(issue.payload);
	// The route does not know the workspace's app user: the assignee goes on as an id, and the owner turns a person away.
	for (const other of [standin.human, standin.stranger]) {
		const answer = await fire(standin.updateIssue(issue.issue, { assignee: other }));
		assert.equal(answer.dispatched, 0, `${other.name} is not the app`);
		assert.equal(answer.json.taken, false);
	}
	assert.equal(webhook.classify(standin.updateIssue(issue.issue, { assignee: standin.appUser }))?.assignedTo, standin.appUser.id);
	assert.equal(webhook.classify(standin.updateIssue(issue.issue, { assignee: standin.human }))?.assignedTo, standin.human.id);
	assert.equal(webhook.classify(standin.updateIssue(issue.issue, { assignee: null })), null);
	// Born assigned to a person.
	assert.equal((await fire(standin.createIssue({ team: alpha, assignee: standin.stranger }).payload)).dispatched, 0);
});

await section("unrelated edits, removals and unassignment are not triggers; an unmapped team and workspace are ignored", async () => {
	const both = standin.createIssue({ team: alpha, labels: ["windlass"], assignee: standin.appUser });
	await fire(both.payload);
	const base = hooks.received.length;
	// Already labelled and assigned: an edit of the title, the description or the state is no trigger.
	for (const patch of [{ title: "Renamed" }, { description: "More words" }, { stateType: "started" }, { team: beta }]) {
		const answer = await fire(standin.updateIssue(both.issue, patch));
		assert.equal(answer.dispatched, 0, JSON.stringify(patch));
		assert.equal(answer.json.taken, false);
	}
	// Removing the label, unassigning, removing another label, adding an unrelated one.
	assert.equal((await fire(standin.updateIssue(both.issue, { removeLabels: ["windlass"] }))).dispatched, 0);
	assert.equal((await fire(standin.updateIssue(both.issue, { assignee: null }))).dispatched, 0);
	assert.equal((await fire(standin.updateIssue(both.issue, { addLabels: ["bug"] }))).dispatched, 0);
	// Quick removed from an issue that keeps `windlass`.
	const quick = standin.createIssue({ team: alpha, labels: ["windlass", "windlass:quick"] });
	await fire(quick.payload);
	const quickBase = hooks.received.length;
	assert.equal((await fire(standin.updateIssue(quick.issue, { removeLabels: ["windlass:quick"] }))).dispatched, 0);
	// The issue is removed: no trigger either.
	assert.equal((await fire(standin.removeIssue(both.issue))).dispatched, 0);
	assert.equal(hooks.received.length, quickBase, "something was dispatched by an edit, a removal or an unassignment");
	assert.ok(quickBase > base);

	// An update that does not say what changed is not a transition, whatever the issue looks like.
	const blind = standin.updateIssue(standin.createIssue({ team: alpha, labels: ["windlass"], assignee: standin.appUser }).issue, { title: "x" });
	delete blind.updatedFrom;
	assert.equal((await fire(blind)).dispatched, 0);

	// Unmapped team, unknown workspace, an event of another type: acknowledged, not dispatched.
	assert.equal((await fire(standin.createIssue({ team: unmapped, labels: ["windlass"] }).payload)).dispatched, 0);
	const stranger = standin.createIssue({ team: alpha, labels: ["windlass"] }).payload;
	assert.equal((await fire({ ...stranger, organizationId: randomUUID() })).dispatched, 0);
	const comment = { ...standin.createIssue({ team: alpha, labels: ["windlass"] }).payload, type: "Comment" };
	assert.equal((await fire(comment, { event: "Comment" })).dispatched, 0);
	assert.equal((await fire({ ...stranger, data: { ...(stranger.data as object), teamId: "nope", team: undefined } })).dispatched, 0);
});

await section("redelivery: the same delivery is taken once, and a delivery that cannot be taken in has Linear try again", async () => {
	const issue = standin.createIssue({ team: alpha, labels: ["windlass"] });
	const first = await fire(issue.payload, { deliveryId: randomUUID() });
	assert.equal(first.json.taken, true);
	// Linear redelivers the same bytes under the same delivery id, with a fresh signature timestamp it does not change.
	const again = await fire(issue.payload, { deliveryId: first.deliveryId });
	assert.equal(again.status, 202);
	assert.equal(again.json.taken, "duplicate");
	assert.equal(again.dispatched, 0);
	hooks.unavailable = true;
	const unavailable = await fire(standin.createIssue({ team: alpha, labels: ["windlass"] }).payload);
	assert.equal(unavailable.status, 503);
	hooks.unavailable = false;
});

await section("refused before dispatch: bad, wrong, altered, stale and oversized deliveries", async () => {
	const payload = standin.createIssue({ team: alpha, labels: ["windlass"] }).payload;
	const lookups = hooks.dispatches;
	const received = hooks.received.length;
	const refused = async (what: string, status: number, code: string, answer: Promise<Awaited<ReturnType<typeof fire>>>) => {
		const result = await answer;
		assert.equal(result.status, status, `${what}: ${result.body}`);
		assert.equal(result.json.code, code, what);
		assert.equal(result.dispatched, 0, what);
	};
	await refused("no signature", 400, "bad_headers", fire(payload, { omit: ["linear-signature"] }));
	await refused("signature not hex", 400, "bad_headers", fire(payload, { signature: "zz".repeat(32) }));
	await refused("signature too short", 400, "bad_headers", fire(payload, { signature: "ab" }));
	await refused("no delivery id", 400, "bad_headers", fire(payload, { omit: ["linear-delivery"] }));
	await refused("delivery id not a uuid", 400, "bad_headers", fire(payload, { deliveryId: "../../etc" }));
	await refused("signed with another secret", 401, "bad_signature", fire(payload, { secret: "lin_wh_" + "0".repeat(48) }));
	await refused("signature of nothing", 401, "bad_signature", fire(payload, { signature: "0".repeat(64) }));
	// The bytes were changed after they were signed: a team swapped for another.
	const original = Buffer.from(JSON.stringify(payload));
	const altered = Buffer.from(original.toString().replace(alpha.id, beta.id));
	assert.notDeepEqual(altered, original);
	await refused("altered bytes", 401, "bad_signature", fire(payload, { bytes: altered }));
	await refused("one byte appended", 401, "bad_signature", fire(payload, { bytes: Buffer.concat([original, Buffer.from(" ")]) }));
	// Whitespace re-encoding is different bytes: the signature is over what was sent, not over the JSON.
	await refused("re-encoded", 401, "bad_signature", fire(payload, { bytes: Buffer.from(JSON.stringify(payload, null, 1)) }));

	// Stale and future timestamps, signed correctly: a replay of a captured delivery.
	await refused("a minute and a half old", 401, "stale_timestamp", fire(payload, { timestamp: Date.now() - 90_000 }));
	await refused("an hour old", 401, "stale_timestamp", fire(payload, { timestamp: Date.now() - 3600_000 }));
	await refused("from the future", 401, "stale_timestamp", fire(payload, { timestamp: Date.now() + 90_000 }));
	await refused("no timestamp", 401, "bad_timestamp", fire(JSON.stringify({ ...payload, webhookTimestamp: undefined })));
	await refused("timestamp as text", 401, "bad_timestamp", fire(JSON.stringify({ ...payload, webhookTimestamp: String(Date.now()) })));
	await refused("not JSON", 400, "bad_json", fire("not json at all"));
	await refused("not UTF-8", 400, "bad_json", (async () => {
		const bad = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
		return fire(payload, { signature: webhook.signBody(bad, standin.signingSecret), bytes: bad });
	})());

	// Too big: refused for its size, signed or not.
	const huge = JSON.stringify({ ...payload, padding: "x".repeat(webhook.MAX_WEBHOOK_BYTES) });
	await refused("oversized", 413, "body_too_large", fire(huge));
	// A method other than POST.
	const get = await standin.deliver(hookUrl, payload, { method: "GET" });
	assert.equal(get.status, 405);

	// Inside the window, either way, the same delivery is taken.
	assert.equal((await fire(payload, { timestamp: Date.now() - 30_000 })).dispatched, 1);
	assert.equal((await fire(standin.createIssue({ team: alpha, labels: ["windlass"] }).payload, { timestamp: Date.now() + 30_000 })).dispatched, 1);
	assert.equal(hooks.received.length, received + 2, "a refused delivery was dispatched");
	// Nothing was looked up, either, for the refused: ids are taken out only after the signature and the timestamp.
	assert.equal(hooks.dispatches, lookups + 2);
});

await section("rotated signing secret and the parse of ids: only UUIDs are taken out", async () => {
	assert.equal(webhook.signatureMatches(Buffer.from("x"), webhook.signBody("x", "a".repeat(40)), ["b".repeat(40), "a".repeat(40)]), true);
	assert.equal(webhook.signatureMatches(Buffer.from("x"), webhook.signBody("x", "a".repeat(40)), ["b".repeat(40)]), false);
	assert.equal(webhook.signatureMatches(Buffer.from("x"), webhook.signBody("x", "a".repeat(40)).toUpperCase(), ["a".repeat(40)]), true);
	assert.equal(webhook.readIds({ type: "Issue", organizationId: "x", data: { id: randomUUID(), teamId: randomUUID() } }), null);
	assert.equal(webhook.readIds({ type: "Issue", organizationId: randomUUID(), data: { id: randomUUID(), team: { id: randomUUID() } } }) !== null, true);
	assert.equal(webhook.readIds({ type: "Comment", organizationId: randomUUID(), data: { id: randomUUID(), teamId: randomUUID() } }), null);
	assert.equal(webhook.timestampProblem({ webhookTimestamp: 1000 }, 1000 + 60_000), null);
	assert.equal(webhook.timestampProblem({ webhookTimestamp: 1000 }, 1000 + 60_001), "stale_timestamp");
});

// ---- credentials -----------------------------------------------------------------------------------

await section("no credential in anything logged, and nothing was written to Linear", async () => {
	const everything = [...logged, ...logLines].join("\n");
	for (const secret of [standin.clientSecret, standin.signingSecret, connection.token.accessToken, connection.token.refreshToken!]) {
		assert.ok(!everything.includes(secret), "a credential was logged");
	}
	assert.ok(everything.includes("linear.connect.confirmed"), "the connection was not logged at all");
	assert.equal(redactLinear("bad lin_oauth_0123456789abcdef and secret-xyz-123", ["secret-xyz-123"]), "bad [redacted] and [redacted]");
	assert.deepEqual(standin.writes, []);
});

await standin.close();
await new Promise<void>((resolve) => platform.close(() => resolve()));
say("linear-protocol-check: all sections passed");
process.exit(0);
