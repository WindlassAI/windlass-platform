#!/bin/sh
# Builds windlass-platform-sandbox:latest. Idempotent: an unchanged Dockerfile and binary reuse the cache.
#
#   WINDLASS_BINARY=/path/to/windlass-linux-<arch> sandbox/build.sh
#
# Without WINDLASS_BINARY it takes the light-harness dist build for this machine's architecture, or
# the 0.1.0 release build. Prints the installed Windlass version on its last line.
set -eu

IMAGE=windlass-platform-sandbox:latest
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
# "Windlass 0.1.0 (linux-arm64)" -> "0.1.0"
echo "$version" | awk '{print $2}'
