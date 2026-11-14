/**
 * What one screen leaves for the next: a prompt that the new-agent dialog could not send is handed
 * to the session screen, which puts the text back in the composer and shows why it was refused.
 */
export interface Handover {
	text: string;
	error: string;
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
