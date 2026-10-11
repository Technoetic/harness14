#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# step-obedience-guard.sh — UserPromptSubmit hook (macOS/Linux)
set -u
RAW="$(cat || true)"
EVENT_CWD=""
if command -v python3 >/dev/null 2>&1; then
  EVENT_CWD="$(printf '%s' "$RAW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cwd", "") if isinstance(d,dict) else "")' 2>/dev/null || true)"
fi
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-${EVENT_CWD:-$PWD}}"

PROGRESS_FILE="$PROJECT_ROOT/step_archive/progress.json"
ARCHIVED_DIR="$PROJECT_ROOT/step_archive/archived"
# Codex coexistence (mirrors step-obedience-guard.ps1): no Claude step reminder while the
# Codex state manager owns this workspace.
if [ -e "$PROJECT_ROOT/step_archive/.harness50-codex/state.json" ]; then exit 0; fi
[ -f "$PROGRESS_FILE" ] || exit 0
# Shared profile/archive identity; invalid metadata never activates a mixed archive.
H50_PROFILE="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/workflow-profile.mjs" resolve "$PROJECT_ROOT" 2>/dev/null)" || exit 0
export H50_PROFILE
ARCHIVED_DIR="$PROJECT_ROOT/$(printf '%s' "$H50_PROFILE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["body_directory"])' | tr -d '\r')"


# Parse progress without jq. Without python3 the state is unknown, so say nothing rather than
# invent one. tr drops the CR that a Windows python prints, which would break the numbers below.
command -v python3 >/dev/null 2>&1 || exit 0

# The commands that control the run itself (/harness-pause, /harness-resume, /harness-status,
# /harness-reset) get no reminder, paused or not (mirrors step-obedience-guard.ps1). An explicit
# /webapp <topic> gets no PAUSED line (below).
CONTROL="$(printf '%s' "$RAW" | python3 -c 'import json,re,sys
d=json.load(sys.stdin)
p=d.get("prompt") if isinstance(d,dict) else None
print("control" if isinstance(p,str) and re.match(r"\s*/(harness(14|20|36|50):)?harness-(pause|resume|status|reset)(\s|$)",p) else "webapp" if isinstance(p,str) and re.match(r"[ \t]*/(harness(14|20|36|50):)?webapp[ \t]+\S",p) else "")' 2>/dev/null || true)"
case "$CONTROL" in control*) exit 0 ;; esac

# The fourth field is '-' or the validated PAUSED line of a named pause (harness-rules 2-1); read
# gives the last variable the rest of the line.
TOTAL=""; DONE=""; NEXT=""; PAUSED_LINE=""
read -r TOTAL DONE NEXT PAUSED_LINE < <(python3 - "$PROGRESS_FILE" <<'PY' | tr -d '\r'
import json,re,sys
# Same bytes as step-obedience-guard.ps1 and step-progress-loader (scripts/lib/pause-state.mjs).
CODES=('permission-denied','required-tool-failed','required-input-missing','user-request')
PAUSED='[HARNESS] PAUSED at step{STEP}/{TOTAL} (reason={REASON}{SINCE}). Automatic continuation is off: do not run steps. Tell the user why (pause_note in step_archive/progress.json) and handle their message. Resume only when the user explicitly asks: /harness-resume.'
def paused_line(p,total,first):
    # Validated values only: a known code, a step inside 1..total, an ISO paused_at. pause_note and
    # pause_evidence are never printed. The step is max(paused_step, first unfinished): the Stop
    # writer records the completions of the turn that paused after the pause itself.
    step=p.get('paused_step')
    step=max(step,first) if isinstance(step,int) and not isinstance(step,bool) and 1<=step<=total else first
    code=p.get('pause_reason') if p.get('pause_reason') in CODES else 'unknown'
    at=p.get('paused_at')
    since=', since '+at if isinstance(at,str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z',at) else ''
    return step, PAUSED.replace('{STEP}',f'{step:03d}').replace('{TOTAL}',str(total)).replace('{REASON}',code).replace('{SINCE}',since)
try:
    p=json.load(open(sys.argv[1],encoding="utf-8"))
    total=int(p.get("total_steps",50))
    done=p.get("completed_steps") or []
    done_set=set(int(x) for x in done)
except Exception:
    raise SystemExit(0)
nxt=None
for i in range(1,total+1):
    if i not in done_set: nxt=i; break
line='-'
if nxt is not None and (('paused' in p and p['paused'] is not False) or p.get('status')=='paused'):
    line=paused_line(p,total,nxt)[1]
print(total, len(done), nxt if nxt is not None else 0, line)
PY
)
case "$TOTAL:$DONE:$NEXT" in
  *[!0-9:]*|:*|*::*|*:) exit 0 ;;
esac

[ "$DONE" -ge "$TOTAL" ] && exit 0
[ "$NEXT" = "0" ] && exit 0

# Named pause: that one line only, no step reminder (mirrors step-obedience-guard.ps1). An explicit
# /webapp <topic> is answered by webapp-trigger, which runs for the same prompt (in parallel); a
# PAUSED line would contradict that answer.
if [ -n "$PAUSED_LINE" ] && [ "$PAUSED_LINE" != "-" ]; then
  case "$CONTROL" in webapp*) exit 0 ;; esac
  printf '%s\n' "$PAUSED_LINE"
  exit 0
fi

# archived/ first, then the flat step_archive/ copy (mirrors step-obedience-guard.ps1).
NEXT_FMT="$(printf 'step%03d' "$NEXT")"
if [ -f "$ARCHIVED_DIR/$NEXT_FMT.md" ]; then
  NEXT_REL="$(printf '%s' "$H50_PROFILE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["step_body"])' | tr -d '\r')"
elif [ -f "$PROJECT_ROOT/step_archive/$NEXT_FMT.md" ]; then
  NEXT_REL="step_archive/$NEXT_FMT.md"
else
  exit 0
fi

# Same single line as step-obedience-guard.ps1.
printf '[HARNESS] %s/%s done. Next: %s (read+execute, no user confirmation). User direct requests still take priority.\n' "$DONE" "$TOTAL" "$NEXT_REL"
exit 0
