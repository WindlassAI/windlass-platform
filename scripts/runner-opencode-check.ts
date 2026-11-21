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
		await importOpenCode(file, async prompt => {
			prompts.push(prompt);
			if (prompts.length === 1) await writeFile(file,"{}");
			return "";
		}, async (provider,key) => { keys.push([provider,key]); }, async id => { logins.push(id ?? ""); });
		assert.deepEqual(keys,[["opencode-go","fixture-go"],["opencode","fixture-zen"]]);
		assert.deepEqual(logins,["chatgpt"]);
		assert.match(prompts.join(" "),/can't be shared safely; sign in separately for the runner/i);
		assert.doesNotMatch(prompts.join(" "),/foreign-|fixture-/);
		assert.equal(await readFile(file,"utf8"),"{}");
		await writeFile(file,input);
		await importOpenCode(file, async () => "n", async () => assert.fail(), async () => assert.fail());
		await symlink(file,join(dir,"link"));
		await assert.rejects(importOpenCode(join(dir,"link"),async () => "", async () => {}, async () => {}));
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

test("pre-launch discovery keeps the ACP default and models from each provider within the machine report budget", async () => {
	const { inventoryModels } = await import("../runner/src/harness-options.js");
	const models = ["opencode","opencode-go","openrouter"].flatMap(provider => Array.from({length:45},(_,i) => ({id:provider+"/model-"+i,name:null,efforts:[]})));
	const result = inventoryModels(models, "opencode-go/model-44");
	assert.equal(result.length,32);
	assert.ok(result.some(m => m.id === "opencode-go/model-44"));
	assert.ok(result.some(m => m.id === "openrouter/model-0"));
});
