import { sign, type KeyObject } from "node:crypto";
import { RETENTION_PATH, retentionRequest, SnapshotVerifier } from "../../server/src/runner/snapshot-proof.js";
import { HASH } from "../../server/src/sandbox/snapshot-key.js";
import { DockerSnapshots } from "../../server/src/sandbox/snapshots.js";
import { image } from "./policy.js";
import type { Identity } from "./state.js";

export function snapshotMaintenance(identity: Identity, key: KeyObject, platform: string) {
	let next = 0;
	const cache = new DockerSnapshots(identity.machineId, image);
	return async (now: number) => {
		if (Date.now() < next) return;
		next = Date.now() + 15 * 60_000;
		await cache.sweep();
		if (!process.env.WLP_SNAPSHOT_VERIFY_KEY) return;
		const statement = retentionRequest(identity.uid, identity.machineId, now);
		const response = await fetch(platform + RETENTION_PATH, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
			headers: { "content-type": "application/json" }, body: JSON.stringify({ ...identity, time: now, signature: sign(null, Buffer.from(statement), key).toString("base64url") }) });
		if (!response.ok) { await response.body?.cancel(); return; }
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			if ((size += chunk.length) > 65536) throw new Error("Oversized snapshot retention answer");
			chunks.push(chunk);
		}
		const { generations, proof } = JSON.parse(Buffer.concat(chunks).toString());
		if (!Array.isArray(generations) || generations.length > 500 || !generations.every(s => typeof s === "string" && HASH.test(s))) return;
		if (new SnapshotVerifier(statement).accept({ ...identity, sessionId: "maintenance" }, { kind: "retain", generations }, proof))
			await cache.sweep(identity.uid, new Set(generations));
	};
}
