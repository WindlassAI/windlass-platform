#!/bin/sh
# From server/: ../scripts/locked.sh <check>.ts [args] or ../scripts/locked.sh ../sandbox/build.sh
set -eu
slots=${WLP_CHECK_SLOTS:-3}
max=${WLP_CHECK_MAX:-4}
for count in "$slots" "$max"; do
    case "$count" in
        0*|*[!0-9]*) echo "WLP_CHECK_SLOTS and WLP_CHECK_MAX must be positive decimal integers" >&2; exit 2 ;;
    esac
    if ! [ "$count" -gt 0 ] 2>/dev/null; then echo "Check slot count is out of range" >&2; exit 2; fi
done
# The last companion port is 7030. Slot 58 is the last that fits in a TCP port.
if [ "$slots" -gt 59 ]; then echo "WLP_CHECK_SLOTS must be at most 59" >&2; exit 2; fi

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
    connection-e2e) ports=6420 ;;
    signin-check)
        ports=6420
        # Its two nodes need the same signing key. Avoid creating a shared .data/secret.
        if [ -z "${WLP_SECRET:-}" ]; then
            read -r WLP_SECRET < /proc/sys/kernel/random/uuid
            export WLP_SECRET
        fi ;;
    idempotency-check) ports=6460 ;;
    factory-e2e) ports=6620 ;;
    http-limits-check) ports=3710 ;;
    webhook-check)
        ports=3410
        # Slot three's engine companion would use 6420, the e2e group's engine port.
        if [ "$slots" -gt 3 ]; then slots=3; fi ;;
    runner-socket-probe) ports=6740 ;;
    machine-check) ports=6850; slots=1 ;;
    runner-check) ports=6900; docker=-s ;; # Its 7020 stub belongs to this check too.
    runner-e2e) ports=6950 ;;
    mcp-check) docker=-s ;;
    verified-check|github-check|backup-check|e2b-provider-test|shot-check) docker=$with_docker ;;
    # Lock hand-run builds and cleanup here. As children of a check they already run under its lock.
    sandbox-check|build.sh|runner-build.sh|cleanup.sh) docker=-x ;;
esac

case "$name" in
    *.sh) set -- "$script" "$@" ;;
    connection-e2e) set -- npx tsx --tsconfig ../web/tsconfig.json "../scripts/$name.ts" "$@" ;;
    *) set -- npx tsx "../scripts/$name.ts" "$@" ;;
esac

if [ -n "$ports" ]; then
    slot=0
    while :; do
        # Slot zero uses the original group's inode, including across old and new checkouts.
        lock=/tmp/wlp-ports-$ports.lock
        if [ "$slot" -ne 0 ]; then lock=/tmp/wlp-ports-$ports-$slot.lock; fi
        exec 3>>"$lock"
        if flock -n -E 75 3; then break; else status=$?; fi
        [ "$status" -eq 75 ] || exit "$status"
        slot=$((slot + 1))
        if [ "$slot" -eq "$slots" ]; then slot=0; sleep 0.2; fi
    done
    export WLP_CHECK_PORT_OFFSET=$((slot * 1000))
fi
if [ -n "$docker" ]; then
    exec 4>>/tmp/wlp-docker.lock
    # A waiting flock must not keep earlier locks if the shell is interrupted.
    flock "$docker" 4 3>&-
fi

# Old callers take this file exclusively. Keep it shared for the whole check.
set -- flock -F -s /tmp/wlp-test.lock "$@"

# Only one machine-check can get its port lock. Take every cap slot in order
# before starting it, including slots already in use by the previous helper.
if [ "$name" = machine-check ]; then
    slot=$max
    while [ "$slot" -gt 0 ]; do
        set -- flock -F -x "/tmp/wlp-slot-$slot.lock" "$@"
        slot=$((slot - 1))
    done
    exec "$@"
fi

# Wait for a port or Docker before taking one slot toward the host-wide cap.
slot=1
while :; do
    exec 5>>"/tmp/wlp-slot-$slot.lock"
    if flock -w 0.1 -E 75 5 3>&- 4>&-; then
        break
    else
        status=$?
        [ "$status" -eq 75 ] || exit "$status"
    fi
    slot=$((slot % max + 1))
done

exec "$@"
