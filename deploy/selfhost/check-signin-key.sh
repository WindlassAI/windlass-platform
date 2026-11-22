#!/usr/bin/env bash
# Exercise init and Compose with fresh fixture credentials, then rotate the signing secret.
set -euo pipefail
umask 077
kit=$(cd -- "$(dirname -- "$0")" && pwd)
root=$(cd "$kit/../.." && pwd)
mkdir -p "$root/.data/selfhost"
work=$(mktemp -d "$root/.data/selfhost/signin.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
unset WLP_SIGNIN_KEY WLP_SECRET SELFHOST_SERVER_ENV_FILE
GIT_WORK_TREE="$work" "$kit/init-env.sh" live >/dev/null 2>"$work/checkout.err"
file="$work/.data/selfhost/live.env"
failures=0
fail() { echo "FAIL $*" >&2; failures=$((failures + 1)); }
grep -q "inside a Git checkout" "$work/checkout.err" || fail "init did not warn about a live env file inside the checkout"
# Print assertions only. Expanded Compose output carries credentials.
resolved() {
  docker compose --env-file "$file" -f "$kit/compose.yaml" config --format json | python3 -c '
import json, os, re, sys
env=json.load(sys.stdin)["services"]["server"]["environment"]
key=env.get("WLP_SIGNIN_KEY")
sys.exit(0 if (key == os.environ["EXPECTED"] if "EXPECTED" in os.environ else
    bool(re.fullmatch("[0-9a-f]{64}", key or "")) and key != env["WLP_SECRET"]) else 1)'
}
export SELFHOST_SERVER_ENV_FILE="$work/server.env"
touch "$SELFHOST_SERVER_ENV_FILE"
resolved || fail "fresh live server lacks an independent 32-byte seal key"
sed -i '/^WLP_SIGNIN_KEY=/d' "$file"
echo 'WLP_SIGNIN_KEY=fixture-previously-in-the-server-env' > "$SELFHOST_SERVER_ENV_FILE"
EXPECTED=fixture-previously-in-the-server-env resolved || fail "existing server env key was lost"
# A live stack initialized into a private directory outside the checkout.
secrets=$(mktemp -d)
trap 'rm -rf -- "$work" "$secrets"' EXIT
chmod 755 "$secrets"
SELFHOST_ENV_DIR="$secrets/live" "$kit/init-env.sh" live >/dev/null 2>"$work/init.err"
moved="$secrets/live/live.env"
[[ ! -s $work/init.err ]] || fail "init warned about a directory outside the checkout"
[[ $(stat -c %a "$secrets/live") == 700 && $(stat -c %a "$moved") == 600 ]] || fail "moved env directory or file is not private"
[[ $(sed -n 's/^SELFHOST_SERVER_ENV_FILE=//p' "$moved") == "$secrets/live/wlp-live.server.env" ]] || fail "moved stack does not select its own server env file"
checked() { env -u SELFHOST_SERVER_ENV_FILE "$kit/check-env-files.sh" "$1" >/dev/null 2>&1; }
if checked "$moved"; then fail "env check passed without the server env file"; fi
( umask 077; echo WLP_ALLOWED_USERS=fixture > "$secrets/live/wlp-live.server.env" )
checked "$moved" || fail "env check refused a private stack outside the checkout"
chmod 640 "$secrets/live/wlp-live.server.env"
if checked "$moved"; then fail "env check passed a group-readable server env file"; fi
chmod 600 "$secrets/live/wlp-live.server.env"
sed -i '/^WLP_DEMO=/d' "$moved"; echo WLP_DEMO=0 >> "$moved"
echo WLP_ALLOWED_USERS= > "$secrets/live/wlp-live.server.env"
if checked "$moved"; then fail "env check passed a live stack without an allowlist"; fi
cp "$secrets/live/wlp-live.server.env" "$work/.data/selfhost/wlp-live.server.env"
if checked "$file"; then fail "env check passed env files inside the checkout"; fi
cd "$root/server"
old=$(openssl rand -hex 32)
new=$(openssl rand -hex 32)
seal='import {serverSealer} from "./src/signin/seal.ts"; console.log(serverSealer().seal("user","fixture","existing sign-in"))'
open='import {readFileSync} from "node:fs"; import {serverSealer} from "./src/signin/seal.ts"; if(serverSealer().open("user","fixture",readFileSync(0,"utf8").trim()) !== "existing sign-in") process.exit(1)'
WLP_SECRET="$old" node --import tsx --input-type=module -e "$seal" |
  WLP_SECRET="$new" WLP_SIGNIN_KEY="$old" node --import tsx --input-type=module -e "$open" || fail "old sign-in failed after signing key rotation"
if WLP_SECRET="$old" WLP_SIGNIN_KEY='' node --import tsx --input-type=module -e "$seal" >/dev/null 2>&1; then
  fail "explicitly empty seal key fell back to WLP_SECRET"
fi
(( failures == 0 )) || exit 1
echo "PASS live initializer, private env directory and its check, Compose key selection, old sign-in after rotation and empty-key refusal"
