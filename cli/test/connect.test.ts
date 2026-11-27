/**
 * The whole `connect claude` flow as a user runs it: the CLI against a stand-in platform, with a stand-in
 * `claude` on PATH that prints a setup token the way Claude Code's screen does (colours, a box, wrapped).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TOKEN = "sk-ant-oat01-" + "Zq8_k-3".repeat(13) + "WWAA";
const REQUEST = "r".repeat(43);

const bin = mkdtempSync(join(tmpdir(), "windlassai-cli-"));
after(() => rmSync(bin, { recursive: true, force: true }));
const ran = join(bin, "claude-ran");
// Box lines 40 wide, as Claude Code draws them; the token wraps over three of them.
const pieces = TOKEN.match(/.{1,40}/g)!.map(
	piece => `printf '\\033[2m│\\033[0m %-40s \\033[2m│\\033[0m\\r\\n' '${piece}'`,
);
writeFileSync(
	join(bin, "claude"),
	`#!/bin/sh
[ "$1" = "setup-token" ] || exit 64
touch '${ran}'
[ -n "$FAKE_CLAUDE_SILENT" ] && { printf 'Authentication cancelled.\\r\\n'; exit 1; }
printf '\\033[?25l\\033[32m✓ Long-lived authentication token created\\033[39m\\r\\n'
${pieces.join("\n")}
printf '\\r\\nStore this token securely.\\033[?25h\\r\\n'
`,
);
chmodSync(join(bin, "claude"), 0o755);

type Plan = { decision: "approved" | "denied"; connect: number; body?: unknown };

/** The platform's three routes: approval arrives on the second poll; the connect answer is the case's. */
async function platform(plan: Plan) {
	const seen: { path: string; body: Record<string, unknown> }[] = [];
	let polls = 0;
	const read = async (req: IncomingMessage) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		return JSON.parse(text) as Record<string, unknown>;
	};
	const server = createServer(async (req, res) => {
		const body = await read(req);
		seen.push({ path: req.url!, body });
		const send = (status: number, answer: unknown) =>
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
		if (req.url === "/platform/connect/start")
			return send(201, {
				userCode: "KQ2M-8XF4",
				approveUrl: "http://127.0.0.1:1/connect?code=KQ2M-8XF4",
				request: REQUEST,
				expiresAt: Date.now() + 600_000,
				interval: 1_000,
			});
		if (req.url === "/platform/connect/poll") return send(200, { state: ++polls < 2 ? "pending" : plan.decision });
		if (req.url === "/platform/connect") return send(plan.connect, plan.body ?? { account: "a@b.com · Max" });
		send(404, {});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	after(() => server.close());
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function cli(args: string[], env: Record<string, string>, stdin = "") {
	rmSync(ran, { force: true });
	const child = spawn(process.execPath, [MAIN, ...args], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPLAY: "", WAYLAND_DISPLAY: "", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.end(stdin);
	let stdout = "",
		stderr = "";
	child.stdout.on("data", chunk => (stdout += chunk));
	child.stderr.on("data", chunk => (stderr += chunk));
	return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve =>
		child.on("close", code => resolve({ code, stdout, stderr })),
	);
}

test("approve in the browser, then claude setup-token's token connects the plan", async () => {
	const site = await platform({ decision: "approved", connect: 200 });
	const run = await cli(["connect", "claude", "--no-browser"], { WINDLASS_PLATFORM: site.url });
	assert.equal(run.code, 0, run.stderr);
	assert.match(run.stdout, /code KQ2M-8XF4/);
	assert.match(run.stdout, /http:\/\/127\.0\.0\.1:1\/connect\?code=KQ2M-8XF4/);
	assert.match(run.stdout, /Connected: a@b\.com · Max/);
	assert.ok(existsSync(ran), "claude setup-token ran");
	assert.deepEqual(
		site.seen.map(one => one.path),
		["/platform/connect/start", "/platform/connect/poll", "/platform/connect/poll", "/platform/connect"],
	);
	assert.deepEqual(site.seen.at(-1)!.body, { request: REQUEST, token: TOKEN });
	assert.ok(!run.stderr.includes("sk-ant"));
	// Nothing on screen shows the token: not the CLI's lines, and not Claude Code's screen copied through.
	for (const piece of TOKEN.match(/.{1,40}/g)!) assert.ok(!run.stdout.includes(piece), "a token piece on screen");
	assert.ok(!run.stdout.includes("WWAA") && run.stdout.includes("(hidden)"));
});

test("a denied request runs nothing and connects nothing", async () => {
	const site = await platform({ decision: "denied", connect: 200 });
	const run = await cli(["connect", "claude", "--no-browser"], { WINDLASS_PLATFORM: site.url });
	assert.equal(run.code, 1);
	assert.match(run.stderr, /denied in the browser/);
	assert.ok(!existsSync(ran));
	assert.ok(!site.seen.some(one => one.path === "/platform/connect"));
});

test("--token-stdin skips claude setup-token; refusals read as the platform means them", async () => {
	const site = await platform({ decision: "approved", connect: 400, body: { code: "plan_refused", message: TOKEN } });
	const run = await cli(
		["connect", "claude", "--no-browser", "--token-stdin"],
		{ WINDLASS_PLATFORM: site.url },
		`${TOKEN}\n`,
	);
	assert.equal(run.code, 1);
	assert.match(run.stderr, /Anthropic did not accept that token/);
	assert.ok(!run.stderr.includes(TOKEN) && !run.stdout.includes(TOKEN));
	assert.ok(!existsSync(ran));
	assert.equal(site.seen.at(-1)!.body.token, TOKEN);

	const typo = await cli(["connect", "claude", "--token-stdin"], { WINDLASS_PLATFORM: site.url }, "sk-ant-oat01-x");
	assert.equal(typo.code, 1);
	assert.match(typo.stderr, /does not hold a setup token/);
});

test("no token in the output and no terminal to paste into: it says how to finish", async () => {
	const site = await platform({ decision: "approved", connect: 200 });
	const run = await cli(["connect", "claude", "--no-browser"], {
		WINDLASS_PLATFORM: site.url,
		FAKE_CLAUDE_SILENT: "1",
	});
	assert.equal(run.code, 1);
	assert.match(run.stderr, /No setup token was found.*--token-stdin/);
	assert.ok(!site.seen.some(one => one.path === "/platform/connect"));
});

test("usage, planned commands and platform addresses", async () => {
	const codex = await cli(["connect", "codex"], { WINDLASS_PLATFORM: "https://windlass.example.com" });
	assert.equal(codex.code, 2);
	assert.match(codex.stderr, /signing in with ChatGPT on the platform.*https:\/\/windlass\.example\.com\/settings/);
	assert.match((await cli(["connect", "--machine"], {})).stderr, /not available yet/);
	const plain = await cli(["connect", "claude"], { WINDLASS_PLATFORM: "http://example.com" });
	assert.match(plain.stderr, /must start with https:\/\//);
});
