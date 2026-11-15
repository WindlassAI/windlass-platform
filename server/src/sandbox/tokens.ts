/**
 * What the Docker layer still knows about access tokens: whether the Windlass of an image can hand one
 * on at all (`probeImage`), which the layer says when the server starts and before every turn.
 *
 * The token source itself is no longer here, and no longer Docker's. A user's sign-in is kept, sealed,
 * in that user's `user` actor, and that actor is the one place that asks Windlass for the user's access
 * token (server/src/signin/: holder.ts says how, commands.ts what Windlass answers). `AccessTokens`
 * (api.ts) is a call to that actor from whichever server runs the turn (signin/facade.ts). Where the
 * command runs is a runner's business: a Windlass on the server, or a helper container of this image
 * (logins.ts).
 */

import { lackOf } from "../signin/commands.js";
import { IMAGE, docker, helperFlags, runHelper, tmpName } from "./docker.js";
import { type WindlassLack, loginTokenCommand } from "./handoff.js";

/**
 * The version of the Windlass in an image and what it lacks for handing a token on, asked once per
 * image id. It is found out as build.sh does, by running the token command in an empty data directory
 * and without a network: a Windlass that has all of it exits 1 ("not signed in"); one with
 * `login token` but without `--valid-for` exits 2 ("unknown option --valid-for"), and so does one
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
