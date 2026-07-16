#!/usr/bin/env bash
# Single-session happy flow exploration — login ONCE, then try paths with back/forth.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGIN_DIR="$ROOT/../login"
AB="$LOGIN_DIR/node_modules/.bin/agent-browser"
SESSION="happyflow-one"
export $(grep -v '^#' "$LOGIN_DIR/.env" | xargs)
LOG="$ROOT/path-results-single.log"
REPORT="$ROOT/PATH_REPORT.md"
: > "$LOG"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

snap() { $AB --session "$SESSION" snapshot -i 2>&1; }
url() { $AB --session "$SESSION" get url 2>/dev/null | tail -1; }

ref_for() {
  local pattern="$1"
  snap | grep -iE "$pattern" | head -1 | sed -n 's/.*\[ref=\(e[0-9]*\)\].*/\1/p'
}

# Correct login: NEVER fill until login form is confirmed (no FULL NAME field)
do_login() {
  log "Login: open /login"
  $AB --session "$SESSION" open "https://beta.koyal.ai/login" >/dev/null
  sleep 4

  if snap | grep -qi 'textbox "FULL NAME'; then
    log "Login: on signup form — click Log In toggle"
    local toggle=$(ref_for 'button "Log In"')
    [ -n "$toggle" ] && $AB --session "$SESSION" click "@$toggle"
    sleep 2
  fi

  if snap | grep -qi 'textbox "FULL NAME'; then
    log "FAIL: still on signup after toggle"
    return 1
  fi

  local email=$(ref_for 'textbox "EMAIL')
  local pass=$(ref_for 'textbox "PASSWORD')
  local submit=$(ref_for 'button "Start Creating"')
  if [ -z "$email" ] || [ -z "$pass" ] || [ -z "$submit" ]; then
    log "FAIL: login fields missing email=$email pass=$pass submit=$submit"
    return 1
  fi

  log "Login: fill email/password (refs $email $pass)"
  $AB --session "$SESSION" fill "@$email" "$KOYAL_TEST_EMAIL"
  $AB --session "$SESSION" fill "@$pass" "$KOYAL_TEST_PASSWORD"
  $AB --session "$SESSION" click "@$submit"
  sleep 5
  local u=$(url)
  log "Login result: $u"
  echo "$u" | grep -qE '/(projects|dashboard|upload)' 
}

click_btn() {
  local text="$1"
  $AB --session "$SESSION" eval "
    for (const b of document.querySelectorAll('button')) {
      if (b.textContent.includes('$text')) { b.click(); break; }
    }
  " >/dev/null 2>&1
}

upload_script() {
  $AB --session "$SESSION" upload '#script-file-input' "$1" >/dev/null 2>&1
  sleep 3
}

upload_audio() {
  $AB --session "$SESSION" upload 'input[type=file]' "$1" 2>/dev/null || \
  $AB --session "$SESSION" eval "
    const i=document.querySelector('input[type=file]');
    if(i) i.dispatchEvent(new Event('change',{bubbles:true}));
  " >/dev/null 2>&1
  sleep 3
}

analyze() {
  local u=$(url)
  local s=$(snap)
  local status="OK"
  local notes=()
  echo "$s" | grep -qi "Something went wrong" && { status="FAIL"; notes+=("something-wrong"); }
  echo "$s" | grep -qi "No dialogue found" && { status="FAIL"; notes+=("no-dialogue"); }
  echo "$s" | grep -qi "404" && { status="FAIL"; notes+=("404"); }
  echo "$s" | grep -qi "projectId" && { status="FAIL"; notes+=("projectId-empty"); }
  echo "$s" | grep -qi 'button "Next" \[disabled' && notes+=("next-disabled")
  echo "$s" | grep -qi "How would you like to start" && notes+=("start-fork")
  echo "$s" | grep -qi "concept driven" && notes+=("story-type")
  echo "$s" | grep -qi "Edit Script" && notes+=("edit-script")
  echo "$s" | grep -qi "Select Your Plan" && notes+=("plan-modal")
  echo "$s" | grep -qi "Final video" && notes+=("final-video-step")
  echo "$s" | grep -qi "Add New Location" && notes+=("locations-step")
  echo "$|${status}|${u}|$(IFS=,; echo "${notes[*]}")"
}

record() { log "PATH $1 => $2 | $3"; echo "$1|$2|$3" >> "$ROOT/path-results-single.tsv"; }

# --- main ---
$AB --session "$SESSION" close 2>/dev/null || true
sleep 1
: > "$ROOT/path-results-single.tsv"

if ! do_login; then
  log "ABORT: login failed"
  exit 1
fi
record "0-login" "WORKS" "$(url)"

# PATH A: dashboard → new project
log "--- A: dashboard new project ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/dashboard" >/dev/null; sleep 3
click_btn "New project"; sleep 4
r=$(analyze); record "A-dashboard-new-project" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"
$AB --session "$SESSION" snapshot -i > "$ROOT/snapshots/pathA_start_fork.txt" 2>&1

# PATH B: back to projects, create project
log "--- B: projects create ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/projects" >/dev/null; sleep 3
ref=$(ref_for 'button "Create Project"')
[ -n "$ref" ] && $AB --session "$SESSION" click "@$ref"
sleep 4
r=$(analyze); record "B-projects-create" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"

# PATH C: script 5s standard concept (stay in same session)
log "--- C: script 5s concept ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/upload" >/dev/null; sleep 2
click_btn "Start with Script"; sleep 2
upload_script "$ROOT/test-script-5-second.txt"
click_btn "Standard"; sleep 1
click_btn "Continue"; sleep 3
click_btn "Next"; sleep 2
click_btn "Concept Driven"; sleep 1
click_btn "Next"; sleep 18
r=$(analyze); record "C-script-5s-concept" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"
$AB --session "$SESSION" screenshot "$ROOT/screenshots/pathC_script_edit.png" 2>/dev/null

# PATH D: browser back then try heist script (new upload from upload page)
log "--- D: script heist ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/upload" >/dev/null; sleep 2
click_btn "Start with Script"; sleep 2
upload_script "$ROOT/test-script-coffee-shop-heist.txt"
click_btn "Standard"; sleep 1
click_btn "Continue"; sleep 3
click_btn "Next"; sleep 2
click_btn "Concept Driven"; sleep 1
click_btn "Next"; sleep 25
r=$(analyze); record "D-script-heist-concept" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"

# PATH E: audio 5s wav
log "--- E: audio upload ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/upload" >/dev/null; sleep 2
click_btn "Start with Audio"; sleep 3
upload_audio "$ROOT/test-audio-5sec.wav"
sleep 10
r=$(analyze); record "E-audio-wav-5s" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"

# PATH F: audio select sample
log "--- F: audio sample ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/upload" >/dev/null; sleep 2
click_btn "Start with Audio"; sleep 2
click_btn "Select Sample"; sleep 5
r=$(analyze); record "F-audio-select-sample" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"

# PATH G: character driven on 5s script
log "--- G: character driven ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/upload" >/dev/null; sleep 2
click_btn "Start with Script"; sleep 2
upload_script "$ROOT/test-script-5-second.txt"
click_btn "Standard"; sleep 1
click_btn "Continue"; sleep 3
click_btn "Next"; sleep 2
click_btn "Character Driven"; sleep 3
r=$(analyze); record "G-character-driven" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"

# PATH H: sidebar round-trip then locations
log "--- H: sidebar locations ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/characters" >/dev/null; sleep 2
$AB --session "$SESSION" open "https://beta.koyal.ai/assets" >/dev/null; sleep 2
$AB --session "$SESSION" open "https://beta.koyal.ai/locations" >/dev/null; sleep 3
r=$(analyze); record "H-sidebar-locations" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"

# PATH I: resume project + wizard theme
log "--- I: resume project ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/projects" >/dev/null; sleep 3
ref=$(snap | grep -i sample-script | head -1 | sed -n 's/.*\[ref=\(e[0-9]*\)\].*/\1/p')
[ -n "$ref" ] && $AB --session "$SESSION" click "@$ref" && sleep 4
r=$(analyze); record "I-click-project-card" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"

log "--- J: scriptEdit theme nav ---"
$AB --session "$SESSION" open "https://beta.koyal.ai/scriptEdit" >/dev/null; sleep 4
ref=$(ref_for 'generic "Theme"')
[ -n "$ref" ] && $AB --session "$SESSION" click "@$ref" && sleep 3
r=$(analyze); record "J-wizard-theme" "$(echo "$r" | cut -d'|' -f2)" "$(echo "$r" | cut -d'|' -f3-)"

log "=== Single-session probe complete ==="
