import type { PullRequestInfo } from "../contract.js";
import type { GithubApp } from "../github/app.js";
import { cloneRepository, publishWork, putOnWork, sessionRepository, type StoredRepository } from "../github/publish.js";
import type { StoredConnection } from "../github/repos.js";
import type { SandboxHandle } from "../sandbox/api.js";
import { evidencePaths, privateLine, safeTarget, validateDraft, type AcceptedDraft } from "./filing.js";
import type { DraftRequest, SetupNote } from "./types.js";

export interface SetupTurn {
	app: GithubApp; repository: StoredRepository; connection: StoredConnection; sandbox: SandboxHandle;
	sessionId: string; commit: string; request: DraftRequest; notes: SetupNote[]; redact(text: string): string;
}

export async function checkSetupFiling(turn: SetupTurn, args: unknown) {
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
				if ((f.size ?? 0) <= 128 * 1024 && (wanted.has(f.path) || /(?:^|\/)(?:package.json|AGENTS.md|CODEOWNERS)$/.test(f.path))) read.push(f.path);
			}
			return { paths: read.slice(0, 160), maxFileBytes: 128 * 1024, maxBytes: 4 * 1024 * 1024, more: false };
		}), { revokeAfter: true });
	if (scan.commit !== commit) throw Error("The repository changed. Run setup again.");
	return validateDraft(args, { ...turn, paths, read: new Map(scan.files.map(f => [f.path, f.text])), owner: repository.owner, host: new URL(repository.url).hostname });
}

export function setupBodies(draft: AcceptedDraft, turn: Pick<SetupTurn, "request" | "notes" | "repository" | "redact">) {
	const used = draft.decisions.filter(n => n.uses.length);
	const lines = new Set(used.flatMap(d => d.uses.map(u => u.path + ":" + u.line)));
	const counts = new Map<string, number>();
	for (const d of draft.decisions) if (!d.uses.length) counts.set(d.verdict, (counts.get(d.verdict) ?? 0) + 1);
	const count = (n: number, word: string) => n + " " + word + (n === 1 ? "" : "s");
	const text = ["Adds contributor guides for the repository.", turn.request.later ? `${turn.request.areas.length} folders drafted. ${turn.request.later} more can be covered later.` : "",
		draft.decisions.length ? `${count(lines.size, "line")} from ${count(used.length, "imported note")}. ${count(draft.decisions.length - used.length, "note")} unused${counts.size ? " (" + [...counts].map(([v,n]) => n + " " + v).join(", ") + ")" : ""}. Details are on the Repo setup page.` : ""].filter(Boolean).join("\n\n");
	const clean = (s: string) => privateLine(s, { ...turn, host: new URL(turn.repository.url).hostname, owner: turn.repository.owner, read: new Map() })
		? "Details withheld" : s.replace(/[|<>&@\[\]`*_!\\]/g, " ");
	const rows = draft.decisions.flatMap(d => {
		const label = clean(turn.notes.find(n => n.id === d.noteId)!.label);
		return d.uses.length ? d.uses.map(u => `| ${clean(u.path)}:${u.line} | ${label} | ${clean(u.evidence)} |`)
			: [`| ${d.verdict} | ${label} | ${clean(d.reason)} |`];
	});
	return { body: text, privateBody: rows.length ? text + "\n\n| Guide line or decision | Source note | Evidence or reason |\n| --- | --- | --- |\n" + rows.join("\n") : undefined };
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
		const wrote = await sandbox.run(guard + " && cat > './" + path + "'", { cwd: directory, stdin: content, signal, timeoutMs: 5000 });
		if (wrote.exitCode !== 0) throw Error("A guide target is missing or is a symbolic link.");
	}
	const { body, privateBody } = setupBodies(draft, turn);
	const pull: PullRequestInfo | null = available ? { number: available.number, state: available.state, url: available.url, title: available.title,
		branch, base: available.base, pushedAt: request.previous?.pushedAt ?? Date.now(), verified: "" } : null;
	signal.throwIfAborted();
	const result = await publishWork({ app, connection, repository, sandbox, sessionId, branch, pull, pushed: cloned.workAt, retitle: true, shownIsEnough: true,
		message: { title: "Add repository guides", commit: "docs: add repository guides", body }, privateBody,
		evidence: { verified: null, checks: [], during: null, redact: turn.redact } });
	return { pull: result.pull, questions: draft.questions, files: [...draft.files.keys()] };
}
