#!/bin/sh
# From server/, take the exclusive Docker lock when running by hand: ../scripts/locked.sh ../scripts/runner-build.sh
# A local immutable image ID works for development. For a release pass registry/repo@sha256:...
# WLP_RUNNER_HARNESSES is a space-separated list, e.g. claude. For a release,
# claude=registry/repo@sha256:... uses an already published harness image.
# WLP_RUNNER_PLATFORMS=linux/amd64,linux/arm64 writes an OCI archive instead of loading one platform.
set -eu
cd "$(dirname "$0")/.."
pin=${1:-$(docker image inspect windlass-platform-sandbox:latest --format '{{.Id}}')}
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
set --
set -f
for harness in ${WLP_RUNNER_HARNESSES:-}; do
  case "$harness" in
    claude=*@sha256:*) set -- "$@" "$harness" ;;
    *)
      image=$(sandbox/harness/build.sh "$harness" "$pin")
      set -- "$@" "$harness=$image" ;;
  esac
done
node runner/bundle.mjs "$pin" "$context/runner.cjs" "$@"
if [ -n "${WLP_RUNNER_PLATFORMS:-}" ]; then
  set -- --platform "$WLP_RUNNER_PLATFORMS" --output "type=oci,dest=${WLP_RUNNER_ARCHIVE:-windlass-runner.tar}"
else
  set -- --load
fi
docker buildx build "$@" --file runner/Dockerfile --tag windlass-runner:dev "$context"
