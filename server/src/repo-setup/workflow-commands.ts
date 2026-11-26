import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

// Only jobs.<id>.steps[].run describes shell commands. A step name or a comment can repeat one.
export function workflowCommands(text: string) {
	const commands = new Map<number, string>();
	const positions = new LineCounter();
	const doc = parseDocument(text, { lineCounter: positions });
	const jobs = doc.get("jobs", true);
	if (doc.errors.length || !isMap(jobs)) return commands;
	const lines = text.split(/\r?\n/);
	for (const { value: job } of jobs.items) {
		const steps = isMap(job) && job.get("steps", true);
		if (!isSeq(steps)) continue;
		for (const step of steps.items) {
			const run = isMap(step) && step.get("run", true);
			if (!isScalar(run) || typeof run.value !== "string" || !run.range) continue;
			const start = positions.linePos(run.range[0]).line;
			const end = positions.linePos(run.range[1] - 1).line;
			if (start === end && !run.value.trimStart().startsWith("#")) commands.set(start, run.value.trim());
			else {
				const shellLines = new Set(run.value.split("\n").map(s => s.trim()));
				for (let n = start + 1; n <= end; n++) {
					const command = lines[n - 1].trim();
					if (command && !command.startsWith("#") && shellLines.has(command)) commands.set(n, command);
				}
			}
		}
	}
	return commands;
}
