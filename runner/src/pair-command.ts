import { rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { directory, origin, RunnerError } from "./state.js";

const path = join(directory, "pair.sock");

// The service owns the process lock while online and while idle. A local pair command asks that same
// process to make the key and receives its terminal messages on this private socket.
export async function requestPair(platform?: string) {
	await new Promise<void>((resolve, reject) => {
		const address = platform === undefined ? "" : origin(platform);
		const client = connect(path, () => client.end(address));
		client.on("data", chunk => process.stdout.write(chunk));
		client.on("end", resolve);
		client.on("error", () => reject(new RunnerError("A runner command is already using the state volume. Wait for it to finish before pairing again.")));
	});
}
// The owner changed the volume. Only a fixed notification crosses this local socket;
// the service rechecks Docker before reporting. While stopped it checks on next welcome.
export async function requestLoginReport(signedIn: boolean) {
	await new Promise<void>(resolve => {
		const client = connect(path, () => client.end(signedIn ? "report-login" : "report-logout"));
		client.setTimeout(15_000, () => client.destroy());
		client.resume();
		client.on("error", () => {});
		client.on("close", () => resolve());
	});
}

export function waitForPair(signal: AbortSignal, ready: () => void, reportLogin?: (signedIn: boolean) => Promise<void>): Promise<{ client: Socket; platform?: string } | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	rmSync(path, { force: true }); // Only the state lock holder may replace a stale socket.
	return new Promise((resolve, reject) => {
		let accepted = false;
		const listener = createServer({ allowHalfOpen: true }, client => {
			let address = "";
			client.setEncoding("utf8");
			client.on("data", chunk => { address += chunk; if (address.length > 2048) client.destroy(); });
			client.on("error", () => client.destroy());
			client.on("end", () => {
				if (address === "report-login" || address === "report-logout") {
					if (reportLogin) void reportLogin(address === "report-login").catch(() => {}).finally(() => client.end());
					else client.end();
					return;
				}
				if (accepted || signal.aborted) { client.end(); return; }
				let platform: string | undefined;
				try { if (address) platform = origin(address); }
				catch { client.end("Give a platform HTTPS origin.\n"); return; }
				accepted = true;
				signal.removeEventListener("abort", stop);
				listener.close();
				resolve({ client, platform });
			});
		});
		const stop = () => { listener.close(); resolve(undefined); };
		listener.once("error", reject);
		listener.listen(path, () => {
			if (signal.aborted) return stop();
			signal.addEventListener("abort", stop, { once: true });
			ready();
		});
	});
}
