/** The Connections grid's cells: what pays for each agent at each place, and the one action that connects it. */
import type { MachineSummary, ModelPlanStatus, ModelProviderStatus } from "@contract";
import { describe, expect, it } from "vitest";
import {
	anyAgentConnected,
	cellId,
	choosableKeys,
	connectAction,
	type ConnectionInputs,
	hostedCell,
	machineCell,
} from "./connections";

const key = (provider: ModelProviderStatus["provider"], ok = true): ModelProviderStatus => ({
	provider,
	last4: "4f2a",
	addedAt: 1,
	checkedAt: 1,
	ok,
	models: ["m"],
});
const plan = (provider: ModelPlanStatus["provider"]): ModelPlanStatus => ({
	provider,
	account: "a@b.com · Max",
	addedAt: 1,
	checkedAt: 1,
	ok: true,
});
const inputs = (over: Partial<ConnectionInputs> = {}): ConnectionInputs => ({
	keys: [],
	plans: { allowed: true, plans: [] },
	chatgpt: false,
	canConnectChatgpt: true,
	...over,
});

describe("a hosted cell", () => {
	it("is not connected and leads to the agent's plan, or to its key where plans are off", () => {
		expect(hostedCell("claude", inputs())).toEqual({
			id: "claude-hosted",
			state: "none",
			label: "Not connected",
			detail: null,
			action: { kind: "plan", provider: "anthropic" },
		});
		const off = inputs({ plans: { allowed: false, plans: [] } });
		expect(hostedCell("claude", off).action).toEqual({ kind: "key", provider: "anthropic" });
		expect(hostedCell("codex", off).action).toEqual({ kind: "key", provider: "openai" });
		expect(hostedCell("opencode", inputs()).action?.kind).toBe("key");
	});

	it("names the plan first, with the key as its backup", () => {
		const both = inputs({ keys: [key("anthropic")], plans: { allowed: true, plans: [plan("anthropic")] } });
		expect(hostedCell("claude", both)).toMatchObject({
			state: "plan",
			label: "Claude plan",
			detail: "Key …4f2a as backup",
			action: null,
		});
		const planOnly = inputs({ plans: { allowed: true, plans: [plan("anthropic")] } });
		expect(hostedCell("claude", planOnly).detail).toBe("a@b.com · Max");
	});

	it("ignores a plan the account may not use, and says the key pays", () => {
		const off = inputs({ keys: [key("anthropic")], plans: { allowed: false, plans: [plan("anthropic")] } });
		expect(hostedCell("claude", off)).toMatchObject({ state: "key", label: "Anthropic key", detail: "…4f2a" });
	});

	it("says a key whose check failed, and offers to replace it", () => {
		expect(hostedCell("codex", inputs({ keys: [key("openai", false)] }))).toMatchObject({
			state: "bad",
			label: "Key check failed",
			action: { kind: "key", provider: "openai" },
		});
	});

	it("runs Windlass on the ChatGPT sign-in, or on any key", () => {
		expect(hostedCell("windlass", inputs({ chatgpt: true }))).toMatchObject({ state: "plan", label: "ChatGPT plan" });
		expect(hostedCell("windlass", inputs({ keys: [key("google")] }))).toMatchObject({
			state: "key",
			detail: "Gemini",
		});
		expect(hostedCell("windlass", inputs()).action).toEqual({ kind: "plan", provider: "openai" });
		expect(connectAction("windlass", inputs({ canConnectChatgpt: false }))).toEqual({
			kind: "key",
			provider: "openai",
		});
	});
});

const machine = (harnesses: NonNullable<MachineSummary["harnesses"]>): MachineSummary =>
	({ machineId: "m_mac", name: "mac", harnesses }) as MachineSummary;

describe("a machine's cell", () => {
	const hosted = hostedCell("windlass", inputs({ chatgpt: true }));

	it("follows Hosted for Windlass, and says when the agent is not there", () => {
		expect(machineCell("windlass", machine([]), hosted)).toMatchObject({
			id: "windlass-m_mac",
			state: "plan",
			detail: "Same as Hosted",
		});
		expect(machineCell("claude", machine([]), hosted)).toMatchObject({
			state: "absent",
			action: { kind: "machines" },
		});
	});

	it("tells its own sign-in, the owner's key, a sign-in to do and a check that failed apart", () => {
		const entry = { id: "claude" as const, adapter: "a", image: "i" };
		expect(machineCell("claude", machine([{ ...entry, signIn: "token" }]), hosted)).toMatchObject({
			state: "machine",
			label: "Own sign-in",
		});
		expect(
			machineCell(
				"claude",
				machine([
					{ ...entry, signIn: "token", platformKeys: ["anthropic"], source: "key", machineSignIns: ["anthropic"] },
				]),
				hosted,
			),
		).toMatchObject({ state: "key", label: "Your key", detail: "Anthropic" });
		expect(machineCell("claude", machine([{ ...entry, signIn: "none" }]), hosted)).toMatchObject({
			state: "none",
			label: "Sign in needed",
		});
		expect(
			machineCell("claude", machine([{ ...entry, signIn: "unknown", signInReason: "timed out" }]), hosted),
		).toMatchObject({ state: "unknown", detail: "timed out" });
	});

	it("offers the choice of payer only where the runner relays keys and a key of its sign-in's provider is saved", () => {
		const entry = {
			id: "claude" as const,
			adapter: "a",
			image: "i",
			signIn: "token" as const,
			machineSignIns: ["anthropic" as const],
		};
		expect(choosableKeys({ ...entry, keyRelay: true }, [key("anthropic")])).toEqual(["anthropic"]);
		expect(choosableKeys(entry, [key("anthropic")])).toEqual([]);
		expect(choosableKeys({ ...entry, keyRelay: true }, [key("openai")])).toEqual([]);
	});
});

it("counts any plan, key, ChatGPT sign-in or signed-in machine agent as an agent connected", () => {
	expect(anyAgentConnected(inputs(), [])).toBe(false);
	expect(anyAgentConnected(inputs({ chatgpt: true }), [])).toBe(true);
	expect(anyAgentConnected(inputs({ keys: [key("openrouter")] }), [])).toBe(true);
	expect(anyAgentConnected(inputs({ keys: [key("openrouter", false)] }), [])).toBe(false);
	expect(anyAgentConnected(inputs(), [machine([{ id: "codex", adapter: "a", image: "i", signIn: "token" }])])).toBe(
		true,
	);
	expect(cellId("codex", "hosted")).toBe("codex-hosted");
});
