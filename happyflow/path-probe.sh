#!/usr/bin/env bash
# Quick probe: returns URL + first meaningful heading from snapshot
set -euo pipefail
AB="${AB:-$(cd "$(dirname "$0")/../login" && pwd)/node_modules/.bin/agent-browser}"
SESSION="${SESSION:-happyflow-probe}"
$AB --session "$SESSION" get url 2>/dev/null | tail -1
$AB --session "$SESSION" snapshot -i 2>&1 | grep -iE 'heading|Something went wrong|No dialogue|404|error|Verify|Next|disabled' | head -8
