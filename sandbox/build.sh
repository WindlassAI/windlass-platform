#!/bin/sh
# Builds the base sandbox image or its screenshots variant. Idempotent: an unchanged Dockerfile and binary reuse the cache.
#
# From server/, publish the local image or supply a run-private tag:
#   WINDLASS_BINARY=/path/to/windlass-linux-<arch> ../sandbox/build.sh
#   WLP_SANDBOX_IMAGE=<name:tag> ../sandbox/build.sh
#   WLP_SANDBOX_VARIANT=shots ../sandbox/build.sh
#
# Without WINDLASS_BINARY it takes the released Windlass that sandbox/fetch-windlass.sh pins and fetches.
# A build of your own is for trying a Windlass that is not released yet:
#   WINDLASS_BINARY=~/projects/windlass-local-builds/windlass-linux-<arch> ../sandbox/build.sh
# Prints the installed Windlass version on its last line.
set -eu

context_only=false
if [ "$#" -gt 0 ]; then
  if [ "$#" != 2 ] || [ "$1" != --context ] || [ -z "$2" ]; then
    echo "usage: build.sh [--context <empty directory>]" >&2
    exit 2
  fi
  context_only=true
  context=$2
  mkdir -p "$context"
  [ -z "$(ls -A "$context")" ] || { echo "build.sh: context directory must be empty" >&2; exit 2; }
fi

variant=${WLP_SANDBOX_VARIANT:-base}
case "$variant" in
  base) tag=latest ;;
  shots) tag=shots ;;
  *) echo "WLP_SANDBOX_VARIANT must be base or shots" >&2; exit 2 ;;
esac
IMAGE="${WLP_SANDBOX_IMAGE:-windlass-platform-sandbox:$tag}"
if [ "$context_only" = true ]; then
  : # No local image tag is published.
elif [ -n "${WLP_SANDBOX_IMAGE:-}" ]; then
  case "$IMAGE" in
    windlass-platform-sandbox:shots) echo "build.sh: omit WLP_SANDBOX_IMAGE to publish :shots" >&2; exit 2 ;;
  esac
  case "${IMAGE##*/}" in
    *:latest) echo "build.sh: omit WLP_SANDBOX_IMAGE to publish :latest" >&2; exit 2 ;;
    *:*) ;;
    *) echo "build.sh: give the private image an explicit tag" >&2; exit 2 ;;
  esac
else
  # Only publishers compete for this tag. An interrupted publisher releases the descriptor.
  exec 9>>/tmp/wlp-sandbox-publish.lock
  flock -n 9 || { echo "build.sh: another local image publication is in progress" >&2; exit 1; }
fi
LABEL=dev.windlass-platform=1
here=$(cd "$(dirname "$0")" && pwd)

case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "build.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

binary="${WINDLASS_BINARY:-}"
if [ -z "$binary" ]; then
  binary="$("$here/fetch-windlass.sh")/windlass-linux-$arch"
fi
if [ -z "$binary" ] || [ ! -f "$binary" ]; then
  echo "build.sh: no Windlass binary found; set WINDLASS_BINARY to a windlass-linux-$arch executable" >&2
  exit 1
fi

# A small build context of its own: the Dockerfile, the helpers and the binary (hard-linked when possible).
if [ "$context_only" = false ]; then
  context=$(mktemp -d "${TMPDIR:-/tmp}/wlp-build.XXXXXX")
  trap 'rm -rf "$context"' EXIT INT TERM
fi
cp "$here/Dockerfile" "$here/wlp-run" "$context/"
if [ "$variant" = shots ]; then cp "$here/wlp-shot" "$context/"; fi
ln "$binary" "$context/windlass" 2>/dev/null || cp "$binary" "$context/windlass"

[ "$context_only" = false ] || exit 0

echo "build.sh: building $IMAGE with $binary" >&2
docker build --target "$variant" --progress=plain --label "$LABEL" --tag "$IMAGE" "$context" >&2

version=$(docker run --rm --label "$LABEL" --name "wlp-build-$$" --network none "$IMAGE" windlass --version)
echo "build.sh: installed $version" >&2

echo "$version" | awk '{print $2}'
