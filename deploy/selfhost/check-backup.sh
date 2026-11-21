#!/usr/bin/env bash
# Local-only integration check on the demo staging stack, with an expendable age keypair.
set -euo pipefail
kit=$(cd -- "$(dirname -- "$0")" && pwd)
stack=${1:?usage: check-backup.sh staging.env}
: "${SELFHOST_BACKUP_DIR:?use a private drill directory}" "${SELFHOST_BACKUP_AGE_RECIPIENT:?}" "${SELFHOST_BACKUP_AGE_IDENTITY:?}"
compose=(docker compose --env-file "$stack" -f "$kit/compose.yaml")
[[ $("${compose[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])') == wlp-staging ]] || exit 2
failures=0
fail() { echo "FAIL $*" >&2; failures=$((failures + 1)); }
if env -u SELFHOST_BACKUP_AGE_RECIPIENT -u SELFHOST_BACKUP_PLAINTEXT "$kit/backup.sh" "$stack" >/dev/null; then
  fail "backup accepted a missing recipient"
fi
# Fail before opening an S3 client, even when someone opts into plaintext.
if result=$(env -u SELFHOST_BACKUP_AGE_RECIPIENT -u SELFHOST_BACKUP_DIR -u SELFHOST_BACKUP_BUCKET SELFHOST_BACKUP_PLAINTEXT=1 "$kit/backup.sh" "$stack" 2>&1) || [[ $result != *SELFHOST_BACKUP_AGE_RECIPIENT* ]]; then
  fail "S3 recipient check did not refuse plaintext before store access"
fi
archive=$("$kit/backup.sh" "$stack")
file="$SELFHOST_BACKUP_DIR/wlp-staging/$archive"
[[ $archive == *.tar.gz.age ]] || fail "missing .age suffix"
cmp --silent --bytes=21 "$file" <(printf %s age-encryption.org/v1) || fail "missing age header"
if tar -tzf "$file" >/dev/null 2>&1; then fail "tar could read the published object"; fi
if (( failures )); then exit 1; fi
volumes() { docker volume ls -q --filter label=com.docker.compose.project=wlp-staging --filter label=wlp.restore | sort; }
before=$(volumes)
if env -u SELFHOST_BACKUP_AGE_IDENTITY "$kit/restore.sh" "$stack" "$archive" >/dev/null; then fail "restore accepted a missing identity"; fi
[[ $(volumes) == "$before" ]] || fail "failed restore created a volume"
(( failures == 0 )) || exit 1
echo "PASS encrypted object, unreadable as tar, missing recipient and identity refused" >&2
echo "$archive"
