#!/bin/sh
# Fetches the released Windlass executables the platform runs, and prints the directory they are in.
#
#   sandbox/fetch-windlass.sh            both Linux executables of the pinned release
#
# The release is pinned here, by tag and by the SHA-256 of each file: a file that does not match is
# removed and the script fails, so a changed or replaced release is not installed. To move to another
# release, change RELEASE and the two sums (they are in the release's SHA256SUMS; check them against a
# build you trust). Files that are there and match are not fetched again.
#
#   WINDLASS_RELEASE_DIR=<directory>     where they are kept (default ~/.cache/windlass-platform/windlass-<tag>)
#
# sandbox/build.sh, sandbox/e2b/build.sh and server/stage-windlass.sh take their Windlass from here
# unless they are told otherwise (WINDLASS_BINARY, WINDLASS_BUILDS): a build of your own is for trying a
# Windlass that is not released yet.
set -eu

RELEASE=v0.2.0
SUM_x64=e68d84315e542592678b41a65f9357b7ccecface9b6ab49874b7abda3628994e
SUM_arm64=123dab0622134edf42a55322c59b33a6d685d3cff1c5d4eeb13e740eb344d56f
BASE="https://github.com/parthg1901/windlass/releases/download/$RELEASE"

dir="${WINDLASS_RELEASE_DIR:-$HOME/.cache/windlass-platform/windlass-$RELEASE}"
mkdir -p "$dir"

sum_of() { sha256sum "$1" | cut -d' ' -f1; }

for arch in x64 arm64; do
  file="$dir/windlass-linux-$arch"
  eval "want=\$SUM_$arch"
  if [ -f "$file" ] && [ "$(sum_of "$file")" = "$want" ]; then continue; fi
  echo "fetch-windlass.sh: fetching Windlass $RELEASE for linux-$arch" >&2
  curl --fail --silent --show-error --location --output "$file.part" "$BASE/windlass-linux-$arch"
  got=$(sum_of "$file.part")
  if [ "$got" != "$want" ]; then
    rm -f "$file.part"
    echo "fetch-windlass.sh: windlass-linux-$arch of $RELEASE has SHA-256 $got, not the pinned $want; nothing was installed" >&2
    exit 1
  fi
  chmod 0755 "$file.part"
  mv "$file.part" "$file"
done
echo "$dir"
