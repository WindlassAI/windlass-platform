/**
 * acme/signal-flags is ready hosted, retrying on "build-box" and failed on "nas" (its pnpm version).
 * Rebuild runs for a few seconds and passes. Records last as long as the page is open.
 */
import type {
	EnvironmentBuild,
	EnvironmentPlace,
	EnvironmentSchedule,
	GithubId,
	RepositoryEnvironment,
	RepositoryEnvironments,
} from "@contract";
import { HOUR } from "./mock-time";

const COMMIT = "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39";
const passed = (name: string, durationMs: number) => ({
	name,
	status: "passed" as const,
	exitCode: 0,
	durationMs,
	environment: null,
});

function build(at: number, over: Partial<EnvironmentBuild> = {}): EnvironmentBuild {
	return {
		trigger: "schedule",
		startedAt: at,
		finishedAt: at + 4 * 60_000,
		commit: COMMIT,
		image: "sha256:9b2e6f0c1d3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c",
		setupHash: "s",
		checksHash: "c",
		profile: "docker-hardened",
		checks: [passed("test", 41_000), passed("types", 63_000)],
		failure: null,
		snapshot: true,
		...over,
	};
}

function seed(repositoryId: GithubId, now: number): RepositoryEnvironments {
	if (String(repositoryId) !== "7106") {
		return {
			available: true,
			unavailableReason: null,
			schedule: 24,
			scheduleChosen: false,
			environments: [],
			places: [{ place: "hosted", placeName: "Hosted" }],
		};
	}
	const failed = build(now - 2 * HOUR, {
		trigger: "push",
		commit: "8e1d0c3b2a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d",
		checks: [
			passed("test", 39_000),
			{ name: "types", status: "failed", exitCode: 1, durationMs: 2_100, environment: "package_manager" },
		],
		failure: {
			kind: "package_manager",
			check: "types",
			line: "ERR_PNPM_BAD_PM_VERSION This project is configured to use v9.15.0 of pnpm. Your current pnpm is v10.4.1",
			excerpt:
				'> harbor@0.0.0 typecheck /workspace\n> tsc --noEmit\n\n ERR_PNPM_BAD_PM_VERSION  This project is configured to use v9.15.0 of pnpm. Your current pnpm is v10.4.1\n\nIf you want to bypass this version check, you can set the "package-manager-strict" configuration to "false" or set the "COREPACK_ENABLE_STRICT" environment variable to "0"',
		},
		snapshot: false,
	});
	return {
		available: true,
		unavailableReason: null,
		schedule: 24,
		scheduleChosen: false,
		environments: [
			// Main is red: "lint" fails on its code, which does not keep the environment from being promoted.
			{
				place: "hosted",
				placeName: "Hosted",
				state: "ready",
				ready: build(now - 9 * HOUR, {
					checks: [
						passed("test", 41_000),
						passed("types", 63_000),
						{ name: "lint", status: "failed", exitCode: 1, durationMs: 8_000, environment: null },
					],
					codeFailures: ["lint"],
				}),
				attempt: null,
				note: null,
				nextAt: now + 14 * HOUR,
			},
			{
				place: "m_build",
				placeName: "‘build-box’",
				state: "retrying",
				ready: null,
				attempt: build(now - 5 * 60_000, { interrupted: true, snapshot: false, checks: [] }),
				note: null,
				nextAt: now + 90_000,
			},
			{
				place: "m_nas",
				placeName: "‘nas’",
				state: "failed",
				ready: null,
				attempt: failed,
				note: null,
				nextAt: now + 14 * HOUR,
			},
		],
		places: [],
	};
}

const kept = new Map<string, RepositoryEnvironments>();

/** `unavailable`: why the repository can have none (no setup command, saved secrets); null when it can. */
export function mockEnvironments(
	repositoryId: GithubId,
	now: number,
	unavailable: string | null = null,
): RepositoryEnvironments {
	if (unavailable)
		return {
			available: false,
			unavailableReason: unavailable,
			schedule: 0,
			scheduleChosen: false,
			environments: [],
			places: [],
		};
	const key = String(repositoryId);
	const view = kept.get(key) ?? seed(repositoryId, now);
	for (const env of view.environments) {
		if (env.state === "retrying" && env.nextAt !== null && now >= env.nextAt) {
			env.attempt = build(env.nextAt, { retries: 1, finishedAt: null, checks: [], snapshot: false });
			env.state = "building";
			env.nextAt = null;
		}
		if (env.state === "building" && env.attempt?.retries && now >= env.attempt.startedAt + 4_000) {
			env.ready = build(env.attempt.startedAt, { retries: 1, finishedAt: env.attempt.startedAt + 4_000 });
			env.state = "ready";
			env.attempt = null;
			env.nextAt = view.schedule ? env.ready.startedAt + view.schedule * HOUR : null;
		}
	}
	kept.set(key, view);
	return structuredClone(view);
}

export function mockSchedule(
	repositoryId: GithubId,
	schedule: EnvironmentSchedule,
	now: number,
	unavailable: string | null = null,
): RepositoryEnvironments {
	if (unavailable) return mockEnvironments(repositoryId, now, unavailable);
	const view = mockEnvironments(repositoryId, now);
	kept.set(String(repositoryId), {
		...view,
		schedule,
		scheduleChosen: true,
		environments: view.environments.map(e =>
			e.state === "retrying" ? e : { ...e, nextAt: schedule === 0 ? null : now + schedule * HOUR },
		),
	});
	return mockEnvironments(repositoryId, now);
}

/** Rebuild: the place (or each) shows building, and `done` is called when the mock's build passed. */
export function mockRebuild(
	repositoryId: GithubId,
	place: EnvironmentPlace | undefined,
	now: number,
	later: (ms: number, run: () => void) => void,
	done: () => void,
): RepositoryEnvironments {
	const view = mockEnvironments(repositoryId, now);
	const names = new Map([
		...view.environments.map(e => [e.place, e.placeName] as const),
		...view.places.map(p => [p.place, p.placeName] as const),
	]);
	const places = place
		? [place]
		: view.environments.length
			? view.environments.map(e => e.place)
			: view.places.slice(0, 1).map(p => p.place);
	const running = build(now, { trigger: "rebuild", finishedAt: null, checks: [], commit: "" });
	const environments: RepositoryEnvironment[] = view.environments.map(e =>
		places.includes(e.place) ? { ...e, state: "building", attempt: running, note: null } : e,
	);
	for (const p of places)
		if (!environments.some(e => e.place === p))
			environments.push({
				place: p,
				placeName: names.get(p) ?? p,
				state: "building",
				ready: null,
				attempt: running,
				note: null,
				nextAt: null,
			});
	kept.set(String(repositoryId), { ...view, environments, places: view.places.filter(p => !places.includes(p.place)) });
	later(4_000, () => {
		const current = kept.get(String(repositoryId))!;
		const finished = build(now, { trigger: "rebuild", finishedAt: now + 3_500 });
		kept.set(String(repositoryId), {
			...current,
			environments: current.environments.map(e =>
				places.includes(e.place) ? { ...e, state: "ready", ready: finished, attempt: null } : e,
			),
		});
		done();
	});
	return mockEnvironments(repositoryId, now);
}
