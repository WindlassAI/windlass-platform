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
import { DATA_DIR, shellQuote } from "./provider.js";

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
	/** `proof` must also not be empty (`test -s`), not only be a regular file. */
	proofNotEmpty?: boolean;
	/**
	 * A `root` that is not there means there is no session to copy (`empty`), not a failed save: an agent
	 * that makes its data directory at its first write. Without it, a missing `root` fails the save.
	 */
	missingRootIsEmpty?: boolean;
	/**
	 * Shell run in `root` before the files are listed, such as an export of the session to a file of
	 * `copied`. Its exit status is its last command's (it runs as an `if` condition, where `set -e` does
	 * not hold), so it is one chain of `&&`. Its output is dropped; when it fails, packing answers
	 * `export` and nothing is uploaded. Leaving no file `present` names, it makes the copy `empty`.
	 */
	beforePack?: string;
	/**
	 * Shell run in `root` after a checked unpack and its proof, such as an import of the exported
	 * session. One chain of `&&`, its output dropped; when it fails, the restore answers `import`.
	 */
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

/** A UUID, lower case: Claude Code's session ids (v4) and Codex's thread ids (v7, `CODEX_SESSION_FILES`). */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * ## What Claude Code keeps, and what of it is copied
 *
 * Its config directory: no `CLAUDE_CONFIG_DIR` is set (not by wlp-claude-acp, the image, hosted-keys.ts or
 * the runner), so `~/.claude` of the agent user. Read from Claude Code 2.1.328 (the native binary of
 * `@anthropic-ai/claude-agent-sdk-linux-<arch>` 0.3.328) and `@agentclientprotocol/claude-agent-acp`
 * 0.109.0 (`paths.js`, `resumed-session.js` `findTranscript`, `session-status.js`, `subagent-history.js`),
 * and from what a real turn in the harness image leaves:
 *
 *   projects/<slug>/<id>.jsonl  the session's transcript, append-only JSON lines: every message, tool
 *                               call and result. `<slug>` is the turn's cwd with every character that
 *                               is not a letter or a digit made `-` (`/workspace`: `-workspace`; a
 *                               review's directory: another). The adapter and the CLI look for
 *                               `<id>.jsonl` under every `projects/*`, so the slug need not match the
 *                               new sandbox's. A new sandbox given only this file resumes the session
 *                               and appends to it                                           COPIED
 *   projects/<slug>/<id>/subagents/agent-<agent>.jsonl
 *                               the transcripts of the session's subagents, replayed on a load COPIED
 *   projects/<slug>/<id>/tool-results/*
 *                               tool output too long for the transcript, which names the file COPIED
 *   projects/<slug>/memory/     Claude's notes for the project: of the cwd, shared by every session
 *                               there, and not needed for a resume                        not copied
 *   file-history/<id>/          copies of files before Claude edited them, for rewinding: as large as
 *                               the workspace, which went with the old sandbox             not copied
 *   todos/, sessions/, plugins/, statsig/, logs/, settings*.json
 *                               to-do lists, a registry of running processes, plugin and feature
 *                               caches, logs, and the image's or the repository's settings  not copied
 *   session-env/, shell-snapshots/
 *                               the environment of the session's shells: may hold the turn's
 *                               placeholders                                                  NEVER
 *   .credentials.json           a sign-in (OAuth). No sandbox has one, but the agent may log in NEVER
 *   ~/.claude.json, backups/    outside the root: the user and machine ids, and with a sign-in its
 *                               account; `backups/` holds copies of it                        NEVER
 *
 * A session id is a UUID (the adapter's `SESSION_ID_PATTERN`; the CLI makes v4, in lower case), so
 * `<id>` names no other session's files. The transcript is append-only and no database is involved: a
 * plain tar between turns is consistent, and a turn killed while writing leaves at most a cut last line.
 */
export const CLAUDE_SESSION_FILES: SessionFiles = Object.freeze({
	root: "/home/agent/.claude",
	id: `^${UUID}$`,
	copied: Object.freeze([
		{ under: "projects", minDepth: 2, maxDepth: 2, path: "projects/-*/<id>.jsonl" },
		{ under: "projects", minDepth: 4, maxDepth: 4, path: "projects/-*/<id>/subagents/*", names: ["agent-*.jsonl"] },
		{ under: "projects", minDepth: 4, maxDepth: 4, path: "projects/-*/<id>/tool-results/*", noDotNames: true },
	]),
	present: "^projects/-[^/]*/<id>\\.jsonl$",
	held: "^projects/-[^/]*/<id>(\\.jsonl|/subagents/agent-[^/]+\\.jsonl|/tool-results/[^./][^/]*)$",
	proof: "projects/*/<id>.jsonl",
	proofNotEmpty: true,
	missingRootIsEmpty: true,
});

/**
 * ## What Codex keeps, and what of it is copied
 *
 * `CODEX_HOME=/opt/wlp-codex/home`, set by the image and by hosted-keys.ts. The folder is root's; the
 * agent user owns only the subfolders the image made for it. Read from `@openai/codex` 0.171.0 and
 * `@agentclientprotocol/codex-acp` 2.9.0 (its `session/resume` is the app server's `thread/resume`), and
 * from what a real turn in the harness image leaves:
 *
 *   sessions/YYYY/MM/DD/rollout-<created>-<id>.jsonl
 *                               the thread's rollout, append-only JSON lines: everything a resume
 *                               reads. The date and time are when the thread was made, so the path is
 *                               found, not computed. A new sandbox given only this file, at the same
 *                               path, resumes the thread: `thread/resume` indexes it again into a new
 *                               `sqlite/state_5.sqlite` and appends to it                    COPIED
 *   archived_sessions/          threads the user archived. The platform archives none       not copied
 *   sqlite/*.sqlite             databases shared by every thread (`CODEX_SQLITE_HOME`): the thread
 *                               index, a projection of each rollout, logs, goals, memories. All are
 *                               rebuilt from the rollouts; `state_5` also holds remote-control
 *                               enrollments and `logs_2` request detail                        NEVER
 *   shell_snapshots/            the environment of the thread's shells: may hold the turn's
 *                               placeholders                                                  NEVER
 *   log/, tmp/, .tmp/, cache/, skills/, thread-writer-locks/
 *                               logs, scratch, caches and the writer locks of one machine     NEVER
 *   auth.json, installation_id, config.toml, .env, rules/, hooks.json
 *                               a sign-in (no sandbox has one: the bearer comes per turn over
 *                               `providers/set`), the machine's id, and the user's configuration NEVER
 *
 * A thread's id is a UUID v7. A child thread the model spawns is another rollout with its own id, and is
 * not copied with its parent (the platform runs Codex without subtasks). A rollout is append-only, so a
 * plain tar between turns is consistent.
 */
export const CODEX_SESSION_FILES: SessionFiles = Object.freeze({
	root: "/opt/wlp-codex/home",
	id: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
	copied: Object.freeze([
		{
			under: "sessions",
			minDepth: 4,
			maxDepth: 4,
			path: "sessions/[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9]/*",
			names: ["rollout-*-<id>.jsonl"],
		},
	]),
	present: "^sessions/[0-9]{4}/[0-9]{2}/[0-9]{2}/rollout-[^/]+-<id>\\.jsonl$",
	held: "^sessions/[0-9]{4}/[0-9]{2}/[0-9]{2}/rollout-[^/]+-<id>\\.jsonl$",
	proof: "sessions/*/*/*/rollout-*-<id>.jsonl",
	proofNotEmpty: true,
	missingRootIsEmpty: true,
});

/**
 * The environment OpenCode's export and import run with: wlp-opencode-acp's, without the provider's key
 * and settings (neither is needed, and neither may reach a file), and the data directory named, so that
 * the session is read from and written to the database the agent's turns use whatever the step's own
 * environment holds. They run as whatever user the provider runs the step as, which is the user it runs
 * the agent's turn as (`SandboxHandle.run`, `TurnSandbox.start`): the agent user, owner of the database.
 */
const OPENCODE_ENV = [
	"env",
	"-u OPENCODE_AUTH_CONTENT",
	"-u OPENCODE_CONFIG_CONTENT",
	"HOME=/home/agent",
	"XDG_DATA_HOME=/home/agent/.local/share",
	"XDG_CONFIG_HOME=/etc/wlp-opencode",
	"OPENCODE_PURE=true",
	"OPENCODE_DISABLE_PROJECT_CONFIG=true",
	"OPENCODE_DISABLE_MODELS_FETCH=true",
	"OPENCODE_DISABLE_AUTOUPDATE=true",
	"OPENCODE_DISABLE_EXTERNAL_SKILLS=true",
	"OPENCODE_DISABLE_CLAUDE_CODE=true",
	"OPENCODE_DISABLE_LSP_DOWNLOAD=true",
].join(" ");

/**
 * Checks an export of OpenCode's (`node -e <this> <file> <id>`): the session `<id>`, its messages and
 * their parts, as `opencode export` 1.19.6 writes them (`{info, messages: [{info, parts}]}`), and nothing
 * else: no other key at the top or in a message, no message or part of another session, and no key
 * anywhere named like a credential. That last is stricter than OpenCode's export needs (none of its rows
 * has such a field: those are in `account`, `control_account`, `credential` and `session_share`, which
 * it never reads), so a session whose tool call has an argument of such a name is not copied.
 */
const OPENCODE_EXPORT_CHECK = [
	"const [file, id] = process.argv.slice(1);",
	'const data = JSON.parse(require("fs").readFileSync(file, "utf8"));',
	'const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);',
	"const only = (v, keys) => plain(v) && Object.keys(v).every(k => keys.includes(k));",
	"const named = /^(access_?token|refresh_?token|id_?token|api_?key|secret|client_?secret|password|credentials?|authorization|cookie)$/i;",
	"const clean = v => Array.isArray(v) ? v.every(clean) : plain(v) ? Object.entries(v).every(([k, x]) => !named.test(k) && clean(x)) : true;",
	'const ok = only(data, ["info", "messages"]) && plain(data.info) && data.info.id === id && Array.isArray(data.messages) &&',
	'  data.messages.every(m => only(m, ["info", "parts"]) && plain(m.info) && m.info.sessionID === id && Array.isArray(m.parts) &&',
	"    m.parts.every(p => plain(p) && p.sessionID === id)) && clean(data);",
	"process.exit(ok ? 0 : 1);",
].join("\n");

const OPENCODE_EXPORT = 'wlp-backup/"$WLP_BACKUP_SESSION".json';

/**
 * ## What OpenCode keeps, and what of it is copied
 *
 * `XDG_DATA_HOME` is not set (wlp-opencode-acp sets only `XDG_CONFIG_HOME=/etc/wlp-opencode`), so
 * `~/.local/share/opencode` of the agent user. Read from OpenCode 1.19.6 (the release the image pins)
 * and from what a real turn in the harness image leaves:
 *
 *   opencode.db (-wal, -shm)    ONE SQLite database for every session and project: `session`,
 *                               `message`, `part`, `todo`, `event`, `project`, `permission`, ... and
 *                               `account` (access and refresh tokens), `control_account`, `credential`
 *                               (keys) and `session_share` (share secrets). Empty with the platform's
 *                               keys, which come in the environment, but filled by an agent that runs
 *                               `opencode auth login`                                          NEVER
 *   wlp-backup/<id>.json        the platform's: `opencode export <id>` before packing (`beforePack`),
 *                               checked (`OPENCODE_EXPORT_CHECK`): the session, its messages and their
 *                               parts. After unpacking, `opencode import` puts it into the new
 *                               sandbox's database and the file is removed (`afterUnpack`). A new
 *                               sandbox given only that, as the research for #133 did by hand, resumes
 *                               the session over ACP's `session/resume`                       COPIED
 *   snapshot/, repos/, tool-output/
 *                               a git repository of the workspace for undo, clones, and tool output
 *                               kept whole: the workspace went with the old sandbox          not copied
 *   log/, auth.json             logs, and an older version's sign-in                          NEVER
 *
 * What the export leaves out (to-dos, the event log, context epochs, child sessions with their own
 * ids) a resume does without. The export reads through SQLite and is consistent while no other OpenCode
 * runs, which the save makes sure of first (agent-session/workspace.ts, `saveBackup`). A session id is
 * `ses_` and 26 letters and digits.
 */
export const OPENCODE_SESSION_FILES: SessionFiles = Object.freeze({
	root: "/home/agent/.local/share/opencode",
	id: "^ses_[0-9A-Za-z]{26}$",
	copied: Object.freeze([{ under: "wlp-backup", maxDepth: 1, names: ["<id>.json"] }]),
	present: "^wlp-backup/<id>\\.json$",
	held: "^wlp-backup/<id>\\.json$",
	proof: "wlp-backup/<id>.json",
	proofNotEmpty: true,
	missingRootIsEmpty: true,
	// No database: no session, nothing exported, and the copy is `empty`.
	beforePack:
		"rm -rf wlp-backup && { [ ! -f opencode.db ] || { mkdir wlp-backup" +
		` && ${OPENCODE_ENV} opencode export "$WLP_BACKUP_SESSION" > wlp-backup/.export` +
		` && node -e ${shellQuote(OPENCODE_EXPORT_CHECK)} wlp-backup/.export "$WLP_BACKUP_SESSION"` +
		` && mv wlp-backup/.export ${OPENCODE_EXPORT}; }; }`,
	afterUnpack: [
		`node -e ${shellQuote(OPENCODE_EXPORT_CHECK)} ${OPENCODE_EXPORT} "$WLP_BACKUP_SESSION"`,
		`${OPENCODE_ENV} opencode import ${OPENCODE_EXPORT}`,
		`${OPENCODE_ENV} opencode export "$WLP_BACKUP_SESSION" > /dev/null`,
		"rm -rf wlp-backup",
	].join(" && "),
});

/** The descriptions by agent. An agent whose record has `backups` must have one here (backup-check holds them together). */
const SESSION_FILES: Partial<Record<HarnessId, SessionFiles>> = {
	windlass: WINDLASS_SESSION_FILES,
	claude: CLAUDE_SESSION_FILES,
	codex: CODEX_SESSION_FILES,
	opencode: OPENCODE_SESSION_FILES,
};

/** The description of an agent's session files, when its sessions are copied; null when they are not. Windlass's for none. */
export function sessionFilesOf(harness: HarnessId | undefined = "windlass"): SessionFiles | null {
	if (!capabilitiesOf(harness).backups) return null;
	return SESSION_FILES[harness] ?? null;
}

/**
 * Whether the agent keeps its sessions in Windlass's data directory (`DATA_DIR`): the one folder a
 * Docker provider may put on a volume that outlives the sandbox (volumes.ts, session-data.ts). Every
 * other agent's sessions are on the sandbox's own disk, and go with it.
 */
export function keptInDataDir(harness: HarnessId | undefined): boolean {
	return sessionFilesOf(harness)?.root === DATA_DIR;
}
