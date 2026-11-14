import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			// The one file shared with the server: types and constants only, no server code.
			"@contract": fileURLToPath(new URL("../server/src/contract.ts", import.meta.url)),
		},
	},
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
