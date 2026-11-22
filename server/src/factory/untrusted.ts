/**
 * Text the platform hands an item's agent without vouching for it, and how Windlass is told.
 *
 * Someone else's issue, CI logs, GitHub feedback from people other than the item's person, a second
 * reviewer's findings, the builder's report the reviewer reads, and the reports of other subtasks are
 * all written by someone (or something) other than the item's person. The platform labels them in the
 * prompt for the model ("quoted data", "untrusted text"), and also names where they came from on the
 * turn: each `TurnPlan` and `deliver` effect carries `untrusted`, the sources in the person's words.
 *
 * The session sends the sources with the prompt, as Windlass 0.6.0 takes them
 * (`session/prompt` `_meta["windlass/untrusted"]: { source }`, its docs/acp.md): the session is tainted
 * before the turn's first step, so a command that would use the network or run outside Windlass's
 * sandbox, and a tool that could send data out, asks again; in an item's unattended turn that is refused
 * and recorded. Taint stays for the rest of the session.
 *
 * Trusted, and never marked: the platform's own sentences, the item's body when the person wrote it (on
 * the page, through the API, or as the issue's own author), the person's notes and answers (an
 * `ask_person` answer among them), and the person's own feedback on GitHub. The repository's files are
 * the workspace, which Windlass trusts by decision.
 */

/** The longest source Windlass takes (its docs/acp.md, `_meta["windlass/untrusted"]`). */
export const UNTRUSTED_SOURCE_MAX = 200;

/** A commit as the person reads it; a head that is no commit id (a branch git named instead) as it is. */
const short = (head: string) => (/^[0-9a-f]{40}$/.test(head) ? head.slice(0, 7) : head.slice(0, 60));

/** Each source as the person reads it on the timeline and in Windlass's approval wording. */
export const untrustedWords = {
	issue: (number: number, author: string) => `issue #${number} by @${author}`,
	ci: (head: string) => `CI logs of ${short(head)}`,
	feedback: (writers: string) => `GitHub feedback from ${writers}`,
	review: (head: string) => `the second reviewer's findings on ${short(head)}`,
	builder: (pr: number) => `the builder's report on pull request #${pr}`,
	reports: "reports of the feature's subtasks",
	earlier: "reports of earlier subtasks",
};

/** The sources of several pieces of text, each once, in order. */
export function sources(...lists: Array<readonly string[] | undefined | null>): string[] {
	return [...new Set(lists.flatMap(list => list ?? []).map(source => source.trim()).filter(Boolean))];
}

/** One source for Windlass: the sources joined, cut to its limit (never refused for length). Null for none. */
export function untrustedSource(list: readonly string[] | undefined): string | null {
	const joined = sources(list).join("; ");
	if (!joined) return null;
	return joined.length <= UNTRUSTED_SOURCE_MAX ? joined : joined.slice(0, UNTRUSTED_SOURCE_MAX - 1).trimEnd() + "…";
}

/**
 * Why a Windlass turn with outside text does not start on "Docker, hardened": Windlass runs there with
 * approval "full", and once the session is tainted it puts commands back into its bubblewrap sandbox,
 * which Docker's default seccomp profile does not let start. Every command would ask, and an item's turn
 * refuses what asks: the turn could do nothing.
 */
export const hardenedRefusal = (list: readonly string[]) =>
	`This turn carries text from someone else (${sources(list).join("; ")}). On “Docker, hardened” Windlass cannot sandbox commands once such text is in the conversation, so it would refuse every command. File the work again on “Docker + Windlass sandbox”, or give up.`;

/** Once per session, when the sandbox's Windlass does not take the marker (before 0.6.0). */
export const unmarkedNote = (list: readonly string[]) =>
	`This sandbox's Windlass cannot be told which text came from someone else (${sources(list).join("; ")}); it went to the agent as labelled text only. Windlass 0.6.0 or later marks it.`;

/** Once per session, for an agent that has no marker at all (Claude Code, OpenCode). */
export const agentUnmarkedNote = (agent: string, list: readonly string[]) =>
	`${agent} cannot be told which text came from someone else (${sources(list).join("; ")}); it went to the agent as labelled text only, and the agent runs its commands without asking.`;
