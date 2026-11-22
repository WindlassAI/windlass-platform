// Docker owns the index as well as the layers. Tags record last use across process restarts.
// Every operation names a local image ID; a session request can never select a Docker image.
import { docker, LABEL, DATA_DIR, randomId } from "./docker.js";
import { digest, HASH, SHA, type SnapshotKey, type SnapshotRequest, type SnapshotSource } from "./snapshot-key.js";

const S = LABEL + ".snapshot";
const TTL = 14 * 86_400_000;
export const snapshotLimits = { machine: 10_000_000_000, user: 2_000_000_000, free: 15_000_000_000 };
type Labels = Record<string, string>;
type Image = { Id: string; Size: number; Os: string; Architecture: string; Variant?: string; Config: { Labels: Labels; Env: string[] }; RepoTags?: string[] };
type Row = { tag: string; uid: string; repo: string; used: number; bytes: number; image: Image };

export function evictions<T extends Pick<Row, "uid" | "used" | "bytes">>(rows: T[], now: number, caps = snapshotLimits) {
	const oldest = rows.slice().sort((a, b) => a.used - b.used);
	const users = new Map<string, number>();
	let total = 0;
	for (const row of oldest) {
		users.set(row.uid, (users.get(row.uid) ?? 0) + row.bytes);
		total += row.bytes;
	}
	const removed = new Set<T>();
	for (const row of oldest) {
		const bytes = users.get(row.uid)!;
		if (now - row.used < TTL && bytes <= caps.user) continue;
		removed.add(row);
		users.set(row.uid, bytes - row.bytes);
		total -= row.bytes;
	}
	for (const row of oldest) {
		if (total <= caps.machine) break;
		if (!removed.has(row)) { removed.add(row); total -= row.bytes; }
	}
	return oldest.filter(row => removed.has(row));
}

const inspect = async (kind: "image" | "container", name: string) =>
	JSON.parse((await docker([kind, "inspect", name], { check: true, timeoutMs: 15_000 })).stdout)[0];
const valid = (key: SnapshotKey) => /^[1-9]\d{0,19}$/.test(key.repo) && HASH.test(key.inputs) && HASH.test(key.generation);
export class DockerSnapshots {
	private readonly namespace: string;
	constructor(readonly machine: string, readonly base: string, readonly network?: { mode: string; env: Record<string, string> }, private readonly limits = snapshotLimits, private readonly screenshots = false) {
		this.namespace = "wlp-prepared-" + digest([machine]).slice(0, 24);
	}

	// A daemon-local mutex also orders separate server processes. The sleeper releases it after a crash.
	private async locked<T>(image: string, work: () => Promise<T>, busy: T) {
		const lock = await docker(["run", "-d", "--rm", "--pull", "never", "--name", this.namespace + "-lock",
			"--network", "none", "--cap-drop", "ALL", "--entrypoint", "/bin/sleep", image, "900"], { timeoutMs: 20_000 });
		if (lock.code !== 0) return busy;
		try { return await work(); }
		finally { await docker(["rm", "-f", lock.stdout.trim()], { timeoutMs: 15_000 }); }
	}

	private async rows(): Promise<Row[]> {
		const refs = (await docker(["image", "ls", "--filter", "label=" + S + "=1", "--filter", "reference=" + this.namespace + ":*",
			"--format", "{{.Repository}}:{{.Tag}}"], { check: true })).stdout.trim().split(/\s+/).filter(Boolean);
		if (!refs.length) return [];
		const images: Image[] = JSON.parse((await docker(["image", "inspect", ...refs], { check: true })).stdout);
		return images.map((image, i) => {
			const labels = image.Config.Labels;
			const tag = refs[i];
			if (labels[S+".machine"] !== this.machine || !image.RepoTags?.includes(tag)) throw new Error("Snapshot index changed");
			const bytes = Number(labels[S+".writable"]) + Math.max(0, image.Size - Number(labels[S+".base-size"]));
			const used = Number(tag.split(":")[1].split("-")[0]);
			if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(used)) throw new Error("Invalid snapshot index");
			return { tag, image, uid: labels[S+".uid"], repo: labels[S+".repo"], bytes, used };
		});
	}

	private tag() { return this.namespace + ":" + Date.now() + "-" + randomId(6); }
	private async remove(row: Row) { await docker(["image", "rm", "--force", row.tag], { check: true }); }
	private async prune() {
		const rows = await this.rows();
		// Finish an interrupted replacement or last-use retag before charging quotas.
		const seen = new Set<string>();
		const drop = new Set<Row>();
		for (const row of rows.sort((a, b) => Number(b.image.Config.Labels[S+".created"]) - Number(a.image.Config.Labels[S+".created"]) || b.used - a.used)) {
			const owner = JSON.stringify([row.uid, row.repo]);
			if (seen.has(owner)) drop.add(row);
			seen.add(owner);
		}
		for (const row of evictions(rows.filter(row => !drop.has(row)), Date.now(), this.limits)) drop.add(row);
		for (const row of drop) await this.remove(row);
		return rows.filter(row => !drop.has(row));
	}

	private key(request: SnapshotKey, base: Image, uid: string, profile: string) {
		return digest([uid, request.repo, request.generation, request.inputs, base.Id, base.Os, base.Architecture, base.Variant ?? "", profile, this.screenshots, this.network?.mode ?? "hosted", this.network?.env ?? {}]);
	}

	async select(request: SnapshotRequest, uid: string, profile: string) {
		if (!valid(request) || !/^[a-f0-9]{32}$/.test(request.attempt)) throw new Error("Invalid snapshot request");
		const base: Image = await inspect("image", this.base);
		const key = this.key(request, base, uid, profile);
		const matches = (row: Row) => row.uid === uid && row.repo === request.repo && row.image.Config.Labels[S+".key"] === key;
		const rows = await this.rows();
		const candidate = rows.find(matches);
		if (!candidate) return { image: base.Id, key, hit: false };
		// A different repository can be mid-commit. An existing, in-budget immutable image
		// is still usable then. Create retries cold if Docker evicts it before the run.
		const usable = !evictions(rows, Date.now(), this.limits).includes(candidate);
		const image = await this.locked(base.Id, async () => {
			const row = (await this.prune()).find(matches);
			if (!row) return null;
			await docker(["tag", row.image.Id, this.tag()], { check: true });
			await this.remove(row);
			return row.image.Id;
		}, usable ? candidate.image.Id : null);
		return { image: image ?? base.Id, key, hit: !!image };
	}

	async save(container: string, uid: string, profile: string, source: SnapshotSource) {
		if (!valid(source) || !SHA.test(source.commit) || !Number.isSafeInteger(source.created) || !/^[a-f0-9]{32}$/.test(source.attempt)) return false;
		const base: Image = await inspect("image", this.base);
		return this.locked(base.Id, async () => {
			const box = await inspect("container", container);
			const labels: Labels = box.Config.Labels;
			const key = this.key(source, base, uid, profile);
			if (box.Image !== base.Id || labels[S+".candidate"] !== key || labels[S+".attempt"] !== source.attempt || labels[LABEL+".uid"] !== uid ||
				labels[LABEL+".profile"] !== profile || (labels[LABEL+".machine"] ?? "") !== this.machine ||
				labels[LABEL+".harness"] || box.Mounts.length !== 1 || box.Mounts[0].Type !== "volume" || box.Mounts[0].Destination !== DATA_DIR) return false;
			// Commit merges container Config. Refuse extra labels or env (including Docker client proxy credentials).
			const allowed = new Set([...Object.keys(base.Config.Labels ?? {}), LABEL, LABEL+".uid", LABEL+".session", LABEL+".profile", LABEL+".machine", LABEL+".egress", S+".candidate", S+".attempt", variantLabel]);
			const env = [...base.Config.Env, ...Object.entries(this.network?.env ?? {}).map(([k,v]) => k+"="+v)];
			if (Object.keys(labels).some(k => !allowed.has(k)) || JSON.stringify([...box.Config.Env].sort()) !== JSON.stringify(env.sort())) return false;
			await this.prune();
			const space = await docker(["run", "--rm", "--network", "none", "--pull", "never", "--cap-drop", "ALL", "--entrypoint", "/bin/df", base.Id, "-B1", "--output=avail", "/workspace"], { check: true });
			if (!(Number(space.stdout.trim().split(/\s+/).pop()) >= this.limits.free)) return false;
			// Containerd can retain both the writable filesystem snapshot and its compressed layer blob.
			const size = await docker(["container", "inspect", "--size", "--format", "{{.SizeRw}}", box.Id], { check: true });
			const writable = Number(size.stdout.trim());
			if (!Number.isSafeInteger(writable) || writable < 0 || writable > Math.min(this.limits.machine, this.limits.user)) return false;
			const tag = this.tag();
			const metadata: Labels = { [LABEL+".session"]: "", [S+".candidate"]: "", [S+".attempt"]: "", [S]: "1", [S+".machine"]: this.machine, [S+".uid"]: uid,
				[S+".repo"]: source.repo, [S+".inputs"]: source.inputs, [S+".generation"]: source.generation, [S+".key"]: key, [S+".commit"]: source.commit, [S+".created"]: String(source.created), [S+".base-size"]: String(base.Size), [S+".writable"]: String(writable) };
			await docker(["commit", ...Object.entries(metadata).flatMap(([k,v]) => ["-c", "LABEL "+k+"="+JSON.stringify(v)]), box.Id, tag], { check: true, timeoutMs: 10 * 60_000 });
			return (await this.prune()).some(row => row.tag === tag);
		}, false);
	}

	/** Periodic maintenance also reaches a machine whose owner starts no further sessions. */
	async sweep(uid?: string, retained?: ReadonlySet<string>) {
		// Docker can keep an untagged layer alive while a session still uses it. Unforced removal
		// retries only this cache's untagged images and leaves all live references intact.
		const dangling = await docker(["image", "ls", "-q", "--no-trunc", "--filter", "dangling=true", "--filter", "label="+S+"=1",
			"--filter", "label="+S+".machine="+this.machine], { check: true });
		for (const id of dangling.stdout.trim().split(/\s+/).filter(Boolean)) {
			const image: Image = await inspect("image", id);
			if (!image.RepoTags?.length && image.Config.Labels[S+".machine"] === this.machine) await docker(["image", "rm", id]);
		}
		if (!(await this.rows()).length) return;
		await this.locked(this.base, async () => {
			for (const row of await this.prune()) {
				if (row.uid === uid && retained && !retained.has(row.image.Config.Labels[S+".generation"])) await this.remove(row);
			}
		}, undefined);
	}

	async sweepOwners(retained: (uid: string) => Promise<ReadonlySet<string>>) {
		await this.sweep();
		for (const uid of new Set((await this.rows()).map(row => row.uid))) await this.sweep(uid, await retained(uid));
	}

	async drop(uid: string, repo?: string) {
		if (!(await this.rows()).some(row => row.uid === uid && (!repo || row.repo === repo))) return;
		await this.locked(this.base, async () => {
			for (const row of await this.rows()) if (row.uid === uid && (!repo || row.repo === repo)) await this.remove(row);
		}, undefined);
	}
}

export const variantLabel = S+".variant";
export const candidateLabel = S+".candidate";
export const attemptLabel = S+".attempt";
export function sourceFromLabels(labels: Labels): SnapshotSource | undefined {
	if (labels[S] !== "1") return;
	const source = { attempt: labels[attemptLabel], repo: labels[S+".repo"], inputs: labels[S+".inputs"], generation: labels[S+".generation"], commit: labels[S+".commit"], created: Number(labels[S+".created"]) };
	if (!valid(source) || !/^[a-f0-9]{32}$/.test(source.attempt) || !SHA.test(source.commit) || !Number.isSafeInteger(source.created)) throw new Error("Invalid prepared sandbox metadata");
	return source;
}
