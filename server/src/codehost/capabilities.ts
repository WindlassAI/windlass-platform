import type { HostId } from "../contract.js";

/**
 * What a code host offers: one record per host. The platform decides by these flags, never by the host's id, so
 * one shared path serves every host and a host added later is one record more (as `sandbox/harnesses.ts` does for
 * agents). A `false` or "none" is often "not built yet" rather than "cannot". A flag nothing reads is removed.
 */
export interface HostCaps {
	/**
	 * Who the platform acts as there: the App's bot, told apart by its login, or the connected person, told apart by
	 * their account id (and by the marker on what the platform writes).
	 */
	actsAs: "app-bot" | "user";
	/** Where an item's verdict (`windlass/verified`) goes: an App check run a person can ask to run again, or nowhere yet. */
	verdict: "check-run" | "none";
	/** Pushes by others to an item's branch are read, so the item notices them. */
	pushEvents: boolean;
	/** Reviews and comments on the pull request reach the builder as feedback. */
	feedback: boolean;
	/** What wakes an item: one App webhook for every repository, routed by the repository directory, or the owner's per-project hook. */
	hooks: "app" | "project";
}

const HOSTS: Record<HostId, HostCaps> = {
	github: { actsAs: "app-bot", verdict: "check-run", pushEvents: true, feedback: true, hooks: "app" },
	gitlab: { actsAs: "user", verdict: "none", pushEvents: false, feedback: false, hooks: "project" },
};

/** A repository row written before GitLab has no provider: it is GitHub's. */
export function hostCaps(host: HostId | undefined): HostCaps {
	return HOSTS[host ?? "github"];
}
