/**
 * The sandbox layer, put together: `createSandboxLayer` for a server on Docker, `createE2bLayer` for
 * one on E2B (server/src/layer.ts chooses by WLP_SANDBOX).
 *
 * Docker mounts the user's data volume in session containers. The user's actor holds the ChatGPT sign-in.
 */

import { mirrorDeployment, snapshotDeployment } from "./snapshot-deployment.js";
import { config } from "../config.js";
import type { SandboxLayer } from "./api.js";
import { WindlassSignIns } from "../signin/commands.js";
import type { MemorySignInDirectory } from "../signin/directory.js";
import { type SignInLogins, type SignInTokens, actorSignIns, memorySignIns } from "../signin/facade.js";
import { DockerLoginRunner } from "./logins.js";
import { DockerSandboxes } from "./sandboxes.js";
import { dropSessionVolume, ensureSessionVolume, ensureUserVolume, removeTokenFiles, sessionVolume, userVolume } from "./volumes.js";
import { DockerWindlass } from "./windlass.js";
import { IMAGE } from "./docker.js";
import { DockerModelRelay, type DockerModelRelayOptions, HOSTED_RELAY_USER_REQUESTS } from "./model-relay.js";

export interface DockerSandboxLayer extends SandboxLayer {
	sandboxes: DockerSandboxes;
	windlass: DockerWindlass;
	logins: SignInLogins;
	tokens: SignInTokens;
	/** The sign-ins kept in this process, with `signIns: "memory"`; null on a server, where the users' actors hold them. */
	signIns: MemorySignInDirectory | null;
}

/** For the layer's own checks; the server takes the defaults. */
export interface SandboxLayerOptions {
	/** Another image than windlass-platform-sandbox:latest. */
	image?: string;
	shotsImage?: string;
	/**
	 * "memory": the users' sign-ins are kept in this process instead of in the server's `user` actors,
	 * and Windlass's sign-in commands run in helper containers of `image`. For a check that uses the
	 * layer by itself, with no server beside it; one process only, so never for a deployment. The
	 * default, "actors", is the server's: `logins` and `tokens` call the users' actors, and the commands
	 * run where the server is configured to run them (signin/index.ts).
	 */
	signIns?: "actors" | "memory";
	/** With "memory". "none": the helper that asks Windlass for an access token gets no network, so it can send nothing: a token that needs no refresh is printed all the same, and one that needs one fails. */
	tokenNetwork?: "bridge" | "none";
	/** With "memory": more `docker run` flags for that helper (a volume a stand-in for the sign-in service reads its plan from). */
	signInHelperFlags?: string[];
	/**
	 * Windlass's model relay (docs/model-relay.md). Left out: the server's layer has it unless
	 * WLP_MODEL_RELAY=off, and a check's layer (`signIns: "memory"`) does not, so the checks of the token
	 * file in the sandbox, which runners older than `model-relay` still use, go on checking that. "off":
	 * none. Options: a relay with them (the relay's own checks).
	 */
	modelRelay?: "off" | Partial<DockerModelRelayOptions>;
}

export function createSandboxLayer(options: SandboxLayerOptions = {}): DockerSandboxLayer {
	const { image } = options;
	// Docker's part of a user: the volume Windlass's own data of that user's sessions is in.
	const ensureUserData = (uid: string) => ensureUserVolume(uid, image);
	const signIns =
		options.signIns === "memory"
			? memorySignIns({
					commands: new WindlassSignIns(new DockerLoginRunner({ image, network: options.tokenNetwork, extraFlags: options.signInHelperFlags })),
					revoke: (uid) => removeTokenFiles(uid, image),
					ensureUserData,
				})
			: { ...actorSignIns({ ensureUserData }), directory: null };
	const relayOptions = options.modelRelay ?? (options.signIns !== "memory" && config.modelRelay.on ? {} : "off");
	const modelRelay = relayOptions === "off" ? undefined
		: new DockerModelRelay({ machine: "", image: image ?? IMAGE, requests: config.modelRelay.requests, userRequests: HOSTED_RELAY_USER_REQUESTS, ...relayOptions });
	return {
		// The hosted provider: its containers carry no machine, and mount the user's volume of this machine.
		sandboxes: new DockerSandboxes({
			image,
			shotsImage: options.shotsImage,
			machine: null,
			modelRelay,
			deployment: snapshotDeployment(config.storagePath, config.snapshots),
			mirrorScope: mirrorDeployment(config.storagePath),
			dataVolume: async (uid, sandbox) => {
				if (sandbox !== undefined) return ensureSessionVolume(uid, sandbox);
				await ensureUserData(uid);
				return userVolume(uid);
			},
			dropDataVolume: dropSessionVolume,
			ownVolumeName: sessionVolume,
		}),
		windlass: new DockerWindlass(signIns.tokens, { image }),
		logins: signIns.logins,
		tokens: signIns.tokens,
		signIns: signIns.directory,
	};
}

/**
 * The layer of a server on E2B (WLP_SANDBOX=e2b): sessions' sandboxes are E2B microVMs (e2b/), which
 * every server machine of a deployment reaches. The sign-ins are the users' actors', as on Docker, and
 * E2B adds nothing to a user: Windlass's data directory is on each sandbox's own disk, so there is no
 * `ensureUserData`. That disk goes with the sandbox, so where a bucket is configured a copy of
 * Windlass's session data is kept there (backup.ts); the Docker layer has none: its data directory is
 * a volume that outlives every sandbox. The E2B provider and E2B's SDK are loaded here and not before,
 * so a server on Docker needs neither. Throws, with what to set, when E2B_API_KEY is missing.
 */
export async function createE2bLayer(): Promise<SandboxLayer> {
	const { createE2bSandboxLayer } = await import("./e2b/index.js");
	const { backupsFromConfig } = await import("./backup.js");
	const signIns = actorSignIns();
	return createE2bSandboxLayer({
		logins: signIns.logins,
		tokens: signIns.tokens,
		backups: await backupsFromConfig(),
	});
}

export { SandboxUserError } from "./api.js";
export type * from "./api.js";
