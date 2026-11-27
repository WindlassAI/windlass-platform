/**
 * `GET /install.sh`: the one-line install of a machine, `curl -fsSL <platform>/install.sh | sh`
 * (docs/machines.md). A short POSIX sh script with this platform's address and its pinned runner
 * image put in. It checks that Docker is there and answers, pulls the image and runs the runner's
 * setup in a one-off container on the terminal. It writes nothing on the host outside Docker and
 * never asks for sudo. Without a terminal it prints the setup command instead.
 */
import { config } from "./config.js";

export const INSTALL_SCRIPT_PATH = "/install.sh";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** The script for this platform address and runner image (both checked by config.ts: an origin, an image pinned by digest). */
export function installScript(platform: string, image: string): string {
	return `#!/bin/sh
# Installs the Windlass runner on this machine for ${platform}.
# It needs Docker, and runs the runner's setup in a one-off container. It changes
# nothing else here: no sudo, no files outside Docker. Read it before you run it:
#   curl -fsSL ${platform}/install.sh
set -eu

PLATFORM=${quote(platform)}
IMAGE=${quote(image)}

say() { printf '%s\\n' "$*"; }
fail() { printf 'windlass: %s\\n' "$*" >&2; exit 1; }
# Under curl | sh standard input is this script: questions are asked on the terminal.
has_terminal() { (: </dev/tty) 2>/dev/null; }

os=$(uname -s 2>/dev/null || echo unknown)
wsl=false
case "$os" in
  Linux) if grep -qi microsoft /proc/version 2>/dev/null; then wsl=true; fi ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  case "$os" in
    Darwin) fail "Docker is not installed. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/) or OrbStack (https://orbstack.dev), start it, then run this again." ;;
    Linux)
      if [ "$wsl" = true ]; then fail "Docker is not available in this WSL distribution. In Docker Desktop, open Settings > Resources > WSL integration, turn it on for this distribution, then run this again."; fi
      fail "Docker is not installed. Install Docker Engine (https://docs.docker.com/engine/install/), then run this again." ;;
    MINGW*|MSYS*|CYGWIN*) fail "Run this in a WSL terminal with Docker Desktop's WSL integration on, or run the setup command from the Machines page in PowerShell." ;;
    *) fail "Docker is not installed. Install Docker, then run this again." ;;
  esac
fi

if ! problem=$(docker info --format '{{.ServerVersion}}' 2>&1 >/dev/null); then
  case "$problem" in
    *"permission denied"*) fail "Docker is running, but this user may not use it. Add the user to the docker group (then log in again), or run this as a user who can run docker." ;;
  esac
  case "$os" in
    Darwin) fail "Docker is not running. Start Docker Desktop or OrbStack, wait until it says it is running, then run this again." ;;
    Linux)
      if [ "$wsl" = true ]; then fail "Docker is not running. Start Docker Desktop on Windows, then run this again."; fi
      fail "Docker is not running. Start it (for example: sudo systemctl start docker), then run this again." ;;
    *) fail "Docker is not running. Start it, then run this again." ;;
  esac
fi

say "Fetching the Windlass runner..."
docker pull "$IMAGE" || fail "Could not fetch $IMAGE. Check this machine's network, then run this again."

# Docker keeps no log of this container: the setup's sign-ins happen in it.
set -- docker run -it --rm --log-driver none \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v windlass-runner:/var/lib/windlass-runner \\
  "$IMAGE" setup --platform "$PLATFORM"

if has_terminal; then
  exec "$@" </dev/tty
fi
say "There is no terminal here to answer the setup's questions. Run this in a terminal on this machine:"
say ""
say "  $*"
`;
}

const headers = {
	"content-type": "text/plain; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};

/** The script, or a script that says why there is none; 404 where this platform takes no machines. */
export function installScriptResponse(request: Request): Response {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method not allowed\n", { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
	const machines = config.machines;
	if (!machines) return new Response("Not found\n", { status: 404, headers });
	const body = machines.runnerImage
		? installScript(machines.publicUrl, machines.runnerImage)
		: "#!/bin/sh\necho 'windlass: this platform has not published a runner yet, so there is nothing to install.' >&2\nexit 1\n";
	return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}
