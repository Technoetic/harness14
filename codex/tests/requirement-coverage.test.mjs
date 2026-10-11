import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, link } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { makeWorkspace, makeDirectoryLink, writeClaudeFixture } from './helpers/workspace.mjs';
import { snapshotQa, recordQa } from '../../scripts/lib/qa-report.mjs';
import { withReadBudget, readBudgetUsage } from '../../scripts/lib/read-budget.mjs';

const api = await import('../../scripts/lib/requirement-coverage.mjs').catch(() => ({}));
const cli = fileURLToPath(new URL('../../scripts/requirement-coverage.mjs', import.meta.url));
const profile = 'planning-first-14-v1';
const reviewed = () => ({ schema_version: 1,
  requirements: [{ id: 'R-total', acceptance_ids: ['AC-total'] }, { id: 'R-route', acceptance_ids: ['AC-route'] }],
  acceptance: [{ id: 'AC-total', check_ids: ['total'] }, { id: 'AC-route', check_ids: ['route'] }] });

async function fixture({ active = false, topic = null } = {}) {
  assert.equal(typeof api.freezeRequirements, 'function', 'reviewed requirement freeze API must exist');
  assert.equal(typeof api.inspectRequirementInventory, 'function', 'inventory inspection API must exist');
  assert.equal(typeof api.inspectRequirementCoverage, 'function', 'coverage inspection API must exist');
  const root = await makeWorkspace();
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'step_archive/outputs'), { recursive: true });
  await writeFile(join(root, 'src/app.js'), 'export const total = 7;');
  await writeFile(join(root, 'step_archive/outputs/test.json'), '{"total":7,"route":true}');
  if (active) await generation(root, '2026-10-11T01:00:00.000Z', topic ?? 'Explicit reviewed scope\n');
  else if (topic !== null) {
    await mkdir(join(root, 'step_archive/TOPIC'), { recursive: true });
    await writeFile(join(root, 'step_archive/TOPIC/TOPIC.md'), topic);
  }
  return { root, step: active ? 14 : 50 };
}

async function generation(root, at, topic = 'Explicit reviewed scope\n') {
  await writeClaudeFixture(root, { schema_version: 2, workflow_profile: profile, total_steps: 14,
    run_started_at: at, current_step: 14, completed_steps: [] }, { topic });
  await writeFile(join(root, 'step_archive/workflow-profile.json'), JSON.stringify({
    schema_version: 2, workflow_profile: profile, total_steps: 14 }));
}

async function pinnedFixture() {
  const f = await fixture({ active: true });
  await mkdir(join(f.root, 'step_archive/.harness50-codex'), { recursive: true });
  await writeFile(join(f.root, 'step_archive/.harness50-codex/state.json'), JSON.stringify({
    schema_version: 2, workflow_profile: profile, total_steps: 14, workflow_id: 'pinned-coverage-review',
    topic_sha256: createHash('sha256').update(await readFile(join(f.root, 'step_archive/TOPIC/TOPIC.md'))).digest('hex') }));
  return f;
}

async function finalQa(root, step, { ids = ['total', 'route'], mode = 'independent', statuses = {} } = {}) {
  const snapshot = await snapshotQa(root, step, { artifacts: ['src/app.js'],
    checks: ids.map(id => ({ id, requirement: `Verify ${id}.` })) });
  return recordQa(root, step, { snapshot_id: snapshot.snapshot_id, verifier: { id: 'reviewer-2', mode },
    outcomes: ids.map(id => ({ id, status: statuses[id] ?? 'pass', observation: `Observed ${id}.`,
      evidence_paths: statuses[id] === 'unverified' ? [] : ['step_archive/outputs/test.json'],
      next_check: statuses[id] ? 'Run the mandatory check.' : '' })), next_actions: [] });
}

function options(frozen, extra = {}) { return { inventorySha256: frozen.inventory_sha256, ...extra }; }
function incomplete(result) { assert.equal(result.verdict, 'INCOMPLETE'); }

test('freezing explicitly reviewed IDs binds one immutable inventory and requires its expected hash', async () => {
  const { root } = await fixture();
  const frozen = await api.freezeRequirements(root, reviewed());
  assert.equal(frozen.status, 'frozen');
  assert.equal(frozen.verdict, 'PASS');
  assert.match(frozen.inventory_sha256, /^[a-f0-9]{64}$/);
  assert.equal(frozen.requirement_count, 2);
  assert.equal(frozen.acceptance_count, 2);
  assert.equal(frozen.check_count, 2);
  assert.equal((await api.inspectRequirementInventory(root, options(frozen))).verdict, 'PASS');
  incomplete(await api.inspectRequirementInventory(root));
  incomplete(await api.inspectRequirementInventory(root, { inventorySha256: 'a'.repeat(64) }));
  incomplete(await api.inspectRequirementCoverage(root, options(frozen)));
  await assert.rejects(() => api.freezeRequirements(root, reviewed()));
  const weaker = reviewed(); weaker.requirements.pop(); weaker.acceptance.pop();
  await assert.rejects(() => api.freezeRequirements(root, weaker));
  assert.equal((await api.inspectRequirementInventory(root, options(frozen))).inventory_sha256, frozen.inventory_sha256);
});

test('empty, orphaned, unknown, ambiguous or credential-shaped inventory links are rejected', async () => {
  const mutations = [
    p => { p.requirements = []; }, p => { p.acceptance = []; },
    p => { p.requirements[0].acceptance_ids = []; }, p => { p.acceptance[0].check_ids = []; },
    p => { p.requirements[0].acceptance_ids = ['AC-unknown']; },
    p => { p.requirements.pop(); }, p => { p.requirements[0].optional = true; },
    p => { p.requirements[1].id = 'r-TOTAL'; }, p => { p.acceptance[1].id = 'ac-TOTAL'; },
    p => { p.acceptance[0].check_ids = ['total', 'TOTAL']; },
    p => { p.acceptance[1].check_ids = ['TOTAL']; },
    p => { p.requirements[0].acceptance_ids = ['AC-total', 'ac-total']; },
    p => { p.acceptance[0].check_ids = ['sk-abcdefghijklmnop1234567890']; },
    p => { p.requirements[0].id = 'password:private-value'; },
    p => { p.requirements[0].id = 'R-total\n'; },
    p => { p.requirements[0].id = 'x'.repeat(65537); }
  ];
  for (const mutate of mutations) {
    const { root } = await fixture(); const input = reviewed(); mutate(input);
    await assert.rejects(() => api.freezeRequirements(root, input), error => {
      assert.equal(error.message, 'Requirement inventory rejected: invalid, unsafe, changed or already frozen input.');
      return true;
    });
    incomplete(await api.inspectRequirementInventory(root, { inventorySha256: 'a'.repeat(64) }));
  }
});

test('a frozen mapping reaches PASS only with all mandatory IDs in current independent final QA', async () => {
  const { root, step } = await fixture({ active: true });
  const frozen = await api.freezeRequirements(root, reviewed(), { workflowProfile: profile });
  await finalQa(root, step - 1);
  incomplete(await api.inspectRequirementCoverage(root, options(frozen)));
  const qa = await finalQa(root, step);
  const result = await api.inspectRequirementCoverage(root, options(frozen));
  assert.equal(result.status, 'current'); assert.equal(result.verdict, 'PASS');
  assert.equal(result.final_step, 14); assert.equal(result.report_sha256, qa.report_sha256);
  assert.deepEqual(result.requirements, [{ id: 'R-total', status: 'PASS' }, { id: 'R-route', status: 'PASS' }]);
  assert.deepEqual(result.acceptance, [{ id: 'AC-total', status: 'PASS' }, { id: 'AC-route', status: 'PASS' }]);
  assert.deepEqual(result.checks, [{ id: 'total', status: 'PASS' }, { id: 'route', status: 'PASS' }]);
  assert.equal('report' in result, false);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes('Observed'), false);
});

test('omitting or renaming mandatory checks and same-agent final QA remain incomplete', async () => {
  for (const qaOptions of [{ ids: ['total'] }, { ids: ['total', 'renamed-route'] }, { mode: 'same-agent' },
    { statuses: { route: 'fail' } }, { statuses: { route: 'unverified' } }]) {
    const { root, step } = await fixture(); const frozen = await api.freezeRequirements(root, reviewed());
    await finalQa(root, step, qaOptions);
    incomplete(await api.inspectRequirementCoverage(root, options(frozen)));
  }
});

test('changed candidate or evidence invalidates previously complete coverage', async () => {
  for (const name of ['src/app.js', 'step_archive/outputs/test.json']) {
    const { root, step } = await fixture(); const frozen = await api.freezeRequirements(root, reviewed());
    await finalQa(root, step);
    assert.equal((await api.inspectRequirementCoverage(root, options(frozen))).verdict, 'PASS');
    await writeFile(join(root, name), 'changed');
    incomplete(await api.inspectRequirementCoverage(root, options(frozen)));
  }
});

test('changed frozen inventory bytes cannot weaken the check mapping', async () => {
  const { root, step } = await fixture(); const frozen = await api.freezeRequirements(root, reviewed());
  await finalQa(root, step);
  const base = join(root, 'step_archive/outputs/requirement-coverage');
  const name = (await readdir(base)).find(name => name.endsWith('.inventory.json'));
  assert.ok(name, 'frozen original-byte inventory must be stored');
  const file = join(base, name); const input = JSON.parse(await readFile(file, 'utf8'));
  input.requirements.pop(); input.acceptance.pop();
  await writeFile(file, `${JSON.stringify(input)}\n`);
  incomplete(await api.inspectRequirementInventory(root, options(frozen)));
  incomplete(await api.inspectRequirementCoverage(root, options(frozen)));
});

test('workflow generation, profile and TOPIC changes invalidate inventory reuse', async () => {
  for (const mutate of [
    root => generation(root, '2026-10-11T02:00:00.000Z'),
    root => writeFile(join(root, 'step_archive/TOPIC/TOPIC.md'), 'Changed scope\n')
  ]) {
    const { root, step } = await fixture({ active: true }); const frozen = await api.freezeRequirements(root, reviewed());
    await finalQa(root, step); await mutate(root);
    incomplete(await api.inspectRequirementInventory(root, options(frozen)));
    incomplete(await api.inspectRequirementCoverage(root, options(frozen)));
  }
  const { root } = await fixture({ active: true }); const frozen = await api.freezeRequirements(root, reviewed());
  incomplete(await api.inspectRequirementInventory(root, options(frozen, { workflowProfile: 'legacy-50-v1' })));
  const legacy = await fixture({ topic: 'Legacy explicitly reviewed scope\n' });
  const old = await api.freezeRequirements(legacy.root, reviewed());
  await writeFile(join(legacy.root, 'step_archive/TOPIC/TOPIC.md'), 'Changed legacy scope\n');
  incomplete(await api.inspectRequirementInventory(legacy.root, options(old)));
});

test('physical-path aliases and hard-linked frozen inventory are rejected', async () => {
  const { root } = await fixture(); const elsewhere = await makeWorkspace();
  await makeDirectoryLink(elsewhere, join(root, 'step_archive/outputs/requirement-coverage'));
  await assert.rejects(() => api.freezeRequirements(root, reviewed()));
  const f = await fixture(); const frozen = await api.freezeRequirements(f.root, reviewed());
  const base = join(f.root, 'step_archive/outputs/requirement-coverage');
  const name = (await readdir(base)).find(name => name.endsWith('.inventory.json'));
  await link(join(base, name), join(f.root, 'inventory-alias.json'));
  incomplete(await api.inspectRequirementInventory(f.root, options(frozen)));
});

test('coverage inspection rechecks frozen scope after host path-policy callbacks and executes no commands', async () => {
  const { root, step } = await fixture({ topic: 'Frozen scope\n' });
  const frozen = await api.freezeRequirements(root, reviewed()); await finalQa(root, step);
  await writeFile(join(root, 'harness50.quality.json'), JSON.stringify({ checks: { test: { command: [process.execPath,
    '-e', `require('node:fs').writeFileSync('executed-marker','bad')`] } } }));
  assert.equal((await api.inspectRequirementCoverage(root, options(frozen))).verdict, 'PASS');
  assert.equal((await readdir(root)).includes('executed-marker'), false);
  let changed = false;
  const pathPolicy = () => { if (!changed) { changed = true; writeFileSync(join(root, 'step_archive/TOPIC/TOPIC.md'), 'Changed callback scope\n'); } };
  incomplete(await api.inspectRequirementCoverage(root, options(frozen, { pathPolicy })));
});

test('pinned final coverage rejects evidence changed by a late artifact-policy callback', async () => {
  const { root, step } = await pinnedFixture();
  const frozen = await api.freezeRequirements(root, reviewed()); await finalQa(root, step);
  let evidenceSeen = false, changed = false;
  const pathPolicy = (_path, kind) => {
    if (kind === 'evidence') evidenceSeen = true;
    if (kind === 'artifact' && evidenceSeen && !changed) {
      changed = true; writeFileSync(join(root, 'step_archive/outputs/test.json'), '{"total":99,"route":false}');
    }
  };
  incomplete(await api.inspectRequirementCoverage(root, options(frozen, { pathPolicy })));
  assert.equal(changed, true);
  incomplete(await api.inspectRequirementCoverage(root, options(frozen)));
});

test('the final QA recheck uses cached authorization without repeating host callback side effects', async () => {
  const { root, step } = await pinnedFixture(); const frozen = await api.freezeRequirements(root, reviewed());
  await finalQa(root, step); const seen = [];
  const pathPolicy = (path, kind) => {
    assert.ok((kind === 'artifact' && path === 'src/app.js') || (kind === 'evidence' && path === 'step_archive/outputs/test.json'));
    seen.push(`${kind}:${path}`);
    if (seen.length > 3) throw new Error('Host callback must not repeat during the final recheck.');
  };
  assert.equal((await api.inspectRequirementCoverage(root, options(frozen, { pathPolicy }))).verdict, 'PASS');
  assert.deepEqual(seen, ['artifact:src/app.js', 'evidence:step_archive/outputs/test.json', 'artifact:src/app.js']);
});

test('cached final QA authorization rejects a fresh unselected body before reading it', async () => {
  const { root, step } = await pinnedFixture(); const frozen = await api.freezeRequirements(root, reviewed());
  const unselectedSize = 1024 * 1024;
  await writeFile(join(root, 'src/unselected.js'), Buffer.alloc(unselectedSize, 'x'));
  const otherSnapshot = await snapshotQa(root, step, { artifacts: ['src/unselected.js'],
    checks: [{ id: 'total', requirement: 'Verify total.' }, { id: 'route', requirement: 'Verify route.' }] });
  await recordQa(root, step, { snapshot_id: otherSnapshot.snapshot_id, verifier: { id: 'reviewer-2', mode: 'independent' },
    outcomes: ['total', 'route'].map(id => ({ id, status: 'pass', observation: 'Observed result.',
      evidence_paths: ['step_archive/outputs/test.json'], next_check: '' })), next_actions: [] });
  const pointer = join(root, `step_archive/outputs/qa-reports/${profile}/${frozen.workflow_generation}/step014.latest.json`);
  const otherPointer = await readFile(pointer); await finalQa(root, step);
  let evidenceSeen = false, callbacksFinished = false, swapped = false;
  const pathPolicy = (path, kind) => {
    assert.notEqual(path, 'src/unselected.js', 'unselected paths must never be authorized by the host');
    if (kind === 'evidence') evidenceSeen = true;
    if (kind === 'artifact' && evidenceSeen) callbacksFinished = true;
  };
  const selected = { inventorySha256: frozen.inventory_sha256,
    get pathPolicy() {
      if (callbacksFinished && !swapped) { swapped = true; writeFileSync(pointer, otherPointer); }
      return pathPolicy;
    } };
  await withReadBudget(8 * 1024 * 1024, async () => {
    incomplete(await api.inspectRequirementCoverage(root, selected));
    assert.equal(swapped, true, 'the alternate report must reach the second inspection');
    assert.ok(readBudgetUsage().used < unselectedSize, 'the unselected artifact body must not be read');
  });
});

function run(args, input = '') {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', windowsHide: true,
    timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); return result;
}

test('bounded strict CLI freezes and inspects expected hashes with sanitized failures', async () => {
  const { root } = await fixture();
  const args = ['freeze', '--workspace', root, '--input', '-'];
  const frozenRun = run(args, JSON.stringify(reviewed()));
  assert.equal(frozenRun.status, 0, frozenRun.stderr); const frozen = JSON.parse(frozenRun.stdout);
  const inspected = run(['inspect-inventory', '--workspace', root, '--inventory-sha256', frozen.inventory_sha256]);
  assert.equal(inspected.status, 0, inspected.stderr); assert.equal(JSON.parse(inspected.stdout).verdict, 'PASS');
  const coverage = run(['inspect', '--workspace', root, '--inventory-sha256', frozen.inventory_sha256]);
  assert.equal(coverage.status, 2); assert.equal(JSON.parse(coverage.stdout).verdict, 'INCOMPLETE');
  const missing = run(['inspect-inventory', '--workspace', root]);
  assert.equal(missing.status, 2); assert.equal(JSON.parse(missing.stdout).verdict, 'INCOMPLETE');
  for (const input of ['{"schema_version":1,"schema_version":1}', Buffer.from([0xc3, 0x28]),
    JSON.stringify({ private: 'private-value'.repeat(6000) }), JSON.stringify({ password: 'private-value' })]) {
    const failure = run(args, input); assert.equal(failure.status, 2); assert.equal(failure.stdout, '');
    assert.deepEqual(JSON.parse(failure.stderr), { error: { code: 'REQUIREMENT_COMMAND_FAILED', message: 'Requirement coverage command failed' } });
    assert.equal(failure.stderr.includes('private-value'), false); assert.equal(failure.stderr.includes(root), false);
  }
  for (const flags of [['unknown'], ['inspect', '--workspace', root, '--workspace', root],
    ['inspect', '--workspace', root, '--input', '-']]) assert.equal(run(flags).status, 2);
});
