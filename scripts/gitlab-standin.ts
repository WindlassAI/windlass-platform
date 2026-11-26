/** A loopback GitLab OAuth application, v4 API and smart-HTTP git remote for protocol checks.
 * Seed an inaccessible project with addProject({owner, name, accessible:false}); it is absent from
 * discovery and denied over REST and git. Use deliverHook(hookId, event, payload, {guid?, omitToken?})
 * for a real HTTP delivery with a registered hook's URL and token.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const now = () => new Date().toISOString();
const secret = () => randomBytes(24).toString("hex");
type Id = number | bigint;
const wire = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? (JSON as JSON & { rawJSON(s: string): unknown }).rawJSON(String(v)) : v);
interface DeliveryOptions { guid?: string; secret?: string; omitToken?: boolean }
interface User { id: Id; username: string; name: string }
interface Note { id: Id; body: string; author: User; created_at: string; updated_at: string; system: boolean }
interface MergeRequest {
	id: Id; iid: number; project_id: Id; source_project_id: Id; target_project_id: Id; title: string; description: string;
	source_branch: string; target_branch: string; state: string; draft: boolean; merge_status: string; detailed_merge_status: string;
	author: User; reviewers: User[]; merge_user: User | null; web_url: string; notes: Note[];
}
interface Pipeline { id: Id; sha: string; ref: string; status: string; web_url: string; created_at: string; updated_at: string }
interface Job { id: Id; name: string; status: string; stage: string; allow_failure: boolean; failure_reason?: string; ref: string; commit: { id: string }; pipeline: Pipeline; web_url: string; created_at: string; retried: boolean }
export interface StandinProject {
	id: Id; owner: string; name: string; path: string; defaultBranch: string; visibility: string; archived: boolean; accessible: boolean;
	mergeRequests: MergeRequest[]; pipelines: Pipeline[]; jobs: Job[]; traces: Map<string, string>;
}
interface Session { access: string; refresh: string; expiresAt: number; scope: string }
export interface StandinOptions { callbackUrl?: string; pageSize?: number }
function git(args: string[], cwd?: string) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: {
		...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Stand-in", GIT_COMMITTER_NAME: "Stand-in",
		GIT_AUTHOR_EMAIL: "standin@example.invalid", GIT_COMMITTER_EMAIL: "standin@example.invalid",
	} }).trim();
}

export class GitlabStandin {
	readonly clientId = secret();
	readonly clientSecret = secret();
	readonly webhookSecret = secret();
	readonly hooks: { id: number; projectId: Id; url: string; token: string }[] = [];
	readonly token = `glpat-${secret()}`;
	readonly user: User = { id: 71, username: "ada", name: "Ada Owner" };
	readonly projects: StandinProject[] = [];
	readonly requests: { method: string; status: number }[] = [];
	readonly retries: string[] = [];
	readonly reactions = new Set<string>();
	readonly root = mkdtempSync(join(tmpdir(), "wlp-gitlab-"));
	readonly sessions = new Map<string, Session>();
	private readonly codes = new Map<string, { challenge: string; scope: string }>();
	private nextId = 1000;
	private server: Server | null = null;
	baseUrl = "";
	constructor(readonly options: StandinOptions = {}) {}
	get url() { return this.baseUrl; }
	get apiUrl() { return this.baseUrl + "/api/v4"; }
	get redirectUrl() { return this.options.callbackUrl ?? this.baseUrl + "/gitlab/callback"; }
	static async start(options?: StandinOptions) {
		const fixture = new GitlabStandin(options);
		await fixture.start();
		return fixture;
	}
	async start() {
		const server = this.server = createServer((req, res) => {
			this.route(req, res).catch(() => { res.writeHead(500); res.end("stand-in failure"); });
		});
		await new Promise<void>((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No loopback address");
		this.baseUrl = `http://127.0.0.1:${address.port}`;
	}
	async stop() {
		const server = this.server;
		if (server) await new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections(); });
		rmSync(this.root, { recursive: true, force: true });
	}
	addProject(input: { id?: Id; owner: string; name: string; defaultBranch?: string; files?: Record<string, string>; visibility?: string; accessible?: boolean }) {
		if (![...input.owner.split("/"), input.name].every(x => /^[\w-][\w.-]*$/.test(x))) throw new Error("Invalid fixture path");
		const path = join(this.root, input.owner, input.name + ".git"), defaultBranch = input.defaultBranch ?? "main";
		git(["init", "--quiet", "--bare", `--initial-branch=${defaultBranch}`, path]);
		git(["config", "http.receivepack", "true"], path);
		const p: StandinProject = { id: input.id ?? ++this.nextId, owner: input.owner, name: input.name, path, defaultBranch,
			accessible: input.accessible ?? true, visibility: input.visibility ?? "private", archived: false, mergeRequests: [], pipelines: [], jobs: [], traces: new Map() };
		this.commit(p, defaultBranch, input.files ?? { "README.md": `# ${p.name}\n` }, "Initial commit");
		this.projects.push(p);
		return p;
	}
	branchHead(p: StandinProject, branch: string) {
		try { return git(["rev-parse", "--verify", "refs/heads/" + branch], p.path); } catch { return null; }
	}
	commit(p: StandinProject, branch: string, files: Record<string, string | null>, message: string, from?: string) {
		const work = mkdtempSync(join(this.root, "seed-"));
		try {
			git(["init", "--quiet", `--initial-branch=${branch}`, work]);
			const start = from ?? branch;
			if (from || this.branchHead(p, start)) {
				git(["fetch", "--quiet", p.path, `refs/heads/${start}`], work);
				git(["reset", "--hard", "FETCH_HEAD"], work);
			}
			for (const [name, value] of Object.entries(files)) {
				if (name.split("/").some(part => ["", ".", "..", ".git"].includes(part))) throw new Error("Invalid fixture file");
				const path = join(work, name);
				if (value === null) rmSync(path, { force: true });
				else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
			}
			git(["add", "-A"], work);
			git(["commit", "--allow-empty", "-m", message], work);
			git(["push", p.path, `HEAD:refs/heads/${branch}`], work);
			return git(["rev-parse", "HEAD"], work);
		} finally { rmSync(work, { recursive: true, force: true }); }
	}
	private web(p: StandinProject) { return `${this.baseUrl}/${p.owner}/${p.name}`; }
	addPipeline(p: StandinProject, sha: string, ref: string, status: string) {
		const id = ++this.nextId;
		const pipe: Pipeline = { id, sha, ref, status, web_url: `${this.web(p)}/-/pipelines/${id}`, created_at: now(), updated_at: now() };
		p.pipelines.unshift(pipe);
		return pipe;
	}
	addJob(p: StandinProject, pipeline: Pipeline, name: string, status: string, trace = "") {
		const id = ++this.nextId;
		const job: Job = { id, pipeline, ref: pipeline.ref, commit: { id: pipeline.sha }, name, status, allow_failure: false, stage: "test", retried: false,
			web_url: `${this.web(p)}/-/jobs/${id}`, created_at: now() };
		p.jobs.unshift(job); p.traces.set(String(id), trace);
		return job;
	}
	/** Play the browser consent click without following the redirect to the platform. */
	authorize(address: string, deny = false) {
		const url = new URL(address), q = url.searchParams;
		if (url.origin !== this.baseUrl || url.pathname !== "/oauth/authorize" || q.get("client_id") !== this.clientId || q.get("redirect_uri") !== this.redirectUrl ||
			q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) throw new Error("Invalid authorization request");
		const target = new URL(this.redirectUrl);
		target.searchParams.set("state", q.get("state") ?? "");
		if (deny) target.searchParams.set("error", "access_denied");
		else {
			const code = secret();
			this.codes.set(code, { challenge: q.get("code_challenge")!, scope: q.get("scope") ?? "read_user" });
			target.searchParams.set("code", code);
		}
		return target.href;
	}
	deliver(url: string, event: string, payload: unknown, options: DeliveryOptions = {}) {
		const body = wire(payload), guid = options.guid ?? randomUUID(), token = options.secret ?? this.webhookSecret;
		const headers: Record<string, string> = { "content-type": "application/json", "x-gitlab-event": event, "x-gitlab-event-uuid": guid, "x-gitlab-webhook-uuid": guid, "idempotency-key": guid };
		if (!options.omitToken) headers["x-gitlab-token"] = token;
		return fetch(url, { method: "POST", redirect: "manual", body, headers });
	}
	/** POST to the registered target using that project's hook token, just as GitLab does. */
	deliverHook(hookId: string | number, event: string, payload: unknown, options: DeliveryOptions = {}) {
		const hook = this.hooks.find(h => String(h.id) === String(hookId));
		if (!hook) throw new Error("Unknown project hook");
		return this.deliver(hook.url, event, payload, { ...options, secret: options.secret ?? hook.token });
	}
	private async route(req: IncomingMessage, res: ServerResponse) {
		const u = new URL(req.url!, this.baseUrl), path = u.pathname, q = u.searchParams, method = req.method!;
		res.once("finish", () => this.requests.push({ method, status: res.statusCode }));
		const json = (status: number, obj: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(wire(obj)); };
		const fail = (status: number, message: string) => json(status, { message });
		const missing = () => fail(404, "404 Not Found");
		const page = (items: unknown[]) => {
			const size = Math.max(1, Math.min(Number(q.get("per_page") ?? 20), this.options.pageSize ?? 100, 100));
			const n = Math.max(1, Number(q.get("page") ?? 1));
			res.setHeader("x-page", n); res.setHeader("x-per-page", size);
			res.setHeader("x-next-page", n * size < items.length ? String(n + 1) : "");
			if (n * size < items.length) { const next = new URL(u); next.searchParams.set("page", String(n + 1)); res.setHeader("link", `<${next}>; rel="next"`); }
			json(200, items.slice((n - 1) * size, n * size));
		};
		const chunks: Buffer[] = []; let length = 0;
		for await (const chunk of req) {
			length += chunk.length;
			if (length > 16 * 1024 * 1024) return fail(413, "Request too large");
			chunks.push(chunk);
		}
		const body = Buffer.concat(chunks);
		const auth = req.headers.authorization ?? "";
		const scopes = (token: string) => {
			if (token === this.token) return ["api"];
			const s = this.sessions.get(token);
			return s && s.expiresAt > Date.now() ? s.scope.split(" ") : [];
		};
		const remote = this.projects.find(p => path.startsWith(`/${p.owner}/${p.name}.git/`));
		if (remote) {
			const suffix = path.slice(`/${remote.owner}/${remote.name}.git`.length);
			if (!["/info/refs", "/git-receive-pack", "/git-upload-pack"].includes(suffix)) return missing();
			const creds = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString() : "";
			const grants = scopes(creds.slice(creds.indexOf(":") + 1));
			if (!grants.length || !creds.includes(":")) { res.setHeader("www-authenticate", 'Basic realm="GitLab"'); return fail(401, "Unauthorized"); }
			if (!remote.accessible) return missing();
			const advertise = suffix === "/info/refs";
			const service = advertise ? q.get("service") : suffix.slice(1);
			if ((advertise ? method !== "GET" : method !== "POST") || (service !== "git-receive-pack" && service !== "git-upload-pack")) return missing();
			const push = service === "git-receive-pack";
			if (!grants.includes("api") && !grants.includes("write_repository") && (push || !grants.includes("read_repository"))) return fail(403, "Forbidden");
			// Only fixture-sized packs are supported. All request and response bytes, including packfiles, stay binary.
			const raw = execFileSync("git", ["http-backend"], { input: body, maxBuffer: 20 * 1024 * 1024, env: {
				...process.env, GIT_PROJECT_ROOT: this.root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: path, REQUEST_METHOD: method, QUERY_STRING: q.toString(),
				CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length), REMOTE_USER: "oauth2", REMOTE_ADDR: "127.0.0.1",
			} });
			const split = raw.indexOf("\r\n\r\n");
			if (split < 0) throw new Error("Missing CGI headers");
			for (const line of raw.subarray(0, split).toString().split("\r\n")) {
				const index = line.indexOf(":"), key = line.slice(0, index), value = line.slice(index + 1).trim();
				if (key.toLowerCase() === "status") res.statusCode = parseInt(value, 10); else res.setHeader(key, value);
			}
			res.end(raw.subarray(split + 4)); return;
		}
		let fields: Record<string, string> = {};
		if (body.length) {
			try { fields = req.headers["content-type"]?.includes("json") ? JSON.parse(body.toString()) : Object.fromEntries(new URLSearchParams(body.toString())); }
			catch { return fail(400, "Malformed request"); }
		}
		if (path === "/oauth/authorize" && method === "GET") {
			try { res.writeHead(302, { location: this.authorize(u.href) }).end(); } catch { fail(400, "Invalid authorization request"); }
			return;
		}
		if (["/oauth/token", "/oauth/revoke"].includes(path) && method === "POST") {
			const client = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":") : [fields.client_id, fields.client_secret];
			if (client[0] !== this.clientId || client[1] !== this.clientSecret) return json(401, { error: "invalid_client" });
			if (path === "/oauth/revoke") {
				const session = [...this.sessions.values()].find(s => s.access === fields.token || s.refresh === fields.token);
				if (session) this.sessions.delete(session.access);
				return json(200, {});
			}
			let scope: string;
			if (fields.grant_type === "refresh_token") {
				const prev = [...this.sessions.values()].find(s => s.refresh === fields.refresh_token);
				if (!prev) return json(400, { error: "invalid_grant" });
				this.sessions.delete(prev.access); scope = prev.scope;
			} else if (fields.grant_type === "authorization_code") {
				const code = this.codes.get(fields.code);
				if (!code || fields.redirect_uri !== this.redirectUrl || !fields.code_verifier || createHash("sha256").update(fields.code_verifier).digest("base64url") !== code.challenge) return json(400, { error: "invalid_grant" });
				this.codes.delete(fields.code); scope = code.scope;
			} else return json(400, { error: "unsupported_grant_type" });
			const s = { access: secret(), refresh: secret(), scope, expiresAt: Date.now() + 7200000 };
			this.sessions.set(s.access, s);
			return json(200, { access_token: s.access, refresh_token: s.refresh, token_type: "Bearer", expires_in: 7200, created_at: Math.floor(Date.now() / 1000), scope });
		}
		if (!path.startsWith("/api/v4/")) return missing();
		const grants = scopes(auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["private-token"] ?? ""));
		if (!grants.length) return fail(401, "401 Unauthorized");
		const api = path.slice("/api/v4".length);
		if (api === "/user" && method === "GET") return json(200, this.user);
		if (!grants.includes("api") && !(method === "GET" && grants.includes("read_api"))) return fail(403, "403 Forbidden");
		const projectData = (p: StandinProject) => ({ id: p.id, name: p.name, path: p.name, namespace: { full_path: p.owner }, path_with_namespace: p.owner + "/" + p.name,
			name_with_namespace: p.owner + " / " + p.name, default_branch: p.defaultBranch, visibility: p.visibility, archived: p.archived, web_url: this.web(p), http_url_to_repo: this.web(p) + ".git",
			permissions: { project_access: { access_level: 40 }, group_access: null } });
		if (api === "/projects" && method === "GET") return page(this.projects.filter(p => p.accessible && (p.owner + "/" + p.name).toLowerCase().includes((q.get("search") ?? "").toLowerCase())).map(projectData));
		const [, root, projectKey, ...rest] = api.split("/").map(decodeURIComponent);
		const p = this.projects.find(p => String(p.id) === projectKey || p.owner + "/" + p.name === projectKey);
		if (root !== "projects" || !p?.accessible) return missing();
		const [resource, key, action, subId, more] = rest;
		if (!resource && method === "GET") return json(200, projectData(p));
		if (resource === "hooks" && method === "POST" && !key) {
			if (!fields.url || !fields.token) return fail(400, "Invalid hook");
			const id = ++this.nextId;
			this.hooks.push({ id, projectId: p.id, url: fields.url, token: fields.token });
			const { token: _secret, ...config } = fields;
			return json(201, { ...config, id, project_id: p.id });
		}
		if (resource === "repository" && key === "branches" && method === "GET" && action) {
			const id = this.branchHead(p, action); return id ? json(200, { name: action, commit: { id } }) : missing();
		}
		if (resource === "pipelines" && method === "GET") {
			if (!key) return page(p.pipelines.filter(x => (!q.has("sha") || x.sha === q.get("sha")) && (!q.has("ref") || x.ref === q.get("ref"))));
			const pipe = p.pipelines.find(x => String(x.id) === key);
			if (!pipe) return missing();
			if (!action) return json(200, pipe);
			if (action === "jobs") return page(p.jobs.filter(j => j.pipeline === pipe && (!j.retried || q.get("include_retried") === "true")));
		}
		if (resource === "jobs") {
			const job = p.jobs.find(j => String(j.id) === key);
			if (!job) return missing();
			if (!action && method === "GET") return json(200, job);
			if (action === "trace" && method === "GET") { res.writeHead(200, { "content-type": "text/plain" }); res.end(p.traces.get(key)); return; }
			if (action === "retry" && method === "POST") {
				if (job.retried || !["failed", "canceled"].includes(job.status)) return fail(400, "Job cannot be retried");
				job.retried = true; this.retries.push(key);
				return json(201, this.addJob(p, job.pipeline, job.name, "pending"));
			}
		}
		if (resource === "merge_requests") {
			const data = (mr: MergeRequest) => {
				const { notes, ...fields } = mr;
				const sha = this.branchHead(p, mr.source_branch), base = this.branchHead(p, mr.target_branch);
				return { ...fields, sha, diff_refs: { head_sha: sha, base_sha: base, start_sha: base }, user_notes_count: notes.length };
			};
			if (!key && method === "GET") return page(p.mergeRequests.filter(m => (!q.has("state") || m.state === q.get("state")) && (!q.has("source_branch") || m.source_branch === q.get("source_branch"))).map(data));
			if (!key && method === "POST") {
				if (!fields.title || !this.branchHead(p, fields.source_branch) || !this.branchHead(p, fields.target_branch) || fields.source_branch === fields.target_branch) return fail(400, "Invalid merge request");
				if (p.mergeRequests.some(m => m.state === "opened" && m.source_branch === fields.source_branch && m.target_branch === fields.target_branch)) return fail(409, "Merge request already exists");
				const iid = p.mergeRequests.length + 1;
				const mr: MergeRequest = { id: ++this.nextId, iid, project_id: p.id, source_project_id: p.id, target_project_id: p.id,
					state: "opened", merge_status: "can_be_merged", detailed_merge_status: "mergeable", title: fields.title, description: fields.description ?? "",
					source_branch: fields.source_branch, target_branch: fields.target_branch, draft: /^draft:/i.test(fields.title), author: this.user, reviewers: [],
					merge_user: null, web_url: `${this.web(p)}/-/merge_requests/${iid}`, notes: [] };
				p.mergeRequests.push(mr); return json(201, data(mr));
			}
			const mr = p.mergeRequests.find(m => String(m.iid) === key);
			if (!mr) return missing();
			if (!action && method === "GET") return json(200, data(mr));
			if (!action && method === "PUT") {
				if (fields.title) { mr.title = fields.title; mr.draft = /^draft:/i.test(mr.title); }
				if (fields.description !== undefined) mr.description = fields.description;
				if (fields.state_event === "close") mr.state = "closed";
				if (fields.state_event === "reopen") mr.state = "opened";
				return json(200, data(mr));
			}
			if (action === "merge" && method === "PUT") {
				const head = this.branchHead(p, mr.source_branch), base = this.branchHead(p, mr.target_branch);
				if (fields.sha && head !== fields.sha) return fail(409, "SHA does not match HEAD of source branch");
				if (!base || !head || mr.state !== "opened" || mr.draft || mr.detailed_merge_status !== "mergeable") return fail(405, "Branch cannot be merged");
				try { git(["merge-base", "--is-ancestor", base, head], p.path); } catch { return fail(405, "Non-fast-forward fixture merge"); }
				const tree = git(["rev-parse", head + "^{tree}"], p.path);
				const sha = fields.squash ? git(["commit-tree", tree, "-p", base, "-m", fields.squash_commit_message || mr.title], p.path) : head;
				git(["update-ref", `refs/heads/${mr.target_branch}`, sha, base], p.path);
				mr.state = "merged"; mr.merge_user = this.user; return json(200, data(mr));
			}
			if (action === "notes") {
				if (!subId && method === "GET") return page(mr.notes);
				if (!subId && method === "POST" && fields.body) {
					const note = { id: ++this.nextId, body: fields.body, author: this.user, created_at: now(), updated_at: now(), system: false };
					mr.notes.push(note); return json(201, note);
				}
				const note = mr.notes.find(n => String(n.id) === subId);
				if (!note) return missing();
				if (!more && method === "PUT" && fields.body) { note.body = fields.body; note.updated_at = now(); return json(200, note); }
				if (!more && method === "GET") return json(200, note);
			}
		}
		if (["issues", "merge_requests"].includes(resource) && /^\d+$/.test(key) && method === "POST" && fields.name === "eyes") {
			const note = rest.length === 5 && action === "notes" && /^\d+$/.test(subId) && more === "award_emoji";
			if (!note && !(rest.length === 3 && action === "award_emoji")) return missing();
			this.reactions.add(`/projects/${p.id}/${resource}/${key}${note ? `/notes/${subId}` : ""}/award_emoji:eyes`);
			return json(201, { id: ++this.nextId, name: fields.name, user: this.user });
		}
		return missing();
	}
}
