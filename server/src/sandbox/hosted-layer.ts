import type { ChatgptLogins, SandboxLayer } from "./api.js";
import { HostedSandboxes, type HostedSandboxProvider } from "./hosted.js";
import { SandboxWindlass, type TurnOptions } from "./turn.js";

export type HostedLayerParts = Pick<SandboxLayer, "tokens" | "logins"> & Partial<Pick<SandboxLayer, "backups">>;

export function hostedSandboxLayer(parts: HostedLayerParts, createProvider: (onVersion: (value: string) => void) => HostedSandboxProvider, version: string | null, turn?: TurnOptions) {
	const provider = createProvider(value => { version ??= value; });
	const windlass = new SandboxWindlass(parts.tokens, { version: async () => version, problem: async () => null }, turn);
	const sandboxes = new HostedSandboxes(provider);
	const logout = async (uid: string) => {
		await parts.logins.logout(uid);
		await provider.forgetTokenFiles(uid).catch((error: unknown) => console.warn(`[wlp] ${provider.id}.token_files_left uid=${uid}: the access token files of the user's running turns could not be removed (${error instanceof Error ? error.message : String(error)}); each expires within the hour`));
	};
	const logins = new Proxy<ChatgptLogins>(parts.logins, {
		get(target, property) {
			if (property === "logout") return logout;
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
	return { sandboxes, windlass, logins, tokens: parts.tokens, backups: parts.backups ?? null };
}
