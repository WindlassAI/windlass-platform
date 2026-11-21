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
GIT_WORK_TREE="$work" "$kit/init-env.sh" live >/dev/null
file="$work/.data/selfhost/live.env"
failures=0
fail() { echo "FAIL $*" >&2; failures=$((failures + 1)); }
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
echo "PASS live initializer, Compose key selection, old sign-in after rotation and empty-key refusal"
