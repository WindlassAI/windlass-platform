// @vitest-environment jsdom
/**
 * The mock's Claude Code agent on "nas" (api/mock.ts, `nas-claude`): its page draws the turn in the
 * platform's own blocks and leaves out what Claude Code does not do. The composer offers only the
 * pickers the harness gave a choice for, and a call has no stop button of its own.
 *
 * And every agent's mode on its page: the composer's picker before the model, which follows the live
 * summary, the panel's line, and none on a work item's agent, whose mode is its profile's.
 */
import type { MachineSummary, AuthResult, ModelList, SessionSummary } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, type MockClient } from "../api/mock";
import { Composer } from "../components/Composer";
import acpSource from "../lib/acp.ts?raw";
import { signInWords } from "../lib/acp";
import { saveAuth } from "../lib/authStore";
import { AppProvider } from "../state/app";
import { useSession } from "../state/hooks";
import { Session, SessionCrumb } from "./Session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let client: MockClient;
let auth: AuthResult;

async function wait(steps = 6): Promise<void> {
	for (let step = 0; step < steps; step++) {
		await act(async () => {
			vi.advanceTimersByTime(400);
		});
	}
}

/** Waits until `ready` holds, a step of the mock's time at once, for at most `steps` steps. */
async function until(ready: () => boolean, steps = 60): Promise<void> {
	for (let step = 0; step < steps && !ready(); step++) await wait(1);
	expect(ready()).toBe(true);
}

function Page({ id, machine }: { id: string; machine?: MachineSummary }) {
	return createElement(Session, { sessionId: id, state: useSession(id), machine });
}

/** Opens the agent `id`, or the one `pick` chooses of the user's agents. */
async function open(
	id:
		| string
		| { harness: "claude" | "opencode" | "codex" }
		| ((sessions: SessionSummary[]) => SessionSummary | undefined),
	machine?: MachineSummary,
): Promise<void> {
	client = createMockClient({ origin: "http://localhost:5173", machine: typeof id === "object" ? "fresh" : "online" });
	const begun = client.login.start();
	vi.advanceTimersByTime(1000);
	const { redirectPrefix, url } = await begun;
	const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
	vi.advanceTimersByTime(1000);
	auth = await finished;
	saveAuth("mock", auth);
	if (typeof id === "object") {
		const pending = client.user(auth).createSession({
			place: { kind: "machine", machineId: "m_workshop" },
			harness: id.harness,
			profile: "docker-hardened",
		});
		await vi.advanceTimersByTimeAsync(1000);
		id = (await pending).id;
	} else if (typeof id !== "string") {
		const listed = client.user(auth).listSessions();
		vi.advanceTimersByTime(1000);
		const found = id(await listed);
		expect(found).toBeDefined();
		id = (found as SessionSummary).id;
	}
	const shown = id;
	act(() => root.render(createElement(AppProvider, { client, children: createElement(Page, { id: shown, machine }) })));
	await wait();
}

beforeEach(() => {
	vi.useFakeTimers();
	// jsdom lays nothing out, and scrolls nothing.
	Element.prototype.scrollTo ??= function scrollTo() {};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client?.dispose();
	saveAuth("mock", null);
	vi.useRealTimers();
});

const pickers = () =>
	[...host.querySelectorAll(".composer-selects [data-picker]")].map(pill => (pill as HTMLElement).dataset.picker);
const text = () => host.textContent ?? "";

it.each(["claude", "opencode", "codex"] as const)(
	"shows %s models and modes in the idle composer and panel before its first turn",
	async harness => {
		await open({ harness });
		// Codex's own plan mode (`capabilities.planMode`), not the items' Plan first.
		// It is one of the composer's pickers, not a control of its own outside the composer.
		if (harness === "codex") expect(pickers()).toContain("plan-mode");
		else expect(host.textContent).not.toContain("Plan mode");
		expect(host.querySelector(".session-main select")).toBeNull();
		expect(host.textContent).not.toContain("Plan first");
		const names =
			harness === "codex"
				? ["6.2 Sol (default)"]
				: harness === "claude"
					? ["Default (recommended)", "Opus", "Haiku"]
					: ["OpenAI/GPT-5.4 (default)", "OpenAI/GPT-5.4 mini"];
		const modeNames =
			harness === "codex"
				? ["Container access"]
				: harness === "claude"
					? ["Manual", "Accept edits", "Plan", "Auto", "Bypass permissions"]
					: ["build", "plan"];
		expect(host.querySelector("#panel-session")?.textContent).toContain("no turns yet");
		if (harness === "codex") {
			expect(host.querySelector(".composer-selects")?.textContent).toContain("6.2 Sol");
			expect(pickers()).toContain("effort");
		} else {
			act(() => (host.querySelector('[data-picker="model"]') as HTMLButtonElement).click());
			// The picker names them as every model picker does: clean, under their provider, the default tagged.
			const picked = harness === "claude" ? names : ["GPT-5.4", "GPT-5.4 mini"];
			expect(Array.from(document.querySelectorAll(".ui-pop .ui-item-label"), el => el.textContent)).toEqual(picked);
		}
		// Under "More", in a fold of its own that reads them once it is opened.
		const details = host
			.querySelector("#panel-session")!
			.closest("section")!
			.querySelector<HTMLDetailsElement>("details details")!;
		act(() => {
			details.open = true;
			details.dispatchEvent(new Event("toggle"));
		});
		expect(
			Array.from(details.querySelectorAll('[aria-label="Available models"] li'), el => el.firstChild?.textContent),
		).toEqual(names.map(name => name.replace(" (default)", "")));
		expect(Array.from(details.querySelectorAll('[aria-label="Available modes"] li'), el => el.textContent)).toEqual(
			modeNames,
		);
	},
);

it("documents the three sign-in labels used by the session and composer", () => {
	const comment = acpSource.match(/Its sign-in in a few words: ([^\n]+) [*]\//)?.[1];
	for (const signIn of ["token", "none", "unknown"] as const) {
		const words = signInWords({ id: "opencode", signIn, adapter: "OpenCode", image: "fixture" });
		expect(comment).toContain(JSON.stringify(words));
	}
});

it.each(["token", "none", "unknown"] as const)(
	"shows session login instructions only when OpenCode needs sign-in (%s)",
	async signIn => {
		await open({ harness: "opencode" }, {
			name: "workshop",
			harnesses: [{ id: "opencode", signIn, adapter: "OpenCode", image: "fixture" }],
		} as MachineSummary);
		const notice = host.querySelector(".session-main .session-notice");
		if (signIn === "token") expect(notice).toBeNull();
		else if (signIn === "none") {
			expect(notice?.textContent).toContain(
				"OpenCode is not signed in on “workshop”, so this agent cannot run a turn.",
			);
			expect(notice?.querySelector("pre")?.textContent).toContain("windlass-runner login opencode");
		} else {
			// A runner that could not check says nothing of the agent being unable to run: a quiet line, the command folded.
			expect(notice?.textContent).not.toContain("cannot run a turn");
			expect(notice?.querySelector("details summary")?.textContent).toBe(
				"Couldn't check OpenCode's sign-in on “workshop”. If a turn fails to start, sign in again:",
			);
			expect(notice?.querySelector("details:not([open]) pre")?.textContent).toContain("windlass-runner login opencode");
		}
	},
);

describe("a Claude Code agent's page", () => {
	it("shows its turn in the platform's blocks: the plan, the calls with the edit's diff, the context and the turn's tokens", async () => {
		await open("nas-claude");
		const turn = host.querySelector(".turn") as HTMLElement;
		expect(turn.querySelector(".block-plan")).not.toBeNull();
		// The three calls, settled one after the other, are one row of work, folded until it is opened.
		const work = turn.querySelector(".work-row") as HTMLButtonElement;
		expect(work.querySelector(".work-text")?.textContent).toBe("Read 1 file, changed 1 file and ran 1 command");
		expect(work.getAttribute("aria-expanded")).toBe("false");
		expect(turn.querySelectorAll(".tool-name")).toHaveLength(0);
		act(() => work.click());
		expect([...turn.querySelectorAll(".tool-name")].map(name => name.textContent)).toEqual(["read", "edit", "shell"]);
		expect([...turn.querySelectorAll(".tool-target")].map(target => target.textContent)).toEqual([
			"README.md",
			"README.md",
			"npm test",
		]);
		// The edit's diff, counted as Windlass's edits are.
		expect(turn.querySelectorAll(".tool")[1]?.querySelector(".tool-facts")?.textContent).toContain("+4 -0");
		expect(turn.querySelector(".turn-end")?.textContent).toContain("context 41% used");
		expect(turn.querySelector(".turn-end")?.textContent).toContain("$0.38 so far");
		expect(turn.querySelector(".turn-end")?.textContent).not.toContain("no token counts were reported");
		// The side panel: the cost first, the context, and under "Token details" the tokens the turn answered with, per turn; no cache chart, since it counts no calls.
		const usage = host.querySelector("[data-usage=context]");
		expect([...(usage?.querySelectorAll(".figure-value") ?? [])].map(value => value.textContent)).toEqual([
			"$0.38",
			"41%",
		]);
		expect(usage?.querySelector("details .tokens")?.textContent).toContain("24,300");
		expect(usage?.textContent).not.toContain("calls");
		expect(host.querySelector(".cache-calls")).toBeNull();
		// Its saved secrets are not handed to it (`envLists`), so the panel does not list them.
		expect(host.querySelector("#panel-secrets")).toBeNull();
	});

	it("has no effort picker, since Claude Code offered no thought_level, and the model picker its models", async () => {
		await open("nas-claude");
		expect(pickers()).toEqual(["mode", "model"]);
		// By the names Claude Code gave them; its default says so in its own name, so nothing is added to it.
		act(() => (host.querySelector('[data-picker="model"]') as HTMLButtonElement).click());
		expect(
			[...document.querySelectorAll('.ui-pop [role="menuitemradio"]')].map(row => [
				(row as HTMLElement).dataset.value,
				row.querySelector(".ui-item-label")?.textContent,
			]),
		).toEqual([
			["default", "Default (recommended)"],
			["opus", "Opus"],
			["haiku", "Haiku"],
		]);
	});

	it("draws no stop button on a running call, and puts Claude Code's question under the call it is about, without a note", async () => {
		await open("nas-claude");
		await act(
			async () => void client.session(auth, "nas-claude").prompt({ text: "Read the README again and run the tests." }),
		);
		const second = () => host.querySelectorAll(".turn")[1] as HTMLElement | undefined;
		await until(() => second()?.querySelector(".tool-running") != null);
		expect(second()?.querySelector(".tool-stop")).toBeNull();
		expect(second()?.querySelector(".tool-stoppable")).toBeNull();
		await until(() => second()?.querySelector(".tool .q-inline, .tool .q") != null);
		const asked = second()?.querySelector(".tool .q") as HTMLElement;
		expect(asked.closest(".tool")?.querySelector(".tool-name")?.textContent).toBe("shell");
		expect([...asked.querySelectorAll(".q-choice")].map(choice => choice.textContent)).toEqual(
			expect.arrayContaining(["Yes", "No"]),
		);
		expect(asked.textContent).not.toContain("add a note");
		await act(async () => (asked.querySelector(".q-choice") as HTMLButtonElement).click());
		await until(() => second()?.querySelector(".turn-end") != null);
		expect(second()?.querySelector(".tool-stop")).toBeNull();
	}, 30_000);
});

describe("an agent's mode on its page", () => {
	const picker = () => host.querySelector('[data-picker="mode"]') as HTMLButtonElement | null;
	const panelMode = () => {
		const facts = [...host.querySelectorAll("#panel-session ~ .kv dt")].find(term => term.textContent === "mode");
		return facts?.nextElementSibling?.textContent ?? null;
	};
	const pick = async (name: string) => {
		await act(async () => picker()?.click());
		await act(async () =>
			([...document.querySelectorAll('.ui-pop [role="menuitemradio"]')] as HTMLElement[])
				.find(option => option.querySelector(".ui-item-label")?.textContent === name)
				?.click(),
		);
	};
	/** The agent's mode as the mock holds it. */
	const modeOf = async () => {
		const listed = client.user(auth).listSessions();
		vi.advanceTimersByTime(1000);
		return (await listed).find(session => session.id === "nas-claude")?.mode;
	};

	it("has Claude Code's picker on Auto, whose choice the composer sends, and the panel says it", async () => {
		await open("nas-claude");
		expect(picker()?.textContent).toBe("Auto");
		expect(panelMode()).toBe("Auto");
		await pick("Plan");
		await wait(2);
		expect(await modeOf()).toBe("plan");
		expect(picker()?.textContent).toBe("Plan");
		expect(panelMode()).toBe("Plan");
		expect(host.querySelector("#panel-sandbox")?.closest("section")?.querySelector(".facts")?.textContent).toContain(
			"approvalPlanPlan the work before editing.",
		);
	});

	it("follows the mode Claude Code changes itself: a current_mode_update in the turn moves the picker and the panel", async () => {
		await open("nas-claude");
		await pick("Plan");
		await wait(2);
		expect(picker()?.textContent).toBe("Plan");
		// The recorded scenario leaves Plan for Accept edits, then asks before a command.
		await act(async () => void client.session(auth, "nas-claude").prompt({ text: "leaveplan" }));
		await until(() => picker()?.textContent === "Accept edits");
		expect(panelMode()).toBe("Accept edits");
		expect(await modeOf()).toBe("acceptEdits");
	});

	it("says in the panel's sandbox that commands can use the Claude login, and nothing of ChatGPT", async () => {
		await open("nas-claude");
		const sandbox = host.querySelector("#panel-sandbox")?.closest("section")?.textContent ?? "";
		// In a plain outcome line, not as a warning; the detail is under "How it's isolated".
		expect([...host.querySelectorAll("#panel-sandbox ~ .outcomes li")].map(line => line.textContent)).toContain(
			"Commands can use this machine's Claude login",
		);
		expect(
			host
				.querySelector("#panel-sandbox")
				?.closest("section")
				?.querySelector("[class*=warn], [class*=open]:not(.outcome-open)"),
		).toBeNull();
		expect(sandbox).toContain(
			"commands in this container can use your Claude login. Runners without a credential relay also expose the setup token.",
		);
		expect(sandbox).toContain("approvalAutoAutomatically assess tool permissions.");
		expect(sandbox).not.toContain("ChatGPT");
		expect(sandbox).not.toContain("access token");
		expect(sandbox).not.toContain("runs every call without asking");
	});

	it("gives a Windlass agent on a repository, by its flags, per-call tokens, no context section and its saved secrets", async () => {
		await open(sessions =>
			sessions.find(
				one => (one.harness ?? "windlass") === "windlass" && one.item === undefined && one.turns > 0 && one.repository,
			),
		);
		expect(host.querySelector("[data-usage=tokens] .cache-calls")).not.toBeNull();
		expect(host.querySelector("[data-usage=context]")).toBeNull();
		expect(host.querySelector("#panel-secrets")).not.toBeNull();
		expect(host.textContent).not.toContain("Plan mode");
	});

	it("gives a Windlass agent the picker of its sandbox's two modes, and its sandbox's facts as before", async () => {
		await open(sessions =>
			sessions.find(
				session =>
					session.item === undefined && session.harness !== "claude" && session.profile === "docker-windlass-sandbox",
			),
		);
		expect(picker()?.textContent).toBe("Auto");
		await act(async () => picker()?.click());
		expect(
			[...document.querySelectorAll('.ui-pop [role="menuitemradio"] .ui-item-label')].map(name => name.textContent),
		).toEqual(["Ask", "Auto"]);
		expect(panelMode()).toBe("Auto");
		const facts = host.querySelector("#panel-sandbox")?.closest("section")?.textContent;
		expect(facts).toContain("your ChatGPT sign-in is never in the sandbox");
		expect(facts).toContain("The agent's commands cannot read the session's access token.");
		expect(facts).toContain("Approved local MCP servers can read each token.");
	});

	it("draws no picker for a work item's agent, and says its profile's mode in the panel", async () => {
		await open(sessions => sessions.find(session => session.item?.role === "builder"));
		expect(host.querySelector(".item-note")).not.toBeNull();
		expect(host.querySelector(".mode-picker")).toBeNull();
		expect(document.querySelector(".ui-pop")).toBeNull();
		expect(panelMode()).toBe("Auto");
	});
});

describe("the composer of a Claude Code agent", () => {
	const list = (efforts: string[]): ModelList => ({
		source: "harness",
		defaultModel: "default",
		fetchedAt: null,
		models: [{ id: "default", name: null, efforts }],
	});
	const show = (models: ModelList, harness: string | null) =>
		act(() =>
			root.render(
				createElement(Composer, {
					status: "idle",
					online: true,
					models,
					model: "default",
					harness,
					onSend: async () => undefined,
					onStop: async () => undefined,
				}),
			),
		);

	it("draws the effort picker only when the harness offered a thought_level, and the model picker only with a choice", () => {
		show(list([]), "Claude Code");
		expect(pickers()).toEqual([]);
		expect(text()).toContain("Claude Code's default model");
		show(list(["low", "medium", "high"]), "Claude Code");
		expect(pickers()).toEqual(["effort"]);
		// Windlass's composer has its model's pill whatever the list; a model's efforts are in its submenu.
		show(list([]), null);
		expect(pickers()).toEqual(["model"]);
	});

	it("labels the agent with its harness beside the machine's name", () => {
		act(() =>
			root.render(
				createElement(SessionCrumb, {
					title: "Add the test command",
					status: "idle",
					place: { kind: "machine", machineId: "m_nas" },
					machine: null,
					harness: "claude",
				}),
			),
		);
		expect(host.querySelector(".crumb-place")?.textContent).toBe("Claude Code on your machine");
		act(() =>
			root.render(
				createElement(SessionCrumb, {
					title: "Add the test command",
					status: "idle",
					place: { kind: "machine", machineId: "m_nas" },
					machine: { name: "nas" } as never,
					harness: "claude",
				}),
			),
		);
		expect(host.querySelector(".crumb-place")?.textContent).toBe("Claude Code on “nas”");
		act(() =>
			root.render(
				createElement(SessionCrumb, {
					title: "Run the tests",
					status: "idle",
					place: { kind: "machine", machineId: "m_nas" },
					machine: { name: "nas" } as never,
				}),
			),
		);
		expect(host.querySelector(".crumb-place")?.textContent).toBe("On nas");
	});
});
