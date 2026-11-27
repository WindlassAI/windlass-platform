export { sleep } from "../server/src/util.js";
import { sleep } from "../server/src/util.js";

/**
 * Asks `probe` every `everyMs` until it gives a value other than undefined, null or false, and
 * returns that value. A probe that throws ends the wait with its error. After `timeoutMs` it throws
 * an error naming `what`. A boolean test works too: the wait then resolves to `true`.
 */
export async function waitFor<T>(what: string, probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 30_000, everyMs = 25): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined && value !== null && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await sleep(everyMs);
	}
}
