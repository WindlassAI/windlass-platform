/**
 * The mock's prepared environments (mock-environments.ts): acme/signal-flags ready here and failed on a machine with an
 * environment problem; Rebuild shows building and then ready; the schedule is saved.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentRow } from "../components/Environments";
import { describe, expect, it, vi } from "vitest";
import { mockEnvironments, mockRebuild, mockSchedule } from "./mock-environments";

describe("prepared environments in the mock", () => {
	it("seeds a ready place and a failed one, classified as the environment's", () => {
		const view = mockEnvironments(7106, 1_000_000_000_000);
		expect(view.environments.map(e => e.state)).toEqual(["ready", "retrying", "failed"]);
		const failed = view.environments[2]!;
		expect(failed.attempt?.failure?.kind).toBe("package_manager");
		expect(failed.attempt?.failure?.excerpt).toContain("ERR_PNPM_BAD_PM_VERSION");
		expect(view.schedule).toBe(24);
	});

	it("shows an interrupted build in normal ink while retrying and offers Rebuild after both retries", () => {
		const now = 1_000_000_000_000;
		const env = mockEnvironments(7106, now).environments.find(e => e.state === "retrying")!;
		const render = (state: "retrying" | "interrupted") =>
			renderToStaticMarkup(
				createElement(EnvironmentRow, {
					env: { ...env, state },
					now,
					busy: false,
					onRebuild: () => undefined,
				}),
			);
		expect(render("retrying")).toContain("Build interrupted — trying again");
		expect(render("retrying")).not.toMatch(/ui-dot-warn|env-failure/);
		expect(render("interrupted")).toContain("Build interrupted after two retries");
		expect(render("interrupted")).toMatch(/<button[^>]*><span>Rebuild<\/span><\/button>/);
		expect(render("interrupted")).not.toContain("disabled");
		expect(mockEnvironments(7106, env.nextAt!).environments.find(e => e.place === env.place)?.state).toBe("building");
		expect(mockEnvironments(7106, env.nextAt! + 4_000).environments.find(e => e.place === env.place)?.state).toBe(
			"ready",
		);
	});

	it("builds on Rebuild and keeps the result", () => {
		vi.useFakeTimers();
		let run: (() => void) | null = null;
		const building = mockRebuild(
			7102,
			undefined,
			1_000_000_000_000,
			(_ms, then) => {
				run = then;
			},
			() => undefined,
		);
		expect(building.environments.map(e => e.state)).toEqual(["building"]);
		run!();
		expect(mockEnvironments(7102, 1_000_000_000_000).environments.map(e => e.state)).toEqual(["ready"]);
		vi.useRealTimers();
	});

	it("has none for a repository with secrets or without a setup command", () => {
		const view = mockEnvironments(7101, 1_000_000_000_000, "Not available for repositories with saved secrets.");
		expect(view.available).toBe(false);
		expect(view.environments).toEqual([]);
	});

	it("saves the schedule", () => {
		const view = mockSchedule(7103, 6, 1_000_000_000_000);
		expect(view.schedule).toBe(6);
		expect(view.scheduleChosen).toBe(true);
	});
});
