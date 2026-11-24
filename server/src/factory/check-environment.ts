/**
 * A check that failed because the sandbox could not run its command, not because of the agent's code. Such a
 * failure says nothing about the work: sending the agent back to "fix your code" only loops. The gate asks the
 * person instead (blueprint.ts, `askEnvironment`), and the platform's own checks do not send the agent back for
 * one (sandbox/platform-checks.ts).
 *
 * The whole list, kept small on purpose; anything else that fails is the code's:
 *
 *   package_manager   the package manager refused to run: pnpm's ERR_PNPM_BAD_PM_VERSION (the image's pnpm is
 *                     not the one the repository pins), or corepack's own errors (a `packageManager` field it
 *                     will not serve, a signature it cannot verify, its troubleshooting pointer)
 *   network           a tool could not be fetched: a network refusal (DNS failure, connection refused,
 *                     unreachable) while corepack or a package registry was being reached. In a sandbox without
 *                     network that is the sandbox, and nothing the agent's code can change
 *   not_found         the shell did not find the command: exit status 127
 *
 * What is matched is the check's own output as it was kept (`VerifiedCheck.output`), line by line.
 */

import type { VerifiedCheck } from "../contract.js";

export type EnvironmentKind = "package_manager" | "network" | "not_found";

export interface EnvironmentFailure {
	kind: EnvironmentKind;
	/** The first line of the output that shows it, trimmed and cut to LINE_CHARS; "" where none did (exit 127 with no output). */
	line: string;
}

const LINE_CHARS = 200;

const PACKAGE_MANAGER: readonly RegExp[] = [
	/ERR_PNPM_BAD_PM_VERSION/,
	/This project is configured to use \S+ because .+ has a "packageManager" field/,
	/github\.com\/nodejs\/corepack#troubleshooting/,
	/Cannot find matching keyid/,
];
const NETWORK_REFUSAL = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|getaddrinfo|Temporary failure in name resolution|Could not resolve host|Network is unreachable/;
/** What fetches a tool: corepack, or a package registry. */
const TOOL_FETCH = /corepack|registry\.npmjs\.org|registry\.yarnpkg\.com|ERR_PNPM_META_FETCH_FAIL|pypi\.org|files\.pythonhosted\.org|proxy\.golang\.org|crates\.io/i;
const NOT_FOUND = /command not found|: not found|No such file or directory/;

// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g;

function lines(output: string): string[] {
	return output.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(CONTROL, "").trim()).filter(Boolean);
}

const cut = (line: string) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line);

/**
 * Why `check` failed for its environment, or null when it did not (passed, failed for its code, timed out, was
 * stopped, or was never started: a check with `startError` is not started, which is told apart already).
 */
export function environmentFailure(check: Pick<VerifiedCheck, "status" | "exitCode" | "output" | "startError">): EnvironmentFailure | null {
	if (check.startError !== undefined) return null;
	if (check.status !== "failed" && check.status !== "could_not_start") return null;
	const out = lines(check.output ?? "");
	if (out.some((line) => TOOL_FETCH.test(line))) {
		const refused = out.find((line) => NETWORK_REFUSAL.test(line));
		if (refused !== undefined) return { kind: "network", line: cut(refused) };
	}
	const refused = out.find((line) => PACKAGE_MANAGER.some((pattern) => pattern.test(line)));
	if (refused !== undefined) return { kind: "package_manager", line: cut(refused) };
	if (check.exitCode === 127) return { kind: "not_found", line: cut(out.find((line) => NOT_FOUND.test(line)) ?? out[0] ?? "") };
	return null;
}

/** How much of a check's output the person's question carries (`ItemQuestion.check.excerpt`). */
export const EXCERPT_LINES = 20;
const EXCERPT_CHARS = 2_000;

/** The end of what the check printed, for the person: at most EXCERPT_LINES lines and EXCERPT_CHARS characters. */
export function outputExcerpt(output: string | undefined): string {
	const kept = (output ?? "").replace(/\r\n?/g, "\n").replace(CONTROL, "").trimEnd().split("\n").slice(-EXCERPT_LINES).join("\n");
	return kept.length > EXCERPT_CHARS ? kept.slice(-EXCERPT_CHARS) : kept;
}
