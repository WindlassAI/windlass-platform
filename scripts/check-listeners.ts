import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSocket, type Socket } from "node:dgram";
import { createServer } from "node:net";

export function portFree(port: number): Promise<boolean> {
	return new Promise(done => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

// A UDP reservation coordinates the checks, but cannot stop the kernel from assigning the same
// TCP port to an outgoing connection before Rivet binds it. Keep all three engine ports and HTTP
// out of the automatic port range. Above 10080, fetch also accepts every HTTP port.
function listenerRange(): [number, number] {
	const [first, last] =
		process.platform === "linux"
			? readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number)
			: [49152, 65535];
	return first - 10081 >= 11 ? [10081, first] : [Math.max(10081, last + 1), 65536];
}

/**
 * RivetKit needs its engine URL before startup. Its native engine also binds base+1 and base+10.
 * Reserve each number on UDP before probing TCP so parallel checks skip it until this process exits.
 */
export async function localListeners(httpCount = 1) {
	const [min, end] = listenerRange();
	// A custom kernel range can cover every candidate. Fall back to the original OS allocation there.
	const candidate = (offset = 0) => (end - min > offset ? randomInt(min, end - offset) : 0);
	for (;;) {
		const reservations: Socket[] = [];
		let allocated = false;
		async function reserve(port: number) {
			const reservation = createSocket("udp4");
			reservations.push(reservation);
			await new Promise<void>((ready, reject) => reservation.once("error", reject).bind(port, "127.0.0.1", ready));
			reservation.unref();

			const chosen = reservation.address().port;
			const probe = createServer();
			await new Promise<void>((ready, reject) => probe.once("error", reject).listen(chosen, "127.0.0.1", ready));
			await new Promise<void>(done => probe.close(() => done()));
			return chosen;
		}
		try {
			const engine = await reserve(candidate(10));
			if (engine + 10 > 65535) continue;
			await reserve(engine + 1);
			await reserve(engine + 10);
			const http: number[] = [];
			for (let i = 0; i < httpCount; i++) http.push(await reserve(candidate()));
			console.log(
				`Local ports: engine ${engine}, ${engine + 1}, ${engine + 10}${http.length ? "; HTTP " + http.join(", ") : ""}`,
			);
			allocated = true;
			return { engine, http };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		} finally {
			if (!allocated) for (const reservation of reservations) reservation.close();
		}
	}
}
