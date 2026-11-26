import { randomBytes } from "node:crypto";
import { UserError } from "rivetkit";
import type { createClient } from "rivetkit/client";
import type { RawAccess } from "rivetkit/db";
import { requireServiceFor, requireUser, serviceParams } from "../auth.js";
import { config } from "../config.js";
import { accountLimits, type UserLimits } from "../user-limits.js";
import { machineLabel, sessionTitle, type CredentialSource, type HarnessOptions, type MachineClaim, type MachineSummary, type SandboxPlace, type SessionSummary } from "../contract.js";
import type { Registry } from "../registry.js";
import { machineDetails } from "../machines/details.js";
import { machineProfiles } from "../machines/profiles.js";
import { BUILT_IN_STORE_LIMITS } from "../sandbox/store-limits.js";
import { codeDigest } from "../runner-keys.js";
import { compactReport, type CatalogId } from "../runner/catalog.js";
import { MACHINE_ID, LEGACY_MIN_RUNNER_VERSION, MIN_RUNNER_VERSION, PAIRING_TTL_MS, versionAtLeast } from "../runner/control.js";
import { MACHINE_PROFILES } from "../runner/protocol.js";
import { createGrant, isActorGone } from "./internal.js";
import type { MachineUpdate } from "./machine.js";
import { asPairingError, pairingGone } from "./machine-pairing.js";

import { savedModelKeys } from "../model-providers.js";
import { listedHarness, machineHarness } from "../sandbox/harnesses.js";
import { PROVIDER_TABLE, accountsAt, providerAccounts } from "./provider-accounts.js";

interface Ctx {
	db: RawAccess; key: string[]; client(): unknown; conn?: { params: unknown } | null;
	vars: { tokenGen: number; machines: Map<string, MachineSummary>; sessions: Map<string, SessionSummary>; github: { user: { login: string } } | null; items?: { limits: UserLimits } };
	broadcast(name: string, ...args: unknown[]): void;
}
const actors = (c: Pick<Ctx, "client">) => c.client() as ReturnType<typeof createClient<Registry>>;
const machine = (c: Pick<Ctx, "client" | "key">, id: string) => actors(c).machine.get([c.key[0]!, id], { params: serviceParams() });
const missing = () => new UserError("That machine is not in your account.", { code: "machine_not_found" });
/** How many machines the account may pair: the deployment's MAX_MACHINES, or its plan's where there is billing (billing/plans.ts). */
const limitsOf = (c: Pick<Ctx, "vars">) => accountLimits(c.vars.items?.limits ?? { id: 0, overrides: {} });
const machineLimit = (c: Pick<Ctx, "vars">) => limitsOf(c).machines;
const full = (c: Pick<Ctx, "vars">) => {
	const limits = limitsOf(c);
	const more = limits.plan?.id === "free" ? " Pro connects up to 10." : "";
	return new UserError(`An account can connect up to ${limits.machines} machines.${more}`, { code: "too_many_machines" });
};
function enabled() {
	if (!config.machines) throw new UserError("Machines are not available on this platform.", { code: "machines_off" });
}

export function launchPlace(raw: unknown): SandboxPlace {
	const place = raw as Partial<{ kind: string; machineId: unknown }> | null | undefined;
	if (place === undefined || place?.kind === "hosted") return { kind: "hosted" };
	if (place?.kind === "machine" && typeof place.machineId === "string" && MACHINE_ID.test(place.machineId)) return { kind: "machine", machineId: place.machineId };
	throw new UserError("Choose where the sandbox runs.", { code: "bad_input" });
}

export async function machineTables(db: RawAccess) {
	await db.execute(PROVIDER_TABLE);
	// Consolidate pre-account Windlass rows before per-machine cleanup can remove them.
	// Repeating either statement after an interrupted migration keeps the same strongest cooldown.
	await db.execute(`INSERT OR REPLACE INTO provider_usage (place,harness,generation,data)
		SELECT '*', harness, generation, json_set(data, '$.account.key', '*/windlass/' || generation)
		FROM provider_usage WHERE harness='windlass' AND EXISTS (SELECT 1 FROM provider_usage WHERE harness='windlass' AND place<>'*')
		ORDER BY CAST(generation AS INTEGER) DESC, json_extract(data, '$.account.limitedUntil') DESC,
			json_extract(data, '$.lastRefusal') DESC, place LIMIT 1`);
	await db.execute("DELETE FROM provider_usage WHERE harness='windlass' AND place<>'*'");
	await db.execute(`CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL, facts TEXT NOT NULL,
		send INTEGER NOT NULL DEFAULT 1, login TEXT, expires INTEGER)`);
	if (!(await db.execute<{ name: string }>("PRAGMA table_info(machines)")).some(column => column.name === "host"))
		await db.execute("ALTER TABLE machines ADD COLUMN host TEXT");
	// Older account indexes still contain the machine's inline models and host.
	const legacy = await db.execute<{ id: string; facts: string }>(`SELECT id, facts FROM machines WHERE facts LIKE '%"options":%' OR json_type(facts, '$.report.host') IS NOT NULL`);
	for (const row of legacy) {
		const facts: MachineUpdate = JSON.parse(row.facts);
		if (!facts.report) continue;
		const { host, ...report } = facts.report;
		await db.execute("UPDATE machines SET facts = ?, host = ? WHERE id = ?", JSON.stringify({ ...facts, report: compactReport(report) }), host ? JSON.stringify(host) : null, row.id);
	}
	await db.execute("CREATE TRIGGER IF NOT EXISTS forget_machine_usage AFTER DELETE ON machines BEGIN DELETE FROM provider_usage WHERE place=OLD.id; END");
	// Legacy runners have no generation marker. An explicit logout still retires the old account.
	await db.execute(`CREATE TRIGGER IF NOT EXISTS forget_harness_usage AFTER UPDATE OF facts ON machines BEGIN
		DELETE FROM provider_usage WHERE place=NEW.id AND EXISTS (
			SELECT 1 FROM json_each(NEW.facts, '$.report.harnesses') AS h
			WHERE json_extract(h.value,'$.id')=harness AND (
				json_extract(h.value,'$.signIn')='none' OR
				(json_extract(h.value,'$.signIn')='token' AND COALESCE(json_extract(h.value,'$.loginGeneration'),'legacy')<>generation)));
	END`);
	await db.execute("CREATE TABLE IF NOT EXISTS machine_details (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
	await db.execute("CREATE TABLE IF NOT EXISTS credential_sources (machine TEXT NOT NULL, harness TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (machine, harness))");
	await db.execute("CREATE TRIGGER IF NOT EXISTS forget_credential_sources AFTER DELETE ON machines BEGIN DELETE FROM credential_sources WHERE machine=OLD.id; END");
	await db.execute("CREATE TABLE IF NOT EXISTS machine_claims (at INTEGER NOT NULL)");
}

async function pairing(c: Ctx, input: { code: string }) {
	const hash = codeDigest(input?.code);
	if (!hash) throw pairingGone();
	const id = await actors(c).pairingDirectory.getOrCreate(["starts"], { params: serviceParams() }).internalLookup(hash);
	if (!id) throw pairingGone();
	return actors(c).machinePairing.get([id], { params: serviceParams() });
}

export function itemMachines(machines: ReadonlyMap<string, MachineSummary>) {
	return config.machines ? [...machines.values()] : [];
}

export async function listMachines(c: { db: RawAccess; vars: Pick<Ctx["vars"], "sessions"> }): Promise<MachineSummary[]> {
	const rows = await c.db.execute<{ id: string; name: string; os: string; arch: string; facts: string; host: string | null; send: number; details: string | null }>("SELECT m.id, name, os, arch, facts, host, send, d.data AS details FROM machines m LEFT JOIN machine_details d ON m.id=d.id WHERE expires IS NULL ORDER BY m.rowid");
	const accounts = await providerAccounts(c.db, Date.now());
	const keys = (await savedModelKeys(c.db)).map(k => k.provider);
	const sources = await credentialSources(c.db);
	return rows.map(row => {
		const { report, ...facts }: MachineUpdate = JSON.parse(row.facts);
		const harnesses = report?.harnesses?.map(h => listedHarness(h, keys, sources.get(`${row.id}/${h.id}`)));
		const sessions = [...c.vars.sessions.values()].filter(s => s.place.kind === "machine" && s.place.machineId === row.id);
		const titles = new Map(sessions.map(s => [s.id, sessionTitle(s)]));
		return {
			whenToUse: "", tags: [], orchestrator: "yes" as const,
			...(row.details && JSON.parse(row.details) as import("../contract.js").MachineDetails),
			providerAccounts: accountsAt(accounts, row.id, keys.filter(p => harnesses?.some(h => h.platformKeys?.includes(p)))),
			personalRunning: sessions.filter(s => !s.item && s.status !== "idle").length,
			host: row.host ? JSON.parse(row.host) : undefined, screenshots: report?.screenshots,
			name: row.name, os: row.os, arch: row.arch, ...facts, machineId: row.id,
			profiles: report ? machineProfiles(machineLabel(row), report) : [], sendSecrets: !!row.send, agents: sessions.length,
			sandboxes: (report?.sandboxes ?? []).map(({ sessionId, state, usedAt, resizePending }) => ({ sessionId, state, usedAt, resizePending, title: titles.get(sessionId) ?? null })).sort((a, b) => b.usedAt - a.usedAt),
			freeDiskBytes: report?.freeDiskBytes ?? null, commandSandbox: report?.commandSandbox ?? null,
			...(report && { egress: report.egress ?? "open", allowedProfiles: report.allowedProfiles ?? [...MACHINE_PROFILES] }),
			...(report?.egressDomains && { egressDomains: report.egressDomains }),
			...(report?.claudeRelay && { claudeRelay: true as const }),
			...(harnesses && { harnesses }),
			...(report?.warmSpares && { readySandboxes: report.warmSpares.ready }),
			...(report?.maxRunning !== undefined ? { maxRunning: report.maxRunning } : {}),
			...(report?.maxSandboxes !== undefined ? { maxSandboxes: report.maxSandboxes } : {}),
			// A runner 0.3.1 or older reports none: it applies its built-in limits.
			...(report && { storeLimits: report.storeLimits ?? { ...BUILT_IN_STORE_LIMITS, builtIn: true as const } }) };
	});
}
export async function changed(c: Ctx) {
	const machines = await listMachines(c);
	c.vars.machines = new Map(machines.map(m => [m.machineId, m]));
	c.broadcast("machines", machines);
	return machines;
}

/** The owner's credential choices by "machine/harness"; one machine's with `machine`. */
async function credentialSources(db: RawAccess, machine?: string): Promise<Map<string, CredentialSource>> {
	const rows = await db.execute<{ machine: string; harness: string; source: CredentialSource }>(
		`SELECT machine, harness, source FROM credential_sources${machine ? " WHERE machine = ?" : ""}`, ...(machine ? [machine] : []));
	return new Map(rows.map(row => [`${row.machine}/${row.harness}`, row.source]));
}

export async function credentialSource(db: RawAccess, machine: string, harness: string): Promise<CredentialSource | null> {
	const [row] = await db.execute<{ source: CredentialSource | null }>(`SELECT s.source FROM machines m
		LEFT JOIN credential_sources s ON s.machine=m.id AND s.harness=? WHERE m.id=? AND m.expires IS NULL`, harness, machine);
	if (!row) throw missing();
	return row.source;
}

export async function machineSecrets(db: RawAccess, id: string): Promise<boolean | null> {
	const [row] = await db.execute<{ send: number }>("SELECT send FROM machines WHERE id = ? AND expires IS NULL", id);
	return row ? !!row.send : null;
}

/**
 * The machine's profiles as its last report has them, and its name, which the session keeps (asking for it
 * later fails while the machine is offline); a machine that cannot take an agent yet is told apart, with what to do.
 */
export async function launchMachineProfiles(db: RawAccess, id: string) {
	enabled();
	const [row] = await db.execute<{ name: string; os: string; arch: string; facts: string }>("SELECT name, os, arch, facts FROM machines WHERE id = ? AND expires IS NULL", id);
	if (!row) throw missing();
	const name = machineLabel(row);
	const { report, runnerVersion, warnings = [] }: MachineUpdate = JSON.parse(row.facts);
	// First: an outdated runner is refused before it can report, so it has no report either.
	const minimum = config.machines?.identity ? MIN_RUNNER_VERSION : LEGACY_MIN_RUNNER_VERSION;
	if (!config.machines?.identity && warnings.some(w => w.kind === "signing-disabled")) throw new UserError("This runner requires signed connections to be enabled on the platform.", { code: "runner_signing_disabled" });
	if (!versionAtLeast(runnerVersion, minimum) || (config.machines?.identity && warnings.some(w => w.kind === "outdated"))) {
		throw new UserError(`The runner on "${name}" is older than this platform takes: update it to ${minimum} or later, then start the agent again.`, { code: "runner_outdated" });
	}
	if (!report) throw new UserError(`"${name}" has not connected yet. Start its runner, and once the Machines page shows it online, start the agent again.`, { code: "machine_not_connected" });
	const keys = (await savedModelKeys(db)).map(k => k.provider);
	const sources = await credentialSources(db, id);
	return { name, slots: report.slots, egress: report.egress, allowedProfiles: report.allowedProfiles, harnesses: report.harnesses?.map(h => listedHarness(h, keys, sources.get(`${id}/${h.id}`))), profiles: machineProfiles(name, report) };
}

/**
 * Has each machine's runner remove its sign-in files. Never throws: by now the sign-in itself is gone,
 * and one machine actor that does not answer must not have the person told that nothing was forgotten.
 * Only a runner connected now hears it (the machine actor queues nothing for it).
 */
export async function logoutMachines(c: Ctx) {
	// A newly accepted socket can precede its status event. Ask each of the at most three owners.
	const paired = await c.db.execute<{ id: string }>("SELECT id FROM machines WHERE expires IS NULL");
	const asked = await Promise.allSettled(paired.map(({ id }) => machine(c, id).internalLogout()));
	asked.forEach((answer, index) => {
		if (answer.status === "rejected") console.warn(`[wlp] machine.logout_failed uid=${c.key[0]} machine=${paired[index]!.id}: ${answer.reason instanceof Error ? answer.reason.message : String(answer.reason)}`);
	});
}

export async function machineCatalog(c: Pick<Ctx, "client" | "key">, machineId: string, id: CatalogId, digest: string): Promise<HarnessOptions | null> {
	return machine(c, machineId).internalCatalog(id, digest);
}

export const machineActions = {
	async machineCatalog(c: Ctx, input: { machineId: string; id: CatalogId; digest: string }) {
		requireUser(c); enabled();
		if (!input || (input.id !== "opencode" && input.id !== "claude" && input.id !== "codex") || typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest) ||
			typeof input.machineId !== "string" || !MACHINE_ID.test(input.machineId) || await machineSecrets(c.db, input.machineId) === null) throw missing();
		return machineCatalog(c, input.machineId, input.id, input.digest);
	},
	async machines(c: Ctx): Promise<MachineSummary[]> {
		requireUser(c); enabled();
		return listMachines(c);
	},
	async claimMachine(c: Ctx, input: { code: string }): Promise<MachineClaim> {
		const { uid } = requireUser(c); enabled();
		const now = Date.now();
		await c.db.execute("DELETE FROM machine_claims WHERE at <= ?", now - PAIRING_TTL_MS);
		const charged = await c.db.execute("INSERT INTO machine_claims SELECT ? WHERE (SELECT count(*) FROM machine_claims) < 5 RETURNING at", now);
		if (!charged.length) throw new UserError("Too many code lookups. Try again in ten minutes.", { code: "too_many_claims" });
		const [{ n }] = await c.db.execute<{ n: number }>("SELECT count(*) AS n FROM machines WHERE expires IS NULL OR expires > ?", now);
		if (n >= machineLimit(c)) throw full(c);
		return (await pairing(c, input)).internalClaim(uid).catch(asPairingError);
	},
	async confirmMachine(c: Ctx, input: { code: string; keyConfirmed: true }): Promise<MachineSummary> {
		const { uid } = requireUser(c); enabled();
		// The person compares the machine key's fingerprint with the runner's terminal before Connect: a code
		// someone else gave them is of that person's machine, whose key their own terminal does not show.
		if (input?.keyConfirmed !== true) throw new UserError("Check that the machine's terminal shows the same machine key, then connect it.", { code: "key_not_confirmed" });
		const claim = await (await pairing(c, input)).internalClaimed(uid).catch(asPairingError);
		const { machineId: id, details, expires } = claim;
		const now = Date.now();
		const facts: MachineUpdate = { status: "waiting", since: now, runnerVersion: details.runnerVersion, warnings: [], report: null };
		await c.db.execute("DELETE FROM machines WHERE expires <= ?", now);
		// A slot is private until the machine accepts it. Retries share the pairing's fixed id.
		await c.db.execute(`INSERT OR IGNORE INTO machines(id, name, os, arch, facts, login, expires) SELECT ?, ?, ?, ?, ?, ?, ?
			WHERE ? > ? AND (SELECT count(*) FROM machines) < ?`, id, details.name, details.os, details.arch, JSON.stringify(facts), c.vars.github?.user.login ?? null, expires, expires, Date.now(), machineLimit(c));
		const [slot] = await c.db.execute<{ expires: number | null }>("SELECT expires FROM machines WHERE id = ?", id);
		if (!slot) { if (expires <= Date.now()) throw pairingGone(); throw full(c); }
		if (slot.expires !== null) {
			const key = [uid, id];
			const handle = actors(c).machine.getOrCreate(key, { params: serviceParams(), createWithInput: { grant: createGrant("machine", key), details, publicKey: claim.publicKey, expires } });
			const facts = await handle.internalFacts().catch(asPairingError);
			if (facts.status === "removed") {
				await c.db.execute("DELETE FROM machines WHERE id = ? AND expires IS NOT NULL", id);
				throw pairingGone();
			}
		}
		const summary = (await listMachines(c)).find(row => row.machineId === id);
		if (!summary) throw pairingGone();
		return summary;
	},
	async removeMachine(c: Ctx, input: { machineId: string; removeSandboxes: boolean }): Promise<MachineSummary[]> {
		requireUser(c); enabled();
		if (typeof input?.removeSandboxes !== "boolean") throw new UserError("Choose whether to remove the sandboxes.", { code: "bad_input" });
		if (typeof input.machineId !== "string" || await machineSecrets(c.db, input.machineId) === null) throw missing();
		try { await machine(c, input.machineId).internalRevoke(input.removeSandboxes); }
		catch (error) { if (isActorGone(error)) throw missing(); throw error; }
		return listMachines(c);
	},
	async setMachineDetails(c: Ctx, input: { machineId: string } & import("../contract.js").MachineDetails) {
		requireUser(c); enabled();
		let details;
		try { details = machineDetails(input); } catch (error) { throw new UserError((error as Error).message, { code: "bad_input" }); }
		// Older settings forms send only text and tags. Preserve the owner's placement policy on those writes.
		const rows = await c.db.execute(`INSERT OR REPLACE INTO machine_details SELECT m.id,
			json_set(?, '$.orchestrator', COALESCE(?, json_extract(d.data, '$.orchestrator'), 'yes'))
			FROM machines m LEFT JOIN machine_details d ON d.id=m.id WHERE m.id=? AND m.expires IS NULL RETURNING id`,
			JSON.stringify(details), input.orchestrator ?? null, input.machineId);
		if (!rows.length) throw missing();
		return changed(c);
	},
	async setMachineSecrets(c: Ctx, input: { machineId: string; send: boolean }): Promise<MachineSummary[]> {
		requireUser(c); enabled();
		if (typeof input?.send !== "boolean") throw new UserError("Choose whether to send saved secrets.", { code: "bad_input" });
		if (typeof input.machineId !== "string") throw missing();
		const rows = await c.db.execute("UPDATE machines SET send = ? WHERE id = ? AND expires IS NULL RETURNING id", Number(input.send), input.machineId);
		if (!rows.length) throw missing();
		return changed(c);
	},
	async setCredentialSource(c: Ctx, input: { machineId: string; harness: string; source: CredentialSource }): Promise<MachineSummary[]> {
		requireUser(c); enabled();
		if (input?.source !== "machine" && input?.source !== "key") throw new UserError("Choose the machine's sign-in or your Settings key.", { code: "bad_input" });
		const harness = machineHarness(input.harness);
		if (!harness) throw new UserError("Unknown agent.", { code: "bad_input" });
		if (typeof input.machineId !== "string") throw missing();
		const rows = await c.db.execute(`INSERT OR REPLACE INTO credential_sources (machine, harness, source)
			SELECT m.id, ?, ? FROM machines m WHERE m.id=? AND m.expires IS NULL
			AND EXISTS (SELECT 1 FROM json_each(m.facts, '$.report.harnesses') h WHERE json_extract(h.value, '$.id')=?)
			RETURNING machine`, harness.id, input.source, input.machineId, harness.id);
		if (!rows.length) {
			if (await machineSecrets(c.db, input.machineId) === null) throw missing();
			throw new UserError("This machine does not offer that agent.", { code: "bad_input" });
		}
		return changed(c);
	},
	async internalMachineCreated(c: Ctx, id: string): Promise<boolean> {
		requireServiceFor(c, "call");
		const rows = await c.db.execute("UPDATE machines SET expires = NULL WHERE id = ? AND expires > ? RETURNING id", id, Date.now());
		if (rows.length) {
			await changed(c);
			return true;
		}
		// Rivet can redeliver an action whose answer was lost after the write.
		return await machineSecrets(c.db, id) !== null;
	},
	async internalMachineApproval(c: Ctx, id: string): Promise<{ login: string | null } | null> {
		requireServiceFor(c, "call");
		const [row] = await c.db.execute<{ login: string | null }>("SELECT login FROM machines WHERE id = ? AND expires IS NULL", id);
		return row ?? null;
	},
	async internalMachineChanged(c: Ctx, id: string, facts: MachineUpdate | null): Promise<boolean> {
		requireServiceFor(c, "call");
		if (!facts) {
			if ((await c.db.execute("DELETE FROM machines WHERE id = ? RETURNING id", id)).length) await changed(c);
			return true;
		}
		return publishMachineUpdate(c, id, facts);
	},
};

export async function publishMachineUpdate(c: Ctx, id: string, update: MachineUpdate) {
	const { host: sampled, ...facts } = update;
	// During a rolling deploy an older machine actor may still publish inline options.
	const host = sampled ?? facts.report?.host;
	if (facts.report && (facts.report.host || facts.report.harnesses?.some(entry => entry.options))) {
		const { host: _host, ...report } = facts.report;
		facts.report = compactReport(report);
	}
	const data = JSON.stringify(facts);
	const sample = host ? JSON.stringify(host) : null;
	const rows = await c.db.execute("UPDATE machines SET name = COALESCE(?, name), facts = ?, host = ? WHERE id = ? AND expires IS NULL AND facts <> ? RETURNING id", facts.name ?? null, data, sample, id, data);
	if (rows.length) { await changed(c); return true; }
	if ((await c.db.execute("UPDATE machines SET host = ? WHERE id = ? AND expires IS NULL AND host IS NOT ? RETURNING id", sample, id, sample)).length) {
		const machine = c.vars.machines.get(id);
		if (machine) c.vars.machines.set(id, { ...machine, host });
		c.broadcast("machineHost", { machineId: id, host: host ?? null });
	}
	return false;
}
