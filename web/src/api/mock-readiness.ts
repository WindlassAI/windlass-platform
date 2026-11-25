import { scoreReadiness, type RepositoryReadiness } from "../../../server/src/factory/readiness";

export function mockSetupChecks(at: number, setup: boolean, checks: boolean, finished: boolean, weekly: boolean): RepositoryReadiness {
	const latest = scoreReadiness([
		{ id: "setup", pass: setup ? finished || null : false, reason: !setup ? "No setup command is saved." : finished ? "The latest build installed the project with one command." : "Setup command saved. Finish setup to check that it works." },
		{ id: "checks", pass: checks ? finished || null : false, reason: !checks ? "No checks are saved." : finished ? "Both saved checks passed in 43 seconds." : "Checks saved. Finish setup to check their results and time." },
		{ id: "guide", pass: finished || null, reason: finished ? "The root guide names the working setup and check commands." : "AGENTS.md found. Finish setup to check its instructions." },
		{ id: "areas", pass: false, reason: "src/services has 78 source files and no guide." },
		{ id: "templates", pass: true, reason: "Both templates are present." },
		{ id: "size", pass: true, reason: "The largest source file has 680 lines." },
		{ id: "ci", pass: true, reason: "The test workflow runs on pull requests." },
		{ id: "secrets", pass: false, reason: "Environment files are ignored. No secret scan was found." },
	], at);
	return { latest, weekly, running: false, error: null };
}
