// @vitest-environment jsdom
/**
 * The mock's machines: what the Machines page is looked at with, by hand and here. It answers as the
 * server's user actor says it does (contract.ts, `UserActions.machines` and the four calls after it).
 */
import { workingCounts } from "../lib/repositories";
import { MAX_MACHINES, type AuthResult, type CreateSessionInput, type MachineSummary } from "@contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAuth } from "../lib/authStore";
import { NewAgent } from "../screens/NewAgent";
import { AppProvider } from "../state/app";
import type { UserApi } from "./client";
import { createMockClient, MOCK_MACHINE_STATES, type MockClient, type MockMachineSession } from "./mock";

const auth = { token: "mock:chatgpt:u_machines:ada@example.com", profile: { uid: "u_machines", email: "ada@example.com", demo: false } };
const make = (machine?: (typeof MOCK_MACHINE_STATES)[number]) => createMockClient({ pace: 0, machine });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the mock's machines", () => {
	it("offers machines unless told not to, with an install command only once a runner is published", async () => {
		const on = make();
		const info = await on.info();
		expect(info.machines?.runnerImage).toMatch(/@sha256:[0-9a-f]{64}$/);
		expect(info.machines?.minRunnerVersion).toBe("0.2.0");
		expect((await make("unpublished").info()).machines?.runnerImage).toBeNull();
		const off = make("off");
		expect((await off.info()).machines).toBeUndefined();
		await expect(off.user(auth).machines()).rejects.toMatchObject({ reason: "machines_off" });
		on.dispose();
		off.dispose();
	});

	it("names each sandbox by its agent's title, and none for an agent that was deleted", async () => {
		const mock = make();
		const [nas] = await mock.user(auth).machines();
		expect(nas?.status).toBe("online");
		expect(nas?.sandboxes.map((sandbox) => sandbox.title)).toEqual(["Run the tests on my machine", null]);
		mock.dispose();
	});

	it("lists each machine's sandboxes as its runner reported them, none before it reported", async () => {
		const profiles = async (state: (typeof MOCK_MACHINE_STATES)[number]) => {
			const mock = make(state);
			const list = await mock.user(auth).machines();
			mock.dispose();
			return list.map((machine) => machine.profiles.map((profile) => profile.available));
		};
		expect(await profiles("online")).toEqual([[true, true]]);
		expect(await profiles("pairing")).toEqual([[]]);
		expect(await profiles("docker")).toEqual([[false, false]]);
		expect(await profiles("full")).toEqual([
			[true, true],
			[false, true],
			[true, true],
		]);
	});

	it("launches an agent on a machine with one of its sandboxes, outside the day's sandbox time", async () => {
		const mock = createMockClient({ pace: 0, usage: "used" });
		const user = mock.user(auth);
		const made = await user.createSession({ place: { kind: "machine", machineId: "m_nas" }, profile: "docker-hardened", title: "On nas" });
		expect(made.place).toEqual({ kind: "machine", machineId: "m_nas" });
		const session = mock.session(auth, made.id);
		const snapshots: Array<{ machine?: unknown; profile: string }> = [];
		const close = session.open({ onSnapshot: (snapshot) => snapshots.push({ machine: snapshot.machine, profile: snapshot.profile.name }), onItem: () => undefined, onDelta: () => undefined, onSummary: () => undefined, onQuestion: () => undefined, onConnection: () => undefined });
		await tick();
		expect(snapshots[0]).toEqual({ machine: null, profile: 'Hardened Docker on your machine "nas"' });
		// The day's time is used up, and a turn on the user's own machine starts all the same.
		expect(await session.prompt({ text: "What is 1 + 1, to be sure?" })).toEqual({ turn: 1, steered: false });
		await expect(user.createSession({ place: { kind: "machine", machineId: "m_nas" }, profile: "e2b" })).rejects.toThrow("There is no such sandbox.");
		close();
		mock.dispose();
	});

	it("fails a turn at once with the server's sentence when the agent's machine is offline or removed, and its snapshot says so", async () => {
		const failed = async (machineSession: MockMachineSession) => {
			const mock = createMockClient({ pace: 0, machineSession });
			const session = mock.session(auth, "nas-tests");
			const seen: { machine?: unknown; message?: string | null } = {};
			const close = session.open({
				onSnapshot: (snapshot) => (seen.machine = snapshot.machine?.state),
				onItem: (item) => {
					if (item.kind === "turn.ended" && item.outcome === "error") seen.message = item.message;
				},
				onDelta: () => undefined,
				onSummary: () => undefined,
				onQuestion: () => undefined,
				onConnection: () => undefined,
			});
			await tick();
			const before = seen.machine;
			await session.prompt({ text: "Run the tests again." });
			await tick();
			session.resync();
			await new Promise((resolve) => setTimeout(resolve, 80));
			close();
			mock.dispose();
			return { before, after: seen.machine, message: seen.message };
		};
		expect(await failed("offline")).toEqual({ before: "answering", after: "offline", message: `Your machine "nas" is offline. The agent's files are there; send the prompt again when it is back.` });
		expect(await failed("removed")).toEqual({ before: "removed", after: "removed", message: "This agent's machine was removed. Its files were there. Start a new agent to go on." });
	});

	it("tells the open page when the machine stops answering and when it is back", async () => {
		const mock = createMockClient({ pace: 0, machineSession: "not_answering" });
		const seen: string[] = [];
		const close = mock.session(auth, "nas-tests").open({ onSnapshot: (snapshot) => seen.push(`snapshot ${snapshot.machine?.state}`), onMachine: (machine) => seen.push(machine.state), onItem: () => undefined, onDelta: () => undefined, onSummary: () => undefined, onQuestion: () => undefined, onConnection: () => undefined });
		try {
			await vi.waitFor(() => expect(seen).toEqual(["snapshot answering", "not_answering", "answering"]));
		} finally {
			close();
			mock.dispose();
		}
	});

	it("starts a turn on a machine when the hosted agents working are at the ceiling", async () => {
		vi.useFakeTimers();
		try {
			const mock = createMockClient({});
			const user = mock.user(auth);
			const settle = async <T,>(promise: Promise<T>) => {
				await vi.advanceTimersByTimeAsync(400);
				return promise;
			};
			// Hosted agents fill the deployment's ceiling, beside the seeds' that are at work.
			const hosted = async () => (await settle(user.createSession({ profile: "docker-windlass-sandbox" }))).id;
			// A work item's turn counts wherever it runs (server/src/actors/user.ts, `internalAcquireRun`).
			const working = workingCounts(await settle(user.listSessions())).ceilinged;
			const { runningTurns } = await settle(user.factoryLimits());
			for (let filled = working; filled < runningTurns; filled++) await settle(mock.session(auth, await hosted()).prompt({ text: "Run the full build and the tests." }));
			const refused = expect(mock.session(auth, await hosted()).prompt({ text: "Run the full build and the tests." })).rejects.toMatchObject({ reason: "too_many_running" });
			await vi.advanceTimersByTimeAsync(400);
			await refused;
			const onNas = await settle(user.createSession({ place: { kind: "machine", machineId: "m_nas" }, profile: "docker-hardened" }));
			expect(await settle(mock.session(auth, onNas.id).prompt({ text: "Run the full build and the tests." }))).toEqual({ turn: 1, steered: false });
			mock.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("starts each state as its name says", async () => {
		const first = async (state: (typeof MOCK_MACHINE_STATES)[number]) => {
			const mock = make(state);
			const list = await mock.user(auth).machines();
			mock.dispose();
			return list;
		};
		expect(await first("none")).toEqual([]);
		expect((await first("pairing"))[0]).toMatchObject({ status: "waiting", sandboxes: [], commandSandbox: null });
		expect((await first("outdated"))[0]?.warnings).toEqual([{ kind: "outdated" }]);
		expect((await first("key"))[0]?.warnings[0]?.kind).toBe("key");
		expect(await first("full")).toHaveLength(MAX_MACHINES);
		const failed = make("failed");
		await expect(failed.user(auth).machines()).rejects.toMatchObject({ code: "network" });
		failed.dispose();
	});

	it("pairs a machine by its code, however it is typed, and its runner then connects", async () => {
		const mock = make("none");
		const user = mock.user(auth);
		const heard: MachineSummary[][] = [];
		const close = user.watch({ onSessions: () => undefined, onMachines: (list) => heard.push(list) });
		await tick();
		expect(await user.claimMachine({ code: "wxyz-12lo" })).toMatchObject({ name: "workstation", os: "Linux", arch: "x64" });
		const made = await user.confirmMachine({ code: "WXYZ 1210" });
		expect(made.status).toBe("waiting");
		// Asked again for the same code, it is the same machine.
		expect((await user.confirmMachine({ code: "WXYZ-1210" })).machineId).toBe(made.machineId);
		await tick();
		expect(heard.at(-1)?.map((machine) => machine.status)).toEqual(["online"]);
		close();
		mock.dispose();
	});

	it("refuses an unknown code, a sixth try in ten minutes, and a machine past the limit", async () => {
		const mock = make("none");
		const user = mock.user(auth);
		await expect(user.claimMachine({ code: "ZZZZ-ZZZZ" })).rejects.toMatchObject({ reason: "pairing_not_found" });
		for (const code of ["AAAA-0001", "AAAA-0002", "AAAA-0003", "AAAA-0004"]) await user.claimMachine({ code });
		await expect(user.claimMachine({ code: "AAAA-0005" })).rejects.toMatchObject({ reason: "too_many_claims" });
		mock.dispose();
		const full = make("full");
		await expect(full.user(auth).claimMachine({ code: "AAAA-0006" })).rejects.toMatchObject({ reason: "too_many_machines" });
		full.dispose();
	});

	it("removes a machine and turns its secrets off, answering with the list as it is then", async () => {
		const mock = make("full");
		const user = mock.user(auth);
		const [nas] = await user.machines();
		const off = await user.setMachineSecrets({ machineId: nas!.machineId, send: false });
		expect(off.find((machine) => machine.machineId === nas!.machineId)?.sendSecrets).toBe(false);
		const left = await user.removeMachine({ machineId: nas!.machineId, removeSandboxes: true });
		expect(left.map((machine) => machine.name)).toEqual(["workshop", "build-box"]);
		await expect(user.removeMachine({ machineId: nas!.machineId, removeSandboxes: false })).rejects.toMatchObject({ reason: "machine_not_found" });
		mock.dispose();
	});

	it("can be read once in the stale state, and not again after the connection dropped", async () => {
		const mock = make("stale");
		const user = mock.user(auth);
		const states: string[] = [];
		const close = user.watch({ onSessions: () => undefined, onConnection: (state) => states.push(state) });
		await tick();
		expect(await user.machines()).toHaveLength(1);
		await tick();
		await tick();
		expect(states).toContain("reconnecting");
		await expect(user.machines()).rejects.toMatchObject({ code: "network" });
		close();
		mock.dispose();
	});
});

// ---------------------------------------------------------------------------------------------
// The launch form on a machine that offers Claude Code
// ---------------------------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the launch form's agent picker", () => {
	let host: HTMLElement;
	let root: Root;
	let client: MockClient;
	let created: CreateSessionInput[];

	/** Lets the mock answer: in steps, so that what one answer renders can ask the next. */
	async function wait(steps = 8): Promise<void> {
		for (let step = 0; step < steps; step++) await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
	}

	/** Signs in to a mock whose machines stand as "full" says (nas offers Claude Code signed in, workshop signed out, build-box not at all) and opens the form. */
	async function open(): Promise<void> {
		vi.useFakeTimers();
		// jsdom has no <dialog> of its own that opens.
		HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
			this.setAttribute("open", "");
		};
		HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
			this.removeAttribute("open");
		};
		created = [];
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		client = createMockClient({ origin: "http://localhost:5173", machine: "full" });
		const begun = client.login.start();
		await vi.advanceTimersByTimeAsync(1000);
		const { redirectPrefix, url } = await begun;
		const finished = client.login.finish(`${redirectPrefix}?code=abc&state=${new URL(url).searchParams.get("state")}`);
		await vi.advanceTimersByTimeAsync(1000);
		const signedIn: AuthResult = await finished;
		saveAuth("mock", signedIn);
		const user = client.user.bind(client);
		(client as { user: (auth: AuthResult) => UserApi }).user = (who) => {
			const api = user(who);
			return { ...api, createSession: (input: CreateSessionInput) => (created.push(input), api.createSession(input)) };
		};
		act(() => root.render(createElement(AppProvider, { client, children: createElement(NewAgent) })));
		await wait();
	}

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		client.dispose();
		saveAuth("mock", null);
		vi.useRealTimers();
	});

	const text = () => host.textContent ?? "";
	const place = (value: string) => act(() => (host.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement).click());
	// The agent's choice; the mode under it is a segmented choice too (`modeSegments`).
	const segments = () => [...host.querySelectorAll(".harness-pick:not(.mode-pick) .segment")].map((segment) => segment.textContent);
	const agentPicker = () => host.querySelector(".harness-pick:not(.mode-pick) .segmented");
	const modeSegments = () => [...host.querySelectorAll(".mode-pick .segment")].map((segment) => ({ name: segment.textContent, chosen: (segment.querySelector("input") as HTMLInputElement).checked }));
	const modeSelect = () => host.querySelector(".mode-pick select") as HTMLSelectElement | null;
	const modeNote = () => host.querySelector(".mode-pick .field-note")?.textContent;
	const sandboxLine = () => [...host.querySelectorAll(".sandbox-pick .sandbox-chosen-facts")].at(-1)?.textContent ?? "";
	const launchIt = async () => {
		await act(async () => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
		await wait();
	};
	const LOGIN = "Claude Code: not signed in on “workshop”. Run windlass-runner login claude there.";

	it("offers Windlass or Claude Code on a machine that reports it, and its sign-in where it is not signed in", async () => {
		await open();
		place("m_workshop");
		expect(segments()).toEqual(["Windlass", "Claude Code"]);
		expect(text()).toContain(LOGIN);
		expect(host.querySelector(".harness-login pre")?.textContent).toBe("docker exec -it windlass-runner windlass-runner login claude");
		// Signed in on nas: the picker, and no sign-in line.
		place("m_nas");
		expect(segments()).toEqual(["Windlass", "Claude Code"]);
		expect(text()).not.toContain("not signed in");
	});

	it("shows no picker on a machine that reports no other harness, nor on this platform", async () => {
		await open();
		expect(agentPicker()).toBeNull();
		expect(text()).not.toContain("Claude Code");
		// The picker there is on nas, and it goes with the machine.
		place("m_nas");
		expect(segments()).toEqual(["Windlass", "Claude Code"]);
		place("m_build");
		expect(host.querySelector(".sandbox-chosen-name")?.textContent).toBe("build-box");
		expect(agentPicker()).toBeNull();
		place("platform");
		expect(agentPicker()).toBeNull();
	});

	it("launches Claude Code in the hardened container, on its default model, with the line that says what that means", async () => {
		await open();
		place("m_nas");
		place("claude");
		expect(text()).toContain("Claude Code runs in this container with your Claude subscription, in the mode chosen below. It does not run this repository's checks; CI's result is on the pull request.");
		// The place's line, then the sandbox's.
		expect([...host.querySelectorAll(".sandbox-chosen-name")].map((name) => name.textContent)).toEqual(["nas", 'Hardened Docker on your machine "nas"']);
		// No model to choose at launch: Claude Code's default.
		expect([...host.querySelectorAll("select")].some((select) => select.id && host.querySelector(`label[for="${select.id}"]`)?.textContent === "Model")).toBe(false);
		expect(text()).toContain("Claude Code's default");
		await act(async () => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
		await wait();
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ harness: "claude", profile: "docker-hardened", place: { kind: "machine", machineId: "m_nas" } });
		expect(created[0]?.model).toBeUndefined();
	});

	it("starts Claude Code on Auto, of its five modes, each said under the choice; another is sent when chosen", async () => {
		await open();
		place("m_nas");
		place("claude");
		const select = modeSelect() as HTMLSelectElement;
		expect([...select.options].map((option) => option.textContent)).toEqual(["Manual", "Accept edits", "Plan", "Auto", "Bypass permissions"]);
		expect(select.value).toBe("auto");
		expect(modeNote()).toBe("Automatically assess tool permissions.");
		act(() => {
			select.value = "plan";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(modeNote()).toBe("Plan the work before editing.");
		await launchIt();
		expect(created[0]).toMatchObject({ harness: "claude", mode: "plan" });
	});

	it("starts Windlass on the chosen sandbox's approval, of Ask and that one", async () => {
		await open();
		// This platform's first sandbox has Windlass's command sandbox: Ask and Auto, on Auto.
		expect(modeSelect()).toBeNull();
		expect(modeSegments()).toEqual([
			{ name: "Ask", chosen: false },
			{ name: "Auto", chosen: true },
		]);
		expect(modeNote()).toBe("Use Windlass’s command sandbox and ask when needed.");
		// The hardened container has none: Ask and Full, on Full.
		place("docker-hardened");
		expect(modeSegments()).toEqual([
			{ name: "Ask", chosen: false },
			{ name: "Full", chosen: true },
		]);
		await launchIt();
		expect(created[0]).toMatchObject({ profile: "docker-hardened", mode: "full" });
	});

	it("keeps a choice of Ask across sandboxes and agents, and stands on the default where the choice is not offered", async () => {
		await open();
		place("m_nas");
		place("ask");
		// Claude Code has no Ask: Auto, its default.
		place("claude");
		expect(modeSelect()?.value).toBe("auto");
		place("windlass");
		expect(modeSegments().find((segment) => segment.chosen)?.name).toBe("Ask");
		place("platform");
		expect(modeSegments().find((segment) => segment.chosen)?.name).toBe("Ask");
		await launchIt();
		expect(created[0]?.mode).toBe("ask");
	});

	it("says Claude Code's mode and its Claude login in the sandbox's facts, and Windlass's as before", async () => {
		await open();
		expect(sandboxLine()).toContain("runs what the sandbox contains, refuses the rest");
		expect(sandboxLine()).toContain("commands cannot read the session's access token");
		place("m_nas");
		place("claude");
		expect(sandboxLine()).toContain("runs in Auto mode");
		expect(sandboxLine()).toContain("commands can read your Claude login token");
		expect(sandboxLine()).not.toContain("access token");
		expect(sandboxLine()).not.toContain("without asking");
		const facts = host.querySelector(".sandbox-cards .facts")?.textContent ?? "";
		expect(facts).toContain("approvalAutoAutomatically assess tool permissions.");
		expect(facts).toContain("commands in this container can read your Claude login token");
		expect(facts).not.toContain("ChatGPT");
		expect(facts).not.toContain("runs every call without asking");
	});
});
