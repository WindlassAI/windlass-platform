/**
 * Post-setup snapshots of hosted E2B sessions (WLP_E2B_SNAPSHOTS=on): the E2B side of what
 * ../snapshots.ts does with Docker images. The session's side is the same for both (agent-session.ts,
 * `snapshotPlan`, `runSetup`, `restorePrepared`): a snapshot is looked up when a session's first
 * sandbox is made, saved after a setup that qualifies (../snapshot-key.ts, `canSaveSnapshot`), and a
 * sandbox made from one is checked against GitHub before setup is skipped.
 *
 * ## What E2B offers (https://docs.e2b.dev/sandbox/snapshots.md, read 2026-11-22, SDK 2.63.0)
 *
 *   `Sandbox.createSnapshot(id, { name, mode })`  a persistent image of a sandbox, which outlives it;
 *                                         `Sandbox.create(snapshotId)` makes any number of new sandboxes
 *                                         from it. The source is paused for a moment and goes on running.
 *   `mode: "filesystem"`                  the disk only: a sandbox made from it boots from that disk, with
 *                                         none of the source's processes or memory. The only mode used
 *                                         here. A memory snapshot would carry whatever setup's processes
 *                                         held in memory, and is never taken in its place.
 *   `Sandbox.listSnapshots()`, `deleteSnapshot(id)`
 *                                         the account's snapshots carry no metadata: only an id and names.
 *   Pause/resume (persistence.md)         keeps one sandbox, not a starting point for others: not used here.
 *
 * E2B publishes no price for keeping a snapshot (its pricing page bills running sandboxes per second
 * and calls disk free). What a snapshot costs here: the running seconds of the sandbox that is saved
 * while E2B writes the image, and nothing while it is kept, as far as E2B says. The count is capped all
 * the same (WLP_E2B_SNAPSHOT_MAX, WLP_E2B_SNAPSHOT_USER_MAX), every snapshot expires 14 days after it was
 * made, and a sandbox whose disk holds more than WLP_E2B_SNAPSHOT_MAX_GB is not saved.
 *
 * ## The index is the names
 *
 * A snapshot is named `wlp-<deployment>-<user>-<repository>-<generation>-<key>-<made>`: digests of this
 * deployment, of (deployment, user) and of (deployment, user, repository), the first characters of the
 * settings generation and of the cache key, and the time it was made in base 36. So one listing answers
 * which snapshots are this deployment's, whose they are and which are stale, with no state kept on a
 * server: any server of the deployment sees the same. One per user and repository is kept; a newer one
 * replaces it, one of an earlier generation is removed when the next session of that repository looks.
 *
 * The cache key is the Docker key's, adapted: the deployment, the user, the repository, the settings
 * generation, the dependency inputs, the template's name and the build its tag points at (a rebuilt
 * template is a new key), the sandbox profile, the screenshots variant, and the deployment's network
 * mode and hosts. A snapshot is never used for another user: the key and the name hold the user, and the
 * snapshot's own record (below) must name that user exactly before its sandbox is handed out.
 *
 * ## What is on the disk when it is saved
 *
 * Setup runs before Windlass is first started in the sandbox, so the disk then holds the template, the
 * repository's clone in /workspace and what setup wrote. Each thing the platform ever puts into an E2B
 * sandbox that must not be in a snapshot, and how it is kept out (`AUDIT_SCRIPT`, run as root just before):
 *
 *   repository secrets      a setup that was handed any is never saved (`canSaveSnapshot`); a repository
 *                           with secrets is never looked up either (`canReuseSnapshot`)
 *   GitHub token            reaches the transport user's private directory under /tmp on standard input
 *                           and is revoked after the clone (github/git.ts). Every /tmp/wlp-* and /tmp/.wlp-*
 *                           is removed, and the save is refused if one is left, if git's configuration of the
 *                           workspace holds a credential, an extra header or a rewrite, if a remote URL holds
 *                           a user, if a credential store exists, or if a token-shaped string is found
 *                           under /workspace/.git, /home/agent, /tmp, /var/tmp or Windlass's data directory
 *   model credential        a turn's access token file in Windlass's data directory: no turn has run yet,
 *                           and a data directory holding any file at all refuses the save
 *   Windlass's data         sessions, memory, sign-ins: the same check
 *   model relay lease       with WLP_MODEL_RELAY_URL a turn's token file holds the lease's placeholder
 *                           (`wlpm1…`) instead of the token, and Windlass gets the relay's address in its
 *                           command's environment, never in a file. No turn has run before setup, the
 *                           data directory check above refuses any token file, and the token scan looks
 *                           for the placeholder's shape too. The lease itself is kept by the server
 *                           (relay-leases.ts) and ends with the turn: nothing of it is on the disk
 *   environment, memory     E2B's envs are no files; a filesystem snapshot has no memory
 *
 * Then a small record of the snapshot goes to /etc/wlp/snapshot.json, owned by root (the agent has no
 * root): deployment, user, repository, key, inputs, generation, commit and time. A sandbox made from the
 * snapshot is handed out only when that record names the same deployment, user, repository and key.
 */

import type { SnapshotLimits } from "../hosted-settings.js";
import { DEFERRED_INPUTS, digest, HASH, SHA, type SnapshotRequest, type SnapshotSelection, type SnapshotSource } from "../snapshot-key.js";
import type { E2bClient, E2bSnapshotInfo } from "./client.js";
import { type E2bSettings, templateFor } from "./config.js";
import type { HostedSize } from "../../contract.js";

/** The metadata keys a sandbox of a snapshot lookup carries (beside sandboxes.ts `META`). */
export const SNAP_META = {
	/** The fresh id of the lookup the sandbox was made for (`SnapshotRequest.attempt`). */
	attempt: "wlp_snap_attempt",
	/** Cold, for a writer: the key a save must match. Empty for any other. */
	candidate: "wlp_snap_candidate",
	/** The template build the sandbox was made from: a save is refused once the tag has moved. */
	build: "wlp_snap_build",
	variant: "wlp_snap_variant",
	/** Made from a snapshot: its name. Such a sandbox is never saved again. */
	from: "wlp_snap_from",
} as const;

export const RECORD_PATH = "/etc/wlp/snapshot.json";
const NAME = /^wlp-([0-9a-f]{8})-([0-9a-f]{10})-([0-9a-f]{10})-([0-9a-f]{8})-([0-9a-f]{12})-([0-9a-z]{1,11})$/;
const ATTEMPT = /^[a-f0-9]{32}$/;
const REPO = /^[1-9]\d{0,19}$/;
const BUILD_TTL_MS = 5 * 60_000;

/** One of this deployment's snapshots, from its name. */
export interface SnapshotRow {
	id: string;
	name: string;
	user: string;
	repo: string;
	generation: string;
	key: string;
	created: number;
}

/** What a sandbox made from a snapshot holds about it (`RECORD_PATH`). */
export interface SnapshotRecord {
	v: 1;
	deployment: string;
	uid: string;
	repo: string;
	key: string;
	inputs: string;
	generation: string;
	commit: string;
	created: number;
}

/**
 * Run as root just before a save, with Windlass's data directory as $1. Prints `ok <bytes used on />`
 * or `refused <what>`; nothing a sandbox prints otherwise is read. Ends with `sync`: E2B's filesystem
 * snapshot has crash-recovery semantics, and setup's last writes must be on the disk.
 */
export const AUDIT_SCRIPT = [
	"set -u",
	"export PATH=/usr/sbin:/usr/bin:/sbin:/bin",
	'data=$1',
	"rm -rf -- /tmp/wlp-* /tmp/.wlp-* 2>/dev/null",
	'for f in /tmp/wlp-* /tmp/.wlp-*; do if [ -e "$f" ] || [ -L "$f" ]; then echo "refused staging"; exit 0; fi; done',
	'if [ -e "$data" ] && [ -n "$(find "$data" -mindepth 1 ! -type d -print -quit 2>/dev/null)" ]; then echo "refused data"; exit 0; fi',
	'for f in /home/agent/.git-credentials /home/agent/.config/git/credentials /root/.git-credentials; do if [ -e "$f" ]; then echo "refused credentials"; exit 0; fi; done',
	// Read as text: git is never run as root over a configuration the agent can write.
	"if grep -qiE '^[[:space:]]*(extraheader|insteadof|helper)[[:space:]]*=|^[[:space:]]*\\[credential' /workspace/.git/config 2>/dev/null; then echo \"refused git-config\"; exit 0; fi",
	"if grep -qE '://[^/@[:space:]]+@' /workspace/.git/config 2>/dev/null; then echo \"refused remote\"; exit 0; fi",
	"timeout 60 grep -rqIE --exclude-dir=.cache --exclude-dir=node_modules --exclude-dir=objects 'gh[opsu]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|wlpm1[._-][A-Za-z0-9_.-]{20,}' /workspace/.git /home/agent /tmp /var/tmp \"$data\" 2>/dev/null",
	'case $? in 0) echo "refused token"; exit 0;; 124) echo "refused scan"; exit 0;; esac',
	"sync",
	"used=$(df -B1 --output=used / | tail -n 1 | tr -d ' ')",
	'echo "ok $used"',
].join("\n");

/** Run as root with the record on standard input: puts it where only root can change it, and syncs. Prints `written`. */
export const RECORD_SCRIPT = [
	"set -eu",
	"export PATH=/usr/sbin:/usr/bin:/sbin:/bin",
	"umask 022",
	"mkdir -p /etc/wlp",
	`cat > ${RECORD_PATH}.tmp`,
	`mv -f ${RECORD_PATH}.tmp ${RECORD_PATH}`,
	"sync",
	"echo written",
].join("\n");

/** Run as root first in a sandbox made from a snapshot: what the source's lookup stub logged is not this one's. Prints the record. */
export const ADOPT_SCRIPT = [
	"set -u",
	"export PATH=/usr/sbin:/usr/bin:/sbin:/bin",
	'if [ -f "$1" ]; then : > "$1"; fi',
	`cat ${RECORD_PATH}`,
].join("\n");

export type Selected =
	| { hit: true; template: string; name: string; key: string; metadata: Record<string, string> }
	| { hit: false; template: string; metadata: Record<string, string> };

export class E2bSnapshots {
	private readonly builds = new Map<string, { build: string | null; at: number }>();
	readonly limits: SnapshotLimits;

	constructor(
		private readonly client: E2bClient,
		private readonly settings: E2bSettings & { snapshots: SnapshotLimits },
		private readonly log: (line: string) => void,
		private readonly now: () => number,
	) {
		this.limits = settings.snapshots;
	}

	private get namespace() { return digest(["e2b-snapshots", this.settings.deployment]).slice(0, 8); }
	userTag(uid: string) { return digest([this.settings.deployment, uid]).slice(0, 10); }
	repoTag(uid: string, repo: string) { return digest([this.settings.deployment, uid, repo]).slice(0, 10); }
	/** A size's template: a snapshot is of one template's sandbox and starts only sandboxes of that size, so the template is in its key. */
	templateOf(screenshots: boolean, size: HostedSize = "small") { return templateFor(this.settings, size, screenshots); }

	/** The build the template's tag points at now, asked of E2B at most every five minutes. Null: unknown, and no snapshot is used or saved. */
	async build(template: string): Promise<string | null> {
		const cached = this.builds.get(template);
		if (cached && this.now() - cached.at < BUILD_TTL_MS) return cached.build;
		const build = await this.client.templateBuild(template).catch(() => null);
		const safe = build !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(build) ? build : null;
		this.builds.set(template, { build: safe, at: this.now() });
		return safe;
	}

	key(request: Pick<SnapshotRequest, "repo" | "generation" | "inputs">, uid: string, profile: string, screenshots: boolean, build: string, size: HostedSize = "small") {
		const network = this.settings.network;
		return digest(["e2b", this.settings.deployment, uid, request.repo, request.generation, request.inputs, this.templateOf(screenshots, size), build, profile, screenshots, network.mode, [...network.hosts].sort()]);
	}

	coldKey(request: Pick<SnapshotRequest, "repo" | "generation" | "attempt">, uid: string, profile: string) {
		return digest(["e2b-cold", this.settings.deployment, uid, profile, request.repo, request.generation, request.attempt]);
	}

	nameFor(uid: string, repo: string, generation: string, key: string, at: number) {
		return `wlp-${this.namespace}-${this.userTag(uid)}-${this.repoTag(uid, repo)}-${generation.slice(0, 8)}-${key.slice(0, 12)}-${at.toString(36)}`;
	}

	/** The deployment's snapshots, by E2B's listing and their names; another's (or no name of this scheme) is never one. */
	async rows(): Promise<SnapshotRow[]> {
		const found = await this.client.listSnapshots();
		return found.flatMap((info) => {
			const row = this.parse(info);
			return row === null ? [] : [row];
		});
	}

	private parse(info: E2bSnapshotInfo): SnapshotRow | null {
		for (const full of [info.snapshotId, ...info.names]) {
			const name = full.slice(full.lastIndexOf("/") + 1).split(":")[0];
			const match = NAME.exec(name);
			if (match === null || match[1] !== this.namespace) continue;
			const created = parseInt(match[6], 36);
			if (!Number.isSafeInteger(created)) continue;
			return { id: info.snapshotId, name, user: match[2], repo: match[3], generation: match[4], key: match[5], created };
		}
		return null;
	}

	private fresh(row: SnapshotRow) { return this.now() - row.created < this.limits.ttlMs; }

	async has(uid: string, repo: string): Promise<boolean> {
		const user = this.userTag(uid), tag = this.repoTag(uid, repo);
		return (await this.rows()).some((row) => row.user === user && row.repo === tag && this.fresh(row));
	}

	/**
	 * What a new sandbox is made from. Never throws for E2B's sake: a listing or a build that cannot be had
	 * is a cold start. Snapshots of the user and repository from an earlier settings generation are removed.
	 */
	async select(request: SnapshotSelection, uid: string, profile: string, screenshots: boolean, size: HostedSize = "small"): Promise<Selected> {
		const template = this.templateOf(screenshots, size);
		const base = { [SNAP_META.attempt]: request.attempt, [SNAP_META.variant]: screenshots ? "shots" : "base" };
		const cold = (candidate: string, build: string | null): Selected => ({ hit: false, template, metadata: { ...base, [SNAP_META.candidate]: request.writer ? candidate : "", [SNAP_META.build]: build ?? "" } });
		if (!REPO.test(request.repo) || !HASH.test(request.generation) || !ATTEMPT.test(request.attempt)) return cold("", null);
		const build = await this.build(template);
		if (build === null) return cold("", null);
		if (request.inputs === DEFERRED_INPUTS) return cold(this.coldKey(request, uid, profile), build);
		if (!HASH.test(request.inputs)) return cold("", null);
		const key = this.key(request, uid, profile, screenshots, build, size);
		let rows: SnapshotRow[];
		try { rows = await this.rows(); }
		catch { return cold(key, build); }
		const user = this.userTag(uid), tag = this.repoTag(uid, request.repo);
		const mine = rows.filter((row) => row.user === user && row.repo === tag);
		for (const row of mine.filter((row) => row.generation !== request.generation.slice(0, 8))) await this.remove(row, "its setup or GitHub connection changed");
		const found = mine.filter((row) => row.generation === request.generation.slice(0, 8) && row.key === key.slice(0, 12) && this.fresh(row)).sort((a, b) => b.created - a.created)[0];
		if (found === undefined) return cold(key, build);
		return { hit: true, template: found.id, name: found.name, key, metadata: { ...base, [SNAP_META.candidate]: "", [SNAP_META.build]: build, [SNAP_META.from]: found.name } };
	}

	/** Whether a record read from a sandbox made from `name` is that snapshot's, for this user and request. */
	recordFits(record: unknown, name: string, uid: string, request?: Pick<SnapshotRequest, "repo" | "generation" | "inputs">, key?: string): record is SnapshotRecord {
		const r = record as Partial<SnapshotRecord> | null;
		if (r === null || typeof r !== "object" || r.v !== 1 || r.deployment !== this.settings.deployment || r.uid !== uid) return false;
		if (typeof r.repo !== "string" || !REPO.test(r.repo) || typeof r.key !== "string" || !HASH.test(r.key) || typeof r.inputs !== "string" || !HASH.test(r.inputs)) return false;
		if (typeof r.generation !== "string" || !HASH.test(r.generation) || typeof r.commit !== "string" || !SHA.test(r.commit) || !Number.isSafeInteger(r.created)) return false;
		const match = NAME.exec(name);
		if (match === null || match[2] !== this.userTag(uid) || match[3] !== this.repoTag(uid, r.repo) || match[5] !== r.key.slice(0, 12) || match[4] !== r.generation.slice(0, 8)) return false;
		if (request && (request.repo !== r.repo || request.generation !== r.generation || request.inputs !== r.inputs)) return false;
		return key === undefined || key === r.key;
	}

	/** The source a session's restore compares with its plan, from the record and the sandbox's own attempt. */
	sourceOf(record: SnapshotRecord, attempt: string): SnapshotSource {
		return { attempt, repo: record.repo, inputs: record.inputs, generation: record.generation, commit: record.commit, created: record.created };
	}

	async remove(row: SnapshotRow, why: string): Promise<void> {
		const removed = await this.client.deleteSnapshot(row.id).catch((error: unknown) => {
			this.log(`[wlp] e2b.snapshot.remove_failed name=${row.name}: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		});
		if (removed) this.log(`[wlp] e2b.snapshot.removed name=${row.name}: ${why}`);
	}

	/**
	 * Keeps the limits: expired ones go, then all but the newest of each user and repository (`keep` is the
	 * one just saved), then the oldest of a user over WLP_E2B_SNAPSHOT_USER_MAX, then the oldest of the
	 * deployment over WLP_E2B_SNAPSHOT_MAX. `only` narrows it to one user's.
	 */
	async prune(keep?: string, only?: (row: SnapshotRow) => boolean): Promise<SnapshotRow[]> {
		const rows = (await this.rows()).sort((a, b) => b.created - a.created || (a.name === keep ? -1 : b.name === keep ? 1 : 0));
		const kept: SnapshotRow[] = [];
		const owners = new Set<string>();
		const users = new Map<string, number>();
		for (const row of rows) {
			const mayRemove = only === undefined || only(row);
			if (!mayRemove) { kept.push(row); continue; }
			const owner = row.user + row.repo;
			const count = users.get(row.user) ?? 0;
			if (!this.fresh(row)) await this.remove(row, `older than ${this.limits.ttlMs / 86_400_000} days`);
			else if (owners.has(owner)) await this.remove(row, "a newer snapshot of the same user and repository replaced it");
			else if (count >= this.limits.maxPerUser) await this.remove(row, `the user has ${this.limits.maxPerUser} newer ones (WLP_E2B_SNAPSHOT_USER_MAX)`);
			else { kept.push(row); owners.add(owner); users.set(row.user, count + 1); continue; }
			owners.add(owner);
		}
		const left: SnapshotRow[] = [];
		for (const [index, row] of kept.entries()) {
			if (index >= this.limits.maxTotal && (only === undefined || only(row)) && row.name !== keep) await this.remove(row, `the deployment has ${this.limits.maxTotal} newer ones (WLP_E2B_SNAPSHOT_MAX)`);
			else left.push(row);
		}
		return left;
	}

	async drop(uid: string, repo?: string): Promise<void> {
		const user = this.userTag(uid), tag = repo === undefined ? undefined : this.repoTag(uid, repo);
		for (const row of await this.rows()) if (row.user === user && (tag === undefined || row.repo === tag)) await this.remove(row, repo === undefined ? "the user is gone" : "the repository's snapshot was dropped");
	}
}
