import type { TurnOutcome, UsageWindow, WindlassEvent } from "./contract.js";
import type { RunTurnResult } from "./sandbox/api.js";
import { MINUTE, resetTime, usageRefusal, utcReset, type UsageObservation } from "./provider-usage.js";

export interface ProviderRefusal {
	window?: UsageWindow;
	retryAfterMs?: number;
	resetsAt?: number;
	kind: string;
	message: string;
}

// A shorter retry remains inside the current provider call.
const LONG_RETRY_MS = MINUTE;
const REFUSALS = new Set([
	"auth", "auth_required", "harness_signed_out", "permission_denied",
	"usage_limit", "insufficient_quota", "quota_exhausted",
	"model_not_found", "model_unavailable", "model_not_available", "content_policy", "context_overflow",
	// The machine relay's own refusals as an agent passes them on (acp-harness.ts): the provider answered an error, or nothing.
	"provider_rejected", "provider_unavailable",
]);

/** Keep routing facts, including short scheduled retries, without retaining the provider's raw account data. */
export function publicUsageEvent(event: WindlassEvent, previous: ProviderRefusal | null): WindlassEvent {
	const message = "The provider's usage or rate limit was reached.";
	if (event.type === "execution.failed" && previous && usageRefusal(previous.kind))
		return { ...event, data: { executionId: event.data?.executionId, message } };
	if (event.type !== "step.failed") return event;
	const error = event.data?.error as { kind?: unknown; error?: Record<string, unknown> } | undefined;
	const provider = error?.error;
	if (error?.kind !== "provider" || !provider) return event;
	const { kind, code, status, retryable, retryAfterMs } = provider;
	const limitKind = typeof kind === "string" && usageRefusal(kind) ? kind : undefined;
	const limitCode = typeof code === "string" && usageRefusal(code) ? code : undefined;
	if (!limitKind && !limitCode && status !== 429) return event;
	return { ...event, data: { ...event.data, error: { kind: "provider", error: { kind: limitKind ?? limitCode ?? "rate_limit", code: limitCode ?? null,
		status: typeof status === "number" ? status : null, retryable: typeof retryable === "boolean" ? retryable : null, retryAfterMs: resetTime(retryAfterMs) ?? null, message } } } };
}

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
		|| status === 401 || status === 403 || status === 404 || (status === 429 && retryable !== true)
		|| (kind === "invalid_request" && retryable !== true)
		|| (rateLimit && (retryable === false || (typeof retryAfterMs === "number" && retryAfterMs >= LONG_RETRY_MS)));
	if (!terminal) return null;
	let reason = kind;
	if (status === 429) reason = "usage_limit";
	else if (!usageRefusal(kind) && typeof code === "string" && usageRefusal(code)) reason = code;
	const delay = resetTime(retryAfterMs);
	return { kind: reason, message: sentence(provider.message), ...(usageRefusal(reason) && delay !== undefined && { retryAfterMs: delay }) };
}

function sentence(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim() : "The provider gave no reason.";
}

/**
 * Windlass refuses a session whose host tools it cannot use, with its own sentence (its `hostToolsProblem`: a name, a
 * timeout, an input schema), as an invalid request. That is the platform's fault, which no retry and no other model
 * mends: its own kind, `PLATFORM_TOOLS`, is never shown as the provider's refusal.
 */
export const PLATFORM_TOOLS = "platform_tools";
const HOST_TOOL_PROBLEM = /^the (?:inputSchema|timeoutSeconds) of the host tool "|^the host tool (?:name )?"/i;

/** The terminal outcome decides whether a step error, or an ACP refusal before the first step, ended this turn. */
export function turnRefusal(outcome: TurnOutcome, result: RunTurnResult | null, step: ProviderRefusal | null): ProviderRefusal | null {
	const refusal = providerTurnRefusal(outcome, result, step);
	return refusal?.kind === "invalid_request" && HOST_TOOL_PROBLEM.test(refusal.message) ? { kind: PLATFORM_TOOLS, message: refusal.message } : refusal;
}

function providerTurnRefusal(outcome: TurnOutcome, result: RunTurnResult | null, step: ProviderRefusal | null): ProviderRefusal | null {
	if (!result || result.aborted || result.timedOut || (outcome !== "failed" && outcome !== "error")) return null;
	const failure = result.failure;
	// A broken token hand-off or process is the platform's failure, even after a provider step error.
	if (failure?.reason === "token_unavailable" || failure?.reason === "engine") return null;
	if (step && (result.summary?.outcome === "failed" || failure?.reason === "execution_failed" || failure?.reason === "auth_required")) return step;
	if (failure && (REFUSALS.has(failure.reason) || failure.reason === "invalid_request")) return { kind: failure.reason, message: sentence(failure.message), ...(failure.window && { window: failure.window }), ...(usageRefusal(failure.reason) && resetTime(failure.resetsAt) !== undefined && { resetsAt: failure.resetsAt }) };
	if (result.acp?.stopReason === "refusal") return { kind: "refusal", message: "The provider gave no reason." };
	return null;
}

export function limitObservation(refusal: ProviderRefusal | null, at: number): UsageObservation | null {
	if (!refusal || !usageRefusal(refusal.kind)) return null;
	return { kind: "refusal", at, resetsAt: refusal.resetsAt ?? null, window: refusal.window };
}

export function refusalMessage(refusal: ProviderRefusal): string {
	if (refusal.kind === PLATFORM_TOOLS) return `The turn did not run: Windlass could not use one of the tools the platform gives the agent. This is a fault in the platform, not a refusal by the provider, and trying again fails the same way until the platform is fixed. Windlass said: ${refusal.message}`;
	// A sentence that already says what the provider did is not prefixed again.
	const said = refusal.kind === "provider_unavailable" || refusal.kind === "provider_rejected" ? refusal.message : `The provider refused the request. ${refusal.message}`;
	return said + (refusal.resetsAt !== undefined ? ` The limit resets at ${new Date(refusal.resetsAt).toISOString().slice(0, 10)} ${utcReset(refusal.resetsAt)}.` : "");
}
