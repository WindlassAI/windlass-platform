import type { SessionSummary } from "@contract";

/** The agents made to continue agent `id` ("Continue in a new PR"), oldest first. */
export function continuedIn(sessions: readonly SessionSummary[], id: string): SessionSummary[] {
	return sessions.filter(one => one.continuedFrom?.id === id).sort((a, b) => a.createdAt - b.createdAt);
}
