/**
 * E2B's template build puts its own base system under sandbox/Dockerfile: systemd, an OpenSSH server on port 22
 * that lets root in, rpcbind on 111, and the accounts `root` and `user` with empty passwords. From there any
 * command of the agent's can `ssh root@127.0.0.1` or `su` without a password, and every boundary between the
 * guest's users (the agent, `nobody` for git with its tokens) is gone. This script takes that away. It runs as
 * root on every create, resume and restart before anything of a session's runs (e2b/sandboxes.ts `harden`), and
 * once more at the end of every template build (template.ts), and it fails unless the guest ends up as wanted.
 *
 * In order: every account with an empty password, and root and `user` whatever theirs, is locked; sshd refuses
 * root, passwords and empty passwords should it ever run; the ssh and rpcbind units are stopped and masked; every
 * sshd process is killed with everything it started (a root shell an agent opened before this ran); then it checks
 * that nothing listens on port 22, no sshd runs and no account has an empty password, and prints `hardened`.
 * Otherwise it prints `refused <what>` and exits 1. Each step is idempotent; a guest that is done already costs
 * a few file reads. It needs no systemd (a container of the image has none) and no `ss`.
 */
export const GUEST_HARDENING_SCRIPT = `# wlp-guest-hardening
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
for name in root user $(awk -F: '$2 == "" { print $1 }' /etc/shadow /etc/passwd 2>/dev/null); do
  if id -u "$name" >/dev/null 2>&1; then passwd -l "$name" >/dev/null 2>&1 || usermod -L "$name" >/dev/null 2>&1; fi
done
config=/etc/ssh/sshd_config
if [ -f "$config" ] && ! grep -q '^# wlp-hardened' "$config"; then
  { printf '# wlp-hardened: the first value of each option counts\\nPermitRootLogin no\\nPasswordAuthentication no\\nPermitEmptyPasswords no\\nKbdInteractiveAuthentication no\\n'; cat "$config"; } > "$config.wlp" && chmod 644 "$config.wlp" && mv -f "$config.wlp" "$config"
fi
units="ssh.socket ssh.service sshd.socket sshd.service rpcbind.socket rpcbind.service"
systemd=no
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then systemd=yes; fi
masked=no
for unit in $units; do
  if [ "$systemd" = yes ] && [ "$(systemctl is-active "$unit" 2>/dev/null)" != inactive ]; then systemctl stop "$unit" >/dev/null 2>&1; fi
  if [ -d /etc/systemd/system ] && [ "$(readlink "/etc/systemd/system/$unit" 2>/dev/null)" != /dev/null ]; then
    ln -sfn /dev/null "/etc/systemd/system/$unit" && masked=yes
  fi
done
if [ "$systemd" = yes ] && [ "$masked" = yes ]; then systemctl daemon-reload >/dev/null 2>&1; fi
tree() { for pid in "$@"; do echo "$pid"; tree $(pgrep -P "$pid"); done; }
servers=$(pgrep -x 'sshd|sshd-session|sshd-auth|rpcbind')
if [ -n "$servers" ]; then kill -KILL $(tree $servers) 2>/dev/null; fi
listening() {
  for table in /proc/net/tcp /proc/net/tcp6; do
    if [ -r "$table" ] && awk 'FNR > 1 && $4 == "0A" && $2 ~ /:0016$/ { found = 1 } END { exit !found }' "$table"; then return 0; fi
  done
  return 1
}
tries=0
while { listening || pgrep -x 'sshd|sshd-session|sshd-auth' >/dev/null; } && [ "$tries" -lt 20 ]; do
  tries=$((tries + 1))
  sleep 0.1
done
if [ ! -r /proc/net/tcp ]; then echo "refused: /proc/net/tcp cannot be read"; exit 1; fi
if listening; then echo "refused: something still listens on port 22"; exit 1; fi
if pgrep -x 'sshd|sshd-session|sshd-auth' >/dev/null; then echo "refused: sshd still runs"; exit 1; fi
empty=$(awk -F: '$2 == "" { print $1 }' /etc/shadow /etc/passwd) || { echo "refused: the password files cannot be read"; exit 1; }
if [ -n "$empty" ]; then echo "refused: accounts with an empty password remain:" $empty; exit 1; fi
echo hardened
`;

/** The last line of a run of the script that left the guest as wanted. */
export const HARDENED = "hardened";
/** What marks the script in a command line: the fake machine answers it as a hardened guest would (fake.ts). */
export const HARDENING_MARK = "# wlp-guest-hardening";
