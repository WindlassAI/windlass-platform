import { githubApp } from "../github/app.js";
import { githubCodeHost } from "./github.js";

export type { CodeHost } from "./types.js";

const providers = {
	github: () => {
		const app = githubApp();
		return app && githubCodeHost(app);
	},
};

/** Unspecified repositories keep using GitHub. Null means the provider is not configured. */
export function resolveCodeHost(provider: keyof typeof providers = "github") {
	return providers[provider]();
}
