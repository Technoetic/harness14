# Installed instruction size

Run `node scripts/instruction-budget.mjs` against the shipped plugin tree. To inspect
an explicit physical plugin copy, use `--root ROOT`. A reviewed alternative registry
may be selected with `--registry docs/custom-budget.json`; it must preserve the
same mandatory delivery contract and supported schema. Exit 0 means `PASS`; exit
2 means `INCOMPLETE` or invalid CLI input. Inspection treats instruction prose as
data, follows no Markdown imports, executes no prose or commands, and changes no files.

The shared interface is `inspectInstructionBudget(pluginRoot, options = {})` from
`scripts/lib/instruction-budget.mjs`. The only supported option is `registryPath`,
a safe plugin-relative `*-budget.json` path under `scripts/` or `docs/`. The default registry
is `scripts/instruction-budget.json`. Unsupported options and registry fields fail
closed. Output contains paths, SHA256 hashes, UTF-8 byte sizes, Unicode code-point
counts, UTF-16 code-unit counts, delivery surfaces and sanitized issue codes. It
does not contain instruction bodies or submitted invalid paths.

The registry covers the current `planning-first-14-v1` delivery in both hosts:
Codex base/control skills, Claude base rules/commands, fourteen selected-step
bodies per host, role instructions, and explicit companion documents. Historical
20/36/50 profile bodies are outside this guard and remain unchanged. This bounded
scope does not claim to inventory every installed Markdown file.

Each surface sums all its registered installed files. Selected-step totals include
all fourteen shipped bodies for that host; they do not imply that fourteen bodies
are loaded together. Harness14 already selects one step body through the manager
and reads companion material when needed. This control adds a source inventory and
CI limit, preserving that existing loading behavior.

These are static original-byte and character measurements. Runtime loaded context,
tokens and billing are **not measured**. Unicode characters mean code points, not
grapheme clusters: `A한😀` contains three code points, four UTF-16 units and eight
UTF-8 bytes. Existing selected task-context JSON budgets are a separate control.

Registry schema 1 declares `files` with `path`, `surface`, `max_bytes` and
`max_unicode_characters`; `surfaces` declare `id`, `delivery` and both limits;
`required_references` declare explicit `from` and `to` paths. Every declared file
is mandatory. An independent delivery contract prevents removing a required file,
moving it into the wrong surface, or dropping the three companion-document
references from either host's base instructions. Reference validation checks the
declared source and target files' physical availability and literal target-path
presence in the measured source. It does not interpret prose, parse Markdown or
follow imports.

Initial limits come from this repository's measured source rather than MoAI's
rules-only thresholds. Before this change, Codex's base skill was 24,210 bytes and
Claude's base rules were 24,760 bytes; the largest current step was 23,238 bytes and
the largest registered companion document was 25,469 bytes. The 32 KiB file cap
leaves space for concise safety and control references. Codex's base surface has
64 KiB, Claude's base has 32 KiB, each selected-step surface has 192 KiB, and
companion documents have 320 KiB. Changes must preserve required instructions;
do not truncate safety obligations to satisfy a limit. Review limit adjustments
with their measured growth and delivery purpose.

The hard input ceiling is 128 explicit files, 128 references and 128 KiB per file
or registry; per-surface ceilings cannot exceed 16 MiB. Duplicate JSON keys,
duplicate/case-aliased paths, unsupported schema, unknown file/reference paths,
invalid bounds, credential-shaped registry paths, malformed UTF-8, symbolic links,
reparse aliases and hard links are rejected. Roots must resolve to physical
directories. Reads use existing bounded safe-file helpers and an aggregate budget;
there is no tree scan, dependency traversal, credential lookup or prose execution.

MoAI's rules-only total budget inspired this control. Harness14's adaptation uses
explicit delivery surfaces, original UTF-8 bytes, Unicode metrics, mandatory
instruction/reference availability and bounded physical reads. It makes no token
or cost-savings claim.
