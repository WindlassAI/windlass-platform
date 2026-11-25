import type { TextRedactor } from "./attachments.js";
import { judgmentIds, type Judgment } from "./readiness.js";
import { fileReport } from "./review.js";

export function fileReadiness(args: unknown, redactor: TextRedactor, take: (result: Judgment) => void): string {
	try {
		return fileReport(args, redactor, report => {
			const raw = JSON.parse(report.description)?.findings;
			if (!Array.isArray(raw) || raw.length !== judgmentIds.length) throw new Error("File the three requested checks.");
			const findings = judgmentIds.map(id => {
				const row = raw.find(r => r?.id === id);
				if (!row || typeof row.pass !== "boolean" || typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 200 || /[\r\n]/.test(row.reason))
					throw new Error(`Give ${id} a pass or fail and a short one-line reason.`);
				return { id, pass: row.pass as boolean, reason: row.reason.trim() as string };
			});
			take({ findings });
		});
	} catch (error) {
		return error instanceof SyntaxError ? "File the findings as a JSON object." : error instanceof Error ? error.message : "File the setup checks again.";
	}
}
