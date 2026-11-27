// Pausing a resumable turn, its heartbeat, and the checks that resume it.
import { describeError } from "../../auth.js";
import { config } from "../../config.js";
import type { TurnUsage, ModelKeySpend, TimelineItem, WindlassEvent } from "../../contract.js";
import type { RunTurnResult } from "../../sandbox/api.js";
import { machineActor } from "../../sandbox/runner-layer.js";
import { reportedModelUsage, cutTurnUsage } from "../../usage.js";
import {
	type TurnRun,
	type PauseReason,
	addUsage,
	pausedLine,
	sessionWholeTask,
	crashCount,
	CRASHES_ALLOWED,
} from "../turn-resume.js";
import { rowOfTurn, queueMessage, flushOutbox, itemTurnText } from "../session-inbox.js";
import { note, persist, serial, writeItems } from "./timeline.js";
import type { Ctx, SessionMeta, ActiveTurn } from "./state.js";
import { runnerLink } from "./runner.js";
import { publish } from "./summary.js";
import { itemPrompt } from "./common.js";

/** How often a turn that waits for its machine looks whether it is back, besides the wake the machine itself sends. */
export const MACHINE_RECHECK_MS = 5 * 60_000;
/** The item's check of a started delivery also repairs a long pause, independently of the session's wakes. */
const STALE_PAUSE_MS = 15 * 60_000;
export const stalePause = (paused: NonNullable<TurnRun["paused"]>) => Date.now() - paused.at >= STALE_PAUSE_MS;

/** A long pause on a machine that answers but cannot take the turn back ends it as interrupted. */
export async function staleOnline(c: Ctx, meta: SessionMeta, paused: NonNullable<TurnRun["paused"]>): Promise<boolean> {
	return (
		stalePause(paused) &&
		meta.place.kind === "machine" &&
		(await runnerLink(c, meta.place.machineId).facts()).status === "online"
	);
}

/** Whether this session's turns pause and resume instead of being cut short. */
export function resumesTurns(meta: SessionMeta): boolean {
	return config.turnResume.enabled && !meta.environmentBuild && !meta.readiness;
}

export function newRun(
	meta: SessionMeta,
	turn: number,
	effort: string | null,
	planMode: boolean,
	now: number,
	fromSeq: number,
): TurnRun | null {
	if (!resumesTurns(meta)) return null;
	return {
		turn,
		effort,
		...(planMode && { planMode: true }),
		activeMs: 0,
		segmentAt: now,
		fromSeq,
		usage: null,
		resumes: 0,
		crashes: 0,
	};
}

// Refresh the wake while running. A process crash cannot schedule one from onSleep.
export function heartbeat(c: Ctx, on: boolean): void {
	if (c.vars.heartbeat) clearInterval(c.vars.heartbeat);
	c.vars.heartbeat = null;
	if (!on) return;
	const arm = () => {
		try {
			if (c.vars.stopping) return;
			void c.schedule.at(Date.now() + config.turnResume.heartbeatMs, "internalResumeTurn").catch((error: unknown) =>
				c.log.warn({
					msg: "could not schedule the wake that resumes the turn after a crash",
					error: describeError(error),
				}),
			);
		} catch {
			// The actor is going away: its turn pauses in `onSleep`, or its next wake finds it.
		}
	};
	arm();
	c.vars.heartbeat = setInterval(arm, Math.max(1_000, Math.floor(config.turnResume.heartbeatMs / 2)));
}

/** A turn the server stops from under it pauses instead of ending, unless its person or the platform was already stopping it. */
export function markPausing(c: Ctx, meta: SessionMeta): void {
	const active = c.vars.turn;
	if (
		!active ||
		!resumesTurns(meta) ||
		meta.run?.turn !== active.number ||
		active.stopping ||
		active.closed ||
		c.vars.destroying ||
		active.item?.withdrawn
	)
		return;
	active.pausing ??= "restart";
}

// A pause preserves the turn number and emits no terminal receipt.
export async function pauseTurn(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	reason: PauseReason,
	usage: TurnUsage | null,
	modelKey: ModelKeySpend | undefined,
	result: RunTurnResult | null,
): Promise<void> {
	const run = meta.run!;
	const turn = active.number;
	const now = Date.now();
	heartbeat(c, false);
	run.activeMs += Math.max(0, now - run.segmentAt);
	run.usage = addUsage(run.usage, usage);
	run.paused = { reason, at: now };
	if (result?.windlassSessionId) meta.windlassSessionId = result.windlassSessionId;
	// What the turn wrote to Windlass's session was not copied out of the sandbox: the copy is behind it.
	if (meta.backup) meta.memoryTurn = turn;
	note(c, turn, "info", pausedLine(reason, meta.machineName), { code: "turn_paused", modelKey });
	c.vars.pending = [];
	meta.status = "paused";
	meta.lastUsedAt = now;
	meta.updatedAt = now;
	c.vars.turn = null;
	publish(c);
	console.log(`[wlp] turn.paused session=${meta.sessionId} turn=${turn} reason=${reason} active_ms=${run.activeMs}`);
	if (reason === "machine") await machinePaused(c, meta, run);
	await persist(c);
	if (reason === "restart")
		await c.schedule
			.at(now + config.turnResume.delayMs, "internalResumeTurn")
			.catch((error: unknown) =>
				c.log.warn({ msg: "could not schedule the wake that resumes the turn", error: describeError(error) }),
			);
}

// Return an item's slot while its machine is offline. Its resume requests a new grant.
export async function machinePaused(c: Ctx, meta: SessionMeta, run: TurnRun): Promise<void> {
	const paused = run.paused;
	if (!paused || meta.place.kind !== "machine") return;
	const row = await rowOfTurn(c.db, run.turn);
	if (row && !paused.told) {
		await serial(c, async () => {
			if (meta.run !== run || run.paused !== paused || paused.told) return;
			await c.db.transaction(
				async tx => {
					if (row.slot) {
						await tx.execute("UPDATE inbox SET slot = NULL WHERE key = ? AND state = 'started'", row.key);
						await queueMessage(tx, { to: "user", done: { slot: row.slot, key: row.key } });
					}
					await queueMessage(tx, {
						to: "item",
						itemId: row.itemId,
						fact: { kind: "turn_paused", at: Date.now(), key: row.key, since: paused.at, machine: meta.machineName },
					});
					// A second restart must recover the same ownership as the inbox and outbox.
					await tx.execute(
						"UPDATE meta SET data = ? WHERE id = 1",
						JSON.stringify({ ...meta, run: { ...run, paused: { ...paused, slotFreed: true, told: true } } }),
					);
				},
				{ name: "inbox.paused" },
			);
			paused.slotFreed = true;
			paused.told = true;
		});
		await flushOutbox(c, meta.uid);
		await c.schedule.at(paused.at + config.turnResume.machineAskMs, "internalMachineAsk").catch(() => undefined);
	}
	if (meta.run !== run || run.paused !== paused) return;
	const alreadyOnline = await machineActor(() => c.client(), meta.uid, meta.place.machineId)
		.pausedSession(meta.sessionId, true)
		.catch((error: unknown) =>
			c.log.warn({
				msg: "could not ask the machine to wake this session when it is back",
				error: describeError(error),
			}),
		);
	await armResumeCheck(c, paused, alreadyOnline ? 1_000 : MACHINE_RECHECK_MS);
}

/** A queued slot or a lost reconnect notification must not be the session's last chance to resume. */
export async function armResumeCheck(c: Ctx, paused: NonNullable<TurnRun["paused"]>, delay: number): Promise<void> {
	const now = Date.now();
	const at = now + delay;
	if (paused.lookAt && now < paused.lookAt && paused.lookAt <= at) return;
	await c.schedule.at(at, "internalResumeTurn");
	paused.lookAt = at;
}

/** The original prompt of a personal turn interrupted before its agent received the task. */
export async function originalPrompt(c: Ctx, turn: number): Promise<string> {
	const [first] = await c.db.execute<{ item: string }>(
		"SELECT item FROM timeline WHERE turn = ? AND kind = 'user' ORDER BY seq LIMIT 1",
		turn,
	);
	const item = first ? (JSON.parse(first.item) as TimelineItem) : null;
	return item?.kind === "user" ? item.text : "";
}

// A lost conversation needs the original task, including its untrusted sources.
export async function wholeTask(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	turn: number,
): Promise<{ text: string; untrusted: string[]; unsandboxed?: boolean }> {
	const item = active.item;
	if (item) {
		const chosen = itemTurnText(item.row, item.row.text, null);
		if (chosen.fresh) return chosen;
		return {
			text: `Your earlier conversation of this step is gone, and so is any work that was not saved in the workspace. Check what the workspace holds now, then do the step from the start:\n\n${itemPrompt(item.row)}`,
			untrusted: item.row.untrusted,
			unsandboxed: item.row.unsandboxed,
		};
	}
	return sessionWholeTask(await taskTimeline(c, turn), turn, active.resume?.held ?? []);
}

/** The timeline items up to turn `turn` that a reconstruction of the task reads (turn-resume.ts), the unwritten ones written first. */
export async function taskTimeline(c: Ctx, turn: number): Promise<TimelineItem[]> {
	await serial(c, () => writeItems(c)).catch(() => undefined);
	const rows = await c.db.execute<{ item: string }>(
		"SELECT item FROM timeline WHERE turn <= ? AND (kind IN ('user', 'turn.ended') OR (kind = 'windlass' AND json_extract(item, '$.event.type') IN ('text.ended', 'workspace.changes')) OR (kind = 'acp' AND json_extract(item, '$.update.sessionUpdate') = 'agent_message_chunk')) ORDER BY seq",
		turn,
	);
	return rows.map(row => JSON.parse(row.item) as TimelineItem);
}

// Treat a crashed active turn as interrupted. Keep its recorded progress and cap repeated crash resumes.
export async function crashPause(c: Ctx, meta: SessionMeta): Promise<boolean> {
	const run = meta.run!;
	const turn = run.turn;
	const rows = await c.db.execute<{ kind: string; at: number; item: string }>(
		"SELECT kind, at, item FROM timeline WHERE turn = ? AND seq >= ? ORDER BY seq",
		turn,
		run.fromSeq,
	);
	const events: WindlassEvent[] = [];
	let progressed = false;
	for (const row of rows) {
		if (row.kind === "acp") progressed = true;
		if (row.kind !== "windlass") continue;
		const item = JSON.parse(row.item) as TimelineItem;
		if (item.kind !== "windlass") continue;
		events.push(item.event);
		if (item.event.type === "text.ended" || reportedModelUsage(item.event) !== null) progressed = true;
	}
	const lastAt = rows.length ? rows[rows.length - 1].at : run.segmentAt;
	run.activeMs += Math.max(0, lastAt - run.segmentAt);
	run.usage = addUsage(run.usage, cutTurnUsage(events));
	run.crashes = crashCount(run.crashes, progressed);
	console.log(
		`[wlp] turn.crashed session=${meta.sessionId} turn=${turn} crashes=${run.crashes} progressed=${progressed}`,
	);
	if (run.crashes > CRASHES_ALLOWED) return false;
	run.paused = { reason: "restart", at: Math.max(lastAt, run.segmentAt) };
	if (meta.backup) meta.memoryTurn = turn;
	note(c, turn, "info", "The server stopped while this turn was running; it will resume by itself.", {
		code: "turn_paused",
	});
	meta.status = "paused";
	meta.updatedAt = Math.max(meta.updatedAt, run.paused.at);
	return true;
}
