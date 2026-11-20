/**
 * The one-line reading of a tool call: what it acts on (`read src/cart.js`, `shell bun test`) and a
 * few facts about how it went (`13 lines`, `exit 1`, `+1 -1`), as the terminal interface writes them.
 * The platform's own tools (server/src/agent-publish.ts) are read from the platform's answer, which
 * is the call's output: what a push went to and at which commit, what was fetched, or that it was not.
 */
import { isRecord, type ToolBlock } from "./timeline";

export interface ToolSummary {
	/** The path, command or pattern: shown in monospace after the tool's name. */
	target: string;
	facts: string[];
	/** The exit code of a command, when it has one. */
	exitCode: number | null;
}

/** The call's arguments, when the text is (already) whole JSON. */
export function parseInput(inputText: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(inputText);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** One string argument out of argument text that may still be streaming in. */
function partialString(inputText: string, key: string): string | null {
	const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(inputText);
	if (!match || match[1] === undefined) return null;
	try {
		return JSON.parse(`"${match[1].replace(/\\$/, "")}"`) as string;
	} catch {
		return match[1];
	}
}

const TARGET_KEYS: Record<string, string[]> = {
	read: ["path"],
	write: ["path"],
	edit: ["path"],
	shell: ["command"],
	glob: ["pattern"],
	grep: ["pattern"],
	// The platform's tools: a pull request's or a report's title, a push's commit message.
	publish: ["title"],
	report: ["title"],
	push: ["message"],
};

/**
 * A call of the platform's `push` or `fetch_base`, as the platform's answer says it went. The answers
 * are the platform's sentences (agent-publish.ts `pushedForAgent`, `nothingToPush`, `fetchedForAgent`,
 * and the refusals, which all begin "Not pushed." or "Not fetched."). Null while there is no answer,
 * or for another tool.
 */
function platformCall(block: ToolBlock): { target: string | null; facts: string[] } | null {
	const output = block.output;
	if (output === null || (block.name !== "push" && block.name !== "fetch_base")) return null;
	if (block.name === "push") {
		if (output.startsWith("Not pushed.")) {
			// A push refused for naming another branch reads as what it named.
			const named = parseInput(block.inputText)?.branch;
			return { target: typeof named === "string" && named.trim() !== "" ? named.trim() : null, facts: ["not pushed"] };
		}
		const nothing = /^Nothing to push: (\S+) at GitHub/.exec(output);
		if (nothing) return { target: nothing[1] ?? null, facts: ["nothing new"] };
		const pushed = /^Pushed to (\S+?)(?: \(([0-9a-f]{7,})\))?\.(?:\s|$)/.exec(output);
		if (!pushed) return null;
		const pull = /Pull request #(\d+) shows it/.exec(output);
		return {
			target: pushed[1] ?? null,
			facts: [...(pushed[2] ? [pushed[2]] : []), ...(output.includes("It replaced what the platform had pushed") ? ["replaced the last push"] : []), ...(pull ? [`pull request #${pull[1]}`] : [])],
		};
	}
	if (output.startsWith("Not fetched.")) return { target: null, facts: ["not fetched"] };
	const fetched = /^Fetched (\S+) from GitHub into the workspace as (\S+?)\.(?:\s|$)/.exec(output);
	return fetched ? { target: fetched[1] ?? null, facts: [`as ${fetched[2]}`] } : null;
}

function targetOf(block: ToolBlock): string {
	const input = parseInput(block.inputText);
	const read = (key: string): string | null => {
		const value = input ? input[key] : partialString(block.inputText, key);
		return typeof value === "string" ? value : null;
	};
	// A subagent is named by the first line of its task, as Windlass names it.
	if (block.name === "subagent") {
		const task = read("task");
		if (task !== null) return task.trim().split("\n", 1)[0] ?? "";
	}
	if (block.name === "grep") {
		const pattern = read("pattern");
		const path = read("path");
		if (pattern !== null) return path ? `${pattern} in ${path}` : pattern;
	}
	for (const key of TARGET_KEYS[block.name] ?? ["path", "command", "pattern", "query", "url", "name"]) {
		const value = read(key);
		if (value !== null) return value;
	}
	if (input) {
		const first = Object.values(input).find((value): value is string => typeof value === "string");
		if (first !== undefined) return first;
		const text = JSON.stringify(input);
		return text === "{}" ? "" : text;
	}
	return "";
}

function diffStat(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

export function summarizeTool(block: ToolBlock): ToolSummary {
	const facts: string[] = [];
	const platform = platformCall(block);
	if (platform) facts.push(...platform.facts);
	const display = block.display ?? {};
	let exitCode: number | null = null;
	if (typeof display.lines === "number") facts.push(`${display.lines} ${display.lines === 1 ? "line" : "lines"}`);
	if (typeof display.matches === "number") facts.push(`${display.matches} ${display.matches === 1 ? "match" : "matches"}`);
	if (typeof display.files === "number") facts.push(`${display.files} ${display.files === 1 ? "file" : "files"}`);
	if (typeof display.diff === "string") {
		const { added, removed } = diffStat(display.diff);
		facts.push(`+${added} -${removed}`);
	}
	if (typeof display.exitCode === "number") {
		exitCode = display.exitCode;
		facts.push(`exit ${display.exitCode}`);
	} else if (typeof display.signal === "string") facts.push(display.signal);
	if (display.timedOut === true) facts.push("timed out");
	if (block.truncated) facts.push(`${block.truncated.originalLines.toLocaleString("en-US")} lines, capped`);
	return { target: (platform?.target ?? targetOf(block)).replace(/\s*\n\s*/g, " ↵ "), facts, exitCode };
}

/** The call's arguments for the expanded body: pretty JSON, with a long string value kept readable. */
export function formatInput(block: ToolBlock): string {
	const input = parseInput(block.inputText);
	if (!input) return block.inputText;
	const keys = Object.keys(input);
	// A single command or path reads better bare than as JSON.
	if (keys.length === 1 && keys[0] !== undefined && typeof input[keys[0]] === "string") return input[keys[0]] as string;
	return keys
		.map((key) => {
			const value = input[key];
			const text = typeof value === "string" ? value.replace(/\n$/, "") : JSON.stringify(value, null, 2);
			return text.includes("\n") ? `${key}:\n${text.replace(/^/gm, "  ")}` : `${key}: ${text}`;
		})
		.join("\n");
}
