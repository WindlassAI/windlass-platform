// A production ACP recorder and its SQLite timeline in a disposable actor context.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { LiveDelta, TimelineItem } from "../../server/src/contract.js";
import { acpRecorder } from "../../server/src/actors/agent-session.js";
import { issueUserToken } from "../../server/src/tokens.js";

export function timelineFixture() {
	const sql = new DatabaseSync(":memory:");
	sql.exec("CREATE TABLE timeline (seq INTEGER PRIMARY KEY, turn, kind, at, item); CREATE TABLE meta(id PRIMARY KEY, data); INSERT INTO meta VALUES (1, '{}')");
	const deltas: LiveDelta[] = [], items: TimelineItem[] = [];
	let writes = 0, failNextInsert = false;
	const vars = { nextSeq: 1, unwritten: [], serial: Promise.resolve(), pending: [], turn: { controller: new AbortController(), done: new Promise<void>(() => {}) },
		meta: { uid: "u_fixture", status: "running", profile: "docker-hardened", place: { kind: "hosted" } }, arming: Promise.resolve() };
	const c = { vars, key: ["u_fixture", "s_test"], conn: { params: { token: issueUserToken({ uid: "u_fixture", email: null, demo: true }, 0) } },
		client: () => ({ user: { get: () => ({ internalTokenGeneration: async () => 0, internalSessionChanged: async () => {} }) } }), log: console,
		broadcast: (name: string, value: never) => { if (name === "delta") deltas.push(value); if (name === "item") items.push(value); },
		keepAwake: <T>(p: Promise<T>) => p,
		db: { async execute(query: string, ...args: SQLInputValue[]) {
			if (query.includes("INTO timeline")) {
				if (failNextInsert) { failNextInsert = false; throw new Error("fixture interrupted write"); }
				writes++;
			}
			return sql.prepare(query).all(...args);
		} },
	};
	const recorder = acpRecorder(c as never, 1);
	return { c, recorder, vars, deltas, items, sql, writes: () => writes, failInsert() { failNextInsert = true; },
		stored: () => sql.prepare("SELECT item FROM timeline ORDER BY seq").all().map(row => JSON.parse(String(row.item)) as TimelineItem),
		chunk: (text: string) => recorder.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }) };
}
