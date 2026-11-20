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
RELEASE=v0.4.0
SUM_x64=89cd02784e86223c50670267dacd0f417dad7112b6876918ed56ca73a1215a4c
SUM_arm64=a511c3edaba0301d77d96d965552d42adf00a07ff750a720e3c1385b573ff35a
BASE="https://github.com/parthg1901/windlass/releases/download/$RELEASE"

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
