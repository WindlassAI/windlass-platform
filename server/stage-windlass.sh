#!/usr/bin/env bash
# Copies the locally built Windlass executables to server/vendor/, where server/Dockerfile takes the one
# for the image's architecture from. The server runs Windlass's sign-in commands with it.
#
#   server/stage-windlass.sh                 from ~/projects/windlass-local-builds
#   WINDLASS_BUILDS=/some/dir server/stage-windlass.sh
#
# The builds are windlass-linux-arm64 (`bun scripts/build.ts` in the Windlass repository) and
# windlass-linux-x64 (sandbox/e2b/build-windlass-x64.sh). server/vendor/ is not committed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
builds="${WINDLASS_BUILDS:-$HOME/projects/windlass-local-builds}"
mkdir -p "$here/vendor"

staged=0
# Docker names the architectures amd64 and arm64; the builds are named x64 and arm64.
for pair in x64:amd64 arm64:arm64; do
	from="$builds/windlass-linux-${pair%%:*}"
	to="$here/vendor/windlass-linux-${pair##*:}"
	if [ -f "$from" ]; then
		install -m 0755 "$from" "$to"
		echo "staged $to"
		staged=$((staged + 1))
	else
		echo "no build at $from: an image for ${pair##*:} cannot be built" >&2
	fi
done
[ "$staged" -gt 0 ] || { echo "No Windlass build found in $builds." >&2; exit 1; }
