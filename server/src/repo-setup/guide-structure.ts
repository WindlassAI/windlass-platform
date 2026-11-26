import { guideReference } from "./guide-check.js";
import { isSetupSource } from "./source-path.js";

export const requiredSections = ["## Quick commands", "## Key files"];

export function requireGuideStructure(path: string, lines: string[], files: ReadonlySet<string>) {
	const root = path === "AGENTS.md";
	const folder = path.slice(0, path.lastIndexOf("/") + 1);
	// One verified nonblank line per tracked source file under the guide, clamped to 8–30 at root or 8–12 in folders.
	const sourceCount = [...files].filter(file => file.startsWith(folder) && isSetupSource(file)).length;
	const minimum = Math.min(root ? 30 : 12, Math.max(8, sourceCount));
	const sections: { title: string; body: string[] }[] = [];
	let section: string[] | undefined;
	let fenced = false;
	for (const line of lines) {
		if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
		if (!fenced && /^#{1,2}\s/.test(line)) {
			section = [];
			if (line.startsWith("##")) sections.push({ title: line.trim(), body: section });
		} else if (line.trim() && !/^(?:\s*#|[| :\-]+$)/.test(line)) section?.push(line);
	}
	for (const title of requiredSections) {
		if (!sections.some(s => s.title === title && s.body.length)) throw Error(`${path}: include ${title} with cited content that survives the evidence checks.`);
	}
	for (const { title, body } of sections) {
		if (!body.length) throw Error(`${path}: ${title} is empty after evidence checks. Add cited content or leave it out.`);
		if (title === "## Terms" && body.length > 15) throw Error(`${path}: keep at most fifteen verified terms.`);
		if (title === "## Key files") {
			const entries = body.filter(line => /^\s*[-*+]\s/.test(line));
			const targets = entries.map(line => {
				const ref = line.match(/`([^`]+)`|\]\(([^)]+)\)/);
				return ref && guideReference(path, (ref[1] ?? ref[2]).split("#")[0]);
			});
			if (entries.length < (root ? 1 : 3) || entries.length > 5 || new Set(targets).size !== entries.length || targets.some(file => !file || !files.has(file)))
				throw Error(`${path}: list ${root ? "one" : "three"} to five key files, each in its own cited bullet with a distinct file path in backticks or a Markdown link.`);
		}
	}
	const count = lines.filter(line => line.trim()).length;
	if (count < minimum) throw Error(`${path}: only ${count} verified nonblank lines remain. Provide at least ${minimum} with line citations.${root ? "" : " You can omit this folder."}`);
}
