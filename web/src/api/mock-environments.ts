/**
 * The mock's prepared environments (server/src/environments.ts): acme/signal-flags is ready here and failed on the
 * machine "nas", where the image's pnpm is not the one the repository pins. Rebuild runs for a few seconds and
 * passes. Kept per repository for as long as the page is open.
 */
import type { EnvironmentBuild, EnvironmentPlace, EnvironmentSchedule, GithubId, RepositoryEnvironment, RepositoryEnvironments } from "@contract";

const HOUR = 3_600_000;
const COMMIT = "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39";
const passed = (name: string, durationMs: number) => ({ name, status: "passed" as const, exitCode: 0, durationMs, environment: null });

function build(at: number, over: Partial<EnvironmentBuild> = {}): EnvironmentBuild {
	return { trigger: "schedule", startedAt: at, finishedAt: at + 4 * 60_000, commit: COMMIT, image: "sha256:9b2e6f0c1d3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c", setupHash: "s", checksHash: "c", profile: "docker-hardened",
		checks: [passed("test", 41_000), passed("types", 63_000)], failure: null, snapshot: true, ...over };
}

function seed(repositoryId: GithubId, now: number): RepositoryEnvironments {
	if (String(repositoryId) !== "7106") {
		return { available: true, unavailableReason: null, schedule: 24, scheduleChosen: false, environments: [], places: [{ place: "hosted", placeName: "This platform" }] };
	}
	const failed = build(now - 2 * HOUR, {
		trigger: "push", commit: "8e1d0c3b2a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d",
		checks: [passed("test", 39_000), { name: "types", status: "failed", exitCode: 1, durationMs: 2_100, environment: "package_manager" }],
		failure: { kind: "package_manager", check: "types", line: "ERR_PNPM_BAD_PM_VERSION This project is configured to use v9.15.0 of pnpm. Your current pnpm is v10.4.1",
			excerpt: "> harbor@0.0.0 typecheck /workspace\n> tsc --noEmit\n\n ERR_PNPM_BAD_PM_VERSION  This project is configured to use v9.15.0 of pnpm. Your current pnpm is v10.4.1\n\nIf you want to bypass this version check, you can set the \"package-manager-strict\" configuration to \"false\" or set the \"COREPACK_ENABLE_STRICT\" environment variable to \"0\"" },
		snapshot: false,
	});
	return {
		available: true, unavailableReason: null, schedule: 24, scheduleChosen: false,
		environments: [
			{ place: "hosted", placeName: "This platform", state: "ready", ready: build(now - 9 * HOUR), attempt: null, note: null, nextAt: now + 14 * HOUR },
			{ place: "m_nas", placeName: "‘nas’", state: "failed", ready: null, attempt: failed, note: null, nextAt: now + 14 * HOUR },
		],
		places: [{ place: "m_build", placeName: "‘build-box’" }],
	};
}

const kept = new Map<string, RepositoryEnvironments>();

/** `unavailable`: why the repository can have none (no setup command, saved secrets); null when it can. */
export function mockEnvironments(repositoryId: GithubId, now: number, unavailable: string | null = null): RepositoryEnvironments {
	if (unavailable) return { available: false, unavailableReason: unavailable, schedule: 0, scheduleChosen: false, environments: [], places: [] };
	const key = String(repositoryId);
	if (!kept.has(key)) kept.set(key, seed(repositoryId, now));
	return structuredClone(kept.get(key)!);
}

export function mockSchedule(repositoryId: GithubId, schedule: EnvironmentSchedule, now: number, unavailable: string | null = null): RepositoryEnvironments {
	if (unavailable) return mockEnvironments(repositoryId, now, unavailable);
	const view = mockEnvironments(repositoryId, now);
	kept.set(String(repositoryId), { ...view, schedule, scheduleChosen: true, environments: view.environments.map(e => ({ ...e, nextAt: schedule === 0 ? null : now + schedule * HOUR })) });
	return mockEnvironments(repositoryId, now);
}

/** Rebuild: the place (or each) shows building, and `done` is called when the mock's build passed. */
export function mockRebuild(repositoryId: GithubId, place: EnvironmentPlace | undefined, now: number, later: (ms: number, run: () => void) => void, done: () => void): RepositoryEnvironments {
	const view = mockEnvironments(repositoryId, now);
	const names = new Map([...view.environments.map(e => [e.place, e.placeName] as const), ...view.places.map(p => [p.place, p.placeName] as const)]);
	const places = place ? [place] : view.environments.length ? view.environments.map(e => e.place) : view.places.slice(0, 1).map(p => p.place);
	const running = build(now, { trigger: "rebuild", finishedAt: null, checks: [], commit: "" });
	const environments: RepositoryEnvironment[] = view.environments.map(e => places.includes(e.place) ? { ...e, state: "building", attempt: running, note: null } : e);
	for (const p of places) if (!environments.some(e => e.place === p)) environments.push({ place: p, placeName: names.get(p) ?? p, state: "building", ready: null, attempt: running, note: null, nextAt: null });
	kept.set(String(repositoryId), { ...view, environments, places: view.places.filter(p => !places.includes(p.place)) });
	later(4_000, () => {
		const current = kept.get(String(repositoryId))!;
		const finished = build(now, { trigger: "rebuild", finishedAt: now + 3_500 });
		kept.set(String(repositoryId), { ...current, environments: current.environments.map(e => places.includes(e.place) ? { ...e, state: "ready", ready: finished, attempt: null } : e) });
		done();
	});
	return mockEnvironments(repositoryId, now);
}
