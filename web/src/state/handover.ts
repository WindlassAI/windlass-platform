/**
 * What one screen leaves for the next: a prompt that the new-agent dialog could not send is handed
 * to the session screen, which puts the text back in the composer and shows why it was refused.
 */
export interface Handover {
	text: string;
	error: string;
	/** True when one of the user's limits refused it: the composer then points to the usage page. */
	limit?: boolean;
	/** The key the prompt was sent with (lib/submission.ts): sent again from the composer unchanged, it is the same submission. */
	idempotencyKey: string;
}

const waiting = new Map<string, Handover>();

export function handOver(sessionId: string, handover: Handover): void {
	waiting.set(sessionId, handover);
}

export function takeHandover(sessionId: string): Handover | null {
	const handover = waiting.get(sessionId) ?? null;
	waiting.delete(sessionId);
	return handover;
}
