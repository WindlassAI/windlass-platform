import type { CiTarget } from "./ci.js";
import type { HostCaps } from "./capabilities.js";
import type { CodeHost, Pull } from "./types.js";

/**
 * An item's repository as the owner's connection reaches it now, in one shape for every code host. Resolve it for
 * each effect and never persist it: it may hold a grant.
 */
export interface ItemHost {
	host: Pick<
		CodeHost<unknown, unknown, unknown>,
		"readPull" | "readCi" | "rerunJobs" | "listComments" | "createComment" | "updateComment"
	>;
	owner: string;
	name: string;
	target(head: string): CiTarget;
	pull(number: number): Promise<Pull>;
	/** Runs `step` with a token for the repository. GitHub scopes an installation token to metadata and `permissions`. */
	withToken<T>(permissions: Record<string, "read" | "write">, step: (token: string) => Promise<T>): Promise<T>;
	/** Whether a pull request comment is the platform's own. */
	ownComment(comment: { author: string; person: { id: number | string } | null }): boolean;
	/** Marks a feedback comment, review or issue as seen. */
	acknowledge(key: string): Promise<void>;
	/** The project's web address, for links a GitHub address would get wrong. */
	webUrl?: string;
	/** What the host offers beyond `CodeHost`. Callers branch on these, not on the provider. */
	caps: HostCaps;
	/** Changes reach the item through webhooks, so its polls can be sparse. */
	webhooks: boolean;
}
