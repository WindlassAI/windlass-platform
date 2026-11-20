/**
 * An object store, as much of one as the platform needs: a place outside the sandboxes and outside the
 * actors for session backups and work-item screenshots.
 *
 * Object transfers run directly between storage and the sandbox or viewer. A server signs a link for the sandbox
 * that has the file, and the sandbox uploads or downloads by itself. A server runs on a small node
 * with a traffic allowance. Its own reads are the object size and, for a screenshot, the 33-byte PNG header.
 *
 * A link is good for one object, one method and a few minutes, and one to upload is good for exactly
 * the number of bytes it was made for: whoever holds it can do that one thing and nothing else. It is
 * a secret for as long as it lasts: never logged, never part of an error, an event or an answer.
 *
 *   s3.ts        any store that speaks the S3 protocol (Cloudflare R2, AWS S3, MinIO, ...): only
 *                signed links, HEAD, ranged GET and DELETE
 *   stand-in.ts  the same in memory or in a directory, for the tests and the fake sandbox layer
 */

/** A URL that is its own permission. A secret until `expiresAt`. */
export interface SignedLink {
	url: string;
	/** When it stops working, ms since the epoch. */
	expiresAt: number;
}

export interface PutOptions { size: number; ttlMs: number; contentType?: string }
export interface GetOptions { ttlMs: number; contentType?: string; disposition?: "inline" }

export interface ObjectStore {
	/**
	 * A link to upload `key` with: an HTTP PUT of exactly `size` bytes (the `Content-Length` is part of
	 * what is signed), which replaces the object whole. It reads nothing and reaches no other key.
	 */
	linkToPut(key: string, options: PutOptions): Promise<SignedLink>;
	/** A link to download `key` with: an HTTP GET. It answers 404 when there is no such object. */
	linkToGet(key: string, options: GetOptions): Promise<SignedLink>;
	/** How large the object is, in bytes; null when there is none. Throws `ObjectStoreError` when the store could not say. */
	size(key: string): Promise<number | null>;
	/** Read only the first bytes for a file signature. */
	readStart(key: string, bytes: number): Promise<Uint8Array | null>;
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
