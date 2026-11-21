import registry from "../../sandbox/relay/providers.json" with { type: "json" };

interface Provider {
	name: string;
	routes: Record<string, string>;
	variants?: Record<string, string[]>;
	blocked?: string[];
}
export const providers: Record<string, Provider> = registry.providers;
export const supported = (id: string) => Object.hasOwn(providers, id);
export const validLogin = (id: string) => id === "chatgpt" || id === "free" || supported(id);
export const providerName = (id: string) => id === "opencode" ? "OpenCode Zen" : id === "opencode-go" ? "OpenCode Go (Go-specific key)" :
	id === "chatgpt" ? "ChatGPT device login" : id === "free" ? "OpenCode public models" : providers[id]!.name;

export const providerHosts = [...new Set(["auth.openai.com","chatgpt.com",
	...Object.values(providers).flatMap(p => [...Object.values(p.routes), ...Object.values(p.variants ?? {}).map(([,url]) => url!)]
		.map(url => new URL(url).hostname))])].sort();
