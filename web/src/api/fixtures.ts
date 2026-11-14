/**
 * The recorded `windlass --json` runs in fixtures/windlass-events/, parsed. Used by the mock client
 * (which replays them as live turns) and by the reducer's tests. Loaded through Vite's glob import,
 * so the files stay where they are and are only bundled into the chunk that asks for them.
 */
import type { WindlassEvent } from "@contract";

const files = import.meta.glob<string>("../../../fixtures/windlass-events/*.jsonl", { query: "?raw", import: "default", eager: true });

function parse(text: string): WindlassEvent[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as WindlassEvent);
}

/** Every fixture by its file name without the extension, e.g. "demo-two-parallel-tool-calls". */
export const FIXTURES: Record<string, WindlassEvent[]> = Object.fromEntries(
	Object.entries(files)
		.map(([path, text]) => [path.split("/").at(-1)?.replace(/\.jsonl$/, "") ?? path, parse(text)] as const)
		.sort(([a], [b]) => a.localeCompare(b)),
);

export function fixture(name: string): WindlassEvent[] {
	const events = FIXTURES[name];
	if (!events) throw new Error(`no such fixture: ${name}`);
	return events;
}
