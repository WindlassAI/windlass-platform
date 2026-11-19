import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { actor, UserError, type UniversalWebSocket } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, requireServiceFor, serviceParams } from "../auth.js";
import { config } from "../config.js";
import { MACHINE_EXPIRY_MS, type MachineClaim, type MachineStatus, type MachineWarning } from "../contract.js";
import { machineError, signed } from "../runner-keys.js";
import { CLOCK_TOLERANCE_MS, CONTROL_DEAD_MS, CONTROL_HEARTBEAT_MS, MACHINE_ID, MIN_RUNNER_VERSION, controlProof, parseRunnerFrame, refuse, secondHello, versionAtLeast, type Refusal, type Report, type ServerFrame } from "../runner/control.js";
import { grantIsValid } from "./internal.js";

const SEEN_INTERVAL = 3 * 60_000;
/**
 * How long a control socket may stay open without a hello. The runner sends it as soon as the challenge
 * arrives; a socket that never does would otherwise keep the actor awake until CONTROL_DEAD_MS.
 */
const HELLO_WAIT_MS = 10_000;
type Socket = UniversalWebSocket;
interface Live { ws: Socket; epoch: string; heardAt: number; connected: number; savedAt: number }
/** `greeting` is the one control socket that has yet to say hello: a newer one replaces it. */
interface Vars { live: Live | null; work: Promise<void>; greeting: Socket | null }
interface Ctx {
	db: RawAccess; vars: Vars; key: string[];
	// Actor references are resolved through this node's registry.
	client(): any;
}
interface Input { grant: string; details: MachineClaim; publicKey: string; expires: number }
type Row = { name: string; version: string; public_key: string; created: number; seen: number | null; removed_at: number | null; remove_sandboxes: number; offset: number; duplicate: number | null; report: string | null };
export interface MachineUpdate { status: MachineStatus; since: number; runnerVersion: string; warnings: MachineWarning[]; report: Report | null }
/** `publicKey` is the machine's Ed25519 key, SPKI in base64; it never changes (pairing again makes a new machine). */
export interface MachineFacts { status: MachineStatus | "removed"; name: string; publicKey: string; report: Report | null }
export type Attachment = { ok: true } | { ok: false; reason: "offline" | "removed" | "unknown" };

const controlPath = (r?: Request) => !!r && new URL(r.url).pathname === "/websocket/control";
function send(ws: Socket, frame: ServerFrame): boolean {
	if (ws.readyState !== ws.OPEN) return false;
	try {
		ws.send(JSON.stringify(frame));
		return true;
	} catch (error) {
		machineError("send control frame", error);
		ws.close(1011, "Control socket failed");
		return false;
	}
}
function reject(ws: Socket, frame: Refusal) {
	send(ws, frame);
	if (ws.readyState === ws.OPEN) ws.close(1008, frame.reason);
}

// A socket and a SQL write cannot be updated in one SQL statement. Order those transitions,
// including delivery to the user's index, so an old close can never overtake a new welcome.
function ordered<T>(c: Ctx, step: () => Promise<T>): Promise<T> {
	const result = c.vars.work.then(step);
	c.vars.work = result.then(() => {}, () => {});
	return result;
}

async function record(c: Ctx) {
	return (await c.db.execute<Row>("SELECT * FROM machine"))[0];
}
const user = (c: Pick<Ctx, "key" | "client">) => c.client().user.get([c.key[0]], { params: serviceParams() });
function update(c: Ctx, row: Row): MachineUpdate {
	const report: Report | null = row.report ? JSON.parse(row.report) : null;
	const warnings: MachineWarning[] = [];
	if (!versionAtLeast(row.version, MIN_RUNNER_VERSION)) warnings.push({ kind: "outdated" });
	if (report && !report.docker.ok) warnings.push({ kind: "docker", reason: report.docker.reason });
	if (Math.abs(row.offset) > CLOCK_TOLERANCE_MS) warnings.push({ kind: "clock", offsetSeconds: Math.round(row.offset / 1000) });
	if (row.duplicate !== null) warnings.push({ kind: "key", at: row.duplicate });
	return { status: c.vars.live ? "online" : row.seen === null ? "waiting" : "offline", since: c.vars.live?.connected ?? row.seen ?? row.created, runnerVersion: row.version, warnings, report };
}
async function publish(c: Ctx, row: Row) {
	await user(c).internalMachineChanged(c.key[1], row.removed_at === null ? update(c, row) : null);
}
/**
 * For what a runner's frame changed: a user actor that is briefly away (its node restarting) must not
 * cost the runner its control socket, and with it every session's attach. Each publish carries the
 * whole row, so the next one puts the user's list right.
 */
function tell(c: Ctx, row: Row | undefined): Promise<void> {
	return row ? publish(c, row).catch((error) => machineError("publish machine change", error)) : Promise.resolve();
}

async function disconnected(c: Ctx, ws: Socket) {
	if (c.vars.live?.ws !== ws) return;
	c.vars.live = null;
	const [row] = await c.db.execute<Row>("UPDATE machine SET seen = ? WHERE removed_at IS NULL RETURNING *", Date.now());
	if (row) await publish(c, row);
}

async function revoke(c: Ctx, removeSandboxes: boolean, idle: boolean): Promise<void> {
	await ordered(c, async () => {
		const [row] = await c.db.execute<Row>(`UPDATE machine SET removed_at = ?, remove_sandboxes = ?
			WHERE removed_at IS NULL AND (? = 0 OR COALESCE(seen, created) <= ?) RETURNING *`, Date.now(), Number(removeSandboxes), Number(idle), Date.now() - MACHINE_EXPIRY_MS);
		if (!row) {
			// A previous removal may have committed just before its index notification failed.
			if (!idle) {
				const tombstone = await record(c);
				if (tombstone?.removed_at != null) await publish(c, tombstone);
			}
			return;
		}
		const live = c.vars.live;
		c.vars.live = null;
		if (live) reject(live.ws, refuse("removed", { removeSandboxes }));
		await publish(c, row);
	});
}

export const machine = actor({
	db: db({ onMigrate: async db => {
		await db.execute(`CREATE TABLE IF NOT EXISTS machine (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
			public_key TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER, removed_at INTEGER, remove_sandboxes INTEGER NOT NULL DEFAULT 0, offset INTEGER NOT NULL DEFAULT 0, duplicate INTEGER, report TEXT)`);
		await db.execute("CREATE TABLE IF NOT EXISTS pending (sandbox TEXT PRIMARY KEY)");
	} }),
	createVars: (): Vars => ({ live: null, work: Promise.resolve(), greeting: null }),
	onCreate: async (c, input?: Input) => {
		if (!input || c.key.length !== 2 || !MACHINE_ID.test(c.key[1]!) || !grantIsValid(input.grant, c.key, "machine") || Date.now() >= input.expires) { c.destroy(); return; }
		const now = Date.now();
		await c.schedule.at(now + MACHINE_EXPIRY_MS, "expire");
		await c.db.execute("INSERT INTO machine (id, name, version, public_key, created) VALUES (1, ?, ?, ?, ?)", input.details.name, input.details.runnerVersion, input.publicKey, now);
		// Only the account's still-valid reservation can make this key usable.
		if (!await user(c).internalMachineCreated(c.key[1])) {
			await c.db.execute("DELETE FROM machine");
			c.destroy();
		}
	},
	onWake: async c => {
		const row = await record(c);
		if (row && (row.seen !== null || row.removed_at !== null)) {
			await publish(c, row);
		}
	},
	onSleep: async c => {
		await ordered(c, async () => {
			if (c.vars.live) await disconnected(c, c.vars.live.ws);
		});
	},
	onBeforeConnect: (c, params) => {
		assertOrigin(c);
		if (!controlPath(c.request)) requireServiceFor({ key: c.key, conn: { params } }, "call");
	},
	onWebSocket: (c, ws) => {
		if (!controlPath(c.request)) { ws.close(1008, "Unknown path"); return; }
		const [uid, id] = c.key;
		const nonce = randomBytes(32).toString("base64url");
		let hello = false;
		let closed = false;
		let queued = 0;
		let heard = Date.now();
		const timer = setInterval(() => {
			if (Date.now() - heard >= CONTROL_DEAD_MS) ws.close(1001, "Runner timed out");
			else if (c.vars.live?.ws === ws) send(ws, { kind: "heartbeat" });
		}, CONTROL_HEARTBEAT_MS);
		// Opening one takes only the uid and the machine's id. Each open socket keeps the actor awake, so
		// one that says nothing goes soon, and at most one waits for its hello at a time; a socket that
		// has said hello is not touched by either.
		c.vars.greeting?.close(1008, "Replaced before its hello");
		c.vars.greeting = ws;
		const silent = setTimeout(() => ws.close(1008, "No hello"), HELLO_WAIT_MS);
		const greeted = () => {
			clearTimeout(silent);
			if (c.vars.greeting === ws) c.vars.greeting = null;
		};
		const fail = (error: unknown) => { machineError("machine control socket", error); ws.close(1011, "Control socket failed"); };
		ws.addEventListener("close", () => {
			clearInterval(timer);
			greeted();
			closed = true;
			return ordered(c, () => disconnected(c, ws)).catch(error => machineError("machine disconnect", error));
		});
		ws.addEventListener("message", ({ data }) => {
			if (closed) return;
			greeted();
			const frame = parseRunnerFrame(data);
			if (!frame || ++queued > 128 || (!hello && frame.kind !== "hello") || (hello && frame.kind === "hello")) {
				closed = true;
				reject(ws, refuse("bad-frame")); return;
			}
			hello = true;
			const now = Date.now();
			return ordered(c, async () => {
				if (closed) return;
				if (frame.kind === "hello") {
					const r = await record(c);
					if (!r || !signed(r.public_key, controlProof(uid!, id!, nonce), frame.signature)) { reject(ws, refuse("unknown")); return; }
					if (r.removed_at !== null) { reject(ws, refuse("removed", { removeSandboxes: !!r.remove_sandboxes })); return; }
					if (!versionAtLeast(frame.runnerVersion, MIN_RUNNER_VERSION)) {
						const [changed] = await c.db.execute<Row>("UPDATE machine SET version = ? WHERE removed_at IS NULL RETURNING *", frame.runnerVersion);
						reject(ws, refuse("outdated", frame));
						await tell(c, changed);
						return;
					}
					const old = c.vars.live;
					if (secondHello(old, frame, now) === "refuse") {
						const [changed] = await c.db.execute<Row>("UPDATE machine SET duplicate = ? WHERE removed_at IS NULL RETURNING *", now);
						reject(ws, refuse("key-in-use"));
						await tell(c, changed);
						return;
					}
					const [changed] = await c.db.execute<Row>("UPDATE machine SET seen = ?, version = ?, offset = ? WHERE removed_at IS NULL RETURNING *", now, frame.runnerVersion, frame.time - now);
					if (!changed || closed) return;
					c.vars.live = { ws, epoch: frame.epoch, heardAt: now, connected: now, savedAt: now };
					old?.ws.close(1001, "Reconnected");
					send(ws, { kind: "welcome", idleSuspendMs: config.idleSuspendMs });
					for (const { sandbox } of await c.db.execute<{ sandbox: string }>("SELECT sandbox FROM pending")) send(ws, { kind: "remove", sandbox });
					await tell(c, changed);
				} else {
					const live = c.vars.live;
					if (live?.ws !== ws) return;
					live.heardAt = now;
					if (now - live.savedAt >= SEEN_INTERVAL) {
						await c.db.execute("UPDATE machine SET seen = ? WHERE removed_at IS NULL", now);
						live.savedAt = now;
					}
					if (frame.kind === "removed") await c.db.execute("DELETE FROM pending WHERE sandbox = ?", frame.sandbox);
					if (frame.kind === "report") {
						const r = await record(c);
						const report: Report = { ...frame, sandboxes: frame.sandboxes.map(s => ({ ...s, usedAt: Math.max(0, s.usedAt - r.offset) })) };
						if (!r.report || !isDeepStrictEqual(JSON.parse(r.report), report)) {
							const [changed] = await c.db.execute<Row>("UPDATE machine SET report = ? WHERE removed_at IS NULL RETURNING *", JSON.stringify(report));
							await tell(c, changed);
						}
					}
				}
				heard = now;
			}).catch(fail).finally(() => { queued--; });
		});
		send(ws, { kind: "challenge", nonce });
	},
	actions: {
		internalFacts: async (c): Promise<MachineFacts> => {
			requireServiceFor(c, "call");
			const r = await record(c);
			// No row: the actor was made without a valid reservation and is going away. To a session, and to a confirmation, that is a machine removed.
			if (!r) return { name: "", status: "removed", publicKey: "", report: null };
			const facts = update(c, r);
			return { name: r.name, status: r.removed_at !== null ? "removed" : facts.status, publicKey: r.public_key, report: facts.report };
		},
		internalConnection: async (c, proof: string, signature: string): Promise<"unknown" | "active" | { removeSandboxes: boolean }> => {
			requireServiceFor(c, "call");
			const r = await record(c);
			if (!r || !signed(r.public_key, proof, signature)) return "unknown";
			return r.removed_at === null ? "active" : { removeSandboxes: !!r.remove_sandboxes };
		},
		internalAttach: async (c, input: { sessionId: string; ticket: string }): Promise<Attachment> => {
			requireServiceFor(c, "call");
			return ordered(c, async (): Promise<Attachment> => {
				const r = await record(c);
				if (!r) return { ok: false, reason: "unknown" };
				if (r.removed_at !== null) return { ok: false, reason: "removed" };
				const live = c.vars.live;
				// The session had the key from `internalFacts` before it made the ticket: the runner's hello can come before this answer.
				if (!live || !send(live.ws, { kind: "attach", sessionId: input.sessionId, ticket: input.ticket })) return { ok: false, reason: "offline" };
				return { ok: true };
			});
		},
		internalRemoveSandbox: async (c, { sandboxId }: { sandboxId: string }): Promise<void> => {
			requireServiceFor(c, "call");
			await ordered(c, async () => {
				await c.db.execute("INSERT OR IGNORE INTO pending SELECT ? WHERE EXISTS (SELECT 1 FROM machine WHERE removed_at IS NULL)", sandboxId);
				if (c.vars.live) send(c.vars.live.ws, { kind: "remove", sandbox: sandboxId });
			});
		},
		internalLogout: async c => {
			requireServiceFor(c, "call");
			await ordered(c, async () => {
				if (c.vars.live) send(c.vars.live.ws, { kind: "logout" });
			});
		},
		internalRevoke: async (c, removeSandboxes: boolean) => {
			requireServiceFor(c, "call");
			await revoke(c, removeSandboxes, false);
		},
		expire: async c => {
			if (!c.scheduledFire) throw new UserError("Only the expiry schedule can remove an idle machine.", { code: "forbidden" });
			await revoke(c, false, true);
			const r = await record(c);
			if (r.removed_at === null) await c.schedule.at((r.seen ?? r.created) + MACHINE_EXPIRY_MS, "expire");
		},
	},
});
