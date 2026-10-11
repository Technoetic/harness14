---
name: harness14-reset
description: Use when a user invokes $harness14-reset or asks to stop the current Harness14 Codex workflow in a recoverable way.
---

# Harness14 Reset

Reset ends Codex control of the current workflow without disturbing the work the workflow produced.

## Resources

Resolve `../../scripts/harness-state.mjs` relative to this SKILL.md, not from the current working directory. Pass the current project directory as the workspace.

Existing receipt/archive profile meanings stay unchanged. Reset deactivates the
selected workflow; only a later explicit new start selects `planning-first-14-v1`, total14.
Existing research-free36 and legacy50 archives are never renumbered.

## Reset operation

For `$harness14-reset`, Call only `reset` through the state manager to recoverably deactivate only Codex control metadata. If the manager returns an error, report it and stop without a filesystem fallback.

## Preserved data and result

- Report the returned `backupPath` so the deactivated Codex metadata remains recoverable.
- Preserve Claude `step_archive/progress.json`, `TOPIC`, all shared outputs, and all project and application source.
- Leave the workspace contents and Claude-owned progress unchanged; the state manager alone handles Codex control metadata.
- No workflow starts automatically after reset. End the request and report what was preserved. The user chooses the next action explicitly.
