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
 * A Windlass that takes the two lists of names (`withholdEnv`, `passEnv` in a session's metadata, its
 * docs/safety.md, "A command's environment") lets whoever opens the session correct the rule by name:
 * a variable in `withholdEnv` is given to no command and still to an MCP server, and a credential-looking
 * one in `passEnv` is given to sandboxed commands too. With them a scope is exact where Windlass
 * sandboxes every command: a secret for the setup command and MCP servers is handed to Windlass and
 * named in `withholdEnv`, and one for the agent's commands as well is named in `passEnv` when its name
 * would keep it from them. Where commands run without Windlass's sandbox, a withheld variable is not
 * given to a command and can still be read by it, from Windlass's own process, so withholding is not
 * relied on there: a secret that is not for the agent's commands stays out of Windlass's
 * environment, MCP servers go without it, and the interface says so.
 *
 * A sandbox keeps the Windlass of the image it was made from, and an older one has the rule and no
 * lists: once a variable is in its environment, only its name keeps it from a command. Which of the
 * two a sandbox has is asked of it (`Windlass.features`, sandbox/api.ts), and `secretReach` and
 * `windlassEnvironment` are told: for a Windlass without the lists they hand over and say what the
 * rule alone allows.
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
import type { Sealer } from "./signin/seal.js";

/** How many secrets one user may have over all repositories. Reaching it refuses a new one: nothing is dropped to make room. */
export const MAX_SECRETS_PER_USER = 2_000;

export { MAX_SECRETS_PER_REPOSITORY };

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
	return RESERVED_NAMES.includes(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** The name as it is saved: an environment variable's. Throws SecretProblem. */
export function cleanSecretName(raw: unknown): string {
	if (typeof raw !== "string" || raw === "") throw new SecretProblem("A secret needs a name.");
	if (raw.length > MAX_SECRET_NAME_CHARS) throw new SecretProblem(`A secret's name can be at most ${MAX_SECRET_NAME_CHARS} characters long.`);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) throw new SecretProblem("A secret's name is an environment variable's: letters, digits and underscores, not starting with a digit.");
	if (isReservedName(raw)) throw new SecretProblem(`${raw} cannot be a secret's name: the sandbox or Windlass relies on a variable of that name.`);
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
	if (value.includes("\0")) throw new SecretProblem("A secret's value holds a character an environment variable cannot take.");
	if (value.trim().length < MIN_SECRET_VALUE_CHARS) throw new SecretProblem(`A secret's value must be at least ${MIN_SECRET_VALUE_CHARS} characters long: a shorter one could not be taken out of what the platform shows.`);
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > MAX_SECRET_VALUE_BYTES) throw new SecretProblem(`A secret's value can be at most ${MAX_SECRET_VALUE_BYTES.toLocaleString("en-US")} bytes long; this one is ${bytes.toLocaleString("en-US")}.`);
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
 * before Windlass is started: with a Windlass that takes the lists it decides which names go into
 * `passEnv`, and with one that does not it decides what a secret reaches at all. So the lists are
 * copied, and must change when Windlass's do: a name this takes to be passed on, and Windlass
 * withholds, would not reach the agent's commands though its scope says so; and with a Windlass
 * without the lists, a name this says it withholds, and it does not, would reach them.
 */
const CREDENTIAL_WORDS = ["TOKEN", "KEY", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "PRIVATE", "COOKIE"];
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
const CREDENTIAL_NAMES = ["DATABASE_URL", "KUBECONFIG", "DOCKER_HOST", "DOCKER_CONFIG", "GPG_AGENT_INFO", "DBUS_SESSION_BUS_ADDRESS", "NETRC"];

/** The four lists, for a check that holds them against Windlass's source (scripts/secrets-check.ts). */
export const CREDENTIAL_RULE = { words: CREDENTIAL_WORDS, segments: CREDENTIAL_SEGMENTS, prefixes: CREDENTIAL_PREFIXES, names: CREDENTIAL_NAMES };

/** Whether Windlass keeps a variable of this name from the commands it sandboxes. */
export function looksLikeCredential(name: string): boolean {
	const upper = name.toUpperCase();
	if (CREDENTIAL_NAMES.includes(upper)) return true;
	if (CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
	if (CREDENTIAL_WORDS.some((word) => upper.includes(word))) return true;
	return upper.split("_").some((segment) => CREDENTIAL_SEGMENTS.includes(segment));
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

const LOOKS = "a name that looks like a credential (it contains TOKEN, KEY, SECRET or PASSWORD, for example)";
/** What is left of a secret that MCP servers are not given: a repository's still goes to its setup command. */
const ONLY_SETUP = "Only the setup command gets it.";

/**
 * What a secret of this name and scope reaches in a sandbox of `profile`, and the sentence that says
 * so when it is less than the scope. `lists`: whether the sandbox's Windlass takes `withholdEnv` and
 * `passEnv` (`WindlassFeatures.envLists`). With them only one thing is left that a scope cannot have:
 * a secret for MCP servers and not for commands, where commands are not held in Windlass's sandbox.
 * `left` ends the sentence about a secret MCP servers are not given: what it reaches all the same,
 * which for a repository's secret is its setup command (an account's says otherwise, account-secrets.ts).
 */
export function secretReach(name: string, scope: SecretScope, profile: Promises, lists: boolean, left: string = ONLY_SETUP): SecretReach {
	if (!lists) return reachByName(name, scope, profile, left);
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

/** `secretReach` for a Windlass without the lists: a variable it has is kept from a command by its name alone, and only from one it sandboxes. */
function reachByName(name: string, scope: SecretScope, profile: Promises, left: string): SecretReach {
	const sandbox = commandSandbox(profile);
	const withheld = looksLikeCredential(name);
	if (scope === "setup") {
		if (sandbox === "windlass") {
			if (withheld) return { servers: true, commands: "no", note: null };
			return {
				servers: false,
				commands: "no",
				note: `MCP servers are not given it in this sandbox. Windlass passes every variable it has on to the agent's commands unless it has ${LOOKS}, so with this name an MCP server could only have it if the commands had it too. ${left}`,
			};
		}
		return {
			servers: false,
			commands: "no",
			note:
				sandbox === "none"
					? `MCP servers are not given it in this sandbox: the agent's commands run there without Windlass's sandbox, and would get every variable an MCP server can be given. ${left}`
					: `MCP servers are not given it in this sandbox: it has not been established that Windlass can sandbox the agent's commands there, and a command it cannot sandbox gets every variable an MCP server can be given. ${left}`,
		};
	}
	if (!withheld) return { servers: true, commands: "yes", note: null };
	if (sandbox === "windlass") {
		return {
			servers: true,
			commands: "no",
			note: `The agent's commands do not get it in this sandbox: Windlass keeps a variable with ${LOOKS} from the commands it sandboxes, and has no setting that lets one through. The setup command and MCP servers get it.`,
		};
	}
	return {
		servers: true,
		commands: "unsandboxed",
		note:
			sandbox === "none"
				? "The agent's commands get it while Windlass runs them without its sandbox. Once content from the web or an MCP server is in the conversation, Windlass sandboxes commands again where it can, and it keeps a variable whose name looks like a credential from the commands it sandboxes."
				: "The agent's commands get it only where Windlass cannot sandbox them: it keeps a variable whose name looks like a credential from the commands it sandboxes.",
	};
}

/**
 * A repository's secrets as a client is sent them: the name, the scope, when each last changed, and
 * what it reaches in a sandbox of `profile` whose Windlass takes the lists or not (`lists`). Each
 * entry is made here from those fields and no other, so whatever else a row holds, the value
 * included, is not in the answer.
 */
export function listedSecrets(rows: ReadonlyArray<{ name: string; scope: string; updated_at: number }>, profile: SandboxProfile, lists: boolean): RepositorySecrets {
	return {
		profile: profile.id,
		secrets: rows.map((row) => {
			const scope: SecretScope = row.scope === "agent" ? "agent" : "setup";
			return { name: String(row.name), scope, updatedAt: Number(row.updated_at), reach: secretReach(String(row.name), scope, profile, lists) };
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
	return Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
}

/** What Windlass is handed of a repository's secrets for one turn, and told about them when its session is opened. */
export interface WindlassSecrets {
	/** What is put into Windlass's own environment: the secrets that reach MCP servers (`secretReach`). */
	env: Record<string, string>;
	/** Of those, the names no command the agent runs is to be given. Empty for a Windlass without the lists. */
	withholdEnv: string[];
	/** Of those, the credential-looking names that sandboxed commands are to be given all the same. Empty for a Windlass without the lists. */
	passEnv: string[];
}

/**
 * What a turn's Windlass gets in a sandbox of `profile`. For a Windlass that takes the lists
 * (`lists`), every secret in its environment that is not for the agent's commands is named in
 * `withholdEnv`, whatever its name, and such a secret is in its environment only where commands are
 * held in its sandbox, which is where withholding cannot be got around; a secret for the agent's
 * commands that Windlass would keep from sandboxed ones by its name is named in `passEnv`. For a
 * Windlass without them both are empty and the environment holds what its rule alone keeps to the
 * scope: whatever is in it, a command that Windlass does not sandbox can read.
 */
export function windlassEnvironment(secrets: readonly OpenedSecret[], profile: Promises, lists: boolean): WindlassSecrets {
	const handed = secrets.filter((secret) => secretReach(secret.name, secret.scope, profile, lists).servers);
	return {
		env: Object.fromEntries(handed.map((secret) => [secret.name, secret.value])),
		withholdEnv: lists ? handed.filter((secret) => secret.scope === "setup").map((secret) => secret.name) : [],
		passEnv: lists ? handed.filter((secret) => secret.scope === "agent" && looksLikeCredential(secret.name)).map((secret) => secret.name) : [],
	};
}

/**
 * Why Windlass was not handed a saved secret an MCP server's definition reads, for the question
 * about that server: the sentence of `secretReach`. Null for a name that is not a saved secret, and
 * for one Windlass was handed.
 */
export function withheldFromServers(name: string, secrets: readonly Pick<OpenedSecret, "name" | "scope">[], profile: Promises, lists: boolean): string | null {
	const secret = secrets.find((item) => item.name === name);
	if (!secret) return null;
	const reach = secretReach(secret.name, secret.scope, profile, lists);
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
	/** The same for every string in a value of JSON's shapes: the values, never an object's keys. Returns the value itself when nothing was replaced. */
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
			const out: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(value)) {
				const next = this.deep(item);
				if (next !== item) changed = true;
				out[key] = next;
			}
			return changed ? (out as T) : value;
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
export const NO_REDACTION: Redactor = { active: false, text: (text) => text, deep: (value) => value, held: () => 0 };

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

	/** The stream ended: what was held back was not a value. */
	flush(): string {
		const rest = this.waiting;
		this.waiting = "";
		return rest;
	}
}
