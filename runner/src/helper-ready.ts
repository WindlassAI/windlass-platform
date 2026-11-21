import { docker } from "../../server/src/sandbox/docker.js";

const ready = `
const net = require("node:net");
const deadline = Date.now() + 8000;
const address = process.argv[1].startsWith("/") ? { path: process.argv[1] } : { host: "127.0.0.1", port: Number(process.argv[1]) };
function probe() {
	const socket = net.connect(address);
	socket.once("connect", () => socket.end());
	socket.on("error", () => {
		if (Date.now() >= deadline) process.exit(1);
		setTimeout(probe, 50);
	});
}
probe();`;

/** Run in the helper's own namespaces before the runner acknowledges the new endpoint. */
export async function waitForListener(id: string, address: string) {
	await docker(["exec", id, "node", "-e", ready, address], { check: true, timeoutMs: 15_000 });
}
