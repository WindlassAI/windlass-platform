import { randomBytes } from "node:crypto";
import { digest } from "../../server/src/sandbox/snapshot-key.js";
import { validArgs, type Args } from "../../server/src/runner/protocol.js";
import { spareRecipe, type SpareRecipe } from "../../server/src/runner/spare-recipe.js";

export const SPARE_SESSION = "@ready"; // Outside the session id grammar, including on older runners.
export const SPARE_TTL = 6 * 60 * 60_000;

export interface SpareSpec {
	context: string;
	args: Args<"create"> & { spare: SpareRecipe };
}

export function validSpec(value: unknown): value is SpareSpec {
	if (!value || typeof value !== "object" || !("context" in value) || typeof value.context !== "string" || !("args" in value)) return false;
	return validArgs("create", value.args) && (value.args.profile === "docker-hardened" || value.args.harness === "codex") &&
		!(value.args.harness && (value.args.prepared || value.args.screenshots)) &&
		!value.args.prepared?.privateData && !value.args.prepared?.writer && spareRecipe(value.args.spare) &&
		value.args.mirrorRepo === value.args.spare.connected?.repo && (!value.args.prepared || value.args.prepared.repo === value.args.mirrorRepo);
}

// The commit may advance and the snapshot attempt belongs to the requesting session.
// Both are checked separately when claiming. Include every other create input.
function key(s: SpareSpec) {
	const { spare, prepared, profile, harness, size, screenshots, mirrorRepo } = s.args;
	const c = spare.connected;
	return digest([s.context, profile, harness, size ?? 1, !!screenshots, mirrorRepo, spare.url,
		c && [c.repo, c.branch, c.generation, c.command, c.timeoutMs], prepared && [prepared.repo, prepared.inputs, prepared.generation]]);
}

interface Entry {
	raw: string;
	spec: SpareSpec;
	started: number;
	abort: AbortController;
	ready: boolean;
}

export class WarmSpares {
	private entries = new Set<Entry>();
	private nextBuild = 0;
	constructor(private build: (raw: string, spec: SpareSpec, signal: AbortSignal) => Promise<void>,
		private drop: (raw: string) => Promise<void>, private now = Date.now, private changed: () => void = () => {}) {}

	get ready() { return [...this.entries].filter(e => e.ready).length; }
	get raws() { return [...this.entries].map(e => e.raw); }
	owns(raw: string) { return this.raws.includes(raw); }

	private discard(e: Entry) {
		this.entries.delete(e);
		e.abort.abort();
		// A build that is still in docker run also cleans up once it returns.
		void this.drop(e.raw).catch(() => {});
	}
	trim(limit = 0, spec?: SpareSpec) {
		for (const e of this.entries) {
			if (this.now() - e.started >= SPARE_TTL || (spec && key(spec) !== key(e.spec)) || this.entries.size > limit) this.discard(e);
		}
	}
	foreground(spec?: SpareSpec) {
		for (const e of this.entries) if (!spec || !e.ready || key(spec) !== key(e.spec)) this.discard(e);
	}
	async take(spec: SpareSpec, verify: (raw: string, built: SpareSpec) => Promise<boolean>) {
		this.trim(2, spec);
		const e = [...this.entries].find(e => e.ready);
		if (!e) return;
		this.entries.delete(e); // A claim consumes the sandbox even when verification fails.
		if (await verify(e.raw, e.spec).catch(() => false)) return e.raw;
		void this.drop(e.raw).catch(() => {});
	}
	fill(spec: SpareSpec, limit: number) {
		this.trim(limit, spec);
		if (this.entries.size >= limit || this.now() < this.nextBuild || [...this.entries].some(e => !e.ready)) return;
		const e: Entry = { raw: (spec.args.harness ? spec.args.harness + "-" : "") + randomBytes(6).toString("hex"), spec, started: this.now(), abort: new AbortController(), ready: false };
		this.entries.add(e);
		void this.build(e.raw, spec, e.abort.signal).then(() => {
			if (!e.abort.signal.aborted) { e.ready = true; this.changed(); }
		}).catch(() => {
			if (!e.abort.signal.aborted) this.nextBuild = this.now() + 60_000;
			this.entries.delete(e);
			e.abort.abort();
		}).finally(async () => {
			if (e.abort.signal.aborted) await this.drop(e.raw).catch(() => {});
		});
	}
}
