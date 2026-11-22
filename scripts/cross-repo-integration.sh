#!/usr/bin/env bash
# The combined run of a feature over the Windlass CLI and this platform (docs/factory, "Cross-repo
# features"): the CLI built from its checkout, staged where the server takes it from, and driven by the
# platform's own checks with that executable. Run in the platform's checkout, with the CLI's checkout at
# $WLP_INPUT_CLI (.github/workflows/windlass-integration.yml sets it):
#
#   WLP_INPUT_CLI=/path/to/windlass bash scripts/cross-repo-integration.sh
#
# It needs bun (the CLI's toolchain), node and pnpm, and x86-64 or arm64 Linux. It fails when a required
# case skipped, so a missing executable can never pass as a tested one.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="${WLP_INPUT_CLI:?WLP_INPUT_CLI names the Windlass CLI checkout}"
case "$(uname -m)" in x86_64) target=x64 docker=amd64 ;; aarch64 | arm64) target=arm64 docker=arm64 ;; *) echo "unsupported machine $(uname -m)" >&2; exit 1 ;; esac
build="$(mktemp -d)"
logs="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

step() { printf '\n== %s\n' "$*"; }

step "1. Build the CLI at $(git -C "$cli" rev-parse HEAD) for linux-$target"
(cd "$cli" && bun install --frozen-lockfile >/dev/null && bun scripts/build.ts --target "linux-$target" --out "$build")
binary="$build/windlass-linux-$target"
[ -x "$binary" ] || { echo "the build left no $binary" >&2; exit 1; }
digest="$(sha256sum "$binary" | cut -d' ' -f1)"
version="$("$binary" --version)"
short="$(git -C "$cli" rev-parse --short=7 HEAD)"
echo "built $binary: $version, sha256 $digest"
case "$version" in *"$short"*) ;; *) echo "the build's version ($version) does not name the CLI's commit $short" >&2; exit 1 ;; esac

step "2. Stage it where the server takes it from"
rm -f "$here/server/vendor/windlass-linux-amd64" "$here/server/vendor/windlass-linux-arm64"
WINDLASS_BUILDS="$build" "$here/server/stage-windlass.sh"
staged="$here/server/vendor/windlass-linux-$docker"
[ "$(sha256sum "$staged" | cut -d' ' -f1)" = "$digest" ] || { echo "the staged executable is not the one built" >&2; exit 1; }
export WLP_WINDLASS_BIN="$staged"
echo "WLP_WINDLASS_BIN=$staged; linux-$([ "$target" = x64 ] && echo arm64 || echo x64) is not tested by this run"

step "3. The platform's dependencies"
(cd "$here" && pnpm install --frozen-lockfile >/dev/null)

# Each case must run against the staged executable: a skip is a failure here.
required() {
	local name="$1"; shift
	step "4. $name"
	(cd "$here/server" && "$@") 2>&1 | tee "$logs/$name.log"
	if grep -qi 'no Windlass executable' "$logs/$name.log"; then echo "required case $name skipped" >&2; exit 1; fi
}
required models npx tsx ../scripts/models-check.ts
required signin env WLP_CHECK_SECTIONS=windlass npx tsx ../scripts/signin-check.ts

step "Passed: the platform at $(git -C "$here" rev-parse HEAD) with the CLI at $(git -C "$cli" rev-parse HEAD) (sha256 $digest)"
