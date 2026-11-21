/**
 * The ticket a session hands its machine's runner, through the machine actor, to open the session's
 * socket (Plans/2026-11-19 "bring your own computer", sections 1.4 and 3).
 *
 * A ticket is 32 random bytes. Only the issuing session instance remembers its keyed digest,
 * under the attach-ticket HKDF label. It consumes that entry on the first presentation, and
 * forgets all entries when it sleeps or moves. The runner signs `sessionProof` over the opaque
 * ticket with its machine key. Tickets expire after TICKET_MS.
 */
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { keyedDigest } from "../signatures.js";
import { sessionProof } from "../runner/control.js";
import type { Hello } from "../runner/protocol.js";

export const TICKET_MS = 60_000;

/** Who a session's socket must come from. */
export interface Expected {
	uid: string;
	sessionId: string;
	machineId: string;
	/** The machine's Ed25519 key, SPKI in base64, as its actor last gave it; null before it gave one. */
	publicKey: string | null;
}

export class AttachTickets {
	/** Keyed digest of the ticket → when it stops being good. */
	private readonly issued = new Map<string, number>();

	issue(now = Date.now()): string {
		for (const [ticket, until] of this.issued) if (until <= now) this.issued.delete(ticket);
		const ticket = randomBytes(32).toString("base64url");
		this.issued.set(keyedDigest("attach-ticket", ticket).toString("hex"), now + TICKET_MS);
		return ticket;
	}

	/**
	 * Whether a hello may open the session's socket. Synchronous, and the ticket is used up by being
	 * shown, whatever the answer: a hello that is refused does not leave it for another try.
	 */
	admits(hello: Hello, expected: Expected, now = Date.now()): boolean {
		const digest = keyedDigest("attach-ticket", hello.ticket).toString("hex");
		const until = this.issued.get(digest);
		this.issued.delete(digest);
		if (until === undefined || until <= now) return false;
		if (hello.machineId !== expected.machineId || expected.publicKey === null) return false;
		return signedBy(expected.publicKey, sessionProof(expected.uid, expected.sessionId, expected.machineId, hello.ticket), hello.signature);
	}
}

function signedBy(spki: string, message: string, signature: string): boolean {
	try {
		const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
		return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
	} catch {
		return false;
	}
}
