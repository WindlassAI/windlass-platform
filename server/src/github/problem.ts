/** A failure with a sentence for the user; `code` is the UserError's code (contract.ts, `publish`). */
export class GithubProblem extends Error {
	constructor(
		readonly code: "github_gone" | "github_denied" | "github_unreachable" | "github_failed",
		message: string,
	) {
		super(message);
		this.name = "GithubProblem";
	}
}
