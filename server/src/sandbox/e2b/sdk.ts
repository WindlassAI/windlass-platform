/**
 * `E2bClient` on E2B's JavaScript SDK (the package `e2b`, 2.63.0). The only file that imports the SDK:
 * it is loaded when a server or a script is really configured for E2B, and nothing in it has run
 * against the service yet (scripts/e2b-check.ts is what does). client.ts names the documentation page
 * of each call.
 *
 * The API key is passed with every call and never put into the environment, a log line or an error.
 */

import { CommandExitError, GuestUnresponsiveError, NotFoundError, RateLimitError, Sandbox, SandboxError, type SandboxInfo, ServiceBusyError, Template } from "e2b";
import { E2bBusyError, type E2bClient, type E2bCommand, type E2bCommandOptions, type E2bConnection, E2bLimitError, type E2bSandboxInfo, E2bSnapshotModeError, type E2bSnapshotInfo } from "./client.js";

/** The user of the template (sandbox/e2b/template.ts), named with every call so that a template built otherwise cannot make commands run as another. */
const USER = "agent";
/** How long one request to E2B may take. Its default is 60 s; a server that waits on a turn's start should hear sooner. */
const REQUEST_TIMEOUT_MS = 30_000;

function infoOf(info: SandboxInfo): E2bSandboxInfo {
	return {
		sandboxId: info.sandboxId,
		templateId: info.templateId,
		state: info.state,
		metadata: info.metadata ?? {},
		startedAt: info.startedAt.getTime(),
		endAt: info.endAt.getTime(),
		cpuCount: info.cpuCount,
		memoryMB: info.memoryMB,
	};
}

/** At most this many pages of the account's snapshots are read: this layer keeps far fewer, and a longer list is someone else's. */
const SNAPSHOT_PAGES = 20;

/** The SDK's errors for "E2B cannot now" and "the plan's limit", as this layer names them; anything else as it is. */
function translated(error: unknown): unknown {
	if (error instanceof ServiceBusyError) return new E2bBusyError(error.message);
	if (error instanceof RateLimitError) return new E2bLimitError(error.message);
	return error;
}

function connection(sandbox: Sandbox): E2bConnection {
	return {
		sandboxId: sandbox.sandboxId,
		async start(command: string, options: E2bCommandOptions): Promise<E2bCommand> {
			const handle = await sandbox.commands.run(command, {
				background: true,
				// E2B's own limit on a command is 60 s by default and kills it; a turn's engine runs for as long as the turn.
				timeoutMs: 0,
				requestTimeoutMs: REQUEST_TIMEOUT_MS,
				user: options.root ? "root" : options.gitUser ? "nobody" : USER,
				cwd: options.cwd,
				envs: options.envs,
				stdin: options.stdin,
				// The output is handed on as it arrives; nothing of it is kept in the handle.
				retainOutput: false,
				onStdout: options.onStdout,
				onStderr: options.onStderr,
			});
			return {
				pid: handle.pid,
				sendStdin: (data) => handle.sendStdin(data, { requestTimeoutMs: REQUEST_TIMEOUT_MS }),
				closeStdin: () => handle.closeStdin({ requestTimeoutMs: REQUEST_TIMEOUT_MS }),
				wait: async () => {
					try {
						const result = await handle.wait();
						return { exitCode: result.exitCode, error: result.error };
					} catch (error) {
						// A non-zero exit code is a result here, not a failure.
						if (error instanceof CommandExitError) return { exitCode: error.exitCode, error: error.error };
						throw error;
					}
				},
				disconnect: () => handle.disconnect(),
				kill: async () => {
					await handle.kill();
				},
			};
		},
		readFile: (path) => sandbox.files.read(path, { user: USER, requestTimeoutMs: 60_000 }),
		writeFile: async (path, content) => {
			await sandbox.files.write(path, content, { user: USER, requestTimeoutMs: 60_000 });
		},
	};
}

export function createE2bSdkClient(apiKey: string): E2bClient {
	const api = { apiKey, requestTimeoutMs: REQUEST_TIMEOUT_MS };
	return {
		async create(input) {
			try {
				// `autoResume: false`: a paused sandbox is started by `connect` and by nothing else, so the limit on running sandboxes is this layer's to keep.
				return connection(await Sandbox.create(input.template, { ...api, timeoutMs: input.timeoutMs, metadata: input.metadata, envs: input.envs, lifecycle: { onTimeout: input.onTimeout, autoResume: false }, ...(input.network ? { network: { ...input.network } } : {}) }));
			} catch (error) {
				throw translated(error);
			}
		},
		async connect(sandboxId, timeoutMs, options = {}) {
			try {
				return connection(await Sandbox.connect(sandboxId, { ...api, timeoutMs, ...(options.reboot ? { onResume: "reboot" as const } : {}) }));
			} catch (error) {
				if (error instanceof NotFoundError) return undefined;
				// Its snapshot was taken while the sandbox was hung: E2B will not restore that memory. Booted from its disk the
				// files are there and no process is, which is all a session needs between turns.
				if (error instanceof GuestUnresponsiveError) return connection(await Sandbox.connect(sandboxId, { ...api, timeoutMs, onResume: "reboot" }));
				throw translated(error);
			}
		},
		async info(sandboxId) {
			try {
				return infoOf(await Sandbox.getInfo(sandboxId, api));
			} catch (error) {
				if (error instanceof NotFoundError) return undefined;
				throw translated(error);
			}
		},
		async list(query) {
			const paginator = Sandbox.list({ ...api, query: { metadata: query.metadata, ...(query.state === undefined ? {} : { state: query.state }) } });
			const found: E2bSandboxInfo[] = [];
			try {
				while (paginator.hasNext) for (const info of await paginator.nextItems()) found.push(infoOf(info));
			} catch (error) {
				throw translated(error);
			}
			return found;
		},
		async setTimeout(sandboxId, timeoutMs) {
			try {
				await Sandbox.setTimeout(sandboxId, timeoutMs, api);
			} catch (error) {
				throw translated(error);
			}
		},
		async pause(sandboxId) {
			try {
				return await Sandbox.pause(sandboxId, api);
			} catch (error) {
				if (error instanceof NotFoundError) return false;
				throw translated(error);
			}
		},
		async updateNetwork(sandboxId, network) {
			try {
				// The update replaces the whole configuration; an empty one clears it (E2B's default).
				await Sandbox.updateNetwork(sandboxId, network ? { ...network } : {}, api);
			} catch (error) {
				throw translated(error);
			}
		},
		async kill(sandboxId) {
			try {
				return await Sandbox.kill(sandboxId, api);
			} catch (error) {
				if (error instanceof NotFoundError) return false;
				throw translated(error);
			}
		},
		async createSnapshot(sandboxId, name) {
			try {
				// Filesystem only, never memory: a memory image would hold what setup's processes had in memory.
				const made = await Sandbox.createSnapshot(sandboxId, { ...api, requestTimeoutMs: 10 * 60_000, name, mode: "filesystem" });
				return { snapshotId: made.snapshotId, names: made.names };
			} catch (error) {
				// 400 snapshot_filesystem_only_disabled, 409 snapshot_filesystem_only_unsupported_node: the SDK keeps only the status.
				if (error instanceof SandboxError && (error.statusCode === 400 || error.statusCode === 409)) throw new E2bSnapshotModeError(error.message);
				throw translated(error);
			}
		},
		async listSnapshots() {
			const paginator = Sandbox.listSnapshots({ ...api, limit: 100 });
			const found: E2bSnapshotInfo[] = [];
			try {
				for (let page = 0; paginator.hasNext && page < SNAPSHOT_PAGES; page += 1) for (const item of await paginator.nextItems()) found.push({ snapshotId: item.snapshotId, names: item.names ?? [] });
			} catch (error) {
				throw translated(error);
			}
			return found;
		},
		async deleteSnapshot(snapshotId) {
			try {
				return await Sandbox.deleteSnapshot(snapshotId, api);
			} catch (error) {
				if (error instanceof NotFoundError) return false;
				throw translated(error);
			}
		},
		async metrics(sandboxId, sinceMs) {
			try {
				const samples = await Sandbox.getMetrics(sandboxId, { ...api, start: new Date(sinceMs) });
				return samples.map((one) => ({ at: one.timestamp.getTime(), memUsed: one.memUsed, memTotal: one.memTotal }));
			} catch (error) {
				if (error instanceof NotFoundError) return [];
				throw translated(error);
			}
		},
		async templateBuild(template) {
			const [name, tag = "default"] = template.split(":");
			try {
				const tags = await Template.getTags(name, api);
				return tags.find((found) => found.tag === tag)?.buildId ?? null;
			} catch (error) {
				// An unknown template is a TemplateError with status 404 (SDK 2.63.0), not a NotFoundError.
				if (error instanceof NotFoundError || (error as { statusCode?: unknown }).statusCode === 404) return null;
				throw translated(error);
			}
		},
	};
}
