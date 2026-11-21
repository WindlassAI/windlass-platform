import { copyFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const [pin, outfile, ...pins] = process.argv.slice(2);
const imagePin = /^([a-z0-9][a-z0-9./:_-]*@)?sha256:[0-9a-f]{64}$/;
const shotsPin = pins[0] && imagePin.test(pins[0]) ? pins.shift() : undefined;
if (!outfile || !imagePin.test(pin))
	throw new Error("Pass an immutable sandbox image digest and the bundle output path.");
const harnessImages = {};
for (const entry of pins) {
	const [id, image, extra] = entry.split("=");
	if (!["claude", "opencode"].includes(id) || !imagePin.test(image) || extra !== undefined)
		throw new Error("Pass a harness image as <harness>=<immutable image digest>.");
	harnessImages[id] = image;
}
const relay = await build({ entryPoints: [fileURLToPath(new URL("../sandbox/relay/opencode.cjs", import.meta.url))],
	bundle: true, platform: "node", format: "cjs", write: false });
await build({
	entryPoints: [fileURLToPath(new URL("src/main.ts", import.meta.url))], outfile,
	banner: { js: "#!/usr/bin/env node" },
	bundle: true, platform: "node", target: "node22", format: "cjs",
	define: { EGRESS_SOURCE: JSON.stringify(await readFile(new URL("src/egress-proxy.mjs", import.meta.url), "utf8")), "import.meta.dirname": "__dirname", BUNDLED_SECCOMP_FILE: JSON.stringify("seccomp-bwrap.json"), SANDBOX_IMAGE: JSON.stringify(pin), SHOTS_IMAGE_PIN: JSON.stringify(shotsPin ?? ""), HARNESS_IMAGES: JSON.stringify(harnessImages),
		OPENCODE_RELAY_SCRIPT: JSON.stringify(relay.outputFiles[0].text),
		CLAUDE_RELAY_SCRIPT: JSON.stringify(await readFile(new URL("../sandbox/relay/server.cjs", import.meta.url), "utf8")) },
});
await copyFile(new URL("../sandbox/seccomp-bwrap.json", import.meta.url), join(dirname(outfile), "seccomp-bwrap.json"));
await copyFile(new URL("../sandbox/seccomp-bwrap.LICENSE", import.meta.url), join(dirname(outfile), "seccomp-bwrap.LICENSE"));
