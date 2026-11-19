/**
 * Windlass's own configuration file in a sandbox, and what the platform writes into it for a turn:
 * MCP servers, and the checks of the session's repository.
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
 * The checks the session's user saved for its repository (repository-checks.ts) are not in this file
 * where Windlass takes required checks: they are named when the session is opened, by the process
 * that opens it, and no file in the sandbox holds them (sandbox/turn.ts). For a Windlass that takes
 * none they go into the same file the same way, as its `checks`: Windlass takes its user's checks
 * from there, runs them before a turn ends and sends the agent back with what fails.
 *
 * The file also turns wake-ups off (`wake.enabled: false`, Windlass's docs/wake-ups.md,
 * "Configuration"), for every session: a wake-up fires only while a Windlass server process runs,
 * and a session's sandbox is paused between turns, so nothing would ever deliver one, and a model
 * offered `wake_create` promises to come back and never does. Windlass decides it when a session
 * starts, so the setting is in the file before any session is opened, and stays there: `wake` is the
 * platform's alone, and a repository's file can only tighten it.
 *
 * Either way `checks`, `requiredChecks` and `verify` in this file are the platform's alone: whatever
 * the file had under them goes, so that what Windlass holds to be its user's checks is what the user
 * saved and nothing a command left there, and its own defaults decide what is done with them (the
 * agent is sent back, three times at most).
 *
 * A repository's own `.windlass/config.json` is not the platform's to write. A Windlass without
 * required checks follows it before its user's file, key by key: a `checks` list there stands in
 * for the user's whole, and `verify` there can turn the gate off (its docs/user-guide.md, "Project
 * configuration"; tried against Windlass 0.2.0, scripts/verified-check.ts), and it reports neither.
 * So the layer reads that file when it writes its own, and `projectChecks` says what it holds on
 * the matter: for such a Windlass that is how the platform knows whose checks a turn ran, and for
 * every Windlass it is how a turn that verified nothing can say which file is why.
 *
 * Nothing here runs anything or touches a file: these are the texts, and sandbox/turn.ts reads and
 * writes them.
 */

import { PUBLISH_SERVER } from "./agent-publish.js";

/** Windlass's configuration file of the sandbox's user. */
export const WINDLASS_CONFIG_FILE = "/home/agent/.config/windlass/config.json";
/** The platform's list of the servers it wrote into that file, beside the directory the tool to publish keeps its answers in. */
export const PLATFORM_SERVERS_FILE = "/home/agent/.local/state/windlass-platform-servers.json";

/** The file's `wake` section: no session the platform opens is offered the wake-up tools. */
export const PLATFORM_WAKE = { enabled: false } as const;

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

/** The file and the list as they are to be: null for one that is to be absent (the file never is: it has `wake`). */
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
 * The configuration file with exactly `servers` in it as the platform's own and `checks` as its
 * checks, and the list that says which servers are the platform's. `text` and `written` are the file
 * and the list as the sandbox has them, null for one that is not there. What an earlier turn wrote is taken out first, and what it stood in for is put back;
 * then each server is written, the later of two of one name last, and a definition the file had
 * under its name is kept in the list. With no server and no check, that is the file as it was before
 * the platform wrote anything, less `checks`, `requiredChecks` and `verify`, and no list; it always
 * has the platform's `wake`, so it is never absent.
 *
 * Null when the file is there and is not what Windlass reads (not JSON, or `mcp` or `mcp.servers` is
 * not an object): it is left alone then, and nothing is written.
 */
export function platformConfig(text: string | null, written: string | null, servers: readonly ConfigServer[], checks: readonly Record<string, unknown>[] = []): PlatformConfig | null {
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
	// `checks`, `requiredChecks`, `verify` and `wake` are the platform's: what the file had under them goes.
	const { mcp: _mcp, checks: _checks, requiredChecks: _required, verify: _verify, wake: _wake, ...rest } = config;
	const mcpNow = Object.keys(next).length > 0 ? { ...restOfMcp, servers: next } : restOfMcp;
	const configNow = { ...rest, ...(Object.keys(mcpNow).length > 0 ? { mcp: mcpNow } : {}), ...(checks.length > 0 ? { checks } : {}), wake: PLATFORM_WAKE };
	return {
		config: `${JSON.stringify(configNow, null, 2)}\n`,
		written: now.names.length === 0 ? null : `${JSON.stringify(now)}\n`,
		// A file that already says all of it is left where it is.
		changed: !same(config, configNow),
	};
}

/** What a repository's own configuration file says about checks. */
export interface ProjectChecks {
	/** How many checks it names; null when it has no `checks`. A list, an empty one too, stands in for the user's. */
	checks: number | null;
	/** Its `verify.mode` ("off", "report", "gate"); null when it sets none. */
	verify: string | null;
}

/**
 * What the repository's `.windlass/config.json` says about checks, from its text: null for a file
 * that is not there or is not a JSON object. Windlass refuses to start a turn on a file it cannot
 * read, so a file that says nothing here either says nothing to Windlass or stops the turn.
 */
export function projectChecks(text: string | null): ProjectChecks | null {
	if (text === null || text.trim() === "") return null;
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(config)) return null;
	const verify = isObject(config.verify) && typeof config.verify.mode === "string" ? config.verify.mode : null;
	return { checks: Array.isArray(config.checks) ? config.checks.length : null, verify };
}
