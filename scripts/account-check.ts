/**
 * The rules of the account's settings, on their own: no server, no sandbox, nothing sent anywhere.
 * What a user keeps for their account whatever the repository: the defaults for new sessions
 * (server/src/account-defaults.ts), their own MCP servers (personal-servers.ts), the secrets those
 * read (account-secrets.ts), and Windlass's configuration file in a sandbox with the platform's
 * servers in it (windlass-config.ts). Every value in it is made up here, at random. The storage runs
 * against a SQLite database in memory, behind a door that makes every statement wait a little, as
 * the actor's database does, so calls started together take turns statement by statement.
 *
 *   cd server && npx tsx ../scripts/account-check.ts
 *
 * What it holds to: a default is saved field by field, also beside another save; a server's name is
 * Windlass's and never the platform's own; a definition is what Windlass's configuration takes, key
 * by key, and nothing else is stored; a server's tools ask unless its user said otherwise; servers
 * and secrets saved together all stay, and never more than an account may keep; an account's secret
 * is sealed for the account, is listed without its value, reaches what a repository's secret of its
 * scope reaches without the setup command (MCP servers only, and only where no command can read it
 * from Windlass's process, or the agent's commands as well, everywhere), and gives way to a
 * repository's secret of the same name; and the configuration file gets the
 * user's servers and the platform's own, loses them again, and never lets a user's take the
 * platform's place.
 *
 * With Windlass's source beside this repository (~/projects/wt-windlass-token-validity, or
 * WLP_WINDLASS_SOURCE), the keys Windlass takes for one server are read from it and held against
 * the copy here.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACCOUNT_DEFAULTS_TABLE, readAccountDefaults, saveAccountDefaults } from "../server/src/account-defaults.js";
import {
	ACCOUNT_SECRETS_TABLE,
	ACCOUNT_SECRET_PROJECT,
	type OpenedAccountSecret,
	SecretNotFound,
	TooManySecrets,
	accountSecretNames,
	accountSecretReach,
	accountSecretsFor,
	accountSecretsNote,
	deleteAccountSecret,
	listedAccountSecrets,
	saveAccountSecret,
	turnEnvironment,
} from "../server/src/account-secrets.js";
import { PUBLISH_SERVER } from "../server/src/agent-publish.js";
import { MAX_ACCOUNT_SECRETS, MAX_PERSONAL_SERVERS, MAX_SERVER_DEFINITION_BYTES, type SandboxProfile } from "../server/src/contract.js";
import { PERSONAL_SERVERS_TABLE, SERVER_KEYS, ServerProblem, addServer, changeServer, cleanServerDefinition, cleanServerName, cleanUnasked, definitionReads, deleteServer, isReservedServerName, listedServer, readServers } from "../server/src/personal-servers.js";
import { type OpenedSecret, SecretRedactor, openSecret, sealSecret, secretReach, setupEnvironment } from "../server/src/repo-secrets.js";
import type { DefaultsDb } from "../server/src/repository-defaults.js";
import { personalServerReach, serverQuestionWords } from "../server/src/server-question.js";
import { createSealer } from "../server/src/signin/seal.js";
import { PLATFORM_WAKE, platformConfig } from "../server/src/windlass-config.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
}

const plain = (value: unknown) => JSON.stringify(value);

const profile = (id: string, extra: Partial<SandboxProfile> = {}): SandboxProfile => ({
	id: id as SandboxProfile["id"],
	name: id,
	summary: "",
	layers: [],
	approval: "auto",
	commandNetwork: false,
	commandsCanReadAccessToken: false,
	available: true,
	...extra,
});
/** Commands held in Windlass's sandbox; commands run directly; and nothing promised of them. */
const STRICT = profile("docker-windlass-sandbox");
const OPEN = profile("docker-hardened", { approval: "full", commandNetwork: true, commandsCanReadAccessToken: true });
const UNKNOWN = profile("e2b", { commandNetwork: true, commandsCanReadAccessToken: true });

/** A database whose every statement waits a moment first: whoever started another call meanwhile gets a turn. */
function database(): { db: DefaultsDb; all(query: string): Array<Record<string, unknown>> } {
	const sqlite = new DatabaseSync(":memory:");
	for (const table of [ACCOUNT_DEFAULTS_TABLE, PERSONAL_SERVERS_TABLE, ACCOUNT_SECRETS_TABLE]) sqlite.exec(table);
	const db: DefaultsDb = {
		async execute<Row extends Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> {
			for (let waits = Math.floor(Math.random() * 4); waits >= 0; waits -= 1) await new Promise<void>((done) => setImmediate(done));
			return sqlite.prepare(query).all(...(args as Array<string | number | null>)) as Row[];
		},
	};
	return { db, all: (query) => sqlite.prepare(query).all() as Array<Record<string, unknown>> };
}

const ROUNDS = 200;

// ---- the account's defaults ------------------------------------------------------------------------

{
	const { db, all } = database();
	expect("nothing is kept until something is saved", plain(await readAccountDefaults(db)) === plain({ profile: null, model: null, updatedAt: null }) && all("SELECT * FROM account_defaults").length === 0);
	const first = await saveAccountDefaults(db, { profile: "docker-hardened" }, 10);
	const second = await saveAccountDefaults(db, { model: "gpt-6-luna" }, 20);
	expect("a sandbox saved alone leaves the model as none, and a model saved after it leaves the sandbox", plain([first.profile, first.model, first.updatedAt]) === plain(["docker-hardened", null, 10]) && plain([second.profile, second.model, second.updatedAt]) === plain(["docker-hardened", "gpt-6-luna", 20]));
	await saveAccountDefaults(db, { profile: null }, 30);
	const gone = await saveAccountDefaults(db, { model: null }, 40);
	expect("clearing the last field leaves no row", plain(gone) === plain({ profile: null, model: null, updatedAt: null }) && all("SELECT * FROM account_defaults").length === 0);

	let both = 0;
	for (let round = 0; round < ROUNDS; round += 1) {
		const fresh = database();
		await saveAccountDefaults(fresh.db, { profile: "docker-windlass-sandbox", model: "gpt-6.1-sol" }, 1);
		await Promise.all([saveAccountDefaults(fresh.db, { profile: "docker-hardened" }, 100), saveAccountDefaults(fresh.db, { model: "gpt-6-luna" }, 100)]);
		const now = await readAccountDefaults(fresh.db);
		if (now.profile === "docker-hardened" && now.model === "gpt-6-luna") both += 1;
	}
	expect(`a save of the sandbox and a save of the model that run together both stay (${ROUNDS} rounds)`, both === ROUNDS, `${both} of ${ROUNDS}`);
}

// ---- a server's name -------------------------------------------------------------------------------

function refusedName(raw: unknown): string | null {
	try {
		cleanServerName(raw);
		return null;
	} catch (error) {
		return error instanceof ServerProblem ? error.code : `another error: ${String(error)}`;
	}
}

expect("a name of letters, digits, '_', '.' and '-' is taken", ["tracker", "Docs.v2", "a", "9lives", "my-server_1", `a${"b".repeat(63)}`].every((name) => refusedName(name) === null));
expect("a name Windlass would refuse is refused", ["", "-tracker", ".hidden", "has space", "a/b", "ünï", `a${"b".repeat(64)}`, 7, null, undefined].every((name) => refusedName(name) === "bad_server"));
expect(
	"the platform's own server's name is no server's of a user's, in any case of letters, nor one that begins with it",
	[PUBLISH_SERVER, PUBLISH_SERVER.toUpperCase(), "Windlass_Platform", `${PUBLISH_SERVER}2`, `${PUBLISH_SERVER}.x`].every((name) => refusedName(name) === "bad_server" && isReservedServerName(name)) && !isReservedServerName("windlass") && refusedName("windlass") === null,
);

// ---- a server's definition -------------------------------------------------------------------------

function refusedSetting(raw: unknown): string | null {
	try {
		cleanUnasked(raw);
		return null;
	} catch (error) {
		return error instanceof ServerProblem ? error.code : String(error);
	}
}

function refused(raw: unknown): string | null {
	try {
		cleanServerDefinition(raw);
		return null;
	} catch (error) {
		return error instanceof ServerProblem ? error.message : `another error: ${String(error)}`;
	}
}

const COMMAND = { command: "tracker-mcp", args: ["--stdio"], cwd: "tools", env: { TRACKER_TOKEN: "${TRACKER_TOKEN}", REGION: "eu" }, tools: { allow: ["search*"], deny: ["delete_*"] }, timeoutSeconds: 120, startupTimeoutSeconds: 45, untrusted: true, enabled: true, protocol: "auto" };
const ADDRESS = { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-Team": "${TEAM}-${DOCS_TOKEN}" } };

expect("a server that is started is taken with every key Windlass has for one", plain(cleanServerDefinition(COMMAND)) === plain(COMMAND));
expect("a server that is reached is taken with its headers", plain(cleanServerDefinition(ADDRESS)) === plain(ADDRESS));
expect("what is stored is rebuilt in one order of keys, whatever order it came in", plain(cleanServerDefinition({ protocol: "legacy", args: [], command: "x" })) === plain({ command: "x", args: [], protocol: "legacy" }));
expect("the variables a definition reads are those in the values of env and headers, each once, in order", plain(definitionReads(COMMAND)) === plain(["TRACKER_TOKEN"]) && plain(definitionReads(ADDRESS)) === plain(["DOCS_TOKEN", "TEAM"]) && definitionReads({ command: "x", args: ["${NOT_READ}"] }).length === 0);
expect("a key Windlass does not know is refused, and the sentence names it and the ones it takes", (refused({ command: "x", comand: "y" }) ?? "").includes('"comand"') && (refused({ command: "x", note: 1 }) ?? "").includes("command, args, cwd, env, url, headers"));
expect("an unknown key's own text is not repeated beyond what is printable of its beginning", !(refused({ command: "x", [`k\u0007${"z".repeat(200)}`]: 1 }) ?? "").includes("z".repeat(41)));
expect("neither a command nor an address, or both, is refused", refused({}) !== null && refused({ args: ["x"] }) !== null && refused({ command: "x", url: "https://example.com/mcp" }) !== null);
expect("headers on a command, and args, cwd or env on an address, are refused as Windlass refuses them", refused({ command: "x", headers: {} }) !== null && ["args", "cwd", "env"].every((key) => refused({ url: "https://example.com/mcp", [key]: key === "args" ? [] : key === "env" ? {} : "d" }) !== null));
expect(
	"a value of the wrong type is refused, for each key",
	[
		{ command: "" },
		{ command: 7 },
		{ command: "x", args: "one" },
		{ command: "x", args: [7] },
		{ command: "x", cwd: "" },
		{ command: "x", env: [] },
		{ command: "x", env: { "1BAD": "v" } },
		{ command: "x", env: { OK: 7 } },
		{ url: "ftp://example.com/mcp" },
		{ url: "not an address" },
		{ url: "https://example.com/mcp", headers: { A: 1 } },
		{ command: "x", tools: [] },
		{ command: "x", tools: { allow: [""] } },
		{ command: "x", tools: { only: ["a"] } },
		{ command: "x", timeoutSeconds: 0 },
		{ command: "x", timeoutSeconds: 3601 },
		{ command: "x", timeoutSeconds: 1.5 },
		{ command: "x", startupTimeoutSeconds: 601 },
		{ command: "x", untrusted: "no" },
		{ command: "x", enabled: 1 },
		{ command: "x", protocol: "newest" },
		{ command: "x\0y" },
		{ command: "x", args: ["a\0b"] },
	].every((raw) => refused(raw) !== null),
);
expect("what is not an object is no definition", [null, undefined, "tracker-mcp", 7, [], [COMMAND]].every((raw) => refused(raw) !== null));
{
	const secret = `tok_${randomBytes(12).toString("hex")}`;
	const said = [refused({ command: "x", args: [secret], env: { A: 7 } }), refused({ url: `ftp://${secret}@example.com/` }), refused({ command: "x", env: { OK: secret }, protocol: secret })];
	expect("a refusal never repeats a value of the definition", said.every((sentence) => sentence !== null && !sentence.includes(secret)), said.join(" | "));
	const large = { command: "x", args: ["y".repeat(MAX_SERVER_DEFINITION_BYTES)] };
	expect(`a definition longer than ${MAX_SERVER_DEFINITION_BYTES} bytes as JSON is refused, and one just inside is taken`, refused(large) !== null && refused({ command: "x", args: ["y".repeat(MAX_SERVER_DEFINITION_BYTES - 40)] }) === null);
}
{
	const source = join(process.env.WLP_WINDLASS_SOURCE ?? join(homedir(), "projects", "wt-windlass-token-validity"), "packages", "core", "src", "mcp", "config.ts");
	if (!existsSync(source)) {
		console.log(`skip  Windlass's source is not at ${source}: the keys it takes for a server were not held against the copy here`);
	} else {
		const fields = /const serverFields = section\(\{([\s\S]*?)\n\}\)/.exec(readFileSync(source, "utf8"))?.[1] ?? "";
		const keys = [...fields.matchAll(/^ {2}([A-Za-z]+)[,:]/gm)].map((match) => match[1]);
		expect("the keys of a server's definition are the ones Windlass's source has", keys.length > 0 && plain([...keys].sort()) === plain([...SERVER_KEYS].sort()), `Windlass: ${keys.join(", ")}\n      here:     ${SERVER_KEYS.join(", ")}`);
	}
}

// ---- how servers are stored ------------------------------------------------------------------------

{
	const { db, all } = database();
	await addServer(db, "tracker", cleanServerDefinition(COMMAND), false, 10);
	await addServer(db, "docs", cleanServerDefinition(ADDRESS), true, 20);
	const listed = (await readServers(db)).map((server) => listedServer(server, new Set(["DOCS_TOKEN"])));
	expect("servers are listed by name, each with what starts it or where it is reached", plain(listed.map((server) => [server.name, server.remote, server.subject])) === plain([["docs", true, "https://docs.example.com/mcp"], ["tracker", false, "tracker-mcp --stdio"]]));
	expect("the list says which variables a definition reads and whether an account's secret of that name is saved", plain(listed[0]?.reads) === plain([{ name: "DOCS_TOKEN", saved: true }, { name: "TEAM", saved: false }]) && plain(listed[1]?.reads) === plain([{ name: "TRACKER_TOKEN", saved: false }]));
	expect("a server's tools ask unless it was saved with the setting on, and the list says which", plain(listed.map((server) => [server.name, server.unasked])) === plain([["docs", true], ["tracker", false]]));
	expect("the setting is on only for exactly true, off when nothing is said, and anything else is refused", cleanUnasked(true) && !cleanUnasked(false) && !cleanUnasked(undefined) && [1, "true", null].every((raw) => refusedSetting(raw) === "bad_server"));
	const taken = await addServer(db, "tracker", { command: "other" }, true, 30).then(
		() => "saved",
		(error: unknown) => (error instanceof ServerProblem ? error.code : String(error)),
	);
	expect("adding a server under a name that is taken is refused, and the saved one stays", taken === "server_exists" && plain((await readServers(db)).find((server) => server.name === "tracker")?.definition) === plain(COMMAND));
	expect("and a refused add leaves the saved one's setting as it was", (await readServers(db)).find((server) => server.name === "tracker")?.unasked === false);
	await changeServer(db, "tracker", { command: "tracker-mcp", args: ["--v2"] }, true, 40);
	const changed = (await readServers(db)).find((server) => server.name === "tracker");
	expect("a change replaces the definition and the setting of the one of that name", plain(changed?.definition) === plain({ command: "tracker-mcp", args: ["--v2"] }) && changed?.unasked === true && changed?.updatedAt === 40);
	await changeServer(db, "tracker", { command: "tracker-mcp", args: ["--v2"] }, false, 45);
	expect("and switches it off again", (await readServers(db)).find((server) => server.name === "tracker")?.unasked === false);
	const missing = await changeServer(db, "nowhere", { command: "x" }, false, 50).then(
		() => "saved",
		(error: unknown) => (error instanceof ServerProblem ? error.code : String(error)),
	);
	expect("a change of a server that is not saved is refused and adds nothing", missing === "server_not_found" && all("SELECT name FROM personal_server").length === 2);
	await deleteServer(db, "docs");
	await deleteServer(db, "docs");
	expect("a deleted server is gone, and deleting it again changes nothing", plain((await readServers(db)).map((server) => server.name)) === plain(["tracker"]));
	// A row that came to hold what Windlass would refuse would fail every turn of its user: it is not handed out.
	await db.execute("INSERT INTO personal_server (name, definition, updated_at) VALUES ('broken', '{\"comand\":\"x\"}', 1), ('unparsed', '{', 1), (?, '{\"command\":\"x\"}', 1)", PUBLISH_SERVER);
	expect("a stored row that is not a definition Windlass takes, or bears the platform's name, is not handed out", plain((await readServers(db)).map((server) => server.name)) === plain(["tracker"]));
}

{
	// Many adds at once, more than an account may keep: the limit holds between them, and every add is answered truly.
	let exact = 0;
	let honest = 0;
	const extra = 6;
	for (let round = 0; round < 40; round += 1) {
		const { db, all } = database();
		const answers = await Promise.all(
			Array.from({ length: MAX_PERSONAL_SERVERS + extra }, (_, index) =>
				addServer(db, `server-${index}`, { command: "x", args: [String(index)] }, false, 100 + index).then(
					() => "saved",
					(error: unknown) => (error instanceof ServerProblem ? error.code : String(error)),
				),
			),
		);
		const kept = all("SELECT name FROM personal_server").map((row) => String(row.name));
		if (kept.length === MAX_PERSONAL_SERVERS) exact += 1;
		const saved = answers.flatMap((answer, index) => (answer === "saved" ? [`server-${index}`] : []));
		if (saved.length === MAX_PERSONAL_SERVERS && saved.every((name) => kept.includes(name)) && answers.every((answer) => answer === "saved" || answer === "too_many_servers")) honest += 1;
	}
	expect(`${MAX_PERSONAL_SERVERS + extra} servers added together leave ${MAX_PERSONAL_SERVERS}, the most an account may keep (40 rounds)`, exact === 40, `${exact} of 40`);
	expect("each add was told whether it was saved, and the ones that were not were told of the limit", honest === 40, `${honest} of 40`);

	let stay = 0;
	for (let round = 0; round < ROUNDS; round += 1) {
		const { db } = database();
		await addServer(db, "tracker", { command: "old" }, false, 1);
		await Promise.all([changeServer(db, "tracker", { command: "new" }, false, 100), addServer(db, "docs", { url: "https://docs.example.com/mcp" }, false, 100), saveAccountDefaults(db, { model: "gpt-6-luna" }, 100), saveAccountSecret(db, "DOCS_TOKEN", "setup", "sealed-value", 100)]);
		const servers = await readServers(db);
		if (plain(servers.map((server) => [server.name, server.definition.command ?? server.definition.url])) === plain([["docs", "https://docs.example.com/mcp"], ["tracker", "new"]]) && (await readAccountDefaults(db)).model === "gpt-6-luna" && (await accountSecretNames(db)).has("DOCS_TOKEN")) stay += 1;
	}
	expect(`a changed server, an added one, a default and a secret saved together all stay (${ROUNDS} rounds)`, stay === ROUNDS, `${stay} of ${ROUNDS}`);
}

// ---- the account's secrets -------------------------------------------------------------------------

const sealer = createSealer(randomBytes(32).toString("hex"));
const value = () => `v_${randomBytes(18).toString("base64url")}`;

{
	const secret = value();
	const sealed = sealSecret(sealer, "u_ada", ACCOUNT_SECRET_PROJECT, "TRACKER_TOKEN", secret);
	const opens = (uid: string, project: string, name: string) => {
		try {
			return openSecret(sealer, uid, project, name, sealed) === secret;
		} catch {
			return false;
		}
	};
	expect("a sealed value opens for its user, the account and its name", opens("u_ada", ACCOUNT_SECRET_PROJECT, "TRACKER_TOKEN"));
	expect("and as nothing else: not another user's, not a repository's of that name, not another name", !opens("u_eve", ACCOUNT_SECRET_PROJECT, "TRACKER_TOKEN") && !opens("u_ada", "github:7101", "TRACKER_TOKEN") && !opens("u_ada", ACCOUNT_SECRET_PROJECT, "OTHER"));
	expect("the sealed value does not hold the value in the clear", !sealed.includes(secret));

	const { db, all } = database();
	await saveAccountSecret(db, "TRACKER_TOKEN", "setup", sealed, 10);
	await saveAccountSecret(db, "DOCS_TOKEN", "agent", sealSecret(sealer, "u_ada", ACCOUNT_SECRET_PROJECT, "DOCS_TOKEN", value()), 20);
	const next = sealSecret(sealer, "u_ada", ACCOUNT_SECRET_PROJECT, "TRACKER_TOKEN", value());
	await saveAccountSecret(db, "TRACKER_TOKEN", "setup", next, 30);
	const rows = all("SELECT name, scope, sealed, updated_at FROM account_secret ORDER BY name");
	expect("a value saved under a name that is saved takes the earlier one's place", rows.length === 2 && rows[1]?.sealed === next && rows[1]?.updated_at === 30);
	expect("a secret is saved with its scope, a repository's two", plain(rows.map((row) => row.scope)) === plain(["agent", "setup"]));
	await saveAccountSecret(db, "TRACKER_TOKEN", "agent", undefined, 35);
	const [rescoped] = all("SELECT scope, sealed, updated_at FROM account_secret WHERE name = 'TRACKER_TOKEN'");
	expect("a scope saved without a value changes the scope and keeps the value", rescoped?.scope === "agent" && rescoped.sealed === next && rescoped.updated_at === 35);
	const absent = await saveAccountSecret(db, "NOWHERE", "agent", undefined, 36).then(
		() => "saved",
		(error: unknown) => (error instanceof SecretNotFound ? "not found" : String(error)),
	);
	expect("a scope for a name that is not saved is refused and adds nothing", absent === "not found" && all("SELECT name FROM account_secret").length === 2);
	await saveAccountSecret(db, "TRACKER_TOKEN", "setup", undefined, 30);
	const listed = listedAccountSecrets(
		rows as Array<{ name: string; scope: string; updated_at: number }>,
		[
			{ name: "TRACKER_TOKEN", project: "github:7101", label: "acme/harbor" },
			{ name: "TRACKER_TOKEN", project: "github:7190", label: "" },
			{ name: "UNRELATED", project: "github:7102", label: "ada/tide-tables" },
		],
		STRICT,
	);
	expect("the list a client gets has names and times and no value, sealed or not", !plain(listed).includes(next) && !plain(listed).includes("sealed") && plain(listed.secrets.map((one) => [one.name, one.scope, one.updatedAt])) === plain([["DOCS_TOKEN", "agent", 20], ["TRACKER_TOKEN", "setup", 30]]));
	expect("it names the repositories that have a secret of their own under the name", plain(listed.secrets.map((one) => one.repositories)) === plain([[], ["acme/harbor", "repository 7190"]]));
	await deleteAccountSecret(db, "DOCS_TOKEN");
	expect("a deleted secret is gone", plain([...(await accountSecretNames(db))]) === plain(["TRACKER_TOKEN"]));

	let exact = 0;
	const extra = 5;
	for (let round = 0; round < 20; round += 1) {
		const fresh = database();
		await saveAccountSecret(fresh.db, "KEPT_0", "setup", "first", 1);
		const answers = await Promise.all([
			...Array.from({ length: MAX_ACCOUNT_SECRETS + extra }, (_, index) => saveAccountSecret(fresh.db, `KEPT_${index + 1}`, "setup", `v${index}`, 100).then(() => "saved", (error: unknown) => (error instanceof TooManySecrets ? "limit" : String(error)))),
			saveAccountSecret(fresh.db, "KEPT_0", "setup", "second", 200).then(() => "replaced", (error: unknown) => String(error)),
		]);
		const kept = fresh.all("SELECT name, sealed FROM account_secret");
		if (kept.length === MAX_ACCOUNT_SECRETS && answers.filter((answer) => answer === "saved").length === MAX_ACCOUNT_SECRETS - 1 && answers.at(-1) === "replaced" && kept.find((row) => row.name === "KEPT_0")?.sealed === "second" && answers.every((answer) => ["saved", "limit", "replaced"].includes(answer))) exact += 1;
	}
	expect(`secrets saved together never pass ${MAX_ACCOUNT_SECRETS}, and a new value for a saved name is taken at the limit too (20 rounds)`, exact === 20, `${exact} of 20`);
}

// ---- whom an account's secret reaches --------------------------------------------------------------

{
	const strict = accountSecretReach("TRACKER_TOKEN", "setup", STRICT, true);
	const open = accountSecretReach("TRACKER_TOKEN", "setup", OPEN, true);
	const unknown = accountSecretReach("TRACKER_TOKEN", "setup", UNKNOWN, true);
	expect("a secret for MCP servers only: where Windlass sandboxes every command, MCP servers get it and no command does", strict.servers && strict.commands === "no" && strict.note === null);
	expect("where commands are not held in Windlass's sandbox, or not known to be, nothing gets it, and the sentence says so", !open.servers && open.commands === "no" && !unknown.servers && unknown.commands === "no" && [open.note, unknown.note].every((note) => note !== null && note.endsWith("So nothing is given it there.") && !note.includes("setup command")), `${open.note}\n      ${unknown.note}`);
	const old = [accountSecretReach("TRACKER_TOKEN", "setup", STRICT, false), accountSecretReach("SENTRY_DSN", "setup", STRICT, false), accountSecretReach("TRACKER_TOKEN", "setup", OPEN, false)];
	expect("with an older Windlass, only a name that looks like a credential reaches MCP servers, and only where commands are sandboxed", old[0]?.servers === true && old[1]?.servers === false && old[2]?.servers === false && old.every((reach) => reach.commands === "no") && !plain(old).includes("setup command"));
	expect("in every kind of sandbox and with either Windlass, the commands never get it", [STRICT, OPEN, UNKNOWN].every((one) => [true, false].every((lists) => ["TRACKER_TOKEN", "SENTRY_DSN"].every((name) => accountSecretReach(name, "setup", one, lists).commands === "no"))));
	expect(
		"a secret that is also for the agent's commands reaches MCP servers and commands in every kind of sandbox, and nothing is said under it",
		[STRICT, OPEN, UNKNOWN].every((one) => ["TRACKER_TOKEN", "SENTRY_DSN"].every((name) => plain(accountSecretReach(name, "agent", one, true)) === plain({ servers: true, commands: "yes", note: null }))),
	);
	expect("what either scope reaches is what a repository's secret of that scope reaches", [STRICT, OPEN, UNKNOWN].every((one) => (["setup", "agent"] as const).every((scope) => [true, false].every((lists) => plain({ ...accountSecretReach("DEPLOY_KEY", scope, one, lists), note: null }) === plain({ ...secretReach("DEPLOY_KEY", scope, one, lists), note: null })))));
	const olderAgent = [STRICT, OPEN, UNKNOWN].flatMap((one) => ["TRACKER_TOKEN", "SENTRY_DSN"].map((name) => accountSecretReach(name, "agent", one, false)));
	expect("with an older Windlass it reaches MCP servers too, and no sentence about it speaks of a setup command", olderAgent.every((reach) => reach.servers) && !plain(olderAgent).includes("setup command") && olderAgent.some((reach) => reach.note?.endsWith("MCP servers get it.") === true));
	expect(
		"a session's panel is told which of them its sandbox hands to servers, and nothing where it hands them all over",
		accountSecretsNote(STRICT, true) === null &&
			[accountSecretsNote(OPEN, true), accountSecretsNote(UNKNOWN, true)].every((note) => note !== null && note.includes("only those that are also for the agent's commands") && note.includes("does not start")) &&
			accountSecretsNote(STRICT, false)?.includes("for MCP servers only") === true,
	);
}

{
	const tracker = value();
	const repositorys = value();
	const account: OpenedAccountSecret[] = [
		{ name: "TRACKER_TOKEN", scope: "setup", value: tracker },
		{ name: "SHARED_KEY", scope: "setup", value: value() },
		{ name: "SENTRY_DSN", scope: "setup", value: value() },
	];
	const repository: OpenedSecret[] = [
		{ name: "SHARED_KEY", scope: "agent", value: repositorys },
		{ name: "NPM_TOKEN", scope: "setup", value: value() },
	];

	const alone = turnEnvironment([], account, STRICT, true);
	expect("with no repository, Windlass is handed every one of the account's secrets, each named as withheld from the agent's commands", plain(Object.keys(alone.env).sort()) === plain(["SENTRY_DSN", "SHARED_KEY", "TRACKER_TOKEN"]) && plain([...alone.withholdEnv].sort()) === plain(["SENTRY_DSN", "SHARED_KEY", "TRACKER_TOKEN"]) && alone.passEnv.length === 0);

	const both = turnEnvironment(repository, account, STRICT, true);
	expect("a repository's secret of the same name wins: its value is the one handed over", both.env.SHARED_KEY === repositorys && both.env.TRACKER_TOKEN === tracker);
	expect("and its scope is the one that holds: the repository's is for the agent's commands, so it is not withheld, and passed on by name", !both.withholdEnv.includes("SHARED_KEY") && both.passEnv.includes("SHARED_KEY") && both.withholdEnv.includes("TRACKER_TOKEN") && both.withholdEnv.includes("NPM_TOKEN"));
	expect("the account's secrets a session is handed are those no secret of its repository has the name of", plain(accountSecretsFor(account, repository).map((secret) => secret.name)) === plain(["TRACKER_TOKEN", "SENTRY_DSN"]));

	const setup = setupEnvironment(repository);
	expect("the repository's setup command is handed the repository's secrets and none of the account's", plain(Object.keys(setup).sort()) === plain(["NPM_TOKEN", "SHARED_KEY"]) && setup.SHARED_KEY === repositorys);

	for (const [name, kind] of [
		["commands run without Windlass's sandbox", OPEN],
		["nothing is promised of commands", UNKNOWN],
	] as const) {
		const there = turnEnvironment(repository, account, kind, true);
		expect(`where ${name}, Windlass is handed none of the account's secrets: only the repository's secret for the agent's commands`, plain(Object.keys(there.env)) === plain(["SHARED_KEY"]) && there.env.SHARED_KEY === repositorys && there.withholdEnv.length === 0);
	}
	// One that is also for the agent's commands is handed over where commands are not sandboxed too, and a server that reads it starts there.
	const wide: OpenedAccountSecret[] = [...account, { name: "WIKI_TOKEN", scope: "agent", value: value() }, { name: "PREVIEW_HOST", scope: "agent", value: value() }];
	for (const [name, kind] of [
		["commands run without Windlass's sandbox", OPEN],
		["nothing is promised of commands", UNKNOWN],
	] as const) {
		const there = turnEnvironment([], wide, kind, true);
		expect(`where ${name}, an account's secret that is also for the agent's commands is handed over, and no other`, plain(Object.keys(there.env).sort()) === plain(["PREVIEW_HOST", "WIKI_TOKEN"]) && there.withholdEnv.length === 0 && plain(there.passEnv) === plain(["WIKI_TOKEN"]));
	}
	const sandboxed = turnEnvironment([], wide, STRICT, true);
	expect("where commands are sandboxed it is not withheld, and passed on by name where its name would keep it from them", !sandboxed.withholdEnv.includes("WIKI_TOKEN") && !sandboxed.withholdEnv.includes("PREVIEW_HOST") && plain(sandboxed.passEnv) === plain(["WIKI_TOKEN"]) && sandboxed.withholdEnv.includes("TRACKER_TOKEN"));
	const older = turnEnvironment([], account, STRICT, false);
	expect("an older Windlass is handed only the ones its own rule keeps from commands, and no lists", plain(Object.keys(older.env).sort()) === plain(["SHARED_KEY", "TRACKER_TOKEN"]) && older.withholdEnv.length === 0 && older.passEnv.length === 0);

	// Whatever a session shows has every saved value taken out, also the account's that the repository's stands in for.
	const redactor = new SecretRedactor([...repository, ...account]);
	const shown = redactor.text(`a=${tracker} b=${repositorys} c=${account[1]?.value}`);
	expect("both values of a shared name, and every other, are taken out of what a session shows", !shown.includes(tracker) && !shown.includes(repositorys) && !shown.includes(String(account[1]?.value)) && shown.includes("[secret:TRACKER_TOKEN]") && shown.includes("[secret:SHARED_KEY]"), shown.replace(/v_[\w-]+/g, "<value>"));
}

{
	// The question about a project's server that reads a secret of the account says whose it is.
	const context = { profile: STRICT, demo: false, dataInSandbox: true, project: { kind: "github" as const, label: "acme/harbor" }, secrets: [], envLists: true, accountSecrets: ["TRACKER_TOKEN"] };
	const question = { name: "harbor", fingerprint: "f", argv: ["python3", "harbor.py"], url: null, file: "/workspace/.windlass/config.json", unset: [], holdsTurn: true };
	const mine = serverQuestionWords({ ...question, secrets: ["TRACKER_TOKEN"] }, context).details.join(" ");
	const mixed = serverQuestionWords({ ...question, secrets: ["NPM_TOKEN", "TRACKER_TOKEN"] }, context).details.join(" ");
	const theirs = serverQuestionWords({ ...question, secrets: ["NPM_TOKEN"] }, context).details.join(" ");
	const named = serverQuestionWords(question, { ...context, machine: { name: "nas" } });
	const unnamed = serverQuestionWords({ ...question, argv: null, url: "https://example.com/mcp" }, { ...context, machine: { name: null } });
	expect("the start question names the machine kept at launch and its network", named.details[0]?.startsWith(`It runs in this session's container on your machine "nas", with its network,`) === true);
	expect("without a name the address question still says where the data leaves", unnamed.details[0] === "Nothing is started: Windlass reaches it at that address from this session's container on your machine, with its network, outside its sandbox around commands, and what the agent sends it leaves your machine.");
	expect("approving a project's server that reads an account's secret is said to hand it that secret, as the account's", mine.includes("the secret TRACKER_TOKEN of your account") && mine.includes("approving gives its value to the server") && !mine.includes("saved for this repository"));
	expect("with a repository's secret beside it, each is named for what it is", mixed.includes("the secret NPM_TOKEN saved for this repository, and the secret TRACKER_TOKEN of your account") && mixed.includes("approving gives their values to the server"));
	expect("a repository's secret alone is said as it always was", theirs.includes("Its definition reads the secret NPM_TOKEN saved for this repository: approving gives its value to the server."));
}

// ---- what a personal server can reach, in the words of the question about a project's ------------------

{
	const context = { demo: false, dataInSandbox: true, project: { kind: "github" as const, label: "acme/harbor" } };
	const asked = (kind: SandboxProfile, argv: string[] | null) => serverQuestionWords({ name: "harbor", fingerprint: "f", argv, url: argv === null ? "https://example.com/mcp" : null, file: null, unset: [], holdsTurn: true }, { ...context, profile: kind }).details[0] ?? "";
	const said = personalServerReach([STRICT, OPEN, UNKNOWN, profile("daytona", { available: false })]);
	expect("it is said for each sandbox the deployment can run, and for none it cannot", plain(said.map((one) => one.profile)) === plain(["docker-windlass-sandbox", "docker-hardened", "e2b"]));
	expect(
		"each sentence is the question's own, said of a session's sandbox instead of this session's",
		[STRICT, OPEN, UNKNOWN].every((kind, index) => said[index]?.command === asked(kind, ["x"]).replace("this session's", "a session's") && said[index]?.address === asked(kind, null).replace("this session's", "a session's")),
		plain(said),
	);
	expect("it says what the brief of such a server is: outside Windlass's sandbox around commands, with the network and the session's access token", (said[0]?.command ?? "").includes("outside Windlass's sandbox around commands") && (said[0]?.command ?? "").includes("has the network") && (said[0]?.command ?? "").includes("the session's access token, which lasts about an hour"));
}

// ---- Windlass's configuration file in a sandbox ----------------------------------------------------

{
	const servers = (text: string | null | undefined) => (text ? ((JSON.parse(text) as { mcp?: { servers?: Record<string, { command?: string }> } }).mcp?.servers ?? {}) : {});
	// The platform writes no server of its own any more (its tools are host tools); one handed in under its name still goes last and wins.
	const publish = { name: PUBLISH_SERVER, definition: { command: "python3" } };
	const tracker = { name: "tracker", definition: { command: "tracker-mcp" } };
	const docs = { name: "docs", definition: { url: "https://docs.example.com/mcp" } };
	/** What the file holds when the platform has nothing in it but its own setting: wake-ups off. */
	const wakeOnly = `${JSON.stringify({ wake: PLATFORM_WAKE }, null, 2)}\n`;

	const first = platformConfig(null, null, [tracker, docs, publish]);
	expect("the user's servers and the platform's own go into a file that is not there", first !== null && plain(Object.keys(servers(first.config))) === plain(["tracker", "docs", PUBLISH_SERVER]) && first.changed && first.written !== null);

	// The next turn: one server was deleted, and the earlier turn never took its own out.
	const second = platformConfig(first?.config ?? null, first?.written ?? null, [tracker]);
	expect("a sandbox that has the file from an earlier turn gets the list as it is now: a deleted server is gone, and so is the platform's when it is not offered", second !== null && plain(Object.keys(servers(second.config))) === plain(["tracker"]));
	const none = platformConfig(second?.config ?? null, second?.written ?? null, []);
	expect("with nothing to write, a file that held nothing else keeps only the platform's wake-ups off, and the platform's list goes", none !== null && none.config === wakeOnly && none.written === null && none.changed);
	expect("a sandbox that never had the file gets one that turns wake-ups off, and that file is not written again", plain(platformConfig(null, null, [])) === plain({ config: wakeOnly, written: null, changed: true }) && platformConfig(wakeOnly, null, [])?.changed === false);

	// A file that is not the platform's alone: a setup command wrote one.
	const theirs = JSON.stringify({ approval: { untrustedPaths: ["**"] }, mcp: { servers: { local: { command: "local-mcp" }, tracker: { command: "their-tracker" } } } });
	const beside = platformConfig(theirs, null, [tracker, publish]);
	expect("what the file holds besides is kept, and a server of the same name gives way to the account's for the turn", beside !== null && plain(Object.entries(servers(beside.config)).map(([name, definition]) => [name, definition.command])) === plain([["local", "local-mcp"], ["tracker", "tracker-mcp"], [PUBLISH_SERVER, "python3"]]) && (JSON.parse(beside.config as string) as { approval: unknown }).approval !== undefined);
	const after = platformConfig(beside?.config ?? null, beside?.written ?? null, []);
	expect("taken out again, the file is what it was, with the server that gave way back in its place, and wake-ups off", after !== null && plain(JSON.parse(after.config as string)) === plain({ ...JSON.parse(theirs), wake: PLATFORM_WAKE }) && after.written === null);
	expect("a file the platform has nothing in, and nothing to add to, is not written again", platformConfig(after?.config ?? null, null, [])?.changed === false);
	expect("whatever a command left under wake, the file turns wake-ups off", JSON.parse(platformConfig(JSON.stringify({ wake: { enabled: true, maxActive: 10 } }), null, [])?.config ?? "{}").wake?.enabled === false);

	// A user's server cannot take the platform's name, by any way.
	const impostor = { name: PUBLISH_SERVER, definition: { command: "impostor" } };
	const tried = platformConfig(null, null, [impostor, publish]);
	expect("whatever is written under the platform's own name before it, the platform's own is what the file has", servers(tried?.config)[PUBLISH_SERVER]?.command === "python3" && Object.keys(servers(tried?.config)).length === 1);
	const planted = JSON.stringify({ mcp: { servers: { [PUBLISH_SERVER]: { command: "planted" } } } });
	expect("a server planted under that name in the sandbox's file goes when the platform's is not offered, and is not put back after one that is", plain(servers(platformConfig(planted, null, [tracker])?.config)) === plain({ tracker: { command: "tracker-mcp" } }) && platformConfig(platformConfig(planted, null, [publish])?.config ?? null, platformConfig(planted, null, [publish])?.written ?? null, [])?.config === wakeOnly);

	// The platform's list is in the sandbox, where a command that runs unsandboxed can write it: nothing is assumed of it.
	const forged = [JSON.stringify({ names: ["local"], replaced: { local: "not a definition", [PUBLISH_SERVER]: { command: "forged" } } }), "{ not json", "[]", JSON.stringify({ names: "local" })];
	expect(
		"a list that is not what the platform writes takes out no more than the names it holds, and puts nothing back under the platform's name",
		forged.every((list) => {
			const next = platformConfig(theirs, list, [publish]);
			return next !== null && servers(next.config)[PUBLISH_SERVER]?.command === "python3" && servers(next.config).tracker?.command === "their-tracker";
		}),
	);
	expect("a file that is not Windlass's configuration is left alone, with or without servers to write", ["{ not json", "[]", JSON.stringify({ mcp: [] }), JSON.stringify({ mcp: { servers: [] } })].every((text) => platformConfig(text, null, [tracker]) === null && platformConfig(text, null, []) === null));
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
