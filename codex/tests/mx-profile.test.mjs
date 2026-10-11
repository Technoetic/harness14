// Regression: compact profiles used to skip MX advice throughout implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installPlugin, runClaudeHook, tempRoot, nativeVariant, gitBash, windows } from './helpers/claude-hooks.mjs';

function fixture(t, profile, total, current) {
  const base = tempRoot(t, 'h20-mx-profile-');
  const plugin = installPlugin(base);
  const project = join(base, 'project [3]');
  mkdirSync(join(project, 'step_archive/TOPIC'), { recursive: true });
  mkdirSync(join(project, 'src'));
  const file = join(project, 'src', 'plain.js');
  writeFileSync(file, 'export const measured = 1;\n');
  writeFileSync(join(project, 'step_archive/TOPIC/TOPIC.md'), '# Public synthetic topic\n');
  const state = { schema_version: 2, workflow_profile: profile, total_steps: total,
    current_step: current, completed_steps: Array.from({ length: current - 1 }, (_, i) => i + 1),
    failed_steps: [], run_started_at: '2026-10-10T03:00:00.000Z' };
  writeFileSync(join(project, 'step_archive/progress.json'), JSON.stringify(state));
  writeFileSync(join(project, 'step_archive/workflow-profile.json'), JSON.stringify({
    schema_version: 2, workflow_profile: profile, total_steps: total }));
  return { plugin, project, file, state };
}

const spell = path => windows && nativeVariant === 'sh' ? path.replaceAll('\\', '/') : path;
function run(f, variant = nativeVariant) {
  return runClaudeHook(f.plugin, 'mx-tag-validator', { hook_event_name: 'PostToolUse',
    cwd: spell(f.project), tool_name: 'Write', tool_input: { file_path: spell(f.file) } },
    { variant, stripCR: true });
}

for (const [profile, total, threshold] of [
  ['planning-first-20-v1', 20, 9], ['research-free-36-v1', 36, 25],
  ['planning-first-14-v1', 14, 3],
]) test(`${profile} warns at implementation and stays quiet immediately before it`, t => {
  const f = fixture(t, profile, total, threshold - 1);
  const before = run(f);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.stdout.trim(), '');
  f.state.current_step = threshold;
  f.state.completed_steps.push(threshold - 1);
  writeFileSync(join(f.project, 'step_archive/progress.json'), JSON.stringify(f.state));
  const at = run(f);
  assert.equal(at.status, 0, at.stderr);
  assert.match(JSON.parse(at.stdout).hookSpecificOutput.additionalContext, /has no @MX tags/);
});

test('unknown or conflicting profile metadata never guesses an implementation coordinate', t => {
  const f = fixture(t, 'planning-first-20-v1', 20, 16);
  for (const state of [{ ...f.state, workflow_profile: 'unregistered-20' },
    { ...f.state, total_steps: 19 }, { ...f.state, current_step: 16.5 }]) {
    writeFileSync(join(f.project, 'step_archive/progress.json'), JSON.stringify(state));
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
  }
  writeFileSync(join(f.project, 'step_archive/progress.json'), JSON.stringify(f.state));
  writeFileSync(join(f.project, 'step_archive/workflow-profile.json'), JSON.stringify({
    schema_version: 2, workflow_profile: 'research-free-36-v1', total_steps: 36 }));
  assert.equal(run(f).stdout.trim(), '');
});

test('bash MX hook also warns at old20 implementation9', { skip: windows && !gitBash }, t => {
  const f = fixture(t, 'planning-first-20-v1', 20, 9);
  const result = run(f, 'sh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /has no @MX tags/);
});

test('bash MX hook excludes harness14 installed files and preserves legacy exclusions', { skip: windows && !gitBash }, t => {
  const f = fixture(t, 'planning-first-14-v1', 14, 3);
  const ordinary = run({ ...f, project: f.project.replaceAll('\\', '/'), file: f.file.replaceAll('\\', '/') }, 'sh');
  assert.match(JSON.parse(ordinary.stdout).hookSpecificOutput.additionalContext, /has no @MX tags/);
  for (const name of ['harness14', 'harness20', 'harness36', 'harness50']) {
    const directory = join(f.project, 'plugins', name);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'installed.js');
    writeFileSync(file, 'export const installed = 1;\n');
    const result = run({ ...f, project: f.project.replaceAll('\\', '/'), file: file.replaceAll('\\', '/') }, 'sh');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '', name);
  }
});
