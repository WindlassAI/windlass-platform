import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const [pin, outfile] = process.argv.slice(2);
if (!outfile || !/^([a-z0-9][a-z0-9./:_-]*@)?sha256:[0-9a-f]{64}$/.test(pin))
	throw new Error("Pass an immutable sandbox image digest and the bundle output path.");
await build({
	entryPoints: [fileURLToPath(new URL("src/main.ts", import.meta.url))], outfile,
	banner: { js: "#!/usr/bin/env node" },
	bundle: true, platform: "node", target: "node22", format: "cjs", define: { SANDBOX_IMAGE: JSON.stringify(pin) },
});
