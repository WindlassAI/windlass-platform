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
mkdir -p "$root/.data/selfhost"
file="$root/.data/selfhost/$stack.env"
admin_token=$(openssl rand -hex 32)
signing_secret=$(openssl rand -hex 32)
release=$(git rev-parse --short HEAD)
tmp=$(mktemp "$root/.data/selfhost/init.XXXXXXXX")
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
  echo "WLP_SANDBOX=fake"
  echo "WLP_DEMO=$demo"
  echo "SELFHOST_SERVER_TARGET=$target"
  echo "WLP_SIGNIN_RUNNER=$signin"
  echo "SELFHOST_RELEASE=$release"
  echo "RIVET_NODE_VERSION=1"
  echo "SELFHOST_ISSUER_GENERATION=1"
} > "$tmp"
ln -- "$tmp" "$file"
echo "Created $file"
