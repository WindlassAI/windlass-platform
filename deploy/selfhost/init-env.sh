#!/usr/bin/env bash
set -eu
umask 077
stack=${1:?usage: init-env.sh staging|live}
case "$stack" in
  staging) http=16440; gateway=16420; demo=1; target=demo; signin= ;;
  live) http=26440; gateway=26420; demo=0; target=production; signin=local ;;
  *) exit 2 ;;
esac
root=$(git rev-parse --show-toplevel)
# SELFHOST_ENV_DIR keeps the stack and server env files outside every checkout (mode 700).
dir=${SELFHOST_ENV_DIR:-$root/.data/selfhost}
mkdir -p -- "$dir"
dir=$(cd -- "$dir" && pwd)
[[ -z ${SELFHOST_ENV_DIR:-} ]] || chmod 700 -- "$dir"
if [[ $stack == live ]] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Warning: $dir is inside a Git checkout. Set SELFHOST_ENV_DIR to a private directory outside every checkout." >&2
fi
file="$dir/$stack.env"
admin_token=$(openssl rand -hex 32)
signing_secret=$(openssl rand -hex 32)
release=$(git rev-parse --short HEAD)
tmp=$(mktemp "$dir/init.XXXXXXXX")
trap 'rm -f -- "$tmp"' EXIT
{
  echo "COMPOSE_PROJECT_NAME=wlp-$stack"
  echo "SELFHOST_HTTP_PORT=$http"
  echo "SELFHOST_GATEWAY_PORT=$gateway"
  echo "SELFHOST_VOLUME=wlp-${stack}_engine-data"
  echo "WLP_PUBLIC_URL=http://127.0.0.1:$http"
  echo "SELFHOST_ENGINE_ORIGIN=http://127.0.0.1:$gateway"
  echo "WLP_PUBLIC_ENDPOINT=http://127.0.0.1:$gateway"
  echo "RIVET_ADMIN_TOKEN=wlp_$admin_token"
  echo "WLP_SECRET=$signing_secret"
  if [[ $stack == live ]]; then
    signin_key=$(openssl rand -hex 32)
    echo "WLP_SIGNIN_KEY=$signin_key"
  fi
  echo "WLP_REQUIRE_SIGNED_RUNNER=0"
  echo "WLP_SANDBOX=fake"
  echo "WLP_DEMO=$demo"
  echo "SELFHOST_SERVER_TARGET=$target"
  echo "WLP_SIGNIN_RUNNER=$signin"
  echo "SELFHOST_RELEASE=$release"
  echo "RIVET_NODE_VERSION=1"
  echo "SELFHOST_ISSUER_GENERATION=1"
  if [[ -n ${SELFHOST_ENV_DIR:-} ]]; then echo "SELFHOST_SERVER_ENV_FILE=$dir/wlp-$stack.server.env"; fi
} > "$tmp"
ln -- "$tmp" "$file"
echo "Created $file"
