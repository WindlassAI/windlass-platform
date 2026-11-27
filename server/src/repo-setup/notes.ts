import { randomBytes } from "node:crypto";
import type { RawAccess } from "rivetkit/db";
import { UserError } from "rivetkit";
import { openSecret, sealSecret } from "../repo-secrets.js";
import { serverSealer } from "../signin/seal.js";
import type { NoteDecision, NoteInput, SetupKnowledge, SetupNote, SetupPublication } from "./types.js";

type Db = Pick<RawAccess, "execute">;
export const NOTE_LIFETIME = 30 * 86400_000;
export const NOTES_TABLE = `CREATE TABLE IF NOT EXISTS setup_notes (
	project TEXT NOT NULL, id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, sealed TEXT NOT NULL, expires INTEGER NOT NULL, pr INTEGER, decision TEXT, drafter TEXT)`;
export const PUBLICATION_TABLE =
	"CREATE TABLE IF NOT EXISTS setup_publication (project TEXT PRIMARY KEY, result TEXT NOT NULL)";
const invalid = (message: string) => new UserError(message, { code: "bad_input" });

export function splitNotes(files: NoteInput[]): NoteInput[] {
	if (!Array.isArray(files) || !files.length || files.length > 20) throw invalid("Choose up to 20 notes.");
	let bytes = 0;
	const notes: NoteInput[] = [];
	for (const f of files) {
		if (
			typeof f?.text !== "string" ||
			!f.text.trim() ||
			typeof f.label !== "string" ||
			!/^[^/\\\x00-\x1f]{1,100}\.(md|mdc)$/i.test(f.label)
		)
			throw invalid("Choose Markdown notes or paste some text.");
		bytes += Buffer.byteLength(f.text);
		for (const text of f.text
			.split(/\n(?=#{1,2} )/)
			.map(s => s.trim())
			.filter(Boolean))
			notes.push({ label: f.label, text });
	}
	if (bytes > 256 * 1024 || notes.length > 200) throw invalid("Use at most 256 KB and 200 notes.");
	return notes;
}

export async function addNotes(db: Db, uid: string, project: string, input: NoteInput[], now: number) {
	const rows = splitNotes(input).map(n => {
		const id = randomBytes(10).toString("hex");
		return [
			project,
			id,
			Buffer.byteLength(n.text),
			sealSecret(serverSealer(), uid, project, "note:" + id, JSON.stringify(n)),
			now + NOTE_LIFETIME,
		];
	});
	const added = await db.execute(
		`WITH incoming(project,id,bytes,sealed,expires) AS (VALUES ${rows.map(() => "(?,?,?,?,?)").join(",")})
		INSERT INTO setup_notes(project,id,bytes,sealed,expires) SELECT * FROM incoming
		WHERE (SELECT count(*) FROM setup_notes WHERE project=? AND expires>?) + ? <= 200
		AND (SELECT coalesce(sum(bytes),0) FROM setup_notes WHERE project=? AND expires>?) + (SELECT sum(bytes) FROM incoming) <= 262144 RETURNING id`,
		...rows.flat(),
		project,
		now,
		rows.length,
		project,
		now,
	);
	if (!added.length) throw invalid("Delete some saved notes before adding more.");
}

export type SealedNote = { id: string; sealed: string; decision: string | null };

export function readNotes(db: Db, project: string) {
	return db.execute<SealedNote>(
		"SELECT id,sealed,decision FROM setup_notes WHERE project=? AND expires>? ORDER BY rowid",
		project,
		Date.now(),
	);
}

export function openNote(uid: string, project: string, row: SealedNote): SetupNote {
	const open = (kind: string, sealed: string) =>
		JSON.parse(openSecret(serverSealer(), uid, project, kind + ":" + row.id, sealed));
	return {
		id: row.id,
		...open("note", row.sealed),
		decision: row.decision ? open("decision", row.decision) : undefined,
	};
}

export async function setupKnowledge(db: Db, uid: string, project: string): Promise<SetupKnowledge> {
	const notes = (await readNotes(db, project)).map(row => openNote(uid, project, row));
	const [saved] = await db.execute<{ result: string }>("SELECT result FROM setup_publication WHERE project=?", project);
	return { notes, publication: saved ? JSON.parse(saved.result) : null };
}

export async function savePublication(
	db: Db,
	uid: string,
	project: string,
	publication: SetupPublication,
	decisions: NoteDecision[],
	session: string,
) {
	await db.execute(
		"UPDATE setup_notes SET drafter=NULL,decision=NULL WHERE project=? AND pr=?",
		project,
		publication.pull.number,
	);
	await db.execute("INSERT OR REPLACE INTO setup_publication VALUES (?,?)", project, JSON.stringify(publication));
	for (const d of decisions)
		await db.execute(
			"UPDATE setup_notes SET pr=?,decision=?,drafter=? WHERE project=? AND id=?",
			publication.pull.number,
			sealSecret(serverSealer(), uid, project, "decision:" + d.noteId, JSON.stringify(d)),
			d.question ? session : null,
			project,
			d.noteId,
		);
}

export async function closeSetupPull(db: Db, project: string, pr: number, merged: boolean) {
	await db.execute(
		"UPDATE setup_publication SET result=json_set(result,'$.pull.state',?) WHERE project=? AND json_extract(result,'$.pull.number')=?",
		merged ? "merged" : "closed",
		project,
		pr,
	);
	await db.execute("DELETE FROM setup_notes WHERE project=? AND pr=?", project, pr);
}
