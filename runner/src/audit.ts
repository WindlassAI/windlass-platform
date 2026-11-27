import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanClaudeOutput } from "./claude-output.js";
import { directory } from "./state.js";

const files = () =>
	existsSync(directory)
		? readdirSync(directory)
				.filter(name => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
				.sort()
		: [];
let lastDay = "";
export function audit(session: string | null, sandbox: string | null, operation: string, outcome: string): void {
	const time = new Date().toISOString();
	const day = time.slice(0, 10);
	if (day !== lastDay) {
		const first = new Date(Date.now() - 13 * 86400_000).toISOString().slice(0, 10);
		for (const file of files()) if (file.slice(6, 16) < first) rmSync(join(directory, file));
		lastDay = day;
	}
	// Only locally checked ids and an operation name reach this file. Even an error can contain command output.
	appendFileSync(
		join(directory, `audit-${day}.jsonl`),
		JSON.stringify({ time, session, sandbox, operation, outcome }) + "\n",
		{ mode: 0o600 },
	);
}
export function showLog(): void {
	const first = new Date(Date.now() - 13 * 86400_000).toISOString().slice(0, 10);
	for (const file of files()) if (file.slice(6, 16) >= first) process.stdout.write(readFileSync(join(directory, file)));
}

// A newer server can supply its own diagnostic. Keep URLs, long credentials and terminal
// controls out of status, stderr and the operation log.
export function safeSentence(message: string) {
	return cleanClaudeOutput(message)
		.replace(/https?:\/\/\S+|Bearer\s+\S+|[\w.-]{40,}/gi, "[redacted]")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}
