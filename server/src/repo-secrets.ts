/**
 * A repository's secrets: named values (an API key, a registry token, a database address) a user saves
 * for a repository of their GitHub connection, which the platform hands to that repository's sessions
 * as environment variables. This file has the rules: what may be saved, what a scope comes to in each
 * kind of sandbox, how a value is sealed, and how saved values are taken out of text.
 *
 * Whose they are. The user's, saved in their `user` actor, one row per repository and name, the value
 * sealed (signin/seal.ts, purpose "secret", bound to the user, the repository and the name). A session
 * reads its repository's secrets from there when a turn starts and holds the values in memory for
 * that turn only: never in its stored state. A value is never sent to a browser after it is saved.
 * Which repository a session's secrets are for is what its setup command is saved for
 * (`setupProjectOf`, setup-command.ts): a session on a pasted address or with no repository has none.
 *
 * Who gets them. The setup command gets every secret. Beyond that a secret has a scope, and what the
 * scope can be made to mean is decided by Windlass, which hands on its own environment by a rule
 * (packages/core/src/sandbox/policy.ts, command.ts and mcp/config.ts in its source):
 *
 *   an MCP server      gets the variables its definition names (`${NAME}`), from Windlass's own environment
 *   a sandboxed command gets every variable of Windlass's environment except those whose names look
 *                      like credentials (`looksLikeCredential` below repeats that rule)
 *   an unsandboxed command (approval "full" until untrusted content is in the conversation, and any
 *                      command where Windlass's sandbox does not work) gets all of them
 *
 * The session opener sets two lists in Windlass's metadata:
 * a variable in `withholdEnv` is given to no command and still to an MCP server, and a credential-looking
 * one in `passEnv` is given to sandboxed commands too. With them a scope is exact where Windlass
 * sandboxes every command: a secret for the setup command and MCP servers is handed to Windlass and
 * named in `withholdEnv`, and one for the agent's commands as well is named in `passEnv` when its name
 * would keep it from them. Where commands run without Windlass's sandbox, a withheld variable is not
 * given to a command and can still be read by it, from Windlass's own process, so withholding is not
 * relied on there: a secret that is not for the agent's commands stays out of Windlass's
 * environment, MCP servers go without it, and the interface says so.
 *
 * Redaction. Every saved value of a session's repository is taken out of what the sandbox layer hands
 * on: a turn's events, a setup run's output, error text. `SecretRedactor` does it by value, also for
 * a value split over two pieces of a stream. A value a program changed before printing it (base64,
 * a part of it) is not found, and nothing here keeps a value from a program that was handed it.
 */

import {
	MAX_SECRETS_PER_REPOSITORY,
	MAX_SECRET_NAME_CHARS,
	MAX_SECRET_VALUE_BYTES,
	MIN_SECRET_VALUE_CHARS,
	type RepositorySecrets,
	type SandboxProfile,
	type SecretReach,
	type SecretScope,
} from "./contract.js";
import type { DefaultsDb } from "./repository-defaults.js";
import type { Sealer } from "./signin/seal.js";

/** How many secrets one user may have over all repositories. Reaching it refuses a new one: nothing is dropped to make room. */
export const MAX_SECRETS_PER_USER = 2_000;

export { MAX_SECRETS_PER_REPOSITORY };

/** The database belongs to one user; the value is already sealed for uid, project and name. */
export async function saveRepoSecret(
	db: DefaultsDb,
	{
		project,
		label,
		name,
		sealed,
		scope,
		now,
	}: { uid: string; project: string; label: string; name: string; sealed: string; scope: SecretScope; now: number },
): Promise<"saved" | "replaced" | "repository_full" | "account_full"> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		// Keep the pre-write existence check so RETURNING can distinguish two concurrent saves of the same name.
		const [saved] = await db.execute<{ replaced: number }>(
			`WITH prior AS MATERIALIZED (SELECT EXISTS (SELECT 1 FROM repo_secret WHERE project = ? AND name = ?) AS present)
			INSERT INTO repo_secret (project, name, label, scope, sealed, updated_at)
			SELECT ?, ?, ?, ?, ?, ? FROM prior WHERE present OR (
				(SELECT COUNT(*) FROM repo_secret WHERE project = ?) < ? AND (SELECT COUNT(*) FROM repo_secret) < ?)
			ON CONFLICT (project, name) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END,
				scope = excluded.scope, sealed = excluded.sealed, updated_at = excluded.updated_at
			RETURNING (SELECT present FROM prior) AS replaced`,
			project,
			name,
			project,
			name,
			label,
			scope,
			sealed,
			now,
			project,
			MAX_SECRETS_PER_REPOSITORY,
			MAX_SECRETS_PER_USER,
		);
		if (saved) return saved.replaced ? "replaced" : "saved";
		const [counts] = await db.execute<{ here: number; total: number }>(
			"SELECT (SELECT COUNT(*) FROM repo_secret WHERE project = ?) AS here, COUNT(*) AS total FROM repo_secret",
			project,
		);
		if (counts && counts.here >= MAX_SECRETS_PER_REPOSITORY) return "repository_full";
		if (counts && counts.total >= MAX_SECRETS_PER_USER) return "account_full";
		// A deletion freed a place between the refused write and the count. Try once more.
	}
	throw new Error("the repository secret could not be saved");
}

// ---------------------------------------------------------------------------------------------
// What may be saved
// ---------------------------------------------------------------------------------------------

/** Thrown for a name, value or scope that cannot be saved; `message` is fit to show and never holds a value. */
export class SecretProblem extends Error {}

/**
 * Names the sandbox, Windlass or the platform's own commands depend on. A secret is put into the
 * environment of the setup command and of Windlass, so one of these names would change how they run:
 * where programs are found and loaded, where Windlass keeps its data (`XDG_*`), what the Windlass
 * executable is (`BUN_*`: it is a Bun program), how the shell starts (`BASH_ENV`, `ENV`), where
 * Windlass sends the user's access token (the proxy variables). `DOCKER_*` is refused because the
 * local Docker layer hands a value to `docker exec` through the client's own environment.
 */
const RESERVED_PREFIXES = ["WLP_", "WINDLASS_", "LD_", "XDG_", "BUN_", "NODE_", "DOCKER_", "E2B_", "LC_", "BASH_"];
const RESERVED_NAMES = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LANGUAGE",
	"TZ",
	"TERM",
	"HOSTNAME",
	"IFS",
	"ENV",
	"SHLVL",
	"_",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"PAGER",
	"GIT_PAGER",
	"GIT_TERMINAL_PROMPT",
];

/** Whether the platform, Windlass or the sandbox relies on a variable of this name, in any case of letters. */
export function isReservedName(name: string): boolean {
	const upper = name.toUpperCase();
	return RESERVED_NAMES.includes(upper) || RESERVED_PREFIXES.some(prefix => upper.startsWith(prefix));
}

/** These variables configure the agent adapters, model relays and Git credentials. */
const REQUEST_RESERVED_NAMES = [
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"INITIAL_AGENT_MODE",
	"DISABLE_MCP_CONFIG_FILTERING",
	"MCP_TOOL_TIMEOUT",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_EXEC_PATH",
	"GIT_PROXY_COMMAND",
	"GIT_CONFIG",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"AWS_CA_BUNDLE",
	"PIP_CERT",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"PYTHONHOME",
	"PYTHONINSPECT",
	"PYTHONUSERBASE",
	"PYTHONWARNINGS",
	"PERL5OPT",
	"PERL5LIB",
	"PERLLIB",
	"RUBYOPT",
	"RUBYLIB",
	"RUBYGEMS_GEMDEPS",
	"GEM_HOME",
	"GEM_PATH",
	"JAVA_TOOL_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"DOTNET_STARTUP_HOOKS",
	"GCONV_PATH",
	"SSLKEYLOGFILE",
	"CURL_HOME",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
];
const REQUEST_RESERVED_PREFIXES = [
	"CODEX_",
	"CLAUDE_",
	"OPENCODE_",
	"GIT_CONFIG_",
	"GIT_SSL_",
	"DYLD_",
	"OPENSSL_",
	"NPM_CONFIG_",
];

/** A request may name an ordinary environment variable, never one owned by the platform or its harness. */
export function validRequestedSecretName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		/^[A-Z][A-Z0-9_]{1,63}$/.test(name) &&
		!isReservedName(name) &&
		!name.endsWith("_PROXY") &&
		!REQUEST_RESERVED_NAMES.includes(name) &&
		!REQUEST_RESERVED_PREFIXES.some(prefix => name.startsWith(prefix))
	);
}

export const unavailableSecretName = (name: string) =>
	`${name} cannot be requested; ask your person to set it under Secrets if you need it.`;
export const MAX_SECRET_REQUESTS = 3;

/** Ordinary questions count toward the point at which a builder must stop requesting secrets. */
export function secretRequestLimit(
	name: string,
	asks: number,
	declined: readonly string[],
	period: "run" | "session",
): string | null {
	if (asks >= MAX_SECRET_REQUESTS)
		return `No more secret requests are allowed in this ${period}; three questions have already been recorded.`;
	return declined.includes(name) ? unavailableSecretName(name) : null;
}

/** The name as it is saved: an environment variable's. Throws SecretProblem. */
export function cleanSecretName(raw: unknown): string {
	if (typeof raw !== "string" || raw === "") throw new SecretProblem("A secret needs a name.");
	if (raw.length > MAX_SECRET_NAME_CHARS)
		throw new SecretProblem(`A secret's name can be at most ${MAX_SECRET_NAME_CHARS} characters long.`);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw))
		throw new SecretProblem(
			"A secret's name is an environment variable's: letters, digits and underscores, not starting with a digit.",
		);
	if (isReservedName(raw))
		throw new SecretProblem(
			`${raw} cannot be a secret's name: the sandbox or Windlass relies on a variable of that name.`,
		);
	return raw;
}

/**
 * The value as it is saved: exactly what was sent, with the line ends of a text field made plain.
 * Throws SecretProblem for anything else than text, for one shorter than MIN_SECRET_VALUE_CHARS (it
 * could not be taken out of what is shown), longer than MAX_SECRET_VALUE_BYTES, or with a NUL, which no
 * environment can carry. The message never repeats the value.
 */
export function cleanSecretValue(raw: unknown): string {
	if (typeof raw !== "string") throw new SecretProblem("A secret's value must be text.");
	const value = raw.replace(/\r\n?/g, "\n");
	if (value.includes("\0"))
		throw new SecretProblem("A secret's value holds a character an environment variable cannot take.");
	if (value.trim().length < MIN_SECRET_VALUE_CHARS)
		throw new SecretProblem(
			`A secret's value must be at least ${MIN_SECRET_VALUE_CHARS} characters long: a shorter one could not be taken out of what the platform shows.`,
		);
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > MAX_SECRET_VALUE_BYTES)
		throw new SecretProblem(
			`A secret's value can be at most ${MAX_SECRET_VALUE_BYTES.toLocaleString("en-US")} bytes long; this one is ${bytes.toLocaleString("en-US")}.`,
		);
	return value;
}

export function cleanSecretScope(raw: unknown): SecretScope {
	if (raw === "setup" || raw === "agent") return raw;
	throw new SecretProblem("A secret is for the setup command and MCP servers, or for the agent's commands as well.");
}

// ---------------------------------------------------------------------------------------------
// What a scope comes to
// ---------------------------------------------------------------------------------------------

/**
 * Windlass's `isCredentialName` (packages/core/src/sandbox/policy.ts), repeated: the names it keeps
 * from the commands it sandboxes unless it is told otherwise. The platform has to know the answer
 * before starting Windlass so it can explicitly pass credential-like names to sandboxed commands.
 */
const CREDENTIAL_WORDS = [
	"TOKEN",
	"KEY",
	"SECRET",
	"PASSWORD",
	"PASSWD",
	"PASSPHRASE",
	"CREDENTIAL",
	"PRIVATE",
	"COOKIE",
];
const CREDENTIAL_SEGMENTS = ["AUTH", "PAT"];
const CREDENTIAL_PREFIXES = [
	"AWS_",
	"AZURE_",
	"ARM_",
	"GOOGLE_",
	"GCLOUD_",
	"GCP_",
	"CLOUDSDK_",
	"OCI_",
	"DIGITALOCEAN_",
	"HCLOUD_",
	"LINODE_",
	"VAULT_",
	"OPENAI_",
	"ANTHROPIC_",
	"CLAUDE_",
	"GEMINI_",
	"MISTRAL_",
	"GROQ_",
	"COHERE_",
	"OPENROUTER_",
	"HF_",
	"HUGGINGFACE_",
	"HUGGING_FACE_",
	"XAI_",
	"DEEPSEEK_",
	"TOGETHER_",
	"FIREWORKS_",
	"REPLICATE_",
	"PERPLEXITY_",
	"VOYAGE_",
	"LANGCHAIN_",
	"LANGSMITH_",
];
const CREDENTIAL_NAMES = [
	"DATABASE_URL",
	"KUBECONFIG",
	"DOCKER_HOST",
	"DOCKER_CONFIG",
	"GPG_AGENT_INFO",
	"DBUS_SESSION_BUS_ADDRESS",
	"NETRC",
];

/** The four lists, for a check that holds them against Windlass's source (scripts/secrets-check.ts). */
export const CREDENTIAL_RULE = {
	words: CREDENTIAL_WORDS,
	segments: CREDENTIAL_SEGMENTS,
	prefixes: CREDENTIAL_PREFIXES,
	names: CREDENTIAL_NAMES,
};

/** Whether Windlass keeps a variable of this name from the commands it sandboxes. */
export function looksLikeCredential(name: string): boolean {
	const upper = name.toUpperCase();
	if (CREDENTIAL_NAMES.includes(upper)) return true;
	if (CREDENTIAL_PREFIXES.some(prefix => upper.startsWith(prefix))) return true;
	if (CREDENTIAL_WORDS.some(word => upper.includes(word))) return true;
	return upper.split("_").some(segment => CREDENTIAL_SEGMENTS.includes(segment));
}

/**
 * What a profile promises about the commands the agent runs (sandbox/profiles.ts):
 *
 *   "windlass"   Windlass sandboxes every one of them: approval "auto", and the profile promises its sandbox
 *   "none"       they run directly in the sandbox machine: approval "full"
 *   "unknown"    approval "auto" where it has not been established that Windlass's sandbox works (E2B
 *                before its check has passed): a command runs sandboxed, or, asked about first, without
 */
export type CommandSandbox = "windlass" | "none" | "unknown";

/** The fields of a profile that say it. */
type Promises = Pick<SandboxProfile, "approval" | "commandNetwork" | "commandsCanReadAccessToken">;

export function commandSandbox(profile: Promises): CommandSandbox {
	if (profile.approval === "full") return "none";
	return !profile.commandNetwork && !profile.commandsCanReadAccessToken ? "windlass" : "unknown";
}

/** Whose a secret is: a repository's goes to its setup command whatever its scope, an account's has no setup command to go to (account-secrets.ts). */
export type SecretOwner = "repository" | "account";
/** What is left of a secret that MCP servers are not given. */
const LEFT: Record<SecretOwner, string> = {
	repository: "Only the setup command gets it.",
	account: "So nothing is given it there.",
};

/**
 * Which processes can receive a secret of this scope in the selected profile.
 */
export function secretReach(scope: SecretScope, profile: Promises, owner: SecretOwner = "repository"): SecretReach {
	const left = LEFT[owner];
	if (scope === "agent") return { servers: true, commands: "yes", note: null };
	const sandbox = commandSandbox(profile);
	if (sandbox === "windlass") return { servers: true, commands: "no", note: null };
	return {
		servers: false,
		commands: "no",
		note:
			sandbox === "none"
				? `MCP servers are not given it in this sandbox: the agent's commands run there without Windlass's sandbox, where a command can read whatever Windlass was handed for an MCP server from Windlass's own process. ${left}`
				: `MCP servers are not given it in this sandbox: it has not been established that Windlass can sandbox the agent's commands there, and a command it cannot sandbox can read whatever Windlass was handed for an MCP server from Windlass's own process. ${left}`,
	};
}

/**
 * A repository's secrets as a client is sent them: the name, the scope, when each last changed, and
 * what it reaches in a sandbox of `profile`. Each
 * entry is made here from those fields and no other, so whatever else a row holds, the value
 * included, is not in the answer.
 */
export function listedSecrets(
	rows: ReadonlyArray<{ name: string; scope: string; updated_at: number }>,
	profile: SandboxProfile,
): RepositorySecrets {
	return {
		profile: profile.id,
		secrets: rows.map(row => {
			const scope: SecretScope = row.scope === "agent" ? "agent" : "setup";
			return { name: String(row.name), scope, updatedAt: Number(row.updated_at), reach: secretReach(scope, profile) };
		}),
	};
}

/** A secret with its value, as a session holds it in memory for one turn. */
export interface OpenedSecret {
	name: string;
	scope: SecretScope;
	value: string;
}

/** What the repository's setup command is handed: every secret. */
export function setupEnvironment(secrets: readonly OpenedSecret[]): Record<string, string> {
	return Object.fromEntries(secrets.map(secret => [secret.name, secret.value]));
}

/** What Windlass is handed of a repository's secrets for one turn, and told about them when its session is opened. */
export interface WindlassSecrets {
	/** What is put into Windlass's own environment: the secrets that reach MCP servers (`secretReach`). */
	env: Record<string, string>;
	/** Of those, the names no command the agent runs is to be given. */
	withholdEnv: string[];
	/** Of those, the credential-looking names that sandboxed commands are to be given all the same. */
	passEnv: string[];
}

/**
 * Every secret in Windlass's environment that is not for the agent's commands is named in
 * `withholdEnv`, whatever its name, and such a secret is in its environment only where commands are
 * held in its sandbox, which is where withholding cannot be got around; a secret for the agent's
 * commands that Windlass would keep from sandboxed ones by its name is named in `passEnv`.
 */
export function windlassEnvironment(secrets: readonly OpenedSecret[], profile: Promises): WindlassSecrets {
	const handed = secrets.filter(secret => secretReach(secret.scope, profile).servers);
	return {
		env: Object.fromEntries(handed.map(secret => [secret.name, secret.value])),
		withholdEnv: handed.filter(secret => secret.scope === "setup").map(secret => secret.name),
		passEnv: handed
			.filter(secret => secret.scope === "agent" && looksLikeCredential(secret.name))
			.map(secret => secret.name),
	};
}

/**
 * Why Windlass was not handed a saved secret an MCP server's definition reads, for the question
 * about that server: the sentence of `secretReach`. Null for a name that is not a saved secret, and
 * for one Windlass was handed.
 */
export function withheldFromServers(
	name: string,
	secrets: readonly Pick<OpenedSecret, "name" | "scope">[],
	profile: Promises,
): string | null {
	const secret = secrets.find(item => item.name === name);
	if (!secret) return null;
	const reach = secretReach(secret.scope, profile);
	return reach.servers ? null : reach.note;
}

// ---------------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------------

/** What a sealed value is bound to: its user, its repository and its name. It opens as nothing else. */
function subject(uid: string, project: string, name: string): string {
	return `${uid}\n${project}\n${name}`;
}

export function sealSecret(sealer: Sealer, uid: string, project: string, name: string, value: string): string {
	return sealer.seal("secret", subject(uid, project, name), value);
}

/** Throws `SealError` (signin/seal.ts) for a blob that is not this user's value of that name for that repository, or was sealed with another key. */
export function openSecret(sealer: Sealer, uid: string, project: string, name: string, sealed: string): string {
	return sealer.open("secret", subject(uid, project, name), sealed);
}

// ---------------------------------------------------------------------------------------------
// Taking values out of text
// ---------------------------------------------------------------------------------------------

/** What stands where a value was: which secret it was, never anything of the value. */
export function secretMark(name: string): string {
	return `[secret:${name}]`;
}

/** What the sandbox layer needs of a redactor (sandbox/api.ts). */
export interface Redactor {
	/** False when there is nothing to take out: every method then returns what it was given. */
	readonly active: boolean;
	/** `text` with every value replaced by its mark. */
	text(text: string): string;
	/** Redact every JSON string, including object keys. Returns the value itself when nothing was replaced. */
	deep<T>(value: T): T;
	/** How many characters at the end of `text` may be the beginning of a value that continues in what comes next. */
	held(text: string): number;
}

/**
 * Takes the values of secrets out of text, by value. Besides a value as it is (without white space
 * at its ends, which is left standing), it knows the value as a JSON string holds it (a quote or a
 * line end in it is escaped there), and each line of a value of several lines, since a program prints
 * a key's lines one by one. Longer forms are replaced first.
 */
export class SecretRedactor implements Redactor {
	private readonly forms: Array<{ text: string; mark: string }> = [];

	constructor(secrets: readonly Pick<OpenedSecret, "name" | "value">[]) {
		const seen = new Set<string>();
		const add = (text: string, name: string) => {
			if (text.length < MIN_SECRET_VALUE_CHARS || seen.has(text)) return;
			seen.add(text);
			this.forms.push({ text, mark: secretMark(name) });
		};
		for (const { name, value } of secrets) {
			// Without the white space around it: a value that ends in a line end is found either way, and the line end stays where it was.
			const whole = value.trim();
			add(whole, name);
			add(JSON.stringify(whole).slice(1, -1), name);
			if (whole.includes("\n")) for (const line of whole.split("\n")) add(line.trim(), name);
		}
		this.forms.sort((a, b) => b.text.length - a.text.length);
	}

	get active(): boolean {
		return this.forms.length > 0;
	}

	text(text: string): string {
		if (typeof text !== "string" || text.length < MIN_SECRET_VALUE_CHARS) return text;
		for (const form of this.forms) if (text.includes(form.text)) text = text.split(form.text).join(form.mark);
		return text;
	}

	deep<T>(value: T): T {
		if (!this.active) return value;
		if (typeof value === "string") return this.text(value) as T;
		if (Array.isArray(value)) {
			let changed = false;
			const out = value.map((item: unknown) => {
				const next = this.deep(item);
				if (next !== item) changed = true;
				return next;
			});
			return changed ? (out as T) : value;
		}
		if (typeof value === "object" && value !== null) {
			let changed = false;
			const entries = Object.entries(value).map(([key, item]) => {
				const name = this.text(key);
				const next = this.deep(item);
				if (next !== item || name !== key) changed = true;
				return [name, next];
			});
			return changed ? (Object.fromEntries(entries) as T) : value;
		}
		return value;
	}

	held(text: string): number {
		let longest = 0;
		for (const form of this.forms) {
			const first = form.text[0]!;
			// A value that began earlier than this would be whole, or longer than what is left of the text.
			const from = Math.max(0, text.length - (form.text.length - 1));
			for (let at = text.indexOf(first, from); at !== -1; at = text.indexOf(first, at + 1)) {
				const rest = text.length - at;
				if (rest <= longest) break;
				let fits = true;
				for (let index = 1; index < rest; index += 1) {
					if (text.charCodeAt(at + index) !== form.text.charCodeAt(index)) {
						fits = false;
						break;
					}
				}
				if (fits) {
					longest = rest;
					break;
				}
			}
		}
		return longest;
	}
}

/** A redactor with nothing to take out. */
export const NO_REDACTION: Redactor = { active: false, text: text => text, deep: value => value, held: () => 0 };

/**
 * A stream of text with the values taken out, also one that arrives in two pieces: what may be the
 * beginning of a value is held back until the next piece shows whether it is one.
 */
export class RedactingStream {
	private waiting = "";

	constructor(private readonly redactor: Redactor) {}

	/** What of the stream so far can be passed on. */
	push(text: string): string {
		if (!this.redactor.active) return text;
		const whole = this.redactor.text(this.waiting + text);
		const held = this.redactor.held(whole);
		this.waiting = held === 0 ? "" : whole.slice(whole.length - held);
		return held === 0 ? whole : whole.slice(0, whole.length - held);
	}

	get hasTail(): boolean {
		return this.waiting !== "";
	}

	/** The stream ended: what was held back was not a value. */
	flush(): string {
		const rest = this.waiting;
		this.waiting = "";
		return rest;
	}
}
