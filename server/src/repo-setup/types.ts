import type { PullRequestInfo } from "../contract.js";

export interface SetupDiagnosis {
	leftOut?: string[];
	phase: "draft" | "review" | "revision";
	model: string;
	toolOffered: boolean;
	attempts: number;
	rejections: string[];
	lastMessage: string | null;
	outcome: string;
	stopReason: string | null;
}
export type Verdict = "team" | "personal" | "private" | "secret" | "stale" | "question" | "duplicate";
export interface NoteUse { path: string; line: number; evidence: string }
export interface NoteDecision { noteId: string; verdict: Verdict; reason: string; uses: NoteUse[]; question?: string }
export interface SetupNote extends NoteInput { id: string; decision?: NoteDecision }
export interface NoteInput { label: string; text: string }
export interface GuideCheckStatus { enabled: boolean; result: { conclusion: "failure" | "success"; title: string; url: string } | null }
export interface SetupPublication { head?: string; linkedToClaude?: boolean; pull: PullRequestInfo; files: string[] }
export interface SetupKnowledge { notes: SetupNote[]; publication: SetupPublication | null }
export interface DraftRequest {
	areas: string[];
	later: number;
	noteIds: string[];
	previous: SetupPublication | null;
	answers?: Record<string, "keep" | "drop">;
}
