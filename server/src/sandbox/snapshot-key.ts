// Git blob IDs identify content at the exact tree the session will check out.
import { createHash } from "node:crypto";

export const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export interface SnapshotKey { repo: string; generation: string; inputs: string }
/** Fresh per create, so a runner adopting an earlier container cannot publish it or silently skip setup. */
export interface SnapshotRequest extends SnapshotKey { attempt: string }
/** Lookups from children, reviewers and work branches cannot authorize a later commit. */
export interface SnapshotSelection extends SnapshotRequest { writer: boolean }
export interface SnapshotSource extends SnapshotRequest { commit: string; created: number }
export const DEFERRED_INPUTS = "cold";
export const SNAPSHOT_MIN_SETUP_MS = 30_000;
export const snapshotGeneration = (repo: string, savedAt: number | null, connectedAt: number) => digest([repo, savedAt, connectedAt]);
export const SHA = /^[a-f0-9]{40}$/;
export const HASH = /^[a-f0-9]{64}$/;
export function canReuseSnapshot(enabled: boolean, harness: string | undefined, repositorySecretCount: number) {
	return enabled && (!harness || harness === "windlass") && repositorySecretCount === 0;
}
export function snapshotWriter(origin: { role?: string; owns?: string[] } | undefined) {
	return origin?.role !== "reviewer" && origin?.owns === undefined;
}
export function canSaveSnapshot(origin: { role?: string; owns?: string[] } | undefined, handed: number, succeeded: boolean, duration: number, minimum = SNAPSHOT_MIN_SETUP_MS) {
	return snapshotWriter(origin) && handed === 0 && succeeded && duration >= minimum;
}
export function snapshotPrompt(commit: string) {
	return `[Platform note: Setup came from a snapshot of the repository base at commit ${commit}. The source is checked out for this session. Rebuild if you need current build outputs.]\n\n`;
}

const lock = /^(?:package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|uv\.lock|Gemfile\.lock|composer\.lock|Pipfile\.lock|poetry\.lock|pyproject\.toml|requirements[^/]*\.txt|flake\.lock|mix\.lock|Cargo\.lock|go\.sum)$/;
export interface TreeEntry { path: string; sha: string; mode: string; type: string }
export function dependencyHash(tree: TreeEntry[]): string | null {
	let locked = false;
	const entries: [string, string][] = [];
	for (const file of tree) {
		const name = file.path.slice(file.path.lastIndexOf("/") + 1);
		if (lock.test(name)) locked = true;
		else if (!["package.json", ".nvmrc", ".tool-versions"].includes(name)) continue;
		if (!/^100(644|755)$/.test(file.mode) || file.type !== "blob" || !SHA.test(file.sha)) throw new Error("Unsupported dependency input");
		entries.push([file.path, file.sha]);
	}
	return locked ? digest(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : null;
}
