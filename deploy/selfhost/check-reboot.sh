#!/usr/bin/env bash
# Exercise reboot-if-required.sh against stand-in docker, systemctl and runuser commands.
# Nothing here reaches Docker, systemd or a real reboot.
set -euo pipefail
kit=$(cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/bin"
cat > "$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE/log"
if [[ $1 == exec ]]; then
  n=$(( $(cat "$FAKE/polls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE/polls"
  [[ -f $FAKE/status-fails ]] && exit 1
  echo "Runner 0.2.0, protocol 2. Online"
  echo "m_aaaaaaaaaaaaaaaa"
  if [[ -f $FAKE/busy-polls ]] && (( n <= $(cat "$FAKE/busy-polls") )); then state=running; else state=paused; fi
  echo "  mm_aaaa-0123456789ab  s_one  $state"
  echo "  Data volume wlp-machine-m_aaaaaaaaaaaaaaaa"
elif [[ $1 == ps ]]; then
  cat "$FAKE/sessions" 2>/dev/null || true
fi
EOF
cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE/log"
if [[ $1 == is-active ]]; then [[ -f $FAKE/active-${*: -1} ]]; fi
EOF
cat > "$work/bin/runuser" <<'EOF'
#!/usr/bin/env bash
[[ $1 == -u && $3 == -- ]] || exit 9
echo "runuser $2" >> "$FAKE/log"
shift 3; exec "$@"
EOF
cat > "$work/backup" <<'EOF'
#!/usr/bin/env bash
echo backup >> "$FAKE/log"
[[ ! -f $FAKE/backup-fails ]]
EOF
chmod +x "$work/bin/"* "$work/backup"

failures=0 me=$(id -un)
fail() { echo "FAIL $*" >&2; failures=$((failures + 1)); }
# scenario <name> <exit> <events> [flag file | file=content ...] [-- script args]
scenario() {
  local name=$1 code=$2 want=$3 got; shift 3
  export FAKE="$work/$name"
  mkdir "$FAKE"; : > "$FAKE/log"
  local args=()
  while (( $# )); do
    if [[ $1 == -- ]]; then shift; args=("$@"); break; fi
    if [[ $1 == *=* ]]; then printf '%s\n' "${1#*=}" > "$FAKE/${1%%=*}"; else touch "$FAKE/$1"; fi
    shift
  done
  set +e
  PATH="$work/bin:$PATH" WLP_REBOOT_REQUIRED_FILE="$FAKE/reboot-required" WLP_REBOOT_BACKUP="$work/backup" \
    WLP_REBOOT_BACKUP_USER="$me" WLP_REBOOT_WAIT_MINUTES=0 WLP_REBOOT_POLL_SECONDS=1 \
    "$kit/reboot-if-required.sh" "${args[@]}" > "$FAKE/out" 2>&1
  got=$?
  set -e
  (( got == code )) || fail "$name: exit $got, expected $code"
  # The log's events, in order, on one line.
  local events
  events=$(grep -Eo '^(backup|runuser [a-z_][a-z0-9_-]*|systemctl reboot)' "$FAKE/log" | paste -sd, - || true)
  [[ $events == "$want" ]] || fail "$name: events '$events', expected '$want'"
}

scenario not-required 0 ''
scenario idle 0 "runuser $me,backup,systemctl reboot" reboot-required
scenario dry-run 0 '' reboot-required -- --dry-run
scenario runner-busy 0 '' reboot-required busy-polls=99
scenario runner-silent 0 '' reboot-required status-fails
scenario hosted-session 0 '' reboot-required sessions=c0ffee
scenario apt-upgrading 0 '' reboot-required active-apt-daily-upgrade.service
scenario backup-fails 1 "runuser $me,backup" reboot-required backup-fails
# Busy on the first two polls, idle by the third, within a three-minute wait.
waits() {
  export FAKE="$work/waits"; mkdir "$FAKE"; : > "$FAKE/log"; touch "$FAKE/reboot-required"; echo 2 > "$FAKE/busy-polls"
  PATH="$work/bin:$PATH" WLP_REBOOT_REQUIRED_FILE="$FAKE/reboot-required" WLP_REBOOT_BACKUP="$work/backup" \
    WLP_REBOOT_BACKUP_USER="$me" WLP_REBOOT_WAIT_MINUTES=3 WLP_REBOOT_POLL_SECONDS=1 \
    "$kit/reboot-if-required.sh" > "$FAKE/out" 2>&1 || fail "waits: nonzero exit"
  [[ $(grep -Eo '^(backup|systemctl reboot)' "$FAKE/log" | paste -sd, -) == 'backup,systemctl reboot' ]] || fail "waits: did not reboot once idle"
  [[ $(cat "$FAKE/polls") == 4 ]] || fail "waits: expected 4 status polls (3 before the backup, 1 after), got $(cat "$FAKE/polls")"
}
waits
if env -u WLP_REBOOT_BACKUP WLP_REBOOT_REQUIRED_FILE=/nonexistent "$kit/reboot-if-required.sh" >/dev/null 2>&1; then
  fail "ran without a backup command"
fi
(( failures == 0 )) || exit 1
echo "PASS reboot only when required and idle, after a backup; busy, silent runner, sessions, apt and a failed backup skip it"
