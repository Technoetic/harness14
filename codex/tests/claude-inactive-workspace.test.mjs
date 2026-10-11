// Claude hooks through the installed dispatcher (node hooks/run-hook.mjs <name>, as hooks.json
// runs them) in folders that have no active Harness50 run: harmless events may not create files,
// grant permissions or inject step instructions. Existing workflow metadata keeps the execution
// guards on even when stale, stopped or invalid; unsafe events are covered separately below.
// A genuinely empty folder remains silent. Only an explicit /webapp <topic> starts a run.
// A paused run (named
// pause, harness-rules 2-1) is the one exception that speaks: the loader and the prompt guard
// print where it stopped. The progress writer also starts there, as the first part of the Stop
// entry stop-advance (the writer, then step-auto-continue, each behind its own gate), to record
// completion lines of the turn that paused (claude-named-pause P1); its Stop here carries the pause
// report instead, so it has nothing to record, nothing is written and step-auto-continue does not
// start. The two guards start only in Harness50 workspaces (paused, drift, finished, Codex, stale,
// stopped, invalid or active); on these harmless events they stay silent and write no log.
// A run whose cursor alone is
// off (drift) starts only the progress writer among the step hooks (inside stop-advance as well),
// and that writer puts current_step back (tested separately below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { pausedLine } from '../../scripts/lib/pause-state.mjs';
import { installPlugin, repo, runDispatcher, tempRoot, testEachName, tree, windows } from './helpers/claude-hooks.mjs';

// Loader-created progress.json from the incident workspace: step 1 of 50 and no step bodies.
const STALE_LOADER_PROGRESS = {
  last_updated: '2026-09-23T00:00:00', current_step: 1, total_steps: 50, completed_steps: [], failed_steps: [],
  skipped_steps: [], session_history: [], metrics: { total_sessions: 1, total_duration_minutes: 0, steps_per_session_avg: 0 }
};
const PROMPTS = ['hello', '회사 매출 대시보드 만들어줘', '튜토리얼 만들어줘', '웹앱 만들어줘', '인터랙티브 필수 초보자',
  '@step_archive/archived/step001.md 읽어', 'webapp 생성', '/webapp', '/webappx y'];
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';

// Every hook registered in hooks/hooks.json, grouped by event, read at run time so a new hook is
// covered automatically.
function registrations() {
  const config = JSON.parse(readFileSync(join(repo, 'hooks', 'hooks.json'), 'utf8'));
  return Object.fromEntries(Object.entries(config.hooks).map(([event, groups]) => [event,
    groups.flatMap(group => group.hooks.map(hook => / ([a-z0-9-]+)$/.exec(hook.command)[1]))]));
}

// Synthetic events for each hook event, all with the project as cwd. A paused run's last message is
// the pause report (harness-rules 2-1), which is not a completion line.
const PAUSE_REPORT = 'Step 001/50 멈춤 | 사유: user-request | 사용자가 할 일: 회의 후 재개 | 재개: /harness-resume';
function events(project, kind) {
  const tool = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: project });
  const tools = [
    tool('Bash', { command: 'npm test' }),
    tool('Write', { file_path: 'src/app.js', content: 'x' }),
    tool('Edit', { file_path: 'src/app.js', old_string: 'x', new_string: 'y' }),
    tool('MultiEdit', { file_path: 'src/app.js', edits: [{ old_string: 'x', new_string: 'y' }] }),
    tool('NotebookEdit', { notebook_path: 'a.ipynb', new_source: 'x' }),
    tool('WebFetch', { url: 'https://example.com', prompt: 'x' }),
    tool('WebSearch', { query: 'css' })
  ];
  return {
    SessionStart: [{ hook_event_name: 'SessionStart', source: 'startup', cwd: project }],
    UserPromptSubmit: PROMPTS.map(prompt => ({ hook_event_name: 'UserPromptSubmit', prompt, cwd: project })),
    PreToolUse: tools.map(event => ({ hook_event_name: 'PreToolUse', ...event })),
    PermissionRequest: tools.map(event => ({ hook_event_name: 'PermissionRequest', ...event })),
    PostToolUse: [
      tool('Write', { file_path: join(project, 'src', 'app.js'), content: 'x' }),
      tool('Edit', { file_path: join(project, 'src', 'style.css'), old_string: 'x', new_string: 'y' }),
      tool('Write', { file_path: join(project, 'src', '[id].js'), content: 'x' })
    ].map(event => ({ hook_event_name: 'PostToolUse', ...event })),
    Stop: [{ hook_event_name: 'Stop', session_id: 's', stop_hook_active: false, last_assistant_message: kind === 'paused' ? PAUSE_REPORT : 'Step 001/50 완료', cwd: project }]
  };
}

// A fake npx first on PATH records every call, so any autofix attempt is visible.
function fakeNpx(base) {
  const bin = join(base, 'fake-bin');
  mkdirSync(bin);
  if (windows) {
    writeFileSync(join(bin, 'npx.cmd'), '@echo off\r\n>>"%H50_NPX_LOG%" echo %*\r\nexit /b 0\r\n');
  } else {
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$H50_NPX_LOG"\nexit 0\n');
    chmodSync(join(bin, 'npx'), 0o755);
  }
  const log = join(base, 'npx.log');
  return { log, env: { [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`, H50_NPX_LOG: log } };
}

function setup(t, projectName) {
  const base = tempRoot(t, 'h50-inactive-');
  const plugin = installPlugin(base);
  const project = join(base, projectName);
  mkdirSync(join(project, 'src'), { recursive: true });
  const npx = fakeNpx(base);
  const env = { CLAUDE_PROJECT_DIR: '', PYTHONUTF8: '1', ...npx.env };
  return { base, plugin, project, npx, env };
}

// Same call as runDispatcher, asynchronous so a matrix can run a few dispatchers at once.
function dispatch(plugin, name, event, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(plugin, 'hooks', 'run-hook.mjs'), name], {
      cwd, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', CLAUDE_PROJECT_DIR: '', ...env }, windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} did not finish`)); }, 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
  });
}
// At most one dispatcher per spare CPU (at least two): a 4 vCPU runner starts three at a time,
// because test files running in parallel share the same PowerShell start-up cost.
async function inPool(tasks, limit = 6) {
  const cap = Math.min(limit, Math.max(2, availableParallelism() - 1));
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(cap, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }));
  return results;
}

const hookList = plugin => readdirSync(join(plugin, 'hooks')).sort();
// The two guards start a shell in paused and finished runs. They get one event per decision path
// (destructive-guard: a command; permission-request-guard: a command, an edit and a fetch),
// which keeps the PowerShell starts few enough that a loaded runner stays inside their 4.5 s budget.
const GUARD_TOOLS = { 'destructive-guard': ['Bash'], 'permission-request-guard': ['Bash', 'Write', 'WebFetch'] };
const payloadsFor = (hook, payloads) => Object.hasOwn(GUARD_TOOLS, hook) ? payloads.filter(payload => GUARD_TOOLS[hook].includes(payload.tool_name)) : payloads;
const writeProgress = (project, state) => {
  mkdirSync(join(project, 'step_archive'), { recursive: true });
  writeFileSync(join(project, 'step_archive', 'progress.json'), typeof state === 'string' ? state : JSON.stringify(state));
};
const writeBodies = (project, steps) => {
  mkdirSync(join(project, 'step_archive', 'archived'), { recursive: true });
  for (const step of steps) writeFileSync(join(project, 'step_archive', 'archived', `step${String(step).padStart(3, '0')}.md`), `# Step ${step}\n`);
};
const valid = { current_step: 1, total_steps: 50, completed_steps: [], failed_steps: [], skipped_steps: [], session_history: [], metrics: { total_sessions: 0 } };
const PAUSED_RUN = { ...valid, paused: true };
// What a paused run gets: the loader's two lines and the guard's one line for every prompt that is
// not a run control command (none of PROMPTS is). Every other hook stays silent.
const PAUSED_OUTPUT = {
  'step-progress-loader': `=== Paused at step001 ===\n${pausedLine(PAUSED_RUN)}\n`,
  'step-obedience-guard': `${pausedLine(PAUSED_RUN)}\n`
};

const WORKSPACES = {
  empty: () => {},
  'stale-loader': project => writeProgress(project, STALE_LOADER_PROGRESS),
  paused: project => { writeProgress(project, PAUSED_RUN); writeBodies(project, [1]); },
  'total 107': project => { writeProgress(project, { ...valid, total_steps: 107 }); writeBodies(project, [1]); },
  // A cursor that is no step number is damage, not drift (drift has its own test below).
  'cursor not a step number': project => { writeProgress(project, { ...valid, completed_steps: [2], current_step: '3' }); writeBodies(project, [1, 2, 3]); },
  corrupt: project => writeProgress(project, '{broken'),
  'step_archive link outside the project': (project, base, t) => {
    const outside = join(base, 'outside');
    writeProgress(outside, valid);
    writeBodies(outside, [1]);
    try {
      symlinkSync(join(outside, 'step_archive'), join(project, 'step_archive'), windows ? 'junction' : 'dir');
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      t.skip(`directory links unavailable: ${error.code}`);
      return 'skip';
    }
  }
};

for (const [kind, prepare] of Object.entries(WORKSPACES)) {
  testEachName(`inactive workspace (${kind}): no registered hook writes, approves, blocks or injects step instructions`, async (t, name) => {
    const f = setup(t, name);
    writeFileSync(join(f.project, 'src', '[id].js'), 'export const id = 1;\n');
    if (prepare(f.project, f.base, t) === 'skip') return;
    const before = { project: tree(f.project), outside: existsSync(join(f.base, 'outside')) ? tree(join(f.base, 'outside')) : null, hooks: hookList(f.plugin) };
    const byEvent = events(f.project, kind);
    const tasks = [];
    for (const [event, hooks] of Object.entries(registrations())) {
      for (const hook of hooks) {
        for (const payload of payloadsFor(hook, byEvent[event])) tasks.push(async () => [`${hook} ${JSON.stringify(payload).slice(0, 80)}`, await dispatch(f.plugin, hook, payload, { cwd: f.project, env: f.env })]);
      }
    }
    assert.ok(tasks.length >= 30, `only ${tasks.length} hook calls`);
    for (const [label, result] of await inPool(tasks)) {
      const expected = kind === 'paused' ? PAUSED_OUTPUT[label.split(' ')[0]] ?? '' : '';
      assert.deepEqual({ ...result, stdout: result.stdout.replace(/\r\n/g, '\n') }, { status: 0, stdout: expected, stderr: '' }, label);
    }
    assert.deepEqual(tree(f.project), before.project);
    if (before.outside) assert.deepEqual(tree(join(f.base, 'outside')), before.outside);
    assert.deepEqual(hookList(f.plugin), before.hooks, 'no log or state file next to the installed hooks');
    assert.equal(existsSync(f.npx.log), false, 'npx was started');
  });
}

testEachName('finished run (50/50): only the trust5 gate speaks; progress, specs and state stay unchanged', async (t, name) => {
  const f = setup(t, name);
  writeProgress(f.project, { ...valid, completed_steps: Array.from({ length: 50 }, (_, index) => index + 1), current_step: 50 });
  writeBodies(f.project, [1, 50]);
  mkdirSync(join(f.project, 'step_archive', 'specs'));
  writeFileSync(join(f.project, 'step_archive', 'specs', 'SPEC-050.md'), '# SPEC\n');
  const stable = () => tree(f.project).filter(([key]) => !key.startsWith('step_archive/outputs'));
  const before = stable();
  const byEvent = events(f.project);
  const tasks = [];
  for (const [event, hooks] of Object.entries(registrations())) {
    for (const hook of hooks) {
      for (const payload of payloadsFor(hook, byEvent[event])) tasks.push(async () => [hook, await dispatch(f.plugin, hook, payload, { cwd: f.project, env: f.env })]);
    }
  }
  for (const [hook, result] of await inPool(tasks)) {
    assert.equal(result.status, 0, `${hook}: ${result.stderr}`);
    assert.equal(result.stderr, '', hook);
    if (hook === 'trust5-validator') assert.match(result.stdout, /"decision":"block"/);
    else assert.equal(result.stdout, '', hook);
  }
  assert.deepEqual(stable(), before);
  assert.equal(existsSync(f.npx.log), false);
});

// A hand edit moved current_step off the first unfinished step (drift). Among the step hooks only
// the progress writer starts, directly or as the first part of stop-advance, so both are left out
// of the first pass (each rewrites progress.json). The Stop entry stop-advance then puts the cursor
// back while its step-auto-continue stays silent (that gate failed before the writer ran), and from
// then on the run is active. The other hooks get the first payload of their event only, which keeps
// the dispatches few; the guards are covered in 'the guards run only in harness workspaces'.
testEachName('cursor drift: only the progress writer starts, and it puts current_step back on the first unfinished step', async (t, name) => {
  const f = setup(t, name);
  writeProgress(f.project, { ...valid, last_updated: '', completed_steps: [2], current_step: 3 });
  writeBodies(f.project, [1, 2, 3]);
  const before = tree(f.project);
  const byEvent = events(f.project);
  const tasks = [];
  for (const [event, hooks] of Object.entries(registrations())) {
    for (const hook of hooks) {
      if (['destructive-guard', 'permission-request-guard', 'step-progress-writer', 'stop-advance'].includes(hook)) continue;
      tasks.push(async () => [hook, await dispatch(f.plugin, hook, byEvent[event][0], { cwd: f.project, env: f.env })]);
    }
  }
  for (const [hook, result] of await inPool(tasks)) assert.deepEqual(result, { status: 0, stdout: '', stderr: '' }, hook);
  assert.deepEqual(tree(f.project), before);

  const stop = { hook_event_name: 'Stop', session_id: 's', stop_hook_active: false, last_assistant_message: '', cwd: f.project };
  const read = () => JSON.parse(readFileSync(join(f.project, 'step_archive', 'progress.json'), 'utf8').replace(/^\uFEFF/, ''));
  // The PowerShell writer skips its write while another test file holds the machine-wide
  // Global\step-progress-writer-mutex, so rerun the Stop (bounded) until the cursor is back.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const repair = await dispatch(f.plugin, 'stop-advance', stop, { cwd: f.project, env: f.env });
    // No block in drift, and the writer's own output is dropped.
    assert.deepEqual(repair, { status: 0, stdout: '', stderr: '' });
    if (read().current_step === 1) break;
    await sleep(500 * attempt);
  }
  const after = read();
  assert.deepEqual(after.completed_steps, [2]);
  assert.equal(after.current_step, 1);
  // The next Stop finds an active run: after the writer, step-auto-continue names step 1.
  const continued = await dispatch(f.plugin, 'stop-advance', stop, { cwd: f.project, env: f.env });
  assert.equal(continued.status, 0, continued.stderr);
  const reason = JSON.parse(continued.stdout).reason;
  assert.ok(reason.includes('step_archive/archived/step001.md'), reason);
  assert.equal(existsSync(f.npx.log), false);
});

// The two guards run only in Harness50 workspaces: an active, paused or finished Claude run, or a
// Codex workspace, including stale or damaged progress metadata. In an unrelated folder without
// workflow metadata no shell starts and the host's permission checks decide. A block writes the
// guard log next to the
// installed hooks, so this test does not compare the hooks folder.
testEachName('the guards run only in harness workspaces', (t, name) => {
  const f = setup(t, name);
  const guard = (hook, project, event) => runDispatcher(f.plugin, hook, { cwd: project, ...event }, { cwd: project, env: f.env, timeoutMs: 60000 });
  const settingsWrite = { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '.claude/settings.json', content: '{}' } };
  const bash = (command, hook_event_name = 'PreToolUse') => ({ hook_event_name, tool_name: 'Bash', tool_input: { command } });
  const silent = { status: 0, stdout: '', stderr: '' };
  const settingsDenied = project => {
    const result = guard('permission-request-guard', project, settingsWrite);
    assert.equal(result.status, 2, `${project}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: {
      hookEventName: 'PermissionRequest', decision: {
        behavior: 'deny', reason: 'harness20: blocked unsafe tool input (protected-path)'
      }
    } });
  };
  const resetBlocked = project => {
    const result = guard('destructive-guard', project, bash('git reset --hard'));
    assert.equal(result.status, 2, `${project}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Rule: git-reset-hard/);
  };

  const stale = join(f.base, `${name} stale`);
  mkdirSync(stale);
  writeProgress(stale, STALE_LOADER_PROGRESS);
  const staleBefore = tree(stale);
  assert.deepEqual(guard('permission-request-guard', f.project, settingsWrite), silent, f.project);
  assert.deepEqual(guard('destructive-guard', f.project, bash('git reset --hard')), silent, f.project);
  settingsDenied(stale);
  resetBlocked(stale);
  assert.equal(existsSync(join(f.project, 'step_archive')), false);
  assert.deepEqual(tree(stale), staleBefore);

  // After /webapp <topic> the same folder is an active run: block, deny and ask apply, and a
  // command that destructive-guard leaves to the user is never refused by permission-request-guard.
  assert.equal(guard('webapp-trigger', f.project, { hook_event_name: 'UserPromptSubmit', prompt: '/webapp fractions' }).status, 0);
  const deny = guard('permission-request-guard', f.project, settingsWrite);
  assert.equal(deny.status, 2, deny.stderr);
  assert.match(deny.stdout, /"deny"/);
  const block = guard('destructive-guard', f.project, bash('git reset --hard'));
  assert.equal(block.status, 2, block.stderr);
  assert.match(block.stderr, /Rule: git-reset-hard/);
  const ask = guard('destructive-guard', f.project, bash('sudo apt install jq'));
  assert.equal(ask.status, 0, ask.stderr);
  assert.match(ask.stdout, /"permissionDecision":"ask"/);
  assert.deepEqual(guard('permission-request-guard', f.project, bash('git commit -m "remove sudo usage"', 'PermissionRequest')), silent);

  // Paused, drift, finished (50/50), invalid, stopped, corrupt and Codex workspaces keep the
  // guards as well: changing or damaging existing metadata never turns them off.
  const workspaces = {
    paused: project => { writeProgress(project, PAUSED_RUN); writeBodies(project, [1]); },
    drift: project => { writeProgress(project, { ...valid, completed_steps: [2], current_step: 3 }); writeBodies(project, [1]); },
    finished: project => writeProgress(project, { ...valid, completed_steps: Array.from({ length: 50 }, (_, index) => index + 1), current_step: 50 }),
    invalid: project => { writeProgress(project, { ...valid, total_steps: 107 }); writeBodies(project, [1]); },
    stopped: project => { writeProgress(project, { ...valid, status: 'cancelled' }); writeBodies(project, [1]); },
    corrupt: project => writeProgress(project, '{broken'),
    codex: project => {
      mkdirSync(join(project, 'step_archive', '.harness50-codex'), { recursive: true });
      writeFileSync(join(project, 'step_archive', '.harness50-codex', 'state.json'), '{}');
    }
  };
  for (const [kind, prepare] of Object.entries(workspaces)) {
    const project = join(f.base, `${name} ${kind}`);
    mkdirSync(project);
    prepare(project);
    const before = tree(project);
    settingsDenied(project);
    resetBlocked(project);
    assert.deepEqual(tree(project), before, `${kind}: guard decisions preserve workflow bytes`);
  }
});

// Runs one registered hook through the installed dispatcher and returns trimmed stdout.
function hookRunner(f) {
  return (hook, event) => {
    const result = runDispatcher(f.plugin, hook, { cwd: f.project, ...event }, { cwd: f.project, env: f.env, timeoutMs: 60000 });
    assert.equal(result.status, 0, `${hook}: ${result.stderr}`);
    assert.equal(result.stderr, '', hook);
    return result.stdout.trim();
  };
}
const topicFile = f => join(f.project, 'step_archive', 'TOPIC', 'TOPIC.md');
const progressFile = f => join(f.project, 'step_archive', 'progress.json');
const allow = /"permissionDecision":"allow"/;

testEachName('/webapp <topic> starts a run that the other hooks then follow', (t, name) => {
  const f = setup(t, name);
  const run = hookRunner(f);
  const issued = run('webapp-trigger', { hook_event_name: 'UserPromptSubmit', prompt: '/webapp fractions' });
  assert.match(issued, /<harness50-trigger>/);
  const progress = JSON.parse(readFileSync(progressFile(f), 'utf8').replace(/^﻿/, ''));
  assert.equal(progress.current_step, 1);
  assert.deepEqual(progress.completed_steps, []);
  assert.match(run('webapp-trigger', prompt('/harness14:webapp zeta')), /<harness50-trigger>/);
  assert.match(readFileSync(topicFile(f), 'utf8'), /zeta/);
  assert.equal(progress.total_steps, 14);
  assert.equal(progress.workflow_profile, "planning-first-14-v1");
  assert.equal(readdirSync(join(f.project, 'step_archive', 'profiles', 'planning-first-14-v1', 'archived')).filter(file => /^step\d{3}\.md$/.test(file)).length, 14);
  assert.match(readFileSync(topicFile(f), 'utf8'), /fractions/);

  const loader = run('step-progress-loader', { hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(loader, /Current step: step001/);
  assert.match(loader, /OBEDIENCE/);

  const write = file_path => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: 'x' } });
  assert.match(run('auto-approve', write('src/app.js')), allow);
  for (const target of ['.husky/pre-commit', 'package.json', '.mcp.json', 'CLAUDE.md']) {
    assert.equal(run('auto-approve', write(target)), '', target);
  }

  const stop = JSON.parse(run('step-auto-continue', { hook_event_name: 'Stop', session_id: 'issued', stop_hook_active: false }));
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /step001/);
});

testEachName('/webapp never overwrites a run with completed steps; natural language changes nothing', (t, name) => {
  const f = setup(t, name);
  const run = hookRunner(f);
  const prompt = text => ({ hook_event_name: 'UserPromptSubmit', prompt: text });
  writeProgress(f.project, { ...valid, completed_steps: [1], current_step: 2 });
  writeBodies(f.project, [1, 2]);
  mkdirSync(join(f.project, 'step_archive', 'TOPIC'));
  writeFileSync(topicFile(f), '---\ntopic: first\n---\n');
  const bytes = () => [readFileSync(progressFile(f)), readFileSync(topicFile(f))];
  const before = bytes();
  const skipped = run('webapp-trigger', prompt('/webapp other')).split(/\r?\n/);
  assert.equal(skipped.length, 1, skipped.join('\n'));
  assert.match(skipped[0], /already records 1\/50 completed steps/);
  assert.deepEqual(bytes(), before);
  const canonical = run('webapp-trigger', prompt('/harness14:webapp other'));
  assert.match(canonical, /already records 1\/50 completed steps/);
  assert.deepEqual(bytes(), before, 'canonical namespace preserves existing workflow bytes');
  const namespaced = run('webapp-trigger', prompt('/harness20:webapp other'));
  assert.match(namespaced, /already records 1\/50 completed steps/);
  assert.deepEqual(bytes(), before, 'new namespace preserves the existing 50-step workflow');
  // An active project: natural language reaches no hook that could restart it.
  assert.equal(run('webapp-trigger', prompt('회사 매출 대시보드 만들어줘')), '');
  assert.deepEqual(bytes(), before);
});

testEachName('a new /webapp topic replaces one without completed steps, including harness14, harness20, harness36 and harness50 namespaces', (t, name) => {
  const f = setup(t, name);
  const run = hookRunner(f);
  const prompt = text => ({ hook_event_name: 'UserPromptSubmit', prompt: text });
  assert.match(run('webapp-trigger', prompt('/webapp alpha')), /<harness50-trigger>/);
  assert.match(run('webapp-trigger', prompt('/webapp beta')), /<harness50-trigger>/);
  assert.match(readFileSync(topicFile(f), 'utf8'), /beta/);
  assert.doesNotMatch(readFileSync(topicFile(f), 'utf8'), /alpha/);
  assert.match(run('webapp-trigger', prompt('/harness50:webapp gamma')), /<harness50-trigger>/);
  assert.match(readFileSync(topicFile(f), 'utf8'), /gamma/);
  assert.match(run('webapp-trigger', prompt('/harness36:webapp delta')), /<harness50-trigger>/);
  assert.match(readFileSync(topicFile(f), 'utf8'), /delta/);
  assert.match(run('webapp-trigger', prompt('/harness20:webapp epsilon')), /<harness50-trigger>/);
  assert.match(readFileSync(topicFile(f), 'utf8'), /epsilon/);
  const progress = JSON.parse(readFileSync(progressFile(f), 'utf8').replace(/^﻿/, ''));
  assert.match(run('webapp-trigger', prompt('/harness14:webapp zeta')), /<harness50-trigger>/);
  assert.match(readFileSync(topicFile(f), 'utf8'), /zeta/);
  assert.equal(progress.total_steps, 14);
  assert.equal(progress.workflow_profile, 'planning-first-14-v1');
});

testEachName('lsp-autofix in an active run starts only a project-local biome or stylelint', (t, name) => {
  const f = setup(t, name);
  const run = hookRunner(f);
  writeProgress(f.project, valid);
  writeBodies(f.project, [1]);
  const post = file_path => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path, content: 'x' } });
  const npxLog = () => existsSync(f.npx.log) ? readFileSync(f.npx.log, 'utf8') : '';
  writeFileSync(join(f.project, 'src', 'app.js'), 'export const a = 1;\n');
  writeFileSync(join(f.project, 'src', 'style.css'), 'a { color: red; }\n');
  mkdirSync(join(f.project, 'lib'));
  writeFileSync(join(f.project, 'lib', 'outside.js'), 'x\n');

  assert.equal(run('lsp-autofix', post(join(f.project, 'src', 'app.js'))), '');
  assert.equal(run('lsp-autofix', post(join(f.project, 'src', 'style.css'))), '');
  assert.equal(npxLog(), '', 'no local tool: npx is never started');

  const localPackage = (...parts) => {
    mkdirSync(join(f.project, 'node_modules', ...parts), { recursive: true });
    writeFileSync(join(f.project, 'node_modules', ...parts, 'package.json'), '{"name":"fake"}');
  };
  localPackage('@biomejs', 'biome');
  assert.equal(run('lsp-autofix', post(join(f.project, 'src', 'app.js'))), '');
  assert.match(npxLog(), /--no-install @biomejs\/biome check --write/);
  assert.doesNotMatch(npxLog(), /stylelint/);
  assert.equal(run('lsp-autofix', post(join(f.project, 'src', 'style.css'))), '');
  assert.doesNotMatch(npxLog(), /stylelint/, 'no local stylelint yet');
  localPackage('stylelint');
  assert.equal(run('lsp-autofix', post(join(f.project, 'src', 'style.css'))), '');
  assert.match(npxLog(), /--no-install stylelint --fix/);

  const calls = npxLog();
  assert.equal(run('lsp-autofix', post(join(f.project, 'lib', 'outside.js'))), '');
  assert.equal(run('lsp-autofix', post(join(f.base, 'src', 'elsewhere.js'))), '');
  assert.equal(npxLog(), calls, 'files outside <project>/src are left alone');
});
