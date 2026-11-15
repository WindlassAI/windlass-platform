/**
 * The one place that reads a user's ChatGPT sign-in and refreshes it. A user's current access token is
 * what Windlass prints where the sign-in is saved:
 *
 *   docker run --rm -i --init --name wlp-tmp-<..> --label dev.windlass-platform=1 --cap-drop ALL \
 *     --security-opt no-new-privileges --network bridge --memory 512m --pids-limit 128 \
 *     -v wlp-auth-<uid>:/home/agent/.local/share/windlass \
 *     windlass-platform-sandbox:latest windlass login token --json --valid-for 20m
 *
 * It prints `{"accessToken":"...","expiresAt":<ms>}`: the saved token when that is good for twenty
 * minutes more (`TOKEN_VALID_FOR_MS`, handoff.ts), and otherwise a new one, for which it refreshes the
 * sign-in first, under Windlass's own lock. Only the refresh needs the network, which is why the helper
 * has one. Nothing else ever mounts the auth volume with a network. So the platform decides how much
 * time a token it hands out has left, and depends on no window of Windlass's own.
 *
 * An answer is kept here and reused while it has those twenty minutes, which saves starting a container
 * for a token Windlass would print again unchanged. It is not what limits the refreshes: Windlass
 * refreshes only when the saved token has less than was asked for, so a sign-in is refreshed at most
 * every forty minutes whoever asks, also when several servers ask for the same user.
 *
 * A refresh cannot give a token that lasts longer than the service issues them (about an hour). Should
 * that be less than is asked for, Windlass prints the token all the same, exits 0 and says so in one
 * line on standard error: the token is used with its real expiry, a line `[wlp] token.short` says once
 * per user that more was asked than the service issues, and the token is reused until half of what it
 * had left is gone, since asking again sooner would only refresh again.
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
 * Two answers have no code, and for those alone the words are read (`loginToken` says why): the line
 * for nobody being signed in, and the stack trace an older Windlass died with when it could not reach
 * the sign-in service.
 *
 * The token is a secret. It is read from the helper's standard output and from nowhere else, and that
 * output is never logged or put into an error: messages are made from the exit code and from standard
 * error, where Windlass never prints a token.
 */

import { type AccessToken, type AccessTokens, SandboxUserError } from "./api.js";
import { DATA_DIR, IMAGE, docker, helperFlags, runHelper, tmpName, volumeExists } from "./docker.js";
import {
	NOT_SIGNED_IN,
	SIGNED_OUT,
	SIGN_IN_EXPIRED,
	SIGN_IN_REFUSED,
	SIGN_IN_UNREACHABLE,
	SignInRefreshError,
	TOKEN_VALID_FOR_MS,
	type WindlassLack,
	WindlassOutdatedError,
	loginTokenCommand,
	outdatedWindlass,
	saysShorterThanAsked,
	windlassDuration,
} from "./handoff.js";
import { assertName, authVolume, migrateSignIn } from "./volumes.js";

/** How long `windlass login token` may take: it waits up to 30 s for Windlass's refresh lock, then asks OpenAI. */
const TOKEN_TIMEOUT_MS = 90_000;

export interface DockerAccessTokensOptions {
	image?: string;
	/**
	 * The helper's network. "none" is for checks that must not be able to send anything: a token that has
	 * the time left that is asked for is printed all the same, and one that needs a refresh fails.
	 */
	network?: "bridge" | "none";
	/** Where the line `[wlp] token.short` goes. Default the console. It never contains a token. */
	log?: (line: string) => void;
}

/**
 * The version of the Windlass in an image and what it lacks for handing a token on, asked once per
 * image id. It is found out as build.sh does, by running the token source's own command in an empty
 * data directory and without a network: a Windlass that has all of it exits 1 ("not signed in"); one
 * with `login token` but without `--valid-for` exits 2 ("unknown option --valid-for"), and so does one
 * without the command ("unknown login command").
 */
export interface ImageWindlass {
	version: string | null;
	/** What the hand-off needs and this Windlass does not have; null when it has it all. */
	lacks: WindlassLack | null;
}

const probed = new Map<string, { imageId: string; found: ImageWindlass }>();

export async function probeImage(image: string = IMAGE): Promise<ImageWindlass | null> {
	const inspected = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
	if (inspected.code !== 0) return null;
	const imageId = inspected.stdout.trim();
	const known = probed.get(image);
	if (known?.imageId === imageId) return known.found;
	const [first, second] = [tmpName(), tmpName()];
	const [said, token] = await Promise.all([
		runHelper(helperFlags(first, "none"), first, ["windlass", "--version"], { timeoutMs: 60_000, image }),
		runHelper(helperFlags(second, "none"), second, loginTokenCommand(), { timeoutMs: 60_000, image }),
	]);
	// "Windlass 0.1.1+0f5192c3ea (linux-arm64)"
	const match = /^\S+\s+(\S+)/.exec(said.stdout.trim());
	const found = { version: said.code === 0 && match !== null ? match[1]! : null, lacks: token.code === 1 ? null : lackOf(token) };
	// A probe that could not run (Docker busy, a timeout) is not remembered.
	if (found.version !== null && !token.timedOut) probed.set(image, { imageId, found });
	return found;
}

/** Windlass's answer to a command line it does not know: exit code 2, with its usage. The exit code says it. */
function isUsage(result: { code: number | null }): boolean {
	return result.code === 2;
}

/**
 * Which part of the token source's command line a Windlass that refused it does not know. Read from its
 * words, and it has to be: a usage error has no code, and the only Windlasses that give this one are the
 * older builds, whose sentence ("unknown option --valid-for") is as it was when they were built. It
 * chooses between two sentences that both say to rebuild the image.
 */
function lackOf(result: { stderr: string }): WindlassLack {
	return /unknown option --valid-for/.test(result.stderr) ? "--valid-for" : "login token";
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

/** A token as it is kept for a user's other requests, and until when. */
interface Kept {
	token: AccessToken;
	reuseUntil: number;
}

export class DockerAccessTokens implements AccessTokens {
	private readonly image: string;
	private readonly network: "bridge" | "none";
	private readonly log: (line: string) => void;
	private readonly cache = new Map<string, Kept>();
	private readonly running = new Map<string, Promise<AccessToken>>();
	/** Counts the changes of each user's sign-in, so an answer that was on its way across one is not kept. */
	private readonly changes = new Map<string, number>();
	/** The users whose last token came out shorter than asked, which was said once for each. */
	private readonly short = new Set<string>();
	/** How many times Windlass was asked, for the layer's own checks. */
	asked = 0;

	constructor(options: DockerAccessTokensOptions = {}) {
		this.image = options.image ?? IMAGE;
		this.network = options.network ?? "bridge";
		this.log = options.log ?? ((line) => console.log(line));
	}

	async current(uid: string): Promise<AccessToken> {
		assertName(uid, "user id");
		const kept = this.cache.get(uid);
		if (kept !== undefined && Date.now() < kept.reuseUntil) return { ...kept.token };
		// One at a time per user: whoever asks while a request runs waits for that one's answer.
		let running = this.running.get(uid);
		if (running === undefined) {
			running = this.ask(uid).finally(() => this.running.delete(uid));
			this.running.set(uid, running);
		}
		return { ...(await running) };
	}

	/** The user's sign-in changed (a new one was adopted, or it was forgotten): no token of the old one is handed out again. */
	forget(uid: string): void {
		this.cache.delete(uid);
		this.short.delete(uid);
		this.changes.set(uid, (this.changes.get(uid) ?? 0) + 1);
	}

	private async ask(uid: string): Promise<AccessToken> {
		for (let tries = 0; ; tries += 1) {
			const before = this.changes.get(uid) ?? 0;
			const token = await this.loginToken(uid);
			if ((this.changes.get(uid) ?? 0) === before) {
				this.keep(uid, token);
				return token;
			}
			// The sign-in changed while Windlass was asked, so this token may be the old one's: ask again.
			if (tries >= 2) return token;
		}
	}

	/**
	 * Keeps a token for the user's other requests. One that has what was asked for is reused for as long
	 * as it does: asking again before then would print the same one. One with less is the longest the
	 * service gives (Windlass refreshed for it): asking again would refresh again and give no more, so
	 * it is reused until half of what it has left is gone.
	 */
	private keep(uid: string, token: AccessToken): void {
		const left = token.expiresAt - Date.now();
		this.cache.set(uid, { token, reuseUntil: token.expiresAt - (left > TOKEN_VALID_FOR_MS ? TOKEN_VALID_FOR_MS : left / 2) });
	}

	private async loginToken(uid: string): Promise<AccessToken> {
		await migrateSignIn(uid, this.image);
		const volume = authVolume(uid);
		if (!(await volumeExists(volume))) throw new SandboxUserError(NOT_SIGNED_IN);
		const helper = tmpName();
		this.asked += 1;
		const result = await runHelper([...helperFlags(helper, this.network), "-v", `${volume}:${DATA_DIR}`], helper, loginTokenCommand(), { timeoutMs: TOKEN_TIMEOUT_MS, image: this.image });
		if (result.timedOut) throw new Error("`windlass login token` did not answer in time");
		if (result.code === 0) {
			const token = parseToken(result.stdout);
			if (token === null) throw new Error("`windlass login token --json` did not print a token and its expiry");
			if (token.expiresAt <= Date.now()) throw new Error("`windlass login token` printed a token that has already expired");
			this.noteLength(uid, token, saysShorterThanAsked(result.stderr));
			return token;
		}
		const stderr = result.stderr.trim();
		// The image's Windlass does not know the command or its option: it says which, and the probe knows its version.
		if (isUsage(result)) throw new WindlassOutdatedError(outdatedWindlass((await probeImage(this.image).catch(() => null))?.version ?? null, this.image, lackOf(result)));
		// What Windlass says about the sign-in, by its code.
		const failed = signInFailure(stderr);
		if (failed !== null) {
			if (failed.code === SIGNED_OUT) throw new SandboxUserError(NOT_SIGNED_IN);
			if (SIGN_IN_REFUSED.has(failed.code)) throw new SandboxUserError(SIGN_IN_EXPIRED);
			// Not the user's doing. That the service could not be reached is said in Windlass's own sentence, which names the host and the reason.
			if (failed.code === SIGN_IN_UNREACHABLE) throw new SignInRefreshError(`${failed.message.charAt(0).toLowerCase()}${failed.message.slice(1)}`, failed.code);
			throw new SignInRefreshError(`the sign-in could not be refreshed: ${failed.message} (${failed.code})`, failed.code);
		}
		// No code from here on. Windlass reports nobody being signed in without one, as a line of its own
		// ("windlass: not signed in, so there is no token to hand on; run `windlass login`", exit code 1), so that
		// one answer is still told by its words.
		if (result.code === 1 && stderr.split("\n").some((line) => /^\S+: not signed in\b/.test(line.trim()))) throw new SandboxUserError(NOT_SIGNED_IN);
		// Anything else is not known to be about the sign-in, and is not said to be: an older Windlass (before
		// 0.1.1+739e1cbc09) died here with a stack trace when the sign-in service could not be reached, and the
		// line of the error it threw is its reason.
		throw new Error(`\`windlass login token\` failed (exit code ${result.code}): ${thrownLine(stderr) ?? "it gave no reason"}`);
	}

	/**
	 * Windlass's one line about a token that is good for less than was asked is not an error: it is said
	 * once for the user, and again only after a token came that had what was asked for, or after the
	 * user's sign-in changed.
	 */
	private noteLength(uid: string, token: AccessToken, shorter: boolean): void {
		if (!shorter) {
			this.short.delete(uid);
			return;
		}
		if (this.short.has(uid)) return;
		this.short.add(uid);
		const left = Math.max(0, token.expiresAt - Date.now());
		this.log(
			`[wlp] token.short uid=${uid}: Windlass was asked for an access token that is good for ${windlassDuration(TOKEN_VALID_FOR_MS)} more, which is more than the sign-in service issues: after a refresh the token lasts ${Math.round(left / 1000)} s. It is used as it is, with that expiry, and so is every such token until half of what it has left is gone`,
		);
	}
}

/** The object `windlass login token --json` prints, from its standard output. Null when that is not what it printed. */
function parseToken(stdout: string): AccessToken | null {
	const line = stdout.trim().split("\n").pop() ?? "";
	try {
		const value = JSON.parse(line) as { accessToken?: unknown; expiresAt?: unknown };
		if (typeof value?.accessToken !== "string" || value.accessToken === "" || /\s/.test(value.accessToken) || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
		return { accessToken: value.accessToken, expiresAt: value.expiresAt };
	} catch {
		return null;
	}
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * Why Windlass died, from what it wrote to standard error: the line of the error it threw (how an older
 * Windlass ended when a request could not be sent), never a stack frame or the source excerpt Bun
 * prints with it. It words a reason and decides nothing: such a failure is never taken for the sign-in's.
 */
function thrownLine(stderr: string): string | null {
	const lines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const thrown = lines.find((line) => /^(error|[A-Z]\w*Error|[A-Z]\w*Exception)(\[\w+\])?: \S/.test(line));
	if (thrown !== undefined) return oneLine(thrown.replace(/^error: /, ""));
	const own = lines.find((line) => /^windlass: /.test(line));
	return own === undefined ? null : oneLine(own.replace(/^windlass: /, ""));
}
