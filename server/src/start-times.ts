/**
 * How long each part of a turn's start took (contract.ts `StartTimes`, docs/architecture.md, "Start times"). The session
 * makes a `StartClock` when the turn starts, after any wait for a slot; the sandbox code tells it when the
 * sandbox was ready and when the workspace was, and the harness tells it the points of its own start
 * (`RunTurnInput.onStartMark`). At the agent's first output, or at the turn's end when there was none,
 * the clock hands the record to `done` once.
 *
 * Nothing in a record is a secret: durations, the harness, the place and the turn's number.
 */

import type { HarnessId, StartTimes } from "./contract.js";
import type { RunnerStartTimes, StartMark } from "./sandbox/api.js";

/** How many turns' start times a session keeps and shows. */
export const START_TIMES_KEPT = 5;

export class StartClock {
	private readonly began: number;
	private readyAt: number | null = null;
	private openedAt: number | null = null;
	private readonly at: Partial<Record<StartMark, number>> = {};
	private relayMs: number | null = null;
	private sandboxMs: number | null = null;
	private setupMs: number | null = null;
	private isNew = false;
	private runner: RunnerStartTimes | null = null;
	private finished = false;

	constructor(
		private readonly turn: number,
		private readonly harness: HarnessId,
		private readonly place: StartTimes["place"],
		private readonly waited: number | null,
		private readonly done: (times: StartTimes) => void,
		private readonly now: () => number = Date.now,
	) {
		this.began = now();
	}

	/** The sandbox is ready: made and started (`isNew`), or an existing one connected or resumed, in `ms`. */
	sandbox(ms: number, isNew: boolean, runner?: RunnerStartTimes): void {
		this.sandboxMs = ms;
		this.isNew = isNew;
		this.runner = runner ?? null;
		this.readyAt = this.now();
	}

	/** The workspace is ready (clone, setup command, restores): the sandbox code is done. */
	opened(): void {
		this.openedAt = this.now();
		if (this.readyAt !== null) this.setupMs = this.openedAt - this.readyAt;
	}

	/** A point of the harness's start. The first output ends the start. */
	mark(point: StartMark, ms?: number): void {
		if (this.finished) return;
		if (point === "relay") {
			if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) this.relayMs = Math.round(ms);
			return;
		}
		this.at[point] ??= this.now();
		if (point === "output") this.finish();
	}

	/** Hands the record over, once: at the first output, or at the turn's end if the agent's process was started. */
	finish(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.at.process === undefined && this.sandboxMs === null) return;
		try {
			this.done(this.record());
		} catch {
			// What becomes of the record must not stop the turn.
		}
	}

	record(): StartTimes {
		const span = (from: number | null | undefined, to: number | null | undefined) => (from == null || to == null ? undefined : Math.max(0, to - from));
		const { process, initialized, prompted, output } = this.at;
		const times: StartTimes = { turn: this.turn, at: this.began, harness: this.harness, place: this.place, newSandbox: this.isNew };
		const put = <K extends keyof StartTimes>(key: K, value: StartTimes[K] | undefined | null) => {
			if (value !== undefined && value !== null) times[key] = value;
		};
		put("waited", this.waited !== null && this.waited >= 1000 ? this.waited : undefined);
		if (this.runner && this.isNew) {
			put("image", this.runner.image);
			if (this.runner.pulled) times.pulled = true;
			put("runnerCreate", this.runner.create);
		}
		put("sandbox", this.sandboxMs);
		put("setup", this.isNew || (this.setupMs ?? 0) >= 1000 ? this.setupMs : undefined);
		put("prepare", span(this.openedAt, process));
		put("relay", this.relayMs);
		put("agent", span(process, initialized));
		put("session", span(initialized, prompted));
		put("firstOutput", span(prompted, output));
		put("total", span(this.began, output));
		return times;
	}
}

/** The session's records with one more, at most START_TIMES_KEPT, oldest first. */
export function keepStartTimes(kept: readonly StartTimes[] | undefined, times: StartTimes): StartTimes[] {
	return [...(kept ?? []), times].slice(-START_TIMES_KEPT);
}

/** One log line, `[wlp] session.start_times …`, with every duration in ms. No secrets: durations, ids and names. */
export function startTimesLog(sessionId: string, times: StartTimes): string {
	const fields: (keyof StartTimes)[] = ["waited", "image", "sandbox", "runnerCreate", "setup", "prepare", "relay", "agent", "session", "firstOutput", "total"];
	const ms = fields.filter((key) => typeof times[key] === "number").map((key) => `${key}_ms=${times[key]}`);
	return `[wlp] session.start_times session=${sessionId} turn=${times.turn} harness=${times.harness} place=${times.place} new=${times.newSandbox}${times.pulled ? " pulled=true" : ""} ${ms.join(" ")}`.trimEnd();
}
