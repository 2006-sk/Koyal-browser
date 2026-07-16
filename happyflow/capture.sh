#!/usr/bin/env bash
# Capture agent-browser artifacts for one screen into happyflow/
set -euo pipefail
NAME="${1:?screen name required}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
AB="${AB:-$(cd "$ROOT/../login" && pwd)/node_modules/.bin/agent-browser}"
SESSION="${SESSION:-happyflow-explore}"

mkdir -p "$ROOT/screenshots" "$ROOT/snapshots" "$ROOT/network" "$ROOT/console"

"$AB" --session "$SESSION" get url > "$ROOT/snapshots/${NAME}_url.txt" 2>&1 || true
"$AB" --session "$SESSION" snapshot -i > "$ROOT/snapshots/${NAME}_interactive.txt" 2>&1
"$AB" --session "$SESSION" snapshot > "$ROOT/snapshots/${NAME}_full.txt" 2>&1
"$AB" --session "$SESSION" screenshot --annotate "$ROOT/screenshots/${NAME}.png" 2>&1 || \
  "$AB" --session "$SESSION" screenshot "$ROOT/screenshots/${NAME}.png" 2>&1
"$AB" --session "$SESSION" network requests > "$ROOT/network/${NAME}_requests.txt" 2>&1 || true
{
  echo "=== ERRORS ==="
  "$AB" --session "$SESSION" errors 2>&1 || true
  echo ""
  echo "=== CONSOLE ==="
  "$AB" --session "$SESSION" console 2>&1 || true
} > "$ROOT/console/${NAME}_errors.txt"

echo "✓ captured: $NAME ($(cat "$ROOT/snapshots/${NAME}_url.txt" 2>/dev/null | tail -1))"
