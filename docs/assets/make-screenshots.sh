#!/usr/bin/env bash
# Capture the README's UI screenshots from a throwaway demo store.
#
#   ./docs/assets/demo-seed.sh /tmp/pm-demo
#   ./docs/assets/make-screenshots.sh /tmp/pm-demo
#
# Never point this at a real store: the output is committed to a public repo.
# The script refuses any store holding more entries than the seed creates,
# which is the cheapest available proxy for "this is not the demo".
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STORE="${1:?usage: make-screenshots.sh <demo-store-dir>}"
PORT="${PORT:-4781}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="$REPO/docs/assets"

[ -x "$CHROME" ] || { echo "no Chrome at $CHROME (set CHROME=…)"; exit 1; }

entries=$(find "$STORE/memory/entries" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
if [ "$entries" -gt 40 ]; then
  echo "refusing: $STORE holds $entries entries — that does not look like the demo store"
  exit 1
fi

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 && nvm use 20 >/dev/null 2>&1

(cd "$STORE" && npx tsx "$REPO/src/cli.ts" ui --port "$PORT" --no-open >/tmp/pm-ui-$PORT.log 2>&1) &
UI_PID=$!
trap 'kill "$UI_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT" >/dev/null && break
  sleep 1
done

shot() { # shot <name> <hash-route> <height>
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --virtual-time-budget=9000 \
    --window-size="1360,$3" \
    --screenshot="$OUT/$1.png" \
    "http://127.0.0.1:$PORT/$2" >/dev/null 2>&1
  echo "  ✓ $1.png"
}

shot ui-record        "#/"                                                        900
shot ui-chain         "#/entry/2026-10-07-refunds-move-to-kafka-rabbitmq-is-retired" 620
shot ui-graphs        "#/graphs"                                                   640

echo "✓ screenshots written to docs/assets/"
