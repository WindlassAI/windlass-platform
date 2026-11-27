/**
 * Listing and removing a deployment's sandboxes by their mark (`wlp_deployment`), for
 * scripts/e2b-cleanup.ts: what stops everything a deployment has at E2B, running or paused, when the
 * servers are gone or the credit matters more than the sessions. Only sandboxes that carry the
 * deployment's mark are ever touched.
 */

import type { E2bClient, E2bSandboxInfo } from "./client.js";
import { describeUsage, type RateCard } from "./pricing.js";
import { HOSTED_SIZE_SPECS } from "../../contract.js";
import { META, sandboxSize } from "./sandboxes.js";
import { errorText } from "../../util.js";

export interface CleanupReport {
	found: E2bSandboxInfo[];
	/** The ids that were killed. Empty in a dry run. */
	killed: string[];
	/** The ids that could not be killed, with why. */
	failed: Array<{ sandboxId: string; reason: string }>;
	/** One line per sandbox, and a last one that adds up. They hold no secret. */
	lines: string[];
}

/** The deployment's sandboxes, running and paused, oldest first. */
export async function deploymentSandboxes(client: E2bClient, deployment: string): Promise<E2bSandboxInfo[]> {
	const found = await client.list({ metadata: { [META.deployment]: deployment } });
	// The filter is E2B's; a sandbox is only taken for ours when its own metadata says so too.
	return found.filter((info) => info.metadata[META.deployment] === deployment).sort((a, b) => a.startedAt - b.startedAt);
}

/** Lists the deployment's sandboxes and, with `kill`, removes them. Without it nothing is changed: a dry run. */
export async function cleanupDeployment(client: E2bClient, deployment: string, options: { kill: boolean; rateCard?: RateCard; now?: () => number }): Promise<CleanupReport> {
	const now = (options.now ?? Date.now)();
	const found = await deploymentSandboxes(client, deployment);
	const report: CleanupReport = { found, killed: [], failed: [], lines: [] };
	for (const info of found) {
		const size = sandboxSize(info.metadata);
		const who = `uid=${info.metadata[META.uid] ?? "?"} session=${info.metadata[META.session] ?? "?"} size=${size}`;
		// For a running one: since it started, which is the most it can have run in this stretch. At E2B's own figures for it, else its size's.
		const spec = HOSTED_SIZE_SPECS[size];
		const usage = info.state === "running" ? `running, at most ${describeUsage(Math.max(0, now - info.startedAt) / 1000, info.cpuCount || spec.cpus, info.memoryMB || spec.memoryMiB, options.rateCard)} so far` : "paused, costs nothing while it is";
		let outcome = options.kill ? "killed" : "would be killed";
		if (options.kill) {
			try {
				await client.kill(info.sandboxId);
				report.killed.push(info.sandboxId);
			} catch (error) {
				const reason = errorText(error).replace(/\s+/g, " ").trim();
				report.failed.push({ sandboxId: info.sandboxId, reason });
				outcome = `could not be killed (${reason})`;
			}
		}
		report.lines.push(`${info.sandboxId}  ${who}  ${usage}: ${outcome}`);
	}
	const running = found.filter((info) => info.state === "running").length;
	report.lines.push(
		found.length === 0
			? `The deployment "${deployment}" has no sandboxes at E2B.`
			: options.kill
				? `Killed ${report.killed.length} of the ${found.length} sandboxes of the deployment "${deployment}" (${running} were running)${report.failed.length === 0 ? "." : `; ${report.failed.length} could not be killed.`}`
				: `The deployment "${deployment}" has ${found.length} sandboxes at E2B, ${running} of them running. A dry run: nothing was changed. Run again with --kill to remove them.`,
	);
	return report;
}
