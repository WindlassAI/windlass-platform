#!/usr/bin/env bash
# Reboot for pending updates only when the host asks for one and no agent sandbox is active.
# Run as root by windlass-reboot.timer (see README, "Weekly conditional reboot"). Order: is a reboot
# required, is nothing running, take the backup, check again, reboot. Any failed step skips the reboot
# until the next week. --dry-run makes every check and reports, without the backup or the reboot.
set -euo pipefail
dry=0
case ${1:-} in
  --dry-run) dry=1 ;;
  '') ;;
  *) echo "usage: reboot-if-required.sh [--dry-run]" >&2; exit 2 ;;
esac
required=${WLP_REBOOT_REQUIRED_FILE:-/var/run/reboot-required}
runner=${WLP_RUNNER_CONTAINER:-windlass-runner}
backup=${WLP_REBOOT_BACKUP:?set WLP_REBOOT_BACKUP to the backup command}
backup_user=${WLP_REBOOT_BACKUP_USER:?set WLP_REBOOT_BACKUP_USER to the user that runs the backup}
wait_minutes=${WLP_REBOOT_WAIT_MINUTES:-90}
poll_seconds=${WLP_REBOOT_POLL_SECONDS:-300}
[[ $wait_minutes =~ ^[0-9]+$ && $poll_seconds =~ ^[1-9][0-9]*$ ]] || { echo "WLP_REBOOT_WAIT_MINUTES and WLP_REBOOT_POLL_SECONDS must be whole numbers" >&2; exit 2; }
say() { echo "reboot-if-required: $*"; }

if [[ ! -e $required ]]; then say "no reboot required"; exit 0; fi
say "reboot required by: $(tr '\n' ' ' < "$required.pkgs" 2>/dev/null || echo unknown)"

# Busy when the runner reports a sandbox in the running state (a turn, or one not yet suspended
# after its last turn), when any session container on this daemon runs (hosted Docker sessions
# too), or while apt is upgrading. A runner that cannot report counts as busy.
busy() {
  local status sessions unit
  if ! status=$(docker exec "$runner" windlass-runner status 2>&1); then
    say "the runner did not report its status"; return 0
  fi
  # Sandbox lines are "  <id>  <session>  running|paused".
  if grep -Eq '^  [^ ]+  [^ ]+  running$' <<< "$status"; then
    say "the runner has a running sandbox"; return 0
  fi
  if ! sessions=$(docker ps -q --filter label=dev.windlass-platform.session --filter status=running); then
    say "docker ps failed"; return 0
  fi
  if [[ -n $sessions ]]; then say "a session container is running"; return 0; fi
  for unit in apt-daily.service apt-daily-upgrade.service; do
    if systemctl is-active --quiet "$unit"; then say "$unit is running"; return 0; fi
  done
  return 1
}

wait_idle() {
  local deadline=$((SECONDS + wait_minutes * 60))
  while busy; do
    if (( SECONDS + poll_seconds > deadline )); then say "still busy after $wait_minutes min, skipping until next week"; return 1; fi
    sleep "$poll_seconds"
  done
}

wait_idle || exit 0
if (( dry )); then say "idle; would back up with $backup as $backup_user, check again and reboot"; exit 0; fi
say "idle; backing up"
home=$(getent passwd "$backup_user" | cut -d: -f6)
runuser -u "$backup_user" -- env HOME="$home" "$backup" || { say "backup failed, not rebooting"; exit 1; }
# The backup restarted the platform; a turn may have started meanwhile.
wait_idle || exit 0
say "rebooting"
systemctl reboot
