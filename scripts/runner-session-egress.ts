// From server: pnpm exec tsx ../scripts/runner-e2e.ts egress <base-image-id> <claude-image-id>
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createClient, type Registry } from "../server/src/client.js";
import { LABEL, MACHINE_LABEL } from "../server/src/sandbox/docker.js";
import { cloneScript, commitScript, fetchBaseScript, pushScript } from "../server/src/github/git.js";
import type { TimelineItem } from "../server/src/contract.js";
import { until } from "./runner-standin.js";
import { writeProofDocker } from "./runner-proof-docker.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const repoUrl = "https://github.com/octocat/Hello-World.git";
export async function sessionEgress(dir: string, origin: string, endpoint: string, start: (env: Record<string, string>) => Promise<void>) {
	const [base, claude] = process.argv.slice(3);
	for (const pin of [base, claude]) assert.match(pin, /^sha256:[a-f0-9]{64}$/);
	const prefix = "egress-" + randomUUID() + "-";
	const bundle = join(dir, "runner.cjs");
	const realDocker = (await exec("which", ["docker"])).stdout.trim();
	const docker = async (...args: string[]) => (await exec(realDocker, args, { timeout: 120_000 })).stdout.trim();
	const fake = join(dir, "fake-acp");
	await writeFile(fake, "#!/bin/sh\nexec node /proof/egress.mjs\n", { mode: 0o755 });
	const probe = await readFile(join(root, "fixtures/acp-agent/egress.sh"), "utf8");
	const lan = prefix + "lan";
	const remote = prefix + "git";
	await writeProofDocker(dir, prefix, realDocker, { adapter: fake, scenarios: join(root, "fixtures/acp-agent"), lan });
	await exec(process.execPath, [join(root, "runner/bundle.mjs"), base, bundle, "claude=" + claude]);
	const model = join(dir, "model.json");
	await writeFile(model, JSON.stringify({ responses: [
		[{ type: "tool_call", callId: "network", name: "shell", input: { command: `(\n${probe}\n) > /tmp/proof-output` } }, { type: "finish", reason: "tool_calls" }],
		[{ type: "text", text: "Finished the probes." }, { type: "finish", reason: "stop" }],
	] }));
	await start({ WLP_TEST_MODEL_SCRIPT: model, WLP_PUBLIC_ENDPOINT: endpoint });
	const client = createClient<Registry>({ endpoint, token: "default", namespace: "default" });
	const { profile: { uid }, token } = await client.login.getOrCreate([randomUUID()]).demo();
	const params = { token };
	const user = client.user.getOrCreate([uid], { params });
	const runner = spawn(process.execPath, [bundle, "--platform", origin, "--egress", "restricted", "--egress-allow", "git-fixture.test", "--harness", "claude"], {
		env: { HOME: dir, PATH: dir + ":" + process.env.PATH, WLP_RUNNER_STATE_DIR: join(dir, "runner-state") }, stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	runner.stdout.on("data", data => output += data);
	runner.stderr.on("data", data => output += data);
	let machineId: string | undefined;
	try {
		await docker("network", "create", lan);
		await docker("run", "-d", "--name", remote, "--network", lan, "--network-alias", "git-fixture.test", "--network-alias", "unlisted.test",
			base, "bash", "-ec", [
				"cd /tmp && mkdir -p cgi-bin && git init -q --bare remote.git && git -C remote.git config http.receivepack true",
				"printf '%s\\n' '#!/bin/sh' 'export GIT_PROJECT_ROOT=/tmp GIT_HTTP_EXPORT_ALL=1' 'exec git http-backend' > cgi-bin/git",
				"chmod +x cgi-bin/git && exec python3 -m http.server --cgi 8080",
			].join("\n"));
		const code = await until("pairing code", () => /enter (\w{4}-\w{4})/.exec(output)?.[1]);
		await user.claimMachine({ code });
		({ machineId } = await user.confirmMachine({ code }));
		const labels = ["--label", LABEL + "=1", "--label", MACHINE_LABEL + "=" + machineId, "--label", LABEL + ".uid=" + uid];
		const login = prefix + "login-" + machineId;
		await docker("volume", "create", ...labels, login);
		await docker("run", "--rm", "--network", "none", "--user", "0", "-v", login + ":/login", base, "sh", "-ec", "echo fixture > /login/token; chown 1000:1000 /login/token; chmod 400 /login/token");
		await until("signed-in restricted report", async () => (await user.machines()).some(m => m.machineId === machineId && m.egress === "restricted" && m.harnesses?.some(h => h.signIn === "token")), 120_000);
		for (const harness of ["windlass", "claude"] as const) {
			const session = await user.createSession({ place: { kind: "machine", machineId }, profile: "docker-hardened", repoUrl, harness });
			const conn = client.agentSession.get([uid, session.id], { params }).connect();
			const items: TimelineItem[] = [];
			conn.on("item", (i: unknown) => items.push(i as TimelineItem));
			try {
				const { turn } = await conn.prompt({ text: "plain" });
				const end = await until("turn end", () => items.find(i => i.kind === "turn.ended" && i.turn === turn), 180_000);
				assert(end.kind === "turn.ended" && end.outcome === "succeeded", JSON.stringify(items.slice(-5)));
				const name = await docker("ps", "--filter", "label=" + MACHINE_LABEL + "=" + machineId, "--filter", "label=" + LABEL + ".session=" + session.id, "--format", "{{.Names}}");
				assert(name.startsWith(prefix + "agent-"));
				const result = await docker("exec", name, "cat", "/tmp/proof-output");
				assert.match(result, /^([0-9a-f]{40})\n\1\s+HEAD\n\d+\.\d+\.\d+\nblocked$/);
				console.log("PASS", harness, "session launch, public clone, agent git/npm and blocked destinations", result);
				if (harness === "claude") {
					const result = await docker("exec", name, "bash", "-ec", "mkdir /tmp/token-clone && cd /tmp/token-clone\n" + cloneScript(repoUrl, "master", "hello") + "\ntest -s README");
					assert.match(result, /^wlp:dir \.$/m);
					const git = (script: string) => docker("exec", "-w", "/tmp/token-clone", name, "bash", "-ec", script);
					const url = "http://git-fixture.test:8080/cgi-bin/git/remote.git";
					const denied = await git("curl --max-time 5 -so /dev/null -w '%{http_code}' http://unlisted.test:8080/");
					assert.equal(denied, "403");
					const fetched = await git(fetchBaseScript(repoUrl, "master"));
					assert.match(fetched, /wlp:fetched/);
					const branch = "egress-proof";
					await git("echo egress > proof.txt\n{\n" + commitScript({ branch, base: "master", sessionId: session.id, pushed: null,
						author: { name: "Fixture", email: "test@example.invalid" } }) + "\n} <<< 'Fixture commit'");
					const pushed = await git(pushScript(session.id, url, branch));
					const received = await docker("exec", remote, "git", "-C", "/tmp/remote.git", "rev-parse", "refs/heads/" + branch);
					assert(pushed.includes("wlp:pushed " + received), pushed);
					console.log("PASS platform clone and fetch, allowlisted push and denied alias", received);
				}
			} finally { await conn.dispose(); }
		}
	} catch (err) { console.error(output); throw err; }
	finally {
		const exit = once(runner, "exit");
		if (runner.exitCode === null && !runner.signalCode) { runner.kill("SIGTERM"); await exit; }
		if (machineId) {
			const filters = ["--filter", "label=" + MACHINE_LABEL + "=" + machineId, "--filter", "label=" + LABEL + ".uid=" + uid];
			for (const id of (await docker("ps", "-aq", ...filters)).split(/\s+/).filter(Boolean)) await docker("rm", "-fv", id);
			for (const vol of (await docker("volume", "ls", "-q", ...filters)).split(/\s+/).filter(Boolean)) await docker("volume", "rm", vol);
		}
		await docker("rm", "-f", remote).catch(() => {});
		await docker("network", "rm", lan);
	}
}
