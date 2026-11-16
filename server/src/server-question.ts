/**
 * The words of the question about an MCP server a project's configuration names, and of the lines the
 * timeline gets for what became of it.
 *
 * Windlass has its own explanation for this question: the server "runs outside the sandbox, with your
 * permissions". On a machine of the user's that is the whole of it. Here it has to say what is true of
 * a session's sandbox, which depends on the profile (sandbox/profiles.ts):
 *
 *   - The server is a process Windlass starts beside itself, as the sandbox's own user, in the session's
 *     container or microVM. It is never inside Windlass's sandbox around commands (bubblewrap), in any
 *     profile and whatever approval mode Windlass runs with.
 *   - So it has the sandbox machine's network, and it can read Windlass's data directory: Windlass's
 *     record of the conversation, and the turn's access token file (sandbox/token-file.ts). On Docker
 *     that directory is the user's volume, with the records of the user's other sessions in it. Where the profile promises that the agent's
 *     commands have neither (`commandNetwork`, `commandsCanReadAccessToken` both false), that is the
 *     difference the user has to know; where commands run directly in the container, there is none;
 *     and where nothing is promised of commands (E2B until its check has passed), the server's reach
 *     is certain all the same.
 *   - A demo session is handed no access token, so there is none to read.
 *
 * An approval is remembered twice. Windlass keeps one in its data directory, for the project
 * directory and for exactly this definition, good for 30 days. And the platform keeps one of its own
 * for the user, for the session's project (its repository; the session itself when it has none) and
 * exactly this definition, for the same 30 days (server-approvals.ts), and answers from it before the
 * question is put. What that comes to depends on where Windlass's data is:
 *
 *   - On the sandbox's own disk (E2B: `Sandboxes.sessionsLiveInSandbox`), Windlass's record reaches no
 *     further than the sandbox, so the platform's is what the user's other sessions on the repository,
 *     and a sandbox that replaces this one, go by. Forgetting the platform's record holds for those;
 *     a sandbox the server already started in keeps Windlass's record and starts it still.
 *   - On Docker the directory is the user's volume and every session's project directory is
 *     /workspace, so Windlass's record alone starts the server in every session of the user in which
 *     a server of that name has exactly that definition, whatever its repository. The platform's
 *     record is kept there too and changes nothing until Windlass's has run out.
 *
 * Either record is of the definition: the command and its arguments, or the address. Neither is of
 * the files the command runs, which a later commit can change without a new question; the question
 * says so in a sentence.
 *
 * web/src/api/mock.ts repeats these texts for the web app's mock.
 */

import type { QuestionChoice, SandboxProfile } from "./contract.js";
import type { TurnServerOutcome, TurnServerQuestion } from "./sandbox/api.js";
import type { ApprovalProject } from "./server-approvals.js";

export interface ServerQuestionContext {
	/** The profile the session's sandbox was made with. */
	profile: SandboxProfile;
	/** A demo session: its turns are handed no access token. */
	demo: boolean;
	/** `Sandboxes.sessionsLiveInSandbox`: Windlass's data directory, and with it Windlass's own record of an approval, is on this sandbox's own disk. */
	dataInSandbox: boolean;
	/** What the platform remembers an approval for: the session's repository, or the session itself. */
	project: Pick<ApprovalProject, "kind" | "label">;
}

export const SERVER_START = "start";
export const SERVER_NOT_NOW = "not_now";

/** The command as a line: every argument that is not plain text in single quotes, so where one ends is never a guess (Windlass's `quotedCommand`). */
export function commandLine(argv: readonly string[]): string {
	return argv.map((argument) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function list(items: readonly string[]): string {
	return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What the sandbox machine is called in the profile's own texts. */
function machine(profile: SandboxProfile): string {
	return profile.id.startsWith("e2b") ? "microVM" : profile.id.startsWith("docker") ? "container" : "sandbox";
}

/** Where the server runs and what it can reach there, for this profile. One sentence. */
function reach(question: Pick<TurnServerQuestion, "argv">, context: ServerQuestionContext): string {
	const { profile, demo } = context;
	const where = machine(profile);
	if (question.argv === null) {
		return `Nothing is started: Windlass reaches it at that address from this session's ${where}, outside its sandbox around commands, and what the agent sends it leaves the ${where}.`;
	}
	// Windlass's data directory: its record of the conversation, and the turn's access token file.
	const data = "Windlass's own data, including the session's access token, which lasts about an hour and cannot be renewed";
	if (profile.approval === "full") {
		// Commands run directly in the machine: the server has what they have.
		return demo
			? `It runs in this session's ${where}, as the agent's commands do here: like them, it has the network and can read Windlass's own data. A demo session has no access token there.`
			: `It runs in this session's ${where}, as the agent's commands do here: like them, it has the network and can read ${data}.`;
	}
	if (!profile.commandNetwork && !profile.commandsCanReadAccessToken) {
		return demo
			? `It runs in this session's ${where}, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read Windlass's own data. A demo session has no access token there.`
			: `It runs in this session's ${where}, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read ${data}.`;
	}
	// Nothing is promised of commands here; of the server it is certain.
	return demo
		? `It runs in this session's ${where} and is never inside Windlass's sandbox around commands, whether or not that sandbox works here: it has the network and can read Windlass's own data. A demo session has no access token there.`
		: `It runs in this session's ${where} and is never inside Windlass's sandbox around commands, whether or not that sandbox works here: it has the network and can read ${data}.`;
}

/**
 * What approving does, how far it is remembered, and where it is taken back. One sentence. `when` is
 * "next" for an approval given in the session's panel while no question is open: no Windlass runs
 * between turns, so the server starts with the next one.
 */
function approving(question: Pick<TurnServerQuestion, "argv">, context: ServerQuestionContext, when: "now" | "next" = "now"): string {
	const remote = question.argv === null;
	const does = when === "next" ? (remote ? "Approving lets Windlass connect to it from this session's next turn" : "Approving starts it with this session's next turn") : remote ? "Approving lets Windlass connect to it now" : "Approving starts it now";
	// Windlass's own record, in the data all of the user's sessions share, reaches further than the platform's.
	if (!context.dataInSandbox) return `${does} and is remembered for 30 days for exactly this definition, in all your sessions: they share Windlass's data.`;
	if (context.project.kind === "session") {
		return `${does} and is remembered for 30 days for exactly this definition, for this session, which has no repository: a sandbox that replaces this one ${remote ? "connects" : "starts it"} without asking, until you forget the approval in the session's panel.`;
	}
	return `${does} and is remembered for 30 days for exactly this definition: your sessions on ${context.project.label} then ${remote ? "connect" : "start it"} without asking, until you forget the approval in a session's panel.`;
}

/** What an approval is of, and so what it does not cover. One sentence. */
function covers(question: Pick<TurnServerQuestion, "argv">): string {
	return question.argv === null
		? "It is an approval of this address, not of what answers there."
		: "It is an approval of this command, not of the files it runs: a later commit can change those without a new question.";
}

/** How far the choice to approve is remembered, as the choice says it. */
function remembered(context: ServerQuestionContext): string {
	if (!context.dataInSandbox) return "exactly this definition, for your sessions, for 30 days";
	return context.project.kind === "session" ? "exactly this definition, for this session, for 30 days" : `exactly this definition, for your sessions on ${context.project.label}, for 30 days`;
}

/** Why it does not start whatever the answer: a variable its definition reads is not set, and the platform has nowhere to keep one. */
function missing(question: TurnServerQuestion): string | null {
	if (question.unset.length === 0) return null;
	const names = list(question.unset);
	const start = question.argv === null ? "It cannot be reached yet" : "It will not start yet";
	return question.unset.length === 1
		? `${start}: its definition reads the variable ${names}, which is not set in the sandbox, and the platform cannot set variables for a session yet.`
		: `${start}: its definition reads the variables ${names}, which are not set in the sandbox, and the platform cannot set variables for a session yet.`;
}

/** The question as the clients show it: `PendingQuestion`'s title, subject, details and choices. */
export function serverQuestionWords(question: TurnServerQuestion, context: ServerQuestionContext): { title: string; subject: string; details: string[]; choices: QuestionChoice[] } {
	const remote = question.argv === null;
	const unset = missing(question);
	return {
		title: remote ? `Connect to this project's MCP server "${question.name}"?` : `Start this project's MCP server "${question.name}"?`,
		subject: question.argv === null ? (question.url ?? "") : commandLine(question.argv),
		details: [reach(question, context), approving(question, context), covers(question), ...(unset === null ? [] : [unset])],
		choices: [
			{
				id: SERVER_START,
				label: remote ? "Connect for this project" : "Start it for this project",
				approve: true,
				remembers: remembered(context),
			},
			{ id: SERVER_NOT_NOW, label: "Not now", approve: false, remembers: null },
		],
	};
}

/**
 * The same question for a server that waits, as the session's panel puts it before it takes an
 * approval while no question is open: what the server can reach, what approving does then, and what
 * the approval is of. The panel shows the command and the file beside it.
 */
export function serverPanelWords(server: { name: string; remote: boolean }, context: ServerQuestionContext): { title: string; details: string[] } {
	const question = { argv: server.remote ? null : [] };
	return {
		title: server.remote ? `Connect to this project's MCP server "${server.name}"?` : `Start this project's MCP server "${server.name}"?`,
		details: [reach(question, context), approving(question, context, "next"), covers(question)],
	};
}

type Level = "info" | "warn" | "error";

const named = (question: Pick<TurnServerQuestion, "name">) => `the MCP server "${question.name}"`;

/** Windlass's reason as the end of a sentence: its own words, without a second full stop. */
function reason(text: string): string {
	return text.trim().replace(/\s*\n\s*/g, " ").replace(/\.$/, "");
}

/** The line for a server the user said to start, from what Windlass made of it. */
export function serverApprovedNote(question: TurnServerQuestion, outcome: TurnServerOutcome): { level: Level; text: string } {
	const remote = question.argv === null;
	switch (outcome.state) {
		case "running": {
			const tools = outcome.tools === 1 ? "1 tool" : outcome.tools === 0 ? "no tools" : `${outcome.tools} tools`;
			const began = remote ? `Connected to ${named(question)} for this project: ${tools}.` : `Started ${named(question)} for this project: ${tools}.`;
			if (outcome.tools === 0) return { level: "info", text: began };
			// Before the prompt went, the model's first request has them. In a running turn they can be called at
			// once, and the model is told of them with the list Windlass appends at its next step.
			return { level: "info", text: question.holdsTurn ? `${began} The agent has them from this turn on.` : `${began} The turn was already running: the agent is told of them at its next step.` };
		}
		case "starting":
			return { level: "info", text: `Approved ${named(question)} for this project. It is still starting; the agent is told of its tools once it runs.` };
		case "failed":
			return {
				level: "warn",
				text: `Approved ${named(question)} for this project, but it did not start: ${reason(outcome.reason)}. ${question.unset.length > 0 ? "The platform cannot set variables for a session yet." : "Windlass tries again by itself."}`,
			};
		case "changed":
			return { level: "warn", text: `The definition of ${named(question)} changed while it was asked about, so nothing was started. The new definition is asked about.` };
		case "refused":
			return { level: "warn", text: `Windlass did not take the approval of ${named(question)}: ${reason(outcome.reason)}. Your next message asks again.` };
	}
}

/**
 * The line for a server the platform had Windlass start without putting the question, because the
 * user's approval of exactly this definition for this project is remembered. `ago` says when they
 * approved, as "3 days ago".
 */
export function serverRecalledNote(question: TurnServerQuestion, outcome: TurnServerOutcome, ago: string): { level: Level; text: string } {
	const remote = question.argv === null;
	const because = `because you approved it for this project ${ago}`;
	switch (outcome.state) {
		case "running": {
			const tools = outcome.tools === 1 ? "1 tool" : outcome.tools === 0 ? "no tools" : `${outcome.tools} tools`;
			const began = remote ? `Connected to ${named(question)} ${because}: ${tools}.` : `Started ${named(question)} ${because}: ${tools}.`;
			if (outcome.tools === 0) return { level: "info", text: began };
			return { level: "info", text: question.holdsTurn ? `${began} The agent has them from this turn on.` : `${began} The turn was already running: the agent is told of them at its next step.` };
		}
		case "starting":
			return { level: "info", text: `The MCP server "${question.name}" is starting ${because}; the agent is told of its tools once it runs.` };
		case "failed":
			return {
				level: "warn",
				text: `You approved ${named(question)} for this project ${ago}, but it did not start: ${reason(outcome.reason)}. ${question.unset.length > 0 ? "The platform cannot set variables for a session yet." : "Windlass tries again by itself."}`,
			};
		case "changed":
			return { level: "warn", text: `The definition of ${named(question)} changed as it was being started, so nothing was started. The new definition is asked about.` };
		case "refused":
			return { level: "warn", text: `Windlass did not take your earlier approval of ${named(question)}: ${reason(outcome.reason)}. Your next message tries again.` };
	}
}

/** What forgetting a remembered approval does where the session runs, and what it leaves: for the panel, under the list. */
export function forgettingWords(context: Pick<ServerQuestionContext, "dataInSandbox">): string {
	return context.dataInSandbox
		? "Forgetting holds for the next session or sandbox. Where the server already started, Windlass's own record still starts it, and a running one is not stopped."
		: "Forgetting holds once Windlass's own record has run out, 30 days after the server was last approved: all your sessions share that record here. A running server is not stopped.";
}

/** The line for an approval given in the session's panel while no question about the server was open. */
export function serverPanelApprovedNote(server: { name: string; remote: boolean }): string {
	return `Approved ${named(server)} for this project in the session's panel. ${server.remote ? "Windlass connects to it" : "It starts"} with the next turn.`;
}

/** The line for an approval the user took back in the session's panel. */
export function serverForgottenNote(server: { name: string }, context: Pick<ServerQuestionContext, "dataInSandbox">): string {
	return context.dataInSandbox
		? `Forgot your approval of ${named(server)} for this project. The next session or sandbox asks again; where it already started, Windlass's own record still starts it.`
		: `Forgot your approval of ${named(server)} for this project. Windlass's own record, which all your sessions share here, still starts it until 30 days after it was last approved.`;
}

/** The line for "not now". The model is not told by itself: Windlass says it when the model tries the server. */
export function serverNotNowNote(question: TurnServerQuestion): string {
	return question.argv === null
		? `Did not connect to ${named(question)}. If the agent tries to use it, it is told that the server waits for you; your next message asks again.`
		: `Left ${named(question)} stopped. If the agent tries to use it, it is told that the server waits for you; your next message asks again.`;
}

/** The line for a question nobody answered in time. `within` is the time it waited, in words. */
export function serverExpiredNote(question: TurnServerQuestion, within: string): string {
	return `Nobody answered about ${named(question)} within ${within}, so it stays ${question.argv === null ? "unconnected" : "stopped"}. Your next message asks again.`;
}

/** The line for a question the turn's own end took away: only one put while the turn was already running can meet that. */
export function serverUnansweredNote(question: TurnServerQuestion): string {
	return `The turn ended before anyone answered about ${named(question)}. Your next message asks again.`;
}
