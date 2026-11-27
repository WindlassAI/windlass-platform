/** The account's settings, secrets, model providers and API tokens. */

import type { SandboxProfileId } from "../contract.js";
import type { RepositoryAutonomy, RepositoryDefaults, SecretReach, SecretScope } from "./repository.js";

/** Account defaults apply after explicit launch and repository choices. Ignore unavailable profiles and models. */
export type AccountDefaults = Omit<RepositoryDefaults, keyof RepositoryAutonomy | "screenshots">;

export type AccountDefaultsPatch = Partial<Omit<AccountDefaults, "updatedAt" | "previousStartPlace">>;
export type RepositoryDefaultsPatch = Partial<
	Omit<RepositoryDefaults, "updatedAt" | "mergeKinds" | "previousStartPlace">
> & { offer?: import("../factory/readiness-track.js").Offer };

/** User-owned MCP definition supplied to every session independent of repository configuration. */
export interface PersonalServer {
	/** Its key in Windlass's configuration: what the model calls it by. */
	name: string;
	definition: Record<string, unknown>;
	/** True when it is reached at an address and nothing is started. */
	remote: boolean;
	/** What starts it, or where it is reached, in one line: the command with its arguments, or the address. */
	subject: string;
	/** False when its definition says `enabled: false`: Windlass then leaves it out. */
	enabled: boolean;
	/** Allows tools to run without asking. Trust in their output is controlled separately by the definition. */
	unasked: boolean;
	/** Variables referenced by env or headers, in order. An unset variable prevents startup. */
	reads: Array<{ name: string; saved: boolean }>;
	/** When it was last saved, ms since the epoch. */
	updatedAt: number;
}

/** Show the server's reach before saving because user-owned MCP servers start without project approval. */
export interface PersonalServerReach {
	profile: SandboxProfileId;
	/** The profile's display name. */
	name: string;
	/** For a server that is started by a command. */
	command: string;
	/** For a server that is reached at an address. */
	address: string;
}

/** The account's settings, as their page shows them. No value of a secret is among them: `accountSecrets` lists those. */
export interface AccountSettings {
	defaults: AccountDefaults;
	/** By name. */
	servers: PersonalServer[];
	/** One entry for each sandbox this deployment can run. */
	serverReach: PersonalServerReach[];
	/** How many servers and account secrets a user may keep, and how long a server's definition may be as JSON, in bytes. */
	limits: { servers: number; definitionBytes: number; secrets: number };
}

/** Account secrets expose only metadata here and never go to repository setup. */
export interface AccountSecret {
	/** The environment variable a server's definition reads it as. */
	name: string;
	/** A repository's secret's scopes, without the setup command: "setup" is MCP servers only, "agent" the agent's commands as well. */
	scope: SecretScope;
	/** When its value or scope was last changed, ms since the epoch. */
	updatedAt: number;
	/** What it reaches in the sandbox the list was asked for. */
	reach: SecretReach;
	/** Repository-specific value and scope override the account secret in these repositories. */
	repositories: string[];
}

export const MODEL_CHECKS_PER_MINUTE = 12;
export const MODEL_PROVIDERS = ["openai", "anthropic", "google", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(value: unknown): value is ModelProvider {
	return (MODEL_PROVIDERS as readonly unknown[]).includes(value);
}

const MODEL_KEY_SHAPES: Record<ModelProvider, RegExp> = {
	openai: /^sk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{16,512}|[A-Za-z0-9]{16,512})$/,
	anthropic: /^sk-ant-[A-Za-z0-9_-]{16,600}$/,
	google: /^(?:AIza[A-Za-z0-9_-]{35}|AQ\.[A-Za-z0-9_.-]{16,1024})$/,
	openrouter: /^sk-or-v1-[A-Za-z0-9]{16,512}$/,
};

export function validModelKey(provider: ModelProvider, key: unknown): key is string {
	return typeof key === "string" && MODEL_KEY_SHAPES[provider].test(key);
}

export interface ModelProviderStatus {
	provider: ModelProvider;
	last4: string;
	addedAt: number;
	checkedAt: number | null;
	ok: boolean;
	models?: string[];
	windlassModels?: string[];
	needsWindlassCheck?: boolean;
}

/** A failed check leaves the key saved and returns a message safe to display. */
export type ModelProviderCheck = ModelProviderStatus & { message?: string };

export interface AccountSecrets {
	secrets: AccountSecret[];
	/** The profile `reach` is said for. */
	profile: SandboxProfileId;
}

/** What an API token may do. */
export type ApiTokenScope = "items:create" | "items:read";

/** The bearer value is shown once. Only its digest is retained until revocation. */
export interface ApiToken {
	id: string;
	name: string;
	scopes: ApiTokenScope[];
	createdAt: number;
	/** When it was last used, to the minute; null before. */
	usedAt: number | null;
}
