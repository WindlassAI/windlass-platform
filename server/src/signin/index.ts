/**
 * This server's sign-in machinery: where Windlass's sign-in commands run, and what the sandbox provider
 * adds to a user's sign-in. The `user` and `login` actors and the sandbox layer's `logins` and `tokens`
 * all take it from here, so there is one of it per server process.
 *
 * Where the commands run is independent of where sandboxes run:
 *
 *   WLP_WINDLASS_BIN       a Windlass executable on this server (a path, or a name on PATH; default
 *                          `windlass`). The commands run as local processes: the way for a deployment,
 *                          and it needs no Docker. It must be a Windlass with `login token --valid-for`
 *   WLP_SIGNIN_RUNNER      `local` or `docker`, to say it outright. Without it: `local` when
 *                          WLP_WINDLASS_BIN is set, otherwise `docker` when the sandboxes are Docker's
 *                          (the helper container of the sandbox image, for development), otherwise
 *                          `local`. `signInProblem()` says when the local Windlass cannot be run or
 *                          is too old
 *   WLP_SIGNIN_TMPDIR      where the local runner makes its private directories (default: /dev/shm
 *                          where there is one, else the system's temporary directory)
 *
 * With WLP_SANDBOX=fake no Windlass runs at all: the fake layer's stand-in answers (sandbox-fake.ts).
 * Unless WLP_SIGNIN_RUNNER is set: then the sign-in is the real one over fake sandboxes, which is how
 * the sign-in is tried on a machine without Docker (scripts/signin-check.ts, section `actors`).
 */

import { config } from "../config.js";
import { loginTokenCommand } from "../sandbox/handoff.js";
import type { SignInCommands } from "./commands.js";
import { WindlassSignIns, lackOf } from "./commands.js";
import type { LegacySignIns } from "./holder.js";
import { NO_MATERIAL } from "./material.js";
import { LocalLoginRunner, type LoginRunner } from "./runner.js";
import { type Sealer, serverSealer } from "./seal.js";

export interface SignInHooks {
	legacy?: LegacySignIns;
	/** Removes the token files of the user's running turns. */
	revoke?: (uid: string) => Promise<void>;
}

export interface SignIns {
	commands: SignInCommands;
	sealer: Sealer;
	hooks: SignInHooks;
	/** Where the commands run, for the line the server prints when it starts. */
	describe: string;
	/** What keeps the commands from running there, in a sentence that says what to do; null when nothing does. */
	check: () => Promise<string | null>;
}

function chosenRunner(): "local" | "docker" {
	const said = (process.env.WLP_SIGNIN_RUNNER ?? "").trim().toLowerCase();
	if (said === "local" || said === "docker") return said;
	if (said !== "") throw new Error(`WLP_SIGNIN_RUNNER must be "local" or "docker"; got "${said}"`);
	if ((process.env.WLP_WINDLASS_BIN ?? "") !== "") return "local";
	// A server whose sandboxes are Docker's has the sandbox image, and may have no Windlass of its own.
	return config.sandbox === "docker" ? "docker" : "local";
}

/**
 * Whether the Windlass on this server can do what the platform asks of it, found out as the image's is
 * (sandbox/tokens.ts): the token command, on no sign-in at all. A Windlass that has it answers that
 * nobody is signed in (exit code 1); one that does not know the command or its `--valid-for` says so
 * (exit code 2). Nothing is sent anywhere: without a sign-in there is nothing to refresh.
 */
async function checkLocal(runner: LoginRunner, binary: string): Promise<string | null> {
	const version = await runner.version();
	if (version === null) {
		return `The Windlass the server runs sign-in commands with, ${binary}, could not be run, so nobody can sign in with ChatGPT and every turn that is not a demo turn fails. Set WLP_WINDLASS_BIN to a Windlass executable for this machine, one with \`windlass login token --valid-for\`, then start the server again.`;
	}
	const [, , ...args] = loginTokenCommand();
	const probe = await runner.run(NO_MATERIAL, { args, network: false, timeoutMs: 30_000 });
	return probe.code === 2 ? runner.outdated(lackOf(probe)) : null;
}

async function make(): Promise<SignIns> {
	const sealer = serverSealer();
	if (config.sandbox === "fake" && (process.env.WLP_SIGNIN_RUNNER ?? "").trim() === "") {
		const { createFakeSignInCommands } = await import("../sandbox-fake.js");
		return { commands: createFakeSignInCommands(), sealer, hooks: {}, describe: "the fake layer's stand-in for Windlass", check: async () => null };
	}
	const hooks: SignInHooks = {};
	if (config.sandbox === "docker") {
		const { removeTokenFiles } = await import("../sandbox/volumes.js");
		hooks.revoke = (uid) => removeTokenFiles(uid);
	}
	let runner: LoginRunner;
	let describe: string;
	let check: () => Promise<string | null>;
	if (chosenRunner() === "local") {
		const binary = (process.env.WLP_WINDLASS_BIN ?? "").trim() || "windlass";
		const local = new LocalLoginRunner({ binary });
		runner = local;
		describe = `the Windlass at ${binary}, as a local process`;
		check = () => checkLocal(local, binary);
	} else {
		const { DockerLoginRunner } = await import("../sandbox/logins.js");
		runner = new DockerLoginRunner();
		describe = "a helper container of the sandbox image";
		// The image's Windlass is the sandbox layer's to look at (`Windlass.problem()`).
		check = async () => null;
	}
	return { commands: new WindlassSignIns(runner, { log: (line) => console.error(line) }), sealer, hooks, describe, check };
}

let made: Promise<SignIns> | null = null;

/** This server's sign-in machinery, made at first use. A configuration that cannot work is reported again at every use. */
export function getSignIns(): Promise<SignIns> {
	made ??= make().catch((error: unknown) => {
		made = null;
		throw error;
	});
	return made;
}

/**
 * What keeps this server from running sign-in commands, in a sentence that says what to set, or null.
 * For the server to say when it starts rather than at the first sign-in.
 */
export async function signInProblem(): Promise<string | null> {
	try {
		return await (await getSignIns()).check();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
