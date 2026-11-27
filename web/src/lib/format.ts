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

/** How long something has run, as a clock reads it: 108_000 → "1:48", 3_729_000 → "1:02:09". */
export function clockDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const pad = (value: number) => String(value).padStart(2, "0");
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

/** 45879 → "45,879". */
/** A length of time in words, for a sentence: "10 minutes", "45 seconds", "1 hour". */
export function spelledDuration(ms: number): string {
	const of = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
	if (ms < 60_000) return of(Math.max(1, Math.round(ms / 1000)), "second");
	if (ms < 3_600_000 || ms % 3_600_000 !== 0) return of(Math.round(ms / 60_000), "minute");
	return of(ms / 3_600_000, "hour");
}

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

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
/** "first" to "tenth" spelled, then "11th". */
export const ordinal = (n: number): string => ORDINALS[n - 1] ?? `${n}th`;

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

export function clockTime(at: number, now: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	return date.toDateString() === new Date(now).toDateString()
		? time
		: `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

export function absoluteTime(at: number): string {
	return new Date(at).toLocaleString("en-GB", {
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
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

/**
 * A length of sandbox time, in the words the server's own sentences use (server/src/usage.ts,
 * `spellSeconds`): "2 h", "1 h 50 min", "12 min", "4 min 5 s", "45 s".
 */
export function sandboxTime(total: number): string {
	const seconds = Math.max(0, Math.round(total));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	if (hours > 0) return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
	if (minutes >= 10 || (minutes > 0 && rest === 0)) return `${minutes} min`;
	if (minutes > 0) return `${minutes} min ${rest} s`;
	return `${seconds} s`;
}

/** A length of sandbox time for a column of them, where they must line up: "1:13:05", "0:04:05". */
export function sandboxClock(total: number): string {
	const seconds = Math.max(0, Math.round(total));
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/** An estimated cost in US dollars: four decimals below a dollar, since a turn costs a fraction of a cent. */
export function usd(amount: number): string {
	return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

/** A time of day in the viewer's own time zone, with the zone's name: "05:30 GMT+5:30". */
export function localTime(at: number): string {
	return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

/** A UTC day ("2026-11-17") as a row's label: "Tue 17 Nov". */
export function utcDay(day: string): string {
	return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	});
}

/** A size in bytes as people read it, in units of 1,024: "2 MB", "1 GB", "512 KB", "1.5 GB". */
export function byteSize(bytes: number): string {
	const units = ["bytes", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const shown =
		unit === 0
			? String(Math.round(value))
			: value >= 10
				? String(Math.round(value))
				: value.toFixed(1).replace(/\.0$/, "");
	return `${shown} ${units[unit]}`;
}
