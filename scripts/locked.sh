#!/bin/sh
# From server/: ../scripts/locked.sh <check>.ts [args] or ../scripts/locked.sh ../sandbox/build.sh
set -eu
slots=3

script=${1:?usage: locked.sh <script> [args...]}
shift
name=${script##*/}
name=${name%.ts}
ports=
docker=
with_docker=
endpoint=
previous=
for arg do
    if [ "$arg" = --docker ]; then with_docker=-s; fi
    if [ "$previous" = --endpoint ]; then endpoint=1; fi
    previous=$arg
done

case "$name" in
    e2e)
        if [ -z "$endpoint" ]; then ports=6420; fi
        if [ "${WLP_SANDBOX:-fake}" = docker ]; then docker=-s; fi ;;
    connection-e2e|signin-check) ports=6420 ;;
    idempotency-check) ports=6460 ;;
    factory-e2e) ports=6620 ;;
    runner-socket-probe) ports=6740 ;;
    machine-check) ports=6850 ;;
    runner-check) ports=6900; docker=-s ;; # Its 7020 stub belongs to this check too.
    runner-e2e) ports=6950 ;;
    mcp-check) docker=-s ;;
    verified-check|github-check|backup-check|e2b-provider-test) docker=$with_docker ;;
    # Lock hand-run builds and cleanup here. As children of a check they already run under its lock.
    sandbox-check|build.sh|runner-build.sh|cleanup.sh) docker=-x ;;
esac

case "$name" in
    *.sh) set -- "$script" "$@" ;;
    connection-e2e) set -- npx tsx --tsconfig ../web/tsconfig.json "../scripts/$name.ts" "$@" ;;
    *) set -- npx tsx "../scripts/$name.ts" "$@" ;;
esac

if [ -n "$ports" ]; then
    exec 3>>"/tmp/wlp-ports-$ports.lock"
    flock -x 3
fi
if [ -n "$docker" ]; then
    exec 4>>/tmp/wlp-docker.lock
    # A waiting flock must not keep earlier locks if the shell is interrupted.
    flock "$docker" 4 3>&-
fi

# Wait for a port or Docker before taking a slot. A short wait per slot avoids spinning.
slot=1
while :; do
    exec 5>>"/tmp/wlp-slot-$slot.lock"
    if flock -w 0.1 -E 75 5 3>&- 4>&-; then
        break
    else
        status=$?
        [ "$status" -eq 75 ] || exit "$status"
    fi
    slot=$((slot % slots + 1))
done

# Old callers take this file exclusively. A shared lock keeps them out for the whole
# check, while helper callers in different groups can still run together.
exec flock -F -s /tmp/wlp-test.lock "$@"
