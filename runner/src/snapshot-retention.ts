import { randomBytes, sign, type KeyObject } from "node:crypto";
import { RETENTION_PATH, retentionRequest, verifyRetention, type Trust } from "../../server/src/runner/frame-auth.js";
import { DockerSnapshots } from "../../server/src/sandbox/snapshots.js";
import type { StoreLimits } from "../../server/src/sandbox/store-limits.js";
import { image } from "./policy.js";
import { loadPair, type Identity } from "./state.js";

export async function dropPreviousSnapshots(identity: Identity) {
	const paired = loadPair();
	if (paired?.current.machineId !== identity.machineId || paired.current.uid !== identity.uid) return;
	for (const old of paired.previous) await new DockerSnapshots(old.machineId, image).drop(old.uid);
}

/** `limits`: the machine's store limits in force (`Executor.storeLimits`), read at each sweep. */
export function snapshotMaintenance(
	identity: Identity,
	key: KeyObject,
	platform: string,
	trust: Trust | null,
	limits: () => StoreLimits,
) {
	let next = 0;
	const cache = new DockerSnapshots(identity.machineId, image, undefined, limits);
	return async (now: number) => {
		if (Date.now() < next) return;
		next = Date.now() + 15 * 60_000;
		await dropPreviousSnapshots(identity);
		await cache.sweep(identity.uid);
		if (!trust) return;
		const nonce = randomBytes(32).toString("base64url");
		const statement = retentionRequest(identity.uid, identity.machineId, now, nonce);
		const response = await fetch(platform + RETENTION_PATH, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(5000),
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...identity,
				time: now,
				nonce,
				signature: sign(null, Buffer.from(statement), key).toString("base64url"),
			}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return;
		}
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			if ((size += chunk.length) > 65536) throw new Error("Oversized snapshot retention answer");
			chunks.push(chunk);
		}
		const answer = JSON.parse(Buffer.concat(chunks).toString());
		await cache.sweep(identity.uid, verifyRetention(statement, answer, trust));
	};
}
