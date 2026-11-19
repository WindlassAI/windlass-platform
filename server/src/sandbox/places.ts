import type { SandboxLayer } from "./api.js";

/** Each server registers the same machine providers. Their sandboxes have no hosted price. */
export const places = new Map<string, (uid: string, machineId: string) => SandboxLayer>();
