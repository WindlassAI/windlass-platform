/**
 * What GitHub says of a commit's CI, read for the factory (Plans "software factory" §2.1 step 4): the
 * check runs and commit statuses of the pushed head and, for a GitHub Actions job that failed, the end
 * of its log. Read with an installation token asked for with the three read permissions CI needs
 * (Checks, Commit statuses, Actions) and nothing else, used for one reading and dropped.
 *
 * Every reading ends as one of four outcomes, and the four are never confused, because the factory acts
 * on each differently:
 *
 *   read            what GitHub has: possibly nothing yet, possibly still running (`ciState`)
 *   not_permitted   GitHub will not show this installation the commit's CI: the app lacks a permission,
 *                   the installation has not accepted it, or GitHub answered 403 for another reason.
 *                   Waiting does not help; the item is handed over saying so
 *   rate_limited    GitHub asks to wait, until `retryAt`: a primary limit (`x-ratelimit-reset`) or a
 *                   secondary one (`retry-after`)
 *   failed          GitHub could not be reached or answered something else; the next poll tries again
 *
 * A log is untrusted text: it is what code from the branch printed in CI, so it is marked as such, has
 * control characters and anything that looks like a token taken out, and is cut to its last
 * LOG_TAIL_LINES lines and LOG_TAIL_CHARS characters. It is read as a stream, keeping only its end, and
 * no further than LOG_MAX_BYTES.
 *
 * Why this file makes its own requests instead of `GithubApp`'s: that client (app.ts) returns parsed
 * JSON without the response's headers and follows redirects with the token attached. A reading needs
 * the rate-limit headers to tell a limit from a refusal, and a log is a redirect to storage outside
 * GitHub that must be fetched without the token. Everything else is the client's: the same API address,
 * version, user agent and error type, and `withToken` for the token.
 *
 * The polling intervals of the factory (slice 1) are here as data (`CI_POLLING`), not timers: the item
 * actor schedules its polls itself.
 *
 * GitHub's documentation, read 2026-11-19:
 *   check runs        https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference ("Checks: read")
 *   combined status   https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference ("Commit statuses: read")
 *   a job's log       https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run ("Actions: read"; a 302 to a short-lived address)
 *   rate limits       https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api (403 or 429; `x-ratelimit-remaining: 0` with `x-ratelimit-reset`, or `retry-after`)
 */

import { GITHUB_API_VERSION, type GithubApp, GithubError } from "./app.js";
import { redact } from "./redact.js";

/** How often the factory looks at CI, and how long it waits for it (slice 1's brief, §2.1 steps 4 and 8, §4.2 "GitHub API"). */
export const CI_POLLING = {
	/** While an item waits for CI. */
	everyMs: 60_000,
	/** The same, while the user has more than `crowdedAbove` items open: keeps an installation under GitHub's hourly limit. */
	crowdedEveryMs: 180_000,
	crowdedAbove: 10,
	/** No check run and no status this long after the push: the repository has no CI. */
	noneAfterMs: 10 * 60_000,
	/** CI still running this long after the push: a person is asked. */
	timeoutMs: 90 * 60_000,
	/** While an item is in review: is its pull request merged or closed. */
	prEveryMs: 10 * 60_000,
} as const;

export function ciPollEvery(openItems: number): number {
	return openItems > CI_POLLING.crowdedAbove ? CI_POLLING.crowdedEveryMs : CI_POLLING.everyMs;
}

/** The permissions a reading's token is asked for. `TokenScope` names only those the rest of the platform uses, so this is assigned to it rather than written in it. */
const CI_PERMISSIONS = { metadata: "read", checks: "read", statuses: "read", actions: "read" } as const;

export const LOG_TAIL_LINES = 200;
export const LOG_TAIL_CHARS = 16_000;
export const LOG_MAX_BYTES = 16 * 1024 * 1024;
/** Logs are read for at most this many failing jobs per reading. */
export const LOGS_PER_READING = 3;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "windlass-platform";

/** One check run or commit status of the head. */
export interface CiRun {
	name: string;
	/** The app that reported it ("github-actions"), or "status" for a commit status. */
	app: string;
	state: "pending" | "passed" | "failed" | "neutral";
	/** GitHub's word: a check run's `conclusion` (or its `status` while it runs), a status's `state`. */
	conclusion: string;
	url: string;
	/** The run's output title and summary, or the status's description: written by CI, so untrusted, and cut short. */
	summary: string;
	/** For a GitHub Actions check run: its job's id, whose log can be read. */
	jobId: number | null;
}

/** The end of a failing job's log. Untrusted: what code from the branch printed. */
export type CiLog = { name: string; untrusted: true; text: string; truncated: boolean } | { name: string; untrusted: true; text: null; why: string };

export type CiReading =
	| { kind: "read"; head: string; runs: CiRun[]; truncated: boolean; logs: CiLog[] }
	| { kind: "not_permitted"; said: string }
	| { kind: "rate_limited"; retryAt: number; said: string }
	| { kind: "failed"; said: string };

/** What a reading comes to for the factory. "retry": nothing was learnt, look again later. */
export type CiState = "passed" | "failed" | "pending" | "none" | "not_permitted" | "retry";

export function ciState(reading: CiReading): CiState {
	if (reading.kind === "not_permitted") return "not_permitted";
	if (reading.kind !== "read") return "retry";
	if (reading.runs.length === 0) return "none";
	if (reading.runs.some((run) => run.state === "failed")) return "failed";
	if (reading.runs.some((run) => run.state === "pending")) return "pending";
	return "passed";
}

/** Conclusions of a completed check run that say the code failed something. "cancelled", "skipped", "stale" and "neutral" do not. */
const FAILING = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const whole = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);

/** Strips what a terminal would interpret and anything that is not printable text. */
function plain(value: string): string {
	return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
const short = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Thrown inside a reading to end it with an outcome other than "read". */
class Ended {
	constructor(readonly reading: Exclude<CiReading, { kind: "read" }>) {}
}

function refusal(status: number, headers: Headers, said: string, now: number): Ended {
	const retryAfter = Number(headers.get("retry-after"));
	const reset = Number(headers.get("x-ratelimit-reset"));
	const limited = status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || /rate limit/i.test(said)));
	if (limited) {
		const retryAt = Number.isFinite(retryAfter) && retryAfter > 0 ? now + retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + CI_POLLING.everyMs;
		return new Ended({ kind: "rate_limited", retryAt: Math.max(retryAt, now), said });
	}
	if (status === 403) return new Ended({ kind: "not_permitted", said });
	return new Ended({ kind: "failed", said: `GitHub answered ${status}${said ? ` (${said})` : ""}` });
}

async function get(app: GithubApp, token: string, path: string, query: Record<string, string | number>): Promise<{ body: unknown; next: boolean }> {
	const url = new URL(`${app.settings.apiUrl}${path}`);
	for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
	let response: Response;
	try {
		response = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	} catch {
		throw new Ended({ kind: "failed", said: "GitHub could not be reached" });
	}
	const raw = await response.text().catch(() => "");
	let body: unknown = null;
	try {
		body = raw === "" ? null : JSON.parse(raw);
	} catch {
		body = null;
	}
	if (!response.ok) throw refusal(response.status, response.headers, redact(short(text(record(body).message).replace(/\s+/g, " "), 300), [token]), Date.now());
	return { body, next: /rel="next"/.test(response.headers.get("link") ?? "") };
}

function headers(token: string): Record<string, string> {
	return { accept: "application/vnd.github+json", "user-agent": USER_AGENT, "x-github-api-version": GITHUB_API_VERSION, authorization: `Bearer ${token}` };
}

/** Every page of a listing, up to MAX_PAGES; `truncated` when there were more. */
async function pages(app: GithubApp, token: string, path: string, read: (body: unknown) => unknown[]): Promise<{ items: unknown[]; truncated: boolean }> {
	const items: unknown[] = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const answer = await get(app, token, path, { per_page: PAGE_SIZE, page });
		items.push(...read(answer.body));
		if (!answer.next) return { items, truncated: false };
	}
	return { items, truncated: true };
}

function checkRunOf(value: unknown): CiRun | null {
	const fields = record(value);
	const name = text(fields.name);
	if (name === "") return null;
	const app = text(record(fields.app).slug) || "unknown";
	const status = text(fields.status);
	const conclusion = text(fields.conclusion);
	const state = status !== "completed" ? "pending" : FAILING.has(conclusion) ? "failed" : conclusion === "success" ? "passed" : "neutral";
	const output = record(fields.output);
	const summary = plain([text(output.title), text(output.summary)].filter((part) => part !== "").join(": "));
	return { name, app, state, conclusion: status === "completed" ? conclusion : status, url: text(fields.html_url) || text(fields.details_url), summary: short(summary, 500), jobId: app === "github-actions" ? whole(fields.id) : null };
}

function statusOf(value: unknown): CiRun | null {
	const fields = record(value);
	const name = text(fields.context);
	if (name === "") return null;
	const word = text(fields.state);
	const state = word === "success" ? "passed" : word === "pending" ? "pending" : "failed";
	return { name, app: "status", state, conclusion: word, url: text(fields.target_url), summary: short(plain(text(fields.description)), 500), jobId: null };
}

/** The end of a text as a log tail: no timestamps GitHub put before each line, no control characters, no tokens. */
export function logTail(raw: string, cut: boolean): { text: string; truncated: boolean } {
	const lines = redact(plain(raw.replace(/\r\n?/g, "\n")))
		.split("\n")
		.map((line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/, ""));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	let truncated = cut || lines.length > LOG_TAIL_LINES;
	let tail = lines.slice(-LOG_TAIL_LINES).join("\n");
	if (tail.length > LOG_TAIL_CHARS) {
		tail = tail.slice(-LOG_TAIL_CHARS);
		truncated = true;
	}
	return { text: tail, truncated };
}

/**
 * A failing job's log. GitHub answers with a redirect to a short-lived address at its storage, which is
 * fetched without the token. Only the end is kept while it streams; a log larger than LOG_MAX_BYTES is
 * not read to its end, and none of it is returned, since its end is what matters.
 */
async function readLog(app: GithubApp, token: string, owner: string, name: string, run: CiRun & { jobId: number }): Promise<CiLog> {
	const none = (why: string): CiLog => ({ name: run.name, untrusted: true, text: null, why });
	let response: Response;
	try {
		response = await fetch(`${app.settings.apiUrl}/repos/${owner}/${name}/actions/jobs/${run.jobId}/logs`, { headers: headers(token), redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel();
			response = await fetch(new URL(location, app.settings.apiUrl), { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		}
	} catch {
		return none("the log could not be fetched");
	}
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		if (response.status === 403 || response.status === 429) return none("GitHub did not allow reading the log");
		if (response.status === 404 || response.status === 410) return none("GitHub no longer has the log");
		return none(`GitHub answered ${response.status} for the log`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let kept = "";
	let bytes = 0;
	let cut = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > LOG_MAX_BYTES) {
				await reader.cancel();
				return none(`the log is larger than ${LOG_MAX_BYTES / 1024 / 1024} MiB and was not read to its end`);
			}
			kept += decoder.decode(value, { stream: true });
			// Keep twice the tail, so a line cut here is not the first one kept.
			if (kept.length > LOG_TAIL_CHARS * 2) {
				kept = kept.slice(-LOG_TAIL_CHARS * 2);
				cut = true;
			}
		}
		kept += decoder.decode();
	} catch {
		return none("the log could not be read to its end");
	}
	const tail = logTail(kept, cut);
	return { name: run.name, untrusted: true, ...tail };
}

export interface CiTarget {
	installationId: number;
	repositoryId: number;
	owner: string;
	name: string;
	/** The commit, a full SHA. */
	head: string;
}

/** Reads the CI of a commit. Never throws for anything GitHub answers: every outcome is a `CiReading`. */
export async function readCi(app: GithubApp, target: CiTarget): Promise<CiReading> {
	try {
		return await app.withToken(target.installationId, { repositoryId: target.repositoryId, permissions: CI_PERMISSIONS }, async (token) => {
			try {
				const base = `/repos/${target.owner}/${target.name}/commits/${target.head}`;
				const checks = await pages(app, token, `${base}/check-runs`, (body) => {
					const list = record(body).check_runs;
					return Array.isArray(list) ? list : [];
				});
				const statuses = await pages(app, token, `${base}/status`, (body) => {
					const list = record(body).statuses;
					return Array.isArray(list) ? list : [];
				});
				const runs = [...checks.items.map(checkRunOf), ...statuses.items.map(statusOf)].filter((run): run is CiRun => run !== null);
				const failing = runs.filter((run): run is CiRun & { jobId: number } => run.state === "failed" && run.jobId !== null).slice(0, LOGS_PER_READING);
				const logs: CiLog[] = [];
				for (const run of failing) logs.push(await readLog(app, token, target.owner, target.name, run));
				return { kind: "read", head: target.head, runs, truncated: checks.truncated || statuses.truncated, logs } satisfies CiReading;
			} catch (error) {
				if (error instanceof Ended) return error.reading;
				throw error;
			}
		});
	} catch (error) {
		if (!(error instanceof GithubError)) throw error;
		// The token itself was refused: 422 when the installation does not have, or has not accepted, a permission asked for.
		if (error.status === 422 || error.status === 403) return { kind: "not_permitted", said: error.said };
		if (error.status === 429) return { kind: "rate_limited", retryAt: Date.now() + CI_POLLING.everyMs, said: error.said };
		return { kind: "failed", said: error.unreachable ? "GitHub could not be reached" : error.said };
	}
}
