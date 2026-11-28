/**
 * The Docker model relay with real containers (docs/model-relay.md): the program a paired machine's relay runs for
 * Windlass on the user's ChatGPT sign-in, opened here on the layer's relay as a runner opens it (hosted Windlass
 * pays with the ChatGPT plan through the platform relay instead, `--hosted-keys`). It repeats the experiments of the
 * token-exposure note in a hardened session container, where commands run directly as the user Windlass runs as:
 *
 *   1. what a command can read: the token file, /dev/shm, Windlass's data directory, /tmp, the
 *      workspace, every /proc/<pid>/environ and cmdline. The real token is in none of them.
 *   2. a process left over from setup (`setsid env -i`) that copies every token file it finds, while
 *      the token is replaced: it collects only the placeholder.
 *   3. the real Windlass of the image lists the models and answers a prompt through the relay; the
 *      recording upstream sees the real token, the session never does.
 *   4. a token replaced while a request streams; another turn's placeholder on this turn's forwarder;
 *      the relay's caps; and after the turn, the forwarder and the token are gone.
 *   5. the end of a turn stops its request still streaming; a session process that holds
 *      127.0.0.1:17893 before the forwarder fails the turn; what a server that died left (a forwarder,
 *      a token file) is removed when the next one prepares the relay.
 *   6. 64 streams at once, with 1 MiB request bodies and 2 MiB answers, through a relay container of
 *      the hosted relay's memory (RELAY_MEMORY): every stream completes, and the relay is not killed.
 *
 * The relay sends to a recording upstream on a network of the check's own instead of api.openai.com.
 *
 *   cd server && npx tsx ../scripts/model-relay-docker-check.ts
 *
 * Needs Docker and the base image (sandbox/build.sh). Without the relay every case here fails: the token
 * file would hold the token, and Windlass would have no relay to send to.
 */

import "./check-secret.js";
import assert from "node:assert/strict";
import { config } from "../server/src/config.js";
import { randomBytes } from "node:crypto";
import { docker } from "../server/src/sandbox/docker.js";
import { createSandboxLayer } from "../server/src/sandbox/index.js";
import type { DockerSandboxHandle } from "../server/src/sandbox/sandboxes.js";
import { TokenFile, openModelKeyRelay } from "../server/src/sandbox/token-file.js";
import type { AccessToken } from "../server/src/sandbox/api.js";
import { DATA_DIR } from "../server/src/sandbox/provider.js";
import { DockerModelRelay, type DockerTurnRelay, RELAY_MEMORY } from "../server/src/sandbox/model-relay.js";
import { imageId } from "./check-image.js";
import { sleep } from "./check-wait.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail.slice(0, 2000)}` : ""}`);
}

const run = randomBytes(4).toString("hex");
const network = `wlp-mr-check-${run}`;
const upstreamName = `wlp-mr-upstream-${run}`;
const scope = `check${run}`;
const REAL_A = `REAL-CHATGPT-TOKEN-A-${randomBytes(16).toString("hex")}`;
const REAL_B = `REAL-CHATGPT-TOKEN-B-${randomBytes(16).toString("hex")}`;
const REAL_C = `REAL-CHATGPT-TOKEN-C-${randomBytes(16).toString("hex")}`;

/** The recorder: Windlass's two routes, a slow one for the caps, and what it saw. */
const UPSTREAM = `
const http = require("node:http");
const seen = [];
const event = (type, data) => "event: " + type + "\\ndata: " + JSON.stringify({ type, ...data }) + "\\n\\n";
http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (req.url === "/__seen") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(seen)); }
		seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
		if (body.includes("private-relay-check")) { res.writeHead(403); return res.end("refused"); }
		if (req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ models: [{ slug: "relay-model", display_name: "Relay model", visibility: "list" }] }));
		}
		const stream = /"stream":(\\d+)/.exec(body);
		if (stream) {
			// A long answer in 64 parts, 40 ms apart: what a streaming Responses call looks like to the relay.
			res.writeHead(200, { "content-type": "text/event-stream" });
			const part = "x".repeat(Math.floor(Number(stream[1]) * 1024 / 64));
			let n = 0;
			const next = () => {
				if (n++ === 64) return res.end(event("response.completed", { response: { output: [] } }));
				res.write(event("response.output_text.delta", { item_id: "i", output_index: 0, content_index: 0, delta: part }));
				setTimeout(next, 40);
			};
			return next();
		}
		const hold = /"hold":(\\d+)/.exec(body);
		setTimeout(() => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(event("response.created", { response: {} })
				+ event("response.output_item.done", { output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "From the relay." }] } })
				+ event("response.completed", { response: { output: [] } }));
		}, hold ? Number(hold[1]) : 0);
	});
}).listen(8080);`;

/** A request from inside the session, as a command could make one: node's fetch to the forwarder. */
const CLIENT = `
const [bearer, path, body, count] = process.argv.slice(1);
const one = () => fetch("http://127.0.0.1:17893" + path, { method: body ? "POST" : "GET", body: body || undefined,
	headers: { authorization: "Bearer " + bearer, "content-type": "application/json", cookie: "c=1" } })
	.then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 300) }), (e) => ({ status: 0, text: String(e.cause?.code ?? e) }));
Promise.all(Array.from({ length: Number(count || 1) }, (_, i) => new Promise((ok) => setTimeout(ok, i * 50)).then(one))).then((r) => console.log(JSON.stringify(r)));`;

/** Many streams at once from inside the session, each with a body of `pad` bytes: how many completed, and the bytes each got. */
const LOAD = `
const [bearer, count, pad, kb] = process.argv.slice(1);
const body = JSON.stringify({ stream: Number(kb), pad: "p".repeat(Number(pad)) });
async function one() {
	let status = 0, bytes = 0, tail = "";
	try {
		const r = await fetch("http://127.0.0.1:17893/v1/responses", { method: "POST", body, headers: { authorization: "Bearer " + bearer, "content-type": "application/json" } });
		status = r.status;
		for await (const chunk of r.body) {
			bytes += chunk.length;
			tail = (tail + Buffer.from(chunk).toString("latin1")).slice(-400);
		}
		return { status, bytes, done: tail.includes("response.completed") };
	} catch (e) {
		return { status, bytes, done: false, error: String(e.cause?.code ?? e) };
	}
}
Promise.all(Array.from({ length: Number(count) }, one)).then((r) => console.log(JSON.stringify(r)));`;

async function seen(): Promise<{ method: string; url: string; authorization: string | null; cookie: string | null }[]> {
	const out = await docker(
		[
			"exec",
			upstreamName,
			"node",
			"-e",
			"fetch('http://127.0.0.1:8080/__seen').then(r=>r.text()).then(t=>process.stdout.write(t))",
		],
		{ timeoutMs: 20_000 },
	);
	try {
		return JSON.parse(out.stdout);
	} catch {
		return [];
	}
}
async function request(
	box: DockerSandboxHandle,
	bearer: string,
	path: string,
	body = "",
	count = 1,
): Promise<{ status: number; text: string }[]> {
	const said = await box.ask(["node", "-e", CLIENT, bearer, path, body, String(count)], { timeoutMs: 60_000 });
	try {
		return JSON.parse(said?.stdout ?? "");
	} catch {
		return [{ status: -1, text: `${said?.stdout ?? ""} ${said?.stderr ?? ""}` }];
	}
}

const image = await imageId();
const cleanup: (() => Promise<unknown>)[] = [];
async function check() {
	const keyOnly = process.argv.includes("--hosted-keys");
	if (keyOnly) {
		config.modelRelay.url = { host: "relay.example.com", origin: "https://relay.example.com" };
		process.env.WLP_CODEX_IMAGE ??= image; // The stand-in below drives the CLI's relay from this container.
	}
	await docker(["network", "create", network], { check: true });
	cleanup.push(() => docker(["network", "rm", network]));
	await docker(
		["run", "-d", "--name", upstreamName, "--network", network, "--user", "agent", image, "node", "-e", UPSTREAM],
		{ check: true },
	);
	cleanup.push(() => docker(["rm", "-f", upstreamName]));
	const layer = createSandboxLayer({
		image,
		signIns: "memory",
		tokenNetwork: "none",
		modelRelay: {
			machine: keyOnly ? "" : scope,
			nameScope: scope,
			network,
			upstream: `http://${upstreamName}:8080`,
			limits: { sessionRequests: 2, sessionWaiting: 1, waitMs: 1500 },
		},
	});
	const relayName = `wlp-model-relay-${scope}`;
	cleanup.push(() => docker(["volume", "rm", "-f", `wlp-model-socket-${scope}`]));
	cleanup.push(() => docker(["rm", "-f", relayName]));
	const uid = `mrcheck${run}`;
	cleanup.push(() => docker(["volume", "rm", "-f", `wlp-user-${uid}`]));
	const make = async (session: string) => {
		const id = await layer.sandboxes.create({
			uid,
			sessionId: session,
			profile: "docker-hardened",
			...(keyOnly && { harness: "codex" }),
		});
		cleanup.push(() => layer.sandboxes.destroy(id));
		const box = (await layer.sandboxes.connect(id)) as DockerSandboxHandle | undefined;
		if (!box) throw new Error("the sandbox could not be connected");
		return box;
	};
	/** The access-token lease a runner opens for a machine's ChatGPT turn (runner/src/session.ts), on this layer's relay. */
	const machineStyle = (box: DockerSandboxHandle) =>
		Object.assign(Object.create(box) as DockerSandboxHandle & { modelRelay: () => Promise<DockerTurnRelay> }, {
			modelRelay: () => layer.modelRelay!.open(box.container, box.id, box.uid),
		});
	const a = machineStyle(await make("s-relay-a"));
	const b = machineStyle(await make("s-relay-b"));
	expect(
		"the hosted sandbox offers only its key and plan relay, no access-token relay",
		typeof a.modelKeyRelay === "function" && !Object.hasOwn(Object.getPrototypeOf(a), "modelRelay"),
	);
	const foreignSession = await openModelKeyRelay(a, "s-relay-b", {
		provider: "google",
		generation: "test",
		harness: "opencode",
	}).catch(error => error);
	expect(
		"a Docker key relay refuses another sandbox's session",
		foreignSession instanceof Error && /another session/.test(foreignSession.message),
	);

	if (keyOnly) {
		const key = { provider: "openai", generation: "fixture", harness: "codex" } as const;
		const own = await openModelKeyRelay(a, "s-relay-a", key);
		cleanup.push(own.close);
		const other = await openModelKeyRelay(b, "s-relay-b", key);
		cleanup.push(other.close);
		const status = async (box: DockerSandboxHandle, bearer: string) => {
			const reply = await box.ask([
				"node",
				"-e",
				"fetch(process.argv[1] + '/models', {headers:{authorization:'Bearer ' + process.argv[2]}}).then(r=>console.log(r.status))",
				own.env.WINDLASS_MODEL_BASE_URL!,
				bearer,
			]);
			return Number(reply?.stdout.trim());
		};
		assert.equal(await status(a, own.placeholder), 200);
		assert.equal(await status(b, own.placeholder), 401);
		assert.equal(await status(b, other.placeholder), 200);
		assert.equal((await seen()).length, 2);
		expect("each hosted Docker forwarder accepts only its own container’s Settings-key lease", true);
		return;
	}

	// Due for replacement 4 s in, and tried every 500 ms from then: while the source gives the same token, nothing changes.
	let next: AccessToken = { accessToken: REAL_A, expiresAt: Date.now() + 30 * 60_000 };
	const tokens = { current: async () => next };
	const fileA = new TokenFile(a, tokens as never, { leadMs: 30 * 60_000 - 4_000, retryMs: 500, log: () => {} });
	await fileA.start();
	const fileB = new TokenFile(
		b,
		{ current: async () => ({ accessToken: REAL_C, expiresAt: Date.now() + 3_600_000 }) } as never,
		{ log: () => {} },
	);
	await fileB.start();
	const placeholderA = JSON.parse((await a.ask(["cat", fileA.path]))?.stdout ?? "{}").accessToken as string;
	const placeholderB = JSON.parse((await b.ask(["cat", fileB.path]))?.stdout ?? "{}").accessToken as string;
	expect(
		"the session's token file holds a placeholder, not the token",
		/^wlp-model\.[a-f0-9]{32}$/.test(placeholderA) && placeholderA !== placeholderB,
		placeholderA,
	);
	const named = await docker(
		["exec", relayName, "sh", "-c", `grep -l '"user":"${uid}"' /run/wlp-model/tokens/*.json | wc -l`],
		{ timeoutMs: 20_000 },
	);
	expect(
		"each turn's file in the relay names its user, which the relay's ceiling per user counts by",
		named.stdout.trim() === "2",
		named.stdout + named.stderr,
	);

	// 2. A process left over from setup, out of every sweep, copying every token file it can find.
	await a.run(
		`setsid env -i /bin/sh -c 'while :; do cat /dev/shm/access-token-*.json ${DATA_DIR}/access-token-*.json >> /tmp/.stolen 2>/dev/null; echo >> /tmp/.stolen; sleep 0.2; done' </dev/null >/dev/null 2>&1 &`,
	);

	// 1. What a command can read, as the user Windlass runs as: printed whole and searched here, so the token is on no command line in the session.
	const scan = await a.run(
		[
			`for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do cat "$f" 2>/dev/null; echo; done`,
			`find /dev/shm ${DATA_DIR} /tmp /workspace /home/agent /run /var/tmp -xdev -type f -readable -size -2M -exec cat {} + 2>/dev/null; true`,
		].join("\n"),
		{ timeoutMs: 60_000 },
	);
	expect(
		"no file, no process environment and no command line in the session holds the real token",
		scan.exitCode === 0 &&
			scan.stdout.length < 4_000_000 &&
			scan.stdout.includes(placeholderA) &&
			!scan.stdout.includes(REAL_A),
		`${scan.stdout.length} bytes, exit ${scan.exitCode}`,
	);

	// 3. Real Windlass, through the relay.
	const env = { WINDLASS_ACCESS_TOKEN_FILE: fileA.path, ...fileA.env };
	const models = await a.run("windlass --models", { env, timeoutMs: 120_000 });
	expect(
		"the image's Windlass lists the models through the relay",
		models.exitCode === 0 && models.stdout.includes("relay-model"),
		models.stdout + models.stderr,
	);
	const answered = await a.run('windlass -m relay-model "Please answer."', { env, timeoutMs: 120_000 });
	expect(
		"the image's Windlass answers a prompt through the relay",
		answered.exitCode === 0 && answered.stdout.includes("From the relay."),
		answered.stdout + answered.stderr,
	);
	const afterWindlass = await seen();
	expect(
		"the upstream got Windlass's requests with the real token, never the placeholder or the session's cookies",
		afterWindlass.some(s => s.url === "/v1/models") &&
			afterWindlass.some(s => s.url === "/v1/responses") &&
			afterWindlass.every(s => s.authorization === `Bearer ${REAL_A}` && s.cookie === null),
		JSON.stringify(afterWindlass.map(s => [s.url, s.authorization?.slice(0, 30)])),
	);

	// 4a. Refresh while a request streams.
	const streaming = request(a, placeholderA, "/v1/responses", '{"hold":4000}');
	await sleep(800);
	expect("nothing was replaced while the source gave the same token", fileA.replaced === 0);
	next = { accessToken: REAL_B, expiresAt: Date.now() + 60 * 60_000 };
	for (let i = 0; i < 60 && fileA.replaced === 0; i++) await sleep(250);
	expect("the turn's token was replaced while it ran", fileA.replaced === 1);
	const afterRefresh = await request(a, placeholderA, "/v1/models");
	const streamed = await streaming;
	const log = await seen();
	expect(
		"the request that streamed through the replacement finished, and the next one carried the new token",
		streamed[0]?.status === 200 && afterRefresh[0]?.status === 200 && log.at(-1)?.authorization === `Bearer ${REAL_B}`,
		JSON.stringify({ streamed, afterRefresh }),
	);
	const stolen = (await a.run("cat /tmp/.stolen; pkill -f '.stolen' || true")).stdout;
	expect(
		"the leftover process collected only the placeholder, before and after the replacement",
		stolen.includes(placeholderA) && !stolen.includes(REAL_A) && !stolen.includes(REAL_B),
		stolen.slice(0, 300),
	);

	// 4b. Another turn's placeholder on this turn's forwarder, and the real token as a bearer.
	const foreign = await request(a, placeholderB, "/v1/models");
	const bare = await request(a, REAL_B, "/v1/models");
	const own = await request(b, placeholderB, "/v1/models");
	expect(
		"another session's placeholder and the real token itself are refused on this session's forwarder; the other session's works on its own",
		foreign[0]?.status === 401 &&
			bare[0]?.status === 401 &&
			own[0]?.status === 200 &&
			(await seen()).at(-1)?.authorization === `Bearer ${REAL_C}`,
		JSON.stringify({ foreign, bare, own }),
	);
	const wrong = await request(a, placeholderA, "/v1/chat/completions", "{}");
	expect("anything but Windlass's two routes is refused", wrong[0]?.status === 403, JSON.stringify(wrong));

	// 4c. The caps (2 in flight per turn, 1 waiting, 1.5 s wait): of five slow requests two run, one waits, two are refused.
	const capped = await request(a, placeholderA, "/v1/responses", '{"hold":2500}', 5);
	const statuses = capped.map(r => r.status).sort();
	expect(
		"the relay's caps hold: past them a request waits, then is refused with the session's ceiling named",
		statuses.filter(s => s === 200).length === 2 &&
			statuses.filter(s => s === 503).length === 3 &&
			capped.some(r => /from this session/.test(r.text)),
		JSON.stringify(capped),
	);

	// 4d. Inspect a diagnostic from the scoped relay through Docker's actual log driver.
	await request(a, placeholderA, "/v1/responses", '{"input":"private-relay-check"}');
	const inspected = await docker(["inspect", relayName], { timeoutMs: 20_000 });
	const logging = JSON.parse(inspected.stdout)[0].HostConfig.LogConfig;
	const logs = await docker(["logs", relayName], { timeoutMs: 20_000 });
	const output = logs.stdout + logs.stderr;
	expect(
		"the scoped relay rotates two 4 MiB Docker logs",
		logging.Type === "json-file" && logging.Config["max-size"] === "4m" && logging.Config["max-file"] === "2",
	);
	expect("docker logs includes the refused request's status", logs.code === 0 && output.includes("upstream=403"));
	expect(
		"relay diagnostics and configuration omit the request body and credentials",
		[REAL_A, REAL_B, REAL_C, placeholderA, placeholderB, "private-relay-check"].every(
			value => !output.includes(value) && !inspected.stdout.includes(value),
		),
	);

	// 4e. After the turn.
	await fileA.stop();
	const ended = await request(a, placeholderA, "/v1/models");
	const left = await docker(["exec", relayName, "sh", "-c", "ls /run/wlp-model/tokens | wc -l"], { timeoutMs: 20_000 });
	const forwarder = await docker(["container", "inspect", `wlp-model-fwd-${a.id}`], { timeoutMs: 20_000 });
	expect(
		"after the turn its forwarder is gone, and the relay holds only the other turn's token",
		ended[0]?.status === 0 && forwarder.code !== 0 && left.stdout.trim() === "1",
		JSON.stringify({ ended, left: left.stdout, forwarder: forwarder.code }),
	);
	await fileB.stop();
	const none = await docker(["exec", relayName, "sh", "-c", "ls /run/wlp-model/tokens | wc -l"], { timeoutMs: 20_000 });
	expect("when the last turn ends the relay holds no token", none.stdout.trim() === "0", none.stdout);
	// A sandbox that is stopped takes a forwarder left by a turn cut off with its server with it.
	const fileC = new TokenFile(
		b,
		{ current: async () => ({ accessToken: REAL_C, expiresAt: Date.now() + 3_600_000 }) } as never,
		{ log: () => {} },
	);
	await fileC.start();
	await layer.sandboxes.suspend(b.id);
	const afterSuspend = await docker(["exec", relayName, "sh", "-c", "ls /run/wlp-model/tokens | wc -l"], {
		timeoutMs: 20_000,
	});
	expect(
		"suspending a sandbox removes its forwarder and its turn's file in the relay",
		(await docker(["container", "inspect", `wlp-model-fwd-${b.id}`])).code !== 0 && afterSuspend.stdout.trim() === "0",
		afterSuspend.stdout,
	);
	await fileC.stop();

	// 5a. The end of a turn stops its request still streaming, at once and not when it would have finished.
	const fileD = new TokenFile(
		a,
		{ current: async () => ({ accessToken: REAL_A, expiresAt: Date.now() + 3_600_000 }) } as never,
		{ log: () => {} },
	);
	await fileD.start();
	const placeholderD = JSON.parse((await a.ask(["cat", fileD.path]))?.stdout ?? "{}").accessToken as string;
	const started = Date.now();
	const long = request(a, placeholderD, "/v1/responses", '{"hold":20000}');
	await sleep(1500);
	await fileD.stop();
	const cut = await long;
	expect(
		"ending a turn stops its request still running, long before the provider would have answered",
		cut[0]?.status !== 200 && Date.now() - started < 12_000,
		JSON.stringify({ cut, ms: Date.now() - started }),
	);

	// 5b. A process of the session that took 127.0.0.1:17893 first: the forwarder cannot listen, and the turn fails with nothing handed.
	// What listens on 17893 (0x45E5): said when the case fails.
	const listeners = async () =>
		(
			await a.ask(["sh", "-c", "grep -i ':45E5 ' /proc/net/tcp | awk '$4==\"0A\"{print $2, $10}'"], {
				timeoutMs: 15_000,
			})
		)?.stdout
			.trim()
			.replace(/\s+/g, " ") ?? "";
	const before = await listeners();
	// Started as the agent the way a process left from setup lives on: outside every command the platform runs.
	const SQUAT = `require("node:fs").writeFileSync("/tmp/.squat.pid", String(process.pid)); require("node:net").createServer((s) => s.end("HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\n\\r\\nok")).listen(17893, "127.0.0.1"); setTimeout(() => process.exit(0), 60_000);`;
	await docker(["exec", "-d", "-u", "agent", a.container, "node", "-e", SQUAT], { timeoutMs: 20_000, check: true });
	let squatterUp = "";
	for (let i = 0; i < 40 && !squatterUp.includes("0100007F:45E5"); i++) {
		squatterUp = await listeners();
		if (!squatterUp.includes("0100007F:45E5")) await sleep(250);
	}
	expect(
		"a session process holds 127.0.0.1:17893 before the turn starts",
		squatterUp.includes("0100007F:45E5"),
		`before: ${before} | after: ${squatterUp}`,
	);
	// The sandbox's token file is per sandbox: the last turn's placeholder is still there. This turn must change nothing in it.
	const fileBefore = (await a.ask(["sh", "-c", `cat ${fileD.path} 2>/dev/null || echo NONE`]))?.stdout ?? "";
	const handedE: string[] = [];
	const fileE = new TokenFile(
		a,
		{
			current: async () => {
				handedE.push("asked");
				return { accessToken: REAL_A, expiresAt: Date.now() + 3_600_000 };
			},
		} as never,
		{ log: () => {} },
	);
	const squatted = await fileE.start().then(
		() => null,
		(e: unknown) => e,
	);
	const duringE = await listeners();
	const forwarderE = (
		await docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", `wlp-model-fwd-${a.id}`])
	).stdout.trim();
	const tokenFileE = await a.ask(["sh", "-c", `cat ${fileE.path} 2>/dev/null || echo NONE`]);
	expect(
		"a session process holding the relay's port fails the turn with a clear message, and nothing is handed to it",
		squatted instanceof Error &&
			/holding that port|could not take/.test(String(squatted)) &&
			(await docker(["container", "inspect", `wlp-model-fwd-${a.id}`])).code !== 0 &&
			tokenFileE?.stdout === fileBefore &&
			!fileBefore.includes(REAL_A),
		`${String(squatted)} | before: ${before} | squatter: ${squatterUp} | after the turn's start: ${duringE} | forwarder: ${forwarderE || "none"}`,
	);
	await fileE.stop();
	await a.ask(["sh", "-c", 'kill "$(cat /tmp/.squat.pid)" 2>/dev/null; rm -f /tmp/.squat.pid; sleep 0.3'], {
		timeoutMs: 15_000,
	});

	// 5c. What a server that died left: a forwarder, and the turn's file in the relay. The next server's preparation removes both.
	const fileF = new TokenFile(
		a,
		{ current: async () => ({ accessToken: REAL_A, expiresAt: Date.now() + 3_600_000 }) } as never,
		{ log: () => {} },
	);
	await fileF.start();
	const nextServer = createSandboxLayer({
		image,
		signIns: "memory",
		tokenNetwork: "none",
		modelRelay: {
			machine: keyOnly ? "" : scope,
			nameScope: scope,
			network,
			upstream: `http://${upstreamName}:8080`,
			limits: { sessionRequests: 2, sessionWaiting: 1, waitMs: 1500 },
		},
	});
	const prepared = await nextServer.sandboxes.prepareModelRelay!();
	const leftFiles = await docker(["exec", relayName, "sh", "-c", "ls /run/wlp-model/tokens | wc -l"], {
		timeoutMs: 20_000,
	});
	expect(
		"a server that starts removes the forwarders and token files a server that died left",
		/removed 1 forwarder/.test(prepared) &&
			(await docker(["container", "inspect", `wlp-model-fwd-${a.id}`])).code !== 0 &&
			leftFiles.stdout.trim() === "0",
		prepared + " / " + leftFiles.stdout,
	);
	await fileF.stop();

	// 5b. A machine's plan relay (`openPlan`, `plan-relay`): a container of its own for the turn, the token only on its
	// standard input, the session's forwarder on 127.0.0.1:17893 to its socket, and everything gone at close.
	const p = await make("s-plan");
	const PLAN_A = `REAL-PLAN-TOKEN-A-${randomBytes(16).toString("hex")}`;
	const PLAN_B = `REAL-PLAN-TOKEN-B-${randomBytes(16).toString("hex")}`;
	const planName = `wlp-plan-relay-${p.id}`;
	cleanup.push(() => docker(["rm", "-f", planName]));
	const plan = await layer.modelRelay!.openPlan(p.container, p.id, PLAN_A, {
		wire: "chatgpt-plan",
		harness: "windlass",
		expiresAt: Date.now() + 5 * 60_000,
	});
	cleanup.push(() => plan.close());
	const [planned] = await request(p, plan.placeholder, "/v1/models");
	expect(
		"a plan turn's request on a machine leaves from its relay with the plan's token",
		planned?.status === 200 && (await seen()).at(-1)?.authorization === `Bearer ${PLAN_A}`,
		JSON.stringify(planned),
	);
	expect("the plan relay refuses another bearer", (await request(p, PLAN_A, "/v1/models"))[0]?.status === 401);
	const planInspected = await docker(["container", "inspect", planName], { timeoutMs: 20_000 });
	const onDisk = await docker(
		[
			"exec",
			planName,
			"sh",
			"-c",
			'grep -rlsF -- "$1" /workspace /tmp /proc/1/environ /proc/1/cmdline; true',
			"sh",
			PLAN_A,
		],
		{ timeoutMs: 20_000 },
	);
	const inSession = await p.ask(
		["sh", "-c", 'grep -rlsF -- "$1" /dev/shm /workspace /tmp /proc/*/environ; true', "sh", PLAN_A],
		{ timeoutMs: 30_000 },
	);
	expect(
		"the plan's token is in no file, argument or environment of the relay container, nor anywhere in the session",
		planInspected.code === 0 &&
			!planInspected.stdout.includes(PLAN_A) &&
			onDisk.code === 0 &&
			onDisk.stdout.trim() === "" &&
			inSession?.code === 0 &&
			inSession.stdout.trim() === "",
		`inspect ${planInspected.code}, relay: ${onDisk.stdout}, session: ${inSession?.stdout}`,
	);
	await plan.hand(PLAN_B);
	await request(p, plan.placeholder, "/v1/models");
	expect("a token handed later is the next request's", (await seen()).at(-1)?.authorization === `Bearer ${PLAN_B}`);
	await plan.close();
	const afterClose = await request(p, plan.placeholder, "/v1/models");
	expect(
		"closing the plan relay removes its container and forwarder, and the session reaches nothing on 17893",
		(await docker(["container", "inspect", planName])).code !== 0 &&
			(await docker(["container", "inspect", `wlp-model-fwd-${p.id}`])).code !== 0 &&
			afterClose[0]?.status === 0,
		JSON.stringify(afterClose),
	);

	// 6. 64 streams at once through a relay of the hosted relay's memory, one session's forwarder carrying all of them.
	const loadScope = `${scope}l`;
	const load = new DockerModelRelay({
		machine: loadScope,
		image,
		network,
		upstream: `http://${upstreamName}:8080`,
		requests: 64,
		limits: { sessionRequests: 64, sessionConnections: 80, sessionWaiting: 64, waitMs: 60_000 },
	});
	cleanup.push(() => docker(["volume", "rm", "-f", `wlp-model-socket-${loadScope}`]));
	cleanup.push(() => docker(["rm", "-f", `wlp-model-relay-${loadScope}`]));
	const leaseL = await load.open(a.container, a.id, uid);
	cleanup.push(() => leaseL.close());
	await leaseL.hand({ accessToken: REAL_A, expiresAt: Date.now() + 3_600_000 });
	const loadRelay = `wlp-model-relay-${loadScope}`;
	const loadStart = Date.now();
	const said = await a.ask(["node", "-e", LOAD, leaseL.placeholder, "64", String(1024 * 1024), "2048"], {
		timeoutMs: 300_000,
	});
	let results: { status: number; bytes: number; done: boolean; error?: string }[] = [];
	try {
		results = JSON.parse(said?.stdout ?? "[]");
	} catch {
		/* reported below */
	}
	const peak = await docker(
		[
			"exec",
			loadRelay,
			"sh",
			"-c",
			"cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes",
		],
		{ timeoutMs: 20_000 },
	);
	const state = await docker(
		["inspect", "--format", "{{.State.Running}}|{{.State.OOMKilled}}|{{.HostConfig.Memory}}", loadRelay],
		{ timeoutMs: 20_000 },
	);
	const peakMiB = Math.round(Number(peak.stdout.trim()) / 2 ** 20);
	const limitMiB = Math.round(Number(state.stdout.trim().split("|")[2]) / 2 ** 20);
	console.log(
		`      64 streams: ${Date.now() - loadStart} ms, relay memory peak ${peakMiB} MiB of ${limitMiB} MiB (${RELAY_MEMORY})`,
	);
	const incomplete = results.filter(r => r.status !== 200 || !r.done || r.bytes <= 2 * 1024 * 1024);
	const passed =
		said?.code === 0 &&
		results.length === 64 &&
		incomplete.length === 0 &&
		state.stdout.trim().startsWith("true|false|") &&
		peakMiB > 0 &&
		peakMiB < limitMiB;
	let details = "";
	if (!passed) {
		const forwarder = await docker(
			[
				"inspect",
				"--format",
				"{{.State.Status}} OOMKilled={{.State.OOMKilled}} exit={{.State.ExitCode}}",
				load.forwarderName(a.id),
			],
			{ timeoutMs: 20_000 },
		);
		details = JSON.stringify({
			results: results.length,
			incomplete: incomplete.length,
			firstFailure: incomplete[0],
			peakMiB,
			limitMiB,
			relay: state.stdout.trim(),
			forwarder: (forwarder.stdout || forwarder.stderr).trim(),
			clientExit: said?.code,
			stderr: said?.stderr.slice(-1000),
		});
	}
	expect(
		"64 streams at once with 1 MiB bodies and 2 MiB answers all complete through a relay of the hosted relay's memory, which is not killed",
		passed,
		details,
	);
}
try {
	await check();
} catch (error) {
	failed += 1;
	console.log(`FAIL  the check could not run: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
	// Last made, first removed: a container goes before the network and volumes it uses.
	for (const step of cleanup.reverse()) await step().catch(() => undefined);
}
console.log(failed === 0 ? "\nall model relay Docker checks passed" : `\n${failed} model relay Docker check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
