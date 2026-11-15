/**
 * An object store, as much of one as the platform needs: a place outside the sandboxes and outside the
 * actors for one file per agent session (sandbox/backup.ts keeps Windlass's own session data there).
 *
 * The bytes of an object never pass through a server. A server signs a link, hands it to the sandbox
 * that has the file, and the sandbox uploads or downloads by itself: a server runs on a small node
 * with a traffic allowance, and an object may be tens of megabytes after every turn. So the interface
 * is links, and two small questions a server asks for itself (is it there and how large, remove it).
 *
 * A link is good for one object, one method and a few minutes, and one to upload is good for exactly
 * the number of bytes it was made for: whoever holds it can do that one thing and nothing else. It is
 * a secret for as long as it lasts: never logged, never part of an error, an event or an answer.
 *
 *   s3.ts        any store that speaks the S3 protocol (Cloudflare R2, AWS S3, MinIO, ...): only
 *                signed links and plain HEAD and DELETE, nothing of one provider's own
 *   stand-in.ts  the same in memory or in a directory, for the tests and the fake sandbox layer
 */

/** A URL that is its own permission. A secret until `expiresAt`. */
export interface SignedLink {
	url: string;
	/** When it stops working, ms since the epoch. */
	expiresAt: number;
}

export interface ObjectStore {
	/**
	 * A link to upload `key` with: an HTTP PUT of exactly `size` bytes (the `Content-Length` is part of
	 * what is signed), which replaces the object whole. It reads nothing and reaches no other key.
	 */
	linkToPut(key: string, options: { size: number; ttlMs: number }): Promise<SignedLink>;
	/** A link to download `key` with: an HTTP GET. It answers 404 when there is no such object. */
	linkToGet(key: string, options: { ttlMs: number }): Promise<SignedLink>;
	/** How large the object is, in bytes; null when there is none. Throws `ObjectStoreError` when the store could not say. */
	size(key: string): Promise<number | null>;
	/** Removes the object. A no-op when there is none. Throws `ObjectStoreError` when the store could not be told. */
	remove(key: string): Promise<void>;
}

/**
 * The store refused, or could not be reached. The message names the operation and how it failed (an
 * HTTP status, the store's own error code, the kind of network failure) and nothing else: no address,
 * no key of the account's, no link, and nothing the store wrote back.
 */
export class ObjectStoreError extends Error {
	constructor(
		message: string,
		/** The HTTP status the store answered with; null when it did not answer. */
		readonly status: number | null = null,
	) {
		super(message);
		this.name = "ObjectStoreError";
	}
}

/** A key is made of the platform's own names: segments of letters, digits, `.`, `_` and `-`, none of them `.` or `..`. */
const KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function checkKey(key: string): string {
	if (typeof key !== "string" || key.length > 512 || !KEY.test(key) || key.split("/").some((segment) => segment === "." || segment === "..")) throw new ObjectStoreError("invalid object key");
	return key;
}
