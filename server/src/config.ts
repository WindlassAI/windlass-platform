/**
 * Server configuration, read once from the environment.
 *
 *   WLP_DEMO=1                 offer the demo sign-in (scripted model, no ChatGPT account)
 *   WLP_ALLOWED_EMAILS, WLP_ALLOWED_USERS
 *                              who may sign in with ChatGPT: account emails and user ids (`u_...`),
 *                              comma-separated. Unset, both: anyone with a ChatGPT account. Asked at
 *                              the sign-in and at every call, so a removal holds at once (access.ts)
 *   WLP_SANDBOX=docker|e2b|fake
 *                              the sandbox layer (default docker). docker: containers on this machine, for
 *                              one server. e2b: E2B microVMs, which every server of a deployment reaches
 *                              (the variables below). fake keeps everything in memory
 *   WLP_SECRET                 signs tokens; when unset one is generated and kept in .data/secret.
 *                              Required with a remote engine: every server must sign with the same one
 *   WLP_SIGNIN_KEY             what the key that encrypts ChatGPT sign-ins in actor storage is derived from
 *                              (signin/seal.ts); at least 32 characters, the same on every server. When
 *                              unset the key is derived from WLP_SECRET, under a label of its own
 *   WLP_WEB_ORIGINS            comma-separated web origins allowed to connect
 *                              (default http://localhost:5173,http://127.0.0.1:5173)
 *   RIVETKIT_STORAGE_PATH      where the local Rivet engine keeps actor data, in a `.rivetkit` folder
 *                              inside this directory (default: <repository>/.data)
 *   WLP_FAKE_DELAY_MS          fake layer only: delay between replayed events (default 15)
 *   WLP_LOGIN_TTL_MS           how long a sign-in attempt is accepted (default 600000, ten minutes);
 *                              shortened by tests
 *   WLP_QUESTION_TIMEOUT_MS    how long a turn's question waits for an answer before the platform
 *                              declines it (default QUESTION_TIMEOUT_MS, ten minutes); shortened by tests
 *   WLP_TURN_TIMEOUT_MS        how long one turn may run (default 45 minutes); read in agent-session.ts
 *   WLP_SETUP_TIMEOUT_MS       how long a repository's setup command may run in a new sandbox before the
 *                              platform stops it (default 600000, ten minutes; at most the time a turn
 *                              may take, since it runs inside one). The same on every server
 *   WLP_IDLE_SUSPEND_MS        how long after its last turn ended a session's sandbox is suspended
 *                              (default 10 minutes)
 *   WLP_IDLE_DESTROY_MS        how long after its last use a session's sandbox is removed with its
 *                              files (default 7 days); the timeline stays
 *   WLP_HTTP_PORT, PORT        where the platform's HTTP routes listen (`/platform/info`, `/health`);
 *                              WLP_HTTP_PORT first, then PORT, which Rivet Cloud sets on its nodes
 *                              (default 6440)
 *   WLP_HTTP_HOST              the address they bind (default 127.0.0.1 with the local engine, 0.0.0.0
 *                              with a remote one)
 *   WLP_WEB_DIR                the web app's built files (`web/dist`), for the server to serve itself
 *                              on that port (web.ts): one address for the whole platform. Unset: it
 *                              serves none, and the web app is hosted elsewhere. server/Dockerfile sets it
 *
 * What browsers connect with (`GET /platform/connection`, platform-info.ts; README, "Running on several
 * servers"). None of it is needed with the local engine, which asks for no token:
 *
 *   WLP_PUBLIC_ENDPOINT        the Rivet endpoint browsers connect to, without a namespace or a token in
 *                              it: for a Rivet Cloud cluster, https://<name>-api.onrivet.dev. It is
 *                              not RIVET_ENDPOINT, which is the server's own way to the engine and may be
 *                              an address only the server reaches. Unset: the web app uses the endpoint
 *                              it was built with
 *   RIVET_ADMIN_TOKEN          the engine's admin token, for an engine that asks browsers for a token (a
 *                              Rivet Cloud cluster, or an engine of your own with `auth.admin_token`).
 *                              A secret: it is sent to the engine as a bearer and to nothing else, and
 *                              is never logged or put in an error or an answer. The server uses it for
 *                              one thing, to issue the short-lived tokens it hands browsers
 *                              (connection-tokens.ts), and asks the engine at WLP_PUBLIC_ENDPOINT, which
 *                              must then be set. Unset: browsers are handed no token
 *   WLP_CONNECTION_TOKEN_TTL_MS
 *                              how long such a token lasts (default 3600000, one hour; at least one
 *                              minute, and at most the 24 hours a Rivet Cloud cluster issues one for).
 *                              A server hands one token to every browser until half of that is gone
 *
 * With WLP_SANDBOX=e2b (read in sandbox/e2b/config.ts; README, "E2B"). The defaults are sized for E2B's
 * free Hobby plan, which runs on a one-time credit: every one of them errs on the side of using less.
 *
 *   E2B_API_KEY                the E2B account's API key. Required: without it the server does not start
 *   WLP_E2B_TEMPLATE           the template sandboxes are made from (default windlass-platform-sandbox,
 *                              which sandbox/e2b/build.sh builds). A sandbox has its template's size:
 *                              1 vCPU and 1024 MiB unless the template was built otherwise
 *   WLP_E2B_DEPLOYMENT         marks every sandbox of this deployment in its metadata, so they are
 *                              counted, listed and removed together (default "default"). The same on
 *                              every server of a deployment; different for another deployment that
 *                              shares the E2B account
 *   WLP_E2B_MAX_RUNNING        how many of the deployment's sandboxes may run at the same time, counted
 *                              from E2B's own list, so it holds across servers (default 3; the Hobby
 *                              plan itself allows 10). At the cap a user is told to try again later
 *   WLP_E2B_IDLE_TIMEOUT_MS    a sandbox's own timeout while no turn runs in it: E2B pauses it by itself
 *                              this long after it was last connected to (default 120000, two minutes)
 *   WLP_E2B_TURN_LEASE_MS      a sandbox's own timeout while a turn runs, set again every third of it by
 *                              the server that runs the turn (default 180000): a sandbox whose server
 *                              died is paused by E2B within this time
 *   WLP_E2B_MAX_RUNTIME_MS     how long the plan lets a sandbox run without a pause (default 3600000,
 *                              the Hobby plan's hour; 86400000 on Pro). A sandbox with too little of it
 *                              left for a turn is paused and resumed before the turn starts
 *   WLP_E2B_PAUSE=0            for an account that cannot pause: a sandbox is killed where it would be
 *                              paused (its timeout, `suspend`), and the session's files and its Windlass
 *                              session are lost each time (default 1: pause)
 *   WLP_E2B_WINDLASS_SANDBOX=1 promise Windlass's own sandbox in the E2B profile (no network for
 *                              commands, the access token out of their reach) and remove any new
 *                              sandbox in which bubblewrap does not work. Only once scripts/e2b-check.ts
 *                              has shown that it does (default 0: nothing is promised of it)
 *   WLP_E2B_OPEN_PROFILE=1     also offer "E2B, microVM only" (`e2b-open`): Windlass sandboxes no
 *                              command and runs with --approval full, so commands have the microVM's
 *                              network, a writable home directory and the turn's access token, and
 *                              nothing asks first. Users choose it per session; the E2B profile stays
 *                              the default (default 0: listed, not offered)
 *   WLP_E2B_WINDLASS_VERSION   the Windlass version in the template, to show it before the first sandbox
 *                              was made (default: learned from the first sandbox)
 *
 * The bucket (read by `backupConfig` below; README, "The agent's memory outlives its sandbox"). Where
 * Windlass's own session data lives on the sandbox's disk (E2B), a copy of it is kept in a bucket after
 * every turn and put back into the sandbox that replaces a lost one (sandbox/backup.ts). Any store
 * that speaks the S3 protocol will do, and changing the provider is changing these. With none of the
 * first four set the feature is off, and a session whose sandbox is lost starts a new Windlass session,
 * as it did before there was a bucket; with only some of them set it is off too, and the server says
 * which are missing when it starts. They are the same on every server.
 *
 *   WLP_BUCKET_ENDPOINT        the store's S3 endpoint, without the bucket: for Cloudflare R2,
 *                              https://<account id>.r2.cloudflarestorage.com
 *   WLP_BUCKET_NAME            the bucket. Nothing else needs to be in it, and nothing else should
 *   WLP_BUCKET_ACCESS_KEY_ID   the id of an access key that may read, write and delete objects in that
 *                              bucket, and needs no other right
 *   WLP_BUCKET_SECRET_ACCESS_KEY
 *                              that key's secret. It signs requests and links and is used for nothing
 *                              else: never logged, never in an error, a link or an answer
 *   WLP_BUCKET_REGION          the region the signatures name (default auto, which is R2's; on AWS the
 *                              bucket's region)
 *   WLP_BUCKET_STYLE=path|virtual
 *                              where the bucket's name goes in an address: in the path (default; R2,
 *                              MinIO, AWS) or in the host name
 *   WLP_BUCKET_PREFIX          put before every object's key, for a bucket that is shared with
 *                              something else or between deployments (default none; letters, digits,
 *                              `.`, `_`, `-` and `/`)
 *   WLP_BACKUP_MAX_BYTES       the largest copy that is kept, in bytes of the compressed archive
 *                              (default 67108864, 64 MiB). A session whose data outgrows it is no
 *                              longer copied, and its timeline says so once
 *   WLP_FAKE_BACKUP_DIR        fake layer only: a directory that stands in for the bucket. With it the
 *                              fake layer's Windlass sessions live in its sandboxes, as on E2B, and
 *                              are copied to that directory and restored from it (sandbox-fake.ts)
 *
 * GitHub (read by `githubConfig` below; README, "GitHub"). A GitHub App of this deployment's own lets a
 * user connect GitHub, launch an agent on a repository the app was installed on, private ones included,
 * and get the work back as a pull request. With none of the first five set the feature is off: the web
 * app shows nothing of it and every session behaves as before. With only some of them set it is off
 * too, and the server says which are missing when it starts. They are the same on every server.
 *
 *   WLP_GITHUB_APP_ID          the app's numeric id ("App ID" on the app's settings page): the issuer of
 *                              the tokens the server signs to ask for installation tokens
 *   WLP_GITHUB_APP_SLUG        the app's name as its address has it, https://github.com/apps/<slug>:
 *                              where a user is sent to install it
 *   WLP_GITHUB_CLIENT_ID       the app's client id ("Iv23..."): names the app when a user authorizes it
 *   WLP_GITHUB_CLIENT_SECRET   a client secret of the app. A secret: sent to GitHub with a user's
 *                              authorization code and with nothing else; never logged, never in an
 *                              error or an answer
 *   WLP_GITHUB_PRIVATE_KEY     a private key of the app, the PEM file GitHub lets you download. A
 *                              secret: it signs the app's own tokens and never leaves the server. As
 *                              it is, with its line breaks, or with `\n` in their place, or the whole
 *                              file in base64 (`base64 -w0 key.pem`), which is the form to give a
 *                              secret store that takes one line. Where a secret may not be that long
 *                              (a Rivet Cloud cluster's ends at 1024 bytes), the base64 cut into
 *                              WLP_GITHUB_PRIVATE_KEY_1, _2, ..., which are put together in order
 *   WLP_GITHUB_API_URL         GitHub's API (default https://api.github.com). For GitHub Enterprise
 *                              Server, https://<host>/api/v3; the checks point it at a stand-in
 *   WLP_GITHUB_URL             GitHub itself, where users authorize and git clones from (default
 *                              https://github.com)
 *
 * The Rivet engine is RivetKit's to configure, from its own variables: without RIVET_ENDPOINT it starts
 * a local engine on :6420 (development), with it the server joins that engine as one of its nodes
 * (RIVET_ENDPOINT, RIVET_NAMESPACE, RIVET_TOKEN, RIVET_POOL, RIVET_NODE_VERSION; README, "Running on
 * several servers"). `engine` below is what this server makes of them; it never holds the token, and
 * neither does anything else in `config`: the admin token is read where it is used (`engineAdminToken`).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AccessRules, readAccessRules } from "./access.js";
import { QUESTION_TIMEOUT_MS } from "./contract.js";
import { APPROVAL_TTL_MS } from "./server-approvals.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(REPO_ROOT, ".data");
export const FIXTURES_DIR = join(REPO_ROOT, "fixtures", "windlass-events");

export type SandboxMode = "docker" | "e2b" | "fake";

export interface EngineConfig {
	/**
	 * True when RivetKit is pointed at an engine it does not start itself (RIVET_ENDPOINT, or RivetKit's
	 * older RIVET_ENGINE): other servers may share it, so they must share the secret too.
	 */
	remote: boolean;
	/** The engine's address without the namespace and token the URL may carry; null for the local one. */
	endpoint: string | null;
	namespace: string;
	pool: string;
}

export interface BrowserConnectionConfig {
	/** WLP_PUBLIC_ENDPOINT without a trailing slash; null when browsers are to use the endpoint they were built with. */
	endpoint: string | null;
	/** True when RIVET_ADMIN_TOKEN is set: browsers are handed tokens this server issues with it. */
	tokens: boolean;
	tokenTtlMs: number;
}

export interface Config {
	demo: boolean;
	/** Who may use the platform (access.ts). */
	access: AccessRules;
	sandbox: SandboxMode;
	secret: Buffer;
	/** False when a remote engine is configured and WLP_SECRET is not: the server refuses to start (startup.ts). */
	secretConfigured: boolean;
	engine: EngineConfig;
	browsers: BrowserConnectionConfig;
	httpPort: number;
	httpHost: string;
	/** The web app's built files, when the server serves them itself. */
	webDir: string | null;
	idleSuspendMs: number;
	idleDestroyMs: number;
	origins: string[];
	storagePath: string;
	loginTtlMs: number;
	questionTimeoutMs: number;
	/** How long an approval of a project's MCP server is remembered for its user: Windlass's own 30 days, or less. */
	serverApprovalTtlMs: number;
	/** How long a repository's setup command may run before the platform stops it. */
	setupTimeoutMs: number;
}

function readSandboxMode(): SandboxMode {
	const raw = (process.env.WLP_SANDBOX ?? "docker").trim().toLowerCase();
	if (raw === "docker" || raw === "e2b" || raw === "fake") return raw;
	throw new Error(`WLP_SANDBOX must be "docker", "e2b" or "fake"; got "${raw}"`);
}

/** Read the way RivetKit reads them (its utils/env-vars.ts and registry config, 3.1.1). */
function readEngine(): EngineConfig {
	const raw = (process.env.RIVET_ENGINE || process.env.RIVET_ENDPOINT || "").trim();
	let endpoint: string | null = null;
	let namespace = process.env.RIVET_NAMESPACE || "default";
	if (raw !== "") {
		try {
			const url = new URL(raw);
			if (url.username) namespace = decodeURIComponent(url.username);
			url.username = "";
			url.password = "";
			endpoint = url.toString().replace(/\/+$/, "");
		} catch {
			// RivetKit refuses it when the registry starts, with its own message.
			endpoint = "(not a valid URL)";
		}
	}
	return { remote: raw !== "", endpoint, namespace, pool: process.env.RIVET_POOL || "default" };
}

const engine = readEngine();

/**
 * Where this server's own clients find the engine (signin/directory.ts, github/connect.ts): the one
 * RIVET_ENDPOINT names, and otherwise the local engine RivetKit starts, on its own port or on the one
 * RivetKit's RIVET_RUN_ENGINE_PORT moves it to, as a second development server on one machine needs.
 */
export function ownEngineEndpoint(): string {
	const named = process.env.RIVET_ENGINE || process.env.RIVET_ENDPOINT;
	if (named) return named;
	const port = Number(process.env.RIVET_RUN_ENGINE_PORT);
	return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65_536 ? port : 6420}`;
}

/**
 * The engine's admin token, or null. It is not part of `config`, so that nothing that prints or passes
 * on the configuration can carry it; whoever needs it asks here and keeps it to itself.
 */
export function engineAdminToken(): string | null {
	const token = (process.env.RIVET_ADMIN_TOKEN ?? "").trim();
	return token === "" ? null : token;
}

/** What `backupConfig` found: the bucket's settings when all of them are there, and the size limit. */
export interface BackupConfig {
	/** The S3 bucket's settings (bucket/s3.ts takes them as they are); null when the feature is off. `secretAccessKey` is a secret. */
	bucket: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; style: "path" | "virtual" } | null;
	/** WLP_BUCKET_PREFIX, ending in a slash when it is not empty. */
	prefix: string;
	/** WLP_BACKUP_MAX_BYTES. */
	maxBytes: number;
	/** The required variables that are not set while others are: the names, never a value. Empty when all or none are set. */
	missing: string[];
}

/**
 * The bucket the copies of Windlass's session data go to, read when it is asked for. Like the admin
 * token it is not part of `config`: nothing that prints or passes on the configuration can carry the
 * bucket's secret. Throws for a prefix that could not be part of an object's key.
 */
export function backupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
	const read = (name: string) => (env[name] ?? "").trim();
	const required = ["WLP_BUCKET_ENDPOINT", "WLP_BUCKET_NAME", "WLP_BUCKET_ACCESS_KEY_ID", "WLP_BUCKET_SECRET_ACCESS_KEY"];
	const missing = required.filter((name) => read(name) === "");
	const raw = Number(read("WLP_BACKUP_MAX_BYTES"));
	const maxBytes = Number.isSafeInteger(raw) && raw > 0 ? raw : 64 * 1024 * 1024;
	const prefix = read("WLP_BUCKET_PREFIX").replace(/^\/+|\/+$/g, "");
	if (prefix !== "" && !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefix)) throw new Error('WLP_BUCKET_PREFIX may hold letters, digits, ".", "_", "-" and "/" only');
	const style = read("WLP_BUCKET_STYLE").toLowerCase();
	if (style !== "" && style !== "path" && style !== "virtual") throw new Error('WLP_BUCKET_STYLE must be "path" or "virtual"');
	const bucket =
		missing.length > 0
			? null
			: {
					endpoint: read("WLP_BUCKET_ENDPOINT"),
					region: read("WLP_BUCKET_REGION") || "auto",
					bucket: read("WLP_BUCKET_NAME"),
					accessKeyId: read("WLP_BUCKET_ACCESS_KEY_ID"),
					secretAccessKey: read("WLP_BUCKET_SECRET_ACCESS_KEY"),
					style: style === "virtual" ? ("virtual" as const) : ("path" as const),
				};
	return { bucket, prefix: prefix === "" ? "" : `${prefix}/`, maxBytes, missing: missing.length === required.length ? [] : missing };
}

/** What `githubConfig` found: the GitHub App's public settings when all of it is configured. */
export interface GithubConfig {
	/** Null when the feature is off. Holds no secret: the client secret and the private key are read where they are used. */
	app: { appId: string; slug: string; clientId: string; apiUrl: string; webUrl: string } | null;
	/** The required variables that are not set while others are: the names, never a value. Empty when all or none are set. */
	missing: string[];
}

const GITHUB_REQUIRED = ["WLP_GITHUB_APP_ID", "WLP_GITHUB_APP_SLUG", "WLP_GITHUB_CLIENT_ID", "WLP_GITHUB_CLIENT_SECRET", "WLP_GITHUB_PRIVATE_KEY"];

/**
 * The GitHub App of this deployment, read when it is asked for. Throws for a value that cannot be what
 * it should be (an id that is not a number, an address that is not one); the message names the
 * variable and never repeats a secret.
 */
export function githubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig {
	const read = (name: string) => (name === "WLP_GITHUB_PRIVATE_KEY" ? rawGithubPrivateKey(env) : (env[name] ?? "").trim());
	const missing = GITHUB_REQUIRED.filter((name) => read(name) === "");
	if (missing.length > 0) return { app: null, missing: missing.length === GITHUB_REQUIRED.length ? [] : missing };
	const appId = read("WLP_GITHUB_APP_ID");
	if (!/^[0-9]{1,20}$/.test(appId)) throw new Error("WLP_GITHUB_APP_ID must be the app's numeric id");
	const slug = read("WLP_GITHUB_APP_SLUG");
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(slug)) throw new Error("WLP_GITHUB_APP_SLUG must be the app's name as its address has it: letters, digits and hyphens");
	const clientId = read("WLP_GITHUB_CLIENT_ID");
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) throw new Error("WLP_GITHUB_CLIENT_ID is not a client id");
	const address = (name: string, fallback: string) => {
		const raw = read(name) || fallback;
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error(`${name} must be a URL`);
		}
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
			throw new Error(`${name} must be an http or https URL with no user name, query or fragment in it`);
		}
		return url.toString().replace(/\/+$/, "");
	};
	return { app: { appId, slug, clientId, apiUrl: address("WLP_GITHUB_API_URL", "https://api.github.com"), webUrl: address("WLP_GITHUB_URL", "https://github.com") }, missing: [] };
}

/** The GitHub App's client secret, or null. Like the admin token it is not part of any configuration object. */
export function githubClientSecret(env: NodeJS.ProcessEnv = process.env): string | null {
	const secret = (env.WLP_GITHUB_CLIENT_SECRET ?? "").trim();
	return secret === "" ? null : secret;
}

/**
 * The private key as it was given: WLP_GITHUB_PRIVATE_KEY, or, where a secret store holds less than a
 * key is long (a Rivet Cloud cluster's secrets end at 1024 bytes, and the file in base64 is over two
 * thousand), its pieces in WLP_GITHUB_PRIVATE_KEY_1, _2, ... put together in that order. "" when unset.
 */
function rawGithubPrivateKey(env: NodeJS.ProcessEnv): string {
	const whole = (env.WLP_GITHUB_PRIVATE_KEY ?? "").trim();
	if (whole !== "") return whole;
	let joined = "";
	for (let part = 1; ; part += 1) {
		const piece = (env[`WLP_GITHUB_PRIVATE_KEY_${part}`] ?? "").trim();
		if (piece === "") return joined;
		joined += piece;
	}
}

/**
 * The GitHub App's private key as PEM text, or null: WLP_GITHUB_PRIVATE_KEY as it is, with `\n` for its
 * line breaks, or in base64. Whether it is a key at all is found out by whoever signs with it
 * (github/app.ts), which says so without repeating it.
 */
export function githubPrivateKey(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = rawGithubPrivateKey(env);
	if (raw === "") return null;
	if (raw.includes("-----BEGIN")) return `${raw.replace(/\\n/g, "\n").trim()}\n`;
	const decoded = Buffer.from(raw, "base64").toString("utf8");
	return decoded.includes("-----BEGIN") ? `${decoded.trim()}\n` : raw;
}

/** A day: the longest a Rivet Cloud cluster issues a token for. */
const MAX_CONNECTION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function readBrowsers(): BrowserConnectionConfig {
	const raw = (process.env.WLP_PUBLIC_ENDPOINT ?? "").trim();
	let endpoint: string | null = null;
	if (raw !== "") {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error("WLP_PUBLIC_ENDPOINT must be a URL, such as https://<name>-api.onrivet.dev");
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("WLP_PUBLIC_ENDPOINT must be an http or https URL");
		// It is handed to every browser as it is. The value is not repeated here: it may hold a token.
		if (url.username !== "" || url.password !== "") throw new Error("WLP_PUBLIC_ENDPOINT must not carry a namespace or a token: browsers are handed both by the server");
		endpoint = url.toString().replace(/\/+$/, "");
	}
	const ttl = Number(process.env.WLP_CONNECTION_TOKEN_TTL_MS);
	const tokenTtlMs = Number.isFinite(ttl) && ttl >= 60_000 ? Math.min(Math.floor(ttl), MAX_CONNECTION_TOKEN_TTL_MS) : 60 * 60 * 1000;
	return { endpoint, tokens: engineAdminToken() !== null, tokenTtlMs };
}

function readSecret(): Buffer {
	const fromEnv = process.env.WLP_SECRET;
	if (fromEnv !== undefined && fromEnv !== "") {
		if (fromEnv.length < 16) throw new Error("WLP_SECRET must be at least 16 characters long");
		return Buffer.from(fromEnv, "utf8");
	}
	// A secret made up here would differ from the other servers' and would not be kept: the server
	// refuses to start (startup.ts). Until then nothing may be signed with a value anyone could share.
	if (engine.remote) return randomBytes(32);
	const file = join(DATA_DIR, "secret");
	if (existsSync(file)) {
		const stored = readFileSync(file, "utf8").trim();
		if (stored.length >= 32) return Buffer.from(stored, "utf8");
	}
	mkdirSync(DATA_DIR, { recursive: true });
	const generated = randomBytes(32).toString("hex");
	writeFileSync(file, `${generated}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	return Buffer.from(generated, "utf8");
}

/**
 * What the key that encrypts sign-ins is derived from: WLP_SIGNIN_KEY when it is set, so the token
 * secret can be changed without every user having to sign in with ChatGPT again, and otherwise the
 * server's secret. Either way it is the derivation's input, never the key itself (signin/seal.ts), and
 * it has to be the same on every server: a sign-in sealed by one must open on the others.
 */
export function signInKeySecret(): Buffer {
	const own = process.env.WLP_SIGNIN_KEY;
	if (own === undefined || own === "") return config.secret;
	if (own.length < 32) throw new Error("WLP_SIGNIN_KEY must be at least 32 characters long");
	return Buffer.from(own, "utf8");
}

function readOrigins(): string[] {
	const raw = process.env.WLP_WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173";
	return raw
		.split(",")
		.map((origin) => origin.trim().replace(/\/+$/, ""))
		.filter((origin) => origin !== "");
}

function readStoragePath(): string {
	// The engine is started by RivetKit's native module, which reads this variable itself.
	if (!process.env.RIVETKIT_STORAGE_PATH) {
		mkdirSync(DATA_DIR, { recursive: true });
		process.env.RIVETKIT_STORAGE_PATH = DATA_DIR;
	}
	return process.env.RIVETKIT_STORAGE_PATH;
}

function readHttpPort(): number {
	for (const raw of [process.env.WLP_HTTP_PORT, process.env.PORT]) {
		if (raw === undefined || raw.trim() === "") continue;
		const port = Number(raw);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`The HTTP port must be a number from 1 to 65535; got "${raw}"`);
		return port;
	}
	return 6440;
}

function readDuration(name: string, fallback: number, min: number): number {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
}

const idleSuspendMs = readDuration("WLP_IDLE_SUSPEND_MS", 10 * 60 * 1000, 1_000);
// Removing comes after suspending, never before it.
const idleDestroyMs = Math.max(idleSuspendMs, readDuration("WLP_IDLE_DESTROY_MS", 7 * 24 * 60 * 60 * 1000, 1_000));

function readLoginTtl(): number {
	const raw = Number.parseInt(process.env.WLP_LOGIN_TTL_MS ?? "", 10);
	return Number.isFinite(raw) && raw >= 1_000 ? raw : 10 * 60 * 1000;
}

function readQuestionTimeout(): number {
	const raw = Number.parseInt(process.env.WLP_QUESTION_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(raw) && raw >= 100 ? raw : QUESTION_TIMEOUT_MS;
}

export const config: Config = {
	demo: process.env.WLP_DEMO === "1",
	access: readAccessRules(),
	sandbox: readSandboxMode(),
	secret: readSecret(),
	secretConfigured: !engine.remote || Boolean(process.env.WLP_SECRET),
	engine,
	browsers: readBrowsers(),
	httpPort: readHttpPort(),
	httpHost: process.env.WLP_HTTP_HOST || (engine.remote ? "0.0.0.0" : "127.0.0.1"),
	webDir: (process.env.WLP_WEB_DIR ?? "").trim() || null,
	idleSuspendMs,
	idleDestroyMs,
	origins: readOrigins(),
	storagePath: readStoragePath(),
	loginTtlMs: readLoginTtl(),
	questionTimeoutMs: readQuestionTimeout(),
	// Never longer than Windlass keeps its own record: a shorter time is for the checks.
	serverApprovalTtlMs: Math.min(APPROVAL_TTL_MS, readDuration("WLP_SERVER_APPROVAL_TTL_MS", APPROVAL_TTL_MS, 1_000)),
	setupTimeoutMs: readDuration("WLP_SETUP_TIMEOUT_MS", 10 * 60 * 1000, 1_000),
};
