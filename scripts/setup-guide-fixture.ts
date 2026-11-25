// Put the note citation near the top so the filing checks can assert its exact published line.
export function setupGuide(area: string, title: string, note: string, extra = "") {
	const lines = area ? [
		title, "## Quick commands", note, "Start from the repository root.",
		"## Key files", "- `f0.ts` defines the first fixture.", "- `f1.ts` defines the second fixture.", "- `f2.ts` defines the third fixture.",
		"## Non-obvious patterns", "Keep fixtures independent.", "Preserve existing exports.",
		"## See also", "Read the [repository readme](../README.md).",
	] : [
		title, "## Terms", note, ...extra.split("\n").filter(Boolean),
		"## Setup", "Start from the repository root.", "Read the setup instructions first.", "Check the required runtime.",
		"Install the listed dependencies.", "Use the pinned tool versions.", "Keep the lockfile in sync.",
		"## Checks by change", "Run the checks for the affected area.", "Select the test for the changed behavior.",
		"Check source changes with their fixtures.", "Include a regression case for fixes.", "Check references when moving a guide.",
		"Run the relevant typecheck.", "Record each result.",
		"## Leave to CI", "CI covers all supported runtimes.", "The matrix checks each supported platform.",
		"Wait for the build jobs.", "Inspect a failed job before retrying.", "Check the result on the pushed commit.",
		"## Handoff", "Summarize the behavior change.", "Name the files that carry it.", "List the commands you ran.",
		"Report their outcomes.", "Call out any remaining verification.", "Link related guidance.",
	];
	const content = lines.join("\n") + "\n";
	return { kind: area ? "area" : "guide", path: area ? area + "/AGENTS.md" : "AGENTS.md", content,
		lines: content.split("\n").flatMap((line, i) => line && !line.startsWith("#") && !extra.split("\n").includes(line)
			? [{ line: i + 1, evidence: { file: "README.md", line: 1 }, noteId: line === note ? "team" : undefined }] : []) };
}
