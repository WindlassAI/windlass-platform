/**
 * `ChatgptLogins` and `AccessTokens` (sandbox/api.ts) for every sandbox layer: what the actors and the
 * code that runs a turn call. Nothing here knows a sandbox provider, and nothing here stores anything:
 *
 *   start, finish   run Windlass's own sign-in commands (commands.ts) on the attempt's material, which
 *                   the caller keeps between the two, sealed for that attempt. They may be served by
 *                   different servers: all that connects them is the blob
 *   adopt           seals the finished sign-in for the user and hands it to the user's holder
 *   status, logout  ask the user's holder
 *   current         asks the user's holder for the access token
 *
 * "The user's holder" is a directory (directory.ts): the `user` actor on a server, holders in memory in
 * the layer's own checks.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	type AccessToken,
	type AccessTokens,
	type ChatgptAccount,
	type ChatgptLogins,
	SandboxUserError,
} from "../sandbox/api.js";
import { ATTEMPT_UNKNOWN, type SignInCommands } from "./commands.js";
import { ActorSignInDirectory, MemorySignInDirectory, type SignInDirectory } from "./directory.js";
import type { StoredSignIn } from "./holder.js";
import { getSignIns } from "./index.js";
import { type SignInMaterial, accountOf, assertName, cleanMaterial, hasSignIn, signInOnly } from "./material.js";
import { SealError, type Sealer, createSealer, serverSealer } from "./seal.js";

/** What a sealed attempt holds: the material, and once it is finished, which pasted address finished it. */
interface AttemptState {
	files: SignInMaterial["files"];
	/** SHA-256 of the address that finished the attempt: the same address may be sent again when adopting failed, no other. */
	finishedWith?: string;
}

export interface SignInFacadeOptions {
	/** Windlass's sign-in commands, made when first needed. */
	commands: () => Promise<SignInCommands>;
	directory: SignInDirectory;
	sealer: Sealer;
	/** The provider's part of a new user: the place Windlass's own data of that user's sessions is kept (Docker: a volume). */
	ensureUserData?: (uid: string) => Promise<void>;
	/** How many times `windlass login token` ran in this process, where that is known. */
	asked?: () => number;
}

export class SignInLogins implements ChatgptLogins {
	constructor(private readonly options: SignInFacadeOptions) {}

	async start(attemptId: string): Promise<{ url: string; redirectPrefix: string; attempt: string }> {
		assertName(attemptId, "sign-in attempt id");
		const commands = await this.options.commands();
		const { url, redirectPrefix, material } = await commands.start();
		return { url, redirectPrefix, attempt: this.seal(attemptId, { files: material.files }) };
	}

	async finish(
		attemptId: string,
		attempt: string,
		pastedUrl: string,
	): Promise<{ account: ChatgptAccount; attempt: string }> {
		assertName(attemptId, "sign-in attempt id");
		const state = this.open(attemptId, attempt);
		// Whether it is the address the browser ended on is the commands' to say: Windlass's rules are theirs.
		const pasted = typeof pastedUrl === "string" ? pastedUrl.trim() : "";
		const digest = createHash("sha256").update(pasted).digest("hex");
		const material = cleanMaterial(state.files);
		// Finished before, and adopting it failed: the address that finished it is accepted once more,
		// without a second exchange (OpenAI takes a code once). Any other address is a new attempt's.
		if (state.finishedWith !== undefined) {
			const account = accountOf(material);
			if (state.finishedWith !== digest || account === null)
				throw new SandboxUserError(
					"This sign-in attempt is no longer waiting for an address. Start the sign-in again.",
				);
			return { account, attempt: this.options.sealer.isCurrent(attempt) ? attempt : this.seal(attemptId, state) };
		}
		const commands = await this.options.commands();
		const finished = await commands.finish(material, pasted);
		return {
			account: finished.account,
			attempt: this.seal(attemptId, { files: signInOnly(finished.material).files, finishedWith: digest }),
		};
	}

	async adopt(attemptId: string, attempt: string, uid: string): Promise<void> {
		assertName(attemptId, "sign-in attempt id");
		assertName(uid, "user id");
		const material = signInOnly(cleanMaterial(this.open(attemptId, attempt).files));
		if (!hasSignIn(material)) throw new SandboxUserError("This sign-in is not finished yet.");
		await this.options.ensureUserData?.(uid);
		await this.options.directory.adopt(uid, this.options.sealer.seal("user", uid, JSON.stringify(material)));
	}

	async status(uid: string): Promise<ChatgptAccount | null> {
		assertName(uid, "user id");
		return this.options.directory.status(uid);
	}

	async logout(uid: string): Promise<void> {
		assertName(uid, "user id");
		await this.options.directory.logout(uid);
	}

	async ensureUserVolume(uid: string): Promise<void> {
		assertName(uid, "user id");
		await this.options.ensureUserData?.(uid);
	}

	private seal(attemptId: string, state: AttemptState): string {
		return this.options.sealer.seal("attempt", attemptId, JSON.stringify(state));
	}

	/** An attempt's blob that does not open is not this attempt's: to the user, an attempt that is unknown. */
	private open(attemptId: string, attempt: string): AttemptState {
		try {
			return JSON.parse(this.options.sealer.open("attempt", attemptId, attempt)) as AttemptState;
		} catch (error) {
			if (error instanceof SealError) throw new SandboxUserError(ATTEMPT_UNKNOWN);
			throw error;
		}
	}
}

export class SignInTokens implements AccessTokens {
	constructor(private readonly options: SignInFacadeOptions) {}

	async current(uid: string): Promise<AccessToken> {
		assertName(uid, "user id");
		return this.options.directory.accessToken(uid);
	}

	/**
	 * How many times `windlass login token` was run, where the holders are in this process: the layer's
	 * own checks count refreshes with it. On a server the actors run it, wherever they are, and this
	 * stays 0.
	 */
	get asked(): number {
		return this.options.asked?.() ?? 0;
	}

	/** Drops the token kept for the user. Only where the holders are in this process (the checks); on a server the actor keeps it. */
	forget(uid: string): void {
		if (this.options.directory instanceof MemorySignInDirectory) this.options.directory.forget(uid);
	}
}

export function signInFacade(options: SignInFacadeOptions): { logins: SignInLogins; tokens: SignInTokens } {
	return { logins: new SignInLogins(options), tokens: new SignInTokens(options) };
}

// ---------------------------------------------------------------------------------------------
// The two ways a layer gets them
// ---------------------------------------------------------------------------------------------

/**
 * For a server: the sign-ins are in the users' actors, and Windlass's commands run where this server is
 * configured to run them (signin/index.ts). Right for any number of servers.
 */
export function actorSignIns(options: { ensureUserData?: (uid: string) => Promise<void> } = {}): {
	logins: SignInLogins;
	tokens: SignInTokens;
} {
	const sealer = serverSealer();
	return signInFacade({
		commands: async () => (await getSignIns()).commands,
		directory: new ActorSignInDirectory(sealer),
		sealer,
		ensureUserData: options.ensureUserData,
	});
}

/** The key of the sign-ins kept in this process's memory: made up when the process starts, and gone with it. */
let memoryKey: Sealer | null = null;

export interface MemorySignInsOptions {
	commands: SignInCommands;
	revoke?: (uid: string) => Promise<void>;
	ensureUserData?: (uid: string) => Promise<void>;
	log?: (line: string) => void;
	/** Sign-ins of its own instead of the ones every such layer of this process shares. */
	rows?: Map<string, StoredSignIn>;
}

/**
 * For checks that run without a server: the same holders, over a store in this process's memory. One
 * process only, and nothing outlives it: never for a deployment.
 */
export function memorySignIns(options: MemorySignInsOptions): {
	logins: SignInLogins;
	tokens: SignInTokens;
	directory: MemorySignInDirectory;
	sealer: Sealer;
} {
	memoryKey ??= createSealer(randomBytes(32));
	const sealer = memoryKey;
	const directory = new MemorySignInDirectory({
		commands: options.commands,
		sealer,
		revoke: options.revoke,
		log: options.log,
		rows: options.rows,
	});
	const facade = signInFacade({
		commands: async () => options.commands,
		directory,
		sealer,
		ensureUserData: options.ensureUserData,
		asked: () => options.commands.asked,
	});
	return { ...facade, directory, sealer };
}
