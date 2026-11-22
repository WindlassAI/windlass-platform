/**
 * A cross-repo feature's combined run on GitHub Actions (factory/cross-repo.ts): the integration
 * workflow of the plan's `runFrom` repository, dispatched on that repository's feature branch with the
 * head of every repository of the feature. The workflow (`.github/workflows/windlass-integration.yml`
 * in this repository is the reference) checks each input out at its commit beside the `runFrom`
 * checkout, verifies the commits, and runs the approved command. Its run name carries the feature and
 * the attempt, so a dispatch whose answer was lost is found again rather than started twice.
 *
 * The App needs Actions write on that repository's installation to dispatch, and read to follow the run.
 */

import { GithubError, type GithubApp } from "./app.js";

/** The workflow file the platform dispatches, in `.github/workflows/` of the `runFrom` repository. */
export const INTEGRATION_WORKFLOW = "windlass-integration.yml";

const record = (v: unknown) => (v ?? {}) as Record<string, unknown>;

/** What a run is named, by the workflow's `run-name`: how the platform finds its own run. */
export const runName = (item: string, attempt: number) => `windlass-integration ${item} ${attempt}`;

/** Whether the repository has the integration workflow, enabled, and in the tree at `ref`. */
export async function hasIntegrationWorkflow(app: GithubApp, token: string, owner: string, repo: string, ref: string): Promise<boolean> {
	try {
		const { body } = await app.call({ path: `/repos/${owner}/${repo}/actions/workflows/${INTEGRATION_WORKFLOW}`, auth: { bearer: token }, what: "look for the integration workflow" });
		if (record(body).state !== "active") return false;
		await app.fileAt(token, owner, repo, ".github/workflows/" + INTEGRATION_WORKFLOW, ref);
		return true;
	} catch (error) {
		if (error instanceof GithubError && error.status === 404) return false;
		throw error;
	}
}

export interface IntegrationInput {
	/** The `runFrom` repository's feature branch: the workflow runs from it. */
	ref: string;
	item: string;
	attempt: number;
	/** Every input, by alias: its repository ("owner/name") and the commit to test. */
	heads: Record<string, { repository: string; sha: string }>;
	runFrom: string;
	command: string;
	timeoutSeconds: number;
}

export type RunState = "queued" | "running" | "passed" | "failed" | "cancelled" | "timed_out";
export interface RunReading { runId: string; url: string | null; state: RunState; said: string | null; seconds?: number }

function readingOf(value: unknown): RunReading {
	const run = record(value);
	const runId = String(run.id ?? "");
	const url = typeof run.html_url === "string" ? run.html_url : null;
	if (run.status !== "completed") return { runId, url, state: run.status === "queued" || run.status === "waiting" || run.status === "requested" || run.status === "pending" ? "queued" : "running", said: null };
	const started = Date.parse(String(run.run_started_at ?? run.created_at ?? "")), ended = Date.parse(String(run.updated_at ?? ""));
	const seconds = Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? Math.ceil((ended - started) / 1000) : undefined;
	const conclusion = String(run.conclusion ?? "");
	const state: RunState = conclusion === "success" ? "passed" : conclusion === "cancelled" ? "cancelled" : conclusion === "timed_out" ? "timed_out" : "failed";
	return { runId, url, state, said: state === "failed" ? `the run ended ${conclusion || "without a conclusion"}` : null, ...(seconds !== undefined && { seconds }) };
}

/** The platform's run of this attempt, if GitHub lists one: a dispatch whose answer was lost is found here. */
export async function findIntegrationRun(app: GithubApp, token: string, owner: string, repo: string, ref: string, item: string, attempt: number): Promise<RunReading | null> {
	const { body } = await app.call({ path: `/repos/${owner}/${repo}/actions/workflows/${INTEGRATION_WORKFLOW}/runs`, query: { event: "workflow_dispatch", branch: ref, per_page: 30 }, auth: { bearer: token }, what: "look for the combined run" });
	const runs = record(body).workflow_runs;
	const name = runName(item, attempt);
	const found = Array.isArray(runs) ? runs.find(r => record(r).display_title === name || record(r).name === name) : undefined;
	return found ? readingOf(found) : null;
}

/** Starts the run, or finds the one started for this attempt already. */
export async function dispatchIntegration(app: GithubApp, token: string, owner: string, repo: string, input: IntegrationInput): Promise<RunReading | null> {
	const before = await findIntegrationRun(app, token, owner, repo, input.ref, input.item, input.attempt);
	if (before) return before;
	await app.call({ method: "POST", path: `/repos/${owner}/${repo}/actions/workflows/${INTEGRATION_WORKFLOW}/dispatches`, auth: { bearer: token }, what: "start the combined run", body: {
		ref: input.ref,
		inputs: {
			feature: input.item, attempt: String(input.attempt), run_from: input.runFrom, command: input.command,
			heads: JSON.stringify(input.heads), timeout_minutes: String(Math.ceil(input.timeoutSeconds / 60)),
		},
	} });
	// GitHub lists a dispatched run a moment later: the first poll finds it.
	return findIntegrationRun(app, token, owner, repo, input.ref, input.item, input.attempt);
}

export async function readIntegrationRun(app: GithubApp, token: string, owner: string, repo: string, runId: string): Promise<RunReading> {
	if (!/^\d+$/.test(runId)) throw new Error("Invalid workflow run id.");
	const { body } = await app.call({ path: `/repos/${owner}/${repo}/actions/runs/${runId}`, auth: { bearer: token }, what: "read the combined run" });
	return readingOf(body);
}
