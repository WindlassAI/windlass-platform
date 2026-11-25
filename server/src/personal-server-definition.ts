/** Validate account MCP definitions before storage or mock replay. */
import { MAX_SERVER_DEFINITION_BYTES, MAX_SERVER_NAME_CHARS } from "./contract.js";

/** User servers cannot impersonate the platform's own tools. */
export const PUBLISH_SERVER = "windlass_platform";

/** Messages reach the UI. Name invalid keys without repeating their values. */
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

/** Windlass's rule for a server's name (`serverName`, its packages/core/src/mcp/config.ts). */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isReservedServerName(name: string): boolean {
	return name.toLowerCase().startsWith(PUBLISH_SERVER);
}

export function cleanServerName(raw: unknown): string {
	if (typeof raw !== "string" || raw === "") throw bad("A server needs a name.");
	if (raw.length > MAX_SERVER_NAME_CHARS) throw bad(`A server's name can be at most ${MAX_SERVER_NAME_CHARS} characters long.`);
	if (!SERVER_NAME.test(raw)) throw bad("A server's name is made of letters, digits, '_', '.' and '-', and starts with a letter or a digit.");
	if (isReservedServerName(raw)) throw bad(`A name that begins with ${PUBLISH_SERVER} cannot be a server's: it is the platform's own, and a server by that name would pass for the platform's tools.`);
	return raw;
}

/** Keep the storage order aligned with Windlass's serverFields. */
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

	const bytes = new TextEncoder().encode(JSON.stringify(out)).byteLength;
	if (bytes > MAX_SERVER_DEFINITION_BYTES) throw bad(`A server's definition can be at most ${MAX_SERVER_DEFINITION_BYTES.toLocaleString("en-US")} bytes long as JSON; this one is ${bytes.toLocaleString("en-US")}.`);
	return out;
}

/** `${NAME}` in a value of a definition: Windlass's own pattern (its packages/core/src/mcp/config.ts). */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Preserve the order of first appearance across env and headers. */
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
