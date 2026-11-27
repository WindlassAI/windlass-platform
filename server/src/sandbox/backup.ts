/**
 * A copy of Windlass's own session data, kept outside the sandbox: `SessionBackups` (api.ts) for every
 * provider whose sandboxes can run a shell command, over any `ObjectStore` (server/src/bucket/).
 *
 * ## What Windlass keeps, and what of it is copied
 *
 * Windlass's data directory (provider.ts, `DATA_DIR`), read from its source (packages/core/src/store/,
 * memory/, wake/, snapshot/, auth/; the build 0.1.1+739e1cbc09) and from what a real turn leaves:
 *
 *   sessions/<id>.db            one SQLite database per Windlass session, in WAL mode
 *                               (`journal_mode = WAL`, `synchronous = FULL`): the event log and the
 *                               rows the model's history is read from. A subagent's session is one
 *                               more file here                                             COPIED
 *   sessions/<id>.db-wal        its write-ahead log. A Windlass that closes the session folds it into
 *                               the database and removes it; one that was killed leaves it, holding
 *                               every append since the last checkpoint. A database restored without
 *                               it opens without complaint and has silently lost those turns  COPIED
 *   sessions/<id>.db-shm        the WAL's index: SQLite rebuilds it from the WAL              not copied
 *   sessions/<id>.db-lock, -holder
 *                               the writer lock and the process that holds it: of one machine  not copied
 *   blobs/<aa>/<sha256>         media (images) the sessions' messages refer to by hash      COPIED
 *   memory/**                   Windlass's notes about the user and the project, plain files  COPIED
 *                               (their `.lock` files are not)
 *   index.db                    a cache of the session list, rebuilt from the session files   not copied
 *   snapshots/<hash>/           a private git repository of the workspace's files, for undo and
 *                               diffs. The workspace it describes went with the old sandbox, it can
 *                               be as large as the workspace, and a session resumes without it: the
 *                               first turn in the new sandbox starts a new one               not copied
 *   spill/, approvals/          tool output too long for the log, kept whole in a file the log names
 *                               (a command Windlass sandboxes spills under /tmp instead), and what
 *                               the user allowed for the whole project. A resumed session finds
 *                               neither: an old spilled file is not there to be read again, and
 *                               Windlass asks again. What was allowed for the session is in the
 *                               session's database                                           not copied
 *   wake/                       the wake-ups' database, which holds webhook secrets            NEVER
 *   access-token-*.json         the turn's access token (token-file.ts); removed when a turn ends NEVER
 *   auth.json, auth-pending.json, host-id, auth.lock
 *                               a sign-in. No sandbox holds one (signin/)                      NEVER
 *
 * `session/resume` needs the session's database and, when there is one, its WAL, and nothing else: a
 * new sandbox given only those continues the session with the next `seq` (scripts/backup-check.ts
 * shows it with a real Windlass). What is copied is named, not what is left out: a file Windlass
 * starts to keep tomorrow is not copied until it is added here, so nothing that should stay in the
 * sandbox can leave it by being new.
 *
 * ## How
 *
 * After a turn, and before a turn in a sandbox that replaces a lost one. A `windlass acp` process
 * lives for one turn and the turn code leaves none behind (turn.ts), so between turns nothing has the
 * files open, and a plain `tar` of them is a whole copy: no SQLite tool is needed in the image, and
 * none is there. The archive is one object per agent session, `<prefix>sessions/<uid>/<session>.tgz`,
 * replaced every time.
 *
 * The commands run through the sandbox's handle, so beside Windlass and not under it: Windlass's
 * bubblewrap sandbox gives the agent's own commands no network, and these need the bucket. The server
 * signs a link and the sandbox's curl uses it, so the archive never passes through the server:
 *
 *   save      1. `PACK`: tar and gzip to a file under /tmp, its size and SHA-256 printed. Over the
 *                limit: removed, nothing is uploaded, the earlier copy stays as it was.
 *             2. the server signs a link to PUT exactly that many bytes, good for five minutes.
 *             3. `UPLOAD`: curl sends the file; the archive is removed whatever happens.
 *             4. the server asks the store for the object's size (a HEAD of its own), so that an
 *                upload a sandbox only claimed is not recorded.
 *   restore   1. the server signs a link to GET the object.
 *             2. `RESTORE`: curl fetches it; its size and SHA-256 must be the ones the session
 *                recorded when it was saved, and it may hold nothing but what a copy holds; only
 *                then is it unpacked, and the Windlass session must be among what came out.
 *
 * The link is the only secret in this, and it reaches the sandbox on the command's standard input, as
 * a curl config (`-K -`): it is on no command line, in no environment and in no file. The scripts
 * print one line the server reads (`packed 1234 ab12...`, `http 200`, `curl 28`); nothing else a
 * sandbox prints is kept, logged or shown, so a link cannot come back in an error. `-q` keeps curl from
 * reading a `.curlrc` the agent may have written.
 *
 * A sandbox is the user's agent's to do with as it likes, so nothing here trusts it further than its
 * own session: a link reaches one key, the upload's size is signed and under the limit, and what a
 * restore unpacks goes back into a sandbox of the same session and nowhere else.
 */

import { backupConfig } from "../config.js";
import type { ObjectStore } from "../bucket/store.js";
import type {
	BackupOwner,
	BackupRestoreResult,
	BackupSaveResult,
	SandboxHandle,
	SavedBackup,
	SessionBackups,
} from "./api.js";
import { DATA_DIR, NAME, randomId } from "./provider.js";
import { errorText } from "../util.js";

/** How long a signed link lasts: long enough for a slow upload of the largest archive, short enough to be worth little. */
export const LINK_TTL_MS = 5 * 60 * 1000;
const PACK_TIMEOUT_MS = 2 * 60 * 1000;
/** How long curl may take over one transfer, retries included: inside the link's life. */
const TRANSFER_SECONDS = 180;
const TRANSFER_TIMEOUT_MS = (TRANSFER_SECONDS + 60) * 1000;

/** The agent session's id becomes part of an object's key. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WINDLASS_SESSION = /^ses_[A-Za-z0-9]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The environment a step is given (never a secret), and what each step answers with. The fake sandbox
 * layer has no shell: it reads `WLP_BACKUP_STEP` and plays the step by these same names (sandbox-fake.ts).
 */
export const BACKUP_ENV = {
	step: "WLP_BACKUP_STEP",
	data: "WLP_BACKUP_DATA",
	pack: "WLP_BACKUP_PACK",
	max: "WLP_BACKUP_MAX",
	size: "WLP_BACKUP_SIZE",
	sha256: "WLP_BACKUP_SHA256",
	session: "WLP_BACKUP_SESSION",
	seconds: "WLP_BACKUP_SECONDS",
} as const;

/** The files a copy holds, as paths in Windlass's data directory. `RESTORE` unpacks an archive only when every name in it is one of these. */
const HELD = "^(sessions/[^/]+\\.db(-wal)?|blobs/[0-9a-f][0-9a-f]/[^/]+|memory/.+\\.(md|json|jsonl))$";

/**
 * Packs what a copy holds into `$WLP_BACKUP_PACK`. Prints `packed <bytes> <sha256>`, `empty` when
 * Windlass has no session here, or `too_large <bytes>`: of the archive, or of the files themselves
 * when they are more than ten times the limit, which no compression makes up for and which is then
 * not even tried. The names are sorted and gzip is told to leave out the time, so the same files give
 * the same archive.
 */
export const PACK_SCRIPT = [
	"set -euo pipefail",
	"umask 077",
	'cd "$WLP_BACKUP_DATA"',
	"rm -f /tmp/.wlp-backup-*",
	'list="$WLP_BACKUP_PACK.list"',
	"{",
	"  if [ -d sessions ]; then find sessions -maxdepth 1 -type f \\( -name '*.db' -o -name '*.db-wal' \\) -print0; fi",
	"  if [ -d blobs ]; then find blobs -mindepth 2 -maxdepth 2 -type f -path 'blobs/[0-9a-f][0-9a-f]/*' ! -name '.*' -print0; fi",
	"  if [ -d memory ]; then find memory -type f \\( -name '*.md' -o -name '*.json' -o -name '*.jsonl' \\) ! -name '.*' -print0; fi",
	'} | LC_ALL=C sort -z > "$list"',
	'if ! grep -qz "^sessions/" "$list"; then rm -f "$list"; echo empty; exit 0; fi',
	'raw=$(xargs -0 -r stat -c %s < "$list" | awk \'{ sum += $1 } END { printf "%.0f", sum }\')',
	'if [ "$raw" -gt $((WLP_BACKUP_MAX * 10)) ]; then rm -f "$list"; echo "too_large $raw"; exit 0; fi',
	'tar --null --no-recursion -T "$list" -cf - | gzip -n > "$WLP_BACKUP_PACK"',
	'rm -f "$list"',
	'size=$(stat -c %s "$WLP_BACKUP_PACK")',
	'if [ "$size" -gt "$WLP_BACKUP_MAX" ]; then rm -f "$WLP_BACKUP_PACK"; echo "too_large $size"; exit 0; fi',
	'echo "packed $size $(sha256sum < "$WLP_BACKUP_PACK" | cut -d" " -f1)"',
].join("\n");

/**
 * Sends the archive to the link on standard input and removes it. Prints `http <status>`, `curl <exit
 * code>` when curl could not get an answer (it tries again twice by itself when the failure is one
 * that passes), or `changed` when the archive is not the one that was packed.
 */
export const UPLOAD_SCRIPT = [
	"set -u",
	`trap 'rm -f -- "$WLP_BACKUP_PACK"' EXIT`,
	'if [ ! -f "$WLP_BACKUP_PACK" ] || [ "$(stat -c %s "$WLP_BACKUP_PACK")" != "$WLP_BACKUP_SIZE" ]; then echo changed; exit 0; fi',
	`code=$(curl -q -s -K - -T "$WLP_BACKUP_PACK" -o /dev/null -w '%{http_code}' --connect-timeout 15 --max-time "$WLP_BACKUP_SECONDS" --retry 2 --retry-delay 1 --retry-max-time "$WLP_BACKUP_SECONDS" 2>/dev/null) || { echo "curl $?"; exit 0; }`,
	'echo "http $code"',
].join("\n");

/**
 * Fetches the archive from the link on standard input and unpacks it into Windlass's data directory,
 * which in a sandbox that was just made holds no session. Prints `restored`, or why not: `http
 * <status>` (404: there is no copy), `curl <exit code>`, `size <bytes>` or `hash <sha256>` (it is not
 * the archive that was saved), `contents` (it holds a file a copy never holds), `unpack`, or
 * `no_session` (the Windlass session is not in it). Nothing is unpacked before the checks have passed.
 */
export const RESTORE_SCRIPT = [
	"set -u",
	"umask 077",
	`trap 'rm -f -- "$WLP_BACKUP_PACK"' EXIT`,
	`code=$(curl -q -s -K - -o "$WLP_BACKUP_PACK" -w '%{http_code}' --connect-timeout 15 --max-time "$WLP_BACKUP_SECONDS" --retry 2 --retry-delay 1 --retry-max-time "$WLP_BACKUP_SECONDS" 2>/dev/null) || { echo "curl $?"; exit 0; }`,
	'if [ "$code" != 200 ]; then echo "http $code"; exit 0; fi',
	'size=$(stat -c %s "$WLP_BACKUP_PACK")',
	'if [ "$size" != "$WLP_BACKUP_SIZE" ]; then echo "size $size"; exit 0; fi',
	'hash=$(sha256sum < "$WLP_BACKUP_PACK" | cut -d" " -f1)',
	'if [ "$hash" != "$WLP_BACKUP_SHA256" ]; then echo "hash $hash"; exit 0; fi',
	`names=$(tar -tzf "$WLP_BACKUP_PACK" 2>/dev/null) || { echo unpack; exit 0; }`,
	`if printf '%s\\n' "$names" | grep -qvE '${HELD}'; then echo contents; exit 0; fi`,
	'mkdir -p "$WLP_BACKUP_DATA" && tar -xzf "$WLP_BACKUP_PACK" -C "$WLP_BACKUP_DATA" --no-same-owner --no-same-permissions 2>/dev/null || { echo unpack; exit 0; }',
	'if [ ! -f "$WLP_BACKUP_DATA/sessions/$WLP_BACKUP_SESSION.db" ]; then echo no_session; exit 0; fi',
	"echo restored",
].join("\n");

/** What curl reads its one setting from: the link, and nothing a link could break out of. */
function curlConfig(url: string): string {
	if (/["\\\s]/.test(url)) throw new Error("a signed link holds a character a curl config cannot carry");
	return `url = "${url}"\n`;
}

/** The last line a step printed, when it is one of the answers the step can give; null for anything else. */
function answerOf(stdout: string): string | null {
	const line = stdout.trim().split("\n").pop()?.trim() ?? "";
	return /^(packed \d+ [0-9a-f]{64}|empty|too_large \d+|changed|http \d{3}|curl \d+|size \d+|hash [0-9a-f]{64}|contents|unpack|no_session|restored)$/.test(
		line,
	)
		? line
		: null;
}

const messageOf = (error: unknown) => errorText(error).replace(/\s+/g, " ").trim().slice(0, 300);

export interface SandboxSessionBackupsOptions {
	/** The largest archive that is kept, in bytes. */
	maxBytes: number;
	/** Put before every key, ending in a slash when not empty. */
	prefix?: string;
	now?: () => number;
}

export class SandboxSessionBackups implements SessionBackups {
	readonly maxBytes: number;
	private readonly prefix: string;
	private readonly now: () => number;

	constructor(
		private readonly store: ObjectStore,
		options: SandboxSessionBackupsOptions,
	) {
		this.maxBytes = options.maxBytes;
		this.prefix = options.prefix ?? "";
		this.now = options.now ?? Date.now;
	}

	/** One object per agent session, under its user. */
	keyOf(owner: BackupOwner): string {
		if (
			typeof owner.uid !== "string" ||
			!NAME.test(owner.uid) ||
			typeof owner.sessionId !== "string" ||
			!SESSION.test(owner.sessionId)
		)
			throw new Error("a backup is named by a user id and a session id");
		return `${this.prefix}sessions/${owner.uid}/${owner.sessionId}.tgz`;
	}

	async save(sandbox: SandboxHandle, owner: BackupOwner): Promise<BackupSaveResult> {
		const began = this.now();
		try {
			const key = this.keyOf(owner);
			const pack = `/tmp/.wlp-backup-${randomId(6)}.tgz`;
			const packed = await this.step(
				sandbox,
				"pack",
				PACK_SCRIPT,
				{ [BACKUP_ENV.data]: DATA_DIR, [BACKUP_ENV.pack]: pack, [BACKUP_ENV.max]: String(this.maxBytes) },
				undefined,
				PACK_TIMEOUT_MS,
			);
			if (packed === "empty") return { outcome: "empty" };
			const tooLarge = /^too_large (\d+)$/.exec(packed);
			if (tooLarge !== null) return { outcome: "too_large", size: Number(tooLarge[1]), limit: this.maxBytes };
			const made = /^packed (\d+) ([0-9a-f]{64})$/.exec(packed);
			if (made === null) return { outcome: "failed", reason: `packing answered "${packed}"` };
			const size = Number(made[1]);
			const sha256 = made[2];
			// The sandbox's word for the size is only what the link is made for: more than the limit gets none.
			if (!Number.isSafeInteger(size) || size > this.maxBytes)
				return { outcome: "too_large", size, limit: this.maxBytes };

			const link = await this.store.linkToPut(key, { size, ttlMs: LINK_TTL_MS });
			const sent = await this.step(
				sandbox,
				"upload",
				UPLOAD_SCRIPT,
				{ [BACKUP_ENV.pack]: pack, [BACKUP_ENV.size]: String(size), [BACKUP_ENV.seconds]: String(TRANSFER_SECONDS) },
				curlConfig(link.url),
				TRANSFER_TIMEOUT_MS,
			);
			if (sent !== "http 200") return { outcome: "failed", reason: `the upload answered "${sent}"` };
			// The store's own word that the object is there. When it cannot be asked just now, the upload's answer stands.
			const stored = await this.store.size(key).catch(() => undefined);
			if (stored !== undefined && stored !== size)
				return {
					outcome: "failed",
					reason:
						stored === null
							? "the sandbox reported an upload, but the bucket has no such object"
							: `the sandbox reported an upload of ${size} bytes, but the bucket's object has ${stored}`,
				};
			return { outcome: "saved", backup: { size, sha256, at: this.now() }, ms: this.now() - began };
		} catch (error) {
			return { outcome: "failed", reason: messageOf(error) };
		}
	}

	async restore(
		sandbox: SandboxHandle,
		owner: BackupOwner,
		saved: SavedBackup,
		windlassSessionId: string,
	): Promise<BackupRestoreResult> {
		const began = this.now();
		try {
			if (
				!Number.isSafeInteger(saved.size) ||
				saved.size < 0 ||
				!SHA256.test(saved.sha256) ||
				!WINDLASS_SESSION.test(windlassSessionId)
			)
				return { outcome: "failed", reason: "the session's record of its copy is not usable" };
			const link = await this.store.linkToGet(this.keyOf(owner), { ttlMs: LINK_TTL_MS });
			const answer = await this.step(
				sandbox,
				"restore",
				RESTORE_SCRIPT,
				{
					[BACKUP_ENV.data]: DATA_DIR,
					[BACKUP_ENV.pack]: `/tmp/.wlp-backup-${randomId(6)}.tgz`,
					[BACKUP_ENV.size]: String(saved.size),
					[BACKUP_ENV.sha256]: saved.sha256,
					[BACKUP_ENV.session]: windlassSessionId,
					[BACKUP_ENV.seconds]: String(TRANSFER_SECONDS),
				},
				curlConfig(link.url),
				TRANSFER_TIMEOUT_MS,
			);
			if (answer === "restored") return { outcome: "restored", ms: this.now() - began };
			if (answer === "http 404") return { outcome: "missing" };
			const why: Record<string, string> = {
				contents: "the copy holds a file a copy never holds, so nothing of it was unpacked",
				unpack: "the copy could not be unpacked",
				no_session: "the copy does not hold the Windlass session",
			};
			if (/^(size|hash) /.test(answer))
				return {
					outcome: "failed",
					reason:
						"the bucket's object is not the copy this session saved (its size or its hash differs), so nothing of it was unpacked",
				};
			return { outcome: "failed", reason: why[answer] ?? `the download answered "${answer}"` };
		} catch (error) {
			return { outcome: "failed", reason: messageOf(error) };
		}
	}

	async remove(owner: BackupOwner): Promise<void> {
		await this.store.remove(this.keyOf(owner));
	}

	/**
	 * Runs one script in the sandbox and returns its answer. Whatever else it printed is dropped here:
	 * the standard input may hold a link, and no error of this layer repeats a sandbox's output.
	 */
	private async step(
		sandbox: SandboxHandle,
		name: string,
		script: string,
		env: Record<string, string>,
		stdin: string | undefined,
		timeoutMs: number,
	): Promise<string> {
		let result: Awaited<ReturnType<SandboxHandle["run"]>>;
		try {
			result = await sandbox.run(script, { env: { ...env, [BACKUP_ENV.step]: name }, stdin, timeoutMs, cwd: "/" });
		} catch {
			// A provider's error may quote the command; the command's input is the link.
			throw new Error(`the ${name} step could not be run in the sandbox`);
		}
		if (result.timedOut)
			throw new Error(`the ${name} step took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`);
		const answer = answerOf(result.stdout);
		if (answer === null) throw new Error(`the ${name} step ended with exit code ${result.exitCode} and no answer`);
		return answer;
	}
}

/**
 * The backups of a deployment, from the server's settings (config.ts, "The bucket"): null when no
 * bucket is configured. Says once, where the server's other lines go, whether copies are kept, and
 * which settings are missing when only some are there. Settings that cannot be used turn the feature
 * off with a warning, and never keep the server from running agents; a bucket that refuses the
 * server's key is said when the server starts and not at the first save. The S3 store is loaded only
 * when it is used. No line holds a setting's value.
 */
export async function backupsFromConfig(
	print: (line: string) => void = line => console.log(line),
): Promise<SessionBackups | null> {
	const lost = "an agent whose sandbox is lost starts without its memory of the conversation";
	try {
		const found = backupConfig();
		if (found.bucket === null) {
			if (found.missing.length > 0)
				print(
					`[wlp] WARNING: The bucket for the agents' memory is only partly configured (${found.missing.join(", ")} ${found.missing.length === 1 ? "is" : "are"} not set), so no copy is kept: ${lost}.`,
				);
			else
				print(
					`[wlp] backups: off (no bucket is configured: WLP_BUCKET_ENDPOINT, WLP_BUCKET_NAME, WLP_BUCKET_ACCESS_KEY_ID, WLP_BUCKET_SECRET_ACCESS_KEY): ${lost}.`,
				);
			return null;
		}
		const { S3ObjectStore } = await import("../bucket/s3.js");
		const store = new S3ObjectStore(found.bucket);
		print(
			`[wlp] backups: on. Windlass's session data is copied to the bucket after every turn, up to ${Math.round(found.maxBytes / 1024 / 1024)} MiB a session, and restored into a sandbox that replaces a lost one.`,
		);
		// Asked of an object that does not exist: a bucket that takes the key answers that there is none.
		void store.size(`${found.prefix}sessions/wlp-probe/wlp-probe.tgz`).catch((error: unknown) => {
			print(
				`[wlp] WARNING: The bucket for the agents' memory did not take the server's request (${messageOf(error)}). Until it does, no copy can be saved or restored: check WLP_BUCKET_ENDPOINT, WLP_BUCKET_NAME and the access key.`,
			);
		});
		return new SandboxSessionBackups(store, { maxBytes: found.maxBytes, prefix: found.prefix });
	} catch (error) {
		print(`[wlp] WARNING: The bucket's settings cannot be used (${messageOf(error)}), so no copy is kept: ${lost}.`);
		return null;
	}
}
