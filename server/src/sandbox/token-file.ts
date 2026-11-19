/**
 * The access token file of one turn: how a turn that is not scripted gets to use its user's ChatGPT
 * sign-in without the sandbox ever holding it.
 *
 *   where   <Windlass's data directory>/access-token-<sandbox id>.json in the session's sandbox, that is
 *           /home/agent/.local/share/windlass/access-token-<sandbox id>.json. The data directory is the
 *           place Windlass recommends: its own command sandbox hides that directory as a whole, so a
 *           sandboxed command cannot see the file, also not at the moment it is renamed into place.
 *   what    `{"accessToken":"...","expiresAt":<ms>}`, as `windlass login token --json` prints it. With
 *           the expiry Windlass refuses an expired token before it sends anything.
 *   how     written to a file beside it (`<file>.tmp`) and renamed into place, mode 0600, the content on
 *           standard input (`TurnSandbox.writeSecretFile`).
 *   when    before Windlass starts, with a token that is good for at least `TOKEN_VALID_FOR_MS` (twenty
 *           minutes) more, then again when the token in it has `TOKEN_REPLACE_LEAD_MS` (ten minutes)
 *           left. The token source asks Windlass for one with twenty, so at that moment, whenever it
 *           comes, the sign-in is refreshed and the file gets a new token: the replacement depends on
 *           no window of Windlass's. A token that has no more than the lead left when it is written
 *           (the service issues none that lasts as long as was asked) is replaced when half of what it
 *           had left is gone, not at once and again and again.
 *           A replacement that fails is logged and tried again every
 *           `TOKEN_REPLACE_RETRY_MS` (20 s) for as long as the turn runs; it never ends the turn. When
 *           the reason is the sign-in itself (it is gone, or OpenAI refuses to refresh it), which
 *           trying again does not mend, each wait is twice the one before, up to five minutes. If
 *           the token runs out all the same, Windlass says so at its next model call with its code
 *           `handed_in_expired`, and the turn's failure names the reason the replacement failed
 *           (handoff.ts, `handedInFailure`). That reason is kept as the token source threw it: its kind
 *           says whether it is the sign-in's (`SandboxUserError`, made from Windlass's `signed_out` or a
 *           refusal such as `invalid_grant`) or not (`network_error`, ...), and no message is read for it.
 *           Removed when the turn ends; `Sandboxes.suspend` and `destroy` remove what a turn that was
 *           cut off with its server left there, and `ChatgptLogins.logout` the files of all the user's
 *           running turns.
 *   whose   one file per sandbox, so per session, not per user. On Docker a user's sessions share the data
 *           volume and may run turns at the same time (on E2B each sandbox has a data directory of its
 *           own, and the file is named the same way): with one file each, a turn writes, replaces and removes
 *           only what is its own, the file is there only while a turn runs, and no turn's schedule
 *           depends on a token another turn wrote. (One file per user would have to stay for as long as
 *           any of the user's turns runs, and an older token written late by one turn could outlive
 *           the schedule of another.) Sandboxes have one turn at a time.
 *
 * In the hardened profile (no Windlass sandbox) a command the agent runs can read the file, and through
 * the shared volume those of the same user's other running turns: all hold that user's own token.
 * What such a command prints is tool output, which becomes an event. Windlass takes out of tool output
 * every token it has read from the file, which it does at a model call; the platform takes every token
 * it handed this turn out of everything the engine sends as well (`scrub`), so that a token never gets
 * into the turn's events by being printed as it is, also not one written to the file a moment before.
 */

import { type AccessToken, type AccessTokens, SandboxUserError } from "./api.js";
import { TOKEN_REPLACE_LEAD_MS, TOKEN_REPLACE_RETRY_MS, type TokenFileState, tokenFileContent } from "./handoff.js";
import { DATA_DIR, type TurnSandbox } from "./provider.js";

/** The name of a turn's access token file in Windlass's data directory, before the sandbox id. */
export const TOKEN_FILE_PREFIX = "access-token-";

/** Where a sandbox's turn finds its access token. */
export function tokenFilePath(sandboxId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(sandboxId)) throw new Error("invalid sandbox id");
	return `${DATA_DIR}/${TOKEN_FILE_PREFIX}${sandboxId}.json`;
}

/**
 * How long after a token was written late (the one before it had expired) a refusal by Windlass still
 * counts as that gap's: Windlass fails the turn at the model call that found no usable token, and the
 * turn's end is worked out a moment later.
 */
const LAPSE_MEMORY_MS = 60_000;

/** What stands in an event where a command printed the turn's access token. */
export const TOKEN_REMOVED = "[access token removed]";

/** The longest wait between two tries to replace the file while the sign-in itself is what fails. */
const REFUSED_RETRY_MAX_MS = 5 * 60_000;

export interface TokenFileOptions {
	/** How much the token in the file has left when the file is replaced. Default `TOKEN_REPLACE_LEAD_MS`; the layer's checks change it. */
	leadMs?: number;
	/** How long after a failed replacement the next is tried, and the least time between two. Default `TOKEN_REPLACE_RETRY_MS`. */
	retryMs?: number;
	/** Where the log lines go: `[wlp] token.handed`, `token.replaced`, `token.replace_failed`. Default the console. They never contain a token. */
	log?: (line: string) => void;
}

/** The token was there, but its file could not be written in the sandbox: the sandbox's failure, not the token source's. */
export class TokenFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TokenFileError";
	}
}

export class TokenFile {
	readonly path: string;
	private readonly leadMs: number;
	private readonly retryMs: number;
	private readonly log: (line: string) => void;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	/** The write in progress, if one is: `stop` waits for it, so nothing is written after the file was removed. */
	private writing: Promise<void> = Promise.resolve();
	private expiresAt = 0;
	/** When the token in the file is due to be replaced. */
	private replaceAt = 0;
	private problem: unknown = null;
	/** When a token was written that came after the one before it had expired: for a while, a refusal by Windlass is that gap's. */
	private lapseEndedAt: number | null = null;
	/** How many replacements in a row failed because of the sign-in itself. */
	private refused = 0;
	/** Every token this turn was handed, in the forms a line of the engine's output can hold it: as it is, and as JSON writes it. */
	private readonly handed = new Set<string>();
	/** How many times the file was replaced after the first write. */
	replaced = 0;

	constructor(
		private readonly sandbox: TurnSandbox,
		private readonly tokens: AccessTokens,
		options: TokenFileOptions = {},
	) {
		this.path = tokenFilePath(sandbox.id);
		this.leadMs = options.leadMs ?? TOKEN_REPLACE_LEAD_MS;
		this.retryMs = options.retryMs ?? TOKEN_REPLACE_RETRY_MS;
		this.log = options.log ?? ((line) => (line.includes("token.replace_failed") ? console.warn(line) : console.log(line)));
	}

	/** What the turn leaves in the sandbox and removes when it ends: the file, and the one a write that was cut off may have left beside it. */
	get files(): string[] {
		return [this.path, `${this.path}.tmp`];
	}

	/**
	 * Takes the tokens this turn was handed out of a piece of the engine's output (a protocol message, its
	 * standard error). It is what keeps a token a command printed out of the turn's events; a token a
	 * command has changed before printing it is not found.
	 */
	scrub(text: string): string {
		for (const token of this.handed) if (text.includes(token)) text = text.split(token).join(TOKEN_REMOVED);
		return text;
	}

	/** What `handedInFailure` needs to know when Windlass refuses the token. */
	get state(): TokenFileState {
		const now = Date.now();
		const lapsed = (this.expiresAt > 0 && this.expiresAt <= now) || (this.lapseEndedAt !== null && now - this.lapseEndedAt < LAPSE_MEMORY_MS);
		return { expiresAt: this.expiresAt, problem: this.problem, lapsed };
	}

	/** Gets the user's token and writes the file. Rejects with what the token source threw when there is no token to be had, and with a TokenFileError when the file cannot be written. */
	async start(): Promise<void> {
		const token = await this.tokens.current(this.sandbox.uid);
		const written = await this.write(token).catch((error: unknown) => {
			throw new TokenFileError(error instanceof Error ? error.message : String(error));
		});
		if (!written) return;
		this.log(`[wlp] token.handed sandbox=${this.sandbox.id} uid=${this.sandbox.uid}: the turn was handed an access token that lasts ${Math.round((token.expiresAt - Date.now()) / 1000)} s more`);
		this.schedule();
	}

	/** Ends the schedule and waits for a write in progress. The file itself is the caller's to remove. */
	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		await this.writing.catch(() => undefined);
	}

	/** False when the turn has ended meanwhile: nothing was written. */
	private async write(token: AccessToken): Promise<boolean> {
		if (this.stopped) return false;
		// Before the file is there: a command may read it the moment it is. Too short a string would be found everywhere.
		if (token.accessToken.length >= 16) for (const form of [token.accessToken, JSON.stringify(token.accessToken).slice(1, -1)]) this.handed.add(form);
		const writing = this.sandbox.writeSecretFile(this.path, tokenFileContent(token));
		this.writing = writing.catch(() => undefined);
		await writing;
		const now = Date.now();
		if (this.expiresAt > 0 && this.expiresAt <= now) this.lapseEndedAt = now;
		this.expiresAt = token.expiresAt;
		// When the token has the lead left. One that has no more than that already is as long as tokens come:
		// replacing it now would only fetch another like it, so it stays until half of what it has is gone.
		const left = Math.max(0, token.expiresAt - now);
		this.replaceAt = token.expiresAt - (left > this.leadMs ? this.leadMs : left / 2);
		return true;
	}

	/** `retryInMs`: the last try did not give a new token, and the next one comes after this long. */
	private schedule(retryInMs?: number): void {
		if (this.stopped) return;
		const due = this.replaceAt - Date.now();
		this.timer = setTimeout(() => void this.replace(), retryInMs ?? Math.max(this.retryMs, due));
		// A turn that has ended otherwise must not be kept alive by this.
		this.timer.unref?.();
	}

	private async replace(): Promise<void> {
		if (this.stopped) return;
		const who = `sandbox=${this.sandbox.id} uid=${this.sandbox.uid}`;
		try {
			const token = await this.tokens.current(this.sandbox.uid);
			// The same token again: the token source still reuses it. The file is right as it is; look again soon.
			if (token.expiresAt === this.expiresAt) return this.schedule(this.retryMs);
			if (!(await this.write(token))) return;
			this.replaced += 1;
			this.log(`[wlp] token.replaced ${who}: the turn's access token file holds a new token that lasts ${Math.round((token.expiresAt - Date.now()) / 1000)} s more${this.problem === null ? "" : this.lapseEndedAt !== null ? ", after the one in it had expired" : ", after an earlier try had failed"}`);
			this.problem = null;
			this.refused = 0;
			this.schedule();
		} catch (error) {
			if (this.stopped) return;
			this.problem = error;
			// A sign-in that is gone or refused (the token source read that from Windlass's code) does not come back by
			// asking again; one the network kept from being refreshed (`network_error`) may.
			this.refused = error instanceof SandboxUserError ? this.refused + 1 : 0;
			const retryInMs = this.refused === 0 ? this.retryMs : Math.min(this.retryMs * 2 ** (this.refused - 1), Math.max(this.retryMs, REFUSED_RETRY_MAX_MS));
			const left = this.expiresAt - Date.now();
			const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
			this.log(`[wlp] token.replace_failed ${who}: the turn's access token file could not be replaced (${message}); the token in it ${left > 0 ? `lasts ${Math.ceil(left / 1000)} s more` : "has expired"}; trying again in ${Math.round(retryInMs / 1000)} s`);
			this.schedule(retryInMs);
		}
	}
}
