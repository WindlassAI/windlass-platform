/** A repository's setup, checks, environments, network, verification, secrets and page. */

import type { EgressMode, HarnessId, SandboxProfileId } from "../contract.js";
import type { GithubId } from "./github.js";
import type { HostedSize } from "./hosted-sizes.js";

/** Only the owner can set setup. It runs after clone and before the first turn as the sandbox user, outside Windlass command isolation. */
export interface RepositorySetup {
	/** The command as it is saved; "" when none is. */
	command: string;
	/** When it was last saved, ms since the epoch; null when none is saved. */
	updatedAt: number | null;
	/** How long a run may take before the platform stops it. */
	timeoutMs: number;
}

/** Windlass runs these owner-defined checks before accepting a turn. */
export interface RepositoryCheck {
	/** Letters, digits, "_", "." and "-", starting with a letter or digit; no two of a list alike. */
	name: string;
	/** Run with `bash -c` in the repository's directory. */
	command: string;
	/** How long it may run, 1 to MAX_CHECK_TIMEOUT_SECONDS; absent: Windlass's own default (120). */
	timeoutSeconds?: number;
	/** Glob patterns of changed files that make it run; absent: any change does. */
	when?: string[];
	/** Include passing output in the PR too (Windlass outputTail “always”). */
	showOutput?: boolean;
}

/** `repositoryChecks`, and what saving answers with. */
export interface RepositoryChecks {
	/** In the order they run. */
	checks: RepositoryCheck[];
	/** When the list was last saved, ms since the epoch; null when none is saved. */
	updatedAt: number | null;
}

// A repository's prepared environments (environments.ts)

/** Where an environment is kept: "hosted", or the id of one of the user's machines. */
export type EnvironmentPlace = string;
export type EnvironmentState = "building" | "retrying" | "interrupted" | "ready" | "failed" | "stale";
/** What started a build. "first_use": a session started cold where the repository has none. */
export type EnvironmentTrigger = "schedule" | "push" | "rebuild" | "change" | "first_use" | "image";
/** Why the sandbox could not run a check (factory/check-environment.ts); "code": it ran and failed on the base's code. */
export type EnvironmentFailureKind = "package_manager" | "network" | "not_found" | "code" | "setup" | "clone" | "save";

/** One saved check as a build ran it. */
export interface EnvironmentCheckResult {
	name: string;
	status: CheckStatus;
	exitCode: number | null;
	durationMs: number;
	/** The check-environment.ts kind of a failure the sandbox caused; null for a pass or a failure of the code. */
	environment: "package_manager" | "network" | "not_found" | null;
}

/** One build of an environment, as the record keeps it. */
export interface EnvironmentBuild {
	trigger: EnvironmentTrigger;
	/** Automatic retries started for this trigger. */
	retries?: number;
	/** This attempt ended before the place could report its result. */
	interrupted?: true;
	startedAt: number;
	/** When setup and the checks finished; null while it runs. For the ready part, when it was validated. */
	finishedAt: number | null;
	/** The base commit setup ran at; "" until the clone. */
	commit: string;
	/** Whether the build used the screenshots image. */
	screenshots?: true;
	/** The image the sandbox was made from, as the place says it; "" where it does not (an older runner). */
	image: string;
	/** Digests of the setup command and of the checks as they were when the build started. */
	setupHash: string;
	checksHash: string;
	profile: string;
	/** Hosted, where the deployment offers sizes: the size it was built in. Its image starts only sandboxes of this size. */
	hostedSize?: HostedSize;
	checks: EnvironmentCheckResult[];
	/** Why it did not pass; null when it did or while it runs. */
	failure: { kind: EnvironmentFailureKind; check: string | null; line: string; excerpt: string } | null;
	/** A prepared image was saved. A passing setup under the minimum time keeps none: sessions then start cold, quickly. */
	snapshot: boolean;
	/** Base-code failures are reported but do not block environment promotion. */
	codeFailures?: string[];
}

/** One place's environment of a repository. */
export interface RepositoryEnvironment {
	place: EnvironmentPlace;
	/** "Hosted", or the machine's name. */
	placeName: string;
	state: EnvironmentState;
	/** The last build that passed: the one sessions start from while it is current. */
	ready: EnvironmentBuild | null;
	/** The latest build, when it is newer than `ready`. */
	attempt: EnvironmentBuild | null;
	/** Why it is stale, or why a build is waiting ("daily sandbox time is used up"); null otherwise. */
	note: string | null;
	/** When the next build is due, ms since the epoch; null when none is. */
	nextAt: number | null;
}

/** How often a repository's environments are rebuilt on a schedule: 0 is off, 24 nightly. */
export type EnvironmentSchedule = 0 | 6 | 12 | 24;
export const ENVIRONMENT_SCHEDULES: readonly EnvironmentSchedule[] = [24, 12, 6, 0];

export interface RepositoryEnvironments {
	/** Whether the deployment keeps prepared sandboxes at all, and why not when it does not. */
	available: boolean;
	unavailableReason: string | null;
	schedule: EnvironmentSchedule;
	/** Whether `schedule` was chosen, or is the default (nightly with a setup command, off without). */
	scheduleChosen: boolean;
	environments: RepositoryEnvironment[];
	/** Places a Rebuild may name that have no environment yet. */
	places: { place: EnvironmentPlace; placeName: string }[];
}

// A repository's network list

/** Presets contain exact download and redirect hosts. The sandbox hosts file cannot pin wildcards. */
export interface NetworkPreset {
	id: string;
	/** In words, for the repository's settings: "Playwright browsers". */
	name: string;
	/** What it is for, in a few words. */
	about: string;
	hosts: readonly string[];
}

export const NETWORK_PRESETS: readonly NetworkPreset[] = [
	{
		id: "@npm",
		name: "npm registry",
		about: "npm, pnpm, Yarn and Bun packages",
		hosts: ["registry.npmjs.org", "registry.yarnpkg.com"],
	},
	{ id: "@pypi", name: "PyPI", about: "pip, uv and Poetry packages", hosts: ["pypi.org", "files.pythonhosted.org"] },
	{
		id: "@github",
		name: "GitHub downloads",
		about: "Release assets, raw files and archives",
		hosts: [
			"github.com",
			"codeload.github.com",
			"objects.githubusercontent.com",
			"raw.githubusercontent.com",
			"release-assets.githubusercontent.com",
		],
	},
	{
		id: "@crates",
		name: "crates.io",
		about: "Cargo packages",
		hosts: ["crates.io", "index.crates.io", "static.crates.io"],
	},
	{
		id: "@go",
		name: "Go module proxy",
		about: "Go modules and their checksums",
		hosts: ["proxy.golang.org", "sum.golang.org"],
	},
	{
		id: "@node",
		name: "nodejs.org",
		about: "Node.js downloads, and the headers node-gyp builds native addons with",
		hosts: ["nodejs.org"],
	},
	{
		id: "@playwright",
		name: "Playwright browsers",
		about:
			"What playwright install downloads. On x86_64 its Chromium download redirects to Google Cloud Storage, which is not in this preset: add @gcs for it",
		hosts: ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"],
	},
	{
		id: "@gcs",
		name: "Google Cloud Storage",
		about:
			"Reaches every public Google Cloud Storage bucket, anyone's, not only the one a download needs. Playwright's Chromium for x86_64 comes from it",
		hosts: ["storage.googleapis.com"],
	},
	{
		id: "@prisma",
		name: "Prisma engines",
		about: "The engines Prisma downloads when it is installed",
		hosts: ["binaries.prisma.sh"],
	},
	{
		id: "@debian",
		name: "Debian packages",
		about: "Debian's apt sources",
		hosts: ["deb.debian.org", "security.debian.org"],
	},
	{
		id: "@ubuntu",
		name: "Ubuntu packages",
		about: "Ubuntu's apt sources; the sandbox runs Ubuntu",
		hosts: ["archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com"],
	},
];

/** Warnings shared by every surface that offers to allow a broad host. */
export const WIDE_HOSTS: Readonly<Record<string, string>> = {
	"storage.googleapis.com":
		"storage.googleapis.com serves every public Google Cloud Storage bucket, anyone's: allowed, it lets a command send to or fetch from any of them, not only the one a download needs.",
};

/** A blocked lookup is a request only. Granting access requires repository settings permission. */
export interface NetworkRequest {
	host: string;
	/** When a command last asked for it, ms since the epoch. */
	at: number;
	/** The session whose sandbox it was looked up in; null when that is not known. */
	sessionId: string | null;
}

/** Exact hosts and presets extend restricted E2B egress for this repository. An active session can apply an approval immediately. */
export interface RepositoryNetwork {
	/** What is saved: preset ids ("@playwright") and exact host names, in the order they were added. */
	entries: string[];
	/** The hosts they come to, sorted, each once. */
	hosts: string[];
	/** When the list was last saved, ms since the epoch; null when none is saved. */
	updatedAt: number | null;
	/** Hosts its sessions' commands asked for and could not reach, the newest first. */
	requests: NetworkRequest[];
	/** The presets that can be chosen. */
	presets: NetworkPreset[];
	/** Deployment-wide egress before repository additions. In restricted mode hosts include the model API, Git host, bucket and operator allowlist. */
	hosted: { mode: EgressMode; hosts: string[] } | null;
	/** How many hosts the list may come to here (MAX_REPOSITORY_HOSTS, less where the deployment's own list leaves less room). */
	limit: number;
}

/** A host or a preset found in a repository's files (`scanRepositoryNetwork`): a proposal, never applied by itself. */
export interface NetworkProposal {
	/** A preset id or an exact host name: what allowing it saves. */
	entry: string;
	/** For a preset, its hosts; for a host, that host. */
	hosts: string[];
	/** Where it was found, in words, at most five: "package.json scripts.postinstall", ".github/workflows/ci.yml line 31". */
	sources: string[];
}

/** What a scan of a repository's files found. */
export interface NetworkScan {
	/** Not yet reachable from its sandboxes: presets first, then hosts by name. */
	proposals: NetworkProposal[];
	/** The commit that was read, and the branch it is the head of. */
	commit: string | null;
	branch: string | null;
	/** How many files were read. */
	files: number;
	/** True when GitHub's list of files was cut short, or more files matched than are read: something may be missing. */
	incomplete: boolean;
}

/** What `allowHost` did. */
export interface HostAllowed {
	network: RepositoryNetwork;
	/** True when the session's sandbox was changed at once, which happens only while a turn holds it; false when it applies from the next turn. */
	applied: boolean;
}

/** How one check ended, in Windlass's words (`CheckEvidence.status`). */
export type CheckStatus = "passed" | "failed" | "timed_out" | "could_not_start" | "interrupted";

/** A check that ran, as Windlass recorded it (`checks.finished`) and as the platform accounts for it. */
export interface VerifiedCheck {
	name: string;
	command: string;
	/**
	 * "user": one of the checks the session's user saved for the repository, handed to Windlass for
	 * that turn. "repository": from the repository's own `.windlass/config.json`, which Windlass
	 * runs alongside the user's required checks.
	 */
	whose: "user" | "repository";
	/** True when Windlass ran it as a required check: the repository's file could neither replace it nor switch it off. Only a check of the user's is one. */
	required?: boolean;
	status: CheckStatus;
	exitCode: number | null;
	durationMs: number;
	/** How many times in its turn the agent was sent back with this check failing. */
	sentBack: number;
	/** True when Windlass did not run it again in that run: it had passed earlier in the session, and no file it covers changed since. */
	carried?: boolean;
	/** The end of what it printed, at most CHECK_OUTPUT_CHARS: kept for one that did not pass, and for one whose user asked (`RepositoryCheck.showOutput`; of the repository's own, its file's `outputTail`). */
	output?: string;
	/**
	 * Set for a check that was not started (`could_not_start` with no exit code), with the reason why its command could not be
	 * started, in Windlass's words (the evidence's `startError`), "" where it gave none. Such a check
	 * says nothing about the code, and the agent was not sent back for it.
	 */
	startError?: string;
}

/** Verification is derived from Windlass's recorded gate for the turn and its measured file state. */
export type Verified = (
	| {
			state: "not_needed";
			/** A restored state can refer to a prior check run or the state at turn start. */
			unneeded: { reason: "turn_unchanged" | "state_unchanged" | "not_covered"; on: "run" | "start" | null };
	  }
	| {
			state: "passed" | "unresolved" | "none_set" | "off" | "no_sandbox" | "not_in_force" | "stopped" | "failed";
			unneeded?: never;
	  }
) & {
	turn: number;
	/**
	 * For "unresolved": why the turn was let end, and for "acknowledged" what the agent gave as its
	 * reason. "not_started": no check that did not pass was started (`VerifiedCheck.startError`), so
	 * the turn ended at once and the agent was not sent back. "environment": every check that failed did so because the
	 * sandbox could not run it (factory/check-environment.ts), so the agent was not sent back either.
	 */
	unresolved?: {
		reason: "acknowledged" | "max_rounds" | "report_mode" | "not_started" | "environment";
		said: string | null;
	};

	/** Failed checks whose changes were subsequently undone. They are separate from the run that verifies the final state. */
	putBack?: VerifiedCheck[];
	/** Last completed check run supporting this state. seq identifies checks.finished in the Windlass log. */
	run: { turn: number; at: number; seq: number; checks: VerifiedCheck[] } | null;
	/** The user's checks, as saved when `turn` started, that are neither among `run`'s nor among `putBack`. */
	unrun: Array<{ name: string; command: string }>;
	/** True when the user's checks were required ones in `turn` and the repository's file said something about checks or verification: that held for the repository's own checks, and not for the user's. */
	overruled?: boolean;
	/** True when Windlass recorded another state of the workspace after `run` finished than the one the checks ran on. */
	changedAfter: boolean;
};

/** Observations on the changes for a human reviewer. Post-check edits are recorded separately in Verified.changedAfter. */
export interface VerifiedFlag {
	kind:
		| "tests_removed"
		| "tests_skipped"
		| "checks_changed"
		| "exit_ignored"
		| "agent_instructions_changed"
		| "outside_scope";
	/** What it was seen in: paths, at most a few. */
	where: string[];
}

/** Repository secrets always reach setup. Agent scope also exposes them to agent commands; account secrets never go to repository setup. */
export type SecretScope = "setup" | "agent";

/** Where commands are unisolated, withholding a secret from them also requires withholding it from Windlass and its MCP servers. */
export interface SecretReach {
	/** Whether the MCP servers the repository names can be given it (`${NAME}` in their definitions). */
	servers: boolean;
	commands: "yes" | "no";
	/** Set when that is less than the scope says, or needs a word: a sentence fit to show under the secret. */
	note: string | null;
}

/** A secret as it is listed: never with its value, which is not sent to a client once it is saved. */
export interface RepositorySecret {
	/** The environment variable it is handed over as. */
	name: string;
	scope: SecretScope;
	/** When its value or scope was last changed, ms since the epoch. */
	updatedAt: number;
	/** What it reaches in the sandbox the list was asked for: its profile, and the Windlass in it. */
	reach: SecretReach;
	/** True when the user's account has a secret of this name too (`AccountSecret`): in this repository's sessions this one is used in its place. */
	account?: boolean;
}

/** The secrets a user saved for one repository of their GitHub connection, by name. */
export interface RepositorySecrets {
	secrets: RepositorySecret[];
	/** The profile `reach` is said for. */
	profile: SandboxProfileId;
}

// A repository's page

/** Saved defaults may outlive a model or sandbox. Ignore unavailable choices at launch. */
export interface RepositoryAutonomy {
	autoApprovePlans?: boolean;
	autoMergeSingles?: boolean;
	/** An offer limits automatic merge to these kinds. A manual opt-in covers every kind. */
	mergeKinds?: import("../factory/readiness-track.js").TaskKind[];
	waitForCiOnEachPart?: boolean;
}

export type DefaultPlace = "hosted" | "any-machine" | { machine: string };

/** Each omitted or null choice inherits from the next settings layer. */
export interface ItemPlaceDefaults {
	place?: DefaultPlace | null;
	placeFallback?: "wait" | "hosted" | null;
	harness?: HarnessId | null;
	machineProfile?: SandboxProfileId | null;
	/** The machine agent's model and effort, by id; null runs its default. Plan-first subtasks on that agent start with them. */
	machineModel?: string | null;
	machineEffort?: string | null;
}

export type StartPlace = { kind: "hosted" } | { kind: "machine"; machineId: string; profile: SandboxProfileId };

export interface RepositoryDefaults extends RepositoryAutonomy, ItemPlaceDefaults {
	/** The default place projected into the interactive launch controls. */
	startPlace?: StartPlace | null;
	/** A conflicting personal default from before personal and work-item places were unified. */
	previousStartPlace?: StartPlace;
	/** Allow item agents to file screenshots for this repository. Defaults to false. */
	screenshots: boolean;
	/** The sandbox profile, by its id; null when none is saved. */
	profile: SandboxProfileId | null;
	reviewModel?: string | null;
	reviewEffort?: string | null;
	effort?: string | null;
	/** The model; null when none is saved. */
	model: string | null;
	/** The hosted sandbox size of the repository's agents and work items; null when none is saved (agents small, work items standard). */
	hostedSize?: HostedSize | null;
	/** When either was last saved, ms since the epoch; null when neither is. */
	updatedAt: number | null;
}

/** The user's remembered approval of an MCP server a repository names, as the repository's page lists it. */
export interface RepositoryApproval {
	/** The server's name in the repository's configuration. */
	name: string;
	/** When the user last approved a definition of it, and until when that approval holds, ms since the epoch. */
	approvedAt: number;
	expiresAt: number;
	/** How many definitions of it are approved: more than one when its definition changed and was approved again. Forgetting forgets them all. */
	definitions: number;
}

export interface RepositoryView {
	knowledge: import("../repo-setup/types.js").SetupKnowledge;
	guideCheck: import("../repo-setup/types.js").GuideCheckStatus;
	readiness: import("../factory/readiness.js").RepositoryReadiness;
	/** GitHub's id for the repository. */
	id: GithubId;
	/** Last known owner/name. Query githubRepository for the current name. */
	name: string | null;
	defaults: RepositoryDefaults;
	/** The remembered approvals that have not run out, the newest first. */
	approvals: RepositoryApproval[];
	/** What forgetting an approval does and does not do on this deployment, in a sentence or two. */
	forgetting: string;
	/** What else is saved for it: whether a setup command is, how many secrets, how many checks, and how many entries its network list has. */
	saved: { setup: boolean; secrets: number; checks: number; network: number };
}

/** A repository the user's actor keeps something for: a setup command, a secret, a default or a remembered approval. */
export interface SavedRepository {
	id: GithubId;
	/** As `RepositoryView.name`. */
	name: string | null;
}
