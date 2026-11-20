/**
 * One submission and its key (`IdempotencyKey` in the contract). A user who sends a message means to
 * send it once, however many attempts that takes: the call can be answered late, not at all, or with
 * a refusal the user answers by sending the same again. So every attempt of one submission carries
 * one key, and the server takes that key once. A new submission, also of the same words sent again on
 * purpose after they were taken, gets a key of its own.
 *
 * What makes two sends the same submission is what is sent: the composer goes by the message's text,
 * the start composer by everything it sends for the agent.
 */
import type { IdempotencyKey } from "@contract";

export interface Submission {
	/** What is sent, as text: the message, or the start composer's input as JSON. */
	content: string;
	idempotencyKey: IdempotencyKey;
}

/**
 * The submission a send is an attempt of: `last`, the one that was sent before and not taken, when
 * what is sent now is unchanged; otherwise a new one, with a key of its own.
 */
export function submissionOf(content: string, last: Submission | null): Submission {
	return last !== null && last.content === content ? last : { content, idempotencyKey: crypto.randomUUID() };
}
