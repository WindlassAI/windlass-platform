import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { certify, rootFingerprint } from "../server/src/runner/frame-auth.js";

try {
	const { positionals: [command], values } = parseArgs({ allowPositionals: true, options: {
		out: { type: "string" }, root: { type: "string" }, serial: { type: "string" }, days: { type: "string" }, endpoint: { type: "string" },
	} });
	if (command === "root" && values.out) {
		const { privateKey } = generateKeyPairSync("ed25519");
		writeFileSync(values.out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
		console.log("Platform key fingerprint: " + rootFingerprint(privateKey));
	} else if (values.root && (command === "fingerprint" || command === "certify")) {
		const root = createPrivateKey(readFileSync(values.root));
		if (command === "fingerprint") console.log("Platform key fingerprint: " + rootFingerprint(root));
		else {
			const serial = Number(values.serial), days = Number(values.days ?? 90);
			if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(serial) || serial < 1) throw Error();
			if (values.endpoint) {
				const url = new URL(values.endpoint);
				if (url.origin !== values.endpoint || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw Error();
			}
			process.stdout.write("WLP_PLATFORM_KEY=" + certify(root, serial, Date.now() + days * 86_400_000, values.endpoint) + "\n");
		}
	} else throw Error();
} catch {
	console.error("Use root --out NEW_FILE, fingerprint --root FILE, or certify --root FILE --serial N --days 90 [--endpoint ORIGIN]. Check file permissions and arguments.");
	process.exitCode = 1;
}
