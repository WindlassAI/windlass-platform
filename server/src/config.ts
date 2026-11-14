/**
 * Server configuration, read once from the environment.
 *
 *   WLP_DEMO=1                 offer the demo sign-in (scripted model, no ChatGPT account)
 *   WLP_SANDBOX=docker|fake    the sandbox layer (default docker); fake keeps everything in memory
 *   WLP_SECRET                 signs tokens; when unset one is generated and kept in .data/secret
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
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUESTION_TIMEOUT_MS } from "./contract.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(REPO_ROOT, ".data");
export const FIXTURES_DIR = join(REPO_ROOT, "fixtures", "windlass-events");

export type SandboxMode = "docker" | "fake";

export interface Config {
	demo: boolean;
	sandbox: SandboxMode;
	secret: Buffer;
	origins: string[];
	storagePath: string;
	loginTtlMs: number;
	questionTimeoutMs: number;
}

function readSandboxMode(): SandboxMode {
	const raw = (process.env.WLP_SANDBOX ?? "docker").trim().toLowerCase();
	if (raw === "docker" || raw === "fake") return raw;
	throw new Error(`WLP_SANDBOX must be "docker" or "fake"; got "${raw}"`);
}

function readSecret(): Buffer {
	const fromEnv = process.env.WLP_SECRET;
	if (fromEnv !== undefined && fromEnv !== "") {
		if (fromEnv.length < 16) throw new Error("WLP_SECRET must be at least 16 characters long");
		return Buffer.from(fromEnv, "utf8");
	}
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
	origins: readOrigins(),
	storagePath: readStoragePath(),
	loginTtlMs: readLoginTtl(),
	questionTimeoutMs: readQuestionTimeout(),
};
