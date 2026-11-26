import type { GithubApp } from "../github/app.js";
import { cloneRepository, infoOf, publishWork, putOnWork, sessionRepository, type StoredRepository } from "../github/publish.js";
import type { StoredConnection } from "../github/repos.js";
import type { SandboxHandle } from "../sandbox/api.js";
import { evidencePaths, privateLine, safeTarget, smokeCommand, pruneCitations, validateDraft, type AcceptedDraft } from "./filing.js";
import { isGuide } from "./guide-check.js";
import type { DraftRequest, SetupNote, SkillFiling } from "./types.js";

export interface SetupTurn {
	app: GithubApp; repository: StoredRepository; connection: StoredConnection; sandbox: SandboxHandle;
	savedCommands: string[]; sessionId: string; commit: string; request: DraftRequest; directory: string; notes: SetupNote[]; redact(text: string): string;
}

export async function checkSetupFiling(turn: SetupTurn, args: unknown, signal: AbortSignal, revision: boolean, stats: SkillFiling,
	onRefusedLine: (path: string, line: number, text: string, reason: string) => void) {
	const { app, repository, connection, commit } = turn;
	const { installation } = await sessionRepository(app, connection, repository, "read");
	const wanted = evidencePaths(args);
	const paths: string[] = [];
	const scan = await app.withToken(installation.id, { repositoryId: repository.id, permissions: { metadata: "read", contents: "read" } },
		token => app.scanFiles(token, repository.owner, repository.name, commit, (tree, truncated) => {
			if (truncated) throw Error("The repository file list is incomplete.");
			const read: string[] = [];
			for (const f of tree) {
				if (f.type !== "blob" || f.mode === "120000") continue;
				paths.push(f.path);
				if ((f.size ?? 0) <= 128 * 1024 && (wanted.has(f.path) || isGuide(f.path) || /(?:^|\/)(?:package\.json|CODEOWNERS)$/.test(f.path))) read.push(f.path);
			}
			return { paths: read.slice(0, 160), maxFileBytes: 128 * 1024, maxBytes: 4 * 1024 * 1024, more: false };
		}), { revokeAfter: true });
	if (scan.commit !== commit) throw Error("The repository changed. Run setup again.");
	const draft = validateDraft(args, { ...turn, revision, paths, onRefusedLine, read: new Map(scan.files.map(f => [f.path, f.text])), owner: repository.owner, host: new URL(repository.url).hostname }, stats);
	for (const path of draft.skills.keys()) {
		const command = smokeCommand(draft.files.get(path)!);
		if (!command) continue;
		stats.smokeTested++;
		const check = await turn.sandbox.run(command, { cwd: turn.directory + "/repo", signal, timeoutMs: 3000 });
		signal.throwIfAborted();
		if (check.exitCode === 0 && !check.timedOut && !check.aborted) draft.skills.set(path, "ran");
		else {
			const reason = check.timedOut ? "Smoke check timed out." : check.aborted ? "Smoke check was interrupted." : `Smoke check exited ${check.exitCode ?? "without a status"}.`;
			stats.droppedBySmoke.push({ path, reason });
			draft.skills.delete(path);
			draft.files.delete(path);
		}
	}
	pruneCitations(draft);
	return draft;
}

export function setupBodies(draft: AcceptedDraft, turn: Pick<SetupTurn, "request" | "notes" | "repository" | "redact">) {
	const used = draft.decisions.filter(n => n.uses.length);
	const lines = new Set(used.flatMap(d => d.uses.map(u => u.path + ":" + u.line)));
	const counts = new Map<string, number>();
	for (const d of draft.decisions) if (!d.uses.length) counts.set(d.verdict, (counts.get(d.verdict) ?? 0) + 1);
	const count = (n: number, word: string) => n + " " + word + (n === 1 ? "" : "s");
	const covered = turn.request.areas.filter(area => draft.files.has(area + "/AGENTS.md")).length;
	const later = turn.request.areas.length - covered + turn.request.later;
	const text = ["Adds contributor guides for the repository.", `${count(covered, "folder")} covered.` + (later ? ` ${later} more can be covered later.` : ""),
		draft.decisions.length ? `${count(lines.size, "line")} from ${count(used.length, "imported note")}. ${count(draft.decisions.length - used.length, "note")} unused${counts.size ? " (" + [...counts].map(([v,n]) => n + " " + v).join(", ") + ")" : ""}. Details are on the Repo setup page.` : ""].filter(Boolean).join("\n\n");
	const skillChecks = [...draft.skills].map(([path, status]) => `- \`${path}\` — ${status}`).join("\n");
	const sections = [text];
	if (skillChecks) sections.push("Skill checks\n\n" + skillChecks);
	if (draft.leftOut?.length) sections.push("Left out\n\n" + draft.leftOut.map(note => "- " + note).join("\n"));
	const body = sections.join("\n\n");
	const clean = (s: string) => privateLine(s, { ...turn, host: new URL(turn.repository.url).hostname, owner: turn.repository.owner, read: new Map() })
		? "Details withheld" : s.replace(/[|<>&@\[\]`*_!\\]/g, " ");
	const rows = draft.decisions.flatMap(d => {
		const label = clean(turn.notes.find(n => n.id === d.noteId)!.label);
		return d.uses.length ? d.uses.map(u => `| ${clean(u.path)}:${u.line} | ${label} | ${clean(u.evidence)} |`)
			: [`| ${d.verdict} | ${label} | ${clean(d.reason)} |`];
	});
	return { body, privateBody: rows.length ? body + "\n\n| Guide line or decision | Source note | Evidence or reason |\n| --- | --- | --- |\n" + rows.join("\n") : undefined };
}

export async function publishSetup(turn: SetupTurn, draft: AcceptedDraft, signal: AbortSignal) {
	const { app, connection, repository, sandbox, request, sessionId, commit } = turn;
	const resolved = await sessionRepository(app, connection, repository, "write");
	const available = await app.withToken(resolved.installation.id, { repositoryId: repository.id, permissions: { metadata: "read", pull_requests: "read" } },
		token => app.openSetupPull(token, repository.owner, repository.name, repository.id, repository.branch));
	const branch = available?.head ?? "windlass/repo-setup-" + new Date().toISOString().slice(0, 10).replaceAll("-", "");
	if (branch === repository.branch || branch === resolved.repository.defaultBranch || !/^windlass\/repo-setup-\d{8}$/.test(branch)) throw Error("The guide branch must be separate from the default branch.");
	const cloned = await cloneRepository(app, connection, repository, sandbox, signal, available ? branch : undefined, available ? undefined : commit);
	if (!cloned || repository.baseSha !== commit || (available && cloned.workAt !== available.headSha)) throw Error("The repository changed during setup. Run it again.");
	if (available) await putOnWork(sandbox, cloned.directory, branch, cloned.workAt!);
	const directory = cloned.directory === "." ? sandbox.cwd : sandbox.cwd + "/" + cloned.directory;
	for (const [path, content] of draft.files) {
		if (!safeTarget(path)) throw Error("Invalid guide path.");
		const parts = path.split("/");
		const guard = parts.map((_, i) => "test ! -L './" + parts.slice(0, i + 1).join("/") + "'").join(" && ");
		const wrote = await sandbox.run(guard + " && mkdir -p -- './" + (parts.slice(0, -1).join("/") || ".") + "' && cat > './" + path + "'", { cwd: directory, stdin: content, signal, timeoutMs: 5000 });
		if (wrote.exitCode !== 0) throw Error("A guide target is missing or is a symbolic link.");
	}
	let linkedToClaude = !!(draft.skills.size && request.previous?.linkedToClaude && request.previous.pull.number === available?.number);
	if (draft.skills.size) {
		const linked = await sandbox.run("if test -d .claude && test ! -L .claude && test ! -e .claude/skills && test ! -L .claude/skills; then ln -s ../.agents/skills .claude/skills && echo linked; fi", { cwd: directory, signal, timeoutMs: 5000 });
		if (linked.exitCode !== 0) throw Error("Could not link the repository skills.");
		if (linked.stdout.trim() === "linked") linkedToClaude = true;
	}
	// A collection of draft files replaces the previous publication, including files dropped by the reviewer.
	const previous = request.previous;
	if (available && previous?.pull.number === available.number) {
		const dropped = previous.files.filter(path => !draft.files.has(path));
		if (previous.linkedToClaude && !draft.skills.size) dropped.push(".claude/skills");
		if (dropped.length) {
			if (previous.head !== available.headSha || dropped.some(path => !safeTarget(path) || path !== ".claude/skills" && !isGuide(path))) throw Error("The earlier draft changed. Review the pull request before changing this repository again.");
			const paths = dropped.map(path => `"${path}"`).join(" ");
			const restored = await sandbox.run(`git -c core.hooksPath=/dev/null restore --source=${commit} --staged --worktree -- ${paths}`, { cwd: directory, signal, timeoutMs: 5000 });
			if (restored.exitCode !== 0) throw Error("Could not remove earlier setup changes.");
		}
	}
	const { body, privateBody } = setupBodies(draft, turn);
	const pull = available ? infoOf(available, request.previous?.pull.pushedAt ?? Date.now(), "") : null;
	signal.throwIfAborted();
	const result = await publishWork({ app, connection, repository, sandbox, sessionId, branch, pull, pushed: cloned.workAt, retitle: true, shownIsEnough: true,
		message: { title: "Add repository guides", commit: "docs: add repository guides", body }, privateBody,
		evidence: null, redact: turn.redact });
	return { pull: result.pull, linkedToClaude: linkedToClaude || undefined, head: result.head ?? undefined, files: [...draft.files.keys()] };
}
