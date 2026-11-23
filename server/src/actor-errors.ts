/** Whether a call failed because the actor it was meant for does not exist (any more). */
export function isActorGone(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { group, code } = error as { group?: unknown; code?: unknown };
	return group === "actor" && (code === "not_found" || code === "destroying" || code === "destroyed");
}

/** A session also answers this way between the start of deletion and the actor's destruction. */
export function isSessionGone(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { group, code } = error as { group?: unknown; code?: unknown };
	return (group === "user" && code === "session_not_found") || isActorGone(error);
}
