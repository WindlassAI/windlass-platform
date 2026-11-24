/**
 * The server's half of a session's runner conversation, kept in the session actor's SQLite, so that a
 * server that restarts while a machine's runner keeps the session's work (within RUNNER_GRACE_MS)
 * resumes the same conversation instead of starting a new one (runner/channel.ts, `keepIn`).
 *
 *   runner_conversation   one row: the conversation's id, how far each side numbered, what the runner
 *                         acknowledged, and what the server committed of what it received
 *   runner_frames         the frames the server sent and the runner has not acknowledged, by seq
 *   turn_checkpoint       one row: what the running turn needs to take up its process again
 *                         (sandbox/turn.ts, `TurnCheckpoint`), written with the timeline
 *
 * Two writers, which never write the same column:
 *
 *   - Outgoing (`OutgoingJournal`): a frame is stored before it goes out (written ahead), so a runner
 *     never holds a seq the restarted server does not know. A frame that carried a secret is stored as
 *     a cancel of its id (`carriesSecret`), never as it was.
 *   - Incoming (`saveReceived`): the count of what was received is written in the same transaction as
 *     the timeline rows and the turn checkpoint it produced, and only then acknowledged. Whatever the
 *     runner sent past it, it still holds and sends again after a restart: taken once, lost never.
 */
import type { RawAccess } from "rivetkit/db";
import type { ConversationRecord, ServerChannel, Unsaved } from "./channel.js";

type Db = Pick<RawAccess, "execute">;

export async function migrateJournal(db: Db): Promise<void> {
	await db.execute("CREATE TABLE IF NOT EXISTS runner_conversation (id INTEGER PRIMARY KEY CHECK (id = 1), conversation TEXT NOT NULL, sent INTEGER NOT NULL, acked INTEGER NOT NULL, received INTEGER NOT NULL)");
	await db.execute("CREATE TABLE IF NOT EXISTS runner_frames (seq INTEGER PRIMARY KEY, text TEXT NOT NULL)");
	await db.execute("CREATE TABLE IF NOT EXISTS turn_checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), turn INTEGER NOT NULL, data TEXT NOT NULL)");
}

/** What a restarted server reads back; null when there is none. */
export async function readConversation(db: Db): Promise<ConversationRecord | null> {
	const [row] = await db.execute<{ conversation: string; sent: number; acked: number; received: number }>("SELECT conversation, sent, acked, received FROM runner_conversation WHERE id = 1");
	if (!row) return null;
	const frames = await db.execute<{ seq: number; text: string }>("SELECT seq, text FROM runner_frames WHERE seq > ? AND seq <= ? ORDER BY seq", row.acked, row.sent);
	return { conversation: row.conversation, sent: row.sent, acked: row.acked, received: row.received, frames: frames.map(f => [f.seq, f.text]) };
}

/** Forgets the stored conversation and checkpoint: the session starts its next one afresh. */
export async function forgetConversation(db: Db): Promise<void> {
	await db.execute("DELETE FROM runner_frames");
	await db.execute("DELETE FROM runner_conversation");
	await db.execute("DELETE FROM turn_checkpoint");
}

async function writeOutgoing(db: Db, u: Unsaved): Promise<void> {
	if (u.conversation === null) {
		await db.execute("DELETE FROM runner_frames");
		await db.execute("DELETE FROM runner_conversation");
		return;
	}
	if (u.fresh) {
		await db.execute("DELETE FROM runner_frames");
		await db.execute("INSERT OR REPLACE INTO runner_conversation (id, conversation, sent, acked, received) VALUES (1, ?, 0, 0, 0)", u.conversation);
	}
	for (let at = 0; at < u.frames.length; at += 100) {
		const batch = u.frames.slice(at, at + 100);
		await db.execute(`INSERT OR REPLACE INTO runner_frames (seq, text) VALUES ${batch.map(() => "(?, ?)").join(", ")}`, ...batch.flat());
	}
	await db.execute("UPDATE runner_conversation SET sent = MAX(sent, ?), acked = MAX(acked, ?) WHERE id = 1 AND conversation = ?", u.sent, u.acked, u.conversation);
	await db.execute("DELETE FROM runner_frames WHERE seq <= ?", u.acked);
}

/**
 * The outgoing writer of one channel. `dirty` is the channel's `onDirty`: what is waiting is written
 * soon after, in one transaction, and let out. A write that fails lets the frames out all the same:
 * the conversation then cannot be resumed after a restart (the runner would hold a seq the server
 * does not know, and is told to start a new one), which is what happens without storage at all.
 */
export class OutgoingJournal {
	private queued = false;
	private writing: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(
		private readonly db: RawAccess,
		private readonly channel: () => ServerChannel | null,
		/** Received past what is committed: the owner commits it with what it produced (`saveReceived`). */
		private readonly onReceived: () => void,
		private readonly log: (line: string) => void = (line) => console.warn(line),
	) {}

	dirty(): void {
		if (this.closed) return;
		this.onReceived();
		if (this.queued) return;
		this.queued = true;
		setImmediate(() => {
			this.queued = false;
			this.writing = this.writing.then(() => this.write());
		});
	}

	/** Waits for what is being written. */
	settle(): Promise<void> {
		return this.writing;
	}

	close(): void {
		this.closed = true;
	}

	private async write(): Promise<void> {
		const channel = this.channel();
		const u = channel?.unsaved();
		if (!channel || !u) return;
		try {
			await this.db.transaction(tx => writeOutgoing(tx, u), { name: "runner.outgoing" });
		} catch (error) {
			this.log(`[wlp] runner.journal_failed: the conversation could not be stored, so it cannot outlive this server (${error instanceof Error ? error.message : String(error)})`);
		}
		channel.saved(u);
	}
}

/**
 * Inside the transaction that writes the timeline: what the first `received` messages produced is in
 * it, so that much is stored as received. The caller tells the channel (`ServerChannel.committed`)
 * once the transaction has committed, and only when this says the row was there.
 */
export async function saveReceived(tx: Db, conversation: string | null, received: number): Promise<boolean> {
	if (conversation === null) return false;
	// Only into the row of that conversation: one the outgoing writer has not stored yet takes nothing, and nothing is acknowledged.
	const rows = await tx.execute<{ id: number }>("UPDATE runner_conversation SET received = MAX(received, ?) WHERE id = 1 AND conversation = ? RETURNING id", received, conversation);
	return rows.length > 0;
}

export async function saveCheckpoint(tx: Db, turn: number, data: unknown | null): Promise<void> {
	if (data === null) await tx.execute("DELETE FROM turn_checkpoint");
	else await tx.execute("INSERT OR REPLACE INTO turn_checkpoint (id, turn, data) VALUES (1, ?, ?)", turn, JSON.stringify(data));
}

export async function readCheckpoint<T>(db: Db): Promise<{ turn: number; data: T } | null> {
	const [row] = await db.execute<{ turn: number; data: string }>("SELECT turn, data FROM turn_checkpoint WHERE id = 1");
	return row ? { turn: row.turn, data: JSON.parse(row.data) as T } : null;
}
