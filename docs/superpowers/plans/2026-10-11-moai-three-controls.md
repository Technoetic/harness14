# MoAI three controls implementation plan

> For agentic workers: use superpowers:subagent-driven-development for independent components, with root integration and fresh whole-branch review. User authorization: “3가지 진행해”.

**Goal:** Add frozen requirement coverage, installed instruction size limits and diagnostic identity comparison without adding workflow steps.

**Architecture:** Three bounded shared Node modules/CLIs, existing safe-file and workflow identity helpers, schema-2 quality configuration and shared final completion validation. Preserve schema-1 configurations and historical runs.

**Tech Stack:** Node >=22, ESM, standard library, node:test; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-11-moai-three-controls-design.md`.

## Global constraints

- Existing 14-step topology, historical profiles and required quality thresholds remain.
- No automatic command execution, workflow starts, hook trust changes, private bulk reads or NS remote push.
- Every persistent artifact uses safe physical paths, bounded reads, strict JSON, generation binding and original-byte hashes.
- Actual test executions and independent review are required before completion claims.

## Review focus

1. Missing requirement or renamed mandatory check must remain incomplete.
2. Equal diagnostic counts must not hide replacement errors.
3. Changed generation, tool/configuration, inventory or evidence must invalidate reuse.
4. Duplicate JSON keys, oversized inputs, unsafe/aliased paths and credential-shaped fields must be rejected.
5. Existing schema-1 quality and older profile receipts must retain their semantics.

## Task 1 — Requirement engine

Files: `scripts/lib/requirement-coverage.mjs`, `scripts/requirement-coverage.mjs`, `codex/tests/requirement-coverage.test.mjs`, `docs/requirement-coverage.md`.

Interfaces: `freezeRequirements(workspaceRoot,input,options={})`, `inspectRequirementInventory(workspaceRoot,options={})`, `inspectRequirementCoverage(workspaceRoot,options={})`. Inventory input: schema version 1, `requirements:[{id,acceptance_ids}]`, `acceptance:[{id,check_ids}]`; all references explicit and nonempty. Options may carry expected `inventorySha256` and existing `workflowProfile`.

- [x] Write behavioral tests for missing links, duplicate IDs, frozen inventory overwrite, current final QA evidence, changed evidence and generation mismatch.
- [x] Run focused tests and record actual RED.
- [x] Implement immutable generation-bound inventory and coverage inspection using `inspectQa` at the profile's final step.
- [x] Run focused tests and CLI tests; record GREEN.

## Task 2 — Instruction size engine

Files: `scripts/lib/instruction-budget.mjs`, `scripts/instruction-budget.mjs`, `scripts/instruction-budget.json`, `codex/tests/instruction-budget.test.mjs`, `docs/instruction-budget.md`.

Interfaces: `inspectInstructionBudget(pluginRoot,options={})` returns sanitized measured inventory and `PASS`/`INCOMPLETE`; CLI selects explicit shipped registry and never executes loaded prose. Limits are clearly labeled bytes/static characters, with delivery surfaces distinct from actual runtime context.

- [x] Write tests for real files growing over limits, missing mandatory entries, wrong delivery/reference, duplicate paths, unsafe aliases and bounds.
- [x] Run focused tests and record RED.
- [x] Implement explicit registry, safe reads and deterministic size checks without losing mandatory instructions.
- [x] Run GREEN; root wires the shipped-tree command into CI.

## Task 3 — Diagnostic engine

Files: `scripts/lib/diagnostic-delta.mjs`, `scripts/diagnostic-delta.mjs`, `codex/tests/diagnostic-delta.test.mjs`, `docs/diagnostic-delta.md`.

Interfaces: `captureDiagnostics(workspaceRoot,input,options={})`, `compareDiagnostics(workspaceRoot,input,options={})`. Capture explicitly selected source files plus tool ID/version/configuration SHA256 and normalized diagnostics. Compare requires a returned immutable baseline reference and matching tool/configuration/scope; source contents may change and both snapshots record their hashes. Output identity-level introduced/resolved/retained findings; raw messages absent.

- [x] Write tests for equal-count replacement, repeat comparison, mismatched tool/config/generation/scope, modified baseline, duplicate diagnostic identities, private paths and bounds.
- [x] Record RED, implement bounded snapshots and sanitized identity comparison, record GREEN.

## Task 4 — Integration and completion

Files: `scripts/lib/quality.mjs`, `scripts/quality-gate.mjs`, `codex/scripts/lib/acceptance.mjs`, both host workflow instructions, `docs/QUALITY.md`, README attribution, CI and integration tests.

- [x] Write RED integration tests proving schema-2 inventory is mandatory and final QA omission blocks both hosts while schema 1 remains compatible.
- [x] Implement shared inventory binding and final requirement gate, including rechecks after candidate/evidence callbacks.
- [x] Add concise workflow references and schema-2 examples; require diagnostics for repair triage without changing quality authority.
- [ ] Run focused GREEN, full `npm test`, pinned-dependency audit and fresh independent review.
- [ ] Commit reviewed source, record exact evidence and apply the session's authorized release/installation workflow after validation.
