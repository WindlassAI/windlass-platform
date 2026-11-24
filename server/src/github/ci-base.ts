import { namedTests, type BaseTestResult, type NamedTests } from "../factory/base-tests.js";
import { readCi, type CiReading, type CiTarget } from "./ci.js";
import type { GithubApp } from "./app.js";

/** Compare failures by reporter and check name. Only a missing completed result needs a sandbox test. */
export async function checkBaseFailures(app: GithubApp, target: CiTarget, reading: Extract<CiReading, { kind: "read" }>,
	test: (tests: NamedTests) => Promise<BaseTestResult | "pending">): Promise<void> {
	const failed = reading.runs.filter(run => run.state === "failed" && !run.environment);
	if (!failed.length) return;
	const base = await readCi(app, target, { baseResultsOnly: true });
	for (const run of failed) {
		const same = base.kind === "read" && base.head === target.head ? base.runs.find(check => check.name === run.name && check.app === run.app) : null;
		if (same?.state === "failed") run.baseResult = "failed";
		else if (same?.state === "pending" || base.kind === "rate_limited" || base.kind === "failed" || (base.kind === "read" && base.head !== target.head)) run.baseResult = "pending";
		else if (same?.state !== "passed") {
			const tests = namedTests(run.summary + "\n" + (reading.logs.find(log => log.name === run.name)?.text ?? ""));
			if (tests) {
				const result = await test(tests);
				if (result !== "passed") run.baseResult = result;
			}
		}
	}
}
