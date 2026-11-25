/**
 * The mock's prepared environments (mock-environments.ts): acme/signal-flags ready here and failed on a machine with an
 * environment problem; Rebuild shows building and then ready; the schedule is saved.
 */
import { describe, expect, it, vi } from "vitest";
import { mockEnvironments, mockRebuild, mockSchedule } from "./mock-environments";

describe("prepared environments in the mock", () => {
	it("seeds a ready place and a failed one, classified as the environment's", () => {
		const view = mockEnvironments(7106, 1_000_000_000_000);
		expect(view.environments.map((e) => e.state)).toEqual(["ready", "failed"]);
		const failed = view.environments[1]!;
		expect(failed.attempt?.failure?.kind).toBe("package_manager");
		expect(failed.attempt?.failure?.excerpt).toContain("ERR_PNPM_BAD_PM_VERSION");
		expect(view.schedule).toBe(24);
	});

	it("builds on Rebuild and keeps the result", () => {
		vi.useFakeTimers();
		let run: (() => void) | null = null;
		const building = mockRebuild(7102, undefined, 1_000_000_000_000, (_ms, then) => { run = then; }, () => undefined);
		expect(building.environments.map((e) => e.state)).toEqual(["building"]);
		run!();
		expect(mockEnvironments(7102, 1_000_000_000_000).environments.map((e) => e.state)).toEqual(["ready"]);
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
