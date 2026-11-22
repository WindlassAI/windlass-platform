// cd server && npx tsx ../scripts/untrusted-check.ts
/**
 * Text from someone else, from the inbox row to the frame Windlass reads (factory/untrusted.ts). No
 * Docker: the turn code runs against a stand-in engine in this process, which answers `initialize` as
 * Windlass 0.6.0 does (`promptMeta` lists `windlass/untrusted`) or as an older one does (it lists
 * nothing), and records every frame it is sent.
 *
 *   - a marked turn's `session/prompt` carries `_meta["windlass/untrusted"].source`, with its step limit;
 *   - an older engine gets no marker, and the session is told once (`onUntrustedUnmarked`);
 *   - a turn without sources has no marker on either;
 *   - sources over 200 characters are cut, never refused;
 *   - the inbox keeps the sources of a delivery and whether the person chose to run someone else's text
 *     anyway, and a row stored before them reads as none and not.
 */
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RunTurnInput, SandboxHandle } from "../server/src/sandbox/api.js";
import { markTurnSandbox, type ProcessEnd, type SandboxProcess } from "../server/src/sandbox/provider.js";

const { SandboxWindlass } = await import("../server/src/sandbox/turn.js");
const { UNTRUSTED_SOURCE_MAX } = await import("../server/src/factory/untrusted.js");
const { deliveryOf, receive, inboxRow, INBOX_TABLES } = await import("../server/src/actors/session-inbox.js");

let passes = 0;
function expect(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
	if (!ok) process.exitCode = 1;
	else passes += 1;
}

type Frame = { jsonrpc?: string; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };

/** A sandbox whose one program is a stand-in engine: it answers what the turn asks, and keeps every frame. */
function standIn(promptMeta: string[] | null) {
	const frames: Frame[] = [];
	const sandbox = {
		id: "sbx_untrusted",
		cwd: "/workspace",
		uid: "u_check",
		approval: "auto" as const,
		start(_argv: string[], options: { onStdout?: (chunk: string) => void } = {}): SandboxProcess {
			let finish: (end: ProcessEnd) => void = () => {};
			const ended = new Promise<ProcessEnd>((resolve) => (finish = resolve));
			const emit = (frame: Frame) => queueMicrotask(() => options.onStdout?.(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`));
			const process: SandboxProcess & { hasEnded: boolean } = {
				tag: "wlp-untrusted-check",
				ended,
				hasEnded: false,
				write(line: string) {
					for (const text of line.split("\n").filter(Boolean)) {
						const frame = JSON.parse(text) as Frame;
						frames.push(frame);
						if (frame.id === undefined || frame.method === undefined) continue;
						const windlass = { notifications: ["_windlass/event"], openMeta: ["hostTools"], ...(promptMeta === null ? {} : { promptMeta }) };
						if (frame.method === "initialize") emit({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { windlass } } } });
						else if (frame.method === "session/new") emit({ id: frame.id, result: { sessionId: "ses_untrustedcheck" } });
						else if (frame.method === "session/prompt") emit({ id: frame.id, result: { stopReason: "end_turn", _meta: { windlass: { outcome: "succeeded", executionId: "exe_1" } } } });
						else emit({ id: frame.id, result: {} });
					}
					return true;
				},
				closeStdin() {
					process.hasEnded = true;
					finish({ code: 0, signal: null, error: null });
				},
				async signal() {},
				killClient() {
					process.hasEnded = true;
					finish({ code: null, signal: "SIGKILL", error: null });
				},
			};
			return process;
		},
		async ask() { return null; },
		async stopLeftovers() { return 0; },
		async sweep() { return 0; },
		async writeTextFile() {},
		async writeSecretFile() {},
		async removeFiles() {},
		async holdForTurn() { return async () => {}; },
		async run() { return { exitCode: 0, stdout: "", stderr: "", aborted: false, timedOut: false }; },
	};
	markTurnSandbox(sandbox);
	return { handle: sandbox as unknown as SandboxHandle, frames };
}

const tokens = { current: async () => { throw new Error("a scripted turn takes no token"); } } as never;
const host = { version: async () => "0.6.0", problem: async () => null };
const script = { responses: [[{ type: "text", text: "Done." }, { type: "finish", reason: "stop" }]] } as RunTurnInput["script"];

async function turn(promptMeta: string[] | null, input: Partial<RunTurnInput>) {
	const { handle, frames } = standIn(promptMeta);
	let told = 0;
	const result = await new SandboxWindlass(tokens, host).runTurn(handle, { prompt: "Fix the build.", script, maxSteps: 60, onUntrustedUnmarked: () => { told += 1; }, ...input });
	const prompt = frames.find((frame) => frame.method === "session/prompt");
	return { result, told, meta: prompt?.params?._meta as Record<string, unknown> | undefined };
}

const MARKER = "windlass/untrusted";
const CURRENT = ["windlass/maxSteps", MARKER];

{
	const marked = await turn(CURRENT, { untrusted: ["CI logs of 1111111", "issue #42 by @someone"] });
	expect("0.6.0: the prompt carries the sources as one, with its step limit", JSON.stringify(marked.meta) === JSON.stringify({ "windlass/maxSteps": 60, [MARKER]: { source: "CI logs of 1111111; issue #42 by @someone" } }), JSON.stringify(marked.meta));
	expect("0.6.0: the session is not told the marker was missing", marked.told === 0 && marked.result.failure === null, `${marked.told} ${JSON.stringify(marked.result.failure)}`);

	const plain = await turn(CURRENT, { untrusted: [] });
	expect("0.6.0: a turn without sources has no marker", plain.meta !== undefined && !(MARKER in plain.meta) && plain.told === 0, JSON.stringify(plain.meta));

	const older = await turn(null, { untrusted: ["CI logs of 1111111"] });
	expect("an engine that does not list the marker gets none, and the session is told once", older.meta !== undefined && !(MARKER in older.meta) && older.meta["windlass/maxSteps"] === 60 && older.told === 1, `${JSON.stringify(older.meta)}, told ${older.told}`);

	const olderPlain = await turn(null, {});
	expect("and nothing is said for a turn without sources", olderPlain.told === 0);

	const long = Array.from({ length: 10 }, (_, i) => `GitHub feedback from @a-writer-whose-name-is-long-${i}`);
	const cut = await turn(CURRENT, { untrusted: long });
	const source = (cut.meta?.[MARKER] as { source?: string } | undefined)?.source ?? "";
	expect("sources over 200 characters are cut, not refused", source.length === UNTRUSTED_SOURCE_MAX && source.endsWith("…") && source.startsWith(long[0]!) && cut.result.failure === null, `${source.length} characters`);
}

{
	// The inbox, in the session's SQLite: a delivery's sources are kept with its row, and read back as they were given.
	const sqlite = new DatabaseSync(":memory:");
	const db = { execute: async <T>(sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...(args as SQLInputValue[])) as T[] } as never;
	for (const table of INBOX_TABLES) await (db as { execute(sql: string): Promise<unknown> }).execute(table);
	const given = deliveryOf({ key: "i_1:1:1:1", itemId: "i_1", title: "Fix", text: "Fix the build.", agent: null, maxSteps: 60, fetchBase: null, startsRun: true, untrusted: ["CI logs of 1111111", 7, "CI logs of 1111111", "x".repeat(300)] });
	expect("a delivery's sources are strings, each once, each cut to Windlass's limit", given !== null && given.untrusted?.length === 2 && given.untrusted[0] === "CI logs of 1111111" && given.untrusted[1]!.length === UNTRUSTED_SOURCE_MAX, JSON.stringify(given?.untrusted?.map((s) => s.length)));
	await receive(db, given!, 1);
	const row = await inboxRow(db, "i_1:1:1:1");
	expect("the inbox row keeps them", JSON.stringify(row?.untrusted) === JSON.stringify(given!.untrusted));
	const none = deliveryOf({ key: "i_1:1:2:1", itemId: "i_1", title: "Fix", text: "Continue.", agent: null, maxSteps: 60, fetchBase: null, startsRun: false });
	await receive(db, none!, 2);
	expect("a delivery without sources has none", JSON.stringify((await inboxRow(db, "i_1:1:2:1"))?.untrusted) === "[]");
	expect("a delivery that does not say the person let it through is not", (await inboxRow(db, "i_1:1:1:1"))?.unsandboxed === false);
	const anyway = deliveryOf({ key: "i_1:1:3:1", itemId: "i_1", title: "Fix", text: "The issue.", agent: null, maxSteps: 60, fetchBase: null, startsRun: false, untrusted: ["issue #42 by @someone"], unsandboxed: true });
	await receive(db, anyway!, 3);
	const kept = await inboxRow(db, "i_1:1:3:1");
	expect("the inbox keeps that the person chose to run someone else's text anyway", kept?.unsandboxed === true && JSON.stringify(kept.untrusted) === JSON.stringify(["issue #42 by @someone"]));
	expect("only true is a yes", deliveryOf({ key: "k", itemId: "i_1", title: "Fix", text: "x", agent: null, maxSteps: 60, fetchBase: null, startsRun: false, unsandboxed: "yes" })?.unsandboxed === false);
	sqlite.exec("INSERT INTO inbox (key, item, title, text, agent, max_steps, fetch_base, checkout, asks_left, starts_run, state, turn, slot, ended, at) VALUES ('old', 'i_1', 'Fix', 'Old.', NULL, 60, NULL, NULL, NULL, 0, 'waiting', NULL, NULL, NULL, 0)");
	expect("a row stored before the columns reads as none, and not let through", JSON.stringify((await inboxRow(db, "old"))?.untrusted) === "[]" && (await inboxRow(db, "old"))?.unsandboxed === false);
}

assert.ok(passes > 0);
console.log(`\n${passes} passed${process.exitCode ? ", some failed" : ""}`);
