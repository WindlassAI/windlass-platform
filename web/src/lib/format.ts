/** Small formatters, in the manner of the Windlass terminal interface. */

/** 13 → "13ms", 4284 → "4.3s", 20_000 → "20s", 135_000 → "2m 15s". */
export function duration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds - minutes * 60);
	if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes - hours * 60}m`;
}

/** 45879 → "45,879". */
export function count(value: number): string {
	return value.toLocaleString("en-US");
}

/** 4500 → "4.5k", 272000 → "272k", 1_200_000 → "1.2M". */
export function compact(value: number): string {
	if (value < 1000) return String(value);
	if (value < 100_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 0.784 → "78%". */
export function percent(share: number | null): string {
	return share === null ? "–" : `${Math.round(share * 100)}%`;
}

export function plural(value: number, one: string, many = `${one}s`): string {
	return `${count(value)} ${value === 1 ? one : many}`;
}

const UNITS: Array<[limit: number, size: number, name: string]> = [
	[60_000, 1000, "s"],
	[3_600_000, 60_000, "m"],
	[86_400_000, 3_600_000, "h"],
	[30 * 86_400_000, 86_400_000, "d"],
];

/** "now", "42s ago", "5m ago", "3h ago", "2d ago", then a date. */
export function relativeTime(at: number, now: number): string {
	const elapsed = Math.max(0, now - at);
	if (elapsed < 10_000) return "now";
	for (const [limit, size, name] of UNITS) if (elapsed < limit) return `${Math.floor(elapsed / size)}${name} ago`;
	return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function absoluteTime(at: number): string {
	return new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A day without its time: "16 Dec 2026". */
export function day(at: number): string {
	return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "9:41" left of a countdown, or "0:00". */
export function countdown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** ses_7a1d10cc0b4aa58b9dcc → "ses_7a1d10cc…0b4aa5". */
export function shortId(id: string, head = 12, tail = 6): string {
	return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}
