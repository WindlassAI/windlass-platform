import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { providers, providerName, supported, validLogin } from "./opencode-providers.js";
import { RunnerError } from "./state.js";

type Ask = (prompt: string) => Promise<string>;
const featured = ["opencode-go","opencode","chatgpt","openai","anthropic","openrouter","google","zai-coding-plan","free"];
const choices = [...new Set([...featured,...Object.keys(providers)])];
export async function pickProvider(ask: Ask) {
	let matches = featured;
	for (;;) {
		const list = matches.slice(0,12).map(id => "  " + id + " — " + providerName(id)).join("\n");
		const input = (await ask(list + "\nOpenCode provider (id or search, Enter for chatgpt): ")).trim().toLowerCase();
		if (!input) return "chatgpt";
		if (validLogin(input)) return input;
		const terms = input.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
		matches = choices.filter(id => terms.every(word => (id+" "+providerName(id)).toLowerCase().includes(word)));
		if (!matches.length) { console.log("No matching provider. Enter another search or an exact id."); matches = featured; }
	}
}

async function confirm(ask: Ask, prompt: string) {
	for (;;) {
		const answer = (await ask(prompt + " [Y/n] ")).trim().toLowerCase();
		if (["","y","yes"].includes(answer)) return true;
		if (["n","no"].includes(answer)) return false;
	}
}
export async function importOpenCode(file: string, ask: Ask, store: (id: string,key: string) => Promise<void>, login: (id?: string) => Promise<void>) {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
		if (error.code !== "ENOENT") throw new RunnerError("Could not open the mounted OpenCode auth.json.");
	});
	if (!handle) return false;
	let entries;
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
		// A single bounded read also limits a file that grows after stat.
		const bytes = Buffer.alloc(stat.size + 1);
		const read = await handle.read(bytes);
		if (read.bytesRead !== stat.size) throw new Error();
		const data = JSON.parse(bytes.toString("utf8",0,read.bytesRead));
		if (!data || Array.isArray(data) || typeof data !== "object") throw new Error();
		entries = Object.entries(data).flatMap<{id:string; key?:string}>(([id,value]) => {
			if (!/^[a-z0-9][a-z0-9._-]{0,100}$/.test(id) || !value || typeof value !== "object") return [];
			if (["refresh","refresh_token","refreshToken"].some(field => Object.hasOwn(value,field)) || ("type" in value && value.type === "oauth")) return [{id,key:undefined}];
			if ("type" in value && value.type === "api" && "key" in value && typeof value.key === "string" && /^[!-~]{1,4096}$/.test(value.key))
				return [{id,key:value.key}];
			return [];
		});
	} catch { throw new RunnerError("Invalid OpenCode auth.json in the setup import mount."); }
	finally { await handle.close(); }
	for (const {id,key} of entries) {
		if (!key) {
			if (await confirm(ask, id + " login can't be shared safely; sign in separately for the runner?"))
				await login(id === "openai" ? "chatgpt" : supported(id) ? id : undefined);
		} else if (supported(id)) {
			if (await confirm(ask, providerName(id) + " (" + id + ") API key: import?")) await store(id,key);
		} else console.log("Skipping " + id + ": no fixed inference route in this runner.");
	}
	return entries.length > 0;
}
