/**
 * A user's own MCP servers: servers the user defines once, for their account, which Windlass then
 * starts (or reaches) in every session of theirs, whatever the repository (README, "Account settings").
 * This file has the rules: what a name and a definition may be, how many are kept, and how they are
 * stored.
 *
 * Whose they are. The user's, in their `user` actor, one row per server. They are never read from a
 * repository: a repository's own servers are in its `.windlass/config.json`, and Windlass asks before
 * it starts one of those (server-approvals.ts). A session reads its user's servers from the actor
 * when a turn starts, with the account's secrets (account-secrets.ts), and the sandbox layer writes
 * them into Windlass's own configuration file in the sandbox for that turn (windlass-config.ts).
 *
 * Windlass starts a server its user's own configuration names without asking. That is what makes
 * these servers work in every session, and it is why the settings page says, before one is saved,
 * what it gets (server-question.ts, `personalServerReach`): a process in the session's sandbox
 * machine, outside Windlass's sandbox around commands, with the network and Windlass's own data.
 *
 * What a definition may be. What Windlass's configuration takes for one server (its docs/mcp.md,
 * "The keys"; `packages/core/src/mcp/config.ts` in its source), held to here key by key. It has to
 * be: Windlass refuses a configuration file with a key it does not know or a value of the wrong
 * type, and a turn whose configuration is refused fails before anything is sent. So a definition
 * Windlass would refuse is refused when it is saved, with the key that is wrong, and what is stored
 * is rebuilt from the keys that are known. `scripts/account-check.ts` holds the list of keys against
 * Windlass's source when that is beside this repository.
 *
 * Names. A server's name is its key in Windlass's configuration, and Windlass's rule for one. The
 * platform's own server (`windlass_platform`, agent-publish.ts) keeps its name: no server of a user's
 * may have it, or one that begins with it.
 *
 * A definition is not a place for a credential. It is stored as it is written, shown again on the
 * settings page, written into a file in the sandbox and shown in a session's panel. A value a server
 * needs is saved as an account secret and read as `${NAME}` in `env` or `headers`. Nothing here logs
 * a definition, and nothing should: a user may put a token into an argument or an address by mistake.
 *
 * Saving. Each save is one statement, which reads nothing first: an added server is inserted only
 * while the account keeps fewer than it may, a changed one is updated by its name. So two saves that
 * run together both stay, neither undoes a secret or a default saved meanwhile (other tables), and
 * the limit holds however they interleave.
 *
 * This file has no actor in it: the `user` actor hands its database to these functions, and
 * scripts/account-check.ts runs them against a database of its own.
 */

import { PUBLISH_SERVER } from "./agent-publish.js";
import { MAX_PERSONAL_SERVERS, MAX_SERVER_DEFINITION_BYTES, MAX_SERVER_NAME_CHARS, type PersonalServer } from "./contract.js";
import type { DefaultsDb } from "./repository-defaults.js";
import { commandLine } from "./server-question.js";

/** Thrown for a server that cannot be saved; `message` is fit to show and repeats nothing of a definition but the name of a key. */
export class ServerProblem extends Error {
	constructor(
		readonly code: "bad_server" | "server_exists" | "server_not_found" | "too_many_servers",
		message: string,
	) {
		super(message);
		this.name = "ServerProblem";
	}
}

const bad = (message: string) => new ServerProblem("bad_server", message);

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** Windlass's rule for a server's name (`serverName`, its packages/core/src/mcp/config.ts). */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Whether a name is the platform's own server's, or begins with it, in any case of letters. */
export function isReservedServerName(name: string): boolean {
	return name.toLowerCase().startsWith(PUBLISH_SERVER);
}

/** The name as it is saved. Throws ServerProblem. */
export function cleanServerName(raw: unknown): string {
	if (typeof raw !== "string" || raw === "") throw bad("A server needs a name.");
	if (raw.length > MAX_SERVER_NAME_CHARS) throw bad(`A server's name can be at most ${MAX_SERVER_NAME_CHARS} characters long.`);
	if (!SERVER_NAME.test(raw)) throw bad("A server's name is made of letters, digits, '_', '.' and '-', and starts with a letter or a digit.");
	if (isReservedServerName(raw)) throw bad(`A name that begins with ${PUBLISH_SERVER} cannot be a server's: it is the platform's own server's, by which an agent asks to publish.`);
	return raw;
}

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

/** The keys of one server in Windlass's configuration (`serverFields`), in the order a definition is stored in. */
export const SERVER_KEYS = ["command", "args", "cwd", "env", "url", "headers", "tools", "timeoutSeconds", "startupTimeoutSeconds", "untrusted", "enabled", "protocol"] as const;
const TOOLS_KEYS = ["allow", "deny"] as const;
const PROTOCOLS = ["auto", "modern", "legacy"];
/** Windlass's limits for one call, and for starting (`MAX_CALL_TIMEOUT_SECONDS`, `MAX_STARTUP_TIMEOUT_SECONDS`). */
const MAX_CALL_SECONDS = 3600;
const MAX_STARTUP_SECONDS = 600;

const isObject = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

/** Text Windlass can take: no NUL, which neither an argument nor an environment variable can carry. */
function text(value: unknown, key: string, nonEmpty: boolean): string {
	if (typeof value !== "string" || (nonEmpty && value === "")) throw bad(`${key} must be ${nonEmpty ? "text that is not empty" : "text"}.`);
	if (value.includes("\0")) throw bad(`${key} holds a character that cannot be passed on.`);
	return value;
}

function textList(value: unknown, key: string, nonEmpty: boolean): string[] {
	if (!Array.isArray(value)) throw bad(`${key} must be a list of texts.`);
	return value.map((item, index) => text(item, `${key}[${index}]`, nonEmpty));
}

function textMap(value: unknown, key: string, names: "variables" | "any"): Record<string, string> {
	if (!isObject(value)) throw bad(`${key} must be an object whose values are texts.`);
	const map: Record<string, string> = {};
	for (const [name, item] of Object.entries(value)) {
		if (names === "variables" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw bad(`${key} has a key that is not an environment variable's name: letters, digits and underscores, not starting with a digit.`);
		if (name === "" || name.includes("\0")) throw bad(`${key} has a key that cannot be passed on.`);
		map[name] = text(item, `${key}.${name}`, false);
	}
	return map;
}

function whole(value: unknown, key: string, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw bad(`${key} must be a whole number from 1 to ${max}.`);
	return value;
}

function flag(value: unknown, key: string): boolean {
	if (typeof value !== "boolean") throw bad(`${key} must be true or false.`);
	return value;
}

function unknownKey(found: readonly string[], known: readonly string[], where: string): void {
	const unknown = found.find((key) => !known.includes(key));
	if (unknown === undefined) return;
	// The key is the user's own text: what is printable of it, and not all of a long one.
	const shown = unknown.replace(/[^\x20-\x7e]/g, "?").slice(0, 40);
	throw bad(`${where} has a key Windlass does not know, "${shown}". It takes: ${known.join(", ")}.`);
}

/**
 * A definition as it is saved: what a client sent, held to what Windlass takes for one server, and
 * rebuilt from the keys it knows in one order. Throws ServerProblem for anything Windlass would
 * refuse, for a server that is neither started nor reached, or both, and for one longer than
 * MAX_SERVER_DEFINITION_BYTES as JSON. The message names the key and never repeats a value.
 */
export function cleanServerDefinition(raw: unknown): Record<string, unknown> {
	if (!isObject(raw)) throw bad("A server's definition is an object, as Windlass's configuration takes it: a command to start, or an address to reach.");
	unknownKey(Object.keys(raw), SERVER_KEYS, "The definition");
	const out: Record<string, unknown> = {};
	if (raw.command !== undefined) out.command = text(raw.command, "command", true);
	if (raw.args !== undefined) out.args = textList(raw.args, "args", false);
	if (raw.cwd !== undefined) out.cwd = text(raw.cwd, "cwd", true);
	if (raw.env !== undefined) out.env = textMap(raw.env, "env", "variables");
	if (raw.url !== undefined) {
		const url = text(raw.url, "url", true);
		let parsed: URL | null = null;
		try {
			parsed = new URL(url);
		} catch {
			// Said below.
		}
		if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) throw bad("url must be an http or https address.");
		out.url = url;
	}
	if (raw.headers !== undefined) out.headers = textMap(raw.headers, "headers", "any");
	if (raw.tools !== undefined) {
		if (!isObject(raw.tools)) throw bad("tools must be an object with allow and deny, each a list of tool names.");
		unknownKey(Object.keys(raw.tools), TOOLS_KEYS, "tools");
		const tools: Record<string, string[]> = {};
		for (const key of TOOLS_KEYS) if (raw.tools[key] !== undefined) tools[key] = textList(raw.tools[key], `tools.${key}`, true);
		out.tools = tools;
	}
	if (raw.timeoutSeconds !== undefined) out.timeoutSeconds = whole(raw.timeoutSeconds, "timeoutSeconds", MAX_CALL_SECONDS);
	if (raw.startupTimeoutSeconds !== undefined) out.startupTimeoutSeconds = whole(raw.startupTimeoutSeconds, "startupTimeoutSeconds", MAX_STARTUP_SECONDS);
	if (raw.untrusted !== undefined) out.untrusted = flag(raw.untrusted, "untrusted");
	if (raw.enabled !== undefined) out.enabled = flag(raw.enabled, "enabled");
	if (raw.protocol !== undefined) {
		if (typeof raw.protocol !== "string" || !PROTOCOLS.includes(raw.protocol)) throw bad(`protocol must be one of ${PROTOCOLS.join(", ")}.`);
		out.protocol = raw.protocol;
	}

	// Windlass checks these once the files are merged; here there is one file's worth, and it has to be whole.
	if (out.command !== undefined && out.url !== undefined) throw bad("A definition has a command or a url, not both: a server is either started or reached.");
	if (out.command === undefined && out.url === undefined) throw bad("A definition needs a command (a server to start) or a url (a server to reach).");
	if (out.command !== undefined && out.headers !== undefined) throw bad("headers applies only to a server reached by a url.");
	if (out.url !== undefined) {
		const misplaced = (["args", "cwd", "env"] as const).find((key) => out[key] !== undefined);
		if (misplaced !== undefined) throw bad(`${misplaced} applies only to a server started by a command.`);
	}

	const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
	if (bytes > MAX_SERVER_DEFINITION_BYTES) throw bad(`A server's definition can be at most ${MAX_SERVER_DEFINITION_BYTES.toLocaleString("en-US")} bytes long as JSON; this one is ${bytes.toLocaleString("en-US")}.`);
	return out;
}

/** `${NAME}` in a value of a definition: Windlass's own pattern (its packages/core/src/mcp/config.ts). */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The variables a definition reads: every `${NAME}` in the values of its `env` and `headers`, in order of first appearance. */
export function definitionReads(definition: Record<string, unknown>): string[] {
	const names: string[] = [];
	for (const key of ["env", "headers"]) {
		const values = definition[key];
		if (!isObject(values)) continue;
		for (const value of Object.values(values)) {
			if (typeof value !== "string") continue;
			for (const match of value.matchAll(VARIABLE)) if (match[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
		}
	}
	return names;
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

/** One row per server: `definition` is JSON, as `cleanServerDefinition` made it. */
export const PERSONAL_SERVERS_TABLE = `
	CREATE TABLE IF NOT EXISTS personal_server (
		name TEXT PRIMARY KEY,
		definition TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)
`;

/** A server as it is stored. */
export interface StoredServer {
	name: string;
	definition: Record<string, unknown>;
	updatedAt: number;
}

/** The account's servers, by name. A row that cannot be read as a definition is left out: it would fail every turn. */
export async function readServers(db: DefaultsDb): Promise<StoredServer[]> {
	const rows = await db.execute<{ name: string; definition: string; updated_at: number }>("SELECT name, definition, updated_at FROM personal_server ORDER BY name");
	const servers: StoredServer[] = [];
	for (const row of rows) {
		try {
			// Held to the rules again: what is handed to a turn is what Windlass takes, whatever the row came to hold.
			servers.push({ name: cleanServerName(row.name), definition: cleanServerDefinition(JSON.parse(String(row.definition))), updatedAt: Number(row.updated_at) });
		} catch {
			// Left out.
		}
	}
	return servers;
}

/**
 * Adds a server whose name and definition were cleaned already. One statement inserts it, and only
 * while the account keeps fewer than `limit`: nothing is counted first, so servers added together
 * cannot pass the limit between them. Throws ServerProblem when a server of that name is saved
 * (`server_exists`: it is not replaced) and at the limit (`too_many_servers`).
 */
export async function addServer(db: DefaultsDb, name: string, definition: Record<string, unknown>, now: number, limit = MAX_PERSONAL_SERVERS): Promise<void> {
	const stored = JSON.stringify(definition);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await db.execute(
			"INSERT INTO personal_server (name, definition, updated_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM personal_server) < ? ON CONFLICT (name) DO NOTHING",
			name,
			stored,
			now,
			limit,
		);
		const [row] = await db.execute<{ definition: string; updated_at: number }>("SELECT definition, updated_at FROM personal_server WHERE name = ?", name);
		if (row) {
			if (row.definition === stored && Number(row.updated_at) === now) return;
			throw new ServerProblem("server_exists", `A server named ${name} is saved already. Change that one, or give this one another name.`);
		}
		const [count] = await db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM personal_server");
		if (Number(count?.n ?? 0) >= limit) throw new ServerProblem("too_many_servers", `An account can keep ${limit} MCP servers, and yours has that many. Delete one first.`);
		// Neither saved nor at the limit: a server was deleted between the two statements. Once more.
	}
	throw new Error("the server could not be saved");
}

/** Replaces the definition of the server of that name. Throws ServerProblem (`server_not_found`) when none is saved. */
export async function changeServer(db: DefaultsDb, name: string, definition: Record<string, unknown>, now: number): Promise<void> {
	await db.execute("UPDATE personal_server SET definition = ?, updated_at = ? WHERE name = ?", JSON.stringify(definition), now, name);
	const [row] = await db.execute<{ name: string }>("SELECT name FROM personal_server WHERE name = ?", name);
	if (!row) throw new ServerProblem("server_not_found", `No server named ${name} is saved any more. Add it again.`);
}

export async function deleteServer(db: DefaultsDb, name: string): Promise<void> {
	await db.execute("DELETE FROM personal_server WHERE name = ?", name);
}

// ---------------------------------------------------------------------------------------------
// As the settings page lists them
// ---------------------------------------------------------------------------------------------

/** A stored server as a client is sent it. `secrets` are the names of the account's secrets. */
export function listedServer(server: StoredServer, secrets: ReadonlySet<string>): PersonalServer {
	const { definition } = server;
	const remote = typeof definition.url === "string";
	const argv = remote ? [] : [String(definition.command ?? ""), ...(Array.isArray(definition.args) ? definition.args.map(String) : [])];
	return {
		name: server.name,
		definition,
		remote,
		subject: remote ? String(definition.url) : commandLine(argv),
		enabled: definition.enabled !== false,
		reads: definitionReads(definition).map((name) => ({ name, saved: secrets.has(name) })),
		updatedAt: server.updatedAt,
	};
}
