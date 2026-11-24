#!/bin/sh
# Builds an E2B template sessions' sandboxes are made from, `windlass-platform-sandbox` (small), from the same
# Dockerfile and helpers as the Docker image (sandbox/Dockerfile, wlp-run, wlp-pnpm and, for shots, wlp-shot) and the x86_64
# Windlass. It is to E2B what sandbox/build.sh is to Docker.
#
#   E2B_API_KEY=e2b_... sandbox/e2b/build.sh       build it at E2B (uses the account: a template build,
#                                                  no sandbox afterwards)
#   sandbox/e2b/build.sh --print                   print what E2B would be asked to build; talks to nobody
#                                                  and needs no key
#
#   WINDLASS_BINARY=/path/to/windlass-linux-x64    the executable to put in it (default: the released
#                                                  Windlass that sandbox/fetch-windlass.sh pins and
#                                                  fetches; sandbox/e2b/build-windlass-x64.sh makes one
#                                                  from a local checkout, for a Windlass not released yet)
#   WLP_SANDBOX_VARIANT=shots                     build the screenshots template (default variant: base)
#   WLP_E2B_SIZE=small|standard|large              the size (default small): 1 vCPU and 1 GiB, 2 and 4 GiB,
#                                                  4 and 8 GiB. E2B sets a sandbox's size when its template
#                                                  is built, so each size is a template of its own:
#                                                  windlass-platform-sandbox, -standard, -large (each with
#                                                  -shots for the screenshots variant). The server offers a
#                                                  size once WLP_E2B_SIZES lists it.
#   WLP_E2B_TEMPLATE=<name>                        another name than windlass-platform-sandbox for small;
#                                                  WLP_E2B_TEMPLATE_STANDARD, _LARGE for the others, and
#                                                  WLP_E2B_SHOTS_TEMPLATE[_STANDARD|_LARGE] for shots. The
#                                                  server reads the same variables
#   WLP_E2B_CPU, WLP_E2B_MEMORY_MB                 override the size's figures, for a test build under
#                                                  another name only: the server prices a size at its own
#
# E2B's microVMs are x86_64 whatever this machine is, so an executable for another machine is refused
# here and not at the first turn.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

# Harness templates reuse the published amd64 Docker image, including its pinned adapter.
if [ -n "${WLP_E2B_HARNESS:-}" ]; then
  : "${WLP_E2B_HARNESS_IMAGE:?set the published amd64 harness image reference}"
  cd "$repo/server"
  exec npx tsx ../scripts/e2b-template.ts "$@"
fi

binary="${WINDLASS_BINARY:-}"
if [ -z "$binary" ]; then
  binary="$("$here/../fetch-windlass.sh")/windlass-linux-x64"
fi
if [ ! -f "$binary" ]; then
  echo "build.sh: no x86_64 Windlass at $binary; set WINDLASS_BINARY to one, or leave it unset for the released one" >&2
  exit 1
fi
# The two bytes at offset 18 of an ELF file name the machine: 3e 00 is x86-64.
machine=$(od -An -tx1 -j18 -N2 "$binary" | tr -d ' \n')
if [ "$machine" != "3e00" ]; then
  echo "build.sh: $binary is not an x86_64 executable (ELF machine $machine); E2B runs x86_64 only" >&2
  exit 1
fi

# The same small build context as sandbox/build.sh makes for Docker.
context=$(mktemp -d "${TMPDIR:-/tmp}/wlp-e2b-build.XXXXXX")
trap 'rm -rf "$context"' EXIT INT TERM
cp "$here/../Dockerfile" "$here/../wlp-run" "$here/../wlp-pnpm" "$context/"
if [ "${WLP_SANDBOX_VARIANT:-base}" = shots ]; then cp "$here/../wlp-shot" "$context/"; fi
ln "$binary" "$context/windlass" 2>/dev/null || cp "$binary" "$context/windlass"

echo "build.sh: the E2B template, with $binary" >&2
cd "$repo/server"
npx tsx ../scripts/e2b-template.ts "$context" "$@"
