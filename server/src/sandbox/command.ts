import type { ExecOptions } from "./api.js";
import type { InternalExecResult, TurnSandbox } from "./provider.js";

const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 256 * 1024;

export function within<T>(promise: Promise<T>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>(resolve => {
		timer = setTimeout(() => resolve(false), ms);
	});
	return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

export function runCommand(
	sandbox: Pick<TurnSandbox, "start" | "sweep">,
	argv: string[],
	options: ExecOptions,
	clientStopMessage: string,
	monitor?: () => () => Promise<void>,
): Promise<InternalExecResult> {
	if (options.signal?.aborted)
		return Promise.resolve({
			exitCode: null,
			timedOut: false,
			aborted: true,
			stdout: "",
			stderr: "",
			killed: false,
			stopLog: [],
			leftovers: 0,
		});
	let stdout = "";
	let stderr = "";
	const run = sandbox.start(argv, {
		gitUser: options.gitUser,
		cwd: options.cwd,
		env: options.env,
		secretEnv: options.secretEnv,
		onStdout: text => {
			if (stdout.length < STDOUT_CAP) stdout += text.slice(0, STDOUT_CAP - stdout.length);
			options.onStdout?.(text);
		},
		onStderr: text => {
			stderr = (stderr + text).slice(-STDERR_CAP);
			options.onStderr?.(text);
		},
	});
	if (options.stdin !== undefined && options.stdin !== "") run.write(options.stdin);
	run.closeStdin();

	const release = monitor?.();
	let stopping: Promise<void> | null = null;
	let timedOut = false;
	let aborted = false;
	let killed = false;
	const stopLog: string[] = [];
	const stop = () => {
		if (stopping !== null) return;
		const began = Date.now();
		const note = (text: string) => stopLog.push(`${text} at +${Date.now() - began}ms`);
		stopping = (async () => {
			note("SIGTERM to every process of the run");
			await run.signal("TERM", "all");
			if (await within(run.ended, 2000)) return;
			note("SIGKILL to every process of the run");
			killed = true;
			await run.signal("KILL", "all");
			if (await within(run.ended, 3000)) return;
			note(clientStopMessage);
			run.killClient();
		})();
	};
	const onAbort = () => {
		aborted = true;
		stop();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					stop();
				}, options.timeoutMs);

	const result = run.ended.then(async end => {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		if (end.error !== null) throw end.error;
		if (stopping !== null) await stopping;
		const stopped = stopping !== null;
		const leftovers = await sandbox.sweep(run.tag, { waitMs: stopped ? 2000 : 0 });
		const exitCode =
			killed || end.signal !== null || (stopped && end.code !== null && end.code > 128) ? null : end.code;
		return { exitCode, timedOut, aborted, stdout, stderr, killed, stopLog, leftovers };
	});
	return release ? result.finally(release) : result;
}
