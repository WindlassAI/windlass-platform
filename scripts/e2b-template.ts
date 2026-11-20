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
import { DEFAULT_CPU_COUNT, DEFAULT_MEMORY_MB, readE2bSettings } from "../server/src/sandbox/e2b/config.js";
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
	if (context === undefined || !["Dockerfile", "wlp-run", "windlass", ...(shots ? ["wlp-shot"] : [])].every((file) => existsSync(join(context, file)))) {
		console.error("e2b-template: give the build context: a directory with Dockerfile, wlp-run and windlass, plus wlp-shot for the shots variant (sandbox/e2b/build.sh makes one)");
		return 2;
	}
	const settings = readE2bSettings();
	const name = shots ? settings.shotsTemplate : settings.template;
	// What the Hobby plan allows a sandbox: up to 8 vCPUs and 8 GiB. The defaults are the least this layer asks for.
	const cpuCount = number("WLP_E2B_CPU", DEFAULT_CPU_COUNT, 1, 8);
	const memoryMB = number("WLP_E2B_MEMORY_MB", DEFAULT_MEMORY_MB, 512, 8192);
	console.log(`# The template "${name}": ${cpuCount} vCPU, ${memoryMB} MiB. E2B is asked to build this:`);
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
	console.log(`# A server finds it by its name: WLP_SANDBOX=e2b ${shots ? "WLP_E2B_SHOTS_TEMPLATE" : "WLP_E2B_TEMPLATE"}=${name}. Next: scripts/e2b-check.ts (README, "E2B").`);
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
