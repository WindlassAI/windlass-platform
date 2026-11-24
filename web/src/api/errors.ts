/**
 * What the backend throws, as the screens want it. It is its own file so that the code that asks the
 * server for the connection (connection.ts) reads refusals the same way and does not load RivetKit.
 */
import { PlatformError } from "./client";

/** Error codes a server might use for a refused token. rivet.ts, ASSUMPTION 5. */
const UNAUTHORIZED_CODES = new Set(["unauthorized", "unauthenticated", "forbidden", "invalid_token", "token_expired", "bad_token", "auth"]);

/**
 * The codes of the two limits a user can run into (server/src/usage.ts): too little of the day's
 * sandbox time is left for a turn to start, and the agent needs a sandbox while its user keeps as many
 * as they may. The server's sentence says which and what to do; the screens add the way to the usage page.
 */
const LIMIT_CODES = new Set(["allowance_used", "too_many_sandboxes"]);

/**
 * The codes of the Rivet gateway for a request that met an actor while it stopped or restarted: RivetKit's
 * own list of gateway errors worth sending again (`isRetryableGuardGatewayHttpError`).
 */
const GATEWAY_RESTART_CODES = new Set(["service_unavailable", "actor_wake_retries_exceeded", "actor_stopped_while_waiting", "tunnel_request_aborted", "tunnel_message_timeout", "tunnel_response_closed", "gateway_response_start_timeout"]);
/** The codes of the group `actor` for an actor that is stopping or restarting. */
const ACTOR_RESTART_CODES = new Set(["restarting", "stopping", "stopped"]);
/** What the proxy answers while the server behind it is down. */
const PROXY_RESTART_STATUSES = new Set([502, 503, 504]);

export const RESTARTING_MESSAGE = "The platform is restarting. Trying again…";
export const RESTARTED_MESSAGE = "The platform is restarting. Try again in a moment.";

/**
 * Whether a request failed the way requests fail while the platform restarts: the gateway or the actor
 * said so, the proxy answered 502, 503 or 504, or the connection dropped. RivetKit throws the last two as
 * its `HttpRequestError`, whose message carries the status ("Bad Gateway (502)") or "Request failed".
 */
export function isRestart(error: unknown): boolean {
	if (isRivetError(error)) {
		if (error.group === "guard" && GATEWAY_RESTART_CODES.has(error.code)) return true;
		if (error.group === "actor" && ACTOR_RESTART_CODES.has(error.code)) return true;
		return "statusCode" in error && typeof error.statusCode === "number" && PROXY_RESTART_STATUSES.has(error.statusCode);
	}
	if (!(error instanceof Error) || !error.message.startsWith("HTTP request error: ")) return false;
	const status = /\((\d{3})\)/.exec(error.message)?.[1];
	return error.message.includes("Request failed: ") || (status !== undefined && PROXY_RESTART_STATUSES.has(Number(status)));
}

/** Whether something thrown at the interface is a refusal by one of the user's limits. */
export function isLimitRefusal(error: unknown): boolean {
	return error instanceof PlatformError && error.reason !== null && LIMIT_CODES.has(error.reason);
}

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
	if (isRestart(error)) return new PlatformError("restarting", RESTARTING_MESSAGE, { cause: error });
	if (isRivetError(error)) {
		const { group, code, message } = error;
		if (group === "auth") {
			// A token that ran out is renewed and the request sent again before this is reached (rivet.ts), so
			// this is a renewal that did not help.
			if (isRefusedConnectionToken(error)) return new PlatformError("network", `The connection to ${endpoint} could not be renewed.`, { cause: error });
			return new PlatformError("internal", `The server at ${endpoint} refused the connection.`, { cause: error });
		}
		if (UNAUTHORIZED_CODES.has(code)) return new PlatformError("unauthorized", message || "This sign-in is no longer accepted. Sign in again.", { cause: error });
		if (code === "not_found" || (group === "actor" && (code === "destroying" || code.startsWith("destroyed"))) || (group === "user" && code === "session_not_found")) return new PlatformError("not_found", "There is no agent at this address.", { cause: error });
		// ASSUMPTION 10: the UserError's own code (`no_question`, `steer_unavailable`) arrives as `code`.
		if (group === "user") return new PlatformError("user", message, { cause: error, reason: code });
		if (group === "client") return new PlatformError("network", `The server at ${endpoint} could not be reached.`, { cause: error });
		if (code === "internal_error") return new PlatformError("internal", "The server hit an internal error. Its log has the details.", { cause: error });
		return new PlatformError("internal", message || "The server refused the request.", { cause: error });
	}
	// `fetch` rejects with a TypeError when nothing answers.
	if (error instanceof TypeError) return new PlatformError("network", `The server at ${endpoint} could not be reached.`, { cause: error });
	return new PlatformError("internal", error instanceof Error && error.message !== "" ? error.message : "Something went wrong.", { cause: error });
}
