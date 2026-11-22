// Docker owns the index as well as the layers. Tags record last use across process restarts.
// Every operation names a local image ID; a session request can never select a Docker image.
import { docker, LABEL, DATA_DIR, randomId } from "./docker.js";
import { DEFERRED_INPUTS, digest, HASH, SHA, type SnapshotKey, type SnapshotRequest, type SnapshotSource } from "./snapshot-key.js";

const S = LABEL + ".snapshot";
const TTL = 14 * 86_400_000;
export const snapshotLimits = { machine: 10_000_000_000, user: 2_000_000_000, free: 15_000_000_000 };
type Labels = Record<string, string>;
type Image = { Id: string; Size: number; Os: string; Architecture: string; Variant?: string; Config: { Labels: Labels; Env: string[] }; RepoTags?: string[] };
type Row = { tag: string; uid: string; repo: string; used: number; bytes: number; image: Image };

export function evictions<T extends Pick<Row, "uid" | "used" | "bytes">>(rows: T[], now: number, caps = snapshotLimits, pinned: T[] = []) {
	const oldest = rows.slice().sort((a, b) => a.used - b.used);
	const users = new Map<string, number>();
	let total = 0;
	for (const row of [...oldest, ...pinned]) {
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

/** A removed tag may reclaim zero bytes while a session holds the image. Re-measure after each eviction. */
export async function relieveDiskPressure<T extends { used: number }>(rows: T[], floor: number, available: () => Promise<number>, retire: (row: T) => Promise<void>) {
	for (const row of rows.slice().sort((a,b) => a.used - b.used)) {
		if (await available() >= floor) return true;
		await retire(row);
	}
	return await available() >= floor;
}

async function hasTransportStaging(container: string) {
	// docker diff can list every file installed during setup. Keep only enough of a
	// line prefix to recognize a staging entry split across stdout chunks.
	let found = false, tail = "\n";
	await docker(["diff", container], { check: true, timeoutMs: 90_000, onStdout(chunk) {
		const text = tail + chunk;
		found ||= /\n[AC] \/tmp\/wlp-/.test(text);
		tail = text.slice(-16);
	} });
	return found;
}

const inspect = async (kind: "image" | "container", name: string) =>
	JSON.parse((await docker([kind, "inspect", name], { check: true, timeoutMs: 15_000 })).stdout)[0];
const validScope = (key: SnapshotKey) => /^[1-9]\d{0,19}$/.test(key.repo) && HASH.test(key.generation);
const valid = (key: SnapshotKey) => validScope(key) && HASH.test(key.inputs);
export class DockerSnapshots {
	private readonly namespace: string;
	constructor(readonly machine: string, readonly base: string, readonly network?: { mode: string; env: Record<string, string> }, private readonly limits = snapshotLimits, private readonly screenshots = false, private readonly deployment = machine) {
		if (!deployment) throw new Error("Missing snapshot deployment identity");
		// The persisted pairing id already namespaces a runner. Preserve its tags across upgrades.
		this.namespace = "wlp-prepared-" + digest(machine === deployment ? [machine] : [deployment, machine]).slice(0, 24);
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
		// Older runners could leave an untagged image pinned by a consumer. Only their
		// persisted machine id can establish ownership of a pre-deployment label.
		const pairing = this.machine !== "" && this.deployment === this.machine;
		const scope = pairing ? S + ".machine=" + this.machine : S + ".index=" + this.namespace;
		const dangling = (await docker(["image", "ls", "-q", "--no-trunc", "--filter", "dangling=true",
			"--filter", "label=" + S + "=1", "--filter", "label=" + scope], { check: true })).stdout.trim().split(/\s+/).filter(Boolean);
		const names = [...refs, ...new Set(dangling)];
		if (!names.length) return [];
		const images: Image[] = JSON.parse((await docker(["image", "inspect", ...names], { check: true })).stdout);
		return images.flatMap((image, i) => {
			const labels = image.Config.Labels, tag = names[i];
			const index = labels[S + ".index"];
			if (index !== this.namespace && !(pairing && index === undefined)) return [];
			const untagged = i >= refs.length;
			if (untagged && image.RepoTags?.length) return [];
			if (labels[S+".machine"] !== this.machine || (!untagged && !image.RepoTags?.includes(tag))) throw new Error("Snapshot index changed");
			const bytes = Number(labels[S+".writable"]) + Math.max(0, image.Size - Number(labels[S+".base-size"]));
			const used = untagged ? Number(labels[S + ".created"]) : Number(tag.split(":")[1].replace(/^(held|pending)-/, "").split("-")[0]);
			if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(used)) throw new Error("Invalid snapshot index");
			return [{ tag, image, uid: labels[S+".uid"], repo: labels[S+".repo"], bytes, used }];
		});
	}

	private tag() { return this.namespace + ":" + Date.now() + "-" + randomId(6); }
	private async remove(row: Row) { await docker(["image", "rm", "--force", row.tag], { check: true }); }
	private pending(row: Row) { return row.tag.startsWith(this.namespace + ":pending-"); }
	private held(row: Row) { return row.tag === row.image.Id || row.tag.startsWith(this.namespace + ":held-"); }

	// Keep an accounting tag until Docker has actually released the image. A running or
	// stopped consumer can pin its layers long after eviction from the lookup index.
	private async pinned(row: Row) {
		const pins = await docker(["ps", "-aq", "--filter", "ancestor=" + row.image.Id], { check: true });
		return !!pins.stdout.trim();
	}
	private async release(row: Row) {
		if (!await this.pinned(row)) await docker(["image", "rm", row.tag], { check: true });
	}
	private async retire(row: Row) {
		const tag = row.tag.replace(":", ":held-");
		await docker(["tag", row.image.Id, tag], { check: true });
		await this.remove(row);
		await this.release({ ...row, tag });
	}
	private async free() {
		const space = await docker(["run", "--rm", "--network", "none", "--pull", "never", "--cap-drop", "ALL",
			"--entrypoint", "/bin/df", this.base, "-B1", "--output=avail", "/workspace"], { check: true });
		const available = Number(space.stdout.trim().split(/\s+/).pop());
		if (!Number.isSafeInteger(available) || available < 0) throw new Error("Invalid free space");
		return available;
	}
	private async pressure(rows: Row[]) {
		return relieveDiskPressure(rows.filter(row => !this.held(row) && !this.pending(row)), this.limits.free, () => this.free(), row => this.retire(row));
	}
	private async prune(known: (uid: string) => boolean = () => true) {
		const owned = async () => (await this.rows()).filter(row => known(row.uid));
		const seen = new Set<string>(), images = new Set<string>();
		const inventory = await owned();
		for (const row of inventory.filter(row => this.pending(row))) await this.remove(row);
		const rows = inventory.filter(row => !this.pending(row));
		// Finish interrupted retags before charging layers. A held tag records an eviction in progress.
		rows.sort((a, b) => Number(this.held(b)) - Number(this.held(a)) ||
			Number(b.image.Config.Labels[S+".created"]) - Number(a.image.Config.Labels[S+".created"]) || b.used - a.used);
		for (const row of rows) {
			if (images.has(row.image.Id)) { await this.remove(row); continue; }
			images.add(row.image.Id);
			if (this.held(row)) continue;
			const owner = JSON.stringify([row.uid, row.repo]);
			if (seen.has(owner)) await this.retire(row);
			seen.add(owner);
		}
		for (const row of (await owned()).filter(row => this.held(row))) await this.release(row);
		for (;;) {
			const rows = await owned();
			const held = rows.filter(row => this.held(row));
			const active = rows.filter(row => !this.held(row));
			// Re-read after each eviction: a pinned victim still counts toward both budgets.
			const [oldest] = evictions(active, Date.now(), this.limits, held);
			if (!oldest) return rows;
			await this.retire(oldest);
		}
	}
	private async fitsWithConsumers(rows: Row[], added: Row) {
		const fits = (charged: Row[]) => charged.reduce((n,r) => n + r.bytes, added.bytes) <= this.limits.machine &&
			charged.filter(r => r.uid === added.uid).reduce((n,r) => n + r.bytes, added.bytes) <= this.limits.user;
		const others = rows.filter(r => r.image.Id !== added.image.Id);
		if (fits(others)) return true;
		const fixed: Row[] = [];
		for (const row of others) if (await this.pinned(row)) fixed.push(row);
		return fits(fixed);
	}

	private coldKey(request: SnapshotRequest, uid: string, profile: string) {
		return digest(["cold", this.deployment, this.machine, uid, profile, request.repo, request.generation, request.attempt]);
	}
	async has(uid: string, repo: string) {
		const refs = await docker(["image", "ls", "-q", "--filter", "reference=" + this.namespace + ":[0-9]*",
			"--filter", "label=" + S + ".uid=" + uid, "--filter", "label=" + S + ".repo=" + repo], { check: true });
		return !!refs.stdout.trim();
	}

	private key(request: SnapshotKey, base: Image, uid: string, profile: string) {
		return digest([this.deployment, this.machine, uid, request.repo, request.generation, request.inputs, base.Id, base.Os, base.Architecture, base.Variant ?? "", profile, this.screenshots, this.network?.mode ?? "hosted", this.network?.env ?? {}]);
	}

	async select(request: SnapshotRequest, uid: string, profile: string) {
		if (request.inputs === DEFERRED_INPUTS && validScope(request) && /^[a-f0-9]{32}$/.test(request.attempt))
			return { image: this.base, key: this.coldKey(request, uid, profile), hit: false };
		if (!valid(request) || !/^[a-f0-9]{32}$/.test(request.attempt)) throw new Error("Invalid snapshot request");
		const base: Image = await inspect("image", this.base);
		const key = this.key(request, base, uid, profile);
		const matches = (row: Row) => !this.held(row) && !this.pending(row) && row.uid === uid && row.repo === request.repo && row.image.Config.Labels[S+".key"] === key;
		const rows = await this.rows();
		const candidate = rows.find(matches);
		if (!candidate) return { image: base.Id, key, hit: false };
		// A different repository can be mid-commit. An existing, in-budget immutable image
		// is still usable then. Create retries cold if Docker evicts it before the run.
		const usable = !evictions(rows.filter(row => !this.held(row) && !this.pending(row)), Date.now(), this.limits, rows.filter(row => this.held(row))).includes(candidate);
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
			if (box.Image !== base.Id || (labels[S+".candidate"] !== key && labels[S+".candidate"] !== this.coldKey(source, uid, profile)) || labels[S+".attempt"] !== source.attempt || labels[LABEL+".uid"] !== uid ||
				labels[LABEL+".profile"] !== profile || (labels[LABEL+".machine"] ?? "") !== this.machine ||
				labels[LABEL+".harness"] || box.Mounts.length !== 1 || box.Mounts[0].Type !== "volume" || box.Mounts[0].Destination !== DATA_DIR) return false;
			// Commit merges container Config. Refuse extra labels or env (including Docker client proxy credentials).
			const allowed = new Set([...Object.keys(base.Config.Labels ?? {}), LABEL, LABEL+".uid", LABEL+".session", LABEL+".profile", LABEL+".machine", LABEL+".egress", S+".candidate", S+".attempt", variantLabel]);
			const env = [...base.Config.Env, ...Object.entries(this.network?.env ?? {}).map(([k,v]) => k+"="+v)];
			if (Object.keys(labels).some(k => !allowed.has(k)) || JSON.stringify([...box.Config.Env].sort()) !== JSON.stringify(env.sort())) return false;
			const marker = this.namespace + "-refused-" + key;
			if ((await docker(["volume", "inspect", marker])).code === 0) return false;
			const refuse = async () => {
				await docker(["volume", "create", "--label", S + ".index=" + this.namespace, "--label", S + ".uid=" + uid,
					"--label", S + ".repo=" + source.repo, "--label", S + ".generation=" + source.generation,
					"--label", S + ".created=" + Date.now(), marker], { check: true });
				return false;
			};
			if (await hasTransportStaging(box.Id)) {
				// /tmp is sticky. Each unprivileged owner removes its own paths, including nested private files.
				for (const user of ["65534", "agent"]) await docker(["exec", "--user", user, box.Id, "/bin/sh", "-c", "/bin/rm -rf -- /tmp/wlp-*"], { timeoutMs: 30_000 });
			}
			await docker(["pause", box.Id], { check: true });
			try {
				// Freeze background setup processes across the final diff, size check and commit.
				if (await hasTransportStaging(box.Id)) return false;
				const size = await docker(["container", "inspect", "--size", "--format", "{{.SizeRw}}", box.Id], { check: true });
				const writable = Number(size.stdout.trim());
				const cap = Math.min(this.limits.machine, this.limits.user);
				if (!Number.isSafeInteger(writable) || writable < 0) return false;
				if (2 * writable > cap) return refuse();
				if (!await this.pressure(await this.rows())) return false;
				const tag = this.tag(), pending = tag.replace(":", ":pending-");
				const metadata: Labels = { [LABEL+".session"]: "", [S+".candidate"]: "", [S+".attempt"]: "", [S]: "1", [S+".index"]: this.namespace, [S+".machine"]: this.machine, [S+".uid"]: uid,
					[S+".repo"]: source.repo, [S+".inputs"]: source.inputs, [S+".generation"]: source.generation, [S+".key"]: key, [S+".commit"]: source.commit, [S+".created"]: String(source.created), [S+".base-size"]: String(base.Size), [S+".writable"]: String(writable) };
				await docker(["commit", "--pause=false", ...Object.entries(metadata).flatMap(([k,v]) => ["-c", "LABEL "+k+"="+JSON.stringify(v)]), box.Id, pending], { check: true, timeoutMs: 10 * 60_000 });
				// A crash during validation leaves only a pending tag. The next sweep can discard
				// it without making a half-admitted image eligible for replacement or quota eviction.
				try {
					const rows = await this.rows();
					const added = rows.find(row => row.tag === pending);
					if (!added) return false;
					if (added.bytes > cap) return await refuse();
					if (!await this.fitsWithConsumers(rows.filter(row => !this.pending(row) || row === added), added)) return false;
					await docker(["tag", added.image.Id, tag], { check: true });
				} finally { await docker(["image", "rm", pending], { check: true }); }
				return (await this.prune()).some(row => row.tag === tag);
			} finally { await docker(["unpause", box.Id], { check: true }); }
		}, false);
	}

	private async markers() {
		const ids = (await docker(["volume", "ls", "-q", "--filter", "label=" + S + ".index=" + this.namespace], { check: true })).stdout.trim().split(/\s+/).filter(Boolean);
		if (!ids.length) return [] as { Name: string; Labels: Labels }[];
		return JSON.parse((await docker(["volume", "inspect", ...ids], { check: true })).stdout) as { Name: string; Labels: Labels }[];
	}

	/** Resolve ownership before any expiry, quota or disk-pressure deletion. */
	async sweepOwners(retained: (uid: string) => Promise<ReadonlySet<string> | null | undefined>) {
		const owners = new Set((await this.rows()).map(r => r.uid));
		for (const marker of await this.markers()) owners.add(marker.Labels[S + ".uid"]);
		if (!owners.size) return;
		const known = new Map<string, ReadonlySet<string> | undefined>();
		for (const uid of owners) {
			const keep = await retained(uid);
			if (keep !== null) known.set(uid, keep);
		}
		if (!known.size) return;
		await this.locked(this.base, async () => {
			for (const row of await this.rows()) {
				const keep = known.get(row.uid);
				if (!this.held(row) && !this.pending(row) && keep && !keep.has(row.image.Config.Labels[S + ".generation"])) await this.retire(row);
			}
			for (const { Name, Labels } of await this.markers()) {
				const uid = Labels[S + ".uid"], keep = known.get(uid);
				if (known.has(uid) && ((keep && !keep.has(Labels[S + ".generation"])) || Date.now() - Number(Labels[S + ".created"]) >= TTL))
					await docker(["volume", "rm", Name], { check: true });
			}
			const rows = await this.prune(uid => known.has(uid));
			if (rows.length) await this.pressure(rows);
		}, undefined);
	}

	async sweep(uid?: string, retained?: ReadonlySet<string>) {
		await this.sweepOwners(owner => Promise.resolve(uid === undefined || owner === uid ? retained : null));
	}

	async drop(uid: string, repo?: string) {
		const matches = (row: Row) => row.uid === uid && (!repo || row.repo === repo);
		const matchesMarker = (m: { Labels: Labels }) => m.Labels[S + ".uid"] === uid && (!repo || m.Labels[S + ".repo"] === repo);
		if (!(await this.rows()).some(matches) && !(await this.markers()).some(matchesMarker)) return;
		await this.locked(this.base, async () => {
			for (const row of (await this.rows()).filter(matches)) {
				if (this.pending(row)) await this.remove(row);
				else if (this.held(row)) await this.release(row);
				else await this.retire(row);
			}
			for (const m of (await this.markers()).filter(matchesMarker)) await docker(["volume", "rm", m.Name], { check: true });
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
