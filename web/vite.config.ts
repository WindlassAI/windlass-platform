import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { publicSite } from "./site-build.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const alias = {
	// The one file shared with the server: types and constants only, no server code.
	"@contract": fileURLToPath(new URL("../server/src/contract.ts", import.meta.url)),
};

export default defineConfig({
	// publicSite: the public pages, prerendered after the build (site-build.ts).
	plugins: [react(), publicSite({ alias })],
	resolve: { alias },
	server: {
		port: 5173,
		strictPort: true,
		// contract.ts and the event fixtures live outside web/.
		fs: { allow: [repoRoot] },
	},
	preview: { port: 5173, strictPort: true },
	build: { target: "es2022", sourcemap: true },
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
