import { join } from "node:path";
import type { SandboxProfileId } from "../contract.js";
import { BWRAP_PROBE } from "./provider.js";

// The Docker CLI reads the file in its own filesystem and sends the JSON to the daemon.
declare const BUNDLED_SECCOMP_FILE: string;
const seccomp = join(
	import.meta.dirname,
	typeof BUNDLED_SECCOMP_FILE === "string" ? BUNDLED_SECCOMP_FILE : "../../../sandbox/seccomp-bwrap.json",
);

export const PROFILE_RUN_FLAGS: Partial<Record<SandboxProfileId, string[]>> = {
	"docker-windlass-sandbox": [
		"--security-opt",
		"seccomp=" + seccomp,
		"--security-opt",
		"apparmor=unconfined",
		"--security-opt",
		"systempaths=unconfined",
	],
	"docker-hardened": [],
};

// Run bwrap from inside the container, as Windlass does. Direct runc exec can miss
// Ubuntu’s path-attached AppArmor userns permission and falsely report a failed probe.
export const DOCKER_BWRAP_PROBE = ["env", ...BWRAP_PROBE];
