#!/usr/bin/env node
// Read-only. The single activity judgement shared by run-hook, approval-policy, quality-gate and
// webapp-trigger (읽기 전용, run-hook·approval-policy·quality-gate·webapp-trigger가 공유하는 단일 판정).
//
// A Claude workflow is active only when all of these hold:
//   - no Codex state entry exists at step_archive/.harness50-codex/state.json (lstat, so even a
//     dangling link counts as present);
//   - step_archive/progress.json is a regular file inside the project root and at most 1 MiB;
//   - paused is absent or false, and status is absent or one of ACTIVE_STATUSES;
//   - total_steps is present and equals STEP_COUNT;
//   - completed_steps holds distinct integers 1..STEP_COUNT;
//   - current_step equals the first unfinished step;
//   - that step's body exists (step_archive/archived/stepNNN.md, else step_archive/stepNNN.md).
// When everything holds except the cursor (current_step is another integer 1..STEP_COUNT+1, as
// after a hand edit of progress.json) the run reads as 'drift': the progress writer is the only
// step hook that starts, and it puts current_step back on the first unfinished step. The other
// step hooks stay off until then; the two guards keep running.
// A progress.json created by an older SessionStart loader has no step bodies next to it, so it
// reads as stale and never turns hooks on.
// A named pause (scripts/harness-pause.mjs, harness-rules 2-1) is judged on the same rules with
// the pause flag removed: 'paused' only when that run would be active or drift, else finished,
// stale, stopped or invalid. Only the two guards, the loader, the prompt guard and the progress
// writer start for a paused run.
//
// It never writes and never imports codex/: installed copies and hook fixtures may ship hooks/
// without it. The CLI prints one ASCII line and always exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWorkflowProfile, LEGACY_WORKFLOW_PROFILE } from '../../scripts/lib/workflow-profiles.mjs';
import { claudeStepBody, checkClaudeProfileBinding, readPhysicalFileSync } from '../../scripts/lib/claude-profile.mjs';
import { parseStrictJson } from '../../scripts/lib/strict-json.mjs';

export const STEP_COUNT = 50;
export const ACTIVE_STATUSES = Object.freeze(['active', 'running', 'in_progress']);
export const MAX_PROGRESS_BYTES = 1024 * 1024;
// First line only: '^' without the m flag anchors at the start of the prompt. Case-sensitive.
export const EXPLICIT_WEBAPP = /^[ \t]*\/(?:harness(?:14|20|36|50):)?webapp[ \t]+\S/;
// Which run phases start each registered hook. The two guards run only where a Harness50 run is
// established (active, paused, drift or finished Claude run, or a Codex workspace, where a Claude
// session has no other plugin guard); elsewhere the host permission checks apply, and Bash is never
// auto-approved. 'explicit-webapp' runs only for a '/webapp <topic>' prompt. In a paused run the
// loader and the prompt guard start, to say where the run stopped, and the writer starts to record
// the completion lines the model reported in the turn it paused (harness-rules 2-1 lets it finish
// steps first). The writer never tells the model to continue, so the pause keeps its meaning. Stop
// continuation, approval, quality, SPEC, MX and LSP stay off until /harness-resume.
// In a drift run the writer is the only step hook that starts, to put the cursor back; the
// guards stay on, so moving current_step by hand never turns them off.
// The Stop event runs the writer and then step-auto-continue through run-hook.mjs's 'stop-advance'
// sequence; each part keeps its own gate below.
export const GUARD_PHASES = Object.freeze(['active', 'paused', 'finished', 'codex', 'drift', 'invalid', 'stopped', 'stale']);
export const HOOK_GATES = Object.freeze({
  'destructive-guard': GUARD_PHASES,
  'permission-request-guard': GUARD_PHASES,
  'webapp-trigger': 'explicit-webapp',
  'step-progress-loader': Object.freeze(['active', 'codex', 'paused']),
  'trust5-validator': Object.freeze(['active', 'finished']),
  'step-obedience-guard': Object.freeze(['active', 'paused']),
  'auto-approve': Object.freeze(['active']),
  'mx-tag-validator': Object.freeze(['active']),
  'lsp-autofix': Object.freeze(['active']),
  'step-progress-writer': Object.freeze(['active', 'paused', 'drift']),
  'spec-generator': Object.freeze(['active']),
  'step-auto-continue': Object.freeze(['active'])
});
const DEFAULT_GATE = Object.freeze(['active']);

const CODEX_SKIP_LINE = '[HARNESS] webapp trigger skipped: a Codex workflow owns this workspace, so step_archive/TOPIC/TOPIC.md and progress.json were left unchanged. Resume that workflow, or use a separate workspace for a different topic.';
export const PRECHECK_INVALID_LINE = '[HARNESS] webapp trigger skipped: step_archive/progress.json is unreadable or invalid, so step_archive/TOPIC/TOPIC.md and progress.json were left unchanged. Restore known consistent workflow metadata and profile binding before retrying /harness-reset.';

// Physical path of candidate; a missing tail is joined onto the physical form of its parent.
export function physical(candidate) {
  try { return fs.realpathSync(candidate); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling link is not an ordinary missing destination.
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(physical(parent), path.basename(candidate));
  }
}
export function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function projectRoot(event, env = process.env, cwd = process.cwd()) {
  return physical(path.resolve(env.CLAUDE_PROJECT_DIR || event?.cwd || cwd));
}
// Any entry at the Codex state path, even a directory or link, means the Codex state manager owns
// the workspace. Only "a parent is not a directory" means no entry; other errors fail closed.
export function codexOwned(root) {
  try {
    return fs.lstatSync(path.join(root, 'step_archive', '.harness50-codex', 'state.json'), { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    return error?.code !== 'ENOTDIR';
  }
}

// Pure structural judgement of a parsed progress.json value.
export function classifyProgress(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { phase: 'invalid' };
  if (('paused' in state && state.paused !== false) || state.status === 'paused') return { phase: 'paused' };
  if ('status' in state && !ACTIVE_STATUSES.includes(state.status)) return { phase: 'stopped' };
  let total;
  try { total = resolveWorkflowProfile(state).stepCount; } catch { return { phase: 'invalid' }; }
  const done = state.completed_steps;
  if (!Array.isArray(done) || !done.every(step => Number.isInteger(step) && step >= 1 && step <= total) ||
      new Set(done).size !== done.length) return { phase: 'invalid' };
  // Fresh compact runs cannot retain later work past a rejected prerequisite.
  // Older profiles keep their published nonprefix history semantics.
  if (state.workflow_profile === 'planning-first-14-v1' &&
      [...done].sort((a, b) => a - b).some((step, index) => step !== index + 1)) return { phase: 'invalid' };
  const finished = new Set(done);
  let next = null;
  for (let step = 1; step <= total; step += 1) {
    if (!finished.has(step)) { next = step; break; }
  }
  // The final writer keeps the cursor on the last step or moves it one past.
  if (next === null) {
    return [total, total + 1].includes(state.current_step) ? { phase: 'finished', completed: total } : { phase: 'invalid' };
  }
  if (state.current_step === next) return { phase: 'running', next, completed: done.length };
  // Only the cursor disagrees (a hand edit of progress.json): 'drift'. The progress writer puts
  // current_step back on the first unfinished step. A cursor that is no step number at all stays
  // invalid.
  const cursor = state.current_step;
  return Number.isInteger(cursor) && cursor >= 1 && cursor <= total + 1
    ? { phase: 'drift', next, completed: done.length } : { phase: 'invalid' };
}

const stepName = step => `step${String(step).padStart(3, '0')}.md`;
function regularFile(file) {
  try { return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
}
function progressEntry(root) {
  const file = path.join(root, 'step_archive', 'progress.json');
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) === undefined ? { file, present: false } : { file, present: true };
  } catch (error) {
    if (error?.code === 'ENOTDIR' || error?.code === 'ENOENT') return { file, present: false };
    throw error;
  }
}
// Parsed progress.json that lies inside root, or throws.
function readProgress(root, file) {
  if (!within(physical(file), root)) throw new Error('progress.json leaves the project');
  return parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(readPhysicalFileSync(root,'step_archive/progress.json',MAX_PROGRESS_BYTES)).replace(/^﻿/, ''));
}

export function readRun(root) {
  if (codexOwned(root)) return { phase: 'codex' };
  let entry;
  try { entry = progressEntry(root); } catch { return { phase: 'invalid' }; }
  if (!entry.present) return { phase: 'absent' };
  let state;
  try { state = readProgress(physical(root), entry.file); } catch { return { phase: 'invalid' }; }
  try {
    const profile = resolveWorkflowProfile(state);
    checkClaudeProfileBinding(root, profile);
    if (profile.id !== LEGACY_WORKFLOW_PROFILE) for (let step = 1; step <= profile.stepCount; step++) claudeStepBody(root, state, step);
  } catch { return { phase: 'invalid' }; }
  const run = classifyProgress(state);
  if (run.phase === 'paused') return pausedRun(root, state);
  if (run.phase !== 'running' && run.phase !== 'drift') return run;
  // Without the body of the first unfinished step a drift run is as stale as a running one.
  const body = stepBody(root, run.next, state);
  if (!body) return { ...run, phase: 'stale' };
  return run.phase === 'drift' ? run : { ...run, phase: 'active', stepBody: body };
}
function stepBody(root, step, state) {
  try {
    const body = claudeStepBody(root, state, step);
    return body.startsWith('step_archive/archived/') ? 'archived' : body.startsWith('step_archive/profiles/') ? body : 'flat';
  } catch { return null; }
}
// classifyProgress reports 'paused' before any structural check, so judge the same state without
// the pause: a run that would be active or drift stays 'paused'; anything else keeps that other
// phase. The writer, which starts for a paused run, also puts a drifted cursor back.
function pausedRun(root, state) {
  const unpaused = { ...state };
  delete unpaused.paused;
  if (unpaused.status === 'paused') delete unpaused.status;
  const run = classifyProgress(unpaused);
  if (run.phase !== 'running' && run.phase !== 'drift') return run;
  return stepBody(root, run.next, state) ? { phase: 'paused', next: run.next, completed: run.completed } : { ...run, phase: 'stale' };
}
export const isActive = root => readRun(root).phase === 'active';

// Whether run-hook.mjs should start the named hook for this raw event. Any failure means no.
export function shouldRunHook(name, raw, env = process.env, cwd = process.cwd()) {
  try {
    const gate = Object.hasOwn(HOOK_GATES, name) ? HOOK_GATES[name] : DEFAULT_GATE;
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
    const event = parseStrictJson(text.replace(/^﻿/, ''));
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    if (gate === 'explicit-webapp') return typeof event.prompt === 'string' && EXPLICIT_WEBAPP.test(event.prompt);
    return gate.includes(readRun(projectRoot(event, env, cwd)).phase);
  } catch {
    return false;
  }
}

// 'issue' lets '/webapp <topic>' bootstrap a new run. Anything else is the one line the trigger
// prints instead: recorded progress and unreadable progress are never overwritten. A run without
// completed steps is replaced whether or not it is paused, so '/harness-reset' (which leaves a
// user-request pause) followed by '/webapp <topic>' starts the new topic.
export function webappPrecheck(root) {
  if (codexOwned(root)) return CODEX_SKIP_LINE;
  let state;
  try {
    const entry = progressEntry(root);
    if (!entry.present) return 'issue';
    state = readProgress(physical(root), entry.file);
  } catch {
    return PRECHECK_INVALID_LINE;
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return PRECHECK_INVALID_LINE;
  try { checkClaudeProfileBinding(root, resolveWorkflowProfile(state)); }
  catch { return PRECHECK_INVALID_LINE; }
  if (!('completed_steps' in state)) return PRECHECK_INVALID_LINE;
  const done = state.completed_steps;
  if (!Array.isArray(done)) return PRECHECK_INVALID_LINE;
  if (done.length === 0) return 'issue';
  return `[HARNESS] webapp trigger skipped: step_archive/progress.json already records ${done.length}/${state.total_steps ?? STEP_COUNT} completed steps, so step_archive/TOPIC/TOPIC.md and progress.json were left unchanged. Continue that run (use /harness-resume if it is paused), or run /harness-reset first and then /webapp <topic> for a new topic.`;
}

function invokedDirectly() {
  try {
    return fs.realpathSync.native(process.argv[1] ?? '') === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// node harness-activity.mjs precheck-webapp <root> | phase <root>
if (invokedDirectly()) {
  const [command, target] = process.argv.slice(2);
  let line = 'invalid';
  if (command === 'precheck-webapp') {
    try { line = webappPrecheck(physical(path.resolve(target))); } catch { line = PRECHECK_INVALID_LINE; }
  } else if (command === 'phase') {
    try { line = readRun(physical(path.resolve(target))).phase; } catch { line = 'invalid'; }
  }
  process.stdout.write(`${line}\n`);
  process.exitCode = 0;
}
