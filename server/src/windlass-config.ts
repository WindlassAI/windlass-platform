/**
 * The platform writes the user's MCP servers into Windlass's configuration for each turn.
 *
 * Windlass starts by itself the servers its user's own configuration file names
 * (`~/.config/windlass/config.json`; a server a repository's file names waits for approval). The
 * platform uses that for the MCP servers of the session's user (personal-servers.ts): they go into
 * that file before the turn's Windlass opens its session, and are taken out again when the turn has
 * ended (sandbox/turn.ts). The platform's own tools for the agent are not servers: they are declared
 * when the session is opened (agent-publish.ts).
 *
 * The file is not the platform's alone: the sandbox's image has none, but a repository's setup command
 * runs as the sandbox's user and may write one. So whatever else the file holds is kept, and what the
 * platform wrote is known from a list of its own beside it (`PLATFORM_SERVERS_FILE`): the names it
 * put there, and, for a name the file already had, the definition it stood in for, which is put back
 * when the platform's goes. With that list a turn can also undo what an earlier turn left behind
 * because its server stopped under it: a server its user has deleted since does not go on starting.
 *
 * The platform's own name (`PUBLISH_SERVER`) is no server's: no server of a user's may have it
 * (`isReservedServerName`), and a server a command leaves there under that name is removed.
 *
 * The file also turns wake-ups off (`wake.enabled: false`, Windlass's docs/wake-ups.md,
 * "Configuration"), for every session: a wake-up fires only while a Windlass server process runs,
 * and a session's sandbox is paused between turns, so nothing would ever deliver one, and a model
 * offered `wake_create` promises to come back and never does. Windlass decides it when a session
 * starts, so the setting is in the file before any session is opened, and stays there: `wake` is the
 * platform's alone, and a repository's file can only tighten it.
 *
 * `checks`, `requiredChecks` and `verify` in this file are the platform's alone: whatever
 * the file had under them goes, so that what Windlass holds to be its user's checks is what the user
 * saved and nothing a command left there, and its own defaults decide what is done with them (the
 * agent is sent back, three times at most).
 *
 * The layer reads the repository's own check settings to explain which checks ran.
 *
 * The file also holds one hook of the platform's (`TURN_TIME_HOOK`, Windlass's hooks/README.md): before each
 * shell call it refuses a `timeout` longer than what is left of the turn (`TURN_DEADLINE_FILE`, written at the
 * turn's start). Windlass lets a call ask for up to an hour, and a turn may run 45 minutes: a command that hangs
 * (a guest out of memory) would otherwise hold the turn to its end. A hook cannot change a call's arguments, so
 * the agent is told the most it may ask for and runs it again. The platform's hook is replaced each time by name;
 * the file's other hooks stay.
 *
 * Nothing here runs anything or touches a file: these are the texts, and sandbox/turn.ts reads and
 * writes them.
 */

import { PUBLISH_SERVER } from "./agent-publish.js";

/** Windlass's configuration file of the sandbox's user. */
export const WINDLASS_CONFIG_FILE = "/home/agent/.config/windlass/config.json";
/** The platform's list of the servers it wrote into that file. */
export const PLATFORM_SERVERS_FILE = "/home/agent/.local/state/windlass-platform-servers.json";

/** When the turn at hand ends, in seconds since the epoch by the sandbox's own clock: written at its start, removed at its end. */
export const TURN_DEADLINE_FILE = "/home/agent/.local/state/windlass-platform-turn-deadline";
/** The platform's hook's name: no hook of the file's under it is kept. */
export const TURN_TIME_HOOK_NAME = "windlass-platform-turn-time";
/** What is kept back of the turn for its end: the agent's last words and the platform's closing. */
export const TURN_CLOSE_SECONDS = 60;

/**
 * The hook (Windlass's `beforeTool`, for `shell`): exit 2 refuses the call with stdout as the reason. No deadline,
 * one that is not a number, or one long past (a file a turn that was cut off left) refuses nothing; neither does a
 * background call without a timeout, which the turn's end stops. The call's arguments are the event's JSON line on
 * stdin; a `"timeout"` inside the command's text is escaped there (`\"timeout\"`), so only the argument is read.
 */
const TURN_TIME_SCRIPT = [
	`d=$(cat ${TURN_DEADLINE_FILE} 2>/dev/null) || exit 0`,
	`case "$d" in ''|*[!0-9]*) exit 0;; esac`,
	`left=$(( d - $(date +%s) ))`,
	`[ "$left" -gt -300 ] || exit 0`,
	`e=$(cat)`,
	`t=$(printf '%s' "$e" | grep -o '[^\\]"timeout": *[0-9]*' | head -n 1 | grep -o '[0-9]*$')`,
	`if [ -z "$t" ]; then printf '%s' "$e" | grep -q '[^\\]"background": *true' && exit 0; t=120; fi`,
	`max=$(( left - ${TURN_CLOSE_SECONDS} ))`,
	`if [ "$max" -lt 5 ]; then echo "This turn ends in $(( left > 0 ? left : 0 )) seconds, so there is no time for another command. Stop here: say what is done and what is left."; exit 2; fi`,
	`if [ "$t" -gt "$max" ]; then echo "This turn ends in about $(( (left + 30) / 60 )) minutes, so a command may run at most $max seconds now. Run it again with a timeout of $max or less, or split it into shorter steps."; exit 2; fi`,
	"exit 0",
].join("\n");

/** The platform's hook as the file holds it: a hook that cannot run lets the call through (`onError: "allow"`). */
export const TURN_TIME_HOOK = { name: TURN_TIME_HOOK_NAME, tools: ["shell"], command: TURN_TIME_SCRIPT, timeoutSeconds: 5, onError: "allow" } as const;

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

/** The configuration always has `wake`; the list is absent when no server was written. */
export interface PlatformConfig {
	config: string;
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
 * The configuration file with the user's servers installed, and the list recording those changes.
 * and the list as the sandbox has them, null for one that is not there. What an earlier turn wrote is taken out first, and what it stood in for is put back;
 * then each server is written, the later of two of one name last, and a definition the file had
 * under its name is kept in the list. With no server and no check, that is the file as it was before
 * the platform wrote anything, less `checks`, `requiredChecks` and `verify`, and no list; it always
 * has the platform's `wake`, so it is never absent.
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

	// The file's own hooks stay; the platform's goes first among those before a call, in place of any of its name.
	const hooks = config.hooks === undefined ? {} : config.hooks;
	if (!isObject(hooks) || (hooks.beforeTool !== undefined && !Array.isArray(hooks.beforeTool))) return null;
	const theirs = ((hooks.beforeTool as unknown[] | undefined) ?? []).filter((hook) => !(isObject(hook) && hook.name === TURN_TIME_HOOK_NAME));
	const hooksNow = { ...hooks, beforeTool: [TURN_TIME_HOOK, ...theirs] };

	const { servers: _servers, ...restOfMcp } = mcp;
	// `checks`, `requiredChecks`, `verify` and `wake` are the platform's: what the file had under them goes.
	const { mcp: _mcp, checks: _checks, requiredChecks: _required, verify: _verify, wake: _wake, hooks: _hooks, ...rest } = config;
	const mcpNow = Object.keys(next).length > 0 ? { ...restOfMcp, servers: next } : restOfMcp;
	const configNow = { ...rest, ...(Object.keys(mcpNow).length > 0 ? { mcp: mcpNow } : {}), hooks: hooksNow, wake: PLATFORM_WAKE };
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
