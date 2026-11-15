#!/bin/sh
# Builds the sandbox image, windlass-platform-sandbox:latest. Idempotent: an unchanged Dockerfile and binary reuse the cache.
#
#   WINDLASS_BINARY=/path/to/windlass-linux-<arch> sandbox/build.sh
#   WLP_SANDBOX_IMAGE=<name:tag> ...   another tag than the one the server uses (scripts/sandbox-check.ts
#                                      builds throwaway images from older Windlasses this way)
#
# The platform needs a Windlass that can hand a session an access token that is good for a while yet:
# `windlass login token --valid-for <duration>` and WINDLASS_ACCESS_TOKEN_FILE (`windlass login --help`
# lists the option). An older one still builds, with a warning: demo turns work with it, turns on a
# ChatGPT sign-in do not. That is so for a Windlass without `login token`, and for one that has the
# command but not its `--valid-for`.
#
# Without WINDLASS_BINARY it takes the first of these that exists for this machine's architecture:
#   ~/projects/windlass-local-builds            a copy of the local build that has all of it
#   ~/projects/wt-windlass-token-handoff/dist   an older local build: `login token` without `--valid-for`
#   ~/projects/light-harness/dist               an older local build, without `login token`
#   ~/windlass-0.1.0/release                    the 0.1.0 release build, without `login token`
# Prints the installed Windlass version on its last line.
set -eu

IMAGE="${WLP_SANDBOX_IMAGE:-windlass-platform-sandbox:latest}"
LABEL=dev.windlass-platform=1
here=$(cd "$(dirname "$0")" && pwd)

case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "build.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

binary="${WINDLASS_BINARY:-}"
if [ -z "$binary" ]; then
  for candidate in \
    "/home/ubuntu/projects/windlass-local-builds/windlass-linux-$arch" \
    "/home/ubuntu/projects/wt-windlass-token-handoff/dist/windlass-linux-$arch" \
    "/home/ubuntu/projects/light-harness/dist/windlass-linux-$arch" \
    "/home/ubuntu/windlass-0.1.0/release/windlass-linux-$arch"; do
    if [ -f "$candidate" ]; then binary="$candidate"; break; fi
  done
fi
if [ -z "$binary" ] || [ ! -f "$binary" ]; then
  echo "build.sh: no Windlass binary found; set WINDLASS_BINARY to a windlass-linux-$arch executable" >&2
  exit 1
fi

# A small build context of its own: the Dockerfile, the helper and the binary (hard-linked when possible).
context=$(mktemp -d "${TMPDIR:-/tmp}/wlp-build.XXXXXX")
trap 'rm -rf "$context"' EXIT INT TERM
cp "$here/Dockerfile" "$here/wlp-run" "$context/"
ln "$binary" "$context/windlass" 2>/dev/null || cp "$binary" "$context/windlass"

echo "build.sh: building $IMAGE with $binary" >&2
docker build --quiet --label "$LABEL" --tag "$IMAGE" "$context" >&2

version=$(docker run --rm --label "$LABEL" --name "wlp-build-$$" --network none "$IMAGE" windlass --version)
echo "build.sh: installed $version" >&2

# Does this Windlass have `login token --valid-for`? The platform's own command, in an empty data
# directory and with no network: a Windlass that has it says "not signed in" and exits 1. An older one
# exits 2 with its usage, and says what it does not know: the option ("unknown option --valid-for"),
# or the command itself.
status=0
said=$(docker run --rm --label "$LABEL" --name "wlp-build-$$" --network none "$IMAGE" windlass login token --json --valid-for 20m 2>&1 >/dev/null) || status=$?
if [ "$status" != 1 ]; then
  case "$said" in
    *"unknown option --valid-for"*) lacks="has \`windlass login token\` but not its \`--valid-for\` option, which the platform asks for every access token with," ;;
    *) lacks="has no \`windlass login token\`," ;;
  esac
  echo "build.sh: WARNING: this Windlass $lacks so the platform cannot hand a session an access token:" >&2
  echo "build.sh:          turns on a ChatGPT sign-in will fail (demo turns work). Rebuild from a newer Windlass, one with" >&2
  echo "build.sh:          \`windlass login token --valid-for\` (\`windlass login --help\` lists it):" >&2
  echo "build.sh:          WINDLASS_BINARY=/path/to/windlass-linux-$arch sandbox/build.sh" >&2
fi
# "Windlass 0.1.0 (linux-arm64)" -> "0.1.0"
echo "$version" | awk '{print $2}'
