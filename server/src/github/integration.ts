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

import { parse } from "yaml";
import { GithubError, type GithubApp } from "./app.js";
import { refHead } from "./feature.js";

/** The workflow file the platform dispatches, in `.github/workflows/` of the `runFrom` repository. */
export const INTEGRATION_WORKFLOW = "windlass-integration.yml";
/** Its path in the tree, which GitHub also gives each of its runs. */
export const INTEGRATION_PATH = ".github/workflows/" + INTEGRATION_WORKFLOW;

const record = (v: unknown) => (v ?? {}) as Record<string, unknown>;

/** What a run is named, by the workflow's `run-name`: how the platform finds its own run. */
export const runName = (item: string, attempt: number) => `windlass-integration ${item} ${attempt}`;

/**
 * Why the integration workflow's text may not be dispatched, or null when it may: it runs only on
 * `workflow_dispatch` (no `pull_request_target`, no push, no other trigger), its top-level permissions
 * are set and, like every job's, at most `contents: read`, and it references no secret. The platform
 * dispatches it with inputs it took from a plan; whoever can change the file at the dispatched commit
 * must not be able to make that run hold more than a read of the repository.
 */
export function integrationWorkflowRefusal(source: string): string | null {
	let doc: Record<string, unknown>;
	try {
		const parsed = parse(source, { maxAliasCount: 50 });
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "it is not a workflow";
		doc = parsed as Record<string, unknown>;
	} catch { return "it is not valid YAML"; }
	// YAML 1.1 readers take a bare `on` key for true.
	const on = "on" in doc ? doc.on : doc["true"];
	const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : on && typeof on === "object" ? Object.keys(on) : [];
	if (!triggers.length) return "it names no trigger: it must run on workflow_dispatch only";
	if (triggers.includes("pull_request_target")) return "it runs on pull_request_target: it must run on workflow_dispatch only";
	const others = triggers.filter(t => t !== "workflow_dispatch");
	if (others.length) return `it runs on ${others.map(String).join(", ")}: it must run on workflow_dispatch only`;
	if (/\bsecrets\s*[.[]/.test(source) || /\bsecrets\s*:\s*inherit\b/.test(source)) return "it references secrets: the combined run must hold none";
	if (!("permissions" in doc)) return "it sets no top-level permissions: give it permissions: contents: read";
	const top = permissionsRefusal(doc.permissions);
	if (top) return "its top-level permissions " + top;
	for (const [name, job] of Object.entries(record(doc.jobs))) {
		const j = record(job);
		if ("permissions" in j) {
			const refused = permissionsRefusal(j.permissions);
			if (refused) return `job ${name}'s permissions ${refused}`;
		}
	}
	return null;
}

/** Why `value` grants more than `contents: read`, or null. */
function permissionsRefusal(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value === "" ? null : `are ${value}: at most contents: read`;
	if (typeof value !== "object" || Array.isArray(value)) return "are not a map of scopes";
	for (const [scope, level] of Object.entries(value)) {
		if (level === "none") continue;
		if (scope === "contents" && level === "read") continue;
		return `grant ${scope}: ${String(level)}: at most contents: read`;
	}
	return null;
}

/**
 * Why the repository's integration workflow may not run at `ref` (a commit, or a branch read now), in a
 * sentence part naming it, or null when it may: it must be enabled, in the tree at that commit, and
 * pass `integrationWorkflowRefusal` there. Checked at approval on the base, and again on the exact
 * commit of every dispatch.
 */
export async function integrationWorkflowProblem(app: GithubApp, token: string, owner: string, repo: string, ref: string): Promise<string | null> {
	const missing = `the combined run needs ${INTEGRATION_PATH}, enabled, on ${ref}`;
	try {
		const { body } = await app.call({ path: `/repos/${owner}/${repo}/actions/workflows/${INTEGRATION_WORKFLOW}`, auth: { bearer: token }, what: "look for the integration workflow" });
		if (record(body).state !== "active") return missing;
		const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : await refHead(app, token, owner, repo, ref);
		const source = await app.fileAt(token, owner, repo, INTEGRATION_PATH, sha);
		const refused = integrationWorkflowRefusal(source);
		return refused ? `${INTEGRATION_PATH} at ${sha.slice(0, 7)} is refused: ${refused}` : null;
	} catch (error) {
		if (error instanceof GithubError && error.status === 404) return missing;
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

/**
 * Whether `run` is the platform's own run of the integration workflow on `headSha`: by its name, the
 * workflow file it ran, the commit it ran on, and who triggered it (the App's bot). A run anyone else
 * started, or one of another workflow named the same, is never taken for the platform's.
 */
export function ownRun(app: Pick<GithubApp, "settings">, value: unknown, expect: { name?: string; headSha: string }): boolean {
	const run = record(value), actor = record(run.triggering_actor);
	if (expect.name !== undefined && run.display_title !== expect.name && run.name !== expect.name) return false;
	const path = typeof run.path === "string" ? run.path.replace(/@.*$/, "") : null;
	return path === INTEGRATION_PATH && run.head_sha === expect.headSha
		&& typeof actor.login === "string" && actor.login.toLowerCase() === `${app.settings.slug}[bot]`.toLowerCase() && actor.type === "Bot";
}

/** The platform's run of this attempt on `headSha` (the `runFrom` repository's head), if GitHub lists one: a dispatch whose answer was lost is found here. */
export async function findIntegrationRun(app: GithubApp, token: string, owner: string, repo: string, ref: string, item: string, attempt: number, headSha: string): Promise<RunReading | null> {
	const { body } = await app.call({ path: `/repos/${owner}/${repo}/actions/workflows/${INTEGRATION_WORKFLOW}/runs`, query: { event: "workflow_dispatch", branch: ref, per_page: 30 }, auth: { bearer: token }, what: "look for the combined run" });
	const runs = record(body).workflow_runs;
	const name = runName(item, attempt);
	const found = Array.isArray(runs) ? runs.find(r => ownRun(app, r, { name, headSha })) : undefined;
	return found ? readingOf(found) : null;
}

/** Starts the run, or finds the one started for this attempt already. */
export async function dispatchIntegration(app: GithubApp, token: string, owner: string, repo: string, input: IntegrationInput): Promise<RunReading | null> {
	const headSha = input.heads[input.runFrom]?.sha;
	if (!headSha) throw new Error("The combined run has no head for " + input.runFrom + ".");
	const before = await findIntegrationRun(app, token, owner, repo, input.ref, input.item, input.attempt, headSha);
	if (before) return before;
	await app.call({ method: "POST", path: `/repos/${owner}/${repo}/actions/workflows/${INTEGRATION_WORKFLOW}/dispatches`, auth: { bearer: token }, what: "start the combined run", body: {
		ref: input.ref,
		inputs: {
			feature: input.item, attempt: String(input.attempt), run_from: input.runFrom, command: input.command,
			heads: JSON.stringify(input.heads), timeout_minutes: String(Math.ceil(input.timeoutSeconds / 60)),
		},
	} });
	// GitHub lists a dispatched run a moment later: the first poll finds it.
	return findIntegrationRun(app, token, owner, repo, input.ref, input.item, input.attempt, headSha);
}

/** A run that is not the platform's own (`ownRun`): never followed. */
export class ForeignRun extends Error {}

/** The run `runId`, which must still be the platform's own on `headSha`. */
export async function readIntegrationRun(app: GithubApp, token: string, owner: string, repo: string, runId: string, headSha: string): Promise<RunReading> {
	if (!/^\d+$/.test(runId)) throw new Error("Invalid workflow run id.");
	const { body } = await app.call({ path: `/repos/${owner}/${repo}/actions/runs/${runId}`, auth: { bearer: token }, what: "read the combined run" });
	if (!ownRun(app, body, { headSha })) throw new ForeignRun(`Run ${runId} is not the platform's run of ${INTEGRATION_PATH} on ${headSha.slice(0, 7)}.`);
	return readingOf(body);
}
