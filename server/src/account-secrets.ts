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
 * Whom they reach. MCP servers, and never a repository's setup command. Beyond that an account's
 * secret has a repository's two scopes (`SecretScope`), and to Windlass it is the repository's
 * secret of that scope without the setup command. "setup", the default, is MCP servers only: it
 * goes into Windlass's own environment, where a server's definition reads it, and it is named in
 * `withholdEnv`, so no command the agent runs is given it. An MCP server a project names reads it
 * the same way, once its user has approved that server, and the question about such a server says
 * so. Where the agent's commands are not held in Windlass's sandbox, a withheld variable can still
 * be read from Windlass's process, so there such a secret stays out of Windlass's environment
 * altogether, MCP servers go without it, and the settings page says so (`accountSecretReach`): the
 * line a repository's secrets keep. "agent" is also the agent's commands: its user chose that
 * whatever a command can read may be read, so it is handed over in every sandbox, and a server that
 * reads it starts where commands are not sandboxed too.
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

import {
	type AccountSecret,
	type AccountSecrets,
	MAX_ACCOUNT_SECRETS,
	type SandboxProfile,
	type SecretReach,
	type SecretScope,
} from "./contract.js";
import {
	type CommandSandbox,
	type OpenedSecret,
	SecretProblem,
	type WindlassSecrets,
	commandSandbox,
	secretReach,
	windlassEnvironment,
} from "./repo-secrets.js";
import type { DefaultsDb } from "./repository-defaults.js";

/** What an account's sealed value is bound to where a repository's is bound to its repository. No repository's key can be this. */
export const ACCOUNT_SECRET_PROJECT = "account";

/**
 * One row per name. `scope` is a repository's secret's ("setup": MCP servers only, "agent": also the
 * agent's commands). `sealed` is the value, encrypted for this user, the account and the name;
 * nothing else here is secret.
 */
export const ACCOUNT_SECRETS_TABLE = `
	CREATE TABLE IF NOT EXISTS account_secret (
		name TEXT PRIMARY KEY,
		scope TEXT NOT NULL DEFAULT 'setup',
		sealed TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)
`;

// ---------------------------------------------------------------------------------------------
// Whom they reach
// ---------------------------------------------------------------------------------------------

type Promises = Pick<SandboxProfile, "approval" | "commandNetwork" | "commandsCanReadAccessToken">;

export function accountSecretReach(scope: SecretScope, profile: Promises): SecretReach {
	return secretReach(scope, profile, "account");
}

/**
 * Why a sandbox of `profile` hands MCP servers only some of the account's secrets, in a sentence
 * for a session's panel; null where every one of them is handed over.
 */
export function accountSecretsNote(profile: Promises): string | null {
	const sandbox: CommandSandbox = commandSandbox(profile);
	const only =
		"Of your account's secrets, MCP servers are given only those that are also for the agent's commands in this sandbox";
	if (sandbox === "none")
		return `${only}: the agent's commands run here without Windlass's sandbox, where a command can read whatever Windlass was handed for an MCP server from Windlass's own process. A server that reads another one does not start.`;
	if (sandbox === "unknown")
		return `${only}: it has not been established that Windlass can sandbox the agent's commands here, and a command it cannot sandbox can read whatever Windlass was handed for an MCP server from Windlass's own process. A server that reads another one does not start.`;
	return null;
}

/** A secret of the account with its value, as a session holds it in memory for one turn. */
export interface OpenedAccountSecret {
	name: string;
	scope: SecretScope;
	value: string;
}

/** The account's secrets a session is handed: those no secret of its repository has the name of. */
export function accountSecretsFor(
	account: readonly OpenedAccountSecret[],
	repository: readonly Pick<OpenedSecret, "name">[],
): OpenedAccountSecret[] {
	return account.filter(secret => !repository.some(other => other.name === secret.name));
}

/**
 * What a turn's Windlass gets of its repository's secrets and of the account's, in a sandbox of
 * `profile` (`windlassEnvironment`, repo-secrets.ts). An account's secret is handed over as a
 * repository's secret of its scope is: one for MCP servers only where commands are held in
 * Windlass's sandbox, and named in `withholdEnv`; one that is also for the agent's commands
 * everywhere. One whose name a secret of the repository has is left out, whatever becomes of the
 * repository's.
 */
export function turnEnvironment(
	repository: readonly OpenedSecret[],
	account: readonly OpenedAccountSecret[],
	profile: Promises,
): WindlassSecrets {
	return windlassEnvironment([...repository, ...accountSecretsFor(account, repository)], profile);
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

/** Thrown when the account keeps as many secrets as it may. */
export class TooManySecrets extends SecretProblem {}
/** Thrown for a change of the scope of a secret that is not saved. */
export class SecretNotFound extends SecretProblem {}

/**
 * Saves a secret whose name and scope were cleaned already. With `sealed`, a value sealed already:
 * a new secret, or a new value for the one of that name. One statement writes it, a new name only
 * while the account keeps fewer than `limit`. Without: the scope of the one of that name. Throws
 * TooManySecrets at the limit, and SecretNotFound for a scope of a name that is not saved.
 */
export async function saveAccountSecret(
	db: DefaultsDb,
	name: string,
	scope: SecretScope,
	sealed: string | undefined,
	now: number,
	limit = MAX_ACCOUNT_SECRETS,
): Promise<void> {
	if (sealed === undefined) {
		await db.execute("UPDATE account_secret SET scope = ?, updated_at = ? WHERE name = ?", scope, now, name);
		const [row] = await db.execute<{ name: string }>("SELECT name FROM account_secret WHERE name = ?", name);
		if (!row) throw new SecretNotFound(`No secret named ${name} is saved for your account.`);
		return;
	}
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await db.execute(
			`INSERT INTO account_secret (name, scope, sealed, updated_at)
			SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM account_secret WHERE name = ?) OR (SELECT COUNT(*) FROM account_secret) < ?
			ON CONFLICT (name) DO UPDATE SET scope = excluded.scope, sealed = excluded.sealed, updated_at = excluded.updated_at`,
			name,
			scope,
			sealed,
			now,
			name,
			limit,
		);
		// Another value saved under the name since is the newer one, and stays.
		const [row] = await db.execute<{ name: string }>("SELECT name FROM account_secret WHERE name = ?", name);
		if (row) return;
		const [count] = await db.execute<{ n: number }>("SELECT COUNT(*) AS n FROM account_secret");
		if (Number(count?.n ?? 0) >= limit)
			throw new TooManySecrets(`An account can keep ${limit} secrets, and yours has that many. Delete one first.`);
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
	return new Set(rows.map(row => String(row.name)));
}

/**
 * The account's secrets as a client is sent them: the name, the scope, when each last changed, what
 * it reaches in a sandbox of `profile` made now, and the repositories that have a secret of their own under
 * its name. The value's column is not read, so no value can be in the answer. `repositories` are
 * the rows of the repositories' secrets that share a name with one of these: the key
 * ("github:<GitHub's id>") and what the repository was called when it was saved.
 */
export function listedAccountSecrets(
	rows: ReadonlyArray<{ name: string; scope: string; updated_at: number }>,
	repositories: ReadonlyArray<{ name: string; project: string; label: string }>,
	profile: SandboxProfile,
): AccountSecrets {
	return {
		profile: profile.id,
		secrets: rows.map((row): AccountSecret => {
			const name = String(row.name);
			const scope: SecretScope = row.scope === "agent" ? "agent" : "setup";
			const shared = repositories
				.filter(other => other.name === name)
				.map(other => (other.label !== "" ? other.label : `repository ${other.project.replace(/^github:/, "")}`));
			return {
				name,
				scope,
				updatedAt: Number(row.updated_at),
				reach: accountSecretReach(scope, profile),
				repositories: [...new Set(shared)].sort((a, b) => a.localeCompare(b)),
			};
		}),
	};
}
