import { StringDecoder } from "node:string_decoder";
import type { Process, PtyHandle } from "@daytona/sdk";
import { HostedGuest, META, type GuestCommand } from "../e2b/sandboxes.js";
import { DATA_DIR, randomId } from "../provider.js";
import { tokenFilePath, tokenFilePaths } from "../token-file.js";
import type { HostedSize } from "../../contract.js";
import type { E2bCommandOptions } from "../e2b/client.js";
import { within } from "../command.js";
import type { DaytonaSettings } from "./config.js";
import type { Machine } from "./provider.js";

export type OpenPty = (
	options: NonNullable<Parameters<Process["createPty"]>[0]>,
) => Promise<Pick<PtyHandle, "wait" | "sendInput" | "kill" | "disconnect">>;

export class DaytonaGuest extends HostedGuest {
	constructor(
		private readonly vm: Machine,
		size: HostedSize,
		settings: DaytonaSettings,
	) {
		super(vm.id, vm.labels[META.uid]!, "daytona", "full", settings, vm.labels[META.session]);
		this.size = size;
		this.image = vm.snapshot;
		this.heartbeatMs = Math.floor(settings.idleTimeoutMs / 3);
	}
	private readonly heartbeatMs: number;

	protected holdLongCommand() {
		const timer = setInterval(() => {
			void this.vm.refreshActivity().catch(() => console.warn(`[wlp] daytona.activity_failed id=${this.id}`));
		}, this.heartbeatMs);
		timer.unref();
		return async () => {
			clearInterval(timer);
		};
	}
	async holdForTurn() {
		await this.vm.refreshActivity();
		return this.holdLongCommand();
	}

	protected async startCommand(command: string, options: E2bCommandOptions): Promise<GuestCommand> {
		if (options.root) throw new Error("Daytona session commands require an unprivileged user");
		const user = options.gitUser ? "nobody" : "agent";
		const stdout = new StringDecoder("utf8"),
			stderr = new StringDecoder("utf8");
		let buffer = "",
			ready = false;
		let exitCode: number | undefined, failure: Error | undefined;
		let started!: () => void;
		const handshake = new Promise<void>(resolve => {
			started = resolve;
		});
		const pty = await this.vm.process.createPty({
			id: "wlp-" + randomId(),
			cwd: "/",
			onData(chunk) {
				buffer += Buffer.from(chunk).toString("ascii");
				let end: number;
				while ((end = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					if (!ready) {
						if (line === "wlp-ready") {
							ready = true;
							started();
						}
						continue;
					}
					try {
						const [kind, value] = JSON.parse(line);
						if (kind === "out") options.onStdout?.(stdout.write(Buffer.from(value, "base64")));
						else if (kind === "err") options.onStderr?.(stderr.write(Buffer.from(value, "base64")));
						else if (kind === "exit" && Number.isInteger(value)) exitCode = value;
						else throw new Error("Daytona guest process failed: " + kind);
					} catch (error) {
						failure = error instanceof Error ? error : new Error("Invalid Daytona guest output");
					}
				}
			},
		});
		const done = pty.wait().then(() => {
			options.onStdout?.(stdout.end());
			options.onStderr?.(stderr.end());
			if (failure) throw failure;
			if (exitCode === undefined) throw new Error("Daytona guest disconnected before reporting exit");
			return exitCode < 0 ? { exitCode, error: "signal: " + -exitCode } : { exitCode };
		});
		void done.catch(() => {});
		const send = (frame: unknown) => pty.sendInput(JSON.stringify(frame) + "\n");
		try {
			await pty.sendInput(
				`exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 /usr/bin/sudo -n -H -u ${user} -- /usr/bin/setpriv --no-new-privs /usr/bin/python3 -I /usr/local/lib/wlp-daytona-process.py\n`,
			);
			if (!(await within(Promise.race([handshake, done]), 10_000)))
				throw new Error("Daytona guest launcher did not answer");
			await send({ command, cwd: options.cwd, env: options.envs ?? {} });
			if (!options.stdin) await send(null);
		} catch (error) {
			await pty.kill().catch(() => {});
			throw error;
		}
		return {
			sendStdin: data => send([Buffer.from(data).toString("base64")]),
			closeStdin: () => send(null),
			wait: () => done,
			disconnect: () => pty.disconnect(),
			kill: () => send("kill"),
		};
	}

	async clearTokenFiles() {
		const result = await this.ask(["rm", "-f", "--", ...tokenFilePaths(tokenFilePath(this.id, DATA_DIR))]);
		if (result?.code !== 0) throw new Error("Could not clear the turn's relay files");
	}

	// The toolbox file API runs as the launcher. Guest file access uses the agent uid.
	async readTextFile(path: string) {
		const result = await this.plain(["cat", "--", path], { timeoutMs: 60_000 });
		if (result.code !== 0) throw new Error(`cannot read ${path}: ${result.stderr.trim()}`);
		return result.stdout;
	}
	async writeTextFile(path: string, content: string) {
		const result = await this.plain(["sh", "-ec", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path], {
			stdin: content,
			timeoutMs: 60_000,
		});
		if (result.code !== 0) throw new Error(`cannot write ${path}: ${result.stderr.trim()}`);
	}
}
