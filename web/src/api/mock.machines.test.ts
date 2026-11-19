/**
 * The mock's machines: what the Machines page is looked at with, by hand and here. It answers as the
 * server's user actor says it does (contract.ts, `UserActions.machines` and the four calls after it).
 */
import { MAX_MACHINES, type MachineSummary } from "@contract";
import { describe, expect, it } from "vitest";
import { createMockClient, MOCK_MACHINE_STATES } from "./mock";

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
		expect(nas?.sandboxes.map((sandbox) => sandbox.title)).toEqual(["Check the site's response headers", "Check what the sandbox allows", null]);
		mock.dispose();
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
