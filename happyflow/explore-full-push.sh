#!/usr/bin/env bash
# ONE session — login once, push script + audio paths as far as possible.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGIN_DIR="$ROOT/../login"
AB="$LOGIN_DIR/node_modules/.bin/agent-browser"
SESSION="happyflow"
export $(grep -v '^#' "$LOGIN_DIR/.env" | xargs)
LOG="$ROOT/full-push.log"
TSV="$ROOT/full-push-results.tsv"
: > "$LOG"
: > "$TSV"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
record() { log "RESULT $1 | $2 | $3"; echo -e "$1\t$2\t$3" >> "$TSV"; }

snap() { $AB --session "$SESSION" snapshot -i 2>&1; }
url() { $AB --session "$SESSION" get url 2>/dev/null | tail -1; }
shot() { local f="$1"; $AB --session "$SESSION" screenshot "$ROOT/screenshots/$f" 2>/dev/null || true; }

ref_for() {
  snap | grep -iE "$1" | head -1 | sed -n 's/.*\[ref=\(e[0-9]*\)\].*/\1/p'
}

has_text() { snap | grep -qi "$1"; }

click_ref() {
  local r="$1"
  [ -n "$r" ] && $AB --session "$SESSION" click "@$r" >/dev/null 2>&1
}

click_btn() {
  $AB --session "$SESSION" eval "
    for (const b of document.querySelectorAll('button,a,[role=button]')) {
      const t=(b.textContent||'').trim();
      if (t.includes('$1')) { b.click(); return t; }
    }
    return null;
  " 2>/dev/null
}

click_label() {
  $AB --session "$SESSION" eval "
    for (const el of document.querySelectorAll('label,span,div,p')) {
      if ((el.textContent||'').includes('$1')) { el.click(); return true; }
    }
    return false;
  " 2>/dev/null
}

status_notes() {
  local s="$1" u="$2" notes=()
  echo "$s" | grep -qi "Something went wrong" && notes+=("something-wrong")
  echo "$s" | grep -qi "No dialogue found" && notes+=("no-dialogue")
  echo "$s" | grep -qi "Minimum 1 character" && notes+=("need-character")
  echo "$s" | grep -qi "404" && notes+=("404")
  echo "$s" | grep -qi "projectId" && notes+=("projectId-error")
  echo "$s" | grep -qi 'button "Next" \[disabled' && notes+=("next-disabled")
  echo "$s" | grep -qi 'button "Next"' && ! echo "$s" | grep -qi 'button "Next" \[disabled' && notes+=("next-enabled")
  echo "$s" | grep -qi "Edit Script" && notes+=("edit-script")
  echo "$s" | grep -qi "Review transcript" && notes+=("review-transcript")
  echo "$s" | grep -qi "Theme" && notes+=("theme-step")
  echo "$s" | grep -qi "Final video" && notes+=("final-video")
  echo "$s" | grep -qi "Storyboard" && notes+=("storyboard")
  echo "$s" | grep -qi "Add New Location" && notes+=("locations")
  echo "$s" | grep -qi "How would you like to start" && notes+=("upload-fork")
  echo "$s" | grep -qi "Select Your Plan" && notes+=("plan-modal")
  echo "$s" | grep -qi "concept driven" && notes+=("story-type")
  echo "$s" | grep -qi "InProgress" && notes+=("in-progress")
  echo "$s" | grep -qi "Completed" && notes+=("completed")
  echo "$s" | grep -qi "Generating" && notes+=("generating")
  printf '%s' "${notes[*]:-idle}"
}

analyze() {
  local u=$(url) s=$(snap)
  echo "${u}|$(status_notes "$s" "$u")"
}

do_login() {
  log "=== LOGIN ==="
  $AB --session "$SESSION" open "https://beta.koyal.ai/login" >/dev/null
  sleep 4
  if has_text 'textbox "FULL NAME'; then
    log "Signup form — click Log In"
    click_ref "$(ref_for 'button "Log In"')"
    sleep 2
  fi
  if has_text 'textbox "FULL NAME'; then
    log "FAIL still signup"; return 1
  fi
  local email=$(ref_for 'textbox "EMAIL')
  local pass=$(ref_for 'textbox "PASSWORD')
  local submit=$(ref_for 'button "Start Creating"')
  [ -z "$email" ] || [ -z "$pass" ] && { log "missing fields"; return 1; }
  $AB --session "$SESSION" fill "@$email" "$KOYAL_TEST_EMAIL"
  $AB --session "$SESSION" fill "@$pass" "$KOYAL_TEST_PASSWORD"
  click_ref "$submit"
  sleep 5
  local u=$(url)
  log "Logged in: $u"
  echo "$u" | grep -qE '/(projects|dashboard|upload)'
}

upload_script_file() {
  local f="$1"
  log "Upload script: $(basename "$f")"
  $AB --session "$SESSION" upload '#script-file-input' "$f" 2>/dev/null || \
  $AB --session "$SESSION" upload 'input[type=file]' "$f" 2>/dev/null
  sleep 4
}

upload_audio_file() {
  local f="$1"
  log "Upload audio: $(basename "$f")"
  local n=$($AB --session "$SESSION" eval "document.querySelectorAll('input[type=file]').length" 2>/dev/null)
  log "file inputs: $n"
  $AB --session "$SESSION" upload 'input[type=file]' "$f" 2>/dev/null
  sleep 8
}

pick_plan() {
  local plan="${1:-Standard}"
  log "Pick plan: $plan"
  click_label "$plan"
  sleep 1
  click_btn "Continue"
  sleep 3
}

story_type_and_next() {
  local type="${1:-Concept Driven}"
  log "Story type: $type"
  click_label "$type"
  sleep 2
  click_btn "Next"
  sleep 3
}

# Click Next / Continue while enabled (push wizard forward)
push_wizard() {
  local max="${1:-12}" wait="${2:-8}" i=0
  while [ "$i" -lt "$max" ]; do
    local s=$(snap) u=$(url)
    if echo "$s" | grep -qi "Something went wrong"; then
      log "push_wizard: blocked — something went wrong at $u"
      click_btn "Retry" >/dev/null; sleep 5
      return 1
    fi
    if echo "$s" | grep -qi "Completed" || echo "$s" | grep -qi "Your video is ready"; then
      log "push_wizard: DONE at $u"
      return 0
    fi
    local next=$(ref_for 'button "Next"')
    if echo "$s" | grep -q 'button "Next"' && ! echo "$s" | grep -q 'button "Next" \[disabled'; then
      log "push_wizard [$i]: Next at $u"
      click_ref "$next"
      sleep "$wait"
    elif echo "$s" | grep -qi "Continue" && ! echo "$s" | grep -qi '\[disabled'; then
      log "push_wizard [$i]: Continue"
      click_btn "Continue"; sleep "$wait"
    else
      log "push_wizard [$i]: stuck at $u — $(status_notes "$s" "$u")"
      return 1
    fi
    i=$((i+1))
  done
}

start_script_flow() {
  $AB --session "$SESSION" open "https://beta.koyal.ai/upload" >/dev/null
  sleep 3
  if ! has_text "How would you like to start"; then
    log "Not on upload fork — clicking × or dashboard"
    click_btn "×"; sleep 2
    $AB --session "$SESSION" open "https://beta.koyal.ai/upload" >/dev/null; sleep 3
  fi
  click_btn "Start with Script"; sleep 3
}

start_audio_flow() {
  $AB --session "$SESSION" open "https://beta.koyal.ai/upload" >/dev/null
  sleep 3
  click_btn "×"; sleep 1
  $AB --session "$SESSION" open "https://beta.koyal.ai/upload" >/dev/null
  sleep 3
  click_btn "Start with Audio"; sleep 4
}

try_create_character() {
  log "=== CREATE CHARACTER ==="
  $AB --session "$SESSION" open "https://beta.koyal.ai/characters" >/dev/null
  sleep 3
  click_btn "NEW CHARACTER"; sleep 2
  click_btn "Create AI Avatar"; sleep 2
  local desc=$(ref_for 'textbox')
  if [ -n "$desc" ]; then
    $AB --session "$SESSION" fill "@$desc" "Maya, 32, woman in red coat, coffee shop customer, friendly smile"
    sleep 1
  fi
  click_btn "Create"; sleep 5
  shot "character-create.png"
  record "character-create" "$(url)" "$(analyze | cut -d'|' -f2-)"
}

try_resume_dashboard() {
  log "=== RESUME FROM DASHBOARD ==="
  $AB --session "$SESSION" open "https://beta.koyal.ai/dashboard" >/dev/null
  sleep 4
  # click first in-progress project article/card
  $AB --session "$SESSION" eval "
    const cards=[...document.querySelectorAll('article,a,div')].filter(el=>{
      const t=el.textContent||'';
      return t.includes('InProgress') || t.includes('0:00') || t.includes('COFFEE') || t.includes('MORNING');
    });
    if(cards[0]) cards[0].click();
  " >/dev/null 2>&1
  sleep 4
  local u=$(url)
  log "After dashboard click: $u"
  if echo "$u" | grep -q '/project/'; then
    click_btn "RESUME"; sleep 4
    push_wizard 15 10 || true
  fi
  shot "resume-dashboard.png"
  record "resume-dashboard" "$u" "$(analyze | cut -d'|' -f2-)"
}

navigate_all_sidebar() {
  log "=== SIDEBAR NAV ==="
  for route in dashboard projects characters assets outfits collaborated-projects; do
    $AB --session "$SESSION" open "https://beta.koyal.ai/$route" >/dev/null
    sleep 3
    local a=$(analyze)
    record "sidebar-$route" "$(echo "$a" | cut -d'|' -f1)" "$(echo "$a" | cut -d'|' -f2-)"
  done
  $AB --session "$SESSION" open "https://beta.koyal.ai/locations" >/dev/null; sleep 3
  record "sidebar-locations" "$(url)" "$(analyze | cut -d'|' -f2-)"
}

# --- MAIN ---
$AB --session "$SESSION" close 2>/dev/null || true
sleep 1

do_login || exit 1
record "login" "$(url)" "ok"
shot "01-logged-in.png"

# PATH 1: Big heist script → Standard → Concept → push
log "=== PATH 1: HEIST SCRIPT ==="
start_script_flow
upload_script_file "$ROOT/test-script-coffee-shop-heist.txt"
pick_plan "Standard"
click_btn "Next"; sleep 3
story_type_and_next "Concept Driven"
sleep 30
shot "path1-after-story-type.png"
push_wizard 20 12 || true
shot "path1-push-end.png"
record "heist-standard-concept" "$(url)" "$(analyze | cut -d'|' -f2-)"
$AB --session "$SESSION" console 2>&1 | tail -8 >> "$LOG"

# PATH 2: Heist + Pro plan (fresh upload)
log "=== PATH 2: HEIST PRO ==="
start_script_flow
upload_script_file "$ROOT/test-script-coffee-shop-heist.txt"
pick_plan "Pro"
click_btn "Next"; sleep 3
story_type_and_next "Concept Driven"
sleep 35
push_wizard 20 12 || true
record "heist-pro-concept" "$(url)" "$(analyze | cut -d'|' -f2-)"
shot "path2-heist-pro.png"

# PATH 3: Audio dialogue WAV
log "=== PATH 3: AUDIO DIALOGUE WAV ==="
start_audio_flow
shot "path3-audio-fork.png"
upload_audio_file "$ROOT/test-audio-dialogue.wav"
sleep 15
pick_plan "Standard" 2>/dev/null || true
click_btn "Next"; sleep 5
push_wizard 20 12 || true
record "audio-dialogue-wav" "$(url)" "$(analyze | cut -d'|' -f2-)"
shot "path3-audio-after.png"

# PATH 4: Audio MP3
log "=== PATH 4: AUDIO MP3 ==="
start_audio_flow
upload_audio_file "$ROOT/test-audio-dialogue.mp3"
sleep 15
click_btn "Next"; sleep 5
push_wizard 15 10 || true
record "audio-dialogue-mp3" "$(url)" "$(analyze | cut -d'|' -f2-)"

# PATH 5: Audio Select Sample
log "=== PATH 5: AUDIO SELECT SAMPLE ==="
start_audio_flow
click_btn "Select Sample"; sleep 6
shot "path5-select-sample.png"
record "audio-select-sample" "$(url)" "$(analyze | cut -d'|' -f2-)"

# PATH 6: Character driven with character creation
try_create_character
log "=== PATH 6: CHARACTER DRIVEN ==="
start_script_flow
upload_script_file "$ROOT/test-script-coffee-shop-heist.txt"
pick_plan "Standard"
click_btn "Next"; sleep 3
story_type_and_next "Character Driven"
sleep 5
# try select existing character
click_btn "Maya" 2>/dev/null; sleep 2
$AB --session "$SESSION" eval "
  [...document.querySelectorAll('button,div,label')].forEach(el=>{
    if((el.textContent||'').match(/character|avatar|maya/i)) el.click();
  });
" >/dev/null 2>&1
sleep 3
click_btn "Next"; sleep 20
push_wizard 15 10 || true
record "character-driven-heist" "$(url)" "$(analyze | cut -d'|' -f2-)"
shot "path6-character-driven.png"

# PATH 7: Resume + wizard sidebar steps
try_resume_dashboard

# PATH 8: Projects page — try opening project different ways
log "=== PATH 8: PROJECTS OPEN ==="
$AB --session "$SESSION" open "https://beta.koyal.ai/projects" >/dev/null; sleep 4
$AB --session "$SESSION" eval "
  const btn=[...document.querySelectorAll('button,a,article,div')].find(el=>(el.textContent||'').includes('COFFEE')||(el.textContent||'').includes('MORNING')||(el.textContent||'').includes('HEIST'));
  if(btn) btn.click();
" >/dev/null 2>&1
sleep 4
record "projects-card-click" "$(url)" "$(analyze | cut -d'|' -f2-)"

navigate_all_sidebar

log "=== FULL PUSH COMPLETE ==="
cat "$TSV" | tee -a "$LOG"
