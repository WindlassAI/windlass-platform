#!/bin/sh
# Fetches the released Windlass executables the platform runs, and prints the directory they are in.
#
#   sandbox/fetch-windlass.sh            both Linux executables of the pinned release
#
# The releases are pinned here, by tag and by the SHA-256 of each file: a file that does not match is
# removed and the script fails, so a changed or replaced release is not installed. To move to another
# release, change RELEASE and its two sums (they are in the release's SHA256SUMS; check them
# against a build you trust). Files that are there and match are not fetched again.
#
#   WINDLASS_RELEASE_DIR=<directory>     where they are kept (default ~/.cache/windlass-platform/windlass-<tag>;
#                                        a directory holds one release)
#
# sandbox/build.sh, sandbox/e2b/build.sh and server/stage-windlass.sh take their Windlass from here
# unless they are told otherwise (WINDLASS_BINARY, WINDLASS_BUILDS): a build of your own is for trying a
# Windlass that is not released yet.
set -eu

[ "$#" -eq 0 ] || { echo "usage: fetch-windlass.sh" >&2; exit 2; }
RELEASE=v0.7.1
SUM_x64=559fc5807686fcd7e0dc9e89540d0d3d76120c3f7569e63d050c29c7ca8d0504
SUM_arm64=88984c11d4c1f01fe5223b8d5987dbad85f8f0497b53d6b6a5640f642efe9fa9
BASE="https://github.com/WindlassAI/windlass/releases/download/$RELEASE"

dir="${WINDLASS_RELEASE_DIR:-$HOME/.cache/windlass-platform/windlass-$RELEASE}"
mkdir -p "$dir"

sum_of() { sha256sum "$1" | cut -d' ' -f1; }

part=
trap '[ -z "$part" ] || rm -f "$part"' EXIT
for arch in x64 arm64; do
  file="$dir/windlass-linux-$arch"
  eval "want=\$SUM_$arch"
  if [ -f "$file" ] && [ "$(sum_of "$file")" = "$want" ]; then continue; fi
  echo "fetch-windlass.sh: fetching Windlass $RELEASE for linux-$arch" >&2
  part=$(mktemp "$dir/.windlass-$arch.XXXXXX")
  curl --fail --silent --show-error --location --output "$part" "$BASE/windlass-linux-$arch"
  got=$(sum_of "$part")
  if [ "$got" != "$want" ]; then
    rm -f "$part"
    echo "fetch-windlass.sh: windlass-linux-$arch of $RELEASE has SHA-256 $got, not the pinned $want; nothing was installed" >&2
    exit 1
  fi
  chmod 0755 "$part"
  mv "$part" "$file"
  part=
done
echo "$dir"
