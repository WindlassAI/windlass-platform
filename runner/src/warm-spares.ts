import { randomBytes } from "node:crypto";
import { digest } from "../../server/src/sandbox/snapshot-key.js";
import { validArgs, type Args } from "../../server/src/runner/protocol.js";
import { spareRecipe, type SpareRecipe, type SpareSetup } from "../../server/src/runner/spare-recipe.js";

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
	build?: Promise<void>;
	removal?: Promise<void>;
	setup?: SpareSetup;
}

const RECIPE_TTL = 24 * 60 * 60_000;

export class WarmSpares {
	private entries = new Set<Entry>();
	private recent?: { spec: SpareSpec; usedAt: number; failures: number; retryAt: number };
	constructor(private build: (raw: string, spec: SpareSpec, signal: AbortSignal) => Promise<SpareSetup | void>,
		private drop: (raw: string) => Promise<void>, private now = Date.now, private changed: () => void = () => {}) {}

	get ready() { return [...this.entries].filter(e => e.ready && !e.abort.signal.aborted).length; }
	get raws() { return [...this.entries].map(e => e.raw); }
	owns(raw: string) { return this.raws.includes(raw); }

	/** Only a successfully started session renews demand or resets the failure budget. */
	used(spec?: SpareSpec) {
		this.recent = spec && { spec, usedAt: this.now(), failures: 0, retryAt: 0 };
	}
	get recipe() {
		if (this.recent && this.now() - this.recent.usedAt >= RECIPE_TTL) this.recent = undefined;
		return this.recent?.spec;
	}

	private discard(e: Entry) {
		if (!e.removal) {
			e.abort.abort();
			// A cancelled docker run may still create its container. Remove it after the build settles.
			e.removal = Promise.resolve(e.build).then(() => this.drop(e.raw)).finally(() => this.entries.delete(e));
		}
		return e.removal;
	}
	async trim(limit = 0, spec?: SpareSpec) {
		const removals = [];
		for (const e of this.entries) {
			if (e.removal || this.now() - e.started >= SPARE_TTL || (spec && key(spec) !== key(e.spec)) || limit === 0)
				removals.push(this.discard(e));
			else limit--;
		}
		await Promise.all(removals);
	}
	async foreground(spec?: SpareSpec) {
		await Promise.all([...this.entries].filter(e => e.removal || !spec || !e.ready || key(spec) !== key(e.spec)).map(e => this.discard(e)));
	}
	async take(spec: SpareSpec, verify: (raw: string, built: SpareSpec) => Promise<boolean>) {
		await this.trim(2, spec);
		const e = [...this.entries].find(e => e.ready && !e.abort.signal.aborted);
		if (!e) return;
		this.entries.delete(e); // A claim consumes the sandbox even when verification fails.
		if (await verify(e.raw, e.spec).catch(() => false)) return { raw: e.raw, setup: e.setup };
		this.entries.add(e);
		await this.discard(e);
	}
	fill(limit: number) {
		const spec = this.recipe, demand = this.recent;
		void this.trim(spec ? limit : 0, spec);
		if (!spec || !demand || demand.failures >= 2 || this.now() < demand.retryAt ||
			this.entries.size >= limit || [...this.entries].some(e => !e.ready)) return;
		const e: Entry = { raw: (spec.args.harness ? spec.args.harness + "-" : "") + randomBytes(6).toString("hex"), spec, started: this.now(), abort: new AbortController(), ready: false };
		this.entries.add(e);
		e.build = this.build(e.raw, spec, e.abort.signal).then(setup => {
			if (e.abort.signal.aborted) return;
			e.setup = setup || undefined;
			e.ready = true;
			demand.failures = 0;
			this.changed();
		}).catch(() => {
			if (e.abort.signal.aborted) return;
			demand.failures++;
			demand.retryAt = this.now() + 60_000;
			void this.discard(e);
		});
	}
}
