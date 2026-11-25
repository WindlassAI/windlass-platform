import { guideReference } from "./guide-check.js";

export const rootSections = ["Setup", "Checks by change", "Leave to CI", "Handoff", "Terms"];
export const areaSections = ["Quick commands", "Key files", "Non-obvious patterns", "See also"];

export function requireGuideStructure(path: string, lines: string[], files: ReadonlySet<string>) {
	const root = path === "AGENTS.md";
	const minimum = root ? 30 : 12;
	const sections = new Map<string, string[]>();
	let section: string[] | undefined;
	let fenced = false;
	for (const line of lines) {
		if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
		if (!fenced && /^#{1,2}\s/.test(line)) {
			section = [];
			sections.set(line.trim(), section);
		} else if (line.trim() && !/^(?:\s*#|[| :\-]+$)/.test(line)) section?.push(line);
	}
	for (const title of root ? rootSections : areaSections) {
		const body = sections.get("## " + title);
		if (!body?.length) throw Error(`${path}: include ## ${title} with cited content that survives the evidence checks.`);
		if (title === "Terms" && body.length > 15) throw Error("Include one to fifteen verified terms.");
		if (title === "Key files") {
			const entries = body.filter(line => /^\s*[-*+]\s/.test(line));
			const targets = entries.map(line => {
				const ref = line.match(/`([^`]+)`|\]\(([^)]+)\)/);
				return ref && guideReference(path, (ref[1] ?? ref[2]).split("#")[0]);
			});
			if (entries.length < 3 || entries.length > 5 || new Set(targets).size !== entries.length || targets.some(file => !file || !files.has(file)))
				throw Error(`${path}: list three to five key files, each in its own cited bullet with a distinct file path in backticks or a Markdown link.`);
		}
	}
	const count = lines.filter(line => line.trim()).length;
	if (count < minimum) throw Error(`${path}: only ${count} verified nonblank lines remain. Provide at least ${minimum} with line citations.${root ? "" : " You can omit this folder."}`);
}
