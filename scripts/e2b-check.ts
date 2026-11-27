/**
 * The check of the E2B provider against the real service. It is the first thing that runs anything at
 * E2B, and it answers what cannot be known without an account: whether the template works, whether
 * Windlass's bubblewrap sandbox works inside an E2B microVM, and how pause and resume really behave.
 *
 *   cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-check.ts
 *
 * Build the template first (sandbox/e2b/build.sh). What this does, with one sandbox and no more:
 *
 *   1. creates one sandbox through the provider (so with its metadata, its short timeout, its cap of 1);
 *   2. looks at it: user, workspace, architecture, kernel, the Windlass in the template;
 *   3. runs Windlass's own start-up probe of bubblewrap, and says what the E2B profile may promise;
 *   4. runs one scripted (demo) turn: Windlass's real engine and real tool calls with a scripted model,
 *      so no model is called, no sign-in is needed and no token exists anywhere in this script;
 *   5. tries the things the provider assumes of E2B: a command's standard input, a stop that reaches the
 *      process, a file only its owner can read, the timeout being pushed out and set back;
 *   6. pauses the sandbox, resumes it, and runs a second turn that continues the first one's Windlass
 *      session from the microVM's own disk;
 *   7. destroys it;
 *   8. with WLP_E2B_CHECK_NETWORK=1, the network modes (server/src/sandbox/e2b/network.ts): one short sandbox
 *      in `restricted` and then one in `none`, never two at once, no turn in either. In each: the platform's
 *      own clone of a public repository (github.com), the model API, a host that is not allowed (by name,
 *      by address, over plain HTTP), a lookup, and what 169.254.169.254 answers. `restricted` is paused and
 *      resumed once to see the configuration and the names hold; then its lookup stub must name the host that
 *      was refused, and a host allowed while it runs (a repository's list) must be reached at once.
 *      With WLP_MODEL_RELAY_URL and WLP_E2B_WINDLASS_VERSION=0.7.1 set as on the servers, the model
 *      relay's network instead (docs/model-relay.md): api.openai.com is not reached, the relay's own
 *      hostname is, and answers a placeholder of no turn with `relay_lease_ended` (so the hostname must be
 *      routed to a server of this version), and WLP_PUBLIC_URL's host, when set, is not reached.
 *
 * Limits on itself:
 *
 *   - it refuses to start without E2B_API_KEY, and reads nothing else that is secret;
 *   - it has a hard limit on its own running time (WLP_E2B_CHECK_LIMIT_MS, default and at most six
 *     minutes): when that is reached it stops where it is, removes its sandbox and exits 3;
 *   - whatever happens, `finally` kills every sandbox that carries this run's own deployment label,
 *     which no other sandbox carries;
 *   - should the process itself be killed, the sandbox's own timeout pauses it within three minutes,
 *     and the line printed first says how to remove it;
 *   - at the end it prints how many seconds its sandbox ran and what that costs by E2B's published
 *     prices: an estimate, a few tenths of a cent.
 *
 * Exit code 0 when every check passed, 1 when one failed, 2 without a key, 3 at the time limit.
 */

import type { WindlassEvent } from "../server/src/contract.js";
import type { AccessTokens, ChatgptLogins, RunTurnResult, ScriptedModel, TurnQuestion } from "../server/src/sandbox/api.js";
import { cleanupDeployment } from "../server/src/sandbox/e2b/cleanup.js";
import type { E2bClient, E2bSandboxInfo } from "../server/src/sandbox/e2b/client.js";
import { readE2bSettings } from "../server/src/sandbox/e2b/config.js";
import { e2bModelRelay, readE2bNetwork } from "../server/src/sandbox/e2b/network.js";
import { cloneWithToken } from "../server/src/github/git.js";
import { describeUsage } from "../server/src/sandbox/e2b/pricing.js";
import { type E2bSandboxHandle, e2bSandboxes, META } from "../server/src/sandbox/e2b/sandboxes.js";
import { BWRAP_PROBE } from "../server/src/sandbox/provider.js";
import { DATA_DIR, randomId } from "../server/src/sandbox/provider.js";
import { oneLine, Report } from "./check-report.js";

const MAX_LIMIT_MS = 6 * 60_000;
const startedAt = Date.now();
const tally = new Report();
const { expect, pass, fail } = tally;
/** Something the owner should read that is neither right nor wrong: what E2B turned out to do. */
function info(text: string): void {
	console.log(`INFO  ${oneLine(text)}`);
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function step(name: string, body: () => Promise<void>): Promise<void> {
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		fail(`${name}: unexpected error`, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
}

type Response = ScriptedModel["responses"][number];
const say = (text: string): Response => [{ type: "text", text }, { type: "finish", reason: "stop" }];
const shell = (callId: string, command: string): Response => [{ type: "tool_call", callId, name: "shell", input: { command } }, { type: "finish", reason: "tool_calls" }];

async function main(): Promise<number> {
	const apiKey = (process.env.E2B_API_KEY ?? "").trim();
	if (apiKey === "") {
		console.error("e2b-check: E2B_API_KEY is not set, so nothing was done. This check runs one sandbox at E2B for a minute or two; give it the API key of the account that has the template (sandbox/e2b/build.sh).");
		return 2;
	}
	const asked = Number.parseInt(process.env.WLP_E2B_CHECK_LIMIT_MS ?? "", 10);
	const limitMs = Number.isFinite(asked) && asked >= 60_000 ? Math.min(asked, MAX_LIMIT_MS) : MAX_LIMIT_MS;
	// A label no other sandbox has: everything this run makes, and nothing else, is found by it.
	const deployment = `check-${randomId(4)}`;
	const settings = { ...readE2bSettings(), deployment, maxRunning: 1, pause: true, windlassSandbox: false, openProfile: false };
	console.log(`e2b-check: template "${settings.templates.small.template}", deployment label "${deployment}", time limit ${Math.round(limitMs / 1000)} s.`);
	console.log(`e2b-check: should this process be killed, its sandbox is paused by its own timeout within ${Math.round(settings.turnLeaseMs / 1000)} s; remove it with: npx tsx ../scripts/e2b-cleanup.ts --deployment ${deployment} --kill`);

	// E2B's SDK is loaded here and not before: without a key nothing of it is needed.
	const { createE2bSdkClient } = await import("../server/src/sandbox/e2b/sdk.js");
	const { createE2bSandboxLayer } = await import("../server/src/sandbox/e2b/index.js");
	const client: E2bClient = createE2bSdkClient(apiKey);
	const logLines: string[] = [];
	// No sign-in and no token exist here: every turn is scripted, and a turn that asked for a token would fail the check.
	const tokens: AccessTokens = {
		current: async () => {
			throw new Error("the E2B check hands out no access token: its turns are scripted");
		},
	};
	const layer = createE2bSandboxLayer({ logins: {} as ChatgptLogins, tokens }, { client, settings, log: (line) => (logLines.push(line), console.log(`      ${line}`)) });

	/** How long this run's sandbox has been running, added up over its stretches: what E2B bills by. */
	const usage = { ms: 0, since: null as number | null, cpuCount: 0, memoryMB: 0 };
	const runs = () => (usage.since = Date.now());
	const stops = () => {
		if (usage.since !== null) usage.ms += Date.now() - usage.since;
		usage.since = null;
	};

	let timedOut = false;
	let giveUp: () => void = () => {};
	const limit = new Promise<"limit">((resolve) => (giveUp = () => resolve("limit")));
	const timer = setTimeout(() => {
		timedOut = true;
		giveUp();
	}, limitMs);

	const turn = async (handle: E2bSandboxHandle, prompt: string, script: ScriptedModel, windlassSessionId?: string) => {
		const events: WindlassEvent[] = [];
		const questions: TurnQuestion[] = [];
		const began = Date.now();
		const result: RunTurnResult = await layer.windlass.runTurn(handle, {
			prompt,
			script,
			windlassSessionId,
			onEvent: (event) => events.push(event),
			// What Windlass asks about is allowed once: these turns run what this file wrote. That it asked is what is reported.
			onQuestion: async (question) => (questions.push(question), { choice: question.choices.find((choice) => choice.approve)?.id ?? question.choices[0]?.id ?? "" }),
		});
		return { result, events, questions, ms: Date.now() - began, outcome: (result.summary as { outcome?: string } | null)?.outcome };
	};

	const work = async (): Promise<void> => {
		let id = "";
		let handle: E2bSandboxHandle | undefined;
		let session: string | null = null;
		let created: E2bSandboxInfo | undefined;

		await step("create", async () => {
			const began = Date.now();
			id = await layer.sandboxes.create({ uid: "e2b-check", sessionId: `check-${deployment}`, profile: "e2b" });
			runs();
			pass("a sandbox is created from the template, and its workspace is set up", `${id} in ${Date.now() - began} ms`);
			created = await client.info(id);
			usage.cpuCount = created?.cpuCount ?? 0;
			usage.memoryMB = created?.memoryMB ?? 0;
			expect("E2B knows it as running, with this run's metadata", created?.state === "running" && created.metadata[META.deployment] === deployment && created.metadata[META.uid] === "e2b-check" && created.metadata[META.profile] === "e2b", JSON.stringify(created?.metadata));
			info(`size: ${created?.cpuCount} vCPU, ${created?.memoryMB} MiB (the template's). startedAt ${new Date(created?.startedAt ?? 0).toISOString()}, endAt ${new Date(created?.endAt ?? 0).toISOString()}`);
			const timeout = (created?.endAt ?? 0) - (created?.startedAt ?? 0);
			expect("its own timeout is the short one the provider asked for", Math.abs(timeout - settings.idleTimeoutMs) < 15_000, `${Math.round(timeout / 1000)} s, asked for ${settings.idleTimeoutMs / 1000} s`);
			const listed = await client.list({ metadata: { [META.deployment]: deployment }, state: ["running"] });
			expect("E2B's list finds it by its metadata, and nothing else", listed.length === 1 && listed[0]?.sandboxId === id, `${listed.length} listed`);
			const second = await layer.sandboxes.create({ uid: "e2b-check", sessionId: "one-too-many", profile: "e2b" }).then(
				(extra) => `created ${extra}`,
				(error: unknown) => messageOf(error),
			);
			expect("with the cap at 1, a second sandbox is refused before anything is created", /at most 1 sandbox at the same time/.test(second), second);
			handle = (await layer.sandboxes.connect(id)) as E2bSandboxHandle | undefined;
			expect("connect() gives a handle on it", handle !== undefined);
		});
		if (handle === undefined || timedOut) return;
		const box = handle;

		await step("the template", async () => {
			const facts = await box.run("whoami; pwd; uname -m; uname -r; echo \"$LANG $NO_COLOR\"; git log --oneline | wc -l; stat -c '%a %U' " + DATA_DIR + "; command -v wlp-run bwrap git rg python3 node | wc -l");
			const [who, cwd, machine, kernel, env, commits, dataDir, tools] = facts.stdout.trim().split("\n").map((line) => line.trim());
			expect("commands run as agent in /workspace, with the environment the image gives a container", who === "agent" && cwd === "/workspace" && env === "C.UTF-8 1", `${who} ${cwd} "${env}"`);
			expect("the workspace is an empty git repository with one commit", commits === "1", `${commits} commit(s)`);
			expect("Windlass's data directory is the agent's own, closed to others", dataDir === "700 agent", dataDir);
			expect("the tools of the Docker image are there", tools === "6", `${tools} of 6`);
			info(`architecture ${machine}, kernel ${kernel}`);
			const version = await layer.windlass.version();
			expect("the Windlass in the template answers, and its version is known to the layer from here on", version !== null && /^\d+\.\d+\.\d+/.test(version), String(version));
			const login = await box.ask(["windlass", "login", "status"], { env: { WINDLASS_ACCESS_TOKEN_FILE: "/nonexistent/wlp-probe" }, timeoutMs: 20_000 });
			expect("that Windlass reads a handed-in access token (it names the variable)", login !== null && login.stdout.includes("WINDLASS_ACCESS_TOKEN_FILE"), `exit ${login?.code}: ${login?.stdout.trim().slice(0, 200)}`);
			const odd = ["a b", "it's", "$HOME", 'x"y', "`uname`", "", "é✓", "a\nb", "*", "; echo no"];
			const echoed = await box.exec(["printf", "[%s]", ...odd]);
			expect("an argument reaches a command as it was given, whatever is in it", echoed.exitCode === 0 && echoed.stdout === odd.map((item) => `[${item}]`).join(""), echoed.stdout);
		});
		if (timedOut) return;

		await step("bubblewrap", async () => {
			const probe = await box.ask(BWRAP_PROBE, { timeoutMs: 20_000 });
			const works = probe !== null && probe.code === 0;
			if (works) {
				pass("Windlass's start-up probe of bubblewrap passes inside the microVM");
				info("ANSWER: bubblewrap works here. The E2B profile may promise Windlass's sandbox: set WLP_E2B_WINDLASS_SANDBOX=1 on the servers (every new sandbox is then held to it).");
			} else {
				info(`ANSWER: bubblewrap does NOT work here (${probe === null ? "the probe could not be run" : `exit ${probe.code}: ${probe.stderr.trim().slice(0, 400)}`}). Leave WLP_E2B_WINDLASS_SANDBOX unset: the profile promises nothing of Windlass's sandbox, and Windlass asks before every command.`);
			}
			const user = await box.run("cat /proc/sys/user/max_user_namespaces 2>/dev/null; cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null; cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null; true");
			info(`user namespaces: max ${user.stdout.trim().split("\n").join(", ") || "unknown"}`);
		});
		if (timedOut) return;

		await step("a scripted turn", async () => {
			const before = await client.info(id);
			let during: E2bSandboxInfo | undefined;
			const watching = setTimeout(() => void client.info(id).then((found) => (during = found)), 2_500);
			const first = await turn(box, "Write a small script and run it", { responses: [shell("write", "printf 'echo from-the-script\\n' > hello.sh && sh hello.sh"), shell("wait", "sleep 4; wc -l < hello.sh"), say("Done.")] });
			clearTimeout(watching);
			const outputs = first.events.filter((event) => event.type === "tool.settled").map((event) => String((event.data as { output?: unknown } | undefined)?.output ?? ""));
			expect(
				"a scripted turn runs to its end: Windlass's engine, two real tool calls, the summary",
				first.outcome === "succeeded" && first.result.exitCode === 0 && first.result.failure === null && outputs.some((output) => output.includes("from-the-script")) && first.events.at(-1)?.type === "cli.summary",
				`${first.outcome}, exit ${first.result.exitCode}, ${first.events.length} events in ${first.ms} ms; ${first.result.failure?.message ?? ""} ${first.result.stderrTail.slice(-300)}`,
			);
			session = first.result.windlassSessionId;
			info(`Windlass asked ${first.questions.length} question(s) in this turn${first.questions.length === 0 ? ": its sandbox ran the commands" : `: ${first.questions.map((question) => question.title).join("; ")}. It asks before a command it cannot sandbox`}`);
			const after = await client.info(id);
			expect(
				"while the turn ran, the sandbox's timeout was the turn's lease, and afterwards it is the short one again",
				during !== undefined && during.endAt > (before?.endAt ?? 0) - 1_000 && after !== undefined && Math.abs(after.endAt - Date.now() - settings.idleTimeoutMs) < 20_000,
				`before ${new Date(before?.endAt ?? 0).toISOString()}, during ${during === undefined ? "not seen" : new Date(during.endAt).toISOString()}, after ${new Date(after?.endAt ?? 0).toISOString()}`,
			);
			const left = await box.run(`ls /tmp/.wlp-script-* 2>/dev/null | wc -l; ls ${DATA_DIR} | grep -c access-token; ps -eo args= | grep -c '[w]indlass acp'`);
			expect("the turn left no script file, no token file and no engine behind", left.stdout.trim().split(/\s+/).join(" ") === "0 0 0", left.stdout.trim());
			const memory = await box.run("free -m | sed -n 2p; cat /sys/fs/cgroup/memory.peak 2>/dev/null; true");
			info(`memory after the turn (free -m: total used free shared buff/cache available): ${memory.stdout.trim().split("\n").join(" | ")}. This is what a smaller WLP_E2B_MEMORY_MB has to be measured against`);
		});
		if (timedOut) return;

		await step("what the provider assumes of E2B", async () => {
			const mixed = await box.run('cat; echo "to stderr" >&2; exit 3', { stdin: "from stdin\n" });
			expect("a command gets its standard input, both outputs come back apart, and a non-zero exit code is a result", mixed.exitCode === 3 && mixed.stdout === "from stdin\n" && mixed.stderr === "to stderr\n", JSON.stringify(mixed));
			const controller = new AbortController();
			const began = Date.now();
			const stopping = box.exec(["bash", "-c", "sleep 60 & sleep 60"], { signal: controller.signal });
			setTimeout(() => controller.abort(), 1_000);
			const stopped = await stopping;
			const still = await box.run("ps -eo args= | grep -c '[s]leep 60'");
			expect("an abort stops the command inside the microVM, and what it started", stopped.aborted && stopped.exitCode === null && still.stdout.trim() === "0", `${Date.now() - began} ms; ${stopped.stopLog.join(", ")}; ${still.stdout.trim()} left`);
			info(`a stopped command: ${stopped.killed ? "SIGKILL was needed" : "SIGTERM was enough"}, ${stopped.leftovers} process(es) left over`);
			const secret = `${DATA_DIR}/e2b-check-secret.json`;
			await box.writeSecretFile(secret, '{"not":"a secret, only shaped like one"}');
			const facts = await box.run(`stat -c '%a %U' ${secret}; wc -c < ${secret}; ls ${DATA_DIR} | grep -c '\\.tmp$'`);
			expect("a secret file arrives whole and is readable by its owner only", facts.stdout.trim().split(/\s+/).join(" ") === "600 agent 40 0", facts.stdout.trim());
			await box.removeFiles([secret]);
			await box.writeTextFile("notes/check.txt", "a text file\n");
			expect("text files are read and written through E2B's file API, relative to the workspace", (await box.readTextFile("notes/check.txt")) === "a text file\n" && (await box.run("cat /workspace/notes/check.txt; stat -c %U /workspace/notes/check.txt")).stdout === "a text file\nagent\n");
		});
		if (timedOut) return;

		await step("pause and resume", async () => {
			const before = await client.info(id);
			let began = Date.now();
			await layer.sandboxes.suspend(id);
			stops();
			const pausedMs = Date.now() - began;
			const paused = await client.info(id);
			expect("suspend pauses the sandbox", (await layer.sandboxes.state(id)) === "paused" && paused?.state === "paused", `${paused?.state} after ${pausedMs} ms`);
			expect("a paused sandbox is not among the running ones, so it does not count against the cap", (await client.list({ metadata: { [META.deployment]: deployment }, state: ["running"] })).length === 0);
			began = Date.now();
			const again = (await layer.sandboxes.connect(id)) as E2bSandboxHandle | undefined;
			runs();
			const resumed = await client.info(id);
			expect("connect() resumes it", again !== undefined && resumed?.state === "running", `${resumed?.state} after ${Date.now() - began} ms`);
			info(`startedAt before the pause ${new Date(before?.startedAt ?? 0).toISOString()}, after the resume ${new Date(resumed?.startedAt ?? 0).toISOString()}: a resume ${resumed?.startedAt === before?.startedAt ? "does NOT move" : "moves"} startedAt. (The provider keeps its own count of how long a sandbox has run without a pause and does not rely on this.)`);
			if (again === undefined) return;
			handle = again;
			const kept = await again.run("cat hello.sh; cat notes/check.txt");
			expect("its files are as they were", kept.stdout === "echo from-the-script\na text file\n", kept.stdout);
			if (session === null) {
				fail("the first turn named no Windlass session to continue");
				return;
			}
			const second = await turn(again, "And once more", { responses: [shell("again", "sh hello.sh"), say("Still there.")] }, session);
			expect(
				"a turn after the resume continues the same Windlass session, from the microVM's own disk",
				second.outcome === "succeeded" && second.result.windlassSessionId === session && second.result.failure === null,
				`${second.outcome}, session ${second.result.windlassSessionId} (was ${session}); ${second.result.failure?.message ?? ""}`,
			);
		});
		if (timedOut) return;

		await step("destroy", async () => {
			await layer.sandboxes.destroy(id);
			stops();
			const gone = await client.info(id);
			const listed = await client.list({ metadata: { [META.deployment]: deployment } });
			expect("destroy removes the sandbox: E2B no longer knows it, running or paused", gone === undefined && listed.length === 0 && (await layer.sandboxes.state(id)) === "none", `${gone?.state ?? "gone"}, ${listed.length} listed`);
			expect("each time the sandbox stopped, the provider said what the stretch cost, as an estimate", logLines.filter((line) => /e2b\.sandbox\.(paused|killed)/.test(line) && line.includes("(estimated)")).length >= 2, `${logLines.filter((line) => /\(estimated\)/.test(line)).length} such line(s)`);
		});
	};

	const network = async (): Promise<void> => {
		if (process.env.WLP_E2B_CHECK_NETWORK !== "1") return;
		// The model relay's settings as the servers have them: with them the sandbox reaches the relay's hostname and not api.openai.com.
		const relayEnv = Object.fromEntries(["WLP_MODEL_RELAY", "WLP_MODEL_RELAY_URL", "WLP_E2B_WINDLASS_VERSION"].map((name) => [name, process.env[name] ?? ""]));
		const relay = e2bModelRelay(relayEnv);
		console.log(`      model relay: ${"host" in relay ? relay.origin : `off (${relay.off})`}`);
		const publicHost = (() => { try { return new URL(process.env.WLP_PUBLIC_URL ?? "").hostname; } catch { return null; } })();
		for (const mode of ["restricted", "none"] as const) {
			await step(`network: ${mode}`, async () => {
				const boxes = e2bSandboxes(client, { ...settings, network: readE2bNetwork({ WLP_E2B_NETWORK: mode, ...relayEnv, ...(mode === "restricted" ? { WLP_E2B_NETWORK_ALLOW: "@npm" } : {}) }) }, { log: (line) => console.log(`      ${line}`) });
				const id = await boxes.create({ uid: "check", sessionId: `network-${mode}`, profile: "e2b" });
				runs();
				try {
					const sh = async (handle: E2bSandboxHandle, script: string) => {
						const result = await handle.exec(["sh", "-c", script], { timeoutMs: 60_000 });
						return `${result.stdout}${result.stderr}`.trim().replace(/\s+/g, " ").slice(0, 300);
					};
					const probe = async (handle: E2bSandboxHandle, when: string) => {
						const model = await sh(handle, "curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models");
						const other = await sh(handle, "curl -sS --max-time 15 https://example.com/ | head -c 200; echo exit=$?");
						const direct = await sh(handle, "curl -sS --max-time 15 --resolve example.com:443:93.184.215.14 https://example.com/ | head -c 200; echo exit=$?");
						const plain = await sh(handle, "curl -sS --max-time 15 http://example.com/ | head -c 200; echo exit=$?");
						const lookup = await sh(handle, "getent hosts example.com; echo exit=$?");
						const github = await sh(handle, "curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://github.com/; echo");
						const said = `model ${model} | github ${github} | other ${other} | direct ${direct} | plain ${plain} | lookup ${lookup}`;
						if ("host" in relay) {
							// A placeholder of no turn: what the route answers it with is all that is looked at.
							const relayed = await sh(handle, `H="authorization: Bearer wlpm1.none"; curl -sS --max-time 15 -H "$H" https://${relay.host}/model-relay/v1/models; echo; curl -sS --max-time 15 -o /dev/null -w 'root %{http_code}' https://${relay.host}/`);
							expect(`${mode}${when}: with the model relay, api.openai.com is not reached`, model !== "401", said);
							expect(`${mode}${when}: the relay's own hostname is reached, answers its route with relay_lease_ended and nothing else`, relayed.includes("relay_lease_ended") && relayed.includes("root 404"), relayed);
							if (publicHost && publicHost !== relay.host) {
								const platform = await sh(handle, `curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://${publicHost}/; echo`);
								expect(`${mode}${when}: the platform's public host is not reached`, !/^[1-5]\d\d/.test(platform), platform);
							}
						} else expect(`${mode}${when}: the model API answers (401 without a key)`, model === "401", said);
						expect(`${mode}${when}: example.com is not reached, by name, by address or over plain HTTP`, ![other, direct, plain].some((text) => text.includes("Example Domain")), said);
						expect(`${mode}${when}: an unlisted name does not resolve`, /exit=[1-9]/.test(lookup), said);
						expect(`${mode}${when}: github.com is ${mode === "restricted" ? "" : "not "}reachable`, mode === "restricted" ? /^(200|301|302)/.test(github) : !/^(200|301|302)/.test(github), said);
						console.log(`      169.254.169.254 answers: ${await sh(handle, "curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://169.254.169.254/; echo")} (the microVM's own Firecracker metadata service, by E2B's documentation)`);
					};
					let handle = (await boxes.connect(id)) as E2bSandboxHandle;
					const cloned = await cloneWithToken(handle, "", { url: "https://github.com/octocat/Hello-World.git", branch: "master", directory: "hello" });
					expect(`${mode}: the platform's own clone ${mode === "restricted" ? "works" : "fails"}`, cloned.ok === (mode === "restricted"), `${cloned.failure ?? "ok"} ${cloned.said}`.trim());
					await probe(handle, "");
					if (mode === "restricted") {
						await boxes.suspend(id);
						stops();
						handle = (await boxes.connect(id)) as E2bSandboxHandle;
						runs();
						await probe(handle, ", after a pause and resume");
						// The lookup stub (network.ts DNS_STUB) and a host a repository's list allows while the sandbox runs.
						const stub = await sh(handle, "grep nameserver /etc/resolv.conf; ps -o user= -p \"$(cat /run/wlp-dns.pid)\"");
						expect("restricted: the resolver is the lookup stub, which runs as nobody and survived the pause", stub === "nameserver 127.0.0.1 nobody", stub);
						const blocked = await handle.blockedHosts();
						expect("restricted: the stub names example.com, which a command could not reach, and not a host it may", blocked.includes("example.com") && !blocked.includes("registry.npmjs.org") && !blocked.includes("github.com"), blocked.join(","));
						// Only a sandbox a turn holds is changed at once (setNetwork never resumes or extends one by itself).
						const unheld = await boxes.setNetwork(id, ["example.com"]);
						const release = await handle.holdForTurn();
						let applied = false;
						let reached = "";
						try {
							applied = await boxes.setNetwork(id, ["example.com"]);
							reached = await sh(handle, "curl -sS --max-time 15 https://example.com/ | head -c 200; echo exit=$?");
						} finally {
							await release();
						}
						expect("restricted: a host allowed while a turn holds the sandbox (a repository's list, setNetwork) is reached at once, and not without a hold", !unheld && applied && reached.includes("Example Domain"), `${unheld ? "applied without a hold | " : ""}${reached}`);
						// What keeps the agent from standing in for the lookup stub or racing root's files in /run and /tmp: the kernel's own settings in the guest.
						const kernel = await sh(handle, "cat /proc/sys/net/ipv4/ip_unprivileged_port_start /proc/sys/fs/protected_symlinks /proc/sys/fs/protected_regular");
						const [portStart, symlinks, regular] = kernel.split(/\s+/).map((value) => Number(value));
						console.log(`      in the guest: net.ipv4.ip_unprivileged_port_start=${portStart} fs.protected_symlinks=${symlinks} fs.protected_regular=${regular}`);
						expect("restricted: in the guest an unprivileged process cannot bind port 53, and symlinks and files in sticky directories are protected", Number.isInteger(portStart) && portStart! > 53 && symlinks! >= 1 && regular! >= 1, kernel);
					}
				} finally {
					await boxes.destroy(id);
					stops();
				}
			});
		}
	};

	try {
		const outcome = await Promise.race([work().then(network), limit]);
		if (outcome === "limit") fail("the check finished within its time limit", `stopped after ${Math.round(limitMs / 1000)} s; its sandbox is removed below`);
	} finally {
		clearTimeout(timer);
		stops();
		console.log("\n== cleanup");
		try {
			// By the run's own label: whatever this run made and did not remove itself, and nothing else.
			const report = await cleanupDeployment(client, deployment, { kill: true });
			for (const line of report.lines) console.log(`      ${line}`);
			expect("nothing of this run is left at E2B", report.failed.length === 0 && (await client.list({ metadata: { [META.deployment]: deployment } })).length === 0, report.failed.map((item) => `${item.sandboxId}: ${item.reason}`).join("; "));
		} catch (error) {
			fail("nothing of this run is left at E2B", `the cleanup itself failed (${messageOf(error)}). Run: npx tsx ../scripts/e2b-cleanup.ts --deployment ${deployment} --kill`);
		}
		console.log(`\ne2b-check: the sandbox ran ${describeUsage(usage.ms / 1000, usage.cpuCount, usage.memoryMB, settings.rateCard)}. The check itself took ${Math.round((Date.now() - startedAt) / 1000)} s.`);
		console.log("e2b-check: that is an estimate from the deployment's rate card and this script's own clock; the account's usage page has what was billed.");
	}
	const code = tally.summary();
	return timedOut ? 3 : code;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(`e2b-check: ${messageOf(error)}`);
		process.exit(1);
	},
);
