/**
 * Checks server/src/access.ts: who may use the platform under WLP_ALLOWED_EMAILS, WLP_ALLOWED_USERS
 * and WLP_DEMO.
 *
 *   cd server && npx tsx ../scripts/access-check.ts
 */

import { mayUse, readAccessRules } from "../server/src/access.js";

interface Profile {
	uid: string;
	email: string | null;
	demo: boolean;
}

const listed: Profile = { uid: "u_listed", email: "Someone@Example.com", demo: false };
const byUid: Profile = { uid: "u_owner", email: null, demo: false };
const stranger: Profile = { uid: "u_stranger", email: "other@example.com", demo: false };
const demo: Profile = { uid: "demo_1", email: null, demo: true };

const cases: Array<[what: string, env: Record<string, string>, profile: Profile, want: boolean]> = [
	["no list: anyone with an account", {}, stranger, true],
	["no list, demo off: no demo user", {}, demo, false],
	["demo on: a demo user", { WLP_DEMO: "1" }, demo, true],
	["a list does not let the demo in", { WLP_ALLOWED_USERS: "demo_1" }, demo, false],
	["a list does not keep the demo out", { WLP_DEMO: "1", WLP_ALLOWED_EMAILS: "someone@example.com" }, demo, true],
	[
		"on the list by email, whatever the case",
		{ WLP_ALLOWED_EMAILS: " other@x.org , SOMEONE@example.com " },
		listed,
		true,
	],
	["on the list by user id", { WLP_ALLOWED_USERS: "u_owner" }, byUid, true],
	["user ids compare exactly", { WLP_ALLOWED_USERS: "U_OWNER" }, byUid, false],
	["not on the list", { WLP_ALLOWED_EMAILS: "someone@example.com", WLP_ALLOWED_USERS: "u_owner" }, stranger, false],
	["no email, and not listed by id", { WLP_ALLOWED_EMAILS: "someone@example.com" }, byUid, false],
	["a list of only commas is no list", { WLP_ALLOWED_EMAILS: " , ", WLP_ALLOWED_USERS: "" }, stranger, true],
];

let failed = 0;
for (const [what, env, profile, want] of cases) {
	const got = mayUse(profile, readAccessRules(env));
	console.log(`${got === want ? "PASS" : "FAIL"}  ${what}  (${got ? "may" : "may not"})`);
	if (got !== want) failed += 1;
}
console.log(`\n${failed === 0 ? "ALL PASSED: " : ""}${cases.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
