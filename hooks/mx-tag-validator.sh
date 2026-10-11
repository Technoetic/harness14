#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# mx-tag-validator.sh - PostToolUse(Write|Edit) hook (macOS/Linux)
set -u
RAW="$(cat || true)"
EVENT_CWD=""
if command -v python3 >/dev/null 2>&1; then
  EVENT_CWD="$(printf '%s' "$RAW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cwd", "") if isinstance(d,dict) else "")' 2>/dev/null || true)"
fi
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-${EVENT_CWD:-$PWD}}"
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/mx-tag-validator.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true; }

[ -z "$RAW" ] && exit 0
command -v python3 >/dev/null 2>&1 || exit 0

FP="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); ti=d.get("tool_input") or {}
  print(ti.get("file_path") or ti.get("path") or "")
except: pass' 2>/dev/null)"
[ -z "$FP" ] && exit 0

case "${FP##*.}" in
  js|jsx|ts|tsx|mjs|cjs|html|css|py|go|rs) ;;
  *) exit 0 ;;
esac


PROGRESS_FILE="$PROJECT_ROOT/step_archive/progress.json"
[ -f "$PROGRESS_FILE" ] || exit 0
# The path goes in as an argument, never pasted into the Python source.
CUR="$(python3 -c 'import json,sys;print(int(json.load(open(sys.argv[1],encoding="utf-8")).get("current_step",1)))' "$PROGRESS_FILE" 2>/dev/null || echo 1)"
command -v node >/dev/null 2>&1 || exit 0
THRESHOLD="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/mx-stage.mjs" "$PROJECT_ROOT" 2>/dev/null)" || exit 0
case "$THRESHOLD" in ''|*[!0-9]*) exit 0 ;; esac
[ "$CUR" -lt "$THRESHOLD" ] && exit 0

case "$FP" in
  */step_archive/*|*/.claude/*|*/node_modules/*|*/.git/*|*/plugins/harness14/*|*/plugins/harness20/*|*/plugins/harness36/*|*/plugins/harness50/*) exit 0 ;;
esac
[ -f "$FP" ] || exit 0

# An exit-0 PostToolUse hook reaches Claude only through stdout additionalContext (its stderr is
# dropped), so the warning goes out as the same JSON with the same words as mx-tag-validator.ps1.
# json.dumps escapes every non-ASCII character, so the output does not depend on the locale. The two
# warnings exclude each other (tags present or not), so at most one is printed.
emit_warning() { python3 -c 'import json,sys;print(json.dumps({"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":sys.argv[1]}}))' "$1"; }

if grep -qE '@MX:(NOTE|WARN|ANCHOR|TODO)' "$FP" 2>/dev/null; then
  if grep -qE '@MX:(WARN|ANCHOR)' "$FP" && ! grep -q '@MX:REASON' "$FP"; then
    emit_warning "[@MX-WARN] $FP has WARN/ANCHOR but missing @MX:REASON sub-line — add // @MX:REASON: <근거>"
  fi
  log "OK [step=$CUR] $FP"
  exit 0
fi

log "[@MX-WARN] $FP has no @MX tags"
emit_warning "[@MX-WARN] $FP has no @MX tags (NOTE/WARN/ANCHOR/TODO) — add at top: // @MX:NOTE: <컨텍스트·의도>, 조건부로 @MX:WARN/@MX:ANCHOR(+@MX:REASON)/@MX:TODO (MoAI mx-tag-protocol SoT)"
exit 0
