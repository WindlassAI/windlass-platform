/**
 * Who may use the platform. Without a list, anyone with a configured provider account may sign in. With one
 * (WLP_ALLOWED_EMAILS, WLP_ALLOWED_USERS) only the accounts on it may, and it is asked at the sign-in
 * and again at every call (auth.ts), so taking someone off the list locks them out at once, although
 * the token they hold is good for a month. The demo sign-in has no account to list: WLP_DEMO alone
 * allows it, and switching it off stops the demo users who are signed in as well.
 */

import type { UserProfile } from "./contract.js";

export interface AccessRules {
	/** Whether demo users may use the platform. */
	demo: boolean;
	/** The accounts that may sign in; null when anyone may. */
	allowed: { emails: ReadonlySet<string>; uids: ReadonlySet<string> } | null;
}

export function normalizeEmail(email: unknown): string | null {
	return typeof email === "string" ? email.trim().toLowerCase() || null : null;
}

function items(raw: string | undefined, fold: boolean): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map(item => (fold ? item.trim().toLowerCase() : item.trim()))
			.filter(item => item !== ""),
	);
}

/** Reads the rules from the environment. Emails compare without case; user ids exactly. */
export function readAccessRules(env: Record<string, string | undefined> = process.env): AccessRules {
	const emails = items(env.WLP_ALLOWED_EMAILS, true);
	const uids = items(env.WLP_ALLOWED_USERS, false);
	return { demo: env.WLP_DEMO === "1", allowed: emails.size + uids.size > 0 ? { emails, uids } : null };
}

/** Whether this user may use the platform under these rules. */
export function mayUse(profile: Pick<UserProfile, "uid" | "email" | "demo">, rules: AccessRules): boolean {
	if (profile.demo) return rules.demo;
	if (rules.allowed === null) return true;
	if (rules.allowed.uids.has(profile.uid)) return true;
	const email = normalizeEmail(profile.email);
	return email !== null && rules.allowed.emails.has(email);
}

/** What an account that is not on the list is told when it signs in. */
export const NOT_INVITED =
	"This platform is by invitation for now, and this account is not on its list. Ask whoever runs it to add you.";
