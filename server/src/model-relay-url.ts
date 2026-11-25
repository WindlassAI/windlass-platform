/**
 * WLP_MODEL_RELAY_URL (docs/model-relay.md, "Hosted E2B"): the address E2B sandboxes reach the model relay
 * route at. A hostname of its own, so that E2B's `restricted` and `none` networks can allow it by name
 * without allowing the platform's whole public host: the server answers only the relay's model routes when a
 * request's Host is this name (index.ts), and nothing else. E2B matches allowed names only for HTTPS on
 * port 443, so it is an https address with a DNS name, no port and no path.
 */

export const MODEL_RELAY_WINDLASS = "0.6.0";
export const SETTINGS_KEY_WINDLASS = "0.7.1";

/** Whether a Windlass version (`0.7.1`, `0.7.1+build`, `v0.7.2`) meets the minimum relay version. Null or unreadable: no. */
export function readsModelRelay(version: string | null | undefined, minimum = MODEL_RELAY_WINDLASS): boolean {
	const found = /^v?(\d+)\.(\d+)\.(\d+)/.exec((version ?? "").trim());
	if (!found) return false;
	const [major, minor, patch] = found.slice(1).map(Number);
	const [a, b, c] = minimum.split(".").map(Number);
	return major !== a ? major! > a! : minor !== b ? minor! > b! : patch! >= c!;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ModelRelayUrl {
	/** `https://<host>`: Windlass's WINDLASS_MODEL_ALLOWED_ORIGIN. */
	origin: string;
	/** The DNS name, lower case: what E2B allows, and the Host the server serves the relay on. */
	host: string;
}

/** The relay's address, null when unset, or the reason it cannot be one. */
export function parseModelRelayUrl(raw: string | undefined): ModelRelayUrl | null | { problem: string } {
	const text = (raw ?? "").trim();
	if (text === "") return null;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { problem: "WLP_MODEL_RELAY_URL is not an address" };
	}
	const host = url.hostname.toLowerCase();
	const labels = host.split(".");
	const named = host.length <= 253 && labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^\d+$/.test(labels.at(-1)!) && host !== "localhost";
	if (url.protocol !== "https:" || url.port !== "" || !named || (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "")
		return { problem: "WLP_MODEL_RELAY_URL must be an https address with a DNS name, no port and no path, such as https://windlass-relay.example.com" };
	return { origin: `https://${host}`, host };
}

/** The Host header's name, lower case and without a port; null when there is none. */
export function requestHost(header: string | null): string | null {
	if (!header) return null;
	const match = /^([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(header.trim());
	if (!match || (match[2] !== undefined && match[2] !== "443")) return null;
	return match[1]!.toLowerCase().replace(/\.$/, "");
}
