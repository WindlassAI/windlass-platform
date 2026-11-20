/**
 * cd server && npx tsx ../scripts/shot-check.ts
 * cd server && WLP_SANDBOX_IMAGE=windlass-platform-sandbox:shots ../scripts/locked.sh shot-check.ts --docker
 *
 * The fixture is embedded here. Install Vite in a separate setup container, then use the same
 * workspace on a fresh, offline 1 GiB container. All shell tool calls are real Windlass sandboxes.
 * Read memory.peak before the deliberately oversized renderer runs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { docker, IMAGE, LABEL_ARG, randomId } from "../server/src/sandbox/docker.js";
import { PROFILE_RUN_FLAGS } from "../server/src/sandbox/profiles.js";
import { shellQuote } from "../server/src/sandbox/provider.js";

const url = "http://127.0.0.1:4173/";
const cli = fileURLToPath(new URL("../sandbox/wlp-shot", import.meta.url));
const help = /server and the browser have to be started by the same command; a server started\s+in another command cannot be reached/;
const badNames = ["../x.png", "a b.png", ".hidden.png", "A.png", "a".repeat(65) + ".png"];
assert.match(spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).stdout, help);
for (const name of badNames) {
	const r = spawnSync(process.execPath, [cli, "--url", url, "--shot", "/=ok.png", "--out", name], { encoding: "utf8" });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /^wlp-shot: invalid PNG name:/);
}
console.log("PASS  help and filename validation (without Docker)");

const fixture = "/workspace/fixtures/vite";
const vite = "npx vite --port 4173 --strictPort --host 127.0.0.1";
const serve = `wlp-shot --serve ${shellQuote(vite)} --url ${url}`;
const page = `<!doctype html><meta charset="utf-8"><title>Windlass fixture</title>
<h1>Screenshot fixture</h1><button id="show">Show details</button><p hidden>Ready</p>
<script type="module">
if (new URLSearchParams(location.search).get('page') === 'two') document.querySelector('h1').textContent = 'Fixture details';
document.querySelector('button').onclick = () => {
  const details = document.querySelector('p');
  details.hidden = false;
  details.id = innerWidth < 500 && matchMedia('(prefers-color-scheme: dark)').matches ? 'mobile' : 'desktop';
  if (location.search === '?oom') {
    // Fault in actual private pages in this renderer. Bound the allocation even if the kernel never kills it.
    window.chunks = [];
    for (let i = 0; i < 40; i++) window.chunks.push(new Uint8Array(32 * 1024 * 1024).fill(1));
  }
};
</script>`;

// Only these fixture inputs are ignored. An accidental PNG elsewhere still dirties the repo.
// A minimal empty repository avoids making any commit or staging the generated fixture.
const setup = `set -eu
mkdir -p ${fixture}/.git/objects ${fixture}/.git/refs ${fixture}/.git/info ${fixture}/app
cd ${fixture}
printf 'ref: refs/heads/main\\n' > .git/HEAD
printf '%s\\n' /app/node_modules/ /app/package.json /app/index.html > .git/info/exclude
cd app
printf '%s' '{"private":true,"type":"module","devDependencies":{"vite":"8.3.8"}}' > package.json
cat > index.html <<'PAGE'
${page}
PAGE
npm install --no-audit --no-fund --package-lock=false
test -z "$(git status --porcelain)"`;

// Run while still inside the command too: leaving a PID namespace could otherwise mask a leak.
const noProcesses = `ps -eo pid,comm,args | awk '$2 ~ /^(headless_shell|chrome-headless|chrome_crashpad|MainThread|node|npm|vite|python3)/ { print; found=1 } END { exit found }'`;
const shot = "cd app && ";
type Call = { id: string; command: string; background?: boolean };
type Event = { type: string; outcome?: string; data?: { callId?: string; outcome?: string; output?: string } };

async function dockerProof() {
	const image = process.env.WLP_SANDBOX_IMAGE || "windlass-platform-sandbox:shots";
	const name = "wlp-shot-check-" + randomId(6);
	const volume = name + "-work";
	const run = async (args: string[], stdin?: string) =>
		(await docker(args, { stdin, check: true, timeoutMs: 180000 })).stdout;
	const exec = (args: string[], stdin?: string) => run(["exec", "-i", "-w", fixture, name, ...args], stdin);
	const mount = ["-v", volume + ":/workspace"];
	const memory = ["--memory", "1g", "--memory-swap", "1g"];
	const sizes = (tag: string) => run(["image", "ls", "--format", "{{.Repository}}:{{.Tag}} {{.Size}}", tag]);
	console.log("Before: " + (await sizes(IMAGE)).trim() + "\nAfter:  " + (await sizes(image)).trim());

	async function turn(calls: Call[]): Promise<string[]> {
		const responses: Record<string, unknown>[][] = calls.map(({ id, command, background }) => [
			{ type: "tool_call", callId: id, name: "shell", input: { command, background } },
			{ type: "finish", reason: "tool_calls" },
		]);
		responses.push([{ type: "text", text: "Done." }, { type: "finish", reason: "stop" }]);
		await exec(["sh", "-c", "cat > /tmp/shot-script.json"], JSON.stringify({ responses }));
		const lines = await exec(["env", "WINDLASS_ACP_SCRIPT=/tmp/shot-script.json", "WINDLASS_WAKE=off",
			"windlass", "--approval", "auto", "--json", "Check the screenshot fixture."]);
		const events: Event[] = lines.trim().split("\n").map(line => JSON.parse(line));
		assert.equal(events.find(e => e.type === "cli.summary")?.outcome, "succeeded", lines.slice(-3000));
		return calls.map(call => {
			const result = events.find(e => e.type === "tool.settled" && e.data?.callId === call.id)?.data;
			assert.equal(result?.outcome, "success", `${call.id}: ${result?.output ?? lines.slice(-2000)}`);
			return result?.output ?? "";
		});
	}

	await run(["volume", "create", "--label", LABEL_ARG, volume]);
	try {
		await run(["run", "--rm", "-i", "--init", "--label", LABEL_ARG, ...memory, ...mount, image, "sh", "-se"], setup);
		await run(["run", "-d", "--init", "--label", LABEL_ARG, "--name", name, "--network", "none",
			"--cap-drop", "ALL", "--security-opt", "no-new-privileges", ...PROFILE_RUN_FLAGS["docker-windlass-sandbox"]!,
			...memory, ...mount, image, "sleep", "infinity"]);
		try {
			assert.equal((await exec(["cat", "/sys/fs/cgroup/memory.max"])).trim(), "1073741824");
			assert.equal((await exec(["cat", "/sys/fs/cgroup/memory.swap.max"])).trim(), "0");
			assert.match(await exec(["wlp-shot", "--help"]), help);
			const version = (await exec(["wlp-headless-shell", "--version"])).trim();
			const pairing = JSON.parse(await exec(["node", "-p",
				'JSON.stringify(require("/usr/local/lib/node_modules/playwright-core/browsers.json").browsers.find(b => b.name === "chromium-headless-shell"))']));
			assert.equal(pairing.revision, "1228");
			assert.equal(pairing.browserVersion, "149.0.7827.55");
			// Playwright calls revision 1228 release 149.0.7827.55, but its arm64 executable
			// actually identifies itself as Chromium 149.0.7827.0. Chrome for Testing is .55.
			const arch = (await exec(["dpkg", "--print-architecture"])).trim();
			assert.ok(arch === "arm64" || arch === "amd64");
			assert.equal(version.split(" ").at(-1), arch === "arm64" ? "149.0.7827.0" : "149.0.7827.55");
			console.log("PASS  image help and " + version);
			const [result] = await turn([{ id: "shots", command: shot +
				`${serve} --out home.png --shot '/?page=two=details.png' --click '#show' --wait-for '#desktop' && ` +
				`${serve} --out mobile.png --viewport 390x844 --color-scheme dark --full-page --click '#show' --wait-for '#mobile' && ` +
				noProcesses }]);
			const peak = Number((await exec(["cat", "/sys/fs/cgroup/memory.peak"])).trim());
			console.log(`Vite turn cgroup memory.peak: ${peak} bytes (${(peak / 2 ** 20).toFixed(1)} MiB)`);
			assert.ok(peak > 0 && peak <= 800 * 2 ** 20, "Vite peak exceeded 800 MiB or was unavailable");
			for (const [file, width, height] of [["home.png", 1280, 800], ["details.png", 1280, 800], ["mobile.png", 390, 844]] as const) {
				const png = Buffer.from(await exec(["base64", "-w0", ".wlp-shots/" + file]), "base64");
				assert.equal(png.subarray(0, 16).toString("hex"), "89504e470d0a1a0a0000000d49484452");
				assert.equal(png.readUInt32BE(16), width);
				assert.equal(png.readUInt32BE(20), height);
				assert.equal(png.subarray(-12).toString("hex"), "0000000049454e44ae426082");
				const line = `wlp-shot: .wlp-shots/${file} ${width}x${height} ${png.length} bytes`;
				assert.ok(result.split("\n").includes(line), result);
				console.log("PASS  " + line);
			}
			await exec(["sh", "-c", "cmp -s .wlp-shots/home.png .wlp-shots/details.png; test $? = 1"]);
			assert.equal(await exec(["cat", ".wlp-shots/.gitignore"]), "*\n");
			assert.equal(await exec(["git", "status", "--porcelain"]), "");
			console.log("PASS  clean fixture Git status after shots from a subdirectory");

			// The server stays up in the FIRST tool's network namespace through the second tool's failed
			// readiness probe. Record its namespace only once it owns the listening socket.
			const otherServer = `from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
s = HTTPServer(('127.0.0.1', 4173), SimpleHTTPRequestHandler)
Path('/tmp/server.net').write_text(os.readlink('/proc/self/ns/net'))
s.timeout = .1
while not Path('/tmp/server.stop').exists(): s.handle_request()
Path('/tmp/server.ended').touch()`;
			const waitFile = (path: string) => `for i in $(seq 1 100); do test -f ${path} && break; sleep .1; done; test -f ${path}`;
			const [, isolated] = await turn([
				{ id: "server", background: true, command: "exec python3 -c " + shellQuote(otherServer) },
				{ id: "isolated", command: `set -eu; ${waitFile("/tmp/server.net")}; test "$(cat /tmp/server.net)" != "$(readlink /proc/self/ns/net)"; ` +
					`start=$(date +%s%3N); status=0; wlp-shot --url ${url} --timeout 1 || status=$?; test "$status" = 1; elapsed=$(($(date +%s%3N) - start)); echo "elapsed $elapsed ms"; touch /tmp/server.stop; ${waitFile("/tmp/server.ended")}; ${noProcesses}` },
			]);
			const [message, timing] = isolated.trim().split("\n");
			assert.equal(message, `wlp-shot: the app did not answer at ${url} within 1 s`);
			const elapsed = Number(/^elapsed (\d+) ms$/.exec(timing)?.[1]);
			// Includes loading Node and the global driver and shutting the helper down.
			assert.ok(elapsed >= 1000 && elapsed < 4000, isolated);
			assert.equal(await exec(["sh", "-c", noProcesses]), "");
			console.log(`PASS  live server isolated across two commands, one-second timeout (${elapsed} ms), no residual processes`);

			const [bad] = await turn([{ id: "names", command: `set -eu
for name in '../x.png' 'a b.png'; do
  status=0; wlp-shot --url ${url} --out "$name" || status=$?
  test "$status" = 1
done
test ! -e x.png && test ! -e '.wlp-shots/a b.png' && test -z "$(git status --porcelain)"` }]);
			assert.equal((bad.match(/wlp-shot: invalid PNG name:/g) ?? []).length, 2);
			console.log("PASS  unsafe filenames refused before any write");

			// Keep a TERM-resistant group member alongside Vite. The browser must be running at the
			// moment we signal the helper. Check ps before Windlass tears down the PID namespace.
			const stubborn = 'sh -c ' + shellQuote('trap "" TERM; exec sleep 120') + ' & ' + vite;
			const [interrupted] = await turn([{ id: "term", command: `set -eu; cd app
wlp-shot --serve ${shellQuote(stubborn)} --url ${url} --wait-for '#never' &
helper=$!
for i in $(seq 1 150); do pgrep -f '^/opt/wlp-browser/.+--type=renderer' >/dev/null && break; sleep .1; done
pgrep -f '^/opt/wlp-browser/.+--type=renderer' >/dev/null
kill -TERM "$helper"; status=0; wait "$helper" || status=$?
test "$status" = 1
${noProcesses}
! pgrep -fx 'sleep 120' >/dev/null` }]);
			assert.match(interrupted, /wlp-shot: interrupted/);
			assert.equal(await exec(["sh", "-c", noProcesses]), "");
			console.log("PASS  SIGTERM with a live renderer and TERM-resistant server child, no residual processes");

			const kills = async () => Number(/^oom_kill (\d+)$/m.exec(await exec(["cat", "/sys/fs/cgroup/memory.events"]))?.[1]);
			const before = await kills();
			const [oom, alive] = await turn([
				{ id: "oom", command: shot + `status=0; wlp-shot --serve ${shellQuote(vite)} --url '${url}?oom' --click '#show' --wait-for '#never' --timeout 20 --out oom.png || status=$?; test "$status" = 1 && test ! -e ../.wlp-shots/oom.png && ${noProcesses}` },
				{ id: "alive", command: "printf 'Windlass ran its next sandboxed command\\n'" },
			]);
			assert.equal(oom.trim(), "wlp-shot: the browser was killed (out of memory?)");
			const after = await kills();
			assert.ok(after > before, `kernel oom_kill counter: ${before} -> ${after}`);
			assert.equal(alive.trim(), "Windlass ran its next sandboxed command");
			assert.equal(await exec(["sh", "-c", noProcesses]), "");
			console.log(`PASS  kernel oom_kill ${before} -> ${after}; ${oom.trim()}; ${alive.trim()}`);
		} finally {
			await run(["stop", "--time", "3", name]);
			await run(["rm", name]);
		}
	} finally {
		await run(["volume", "rm", volume]);
	}
}

if (process.argv.includes("--docker")) await dockerProof();
