import type { CheckConclusion } from "../contract.js";

export const VERIFIED_NAME = "windlass/verified";
export type CheckRunUpdate = {
	external_id: string;
	details_url: string;
	started_at: string;
	output: { title: string; summary: string };
} & ({ status: "in_progress" } | { status: "completed"; conclusion: CheckConclusion; completed_at: string });
