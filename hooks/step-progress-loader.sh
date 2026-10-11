#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# step-progress-loader.sh — SessionStart hook (macOS/Linux)
set -u
RAW="$(cat || true)"
EVENT_CWD=""
if command -v python3 >/dev/null 2>&1; then
  EVENT_CWD="$(printf '%s' "$RAW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cwd", "") if isinstance(d,dict) else "")' 2>/dev/null || true)"
fi
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-${EVENT_CWD:-$PWD}}"

STEP_ARCHIVE="$PROJECT_ROOT/step_archive"
PROGRESS_FILE="$STEP_ARCHIVE/progress.json"
ARCHIVED_DIR="$STEP_ARCHIVE/archived"

[ -d "$STEP_ARCHIVE" ] || exit 0

# Codex coexistence (mirrors step-progress-loader.ps1): step_archive/.harness50-codex/state.json
# means the Codex state manager owns this workspace. Print one read-only context line
# (lib/codex-workflow.mjs) and never rewrite progress.json. Without that file nothing changes.
if [ -e "$STEP_ARCHIVE/.harness50-codex/state.json" ]; then
  CODEX_LINE=""
  if command -v node >/dev/null 2>&1; then
    CODEX_LINE="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/codex-workflow.mjs" "$PROJECT_ROOT" 2>/dev/null || true)"
  fi
  [ -n "$CODEX_LINE" ] || CODEX_LINE="[HARNESS] WARNING: step_archive/.harness50-codex/state.json exists but is unreadable or incomplete - Claude hooks will not create progress.json or block Stop here. Inspect it with the harness14 plugin's codex/scripts/harness-state.mjs show and ask the user before repairing or resetting it."
  printf '%s\n' "$CODEX_LINE"
  exit 0
fi

[ -f "$PROGRESS_FILE" ] || exit 0
# Shared profile/archive identity; invalid metadata never activates a mixed archive.
H50_PROFILE="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/workflow-profile.mjs" resolve "$PROJECT_ROOT" 2>/dev/null)" || exit 0
export H50_PROFILE
ARCHIVED_DIR="$PROJECT_ROOT/$(printf '%s' "$H50_PROFILE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["body_directory"])' | tr -d '\r')"


if ! command -v python3 >/dev/null 2>&1; then
  echo "=== harness20: Step Progress Loader (python3 missing — silent) ==="
  exit 0
fi

export PROGRESS_FILE ARCHIVED_DIR
python3 - <<'PY'
import json, os, datetime, re
p_path=os.environ.get("PROGRESS_FILE")
a_dir=os.environ.get("ARCHIVED_DIR")
profile=json.loads(os.environ["H50_PROFILE"])
# Same string as step-progress-loader.ps1 and step-obedience-guard (scripts/lib/pause-state.mjs).
# Python triple quotes keep the inner single quotes of NAMED.
CODES=('permission-denied','required-tool-failed','required-input-missing','user-request')
PAUSED='[HARNESS] PAUSED at step{STEP}/{TOTAL} (reason={REASON}{SINCE}). Automatic continuation is off: do not run steps. Tell the user why (pause_note in step_archive/progress.json) and handle their message. Resume only when the user explicitly asks: /harness-resume.'
NAMED='''Early stop only as a named pause (permission-denied | required-tool-failed | required-input-missing; harness-rules 2-1): save evidence under step_archive/, run node "<plugin-root>/scripts/harness-pause.mjs" pause --workspace "<project-root>" --reason <code> --evidence <step_archive/file> --note '<user action, no quotes>', then end the turn with the pause report.'''
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
    with open(p_path,encoding="utf-8") as f: p=json.load(f)
except Exception: raise SystemExit(0)

# Named pause (harness-rules 2-1). Only scripts/harness-pause.mjs sets or clears it. While it is set
# nothing is written and only where the run stopped is printed (mirrors step-progress-loader.ps1).
if isinstance(p,dict) and (('paused' in p and p['paused'] is not False) or p.get('status')=='paused'):
    try:
        total=int(p.get("total_steps",50))
        completed=set(int(x) for x in (p.get("completed_steps") or []))
    except Exception: raise SystemExit(0)
    first=next((n for n in range(1,total+1) if n not in completed),0)
    if first:
        step,line=paused_line(p,total,first)
        print(f"=== Paused at step{step:03d} ===")
        print(line)
        raise SystemExit(0)

import glob
# Report only (mirrors the .ps1 loader): rewriting total_steps could flip the run's activity.
directories=[a_dir,os.path.dirname(a_dir)] if profile["workflow_profile"]=="legacy-50-v1" else [a_dir]
actual=len({os.path.basename(x) for d in directories for x in glob.glob(os.path.join(glob.escape(d),"step???.md"))})
p.setdefault("metrics",{"total_sessions":0,"total_duration_minutes":0,"steps_per_session_avg":0})
p["metrics"]["total_sessions"]=int(p["metrics"].get("total_sessions",0))+1
p["last_updated"]=datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
tmp=p_path+f".tmp.{os.getpid()}"
with open(tmp,"w",encoding="utf-8") as f: json.dump(p,f,ensure_ascii=False,indent=2)
os.replace(tmp,p_path)

done=len(p.get("completed_steps") or [])
cur=next((n for n in range(1,int(p.get("total_steps",50))+1) if n not in (p.get("completed_steps") or [])),int(p.get("total_steps",50)))
total=int(p.get("total_steps",50))
print("=== harness20: Step Progress Loader ===")
if actual>0 and actual!=p.get("total_steps"):
    print(f"WARNING: total_steps mismatch (progress.json={p.get('total_steps', '')}, filesystem={actual}).")
print(f"Progress: {done}/{total} completed")
print(f"Current step: step{cur:03d}")
if done<total:
    completed=set(int(x) for x in (p.get("completed_steps") or []))
    nxt=None
    for i in range(1,total+1):
        if i not in completed: nxt=i; break
    if nxt:
        next_fmt=f"step{nxt:03d}"
        path=os.path.join(a_dir,f"{next_fmt}.md")
        rel=profile["body_directory"]+f"/{next_fmt}.md"
        if not os.path.isfile(path):
            path=os.path.join(os.path.dirname(a_dir),f"{next_fmt}.md")
            rel=f"step_archive/{next_fmt}.md"
        if os.path.isfile(path):
            print()
            print("=== HARNESS50 OBEDIENCE ===")
            print(f"ABSOLUTE OVERRIDE: Your first action this session is to Read {rel}, unless the user explicitly redirected.")
            print("Do not greet the user. Do not ask what to do. Do not handle unrelated requests first.")
            print(f"Read {next_fmt}.md NOW, then execute it, then move to the next step.")
            print("Each step file ends with 'Read step(N+1).md immediately upon completion'; obey that chain.")
            print(NAMED)
PY
exit 0
