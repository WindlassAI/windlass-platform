/** Reviews, reports, attachments and their limits. */

import type { CheckStatus, VerifiedFlag } from "./repository.js";

/** What a reviewer recommends. It never changes `Verdict.result`. */
export type ReviewRecommendation = "approve" | "changes_requested" | "needs_person";

/** Redacted text with limited formatting: paragraphs, bullets, inline code and bounded fences. Never interpret HTML, links or images. */
export type ReviewText = string;

/** A place in the repository: a path at the head (or at the base, for removed lines). */
export interface ReviewLocation {
	/** Repository-relative: no "..", no leading "/", no NUL, at most REVIEW_LIMITS.pathChars. */
	path: string;
	/** Default "head". */
	side?: "head" | "base";
	/** 1-based, `end >= start`, at most REVIEW_LIMITS.locationLines lines. */
	lines?: { start: number; end: number };
}

/** The author's claim references a platform record. Render the observed result separately from the claim. */
export interface ReviewRef {
	ref: string;
	says?: "passed" | "failed" | "ran" | "not_run";
}

/** The blocks as a reviewer files them (R3). */
export type ReviewBlockInput =
	| { kind: "summary"; text: ReviewText }
	| { kind: "text"; heading?: string; text: ReviewText; refs?: ReviewRef[] }
	| { kind: "finding"; severity: "blocking" | "should_fix" | "note"; title: string; text: ReviewText; at?: ReviewLocation[]; refs?: ReviewRef[]; /** An earlier round's finding id (r1.f2) this one continues. */ continues?: string }
	| { kind: "earlier"; finding: string; status: "fixed" | "not_fixed" | "withdrawn"; text?: ReviewText }
	| { kind: "risk"; text: ReviewText; at?: ReviewLocation[] }
	| { kind: "question"; text: ReviewText }
	| { kind: "excerpt"; at: ReviewLocation & { lines: { start: number; end: number } }; note?: ReviewText }
	| { kind: "screenshot"; file: string; caption: string; shows?: "after" | "before"; page?: string };

export interface ReviewInput {
	recommendation: ReviewRecommendation;
	blocks: ReviewBlockInput[];
}

/** One of the platform's records as it was when the text was filed: what a `ReviewRef` shows. */
export type ReviewRecord =
	| { ref: string; kind: "check"; name: string; status: CheckStatus }
	| { ref: string; kind: "ci"; name: string; app: string; conclusion: string; url: string }
	| { ref: string; kind: "flag"; flag: VerifiedFlag }
	| { ref: string; kind: "command"; command: string; exitCode: number | null; outcome: string; /** At most 20 lines, redacted. */ tail: string };

/** The blocks as stored and shown: ids assigned, references resolved, code fetched (R3), files stored (R2). */
export type ReviewBlock =
	| { kind: "summary"; text: string }
	| { kind: "text"; heading: string | null; text: string; refs: ReviewRef[] }
	| { kind: "finding"; id: string; root: string; severity: "blocking" | "should_fix" | "note"; title: string; text: string; at: ReviewLocation[]; refs: ReviewRef[] }
	| { kind: "earlier"; finding: string; status: "fixed" | "not_fixed" | "withdrawn"; text: string | null }
	| { kind: "risk"; text: string; at: ReviewLocation[] }
	| { kind: "question"; text: string }
	| { kind: "excerpt"; at: ReviewLocation; code: string; note: string | null }
	| { kind: "screenshot"; attachment: string };

export interface ItemAttachment {
	id: string;
	by: "builder" | "reviewer";
	sessionId: string;
	/** The published commit for the builder's filing, or the reviewer's checkout. Null until known. */
	head: string | null;
	width: number;
	height: number;
	bytes: number;
	sha256: string;
	caption: string;
	shows: "after" | "before" | null;
	page: string | null;
	state: "kept" | "removed";
}

/** One set of a part's screenshots, as its builder's report or a review filed them, on its feature's page. */
export interface PartScreenshots {
	itemId: string;
	/** The part's key in the plan, or a repair's ("ci-fix-<n>", "conflict-fix-<n>"). */
	key: string;
	title: string;
	by: ItemAttachment["by"];
	/** The commit the set shows, as `ItemReport.head` and `ItemReview.head`. */
	head: string | null;
	at: number;
	screenshots: ItemAttachment[];
}

/** Builder-authored report, presented separately from platform evidence. */
export interface ItemReport {
	screenshots: ItemAttachment[];
	by: "builder";
	sessionId: string;
	run: number;
	/** The step attempt's key it was filed in: <item>:<run>:<step>:<attempt>. */
	key: string;
	/** The commit published for this report's turn, or null until known. */
	head: string | null;
	at: number;
	title: string;
	blocks: ReviewBlock[];
	/** Referenced platform records at filing time. */
	records: ReviewRecord[];
}

/** A review of one pushed head. Its id is the review step attempt's key. */
export interface ItemReview {
	/** Advisory review requested on this GitHub pull request. */
	requestedPull?: { owner: string; name: string; pr: number };
	screenshots: ItemAttachment[];
	id: string;
	run: number;
	round: number;
	head: string;
	base: string;
	verdictId: string;
	by: { sessionId: string; model: string; via?: "host" | "mcp"; commandSandbox?: "windlass" | "none" | "unknown" };
	at: number;
	state: "filed" | "none";
	said: string | null;
	recommendation: ReviewRecommendation | null;
	blocks: ReviewBlock[];
	records: ReviewRecord[];
	notes: string[];
}

export const REVIEW_LIMITS = {
	inputBytes: 96 * 1024,
	totalChars: 40_000,
	blocks: 60,
	summaryChars: 1_500,
	textChars: 4_000,
	headingChars: 80,
	findings: 30,
	findingTitleChars: 160,
	findingChars: 2_000,
	locationsPerBlock: 5,
	refsPerBlock: 8,
	earlierChars: 600,
	risks: 10,
	riskChars: 1_000,
	questions: 5,
	questionChars: 600,
	excerpts: 10,
	excerptLines: 40,
	excerptLineChars: 300,
	screenshots: 8,
	captionChars: 200,
	pageChars: 300,
	paths: 20,
	refs: 40,
	fenceLines: 60,
	pathChars: 300,
	locationLines: 200,
	lookAtChars: 1_000,
} as const;
