#!/bin/sh
# Builds the x86_64 Windlass that E2B's microVMs need, from a local Windlass checkout, and writes
# nothing into that checkout.
#
#   git clone --branch v0.7.1 https://github.com/WindlassAI/windlass.git ../windlass
#   sandbox/e2b/build-windlass-x64.sh
#   WINDLASS_SOURCE=<checkout> WINDLASS_OUT=<directory> sandbox/e2b/build-windlass-x64.sh
#
# E2B runs x86_64 only, and the local build the Docker image uses is this machine's (arm64 here).
# Windlass's own build script cross-compiles: `bun scripts/build.ts --target linux-x64`. Three things
# keep the checkout untouched:
#
#   - it is run from an empty directory outside the checkout, so whatever Bun writes beside the
#     command (its temporary files) lands there;
#   - `--out` names a directory outside the checkout, so `dist/` in it is not written;
#   - Bun's runtime for the other architecture comes from Bun's own cache in the home directory, which
#     Bun downloads once (the official Bun release of its own version).
#
# The checkout's `git status` (ignored files included) and commit are compared before and after, and the
# build is thrown away when they differ. The executable has no full-screen interface: that needs
# OpenTUI's native library for x86_64, which the checkout has not installed, and a sandbox never starts
# it (the platform runs `windlass acp` and `windlass login`). `windlass --version` says the same commit
# as the build it was made beside. Run twice, this script gives the same bytes; they differ from a build
# run inside the checkout, because the source map embedded in the executable names the sources relative
# to the directory the build ran in. The code is the same. It cannot be run on an arm64 machine; the
# first thing that runs it is the E2B template build.
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
src="${WINDLASS_SOURCE:-$root/../windlass}"
out="${WINDLASS_OUT:-$root/.data/windlass-builds}"
[ -f "$src/scripts/build.ts" ] || { echo "build-windlass-x64.sh: $src is not a Windlass checkout (no scripts/build.ts); set WINDLASS_SOURCE" >&2; exit 1; }
src=$(cd "$src" && pwd)  # The build runs from a temporary directory.
command -v bun >/dev/null 2>&1 || { echo "build-windlass-x64.sh: bun is not installed" >&2; exit 1; }

state() { (cd "$src" && git rev-parse HEAD && git status --porcelain --ignored); }

work=$(mktemp -d "${TMPDIR:-/tmp}/wlp-windlass-x64.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
mkdir "$work/cwd" "$work/out"

before=$(state)
(cd "$work/cwd" && bun "$src/scripts/build.ts" --target linux-x64 --out "$work/out") >&2
after=$(state)
if [ "$before" != "$after" ]; then
  echo "build-windlass-x64.sh: the build changed something in $src; nothing was installed. Its state before and after:" >&2
  printf '%s\n---\n%s\n' "$before" "$after" >&2
  exit 1
fi

built="$work/out/windlass-linux-x64"
# The two bytes at offset 18 of an ELF file name the machine: 3e 00 is x86-64.
machine=$(od -An -tx1 -j18 -N2 "$built" | tr -d ' \n')
[ "$machine" = "3e00" ] || { echo "build-windlass-x64.sh: the build is not an x86_64 executable (machine $machine)" >&2; exit 1; }

mkdir -p "$out"
install -m 0755 "$built" "$out/windlass-linux-x64"
echo "build-windlass-x64.sh: wrote $out/windlass-linux-x64 ($(wc -c < "$built") bytes, sha256 $(sha256sum "$built" | cut -d' ' -f1))" >&2
sed -n 's/.*"version": "\(.*\)",/\1/p' "$work/out/build-info.json"
