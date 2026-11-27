/**
 * The E2B template sessions' sandboxes are made from: the Docker image's own Dockerfile
 * (sandbox/Dockerfile), handed to E2B's template builder, so a microVM has what a container has: the
 * user `agent`, /workspace, Windlass's data directory, `wlp-run`, git, bubblewrap, the Windlass binary,
 * and, in the shots variant, `wlp-shot` with Playwright and Chrome headless shell. E2B's builder reads FROM, RUN, COPY
 * (with --chmod), WORKDIR, USER, ENV, ARG and CMD, and passes over LABEL (https://docs.e2b.dev/template/base-image.md, "Parsing existing Dockerfiles"; the
 * SDK's `fromDockerfile`). The last USER and WORKDIR become the sandbox's defaults: `agent`, /workspace.
 *
 * Three things differ from the container, and the provider makes up for each:
 *
 *   ENV      A template's environment is only set while it is built
 *            (https://docs.e2b.dev/template/defining-template.md, "Environment variables"), so LANG and
 *            NO_COLOR are given to every sandbox when it is created (e2b/sandboxes.ts, `SANDBOX_ENVS`).
 *            HOME is the user's own.
 *   CMD      `sleep infinity` keeps a container alive. A microVM needs nothing to stay up, and E2B
 *            would run a CMD as the template's start command while building, so the line is left out
 *            of what the builder is given.
 *   the size E2B sets CPUs and memory when the template is built, not when a sandbox is made
 *            (https://docs.e2b.dev/template/build.md): `cpuCount`, `memoryMB` below.
 *
 * E2B's microVMs are x86_64, so the context must hold the x86_64 Windlass (sandbox/e2b/build.sh sees to
 * it). Nothing here talks to E2B but `buildSandboxTemplate`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Template, type TemplateClass, defaultBuildLogger } from "e2b";
import { DEFAULT_CPU_COUNT, DEFAULT_MEMORY_MB, DEFAULT_TEMPLATE } from "./config.js";

/** The Dockerfile as E2B's builder gets it: without the line that only a container needs. */
export function templateDockerfile(dockerfile: string, shots = false): string {
	// The SDK accepts a single stage. Inline the inherited stage for its shots template.
	const [base, browser] = dockerfile.split(/^FROM base AS shots$/m);
	if (!browser) throw new Error("Missing sandbox Dockerfile shots stage");
	return (base.replace(/^FROM (\S+) AS base$/m, "FROM $1") + (shots ? browser : ""))
		.split("\n")
		.filter(line => !/^CMD\b/.test(line.trim()))
		.join("\n");
}

/**
 * The template, from a build context: a directory that holds `Dockerfile`, `wlp-run` and the Windlass
 * binary as `windlass`, which is what sandbox/build.sh makes for `docker build` too.
 */
export function sandboxTemplate(context: string, shots = false, image?: string): TemplateClass {
	if (image) return Template().fromImage(image).setUser("agent").setWorkdir("/workspace");
	return Template({ fileContextPath: context }).fromDockerfile(
		templateDockerfile(readFileSync(join(context, "Dockerfile"), "utf8"), shots),
	);
}

/** What E2B would be asked to build, as a Dockerfile again: for looking at it without an account. */
export function describeTemplate(context: string, shots = false, image?: string): string {
	return Template.toDockerfile(sandboxTemplate(context, shots, image));
}

export interface BuildTemplateOptions {
	apiKey: string;
	/** Default `windlass-platform-sandbox`: what WLP_E2B_TEMPLATE names. */
	name?: string;
	shots?: boolean;
	image?: string;
	cpuCount?: number;
	memoryMB?: number;
}

/** Builds the template at E2B and waits for it: uploads the context, runs the steps, snapshots the result. Uses the account's build minutes, and no sandbox afterwards. */
export async function buildSandboxTemplate(
	context: string,
	options: BuildTemplateOptions,
): Promise<{ name: string; templateId: string; buildId: string; cpuCount: number; memoryMB: number }> {
	const name = options.name ?? DEFAULT_TEMPLATE;
	const cpuCount = options.cpuCount ?? DEFAULT_CPU_COUNT;
	const memoryMB = options.memoryMB ?? DEFAULT_MEMORY_MB;
	const built = await Template.build(sandboxTemplate(context, options.shots, options.image), name, {
		apiKey: options.apiKey,
		cpuCount,
		memoryMB,
		onBuildLogs: defaultBuildLogger(),
	});
	return { name: built.name, templateId: built.templateId, buildId: built.buildId, cpuCount, memoryMB };
}
