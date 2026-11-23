import type { BlockedHost, BlockedNetwork } from "./contract.js";

export const emptyNetwork = (): BlockedNetwork => ({ hosts: [], overflow: 0 });
const keyOf = (entry: BlockedHost) => JSON.stringify([entry.host, entry.port]);
const severity = { unlisted: 0, machine_policy: 1, malformed: 2, provider: 3, private: 4 };
const restriction = { repository: 0, deployment: 1, machine: 2, never: 3 };

/** Combine disjoint turns or sessions, never successive snapshots of the same turn. */
export function unionNetwork(...parts: BlockedNetwork[]): BlockedNetwork {
	const entries = new Map<string, BlockedHost>();
	let overflow = 0;
	for (const part of parts) {
		overflow += part.overflow;
		for (const entry of part.hosts) {
			const key = keyOf(entry);
			const kept = entries.get(key);
			if (!kept) { entries.set(key, { ...entry }); continue; }
			kept.count += entry.count;
			if (entry.machineNames) kept.machineNames = [...new Set([...(kept.machineNames ?? []), ...entry.machineNames])];
			kept.firstAt = Math.min(kept.firstAt, entry.firstAt);
			kept.lastAt = Math.max(kept.lastAt, entry.lastAt);
			if (severity[entry.reason] > severity[kept.reason]) kept.reason = entry.reason;
			if (restriction[entry.allow] > restriction[kept.allow]) kept.allow = entry.allow;
		}
	}
	return { hosts: [...entries.values()], overflow };
}

/** The cap survives replacing or resuming the session's sandbox. Keep counting admitted destinations. */
export function limitNetwork(previous: BlockedNetwork, turn: BlockedNetwork): BlockedNetwork {
	const keys = new Set(previous.hosts.map(keyOf));
	let overflow = turn.overflow;
	const hosts = turn.hosts.filter(entry => {
		const key = keyOf(entry);
		if (keys.has(key)) return true;
		if (keys.size < 50) { keys.add(key); return true; }
		overflow += entry.count;
		return false;
	});
	return { hosts, overflow };
}

export function networkBody(body: string, network?: BlockedNetwork): string {
	if (!network || (!network.hosts.length && !network.overflow)) return body;
	const names: string[] = [];
	let rest = network.overflow;
	for (const entry of network.hosts) {
		const host = entry.host?.includes(":") ? "[" + entry.host + "]" : entry.host;
		const name = (host ?? "malformed destination") + (entry.port === null ? "" : ":" + entry.port) + " (" + entry.count + ")";
		if (names.length < 3 && name.length + names.join(", ").length <= 230) names.push(name);
		else rest += entry.count;
	}
	if (rest) names.push(rest + " other request" + (rest === 1 ? "" : "s"));
	const settings = network.hosts.some(entry => entry.allow === "repository") ? " Eligible hosts can be allowed in repository network settings." : "";
	return body + "\n\nBlocked network requests during this work: " + names.join(", ") + "." + settings;
}

/** Read once before setup, then five seconds after each completed read, and once after the turn.
 * finish waits for an outstanding read so that an older result can never follow the final one. */
export async function watchNetwork(read: () => Promise<void>, onFailure: (error: unknown) => void) {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout>;
	let pending: Promise<void>;
	const sample = async () => {
		try { await read(); } catch (error) { onFailure(error); }
	};
	const tick = () => {
		pending = sample().then(() => {
			if (!stopped) timer = setTimeout(tick, 5000);
		});
		return pending;
	};
	await tick();
	return async () => {
		stopped = true;
		clearTimeout(timer);
		await pending;
		await sample();
	};
}
