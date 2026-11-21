import { ACCOUNT_SECRET_PROJECT } from "../account-secrets.js";
import { openSecret, sealSecret } from "../repo-secrets.js";
import type { DefaultsDb } from "../repository-defaults.js";
import { SealError, type Sealer } from "./seal.js";

/** The owner of the rows upgrades the ciphertext before handing it to a session. */
export async function refreshSecretRows(db: DefaultsDb, sealer: Sealer, uid: string, project: string, rows: { name: string; sealed: string }[]): Promise<void> {
	for (const row of rows) {
		if (sealer.isCurrent(row.sealed)) continue;
		let plaintext: string;
		try {
			plaintext = openSecret(sealer, uid, project, row.name, row.sealed);
		} catch (error) {
			// The session already reports unreadable values individually.
			if (error instanceof SealError) continue;
			throw error;
		}
		const replacement = sealSecret(sealer, uid, project, row.name, plaintext);
		if (project === ACCOUNT_SECRET_PROJECT) {
			await db.execute("UPDATE account_secret SET sealed = ? WHERE name = ? AND sealed = ?", replacement, row.name, row.sealed);
		} else {
			await db.execute("UPDATE repo_secret SET sealed = ? WHERE project = ? AND name = ? AND sealed = ?", replacement, project, row.name, row.sealed);
		}
		row.sealed = replacement;
	}
}
