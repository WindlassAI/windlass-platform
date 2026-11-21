import { copyFile } from "node:fs/promises";
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
	if (id !== "claude" || !imagePin.test(image) || extra !== undefined)
		throw new Error("Pass a harness image as claude=<immutable image digest>.");
	harnessImages[id] = image;
}
await build({
	entryPoints: [fileURLToPath(new URL("src/main.ts", import.meta.url))], outfile,
	banner: { js: "#!/usr/bin/env node" },
	bundle: true, platform: "node", target: "node22", format: "cjs",
	define: { "import.meta.dirname": "__dirname", BUNDLED_SECCOMP_FILE: JSON.stringify("seccomp-bwrap.json"), SANDBOX_IMAGE: JSON.stringify(pin), SHOTS_IMAGE_PIN: JSON.stringify(shotsPin ?? ""), HARNESS_IMAGES: JSON.stringify(harnessImages) },
});
await copyFile(new URL("../sandbox/seccomp-bwrap.json", import.meta.url), join(dirname(outfile), "seccomp-bwrap.json"));
await copyFile(new URL("../sandbox/seccomp-bwrap.LICENSE", import.meta.url), join(dirname(outfile), "seccomp-bwrap.LICENSE"));
