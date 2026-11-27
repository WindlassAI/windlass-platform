/** Questions a turn asks and a session's MCP servers. */

/** One answer a question offers. */
export interface QuestionChoice {
	/** Windlass's own id: "once", "session", "project" or "deny". For a question about a server (`PendingQuestion.server`): "start" or "not_now". */
	id: string;
	label: string;
	/** Whether choosing it lets the call run. */
	approve: boolean;
	/** What choosing it remembers, in words ("network for sandboxed commands, for the rest of this session"); null when nothing. */
	remembers: string | null;
}

/**
 * A question Windlass is waiting on: a tool call needs the user's approval before it runs. At most
 * one is pending per session. The same question is in the timeline as Windlass's `approval.requested`
 * event, and its answer as `approval.answered`; this is the live copy with what the platform adds.
 */
export interface PendingQuestion {
	/** Identifies this question in `answer()`. */
	id: string;
	turn: number;
	/** The call it is about, as `approval.requested` and `tool.called` name it. */
	messageId: string;
	callId: string;
	/** The question, e.g. "Allow network access for this command?". */
	title: string;
	/** The command, path or tool it is about, verbatim. */
	subject: string;
	/** What the user should know before answering, one sentence each. */
	details: string[];
	choices: QuestionChoice[];
	/** Set when a subagent asked: the first line of its task. */
	subagent: string | null;
	askedAt: number;
	/** When the platform declines by itself because nobody answered, ms since the epoch. */
	expiresAt: number;
	/**
	 * Set when the question is not about a tool call but about an MCP server the project's own
	 * configuration names (`.windlass/config.json` in the workspace): Windlass does not start such a
	 * server until the user approves exactly this definition of it. `messageId` and `callId` are empty
	 * then, `subject` is the command with its arguments (each argument that is not plain text in single
	 * quotes) or the address, `details` are the platform's own sentences about where the server runs in
	 * this session's sandbox profile and what approving means, and the choices are "start" and
	 * "not_now". Nothing of it is in Windlass's events: what became of it is a `platform` item.
	 *
	 * A tool call's question comes first: while one waits, a server's question steps aside (the
	 * `question` event carries the call's question) and is put again afterwards, under the same `id` and
	 * with a new `expiresAt`. `answer()` takes its id while it stands aside too.
	 */
	server?: QuestionServer;
	/**
	 * Set when the question is the platform's own about a request of the agent's to publish the
	 * session's work: what would be committed, pushed and opened. `messageId` and `callId` name the
	 * agent's call, `subject` is the pull request's title, `details` are the platform's sentences
	 * about what allowing means, and the choices are "once", "session" (which turns
	 * `SessionSummary.publishUnasked` on) and "deny", whose note goes to the agent. Nothing of it is in
	 * Windlass's events: what became of it is a `platform` item, and the call's own result.
	 */
	publish?: QuestionPublish;
}

/** What a request of the agent's to publish would do, as the question about it shows it. */
export interface QuestionPublish {
	/** "owner/name". */
	repository: string;
	/** The session's branch, which the work goes to. */
	branch: string;
	/** The branch the pull request asks to be merged into. */
	base: string;
	/** The whole message of the commit the platform makes of what is uncommitted. */
	commit: string;
	/** The pull request's title and description, as the agent wrote them; the description may be "". */
	title: string;
	description: string;
	/** The session's pull request when it is open: the push goes to it, and it is given the title and description. Null: one is opened. */
	pullRequest: number | null;
}

/** The MCP server a question is about. */
export interface QuestionServer {
	name: string;
	/** The file that defines it, as a path in the sandbox; null when Windlass named none. */
	file: string | null;
	/** True when it is reached at an address (`subject`) and nothing is started. */
	remote: boolean;
	/** The variables its definition reads that are not set in the sandbox: with any, it does not start, approved or not. */
	unset: string[];
	/** A pre-prompt approval holds the turn. A request discovered mid-turn expires when that turn ends. */
	holdsTurn: boolean;
}

/** How a session last knew a server of its project. A server lives with the Windlass process of a turn: between turns none runs. */
export type SessionServerState =
	/** Windlass started it (or reaches it). It starts again with each turn while an approval of it holds. */
	| "running"
	/** Approved, and it had not finished starting when the session last heard. */
	| "starting"
	/** Not started: it waits for the user's approval of exactly this definition. */
	| "waiting"
	/** Approved, and it could not start; `reason` says why. */
	| "failed"
	| "stopped";

/** Last server status Windlass reported in the session. */
export interface SessionServer {
	name: string;
	/** User-owned servers start without project approval. Absent origin means project. */
	origin?: "project" | "user";
	/** What approving starts, as a question shows it: the command with its arguments, or the address it is reached at. */
	subject: string;
	/** True when it is reached at an address and nothing is started. */
	remote: boolean;
	/** The file that defines it, as a path in the sandbox; null when Windlass named none. */
	file: string | null;
	state: SessionServerState;
	/** How many tools it offers, once it runs. */
	tools: number | null;
	/** Why it could not start, in Windlass's own words. */
	reason: string | null;
	/** Null until the session sees a definition wait for approval. Approval must match its fingerprint. */
	fingerprint: string | null;
	/** When the session last heard something new of it, ms since the epoch. */
	at: number;
	/** The user's remembered approval of this definition for the session's project: when they approved, and until when it holds. */
	approval: { approvedAt: number; expiresAt: number } | null;
	/** A prior approval for a different fingerprint cannot authorize the changed definition. */
	earlier?: { approvedAt: number; expiresAt: number } | null;
	/**
	 * Set for a server that waits and has no remembered approval: the question about it as the panel
	 * puts it before `approveServer`, in the words of the question a turn would put (`PendingQuestion`),
	 * for an approval given between turns.
	 */
	asks?: { title: string; details: string[] };
}

/** What the side panel shows of the MCP servers a session's project names. */
export interface SessionServers {
	/**
	 * What an approval is remembered for: the session's repository ("github": `label` is "owner/name";
	 * "address": the pasted address without its scheme), or, for a session with no repository, the
	 * session itself.
	 */
	project: { kind: "github" | "address" | "session"; label: string };
	servers: SessionServer[];
	/** What forgetting an approval does and does not do where this session runs, in a sentence or two. */
	forgetting: string;
	/**
	 * Set where this session's sandbox hands MCP servers only some of the account's secrets, and says
	 * which and why: a server of the user's own that reads another one does not start there.
	 */
	accountSecrets?: string | null;
}
