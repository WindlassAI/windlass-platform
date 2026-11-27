/**
 * cd server && WLP_BROWSER=<headless_shell> npx tsx ../scripts/browser-hello-check.ts
 * cd server && WLP_SANDBOX_IMAGE=windlass-platform-sandbox:shots npx tsx ../scripts/browser-hello-check.ts --docker
 *
 * What the sandbox's browser sends through the runner's proxy (--egress restricted), and what a list of
 * public hosts (--egress-domains) does with it. A stand-in for the proxy listens where the runner's does,
 * with the runner's proxy variables, in a container without a network: it answers CONNECT and keeps the
 * first TLS record, which `clientHelloName` then reads as the broker would.
 *
 * Chrome sends an Encrypted Client Hello extension in every TLS 1.3 hello (a GREASE one when it has no
 * key for the host, as behind a proxy), and the broker refuses Encrypted Client Hello under a list, since
 * its outer name need not be the host the connection reaches. Chromium 149 has no switch for it any more:
 * the `EncryptedClientHello` feature is gone, so `--disable-features=EncryptedClientHello` changes nothing.
 * This check holds that fact. If it fails because the hello is accepted, the browser can reach listed
 * hosts: update the docs (machines.md, "Only some public hosts").
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { RUNNER_HTTP_PROXY } from "../server/src/runner/egress.js";
import { docker, LABEL_ARG } from "../server/src/sandbox/docker.js";
import { imageId } from "./check-image.js";
// @ts-expect-error the standalone program also runs directly in the pinned sandbox image
import { clientHelloName } from "../runner/src/egress-proxy.mjs";

const host = "registry.npmjs.org";
const port = new URL(RUNNER_HTTP_PROXY).port;
/** Run as `node -e` with the browser's command after `--`: prints `<CONNECT target> <hex of the first record>` per tunnel. */
const capture = `const http = require("http"), { spawn } = require("child_process");
const server = http.createServer((req, res) => res.end()).listen(${port}, "127.0.0.1", () => {
  const [command, ...args] = process.argv.slice(1);
  const browser = spawn(command, args, { stdio: "ignore" });
  setTimeout(() => { browser.kill("SIGKILL"); process.exit(0); }, 8000);
});
server.on("connect", (req, socket) => {
  socket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
  let data = Buffer.alloc(0);
  socket.on("data", chunk => {
    data = Buffer.concat([data, chunk]);
    if (data.length >= 5 && data.length >= 5 + data.readUInt16BE(3)) { console.log(req.url + " " + data.toString("hex")); socket.destroy(); }
  });
});`;
const browserArgs = (binary: string) => [
	binary,
	"--no-sandbox",
	"--disable-dev-shm-usage",
	"--dump-dom",
	`https://${host}/`,
];
const proxyEnv = {
	HTTP_PROXY: RUNNER_HTTP_PROXY,
	HTTPS_PROXY: RUNNER_HTTP_PROXY,
	http_proxy: RUNNER_HTTP_PROXY,
	https_proxy: RUNNER_HTTP_PROXY,
	NO_PROXY: "localhost,127.0.0.1,::1",
	no_proxy: "localhost,127.0.0.1,::1",
};

let output: string;
if (process.argv.includes("--docker")) {
	const image = await imageId(process.env.WLP_SANDBOX_IMAGE || "windlass-platform-sandbox:shots");
	const env = Object.entries(proxyEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
	// The image's own entry points: the wrapper on PATH, which wlp-shot also launches.
	output = (
		await docker(
			[
				"run",
				"--rm",
				"--init",
				"--label",
				LABEL_ARG,
				"--network",
				"none",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				...env,
				image,
				"node",
				"-e",
				capture,
				"--",
				...browserArgs("wlp-headless-shell"),
			],
			{ check: true, timeoutMs: 120_000 },
		)
	).stdout;
} else {
	const binary = process.env.WLP_BROWSER;
	if (!binary) {
		console.log("SKIP  no WLP_BROWSER (give --docker to use the screenshots image)");
		process.exit(0);
	}
	const run = spawnSync(process.execPath, ["-e", capture, "--", ...browserArgs(binary)], {
		encoding: "utf8",
		env: { ...process.env, ...proxyEnv },
		timeout: 60_000,
	});
	assert.equal(run.status, 0, run.stderr);
	output = run.stdout;
}

const hellos = output
	.trim()
	.split("\n")
	.filter(Boolean)
	.map(line => {
		const [target, hex] = line.split(" ");
		return { target, hello: Buffer.from(hex!, "hex") };
	});
assert.ok(hellos.length > 0, "the browser opened no tunnel through the proxy variables: " + output);
/** The extension types of a hello that is otherwise well formed. */
function extensions(hello: Buffer): number[] {
	let at = 5 + 4 + 2 + 32;
	at += 1 + hello[at]!;
	at += 2 + hello.readUInt16BE(at);
	at += 1 + hello[at]!;
	const end = at + 2 + hello.readUInt16BE(at);
	const types: number[] = [];
	for (at += 2; at < end; at += 4 + hello.readUInt16BE(at + 2)) types.push(hello.readUInt16BE(at));
	return types;
}
for (const { target, hello } of hellos) {
	assert.equal(target, host + ":443");
	const types = extensions(hello);
	assert.ok(hello.toString("latin1").includes(host), "the hello names the host");
	assert.ok(
		types.includes(0xfe0d),
		"Chrome sends Encrypted Client Hello: " + types.map(type => type.toString(16)).join(),
	);
	// The broker's answer to it: refused, as any Encrypted Client Hello is under a list.
	assert.equal(clientHelloName(hello), null);
	// The same hello without that one extension is accepted with its name: ECH is the only reason.
	const without = Buffer.from(hello);
	let at = 5 + 4 + 2 + 32;
	at += 1 + without[at]!;
	at += 2 + without.readUInt16BE(at);
	at += 1 + without[at]!;
	for (let p = at + 2; p < at + 2 + without.readUInt16BE(at); p += 4 + without.readUInt16BE(p + 2))
		if (without.readUInt16BE(p) === 0xfe0d) without.writeUInt16BE(0xfe0e, p);
	assert.equal(clientHelloName(without), host);
}
console.log(
	`PASS  ${hellos.length} ClientHello(s) of the sandbox's browser to ${host}: Encrypted Client Hello, refused under --egress-domains; nothing else in them is`,
);
