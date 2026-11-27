/**
 * The sign-in hand-off, in words and numbers. No sandbox ever holds a user's ChatGPT sign-in: the
 * platform keeps it in one place (`AccessTokens`, api.ts) and hands each turn a short-lived access
 * token in a file, which Windlass reads at every model call (`WINDLASS_ACCESS_TOKEN_FILE`; Windlass's
 * user guide, "One sign-in for several machines").
 *
 * It also says what a failure of that hand-off means, which it reads from the stable codes Windlass
 * gives its sign-in's failures and never from the words of a message ("Windlass's codes" below).
 *
 * This file has no Docker in it: the fake layer uses the same sentences and the same mapping.
 */

import { type AccessToken, SandboxUserError } from "./api.js";
import { errorText } from "../util.js";

/** The variable that names the file Windlass reads its access token from. */
export const ACCESS_TOKEN_FILE_ENV = "WINDLASS_ACCESS_TOKEN_FILE";

/*
 * The three durations of the hand-off. A token lasts about an hour and a turn may run 45 minutes.
 *
 *   TOKEN_VALID_FOR_MS      20 min  the least a token has left when it is handed to a turn or written as a
 *                                   replacement: what Windlass is asked for (`--valid-for 20m`)
 *   TOKEN_REPLACE_LEAD_MS   10 min  a turn's token file is replaced when the token in it has this much left
 *   (reuse)                 40 min  a fetched token serves the user's other requests while it still has
 *                                   TOKEN_VALID_FOR_MS left: the first 40 minutes of its hour
 *
 * They fit together like this. The lead is half of what is asked for. So a turn's file is never
 * replaced in the turn's first ten minutes, and when it is, the token in it has less left than is asked
 * for: asking then gives another token at whatever moment the replacement comes (no window has to be
 * hit), and ten minutes remain for a replacement that fails to be tried again. The new token has an
 * hour, so a turn of 45 minutes has its file replaced once at most. Windlass refreshes the sign-in only
 * when it is asked and the saved token has less than twenty minutes left, and a new token has sixty:
 * two refreshes of one user are at least forty minutes apart, however many sessions and turns that user
 * runs. That is 1.5 an hour at most (a token's hour makes one an hour the least there can be), and a
 * user who runs nothing causes none. Every refresh is a request to OpenAI that rotates the sign-in's
 * refresh token, which is why there are no more of them.
 *
 * Should the service issue tokens that last less than is asked for, Windlass says so and prints the
 * token all the same. Such a token is used with its real expiry, and half of what it has left takes
 * the place of both durations: it is reused, and stays in a turn's file, until half of that is gone
 * (tokens.ts, token-file.ts). Nothing is asked again at once because a token came out short.
 */

/**
 * How long a token must still be good for when it is handed to a turn or written as a replacement:
 * `windlass login token --valid-for` is asked for this much, and refreshes the sign-in first when the
 * saved token has less. A fetched token is reused for as long as asking again would print the same
 * one: while it has more than this left.
 */
export const TOKEN_VALID_FOR_MS = 20 * 60 * 1000;

/**
 * A turn's token file is replaced when the token in it has this long left: half of what a token is
 * asked with, so Windlass refreshes for the replacement whenever it comes, and this long remains for a
 * replacement that fails to be tried again.
 */
export const TOKEN_REPLACE_LEAD_MS = 10 * 60 * 1000;

/** How long after a failed replacement the next one is tried, and the least time between two replacements. */
export const TOKEN_REPLACE_RETRY_MS = 20 * 1000;

/** A duration as `--valid-for` takes it: whole minutes as `20m`, anything else in seconds (`90s`). */
export function windlassDuration(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1000));
	return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

/** The command that prints a user's access token where the sign-in is saved: `windlass login token --json --valid-for 20m`. */
export function loginTokenCommand(validForMs: number = TOKEN_VALID_FOR_MS): string[] {
	return ["windlass", "login", "token", "--json", "--valid-for", windlassDuration(validForMs)];
}

/**
 * What Windlass adds on standard error when the token it printed is good for less than was asked: a
 * refresh gave none that lasts longer. The token is printed all the same, with exit code 0.
 */
export function saysShorterThanAsked(stderr: string): boolean {
	return /this token is valid for .* not the .* asked for with --valid-for/.test(stderr);
}

/** What the file holds: the object `windlass login token --json` prints, on one line. */
export function tokenFileContent(token: AccessToken): string {
	return `${JSON.stringify({ accessToken: token.accessToken, expiresAt: token.expiresAt })}\n`;
}

// ---------------------------------------------------------------------------------------------
// Sentences for the user
// ---------------------------------------------------------------------------------------------

export const NOT_SIGNED_IN = "You are not signed in with ChatGPT. Sign in with ChatGPT, then send the prompt again.";
export const SIGN_IN_EXPIRED = "Your ChatGPT sign-in is no longer accepted: it expired or was withdrawn. Sign in with ChatGPT again, then send the prompt once more.";
export const TOKEN_REJECTED = "ChatGPT rejected the access token of your sign-in. Sign in with ChatGPT again, then send the prompt once more.";

// ---------------------------------------------------------------------------------------------
// Windlass's codes
// ---------------------------------------------------------------------------------------------

/*
 * Windlass gives every failure of its sign-in a stable code, and what a failure means for the user is
 * decided from that code, not from the words of a message: the words are for reading, and may change
 * (Windlass's docs/acp.md, "Errors", and docs/troubleshooting.md). The code is in three places:
 *
 *   a turn            on the error `session/prompt` (or opening the session) is answered with,
 *                     `data.windlass.code` (`AcpError.failureCode`), and on the provider error of the model
 *                     call that failed, `step.failed` at `error.error.code`. The two agree.
 *   the token source  in the brackets of the one line `windlass login token` fails with:
 *                     `windlass: sign-in failed: <message> (<code>)`.
 *
 *   handed_in_missing, handed_in_unreadable,   the token file was not delivered as it should be. The
 *   handed_in_empty, handed_in_malformed       sign-in is untouched: `token_unavailable`, send the prompt
 *                                              again (unless the file is gone because the sign-in was
 *                                              forgotten, which the token source says: `auth_required`)
 *   handed_in_expired, handed_in_rejected      the token is no longer good: `auth_required`, sign in with
 *                                              ChatGPT again, unless the platform's own token source says
 *                                              the sign-in is fine and the platform did not deliver the
 *                                              next token in time: `token_unavailable`
 *   signed_out                                 no sign-in is saved: `auth_required`
 *   invalid_grant and the other refusals       the sign-in service refused to refresh the sign-in:
 *   (`SIGN_IN_REFUSED`)                        `auth_required`
 *   network_error                              the sign-in service could not be reached. A connection
 *                                              problem, said as it is: nothing about the sign-in
 *   any other                                  not about the hand-off (a provider's own code for its
 *                                              answer, ...): the failure stays as Windlass reported it
 */

/** No sign-in is saved where Windlass looked for one. */
export const SIGNED_OUT = "signed_out";

/** The sign-in service could not be reached to refresh the sign-in: a connection problem, which says nothing about the sign-in. */
export const SIGN_IN_UNREACHABLE = "network_error";

/**
 * What the sign-in service answers when it refuses a refresh for good, as Windlass passes it on: OAuth's
 * own codes, and `http_<status>` when the answer had none. Any other code of the service's (a
 * `server_error`, an `http_503`) is not taken for a refusal: the sign-in may well be fine.
 */
export const SIGN_IN_REFUSED: ReadonlySet<string> = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "access_denied", "invalid_request", "invalid_scope", "http_400", "http_401", "http_403"]);

/**
 * What Windlass found wrong with the token it was handed:
 *
 *   undelivered  the file gave no token: it was missing, unreadable, empty or malformed
 *   expired      the expiry the file states has passed
 *   rejected     the provider turned the token down, also after the file was read once more
 *   unknown      a failure of a handed-in token that this platform cannot tell further: a code it does not
 *                know yet, or no code and words it does not know
 */
export type HandedInProblem = "undelivered" | "expired" | "rejected" | "unknown";

const HANDED_IN = new Map<string, HandedInProblem>([
	["handed_in_missing", "undelivered"],
	["handed_in_unreadable", "undelivered"],
	["handed_in_empty", "undelivered"],
	["handed_in_malformed", "undelivered"],
	["handed_in_expired", "expired"],
	["handed_in_rejected", "rejected"],
]);

/** What a code of Windlass's says about a handed-in token; null when the code is not about one (`network_error`, a provider's own, ...). */
export function handedInProblem(code: string): HandedInProblem | null {
	// A `handed_in_...` this platform does not know is a newer Windlass's: still about the token, not further told.
	return HANDED_IN.get(code) ?? (code.startsWith("handed_in_") ? "unknown" : null);
}

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------

export type Failure = { reason: string; message: string };

/**
 * Thrown by the token source when Windlass could not refresh the sign-in for a reason that says nothing
 * about the sign-in itself. `code` is Windlass's: `network_error` (the sign-in service could not be
 * reached), `refresh_locked`, `bad_token_response`, or a code of the sign-in service that is no refusal.
 * It is never the user's doing: the sign-in is as it was, and asking again may work.
 */
export class SignInRefreshError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "SignInRefreshError";
	}
}

const sentence = (error: unknown) => errorText(error).trim().replace(/[.\s]+$/, "");

/** Why no token could be had from the token source, as `RunTurnResult.failure`. The kind of error decides, which the token source made from Windlass's code. */
export function tokenSourceFailure(error: unknown): Failure {
	if (error instanceof SandboxUserError) return { reason: "auth_required", message: error.message };
	return { reason: "token_unavailable", message: `The platform could not get an access token of your ChatGPT sign-in for this turn: ${sentence(error)}. Your sign-in is untouched; send the prompt again.` };
}

export interface TokenFileState {
	/** When the token last written to the file expires, ms since the epoch. */
	expiresAt: number;
	/**
	 * What the token source said when it was last asked for this turn's next token and gave none: why the
	 * last attempt to replace the file failed, or its answer at the turn's end when no attempt had failed
	 * (`Turn.told`, windlass.ts). Null when it gave a token, or was not asked.
	 */
	problem: unknown;
	/** Whether the token in the file has expired, or one did within the last minute before the next was written. */
	lapsed: boolean;
}

/**
 * Whether the turn's token ran out, which is the platform's to prevent: Windlass says the token in the
 * file expired, or it says less (the provider turned the token down, or a failure that is not further
 * told) and by the platform's own clock the token in the file had run out. A file that gave no token at
 * all is not a token that ran out.
 */
export function tokenRanOut(problem: HandedInProblem, state: TokenFileState, now: number = Date.now()): boolean {
	return problem === "expired" || (problem !== "undelivered" && (state.lapsed || state.expiresAt <= now));
}

const UNDELIVERED = "Windlass could not read the access token the platform handed it in this sandbox. Your ChatGPT sign-in is untouched; send the prompt again.";
const UNUSABLE = "Windlass could not use the access token the platform handed it for this turn. Send the prompt again; if it ends the same way, sign in with ChatGPT again.";

/**
 * What Windlass's refusal of a handed-in token means for the user. Windlass ends such a turn with its
 * `auth_required` and one sentence for every case, which is for whoever handed the token in (it names
 * the variable and says to hand in a new token). Which case it was is `problem`, read from Windlass's
 * code (`handedInProblem`); why the platform left the file so is in `state`:
 *
 *   - the provider rejected a token that was there and had not run out: `auth_required`, sign in with
 *     ChatGPT again. Only the sign-in can be why;
 *   - the token ran out, or its file gave none, and the token source says the sign-in is gone or no
 *     longer accepted (`state.problem` is a `SandboxUserError`): `auth_required` as well, with the token
 *     source's sentence;
 *   - it ran out or gave none for any other reason (the token source could not be reached, the platform
 *     was late): `token_unavailable`, which is the platform's failure and not the user's sign-in;
 *   - a failure that is not further told, of a token that had not run out: `token_unavailable` too, with
 *     a sentence that claims neither.
 */
/**
 * The model relay's own refusal of a turn's placeholder (docs/model-relay.md): the relay had no live lease
 * for it (the turn's lease ended, or the relay was restarted and lost it). The relay answers 401 with the
 * code `relay_lease_ended`; Windlass reports any 401 of a handed-in token as `handed_in_rejected` and keeps
 * the provider's code in its message ("rejected (<message>, relay_lease_ended)"), or on the step's error.
 * That is the platform's failure, not the user's sign-in: `token_unavailable`, never "sign in again".
 */
export const RELAY_LEASE_ENDED = "relay_lease_ended";
export function relayRefused(code: string | null, ...said: (string | null | undefined)[]): boolean {
	if (code === RELAY_LEASE_ENDED) return true;
	return code !== null && handedInProblem(code) === "rejected" && said.some((text) => typeof text === "string" && /\brelay_lease_ended\b/.test(text));
}
export const RELAY_REFUSED: Failure = {
	reason: "token_unavailable",
	message: "The platform's model relay no longer had this turn's lease (the turn ended, or the relay was restarted). Your ChatGPT sign-in is untouched; send the prompt again.",
};

export function handedInFailure(problem: HandedInProblem, state: TokenFileState, now: number = Date.now()): Failure {
	const ranOut = tokenRanOut(problem, state, now);
	if (problem === "rejected" && !ranOut) return { reason: "auth_required", message: TOKEN_REJECTED };
	const why = state.problem ?? null;
	if (why instanceof SandboxUserError) return { reason: "auth_required", message: why.message };
	if (problem === "undelivered") return { reason: "token_unavailable", message: UNDELIVERED };
	if (!ranOut) return { reason: "token_unavailable", message: UNUSABLE };
	if (why !== null) {
		return { reason: "token_unavailable", message: `The access token this turn was working with ran out and the platform could not replace it: ${sentence(why)}. Your ChatGPT sign-in is untouched; send the prompt again.` };
	}
	return { reason: "token_unavailable", message: "The access token this turn was working with ran out before the platform replaced it. Your ChatGPT sign-in is untouched; send the prompt again." };
}
