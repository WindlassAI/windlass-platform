// Driven through the real actors by runner-e2e.ts fairness; Docker is a stand-in.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createClient, type Registry } from "../server/src/client.js";
import { StandInRunner, until } from "./runner-standin.js";

type Check = (name: string, run: () => Promise<string>) => Promise<void>;
export async function machineFairnessChecks(check: Check, client: ReturnType<typeof createClient<Registry>>, runner: StandInRunner, token: string, storage: string) {
	const { uid, machineId } = runner.id;
	const user = client.user.get([uid], { params: { token } });
	for (const scenario of ["FIFO admission", "stop while waiting", "reconnect while waiting"]) {
		await check(scenario, async () => {
			const sessions: string[] = [];
			async function prompt(blocking: boolean) {
				const s = await user.createSession({ place: { kind: "machine", machineId }, profile: "docker-hardened",
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
					return snap.timeline.some(i => i.kind === "platform" && i.text.includes("2 of 2 busy"));
				}, 8000);
			}
			try {
				const first = await prompt(true), second = await prompt(true);
				await until("both slots to be busy", () => active(first.id) && active(second.id));
				const third = await prompt(true);
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
				await first.handle.stop();
				if (scenario !== "stop while waiting") {
					await until("the third turn to start first", () => active(third.id));
					await queued(fourth);
					await third.handle.stop();
				}
				await until("the fourth turn to finish", async () => (await fourth.handle.snapshot()).summary.lastOutcome === "succeeded");
				if (scenario === "stop while waiting") assert.ok(!runner.served.has(third.id));
				return "two occupied slots, next eligible prompt starts in order";
			} finally {
				await Promise.all(sessions.map(id => client.agentSession.get([uid, id], { params: { token } }).stop()));
				for (const id of sessions) await user.deleteSession(id);
			}
		});
	}
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
