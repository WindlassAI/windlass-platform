/**
 * Server configuration, read once from the environment.
 *
 *   WLP_DEMO=1                 offer the demo sign-in (scripted model, no ChatGPT account)
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
 *   WLP_IDLE_SUSPEND_MS        how long after its last turn ended a session's sandbox is suspended
 *                              (default 10 minutes)
 *   WLP_IDLE_DESTROY_MS        how long after its last use a session's sandbox is removed with its
 *                              files (default 7 days); the timeline stays
 *   WLP_HTTP_PORT, PORT        where the platform's HTTP routes listen (`/platform/info`, `/health`);
 *                              WLP_HTTP_PORT first, then PORT, which Rivet Cloud sets on its nodes
 *                              (default 6440)
 *   WLP_HTTP_HOST              the address they bind (default 127.0.0.1 with the local engine, 0.0.0.0
 *                              with a remote one)
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
 *   WLP_E2B_WINDLASS_VERSION   the Windlass version in the template, to show it before the first sandbox
 *                              was made (default: learned from the first sandbox)
 *
 * The Rivet engine is RivetKit's to configure, from its own variables: without RIVET_ENDPOINT it starts
 * a local engine on :6420 (development), with it the server joins that engine as one of its nodes
 * (RIVET_ENDPOINT, RIVET_NAMESPACE, RIVET_TOKEN, RIVET_POOL, RIVET_NODE_VERSION; README, "Running on
 * several servers"). `engine` below is what this server makes of them; it never holds the token.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUESTION_TIMEOUT_MS } from "./contract.js";

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

export interface Config {
	demo: boolean;
	sandbox: SandboxMode;
	secret: Buffer;
	/** False when a remote engine is configured and WLP_SECRET is not: the server refuses to start (startup.ts). */
	secretConfigured: boolean;
	engine: EngineConfig;
	httpPort: number;
	httpHost: string;
	idleSuspendMs: number;
	idleDestroyMs: number;
	origins: string[];
	storagePath: string;
	loginTtlMs: number;
	questionTimeoutMs: number;
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
	sandbox: readSandboxMode(),
	secret: readSecret(),
	secretConfigured: !engine.remote || Boolean(process.env.WLP_SECRET),
	engine,
	httpPort: readHttpPort(),
	httpHost: process.env.WLP_HTTP_HOST || (engine.remote ? "0.0.0.0" : "127.0.0.1"),
	idleSuspendMs,
	idleDestroyMs,
	origins: readOrigins(),
	storagePath: readStoragePath(),
	loginTtlMs: readLoginTtl(),
	questionTimeoutMs: readQuestionTimeout(),
};
