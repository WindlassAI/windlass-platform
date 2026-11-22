// Git blob IDs identify content at the exact tree the session will check out.
import { createHash } from "node:crypto";

export const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export interface SnapshotKey { repo: string; generation: string; inputs: string }
/** Fresh per create, so a runner adopting an earlier container cannot publish it or silently skip setup. */
export interface SnapshotRequest extends SnapshotKey { attempt: string }
/** Lookups from children, reviewers and work branches cannot authorize a later commit. */
export interface SnapshotSelection extends SnapshotRequest { writer: boolean }
export interface SnapshotSource extends SnapshotRequest { commit: string; created: number }
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

const lock = /^(?:package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|requirements[^/]*\.txt|Cargo\.lock|go\.sum|\.nvmrc|\.tool-versions)$/;
export interface TreeEntry { path: string; sha: string; mode: string; type: string }
export async function dependencyHash(tree: TreeEntry[], readManifest: (path: string) => Promise<string>) {
	const files = tree.filter(e => {
		const name = e.path.split("/").pop()!;
		return name === "package.json" || lock.test(name);
	}).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const entries: unknown[] = [];
	const manifests = new Map<string, Promise<unknown[]>>();
	const pins = async (path: string) => {
		const manifest = JSON.parse(await readManifest(path));
		return manifest.engines === undefined && manifest.packageManager === undefined
			? [] : [manifest.packageManager ?? null, manifest.engines ?? null];
	};
	// Bound concurrent GitHub requests and read identical manifests only once per tree.
	for (let i = 0; i < files.length; i += 4) {
		const batch = await Promise.all(files.slice(i, i + 4).map(async file => {
			if (!/^100(644|755)$/.test(file.mode) || file.type !== "blob" || !SHA.test(file.sha)) throw new Error("Unsupported dependency input");
			if (file.path.split("/").pop() !== "package.json") return [file.path, file.sha];
			const loading = manifests.get(file.sha) ?? pins(file.path);
			manifests.set(file.sha, loading);
			const values = await loading;
			return values.length ? [file.path, ...values] : null;
		}));
		entries.push(...batch.filter(entry => entry !== null));
	}
	return digest(entries);
}
