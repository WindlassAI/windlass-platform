import type { GithubId } from "../contract.js";

const digits = /^[0-9]{1,20}$/;

/** Node 24 supplies the original token, even when the parsed number has lost precision. */
export function parseGithubJson(raw: string): unknown {
	return JSON.parse(raw, (key: string, value: unknown, context?: { source?: string }) => {
		if ((key === "id" || key === "installation_id" || key === "repository_id") && typeof value === "number") {
			const source = context?.source;
			return source && digits.test(source) ? source : null;
		}
		return value;
	});
}

export function decimalId(value: unknown): string | null {
	if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
	return typeof value === "string" && digits.test(value) ? value : null;
}

/** Account, repository and installation keys are positive database IDs. Keep the existing JSON
 * number representation where exact. SQLite also stores these keys as signed 64-bit integers. */
export function githubId(value: unknown): GithubId | null {
	const id = decimalId(value);
	if (!id || id.startsWith("0") || BigInt(id) > 9223372036854775807n) return null;
	const n = Number(id);
	return Number.isSafeInteger(n) ? n : id;
}

export function isGithubId(value: unknown): value is GithubId {
	return value != null && githubId(value) === value;
}

/** Serialize an ID as a JSON integer for APIs that require an integer in the request body. */
export function githubJsonInteger(id: GithubId): unknown {
	if (!isGithubId(id)) throw new Error("Invalid GitHub id");
	return typeof id === "number" ? id : (JSON as JSON & { rawJSON(source: string): unknown }).rawJSON(id);
}
