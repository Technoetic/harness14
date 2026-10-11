#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# webapp-trigger.sh — UserPromptSubmit hook (macOS/Linux)
# Mirrors webapp-trigger.ps1 — only an explicit first-line `/webapp <topic>` (or
# `/harness14:webapp <topic>`, with `/harness50:webapp` compatibility) bootstraps
# step_archive/, writes TOPIC.md, initializes
# progress.json and emits a system-reminder forcing step001 entry. Natural-language prompts do
# nothing. Progress that records completed steps, or cannot be read, is never overwritten: the
# one line from lib/harness-activity.mjs precheck-webapp is printed instead.

set -u
RAW="$(cat || true)"
EVENT_CWD=""
if command -v python3 >/dev/null 2>&1; then
  EVENT_CWD="$(printf '%s' "$RAW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cwd", "") if isinstance(d,dict) else "")' 2>/dev/null || true)"
fi
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-${EVENT_CWD:-$PWD}}"

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STEP_ARCHIVE="$PROJECT_ROOT/step_archive"
ARCHIVED_DIR="$STEP_ARCHIVE/archived"
TOPIC_DIR="$STEP_ARCHIVE/TOPIC"
PROGRESS_FILE="$STEP_ARCHIVE/progress.json"
TOPIC_FILE="$TOPIC_DIR/TOPIC.md"
ASSET_STEPS="$PLUGIN_ROOT/assets/steps"
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/webapp-trigger.log"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

[ -z "$RAW" ] && exit 0

# extract "prompt" field from stdin JSON without jq dependency: fall back to python3 if present
PROMPT=""
if command -v python3 >/dev/null 2>&1; then
  PROMPT="$(printf '%s' "$RAW" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("prompt",""))' 2>/dev/null || true)"
elif command -v jq >/dev/null 2>&1; then
  PROMPT="$(printf '%s' "$RAW" | jq -r '.prompt // ""' 2>/dev/null || true)"
else
  # crude grep fallback
  PROMPT="$(printf '%s' "$RAW" | grep -oE '"prompt"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"prompt"[[:space:]]*:[[:space:]]*"(.*)"/\1/')"
fi
[ -z "$PROMPT" ] && exit 0

# trigger: the explicit command on the first line only, case-sensitive (EXPLICIT_WEBAPP in
# lib/harness-activity.mjs). Natural-language requests never start a run.
printf '%s\n' "$PROMPT" | head -n 1 | grep -Eq '^[[:blank:]]*/(harness(14|20|36|50):)?webapp[[:blank:]]+[^[:space:]]' || exit 0
log "TRIGGER matched"

# Codex coexistence (mirrors webapp-trigger.ps1): an existing Codex workflow is resumed,
# never re-initialized (codex/skills/webapp/SKILL.md). Leave TOPIC.md, progress.json and
# step_archive/ untouched.
if [ -e "$STEP_ARCHIVE/.harness50-codex/state.json" ]; then
  log "Codex workflow state present -> trigger skipped"
  CODEX_LINE=""
  if command -v node >/dev/null 2>&1; then
    CODEX_LINE="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/codex-workflow.mjs" "$PROJECT_ROOT" 2>/dev/null || true)"
  fi
  [ -n "$CODEX_LINE" ] || CODEX_LINE="[HARNESS] WARNING: step_archive/.harness50-codex/state.json exists but is unreadable or incomplete - Claude hooks will not create progress.json or block Stop here. Inspect it with the harness14 plugin's codex/scripts/harness-state.mjs show and ask the user before repairing or resetting it."
  echo "[HARNESS] webapp trigger skipped: a Codex workflow owns this workspace, so step_archive/TOPIC/TOPIC.md and progress.json were left unchanged. Resume that workflow, or use a separate workspace for a different topic."
  printf '%s\n' "$CODEX_LINE"
  exit 0
fi

# Never overwrite a run that recorded completed steps, or a progress.json that cannot be read
# (mirrors webapp-trigger.ps1). 'issue' is the only answer that lets the bootstrap run.
PRECHECK="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/harness-activity.mjs" precheck-webapp "$PROJECT_ROOT" 2>/dev/null | head -n 1 || true)"
if [ "$PRECHECK" != "issue" ]; then
  [ -n "$PRECHECK" ] || PRECHECK="[HARNESS] webapp trigger skipped: node is unavailable, so existing progress could not be checked and nothing was changed."
  log "precheck -> trigger skipped"
  printf '%s\n' "$PRECHECK"
  exit 0
fi

# The shared helper validates every allowlisted source before copying.
PROFILE_JSON="$(node "$PLUGIN_ROOT/hooks/lib/workflow-profile.mjs" bootstrap "$PROJECT_ROOT" 2>/dev/null)" || { echo '[HARNESS] Profile bootstrap failed; nothing was initialized.'; exit 0; }
PROFILE_ID="$(printf '%s' "$PROFILE_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workflow_profile"])' | tr -d '\r')"
TOTAL_STEPS="$(printf '%s' "$PROFILE_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' | tr -d '\r')"
BODY_DIRECTORY="$(printf '%s' "$PROFILE_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["body_directory"])' | tr -d '\r')"
FINAL_STEP="$(printf '%03d' "$TOTAL_STEPS")"
mkdir -p "$TOPIC_DIR"

# H4 수정: html-bundler를 프로젝트로 복사 (step038에서 실행 가능하게)
TOOLS_DIR="$STEP_ARCHIVE/tools"
mkdir -p "$TOOLS_DIR"
HOOK_DIR="$(dirname "${BASH_SOURCE[0]}")"
for b in html-bundler.ps1 html-bundler.sh; do
  [ -f "$HOOK_DIR/$b" ] && cp "$HOOK_DIR/$b" "$TOOLS_DIR/$b"
done

# Normalize and freeze the six-field contract before the first planning step.
if ! printf '%s' "$RAW" | node "$PLUGIN_ROOT/hooks/lib/workflow-profile.mjs" topic "$PROJECT_ROOT" >/dev/null 2>&1; then
  echo '[HARNESS] TOPIC contract initialization failed; no progress was initialized.'
  exit 0
fi
log "TOPIC.md written"

# progress.json
NOW="$(date '+%Y-%m-%dT%H:%M:%S')"
# run_started_at (UTC ISO 8601) is the run boundary: step-progress-writer counts only transcript
# entries from this moment on (mirrors webapp-trigger.ps1). node answered the precheck above, so it
# gives the millisecond form; date -u (whole seconds, never later than now) is the fallback.
STARTED="$(node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || true)"
case "$STARTED" in
  [0-9][0-9][0-9][0-9]-*Z) ;;
  *) STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" ;;
esac
cat >"$PROGRESS_FILE" <<JSON
{
  "run_started_at": "$STARTED",
  "current_step": 1,
  "completed_steps": [],
  "skipped_steps": [],
  "failed_steps": [],
  "schema_version": 2,
  "workflow_profile": "$PROFILE_ID",
  "total_steps": $TOTAL_STEPS,
  "metrics": { "total_duration_minutes": 0, "total_sessions": 0, "steps_per_session_avg": 0 },
  "session_history": [],
  "last_updated": "$NOW"
}
JSON
log "progress.json initialized"

# system-reminder
cat <<REMINDER
<harness50-trigger>
WEBAPP TUTORIAL TRIGGER DETECTED

Bootstrap complete:
  - step_archive/ ready
  - step_archive/TOPIC/TOPIC.md written with the user prompt
  - step_archive/progress.json initialized (current_step=1, total=$TOTAL_STEPS)
  - $BODY_DIRECTORY/step001.md ~ step$FINAL_STEP.md available

ABSOLUTE OVERRIDE:
  Before addressing anything else, IMMEDIATELY:
    1. Read $BODY_DIRECTORY/step001.md
    2. Execute its instructions in full (including TOPIC pickup from TOPIC.md)
    3. On completion report 'Step 001/$TOTAL_STEPS 완료' and Read step002.md
    4. Continue without user confirmation through step$FINAL_STEP

Missing essential input requires a required-input-missing named pause; never invent earlier completed work.
Do NOT ask the user any clarifying questions.
Do NOT pause for confirmation.
Do NOT end the turn before step$FINAL_STEP except by a named pause (harness-rules 2-1).
</harness50-trigger>
REMINDER
exit 0
