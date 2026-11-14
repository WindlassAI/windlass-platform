/**
 * The sandbox layer: Docker containers for sessions, Windlass run inside them, and the ChatGPT sign-in
 * done by Windlass in throwaway containers. See api.ts for the interface and sandbox/ for the image.
 */

import type { SandboxLayer } from "./api.js";
import { DockerChatgptLogins } from "./logins.js";
import { DockerSandboxes } from "./sandboxes.js";
import { DockerWindlass } from "./windlass.js";

export function createSandboxLayer(): SandboxLayer {
	return {
		sandboxes: new DockerSandboxes(),
		windlass: new DockerWindlass(),
		logins: new DockerChatgptLogins(),
	};
}

export { SandboxUserError } from "./api.js";
export type * from "./api.js";
