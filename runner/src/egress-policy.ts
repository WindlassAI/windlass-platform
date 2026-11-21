import { isIP } from "node:net";
import { egressMode } from "../../server/src/runner/control.js";
import type { EgressMode } from "../../server/src/contract.js";
import { RunnerError } from "./state.js";

export interface Egress { mode: EgressMode; allow: string[] }
export const restricted: Egress = { mode: "restricted", allow: [] };
export const open: Egress = { mode: "open", allow: [] };
export function egressFlags(mode?: string, hosts?: string): Egress | undefined {
	if (mode === undefined && hosts === undefined) return;
	mode ??= "restricted";
	if (!egressMode(mode)) throw new RunnerError("Use --egress open, restricted or none.");
	const allow = hosts === undefined ? [] : hosts.toLowerCase().split(",").map(host => host.trim());
	if (hosts !== undefined && (mode !== "restricted" || allow.length > 64 || allow.some(host =>
		host.length > 253 || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || isIP(host) || /^\d+$/.test(host.split(".").at(-1)!))))
		throw new RunnerError("Use --egress-allow with restricted and up to 64 comma-separated DNS hostnames.");
	return { mode, allow: [...new Set(allow)].sort() };
}
