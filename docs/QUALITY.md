# Measured quality checks

Harness50 2.2 replaces the old Trust5 directory-presence score with measured checks. Missing tools, nonzero exits, timeouts, missing coverage and changed source never earn partial credit or PASS. These checks do not measure teaching effectiveness or visual taste.

Fresh planning-first14 quality gates are 4/8/14, with prefinal inspection after 13; explicit research-free36 retains 26/30/36 and prefinal35, and legacy50 retains 38/44/50 and prefinal49. New reports bind workflow_profile and workflow_generation (schema2); legacy schema1 reports keep their old meaning. Reset leftovers cannot satisfy the current run.

## Project checks

Create `harness50.quality.json` in the generated project. Each command is an executable/argument array, run without shell expansion from the project root. Configure already installed tools. On Windows use Node entry points instead of `.cmd` wrappers.

New workflow guidance uses configuration schema 2. First freeze the reviewed requirement inventory through [requirement coverage](requirement-coverage.md), then copy its returned hash into `requirements.inventory_sha256` below; the all-`a` hash is a placeholder. Intermediate gates validate this frozen binding. Both hosts' final completion additionally require current independent final QA evidence for every mapped check. Historical schema-1 configurations retain their previous semantics and cannot claim this requirement coverage.

```json
{
  "schema_version": 2,
  "requirements": { "inventory_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "checks": {
    "test": { "command": ["node", "node_modules/c8/bin/c8.js", "--reporter=json-summary", "node", "--test", "tests/app.test.mjs"] },
    "lint": { "command": ["node", "node_modules/@biomejs/biome/bin/biome", "check", "src"] },
    "typecheck": { "command": ["node", "node_modules/typescript/bin/tsc", "--noEmit", "-p", "jsconfig.json"] },
    "security": { "command": ["semgrep", "scan", "--config", "security-rules.yml", "--error", "--strict", "src"] }
  },
  "coverage": { "path": "coverage/coverage-summary.json", "minimum": 85 }
}
```

The example expects a project-specific test file, type configuration and reviewed local Semgrep rules; it does not install them. Security checks must use meaningful rules. An empty test or `exit 0` does not establish quality. Coverage is calculated from measured covered/total counts for lines, statements, functions and branches, each at least 85%; zero denominators are incomplete. The test command must generate fresh coverage evidence.

Before running tests, the runner removes the configured generated coverage report under `coverage/` so an earlier run cannot satisfy the gate. It captures the replacement immediately after the test command and rejects later changes to it.

Run explicitly with normal host permissions:

```text
node "<plugin-root>/scripts/quality-gate.mjs" --workspace "<project-root>"
node "<plugin-root>/scripts/quality-gate.mjs" --inspect --workspace "<project-root>"
```

Each command is bounded to two minutes and 1 MiB output. The report records exit codes without storing raw command output that could contain secrets. Diagnose failures in a normal foreground invocation. Source fingerprints exclude dependencies, Git metadata, coverage and `step_archive`; they include project configuration and final dist files. Changes require another run. Reports go to `step_archive/outputs/quality-gate.json`.

Claude's progress writer records a fresh Step 4 or 8 only when `quality-gate.mjs --inspect` reports PASS, and a fresh Step 14 only on the final PASS (`--inspect-final`); a refused completion is named in the next continue instruction. Unlike the Codex state manager, which inspects when a completion is submitted, the writer inspects at the next Stop against the sources as they are then: when a later step in the same turn changed them, the report is stale and `quality-gate.mjs` must run again. Claude Stop hooks also inspect saved evidence once 4, 8 and 13 contiguous steps are complete and write `trust5_r1.md`, `trust5_r2.md` and `trust5_r3.md`. They neither execute configured commands nor download tools. Missing or failed evidence requests a repair once; an already active Stop turn is not recursively blocked. Incomplete gates must not be presented as product completion. Codex steps explicitly run the same checks through normal permissions, and the state manager independently inspects current measured quality before accepting a new completion at 4, 8 or 14. It records the validated report digest; missing, failed or stale quality cannot create a new completion receipt. Explicit20 retains writer gates10/14/final20 and Stop inspections after10/14/19; explicit36 retains26/30/final36 and inspections after26/30/35; legacy50 retains38/44/final50 and inspections after38/44/49. Older receipts retain their historical recovery meaning.

## Final browser output

A passing schema-v3 browser report is required for fresh completion; which browser
backend produces it is free. Install one of the two [browser backends](BROWSER-TOOLS.md)
in a separate checkout, outside the plugin cache:

```text
git clone https://github.com/Technoetic/harness14.git
cd harness14

# Backend 1 — Playwright (CI, machines that allow it), isolated in browser-verifier/
cd browser-verifier && npm ci && npx playwright install chromium && cd ..

# Backend 2 — Aside CLI (machines without Playwright); the Aside app must be running
aside --version

node scripts/verify-output.mjs --probe
node scripts/verify-output.mjs --workspace "<project-root>" --backend auto
```

`--probe` prints which backends are available and which one `auto` would select,
without launching a browser. `--backend playwright|aside` (or the environment
variable `HARNESS50_BROWSER_BACKEND`) forces one; `auto` prefers Playwright and falls
back to Aside. Fresh environment Step 2 locks its actually available, explicitly permitted selection (explicit20 retains environment3; old36/50 retain their tool Step 3) in `step_archive/outputs/browser-backend.json`
with `node scripts/verify-output.mjs --probe --backend <selected> --lock --workspace "<project-root>"`.
Use `aside` as `<selected>` where Playwright is prohibited; do not install another backend
merely because a generic example lists it. After that, `auto` uses only the locked backend and fails instead of falling back, so
install and repair only that backend
([backend lock](BROWSER-TOOLS.md#backend-lock-step-3)). No hook installs browser packages. The verifier loads the exact
`dist/index.html` bytes at 1440×900 and 390×844. It blocks network dependencies and
WebSockets, reports JavaScript/console errors, detects horizontal overflow, checks
initial keyboard focus and runs axe WCAG A/AA checks. It records measured load timing
without converting it to a Lighthouse score. The single-file output must include
required styles, scripts and assets.

The HTML must also contain the [screen routing contract](ROUTING.md). Every independent
screen has a stable URL, with hash routing as the portable default. The verifier
checks each declared route at both viewport sizes, including direct entry, reload,
real link navigation, Back/Forward, URL-to-screen agreement and unknown-route fallback.
It repeats the complete checks with the Navigation API forcibly removed before
application startup, so an application that only works with the new API fails.
With the Playwright backend, `--executable-path "<browser-path>"` selects an installed
Chromium-based browser and each run uses fresh temporary browser contexts, never the
user's persistent profile. The Aside backend runs inside the user's own Aside Browser
(shared profile, visible tabs, no headless mode) and reproduces the same checks through
measured workarounds — iframe mobile viewport, server-injected init script, CSP-based
request blocking, per-chunk origins; its report discloses that in the `environment`
block (`backend`, `isolation`, `color_scheme`, `language`, `dpr`, `tool_version`, …),
so a reviewer can tell shared-profile evidence from fresh-context evidence.

The schema-v3 JSON report is `step_archive/outputs/browser-output.json`, bound to the
HTML SHA-256 and its exact embedded route inventory. Entry screenshots are
`step_archive/screenshots/verified-desktop.png` and `verified-mobile.png`; the report
also contains per-route measurements. The mandatory
`compatibility.navigation_api_unavailable.viewports` repeats the desktop/mobile
evidence; its screenshots use `verified-navigation-api-unavailable-desktop.png`
and `verified-navigation-api-unavailable-mobile.png` in the same directory. Both
scenarios share one deadline and the same network restrictions. Observed API
capability is diagnostic; project E2E must separately demonstrate native backend
use when supported. Failures return exit code 1. Review axe
`accessibility_incomplete` items manually. Keep application-specific E2E, keyboard,
mouse and visual review for states beyond the finite route inventory. History-mode
fallback inside the verifier does not establish that a deployment server has rewrites.

Fresh completion requires version 3 evidence with both scenarios, from either backend
(the gate reads named report fields only and ignores `environment`). Both hosts also
require a current [final regression report](QA-REPORTS.md#final-candidate-regression-at-step-14)
covering E2E, screenshots, keyboard, mouse, design and console on the same final HTML.
Fresh14, existing20 and retained research-free36 final regression also require a recorded independent verifier; a same-agent
report remains diagnostic and cannot satisfy that completion gate. Legacy50 keeps
its original evidence and recovery semantics.
Run these complete matrices after the last repair and build. Any subsequent
candidate change invalidates that assessment and requires rerunning the matrices.
Claude's writer inspects current quality, browser and regression evidence before
recording a fresh Step 14; its final Stop quality report covers all three.
`quality-gate.mjs --inspect-final --workspace "<project-root>"`
performs the same read-only inspection without launching browsers or project commands.
Historical completed records and Codex receipts retain their recovery semantics.

Codex completion independently validates final HTML structure and UTF-8 from the same stable handle it hashes. Submitted command results, quality reports and human inspection claims are local evidence, not signed attestations against a process that can rewrite its own project. Do not describe them as independent live-model benchmark results.

## QA feedback between attempts

Use the shared [QA report protocol](QA-REPORTS.md) to carry sanitized failed checks
and next actions between Claude and Codex attempts. Both hosts inspect the current
step's report before a relevant retry, snapshot explicit candidate files after
the build and before QA, then record that round before completion or failure
handoff. Changed candidate or evidence files make prior success claims stale.
The report does not run checks, discover product-specific requirements, change workflow
state or replace measured quality/browser evidence. Fresh Step 14 enforces the six final
regression categories and their final HTML binding. Failed, missing and
unexecuted required checks remain incomplete even when a retry limit is reached.

Schema-2 requirement coverage extends this declared check inventory with a reviewed,
immutable requirement-to-acceptance-to-check mapping. Final QA includes the six
regression categories and every mapped product check. Coverage inspection reuses
current QA evidence and rejects omissions, changed evidence, inventory mismatch
and incompatible workflow generations. It establishes completeness of the reviewed
list; it cannot discover unstated intent or authenticate an agent's observation.

Use [diagnostic comparison](diagnostic-delta.md) to distinguish introduced, resolved
and retained code findings during repairs. Both snapshots identify the producing
tool/version/configuration and exact selected source bytes. This is advisory triage;
the existing four quality commands and minimum coverage retain their authority.

## Jev-first typed judgments

User-requested Jev-first mode applies to all eligible current typed judgments,
including chat and arithmetic outside the fixed checkpoints. The additive
[direct adapter](jev-first.md) accepts explicit inline context without pretending
it is verified file evidence. Existing file judgments use their source-bound
adapters, policies and reports. Never reclassify denied file content as inline input.

Noul preserves the native probability without inventing confidence. Choice requires
an abstention option. Score preserves its ordered rubric, legend, probabilities and
weighted rating; it is not arbitrary numeric generation. Exact response validation
rejects unrequested IDs, types, categories and free-form explanations. Low confidence,
low Noul decisiveness, abstention and service failure return to host review. Current
facts and environmental observations require actual evidence before judging; missing
evidence does not prove a negative. These signals do not measure calibrated accuracy.

Reuse existing transmission authorization and matching results, with one caller and
one batch per unchanged request. No automatic retries, full-history upload or hidden
workspace collection. Mark validated Jev use or the host fallback reason explicitly.
Native typed judging does not generate arbitrary text/code, execute tools, grant
permission or replace deterministic tests, independent review or completion writers.

## Advisory semantic checkpoints

The [Jev checkpoint protocol](jev-checkpoints.md) adds bounded text judgments at
fresh14 steps 1, 2, 3, 9 and 13 (explicit research-free36 retains 17/18/25/31/35, and legacy50 retains 16/24/25/30/37/45/49). Hosts call it automatically only when the active
task authorizes Jev and sending the selected excerpts, reusing existing authorization.
It evaluates requirements, distinct alternatives,
explanation text, scenario coverage and finding classification. It does not execute
tests or inspect images. Fresh Step 3 persists selected implementation prose as evidence
first; the judgment concerns that text, not executable correctness.

Before reusing a report, compare current prepare metadata with inspect: request,
policy, input and source hashes must match, and unverified reports remain unverified.
Abstention, low confidence or unavailable service returns the decision to the host
and existing independent review. The default 0.8 threshold is a review heuristic,
not calibrated accuracy. Findings with insufficient evidence are not proven failures.
Local report consistency is not provider attestation. Required acceptance and the
measured quality, browser, E2E, visual, final-regression and completion gates retain
their authority. One batch per unchanged checkpoint is host policy, not a runtime quota.

## Release verification and product evaluation

`npm test` covers adapter/state/security contracts. `npm run test:browser` checks working and deliberately broken HTML fixtures in a real browser, always through the Playwright backend from `browser-verifier/` (the suite pins `backend: 'playwright'`; Aside runs are exercised manually with `node scripts/verify-output.mjs --backend aside`). Rating real generated tutorials also requires multiple topics, repeated full runs, cost/latency records and user evaluation. This release does not fabricate those results.

Explicit `planning-first-20-v1` runs keep environment3, implementation9, E2E15,
final20, quality10/14/20, QA11/16/17/18 and Jev1/2/9/15/19, with their original
profile/generation evidence paths. Existing20/36/50 bodies and indexes are preserved.
