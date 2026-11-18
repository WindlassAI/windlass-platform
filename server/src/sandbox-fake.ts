/**
 * A sandbox layer with no Docker in it, for `WLP_SANDBOX=fake`: sandboxes are objects in memory,
 * `runTurn` replays a recorded Windlass run from fixtures/windlass-events/, and sign-ins return a
 * synthetic account. No model is called and nothing leaves the process.
 *
 * Words in the prompt choose the recording, as they choose the demo scenario of the real layer:
 *
 *   network, fetch, download, curl, http, headers, website, url
 *                   a command asks for network access: the turn stops at `approval.requested`, calls
 *                   `onQuestion`, and goes on with the recording in which the user allowed the call or
 *                   the one in which they declined it. Without `onQuestion` the call is refused at once
 *                   (`approval.denied`, reason `unattended`), as Windlass does when nobody can answer.
 *   long, slow, build, progress, wait
 *                   one command that prints for a while: the turn to steer, or to stop one call of
 *
 * A turn that is handed checks (`RunTurnInput.checks`) ends with one run of them, as the gate of a
 * Windlass that takes them as required checks would report it: each is the session's and required,
 * a check whose command has the word "fail" in it fails, with the end of its output in the evidence,
 * and the turn ends `unresolved`; any other passes.
 *
 * Switches in the prompt reach every other ending:
 *
 *   "(slow)"          twenty times the delay between events, long enough to stop a turn or a call
 *   "(slow-stop)"     a stopped turn takes most of a second to wind down
 *   "(crash)"         Windlass dies after a few events: exit code 1, no summary, text on stderr,
 *                     `failure.reason` "engine"
 *   "(throw)"         the layer itself fails: `runTurn` rejects
 *   "(auth-fail)"     the recorded run of a refused sign-in: `failure.reason` "auth_required"
 *   "(old-windlass)"  the image's Windlass cannot hand a token on (it has no `login token`, or not that
 *                     command's `--valid-for`): "windlass_outdated", no events
 *   "(session-gone)"  Windlass no longer has the session to continue: "session_not_found", no events
 *   "(session-busy)"  another process holds the session: "session_in_use", no events
 *   "(exec-fail)"     the model call fails for good: outcome `failed`, "execution_failed"
 *   "(lose-sandbox)"  the sandbox is gone when the turn ends, as if its container had been removed
 *   "(big-memory)"    Windlass's session grows by two mebibytes in this turn, for a copy that is over
 *                     the limit (with WLP_FAKE_BACKUP_DIR, below)
 *
 * And the project's own MCP servers, which Windlass leaves stopped until the user approves them. Each
 * switch says what the workspace's `.windlass/config.json` names in this turn; the question is put
 * through `onServerQuestion` before the first event, as the real layer puts it before the prompt:
 *
 *   "(mcp)"           the server "harbor", started by `python3 tools/harbor_mcp.py`; approved, it runs
 *                     with two tools
 *   "(mcp-changed)"   the same server with another argument: another definition, asked about anew
 *   "(mcp-env)"       its definition reads HARBOR_TOKEN, which is not set: the question says so, and
 *                     approved it fails to start with Windlass's sentence
 *   "(mcp-remote)"    a server "docs" that is reached at an address and not started
 *   "(mcp-moved)"     the definition changes while the question is open: the approval finds nothing
 *                     waiting (`changed`), and the new definition is asked about
 *   "(mcp-late)"      "harbor" with yet another argument, which Windlass reports at the turn's first model call, so the
 *                     question is put while the turn runs; with a word that makes the turn ask about a
 *                     tool call, both questions are open at once
 *
 * An approval is remembered as Windlass remembers it: for exactly that definition, where its data is
 * (per sandbox with WLP_FAKE_BACKUP_DIR, as on E2B; otherwise per user, as on Docker's volume). A
 * server left stopped is asked about again by the next turn that names it. What the turn's project
 * names is reported through `onServers` as the real layer reports it: before the first question, and
 * again whenever a server starts or fails. The user's own servers a turn is handed
 * (`RunTurnInput.servers`) are reported with them, as Windlass starts them: running with one tool,
 * or failed with Windlass's sentence when the definition reads a variable the turn's secrets do not
 * hold; nothing is started.
 *
 * A repository address that contains "slow-clone" takes a second and a half to clone, which holds a
 * turn in `starting`; one that contains "fail-clone" fails.
 *
 * `TurnControl.steer` writes the `inbox.enqueued` a real steer produces and its `inbox.delivered` at
 * the next step; `TurnControl.cancelCall` settles a running call early (`tool.cancel_requested`, then
 * `tool.settled` with what it had printed) and the turn goes on. After the last recorded event the
 * layer's own `cli.summary`-shaped event follows, built from the events as the real layer builds it.
 *
 * With WLP_FAKE_BACKUP_DIR=<directory> the layer behaves as the E2B layer does where a bucket is
 * configured. Windlass's sessions then live in the sandbox they were made in (`sessionsLiveInSandbox`):
 * a turn that names a session its sandbox does not hold ends with `session_not_found`, as with a real
 * Windlass. And the layer has `backups`: the real `SandboxSessionBackups` (sandbox/backup.ts) over a
 * stand-in for the bucket that keeps each object as a file in that directory (bucket/stand-in.ts). The
 * fake sandbox has no shell, so it plays the three scripts' parts itself (`FakeHandle.backupStep`):
 * it packs its sessions, uploads and downloads through the signed link, and checks what it fetched
 * against the size and hash it is told, with the same answers the scripts give. A test removes or
 * damages an object's file to play a bucket that lost or spoiled it; restarting the server loses the
 * sandboxes and keeps the directory.
 *
 * Sign-in: paste `<redirectPrefix>?code=<name>` to sign in as `<name>@example.com`; `code=refused`
 * is refused. The steps, the sealed attempt and the user's sign-in in the `user` actor are the real
 * ones (server/src/signin/): only Windlass is stood in for (`FakeSignInCommands`), so what a sign-in
 * holds here is a made-up `auth.json` with obviously fake tokens.
 *
 * Access tokens: a turn without a script asks the layer's token source for its user's access token
 * first, as the real layer does, and is handed one (a line `[wlp] token.handed` says so; the token is
 * obviously fake and goes nowhere). A demo turn asks for none. The account's name decides the answer:
 * `code=expired` signs in an account whose sign-in can no longer be refreshed ("auth_required": sign
 * in again), `code=offline` one whose token cannot be had this time ("token_unavailable"), and
 * `code=brief` one whose saved token has only a minute left, so the first request refreshes it. The
 * stand-in fails as Windlass does, by the kind of error the real commands make from Windlass's code: a
 * `SandboxUserError` for a sign-in that is missing (`signed_out`) or refused (`invalid_grant`), and a
 * `SignInRefreshError` with the code `network_error` for a sign-in service that cannot be reached.
 * Nothing here is told by the words of a message; the switches above are this layer's own.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StandInObjectStore } from "./bucket/stand-in.js";
import type { ListedModels } from "./account-models.js";
import { FIXTURES_DIR, backupConfig } from "./config.js";
import type { RepositoryCheck, SandboxProfile, SandboxProfileId, WindlassEvent } from "./contract.js";
import { definitionReads, isReservedServerName } from "./personal-servers.js";
import { WINDLASS_CONFIG_FILE } from "./windlass-config.js";
import {
	type AccessToken,
	type AccessTokens,
	type ChatgptAccount,
	type ChatgptLogins,
	type CreateSandboxInput,
	type ExecOptions,
	type ExecResult,
	type ListedSandbox,
	type RunTurnInput,
	type RunTurnResult,
	type SandboxHandle,
	type SandboxLayer,
	type Sandboxes,
	SandboxUserError,
	type ScriptedModel,
	type TurnAnswer,
	type TurnControl,
	type TurnQuestion,
	type TurnServer,
	type TurnServerQuestion,
	type Windlass,
	type WindlassFeatures,
} from "./sandbox/api.js";
import { BACKUP_ENV, SandboxSessionBackups } from "./sandbox/backup.js";
import { NOT_SIGNED_IN, SIGN_IN_EXPIRED, SIGN_IN_UNREACHABLE, SignInRefreshError, TOKEN_VALID_FOR_MS, outdatedWindlass, tokenSourceFailure } from "./sandbox/handoff.js";
import type { SignInCommands, TokenAnswer } from "./signin/commands.js";
import { actorSignIns, memorySignIns } from "./signin/facade.js";
import type { SignInMaterial } from "./signin/material.js";

const WORKSPACE = "/workspace";
const REDIRECT_PREFIX = "http://127.0.0.1:1455/auth/callback";
/** What the stand-in for `windlass --models` lists for every account: the efforts differ by model, as a plan's do. */
const FAKE_PLAN: ListedModels = {
	models: [
		{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
		{ id: "gpt-6-sol", name: null, efforts: ["low", "medium", "high"] },
		{ id: "gpt-6-luna", name: null, efforts: [] },
	],
	defaultModel: "gpt-6.1-sol",
};
const SLOW_CLONE_MS = 1_500;
const SLOW_STOP_MS = 800;

const PROFILES: SandboxProfile[] = [
	{
		id: "docker-windlass-sandbox",
		name: "Docker + Windlass sandbox",
		summary: "Fake layer: stands in for a container whose commands Windlass sandboxes again.",
		layers: ["In-memory sandbox (fake layer)", "Windlass's sandbox around each command (simulated)"],
		approval: "auto",
		commandNetwork: false,
		commandsCanReadAccessToken: false,
		available: true,
	},
	{
		id: "docker-hardened",
		name: "Docker, hardened",
		summary: "Fake layer: stands in for a container under Docker's default profiles.",
		layers: ["In-memory sandbox (fake layer)"],
		approval: "full",
		commandNetwork: true,
		commandsCanReadAccessToken: true,
		available: true,
	},
	...(["e2b", "e2b-open", "daytona", "firecracker", "agentos"] as const).map(
		(id): SandboxProfile => ({
			id,
			name: id,
			summary: "Not available in the fake layer.",
			layers: [id],
			approval: "auto",
			commandNetwork: true,
			commandsCanReadAccessToken: false,
			available: false,
			unavailableReason: "The fake sandbox layer only stands in for the two Docker profiles.",
		}),
	),
];

interface FakeSandbox {
	id: string;
	uid: string;
	sessionId: string;
	profile: SandboxProfileId;
	state: "running" | "paused";
	/** Files that differ from the last commit: path -> content. */
	files: Map<string, string>;
	/** The Windlass sessions on this sandbox's own disk, where sessions live in the sandbox. */
	windlass: Map<string, FakeSession>;
	/** The archive `backupStep` packed and has not uploaded yet. */
	packed: Buffer | null;
}

/** What the fake Windlass keeps of a session: enough to continue it, and to notice when it is gone. */
interface FakeSession {
	/** The last `seq` written, so a continued session keeps counting. */
	seq: number;
	turns: number;
	/** Bytes the session's data is larger by than the few it really has: "(big-memory)". */
	padding: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted || ms <= 0) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

function ok(stdout = ""): ExecResult {
	return { exitCode: 0, timedOut: false, aborted: false, stdout, stderr: "" };
}

class FakeHandle implements SandboxHandle {
	readonly cwd = WORKSPACE;

	constructor(
		readonly sandbox: FakeSandbox,
		private readonly exists: () => boolean,
		/** The stand-in for the bucket a signed link opens; null where the layer keeps no copies. */
		private readonly bucket: StandInObjectStore | null = null,
	) {}

	get id(): string {
		return this.sandbox.id;
	}

	get profile(): SandboxProfileId {
		return this.sandbox.profile;
	}

	async run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		await delay(/\bgit clone\b/.test(command) && command.includes("slow-clone") ? SLOW_CLONE_MS : 5, options.signal);
		if (options.signal?.aborted) return { exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "" };
		if (!this.exists()) throw new Error(`fake sandbox ${this.sandbox.id} does not exist`);
		const step = options.env?.[BACKUP_ENV.step];
		const result = step === undefined ? this.interpret(command) : this.backupStep(step, options.env ?? {}, options.stdin ?? "");
		if (result.stdout) options.onStdout?.(result.stdout);
		if (result.stderr) options.onStderr?.(result.stderr);
		return result;
	}

	/** Understands the few commands the platform runs; anything else succeeds with no output. */
	private interpret(command: string): ExecResult {
		const files = this.sandbox.files;
		if (/\bgit clone\b/.test(command)) {
			if (command.includes("fail-clone")) {
				return { exitCode: 128, timedOut: false, aborted: false, stdout: "", stderr: "fatal: repository 'https://example.com/fail-clone.git/' not found\n" };
			}
			return ok();
		}
		if (/\bstatus\b.*--porcelain/.test(command)) {
			const separator = /\s-z\b/.test(command) ? "\0" : "\n";
			return ok([...files.keys()].sort().map((path) => `?? ${path}${separator}`).join(""));
		}
		if (/\bdiff\b/.test(command)) {
			const parts = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => {
				const lines = content.replace(/\n$/, "").split("\n");
				return [
					`diff --git a/${path} b/${path}`,
					"new file mode 100644",
					"--- /dev/null",
					`+++ b/${path}`,
					`@@ -0,0 +1,${lines.length} @@`,
					...lines.map((line) => `+${line}`),
					"",
				].join("\n");
			});
			return ok(parts.join(""));
		}
		return ok();
	}

	/**
	 * A step of sandbox/backup.ts, played without a shell: the same environment in, the same one line
	 * out. The archive is the sandbox's Windlass sessions as a line of JSON, and after it as many bytes
	 * as the sessions are padded by.
	 */
	private backupStep(step: string, env: Record<string, string>, stdin: string): ExecResult {
		const sandbox = this.sandbox;
		const link = /^url = "(.*)"$/m.exec(stdin)?.[1] ?? "";
		const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
		if (step === "pack") {
			sandbox.packed = null;
			if (sandbox.windlass.size === 0) return ok("empty\n");
			const padding = [...sandbox.windlass.values()].reduce((sum, session) => sum + session.padding, 0);
			const size = Buffer.byteLength(JSON.stringify([...sandbox.windlass])) + 1 + padding;
			// As the script: an archive over the limit is not kept.
			if (size > Number(env[BACKUP_ENV.max])) return ok(`too_large ${size}\n`);
			sandbox.packed = Buffer.concat([Buffer.from(`${JSON.stringify([...sandbox.windlass])}\n`), Buffer.alloc(padding)]);
			return ok(`packed ${sandbox.packed.length} ${sha256(sandbox.packed)}\n`);
		}
		if (this.bucket === null) return ok("curl 6\n");
		if (step === "upload") {
			const packed = sandbox.packed;
			sandbox.packed = null;
			if (packed === null || String(packed.length) !== env[BACKUP_ENV.size]) return ok("changed\n");
			return ok(`http ${this.bucket.use(link, "PUT", packed).status}\n`);
		}
		if (step === "restore") {
			const fetched = this.bucket.use(link, "GET");
			if (fetched.status !== 200 || fetched.body === undefined) return ok(`http ${fetched.status}\n`);
			if (String(fetched.body.length) !== env[BACKUP_ENV.size]) return ok(`size ${fetched.body.length}\n`);
			if (sha256(fetched.body) !== env[BACKUP_ENV.sha256]) return ok(`hash ${sha256(fetched.body)}\n`);
			let sessions: Array<[string, FakeSession]>;
			try {
				const end = fetched.body.indexOf(0x0a);
				sessions = JSON.parse(fetched.body.subarray(0, end < 0 ? undefined : end).toString("utf8")) as Array<[string, FakeSession]>;
			} catch {
				return ok("unpack\n");
			}
			for (const [id, session] of sessions) sandbox.windlass.set(id, session);
			return ok(sandbox.windlass.has(env[BACKUP_ENV.session] ?? "") ? "restored\n" : "no_session\n");
		}
		return { exitCode: 2, timedOut: false, aborted: false, stdout: "", stderr: `unknown backup step: ${step}\n` };
	}

	async readTextFile(path: string): Promise<string> {
		const content = this.sandbox.files.get(path.replace(`${WORKSPACE}/`, ""));
		if (content === undefined) throw new Error(`no such file: ${path}`);
		return content;
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		this.sandbox.files.set(path.replace(`${WORKSPACE}/`, ""), content);
	}
}

class FakeSandboxes implements Sandboxes {
	readonly all = new Map<string, FakeSandbox>();
	/** As on Docker, the fake Windlass sessions are not tied to a sandbox; with a stand-in for the bucket they are, as on E2B. */
	readonly sessionsLiveInSandbox: boolean;
	/** Nothing stops a fake sandbox but the session that has it, and none is billed. */
	readonly idleStopMs = null;
	/** The Windlass sessions where they outlive sandboxes: all in one place, as on a volume. */
	private readonly shared = new Map<string, FakeSession>();
	/** The definitions of project servers Windlass was told to start, by where its data directory is. */
	private readonly approvals = new Map<string, Set<string>>();

	/** The approvals the Windlass in this sandbox remembers: its own where its data is in the sandbox, its user's where it is on a volume. */
	approvalsOf(id: string): Set<string> {
		const key = this.sessionsLiveInSandbox ? `sandbox:${id}` : `user:${this.all.get(id)?.uid ?? ""}`;
		const found = this.approvals.get(key) ?? new Set<string>();
		this.approvals.set(key, found);
		return found;
	}

	constructor(private readonly bucket: StandInObjectStore | null = null) {
		this.sessionsLiveInSandbox = bucket !== null;
	}

	/** Where the Windlass that runs in this sandbox keeps its sessions. */
	windlassOf(id: string): Map<string, FakeSession> {
		return this.sessionsLiveInSandbox ? (this.all.get(id)?.windlass ?? new Map()) : this.shared;
	}

	profiles(): SandboxProfile[] {
		return PROFILES;
	}

	profile(id: SandboxProfileId): SandboxProfile {
		const found = PROFILES.find((profile) => profile.id === id);
		if (!found) throw new Error(`unknown sandbox profile: ${id}`);
		return found;
	}

	async create(input: CreateSandboxInput): Promise<string> {
		if (!this.profile(input.profile).available) throw new Error(`sandbox profile ${input.profile} is not available`);
		await delay(20);
		const id = `fake-${randomBytes(6).toString("hex")}`;
		this.all.set(id, { id, uid: input.uid, sessionId: input.sessionId, profile: input.profile, state: "running", files: new Map(), windlass: new Map(), packed: null });
		return id;
	}

	async connect(id: string): Promise<SandboxHandle | undefined> {
		const sandbox = this.all.get(id);
		if (!sandbox) return undefined;
		sandbox.state = "running";
		return new FakeHandle(sandbox, () => this.all.has(id), this.bucket);
	}

	async state(id: string): Promise<"none" | "running" | "paused"> {
		return this.all.get(id)?.state ?? "none";
	}

	price(): null {
		return null;
	}

	async list(uid: string): Promise<ListedSandbox[]> {
		return [...this.all.values()].filter((sandbox) => sandbox.uid === uid).map((sandbox) => ({ id: sandbox.id, sessionId: sandbox.sessionId, state: sandbox.state }));
	}

	async suspend(id: string): Promise<void> {
		const sandbox = this.all.get(id);
		if (sandbox) sandbox.state = "paused";
	}

	async destroy(id: string): Promise<void> {
		this.all.delete(id);
	}
}

// ---------------------------------------------------------------------------------------------
// Windlass
// ---------------------------------------------------------------------------------------------

const fixtureCache = new Map<string, WindlassEvent[]>();

function fixture(name: string): WindlassEvent[] {
	let events = fixtureCache.get(name);
	if (!events) {
		events = readFileSync(join(FIXTURES_DIR, name), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as WindlassEvent);
		fixtureCache.set(name, events);
	}
	return events;
}

/** The words that choose a scenario; the real layer's demo scripts go by the same ones. */
const APPROVAL_WORDS = /\b(network|fetch|downloads?|curl|https?|headers?|websites?|urls?)\b/;
const LONG_WORDS = /\b(long|slow|build|progress|wait)\b/;

function fixtureFor(text: string, turn: number): string {
	if (text.includes("(auth-fail)")) return "demo-a-non-retryable-error-authentication.jsonl";
	if (LONG_WORDS.test(text)) return "demo-a-long-build-command.jsonl";
	if (/\b(tests?|failing|fix)\b/.test(text)) return "demo-find-and-fix-a-failing-test.jsonl";
	if (/\bparallel\b/.test(text)) return "demo-two-parallel-tool-calls.jsonl";
	if (/\b(checks?|verify)\b/.test(text)) return "demo-the-checks-fail-the-model-fixes-the-code-and-they-pass.jsonl";
	return turn % 2 === 1 ? "real-scripted-bwrap.jsonl" : "demo-several-steps-in-one-turn.jsonl";
}

function dataOf(event: WindlassEvent): Record<string, unknown> {
	return event.data ?? {};
}

/** A call's identity: providers reuse call ids, so the step's message id is part of it. */
function callKey(messageId: unknown, callId: unknown): string {
	return `${String(messageId)}/${String(callId)}`;
}

interface ApprovalScenario {
	/** The whole recording in which the user allowed the call. */
	approved: WindlassEvent[];
	/** What follows `approval.answered` in the recording in which they declined, in the ids of the other one. */
	deniedTail: WindlassEvent[];
}

let approvalCache: ApprovalScenario | null = null;

/**
 * The two recordings of the approval turn made into one scenario. Both were recorded with a second
 * message steered in; that message is left out here, since a replay is steered only when its caller
 * steers it. The recordings are the same script up to the question, so the declined one's ids can be
 * mapped onto the approved one's, event by event.
 */
function approvalScenario(): ApprovalScenario {
	if (approvalCache) return approvalCache;
	const withoutRecordedSteer = (events: WindlassEvent[]): WindlassEvent[] => {
		const enqueued = events.filter((event) => event.type === "inbox.enqueued");
		const steered = enqueued.length > 1 ? dataOf(enqueued[1]).messageId : undefined;
		return events.filter((event) => !((event.type === "inbox.enqueued" || event.type === "inbox.delivered") && dataOf(event).messageId === steered));
	};
	const approved = withoutRecordedSteer(fixture("acp-approval-approved.jsonl"));
	const denied = withoutRecordedSteer(fixture("acp-approval-denied.jsonl"));
	const asked = approved.findIndex((event) => event.type === "approval.requested");
	const askedDenied = denied.findIndex((event) => event.type === "approval.requested");
	const answeredDenied = denied.findIndex((event) => event.type === "approval.answered");
	if (asked < 0 || asked !== askedDenied || answeredDenied !== asked + 1) throw new Error("the approval fixtures do not line up");

	const ids = new Map<string, string>();
	for (let index = 0; index <= asked; index += 1) {
		for (const read of [(event: WindlassEvent) => dataOf(event).messageId, (event: WindlassEvent) => event.messageId, (event: WindlassEvent) => dataOf(event).executionId]) {
			const from = read(denied[index]);
			const to = read(approved[index]);
			if (typeof from === "string" && typeof to === "string" && from !== to) ids.set(from, to);
		}
	}
	const deniedTail = denied.slice(answeredDenied + 1).map((event) => {
		let text = JSON.stringify(event);
		for (const [from, to] of ids) text = text.split(from).join(to);
		return JSON.parse(text) as WindlassEvent;
	});
	approvalCache = { approved, deniedTail };
	return approvalCache;
}

function questionOf(event: WindlassEvent): TurnQuestion {
	const data = dataOf(event);
	const question = (data.question ?? {}) as { title?: unknown; subject?: unknown; details?: unknown; choices?: unknown };
	const choices = Array.isArray(question.choices) ? (question.choices as Array<Record<string, unknown>>) : [];
	return {
		messageId: String(data.messageId),
		callId: String(data.callId),
		title: String(question.title ?? ""),
		subject: String(question.subject ?? ""),
		details: Array.isArray(question.details) ? question.details.map(String) : [],
		choices: choices.map((choice) => ({
			id: String(choice.id),
			label: String(choice.label ?? choice.id),
			approve: choice.approve === true,
			remembers: typeof choice.remembers === "string" ? choice.remembers : null,
		})),
		subagent: null,
	};
}

const EXEC_FAIL_MESSAGE = "The model call failed 4 times: the provider answered 503 (fake layer).";

/** A server the project's configuration names in a turn of the fake layer. */
interface FakeServer {
	name: string;
	fingerprint: string;
	argv: string[] | null;
	url: string | null;
	unset: string[];
	/** Reported while the turn runs instead of before its prompt. */
	late: boolean;
	/** The definition it has changed to by the time the first approval arrives. */
	movedTo: FakeServer | null;
}

const SERVER_FILE = `${WORKSPACE}/.windlass/config.json`;

/** What the prompt's switches say the project names; the fingerprints stand for Windlass's hash of each definition. */
function fakeServers(text: string): FakeServer[] {
	const harbor = (fingerprint: string, extra: string[] = [], rest: Partial<FakeServer> = {}): FakeServer => ({
		name: "harbor",
		fingerprint,
		argv: ["python3", "tools/harbor_mcp.py", ...extra],
		url: null,
		unset: [],
		late: false,
		movedTo: null,
		...rest,
	});
	const servers: FakeServer[] = [];
	if (text.includes("(mcp)")) servers.push(harbor("81498df752b8ef7d"));
	if (text.includes("(mcp-changed)")) servers.push(harbor("5d0c2a7be1f94c36", ["--berths", "12"]));
	if (text.includes("(mcp-env)")) servers.push(harbor("748df09716dce52c", [], { unset: ["HARBOR_TOKEN"] }));
	if (text.includes("(mcp-moved)")) servers.push(harbor("2b9e0f6a4d7c8135", ["--port", "old"], { movedTo: harbor("9a3f5c1e7b2d4068", ["--port", "new"]) }));
	if (text.includes("(mcp-late)")) servers.push(harbor("3c7d9e1f5a2b4680", ["--tide"], { late: true }));
	if (text.includes("(mcp-remote)")) servers.push({ name: "docs", fingerprint: "e4d1a80c93f6b275", argv: null, url: "https://docs.example.com/mcp", unset: [], late: false, movedTo: null });
	return servers;
}

interface Usage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
}

/** The events that end a turn, and the outcome each one means. */
const TERMINAL = new Map([
	["execution.succeeded", "succeeded"],
	["execution.failed", "failed"],
	["execution.interrupted", "interrupted"],
]);

class FakeWindlass implements Windlass {
	constructor(
		private readonly sandboxes: FakeSandboxes,
		private readonly eventDelayMs: number,
		private readonly tokens: AccessTokens,
	) {}

	async version(): Promise<string | null> {
		return "0.1.0-fake";
	}

	async problem(): Promise<string | null> {
		return null;
	}

	async features(): Promise<WindlassFeatures> {
		return { sessionHome: true, envLists: true, requiredChecks: true };
	}

	demoScript(prompt: string, turn: number): ScriptedModel {
		return { responses: [[{ type: "text", text: `Fake reply ${turn} to: ${prompt.slice(0, 80)}` }, { type: "finish", reason: "stop" }]] };
	}

	async runTurn(sandbox: SandboxHandle, input: RunTurnInput): Promise<RunTurnResult> {
		const text = input.prompt.toLowerCase();
		if (text.includes("(throw)")) throw new Error("fake layer: docker exec failed: container is not running");
		if (!this.sandboxes.all.has(sandbox.id)) throw new Error(`fake sandbox ${sandbox.id} does not exist`);

		// Refusals Windlass makes before a turn exists: nothing is written, nothing is emitted.
		if (text.includes("(session-gone)")) {
			const id = input.windlassSessionId ?? "ses_fake0000000000000000";
			return { exitCode: 0, aborted: false, timedOut: false, windlassSessionId: null, summary: null, stderrTail: "", failure: { reason: "session_not_found", message: `Windlass has no session ${id}.` } };
		}
		if (text.includes("(session-busy)")) {
			const id = input.windlassSessionId ?? "ses_fake0000000000000000";
			return {
				exitCode: 0,
				aborted: false,
				timedOut: false,
				windlassSessionId: input.windlassSessionId ?? null,
				summary: null,
				stderrTail: "",
				failure: { reason: "session_in_use", message: `Session ${id} is open in another Windlass process (pid 4242). It can be continued once that process has closed it.` },
			};
		}

		const none = { exitCode: null, aborted: false, timedOut: false, windlassSessionId: null, summary: null, stderrTail: "" };
		if (text.includes("(old-windlass)")) return { ...none, failure: { reason: "windlass_outdated", message: outdatedWindlass("0.0.0-fake", "windlass-platform-sandbox:latest") } };
		// A turn that is not scripted runs on its user's sign-in: it is handed that user's access token before anything starts.
		if (input.script === undefined) {
			const uid = this.sandboxes.all.get(sandbox.id)?.uid ?? "";
			try {
				const token = await this.tokens.current(uid);
				console.log(`[wlp] token.handed sandbox=${sandbox.id} uid=${uid}: the turn was handed an access token that lasts ${Math.round((token.expiresAt - Date.now()) / 1000)} s more`);
			} catch (error) {
				return { ...none, failure: tokenSourceFailure(error) };
			}
		}

		const continued = input.windlassSessionId !== undefined;
		const sessionId = input.windlassSessionId ?? `ses_fake${randomBytes(8).toString("hex")}`;
		const sessions = this.sandboxes.windlassOf(sandbox.id);
		// Where sessions live in the sandbox, one it does not hold cannot be continued: Windlass's own refusal.
		if (continued && this.sandboxes.sessionsLiveInSandbox && !sessions.has(sessionId)) {
			return { exitCode: 0, aborted: false, timedOut: false, windlassSessionId: null, summary: null, stderrTail: "", failure: { reason: "session_not_found", message: `there is no session ${sessionId}` } };
		}
		const session: FakeSession = sessions.get(sessionId) ?? { seq: 0, turns: 0, padding: 0 };
		sessions.set(sessionId, session);
		session.turns += 1;
		const turn = session.turns;
		if (text.includes("(big-memory)")) session.padding += 2 * 1024 * 1024;
		const gap = this.eventDelayMs * (text.includes("(slow)") ? 20 : 1);
		const crashAfter = text.includes("(crash)") ? 6 : Number.POSITIVE_INFINITY;
		const execFailAfter = text.includes("(exec-fail)") ? 8 : Number.POSITIVE_INFINITY;
		const approval = !text.includes("(auth-fail)") && APPROVAL_WORDS.test(text) ? approvalScenario() : null;
		const signal = input.signal;
		const startedAt = Date.now();
		const handed = input.checks ?? [];

		let seq = session.seq;
		let emitted = 0;
		let ended = false;
		let promptSeen = false;
		let executionId: string | null = null;
		let currentStep: string | null = null;
		let outcome: string | null = null;
		let steps = 0;
		let requests = 0;
		let usage: Usage | null = null;
		let summary: WindlassEvent | null = null;
		/** Calls that started and have not settled, with what each has printed so far. */
		const running = new Map<string, string>();
		const cancelled = new Set<string>();
		/** Steered messages admitted and not yet delivered to the model. */
		const undelivered: string[] = [];
		let wake: (() => void) | null = null;

		const emit = (recorded: WindlassEvent): void => {
			const event: WindlassEvent = { ...recorded, sessionId };
			const durable = typeof recorded.seq === "number";
			if (durable) {
				seq += 1;
				event.seq = seq;
				event.time = Date.now();
			}
			const data = dataOf(event);
			switch (event.type) {
				case "inbox.enqueued":
					// The first one of a recording is the prompt; a steer writes its own.
					if (!promptSeen) {
						promptSeen = true;
						event.data = { ...data, content: [{ type: "text", text: input.prompt }] };
					}
					break;
				case "execution.started":
					if (typeof data.executionId === "string") executionId = data.executionId;
					break;
				case "step.started":
					requests += 1;
					currentStep = typeof data.messageId === "string" ? data.messageId : null;
					if (input.model) event.data = { ...data, model: input.model };
					break;
				case "step.ended": {
					steps += 1;
					const used = data.usage as Partial<Usage> | null | undefined;
					if (used && typeof used.inputTokens === "number") {
						usage = {
							inputTokens: (usage?.inputTokens ?? 0) + used.inputTokens,
							cachedInputTokens: (usage?.cachedInputTokens ?? 0) + (used.cachedInputTokens ?? 0),
							outputTokens: (usage?.outputTokens ?? 0) + (used.outputTokens ?? 0),
							reasoningTokens: (usage?.reasoningTokens ?? 0) + (used.reasoningTokens ?? 0),
						};
					}
					break;
				}
				case "step.failed":
					steps += 1;
					break;
				case "tool.started":
					running.set(callKey(data.messageId, data.callId), "");
					break;
				case "tool.progress": {
					const key = callKey(event.messageId, event.callId);
					if (running.has(key)) running.set(key, String(event.text ?? ""));
					break;
				}
				case "tool.settled":
					running.delete(callKey(data.messageId, data.callId));
					break;
				default:
					outcome = TERMINAL.get(event.type) ?? outcome;
					// Done with checks still failing is an outcome of its own, as the command line's summary has it.
					if (event.type === "execution.succeeded" && (data.verification as { status?: unknown } | undefined)?.status === "unresolved") outcome = "unresolved";
			}
			emitted += 1;
			input.onEvent(event);
		};

		/** How the turn ended, once an event has said so. */
		const finished = (): string | null => outcome;

		/** The event the layer makes itself after Windlass's last one: what `windlass --json` printed as `cli.summary`. */
		const summarize = (): void => {
			const total = usage as Usage | null;
			summary = {
				type: "cli.summary",
				sessionId,
				executionId,
				outcome: outcome ?? "interrupted",
				steps,
				requests,
				durationMs: Date.now() - startedAt,
				usage: total,
				cachedShare: total && total.inputTokens > 0 ? Math.round((total.cachedInputTokens / total.inputTokens) * 1000) / 1000 : null,
			};
			input.onEvent(summary);
		};

		/** Waits between two events; a stop of the turn or of a call ends the wait early. */
		const pause = (ms: number): Promise<void> =>
			new Promise((resolve) => {
				if (signal?.aborted || ms <= 0) {
					resolve();
					return;
				}
				const finish = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", finish);
					if (wake === finish) wake = null;
					resolve();
				};
				const timer = setTimeout(finish, ms);
				signal?.addEventListener("abort", finish, { once: true });
				wake = finish;
			});

		const deliverSteers = (): void => {
			for (const messageId of undelivered.splice(0)) emit({ type: "inbox.delivered", v: 1, data: { messageId }, seq: 0, time: 0 });
		};

		const control: TurnControl = {
			steer: async (message: string): Promise<void> => {
				if (ended || signal?.aborted) throw new Error("the turn has ended");
				const messageId = `msg_${randomBytes(12).toString("hex")}`;
				emit({ type: "inbox.enqueued", v: 1, data: { messageId, origin: null, delivery: "steer", content: [{ type: "text", text: message }] }, seq: 0, time: 0 });
				undelivered.push(messageId);
			},
			cancelCall: async (messageId: string, callId: string): Promise<{ stopped: boolean; message: string | null }> => {
				if (ended) throw new Error("the turn has ended");
				const key = callKey(messageId, callId);
				if (!running.has(key)) return { stopped: false, message: "That call is not running, so there is nothing to stop." };
				if (cancelled.has(key)) return { stopped: false, message: "That call was already asked to stop." };
				cancelled.add(key);
				emit({ type: "tool.cancel_requested", v: 1, data: { messageId, callId }, seq: 0, time: 0 });
				wake?.();
				return { stopped: true, message: null };
			},
		};

		/**
		 * Puts the question of an `approval.requested` to the caller and returns the events that follow
		 * the answer, or null when the question was withdrawn because the turn was stopped.
		 */
		const ask = async (requested: WindlassEvent, rest: WindlassEvent[], scenario: ApprovalScenario): Promise<WindlassEvent[] | null> => {
			const question = questionOf(requested);
			const { messageId, callId } = question;
			const declined = (output: string): WindlassEvent[] =>
				scenario.deniedTail.map((event) => (event.type === "tool.settled" && dataOf(event).callId === callId ? { ...event, data: { ...dataOf(event), output } } : event));

			if (!input.onQuestion) {
				const data = dataOf(requested);
				emit({ type: "approval.denied", v: 1, data: { messageId, callId, mode: data.mode, paths: data.paths, escalation: data.escalation, reason: "unattended", needs: data.needs, stop: false }, seq: 0, time: 0 });
				return declined("Not run: this call needs the user's approval for network access, and this run has no one to approve it.");
			}

			emit(requested);
			const asking = new AbortController();
			let answer: TurnAnswer | null = null;
			const how = await new Promise<"answered" | "declined" | "withdrawn">((resolve) => {
				if (signal?.aborted) {
					resolve("withdrawn");
					return;
				}
				const withdrawn = () => resolve("withdrawn");
				signal?.addEventListener("abort", withdrawn, { once: true });
				const settle = (result: "answered" | "declined") => {
					signal?.removeEventListener("abort", withdrawn);
					resolve(result);
				};
				let promise: Promise<TurnAnswer>;
				try {
					promise = input.onQuestion!(question, asking.signal);
				} catch {
					settle("declined");
					return;
				}
				promise.then(
					(value) => {
						answer = value;
						settle("answered");
					},
					() => settle("declined"),
				);
			});
			if (how === "withdrawn") {
				asking.abort();
				return null;
			}

			const given = answer as TurnAnswer | null;
			// An option the question does not have declines, as does a promise that rejected.
			const choice = how === "answered" && given ? question.choices.find((candidate) => candidate.id === given.choice) : undefined;
			const note = choice && typeof given?.note === "string" && given.note !== "" ? given.note : null;
			const approve = choice?.approve === true;
			emit({ type: "approval.answered", v: 1, data: { messageId, callId, choice: choice?.id ?? "deny", approve, note, grants: [] }, seq: 0, time: 0 });
			if (approve) return rest.filter((event) => event.type !== "approval.answered");
			return declined(`Not run: the user declined this call.${note ? ` Their note: ${note}` : ""}`);
		};

		/** The questions about servers that are open: withdrawn when the turn is stopped, and when it ends. */
		const serverQuestions = new Set<AbortController>();
		/**
		 * Puts the question about one server, unless Windlass remembers an approval of exactly this
		 * definition, and plays what Windlass makes of a yes.
		 */
		/** The project's servers as this turn's Windlass has them, by name: what `onServers` is told. */
		const told = new Map<string, TurnServer>();
		const say = (): void => {
			try {
				input.onServers?.([...told.values()]);
			} catch {
				// A listener's failure must not stop the turn.
			}
		};
		/** What Windlass says of a server: that it waits, or what became of one it may start. */
		const describe = (server: FakeServer, waits: boolean): void => {
			const state: TurnServer["state"] = waits ? "waiting" : server.unset.length > 0 ? "failed" : "running";
			told.set(server.name, {
				name: server.name,
				origin: "project",
				state,
				argv: server.argv,
				url: server.url,
				file: SERVER_FILE,
				tools: state === "running" ? 2 : null,
				error: state === "failed" ? `the environment variable ${server.unset[0]} named in its env is not set` : null,
				fingerprint: waits ? server.fingerprint : null,
			});
		};
		const keyOf = (server: FakeServer) => `${server.name}:${server.fingerprint}`;
		const askServer = async (server: FakeServer, holdsTurn: boolean): Promise<void> => {
			const approved = this.sandboxes.approvalsOf(sandbox.id);
			const key = keyOf(server);
			// Windlass's own record starts the server, and nobody is asked.
			describe(server, !approved.has(key));
			say();
			if (approved.has(key)) return;
			if (!input.onServerQuestion || signal?.aborted || ended) return;
			const question: TurnServerQuestion = { name: server.name, fingerprint: server.fingerprint, argv: server.argv, url: server.url, file: SERVER_FILE, unset: server.unset, holdsTurn };
			const asking = new AbortController();
			const withdrawn = new Promise<null>((resolve) => asking.signal.addEventListener("abort", () => resolve(null), { once: true }));
			const stop = () => asking.abort();
			signal?.addEventListener("abort", stop, { once: true });
			serverQuestions.add(asking);
			try {
				const start = await Promise.race([
					Promise.resolve()
						.then(() => input.onServerQuestion!(question, asking.signal))
						.catch(() => false),
					withdrawn,
				]);
				if (asking.signal.aborted || start !== true) return;
				if (server.movedTo) {
					input.onServerApproved?.(question, { state: "changed" });
					await askServer(server.movedTo, holdsTurn);
					return;
				}
				approved.add(key);
				describe(server, false);
				say();
				input.onServerApproved?.(question, server.unset.length > 0 ? { state: "failed", reason: `the environment variable ${server.unset[0]} named in its env is not set` } : { state: "running", tools: 2 });
			} finally {
				signal?.removeEventListener("abort", stop);
				serverQuestions.delete(asking);
			}
		};
		const servers = fakeServers(text);
		let lateAsked = false;

		try {
			// The user's own servers start without a question, as with a real Windlass: one whose definition reads a
			// variable the turn was not handed does not start, and a name the project has too is the project's.
			for (const own of input.servers ?? []) {
				if (isReservedServerName(own.name) || own.definition.enabled === false || servers.some((server) => server.name === own.name)) continue;
				const argv = typeof own.definition.command === "string" ? [own.definition.command, ...(Array.isArray(own.definition.args) ? own.definition.args.map(String) : [])] : null;
				const unset = definitionReads(own.definition).find((name) => !(name in (input.secrets?.env ?? {})));
				told.set(own.name, {
					name: own.name,
					origin: "user",
					state: unset === undefined ? "running" : "failed",
					argv,
					url: argv === null ? String(own.definition.url ?? "") : null,
					file: WINDLASS_CONFIG_FILE,
					tools: unset === undefined ? 1 : null,
					error: unset === undefined ? null : `the environment variable ${unset} named in its ${argv === null ? "headers" : "env"} is not set`,
					fingerprint: null,
				});
			}
			// What the project names is said in one answer, as Windlass gives it: also that it names nothing.
			for (const server of servers) if (!server.late) describe(server, !this.sandboxes.approvalsOf(sandbox.id).has(keyOf(server)));
			say();
			// What waits is asked about before Windlass gets the prompt: nothing of the turn has happened yet.
			for (const server of servers) if (!server.late) await askServer(server, true);
			if (signal?.aborted) return { exitCode: null, aborted: true, timedOut: false, windlassSessionId: continued ? sessionId : null, summary: null, stderrTail: "", failure: null };

			input.onControl?.(control);
			let queue = [...(approval ? approval.approved : fixture(fixtureFor(text, turn)))];
			while (queue.length > 0) {
				let recorded = queue.shift() as WindlassEvent;
				// The recordings made with `windlass --json` end with the command line's own summary line.
				if (recorded.type === "cli.summary") continue;
				// The checks the turn was handed, as Windlass would run them before it lets the turn end: one run, and the gate's verdict on it.
				if (recorded.type === "execution.succeeded" && handed.length > 0) {
					const evidence = { run: 1, afterSeq: seq, changedFiles: [`notes/turn-${turn}.md`], checks: handed.map((check) => fakeCheck(check)) };
					const failing = evidence.checks.filter((check) => check.status !== "passed").map((check) => check.name);
					emit({ type: "checks.started", v: 1, data: { run: 1, checks: handed.map((check) => check.name) }, seq: 0, time: 0 });
					emit({ type: "checks.finished", v: 1, data: { run: 1, evidence }, seq: 0, time: 0 });
					const verification = failing.length === 0 ? { status: "passed", evidence } : { status: "unresolved", reason: "max_rounds", failing, acknowledgement: null, evidence };
					recorded = { ...recorded, data: { ...dataOf(recorded), verification } };
				}
				if (continued && (recorded.type === "session.created" || recorded.type === "baseline.set")) continue;
				if (signal?.aborted) break;
				if (emitted >= crashAfter) {
					return {
						exitCode: 1,
						aborted: false,
						timedOut: false,
						windlassSessionId: sessionId,
						summary: null,
						stderrTail: "windlass: fatal: simulated crash (fake layer)\n",
						failure: { reason: "engine", message: "Windlass stopped before the turn was finished (exit code 1)." },
					};
				}
				if (emitted >= execFailAfter && recorded.type !== "step.failed" && !TERMINAL.has(recorded.type)) {
					const error = { kind: "provider", error: { kind: "server", retryable: true, message: "The provider answered 503.", status: 503, code: null, retryAfterMs: null, requestId: null } };
					queue = [
						{ type: "step.failed", v: 1, data: { messageId: currentStep, error, usage: null }, seq: 0, time: 0 },
						{ type: "execution.failed", v: 1, data: { executionId, message: EXEC_FAIL_MESSAGE }, seq: 0, time: 0 },
					];
					continue;
				}

				// A steered message reaches the model at the next step, or just before the turn would end.
				if (recorded.type === "step.started" || TERMINAL.has(recorded.type)) deliverSteers();

				// A server Windlass reports while the turn runs: its question does not hold the turn.
				if (recorded.type === "step.started" && !lateAsked) {
					lateAsked = true;
					for (const server of servers) if (server.late) void askServer(server, false);
				}

				if (recorded.type === "tool.progress" && cancelled.has(callKey(recorded.messageId, recorded.callId))) continue;
				if (recorded.type === "tool.settled" && cancelled.has(callKey(dataOf(recorded).messageId, dataOf(recorded).callId))) {
					const data = dataOf(recorded);
					const printed = running.get(callKey(data.messageId, data.callId)) ?? "";
					const display = typeof data.display === "object" && data.display !== null ? { ...data.display, exitCode: null, signal: "SIGTERM", interrupted: "call" } : data.display;
					emit({ ...recorded, data: { ...data, outcome: "error", output: `${printed}${printed ? "\n" : ""}[Stopped by the user. The command had not finished.]`, display } });
					await pause(gap);
					continue;
				}

				if (recorded.type === "approval.requested" && approval) {
					const next = await ask(recorded, queue, approval);
					if (next === null) break;
					queue = [...next];
					await pause(gap);
					continue;
				}

				emit(recorded);
				await pause(gap);
			}

			// A stop that arrives after Windlass's last event has nothing left to interrupt.
			if (signal?.aborted && finished() === null) {
				if (text.includes("(slow-stop)")) await delay(SLOW_STOP_MS);
				emit({ type: "execution.interrupt_requested", v: 1, data: { reason: "user" }, seq: 0, time: 0 });
				emit({ type: "execution.interrupted", v: 1, data: { reason: "user" }, seq: 0, time: 0 });
				summarize();
				return { exitCode: 130, aborted: true, timedOut: false, windlassSessionId: sessionId, summary, stderrTail: "", failure: null };
			}
			summarize();

			const files = this.sandboxes.all.get(sandbox.id)?.files;
			files?.set(`notes/turn-${turn}.md`, `# Turn ${turn}\n\n${input.prompt.slice(0, 200)}\n`);
			if (turn === 1) files?.set("made.txt", "hello\n");
			if (text.includes("(lose-sandbox)")) this.sandboxes.all.delete(sandbox.id);

			let failure: RunTurnResult["failure"] = null;
			if (text.includes("(auth-fail)")) failure = { reason: "auth_required", message: "Signed out: sign in again to continue." };
			else if (finished() === "failed") failure = { reason: "execution_failed", message: EXEC_FAIL_MESSAGE };
			return { exitCode: 0, aborted: false, timedOut: false, windlassSessionId: sessionId, summary, stderrTail: "", failure, checks: { required: true, handed: true, project: null } };
		} finally {
			ended = true;
			session.seq = seq;
			for (const asking of serverQuestions) asking.abort();
		}
	}
}

/** A check as the fake Windlass "ran" it: one whose command has the word "fail" in it fails with exit code 1, any other passes. */
function fakeCheck(check: RepositoryCheck): Record<string, unknown> {
	const fails = /\bfail/.test(check.command);
	const printed = fails ? `${check.name}: 1 failed\n` : `${check.name}: ok\n`;
	// As a Windlass with required checks records one the client named: whose it is, and the end of the output of one that failed or whose entry asks.
	const outputTail = fails || check.showOutput === true ? { text: printed, truncated: false } : null;
	return { name: check.name, command: check.command, status: fails ? "failed" : "passed", exitCode: fails ? 1 : 0, signal: null, durationMs: 40, files: [], fingerprint: "fake", reusedFromSeq: null, outputPath: null, outputBytes: printed.length, outputLines: 1, origin: "session", required: true, outputTail };
}

// ---------------------------------------------------------------------------------------------
// Sign-in and access tokens: Windlass's sign-in commands, stood in for
// ---------------------------------------------------------------------------------------------

/** What the stand-in keeps in a sign-in's `auth.json`: the fields the platform reads, and tokens that are obviously not real. */
interface FakeCredentials {
	account: { sub: string; email: string };
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

/**
 * Windlass's sign-in commands without Windlass (signin/commands.ts has the real ones): the same steps
 * over the same kind of material, so everything above them runs as it does for real, sealing, the
 * actors' storage and the one-request-at-a-time token source included. `token` answers as
 * `windlass login token --valid-for 20m` does: the saved token while that has twenty minutes left
 * (`TOKEN_VALID_FOR_MS`), and otherwise a new one that lasts an hour, with a new refresh token, which
 * is a changed `auth.json` for the caller to save. `models` lists the same plan for every account.
 */
class FakeSignInCommands implements SignInCommands {
	/** How many times the (imaginary) `windlass login token --json --valid-for 20m` ran. */
	asked = 0;
	private issued = 0;

	async start(): Promise<{ url: string; redirectPrefix: string; material: SignInMaterial }> {
		const state = randomBytes(8).toString("hex");
		return { url: `https://auth.openai.com/oauth/authorize?fake=1&state=${state}`, redirectPrefix: REDIRECT_PREFIX, material: { files: { "auth-pending.json": JSON.stringify({ fake: true, state }) } } };
	}

	async finish(material: SignInMaterial, pastedUrl: string): Promise<{ account: ChatgptAccount; material: SignInMaterial }> {
		if (material.files["auth-pending.json"] === undefined) throw new SandboxUserError("This sign-in attempt is not known. Start again.");
		if (!pastedUrl.startsWith(REDIRECT_PREFIX)) {
			throw new SandboxUserError(`That is not the address the sign-in ends on. It starts with ${REDIRECT_PREFIX}`);
		}
		let code: string | null = null;
		try {
			code = new URL(pastedUrl).searchParams.get("code");
		} catch {
			code = null;
		}
		if (!code) throw new SandboxUserError("The address has no sign-in code in it. Copy the whole address.");
		if (code === "refused") throw new SandboxUserError("OpenAI refused the sign-in. Start again.");
		if (code === "explode") throw new Error("fake layer: docker run failed with /var/run/docker.sock: permission denied");
		const saved = this.issue({ sub: `fake|${code}`, email: `${code}@example.com` }, code === "brief" ? 60_000 : 60 * 60 * 1000);
		return { account: { ...saved.account, accessExpiresAt: saved.expiresAt }, material: { files: { "auth.json": JSON.stringify(saved) } } };
	}

	async token(material: SignInMaterial): Promise<TokenAnswer> {
		const text = material.files["auth.json"];
		if (text === undefined) return { ok: false, material, error: new SandboxUserError(NOT_SIGNED_IN) };
		this.asked += 1;
		await delay(10);
		const saved = JSON.parse(text) as FakeCredentials;
		if (saved.account.sub === "fake|expired") return { ok: false, material, error: new SandboxUserError(SIGN_IN_EXPIRED) };
		// As the real commands word Windlass's `network_error`: its sentence, which names the host and the reason.
		if (saved.account.sub === "fake|offline") return { ok: false, material, error: new SignInRefreshError("could not reach the sign-in service at auth.openai.com: the fake layer has no network", SIGN_IN_UNREACHABLE) };
		if (saved.expiresAt - Date.now() > TOKEN_VALID_FOR_MS) return { ok: true, material, token: { accessToken: saved.accessToken, expiresAt: saved.expiresAt }, shorter: false };
		// A refresh: the sign-in comes back with another refresh token, and has to be saved.
		const next = this.issue(saved.account, 60 * 60 * 1000);
		return { ok: true, material: { files: { ...material.files, "auth.json": JSON.stringify(next) } }, token: { accessToken: next.accessToken, expiresAt: next.expiresAt }, shorter: false };
	}

	async models(): Promise<ListedModels> {
		await delay(10);
		return structuredClone(FAKE_PLAN);
	}

	private issue(account: FakeCredentials["account"], lastsMs: number): FakeCredentials {
		const number = (this.issued += 1);
		return { account, accessToken: `FAKE-ACCESS-TOKEN-${number}-not-a-real-token`, refreshToken: `FAKE-REFRESH-TOKEN-${number}-not-a-real-token`, expiresAt: Date.now() + lastsMs };
	}
}

/** The stand-in for Windlass's sign-in commands: what the server's sign-in machinery runs with WLP_SANDBOX=fake (signin/index.ts). */
export function createFakeSignInCommands(): SignInCommands {
	return new FakeSignInCommands();
}

/**
 * `signIns: "memory"` keeps the users' sign-ins in this process instead of in the server's actors: for
 * a check that uses the layer by itself, with no server beside it.
 */
export function createFakeSandboxLayer(options: { signIns?: "actors" | "memory" } = {}): SandboxLayer {
	const raw = Number.parseInt(process.env.WLP_FAKE_DELAY_MS ?? "", 10);
	const eventDelayMs = Number.isFinite(raw) && raw >= 0 ? raw : 15;
	// A directory that stands in for the bucket: Windlass's sessions then live in the sandboxes, and are copied there.
	const backupDir = (process.env.WLP_FAKE_BACKUP_DIR ?? "").trim();
	const bucket = backupDir === "" ? null : new StandInObjectStore({ dir: backupDir });
	const sandboxes = new FakeSandboxes(bucket);
	// The sign-in steps and the token source are the real ones, over the stand-in for Windlass above.
	const { logins, tokens } = options.signIns === "memory" ? memorySignIns({ commands: createFakeSignInCommands(), rows: new Map() }) : actorSignIns();
	return { sandboxes, windlass: new FakeWindlass(sandboxes, eventDelayMs, tokens), logins, tokens, backups: bucket === null ? null : new SandboxSessionBackups(bucket, { maxBytes: backupConfig().maxBytes }) };
}
