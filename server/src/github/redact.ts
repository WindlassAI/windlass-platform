/**
 * Keeps credentials out of what is shown or logged. Text that comes back from GitHub or from git (an
 * error's message, the end of standard error) passes through here before it goes anywhere: the tokens
 * the caller knows it used are taken out by value, in the forms they travel in, and anything else
 * that looks like a GitHub token by its prefix.
 */

/** GitHub's token prefixes: installation (`ghs_`), user (`ghu_`), refresh (`ghr_`), OAuth, personal. */
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9_.-]{16,}|github_pat_[A-Za-z0-9_]{20,})/g;
/** A credential in an address (`https://user:secret@host`) and in a header. */
const URL_CREDENTIAL = /(\bhttps?:\/\/)[^\s/@:]+:[^\s/@]+@/g;
const HEADER_CREDENTIAL = /\b(authorization:\s*(?:basic|bearer|token)\s+)[A-Za-z0-9._~+/=-]+/gi;

export function redact(text: string, secrets: Array<string | null | undefined> = []): string {
	let out = text;
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret.length < 6) continue;
		const forms = [secret, Buffer.from(secret, "utf8").toString("base64"), Buffer.from(`x-access-token:${secret}`, "utf8").toString("base64"), encodeURIComponent(secret)];
		for (const form of forms) out = out.split(form).join("[redacted]");
	}
	return out.replace(TOKEN_SHAPE, "[redacted]").replace(URL_CREDENTIAL, "$1[redacted]@").replace(HEADER_CREDENTIAL, "$1[redacted]");
}
