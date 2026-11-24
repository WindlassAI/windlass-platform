import { randomBytes } from "node:crypto";
import { validArgs, type Args } from "../../server/src/runner/protocol.js";
import { spareProfile, spareRecipe, type SpareRecipe, type SpareSetup } from "../../server/src/runner/spare-recipe.js";

export const SPARE_SESSION = "@ready"; // Outside the session id grammar, including on older runners.
export const SPARE_TTL = 6 * 60 * 60_000;

// The runner supplies these fields locally. Only their names can reach the service log.
const contextFields = ["uid", "machineId", "version", "image", "shotsImage", "claudePin", "codexPin", "opencodePin",
	"egress", "domains", "slots", "screenshotsEnabled", "allowedProfiles", "sessionVolumes"] as const;
type SpareContext = Record<typeof contextFields[number], string | boolean | undefined>;

export interface SpareSpec {
	context: SpareContext;
	args: Args<"create"> & { spare: SpareRecipe };
}

export function validSpec(value: unknown): value is SpareSpec {
	if (!value || typeof value !== "object" || !("context" in value) || !("args" in value)) return false;
	const context = value.context;
	if (!context || typeof context !== "object" || Object.keys(context).length !== contextFields.length ||
		!contextFields.every(field => Object.hasOwn(context, field))) return false;
	return validArgs("create", value.args) && spareProfile(value.args.profile, value.args.harness) &&
		!(value.args.harness && (value.args.prepared || value.args.screenshots)) &&
		!value.args.prepared?.privateData && !value.args.prepared?.writer && spareRecipe(value.args.spare) &&
		value.args.mirrorRepo === value.args.spare.connected?.repo && (!value.args.prepared || value.args.prepared.repo === value.args.mirrorRepo);
}

// The commit may advance and the snapshot attempt belongs to the requesting session.
// Both are checked separately when claiming. Include every other create input.
export function spareKeyFields(s: SpareSpec) {
	const { spare, prepared, profile, harness, size, screenshots, mirrorRepo } = s.args;
	const c = spare.connected;
	return { ...s.context, profile, harness, size: size ?? 1, screenshots: !!screenshots, mirrorRepo, url: spare.url,
		"connected.repo": c?.repo, "connected.branch": c?.branch, "connected.generation": c?.generation,
		"connected.command": c?.command, "connected.timeoutMs": c?.timeoutMs,
		"prepared.repo": prepared?.repo, "prepared.inputs": prepared?.inputs, "prepared.generation": prepared?.generation };
}

export function spareMismatches(a: SpareSpec, b: SpareSpec) {
	const built = spareKeyFields(a), requested = spareKeyFields(b);
	return (Object.keys(built) as (keyof typeof built)[]).filter(field => built[field] !== requested[field]);
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

/** Only fixed reason codes may reach the service log. Docker and setup errors can contain secrets. */
export class SpareBuildError extends Error {
	constructor(readonly reason: "disk" | "bound" | "private-data" | "bubblewrap" | "snapshot" | "clone" | "base" | "setup" | "changed-base") { super(reason); }
}

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

	/** A miss after maintenance can still be compared with the last successful create. */
	comparison(spec?: SpareSpec) {
		const ready = [...this.entries].find(e => e.ready && !e.abort.signal.aborted && this.now() - e.started < SPARE_TTL);
		const previous = ready?.spec ?? this.recipe;
		const mismatch = spec && previous ? spareMismatches(spec, previous).join(",") || "none" : "unknown";
		return { compared: ready ? "ready" : previous ? "recent" : "none", mismatch };
	}

	private discard(e: Entry, reason: string, detail = "") {
		if (!e.removal) {
			console.info(`spare.skip id=${e.raw} reason=${reason}${detail}`);
			e.abort.abort();
			// A cancelled docker run may still create its container. Remove it after the build settles.
			e.removal = Promise.resolve(e.build).then(() => this.drop(e.raw)).finally(() => this.entries.delete(e));
		}
		return e.removal;
	}
	async trim(limit = 0, spec?: SpareSpec, cause = "maintenance") {
		const removals = [];
		for (const e of this.entries) {
			const expired = this.now() - e.started >= SPARE_TTL;
			const fields = spec && spareMismatches(spec, e.spec);
			if (e.removal || expired || fields?.length || limit === 0) {
				const reason = expired ? "expired" : fields?.length && limit > 0 ? "recipe-changed" : "capacity";
				removals.push(this.discard(e, reason, ` cause=${cause} mismatch=${fields ? fields.join(",") || "none" : "unknown"}`));
			} else limit--;
		}
		await Promise.all(removals);
	}
	async take(spec: SpareSpec, verify: (raw: string, built: SpareSpec) => Promise<boolean>, waitForRemoval = true) {
		for (const e of [...this.entries]) {
			if (!e.ready || e.abort.signal.aborted || this.now() - e.started >= SPARE_TTL || spareMismatches(spec, e.spec).length) continue;
			if (!this.entries.delete(e)) continue; // Reserve before verification yields to maintenance or another claim.
			if (await verify(e.raw, e.spec).catch(() => false)) return { raw: e.raw, setup: e.setup };
			this.entries.add(e);
			const changedHead = spec.args.spare.connected?.commit !== e.spec.args.spare.connected?.commit;
			const rejected = this.discard(e, "verification", ` mismatch=${changedHead ? "connected.commit" : "none"}`);
			if (waitForRemoval) await rejected;
		}
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
			console.info(`spare.build id=${e.raw} reason=ready`);
			this.changed();
		}).catch(error => {
			if (e.abort.signal.aborted) return;
			demand.failures++;
			demand.retryAt = this.now() + 60_000;
			void this.discard(e, error instanceof SpareBuildError ? error.reason : "build-failed");
		});
	}
}
