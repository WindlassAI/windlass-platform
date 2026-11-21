import { randomBytes } from "node:crypto";
import { UserError } from "rivetkit";
import type { createClient } from "rivetkit/client";
import type { RawAccess } from "rivetkit/db";
import { requireServiceFor, requireUser, serviceParams } from "../auth.js";
import { config } from "../config.js";
import { MAX_MACHINES, type MachineClaim, type MachineSummary, type SandboxPlace, type SessionSummary } from "../contract.js";
import type { Registry } from "../registry.js";
import { machineProfiles } from "../machines/profiles.js";
import { codeDigest } from "../runner-keys.js";
import { MACHINE_ID, MIN_RUNNER_VERSION, PAIRING_TTL_MS, versionAtLeast } from "../runner/control.js";
import { approvalCode, MACHINE_PROFILES, CLAUDE_LOGIN_MS, type LoginCommand, type LoginResult } from "../runner/protocol.js";
import { createGrant, isActorGone } from "./internal.js";
import type { MachineUpdate } from "./machine.js";
import { asPairingError, pairingGone } from "./machine-pairing.js";

interface Ctx {
	db: RawAccess; key: string[]; client(): unknown; conn?: { params: unknown } | null;
	vars: { machines: Map<string, MachineSummary>; sessions: Map<string, SessionSummary>; github: { user: { login: string } } | null };
	broadcast(name: string, ...args: unknown[]): void;
}
const actors = (c: Ctx) => c.client() as ReturnType<typeof createClient<Registry>>;
const machine = (c: Ctx, id: string) => actors(c).machine.get([c.key[0]!, id], { params: serviceParams() });
const missing = () => new UserError("That machine is not in your account.", { code: "machine_not_found" });
const full = () => new UserError(`An account can connect up to ${MAX_MACHINES} machines.`, { code: "too_many_machines" });
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
	await db.execute(`CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL, facts TEXT NOT NULL,
		send INTEGER NOT NULL DEFAULT 1, login TEXT, expires INTEGER)`);
	await db.execute("CREATE TABLE IF NOT EXISTS claude_login_attempts (at INTEGER NOT NULL)");
	await db.execute("CREATE TABLE IF NOT EXISTS machine_claims (at INTEGER NOT NULL)");
}

async function pairing(c: Ctx, input: { code: string }) {
	const hash = codeDigest(input?.code);
	if (!hash) throw pairingGone();
	const id = await actors(c).pairingDirectory.getOrCreate(["starts"], { params: serviceParams() }).internalLookup(hash);
	if (!id) throw pairingGone();
	return actors(c).machinePairing.get([id], { params: serviceParams() });
}

export async function listMachines(c: { db: RawAccess; vars: Pick<Ctx["vars"], "sessions"> }): Promise<MachineSummary[]> {
	const rows = await c.db.execute<{ id: string; name: string; os: string; arch: string; facts: string; send: number }>("SELECT id, name, os, arch, facts, send FROM machines WHERE expires IS NULL ORDER BY rowid");
	return rows.map(row => {
		const { report, ...facts }: MachineUpdate = JSON.parse(row.facts);
		const sessions = [...c.vars.sessions.values()].filter(s => s.place.kind === "machine" && s.place.machineId === row.id);
		const titles = new Map(sessions.map(s => [s.id, s.title]));
		return {
			name: row.name, os: row.os, arch: row.arch, ...facts, machineId: row.id,
			profiles: report ? machineProfiles(row.name, report) : [], sendSecrets: !!row.send, agents: sessions.length,
			sandboxes: (report?.sandboxes ?? []).map(({ sessionId, state, usedAt }) => ({ sessionId, state, usedAt, title: titles.get(sessionId) ?? null })).sort((a, b) => b.usedAt - a.usedAt),
			freeDiskBytes: report?.freeDiskBytes ?? null, commandSandbox: report?.commandSandbox ?? null,
			...(report && { allowedProfiles: report.allowedProfiles ?? [...MACHINE_PROFILES] }),
			...(report?.harnesses ? { harnesses: report.harnesses } : {}),
			...(report?.maxRunning !== undefined ? { maxRunning: report.maxRunning } : {}),
			...(report?.maxSandboxes !== undefined ? { maxSandboxes: report.maxSandboxes } : {}) };
	});
}
async function changed(c: Ctx) {
	const machines = await listMachines(c);
	c.vars.machines = new Map(machines.map(m => [m.machineId, m]));
	c.broadcast("machines", machines);
	return machines;
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
	const [row] = await db.execute<{ name: string; facts: string }>("SELECT name, facts FROM machines WHERE id = ? AND expires IS NULL", id);
	if (!row) throw missing();
	const { report, runnerVersion }: MachineUpdate = JSON.parse(row.facts);
	// First: an outdated runner is refused before it can report, so it has no report either.
	if (!versionAtLeast(runnerVersion, MIN_RUNNER_VERSION)) {
		throw new UserError(`The runner on "${row.name}" is older than this platform takes: update it to ${MIN_RUNNER_VERSION} or later, then start the agent again.`, { code: "runner_outdated" });
	}
	if (!report) throw new UserError(`"${row.name}" has not connected yet. Start its runner, and once the Machines page shows it online, start the agent again.`, { code: "machine_not_connected" });
	return { name: row.name, allowedProfiles: report.allowedProfiles, harnesses: report.harnesses, profiles: machineProfiles(row.name, report) };
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

async function claudeLogin(c: Ctx, machineId: string, command: LoginCommand): Promise<Exclude<LoginResult, { error: string }>> {
	requireUser(c); enabled();
	const now = Date.now();
	await c.db.execute("DELETE FROM claude_login_attempts WHERE at <= ?", now - CLAUDE_LOGIN_MS);
	const admitted = await c.db.execute("INSERT INTO claude_login_attempts SELECT ? WHERE (SELECT count(*) FROM claude_login_attempts) < 12 RETURNING at", now);
	if (!admitted.length) throw new UserError("Too many Claude sign-in requests. Try again in ten minutes.", { code: "rate_limited" });
	if (typeof machineId !== "string" || !MACHINE_ID.test(machineId) || await machineSecrets(c.db, machineId) === null) throw missing();
	if (command.kind === "harnessLogin.finish" && !approvalCode(command.code))
		throw new UserError("Paste the authorization code shown by Anthropic.", { code: "bad_input" });
	const result = await machine(c, machineId).internalClaudeLogin(command);
	if ("error" in result) throw new UserError(result.error, { code: "claude_login_failed" });
	return result;
}

const unexpected = () => new UserError("The runner returned an unexpected sign-in reply.", { code: "claude_login_failed" });
export const machineActions = {
	async startClaudeLogin(c: Ctx, input: { machineId: string }) {
		const result = await claudeLogin(c, input?.machineId, { kind: "harnessLogin.start", requestId: randomBytes(16).toString("hex") });
		if (!("url" in result)) throw unexpected();
		return result;
	},
	async finishClaudeLogin(c: Ctx, input: { machineId: string; code: string }) {
		const result = await claudeLogin(c, input?.machineId, { kind: "harnessLogin.finish", requestId: randomBytes(16).toString("hex"), code: input?.code });
		if (!("signedIn" in result)) throw unexpected();
		return result;
	},
	async cancelClaudeLogin(c: Ctx, input: { machineId: string }) {
		const result = await claudeLogin(c, input?.machineId, { kind: "harnessLogin.cancel", requestId: randomBytes(16).toString("hex") });
		if (!("cancelled" in result)) throw unexpected();
		return result;
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
		if (n >= MAX_MACHINES) throw full();
		return (await pairing(c, input)).internalClaim(uid).catch(asPairingError);
	},
	async confirmMachine(c: Ctx, input: { code: string }): Promise<MachineSummary> {
		const { uid } = requireUser(c); enabled();
		const claim = await (await pairing(c, input)).internalClaimed(uid).catch(asPairingError);
		const { machineId: id, details, expires } = claim;
		const now = Date.now();
		const facts: MachineUpdate = { status: "waiting", since: now, runnerVersion: details.runnerVersion, warnings: [], report: null };
		await c.db.execute("DELETE FROM machines WHERE expires <= ?", now);
		// A slot is private until the machine accepts it. Retries share the pairing's fixed id.
		await c.db.execute(`INSERT OR IGNORE INTO machines(id, name, os, arch, facts, login, expires) SELECT ?, ?, ?, ?, ?, ?, ?
			WHERE ? > ? AND (SELECT count(*) FROM machines) < ?`, id, details.name, details.os, details.arch, JSON.stringify(facts), c.vars.github?.user.login ?? null, expires, expires, Date.now(), MAX_MACHINES);
		const [slot] = await c.db.execute<{ expires: number | null }>("SELECT expires FROM machines WHERE id = ?", id);
		if (!slot) { if (expires <= Date.now()) throw pairingGone(); throw full(); }
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
	async setMachineSecrets(c: Ctx, input: { machineId: string; send: boolean }): Promise<MachineSummary[]> {
		requireUser(c); enabled();
		if (typeof input?.send !== "boolean") throw new UserError("Choose whether to send saved secrets.", { code: "bad_input" });
		if (typeof input.machineId !== "string") throw missing();
		const rows = await c.db.execute("UPDATE machines SET send = ? WHERE id = ? AND expires IS NULL RETURNING id", Number(input.send), input.machineId);
		if (!rows.length) throw missing();
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
	async internalMachineChanged(c: Ctx, id: string, facts: MachineUpdate | null): Promise<void> {
		requireServiceFor(c, "call");
		const rows = facts === null
			? await c.db.execute("DELETE FROM machines WHERE id = ? RETURNING id", id)
			: await c.db.execute("UPDATE machines SET facts = ? WHERE id = ? AND expires IS NULL AND facts <> ? RETURNING id", JSON.stringify(facts), id, JSON.stringify(facts));
		if (rows.length) await changed(c);
	},
};
