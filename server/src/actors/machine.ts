import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, requireServiceFor, serviceParams } from "../auth.js";
import { config } from "../config.js";
import { MACHINE_EXPIRY_MS, type MachineClaim, type MachineStatus, type MachineWarning } from "../contract.js";
import { MINUTE_MS } from "../http-limits.js";
import { machineError, signed } from "../runner-keys.js";
import { CLOCK_TOLERANCE_MS, CONTROL_DEAD_MS, CONTROL_HEARTBEAT_MS, MACHINE_ID, MIN_RUNNER_VERSION, REFUSED_RETRY_MS, controlProof, parseRunnerFrame, refuse, secondHello, versionAtLeast, type Refusal, type Report, type ServerFrame } from "../runner/control.js";
import { loginCommand, type LoginCommand, type LoginResult } from "../runner/protocol.js";
import { grantIsValid } from "./internal.js";

const SEEN_INTERVAL = 3 * 60_000;
// A refused copy has no open socket. Give it time to retry before retiring the warning.
const KEY_WARNING_MS = REFUSED_RETRY_MS + CONTROL_DEAD_MS;
/**
 * How long a control socket may stay open without a hello. The runner sends it as soon as the challenge
 * arrives; a socket that never does would otherwise keep the actor awake until CONTROL_DEAD_MS.
 */
const HELLO_WAIT_MS = 10_000;
const offline = () => new UserError("The machine disconnected during sign-in. Start again when it is online.", { code: "machine_not_connected" });
interface Socket { login(command: LoginCommand): Promise<LoginResult>; send(frame: ServerFrame): boolean; close(code: number, reason: string): void }
interface Live { offset: number; offersClaude?: boolean; claudeLogin?: boolean; ws: Socket; epoch: string; heardAt: number; connected: number; savedAt: number }
/** `greeting` is the one control socket that has yet to say hello: a newer one replaces it. */
interface Vars { live: Live | null; work: Promise<void>; greeting: Socket | null }
interface Ctx {
	db: RawAccess; vars: Vars; key: string[];
	schedule: { at(timestamp: number, action: string): Promise<string>; list(): Promise<Array<{ action: string; runAt: number }>> };
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
function reject(ws: Socket, frame: Refusal) {
	ws.send(frame);
	ws.close(1008, frame.reason);
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
	if (row.duplicate !== null && Date.now() < row.duplicate + KEY_WARNING_MS) warnings.push({ kind: "key", at: row.duplicate });
	return { status: c.vars.live ? "online" : row.seen === null ? "waiting" : "offline", since: c.vars.live?.connected ?? row.seen ?? row.created, runnerVersion: row.version, warnings, report };
}
async function publish(c: Ctx, row: Row) {
	const facts = row.removed_at === null ? update(c, row) : null;
	const conflict = facts?.warnings.find(w => w.kind === "key");
	if (conflict) {
		// An earlier alarm rereads the last refusal. One alarm also covers repeated attempts and actor sleeps.
		const alarms = await c.schedule.list();
		if (!alarms.some(alarm => alarm.action === "expireKeyWarning" && alarm.runAt > Date.now())) {
			await c.schedule.at(conflict.at + KEY_WARNING_MS, "expireKeyWarning");
		}
	}
	await user(c).internalMachineChanged(c.key[1], facts);
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
		await db.execute("CREATE TABLE IF NOT EXISTS connection_budget (id INTEGER PRIMARY KEY, minute INTEGER NOT NULL, used INTEGER NOT NULL)");
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
			c.vars.greeting?.close(1001, "Machine actor sleeping");
			c.vars.live?.ws.close(1001, "Machine actor sleeping");
		});
		await c.vars.work;
	},
	onBeforeConnect: (c, params) => {
		assertOrigin(c);
		if (!controlPath(c.request)) requireServiceFor({ key: c.key, conn: { params } }, "call");
	},
	onWebSocket: (c, raw) => {
		if (!controlPath(c.request)) { raw.close(1008, "Unknown path"); return; }
		const [uid, id] = c.key;
		const nonce = randomBytes(32).toString("base64url");
		const loginReplies = new Map<string, (result: LoginResult | null) => void>();
		let hello = false;
		let closed = false;
		let queued = 0;
		// The raw socket need not deliver a close event when the actor initiates the close.
		const gone = () => {
			if (closed) return;
			closed = true;
			for (const reply of loginReplies.values()) reply(null);
			clearTimeout(deadline);
			clearInterval(heartbeat);
			if (c.vars.greeting === ws) c.vars.greeting = null;
			if (c.vars.live?.ws === ws) return ordered(c, () => disconnected(c, ws)).catch(error => machineError("machine disconnect", error));
		};
		const ws: Socket = {
			login(command) {
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => done(null), 45_000);
					function done(result: LoginResult | null) {
						loginReplies.delete(command.requestId);
						clearTimeout(timer);
						if (result) resolve(result); else reject(offline());
					}
					loginReplies.set(command.requestId, done);
					if (!ws.send(command)) done(null);
				});
			},
			send(frame) {
				if (!closed && raw.readyState === raw.OPEN) {
					try { raw.send(JSON.stringify(frame)); return true; }
					catch (error) { machineError("send control frame", error); }
				}
				ws.close(1011, "Control socket failed");
				return false;
			},
			close(code, reason) {
				if (closed) return;
				void gone();
				if (raw.readyState === raw.OPEN) raw.close(code, reason);
			},
		};
		// 1001, not 1008: the runner reads 1008 as a refusal, ends its sessions' conversations and waits ten minutes,
		// and a hello held up on a stalled link (or a socket replaced before its hello) is no refusal.
		let deadline = setTimeout(() => ws.close(1001, "No hello"), HELLO_WAIT_MS);
		const heartbeat = setInterval(() => {
			if (c.vars.live?.ws === ws) ws.send({ kind: "heartbeat" });
		}, CONTROL_HEARTBEAT_MS);
		c.vars.greeting?.close(1001, "Replaced before its hello");
		c.vars.greeting = ws;
		const fail = (error: unknown) => { machineError("machine control socket", error); ws.close(1011, "Control socket failed"); };
		raw.addEventListener("close", gone);
		raw.addEventListener("message", ({ data }) => {
			if (closed) return;
			const frame = parseRunnerFrame(data);
			if (!frame || ++queued > 128 || (!hello && frame.kind !== "hello") || (hello && frame.kind === "hello")) {
				reject(ws, refuse("bad-frame")); return;
			}
			if (!hello) {
				hello = true;
				if (c.vars.greeting === ws) c.vars.greeting = null;
				clearTimeout(deadline);
				deadline = setTimeout(() => ws.close(1001, "Runner timed out"), CONTROL_DEAD_MS);
			} else {
				deadline.refresh();
			}
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
					c.vars.live = { ws, offset: frame.time - now, epoch: frame.epoch, heardAt: now, connected: now, savedAt: now };
					old?.ws.close(1001, "Reconnected");
					ws.send({ kind: "welcome", idleSuspendMs: config.idleSuspendMs });
					for (const { sandbox } of await c.db.execute<{ sandbox: string }>("SELECT sandbox FROM pending")) ws.send({ kind: "remove", sandbox });
					await tell(c, changed);
				} else {
					const live = c.vars.live;
					if (live?.ws !== ws) return;
					live.heardAt = now;
					if (now - live.savedAt >= SEEN_INTERVAL) {
						await c.db.execute("UPDATE machine SET seen = ? WHERE removed_at IS NULL", now);
						live.savedAt = now;
					}
					if (frame.kind === "harnessLogin.result") loginReplies.get(frame.requestId)?.(frame.result);
					if (frame.kind === "removed") await c.db.execute("DELETE FROM pending WHERE sandbox = ?", frame.sandbox);
					if (frame.kind === "report") {
						live.offersClaude = frame.harnesses?.some(h => h.id === "claude");
						live.claudeLogin = frame.claudeLogin;
						const r = await record(c);
						const report: Report = { ...frame, sandboxes: frame.sandboxes.map(s => ({ ...s, usedAt: Math.max(0, s.usedAt - r.offset) })) };
						if (!r.report || !isDeepStrictEqual(JSON.parse(r.report), report)) {
							const [changed] = await c.db.execute<Row>("UPDATE machine SET report = ? WHERE removed_at IS NULL RETURNING *", JSON.stringify(report));
							await tell(c, changed);
						}
					}
				}
			}).catch(fail).finally(() => { queued--; });
		});
		ws.send({ kind: "challenge", nonce });
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
		internalConnection: async (c, proof: string, signature: string, limitByMachine = false): Promise<"unknown" | "active" | { removeSandboxes: boolean } | { retryAfter: number }> => {
			requireServiceFor(c, "call");
			const r = await record(c);
			if (!r || !signed(r.public_key, proof, signature)) return "unknown";
			if (r.removed_at !== null) return { removeSandboxes: !!r.remove_sandboxes };
			if (limitByMachine) {
				const now = Date.now();
				const minute = Math.floor(now / MINUTE_MS);
				const admitted = await c.db.execute(`INSERT INTO connection_budget VALUES (1, ?, 1)
					ON CONFLICT(id) DO UPDATE SET minute = excluded.minute, used = CASE WHEN minute = excluded.minute THEN used + 1 ELSE 1 END
					WHERE minute != excluded.minute OR used < ? RETURNING id`, minute, config.httpLimits.runnerConnection);
				if (!admitted.length) return { retryAfter: Math.ceil(((minute + 1) * MINUTE_MS - now) / 1000) };
			}
			return "active";
		},
		internalClaudeLogin: async (c, command: LoginCommand): Promise<LoginResult> => {
			requireServiceFor(c, "call");
			if (!loginCommand(command)) throw new UserError("Invalid Claude sign-in request.", { code: "bad_input" });
			const live = c.vars.live;
			if (!live) throw offline();
			if (!live.offersClaude) throw new UserError("This machine does not offer Claude Code.", { code: "claude_unavailable" });
			if (!live.claudeLogin) throw new UserError("Update the runner to sign in to Claude Code from the page.", { code: "runner_outdated" });
			const result = await live.ws.login(command);
			// The page uses platform time. The runner enforces the lifetime on its own clock.
			if ("expiresAt" in result) return { ...result, expiresAt: result.expiresAt - live.offset };
			return result;
		},
		internalAttach: async (c, input: { sessionId: string; ticket: string }): Promise<Attachment> => {
			requireServiceFor(c, "call");
			return ordered(c, async (): Promise<Attachment> => {
				const r = await record(c);
				if (!r) return { ok: false, reason: "unknown" };
				if (r.removed_at !== null) return { ok: false, reason: "removed" };
				const live = c.vars.live;
				// The session had the key from `internalFacts` before it made the ticket: the runner's hello can come before this answer.
				if (!live || !live.ws.send({ kind: "attach", sessionId: input.sessionId, ticket: input.ticket })) return { ok: false, reason: "offline" };
				return { ok: true };
			});
		},
		internalRemoveSandbox: async (c, { sandboxId, sessionId }: { sandboxId: string | null; sessionId?: string }): Promise<void> => {
			requireServiceFor(c, "call");
			await ordered(c, async () => {
				const r = await record(c);
				if (!r || r.removed_at !== null) return;
				const ids = new Set<string>();
				if (sandboxId) ids.add(sandboxId);
				// Only a session deletion includes sessionId. Read its last inventory in order with incoming reports.
				if (sessionId && r.report) {
					const report: Report = JSON.parse(r.report);
					for (const box of report.sandboxes) if (box.sessionId === sessionId) ids.add(box.id);
				}
				if (!ids.size) return;
				await c.db.execute("INSERT OR IGNORE INTO pending SELECT value FROM json_each(?)", JSON.stringify([...ids]));
				for (const sandbox of ids) c.vars.live?.ws.send({ kind: "remove", sandbox });
			});
		},
		internalLogout: async c => {
			requireServiceFor(c, "call");
			await ordered(c, async () => {
				if (c.vars.live) c.vars.live.ws.send({ kind: "logout" });
			});
		},
		internalRevoke: async (c, removeSandboxes: boolean) => {
			requireServiceFor(c, "call");
			await revoke(c, removeSandboxes, false);
		},
		expireKeyWarning: async c => {
			if (!c.scheduledFire) throw new UserError("Only the machine's schedule can expire its key warning.", { code: "forbidden" });
			await ordered(c, async () => {
				const row = await record(c);
				if (row && row.removed_at === null) await publish(c, row);
			});
		},
		expire: async c => {
			if (!c.scheduledFire) throw new UserError("Only the expiry schedule can remove an idle machine.", { code: "forbidden" });
			await revoke(c, false, true);
			const r = await record(c);
			if (r.removed_at === null) await c.schedule.at((r.seen ?? r.created) + MACHINE_EXPIRY_MS, "expire");
		},
	},
});
