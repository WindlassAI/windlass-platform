// @vitest-environment jsdom
import type { AuthResult, PromptInput } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformError } from "../api/client";
import { createMockClient } from "../api/mock";
import { handOver, takeHandover } from "../state/handover";
import { Composer, type ComposerProps } from "./Composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
/** What the composer sent, in order, and what each send is answered with: a failure, or nothing. */
let sent: PromptInput[];
let answers: Array<Error | null>;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	sent = [];
	answers = [];
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

const onSend = async (input: PromptInput) => {
	sent.push(input);
	const answer = answers.shift() ?? null;
	if (answer) throw answer;
};

const show = (props: Partial<ComposerProps> = {}) =>
	act(() => root.render(createElement(Composer, { status: "idle", online: true, models: null, model: "gpt-6.1-sol", onSend, onStop: async () => undefined, ...props })));

const field = () => host.querySelector("textarea") as HTMLTextAreaElement;

/** Types into the field as a browser does, so that React sees the change. */
const write = (text: string) =>
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field(), text);
		field().dispatchEvent(new Event("input", { bubbles: true }));
	});

const send = () => act(async () => (host.querySelector('button[type="submit"]') as HTMLButtonElement).click());

const noAnswer = () => new PlatformError("network", "The server at http://localhost:6420 did not answer.");

describe("the composer's submissions", () => {
	it("keeps a message that was not taken, and sends it again with the key it had", async () => {
		show();
		write("Fix the flaky test");
		answers.push(noAnswer());
		await send();
		expect(field().value).toBe("Fix the flaky test");
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("did not answer");
		await send();
		expect(sent.map((input) => input.text)).toEqual(["Fix the flaky test", "Fix the flaky test"]);
		expect(sent[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
		expect(sent[1]?.idempotencyKey).toBe(sent[0]?.idempotencyKey);
		// Taken: the field is empty, and nothing shows a control for any of this.
		expect(field().value).toBe("");
		expect(host.querySelectorAll("button")).toHaveLength(1);
	});

	it("gives a message whose text changed a key of its own", async () => {
		show();
		write("Fix the flaky test");
		answers.push(noAnswer(), noAnswer());
		await send();
		write("Fix the flaky test in ci.yml");
		await send();
		// Spaces around it are not part of what is sent, so they change nothing.
		write("  Fix the flaky test in ci.yml  ");
		await send();
		expect(sent.map((input) => input.text)).toEqual(["Fix the flaky test", "Fix the flaky test in ci.yml", "Fix the flaky test in ci.yml"]);
		expect(sent[1]?.idempotencyKey).not.toBe(sent[0]?.idempotencyKey);
		expect(sent[2]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
	});

	it("gives the same words a new key once they were taken: sent again on purpose, they are a new message", async () => {
		show();
		write("Run the tests");
		await send();
		write("Run the tests");
		await send();
		expect(sent).toHaveLength(2);
		expect(sent[1]?.idempotencyKey).not.toBe(sent[0]?.idempotencyKey);
	});

	it("keeps the key through a refusal that clears itself, and when the message then steers the turn", async () => {
		show({ status: "running" });
		write("Also update the changelog");
		answers.push(new PlatformError("user", "The turn is still starting and cannot take a message right now. Try again in a moment.", { reason: "turn_running" }));
		await send();
		expect(host.querySelector('[role="status"]')?.textContent).toContain("Your message is still here.");
		await send();
		expect(sent[1]).toEqual({ text: "Also update the changelog", idempotencyKey: sent[0]?.idempotencyKey });
	});

	it("sends a handed-over prompt with the key it was first sent with, until its text changes", async () => {
		handOver("s_1", { text: "Add a health check", error: "The server did not answer.", idempotencyKey: "key-of-the-launch-form" });
		const handover = takeHandover("s_1");
		show({ initial: handover });
		expect(field().value).toBe("Add a health check");
		answers.push(noAnswer());
		await send();
		expect(sent[0]?.idempotencyKey).toBe("key-of-the-launch-form");
		write("Add a health check at /healthz");
		await send();
		expect(sent[1]?.idempotencyKey).not.toBe("key-of-the-launch-form");
	});

	it("leaves one message when the first attempt arrived and only its answer was lost", async () => {
		vi.useFakeTimers();
		const client = createMockClient({ origin: "http://localhost:5173" });
		const login = client.login.demo();
		await vi.advanceTimersByTimeAsync(1000);
		const auth: AuthResult = await login;
		const created = client.user(auth).createSession({ profile: "docker-windlass-sandbox" });
		await vi.advanceTimersByTimeAsync(500);
		const api = client.session(auth, (await created).id);
		const messages: string[] = [];
		const close = api.open({ onSnapshot: () => undefined, onItem: (item) => void (item.kind === "user" && messages.push(item.text)), onDelta: () => undefined, onSummary: () => undefined, onQuestion: () => undefined, onConnection: () => undefined });
		// The server takes the prompt; the first answer never reaches the composer.
		let lost = true;
		show({
			onSend: async (input) => {
				sent.push(input);
				await api.prompt(input);
				if (lost) {
					lost = false;
					throw noAnswer();
				}
			},
		});
		const passes = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
		write("Fix the flaky test");
		await send();
		await passes(500);
		expect(field().value).toBe("Fix the flaky test");
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("did not answer");
		await send();
		await passes(500);
		expect(field().value).toBe("");
		expect(sent).toHaveLength(2);
		expect(messages).toEqual(["Fix the flaky test"]);
		close();
		client.dispose();
	});
});
