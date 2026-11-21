# Shared by backup.sh and restore.sh. All object keys are under the source Compose project.
set -euo pipefail
umask 077
kit=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
compose=(docker compose --env-file "${1:?stack env file required}" -f "$kit/compose.yaml")
# Project names, image tags and the volume all come from Compose's resolution of the env file.
mapfile -t stack < <("${compose[@]}" config --format json | python3 -c '
import sys,json
c=json.load(sys.stdin)
print(c["name"], c["services"]["engine"]["image"], c["volumes"]["engine-data"]["name"], sep="\n")')
[[ ${#stack[@]} == 3 ]] || exit 1
project=${stack[0]} image=${stack[1]} volume=${stack[2]}
root="$kit/../../.data/selfhost"
mkdir -p "$root"
exec 9>"$root/$project.archive.lock"
flock -n 9 || { echo "Another archive operation is active for $project" >&2; exit 1; }
work=$(mktemp -d "$root/archive.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT

if [[ -n ${SELFHOST_BACKUP_DIR:-} ]]; then
  store="$SELFHOST_BACKUP_DIR/$project"
  mkdir -p -- "$store"
else
  : "${SELFHOST_BACKUP_BUCKET:?required}" "${SELFHOST_BACKUP_ENDPOINT:?required}"
  export AWS_ACCESS_KEY_ID="${SELFHOST_BACKUP_ACCESS_KEY_ID:?required}"
  export AWS_SECRET_ACCESS_KEY="${SELFHOST_BACKUP_SECRET_ACCESS_KEY:?required}"
  export AWS_DEFAULT_REGION="${SELFHOST_BACKUP_REGION:-us-east-1}" AWS_EC2_METADATA_DISABLED=true AWS_PAGER=""
  unset AWS_PROFILE AWS_SESSION_TOKEN
  command -v aws >/dev/null
  s3=(aws --endpoint-url "$SELFHOST_BACKUP_ENDPOINT")
  bucket=$SELFHOST_BACKUP_BUCKET
fi

# Accept only archive basenames generated here. The timestamp sorts chronologically.
archive_name() {
  [[ $1 =~ ^engine-[0-9]{8}T[0-9]{6}\.[0-9]{9}Z-[0-9a-f-]{36}\.tar\.gz$ ]]
}
