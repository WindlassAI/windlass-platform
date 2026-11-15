/**
 * The three actors of the contract. The platform's information is not an actor any more: every server
 * serves it over HTTP (index.ts), so no single actor stands in the way of every visitor.
 */

import { setup } from "rivetkit";
import { agentSession } from "./actors/agent-session.js";
import { login } from "./actors/login.js";
import { user } from "./actors/user.js";

export const registry = setup({
	use: { login, user, agentSession },
	// A prompt may be 20,000 characters, and a snapshot carries a session's whole timeline.
	maxIncomingMessageSize: 256 * 1024,
	maxOutgoingMessageSize: 12 * 1024 * 1024,
	// RivetKit's own "Services" host is not used here. Left on, it is one more process, and one that
	// survives a killed server and then keeps the next start from coming up.
	startServices: false,
	// On SIGINT/SIGTERM, give sessions time to close a running turn and pause their sandboxes.
	shutdown: { gracePeriodMs: 20_000 },
});

export type Registry = typeof registry;
