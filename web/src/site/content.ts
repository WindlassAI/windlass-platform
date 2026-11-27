/**
 * The landing page's words, kept apart from its markup so that the page, its FAQPage JSON-LD and
 * llms.txt say the same thing. Every claim here is one the platform's code and README back: no
 * dates for agents that are not built, no prices, no numbers that were not measured.
 */

export const LANDING_TITLE = "Windlass — coding agents in sandboxes you choose";

export const LANDING_DESCRIPTION =
	"Run coding agents (Windlass, Claude Code) in sandboxes you choose, hosted or on your own machine. Watch every turn live and take the work as a pull request.";

/** One sentence an answer engine can quote as is. */
export const ONE_LINER =
	"Windlass is a platform that runs coding agents (Windlass and Claude Code) in isolated sandboxes, hosted or on your own machine, shows every step live in the browser, and turns finished work into GitHub pull requests.";

export interface Agent {
	name: string;
	state: "available" | "planned";
	where: string;
}

export const AGENTS: Agent[] = [
	{
		name: "Windlass",
		state: "available",
		where: "Hosted sandboxes and your own machines. The platform's own agent, a coding agent for the terminal.",
	},
	{
		name: "Claude Code",
		state: "available",
		where: "On a machine of your own, signed in there with your own Claude account.",
	},
	{
		name: "OpenCode",
		state: "available",
		where: "On a machine of your own, with any API-key provider OpenCode supports or its free models.",
	},
	{ name: "Codex", state: "planned", where: "Planned. Not available yet." },
];

export interface Feature {
	key: string;
	title: string;
	text: string;
}

export const SESSION_FEATURES: Feature[] = [
	{
		key: "start",
		title: "Start from a prompt",
		text: "Pick the agent, the model, the mode and the repository, then say what you want done.",
	},
	{
		key: "watch",
		title: "Watch it live",
		text: "Every file it reads, every command it runs and what it cost, as it happens.",
	},
	{
		key: "steer",
		title: "Steer mid-turn",
		text: "A message sent while it works is read at its next step. Stop one call without ending the turn.",
	},
	{
		key: "ask",
		title: "Answer its questions",
		text: "When a command wants the network or a write outside the workspace, it asks: allow once, for the session, or decline with a note.",
	},
	{ key: "diff", title: "Read the diff", text: "The workspace's changes after every turn, file by file." },
	{
		key: "publish",
		title: "Publish a pull request",
		text: "Through the Windlass GitHub App, on the repositories you connect.",
	},
];

export interface Step {
	label: string;
	text: string;
}

/** The Factory's sequence, as server/src/factory/blueprint.ts fixes it. */
export const FACTORY_STEPS: Step[] = [
	{ label: "file", text: "From the Factory page, the API, or a GitHub issue: a “windlass” label or an @mention" },
	{ label: "implement", text: "An agent works the task in a sandbox of its own" },
	{ label: "check", text: "Your repository's checks run; a failure goes back to the agent" },
	{ label: "pull request", text: "The platform pushes the branch and opens the pull request" },
	{ label: "ci", text: "CI is read; failing checks and their logs go back to the agent" },
	{ label: "review", text: "A second agent reviews the pushed commit, with screenshots where enabled" },
	{ label: "ready for you", text: "A verdict built from what was observed, never from the agent's words" },
];

export interface Faq {
	question: string;
	answer: string;
}

export const FAQ: Faq[] = [
	{
		question: "What is Windlass?",
		answer:
			"Windlass is a platform that runs coding agents for you. Each agent session works in a sandbox of its own, hosted or on a machine of yours, and the browser shows every step as it happens: the files read, the commands run, the questions asked and the changes made. Finished work becomes a pull request on GitHub. Windlass is also the name of the platform's own agent, a coding agent for the terminal.",
	},
	{
		question: "Which coding agents can it run?",
		answer:
			"Three today: Windlass, on hosted sandboxes and on your own machines; Claude Code, on a machine of your own where it is signed in with your Claude account; and OpenCode, on a machine of your own with any API-key provider it supports or its free models. Codex is planned and not available yet.",
	},
	{
		question: "Where does the agent's code run?",
		answer:
			"Choose Hosted or pair your own Mac, Linux or Windows (WSL) computer with Docker. Your computer connects to Windlass.",
	},
	{
		question: "How are agents isolated?",
		answer:
			"Each agent has its own workspace. In Strict, commands are locked down and have no internet access. In Open, commands can reach the internet and read credentials in the workspace.",
	},
	{
		question: "What is the Factory?",
		answer:
			'The Factory carries a task to a pull request by itself. You file a work item on the Factory page, through the API, or by labelling a GitHub issue “windlass” or @mentioning the Windlass app on it. An agent implements it, your checks and CI are read and failures go back to the agent, a second agent can review the result, and the item lands in your "Ready for you" list with a verdict. The platform never merges: you do, on GitHub.',
	},
	{
		question: "Does it work with GitHub?",
		answer:
			"Yes, through the Windlass GitHub App. Connect the repositories you choose; sessions publish their work as pull requests, work items can be filed from issues, and the Factory reads CI on the pushed commit.",
	},
	{
		question: "How do I get access, and what does it cost?",
		answer:
			"Access is by invitation while the platform is young: an invited account signs in, and everyone else is refused. There is no public sign-up and no pricing yet.",
	},
];
