/**
 * What GitHub says of a commit's CI, read for the factory (Plans "software factory" §2.1 step 4): the
 * check runs and commit statuses of the pushed head and, for a GitHub Actions job that failed, the end
 * of its log. When check output or a single annotation says the job never started, the Actions job
 * record must confirm it had no steps or runner. Read with an installation token asked for with the three read permissions CI needs
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
 * The polling intervals of the factory (slice 1) are here as data (`CI_POLLING`), not timers: the item
 * actor schedules its polls itself.
 *
 * GitHub's documentation, read 2026-11-19:
 *   check runs        https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference ("Checks: read")
 *   combined status   https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference ("Commit statuses: read")
 *   a job's log       https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run ("Actions: read"; a 302 to a short-lived address)
 *   rate limits       https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api (403 or 429; `x-ratelimit-remaining: 0` with `x-ratelimit-reset`, or `retry-after`)
 */

import type { GithubId } from "../contract.js";
import { decimalId, ownApp } from "./ids.js";
import { type GithubApp, GithubError } from "./app.js";
import { redact } from "./redact.js";

/** How often the factory looks at CI, and how long it waits for it (Plans "software factory" §2.1 steps 4 and 8, §4.2 "GitHub API"). */
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
	webhookEveryMs: 5 * 60_000,
	webhookCrowdedEveryMs: 10 * 60_000,
	webhookPrEveryMs: 30 * 60_000,
} as const;

export function ciPollEvery(openItems: number, webhooks = false): number {
	if (webhooks) return openItems > CI_POLLING.crowdedAbove ? CI_POLLING.webhookCrowdedEveryMs : CI_POLLING.webhookEveryMs;
	return openItems > CI_POLLING.crowdedAbove ? CI_POLLING.crowdedEveryMs : CI_POLLING.everyMs;
}

export const LOG_TAIL_LINES = 200;
export const LOG_TAIL_CHARS = 16_000;
export const LOG_MAX_BYTES = 16 * 1024 * 1024;
/** Logs are read for at most this many failing jobs per reading. */
export const LOGS_PER_READING = 3;
/** Actions job records read per reading to confirm that a job never started (one small request each). */
export const JOB_READS_PER_READING = 20;

/** One check run or commit status of the head. */
export interface CiRun {
	name: string;
	/** The app that reported it ("github-actions"), or "status" for a commit status. */
	app: string;
	state: "pending" | "passed" | "failed" | "not_run" | "cancelled" | "neutral";
	/** GitHub's word: a check run's `conclusion` (or its `status` while it runs), a status's `state`. */
	conclusion: string;
	url: string;
	/** The check output, job-not-started diagnostic, or status description. Untrusted and cut short. */
	summary: string;
	/** For a GitHub Actions check run: its job's id, whose log can be read. */
	jobId: string | null;
}

/** The end of a failing job's log. Untrusted: what code from the branch printed. */
export type CiLog = { name: string; untrusted: true; text: string; truncated: boolean } | { name: string; untrusted: true; text: null; why: string };

export type CiReading =
	| { kind: "read"; head: string; runs: CiRun[]; truncated: boolean; logs: CiLog[] }
	| { kind: "not_permitted"; said: string }
	| { kind: "rate_limited"; retryAt: number; said: string }
	| { kind: "failed"; said: string };

/**
 * What a reading comes to for the factory. "retry": nothing was learnt, look again later.
 * "incomplete": every run read has finished and none failed, but GitHub listed more than are read
 * (`truncated`): a failure may be among the rest, so it is not a pass. "skipped": CI ran, every run has
 * finished, none failed and none passed (all skipped or neutral): nothing in it verified the
 * work, which is not the same as no CI. "not_run": GitHub explicitly said a job never started.
 */
export type CiState = "cancelled" | "passed" | "not_run" | "failed" | "pending" | "none" | "skipped" | "not_permitted" | "incomplete" | "retry";

export function ciState(reading: CiReading): CiState {
	if (reading.kind === "not_permitted") return "not_permitted";
	if (reading.kind !== "read") return "retry";
	// Nothing usable read of a listing cut short is not "no CI": the rest of it was never seen.
	if (reading.runs.length === 0) return reading.truncated ? "incomplete" : "none";
	// A failure that was read stands, however much was not.
	if (reading.runs.some((run) => run.state === "failed")) return "failed";
	if (reading.runs.some((run) => run.state === "not_run")) return "not_run";
	if (reading.runs.some((run) => run.state === "pending")) return "pending";
	if (reading.truncated) return "incomplete";
	if (reading.runs.some((run) => run.state === "cancelled")) return "cancelled";
	// At least one check must have verified the work.
	return reading.runs.some((run) => run.state === "passed") ? "passed" : "skipped";
}

/** Conclusions of a completed check run that say the code failed something. "cancelled", "skipped", "stale" and "neutral" do not. */
const FAILING = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Strips what a terminal would interpret and anything that is not printable text. */
export function plain(value: string): string {
	return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
const short = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function refusal({ status, headers, said }: GithubError): CiReading {
	if (status === 0) return { kind: "failed", said: "GitHub could not be reached" };
	const now = Date.now();
	const retryAfter = Number(headers.get("retry-after"));
	const reset = Number(headers.get("x-ratelimit-reset"));
	const limited = status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || /rate limit/i.test(said)));
	if (limited) {
		const retryAt = Number.isFinite(retryAfter) && retryAfter > 0 ? now + retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + CI_POLLING.everyMs;
		return { kind: "rate_limited", retryAt: Math.max(retryAt, now), said };
	}
	if (status === 403) return { kind: "not_permitted", said };
	return { kind: "failed", said: `GitHub answered ${status}${said ? ` (${said})` : ""}` };
}

const notStarted = (message: string) => /^The job was not started because\b/i.test(message.trim());

type Candidate = { run: CiRun; jobId: string; diagnostic: string; annotationId: string };

function checkRunOf(fields: Record<string, unknown>, candidates: Candidate[]): CiRun | null {
	const name = text(fields.name);
	if (name === "") return null;
	const app = text(record(fields.app).slug) || "unknown";
	const status = text(fields.status);
	const conclusion = text(fields.conclusion);
	const state = status !== "completed" ? "pending" : FAILING.has(conclusion) ? "failed" : conclusion === "success" ? "passed" : conclusion === "cancelled" || conclusion === "stale" ? "cancelled" : "neutral";
	const output = record(fields.output);
	const summary = plain([text(output.title), text(output.summary)].filter((part) => part !== "").join(": "));
	const run: CiRun = { name, app, state, conclusion: status === "completed" ? conclusion : status, url: text(fields.html_url) || text(fields.details_url), summary: short(summary, 500), jobId: app === "github-actions" ? decimalId(fields.id) : null };
	if (run.jobId !== null && state === "failed" && conclusion === "failure") {
		const diagnostic = [text(output.title), text(output.summary)].find(notStarted) ?? "";
		if (diagnostic || output.annotations_count === 1) {
			candidates.push({ run, jobId: run.jobId, diagnostic, annotationId: diagnostic ? "" : text(fields.node_id) });
		}
	}
	return run;
}

function statusOf(value: unknown): CiRun | null {
	const fields = record(value);
	const name = text(fields.context);
	if (name === "") return null;
	const word = text(fields.state);
	const state = word === "success" ? "passed" : word === "pending" ? "pending" : "failed";
	return { name, app: "status", state, conclusion: word, url: text(fields.target_url), summary: short(plain(text(fields.description)), 500), jobId: null };
}

const priority: Record<CiRun["state"], number> = { neutral: 0, passed: 1, cancelled: 2, pending: 3, not_run: 4, failed: 5 };

/** GitHub allocates a new check-run id for each attempt. Discard superseded attempts before reading diagnostics. */
function latestAttempts(checks: Record<string, unknown>[]) {
	const latest = new Map<string, Record<string, unknown>>();
	for (const check of checks) {
		const key = JSON.stringify([record(check.app).slug, check.name]);
		const prior = latest.get(key);
		if (!prior || BigInt(decimalId(check.id) ?? 0) > BigInt(decimalId(prior.id) ?? 0)) latest.set(key, check);
	}
	return [...latest.values()];
}

/** If different reporters share a name, retain the most consequential current result. */
function distinctChecks(runs: CiRun[]): CiRun[] {
	const byName = new Map<string, CiRun>();
	for (const run of runs) {
		const prior = byName.get(run.name);
		if (!prior || priority[run.state] > priority[prior.state]) byName.set(run.name, run);
	}
	return [...byName.values()];
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
async function readLog(app: GithubApp, token: string, owner: string, name: string, run: CiRun & { jobId: string }): Promise<CiLog> {
	const none = (why: string): CiLog => ({ name: run.name, untrusted: true, text: null, why });
	let response: Response;
	try {
		response = await app.jobLog(token, owner, name, run.jobId);
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
	installationId: GithubId;
	repositoryId: GithubId;
	owner: string;
	name: string;
	/** The commit, a full SHA. */
	head: string;
}

export type CancelledJob = Pick<CiRun, "name" | "jobId">;

/** Request one retry per affected workflow, using the job record to bind its run to this commit. */
export async function rerunCancelled(app: GithubApp, target: CiTarget, jobs: CancelledJob[]) {
	const accepted: string[] = [];
	const problems = new Set<string>();
	const problem = (error: GithubError) => error.status === 403 && !error.rateLimited
		? "GitHub refused Actions: write for this installation" : error.message;
	const actions = jobs.filter((job): job is { name: string; jobId: string } => job.jobId !== null);
	const base = `/repos/${target.owner}/${target.name}/actions`;
	if (actions.length < jobs.length) problems.add("some cancelled checks have no GitHub Actions job");
	if (actions.length) {
		try {
			await app.withToken(target.installationId, { repositoryId: target.repositoryId, permissions: { metadata: "read", actions: "write" } }, async token => {
				const auth = { bearer: token };
				const workflows = new Map<string, string[]>();
				for (const { name, jobId } of actions) {
					let job: Record<string, unknown>;
					try {
						const { body } = await app.call({ path: `${base}/jobs/${jobId}`, auth, what: "find the cancelled job’s workflow run" });
						job = record(body);
					} catch (error) {
						if (!(error instanceof GithubError)) throw error;
						problems.add(problem(error));
						continue;
					}
					const runId = decimalId(job.run_id);
					if (!runId || job.head_sha !== target.head) {
						problems.add(`GitHub did not identify a workflow run on this commit for ${name}`);
						continue;
					}
					const ids = workflows.get(runId) ?? [];
					ids.push(jobId);
					workflows.set(runId, ids);
				}
				for (const [runId, ids] of workflows) {
					try {
						await app.call({ method: "POST", path: `${base}/runs/${runId}/rerun-failed-jobs`, auth, what: "rerun the failed jobs" });
						accepted.push(...ids);
					} catch (error) {
						if (!(error instanceof GithubError)) throw error;
						problems.add(problem(error));
					}
				}
			});
		} catch (error) {
			if (!(error instanceof GithubError)) throw error;
			problems.add(error.status === 422 ? "the installation did not grant Actions: write" : problem(error));
		}
	}
	const said = [accepted.length ? "Requested a GitHub Actions rerun for the cancelled checks." : "",
		problems.size ? `Could not request ${accepted.length ? "every" : "a"} rerun: ${[...problems].join(". ")}.` : ""].filter(Boolean).join(" ");
	return { accepted, said };
}

/** Resolve ambiguous failures before collapsing names or choosing any logs to download. */
async function readRuns(app: GithubApp, token: string, target: CiTarget, head: string, checks: unknown[], statuses: unknown[], truncated: boolean): Promise<CiReading> {
	const candidates: Candidate[] = [];
	let remainingJobReads = JOB_READS_PER_READING;
	const fromHead = checks.map(record).filter((fields) => (!fields.head_sha || fields.head_sha === head) && !ownApp(record(fields.app), app.settings));
	let runs = [...latestAttempts(fromHead).map((fields) => checkRunOf(fields, candidates)), ...statuses.map(statusOf)].filter((run): run is CiRun => run !== null);
	if (candidates.length) {
		let messages = new Map<string, string>();
		let unread: CiReading = { kind: "failed", said: "GitHub did not return the check annotations" };
		try {
			const ids = [...new Set(candidates.map(({ annotationId }) => annotationId).filter(Boolean))];
			if (ids.length) messages = await app.checkAnnotations(token, ids);
		} catch (error) {
			if (!(error instanceof GithubError)) throw error;
			unread = refusal(error);
		}
		const missing = new Set<CiRun>();
		for (const { run, jobId, diagnostic, annotationId } of candidates) {
			const message = diagnostic || messages.get(annotationId);
			if (message && !notStarted(message)) continue;
			// Past the budget a candidate is unread, not failed: it may be one more job that never started.
			if (remainingJobReads === 0) { missing.add(run); continue; }
			remainingJobReads--;
			// Workflows can write all three forms of the diagnostic. Only GitHub's job record can corroborate it.
			try {
				if (!(await app.jobNeverStarted(token, target.owner, target.name, jobId))) continue;
			} catch (error) {
				if (!(error instanceof GithubError)) throw error;
				continue;
			}
			if (message) {
				run.state = "not_run";
				run.summary = short(redact(plain(message.trim())), 500);
			} else {
				missing.add(run);
			}
		}
		// An unread annotation cannot establish a code failure. An independent, confirmed failure still stands.
		if (missing.size) {
			runs = runs.filter((run) => !missing.has(run));
			if (!runs.some((run) => run.state === "failed")) return unread;
			truncated = true;
		}
	}
	runs = distinctChecks(runs);
	const failing = runs.filter((run): run is CiRun & { jobId: string } => run.state === "failed" && run.jobId !== null).slice(0, LOGS_PER_READING);
	const logs: CiLog[] = [];
	for (const run of failing) logs.push(await readLog(app, token, target.owner, target.name, run));
	return { kind: "read", head, runs, truncated, logs };
}

/** Reads the CI of a commit. Never throws for anything GitHub answers: every outcome is a `CiReading`. */
export async function readCi(app: GithubApp, target: CiTarget): Promise<CiReading> {
	// GitHub's answer to a call of the reading, as against one to the request for its token.
	let answered: GithubError | null = null;
	try {
		return await app.withToken(target.installationId, { repositoryId: target.repositoryId, permissions: { metadata: "read", checks: "read", statuses: "read", actions: "read" } }, async (token) => {
			try {
				const base = `/repos/${target.owner}/${target.name}/commits/${target.head}`;
				const auth = { bearer: token };
				const checks = await app.pages({ path: `${base}/check-runs`, auth, what: "list check runs" }, (body) => {
					const list = record(body).check_runs;
					return Array.isArray(list) ? list : [];
				});
				// The combined status names the commit GitHub answered for: the reading is of that commit, which is checked against the one asked of it.
				let answeredFor = "";
				const statuses = await app.pages({ path: `${base}/status`, auth, what: "read commit statuses" }, (body) => {
					const { sha, statuses: list } = record(body);
					if (answeredFor === "" && typeof sha === "string") answeredFor = sha;
					return Array.isArray(list) ? list : [];
				});
				const head = answeredFor || (/^[0-9a-f]{40}$/i.test(target.head) ? target.head : text(record(checks.items[0]).head_sha) || target.head);
				return await readRuns(app, token, target, head, checks.items, statuses.items, checks.truncated || statuses.truncated);
			} catch (error) {
				// Thrown on, so that a kept token GitHub no longer takes is replaced by a new one (`withToken`'s `reuse`).
				if (error instanceof GithubError) answered = error;
				throw error;
			}
		}, { reuse: true });
	} catch (error) {
		if (!(error instanceof GithubError)) throw error;
		if (error === answered) return refusal(error);
		// The token itself was refused: 422 when the installation does not have, or has not accepted, a permission asked for.
		if (error.status === 422) return { kind: "not_permitted", said: error.said };
		// Otherwise as any answer of GitHub's: a limit by its headers, before a 403 is taken for a refusal.
		return refusal(error);
	}
}
