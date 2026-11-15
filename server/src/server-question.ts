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
 * What is remembered is Windlass's own doing: an approval is a file in its data directory, for the
 * project directory and for exactly this definition, good for 30 days. Where that directory is on the
 * sandbox's disk (E2B: `Sandboxes.sessionsLiveInSandbox`), it holds for this session's sandbox. On
 * Docker the directory is the user's volume and every session's project directory is /workspace, so it
 * holds for every session of the user in which a server of that name has exactly that definition.
 *
 * web/src/api/mock.ts repeats these texts for the web app's mock.
 */

import type { QuestionChoice, SandboxProfile } from "./contract.js";
import type { TurnServerOutcome, TurnServerQuestion } from "./sandbox/api.js";

export interface ServerQuestionContext {
	/** The profile the session's sandbox was made with. */
	profile: SandboxProfile;
	/** A demo session: its turns are handed no access token. */
	demo: boolean;
	/** `Sandboxes.sessionsLiveInSandbox`: Windlass's data directory, and with it an approval, is on this sandbox's own disk. */
	dataInSandbox: boolean;
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
	return profile.id === "e2b" ? "microVM" : profile.id.startsWith("docker") ? "container" : "sandbox";
}

/** Where the server runs and what it can reach there, for this profile. One sentence. */
function reach(question: TurnServerQuestion, context: ServerQuestionContext): string {
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

/** What approving does and where it is remembered. One sentence. */
function approving(question: TurnServerQuestion, context: ServerQuestionContext): string {
	const does = question.argv === null ? "Approving lets Windlass connect to it now" : "Approving starts it now";
	return context.dataInSandbox
		? `${does} and is remembered for 30 days for exactly this definition, in this session's sandbox only: another session asks again.`
		: `${does} and is remembered for 30 days for exactly this definition, in all your sessions: they share Windlass's data.`;
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
		details: [reach(question, context), approving(question, context), ...(unset === null ? [] : [unset])],
		choices: [
			{
				id: SERVER_START,
				label: remote ? "Connect for this project" : "Start it for this project",
				approve: true,
				remembers: context.dataInSandbox ? "exactly this definition, in this session's sandbox, for 30 days" : "exactly this definition, for your sessions, for 30 days",
			},
			{ id: SERVER_NOT_NOW, label: "Not now", approve: false, remembers: null },
		],
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
