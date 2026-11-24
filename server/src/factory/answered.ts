import type { ChoiceId } from "../contract.js";

/**
 * The item log's line for an answer to its question: the choice by its label, and the person's note after it.
 * A reply to the agent's own question is the person's answer itself, so it is not named by its button
 * ("Answer the agent"). Shared with the web mock, so it imports nothing of the server's.
 */
export function answeredWords(picked: { id: ChoiceId; label: string }, note: string | null): string {
	const end = (text: string) => (/[.!?…]["”’)]?$/.test(text) ? "" : ".");
	if (picked.id === "reply" && note !== null) return `Answered: ${note}${end(note)}`;
	return note === null ? `Answered “${picked.label}”.` : `Answered “${picked.label}”: ${note}${end(note)}`;
}
