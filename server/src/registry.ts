/**
 * The actors of the contract. The platform's information is not an actor any more: every server
 * serves it over HTTP (index.ts), so no single actor stands in the way of every visitor.
 */

import { setup } from "rivetkit";
import { agentSession, SHUTDOWN_GRACE_MS } from "./actors/agent-session.js";
import { machine } from "./actors/machine.js";
import { machinePairing, pairingDirectory } from "./actors/machine-pairing.js";
import { githubAccount } from "./actors/github-account.js";
import { githubInbox, githubHooks } from "./actors/github-inbox.js";
import { githubRepository } from "./actors/github-repository.js";
import { login } from "./actors/login.js";
import { user } from "./actors/user.js";
import { workItem } from "./actors/work-item.js";

export const registry = setup({
	use: { login, user, agentSession, machine, machinePairing, pairingDirectory, workItem, githubInbox, githubAccount, githubRepository, githubHooks },
	// A prompt may be 20,000 characters, and a snapshot carries a session's whole timeline.
	maxIncomingMessageSize: 256 * 1024,
	maxOutgoingMessageSize: 12 * 1024 * 1024,
	// RivetKit's own "Services" host is not used here. Left on, it is one more process, and one that
	// survives a killed server and then keeps the next start from coming up.
	startServices: false,
	// On SIGINT/SIGTERM, give sessions time to close a running turn and pause their sandboxes. What a
	// session does in that time is counted against it where it is defined.
	shutdown: { gracePeriodMs: SHUTDOWN_GRACE_MS },
});

export type Registry = typeof registry;
