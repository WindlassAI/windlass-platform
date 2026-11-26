/**
 * A repository's checks: the commands its user saved that tell whether the code is right (docs/github-and-repositories.md, "A
 * repository's checks"). Windlass runs them before it calls a turn done and sends the agent back with
 * what fails: its verification gate, which runs nothing while no check is set.
 *
 * Whose they are. The user's, kept in their `user` actor, one row per repository of their GitHub
 * connection, under the key the setup command and the secrets use (setup-command.ts,
 * `setupProjectKey`). They are never read from the repository: a file in a repository is something
 * an agent can edit during a turn, and a check a turn can rewrite verifies nothing. A session is
 * handed the list when a turn starts, with its repository's secrets, and the sandbox layer names it
 * to Windlass as required checks when the session opens.
 *
 * What may be saved is what Windlass takes (`checks[]` in its configuration, its docs/user-guide.md),
 * so a list that is saved is one Windlass reads: a list it cannot read fails the turn. `showOutput` is
 * the platform's own, and is handed over only as what a Windlass with required checks takes for it.
 *
 * Saving. The list is one value: a save writes the whole of it in one statement and reads nothing
 * first, so of two saves that run together one stays whole, and neither undoes what another table
 * holds for the repository.
 *
 * This file has no actor in it: the `user` actor hands its database to these functions, and
 * scripts/verified-check.ts runs them against a database of its own.
 */

import { refuseAtRepositoryCap } from "./repository-defaults.js";
import { MAX_CHECKS_PER_REPOSITORY, MAX_CHECK_NAME_CHARS, MAX_CHECK_PATTERNS, MAX_CHECK_PATTERN_CHARS, MAX_CHECK_TIMEOUT_SECONDS, MAX_SETUP_COMMAND_CHARS, type RepositoryCheck, type RepositoryChecks } from "./contract.js";

/** How many repositories one user may have checks for; the ones saved longest ago go first. */
export const MAX_CHECKED_REPOSITORIES = 500;

/** Thrown for a list that cannot be saved; `message` is fit to show. */
export class ChecksProblem extends Error {}

/** Windlass's rule for a check's name: it appears in the report the agent reads and in what it answers with. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The list as it is saved, from what a client sent: each check with the fields Windlass takes, within
 * its limits, and the platform's `showOutput`. Throws ChecksProblem that names the check at fault.
 */
export function cleanChecks(raw: unknown): RepositoryCheck[] {
	if (!Array.isArray(raw)) throw new ChecksProblem("The checks must be a list.");
	if (raw.length > MAX_CHECKS_PER_REPOSITORY) throw new ChecksProblem(`A repository can have ${MAX_CHECKS_PER_REPOSITORY} checks; this list has ${raw.length}.`);
	const checks: RepositoryCheck[] = [];
	for (const [index, item] of raw.entries()) {
		const input = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
		const name = typeof input.name === "string" ? input.name.trim() : "";
		const which = name === "" ? `Check ${index + 1}` : `The check "${name.slice(0, MAX_CHECK_NAME_CHARS)}"`;
		if (name === "") throw new ChecksProblem(`${which} needs a name.`);
		if (name.length > MAX_CHECK_NAME_CHARS || !NAME.test(name)) throw new ChecksProblem(`${which} needs a name of letters, digits, "_", "." and "-" that starts with a letter or a digit, at most ${MAX_CHECK_NAME_CHARS} characters.`);
		if (checks.some((check) => check.name === name)) throw new ChecksProblem(`Two checks are named "${name}". Give each its own name.`);
		const command = typeof input.command === "string" ? input.command.replace(/\r\n?/g, "\n").trim() : "";
		if (command === "") throw new ChecksProblem(`${which} needs a command.`);
		if (command.length > MAX_SETUP_COMMAND_CHARS) throw new ChecksProblem(`${which} has a command of ${command.length} characters; the limit is ${MAX_SETUP_COMMAND_CHARS}. Put a longer one in a script in the repository and run that.`);
		if (command.includes("\0")) throw new ChecksProblem(`${which} has a command with a character a shell cannot take.`);
		const check: RepositoryCheck = { name, command };
		if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== null) {
			const seconds = input.timeoutSeconds;
			if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_CHECK_TIMEOUT_SECONDS) throw new ChecksProblem(`${which} may run for 1 to ${MAX_CHECK_TIMEOUT_SECONDS} seconds.`);
			check.timeoutSeconds = seconds;
		}
		if (input.when !== undefined && input.when !== null) {
			if (!Array.isArray(input.when) || input.when.some((pattern) => typeof pattern !== "string")) throw new ChecksProblem(`${which} needs its file patterns as a list of text.`);
			const when = (input.when as string[]).map((pattern) => pattern.trim()).filter((pattern) => pattern !== "");
			if (when.length > MAX_CHECK_PATTERNS) throw new ChecksProblem(`${which} can have ${MAX_CHECK_PATTERNS} file patterns.`);
			for (const pattern of when) {
				if (pattern.length > MAX_CHECK_PATTERN_CHARS || /[\0\n]/.test(pattern)) throw new ChecksProblem(`${which} has a file pattern Windlass cannot take: one line, at most ${MAX_CHECK_PATTERN_CHARS} characters.`);
				// Windlass keeps "!" for a negation it does not have yet, and refuses the file.
				if (pattern.startsWith("!")) throw new ChecksProblem(`${which} has the file pattern "${pattern}": a pattern cannot start with "!".`);
			}
			// No pattern is no condition: Windlass refuses an empty list.
			if (when.length > 0) check.when = when;
		}
		if (input.showOutput === true) check.showOutput = true;
		checks.push(check);
	}
	return checks;
}

/**
 * The list as Windlass takes it: its own fields and no other, since it refuses a key it does not
 * know. `outputTail: "always"` has it keep the end of a check's output also when the check passed.
 */
export function windlassChecks(checks: readonly RepositoryCheck[]): Array<Record<string, unknown>> {
	return checks.map((check) => ({
		name: check.name,
		command: check.command,
		...(check.timeoutSeconds === undefined ? {} : { timeoutSeconds: check.timeoutSeconds }),
		...(check.when === undefined ? {} : { when: [...check.when] }),
		...(check.showOutput === true ? { outputTail: "always" } : {}),
	}));
}

/** The part of the actor's database these functions use. */
export interface ChecksDb {
	execute<Row extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]>;
}

/** One row per repository: `project` is "github:<GitHub's id>", `label` the repository in words, `checks` the list as JSON. */
export const CHECKS_TABLE = `
	CREATE TABLE IF NOT EXISTS repository_checks (
		project TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		checks TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)
`;

/** The checks saved for a project; none when there is no row, or when the row is not a list this code wrote. */
export async function readChecks(db: ChecksDb, project: string): Promise<RepositoryChecks> {
	const [row] = await db.execute<{ checks: string; updated_at: number }>("SELECT checks, updated_at FROM repository_checks WHERE project = ?", project);
	if (!row) return { checks: [], updatedAt: null };
	try {
		return { checks: cleanChecks(JSON.parse(row.checks)), updatedAt: row.updated_at };
	} catch {
		return { checks: [], updatedAt: row.updated_at };
	}
}

/** Saves a list that was cleaned already, in place of the project's earlier one, and answers with what is saved then; an empty list removes the row. */
export async function saveChecks(db: ChecksDb, project: string, label: string, checks: readonly RepositoryCheck[], now: number): Promise<RepositoryChecks> {
	if (checks.length === 0) {
		await db.execute("DELETE FROM repository_checks WHERE project = ?", project);
	} else {
		await refuseAtRepositoryCap(db, "repository_checks", project, MAX_CHECKED_REPOSITORIES, "checks");
		await db.execute(
			"INSERT INTO repository_checks (project, label, checks, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END, checks = excluded.checks, updated_at = excluded.updated_at",
			project,
			label,
			JSON.stringify(checks),
			now,
		);
	}
	return readChecks(db, project);
}
