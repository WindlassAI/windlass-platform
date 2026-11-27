import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Use the workspace's locked YAML parser, including Actions' supported YAML aliases.
const { parse } = createRequire(new URL("../server/package.json", import.meta.url))("yaml");
const file = process.argv[2] ?? new URL("../.github/workflows/release-images.yml", import.meta.url);
const workflow = parse(readFileSync(file, "utf8"));
function requireRule(ok: unknown, message: string) {
	if (!ok) throw new Error(message);
}
type Job = { uses?: string; permissions?: Record<string, string>; steps?: { uses?: string }[] };
requireRule(
	workflow.permissions?.contents === "read" && Object.keys(workflow.permissions).length === 1,
	"Only contents: read is allowed at workflow scope",
);
requireRule(!("pull_request_target" in workflow.on), "Unexpected privileged trigger");
const pushJobs = ["sandbox", "sandbox-index", "harness", "harness-index", "runner", "sign", "daytona"];
for (const [name, job] of Object.entries(workflow.jobs) as [string, Job][]) {
	for (const [scope, access] of Object.entries(job.permissions ?? {})) {
		const allowed =
			scope === "contents"
				? access === "read" || (name === "release" && access === "write")
				: scope === "packages"
					? access === "read" || (access === "write" && pushJobs.includes(name))
					: scope === "id-token" && access === "write" && ["sign", "release", "daytona"].includes(name);
		requireRule(allowed, `Unexpected permission in ${name}: ${scope}: ${access}`);
	}
	for (const step of [job, ...(job.steps ?? [])]) {
		if (step.uses) requireRule(/^[\w./-]+@[0-9a-f]{40}$/.test(step.uses), `Unpinned action in ${name}: ${step.uses}`);
	}
}
