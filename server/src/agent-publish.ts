/**
 * The agent asking the platform to publish: commit and push the session's work to the session's
 * branch and open or update the session's pull request, with a title and a description the agent
 * writes. The platform does the work, with the code and the token handling of a publish from the
 * side panel (github/publish.ts, git.ts); the agent has no GitHub credential, before or after.
 *
 * How the agent asks. Windlass offers a model the tools of MCP servers, and starts by itself the
 * servers its user's own configuration file names (`~/.config/windlass/config.json`; a server a
 * repository's file names waits for approval). So for a turn of a session that may publish, the
 * sandbox layer writes one server into that file, `windlass_platform`, with one tool, `publish`, and
 * takes it out again when the turn ends (sandbox/turn.ts). The model finds the tool in the list
 * Windlass gives it, with the description below, and calls it like any other.
 *
 * The server is a mailbox and nothing more: a few lines of Python that do nothing with a call but
 * wait for an answer. What the platform acts on is Windlass's own report of the call in the turn's
 * events (`tool.called`, with the arguments), which the engine writes on its connection to the
 * platform. The platform decides, publishes, and puts what the agent is to be told into a file the
 * server waits for; the server hands it back as the tool's result. Which file: the server names each
 * call it receives in a progress notification, which Windlass passes on as an event of that call,
 * so the platform knows which call waits where. Nothing travels on a network, and nothing the
 * sandbox says is trusted:
 *
 *   - the request is the engine's event, never a file or a process's word;
 *   - the server's name for a call is only a file name (checked), and the file is only what the
 *     agent reads;
 *   - a repository's own configuration that names a server `windlass_platform` makes it the
 *     project's, which Windlass says (`origin`), and then no call is acted on at all.
 *
 * Where Windlass sandboxes the agent's commands they can do none of this: they see no process but
 * their own, cannot read Windlass's configuration and cannot write where the answers go. Where
 * commands run directly in the sandbox machine they run as Windlass's user and can write on the
 * engine's own connection, so there a command can ask in the agent's name. That cannot be closed
 * from here, and it is why such a session's agent is never let publish unasked
 * (`publishUnaskedProblem`): there every request is put to the user, whoever made it. README, "The
 * agent asks to publish", says the same.
 *
 * This file has what is the same everywhere: the server and its tool, what a request may hold, and
 * the words of the question, of the timeline's lines and of what the agent is told.
 */

import { MAX_PUBLISH_BODY_CHARS, MAX_PUBLISH_TITLE_CHARS, type PublishMessage, type PullRequestInfo, type QuestionChoice, type QuestionPublish } from "./contract.js";
import type { CommandSandbox, Redactor } from "./repo-secrets.js";

/** The server's name in Windlass's configuration, and its one tool: the model calls `mcp_call` with these. */
export const PUBLISH_SERVER = "windlass_platform";
export const PUBLISH_TOOL = "publish";

/** Windlass's configuration file of the sandbox's user, and where the server waits for the platform's answers. */
export const WINDLASS_CONFIG_FILE = "/home/agent/.config/windlass/config.json";
export const PUBLISH_STATE_DIR = "/home/agent/.local/state/windlass-platform";
export const PUBLISH_DIR = `${PUBLISH_STATE_DIR}/publish`;

/** The longest commit message a request may carry. */
export const MAX_PUBLISH_COMMIT_CHARS = 4_000;

/** How long publishing itself may take once it is allowed: a commit, a push and GitHub's API, with room. */
const PUBLISHING_SECONDS = 5 * 60;
/** The longest Windlass lets one call of an MCP tool take. */
const WINDLASS_CALL_LIMIT_SECONDS = 3600;

/**
 * What the model reads about the tool. Windlass's list shows the first sentence, at most 160
 * characters; the rest is there when the model looks the tool up.
 */
const DESCRIPTION = [
	"Publish this session's work to GitHub: commit and push it to the session's own branch and open or update the session's pull request.",
	"You have no GitHub credential and `git push` does not work here: this tool is the only way to publish, and the platform that runs this session does the work.",
	"It commits whatever is uncommitted in the workspace with your commit message, pushes the session's branch (the platform names it; you cannot choose another, and never the repository's default branch), and opens a pull request into the branch the session started from, with your title and description.",
	"When the session's pull request is open already, it pushes to that one and gives it the title and description of this call.",
	"The user may be asked to allow it first, which can take minutes: wait for the result.",
	"The result says what was published and gives the pull request's address, or says why nothing was published. Tell the user what it says, and do not try another way to publish.",
].join(" ");

const INPUT_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string", description: `The pull request's title, at most ${MAX_PUBLISH_TITLE_CHARS} characters.` },
		description: { type: "string", description: `The pull request's description, in Markdown, at most ${MAX_PUBLISH_BODY_CHARS} characters: what changed and why, and how it was checked.` },
		commit_message: { type: "string", description: `The message of the commit the platform makes of what is uncommitted, at most ${MAX_PUBLISH_COMMIT_CHARS} characters. Left out, it is the title.` },
		branch: { type: "string", description: "Leave it out. The work goes to the session's own branch, and a request that names any other branch is refused." },
	},
	required: ["title"],
};

/**
 * The server. One JSON-RPC message per line on standard input and output, the handshake of the MCP
 * revisions Windlass falls back to. A call of the tool is named (`request`), announced with that
 * name as the call's progress, and answered with the content of the file of that name once the
 * platform has written it; the file is removed when it was read. A call nobody answers in `wait`
 * seconds ends by saying so. Calls are taken one at a time.
 */
const SERVER_SOURCE = String.raw`
import json, os, secrets, sys, time

DIRECTORY, WAIT, TOOL = json.loads(sys.argv[1])
os.makedirs(DIRECTORY, mode=0o700, exist_ok=True)


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def text(words, failed=False):
    return {"content": [{"type": "text", "text": words}], "isError": failed}


def call(params):
    if params.get("name") != TOOL["name"]:
        return text("There is no such tool.", True)
    request = secrets.token_hex(12)
    token = (params.get("_meta") or {}).get("progressToken")
    if token is None:
        return text("Not published: this Windlass gives the platform no way to tell which call waits for its answer.", True)
    send({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progressToken": token, "progress": 0, "total": 1, "message": "handed to the platform as request " + request}})
    path = os.path.join(DIRECTORY, "result-" + request)
    deadline = time.monotonic() + WAIT
    while time.monotonic() < deadline:
        try:
            with open(path, encoding="utf-8") as answer:
                words = answer.read()
        except OSError:
            time.sleep(0.2)
            continue
        try:
            os.remove(path)
        except OSError:
            pass
        return text(words)
    return text("The platform did not answer this request in time. Whether anything was published is not known here: tell the user to look at the session's panel.", True)


for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    if not isinstance(message, dict) or "id" not in message or "method" not in message:
        continue
    method = message["method"]
    if method == "initialize":
        result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "windlass-platform", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [TOOL]}
    elif method == "tools/call":
        result = call(message.get("params") or {})
    elif method == "ping":
        result = {}
    else:
        send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "method not found: " + str(method)}})
        continue
    send({"jsonrpc": "2.0", "id": message["id"], "result": result})
`;

/**
 * The server's definition, as Windlass's configuration takes it. `questionTimeoutMs` is how long
 * the user has to answer: a call may wait that long and then for the publishing itself. What the
 * server returns is the platform's own words, so it is marked as trusted: its results do not count
 * as content from outside, after which Windlass would ask about every command it cannot sandbox.
 */
export function publishServerDefinition(questionTimeoutMs: number): Record<string, unknown> {
	const limit = Math.min(WINDLASS_CALL_LIMIT_SECONDS, Math.ceil(questionTimeoutMs / 1000) + PUBLISHING_SECONDS);
	const tool = { name: PUBLISH_TOOL, description: DESCRIPTION, inputSchema: INPUT_SCHEMA };
	// The server gives up a little before Windlass would: its own sentence is the better one to end on.
	return { command: "python3", args: ["-c", SERVER_SOURCE, JSON.stringify([PUBLISH_DIR, Math.max(30, limit - 30), tool])], untrusted: false, timeoutSeconds: limit };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Windlass's configuration file with the server in it. `text` is the file as it is, or null when
 * there is none (a sandbox's image has none). Null when the file is not what Windlass reads: it is
 * left alone then, and the tool is not offered.
 */
export function withPublishServer(text: string | null, definition: Record<string, unknown>): string | null {
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
	const servers = mcp.servers === undefined ? {} : mcp.servers;
	if (!isObject(servers)) return null;
	return `${JSON.stringify({ ...config, mcp: { ...mcp, servers: { ...servers, [PUBLISH_SERVER]: definition } } }, null, 2)}\n`;
}

/**
 * The file without the server: its new content, null when nothing else is in it (the file goes), and
 * undefined when it is to be left as it is (it cannot be read as configuration, or has no such server).
 */
export function withoutPublishServer(text: string): string | null | undefined {
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObject(config) || !isObject(config.mcp) || !isObject(config.mcp.servers) || !(PUBLISH_SERVER in config.mcp.servers)) return undefined;
	const { [PUBLISH_SERVER]: _own, ...servers } = config.mcp.servers;
	const { servers: _servers, ...mcp } = config.mcp;
	const { mcp: _mcp, ...rest } = config;
	const kept = Object.keys(servers).length > 0 ? { ...mcp, servers } : mcp;
	const next = Object.keys(kept).length > 0 ? { ...rest, mcp: kept } : rest;
	return Object.keys(next).length === 0 ? null : `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * The arguments of a call of the tool, from Windlass's `tool.called` event of an `mcp_call`; null
 * for any other call. Windlass takes the tool's name with or without the server's in front.
 */
export function publishArguments(name: unknown, input: unknown): Record<string, unknown> | null {
	if (name !== "mcp_call") return null;
	let call: unknown = input;
	if (typeof input === "string") {
		try {
			call = JSON.parse(input);
		} catch {
			return null;
		}
	}
	if (!isObject(call) || call.server !== PUBLISH_SERVER) return null;
	if (call.tool !== PUBLISH_TOOL && call.tool !== `${PUBLISH_SERVER}/${PUBLISH_TOOL}`) return null;
	return isObject(call.arguments) ? call.arguments : {};
}

/** The server's name for a call, from the progress Windlass reports of it; null when it names none. */
export function publishRequestId(progress: unknown): string | null {
	return typeof progress === "string" ? (/\brequest ([0-9a-f]{24})\b/.exec(progress)?.[1] ?? null) : null;
}

/** Where the server waits for the answer to the call it named `request`. */
export const publishResultFile = (request: string) => `${PUBLISH_DIR}/result-${request}`;

// ---------------------------------------------------------------------------------------------
// What a request may hold
// ---------------------------------------------------------------------------------------------

/** What is taken out of the agent's text besides line breaks and tabs: a terminal, or a page, should not act on it. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;

export type PublishRequest =
	/** What the platform would publish with. */
	| { ok: true; message: PublishMessage & { commit: string } }
	/** Why it is refused before anyone is asked: `said` for the timeline, `told` for the agent. */
	| { ok: false; said: string; told: string };

/**
 * A request's arguments, checked. They are the model's text, and nothing is assumed of them: each
 * has to be text, the repository's saved secrets are taken out (the event they came in was cleaned
 * before, but as JSON, where a value with a line break or a quote in it is not itself), control
 * characters go, and what is longer than the limits is refused, with the limit, so that the agent
 * can ask again. A request that names a branch other than the session's, or a base other than the
 * branch the session started from, is refused: the session's work goes to the session's branch.
 */
export function publishRequest(given: Record<string, unknown>, where: { branch: string; base: string }, redactor: Redactor): PublishRequest {
	const refuse = (said: string, told: string): PublishRequest => ({ ok: false, said, told });
	const named = (value: unknown) => (typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : JSON.stringify(value));
	const shown = (value: string) => JSON.stringify(redactor.text(value.replace(CONTROL, "")).slice(0, 120));

	const branch = named(given.branch) || named(given.head);
	if (branch !== "" && branch !== where.branch) {
		return refuse(
			`The agent asked to publish to ${shown(branch)}, which is not this session's branch (${where.branch}), so nothing was published.`,
			`Not published. This session's work can only go to the session's own branch, ${where.branch}, with a pull request into ${where.base}; a request that names another branch is refused. Call the tool again without a branch.`,
		);
	}
	const base = named(given.base);
	if (base !== "" && base !== where.base) {
		return refuse(
			`The agent asked for a pull request into ${shown(base)}, which is not the branch this session started from (${where.base}), so nothing was published.`,
			`Not published. This session's pull request can only ask to be merged into ${where.base}, the branch the session started from. Call the tool again without a base.`,
		);
	}

	const fields: Array<{ key: string; name: string; limit: number; needed: boolean; oneLine: boolean }> = [
		{ key: "title", name: "title", limit: MAX_PUBLISH_TITLE_CHARS, needed: true, oneLine: true },
		{ key: "description", name: "description", limit: MAX_PUBLISH_BODY_CHARS, needed: false, oneLine: false },
		{ key: "commit_message", name: "commit message", limit: MAX_PUBLISH_COMMIT_CHARS, needed: false, oneLine: false },
	];
	const clean: Record<string, string> = {};
	for (const field of fields) {
		const value = given[field.key];
		if (value !== undefined && value !== null && typeof value !== "string") {
			return refuse(`The agent asked to publish with a ${field.name} that is not text, so nothing was published.`, `Not published. The ${field.name} has to be text. Call the tool again.`);
		}
		const text = redactor.text(typeof value === "string" ? value : "").replace(/\r\n?/g, "\n").replace(CONTROL, "");
		const kept = field.oneLine ? text.replace(/\s+/g, " ").trim() : text.trim();
		if (field.needed && kept === "") return refuse(`The agent asked to publish without a ${field.name}, so nothing was published.`, `Not published. Give the pull request a ${field.name} and call the tool again.`);
		if (kept.length > field.limit) {
			return refuse(
				`The agent asked to publish with a ${field.name} of ${kept.length} characters, and the limit is ${field.limit}, so nothing was published.`,
				`Not published. The ${field.name} is ${kept.length} characters long and the limit is ${field.limit}. Shorten it and call the tool again.`,
			);
		}
		clean[field.key] = kept;
	}
	const title = clean.title ?? "";
	return { ok: true, message: { title, body: clean.description ?? "", commit: (clean.commit_message ?? "") === "" ? title : (clean.commit_message as string) } };
}

// ---------------------------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------------------------

/** The ids of the question's answers. */
export const PUBLISH_ONCE = "once";
export const PUBLISH_SESSION = "session";
export const PUBLISH_DENY = "deny";

/**
 * Why an agent cannot be let publish unasked in a sandbox whose commands are not held in Windlass's
 * sandbox, or not known to be: a command there could ask in the agent's name, and with nobody asked
 * that would be a publish a command made by itself. Null where Windlass sandboxes every command.
 */
export function publishUnaskedProblem(sandbox: CommandSandbox): string | null {
	if (sandbox === "windlass") return null;
	return sandbox === "none"
		? "In this sandbox the agent's commands run outside Windlass's sandbox and could ask in the agent's name, so you are asked each time the agent wants to publish."
		: "In this sandbox it is not established that Windlass's sandbox holds the agent's commands, which could then ask in the agent's name, so you are asked each time the agent wants to publish.";
}

export interface PublishQuestionInput {
	/** "owner/name". */
	repository: string;
	branch: string;
	base: string;
	message: PublishMessage & { commit: string };
	/** The session's pull request when it is open: the push goes to it. */
	open: PullRequestInfo | null;
	/** What the session's profile promises about the agent's commands: where they are not sandboxed the question says so, and cannot be answered for the whole session. */
	sandbox: CommandSandbox;
}

/** The question about a request of the agent's, as the session's question box shows it. */
export function publishQuestionWords(input: PublishQuestionInput): { title: string; subject: string; details: string[]; choices: QuestionChoice[]; publish: QuestionPublish } {
	const { open } = input;
	return {
		title: open ? `Allow the agent to push to pull request #${open.number}?` : "Allow the agent to open a pull request?",
		subject: input.message.title,
		details: [
			open
				? `The platform commits what is uncommitted in the workspace with this message and pushes it to pull request #${open.number}, which is given this title and description.`
				: "The platform commits what is uncommitted in the workspace with this message, pushes it to the session's branch, and opens the pull request under this title and description.",
			"Everything in the workspace goes to GitHub as it is: Changes, in the session's panel, lists it.",
			"The agent is given no GitHub access: the platform pushes, and tells the agent the pull request's address.",
			...(input.sandbox === "windlass" ? [] : ["In this sandbox a command the agent ran could have asked this in the agent's name: its commands are not held in Windlass's sandbox."]),
		],
		choices: [
			{ id: PUBLISH_ONCE, label: "Allow once", approve: true, remembers: null },
			...(input.sandbox === "windlass" ? [{ id: PUBLISH_SESSION, label: "Allow for this session", approve: true, remembers: "publishing for the agent without asking, for the rest of this session" }] : []),
			{ id: PUBLISH_DENY, label: "Don't allow", approve: false, remembers: null },
		],
		publish: { repository: input.repository, branch: input.branch, base: input.base, commit: input.message.commit, title: input.message.title, description: input.message.body, pullRequest: open ? open.number : null },
	};
}

// ---------------------------------------------------------------------------------------------
// The timeline's lines, and what the agent is told
// ---------------------------------------------------------------------------------------------

/**
 * Said under Windlass's own question about the tool, which the platform answers itself: Windlass
 * asks before a call of an MCP tool, and this one does nothing but hand the request over.
 */
export const PUBLISH_HANDED_OVER = "The platform allowed this itself: the tool only hands the agent's request to the platform, which decides it.";

/** How a request came to be allowed. */
export type PublishAllowed = "unasked" | "once" | "session";

/** The first sentence of the line about a request that was allowed: who allowed it. */
export function publishAllowedWords(allowed: PublishAllowed): string {
	if (allowed === "once") return "The agent asked to publish, and you allowed it once.";
	if (allowed === "session") return "The agent asked to publish, and you allowed it for the rest of this session: it is not asked about again, unless Pull request in the session's panel says otherwise.";
	return "The agent asked to publish, which this session allows without asking.";
}

/** What was published, for the agent: the pull request's address first. */
export function publishedForAgent(input: { repository: string; pull: PullRequestInfo; opened: boolean; pushed: boolean; retitled: boolean; files: number | null }): string {
	const { pull } = input;
	const did = input.opened ? `Opened pull request #${pull.number}` : input.pushed ? `Pushed to pull request #${pull.number}${input.retitled ? " and gave it this title and description" : ""}` : `Gave pull request #${pull.number} this title and description; there was nothing new to push`;
	const files = input.files === null || !input.pushed ? "" : input.files === 0 ? " The commits were your own: nothing was uncommitted." : ` The platform's commit holds ${input.files === 1 ? "1 file" : `${input.files} files`}.`;
	return `Published. ${did}: ${pull.url}\nThe work is on the branch ${pull.branch} of ${input.repository}, to be merged into ${pull.base}.${files}\nGive the user the pull request's address.`;
}

/** The user said no. `note` is what they wrote for the agent. */
export function publishDeclined(note: string | undefined): { said: string; told: string } {
	const words = (note ?? "").trim();
	return {
		said: words === "" ? "The agent asked to publish, and you did not allow it. Nothing was published." : `The agent asked to publish, and you did not allow it: ${JSON.stringify(words)}. Nothing was published.`,
		told: `Not published. The user did not allow it${words === "" ? "." : `, and wrote: ${words}`}\nThe work is still in the workspace. Do not try another way to publish.`,
	};
}

/** Nobody answered in time. `title` is the question's, `waited` how long it stood ("10 minutes"). */
export function publishUnanswered(title: string, waited: string): { said: string; told: string } {
	return {
		said: `Nobody answered "${title}" within ${waited}, so it was declined. Nothing was published; Pull request, in the session's panel, can let the agent publish without asking.`,
		told: `Not published. Nobody answered the platform's question within ${waited}, so it was declined for the user.\nThe work is still in the workspace. Say in your answer that it is not published yet and that the user can publish it from the session's panel, or allow you to publish without asking there.`,
	};
}

/** The question went with the call or the turn before anyone answered: what the agent would read if it still could. */
export const PUBLISH_WITHDRAWN = "Not published. The request was withdrawn before the user answered.";

/** Publishing was allowed and did not go through. `why` is the sentence a publish from the panel fails with. */
export function publishFailed(allowed: PublishAllowed, why: string): { said: string; told: string } {
	return { said: `${publishAllowedWords(allowed)} It did not go through: ${why}`, told: `Not published. ${why}` };
}
