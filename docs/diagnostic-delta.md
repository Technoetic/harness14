# Diagnostic identity comparison

Use this advisory evidence for repair triage within an active workflow generation. The host runs the compiler, linter or other diagnostic tool and explicitly normalizes its output. These APIs and the CLI only validate snapshots and write diagnostic metadata; they execute no commands and perform no repair, revert or retry loop. A comparison never grants quality PASS or completion. Existing zero-error quality checks remain authoritative.

## Explicit snapshot input

Both operations take the same schema-1 JSON object:

```json
{
  "schema_version": 1,
  "tool": {
    "id": "typescript",
    "version": "5.8.3",
    "configuration_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "files": ["src/app.js"],
  "diagnostics": [
    {
      "file": "src/app.js",
      "code": "TS1001",
      "severity": "error",
      "location": {"line": 1, "column": 1},
      "message": "An ordinary compiler finding."
    }
  ]
}
```

The host supplies the actual tool version and a SHA256 of the exact producing configuration; this module never guesses either. Select every source file covered by the snapshot explicitly, including files with no findings. Diagnostic paths must exactly match that selection. Coordinates are one-based; optional `end_line` and `end_column` must occur together and cannot precede the start. Severity is `error`, `warning`, `info` or `hint`. Tool identifiers, versions and diagnostic codes are bounded ASCII tokens. All fields are explicit; unknown fields and duplicate diagnostic identities are rejected.

An identity consists of file, code, severity, complete location and SHA256 of the exact UTF-8 message. Message changes therefore count as replacement findings. Only message digests persist or appear in results. Credential-shaped text is rejected with a generic failure; neither raw messages nor source contents are included in artifacts or output. Source hashes are computed from original bytes. No file search or bulk source scan occurs.

Input is limited to 64 KiB, 128 source paths and 512 diagnostics; every message is at most 4 KiB. Each source file is at most 1 MiB and the selected source set at most 16 MiB. TOPIC and workflow identity reads also have fixed bounds, with a 64 MiB aggregate request read budget including rechecks. Artifacts are at most 512 KiB, including a full replacement of all 512 findings. Strict JSON rejects duplicate keys, malformed UTF-8 and invalid structures. Object API input additionally rejects accessors, symbols, cycles and non-JSON values before serialization.

Paths are workspace-relative with `/` separators. Hidden, generated, dependency, private and credential-oriented paths are refused, as are traversal, Windows device names, alternate data streams, symlink/junction aliases and hard links. The active workflow profile, generation and approved TOPIC hash bind each artifact. Untagged legacy workspaces without a generation cannot create baselines. All selected files, TOPIC and workflow identity are rechecked before and after persistence. Failed or unstable requests yield no usable reference; a failure after writing may leave an unreferenced immutable metadata artifact.

## APIs

```js
import { captureDiagnostics, compareDiagnostics } from './scripts/lib/diagnostic-delta.mjs';

const captured = await captureDiagnostics(workspaceRoot, snapshot, {
  workflowProfile: 'planning-first-14-v1' // optional, must match active metadata
});
const compared = await compareDiagnostics(workspaceRoot, laterSnapshot, {
  baseline: captured.baseline, // exactly { id: UUID, sha256: originalBytesSha256 }
  workflowProfile: 'planning-first-14-v1'
});
```

Input can be a safe plain JSON object, a strict JSON string or a UTF-8 Buffer. Capture returns `status: "CAPTURED"`, `advisory: true`, the immutable `baseline: {id, sha256}` reference and sanitized metadata. Comparison requires both reference fields and returns `COMPARED` with `introduced`, `resolved`, `retained`, counts, and each file's `baseline_sha256` and `current_sha256`. A total of two findings can still mean one introduced, one resolved and one retained finding.

The selected file set must be identical across snapshots; input order does not matter. Source bytes may change during repairs. Tool identity, version, configuration, generation and TOPIC must remain compatible. Incompatible metadata yields `INCOMPARABLE`; missing, renamed, unsafe or changing sources, missing/modified baseline bytes and invalid inputs yield `INCOMPLETE`. A generation change makes the old reference unavailable in the new generation namespace. Errors contain no input values or absolute paths. None of these statuses is a quality verdict.

Artifacts use exclusive creation at `step_archive/outputs/diagnostics/<profile>/<generation>/baseline-<uuid>.json` and `comparison-<uuid>.json`. They are never overwritten. A reference cannot supply an arbitrary artifact path. Stored source paths are validated metadata only: comparison source reads use the independently supplied current selection. Keep the returned SHA256 reference with the handoff; reports and references are local evidence, not signed attestations. Reuse a comparison only while its source hashes, baseline digest, producing metadata and workflow identity remain current; run a new comparison after changes.

## CLI

Prepare a reviewed JSON snapshot outside the workspace root when appropriate, then send it through stdin. The CLI reads no arbitrary input file and accepts no tool commands:

```powershell
Get-Content -Raw snapshot.json | node <plugin-root>/scripts/diagnostic-delta.mjs capture --workspace <project-root> --input -
Get-Content -Raw later-snapshot.json | node <plugin-root>/scripts/diagnostic-delta.mjs compare --workspace <project-root> --input - --baseline-id <returned-uuid> --baseline-sha256 <returned-sha256>
```

Optional `--workflow-profile <id>` must match the active workflow. Exit 0 means the capture or advisory comparison succeeded; exit 1 means `INCOMPLETE` or `INCOMPARABLE`; exit 2 means invalid CLI arguments or oversized stdin. `--help` prints the syntax. There is no command-running mode, output-path override or baseline rewrite option.

MoAI's diagnostic-count regression check inspired this control. Harness14 compares diagnostic identities and immutable scope-bound snapshots, so equal-count replacements and changed producing configurations cannot silently appear unchanged.
