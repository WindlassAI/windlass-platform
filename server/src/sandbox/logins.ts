/**
 * Sign in with ChatGPT, done by Windlass itself in throwaway containers:
 *
 *   start   `windlass login start --no-browser` in a fresh volume wlp-login-<attemptId>
 *   finish  `windlass login finish`, the pasted address on stdin (never on a command line)
 *   adopt   auth.json and host-id copied into wlp-user-<uid>, the attempt volume removed
 *
 * The account is read from auth.json inside a container that prints only `sub`, `email` and
 * `expiresAt`: tokens never leave the volume.
 */

import { type ChatgptAccount, type ChatgptLogins, SandboxUserError } from "./api.js";
import { DATA_DIR, LABEL, helperFlags, removeVolume, runHelper, tmpName, volumeExists } from "./docker.js";
import { assertName, ensureDataVolume, ensureUserVolume, loginVolume, userVolume } from "./volumes.js";

const READ_ACCOUNT = `
import json, sys
try:
    with open(sys.argv[1]) as f:
        c = json.load(f)
except FileNotFoundError:
    print("null"); sys.exit(0)
a = c.get("account") or {}
sub = a.get("sub")
if not isinstance(sub, str):
    print("null"); sys.exit(0)
email = a.get("email")
exp = c.get("expiresAt")
print(json.dumps({"sub": sub, "email": email if isinstance(email, str) else None, "accessExpiresAt": exp if isinstance(exp, (int, float)) else None}))
`;

const ADOPT = `
set -eu
src=/mnt/login
dst=${DATA_DIR}
[ -f "$src/auth.json" ] || exit 3
for f in auth.json host-id; do
  [ -f "$src/$f" ] || continue
  cp "$src/$f" "$dst/.$f.adopt"
  chmod 600 "$dst/.$f.adopt"
  mv -f "$dst/.$f.adopt" "$dst/$f"
done
rm -f "$dst/auth-pending.json"
`;

/** What Windlass's `sign-in failed: <message> (<code>)` becomes for the user. */
const FRIENDLY: Record<string, string> = {
	no_pending_login: "This sign-in attempt is no longer waiting for an address. Start the sign-in again.",
	state_mismatch: "That address belongs to a different sign-in attempt. Start the sign-in again and paste the address of the page the browser ended on.",
	missing_code: "That address has no authorization code. Paste the full address of the page the browser ended on.",
	access_denied: "The sign-in was not approved in the browser.",
	plan_usage_not_granted: "The sign-in worked, but ChatGPT plan usage was not granted. Sign in again and allow it.",
	registration_incomplete: "OpenAI did not finish registering this app for your account. Start the sign-in again.",
};

async function readAccount(volume: string): Promise<ChatgptAccount | null> {
	const helper = tmpName();
	const result = await runHelper([...helperFlags(helper, "none"), "-v", `${volume}:${DATA_DIR}:ro`], helper, ["python3", "-I", "-c", READ_ACCOUNT, `${DATA_DIR}/auth.json`], { timeoutMs: 60_000 });
	if (result.code !== 0) throw new Error(`could not read the sign-in: ${result.stderr.trim()}`);
	const parsed = JSON.parse(result.stdout.trim()) as ChatgptAccount | null;
	return parsed;
}

export class DockerChatgptLogins implements ChatgptLogins {
	async start(attemptId: string): Promise<{ url: string; redirectPrefix: string }> {
		const volume = loginVolume(attemptId);
		await removeVolume(volume); // calling it again restarts the attempt
		await ensureDataVolume(volume, { [`${LABEL}.login`]: attemptId });
		const helper = tmpName();
		// `login start` makes no network request: it saves the PKCE state and prints the address.
		const result = await runHelper([...helperFlags(helper, "none"), "-v", `${volume}:${DATA_DIR}`], helper, ["windlass", "login", "start", "--no-browser"], { timeoutMs: 60_000 });
		const url = result.stdout
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.startsWith("https://"));
		if (result.code !== 0 || url === undefined) {
			await removeVolume(volume);
			throw new Error(`windlass login start failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
		}
		const redirectPrefix = new URL(url).searchParams.get("redirect_uri") ?? "http://127.0.0.1:1455/auth/callback";
		return { url, redirectPrefix };
	}

	async finish(attemptId: string, pastedUrl: string): Promise<ChatgptAccount> {
		const volume = loginVolume(attemptId);
		if (!(await volumeExists(volume))) throw new SandboxUserError("This sign-in attempt is unknown or has expired. Start the sign-in again.");
		const pasted = checkPasted(pastedUrl);
		const helper = tmpName();
		// The token exchange needs the network. The address goes in on stdin, one line.
		const result = await runHelper([...helperFlags(helper, "bridge"), "-v", `${volume}:${DATA_DIR}`], helper, ["windlass", "login", "finish"], { stdin: `${pasted}\n`, timeoutMs: 90_000 });
		if (result.timedOut) throw new SandboxUserError("OpenAI did not answer in time. Try again.");
		if (result.code !== 0) {
			const match = /sign-in failed: ([\s\S]*?) \(([A-Za-z0-9_]+)\)\s*$/.exec(result.stderr.trim());
			if (match) throw new SandboxUserError(FRIENDLY[match[2]!] ?? match[1]!);
			throw new SandboxUserError(`The sign-in could not be finished: ${result.stderr.trim().replace(/^windlass: /, "") || `exit ${result.code}`}`);
		}
		const account = await readAccount(volume);
		if (account === null) throw new Error("windlass login finish succeeded but left no sign-in");
		return account;
	}

	async adopt(attemptId: string, uid: string): Promise<void> {
		const from = loginVolume(attemptId);
		const to = userVolume(uid);
		if (!(await volumeExists(from))) throw new SandboxUserError("This sign-in attempt is unknown or has expired. Start the sign-in again.");
		await ensureUserVolume(uid);
		const helper = tmpName();
		const result = await runHelper([...helperFlags(helper, "none"), "-v", `${to}:${DATA_DIR}`, "-v", `${from}:/mnt/login:ro`], helper, ["sh", "-c", ADOPT], { timeoutMs: 60_000 });
		if (result.code === 3) throw new SandboxUserError("This sign-in is not finished yet.");
		if (result.code !== 0) throw new Error(`could not save the sign-in: ${result.stderr.trim()}`);
		await removeVolume(from);
	}

	async discard(attemptId: string): Promise<void> {
		await removeVolume(loginVolume(attemptId));
	}

	async status(uid: string): Promise<ChatgptAccount | null> {
		const volume = userVolume(uid);
		if (!(await volumeExists(volume))) return null;
		return readAccount(volume);
	}

	async logout(uid: string): Promise<void> {
		const volume = userVolume(uid);
		if (!(await volumeExists(volume))) return;
		const helper = tmpName();
		const result = await runHelper([...helperFlags(helper, "none"), "-v", `${volume}:${DATA_DIR}`], helper, ["windlass", "login", "logout"], { timeoutMs: 60_000 });
		if (result.code !== 0) throw new Error(`windlass login logout failed: ${result.stderr.trim()}`);
	}

	async ensureUserVolume(uid: string): Promise<void> {
		assertName(uid, "user id");
		await ensureUserVolume(uid);
	}
}

/** The address must be the loopback page the browser ended on, on one line, with a `state`. */
function checkPasted(text: string): string {
	const trimmed = typeof text === "string" ? text.trim() : "";
	const wrong = new SandboxUserError("That is not the address the browser ended on. It starts with http://127.0.0.1:1455/auth/callback?code=");
	if (trimmed === "" || /[\r\n]/.test(trimmed) || trimmed.length > 8192) throw wrong;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw wrong;
	}
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/auth/callback" || !url.searchParams.has("state")) throw wrong;
	return trimmed;
}
