#!/usr/bin/env node
import { runQualityGate, inspectQualityReport, prepareQualityGate, inspectRequirementCompletion } from './lib/quality.mjs';
import { physicalWorkspace, readSafe, writeSafe } from './lib/quality-files.mjs';
import { inspectBrowserOutput } from './lib/final-output.mjs';
import { inspectFinalRegression } from './lib/final-regression.mjs';

import { workflowContext } from './lib/workflow-context.mjs';
import { resolveWorkflowProfile } from './lib/workflow-profiles.mjs';

async function inspectFinalOutput(workspaceRoot) {
  const context = await workflowContext(await physicalWorkspace(workspaceRoot));
  const [quality, browser, regression, requirements] = await Promise.all([
    inspectQualityReport(workspaceRoot), inspectBrowserOutput(workspaceRoot), inspectFinalRegression(workspaceRoot, context.profile.id),
    inspectRequirementCompletion(workspaceRoot)
  ]);
  const required = requirements.verdict !== 'NOT_CONFIGURED';
  const passed = quality.verdict === 'PASS' && browser.verdict === 'PASS' && regression.verdict === 'PASS'
    && (!required || requirements.verdict === 'PASS');
  return { verdict: passed ? 'PASS' : 'INCOMPLETE', quality, browser, regression,
    ...(required ? { requirements } : {}),
    ...(passed ? {} : { error: `Final evidence incomplete: quality=${quality.verdict}, browser=${browser.verdict}, regression=${regression.verdict}${required ? `, requirements=${requirements.verdict}` : ''}. ${quality.error ?? ''} ${browser.error ?? ''} ${regression.error ?? ''}`.trim() }) };
}

async function main() {
  const args = process.argv.slice(2);
  const hook = args.includes('--hook');
  const inspectFinal = args.includes('--inspect-final');
  const inspect = hook || inspectFinal || args.includes('--inspect');
  const prepare = args.includes('--prepare');
  const configHashIndex = args.indexOf('--config-sha256');
  const approvedConfigSha256 = configHashIndex < 0 ? undefined : args[configHashIndex + 1];
  if (configHashIndex >= 0 && !/^[a-f0-9]{64}$/.test(approvedConfigSha256 ?? '')) throw new Error('--config-sha256 requires the exact approved 64-character lowercase SHA256');
  if (prepare && (inspect || hook)) throw new Error('--prepare cannot be combined with inspection or hook modes');
  let event = {};
  if (hook) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) throw new Error('Hook event exceeds size limit');
    }
    try { event = JSON.parse(input || '{}'); } catch { return; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
  }
  const workspaceOption = args.indexOf('--workspace');
  const workspaceRoot = workspaceOption >= 0 ? args[workspaceOption + 1] : process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();
  if (!workspaceRoot) throw new Error('--workspace requires a directory');
  if (prepare) { console.log(JSON.stringify(await prepareQualityGate(workspaceRoot), null, 2)); return; }
  let round, finalStep = 50;
  if (hook) {
    // Shared judgement (hooks/lib/harness-activity.mjs), loaded only here: the non-hook modes
    // must keep working without hooks/ next to scripts/.
    const { codexOwned, classifyProgress } = await import('../hooks/lib/harness-activity.mjs');
    let physicalRoot;
    try { physicalRoot = await physicalWorkspace(workspaceRoot); } catch { return; }
    // Codex coexistence: any entry at step_archive/.harness50-codex/state.json means the Codex state
    // manager owns completion here, so a stale Claude progress.json next to it never drives this Stop gate.
    if (codexOwned(physicalRoot)) return;
    let progress;
    try { progress = JSON.parse((await readSafe(physicalRoot, 'step_archive/progress.json')).toString('utf8').replace(/^\uFEFF/, '')); }
    catch { return; }
    // Paused, stopped or structurally invalid runs release the gate; the milestone rules follow.
    const run = classifyProgress(progress);
    if (!['running', 'finished'].includes(run.phase)) return;
    const profile = resolveWorkflowProfile(progress);
    const total = profile.stepCount; finalStep = profile.milestones.final;
    const [quality1, quality2] = profile.milestones.quality;
    const done = progress.completed_steps;
    if (!Array.isArray(done) || done.length > total || done.some((n, i) => n !== i + 1) || done.length < quality1) return;
    // The final writer retains step 50; accept the exhausted cursor 51 as well.
    if (!Number.isInteger(progress.current_step) ||
        (done.length < total ? progress.current_step !== done.length + 1 : ![total, total + 1].includes(progress.current_step))) return;
    round = done.length >= finalStep - 1 ? 'r3' : done.length >= quality2 ? 'r2' : 'r1';
  }
  const final = inspectFinal || round === 'r3';
  const report = final ? await inspectFinalOutput(workspaceRoot)
    : inspect ? await inspectQualityReport(workspaceRoot) : await runQualityGate(workspaceRoot, { approvedConfigSha256 });
  if (hook) {
    const root = await physicalWorkspace(workspaceRoot);
    const md = `# TRUST5 measured quality - ${round}\n\nVerdict: ${report.verdict}\n\nChecks: test, lint, typecheck, security; measured coverage >= 85%.${final ? ' Current HTML, schema-v3 browser routing evidence for both API scenarios, and all six final regression matrices are also required.' : ''}\nNo directory-presence scores or partial credit.\n\n${report.error ?? 'All required evidence passed inspection.'}\n\nEvidence: quality-gate.json${final ? `, browser-output.json, Step${finalStep} immutable QA report` : ''}. This is local evidence, not a signed attestation.\n`;
    await writeSafe(root, `step_archive/outputs/trust5_${round}.md`, md);
    if (report.verdict !== 'PASS' && event.stop_hook_active !== true) {
      console.log(JSON.stringify({ decision: 'block', reason: 'Harness20 quality evidence is missing, failed or stale. Configure harness50.quality.json and explicitly run node "<plugin-root>/scripts/quality-gate.mjs" --workspace "<project-root>". ' + (final ? `Also run the browser verifier for every declared route in both API scenarios, then snapshot, rerun and record all six Step${finalStep} regression matrices on the final HTML as described in docs/QA-REPORTS.md. ` : '') + 'Read docs/QUALITY.md. Repair failed checks before claiming this milestone complete.' }));
    }
    return;
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== 'PASS') process.exitCode = 1;
}

main().catch(error => { console.error(`Harness20 quality: ${error.message}`); process.exitCode = 1; });
