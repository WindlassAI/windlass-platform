import { randomUUID } from "node:crypto";
import { UserError } from "rivetkit";
import { requireServiceFor, requireUser } from "./auth.js";
import { MODEL_CHECKS_PER_MINUTE, isModelProvider, validModelKey, type ModelProvider, type ModelProviderCheck, type ModelProviderStatus } from "./contract.js";
import { MINUTE_MS } from "./http-limits.js";
import type { DefaultsDb } from "./repository-defaults.js";
import { serverSealer } from "./signin/seal.js";

export const MODEL_PROVIDER_TABLES = [
	`CREATE TABLE IF NOT EXISTS model_provider (
		provider TEXT PRIMARY KEY, sealed TEXT NOT NULL, generation TEXT NOT NULL, last4 TEXT NOT NULL,
		added_at INTEGER NOT NULL, checked_at INTEGER, check_ok INTEGER NOT NULL DEFAULT 0, models TEXT
	)`,
	"CREATE TABLE IF NOT EXISTS model_check_budget (id INTEGER PRIMARY KEY CHECK (id = 1), minute INTEGER NOT NULL, used INTEGER NOT NULL)",
];

type Context = Parameters<typeof requireUser>[0] & { db: DefaultsDb };
type StatusRow = { provider: ModelProvider; last4: string; added_at: number; checked_at: number | null; check_ok: number; models: string | null };
const STATUS_COLUMNS = "provider, last4, added_at, checked_at, check_ok, models";
const origins: Record<ModelProvider, string> = {
	openai: "https://api.openai.com",
	anthropic: "https://api.anthropic.com",
	google: "https://generativelanguage.googleapis.com",
	openrouter: "https://openrouter.ai",
};

function status(row: StatusRow): ModelProviderStatus {
	return { provider: row.provider, last4: row.last4, addedAt: row.added_at, checkedAt: row.checked_at, ok: !!row.check_ok,
		...(row.models !== null && { models: JSON.parse(row.models) as string[] }) };
}

function providerOf(raw: unknown): ModelProvider {
	if (!isModelProvider(raw)) throw new UserError("Unknown model provider.", { code: "bad_provider" });
	return raw;
}

async function takeCheck(db: DefaultsDb): Promise<void> {
	const admitted = await db.execute(`INSERT INTO model_check_budget VALUES (1, ?, 1)
		ON CONFLICT(id) DO UPDATE SET minute = excluded.minute, used = CASE WHEN minute = excluded.minute THEN used + 1 ELSE 1 END
		WHERE minute != excluded.minute OR used < ? RETURNING id`, Math.floor(Date.now() / MINUTE_MS), MODEL_CHECKS_PER_MINUTE);
	if (!admitted.length) throw new UserError("Too many model provider checks. Try again next minute.", { code: "rate_limited" });
}

const subject = (uid: string, provider: ModelProvider) => JSON.stringify([uid, provider]);
export const modelKeyTransitSubject = (uid: string, provider: ModelProvider, nonce: string) => JSON.stringify(["model-key", uid, provider, nonce]);

async function savedKey(db: DefaultsDb, uid: string, provider: ModelProvider) {
	const [row] = await db.execute<{ sealed: string; generation: string }>("SELECT sealed, generation FROM model_provider WHERE provider = ?", provider);
	if (!row) return null;
	const sealer = serverSealer();
	const owner = subject(uid, provider);
	const key = sealer.open("model-key", owner, row.sealed);
	if (!sealer.isCurrent(row.sealed)) {
		await db.execute("UPDATE model_provider SET sealed = ? WHERE provider = ? AND sealed = ?", sealer.seal("model-key", owner, key), provider, row.sealed);
	}
	return { key, generation: row.generation };
}

// A model ID echoed by a provider must not disclose key material, even in truncated form.
function safeModelId(id: unknown, key: string): id is string {
	if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id)) return false;
	for (let i = 0; i + 5 <= id.length; i++) {
		if (key.includes(id.slice(i, i + 5))) return false;
	}
	return true;
}

async function fetchModels(provider: ModelProvider, key: string): Promise<string[]> {
	const origin = (process.env[`WLP_${provider.toUpperCase()}_BASE_URL`] ?? origins[provider]).replace(/\/+$/, "");
	const headers: Record<string, string> = provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
		: provider === "google" ? { "x-goog-api-key": key } : { authorization: `Bearer ${key}` };
	const init: RequestInit = { headers, redirect: "error", signal: AbortSignal.timeout(8_000) };
	// OpenRouter's catalog is public. Verify ownership before using its list.
	if (provider === "openrouter") {
		const auth = await fetch(origin + "/api/v1/key", init);
		await auth.body?.cancel();
		if (!auth.ok) throw new Error("Key check failed");
	}
	const path = provider === "google" ? "/v1beta/models" : provider === "openrouter" ? "/api/v1/models" : "/v1/models";
	const res = await fetch(origin + path, init);
	if (!res.ok || !res.body) {
		await res.body?.cancel();
		throw new Error("Model list unavailable");
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of res.body) {
		size += chunk.byteLength;
		if (size > 8 * 1024 * 1024) throw new Error("Model list too large");
		chunks.push(chunk);
	}
	const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const entries = provider === "google" ? body.models : body.data;
	if (!Array.isArray(entries)) throw new Error("Invalid model list");
	const models = new Set<string>();
	for (const entry of entries) {
		const id = provider === "google" ? entry?.name?.replace(/^models\//, "") : entry?.id;
		if (safeModelId(id, key)) models.add(id);
		if (models.size === 32) break;
	}
	return [...models];
}

async function runCheck(db: DefaultsDb, provider: ModelProvider, key: string, generation: string): Promise<ModelProviderCheck> {
	// Provider bodies, status text and fetch errors can all contain the submitted key.
	const models = await fetchModels(provider, key).catch(() => null);
	const [row] = await db.execute<StatusRow>(`UPDATE model_provider SET checked_at = ?, check_ok = ?, models = ?
		WHERE provider = ? AND generation = ? RETURNING ${STATUS_COLUMNS}`,
		Date.now(), Number(models !== null), models === null ? null : JSON.stringify(models), provider, generation);
	if (!row) throw new UserError("The saved key changed during the check.", { code: "model_key_changed" });
	return { ...status(row), ...(models === null && { message: "Could not check the key with the provider. Verify the key and try again." }) };
}

export const modelProviderActions = {
	async modelProviders(c: Context): Promise<ModelProviderStatus[]> {
		requireUser(c);
		return (await c.db.execute<StatusRow>(`SELECT ${STATUS_COLUMNS} FROM model_provider ORDER BY provider`)).map(status);
	},
	async saveModelProvider(c: Context, input: { provider: ModelProvider; key: string }): Promise<ModelProviderCheck> {
		const { uid } = requireUser(c);
		const provider = providerOf(input?.provider);
		const key = input.key;
		if (!validModelKey(provider, key)) throw new UserError("The key format does not match the provider.", { code: "bad_model_key" });
		await takeCheck(c.db);
		const generation = randomUUID();
		const sealed = serverSealer().seal("model-key", subject(uid, provider), key);
		await c.db.execute(`INSERT OR REPLACE INTO model_provider (provider, generation, sealed, last4, added_at) VALUES (?, ?, ?, ?, ?)`,
			provider, generation, sealed, key.slice(-4), Date.now());
		return runCheck(c.db, provider, key, generation);
	},
	async checkModelProvider(c: Context, raw: ModelProvider): Promise<ModelProviderCheck> {
		const { uid } = requireUser(c);
		const provider = providerOf(raw);
		await takeCheck(c.db);
		const saved = await savedKey(c.db, uid, provider);
		if (!saved) throw new UserError("No key is saved for this provider.", { code: "model_key_missing" });
		return runCheck(c.db, provider, saved.key, saved.generation);
	},
	async removeModelProvider(c: Context, raw: ModelProvider): Promise<void> {
		requireUser(c);
		await c.db.execute("DELETE FROM model_provider WHERE provider = ?", providerOf(raw));
	},
	async internalModelKey(c: Context, raw: ModelProvider, nonce: string): Promise<string | null> {
		requireServiceFor(c, "call");
		const provider = providerOf(raw);
		if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new UserError("Invalid model key request nonce.", { code: "bad_nonce" });
		const uid = c.key[0]!;
		const saved = await savedKey(c.db, uid, provider);
		return saved && serverSealer().seal("transit", modelKeyTransitSubject(uid, provider, nonce), JSON.stringify(saved));
	},
};
