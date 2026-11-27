/**
 * Checks against the real service that no user of an E2B sandbox can become root. E2B's template build adds its
 * own base system (an OpenSSH server that lets root in, rpcbind, `root` and `user` with empty passwords); the
 * provider takes that away at every create, resume and restart (server/src/sandbox/e2b/guest-hardening.ts).
 *
 *   cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-hardening-check.ts
 *   cd server && E2B_API_KEY=e2b_... WLP_E2B_TEMPLATE=windlass-platform-sandbox-claude npx tsx ../scripts/e2b-hardening-check.ts
 *
 * With one sandbox of the configured small template (WLP_E2B_TEMPLATE names another), made through the provider as
 * production makes it:
 *
 *   1. after create, as the agent: `ssh root@127.0.0.1` fails, nothing listens on port 22, `su` to root and to
 *      `user` fail without a terminal, `sudo -n` fails; as root: no account has an empty password;
 *   2. as root, E2B's state is put back (ssh and rpcbind unmasked and started, `user`'s password emptied), the
 *      sandbox is paused and connected again through the provider: the same checks pass, so a resume hardens it;
 *   3. it is paused and started again from its disk (what the provider does with a sandbox that does not answer):
 *      before anything runs, port 22 is closed and no password is empty, since the masks and locks are on its disk;
 *      a connect from a provider that has not seen it then hardens it and the checks pass again.
 *
 * Whatever happens, `finally` kills every sandbox with this run's own deployment label. Exit code 0 when every
 * check passed, 1 when one failed, 2 without a key.
 */

import type { E2bClient, E2bConnection } from "../server/src/sandbox/e2b/client.js";
import { cleanupDeployment } from "../server/src/sandbox/e2b/cleanup.js";
import { readE2bSettings } from "../server/src/sandbox/e2b/config.js";
import { type E2bSandboxHandle, META, e2bSandboxes } from "../server/src/sandbox/e2b/sandboxes.js";
import { randomId } from "../server/src/sandbox/provider.js";
import { shellQuote } from "../server/src/util.js";
import { oneLine, Report } from "./check-report.js";

const tally = new Report();
const { expect, fail } = tally;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether something listens on TCP port 22, read from /proc as any user can (no `ss` needed). */
const LISTENING_22 = `for table in /proc/net/tcp /proc/net/tcp6; do [ -r "$table" ] && awk 'FNR > 1 && $4 == "0A" && $2 ~ /:0016$/ { found = 1 } END { exit !found }' "$table" && { echo listening; exit 0; }; done; echo closed`;
/** As root: the accounts whose password field is empty. */
const EMPTY_PASSWORDS = `awk -F: '$2 == "" { print $1 }' /etc/shadow /etc/passwd; echo end`;
/** As root: what E2B's base system had, back again (the regression a resume must undo). */
const UNDO = `for unit in ssh.socket ssh.service sshd.socket sshd.service rpcbind.socket rpcbind.service; do
  [ "$(readlink /etc/systemd/system/$unit 2>/dev/null)" = /dev/null ] && rm -f /etc/systemd/system/$unit
done
systemctl daemon-reload
systemctl start ssh.socket 2>/dev/null || systemctl start ssh.service 2>/dev/null
systemctl start rpcbind.socket rpcbind.service 2>/dev/null
id -u user >/dev/null 2>&1 && passwd -d user >/dev/null
echo undone`;

async function step(name: string, body: () => Promise<void>): Promise<void> {
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		fail(`${name}: unexpected error`, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
}

/** A script as root straight over E2B's connection, with nothing of the provider's run before it. */
async function rawRoot(connection: E2bConnection, script: string): Promise<string> {
	let out = "";
	const command = await connection.start(`sh -c ${shellQuote(script)}`, {
		root: true,
		cwd: "/",
		stdin: false,
		onStdout: text => (out += text),
	});
	await command.wait();
	return out.trim();
}

/** What an agent's command can do, and what root sees: every check of a hardened guest. */
async function hardened(handle: E2bSandboxHandle, when: string): Promise<void> {
	const agent = async (command: string) => {
		const result = await handle.run(command, { timeoutMs: 30_000 });
		return { code: result.exitCode, out: `${result.stdout}${result.stderr}`.trim() };
	};
	const whoami = await agent("id -un");
	expect(`${when}: commands run as agent`, whoami.out === "agent", whoami.out);
	const ssh = await agent(
		"ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 root@127.0.0.1 id -un </dev/null",
	);
	expect(
		`${when}: ssh root@127.0.0.1 fails`,
		ssh.code !== 0 && !/^root$/m.test(ssh.out),
		`exit ${ssh.code}: ${oneLine(ssh.out).slice(0, 200)}`,
	);
	const port = await agent(LISTENING_22);
	expect(`${when}: nothing listens on port 22`, port.out === "closed", port.out);
	const su = await agent("timeout 10 su -c 'id -un' root </dev/null");
	expect(
		`${when}: su to root fails without a terminal`,
		su.code !== 0 && !/^root$/m.test(su.out),
		`exit ${su.code}: ${oneLine(su.out).slice(0, 200)}`,
	);
	const suUser = await agent("timeout 10 su -c 'id -un' user </dev/null");
	expect(
		`${when}: su to E2B's user fails without a terminal`,
		suUser.code !== 0 && !/^user$/m.test(suUser.out),
		`exit ${suUser.code}: ${oneLine(suUser.out).slice(0, 200)}`,
	);
	const sudo = await agent("sudo -n id -un </dev/null");
	expect(
		`${when}: sudo -n fails`,
		sudo.code !== 0 && !/^root$/m.test(sudo.out),
		`exit ${sudo.code}: ${oneLine(sudo.out).slice(0, 200)}`,
	);
	// E2B's own agent runs every command as any user; it must refuse a request without the sandbox's access token.
	const envd = await agent(
		"curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:49983/process.Process/List",
	);
	console.log(`INFO  ${when}: envd answers an agent's request without a token with HTTP ${envd.out}`);
	expect(`${when}: envd does not serve an agent's request without a token`, envd.out !== "200", envd.out);
	const empty = await handle.rootAnswer(EMPTY_PASSWORDS, [], { timeoutMs: 30_000 });
	expect(
		`${when}: no account has an empty password (read as root)`,
		empty?.code === 0 && empty.stdout.trim() === "end",
		oneLine(empty?.stdout ?? "no answer"),
	);
}

async function main(): Promise<number> {
	const apiKey = (process.env.E2B_API_KEY ?? "").trim();
	if (apiKey === "") {
		console.error("e2b-hardening-check: E2B_API_KEY is not set, so nothing was done.");
		return 2;
	}
	const deployment = `check-${randomId(4)}`;
	const settings = {
		...readE2bSettings(),
		deployment,
		maxRunning: 1,
		pause: true,
		windlassSandbox: false,
		openProfile: false,
		modelRelayOrigin: null,
	};
	console.log(
		`e2b-hardening-check: template "${settings.templates.small.template}", deployment label "${deployment}". Should this process be killed, remove its sandbox with: npx tsx ../scripts/e2b-cleanup.ts --deployment ${deployment} --kill`,
	);
	const { createE2bSdkClient } = await import("../server/src/sandbox/e2b/sdk.js");
	const client: E2bClient = createE2bSdkClient(apiKey);
	const log = (line: string) => console.log(`      ${line}`);
	const provider = () => e2bSandboxes(client, settings, { log });
	const sandboxes = provider();
	try {
		let id = "";
		let handle: E2bSandboxHandle | undefined;
		await step("create", async () => {
			id = await sandboxes.create({ uid: "e2b-check", sessionId: `check-${deployment}`, profile: "e2b" });
			handle = (await sandboxes.connect(id)) as E2bSandboxHandle;
			await hardened(handle, "after create");
		});
		if (handle === undefined) return tally.summary();

		await step("resume", async () => {
			const undone = await handle!.rootAnswer(UNDO, [], { timeoutMs: 60_000 });
			const port = await handle!.rootAnswer(LISTENING_22, [], { timeoutMs: 30_000 });
			expect(
				"E2B's state is back before the pause (so the resume has something to undo)",
				undone?.stdout.includes("undone") === true && port?.stdout.trim() === "listening",
				`${oneLine(undone?.stdout ?? "no answer")} / port 22 ${port?.stdout.trim()}`,
			);
			await sandboxes.suspend(id);
			handle = (await sandboxes.connect(id)) as E2bSandboxHandle;
			await hardened(handle, "after resume");
		});

		await step("restart from disk", async () => {
			await client.pause(id);
			const fresh = await client.connect(id, settings.idleTimeoutMs, { reboot: true });
			if (fresh === undefined) throw new Error("the sandbox was gone after it was paused");
			// Before the provider runs anything: what the boot itself brought up.
			const port = await rawRoot(fresh, LISTENING_22);
			const empty = await rawRoot(fresh, EMPTY_PASSWORDS);
			expect(
				"a start from the disk brings neither sshd nor an empty password back (the masks and locks are on its disk)",
				port === "closed" && empty === "end",
				`port 22 ${port}; empty: ${oneLine(empty)}`,
			);
			// A provider that has not seen it, as after a restart of the server: it hardens it at its connect.
			const again = (await provider().connect(id)) as E2bSandboxHandle;
			await hardened(again, "after a start from the disk");
		});
	} finally {
		console.log("\n== cleanup");
		try {
			const report = await cleanupDeployment(client, deployment, { kill: true });
			for (const line of report.lines) console.log(`      ${line}`);
			expect(
				"nothing of this run is left at E2B",
				report.failed.length === 0 && (await client.list({ metadata: { [META.deployment]: deployment } })).length === 0,
				report.failed.map(item => `${item.sandboxId}: ${item.reason}`).join("; "),
			);
		} catch (error) {
			fail(
				"nothing of this run is left at E2B",
				`the cleanup itself failed (${messageOf(error)}). Run: npx tsx ../scripts/e2b-cleanup.ts --deployment ${deployment} --kill`,
			);
		}
	}
	return tally.summary();
}

main().then(
	code => process.exit(code),
	(error: unknown) => {
		console.error(`e2b-hardening-check: ${messageOf(error)}`);
		process.exit(1);
	},
);
