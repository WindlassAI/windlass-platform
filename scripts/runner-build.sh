#!/bin/sh
# A local build prints its image ID. WLP_RUNNER_PLATFORMS exports an OCI archive.
# WLP_RUNNER_PUSH is the versioned registry tag. Its four sibling pins must be
# registry references; the second tag uses the source commit.
set -eu
cd "$(dirname "$0")/.."
screenshots=false
if [ "${1:-}" = --screenshots ]; then screenshots=true; shift; fi
push=${WLP_RUNNER_PUSH:-}
version=${WLP_RELEASE_VERSION:-}
if [ -n "$push" ]; then
  case "${1:-}" in *@sha256:*) ;; *) echo "Runner publication requires a registry sandbox pin (name@sha256:digest)." >&2; exit 2 ;; esac
  case "${2:-}" in *@sha256:*) ;; *) echo "Runner publication requires a registry screenshots pin." >&2; exit 2 ;; esac
  [ "$screenshots" = true ] || { echo "Runner publication requires --screenshots." >&2; exit 2; }
fi
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
      [ -z "$push" ] || { echo "Runner publication requires a registry pin for $harness." >&2; exit 2; }
      id=$(sandbox/harness/build.sh "$harness" "$pin")
      set -- "$@" "$harness=$id" ;;
  esac
done
node runner/bundle.mjs "$pin" "$context/runner.cjs" "$@"
if [ -n "$push" ] || [ -n "${WLP_RUNNER_RELEASE_DIR:-}" ]; then
  node scripts/release-check.ts scan "$context/runner.cjs"
fi
if [ -n "${WLP_RUNNER_RELEASE_DIR:-}" ]; then
  mkdir -p "$WLP_RUNNER_RELEASE_DIR"
  cp "$context/runner.cjs" "$context/sandbox-layout.json" "$WLP_RUNNER_RELEASE_DIR/"
fi
if [ -n "$push" ]; then
  node scripts/release-check.ts pins "$context/runner.cjs"
  version=${push##*:runner-v}
  tag=$(node scripts/release-check.ts tag "$version")
  [ "$push" = "${push%:*}:$tag" ] || { echo "Use a runner-v<version> publication tag." >&2; exit 2; }
  short=$(git rev-parse HEAD | cut -c1-12)
  set -- --push --platform linux/amd64,linux/arm64 --tag "$push" --tag "${push%:*}:sha-$short" --metadata-file "$context/metadata.json"
elif [ -n "${WLP_RUNNER_PLATFORMS:-}" ]; then
  archive=${WLP_RUNNER_ARCHIVE:-$(mktemp ./windlass-runner.XXXXXX.tar)}
  set -- --platform "$WLP_RUNNER_PLATFORMS" --output "type=oci,dest=$archive"
else
  set -- --load --iidfile "$context/image-id"
  if [ -n "${WLP_RUNNER_BUILD_TAG:-}" ]; then set -- "$@" --tag "$WLP_RUNNER_BUILD_TAG"; fi
fi
if [ -n "$push" ] || [ -n "${WLP_RUNNER_RELEASE_DIR:-}" ]; then
  revision=$(git rev-parse HEAD)
  : "${version:?set WLP_RELEASE_VERSION for a dry run}"
  set -- "$@" --provenance mode=max --sbom=true --annotation "index:org.opencontainers.image.description=Windlass machine runner"
  for field in "source=https://github.com/WindlassAI/windlass-platform" "revision=$revision" "version=$version" "licenses=MIT"; do
    set -- "$@" --label "org.opencontainers.image.$field" --annotation "index:org.opencontainers.image.$field"
  done
fi
docker buildx build "$@" --file runner/Dockerfile --label dev.windlass-platform=1 "$context" >&2
if [ -n "$push" ]; then
  jq -er '."containerimage.digest" | select(test("^sha256:[0-9a-f]{64}$"))' "$context/metadata.json"
elif [ -n "${WLP_RUNNER_PLATFORMS:-}" ]; then echo "$archive"; else cat "$context/image-id"; fi
