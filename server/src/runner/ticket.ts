/**
 * The ticket a session hands its machine's runner, through the machine actor, to open the session's
 * socket (Plans/2026-11-19 "bring your own computer", sections 1.4 and 3).
 *
 * A ticket is 32 random bytes that only the session actor's instance that made it knows: it keeps them
 * in memory, as it keeps its channel, so no other instance and no other actor can take one, and an
 * instance that slept or moved has none of its predecessor's. That is why it needs no signature of the
 * server's: the one instance that checks a ticket is the one that made it. Each is good once, for
 * TICKET_MS. The runner signs `sessionProof` over it with the machine's key, so a ticket that reached
 * someone else is no use to them either.
 */
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { sessionProof } from "./control.js";
import type { Hello } from "./protocol.js";

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
	/** Ticket → when it stops being good. */
	private readonly issued = new Map<string, number>();

	issue(now = Date.now()): string {
		for (const [ticket, until] of this.issued) if (until <= now) this.issued.delete(ticket);
		const ticket = randomBytes(32).toString("base64url");
		this.issued.set(ticket, now + TICKET_MS);
		return ticket;
	}

	/**
	 * Whether a hello may open the session's socket. Synchronous, and the ticket is used up by being
	 * shown, whatever the answer: a hello that is refused does not leave it for another try.
	 */
	admits(hello: Hello, expected: Expected, now = Date.now()): boolean {
		const until = this.issued.get(hello.ticket);
		this.issued.delete(hello.ticket);
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
