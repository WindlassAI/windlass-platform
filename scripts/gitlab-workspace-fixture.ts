/** GitLab actor E2E uses a fake model, not a fake remote branch. Run the platform's Git
 * commands on a scratch checkout of the loopback stand-in; keep all other fake commands inert. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExecOptions, ExecResult } from "../server/src/sandbox/api.js";
import { FakeHandle } from "../server/src/sandbox-fake.js";

export function installGitlabWorkspaceFixture(storage: string) {
	const original = FakeHandle.prototype.run;
	const roots = new Map<string, Promise<string>>();
	FakeHandle.prototype.run = async function (command, options: ExecOptions = {}) {
		if (!roots.has(this.id) && options.gitUser && command.includes("wlp_git clone --quiet") && command.includes("username=oauth2")) {
			roots.set(this.id, mkdtemp(join(storage, "git-")));
		}
		const root = roots.get(this.id);
		if (!root || !(options.gitUser || command.includes('echo "wlp:dir $target"') || command.includes('private=$(mktemp -d /tmp/wlp-git.XXXXXXXX)') || command.includes('bridge export HEAD index MERGE_HEAD'))) return original.call(this, command, options);
		const cwd = await root;

		const result = await new Promise<ExecResult>((resolve, reject) => {
			const child = spawn("bash", ["-c", command], { cwd: options.gitUser ? "/" : cwd, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" }, signal: options.signal, timeout: options.timeoutMs });
			let stdout = "", stderr = "";
			child.stdout.setEncoding("utf8").on("data", text => { stdout += text; options.onStdout?.(text); });
			child.stderr.setEncoding("utf8").on("data", text => { stderr += text; options.onStderr?.(text); });
			child.stdin.on("error", () => {});
			child.stdin.end(options.stdin ?? "");
			child.on("error", reject);
			child.on("close", code => resolve({ exitCode: code, stdout, stderr, timedOut: code === null, aborted: !!options.signal?.aborted }));
		});
		if (result.exitCode === 0 && command.includes('echo "wlp:dir $target"')) {
			// The only simulated part of the Git change is what the model typed.
			await writeFile(join(cwd, `windlass-fixture-${basename(cwd)}.txt`), "Built by the fixture model.\n", { flag: "wx" });
		}
		return result;
	};
}
