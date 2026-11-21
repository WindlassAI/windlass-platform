#!/bin/sh
# From server/, run ../scripts/runner-build.sh to build and print the local runner image ID.
# A local immutable image ID works for development. For a release pass registry/repo@sha256:...
# WLP_RUNNER_HARNESSES is a space-separated list, e.g. claude. For a release,
# claude=registry/repo@sha256:... uses an already published harness image.
# WLP_RUNNER_PLATFORMS=linux/amd64,linux/arm64 writes an OCI archive instead of loading one platform.
set -eu
cd "$(dirname "$0")/.."
# --screenshots pins both images so personal sessions can still use the base.
screenshots=false
if [ "${1:-}" = --screenshots ]; then screenshots=true; shift; fi
pin=${1:-$(docker image inspect "${WLP_SANDBOX_IMAGE:-windlass-platform-sandbox:latest}" --format '{{.Id}}')}
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
if [ "$screenshots" = true ]; then
  shots=${2:-$(docker image inspect "${WLP_SANDBOX_SHOTS_IMAGE:-windlass-platform-sandbox:shots}" --format '{{.Id}}')}
  set -- "$shots"
else
  set --
fi
set -f
for harness in ${WLP_RUNNER_HARNESSES:-}; do
  case "$harness" in
    claude=*@sha256:*|opencode=*@sha256:*) set -- "$@" "$harness" ;;
    *)
      image=$(sandbox/harness/build.sh "$harness" "$pin")
      set -- "$@" "$harness=$image" ;;
  esac
done
node runner/bundle.mjs "$pin" "$context/runner.cjs" "$@"
if [ -n "${WLP_RUNNER_PLATFORMS:-}" ]; then
  archive=${WLP_RUNNER_ARCHIVE:-$(mktemp ./windlass-runner.XXXXXX.tar)}
  set -- --platform "$WLP_RUNNER_PLATFORMS" --output "type=oci,dest=$archive"
else
  set -- --load --iidfile "$context/image-id"
  if [ -n "${WLP_RUNNER_BUILD_TAG:-}" ]; then set -- "$@" --tag "$WLP_RUNNER_BUILD_TAG"; fi
fi
docker buildx build "$@" --file runner/Dockerfile --label dev.windlass-platform=1 "$context"
if [ -n "${WLP_RUNNER_PLATFORMS:-}" ]; then echo "$archive"; else cat "$context/image-id"; fi
