import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const [pin, outfile, ...harnessPins] = process.argv.slice(2);
const imagePin = /^([a-z0-9][a-z0-9./:_-]*@)?sha256:[0-9a-f]{64}$/;
if (!outfile || !imagePin.test(pin))
	throw new Error("Pass an immutable sandbox image digest and the bundle output path.");
const harnessImages = {};
for (const entry of harnessPins) {
	const [id, image, extra] = entry.split("=");
	if (id !== "claude" || !imagePin.test(image) || extra !== undefined)
		throw new Error("Pass a harness image as claude=<immutable image digest>.");
	harnessImages[id] = image;
}
await build({
	entryPoints: [fileURLToPath(new URL("src/main.ts", import.meta.url))], outfile,
	banner: { js: "#!/usr/bin/env node" },
	bundle: true, platform: "node", target: "node22", format: "cjs",
	define: { SANDBOX_IMAGE: JSON.stringify(pin), HARNESS_IMAGES: JSON.stringify(harnessImages) },
});
