/**
 * Windlass's sign-in commands in a throwaway container of the sandbox image: the Docker form of the
 * runner in signin/runner.ts, kept for development on a machine that has the image and no Windlass of
 * its own. A deployment runs them with a Windlass on the server instead (`LocalLoginRunner`) and needs
 * no Docker for it.
 *
 *   docker run --rm -i --init --name wlp-tmp-<..> --label dev.windlass-platform=1 --cap-drop ALL \
 *     --security-opt no-new-privileges --network none|bridge --memory 512m --pids-limit 128 \
 *     windlass-platform-sandbox:latest python3 -I -c <IN_CONTAINER> <seconds> login token --json --valid-for 20m
 *
 * No volume is mounted and nothing is written on the host. The sign-in material goes in on the
 * container's standard input and comes back on its standard output, as JSON; inside, a small program
 * does what every runner does (signin/runner.ts): it makes a private directory in the container's
 * memory (`/dev/shm`), writes the material into it, runs `windlass login ...` with XDG_DATA_HOME
 * pointing there, reads the files back whatever the command did, and removes the directory. The
 * container is removed when it ends, and with it everything in it.
 *
 * The command's own time limit is kept inside the container, so that a command that hangs is ended
 * there and what it had saved still comes back. Only when the container itself does not answer is it
 * removed from outside, and then nothing can be read back.
 *
 * The network is the bridge for a command that talks to the sign-in service and none otherwise. What
 * the container prints may hold a sign-in and a token: it is parsed here and never logged or put into
 * an error.
 *
 * A command that runs on a handed-in access token (`runWithToken`) goes the same way: the token goes in
 * on standard input, and the program writes it to a file in the private directory and names that file
 * to Windlass with WINDLASS_ACCESS_TOKEN_FILE.
 */

import { MATERIAL_FILES, MAX_MATERIAL_FILE_BYTES, NO_MATERIAL, type SignInMaterial, cleanMaterial } from "../signin/material.js";
import type { LoginCommand, LoginRun, LoginRunner, TokenCommand, TokenRun } from "../signin/runner.js";
import type { AccessToken } from "./api.js";
import { IMAGE, docker, helperFlags, tmpName } from "./docker.js";
import { ACCESS_TOKEN_FILE_ENV, tokenFileContent } from "./handoff.js";
import { probeImage } from "./tokens.js";

/**
 * Runs inside the container. Arguments: the command's time limit in seconds, then Windlass's own
 * arguments. Standard input: `{"files": {name: text}, "stdin": text}`, or with `"token": text` in
 * place of the files, the content of an access token file to hand to Windlass. Standard output:
 * `{"code": .., "stdout": .., "stderr": .., "timedOut": .., "files": {name: text}}`.
 */
const IN_CONTAINER = `
import json, os, shutil, subprocess, sys, tempfile
NAMES = ${JSON.stringify([...MATERIAL_FILES])}
LIMIT = ${MAX_MATERIAL_FILE_BYTES}
request = json.load(sys.stdin)
seconds = float(sys.argv[1])
memory = "/dev/shm"
root = tempfile.mkdtemp(prefix="wlp-signin-", dir=memory if os.path.isdir(memory) and os.access(memory, os.W_OK | os.X_OK) else None)
answer = {"code": None, "stdout": "", "stderr": "", "timedOut": False, "files": {}}
try:
    data = os.path.join(root, "data", "windlass")
    os.makedirs(data, mode=0o700)
    given = request.get("files") or {}
    for name in NAMES:
        text = given.get(name)
        if isinstance(text, str):
            fd = os.open(os.path.join(data, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(text)
    env = dict((k, v) for k, v in os.environ.items() if not k.startswith("WINDLASS_"))
    env["XDG_DATA_HOME"] = os.path.join(root, "data")
    token = request.get("token")
    if isinstance(token, str):
        handed = os.path.join(root, "access-token.json")
        fd = os.open(handed, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(token)
        env[${JSON.stringify(ACCESS_TOKEN_FILE_ENV)}] = handed
    try:
        done = subprocess.run(["windlass"] + sys.argv[2:], input=request.get("stdin") or "", capture_output=True, text=True, timeout=seconds, env=env)
        answer["code"], answer["stdout"], answer["stderr"] = done.returncode, done.stdout, done.stderr
    except subprocess.TimeoutExpired as late:
        answer["timedOut"] = True
        said = late.stderr or ""
        answer["stderr"] = said.decode("utf-8", "replace") if isinstance(said, bytes) else said
    for name in NAMES:
        path = os.path.join(data, name)
        if os.path.isfile(path) and not os.path.islink(path) and os.path.getsize(path) <= LIMIT:
            with open(path) as f:
                answer["files"][name] = f.read()
finally:
    shutil.rmtree(root, ignore_errors=True)
json.dump(answer, sys.stdout)
`;

/** How much longer than the command the container may take before it is removed from outside: starting it, and reading the files back. */
const CONTAINER_MARGIN_MS = 20_000;

export interface DockerLoginRunnerOptions {
	image?: string;
	/**
	 * The network of a command that talks to the sign-in service. "none" is for checks that must not be
	 * able to send anything: a token that has the time left that is asked for is printed all the same, and
	 * one that needs a refresh fails.
	 */
	network?: "bridge" | "none";
	/** More `docker run` flags for the helper, for the layer's own checks (a volume for a stand-in's plan). */
	extraFlags?: string[];
}

export class DockerLoginRunner implements LoginRunner {
	private readonly image: string;
	private readonly network: "bridge" | "none";

	constructor(private readonly options: DockerLoginRunnerOptions = {}) {
		this.image = options.image ?? IMAGE;
		this.network = options.network ?? "bridge";
	}

	async run(material: SignInMaterial, command: LoginCommand): Promise<LoginRun> {
		return this.inContainer(["login", ...command.args], { files: material.files, stdin: command.stdin ?? "" }, command, material);
	}

	async runWithToken(token: AccessToken, command: TokenCommand): Promise<TokenRun> {
		return this.inContainer(command.args, { token: tokenFileContent(token) }, { ...command, network: true });
	}

	/** One container for one command: `args` are Windlass's, `request` what the program inside is given. `material` is what the answer holds when nothing could be read back. */
	private async inContainer(args: string[], request: Record<string, unknown>, command: Pick<LoginCommand, "network" | "timeoutMs" | "signal">, material: SignInMaterial = NO_MATERIAL): Promise<LoginRun> {
		const name = tmpName();
		const flags = [...helperFlags(name, command.network ? this.network : "none"), ...(this.options.extraFlags ?? [])];
		const seconds = String(Math.max(1, Math.ceil(command.timeoutMs / 1000)));
		let aborted = false;
		let returned = false;
		// The local client cannot be signalled through docker.ts: removing the container ends both. An abort
		// can come before the container exists, so it is tried until it is gone or the client has returned.
		const onAbort = () => {
			aborted = true;
			void (async () => {
				for (let tries = 0; tries < 60 && !returned; tries += 1) {
					const removed = await docker(["rm", "-f", name]).catch(() => null);
					if (removed !== null && removed.code === 0 && removed.stdout.trim() === name) return;
					await new Promise((done) => setTimeout(done, 200));
				}
			})();
		};
		if (command.signal?.aborted) return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true, material, materialRead: false };
		command.signal?.addEventListener("abort", onAbort, { once: true });
		let result: Awaited<ReturnType<typeof docker>>;
		try {
			result = await docker(["run", ...flags, this.image, "python3", "-I", "-c", IN_CONTAINER, seconds, ...args], {
				stdin: JSON.stringify(request),
				timeoutMs: command.timeoutMs + CONTAINER_MARGIN_MS,
			});
		} finally {
			returned = true;
			command.signal?.removeEventListener("abort", onAbort);
		}
		// Killing the local client does not stop the container.
		if (result.timedOut) await docker(["rm", "-f", name]).catch(() => undefined);
		const answer = parseAnswer(result.stdout);
		if (answer === null) {
			// The container gave no answer of its own: it was removed, or could not be started. Nothing was read back.
			if (!aborted && !result.timedOut) throw new Error(`could not run Windlass in a helper container of ${this.image} (exit code ${result.code}): ${result.stderr.replace(/\s+/g, " ").trim().slice(0, 300) || "it printed nothing"}`);
			return { code: null, stdout: "", stderr: "", timedOut: result.timedOut && !aborted, aborted, material, materialRead: false };
		}
		return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr, timedOut: answer.timedOut, aborted, material: cleanMaterial(answer.files), materialRead: true };
	}

	async version(): Promise<string | null> {
		return probeImage(this.image);
	}
}

interface ContainerAnswer {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	files: unknown;
}

function parseAnswer(stdout: string): ContainerAnswer | null {
	try {
		const value = JSON.parse(stdout) as Partial<ContainerAnswer> | null;
		if (typeof value !== "object" || value === null || typeof value.stdout !== "string" || typeof value.stderr !== "string") return null;
		return { code: typeof value.code === "number" ? value.code : null, stdout: value.stdout, stderr: value.stderr, timedOut: value.timedOut === true, files: value.files };
	} catch {
		return null;
	}
}
