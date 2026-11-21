import type { TurnOutcome, WindlassEvent } from "./contract.js";
import type { RunTurnResult } from "./sandbox/api.js";

export interface ProviderRefusal {
	kind: string;
	message: string;
}

// A rate limit this long needs an owner's decision before another factory turn is spent.
const LONG_RETRY_MS = 60_000;
const REFUSALS = new Set([
	"auth", "auth_required", "harness_signed_out", "permission_denied",
	"usage_limit", "insufficient_quota", "quota_exhausted",
	"model_not_found", "model_unavailable", "model_not_available", "content_policy", "context_overflow",
]);

/** The most recent model call only. A later attempt or execution supersedes its error. */
export function stepRefusal(previous: ProviderRefusal | null, event: WindlassEvent): ProviderRefusal | null {
	if (event.type === "execution.started" || event.type === "step.started" || event.type === "step.ended") return null;
	if (event.type === "step.refused") return { kind: "refusal", message: sentence(event.data?.message) };
	if (event.type !== "step.failed") return previous;
	const error = event.data?.error as { kind?: unknown; error?: Record<string, unknown> } | undefined;
	const provider = error?.error;
	if (error?.kind !== "provider" || typeof provider?.kind !== "string") return null;
	const { kind, status, code, retryable, retryAfterMs } = provider;
	const rateLimit = kind === "rate_limit" || status === 429;
	const terminal = REFUSALS.has(kind) || (typeof code === "string" && REFUSALS.has(code))
		|| status === 401 || status === 403 || status === 404
		|| (kind === "invalid_request" && retryable !== true)
		|| (rateLimit && (retryable === false || (typeof retryAfterMs === "number" && retryAfterMs >= LONG_RETRY_MS)));
	return terminal ? { kind, message: sentence(provider.message) } : null;
}

function sentence(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim() : "The provider gave no reason.";
}

/** The terminal outcome decides whether a step error, or an ACP refusal before the first step, ended this turn. */
export function turnRefusal(outcome: TurnOutcome, result: RunTurnResult | null, step: ProviderRefusal | null): ProviderRefusal | null {
	if (!result || result.aborted || result.timedOut || (outcome !== "failed" && outcome !== "error")) return null;
	const failure = result.failure;
	// A broken token hand-off or process is the platform's failure, even after a provider step error.
	if (failure?.reason === "token_unavailable" || failure?.reason === "engine") return null;
	if (step && (result.summary?.outcome === "failed" || failure?.reason === "execution_failed" || failure?.reason === "auth_required")) return step;
	if (failure && (REFUSALS.has(failure.reason) || failure.reason === "invalid_request")) return { kind: failure.reason, message: sentence(failure.message) };
	if (result.acp?.stopReason === "refusal") return { kind: "refusal", message: "The provider gave no reason." };
	return null;
}

export function refusalMessage(refusal: ProviderRefusal): string {
	return `The provider refused the request. ${refusal.message}`;
}
