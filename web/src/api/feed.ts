/**
 * How a run of `windlass --json` becomes what a session's clients receive, as contract.ts describes
 * it: durable events and three of the ephemeral ones are stored (timeline items); the four streaming
 * ones are broadcast and never stored (live deltas). Pure functions, shared by the mock and the tests.
 */
import { VerificationLog } from "../../../server/src/verified";
import type { LiveDelta, TimelineItem, TurnUsage, WindlassEvent } from "@contract";

/** Streaming output: broadcast, never stored. */
export const LIVE_TYPES: ReadonlySet<string> = new Set(["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"]);

export function isLive(event: WindlassEvent): boolean {
	return LIVE_TYPES.has(event.type);
}

/** A durable event has a place in Windlass's log; the stored ephemeral ones do not. */
export function isDurable(event: WindlassEvent): boolean {
	return typeof event.seq === "number";
}

/** Splits a recording into runs: each ends with its `cli.summary`. */
export function splitRuns(events: WindlassEvent[]): WindlassEvent[][] {
	const runs: WindlassEvent[][] = [];
	let current: WindlassEvent[] = [];
	for (const event of events) {
		current.push(event);
		if (event.type === "cli.summary") {
			runs.push(current);
			current = [];
		}
	}
	if (current.length > 0) runs.push(current);
	return runs;
}

/**
 * When each event of a run happens, in milliseconds from the run's start. Durable events carry a
 * time; the ephemeral ones between two of them are spread evenly over the interval. Minimum gaps
 * keep a recording made at full speed watchable.
 */
export function schedule(events: WindlassEvent[], minimum: { live: number; stored: number } = { live: 24, stored: 60 }): number[] {
	const times = events.map((event) => (typeof event.time === "number" ? event.time : null));
	const first = times.find((time) => time !== null) ?? 0;
	const raw: number[] = [];
	for (let index = 0; index < events.length; index++) {
		const own = times[index];
		if (own !== null && own !== undefined) {
			raw.push(own - first);
			continue;
		}
		let before = index - 1;
		while (before >= 0 && times[before] === null) before--;
		let after = index + 1;
		while (after < events.length && times[after] === null) after++;
		const from = before >= 0 ? (times[before] ?? first) - first : 0;
		const position = index - before;
		if (after >= events.length) raw.push(from + 40 * position);
		else raw.push(from + (((times[after] ?? first) - first - from) * position) / (after - before));
	}
	const offsets: number[] = [];
	let last = 0;
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (!event) continue;
		const gap = index === 0 ? 0 : Math.max((raw[index] ?? 0) - (raw[index - 1] ?? 0), isLive(event) ? minimum.live : minimum.stored);
		last += gap;
		offsets.push(Math.round(last));
	}
	return offsets;
}

/**
 * A run recorded over ACP has no `cli.summary` (the command line prints it, not the engine). This
 * adds one, made from the run's own events, so the run ends as a turn like any other.
 */
export function withSummary(events: WindlassEvent[]): WindlassEvent[] {
	if (events.some((event) => event.type === "cli.summary")) return events;
	let usage: TurnUsage | null = null;
	let steps = 0;
	let outcome = "succeeded";
	let executionId: unknown = null;
	for (const event of events) {
		const data = (event.data ?? {}) as Record<string, unknown>;
		if (event.type === "execution.started") executionId = data.executionId;
		if (event.type === "step.started") steps += 1;
		if ((event.type === "step.ended" || event.type === "step.failed") && typeof data.usage === "object" && data.usage !== null) {
			const add = data.usage as TurnUsage;
			usage = usage
				? { inputTokens: usage.inputTokens + add.inputTokens, cachedInputTokens: usage.cachedInputTokens + add.cachedInputTokens, outputTokens: usage.outputTokens + add.outputTokens, reasoningTokens: usage.reasoningTokens + add.reasoningTokens }
				: { ...add };
		}
		if (event.type === "execution.failed") outcome = "failed";
		if (event.type === "execution.interrupted") outcome = "interrupted";
	}
	const times = events.map((event) => event.time).filter((time): time is number => typeof time === "number");
	const durationMs = times.length > 1 ? (times.at(-1) as number) - (times[0] as number) : 0;
	const cachedShare = usage && usage.inputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 1000) / 1000 : null;
	const sessionId = events.find((event) => typeof event.sessionId === "string")?.sessionId;
	return [...events, { type: "cli.summary", sessionId, executionId, outcome, steps, summaryCalls: 0, requests: steps, durationMs, usage, cachedShare }];
}

export type FeedEntry = { item: TimelineItem } | { delta: LiveDelta };

/**
 * One run as a session's clients would receive it: the user's prompt, every stored event as a
 * timeline item, every streaming event as a delta, and the platform's `turn.ended` built from the
 * run's `cli.summary`. `seq` continues from `afterSeq`.
 */
export function runToFeed(events: WindlassEvent[], options: { turn: number; afterSeq?: number; at?: number; model?: string } = { turn: 1 }): FeedEntry[] {
	const feed: FeedEntry[] = [];
	let seq = options.afterSeq ?? 0;
	const at = options.at ?? 0;
	const offsets = schedule(events);
	const prompt = events.find((event) => event.type === "inbox.enqueued");
	feed.push({ item: { seq: ++seq, at, turn: options.turn, kind: "user", text: promptText(prompt), model: options.model ?? "gpt-test", effort: null } });
	events.forEach((event, index) => {
		if (isLive(event)) feed.push({ delta: { turn: options.turn, event } });
		else feed.push({ item: { seq: ++seq, at: at + (offsets[index] ?? 0), turn: options.turn, kind: "windlass", event } });
	});
	const summary = events.find((event) => event.type === "cli.summary");
	if (summary) {
		const log = new VerificationLog();
		for (const event of events) log.note(event);
		feed.push({ item: { ...turnEnded(summary, { seq: ++seq, at: at + (offsets.at(-1) ?? 0), turn: options.turn }), verified: log.verified(options.turn, [], { project: null }, null) } });
	}
	return feed;
}

export function promptText(enqueued: WindlassEvent | undefined): string {
	const content = enqueued?.data?.content;
	if (!Array.isArray(content)) return "";
	return content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "")).join("");
}

const OUTCOMES = ["succeeded", "unresolved", "failed", "stopped", "interrupted"] as const;

/** The platform's `turn.ended` for a run that printed `cli.summary`. */
export function turnEnded(summary: WindlassEvent, position: { seq: number; at: number; turn: number }): Omit<Extract<TimelineItem, { kind: "turn.ended" }>, "verified"> {
	const outcome = OUTCOMES.find((candidate) => candidate === summary.outcome) ?? "failed";
	const usage = typeof summary.usage === "object" && summary.usage !== null ? (summary.usage as TurnUsage) : null;
	return {
		...position,
		kind: "turn.ended",
		outcome,
		exitCode: outcome === "succeeded" || outcome === "unresolved" ? 0 : outcome === "interrupted" ? 130 : 1,
		steps: typeof summary.steps === "number" ? summary.steps : null,
		durationMs: typeof summary.durationMs === "number" ? summary.durationMs : 0,
		usage,
		cachedShare: typeof summary.cachedShare === "number" ? summary.cachedShare : null,
		message: null,
	};
}
