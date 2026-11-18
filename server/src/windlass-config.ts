/**
 * Windlass's own configuration file in a sandbox, and the MCP servers the platform writes into it for
 * a turn.
 *
 * Windlass starts by itself the servers its user's own configuration file names
 * (`~/.config/windlass/config.json`; a server a repository's file names waits for approval). The
 * platform uses that for two things: the server of the tool by which the agent asks the platform to
 * publish (agent-publish.ts), and the MCP servers of the session's user (personal-servers.ts). Both go
 * into that one file before the turn's Windlass opens its session, and both are taken out again when
 * the turn has ended (sandbox/turn.ts).
 *
 * The file is not the platform's alone: the sandbox's image has none, but a repository's setup command
 * runs as the sandbox's user and may write one. So whatever else the file holds is kept, and what the
 * platform wrote is known from a list of its own beside it (`PLATFORM_SERVERS_FILE`): the names it
 * put there, and, for a name the file already had, the definition it stood in for, which is put back
 * when the platform's goes. With that list a turn can also undo what an earlier turn left behind
 * because its server stopped under it: a server its user has deleted since does not go on starting.
 *
 * The platform's own server is written last and under its own name, which no server of a user's may
 * have (`isReservedServerName`), so a user's definition can neither take its name nor replace it; and
 * a server left in the file under that name without the platform's list knowing of it is removed all
 * the same: the name is the platform's.
 *
 * Nothing here runs anything or touches a file: these are the texts, and sandbox/turn.ts reads and
 * writes them.
 */

import { PUBLISH_SERVER } from "./agent-publish.js";

/** Windlass's configuration file of the sandbox's user. */
export const WINDLASS_CONFIG_FILE = "/home/agent/.config/windlass/config.json";
/** The platform's list of the servers it wrote into that file, beside the directory the tool to publish keeps its answers in. */
export const PLATFORM_SERVERS_FILE = "/home/agent/.local/state/windlass-platform-servers.json";

/** A server as it goes into the file: its key in `mcp.servers`, and its definition as Windlass takes it. */
export interface ConfigServer {
	name: string;
	definition: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What the platform's list holds: the names it wrote, and what the file had under a name before. */
interface Written {
	names: string[];
	replaced: Record<string, unknown>;
}

/** The list as the sandbox has it. Nothing is assumed of it: what is not the shape the platform writes counts as no list. */
function writtenOf(text: string | null): Written {
	const none: Written = { names: [], replaced: {} };
	if (text === null || text.trim() === "") return none;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return none;
	}
	if (!isObject(parsed) || !Array.isArray(parsed.names)) return none;
	const names = parsed.names.filter((name): name is string => typeof name === "string");
	const replaced = isObject(parsed.replaced) ? Object.fromEntries(Object.entries(parsed.replaced).filter(([name, definition]) => names.includes(name) && isObject(definition))) : {};
	return { names, replaced };
}

/** The file and the list as they are to be: null for one that is to be absent. */
export interface PlatformConfig {
	config: string | null;
	written: string | null;
	/** False when the file already says exactly that, however it is spelled: it need not be written. */
	changed: boolean;
}

/** Whether two values of JSON's shapes say the same, whatever order their keys are in. */
function same(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((key) => key in b && same(a[key], b[key]));
	}
	return a === b;
}

/**
 * The configuration file with exactly `servers` in it as the platform's own, and the list that says
 * so. `text` and `written` are the file and the list as the sandbox has them, null for one that is
 * not there. What an earlier turn wrote is taken out first, and what it stood in for is put back;
 * then each server is written, the later of two of one name last, and a definition the file had
 * under its name is kept in the list. With no server, that is the file as it was before the platform
 * wrote anything, and no list.
 *
 * Null when the file is there and is not what Windlass reads (not JSON, or `mcp` or `mcp.servers` is
 * not an object): it is left alone then, and nothing is written.
 */
export function platformConfig(text: string | null, written: string | null, servers: readonly ConfigServer[]): PlatformConfig | null {
	let config: unknown = {};
	if (text !== null && text.trim() !== "") {
		try {
			config = JSON.parse(text);
		} catch {
			return null;
		}
	}
	if (!isObject(config)) return null;
	const mcp = config.mcp === undefined ? {} : config.mcp;
	if (!isObject(mcp)) return null;
	const there = mcp.servers === undefined ? {} : mcp.servers;
	if (!isObject(there)) return null;

	// What the platform wrote before goes, and so does anything under its own server's name.
	const before = writtenOf(written);
	const kept: Record<string, unknown> = {};
	for (const [name, definition] of Object.entries(there)) if (!before.names.includes(name) && name !== PUBLISH_SERVER) kept[name] = definition;
	for (const [name, definition] of Object.entries(before.replaced)) if (!(name in kept) && name !== PUBLISH_SERVER) kept[name] = definition;

	const now: Written = { names: [], replaced: {} };
	const next: Record<string, unknown> = { ...kept };
	for (const server of servers) {
		if (!now.names.includes(server.name)) now.names.push(server.name);
		if (server.name in kept) now.replaced[server.name] = kept[server.name];
		next[server.name] = server.definition;
	}

	const { servers: _servers, ...restOfMcp } = mcp;
	const { mcp: _mcp, ...rest } = config;
	const mcpNow = Object.keys(next).length > 0 ? { ...restOfMcp, servers: next } : restOfMcp;
	const configNow = Object.keys(mcpNow).length > 0 ? { ...rest, mcp: mcpNow } : rest;
	return {
		config: Object.keys(configNow).length === 0 ? null : `${JSON.stringify(configNow, null, 2)}\n`,
		written: now.names.length === 0 ? null : `${JSON.stringify(now)}\n`,
		// A file that is there and says nothing is left where it is.
		changed: !same(config, configNow),
	};
}
