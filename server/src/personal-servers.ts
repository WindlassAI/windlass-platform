/**
 * Account-owned MCP servers start without a per-repository approval. Store validated definitions
 * without logging them, and enforce the account limit in the insert so concurrent saves cannot race.
 */
import { MAX_PERSONAL_SERVERS, type PersonalServer } from "./contract.js";
import {
	ServerProblem,
	cleanServerName,
	cleanServerDefinition,
	definitionReads,
} from "./personal-server-definition.js";
import type { DefaultsDb } from "./repository-defaults.js";
import { commandLine } from "./server-question.js";

export {
	ServerProblem,
	SERVER_KEYS,
	cleanServerName,
	cleanServerDefinition,
	definitionReads,
	isReservedServerName,
} from "./personal-server-definition.js";

/** One row per server: `definition` is JSON, as `cleanServerDefinition` made it; `unasked` is 1 where its tools run without asking. */
export const PERSONAL_SERVERS_TABLE = `
	CREATE TABLE IF NOT EXISTS personal_server (
		name TEXT PRIMARY KEY,
		definition TEXT NOT NULL,
		unasked INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL
	)
`;

/** A server as it is stored. */
export interface StoredServer {
	name: string;
	definition: Record<string, unknown>;
	/** Its tools run without asking: the platform answers Windlass's question about a call of one for the user. */
	unasked: boolean;
	updatedAt: number;
}

/** The setting as it is saved: on only when a client said exactly that. */
export function cleanUnasked(raw: unknown): boolean {
	if (raw === undefined || typeof raw === "boolean") return raw === true;
	throw new ServerProblem("bad_server", "Whether a server's tools run without asking is true or false.");
}

/** The account's servers, by name. A row that cannot be read as a definition is left out: it would fail every turn. */
export async function readServers(db: DefaultsDb): Promise<StoredServer[]> {
	const rows = await db.execute<{ name: string; definition: string; unasked: number; updated_at: number }>(
		"SELECT name, definition, unasked, updated_at FROM personal_server ORDER BY name",
	);
	const servers: StoredServer[] = [];
	for (const row of rows) {
		try {
			// Held to the rules again: what is handed to a turn is what Windlass takes, whatever the row came to hold.
			servers.push({
				name: cleanServerName(row.name),
				definition: cleanServerDefinition(JSON.parse(String(row.definition))),
				unasked: Number(row.unasked) === 1,
				updatedAt: Number(row.updated_at),
			});
		} catch {
			// Left out.
		}
	}
	return servers;
}

/**
 * Adds a server whose name, definition and setting were cleaned already. One statement inserts it, and only
 * while the account keeps fewer than `limit`: nothing is counted first, so servers added together
 * cannot pass the limit between them. Throws ServerProblem when a server of that name is saved
 * (`server_exists`: it is not replaced) and at the limit (`too_many_servers`).
 */
export async function addServer(
	db: DefaultsDb,
	name: string,
	definition: Record<string, unknown>,
	unasked: boolean,
	now: number,
	limit = MAX_PERSONAL_SERVERS,
): Promise<void> {
	const stored = JSON.stringify(definition);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await db.execute(
			"INSERT INTO personal_server (name, definition, unasked, updated_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM personal_server) < ? ON CONFLICT (name) DO NOTHING",
			name,
			stored,
			unasked ? 1 : 0,
			now,
			limit,
		);
		const [row] = await db.execute<{ definition: string; updated_at: number }>(
			"SELECT definition, updated_at FROM personal_server WHERE name = ?",
			name,
		);
		if (row) {
			if (row.definition === stored && Number(row.updated_at) === now) return;
			throw new ServerProblem(
				"server_exists",
				`A server named ${name} is saved already. Change that one, or give this one another name.`,
			);
		}
		const [count] = await db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM personal_server");
		if (Number(count?.n ?? 0) >= limit)
			throw new ServerProblem(
				"too_many_servers",
				`An account can keep ${limit} MCP servers, and yours has that many. Delete one first.`,
			);
		// Neither saved nor at the limit: a server was deleted between the two statements. Once more.
	}
	throw new Error("the server could not be saved");
}

/** Replaces the definition and the setting of the server of that name. Throws ServerProblem (`server_not_found`) when none is saved. */
export async function changeServer(
	db: DefaultsDb,
	name: string,
	definition: Record<string, unknown>,
	unasked: boolean,
	now: number,
): Promise<void> {
	await db.execute(
		"UPDATE personal_server SET definition = ?, unasked = ?, updated_at = ? WHERE name = ?",
		JSON.stringify(definition),
		unasked ? 1 : 0,
		now,
		name,
	);
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
	const argv = remote
		? []
		: [String(definition.command ?? ""), ...(Array.isArray(definition.args) ? definition.args.map(String) : [])];
	return {
		name: server.name,
		definition,
		remote,
		subject: remote ? String(definition.url) : commandLine(argv),
		enabled: definition.enabled !== false,
		unasked: server.unasked,
		reads: definitionReads(definition).map(name => ({ name, saved: secrets.has(name) })),
		updatedAt: server.updatedAt,
	};
}

// ---------------------------------------------------------------------------------------------
// As a session's timeline says it
// ---------------------------------------------------------------------------------------------

/** The line under a call the platform allowed for the user because their settings let that server's tools run without asking. */
export function unaskedNote(server: string): string {
	return `Allowed for you without asking: your settings let the tools of your MCP server "${server}" run that way.`;
}
