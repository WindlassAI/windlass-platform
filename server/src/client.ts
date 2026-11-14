/**
 * What a script outside this package needs to talk to the server: RivetKit's client and the registry's
 * type. (Scripts under scripts/ cannot resolve `rivetkit` themselves; this package can.)
 */

export { createClient } from "rivetkit/client";
export type { Registry } from "./registry.js";
