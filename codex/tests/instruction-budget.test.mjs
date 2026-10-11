import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const moduleUrl = new URL('../../scripts/lib/instruction-budget.mjs', import.meta.url);
const cli = fileURLToPath(new URL('../../scripts/instruction-budget.mjs', import.meta.url));
async function inspect(root, options = {}) {
  const module = await import(moduleUrl).catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.inspectInstructionBudget, 'function', 'instruction inventory inspector must exist');
  return module.inspectInstructionBudget(root, options);
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'h14-instruction-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = JSON.parse(await readFile(join(repo, 'scripts/instruction-budget.json'), 'utf8'));
  for (const file of registry.files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repo, file.path), target);
  }
  await mkdir(join(root, 'scripts'), { recursive: true });
  const save = async () => writeFile(join(root, 'scripts/instruction-budget.json'), JSON.stringify(registry));
  await save();
  return { root, registry, save };
}
function incomplete(result, code) {
  assert.equal(result.verdict, 'INCOMPLETE');
  assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result));
}
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test('inventory measures the real shipped tree without treating source bytes as runtime context', async () => {
  const result = await inspect(repo);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.issues));
  assert.equal(result.measurement.runtime_context_measured, false);
  assert.equal(result.measurement.runtime_tokens_measured, false);
  assert.equal(result.measurement.billing_measured, false);
  const file = result.files.find(file => file.path === 'codex/skills/webapp/SKILL.md');
  assert.ok(file.utf8_bytes > 20000);
  assert.equal(file.surface, 'codex-base');
  assert.equal(result.files.filter(file => file.surface === 'codex-selected-steps').length, 14);
  assert.equal(result.files.filter(file => file.surface === 'claude-selected-steps').length, 14);
  assert.ok(result.surfaces.some(surface => surface.delivery === 'on-demand'));
  assert.equal(JSON.stringify(result).includes('Route the request before workflow operations'), false);
});

test('a physical copy passes and Unicode sizes count original bytes and code points', async t => {
  await inspect(repo);
  const f = await fixture(t);
  await writeFile(join(f.root, 'skills/chunk-writer/SKILL.md'), 'A한😀\n');
  const result = await inspect(f.root);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.issues));
  const file = result.files.find(file => file.path === 'skills/chunk-writer/SKILL.md');
  assert.equal(file.utf8_bytes, 9);
  assert.equal(file.unicode_characters, 4);
  assert.equal(file.utf16_code_units, 5);
});

test('actual growth beyond a file budget stays incomplete without truncating instructions', async t => {
  await inspect(repo);
  const f = await fixture(t);
  const file = f.registry.files.find(file => file.path === 'skills/chunk-writer/SKILL.md');
  await writeFile(join(f.root, file.path), 'X'.repeat(file.max_bytes + 1));
  const result = await inspect(f.root);
  incomplete(result, 'FILE_BUDGET_EXCEEDED');
  assert.equal(result.files.find(entry => entry.path === file.path).utf8_bytes, file.max_bytes + 1);
  assert.equal((await readFile(join(f.root, file.path))).length, file.max_bytes + 1);
});

test('a surface budget and a Unicode character budget are independently enforced', async t => {
  await inspect(repo);
  const f = await fixture(t);
  const role = f.registry.files.find(file => file.path === 'skills/chunk-writer/SKILL.md');
  role.max_unicode_characters = 3;
  await writeFile(join(f.root, role.path), 'A한😀\n');
  f.registry.surfaces.find(surface => surface.id === 'codex-base').max_bytes = 1;
  await f.save();
  const result = await inspect(f.root);
  incomplete(result, 'FILE_BUDGET_EXCEEDED');
  incomplete(result, 'SURFACE_BUDGET_EXCEEDED');
});

test('missing required files and companion reference targets cannot pass', async t => {
  await inspect(repo);
  const f = await fixture(t);
  await rm(join(f.root, 'docs/instruction-budget.md'));
  const result = await inspect(f.root);
  incomplete(result, 'FILE_UNAVAILABLE');
  incomplete(result, 'REFERENCE_UNAVAILABLE');
});

test('a missing declared companion pointer in a base instruction stays incomplete', async t => {
  await inspect(repo);
  const f = await fixture(t);
  const path = join(f.root, 'codex/skills/webapp/SKILL.md');
  const body = await readFile(path, 'utf8');
  await writeFile(path, body.replaceAll('docs/instruction-budget.md', 'docs/removed.md'));
  incomplete(await inspect(f.root), 'REFERENCE_NOT_DECLARED');
});

test('removing a mandatory file or changing its delivery surface rejects the registry', async t => {
  await inspect(repo);
  for (const mutation of [
    registry => { registry.files = registry.files.filter(file => file.path !== 'codex/skills/webapp/SKILL.md'); },
    registry => { registry.files.find(file => file.path === 'codex/skills/webapp/SKILL.md').surface = 'claude-base'; },
    registry => { registry.required_references = registry.required_references.filter(reference => reference.to !== 'docs/instruction-budget.md'); },
    registry => { registry.surfaces.find(surface => surface.id === 'codex-base').delivery = 'selected-step'; },
  ]) {
    const f = await fixture(t); mutation(f.registry); await f.save();
    incomplete(await inspect(f.root), 'REGISTRY_INVALID');
  }
});

test('duplicate paths, case aliases, unknown references and unsafe instruction paths are rejected', async t => {
  await inspect(repo);
  for (const mutation of [
    registry => { registry.files.push({ ...registry.files[0] }); },
    registry => { registry.files.push({ ...registry.files[0], path: registry.files[0].path.toUpperCase() }); },
    registry => { registry.required_references.push({ from: registry.files[0].path, to: 'docs/unregistered.md' }); },
    registry => { registry.files[0].path = '../outside.md'; },
    registry => { registry.files[0].path = 'docs/.env'; },
    registry => { registry.files[0].path = 'docs/password.md'; },
    registry => { registry.files[0].path = 'codex\\skills\\webapp\\SKILL.md'; },
    registry => { registry.files[0].path = 'docs/file.md:secret'; },
  ]) {
    const f = await fixture(t); mutation(f.registry); await f.save();
    const result = await inspect(f.root);
    incomplete(result, 'REGISTRY_INVALID');
    assert.equal(result.files.length, 0);
    assert.equal(JSON.stringify(result).includes('password'), false);
  }
});

test('invalid schemas, duplicate JSON keys and resource bounds reject before file measurement', async t => {
  await inspect(repo);
  for (const mutation of [
    registry => { registry.schema_version = 2; },
    registry => { registry.password = 'SECRET_SENTINEL'; },
    registry => { registry.files[0].max_bytes = 128 * 1024 + 1; },
    registry => { registry.files[0].max_bytes = 0; },
    registry => { registry.files[0].max_unicode_characters = 1.5; },
    registry => { registry.files = Array.from({ length: 129 }, () => ({ ...registry.files[0] })); },
    registry => { registry.surfaces[0].max_bytes = Number.MAX_SAFE_INTEGER; },
  ]) {
    const f = await fixture(t); mutation(f.registry); await f.save();
    incomplete(await inspect(f.root), 'REGISTRY_INVALID');
  }
  const f = await fixture(t);
  await writeFile(join(f.root, 'scripts/instruction-budget.json'), '{"schema_version":1,"schema_version":1}');
  incomplete(await inspect(f.root), 'REGISTRY_INVALID');
  await writeFile(join(f.root, 'scripts/instruction-budget.json'), ' '.repeat(128 * 1024 + 1));
  incomplete(await inspect(f.root), 'REGISTRY_UNAVAILABLE');
});

test('oversized instruction files and malformed UTF-8 are rejected without exposing their bodies', async t => {
  await inspect(repo);
  const f = await fixture(t);
  const path = join(f.root, 'skills/chunk-writer/SKILL.md');
  await writeFile(path, 'SECRET_SENTINEL'.repeat(10000));
  const oversized = await inspect(f.root);
  incomplete(oversized, 'FILE_UNAVAILABLE');
  assert.equal(JSON.stringify(oversized).includes('SECRET_SENTINEL'), false);
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  incomplete(await inspect(f.root), 'FILE_UNAVAILABLE');
});

test('hard links, linked instruction directories and aliased roots cannot pass', async t => {
  await inspect(repo);
  const f = await fixture(t);
  await link(join(f.root, 'skills/chunk-writer/SKILL.md'), join(f.root, 'linked.md'));
  incomplete(await inspect(f.root), 'FILE_UNAVAILABLE');
  await rm(join(f.root, 'linked.md'));
  const moved = join(f.root, 'actual-skills');
  await cp(join(f.root, 'skills'), moved, { recursive: true });
  await rm(join(f.root, 'skills'), { recursive: true });
  await symlink(moved, join(f.root, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  incomplete(await inspect(f.root), 'FILE_UNAVAILABLE');
  const alias = `${f.root}-alias`;
  t.after(() => rm(alias, { recursive: true, force: true }));
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  incomplete(await inspect(alias), 'PLUGIN_ROOT_UNAVAILABLE');
});

test('CLI supports an explicit safe registry and emits metadata with meaningful exit codes', async t => {
  await inspect(repo);
  const f = await fixture(t);
  const success = run(['--root', f.root]);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stderr, '');
  assert.equal(JSON.parse(success.stdout).verdict, 'PASS');
  await mkdir(join(f.root, 'docs'), { recursive: true });
  await writeFile(join(f.root, 'docs/custom-budget.json'), JSON.stringify(f.registry));
  assert.equal(run(['--root', f.root, '--registry', 'docs/custom-budget.json']).status, 0);
  await rm(join(f.root, 'docs/instruction-budget.md'));
  const missing = run(['--root', f.root]);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).verdict, 'INCOMPLETE');
});

test('CLI rejects unsafe, duplicate and unsupported flags without reflecting submitted values', async () => {
  await inspect(repo);
  for (const args of [
    ['--root', repo, '--registry', '.env'],
    ['--root', repo, '--registry', '../secret.json'],
    ['--root', repo, '--registry', 'docs/password.json'],
    ['--root', repo, '--root', 'SECRET_SENTINEL'],
    ['--root', repo, '--unknown', 'SECRET_SENTINEL'],
    ['--root'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(`${result.stdout}${result.stderr}`.includes('SECRET_SENTINEL'), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes('password'), false);
  }
});

test('API limits registry selection to explicit budget files and rejects unsupported options', async () => {
  await inspect(repo);
  for (const options of [
    { registryPath: 'docs/auth.json' },
    { registryPath: 'docs/login.json' },
    { registryPath: '../instruction-budget.json' },
    { registryPath: 'scripts/instruction-budget.json', unsupported: 'SECRET_SENTINEL' },
    { registry: 'SECRET_SENTINEL' },
  ]) {
    const result = await inspect(repo, options);
    incomplete(result, 'REGISTRY_INVALID');
    assert.equal(result.files.length, 0);
    assert.equal(JSON.stringify(result).includes('SECRET_SENTINEL'), false);
  }
});
