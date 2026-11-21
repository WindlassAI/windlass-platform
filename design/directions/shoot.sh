#!/usr/bin/env bash
# Render one mockup page to PNG with headless Chromium.
# usage: shoot.sh <page.html> <out.png> <width> <height> [query] [--full]
# query example: "theme=light&state=open". Each page reads ?theme= and ?state= itself.
set -euo pipefail
page=$(realpath "$1"); out=$(realpath -m "$2"); w=$3; h=$4; q=${5:-}; full=${6:-}
AB=/home/ubuntu/.local/npm/bin/agent-browser
export AGENT_BROWSER_EXECUTABLE_PATH=$HOME/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell
export AGENT_BROWSER_ARGS=$'--no-sandbox\n--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-mock-$(basename "$(dirname "$page")")}

$AB open "file://$page${q:+?$q}" >/dev/null
$AB set viewport "$w" "$h" >/dev/null
$AB eval 'document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,700))).then(()=>document.fonts.size)' >/dev/null
mkdir -p "$(dirname "$out")"
if [ "$full" = "--full" ]; then $AB screenshot --full "$out" >/dev/null; else $AB screenshot "$out" >/dev/null; fi
echo "$out"
