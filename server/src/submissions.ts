/**
 * A submission and its key (docs/architecture.md, "A message sent twice"; contract.ts, `IdempotencyKey`).
 *
 * Why. A call can reach an actor twice. RivetKit's client sends an action again when the engine
 * reports that the answer was lost on its way, an action that is in flight when its actor is put to
 * sleep runs again in the actor's next instance, and a user who was told that the server did not
 * answer presses Send again. Without a key each of these is a new message. With one, the actor takes
 * the submission once and answers every other attempt with what the first was answered.
 *
 * What is held against a key. A digest of what was sent under it, so that a key which comes again
 * with something else is refused and not answered as a repeat. It is a digest and not the content:
 * what an actor keeps of a message may differ from what was sent (a secret's value is taken out of a
 * message before it is stored), and a repeat must still be told from another message.
 *
 * Three states of a key, and what each actor does with them:
 *
 *   taken     the actor keeps the key with what it made, and answers from that (`isRepeat`)
 *   deciding  an attempt with it is between received and taken; an action waits on other actors and
 *             on the sandbox layer there, and other calls run meanwhile. A second attempt is not
 *             decided on its own: it ends as the first one ends, answer or refusal (`Attempts`)
 *   unused    anything else, also after an attempt that was refused: the next attempt is a new try
 *
 * A key is recorded in the same synchronous step that takes its submission, and never before: so a
 * refusal leaves nothing behind, and "refused" and "taken, but the answer was lost" are told apart by
 * whether the key is kept. Where it is kept, and for how long, is each actor's own (agent-session.ts,
 * `SessionMeta.submissions`; user.ts, the `sessions` table). A key is never logged and never sent to
 * a client.
 *
 * This file has no actor in it.
 */

import { createHash } from "node:crypto";
import { MAX_IDEMPOTENCY_KEY_CHARS } from "./contract.js";

/** Thrown for a key that cannot be taken; `message` is fit to show, `code` is the UserError's. */
export class SubmissionProblem extends Error {
	constructor(
		readonly code: "bad_idempotency_key" | "idempotency_key_reused",
		message: string,
	) {
		super(message);
		this.name = "SubmissionProblem";
	}
}

/** A submission that came with a key: the key, and the digest of what was sent under it. */
export interface Submission {
	key: string;
	sent: string;
}

/**
 * The submission a call is an attempt of, from the key it came with and what it asks for; null when
 * it came with none (left out, or null). `content` is anything JSON can hold, and two contents are
 * the same when they hold the same values under the same names, in whatever order. Throws
 * SubmissionProblem for a key that is no string, is empty or is longer than the limit, counted in
 * characters as JSON Schema's `maxLength` counts them.
 */
export function submissionOf(key: unknown, content: unknown): Submission | null {
	if (key === undefined || key === null) return null;
	if (typeof key !== "string" || key === "" || [...key].length > MAX_IDEMPOTENCY_KEY_CHARS) {
		throw new SubmissionProblem("bad_idempotency_key", `The key of a submission must be a text of 1 to ${MAX_IDEMPOTENCY_KEY_CHARS} characters. Leave it out to send without one.`);
	}
	return { key, sent: createHash("sha256").update(JSON.stringify(ordered(content))).digest("base64url") };
}

/** `value` with every object's names in order, so that what is the same is written the same. */
function ordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(ordered);
	if (typeof value !== "object" || value === null) return value;
	const from = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(from)
			.sort()
			.map((name) => [name, ordered(from[name])]),
	);
}

/**
 * Whether `submission` is another attempt of `first`, which is what is kept or being decided under
 * its key; false when there is none. Throws SubmissionProblem when the key came with something else
 * the first time: `what` names what a key belongs to here ("message to this agent", "agent").
 */
export function isRepeat(first: Submission | undefined, submission: Submission, what: string): boolean {
	if (first === undefined) return false;
	if (first.sent !== submission.sent) {
		throw new SubmissionProblem("idempotency_key_reused", `The key this was sent with was already used for another ${what}, so this one was not taken. A new submission needs a key of its own.`);
	}
	return true;
}

/** The attempts that are being decided now, by key, each with the outcome all of them end with. */
export class Attempts<Answer> {
	private readonly deciding = new Map<string, Submission & { outcome: Promise<Answer> }>();

	/**
	 * Decides `submission` with `decide` unless an attempt of it is being decided already, in which
	 * case it ends as that one does. Nothing is awaited before `decide` runs and before the attempt is
	 * on the list, so of two attempts that arrive together exactly one decides. `what` as in `isRepeat`.
	 */
	run(submission: Submission, what: string, decide: () => Promise<Answer>): Promise<Answer> {
		const first = this.deciding.get(submission.key);
		if (first && isRepeat(first, submission, what)) return first.outcome;
		const outcome = decide().finally(() => this.deciding.delete(submission.key));
		this.deciding.set(submission.key, { ...submission, outcome });
		return outcome;
	}
}
