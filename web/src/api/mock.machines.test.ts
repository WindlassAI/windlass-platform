/**
 * The mock's machines: what the Machines page is looked at with, by hand and here. It answers as the
 * server's user actor says it does (contract.ts, `UserActions.machines` and the four calls after it).
 */
import { MAX_MACHINES, type MachineSummary } from "@contract";
import { describe, expect, it, vi } from "vitest";
import { createMockClient, MOCK_MACHINE_STATES, type MockMachineSession } from "./mock";

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
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(seen).toEqual(["snapshot answering", "not_answering", "answering"]);
		close();
		mock.dispose();
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
			const working = (await settle(user.listSessions())).filter((session) => session.status !== "idle" && session.place.kind === "hosted").length;
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
