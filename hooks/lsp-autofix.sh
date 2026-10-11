#!/usr/bin/env bash
# Windows guard: skip on git-bash / MSYS / Cygwin (ps1 counterpart runs there)
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
# lsp-autofix.sh - PostToolUse(Write|Edit) hook (macOS/Linux)
set -u
RAW="$(cat || true)"
EVENT_CWD=""
if command -v python3 >/dev/null 2>&1; then
  EVENT_CWD="$(printf '%s' "$RAW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cwd", "") if isinstance(d,dict) else "")' 2>/dev/null || true)"
fi
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-${EVENT_CWD:-$PWD}}"
LOG_FILE="$(dirname "${BASH_SOURCE[0]}")/lsp-autofix.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true; }

[ -z "$RAW" ] && exit 0
command -v python3 >/dev/null 2>&1 || exit 0

FP="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); ti=d.get("tool_input") or {}
  print(ti.get("file_path") or ti.get("path") or "")
except: pass' 2>/dev/null)"
[ -z "$FP" ] && exit 0

EXT="${FP##*.}"
case "$EXT" in
  js|jsx|ts|tsx|mjs|cjs) KIND="js" ;;
  css|scss) KIND="css" ;;
  *) exit 0 ;;
esac

# Only files whose path relative to the project root starts with src/ (a relative input is read
# from the project root; mirrors lsp-autofix.ps1).
REL="$(python3 -c 'import os,sys; print(os.path.relpath(os.path.join(sys.argv[1], sys.argv[2]), sys.argv[1]).replace(os.sep, "/"))' "$PROJECT_ROOT" "$FP" 2>/dev/null)" || exit 0
case "$REL" in
  src/*) ;;
  *) exit 0 ;;
esac
case "/$REL" in
  */node_modules/*|*/.git/*|*/step_archive/*|*/.claude/*) exit 0 ;;
esac
case "$FP" in
  */plugins/harness14/*|*/plugins/harness20/*|*/plugins/harness36/*|*/plugins/harness50/*) exit 0 ;;
esac


cd "$PROJECT_ROOT" || exit 0

# Only a project-local biome/stylelint runs, through `npx --no-install`: nothing is downloaded,
# and a package that sits only in the npx cache is not used.
if [ "$KIND" = "js" ]; then
  if [ ! -f "$PROJECT_ROOT/node_modules/@biomejs/biome/package.json" ]; then
    log "biome skipped (no local @biomejs/biome): $FP"
  elif npx --no-install @biomejs/biome check --write "$FP" >/dev/null 2>&1; then
    log "biome OK: $FP"
  else
    log "biome diag: $FP"
    echo "[LSP-AUTOFIX] biome: $FP" 1>&2
  fi
fi
if [ "$KIND" = "css" ]; then
  if [ ! -f "$PROJECT_ROOT/node_modules/stylelint/package.json" ]; then
    log "stylelint skipped (no local stylelint): $FP"
  elif npx --no-install stylelint --fix "$FP" >/dev/null 2>&1; then
    log "stylelint OK: $FP"
  else
    log "stylelint diag: $FP"
    echo "[LSP-AUTOFIX] stylelint: $FP" 1>&2
  fi
fi
exit 0
