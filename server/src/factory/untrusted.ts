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
 *
 * A cross-repo feature's other repository (factory/cross-repo.ts) is the same: its tree, which the
 * planner reads at `.windlass-inputs/<alias>`, is a repository the person bound at filing with write
 * access, the bar the primary meets, so it is trusted as the primary's files are, whoever owns it. No
 * issue or third party chose it. The combined run's result is the run's own text, like CI logs, and is
 * marked as such (`untrustedWords.integration`).
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
	/** A cross-repo feature's combined run on GitHub Actions: what it said, as GitHub reported it. */
	integration: "the combined run's result",
};

/**
 * The sources written by someone other than the item's person: an issue of someone else's, and GitHub
 * feedback with any other writer, also as a subtask or a feature inherited them (the same words). The
 * rest (CI logs, the second reviewer's findings, the builder's report, subtask reports) is text the
 * platform's own run made: no person outside put it there, though what it quotes is not vouched for.
 */
export function thirdParty(list: readonly string[] | undefined | null): string[] {
	return sources(list).filter(source => THIRD_PARTY.some(form => form.test(source)));
}

/** `untrustedWords.issue` and `untrustedWords.feedback`, as they begin: every source is made by those words. */
const THIRD_PARTY = [/^issue #\d+ by @/, /^GitHub feedback from /];

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
 * On "Docker, hardened" Windlass runs with approval "full", and once a session is tainted it puts
 * commands back into its bubblewrap sandbox, which Docker's default seccomp profile does not let start:
 * every command would ask, and an item's turn refuses what asks. So there no source is marked. Text of
 * the run's own goes as labelled text only (`hardenedUnmarkedNote`); a turn with someone else's text
 * does not start (this sentence) until the person chooses to run it anyway (`FactoryItem.unsandboxed`),
 * and then it too goes labelled only, its commands outside Windlass's sandbox.
 */
export const hardenedRefusal = (list: readonly string[]) =>
	`This turn carries text from someone else (${sources(list).join("; ")}). On “Docker, hardened” Windlass cannot sandbox commands once it is told of such text, so the text would go to the agent labelled only, and its commands would run outside Windlass's sandbox, with the container's network and the session's access token. Run it anyway, file the work again on “Docker + Windlass sandbox”, or give up.`;

/** What stops a turn on "Docker, hardened" (above): its sources of someone else's, unless the person chose to run them anyway. */
export function hardenedStop(list: readonly string[] | undefined, unsandboxed: boolean | undefined): string[] {
	return unsandboxed ? [] : thirdParty(list);
}

/** Once per session, on "Docker, hardened", where no source is marked (above). */
export const hardenedUnmarkedNote = (list: readonly string[]) =>
	`On “Docker, hardened” Windlass is not told that this text is not yours (${sources(list).join("; ")}), since it could not sandbox commands once told. The text went to the agent as labelled text only, and commands run as on any turn.`;

/** Once per session, when the sandbox's Windlass does not take the marker (before 0.6.0). */
export const unmarkedNote = (list: readonly string[]) =>
	`This sandbox's Windlass cannot be told which text came from someone else (${sources(list).join("; ")}); it went to the agent as labelled text only. Windlass 0.6.0 or later marks it.`;

/** Once per session, for an agent that has no marker at all (Claude Code, OpenCode). */
export const agentUnmarkedNote = (agent: string, list: readonly string[]) =>
	`${agent} cannot be told which text came from someone else (${sources(list).join("; ")}); it went to the agent as labelled text only, and the agent runs its commands without asking.`;
