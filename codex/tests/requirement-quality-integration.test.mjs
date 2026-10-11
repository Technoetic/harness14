import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { makeWorkspace } from './helpers/workspace.mjs';
import { prepareQuality, prepareFinalRegression } from './helpers/completion-quality.mjs';
import * as quality from '../../scripts/lib/quality.mjs';
import { freezeRequirements } from '../../scripts/lib/requirement-coverage.mjs';
import { snapshotQa, recordQa } from '../../scripts/lib/qa-report.mjs';
import { validateCompletionEvidence } from '../scripts/lib/acceptance.mjs';

const PROFILE = 'planning-first-14-v1';
const FINAL_IDS = ['e2e', 'screenshot', 'keyboard', 'mouse', 'design', 'console'].map(x => `${x}-regression`);
const run = promisify(execFile);
const gateCli = fileURLToPath(new URL('../../scripts/quality-gate.mjs', import.meta.url));
const contract = { number: 14, id: 'step014', acceptance: [{ id: 'reviewed', kind: 'check', required: true, description: 'Reviewed fixture.' }] };
const evidence = [{ acceptance_id: 'reviewed', kind: 'check', detail: 'Fixture observation.', ok: true }];

async function fixture() {
  const root = await makeWorkspace();
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist/index.html'), '<!doctype html><html><head><title>Fixture</title></head><body>Fixture</body></html>');
  await prepareFinalRegression(root, { workflowProfile: PROFILE });
  await prepareQuality(root);
  const frozen = await freezeRequirements(root, { schema_version: 1,
    requirements: [{ id: 'R-requested-behavior', acceptance_ids: ['AC-requested-behavior'] }],
    acceptance: [{ id: 'AC-requested-behavior', check_ids: ['requested-behavior'] }] });
  const configPath = join(root, 'harness50.quality.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.schema_version = 2;
  config.requirements = { inventory_sha256: frozen.inventory_sha256 };
  await writeFile(configPath, JSON.stringify(config));
  return { root, config, configPath, frozen };
}

async function finalQa(root, includeRequired = true) {
  const ids = [...FINAL_IDS, ...(includeRequired ? ['requested-behavior'] : [])];
  await writeFile(join(root, 'step_archive/outputs/requested-behavior.json'), JSON.stringify({ observed: ids }));
  const snap = await snapshotQa(root, 14, { artifacts: ['dist/index.html', 'harness50.quality.json'],
    checks: ids.map(id => ({ id, requirement: `Observe ${id}.` })) });
  await recordQa(root, 14, { snapshot_id: snap.snapshot_id,
    verifier: { id: 'independent-fixture-reviewer', mode: 'independent' },
    outcomes: ids.map(id => ({ id, status: 'pass', observation: `Observed ${id}.`,
      evidence_paths: ['step_archive/outputs/requested-behavior.json'], next_check: '' })), next_actions: [] });
}

test('schema 2 accepts the frozen inventory at intermediate quality gates before final QA', async () => {
  const { root, frozen } = await fixture();
  const result = await quality.runQualityGate(root);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.requirements_inventory_sha256, frozen.inventory_sha256);
  assert.equal((await quality.inspectQualityReport(root)).verdict, 'PASS');
});

test('schema 2 refuses a missing, malformed or mismatching inventory hash', async () => {
  for (const value of [undefined, { inventory_sha256: 'bad' }, { inventory_sha256: 'a'.repeat(64) }]) {
    const { root, config, configPath } = await fixture();
    if (value === undefined) delete config.requirements; else config.requirements = value;
    await writeFile(configPath, JSON.stringify(config));
    assert.notEqual((await quality.runQualityGate(root)).verdict, 'PASS');
  }
});

test('schema 1 retains historical quality semantics and rejects a schema-2-only field', async () => {
  const root = await makeWorkspace();
  await prepareQuality(root);
  assert.equal((await quality.inspectQualityReport(root)).verdict, 'PASS');
  const configPath = join(root, 'harness50.quality.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.requirements = { inventory_sha256: 'a'.repeat(64) };
  await writeFile(configPath, JSON.stringify(config));
  assert.notEqual((await quality.runQualityGate(root)).verdict, 'PASS');
});

test('native Step14 rejects a mapped requirement omitted from otherwise passing final matrices', async () => {
  const { root } = await fixture();
  await quality.runQualityGate(root);
  await finalQa(root, false);
  await assert.rejects(validateCompletionEvidence({ contract, evidence, workspaceRoot: root, workflowProfile: PROFILE }),
    error => error.code === 'ACCEPTANCE_REQUIREMENTS_INCOMPLETE');
});

test('native Step14 accepts mapped current requirement evidence and binds existing report receipts', async () => {
  const { root } = await fixture();
  await quality.runQualityGate(root);
  await finalQa(root);
  const result = await validateCompletionEvidence({ contract, evidence, workspaceRoot: root, workflowProfile: PROFILE });
  assert.ok(result.evidence.some(item => item.acceptance_id === 'measured-quality-report'));
  assert.ok(result.evidence.some(item => item.acceptance_id === 'final-regression-report'));
});

test('shared final requirement inspection rejects omitted and subsequently changed evidence', async () => {
  assert.equal(typeof quality.inspectRequirementCompletion, 'function', 'missing shared final requirement inspector');
  const { root } = await fixture();
  await quality.runQualityGate(root);
  await finalQa(root, false);
  assert.equal((await quality.inspectRequirementCompletion(root)).verdict, 'INCOMPLETE');
  await finalQa(root);
  assert.equal((await quality.inspectRequirementCompletion(root)).verdict, 'PASS');
  await writeFile(join(root, 'step_archive/outputs/requested-behavior.json'), '{}');
  assert.equal((await quality.inspectRequirementCompletion(root)).verdict, 'INCOMPLETE');
});

test('Claude final inspection includes the shared requirement gate without executing checks', async () => {
  const { root } = await fixture();
  await quality.runQualityGate(root);
  await finalQa(root, false);
  let stdout;
  try { ({ stdout } = await run(process.execPath, [gateCli, '--inspect-final', '--workspace', root])); }
  catch (error) { stdout = error.stdout; }
  const result = JSON.parse(stdout);
  assert.equal(result.verdict, 'INCOMPLETE');
  assert.equal(result.requirements?.verdict, 'INCOMPLETE');
});

test('native completion rechecks requirement binding after artifact callbacks', async () => {
  const { root, config, configPath } = await fixture();
  await quality.runQualityGate(root);
  await finalQa(root);
  let changed = false;
  await assert.rejects(validateCompletionEvidence({ contract, evidence, workspaceRoot: root, workflowProfile: PROFILE,
    afterArtifactOpen: async () => {
      if (changed) return;
      changed = true;
      config.requirements.inventory_sha256 = 'b'.repeat(64);
      await writeFile(configPath, JSON.stringify(config));
    } }), error => ['ACCEPTANCE_QUALITY_INCOMPLETE', 'ACCEPTANCE_REQUIREMENTS_INCOMPLETE', 'ACCEPTANCE_ARTIFACT_CHANGED'].includes(error.code));
});
