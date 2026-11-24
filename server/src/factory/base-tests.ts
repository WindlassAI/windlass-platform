/** Reproduce only test identifiers reported by CI, using fixed runner commands on a copy of the base commit. */
import { stripVTControlCharacters } from "node:util";
import { randomBytes } from "node:crypto";
import type { SandboxHandle } from "../sandbox/api.js";
import { isolatedCommand } from "../sandbox/platform-checks.js";
import { shellQuote } from "../sandbox/provider.js";

export type NamedTests = { runner: "pytest" | "node" | "go" | "vitest" | "jest" | "js-files"; names: string[] };
export type BaseTestResult = "failed" | "passed" | "unknown";

export function namedTests(output: string, expectedRunner?: NamedTests["runner"]): NamedTests | null {
	output = stripVTControlCharacters(output).replace(/\r/g, "");
	const patterns: [NamedTests["runner"], RegExp][] = [
		["pytest", /^\s*FAILED\s+([\w./-]+\.py::[^\r\n]+?)(?: - |\s*$)/gm],
		["vitest", /^\s*FAIL\s+[\w./-]+\.[cm]?[jt]sx?\s+>\s+(.+)$/gm],
		["jest", /^\s*●\s+(.+?\s›\s.+)$/gm],
		["go", /^\s*--- FAIL: (Test\w+)(?:\s+\(|$)/gm],
		["node", /^\s*not ok \d+ - (.+?)(?: #.*)?$/gm],
		["node", /^\s*✖ (.+?) \([\d.]+ms\)$/gm],
		["js-files", /^\s*FAIL\s+([\w][\w./-]*\.(?:spec|test)\.[cm]?[jt]sx?)\s*$/gm],
	];
	for (const [runner, pattern] of patterns) {
		if (expectedRunner && expectedRunner !== runner) continue;
		const names = [...new Set(Array.from(output.matchAll(pattern), m => m[1]!.trim()))].sort();
		if (names.length && names.length <= 40 && names.every(n => n.length <= 500 && !/[\x00-\x1f]/.test(n))) {
			if (runner === "pytest" && names.some(n => !/^[\w][\w./-]*\.py::[\w]/.test(n) || n.split("::")[0]!.split("/").includes(".."))) return null;
			if (runner === "js-files" && names.some(n => n.split("/").includes(".."))) return null;
			return { runner, names };
		}
	}
	return null;
}

function testCommand({ runner, names }: NamedTests): string {
	if (runner === "pytest") return "python3 -m pytest -q -- " + names.map(shellQuote).join(" ");
	if (runner === "js-files") {
		const files = names.map(n => shellQuote("./" + n)).join(" ");
		return `if [ -x node_modules/.bin/vitest ]; then node_modules/.bin/vitest run ${files}; elif [ -x node_modules/.bin/jest ]; then node_modules/.bin/jest --runInBand --runTestsByPath ${files}; else exit 127; fi`;
	}
	const labels = runner === "jest" || runner === "vitest" ? names.map(n => n.split(runner === "jest" ? " › " : " > ").join(" ")) : names;
	const pattern = shellQuote("^(" + labels.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")$");
	switch (runner) {
		case "node": return "node --test --test-reporter=tap --test-name-pattern=" + pattern;
		case "go": return "go test -count=1 -run " + pattern + " ./...";
		case "jest": return "./node_modules/.bin/jest --runInBand --testNamePattern=" + pattern;
		case "vitest": return "./node_modules/.bin/vitest run --reporter=verbose --testNamePattern=" + pattern;
	}
}

/** A missing runtime, setup error or different failing test cannot establish a failure on the base. */
export async function runBaseTests(sandbox: Pick<SandboxHandle, "run">, cwd: string, base: string, tests: NamedTests, isolated: boolean): Promise<BaseTestResult> {
	if (!/^[0-9a-f]{40}$/.test(base)) return "unknown";
	const copy = "/tmp/wlp-base-" + randomBytes(16).toString("hex");
	try {
		const prepared = await sandbox.run([
			"set -eu", "set -o pipefail", `mkdir -m 700 ${copy}`,
			`GIT_NO_REPLACE_OBJECTS=1 git archive --format=tar ${base} | tar -xf - -C ${copy}`,
			// Reuse installed JS dependencies only when the manifests and lockfiles still match the base.
			...(["node", "js-files", "jest", "vitest"].includes(tests.runner) ? [
				`if [ -d node_modules ] && [ ! -L node_modules ] && [ ! -e ${copy}/node_modules ] && [ ! -L ${copy}/node_modules ] && git diff --quiet ${base} -- ':(glob)**/package.json' '*lock*'; then cp -a --reflink=auto node_modules ${copy}/node_modules; fi`,
			] : []),
		].join("\n"), { cwd, timeoutMs: 60_000 });
		if (prepared.exitCode !== 0) return "unknown";
		const command = testCommand(tests);
		const ran = await sandbox.run(isolated ? isolatedCommand(copy, command) : command, { cwd: copy, timeoutMs: 120_000 });
		if (ran.aborted || ran.timedOut || ran.exitCode === null) return "unknown";
		if (ran.exitCode === 0) return "passed";
		const repeated = namedTests(ran.stdout + "\n" + ran.stderr, tests.runner);
		return repeated?.runner === tests.runner && tests.names.every(n => repeated.names.includes(n)) ? "failed" : "unknown";
	} finally {
		await sandbox.run("rm -rf -- " + copy, { timeoutMs: 30_000 }).catch(() => undefined);
	}
}
