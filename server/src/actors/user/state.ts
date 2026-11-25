// The user actor reloads its account indexes from SQLite on wake. Launch and submission claims live beside the session index.

import type { ItemsState } from "../user-items.js";
import type { RawAccess } from "rivetkit/db";
import type { MachineSummary, SessionSummary, UserProfile } from "../../contract.js";
import type { StoredConnection } from "../../github/repos.js";
import type { AccountModels } from "../../account-models.js";
import type { ListedSandbox } from "../../sandbox/api.js";
import type { ApprovalBook } from "../../server-approvals.js";
import type { Attempts, Submission } from "../../submissions.js";
import type { SignInHolder } from "../../signin/holder.js";
import type { UsageBook } from "../../usage.js";
import type { AccountCheckout } from "../../billing/account.js";

export interface UserVars {
	disconnectSweep?: Promise<void>;
	tokenGen: number;
	profile: UserProfile | null;
	// A valid token or adopted sign-in proves the account has been reached.
	reached: boolean;
	refused?: boolean;
	sessions: Map<string, SessionSummary>;
	launchUntil: Map<string, number>;
	// The persisted generation disambiguates overlapping and replayed launch releases.
	launchClaim: Map<string, number>;
	launchGen: number;
	// Keep each submission digest until its session is removed.
	created: Map<string, Submission & { id: string }>;
	creating: Attempts<SessionSummary>;
	signIn: Promise<SignInHolder> | null;
	// Use the current action's database handle when a cached sign-in holder writes.
	signInDb: RawAccess | null;
	approvals: ApprovalBook;
	github: StoredConnection | null;
	githubWriting: Promise<void>;
	models: AccountModels;
	usage: UsageBook;
	overageReport: Promise<void>;
	checkout: AccountCheckout;
	listed: { at: number; sandboxes: ListedSandbox[] } | null;
	/** Changes that can invalidate an in-flight provider listing: a create, release, or settled hold. */
	keptGeneration: number;
	items: ItemsState;
	machines: Map<string, MachineSummary>;
}

export interface UserCtx {
	vars: UserVars;
	db: RawAccess;
	broadcast(name: string, ...args: unknown[]): void;
}

export function boundedText(value: unknown, max: number): string {
	return typeof value === "string" && value.length <= max ? value : "";
}
