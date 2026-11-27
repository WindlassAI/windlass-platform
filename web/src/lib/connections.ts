/**
 * The Connections page's grid (screens/Connections.tsx): for each agent and each place it runs (Hosted, each paired
 * machine), what pays for it now and the one action that connects it. Hosted follows the turn resolver as it is
 * (`hostedPayer`: a connected plan first, then a key); a machine follows its runner's report and the owner's
 * per-machine choice (`MachineSummary.harnesses[].source`). Pure: no React, no client.
 */
import {
	type HarnessId,
	type MachineSummary,
	type ModelPlanStatus,
	type ModelPlans,
	type ModelProvider,
	type ModelProviderStatus,
	PLAN_NAMES,
	type PlanProvider,
} from "@contract";
import {
	type HostedCredential,
	hostedPayer,
	keyProviders,
	machineHarness,
	WINDLASS_KEY_PROVIDERS,
} from "../../../server/src/sandbox/harnesses.js";
import type { ReportedHarness } from "./acp";
import { clockTime } from "./format";
import { SOURCE_NAMES } from "./models";

/** What the page reads once and every cell is decided from. */
export interface ConnectionInputs {
	keys: readonly ModelProviderStatus[];
	plans: ModelPlans;
	/** Whether the ChatGPT sign-in is connected: Windlass's own models run on it. */
	chatgpt: boolean;
	/** Whether this account may connect the ChatGPT sign-in (not the demo user). */
	canConnectChatgpt: boolean;
}

/**
 * How a cell stands: paid by a plan, a key, or the machine's own sign-in; "bad" a saved key whose check failed;
 * "none" nothing connected; "absent" the agent is not on that machine; "unknown" its runner could not check.
 */
export type CellState = "plan" | "key" | "machine" | "bad" | "none" | "absent" | "unknown";

/** Where a cell's one action leads: a plan's connect command, a key's entry, or the Machines page. */
export type CellAction =
	| { kind: "plan"; provider: PlanProvider; reconnect?: true }
	| { kind: "key"; provider: ModelProvider }
	| { kind: "machines" };

export interface ConnectionCell {
	/** The cell's element id, which a link names as the page's fragment (`cellId`). */
	id: string;
	state: CellState;
	label: string;
	detail: string | null;
	action: CellAction | null;
	/** What the relays last saw of the plan that pays here, where it is not simply usable (`planBadge`). */
	badge?: CellBadge;
}

/** A plan's health in a few words: at its limit (until when), or refused twice and to be connected again. */
export interface CellBadge {
	tone: "warn" | "bad";
	text: string;
}

/** The badge a plan's cell shows: none while it is usable, or once a limit's time has passed. */
export function planBadge(plan: ModelPlanStatus | undefined, now: number): CellBadge | null {
	if (!plan) return null;
	if (plan.health === "invalid") return { tone: "bad", text: "Stopped working" };
	if (plan.health !== "limited" || plan.limitedUntil === null || plan.limitedUntil <= now) return null;
	const at = clockTime(plan.limitedUntil, now);
	return { tone: "warn", text: plan.resetKnown ? `Limited until ${at}` : `Limited · trying again at ${at}` };
}

/** A plan cell's badge and, for a plan that stopped working, its reconnect. */
function withHealth(cell: ConnectionCell, plan: ModelPlanStatus | undefined, now: number): ConnectionCell {
	const badge = planBadge(plan, now);
	if (!badge || !plan) return cell;
	return {
		...cell,
		badge,
		...(plan.health === "invalid" && { action: { kind: "plan", provider: plan.provider, reconnect: true } }),
	};
}

/** A place in the grid: Hosted, or a paired machine by its id. */
export type ConnectionPlace = "hosted" | string;

/** The id of an agent's cell at a place: what a disabled agent in the composer links to (`/connections#claude-hosted`). */
export const cellId = (harness: HarnessId, place: ConnectionPlace) => `${harness}-${place}`;

/** What hosted turns can pay with, as the server's `hostedCredentials` counts them: checked keys, and plans where allowed. */
export function hostedCredentialsFrom(inputs: ConnectionInputs): HostedCredential[] {
	return [
		...inputs.keys.filter(key => key.ok),
		...(inputs.plans.allowed
			? inputs.plans.plans
					.filter(plan => plan.ok)
					.map(plan => ({
						provider: plan.provider,
						plan: true as const,
						checkedAt: plan.checkedAt,
						models: plan.models,
					}))
			: []),
	];
}

const planProvidersOf = (harness: HarnessId): readonly PlanProvider[] => machineHarness(harness)?.planProviders ?? [];

/** The connect a hosted agent needs: its plan where the account may connect one, else its first key. */
export function connectAction(harness: HarnessId, inputs: ConnectionInputs): CellAction {
	if (harness === "windlass")
		return inputs.canConnectChatgpt ? { kind: "plan", provider: "openai" } : { kind: "key", provider: "openai" };
	const plan = inputs.plans.allowed ? planProvidersOf(harness)[0] : undefined;
	if (plan) return { kind: "plan", provider: plan };
	return { kind: "key", provider: keyProviders(harness)[0] ?? "openai" };
}

const keyNames = (providers: readonly ModelProvider[]) => providers.map(provider => SOURCE_NAMES[provider]).join(", ");

/** An agent on Hosted: the plan or key `hostedPayer` would pick for its default model, or what to connect. */
export function hostedCell(harness: HarnessId, inputs: ConnectionInputs, now = Date.now()): ConnectionCell {
	const id = cellId(harness, "hosted");
	const ownKeys = (harness === "windlass" ? WINDLASS_KEY_PROVIDERS : keyProviders(harness)).filter(provider =>
		inputs.keys.some(key => key.provider === provider),
	);
	const okKeys = inputs.keys.filter(key => key.ok && ownKeys.includes(key.provider));
	if (harness === "windlass") {
		if (inputs.chatgpt)
			return withHealth(
				{
					id,
					state: "plan",
					label: PLAN_NAMES.openai,
					detail: okKeys.length ? `Keys too: ${keyNames(okKeys.map(key => key.provider))}` : null,
					action: null,
				},
				inputs.plans.plans.find(one => one.provider === "openai"),
				now,
			);
		if (okKeys.length)
			return { id, state: "key", label: "Your keys", detail: keyNames(okKeys.map(key => key.provider)), action: null };
	} else {
		const payer = hostedPayer(harness, undefined, hostedCredentialsFrom(inputs));
		if (payer?.plan) {
			const plan = inputs.plans.plans.find(one => one.provider === payer.provider);
			const backup = okKeys[0];
			return withHealth(
				{
					id,
					state: "plan",
					label: PLAN_NAMES[payer.provider as PlanProvider],
					detail: backup ? `Key …${backup.last4} as backup` : (plan?.account ?? null),
					action: null,
				},
				plan,
				now,
			);
		}
		if (payer) {
			const key = okKeys.find(one => one.provider === payer.provider);
			return {
				id,
				state: "key",
				label: `${SOURCE_NAMES[payer.provider]} key`,
				detail: key ? `…${key.last4}` : null,
				action: null,
			};
		}
	}
	const failed = inputs.keys.find(key => !key.ok && ownKeys.includes(key.provider));
	if (failed)
		return {
			id,
			state: "bad",
			label: "Key check failed",
			detail: `${SOURCE_NAMES[failed.provider]} …${failed.last4}`,
			action: { kind: "key", provider: failed.provider },
		};
	return { id, state: "none", label: "Not connected", detail: null, action: connectAction(harness, inputs) };
}

/** How a machine's agent signs in there, in a few words. */
function machineMethodWords(entry: ReportedHarness): string | null {
	if (entry.machineMethod === "chatgpt") return "ChatGPT";
	if (entry.machineMethod === "api-key") return "its own API key";
	if (entry.machineProviders?.length) return entry.machineProviders.join(", ");
	return entry.id === "claude" ? "Claude account" : null;
}

/**
 * The providers whose saved key could pay for a machine's agent instead of its own sign-in: where both could, the
 * owner chooses which one is used (`setCredentialSource`), in that agent's cell.
 */
export function choosableKeys(entry: ReportedHarness, keys: readonly ModelProviderStatus[]): ModelProvider[] {
	if (!entry.keyRelay) return [];
	return (entry.machineSignIns ?? []).filter(provider => keys.some(key => key.provider === provider));
}

/** An agent on a machine, from its runner's report: its own sign-in, the owner's key, or what to do there. */
export function machineCell(harness: HarnessId, machine: MachineSummary, hosted: ConnectionCell): ConnectionCell {
	const id = cellId(harness, machine.machineId);
	// Windlass on a machine runs on the same models as hosted: the ChatGPT sign-in or the account's keys.
	if (harness === "windlass") return { ...hosted, id, detail: "Same as Hosted" };
	const entry = machine.harnesses?.find(one => one.id === harness);
	if (!entry) return { id, state: "absent", label: "Not on this machine", detail: null, action: { kind: "machines" } };
	if (entry.signIn === "none")
		return { id, state: "none", label: "Sign in needed", detail: null, action: { kind: "machines" } };
	if (entry.signIn === "unknown")
		return {
			id,
			state: "unknown",
			label: "Couldn't check",
			detail: entry.signInReason ?? null,
			action: { kind: "machines" },
		};
	if (entry.platformKeys?.length && (entry.source === "key" || !entry.machineSignIns?.length))
		return { id, state: "key", label: "Your key", detail: keyNames(entry.platformKeys), action: null };
	return { id, state: "machine", label: "Own sign-in", detail: machineMethodWords(entry), action: null };
}

/** Whether any agent can run anywhere yet: a plan, a checked key, the ChatGPT sign-in, or a machine's signed-in agent. */
export function anyAgentConnected(inputs: ConnectionInputs, machines: readonly MachineSummary[]): boolean {
	return (
		inputs.chatgpt ||
		hostedCredentialsFrom(inputs).length > 0 ||
		machines.some(machine => machine.harnesses?.some(entry => entry.signIn === "token"))
	);
}
