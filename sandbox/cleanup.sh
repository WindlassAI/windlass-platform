#!/bin/sh
# Removes every Docker resource windlass-platform created: containers and volumes that carry the label
# dev.windlass-platform=1 and a wlp- name, then the sandbox image. Nothing without that label is touched.
#
#   sandbox/cleanup.sh            containers, volumes (user sign-ins included!) and the image
#   sandbox/cleanup.sh --keep-image
set -eu
LABEL=dev.windlass-platform=1
keep_image=0
[ "${1:-}" = "--keep-image" ] && keep_image=1

containers=$(docker ps -aq --filter "label=$LABEL" --filter "name=^wlp-")
if [ -n "$containers" ]; then
  # shellcheck disable=SC2086
  docker rm -f $containers >/dev/null
  echo "cleanup.sh: removed $(echo "$containers" | wc -l) container(s)"
fi

volumes=$(docker volume ls -q --filter "label=$LABEL" | grep '^wlp-' || true)
if [ -n "$volumes" ]; then
  # shellcheck disable=SC2086
  docker volume rm -f $volumes >/dev/null
  echo "cleanup.sh: removed $(echo "$volumes" | wc -l) volume(s)"
fi

if [ "$keep_image" = 0 ]; then
  images=$(docker images -q --filter "label=$LABEL" --filter "reference=windlass-platform-sandbox" | sort -u)
  if [ -n "$images" ]; then
    # shellcheck disable=SC2086
    docker rmi -f $images >/dev/null
    echo "cleanup.sh: removed the sandbox image"
  fi
fi
echo "cleanup.sh: done"
