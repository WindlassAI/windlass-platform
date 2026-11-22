import { createHash } from "node:crypto";
import type { HarnessOptions } from "../contract.js";
import type { Report, RunnerFrame } from "./control.js";

export type CatalogFrame = Extract<RunnerFrame, { kind: "catalog" }>;
export type CatalogId = CatalogFrame["id"];
// The runner reuses the same immutable options between probes. Host samples never
// need to serialize those models again.
const digests = new WeakMap<HarnessOptions, string>();
export function optionsDigest(options: HarnessOptions) {
	let digest = digests.get(options);
	if (!digest) {
		// Old machine and user rows may have crossed different serializers. The
		// check timestamp travels in the summary so a fresh probe can reuse its models.
		const json = JSON.stringify(options, ["models", "defaultModel", "modes", "id", "name", "efforts", "description"]);
		digest = createHash("sha256").update(json).digest("hex");
		digests.set(options, digest);
	}
	return digest;
}

/** Also splits inline options from reports saved or sent by an earlier release. */
export function compactReport(report: Report, catalog?: (id: CatalogId, options: HarnessOptions, digest: string) => void): Report {
	if (!report.harnesses) return report;
	return { ...report, harnesses: report.harnesses.map(({ options, ...entry }) => {
		if (!options) return entry;
		const digest = optionsDigest(options);
		catalog?.(entry.id, options, digest);
		return { ...entry, optionsDigest: digest, optionsCheckedAt: options.checkedAt };
	}) };
}

/** Per control connection. Its first inventory reestablishes all catalog references. */
export function reportPublisher(send: (frame: RunnerFrame) => void) {
	let previous = "";
	let previousHost: string | undefined;
	let sent = new Map<CatalogId, string>();
	return (report: Report) => {
		const next = new Map<CatalogId, string>();
		const { host, ...inventory } = report;
		const compact = compactReport(inventory, (id, options, digest) => {
			if (sent.get(id) !== digest) send({ kind: "catalog", id, options });
			next.set(id, digest);
		});
		const serialized = JSON.stringify(compact);
		const sample = JSON.stringify(host);
		if (serialized !== previous) send({ ...compact, ...(host && { host }) });
		else if (sample !== previousHost) send({ kind: "host", host: host ?? null });
		previousHost = sample;
		sent = next;
		previous = serialized;
	};
}
