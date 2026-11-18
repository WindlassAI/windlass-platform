/**
 * The account's secrets: named values a user saves once, for their own MCP servers
 * (personal-servers.ts), which read them as `${NAME}` in a definition's `env` or `headers`. They are
 * built on a repository's secrets (repo-secrets.ts) and differ from them in whose they are and whom
 * they reach.
 *
 * Whose they are. The user's, in their `user` actor, one row per name, the value sealed as a
 * repository's is (signin/seal.ts, purpose "secret") and bound to the user, to the account in place
 * of a repository (`ACCOUNT_SECRET_PROJECT`) and to the name: a value put into another row, or into
 * a repository's, does not open there. A value comes in from the user's browser once and is never
 * sent back: the listing reads no value. What may be saved is what a repository's secret may be
 * (`cleanSecretName`, `cleanSecretValue`).
 *
 * Whom they reach. MCP servers, and nothing else: an account's secret is never handed to the
 * repository's setup command and never offered to the commands the agent runs. To Windlass it is
 * what a repository's secret of the scope "setup and MCP servers" is, without the setup command: it
 * goes into Windlass's own environment, where a server's definition reads it, and it is named in
 * `withholdEnv`, so no command the agent runs is given it. An MCP server a project names reads it
 * the same way, once its user has approved that server, and the question about such a server says
 * so. Where the agent's commands are not held in Windlass's sandbox, a withheld variable can still
 * be read from Windlass's process, so there an account's secret stays out of Windlass's environment
 * altogether, MCP servers go without it, and the settings page says so (`accountSecretReach`): the
 * line a repository's secrets keep.
 *
 * One name, two secrets. A session on a repository that has a secret of the same name as one of the
 * account's is handed the repository's, with its value and its scope, and not the account's: what
 * is saved for the one repository is the more particular choice, as with the defaults. Both values
 * are taken out of what the session shows.
 *
 * Saving. One statement, which reads nothing first: the value is written under its name, and a new
 * name only while the account keeps fewer than it may. So secrets saved together both stay, and the
 * limit holds however they interleave.
 *
 * This file has no actor in it: the `user` actor hands its database to these functions, and
 * scripts/account-check.ts runs them against a database of its own.
 */

import { type AccountSecret, type AccountSecrets, MAX_ACCOUNT_SECRETS, type SandboxProfile, type SecretReach } from "./contract.js";
import { type CommandSandbox, type OpenedSecret, SecretProblem, type WindlassSecrets, commandSandbox, secretReach, windlassEnvironment } from "./repo-secrets.js";
import type { DefaultsDb } from "./repository-defaults.js";

/** What an account's sealed value is bound to where a repository's is bound to its repository. No repository's key can be this. */
export const ACCOUNT_SECRET_PROJECT = "account";

/** One row per name. `sealed` is the value, encrypted for this user, the account and the name; nothing else here is secret. */
export const ACCOUNT_SECRETS_TABLE = `
	CREATE TABLE IF NOT EXISTS account_secret (
		name TEXT PRIMARY KEY,
		sealed TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)
`;

// ---------------------------------------------------------------------------------------------
// Whom they reach
// ---------------------------------------------------------------------------------------------

type Promises = Pick<SandboxProfile, "approval" | "commandNetwork" | "commandsCanReadAccessToken">;

/** What is left of an account's secret that MCP servers are not given: it has no setup command to go to. */
const NOTHING_GETS_IT = "So nothing is given it there.";

/**
 * What an account's secret of this name reaches in a sandbox of `profile`, whose Windlass takes the
 * lists of variable names or not (`lists`): what a repository's secret for the setup command and MCP
 * servers reaches there, without the setup command. `commands` is never "yes".
 */
export function accountSecretReach(name: string, profile: Promises, lists: boolean): SecretReach {
	return secretReach(name, "setup", profile, lists, NOTHING_GETS_IT);
}

/**
 * Why a sandbox of `profile` hands the account's secrets to no MCP server, or to some only, in a
 * sentence for a session's panel; null where every one of them is handed over.
 */
export function accountSecretsNote(profile: Promises, lists: boolean): string | null {
	const sandbox: CommandSandbox = commandSandbox(profile);
	if (sandbox === "none") return "Your account's secrets are not given to MCP servers in this sandbox: the agent's commands run here without Windlass's sandbox, where a command can read whatever Windlass was handed for an MCP server from Windlass's own process. A server that reads one does not start.";
	if (sandbox === "unknown") return "Your account's secrets are not given to MCP servers in this sandbox: it has not been established that Windlass can sandbox the agent's commands here, and a command it cannot sandbox can read whatever Windlass was handed for an MCP server from Windlass's own process. A server that reads one does not start.";
	if (lists) return null;
	return "This sandbox has an older Windlass, which passes every variable it has on to the agent's commands unless its name looks like a credential (it contains TOKEN, KEY, SECRET or PASSWORD, for example). So an account's secret is given to MCP servers here only under such a name, and a server that reads another one does not start.";
}

/** A secret of the account with its value, as a session holds it in memory for one turn. */
export interface OpenedAccountSecret {
	name: string;
	value: string;
}

/** The account's secrets a session is handed: those no secret of its repository has the name of. */
export function accountSecretsFor(account: readonly OpenedAccountSecret[], repository: readonly Pick<OpenedSecret, "name">[]): OpenedAccountSecret[] {
	return account.filter((secret) => !repository.some((other) => other.name === secret.name));
}

/**
 * What a turn's Windlass gets of its repository's secrets and of the account's, in a sandbox of
 * `profile` (`windlassEnvironment`, repo-secrets.ts). An account's secret is handed over as a
 * repository's secret for MCP servers is: where commands are held in Windlass's sandbox, and named
 * in `withholdEnv`. One whose name a secret of the repository has is left out, whatever becomes of
 * the repository's.
 */
export function turnEnvironment(repository: readonly OpenedSecret[], account: readonly OpenedAccountSecret[], profile: Promises, lists: boolean): WindlassSecrets {
	const own = accountSecretsFor(account, repository).map((secret): OpenedSecret => ({ name: secret.name, scope: "setup", value: secret.value }));
	return windlassEnvironment([...repository, ...own], profile, lists);
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

/** Thrown when the account keeps as many secrets as it may. */
export class TooManySecrets extends SecretProblem {}

/**
 * Saves a value that was sealed already under a name that was cleaned already: a new secret, or a
 * new value for the one of that name. One statement writes it, a new name only while the account
 * keeps fewer than `limit`. Throws TooManySecrets at the limit.
 */
export async function saveAccountSecret(db: DefaultsDb, name: string, sealed: string, now: number, limit = MAX_ACCOUNT_SECRETS): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await db.execute(
			`INSERT INTO account_secret (name, sealed, updated_at)
			SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM account_secret WHERE name = ?) OR (SELECT COUNT(*) FROM account_secret) < ?
			ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
			name,
			sealed,
			now,
			name,
			limit,
		);
		// Another value saved under the name since is the newer one, and stays.
		const [row] = await db.execute<{ name: string }>("SELECT name FROM account_secret WHERE name = ?", name);
		if (row) return;
		const [count] = await db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM account_secret");
		if (Number(count?.n ?? 0) >= limit) throw new TooManySecrets(`An account can keep ${limit} secrets, and yours has that many. Delete one first.`);
		// Neither saved nor at the limit: a secret was deleted between the two statements. Once more.
	}
	throw new Error("the secret could not be saved");
}

export async function deleteAccountSecret(db: DefaultsDb, name: string): Promise<void> {
	await db.execute("DELETE FROM account_secret WHERE name = ?", name);
}

/** The names of the account's secrets. */
export async function accountSecretNames(db: DefaultsDb): Promise<Set<string>> {
	const rows = await db.execute<{ name: string }>("SELECT name FROM account_secret");
	return new Set(rows.map((row) => String(row.name)));
}

/**
 * The account's secrets as a client is sent them: the name, when each last changed, what it reaches
 * in a sandbox of `profile` made now, and the repositories that have a secret of their own under
 * its name. The value's column is not read, so no value can be in the answer. `repositories` are
 * the rows of the repositories' secrets that share a name with one of these: the key
 * ("github:<GitHub's id>") and what the repository was called when it was saved.
 */
export function listedAccountSecrets(rows: ReadonlyArray<{ name: string; updated_at: number }>, repositories: ReadonlyArray<{ name: string; project: string; label: string }>, profile: SandboxProfile): AccountSecrets {
	return {
		profile: profile.id,
		secrets: rows.map((row): AccountSecret => {
			const name = String(row.name);
			const shared = repositories.filter((other) => other.name === name).map((other) => (other.label !== "" ? other.label : `repository ${other.project.replace(/^github:/, "")}`));
			return { name, updatedAt: Number(row.updated_at), reach: accountSecretReach(name, profile, true), repositories: [...new Set(shared)].sort((a, b) => a.localeCompare(b)) };
		}),
	};
}
