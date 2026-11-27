/**
 * Which of an agent's files make up one of its sessions: what a copy of the session holds (backup.ts).
 * One description per agent whose record says it is copied (`HarnessCapabilities.backups`); backup.ts
 * itself knows no agent's paths. What is copied is named, not what is left out: a file an agent starts
 * to keep tomorrow is not copied until its description names it, so nothing that should stay in the
 * sandbox can leave it by being new.
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
 * shows it with a real Windlass). Windlass's copy holds every session of the directory, not only the
 * one named: a subagent's session is its own file, and the directory is the session's own where it
 * is copied at all (session-data.ts).
 */

import type { HarnessId } from "../contract.js";
import { capabilitiesOf } from "./harnesses.js";
import { DATA_DIR } from "./provider.js";

/**
 * One `find` over a folder of the agent's data directory. In `path` and `names`, `<id>` stands for the
 * session's id, which the pack script checks against `SessionFiles.id` before it lists anything.
 */
export interface FileRule {
	/** The folder searched, relative to the data directory, a plain name; a missing one adds nothing. */
	under: string;
	minDepth?: number;
	maxDepth?: number;
	/** A `find -path` glob the file's path from the data directory must match (its `*` matches `/` too). */
	path?: string;
	/** `find -name` globs, one of which the file's name must match; without any, every name. */
	names?: readonly string[];
	/** Leaves out names that begin with a dot. */
	noDotNames?: boolean;
}

/**
 * Where an agent keeps one session, for the copy of it. Regexes are POSIX extended ones that bash, grep
 * and JavaScript read alike. In `present`, `held` and `proof`, `<id>` stands for the session's id, which
 * the server checks against `id` and puts in before a script sees them.
 */
export interface SessionFiles {
	/** The agent's data directory in the sandbox. A copy's paths are relative to it. */
	root: string;
	/** What the agent's session ids look like. Nothing is packed or restored for any other. */
	id: string;
	/** The files a copy holds. */
	copied: readonly FileRule[];
	/** A name among the files that must be there for there to be a session to copy; otherwise there is nothing to copy. */
	present: string;
	/** The names a restore unpacks: an archive holding any other name is not unpacked at all. */
	held: string;
	/** A glob, relative to `root`, that a regular file must match after unpacking: the session came back. Without spaces. */
	proof: string;
	/** Shell run in `root` before the files are listed, such as an export of the session to a file of `copied`. */
	beforePack?: string;
	/** Shell run in `root` after a checked unpack and its proof, such as an import of the exported session. */
	afterUnpack?: string;
}

export const WINDLASS_SESSION_FILES: SessionFiles = Object.freeze({
	root: DATA_DIR,
	id: "^ses_[A-Za-z0-9]{1,64}$",
	copied: Object.freeze([
		{ under: "sessions", maxDepth: 1, names: ["*.db", "*.db-wal"] },
		{ under: "blobs", minDepth: 2, maxDepth: 2, path: "blobs/[0-9a-f][0-9a-f]/*", noDotNames: true },
		{ under: "memory", names: ["*.md", "*.json", "*.jsonl"], noDotNames: true },
	]),
	present: "^sessions/",
	held: "^(sessions/[^/]+\\.db(-wal)?|blobs/[0-9a-f][0-9a-f]/[^/]+|memory/.+\\.(md|json|jsonl))$",
	proof: "sessions/<id>.db",
});

/** The descriptions by agent. An agent whose record has `backups` must have one here (backup-check holds them together). */
const SESSION_FILES: Partial<Record<HarnessId, SessionFiles>> = { windlass: WINDLASS_SESSION_FILES };

/** The description of an agent's session files, when its sessions are copied; null when they are not. Windlass's for none. */
export function sessionFilesOf(harness: HarnessId | undefined = "windlass"): SessionFiles | null {
	if (!capabilitiesOf(harness).backups) return null;
	return SESSION_FILES[harness] ?? null;
}
