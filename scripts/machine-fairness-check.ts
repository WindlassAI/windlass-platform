// Driven through the real actors by runner-e2e.ts fairness; Docker is a stand-in.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createClient, type Registry } from "../server/src/client.js";
import { StandInRunner, until } from "./runner-standin.js";
import { DatabaseSync } from "node:sqlite";
import { serviceParams } from "../server/src/auth.js";
import { machine, machineTables, type MachineUpdate } from "../server/src/actors/machine.js";
import type { MachineSlotCapacity } from "../server/src/contract.js";

export async function weightedFifo(slots: MachineSlotCapacity, onGrant?: (name: string, size: number) => Promise<void>) {
	const db = new DatabaseSync(":memory:");
	const raw = { execute: async (q: string, ...params: (string | number | null)[]) => db.prepare(q).all(...params) } as Parameters<typeof machineTables>[0];
	try {
		db.exec("CREATE TABLE turn_slots (session TEXT, turn INTEGER, running INTEGER, PRIMARY KEY(session,turn)); INSERT INTO turn_slots VALUES ('first',1,1)");
		await machineTables(raw);
		db.exec("INSERT INTO machine (id,name,version,public_key,created) VALUES (1,'Mac','0.2.0','fixture',0)");
		let update: MachineUpdate | undefined;
		const c = { db: raw, key: ["owner", "machine"], conn: { params: serviceParams() },
			vars: { live: { maxTurns: 3, slots }, work: Promise.resolve(), nextSlotCheck: Infinity },
			client: () => ({ user: { get: () => ({ internalMachineChanged: (_: string, facts: MachineUpdate) => { update = facts; } }) } }) };
		const actions = machine.config.actions!;
		const request = async (name: string, size: number) => {
			const answer = await actions.internalTurnSlot(c as never, name, 1, size);
			if (answer.state === "granted") await onGrant?.(name, size);
			return answer;
		};
		assert.equal((await request("second", 1)).state, "granted");
		assert.equal((await request("large", 2)).state, "waiting");
		assert.equal((await request("small", 1)).state, "waiting");
		assert.deepEqual(update?.slots, { ...slots, busy: 2, queued: 3 });
		c.vars.live = { maxTurns: 3, slots };
		await actions.internalReleaseTurnSlot(c as never, "first", 1);
		assert.equal((await request("small", 1)).state, "waiting");
		assert.equal((await request("large", 2)).state, "granted");
		assert.deepEqual(update?.slots, { ...slots, busy: 3, queued: 1 });
		assert.equal((await request("large", 2)).state, "granted");
	} finally { db.close(); }
}

type Check = (name: string, run: () => Promise<string>) => Promise<void>;
export async function machineFairnessChecks(check: Check, client: ReturnType<typeof createClient<Registry>>, runner: StandInRunner, token: string, storage: string) {
	const { uid, machineId } = runner.id;
	const user = client.user.get([uid], { params: { token } });
	for (const scenario of ["FIFO admission", "stop while waiting", "reconnect while waiting", "weighted FIFO admission"]) {
		await check(scenario, async () => {
			const sessions: string[] = [];
			const weighted = scenario === "weighted FIFO admission";
			const capacity = runner.fake.report.slots!;
			if (weighted) {
				runner.fake.report.slots = { ...capacity, max: 3 };
				runner.report();
				await until("three reported slots", async () => (await user.machines()).some(m => m.slots?.max === 3));
			}
			async function prompt(blocking: boolean, size?: 2) {
				const s = await user.createSession({ place: { kind: "machine", machineId }, size, profile: "docker-hardened",
					...(blocking ? { repoUrl: "https://example.com/org/slow-clone.git" } : {}) });
				sessions.push(s.id);
				const handle = client.agentSession.get([uid, s.id], { params: { token } });
				assert.equal((await handle.prompt({ text: "Write the primes" })).turn, 1);
				return { id: s.id, handle };
			}
			const active = (id: string) => !!runner.served.get(id)?.runs.size;
			async function queued(s: Awaited<ReturnType<typeof prompt>>) {
				await until("waiting before the first sandbox operation", async () => {
					const snap = await s.handle.snapshot();
					assert.ok(!runner.served.has(s.id), "waiting turn reached the runner");
					return snap.timeline.some(i => i.kind === "platform" && i.text.includes(weighted ? "1 of 3 free" : "0 of 2 free"));
				}, 8000);
			}
			try {
				const first = await prompt(true), second = await prompt(true);
				await until("both slots to be busy", () => active(first.id) && active(second.id));
				const third = await prompt(true, weighted ? 2 : undefined);
				await queued(third);
				if (scenario === "stop while waiting") {
					await third.handle.stop();
					await until("the queued turn to stop", async () => (await third.handle.snapshot()).summary.lastOutcome === "interrupted");
				} else if (scenario === "reconnect while waiting") {
					const before = runner.control;
					before!.ws.close();
					await until("the replacement control socket", () => runner.control && runner.control !== before && runner.control.ws.readyState === 1);
					await queued(third);
				}
				const fourth = await prompt(false);
				await queued(fourth);
				if (weighted) {
					const machine = (await user.machines()).find(m => m.machineId === machineId)!;
					assert.deepEqual([machine.slots?.busy, machine.slots?.queued], [2, 3]);
					assert((await third.handle.snapshot()).timeline.some(i => i.kind === "platform" && i.text.includes("Waiting for 2 free slots")));
				}
				await first.handle.stop();
				if (scenario !== "stop while waiting") {
					await until("the third turn to start first", () => active(third.id));
					if (weighted) assert.equal([...runner.boxes.values()].find(box => box.sessionId === third.id)?.size, 2);
					await queued(fourth);
					await third.handle.stop();
				}
				await until("the fourth turn to finish", async () => (await fourth.handle.snapshot()).summary.lastOutcome === "succeeded");
				if (scenario === "stop while waiting") assert.ok(!runner.served.has(third.id));
				return "two occupied slots, next eligible prompt starts in order";
			} finally {
				await Promise.all(sessions.map(id => client.agentSession.get([uid, id], { params: { token } }).stop()));
				for (const id of sessions) await user.deleteSession(id);
				if (weighted) { runner.fake.report.slots = capacity; runner.report(); }
			}
		});
	}
	await check("machine facts and the session profile carry the runner’s name, egress mode and relay capability", async () => {
		const session = await user.createSession({ place: { kind: "machine", machineId }, profile: "docker-hardened" });
		const handle = client.agentSession.get([uid, session.id], { params: { token } });
		const repoInput = { place: { kind: "machine", machineId }, profile: "docker-hardened", repoUrl: "https://github.com/octocat/Hello-World.git" } as const;
		const repositorySession = await user.createSession(repoInput);
		const previous = (await user.machines()).find(m => m.machineId === machineId)!.name;
		try {
			runner.fake.report.name = "Workshop";
			for (const mode of ["restricted", "none", undefined] as const) {
				if (mode) {
					runner.fake.report.egress = mode;
					runner.fake.report.claudeRelay = true;
				} else {
					delete runner.fake.report.egress;
					delete runner.fake.report.claudeRelay;
				}
				runner.report();
				await until("updated machine egress", async () => (await user.machines()).some(m => m.machineId === machineId && m.name === "Workshop" && m.egress === (mode ?? "open") && m.claudeRelay === (mode ? true : undefined)));
				if (mode === "none") {
					await assert.rejects(user.createSession(repoInput), /--egress none/);
					await assert.rejects(client.agentSession.get([uid, repositorySession.id], { params: { token } }).prompt({ text: "Inspect files" }), /--egress none/);
				}
				await until("updated session profile", async () => {
					const profile = (await handle.snapshot()).profile;
					const text = mode === "restricted" ? /public/ : mode === "none" ? /no network/ : /local network/;
					return profile.name.includes("Workshop") && profile.claudeRelay === (mode ? true : undefined) && profile.commandNetwork === (mode !== "none") && text.test(profile.commandNetworkText ?? "");
				});
			}
		} finally {
			runner.fake.report.name = previous;
			delete runner.fake.report.egress;
			delete runner.fake.report.claudeRelay;
			runner.report();
			await user.deleteSession(repositorySession.id);
			await user.deleteSession(session.id);
		}
		return "restricted, none and legacy open";
	});
	await check("a failed online publish recovers the machine list without another report", async () => {
		const disk = 5555555;
		const marker = join(storage, "fail-online-publish");
		writeFileSync(marker, "");
		try {
			runner.fake.report.freeDiskBytes = disk;
			runner.report();
			await until("the publish refusal", () => existsSync(marker + ".seen"));
			rmSync(marker);
			await until("the retried online publish", async () => (await user.machines()).some(m => m.freeDiskBytes === disk), 9000);
		} finally { rmSync(marker, { force: true }); }
		return "the index recovered from the same runner state";
	});
	await check("a session with a cached offline banner recovers on snapshot without a prompt", async () => {
		const session = await user.createSession({ place: { kind: "machine", machineId }, profile: "docker-hardened" });
		const handle = client.agentSession.get([uid, session.id], { params: { token } }).connect();
		try {
			await runner.setOffline(true);
			await until("the offline machine", async () => (await user.machines()).some(m => m.status === "offline"));
			await handle.prompt({ text: "while offline" });
			await until("the failed turn and cached offline banner", async () => {
				const snap = await handle.snapshot();
				return snap.machine?.state === "offline" && snap.summary.lastOutcome === "error";
			});
			const marker = join(storage, "fail-online-publish");
			rmSync(marker + ".seen", { force: true });
			writeFileSync(marker, "");
			try {
				await runner.setOffline(false);
				await until("the publish refusal", () => existsSync(marker + ".seen"));
			} finally { rmSync(marker, { force: true }); }
			// A changed report fixes the list even on the old server. The session must heal independently.
			runner.fake.report.freeDiskBytes = 9876543;
			runner.report();
			await until("online list", async () => (await user.machines()).some(m => m.status === "online"));
			const before = runner.attaches;
			await until("the session snapshot to recover", async () => (await handle.snapshot()).machine?.state === "answering", 9000);
			assert.equal((await handle.snapshot()).summary.turns, 1);
			assert.equal(runner.attaches, before);
		} finally { await handle.dispose(); await user.deleteSession(session.id); }
		return "online on the next fresh snapshot, without an attach or another prompt";
	});
}
