#!/usr/bin/env node
// Read-only probe of the Codex workflow state for the Claude hooks.
//
// When step_archive/.harness50-codex/state.json exists, the Codex state manager owns
// the workspace. The Claude step hooks then gate on that file's existence alone and
// leave progress.json untouched. This helper only turns the state into one ASCII
// context line for SessionStart and the webapp trigger.
//
// It never writes, never echoes raw file content and always exits 0. It must not
// import codex/: hook fixtures and installed copies may ship hooks/ without it, so the
// schema subset below mirrors codex/scripts/lib/schema.mjs and paths.mjs (a parity
// test in codex/tests/claude-codex-coexistence.test.mjs keeps them aligned).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkflowProfile } from '../../scripts/lib/workflow-profiles.mjs';

export const CODEX_STATE_RELATIVE = 'step_archive/.harness50-codex/state.json';
export const SCHEMA_VERSION = 1;
export const STEP_COUNT = 50;
export const STATUSES = Object.freeze(['running', 'paused', 'blocked', 'completed']);
export const MAX_STATE_BYTES = 64 * 1024;
// Codex uses randomUUID(). The narrow pattern also keeps untrusted text out of model context.
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MANAGER = "the harness14 plugin's codex/scripts/harness-state.mjs";

export const WARNING_LINE = '[HARNESS] WARNING: step_archive/.harness50-codex/state.json exists but is unreadable or incomplete - ' +
  'Claude hooks will not create progress.json or block Stop here. ' +
  `Inspect it with ${MANAGER} show and ask the user before repairing or resetting it.`;

export function codexStatePath(projectRoot) {
  return path.join(projectRoot, 'step_archive', '.harness50-codex', 'state.json');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStep(value, count) {
  return Number.isInteger(value) && value >= 1 && value <= count;
}

// Returns { kind: 'absent' } | { kind: 'invalid' } |
// { kind: 'valid', workflowId, status, step, completed }.
export function summarizeState(state) {
  if (!isPlainObject(state)) return { kind: 'invalid' };
  if (state.schema_version !== 1 && state.schema_version !== 2) return { kind: 'invalid' };
  let count;
  try { count = resolveWorkflowProfile(state).stepCount; }
  catch { return { kind: 'invalid' }; }
  if (typeof state.workflow_id !== 'string' || !WORKFLOW_ID.test(state.workflow_id)) return { kind: 'invalid' };
  if (!STATUSES.includes(state.status)) return { kind: 'invalid' };
  const done = state.completed_steps;
  if (!Array.isArray(done) || done.length > count || !done.every((step, index) => step === index + 1)) {
    return { kind: 'invalid' };
  }
  let step;
  if (state.status === 'completed') {
    if (done.length !== count || state.current_step !== null) return { kind: 'invalid' };
    step = count;
  } else {
    if (!isStep(state.current_step, count) || state.current_step !== done.length + 1) return { kind: 'invalid' };
    step = state.current_step;
  }
  return { kind: 'valid', workflowId: state.workflow_id, status: state.status, step, completed: done.length,
    ...(state.schema_version === 2 ? { total: count, workflowProfile: state.workflow_profile } : {}) };
}

export function probe(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot === '' || projectRoot.includes('\0')) return { kind: 'absent' };
  const file = codexStatePath(projectRoot);
  let stat;
  try {
    stat = fs.lstatSync(file, { throwIfNoEntry: false });
  } catch (error) {
    return error?.code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'invalid' };
  }
  if (stat === undefined) return { kind: 'absent' };
  // Directories, links and devices are never followed or read.
  if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return { kind: 'invalid' };
  try {
    // libuv opens with full share flags on Windows, so Codex's atomic rename is never blocked.
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_STATE_BYTES) return { kind: 'invalid' };
    return summarizeState(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
  } catch {
    return { kind: 'invalid' };
  }
}

export function contextLine(result) {
  if (result?.kind === 'absent') return '';
  if (result?.kind !== 'valid') return WARNING_LINE;
  const where = `[HARNESS] Codex workflow ${result.workflowId} is ${result.status} at step ${result.step}/${result.total ?? STEP_COUNT} ` +
    `(${result.completed}/${result.total ?? STEP_COUNT} complete)`;
  if (result.status === 'completed') {
    return `${where} - nothing to continue; inspect it with ${MANAGER} show. ` +
      'Claude progress.json is not authoritative here.';
  }
  return `${where} - continue it only through ${MANAGER} (show, resume, begin, complete) ` +
    'following codex/skills/webapp/SKILL.md; Claude progress.json and chat completion reports are not authoritative here.';
}

function invokedDirectly() {
  try {
    return fs.realpathSync.native(process.argv[1] ?? '') === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  let line;
  try {
    line = contextLine(probe(process.argv[2]));
  } catch {
    line = WARNING_LINE;
  }
  if (line) process.stdout.write(`${line}\n`);
  process.exitCode = 0;
}
