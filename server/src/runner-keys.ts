import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newPairCode(): string {
	const digits = [...randomBytes(8)].map(n => ALPHABET[n & 31]).join("");
	return digits.slice(0, 4) + "-" + digits.slice(4);
}

export function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function codeDigest(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 32) return null;
	const code = value.toUpperCase().replace(/[ -]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
	return code.length === 8 && [...code].every(c => ALPHABET.includes(c)) ? digest(code) : null;
}

/** One stored representation, also what a session receives with its attach ticket. */
export function publicSpki(pem: string): string | null {
	if (!pem.startsWith("-----BEGIN PUBLIC KEY-----")) return null;
	try {
		const key = createPublicKey(pem);
		return key.asymmetricKeyType === "ed25519" ? key.export({ format: "der", type: "spki" }).toString("base64") : null;
	} catch {
		return null;
	}
}

export function signed(spki: string, message: string, signature: string): boolean {
	const key = createPublicKey({ key: Buffer.from(spki, "base64"), type: "spki", format: "der" });
	return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
}

/** Rivet and system errors may include a request in their message. Log only their category. */
export function machineError(operation: string, error: unknown): void {
	const code = (error as { code?: unknown } | null)?.code;
	const cause =
		typeof code === "string" && /^[a-zA-Z_]{1,64}$/.test(code) ? code : error instanceof Error ? error.name : "unknown";
	console.error(`[wlp] ${operation} failed (${cause})`);
}
