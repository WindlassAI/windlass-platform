/**
 * A repository's network list: the hosts its hosted sandboxes may reach besides the platform's own
 * (the model API, the git host, the bucket) and the deployment's (WLP_E2B_NETWORK_ALLOW), where the
 * deployment runs them on E2B with WLP_E2B_NETWORK=restricted (sandbox/e2b/network.ts). What may be
 * saved, how it is kept, the requests a session files for a host it could not reach, and the fixed
 * reading of a repository's files that proposes hosts.
 *
 * Whose it is. The user's, kept in their `user` actor, one row per repository of their GitHub
 * connection, under the key the setup command, the checks and the secrets use (setup-command.ts,
 * `setupProjectKey`). It is never read from the repository: a host a repository's text names is only
 * ever proposed (`scanForHosts`), and the person allows each one. A repository could otherwise plant
 * a host to send what its sandbox holds to.
 *
 * Who may change it. Whoever may change the repository's settings on the platform: today, the person
 * whose actor keeps them, and nobody else reaches it (`mayChangeNetwork`). Requests (`fileRequests`)
 * are filed by the platform, for every host a command in one of the repository's sandboxes could not
 * reach, and wait on the repository's settings until the person allows or dismisses them. A session's
 * "Allow" from anyone else would file one too, but a session's actions are its own user's, so today
 * nobody else can make that call.
 *
 * Which sessions. Every hosted session on the repository, from its next turn, and at once in the
 * session the host was allowed from while a turn runs there. A session on one repository gets that
 * repository's hosts. The own session of a cross-repo feature (factory/cross-repo.ts), whose planner
 * reads both repositories, gets the hosts of all of them (`unionHosts`); each of its children is on one
 * repository and gets that one's.
 *
 * Saving. The list is one value: a save writes the whole of it in one statement. Adding one host
 * (`addHost`) reads the list and writes it back only if it is still what was read, so two at once
 * both stay.
 *
 * This file has no actor in it: the `user` actor hands its database to these functions, and
 * scripts/network-check.ts runs them against a database of its own.
 */

import { MAX_REPOSITORY_HOSTS, NETWORK_PRESETS, WIDE_HOSTS, type NetworkPreset, type NetworkProposal, type NetworkRequest } from "./contract.js";
import { refuseAtRepositoryCap, type DefaultsDb } from "./repository-defaults.js";
import { MAX_HOSTS, PRESETS, isHostName } from "./sandbox/hosted-network.js";

/** How many repositories one user may have a list for; the ones saved longest ago go first. */
export const MAX_NETWORK_REPOSITORIES = 500;
/** How many requests one repository keeps, and one user over all: beyond them a new host is not filed (`fileRequests`). */
export const MAX_REQUESTS_PER_REPOSITORY = 30;
export const MAX_REQUESTS_PER_USER = 1_000;
/** How many entries a list may have, before presets are expanded. */
const MAX_ENTRIES = 60;

/** Thrown for a list that cannot be saved; `message` is fit to show. */
export class NetworkProblem extends Error {}

/** The presets as a client shows them. */
export function networkPresets(): NetworkPreset[] {
	return NETWORK_PRESETS.map((preset) => ({ id: preset.id, name: preset.name, about: preset.about, hosts: [...preset.hosts] }));
}

/** One entry as it is saved: a preset's id, or an exact DNS name, lower case, without a trailing dot. Null for anything else. */
export function cleanEntry(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const entry = raw.trim().toLowerCase().replace(/\.$/, "");
	if (entry.startsWith("@")) return PRESETS[entry] ? entry : null;
	return isHostName(entry) ? entry : null;
}

/** The hosts a list comes to, sorted, each once. Entries that are not what `cleanEntry` keeps are left out. */
export function expandEntries(entries: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const entry of entries) {
		const clean = cleanEntry(entry);
		if (clean === null) continue;
		for (const host of PRESETS[clean] ?? [clean]) hosts.add(host);
	}
	return [...hosts].sort();
}

/**
 * How many hosts a repository's list may come to on this deployment: MAX_REPOSITORY_HOSTS, and no more
 * than what the deployment's own hosts leave of MAX_HOSTS. A host both name counts once, so this is a
 * floor: `fits` says it exactly for a list.
 */
export function networkLimit(deploymentHosts: readonly string[], maxHosts = MAX_HOSTS): number {
	return Math.max(0, Math.min(MAX_REPOSITORY_HOSTS, maxHosts - deploymentHosts.length));
}

/** Whether a list's hosts fit beside the deployment's: at most MAX_REPOSITORY_HOSTS, and all of them together at most MAX_HOSTS. */
export function fits(hosts: readonly string[], deploymentHosts: readonly string[], maxHosts = MAX_HOSTS): boolean {
	return hosts.length <= MAX_REPOSITORY_HOSTS && new Set([...deploymentHosts, ...hosts]).size <= maxHosts;
}

/**
 * The list as it is saved, from what a client sent: each entry once, in the order given. Throws
 * NetworkProblem naming the entry at fault, or saying how many hosts the list comes to over the limit.
 */
export function cleanEntries(raw: unknown, deploymentHosts: readonly string[] = [], maxHosts = MAX_HOSTS): string[] {
	if (!Array.isArray(raw)) throw new NetworkProblem("The network list must be a list.");
	if (raw.length > MAX_ENTRIES) throw new NetworkProblem(`A network list can have ${MAX_ENTRIES} entries; this one has ${raw.length}.`);
	const entries: string[] = [];
	for (const item of raw) {
		const entry = cleanEntry(item);
		if (entry === null) {
			const shown = typeof item === "string" ? `"${item.trim().slice(0, 80)}"` : "An entry";
			throw new NetworkProblem(
				typeof item === "string" && item.trim().startsWith("@")
					? `${shown} is no preset. The presets are ${NETWORK_PRESETS.map((preset) => preset.id).join(", ")}.`
					: `${shown} is not an exact host name. Give names such as registry.example.com: no addresses, ports, paths or wildcards.`,
			);
		}
		if (!entries.includes(entry)) entries.push(entry);
	}
	const hosts = expandEntries(entries);
	if (!fits(hosts, deploymentHosts, maxHosts)) {
		throw new NetworkProblem(
			hosts.length > MAX_REPOSITORY_HOSTS
				? `The list comes to ${hosts.length} hosts; a repository may allow at most ${MAX_REPOSITORY_HOSTS}.`
				: `The list comes to ${hosts.length} hosts, and with the ${deploymentHosts.length} this deployment allows already that is more than the ${maxHosts} a sandbox may have. Remove some, or ask the deployment's operator to shorten WLP_E2B_NETWORK_ALLOW.`,
		);
	}
	return entries;
}

/**
 * The hosts of a session's repositories together, the primary's first: a session on more than one
 * repository reaches what each allows. `max` is what a repository's list may hold beside the
 * deployment's own hosts (`networkLimit`), so that the sandbox's whole list stays within what it can be
 * given. The primary's list is taken whole, as it was saved and as a one-repository session has it;
 * the later lists' hosts fill what room is left, and past `max` are left out.
 */
export function unionHosts(lists: ReadonlyArray<readonly string[]>, max: number): string[] {
	const [primary = [], ...others] = lists;
	const hosts = new Set<string>(primary);
	for (const list of others) for (const host of list) if (hosts.size < max) hosts.add(host);
	return [...hosts].sort();
}

/**
 * The hosts a turn's sandbox is given: the list as it was read when the turn started (at `readAt`),
 * and every host allowed from the session since (`allowed`, host to when), which that read may have
 * missed. A host allowed before the read is in it already and is taken off `allowed`.
 */
export function hostsForTurn(listed: readonly string[], readAt: number, allowed: Map<string, number>): string[] {
	const later: string[] = [];
	for (const [host, at] of allowed) {
		if (at >= readAt) later.push(host);
		else allowed.delete(host);
	}
	return [...new Set([...listed, ...later])].sort();
}

/**
 * Whether the caller may change the repository's network list. The list is kept in the actor of the
 * person who saved it, and only that person reaches it there: an actor's own user may, nobody else.
 * The one place the rule is said, so that a repository whose settings others share changes it here.
 */
export function mayChangeNetwork(callerUid: string | null, ownerUid: string): boolean {
	return callerUid !== null && callerUid === ownerUid;
}

/** The session's timeline line that names a blocked host, and what can be done about it, with what a host that serves far more reaches (`WIDE_HOSTS`). */
export function blockedHostNote(host: string, repository: string | null): string {
	const what = `A command in this sandbox could not reach ${host}: this deployment's hosted sandboxes reach only the model API, GitHub and the hosts they are allowed.`;
	const wide = WIDE_HOSTS[host];
	return repository
		? `${what} Allow it for ${repository} to let its hosted agents reach it, from this sandbox on. The agent and the repository's own scripts choose what a command looks up, so allow only a host you expect.${wide ? ` ${wide}` : ""}`
		: `${what} This agent has no repository of your GitHub connection, so only the deployment's operator can allow it, in WLP_E2B_NETWORK_ALLOW.${wide ? ` ${wide}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

/** One row per repository: `project` is "github:<GitHub's id>", `label` the repository in words, `entries` the list as JSON. */
export const NETWORK_TABLE = `
	CREATE TABLE IF NOT EXISTS repository_network (
		project TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		entries TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)
`;

/** One row per repository and host a session could not reach. */
export const REQUESTS_TABLE = `
	CREATE TABLE IF NOT EXISTS network_request (
		project TEXT NOT NULL,
		host TEXT NOT NULL,
		session TEXT,
		at INTEGER NOT NULL,
		PRIMARY KEY (project, host)
	)
`;

export interface SavedNetwork {
	entries: string[];
	hosts: string[];
	updatedAt: number | null;
}

function parsed(text: string | undefined): string[] {
	if (text === undefined) return [];
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value) ? value.flatMap((item) => (cleanEntry(item) === null ? [] : [cleanEntry(item)!])) : [];
	} catch {
		return [];
	}
}

/** The list saved for a project; none when there is no row. Entries this code would not save are left out. */
export async function readNetwork(db: DefaultsDb, project: string): Promise<SavedNetwork> {
	const [row] = await db.execute<{ entries: string; updated_at: number }>("SELECT entries, updated_at FROM repository_network WHERE project = ?", project);
	const entries = parsed(row?.entries);
	return { entries, hosts: expandEntries(entries), updatedAt: row?.updated_at ?? null };
}

/** The requests of a project, the newest first, without those the list allows now. */
export async function readRequests(db: DefaultsDb, project: string, allowed: readonly string[] = []): Promise<NetworkRequest[]> {
	const rows = await db.execute<{ host: string; session: string | null; at: number }>("SELECT host, session, at FROM network_request WHERE project = ? ORDER BY at DESC, host LIMIT ?", project, MAX_REQUESTS_PER_REPOSITORY);
	const skip = new Set(allowed);
	return rows.filter((row) => !skip.has(row.host)).map((row) => ({ host: row.host, at: row.at, sessionId: row.session ?? null }));
}

/** Takes the requests the hosts answer off. */
async function settleRequests(db: DefaultsDb, project: string, hosts: readonly string[]): Promise<void> {
	if (hosts.length > 0) await db.execute("DELETE FROM network_request WHERE project = ? AND host IN (SELECT value FROM json_each(?))", project, JSON.stringify(hosts));
}

/** Saves a list that was cleaned already, in place of the project's earlier one; an empty list removes the row. Requests it answers are taken off. */
export async function saveNetwork(db: DefaultsDb, project: string, label: string, entries: readonly string[], now: number): Promise<SavedNetwork> {
	if (entries.length === 0) await db.execute("DELETE FROM repository_network WHERE project = ?", project);
	else {
		await refuseAtRepositoryCap(db, "repository_network", project, MAX_NETWORK_REPOSITORIES, "network lists");
		await db.execute(
			"INSERT INTO repository_network (project, label, entries, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END, entries = excluded.entries, updated_at = MAX(updated_at + 1, excluded.updated_at)",
			project,
			label,
			JSON.stringify(entries),
			now,
		);
	}
	const saved = await readNetwork(db, project);
	await settleRequests(db, project, saved.hosts);
	return saved;
}

/**
 * Adds one entry to the project's list and answers with the list then. Writes only if the list is
 * still what was read, and reads again otherwise, so an entry another call added meanwhile stays.
 * Throws NetworkProblem when the list would not fit.
 */
export async function addEntry(db: DefaultsDb, project: string, label: string, entry: string, deploymentHosts: readonly string[], now: number, maxHosts = MAX_HOSTS): Promise<SavedNetwork> {
	const clean = cleanEntry(entry);
	if (clean === null) throw new NetworkProblem(`"${entry.slice(0, 80)}" is not an exact host name.`);
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const [row] = await db.execute<{ entries: string }>("SELECT entries FROM repository_network WHERE project = ?", project);
		const entries = parsed(row?.entries);
		if (entries.includes(clean) || expandEntries(entries).includes(clean)) {
			await settleRequests(db, project, expandEntries(entries));
			return readNetwork(db, project);
		}
		const next = cleanEntries([...entries, clean], deploymentHosts, maxHosts);
		const written = row
			? await db.execute<{ project: string }>("UPDATE repository_network SET entries = ?, updated_at = MAX(updated_at + 1, ?), label = CASE WHEN ? = '' THEN label ELSE ? END WHERE project = ? AND entries = ? RETURNING project", JSON.stringify(next), now, label, label, project, row.entries)
			: await db.execute<{ project: string }>("INSERT INTO repository_network (project, label, entries, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project) DO NOTHING RETURNING project", project, label, JSON.stringify(next), now);
		if (written.length > 0) {
			const saved = await readNetwork(db, project);
			await settleRequests(db, project, saved.hosts);
			return saved;
		}
	}
	throw new Error("the network list kept changing while a host was added to it");
}

/**
 * Files requests for hosts a session's sandbox could not reach: each host once per repository, with
 * when it was last asked for. Hosts the list allows already are not filed. The requests waiting are
 * kept over new ones: a repository keeps at most MAX_REQUESTS_PER_REPOSITORY and a user at most
 * MAX_REQUESTS_PER_USER, and a new host beyond either is not filed but answered in `full`, so names a
 * command looks up by the hundred cannot push out a request the person may want. A host waiting
 * already is only moved up.
 */
export async function fileRequests(db: DefaultsDb, project: string, hosts: readonly string[], sessionId: string | null, now: number): Promise<{ filed: string[]; full: string[] }> {
	const allowed = new Set((await readNetwork(db, project)).hosts);
	const wanted = [...new Set(hosts.map((host) => host.toLowerCase()))].filter((host) => isHostName(host) && !allowed.has(host));
	if (wanted.length === 0) return { filed: [], full: [] };
	const filed = new Set<string>();
	for (const host of wanted) {
		// One statement each, so the room is counted where the row is written, whatever else is filed meanwhile.
		const [moved] = await db.execute<{ host: string }>("UPDATE network_request SET session = ?, at = ? WHERE project = ? AND host = ? RETURNING host", sessionId, now, project, host);
		const [added] = moved
			? [moved]
			: await db.execute<{ host: string }>(
					"INSERT INTO network_request (project, host, session, at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM network_request WHERE project = ?) < ? AND (SELECT COUNT(*) FROM network_request) < ? ON CONFLICT (project, host) DO UPDATE SET session = excluded.session, at = excluded.at RETURNING host",
					project,
					host,
					sessionId,
					now,
					project,
					MAX_REQUESTS_PER_REPOSITORY,
					MAX_REQUESTS_PER_USER,
				);
		if (added) filed.add(host);
	}
	return { filed: wanted.filter((host) => filed.has(host)), full: wanted.filter((host) => !filed.has(host)) };
}

export async function dismissRequest(db: DefaultsDb, project: string, host: string): Promise<void> {
	await db.execute("DELETE FROM network_request WHERE project = ? AND host = ?", project, host.trim().toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// The fixed reading of a repository's files
// ---------------------------------------------------------------------------------------------

/** A file of the repository's tree, as GitHub lists it. */
export interface ScanEntry {
	path: string;
	type: string;
	size: number | null;
}

/** How many files a scan reads, how large one may be, how many bytes all of them may come to, and how deep in the tree it looks. */
export const SCAN_FILES = 60;
const SCAN_FILE_BYTES = 512 * 1024;
const SCAN_LOCK_BYTES = 4 * 1024 * 1024;
export const SCAN_TOTAL_BYTES = 16 * 1024 * 1024;
const SCAN_DEPTH = 4;
const MAX_PROPOSALS = 40;
const MAX_SOURCES = 5;
/** How long one "where found" may be: a path and a key of a manifest are the repository's text, of any length. */
export const MAX_SOURCE_CHARS = 200;

const SKIPPED_DIRS = new Set(["node_modules", "vendor", "third_party", "third-party", ".git", "dist", "build", "target", "out", ".venv", "venv", "__pycache__", "fixtures", "testdata", "examples", "docs"]);

type Kind = "package" | "npm-lock" | "pnpm-lock" | "yarn-lock" | "lock" | "npmrc" | "yarnrc" | "python" | "toml" | "shell" | "ci" | "gyp" | "devcontainer" | "manifest";

/** What kind of file a path is for the scan, or null when it does not read it. */
export function scanKind(path: string): Kind | null {
	const parts = path.split("/");
	const base = parts.at(-1)!.toLowerCase();
	const dir = parts.slice(0, -1).join("/").toLowerCase();
	if (parts.length - 1 > SCAN_DEPTH || parts.slice(0, -1).some((part) => SKIPPED_DIRS.has(part.toLowerCase()))) return null;
	if (/^\.github\/workflows$/.test(dir) && /\.ya?ml$/.test(base)) return "ci";
	if (base === ".gitlab-ci.yml" || base === ".travis.yml" || base === "azure-pipelines.yml" || base === "bitbucket-pipelines.yml" || (dir === ".circleci" && base === "config.yml") || (dir === ".buildkite" && /\.ya?ml$/.test(base))) return "ci";
	if (base === "package.json") return "package";
	if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return "npm-lock";
	if (base === "pnpm-lock.yaml") return "pnpm-lock";
	if (base === "yarn.lock") return "yarn-lock";
	if (["bun.lock", "poetry.lock", "uv.lock", "pipfile.lock", "cargo.lock", "gemfile.lock", "composer.lock", "go.sum", "pdm.lock"].includes(base)) return "lock";
	if (base === ".npmrc") return "npmrc";
	if (base === ".yarnrc" || base === ".yarnrc.yml") return "yarnrc";
	if (/^(requirements|constraints)[\w.-]*\.(txt|in)$/.test(base) || base === "pip.conf" || base === "setup.cfg" || base === "pipfile") return "python";
	if (base === "pyproject.toml" || base === "cargo.toml" || (dir.endsWith(".cargo") && (base === "config.toml" || base === "config"))) return "toml";
	if (base === "binding.gyp") return "gyp";
	if (dir === ".devcontainer" && base.endsWith(".json")) return "devcontainer";
	if (base === "go.mod" || base === "gemfile" || base === "composer.json" || base === "pom.xml" || /^(build|settings)\.gradle(\.kts)?$/.test(base)) return "manifest";
	if (base === "makefile" || base === "justfile" || base === "taskfile.yml" || base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile") || base.endsWith(".sh") || /^(install|setup|bootstrap)(\.\w+)?$/.test(base)) {
		// Scripts at the top, or in the directories scripts usually live in.
		return parts.length === 1 || /^(scripts|script|bin|tools|ci|\.devcontainer|\.github)(\/|$)/.test(dir) ? "shell" : null;
	}
	return null;
}

const isLock = (kind: Kind) => kind === "npm-lock" || kind === "pnpm-lock" || kind === "yarn-lock" || kind === "lock";

/**
 * The files a scan reads, from the repository's tree: those `scanKind` knows, the shallowest first,
 * at most SCAN_FILES and SCAN_TOTAL_BYTES together (a file whose size the tree does not say counts as
 * the most it may be). `more` when others matched and are not read. `maxBytes` is the whole budget
 * and `maxFileBytes` the most one file may be, for the reader to hold the blobs to (github/app.ts `scanFiles`).
 */
export function scanPaths(tree: readonly ScanEntry[]): { paths: string[]; more: boolean; maxBytes: number; maxFileBytes: number } {
	const matching = tree
		.filter((entry) => entry.type === "blob")
		.flatMap((entry) => {
			const kind = scanKind(entry.path);
			if (kind === null) return [];
			if (entry.size !== null && entry.size > (isLock(kind) ? SCAN_LOCK_BYTES : SCAN_FILE_BYTES)) return [];
			return [{ path: entry.path, depth: entry.path.split("/").length, kind, size: entry.size }];
		})
		.sort((a, b) => a.depth - b.depth || Number(isLock(a.kind)) - Number(isLock(b.kind)) || a.path.localeCompare(b.path));
	const paths: string[] = [];
	let bytes = 0;
	for (const item of matching) {
		const size = item.size ?? (isLock(item.kind) ? SCAN_LOCK_BYTES : SCAN_FILE_BYTES);
		if (paths.length >= SCAN_FILES || bytes + size > SCAN_TOTAL_BYTES) continue;
		paths.push(item.path);
		bytes += size;
	}
	return { paths, more: paths.length < matching.length, maxBytes: SCAN_TOTAL_BYTES, maxFileBytes: SCAN_LOCK_BYTES };
}

/** Names that are never a host a command downloads from. */
function ignoredHost(host: string): boolean {
	return (
		!isHostName(host) ||
		/(^|\.)(localhost|local|test|invalid|example|internal|lan|home|onion)$/.test(host) ||
		/(^|\.)example\.(com|net|org)$/.test(host) ||
		host.endsWith(".in-addr.arpa")
	);
}

const URL_HOST = /\b(?:https?|git\+https?|git\+ssh|ssh|git|wss?|s3|registry\+https?|sparse\+https?):\/\/(?:[^\s@/'"<>]+@)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)\.?(?::\d+)?/g;
/** The hosts of the addresses in a text. */
function urlHosts(text: string): string[] {
	return [...text.matchAll(URL_HOST)].map((match) => match[1]!.toLowerCase());
}

/** What a command line implies: the presets of the tools it runs that fetch. */
const COMMAND_PRESETS: ReadonlyArray<[RegExp, string, string]> = [
	[/\bplaywright\s+install\b/, "@playwright", "runs playwright install"],
	[/\bprisma\s+(generate|migrate|db)\b/, "@prisma", "runs prisma"],
	[/\bapt(-get)?\s+(-\S+\s+)*install\b/, "@ubuntu", "runs apt install"],
	[/\bnode-gyp\b/, "@node", "runs node-gyp"],
	[/\bcargo\s+(build|fetch|install|test|run|check)\b/, "@crates", "runs cargo"],
	[/\bgo\s+(mod\s+download|build|test|install|get|run)\b/, "@go", "runs go"],
	[/\b(pip3?|uv\s+pip)\s+install\b|\buv\s+sync\b|\bpoetry\s+install\b/, "@pypi", "installs Python packages"],
	[/\b(npm\s+(ci|install|i)|pnpm\s+(install|i)|yarn(\s+install)?|bun\s+install)\b/, "@npm", "installs npm packages"],
];

/** The npm packages whose own install downloads more, and what. */
const PACKAGE_PRESETS: ReadonlyArray<[RegExp, string]> = [
	[/^(@playwright\/test|playwright|playwright-core|playwright-chromium|playwright-firefox|playwright-webkit)$/, "@playwright"],
	[/^(prisma|@prisma\/client|@prisma\/engines)$/, "@prisma"],
	[/^node-gyp$/, "@node"],
];

/** A source in words for a line of a file: "path line N". */
const lineOf = (path: string, index: number) => `${path} line ${index + 1}`;

const clip = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

class Found {
	readonly items = new Map<string, Set<string>>();
	add(entry: string, source: string): void {
		const key = entry.startsWith("@") ? entry : entry.toLowerCase();
		if (!key.startsWith("@") && ignoredHost(key)) return;
		const sources = this.items.get(key) ?? new Set<string>();
		if (sources.size < MAX_SOURCES) sources.add(clip(source, MAX_SOURCE_CHARS));
		this.items.set(key, sources);
		// Playwright's Chromium for x86_64 is a redirect to Google Cloud Storage, a preset of its own for how much else it reaches.
		if (key === "@playwright") this.add("@gcs", `${clip(source, MAX_SOURCE_CHARS - 50)} (Playwright's Chromium redirects there)`);
	}
	/** A host an address names: proposed as itself, also when a preset has it, since a preset may allow more than the file needs. */
	host(host: string, source: string): void {
		this.add(host, source);
	}
	text(text: string, source: (index: number) => string, commands = true): void {
		const lines = text.split(/\r?\n/);
		lines.forEach((line, index) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("#") || trimmed.startsWith("//")) return;
			for (const host of urlHosts(line)) this.host(host, source(index));
			if (commands) for (const [pattern, preset] of COMMAND_PRESETS) if (pattern.test(line)) this.add(preset, source(index));
		});
	}
}

/** Keys of package.json whose addresses are pages about the package, not where anything is fetched from. */
const PACKAGE_PAGES = new Set(["homepage", "repository", "bugs", "funding", "author", "contributors", "maintainers", "license", "description", "keywords"]);

function readPackage(found: Found, path: string, text: string): void {
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return;
	}
	if (typeof json !== "object" || json === null) return;
	const walk = (value: unknown, at: string): void => {
		if (typeof value === "string") {
			for (const host of urlHosts(value)) found.host(host, `${path} ${at}`);
			if (at.startsWith("scripts.")) for (const [pattern, preset] of COMMAND_PRESETS) if (pattern.test(value)) found.add(preset, `${path} ${at}`);
		} else if (typeof value === "object" && value !== null) for (const [key, inner] of Object.entries(value)) walk(inner, at === "" ? key : `${at}.${key}`);
	};
	for (const [key, value] of Object.entries(json)) {
		if (PACKAGE_PAGES.has(key)) continue;
		walk(value, key);
	}
	for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		const deps = json[field];
		if (typeof deps !== "object" || deps === null) continue;
		for (const [name, spec] of Object.entries(deps)) {
			for (const [pattern, preset] of PACKAGE_PRESETS) if (pattern.test(name)) found.add(preset, `${path} ${field}.${name}`);
			// "github:owner/repo" and "owner/repo" are fetched from GitHub.
			if (typeof spec === "string" && /^(github:|[\w.-]+\/[\w.-]+(#.*)?$)/.test(spec)) found.add("@github", `${path} ${field}.${name}`);
		}
	}
}

function readNpmLock(found: Found, path: string, text: string): void {
	let json: { packages?: Record<string, { resolved?: unknown }>; dependencies?: Record<string, { resolved?: unknown }> };
	try {
		json = JSON.parse(text);
	} catch {
		return;
	}
	const seen = new Set<string>();
	for (const item of [...Object.values(json.packages ?? {}), ...Object.values(json.dependencies ?? {})]) {
		if (typeof item?.resolved !== "string") continue;
		for (const host of urlHosts(item.resolved)) {
			if (seen.has(host)) continue;
			seen.add(host);
			found.host(host, `${path} (resolved)`);
		}
	}
}

/** Lines of a lockfile that say where a package is fetched from; others (funding, homepages) are passed over. */
function readLockLines(found: Found, path: string, text: string, fetched: RegExp): void {
	const seen = new Set<string>();
	text.split(/\r?\n/).forEach((line, index) => {
		if (!fetched.test(line)) return;
		for (const host of urlHosts(line)) {
			if (seen.has(host)) continue;
			seen.add(host);
			found.host(host, lineOf(path, index));
		}
	});
}

/** Keys of TOML manifests whose addresses are pages about the project. */
const TOML_PAGES = /^\s*(homepage|repository|documentation|changelog|issues|bug[-_ ]?tracker|funding|source|download)\s*=/i;

function readToml(found: Found, path: string, text: string): void {
	let section = "";
	text.split(/\r?\n/).forEach((line, index) => {
		const header = /^\s*\[\[?([^\]]+)\]\]?/.exec(line);
		if (header) {
			section = header[1]!.trim().toLowerCase();
			return;
		}
		if (line.trim().startsWith("#") || section === "project.urls" || section === "tool.poetry.urls" || section === "package.metadata" || (TOML_PAGES.test(line) && !/\bindex\b|\bregistry\b/.test(section))) return;
		for (const host of urlHosts(line)) found.host(host, lineOf(path, index));
	});
	if (path.toLowerCase().endsWith("cargo.toml")) found.add("@crates", path);
	if (path.toLowerCase().endsWith("pyproject.toml")) found.add("@pypi", path);
}

/** In a CI file, only what its steps run: `run:` blocks and the commands under them. */
function readCi(found: Found, path: string, text: string): void {
	const lines = text.split(/\r?\n/);
	let block = -1;
	lines.forEach((line, index) => {
		const indent = line.length - line.trimStart().length;
		const run = /^(\s*)(-\s+)?(run|script|before_script|after_script|install|command|commands)\s*:\s*(.*)$/.exec(line);
		if (run) {
			block = (run[1]?.length ?? 0) + (run[2]?.length ?? 0);
			found.text(run[4] ?? "", () => lineOf(path, index));
			return;
		}
		if (block >= 0 && line.trim() !== "" && indent <= block) block = -1;
		if (block >= 0) found.text(line, () => lineOf(path, index));
	});
}

/**
 * What a repository's files and its saved setup command name that its sandboxes would fetch from:
 * presets and exact hosts, each with where it was found. A fixed reading: nothing is run, and nothing
 * a file says is taken for more than a proposal. `reachable` are the hosts its sandboxes reach
 * already: neither they nor a preset whose hosts all are among them is proposed.
 */
export function scanForHosts(files: ReadonlyArray<{ path: string; text: string }>, setup: string, reachable: Iterable<string>): NetworkProposal[] {
	const found = new Found();
	for (const { path, text } of files) {
		const kind = scanKind(path);
		switch (kind) {
			case "package":
				readPackage(found, path, text);
				break;
			case "npm-lock":
				readNpmLock(found, path, text);
				break;
			case "pnpm-lock":
				readLockLines(found, path, text, /\btarball\s*:|resolution\s*:/);
				break;
			case "yarn-lock":
				readLockLines(found, path, text, /^\s*(resolved|resolution)\b/);
				break;
			case "lock":
				if (path.toLowerCase().endsWith("go.sum")) found.add("@go", path);
				else readLockLines(found, path, text, /\b(url|source|registry|remote|resolved|dist|sdist|wheels?)\b|https?:\/\/\S+\.(tgz|tar\.gz|whl|zip|crate)\b|"https?:\/\/[^"]+"\s*[,\]]/i);
				break;
			case "npmrc":
			case "yarnrc":
				found.text(text, (index) => lineOf(path, index), false);
				break;
			case "python":
				found.text(text, (index) => lineOf(path, index), false);
				found.add("@pypi", path);
				break;
			case "toml":
				readToml(found, path, text);
				break;
			case "ci":
				readCi(found, path, text);
				break;
			case "gyp":
				found.add("@node", `${path} (a native addon: node-gyp fetches Node's headers)`);
				break;
			case "devcontainer":
			case "shell":
				found.text(text, (index) => lineOf(path, index));
				break;
			case "manifest":
				if (path.toLowerCase().endsWith("go.mod")) found.add("@go", path);
				else found.text(text, (index) => lineOf(path, index), false);
				break;
			default:
				break;
		}
	}
	if (setup.trim() !== "") found.text(setup, (index) => `the setup command, line ${index + 1}`);

	const skip = new Set(reachable);
	const proposals: NetworkProposal[] = [];
	for (const [entry, sources] of found.items) {
		const hosts = entry.startsWith("@") ? [...(PRESETS[entry] ?? [])] : [entry];
		if (hosts.length === 0 || hosts.every((host) => skip.has(host))) continue;
		proposals.push({ entry, hosts, sources: [...sources] });
	}
	return proposals
		.sort((a, b) => Number(!a.entry.startsWith("@")) - Number(!b.entry.startsWith("@")) || a.entry.localeCompare(b.entry))
		.slice(0, MAX_PROPOSALS);
}
