#!/bin/sh
# Compatibility entry point for checks invoked from server/.
set -eu
script=${1:?usage: locked.sh <script> [args...]}
shift
case "$script" in
    *.sh) exec "$script" "$@" ;;
esac
name=${script##*/}
exec npx tsx "../scripts/${name%.ts}.ts" "$@"
