/**
 * Windlass's sign-in commands, as steps over sign-in material (material.ts). Each step lends Windlass
 * the material for one command through a runner (runner.ts) and returns what Windlass left of it; none
 * of them stores anything. Whoever calls keeps the material: the `login` actor for an attempt, the
 * `user` actor for a user's sign-in.
 *
 *   start    `windlass login start --no-browser` on nothing: prints OpenAI's address and saves the
 *            pending sign-in (`auth-pending.json`, `host-id`). No network request
 *   finish   `windlass login finish`, the pasted address on standard input (never on a command line):
 *            exchanges the code, and leaves `auth.json` in place of the pending sign-in
 *   token    `windlass login token --json --valid-for 20m`: prints `{"accessToken":"...","expiresAt":<ms>}`,
 *            the saved token when that is good for twenty minutes more (`TOKEN_VALID_FOR_MS`, handoff.ts)
 *            and otherwise a new one, for which it refreshes the sign-in first. Only the refresh needs
 *            the network, and it replaces the refresh token: `auth.json` comes back changed
 *
 *   models   `windlass --models --json` on an access token of the sign-in, and on no sign-in: prints the
 *            models the account's plan offers, one JSON object on a line each (`id`, `description`,
 *            `efforts`, `isDefault`). The token is handed in as a turn's is (`runWithToken`, runner.ts),
 *            so this command never refreshes anything
 *
 * A refresh cannot give a token that lasts longer than the service issues them (about an hour). Should
 * that be less than is asked for, Windlass prints the token all the same, exits 0 and says so in one
 * line on standard error: `token` reports it (`shorter`), and what follows from it is the holder's.
 *
 * When Windlass gives no token it exits 1 with one line on standard error, and what that means is read
 * from the stable code in the line's brackets, not from its words (`signInFailure`):
 *
 *   windlass: sign-in failed: <message> (<code>)
 *
 *   signed_out                           nobody is signed in: `SandboxUserError`, sign in with ChatGPT
 *   invalid_grant, ... (SIGN_IN_REFUSED) the sign-in service refused the refresh: `SandboxUserError`, the
 *                                        sign-in is no longer accepted. A turn's token file backs off on it
 *   network_error                        the sign-in service could not be reached: `SignInRefreshError`,
 *                                        not the user's doing, the sign-in is untouched
 *   any other                            the refresh did not complete (`refresh_locked`,
 *                                        `bad_token_response`, a code of the service's that is no
 *                                        refusal): `SignInRefreshError` as well
 *
 * Windlass reports an empty sign-in with its own line on stderr.
 *
 * The token is a secret. It is read from the command's standard output and from nowhere else, and that
 * output is never logged or put into an error: messages are made from the exit code and from standard
 * error, where Windlass never prints a token.
 */

import type { ListedModels } from "../account-models.js";
import type { ModelChoice } from "../contract.js";
import { type AccessToken, type ChatgptAccount, SandboxUserError } from "../sandbox/api.js";
import {
	NOT_SIGNED_IN,
	SIGNED_OUT,
	SIGN_IN_EXPIRED,
	SIGN_IN_REFUSED,
	SIGN_IN_UNREACHABLE,
	SignInRefreshError,
	loginTokenCommand,
	saysShorterThanAsked,
} from "../sandbox/handoff.js";
import { NO_MATERIAL, type SignInMaterial, accountOf, hasSignIn } from "./material.js";
import type { LoginRun, LoginRunner } from "./runner.js";

/** How long `windlass login token` may take: it waits up to 30 s for its own refresh lock, then asks OpenAI. */
const TOKEN_TIMEOUT_MS = 90_000;
const FINISH_TIMEOUT_MS = 90_000;
const START_TIMEOUT_MS = 60_000;
/** How long `windlass --models` may take: one request to the provider, and whoever asked is waiting on a page. */
const MODELS_TIMEOUT_MS = 5_000;

/** What asking for a token gave, with the material as Windlass left it: changed when it refreshed, whether or not a token came of it. */
export type TokenAnswer =
	| {
			ok: true;
			material: SignInMaterial;
			token: AccessToken /** Windlass said the token is good for less than was asked: a refresh gives none that lasts longer. */;
			shorter: boolean;
	  }
	| { ok: false; material: SignInMaterial; error: Error };

export interface SignInCommands {
	/** Begins a sign-in. `material` is the pending sign-in, to be handed to `finish`. */
	start(): Promise<{ url: string; redirectPrefix: string; material: SignInMaterial }>;
	/**
	 * Finishes a started sign-in from the pasted address. Throws SandboxUserError when the address is not
	 * the one expected, nothing is pending in `material`, or OpenAI refuses the exchange. `material` is
	 * then the finished sign-in.
	 */
	finish(material: SignInMaterial, pastedUrl: string): Promise<{ account: ChatgptAccount; material: SignInMaterial }>;
	/**
	 * An access token of the sign-in in `material` that is good for twenty minutes more. Rejects only
	 * when the command could not be run at all; what Windlass answered is in the result, with the
	 * material to keep from now on.
	 */
	token(material: SignInMaterial, options?: { signal?: AbortSignal }): Promise<TokenAnswer>;
	/**
	 * The models the plan of `token`'s account offers, with the efforts each accepts and the default.
	 * Rejects when Windlass did not list them, with its own reason; no message holds the token.
	 */
	models(token: AccessToken): Promise<ListedModels>;
	/** How many times `token` ran Windlass: for the checks that count refreshes. */
	readonly asked: number;
}

/** What Windlass's `sign-in failed: <message> (<code>)` becomes for the user at `finish`. */
const FRIENDLY: Record<string, string> = {
	no_pending_login: "This sign-in attempt is no longer waiting for an address. Start the sign-in again.",
	state_mismatch:
		"That address belongs to a different sign-in attempt. Start the sign-in again and paste the address of the page the browser ended on.",
	missing_code: "That address has no authorization code. Paste the full address of the page the browser ended on.",
	access_denied: "The sign-in was not approved in the browser.",
	plan_usage_not_granted: "The sign-in worked, but ChatGPT plan usage was not granted. Sign in again and allow it.",
	registration_incomplete: "OpenAI did not finish registering this app for your account. Start the sign-in again.",
};

export const ATTEMPT_UNKNOWN = "This sign-in attempt is unknown or has expired. Start the sign-in again.";

export interface WindlassSignInsOptions {
	/** Where the line about a command that was killed goes. It never contains material or a token. */
	log?: (line: string) => void;
	/** How long `windlass login token` may take. Default 90 s; shortened by checks. */
	tokenTimeoutMs?: number;
	/** How long `windlass --models` may take. Default 5 s; shortened by checks. */
	modelsTimeoutMs?: number;
}

export class WindlassSignIns implements SignInCommands {
	asked = 0;

	constructor(
		private readonly runner: LoginRunner,
		private readonly options: WindlassSignInsOptions = {},
	) {}

	async start(): Promise<{ url: string; redirectPrefix: string; material: SignInMaterial }> {
		// `login start` makes no network request: it saves the PKCE state and prints the address. It tries
		// to listen on 127.0.0.1:1455 for the browser's return; where that port is taken (two attempts
		// starting at once) it says so and goes on, and without a browser it stops listening at once.
		const result = await this.runner.run(NO_MATERIAL, {
			args: ["start", "--no-browser"],
			network: false,
			timeoutMs: START_TIMEOUT_MS,
		});
		const url = result.stdout
			.split("\n")
			.map(line => line.trim())
			.find(line => line.startsWith("https://"));
		if (result.code !== 0 || url === undefined || result.material.files["auth-pending.json"] === undefined) {
			throw new Error(
				`windlass login start failed (${result.timedOut ? "timed out" : `exit code ${result.code}`}): ${oneLine(result.stderr) || "it printed no address"}`,
			);
		}
		const redirectPrefix = new URL(url).searchParams.get("redirect_uri") ?? "http://127.0.0.1:1455/auth/callback";
		return { url, redirectPrefix, material: result.material };
	}

	async finish(
		material: SignInMaterial,
		pastedUrl: string,
	): Promise<{ account: ChatgptAccount; material: SignInMaterial }> {
		const pasted = checkPasted(pastedUrl);
		if (material.files["auth-pending.json"] === undefined) throw new SandboxUserError(FRIENDLY.no_pending_login!);
		// The token exchange needs the network. The address goes in on stdin, one line.
		const result = await this.runner.run(material, {
			args: ["finish"],
			stdin: `${pasted}\n`,
			network: true,
			timeoutMs: FINISH_TIMEOUT_MS,
		});
		if (result.timedOut) throw new SandboxUserError("OpenAI did not answer in time. Try again.");
		if (result.code !== 0) {
			const failed = signInFailure(result.stderr);
			if (failed !== null) throw new SandboxUserError(FRIENDLY[failed.code] ?? failed.message);
			throw new SandboxUserError(
				`The sign-in could not be finished: ${oneLine(result.stderr).replace(/^windlass: /, "") || `exit code ${result.code}`}`,
			);
		}
		const account = accountOf(result.material);
		if (account === null) throw new Error("windlass login finish succeeded but left no sign-in");
		return { account, material: result.material };
	}

	async token(material: SignInMaterial, options: { signal?: AbortSignal } = {}): Promise<TokenAnswer> {
		// Without a sign-in there is nothing to ask Windlass about.
		if (!hasSignIn(material)) return { ok: false, material, error: new SandboxUserError(NOT_SIGNED_IN) };
		this.asked += 1;
		const [, , ...args] = loginTokenCommand();
		const result = await this.runner.run(material, {
			args,
			network: true,
			timeoutMs: this.options.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS,
			signal: options.signal,
		});
		// What Windlass saved is kept whatever it answered: a refresh that the sign-in service has already
		// carried out is in there, also when the command was killed before it could print the token.
		const left = result.materialRead && hasSignIn(result.material) ? result.material : material;
		try {
			return { ok: true, material: left, ...(await this.read(result)) };
		} catch (error) {
			return { ok: false, material: left, error: error instanceof Error ? error : new Error(String(error)) };
		}
	}

	async models(token: AccessToken): Promise<ListedModels> {
		const timeoutMs = this.options.modelsTimeoutMs ?? MODELS_TIMEOUT_MS;
		const result = await this.runner.runWithToken(token, { args: ["--models", "--json"], timeoutMs });
		if (result.timedOut)
			throw new Error(`\`windlass --models\` did not answer in ${timeoutMs / 1000} s and was stopped`);
		// Windlass says why on one line of standard error, where it never prints a token.
		if (result.code !== 0)
			throw new Error(
				`\`windlass --models\` failed (exit code ${result.code}): ${thrownLine(result.stderr) ?? "it gave no reason"}`,
			);
		const listed = parseModels(result.stdout);
		if (listed === null) throw new Error("`windlass --models --json` did not print a list of models");
		return listed;
	}

	private async read(result: LoginRun): Promise<{ token: AccessToken; shorter: boolean }> {
		if (result.aborted) throw new Error("`windlass login token` was stopped: the sign-in changed while it ran");
		if (result.timedOut) {
			this.options.log?.(
				`[wlp] sign-in.command_timeout: \`windlass login token\` did not answer in ${(this.options.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS) / 1000} s and was stopped${result.materialRead ? "; what it had saved by then was kept" : ""}`,
			);
			throw new Error("`windlass login token` did not answer in time");
		}
		if (result.code === 0) {
			const token = parseToken(result.stdout);
			if (token === null) throw new Error("`windlass login token --json` did not print a token and its expiry");
			if (token.expiresAt <= Date.now())
				throw new Error("`windlass login token` printed a token that has already expired");
			return { token, shorter: saysShorterThanAsked(result.stderr) };
		}
		const stderr = result.stderr.trim();
		// What Windlass says about the sign-in, by its code.
		const failed = signInFailure(stderr);
		if (failed !== null) {
			if (failed.code === SIGNED_OUT) throw new SandboxUserError(NOT_SIGNED_IN);
			if (SIGN_IN_REFUSED.has(failed.code)) throw new SandboxUserError(SIGN_IN_EXPIRED);
			// Not the user's doing. That the service could not be reached is said in Windlass's own sentence, which names the host and the reason.
			if (failed.code === SIGN_IN_UNREACHABLE)
				throw new SignInRefreshError(
					`${failed.message.charAt(0).toLowerCase()}${failed.message.slice(1)}`,
					failed.code,
				);
			throw new SignInRefreshError(
				`the sign-in could not be refreshed: ${failed.message} (${failed.code})`,
				failed.code,
			);
		}
		// No code from here on. Windlass reports nobody being signed in without one, as a line of its own
		// ("windlass: not signed in, so there is no token to hand on; run `windlass login`", exit code 1), so that
		// one answer is still told by its words.
		if (result.code === 1 && stderr.split("\n").some(line => /^\S+: not signed in\b/.test(line.trim())))
			throw new SandboxUserError(NOT_SIGNED_IN);
		throw new Error(
			`\`windlass login token\` failed (exit code ${result.code}): ${thrownLine(stderr) ?? "it gave no reason"}`,
		);
	}
}

/**
 * The failure of a sign-in step as Windlass reports it on one line of standard error,
 * `windlass: sign-in failed: <message> (<code>)`: its stable code and its sentence. Null when Windlass
 * said nothing of that form.
 */
function signInFailure(stderr: string): { code: string; message: string } | null {
	for (const line of stderr.split("\n").reverse()) {
		const found = /^\S+: sign-in failed: (.*) \(([A-Za-z][A-Za-z0-9_]*)\)\s*$/.exec(line.trim());
		if (found !== null) return { message: oneLine(found[1]!), code: found[2]! };
	}
	return null;
}

/** The object `windlass login token --json` prints, from its standard output. Null when that is not what it printed. */
function parseToken(stdout: string): AccessToken | null {
	const line = stdout.trim().split("\n").pop() ?? "";
	try {
		const value = JSON.parse(line) as { accessToken?: unknown; expiresAt?: unknown };
		if (
			typeof value?.accessToken !== "string" ||
			value.accessToken === "" ||
			/\s/.test(value.accessToken) ||
			typeof value.expiresAt !== "number" ||
			!Number.isFinite(value.expiresAt)
		)
			return null;
		return { accessToken: value.accessToken, expiresAt: value.expiresAt };
	} catch {
		return null;
	}
}

/** More than any plan offers by far: what is longer is not a list of models. */
const MAX_MODELS = 200;
const MAX_MODEL_ID_CHARS = 200;

/**
 * What `windlass --models --json` prints: one object on a line for each model, `{"id":"...",
 * "description":"..."|null,"efforts":["..."],"isDefault":true|false}`, the default being the model a
 * new session uses when none is named (the first one where Windlass marks none). Null when any line
 * is something else, or there is no model at all: half a list is not served as the plan's.
 */
export function parseModels(stdout: string): ListedModels | null {
	const word = (value: unknown): value is string =>
		typeof value === "string" && value !== "" && value.length <= MAX_MODEL_ID_CHARS && !/[\x00-\x1f\x7f]/.test(value);
	const models: ModelChoice[] = [];
	let defaultModel: string | null = null;
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		let row: { id?: unknown; description?: unknown; efforts?: unknown; isDefault?: unknown };
		try {
			row = JSON.parse(line) as typeof row;
		} catch {
			return null;
		}
		if (
			typeof row !== "object" ||
			row === null ||
			!word(row.id) ||
			!Array.isArray(row.efforts) ||
			!row.efforts.every(word) ||
			models.length >= MAX_MODELS ||
			models.some(model => model.id === row.id)
		)
			return null;
		models.push({ id: row.id, name: word(row.description) ? row.description : null, efforts: row.efforts });
		if (row.isDefault === true) defaultModel ??= row.id;
	}
	return models.length === 0 ? null : { models, defaultModel: defaultModel ?? models[0]!.id };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * Extracts the command's error line from stderr, skipping stack frames and source excerpts.
 */
function thrownLine(stderr: string): string | null {
	const lines = stderr
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "");
	const thrown = lines.find(line => /^(error|[A-Z]\w*Error|[A-Z]\w*Exception)(\[\w+\])?: \S/.test(line));
	if (thrown !== undefined) return oneLine(thrown.replace(/^error: /, ""));
	const own = lines.find(line => /^windlass: /.test(line));
	return own === undefined ? null : oneLine(own.replace(/^windlass: /, ""));
}

/** The address must be the loopback page the browser ended on, on one line, with a `state`. */
export function checkPasted(text: string): string {
	const trimmed = typeof text === "string" ? text.trim() : "";
	const wrong = new SandboxUserError(
		"That is not the address the browser ended on. It starts with http://127.0.0.1:1455/auth/callback?code=",
	);
	if (trimmed === "" || /[\r\n]/.test(trimmed) || trimmed.length > 8192) throw wrong;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw wrong;
	}
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost"].includes(url.hostname) ||
		url.pathname !== "/auth/callback" ||
		!url.searchParams.has("state")
	)
		throw wrong;
	return trimmed;
}
