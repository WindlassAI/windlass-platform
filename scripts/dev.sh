#!/usr/bin/env bash
# Starts the server for development: demo sign-in on, restart on change, Rivet endpoint on :6420.
#
#   scripts/dev.sh                 real sandboxes (Docker; build the image first with sandbox/build.sh)
#   WLP_SANDBOX=fake scripts/dev.sh   no Docker: in-memory sandboxes that replay recorded Windlass runs
#
# Actor data lives in .data/.rivetkit; `rm -rf .data/.rivetkit` (server stopped) starts from nothing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../server"

export WLP_DEMO="${WLP_DEMO:-1}"
export WLP_SANDBOX="${WLP_SANDBOX:-docker}"

if [ "$WLP_SANDBOX" = "docker" ] && ! docker image inspect windlass-platform-sandbox:latest >/dev/null 2>&1; then
	echo "The sandbox image is missing. Build it with sandbox/build.sh, or run with WLP_SANDBOX=fake." >&2
	exit 1
fi

exec npx tsx watch src/index.ts
