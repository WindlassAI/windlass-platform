import type { PullRequestInfo } from "../contract.js";

export type Verdict = "team" | "personal" | "private" | "secret" | "stale" | "question" | "duplicate";
export interface NoteUse { path: string; line: number; evidence: string }
export interface NoteDecision { noteId: string; verdict: Verdict; reason: string; uses: NoteUse[]; question?: string }
export interface SetupNote { id: string; label: string; text: string; decision?: NoteDecision }
export interface NoteInput { label: string; text: string }
export interface SetupPublication { pull: PullRequestInfo; files: string[]; questions: string[] }
export interface SetupKnowledge { notes: SetupNote[]; publication: SetupPublication | null }
export interface DraftRequest {
	areas: string[];
	later: number;
	noteIds: string[];
	previous: PullRequestInfo | null;
	answers?: Record<string, "keep" | "drop">;
}
