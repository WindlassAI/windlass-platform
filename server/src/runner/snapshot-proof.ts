// Snapshot grants bind the operation to a single accepted session socket. The runner trusts a
// deployment public key from its own configuration, never a key supplied on that socket.
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import type { SnapshotSelection, SnapshotSource } from "../sandbox/snapshot-key.js";

export const RETENTION_PATH = "/runner/snapshot-retention";
export const retentionRequest = (uid: string, machine: string, time: number) => JSON.stringify(["windlass-snapshot-retention-v1", uid, machine, time]);
export interface SnapshotIdentity { uid: string; machineId: string; sessionId: string }
export type SnapshotAction = { kind: "create"; profile: string; size?: number; screenshots: boolean; privateData: boolean; key: SnapshotSelection } |
	{ kind: "save"; id: string; source: SnapshotSource } | { kind: "retain"; generations: string[] };
interface Proof { nonce: string; signature: string }
function message(who: SnapshotIdentity, ticket: string, action: SnapshotAction, nonce: string) {
	let fields: unknown[];
	switch (action.kind) {
		case "retain": fields = action.generations; break;
		case "save": {
			const { repo, inputs, generation, attempt, commit, created } = action.source;
			fields = [action.id, repo, inputs, generation, attempt, commit, created];
			break;
		}
		case "create": {
			const { repo, generation, attempt, inputs } = action.key;
			fields = [action.profile, action.size ?? 1, action.screenshots, action.privateData, action.key.writer, repo, generation, attempt, inputs];
			break;
		}
	}
	return Buffer.from(JSON.stringify(["windlass-snapshot-v1", who.uid, who.machineId, who.sessionId, ticket, nonce, action.kind, ...fields]));
}
export function signSnapshot(who: SnapshotIdentity, ticket: string, action: SnapshotAction): Proof | undefined {
	const pem = process.env.WLP_SNAPSHOT_SIGNING_KEY;
	if (!pem || !ticket) return;
	const key = createPrivateKey(pem);
	if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 snapshot signing key");
	const nonce = randomBytes(16).toString("hex");
	return { nonce, signature: sign(null, message(who, ticket, action, nonce), key).toString("base64url") };
}
export class SnapshotVerifier {
	private seen = new Set<string>();
	constructor(private ticket = "") {}
	attach(ticket: string) {
		if (ticket !== this.ticket) this.seen.clear();
		this.ticket = ticket;
	}
	accept(who: SnapshotIdentity, action: SnapshotAction, proof: Proof) {
		const pem = process.env.WLP_SNAPSHOT_VERIFY_KEY;
		if (!pem || !this.ticket || !proof || !/^[a-f0-9]{32}$/.test(proof.nonce) || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature) || this.seen.size >= 128 || this.seen.has(proof.nonce)) return false;
		try {
			const key = createPublicKey(pem);
			if (key.asymmetricKeyType !== "ed25519" || !verify(null, message(who, this.ticket, action, proof.nonce), key, Buffer.from(proof.signature, "base64url"))) return false;
			this.seen.add(proof.nonce);
			return true;
		} catch { return false; }
	}
}
