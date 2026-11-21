#!/bin/sh
# From server/: ../scripts/locked.sh ../sandbox/harness/build.sh claude [<sandbox image>]
# WLP_HARNESS_TAG overrides the local dev tag. Print the resulting immutable image ID.
set -eu
harness=${1:?usage: build.sh claude [<sandbox image>]}
case "$harness" in
    claude|opencode) ;;
    *) echo "Unknown harness: $harness" >&2; exit 2 ;;
esac
base=${2:-windlass-platform-sandbox:latest}
# BuildKit's FROM needs a name. Resolve a runner's bare local ID to its Docker reference.
case "$base" in
    sha256:*) base=$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{index .RepoTags 0}}{{end}}' "$base") ;;
esac
image="windlass-platform-$harness:${WLP_HARNESS_TAG:-dev}"
docker build --build-arg "SANDBOX_IMAGE=$base" --tag "$image" "$(dirname "$0")/$harness" >&2
docker image inspect --format '{{.Id}}' "$image"
