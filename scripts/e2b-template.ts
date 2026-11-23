/**
 * Builds the E2B template from a build context. sandbox/e2b/build.sh makes the context and runs this;
 * see its header for what to set.
 *
 *   cd server && npx tsx ../scripts/e2b-template.ts <context> --print      what would be built; nothing is sent
 *   cd server && E2B_API_KEY=... npx tsx ../scripts/e2b-template.ts <context>
 *
 * Building uploads the context to E2B (the Windlass binary is about 85 MB) and runs the Dockerfile's
 * steps there. It starts no sandbox.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOSTED_SIZES, HOSTED_SIZE_SPECS, isHostedSize } from "../server/src/contract.js";
import { readE2bSettings, templateFor, templateVariables } from "../server/src/sandbox/e2b/config.js";
import { buildSandboxTemplate, describeTemplate } from "../server/src/sandbox/e2b/template.js";

const args = process.argv.slice(2);
const print = args.includes("--print");
const context = args.find((arg) => !arg.startsWith("--"));

function number(name: string, fallback: number, least: number, most: number): number {
	const raw = (process.env[name] ?? "").trim();
	if (raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < least || value > most) throw new Error(`${name} must be a whole number from ${least} to ${most}; got "${raw}"`);
	return value;
}

async function main(): Promise<number> {
	const variant = process.env.WLP_SANDBOX_VARIANT ?? "base";
	if (variant !== "base" && variant !== "shots") throw new Error("WLP_SANDBOX_VARIANT must be base or shots");
	const shots = variant === "shots";
	if (context === undefined || !["Dockerfile", "wlp-run", "wlp-pnpm", "windlass", ...(shots ? ["wlp-shot"] : [])].every((file) => existsSync(join(context, file)))) {
		console.error("e2b-template: give the build context: a directory with Dockerfile, wlp-run and windlass, plus wlp-shot for the shots variant (sandbox/e2b/build.sh makes one)");
		return 2;
	}
	// The size: E2B fixes CPUs and memory when a template is built, so each size is a template of its own (config.ts).
	const size = (process.env.WLP_E2B_SIZE ?? "small").trim();
	if (!isHostedSize(size)) throw new Error(`WLP_E2B_SIZE must be one of ${HOSTED_SIZES.join(", ")}; got "${size}"`);
	const settings = readE2bSettings();
	const name = templateFor(settings, size, shots);
	// What the Hobby plan allows a sandbox: up to 8 vCPUs and 8 GiB. The size's figures are what the server prices it at, so
	// WLP_E2B_CPU and WLP_E2B_MEMORY_MB, which override them, are for a test build under another name only.
	const cpuCount = number("WLP_E2B_CPU", HOSTED_SIZE_SPECS[size].cpus, 1, 8);
	const memoryMB = number("WLP_E2B_MEMORY_MB", HOSTED_SIZE_SPECS[size].memoryMiB, 512, 8192);
	if (cpuCount !== HOSTED_SIZE_SPECS[size].cpus || memoryMB !== HOSTED_SIZE_SPECS[size].memoryMiB) console.log(`# Note: ${size} is ${HOSTED_SIZE_SPECS[size].cpus} vCPU and ${HOSTED_SIZE_SPECS[size].memoryMiB} MiB, which the server prices it at; this build differs.`);
	console.log(`# The ${size} template "${name}": ${cpuCount} vCPU, ${memoryMB} MiB. E2B is asked to build this:`);
	console.log(describeTemplate(context, shots));
	if (print) {
		console.log("# --print: nothing was sent to E2B.");
		return 0;
	}
	const apiKey = (process.env.E2B_API_KEY ?? "").trim();
	if (apiKey === "") {
		console.error("e2b-template: E2B_API_KEY is not set, so nothing was built. With --print this prints the template and needs no key.");
		return 2;
	}
	const built = await buildSandboxTemplate(context, { apiKey, name, shots, cpuCount, memoryMB });
	console.log(`# Built: template "${built.name}" (id ${built.templateId}, build ${built.buildId}), ${built.cpuCount} vCPU and ${built.memoryMB} MiB per sandbox.`);
	const variable = templateVariables(size)[shots ? "shotsTemplate" : "template"];
	console.log(`# A server finds it by its name: WLP_SANDBOX=e2b ${variable}=${name}${size === "small" ? "" : `, and offers the size once WLP_E2B_SIZES lists ${size}`}. Next: scripts/e2b-check.ts (docs/operating.md, "E2B").`);
	return 0;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		// The SDK's errors name the build and the reason, never the key.
		console.error(`e2b-template: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	},
);
