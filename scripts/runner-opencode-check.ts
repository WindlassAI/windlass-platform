import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { importOpenCode, pickProvider } from "../runner/src/opencode-import.js";
Object.assign(globalThis, {SANDBOX_IMAGE:"fixture", SHOTS_IMAGE_PIN:""});
const { projection } = await import("../runner/src/claude-relay.js");

test("setup reads the mounted file once and separately authorizes Go, Zen and a runner-owned OAuth login", async () => {
	const dir = await mkdtemp(join(process.cwd(), ".import-check-"));
	const file = join(dir,"auth.json");
	const input = JSON.stringify({"opencode-go":{type:"api",key:"fixture-go"},opencode:{type:"api",key:"fixture-zen"},
		openai:{type:"oauth",refresh:"foreign-refresh",access:"foreign-access"}});
	try {
		await writeFile(file,input);
		const prompts: string[] = [], keys: unknown[] = [], logins: string[] = [];
		const imported = await importOpenCode(file, async prompt => {
			prompts.push(prompt);
			if (prompts.length === 1) await writeFile(file,"{}");
			return "";
		}, async (provider,key) => { keys.push([provider,key]); }, async id => { logins.push(id ?? ""); });
		assert.equal(imported, true);
		assert.deepEqual(keys,[["opencode-go","fixture-go"],["opencode","fixture-zen"]]);
		assert.deepEqual(logins,["chatgpt"]);
		assert.match(prompts.join(" "),/can't be shared safely; sign in separately for the runner/i);
		assert.doesNotMatch(prompts.join(" "),/foreign-|fixture-/);
		assert.equal(await readFile(file,"utf8"),"{}");
		await writeFile(file,input);
		assert.equal(await importOpenCode(file, async () => "n", async () => assert.fail(), async () => assert.fail()), false);
		await writeFile(file, JSON.stringify({ unsupported: { type: "api", key: "fixture" } }));
		assert.equal(await importOpenCode(file, async () => assert.fail(), async () => assert.fail(), async () => assert.fail()), false);
		await symlink(file,join(dir,"link"));
		await assert.rejects(importOpenCode(join(dir,"link"),async () => "", async () => {}, async () => {}));
	} finally { await rm(dir,{recursive:true,force:true}); }
});

test("an API-shaped subscription entry that also carries refresh material always requires separate sign-in", async () => {
	const dir = await mkdtemp(join(process.cwd(), ".oauth-import-check-"));
	try {
		const file = join(dir, "auth.json");
		await writeFile(file, JSON.stringify({openai:{type:"api",key:"subscription-key",refresh_token:"foreign-token"}}));
		const logins: string[] = [];
		assert.equal(await importOpenCode(file, async () => "y", async () => assert.fail("A subscription was imported"), async id => { logins.push(id!); }), true);
		assert.deepEqual(logins,["chatgpt"]);
	} finally { await rm(dir,{recursive:true,force:true}); }
});

test("the short picker offers Go and Zen first, searches by name and accepts an exact provider ID",async () => {
	const prompts: string[] = [];
	const replies = ["coding plan","zai-coding-plan"];
	assert.equal(await pickProvider(async p => { prompts.push(p); return replies.shift()!; }),"zai-coding-plan");
	assert.ok(prompts[0]!.indexOf("opencode-go") >= 0 && prompts[0]!.indexOf("OpenCode Zen") >= 0);
	assert.match(prompts[1]!,/zai-coding-plan/);
	assert.equal(await pickProvider(async () => "kimi-code-plan-global"),"kimi-code-plan-global");
});

test("the ACP projection enables every selected provider with separate placeholder records and loopback endpoints", () => {
	const ids = ["opencode","opencode-go","zai-coding-plan","google","moonshotai","minimax","deepseek","groq","openrouter","zhipuai-coding-plan"];
	const env = projection(ids,"fixture-placeholder");
	const value = (key: string) => JSON.parse(env.find(v => v.startsWith(key+"="))!.slice(key.length+1));
	const config = value("OPENCODE_CONFIG_CONTENT");
	assert.deepEqual(config.enabled_providers,ids);
	for(const id of ids) {
		assert.equal(config.provider[id].options.baseURL,"http://127.0.0.1:17892/"+id);
		assert.deepEqual(value("OPENCODE_AUTH_CONTENT")[id],{type:"api",key:"fixture-placeholder"});
	}
});

test("authenticated reports carry a full provider catalog while other frames retain the control limit", async () => {
	const { MAX_CONTROL_FRAME_BYTES, parseRunnerFrame, validHarnessOptions } = await import("../server/src/runner/control.js");
	const models = Array.from({ length: 1400 }, (_, i) => ({ id: "openrouter/model-" + i, name: "Model " + i, efforts: ["low", "high"] }));
	const options = { models, defaultModel: models[1399]!.id, modes: [{ id: "plan", name: "Plan", description: null }], checkedAt: Date.now() };
	const frame = JSON.stringify({ kind: "report", docker: { ok: true }, commandSandbox: { ok: true }, freeDiskBytes: 0, sandboxes: [],
		harnesses: [{ id: "opencode", signIn: "token", adapter: "OpenCode", image: "fixture", options }] });
	assert.ok(Buffer.byteLength(frame) > MAX_CONTROL_FRAME_BYTES);
	const report = parseRunnerFrame(frame);
	assert.deepEqual(report?.kind === "report" && report.harnesses?.[0]?.options, options);
	assert.equal(parseRunnerFrame(frame, false), null);
	assert.equal(parseRunnerFrame(" ".repeat(MAX_CONTROL_FRAME_BYTES) + '{"kind":"heartbeat"}'), null);
	assert.equal(validHarnessOptions({ ...options, models: [...models, models[0]] }), false);
	assert.equal(validHarnessOptions({ ...options, models: models.map(m => ({ ...m, id: m.id.padEnd(512, "x"), name: "y".repeat(512) })),
		defaultModel: options.defaultModel.padEnd(512, "x") }), false);
});

test("installer capability reports must describe the exact published runner", async () => {
	const { publishedHarnesses } = await import("../server/src/config.js");
	const image = "registry.invalid/runner@sha256:" + "a".repeat(64);
	const report = JSON.stringify({ image, harnesses: ["claude"] });
	assert.deepEqual(publishedHarnesses(image, report), ["claude"]);
	assert.equal(publishedHarnesses(image.replace("aa", "bb"), report), undefined);
	assert.equal(publishedHarnesses(image), undefined);
});
