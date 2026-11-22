#!/usr/bin/env bash
# Check where a stack's env files are and who can read them, without printing any value.
# The stack env file and the server env file it selects must be regular mode-600 files of this
# user, in directories nobody else can enter, outside every Git checkout. For a stack without demo
# sign-in the resolved server configuration must also admit only listed users.
set -euo pipefail
kit=$(cd -- "$(dirname -- "$0")" && pwd)
stack=${1:?usage: check-env-files.sh stack.env}
failures=0
fail() { echo "FAIL $*" >&2; failures=$((failures + 1)); }
pass() { echo "PASS $*"; }

private() {
  local file=$1 dir
  [[ -f $file && ! -L $file ]] || { fail "$file is missing or not a regular file"; return; }
  [[ $(stat -c '%u %a' -- "$file") == "$(id -u) 600" ]] || fail "$file is not mode 600 and owned by $(id -un)"
  dir=$(cd -- "$(dirname -- "$file")" && pwd)
  [[ $(stat -c '%u' -- "$dir") == "$(id -u)" && $(( 8#$(stat -c '%a' -- "$dir") & 8#077 )) == 0 ]] || fail "$dir is open to other users (want mode 700)"
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then fail "$file is inside the Git checkout $(git -C "$dir" rev-parse --show-toplevel)"; fi
  pass "$file is private and outside every checkout"
}

# Read only the two names this needs. Compose takes the last assignment.
setting() { sed -n "s/^$1=//p" -- "$stack" | tail -n 1; }
private "$stack"
project=$(setting COMPOSE_PROJECT_NAME)
server=${SELFHOST_SERVER_ENV_FILE:-$(setting SELFHOST_SERVER_ENV_FILE)}
server=${server:-../../.data/selfhost/$project.server.env}
[[ $server == /* ]] || server="$kit/$server"
private "$server"

# The resolved configuration goes into Python only; this prints a verdict, never a value.
if docker compose --env-file "$stack" -f "$kit/compose.yaml" config --format json | python3 -c '
import json, sys
env = json.load(sys.stdin)["services"]["server"]["environment"]
if env.get("WLP_DEMO") == "1": sys.exit(0)
sys.exit(0 if (env.get("WLP_ALLOWED_USERS") or env.get("WLP_ALLOWED_EMAILS") or "").strip() else 1)'; then
  pass "the resolved server configuration has demo sign-in or an allowlist"
else
  fail "the resolved server configuration has no demo sign-in and no WLP_ALLOWED_USERS or WLP_ALLOWED_EMAILS"
fi
(( failures == 0 ))
