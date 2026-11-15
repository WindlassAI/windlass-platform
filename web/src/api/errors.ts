/**
 * What the backend throws, as the screens want it. It is its own file so that the code that asks the
 * server for the connection (connection.ts) reads refusals the same way and does not load RivetKit.
 */
import { PlatformError } from "./client";

/** Error codes a server might use for a refused token. rivet.ts, ASSUMPTION 5. */
const UNAUTHORIZED_CODES = new Set(["unauthorized", "unauthenticated", "forbidden", "invalid_token", "token_expired", "bad_token", "auth"]);

/** Structural, like `RivetError.isRivetError`: an error decoded from the wire need not be an instance. */
export function isRivetError(error: unknown): error is { group: string; code: string; message: string } {
	return typeof error === "object" && error !== null && "group" in error && typeof error.group === "string" && "code" in error && typeof error.code === "string" && "message" in error && typeof error.message === "string";
}

/**
 * Whether the Rivet engine refused the token the browser connects with: it ran out, or the engine does
 * not know it. That is the engine's group `auth`, and not the user's sign-in, which the actors check
 * and refuse in the group `user`: the two share the code `invalid_token`.
 */
export function isRefusedConnectionToken(error: unknown): boolean {
	return isRivetError(error) && error.group === "auth" && (error.code === "invalid_token" || error.code === "token_expired");
}

/**
 * What RivetKit throws, as the screens want it. A `UserError` thrown in an actor arrives as an
 * `ActorError` (RivetKit's `RivetError`) with `group: "user"`, the `code` it was given (or the
 * default) and its message; any other error thrown in an actor arrives with `group: "rivetkit"`,
 * `code: "internal_error"` and a generic message. What the engine itself refuses arrives in the
 * engine's groups: `auth` is about the connection's token and never signs the user out.
 */
export function toPlatformError(error: unknown, endpoint: string): PlatformError {
	if (error instanceof PlatformError) return error;
	if (isRivetError(error)) {
		const { group, code, message } = error;
		if (group === "auth") {
			// A token that ran out is renewed and the request sent again before this is reached (rivet.ts), so
			// this is a renewal that did not help.
			if (isRefusedConnectionToken(error)) return new PlatformError("network", `The connection to ${endpoint} could not be renewed.`, { cause: error });
			return new PlatformError("internal", `The server at ${endpoint} refused the connection.`, { cause: error });
		}
		if (UNAUTHORIZED_CODES.has(code)) return new PlatformError("unauthorized", message || "This sign-in is no longer accepted. Sign in again.", { cause: error });
		if (code === "not_found" || (group === "actor" && code.startsWith("destroyed"))) return new PlatformError("not_found", "There is no agent at this address.", { cause: error });
		// ASSUMPTION 10: the UserError's own code (`no_question`, `turn_running`) arrives as `code`.
		if (group === "user") return new PlatformError("user", message, { cause: error, reason: code });
		if (group === "client") return new PlatformError("network", `The server at ${endpoint} could not be reached.`, { cause: error });
		if (code === "internal_error") return new PlatformError("internal", "The server hit an internal error. Its log has the details.", { cause: error });
		return new PlatformError("internal", message || "The server refused the request.", { cause: error });
	}
	// `fetch` rejects with a TypeError when nothing answers.
	if (error instanceof TypeError) return new PlatformError("network", `The server at ${endpoint} could not be reached.`, { cause: error });
	return new PlatformError("internal", error instanceof Error && error.message !== "" ? error.message : "Something went wrong.", { cause: error });
}
