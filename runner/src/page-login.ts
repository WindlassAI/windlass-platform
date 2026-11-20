import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CLAUDE_LOGIN_MS, authorizeUrl, type LoginCommand, type LoginResult } from "../../server/src/runner/protocol.js";
import { docker, LABEL } from "../../server/src/sandbox/docker.js";
import { setupCli, setupFlags, storeClaudeLogin } from "./harness-login.js";
import { harnessImage, type MachineDocker } from "./policy.js";
import { RunnerError } from "./state.js";

const failed = () => new RunnerError("Claude Code sign-in did not finish. Start again and paste the code from Anthropic.");
const stepMs = 20_000;
export const pageLoginLabel = LABEL + ".claude-login=1";

// The CLI needs a terminal even on a runner with no controlling tty. Give only the CLI a PTY,
// wide enough for an unwrapped token. script writes no transcript. The in-container deadline
// also applies if the runner process disappears while waiting for the owner.
class Setup {
	readonly expiresAt = Date.now() + CLAUDE_LOGIN_MS;
	private readonly abortController = new AbortController();
	private readonly container: Promise<string>;
	private child?: ChildProcessWithoutNullStreams;
	private exit?: Promise<number | null>;
	private transcript = "";
	ready = false;
	finishing = false;
	storing?: Promise<void>;
	private closing?: Promise<void>;
	private timer: NodeJS.Timeout;

	constructor(machine: MachineDocker, readonly ended: () => void) {
		this.timer = setTimeout(ended, CLAUDE_LOGIN_MS);
		this.container = docker(["create", "--rm", "-i", "--name", "wlp-claude-login-" + machine.identity.machineId,
			"--label", pageLoginLabel, ...setupFlags(machine), harnessImage("claude")!,
			"timeout", "-k", "5", String(CLAUDE_LOGIN_MS / 1000), "script", "-qef", "--echo", "never", "-c",
			"stty cols 1024 rows 35; exec " + setupCli + " --cli setup-token", "/dev/null"], { timeoutMs: stepMs })
			.then(r => {
				if (r.code !== 0 || !/^[0-9a-f]{64}$/.test(r.stdout.trim())) throw failed();
				return r.stdout.trim();
			});
	}

	async start() {
		const id = await this.container;
		this.abortController.signal.throwIfAborted();
		const child = this.child = spawn("docker", ["start", "-ai", id], { stdio: ["pipe", "pipe", "pipe"] });
		child.stderr.resume(); // Docker diagnostics and setup output are private, including on failure.
		child.stdin.on("error", () => this.ended());
		this.exit = new Promise(resolve => {
			child.once("error", () => resolve(null));
			child.once("close", resolve);
		});
		return new Promise<{ url: string; expiresAt: number }>((resolve, reject) => {
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (this.abortController.signal.aborted || (this.ready && !this.finishing)) return;
				if (this.transcript.length + chunk.length > 256 * 1024) { this.ended(); return; }
				this.transcript += chunk;
				if (this.ready) return;
				// Accept only a complete URL. A chunk boundary can fall anywhere inside its query.
				// The pinned CLI's OSC 8 link ends in BEL or ST; its plain-text form ends in whitespace.
				const url = /https:\/\/[^\s\x00-\x1f\x7f]+(?=[\s\x00-\x1f\x7f])/g;
				for (const [link] of this.transcript.matchAll(url)) {
					if (!authorizeUrl(link)) continue;
					this.ready = true;
					this.transcript = "";
					resolve({ url: link, expiresAt: this.expiresAt });
					break;
				}
			});
			void this.exit!.then(() => {
				reject(failed());
				if (!this.finishing) this.ended();
			});
		});
	}

	async finish(machine: MachineDocker, code: string) {
		if (!this.ready || this.finishing || Date.now() >= this.expiresAt || this.abortController.signal.aborted) throw failed();
		this.finishing = true;
		this.transcript = "";
		// Bracketed paste is a single input to the CLI; Enter submits it. Neither goes in argv.
		this.child!.stdin.write("\x1b[200~" + code + "\x1b[201~\r");
		if (await this.exit !== 0) throw failed();
		this.abortController.signal.throwIfAborted();
		// Read the complete output after successful exit. Never accept a truncated or ambiguous match.
		const tokens = new Set(this.transcript.match(/sk-ant-oat01-[A-Za-z0-9_-]+/g));
		const [token] = tokens;
		if (tokens.size !== 1 || !token || token.length > 512) throw failed();
		this.storing = storeClaudeLogin(machine, token, this.abortController.signal);
		await this.storing;
		return { signedIn: true } as const;
	}

	close() {
		this.abortController.abort();
		clearTimeout(this.timer);
		this.transcript = "";
		return this.closing ??= (async () => {
			const id = await this.container.catch(() => null);
			await this.storing?.catch(() => {});
			if (!id) return;
			try {
				let removed = await docker(["rm", "-f", id], { timeoutMs: stepMs });
				// --rm can win the race with explicit cancellation. Wait for that removal too.
				if (removed.code !== 0 && /removal.*in progress/i.test(removed.stderr))
					removed = await docker(["wait", "--condition", "removed", id], { timeoutMs: stepMs });
				if (removed.code !== 0 && !/No such (container|object)/i.test(removed.stderr))
					throw new RunnerError("Could not remove the Claude setup container.");
			} finally {
				this.child?.stdin.destroy();
				if (this.child?.exitCode === null && !this.child.signalCode) this.child.kill("SIGKILL");
			}
		})();
	}
}

// One slot per authenticated control connection. Reserve it before awaiting Docker and keep it
// until removal completes. A reconnect or re-pair closes the old slot before accepting new work.
export class PageLogin {
	private pending?: Setup;
	constructor(private machine: MachineDocker & { claude: boolean }) {}

	async close(setup = this.pending) {
		if (!setup) return;
		try { await setup.close(); }
		finally { if (setup === this.pending) this.pending = undefined; }
	}

	async request(command: LoginCommand): Promise<LoginResult> {
		if (!this.machine.claude) throw new RunnerError("Start the runner with --harness claude to sign in on this machine.");
		let setup = this.pending;
		if (command.kind === "harnessLogin.cancel") {
			if (setup?.storing) throw new RunnerError("The approved sign-in is already being stored on the machine.");
			await this.close();
			return { cancelled: true };
		}
		if (command.kind === "harnessLogin.start") {
			if (setup) throw new RunnerError("A Claude Code sign-in is already pending on this machine.");
			const fresh: Setup = new Setup(this.machine, () => { void this.close(fresh).catch(() => {}); });
			this.pending = setup = fresh;
		} else if (!setup || setup.finishing || !setup.ready) {
			throw new RunnerError("No Claude Code sign-in is waiting for a code. Start again.");
		}
		const current = setup;
		const timer = setTimeout(() => { void this.close(current).catch(() => {}); }, stepMs);
		try {
			if (command.kind === "harnessLogin.finish") {
				const result = await current.finish(this.machine, command.code);
				await this.close(current);
				return result;
			}
			return await current.start();
		} catch (error) {
			await this.close(current);
			throw error instanceof RunnerError ? error : failed();
		} finally { clearTimeout(timer); }
	}
}
