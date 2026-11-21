#!/usr/bin/env bash
source "$(dirname -- "$0")/archive-common.sh"
name=${2:?usage: restore.sh stack.env archive-basename}
archive_name "$name" || { echo "Invalid archive basename" >&2; exit 2; }
if [[ -n ${store:-} ]]; then
  cp "$store/$name" "$work/data.tar.gz"
else
  "${s3[@]}" s3 cp "s3://$bucket/$project/$name" "$work/data.tar.gz" --only-show-errors
fi
gzip -t "$work/data.tar.gz"
# The volume name is generated here; an existing volume is never a restore target.
nonce=$(cat /proc/sys/kernel/random/uuid)
restored="${project}_restore-$nonce"
! docker volume inspect "$restored" >/dev/null 2>&1 || exit 1
docker volume create --label "com.docker.compose.project=$project" --label com.docker.compose.volume=engine-data \
  --label "wlp.restore=$nonce" "$restored" >/dev/null
[[ $(docker volume inspect -f '{{index .Labels "wlp.restore"}}' "$restored") == "$nonce" ]] || exit 1
complete=0
cleanup() {
  if (( ! complete )); then docker volume rm "$restored" >&2; fi
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --rm --label com.docker.compose.project= --label com.docker.compose.service= -i --network none --read-only --user 0 --entrypoint tar \
  --mount "type=volume,src=$restored,dst=/restore,volume-nocopy" "$image" \
  -C /restore --numeric-owner -xzf - < "$work/data.tar.gz"
complete=1
echo "$restored"
