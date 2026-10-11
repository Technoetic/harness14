import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rename, link } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, makeDirectoryLink } from './helpers/workspace.mjs';

const engine = await import('../../scripts/lib/diagnostic-delta.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tool = { id: 'typescript', version: '5.8.3', configuration_sha256: 'a'.repeat(64) };
const cli = fileURLToPath(new URL('../../scripts/diagnostic-delta.mjs', import.meta.url));
const topic = 'Repair only the explicitly selected application source.\n';

async function fixture() {
  const root = await makeWorkspace();
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/app.js'), 'export const answer = 1;\n');
  await writeFile(join(root, 'src/other.js'), 'export const other = 2;\n');
  await mkdir(join(root, 'step_archive/.harness50-codex'), { recursive: true });
  await mkdir(join(root, 'step_archive/TOPIC'), { recursive: true });
  await writeFile(join(root, 'step_archive/TOPIC/TOPIC.md'), topic);
  await writeState(root);
  return root;
}
async function writeState(root, generation = 'diagnostic-fixture', topicBytes = topic) {
  await writeFile(join(root, 'step_archive/.harness50-codex/state.json'), JSON.stringify({
    schema_version: 2, workflow_profile: 'planning-first-14-v1', total_steps: 14,
    workflow_id: generation, topic_sha256: digest(topicBytes)
  }));
}
function finding(code, message = 'An ordinary compiler finding.', overrides = {}) {
  return { file: 'src/app.js', code, severity: 'error', location: { line: 1, column: 1 }, message, ...overrides };
}
function input(diagnostics = [], files = ['src/app.js']) {
  return { schema_version: 1, tool: { ...tool }, files, diagnostics };
}
async function capture(root, value = input()) {
  assert.equal(typeof engine.captureDiagnostics, 'function', 'diagnostic capture API must exist');
  return engine.captureDiagnostics(root, value);
}
async function compare(root, value, baseline) {
  assert.equal(typeof engine.compareDiagnostics, 'function', 'diagnostic comparison API must exist');
  return engine.compareDiagnostics(root, value, { baseline });
}
function incomplete(result) {
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.advisory, true);
  assert.equal(result.verdict, undefined);
}

test('capture stores immutable generation-bound metadata and only a diagnostic message hash', async () => {
  const root = await fixture();
  const raw = 'Ordinary finding text which must never be persisted.';
  const result = await capture(root, input([finding('TS1001', raw)]));
  assert.equal(result.status, 'CAPTURED');
  assert.equal(result.advisory, true);
  assert.match(result.baseline.id, /^[a-f0-9-]{36}$/);
  assert.match(result.baseline.sha256, /^[a-f0-9]{64}$/);
  const expectedGeneration = digest(JSON.stringify(['codex', 'diagnostic-fixture']));
  assert.equal(result.artifact_path, `step_archive/outputs/diagnostics/planning-first-14-v1/${expectedGeneration}/baseline-${result.baseline.id}.json`);
  const bytes = await readFile(join(root, result.artifact_path));
  assert.equal(digest(bytes), result.baseline.sha256);
  const artifact = JSON.parse(bytes);
  assert.equal(artifact.workflow_generation, expectedGeneration);
  assert.equal(artifact.topic_sha256, digest(topic));
  assert.deepEqual(artifact.sources, [{ path: 'src/app.js', sha256: digest('export const answer = 1;\n') }]);
  assert.equal(artifact.diagnostics[0].message_sha256, digest(raw));
  assert.equal(artifact.diagnostics[0].message, undefined);
  assert.equal(bytes.includes(Buffer.from(raw)), false);
  assert.equal(JSON.stringify(result).includes(raw), false);
  const another = await capture(root, input([finding('TS1001', raw)]));
  assert.notEqual(another.baseline.id, result.baseline.id);
  assert.deepEqual(await readFile(join(root, result.artifact_path)), bytes);
});

test('equal-count replacements report introduced and resolved findings after source changes', async () => {
  const root = await fixture();
  const baseline = await capture(root, input([finding('TS1001'), finding('TS2001', 'Retained finding.')]));
  await writeFile(join(root, 'src/app.js'), 'export const answer = 2;\n');
  const value = input([finding('TS3001'), finding('TS2001', 'Retained finding.')]);
  const result = await compare(root, value, baseline.baseline);
  assert.equal(result.status, 'COMPARED');
  assert.equal(result.advisory, true);
  assert.deepEqual(result.counts, { baseline: 2, current: 2, introduced: 1, resolved: 1, retained: 1 });
  assert.equal(result.introduced[0].code, 'TS3001');
  assert.equal(result.resolved[0].code, 'TS1001');
  assert.equal(result.retained[0].code, 'TS2001');
  assert.deepEqual(result.sources, [{ path: 'src/app.js', baseline_sha256: digest('export const answer = 1;\n'), current_sha256: digest('export const answer = 2;\n') }]);
  const artifact = JSON.parse(await readFile(join(root, result.artifact_path)));
  assert.equal(artifact.status, 'COMPARED');
  assert.equal(artifact.baseline.sha256, baseline.baseline.sha256);
  assert.equal(artifact.introduced[0].message, undefined);
  assert.deepEqual((await compare(root, value, baseline.baseline)).counts, result.counts);
  incomplete(await compare(root, value, result.comparison));
});

test('diagnostic identity includes file, code, severity, complete location and message digest', async () => {
  const root = await fixture();
  const before = finding('TS1001', 'Before.', { location: { line: 1, column: 1, end_line: 1, end_column: 3 } });
  const baseline = await capture(root, input([before], ['src/app.js', 'src/other.js']));
  for (const change of [
    { file: 'src/other.js' }, { code: 'TS2001' }, { severity: 'warning' },
    { location: { line: 1, column: 2, end_line: 1, end_column: 3 } },
    { location: { line: 1, column: 1, end_line: 1, end_column: 4 } }, { message: 'After.' }
  ]) {
    const result = await compare(root, input([{ ...before, ...change }], ['src/app.js', 'src/other.js']), baseline.baseline);
    assert.equal(result.status, 'COMPARED');
    assert.deepEqual(result.counts, { baseline: 1, current: 1, introduced: 1, resolved: 1, retained: 0 });
  }
});

test('tool version, configuration and selected file scope mismatches are incomparable', async () => {
  const root = await fixture();
  const baseline = await capture(root);
  for (const change of [
    value => { value.tool.id = 'eslint'; }, value => { value.tool.version = '6.0.0'; },
    value => { value.tool.configuration_sha256 = 'b'.repeat(64); }, value => { value.files = ['src/other.js']; }
  ]) {
    const value = input(); change(value);
    const result = await compare(root, value, baseline.baseline);
    assert.equal(result.status, 'INCOMPARABLE');
    assert.equal(result.artifact_path, undefined);
  }
});

test('generation changes and changed approved TOPIC reject old baseline references', async () => {
  const root = await fixture();
  const baseline = await capture(root);
  await writeState(root, 'next-workflow');
  assert.notEqual((await compare(root, input(), baseline.baseline)).status, 'COMPARED');
  await writeState(root);
  const changedTopic = 'A different approved scope.\n';
  await writeFile(join(root, 'step_archive/TOPIC/TOPIC.md'), changedTopic);
  await writeState(root, 'diagnostic-fixture', changedTopic);
  assert.equal((await compare(root, input(), baseline.baseline)).status, 'INCOMPARABLE');
});

test('comparison requires an exact digest reference and detects modified baseline bytes', async () => {
  const root = await fixture();
  const baseline = await capture(root);
  for (const reference of [undefined, { id: baseline.baseline.id }, { ...baseline.baseline, sha256: 'b'.repeat(64) },
    { ...baseline.baseline, path: 'src/app.js' }, { id: '../.env', sha256: baseline.baseline.sha256 }]) {
    incomplete(await compare(root, input(), reference));
  }
  await writeFile(join(root, baseline.artifact_path), `${await readFile(join(root, baseline.artifact_path), 'utf8')} `);
  incomplete(await compare(root, input(), baseline.baseline));
});

test('tampered artifact metadata never directs reads of unselected files', async () => {
  const root = await fixture();
  const baseline = await capture(root);
  const artifact = JSON.parse(await readFile(join(root, baseline.artifact_path)));
  artifact.sources[0].path = '.env';
  const bytes = Buffer.from(JSON.stringify(artifact));
  await writeFile(join(root, baseline.artifact_path), bytes);
  incomplete(await compare(root, input(), { ...baseline.baseline, sha256: digest(bytes) }));
});

test('missing and renamed selected sources cannot establish a comparable snapshot', async () => {
  const root = await fixture();
  const baseline = await capture(root);
  await rename(join(root, 'src/app.js'), join(root, 'src/renamed.js'));
  incomplete(await compare(root, input(), baseline.baseline));
  assert.equal((await compare(root, input([], ['src/renamed.js']), baseline.baseline)).status, 'INCOMPARABLE');
});

test('private, secret, traversal, generated and unselected diagnostic paths are rejected before persistence', async () => {
  const root = await fixture();
  for (const name of ['.env', 'src/.env.local', 'private/context.js', 'src/secrets.js', 'src/api-key.json',
    'src/id_rsa', 'src/certificate.pem', '../outside.js', 'src\\app.js', 'src/app.js:secret',
    'step_archive/TOPIC/TOPIC.md', 'node_modules/tool.js', 'src/a./app.js']) {
    incomplete(await capture(root, input([], [name])));
  }
  incomplete(await capture(root, input([finding('TS1001', 'Ordinary.', { file: 'src/other.js' })])));
  await assert.rejects(readdir(join(root, 'step_archive/outputs/diagnostics')), { code: 'ENOENT' });
});

test('directory aliases and hard-linked source files are refused', async () => {
  const root = await fixture();
  const privateRoot = await makeWorkspace();
  await writeFile(join(privateRoot, 'context.js'), 'Private unselected context.');
  await makeDirectoryLink(privateRoot, join(root, 'alias'));
  incomplete(await capture(root, input([], ['alias/context.js'])));
  await link(join(root, 'src/app.js'), join(root, 'src/copied.js'));
  incomplete(await capture(root, input([], ['src/copied.js'])));
});

test('duplicates, malformed fields and ambiguous JSON fail with no artifacts', async () => {
  const root = await fixture();
  const duplicate = finding('TS1001');
  const bad = [input([duplicate, duplicate]), input([], ['src/app.js', 'src/app.js']),
    input([], ['src/app.js', 'src/APP.js']), { ...input(), command: ['node', '-e', 'process.exit(0)'] },
    { ...input(), tool: { id: 'typescript', version: '5.8.3' } },
    { ...input(), tool: { ...tool, configuration_sha256: [tool.configuration_sha256] } },
    input([finding('TS1001', 'Ordinary.', { severity: 'fatal' })]),
    input([finding('TS1001', 'Ordinary.', { location: { line: 0, column: 1 } })]),
    input([finding('TS1001', 'Ordinary.', { location: { line: 2, column: 1, end_line: 1, end_column: 1 } })]),
    input([finding('TS1001', 'Ordinary.', { extra: 'unreviewed' })]),
    '{"schema_version":1,"schema_version":1}', Buffer.from([0xff, 0xfe]),
    JSON.stringify(input([finding('TS1001', 'replace-me')])).replace('replace-me', '\ud800')];
  for (const value of bad) incomplete(await capture(root, value));
  const accessor = input();
  Object.defineProperty(accessor, 'private', { enumerable: true, get() { throw Error('must not invoke getter'); } });
  incomplete(await capture(root, accessor));
});

test('explicit file count, diagnostic count, input bytes and source bytes are bounded', async () => {
  const root = await fixture();
  const tooManyFiles = input([], Array.from({ length: 129 }, (_, i) => `src/file${i}.js`));
  const tooManyFindings = input(Array.from({ length: 513 }, (_, i) => finding(`TS${i}`)));
  const tooManyBytes = input([finding('TS1001', 'ordinary '.repeat(9000))]);
  for (const value of [tooManyFiles, tooManyFindings, tooManyBytes]) incomplete(await capture(root, value));
  await writeFile(join(root, 'src/app.js'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  incomplete(await capture(root));
});

test('a valid 512-finding input remains comparable when metadata exceeds the input byte limit', async () => {
  const root = await fixture();
  const value = input(Array.from({ length: 512 }, (_, i) => finding(`TS${i}`, 'x')));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 65536);
  const baseline = await capture(root, value);
  assert.equal(baseline.status, 'CAPTURED');
  assert.ok((await readFile(join(root, baseline.artifact_path))).length > 65536);
  const result = await compare(root, value, baseline.baseline);
  assert.equal(result.status, 'COMPARED');
  assert.deepEqual(result.counts, { baseline: 512, current: 512, introduced: 0, resolved: 0, retained: 512 });
  const replacements = input(Array.from({ length: 512 }, (_, i) => finding(`ERR${i}`, 'x')));
  const replaced = await compare(root, replacements, baseline.baseline);
  assert.equal(replaced.status, 'COMPARED');
  assert.deepEqual(replaced.counts, { baseline: 512, current: 512, introduced: 512, resolved: 512, retained: 0 });
});

test('non-JSON symbol fields cannot be silently dropped from API input', async () => {
  const root = await fixture();
  const value = input();
  value[Symbol('hidden field')] = 'unreviewed input';
  incomplete(await capture(root, value));
});

test('aggregate source bounds accept sixteen MiB but refuse a larger explicit source set', async () => {
  const root = await fixture();
  const files = Array.from({ length: 17 }, (_, i) => `src/bound${i}.js`);
  const bytes = Buffer.alloc(1024 * 1024, 0x61);
  for (const name of files) await writeFile(join(root, name), bytes);
  incomplete(await capture(root, input([], files)));
  const accepted = await capture(root, input([], files.slice(0, 16)));
  assert.equal(accepted.status, 'CAPTURED');
  assert.equal(accepted.sources.length, 16);
});

test('missing active generation or a changed pinned TOPIC cannot create a baseline', async () => {
  const root = await fixture();
  await writeFile(join(root, 'step_archive/TOPIC/TOPIC.md'), 'Unapproved topic bytes.\n');
  incomplete(await capture(root));
  const missing = await makeWorkspace();
  await mkdir(join(missing, 'src'));
  await writeFile(join(missing, 'src/app.js'), 'Ordinary source.');
  incomplete(await capture(missing));
});

test('credential-shaped fields and messages are rejected without echoing or persisting values', async () => {
  const root = await fixture();
  const secrets = ['password=synthetic-private-value', 'Authorization: Bearer synthetic-token',
    'sk-1234567890abcdefghijklmnopqrstuvwxyz', '-----BEGIN PRIVATE KEY-----'];
  for (const secret of secrets) {
    const result = await capture(root, input([finding('TS1001', secret)]));
    incomplete(result);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  incomplete(await capture(root, { ...input(), password: 'synthetic-private-value' }));
  await assert.rejects(readdir(join(root, 'step_archive/outputs/diagnostics')), { code: 'ENOENT' });
});

test('CLI captures and compares stdin snapshots without dumping raw diagnostics', async () => {
  const root = await fixture();
  const raw = 'Ordinary CLI finding text which must never be dumped.';
  const run = (args, value) => spawnSync(process.execPath, [cli, ...args], {
    input: typeof value === 'string' ? value : JSON.stringify(value), encoding: 'utf8', timeout: 10000, windowsHide: true
  });
  const captured = run(['capture', '--workspace', root, '--input', '-'], input([finding('TS1001', raw)]));
  assert.equal(captured.status, 0, captured.stderr);
  assert.equal(captured.stdout.includes(raw), false);
  const baseline = JSON.parse(captured.stdout).baseline;
  const compared = run(['compare', '--workspace', root, '--input', '-', '--baseline-id', baseline.id, '--baseline-sha256', baseline.sha256], input([finding('TS2001')]));
  assert.equal(compared.status, 0, compared.stderr);
  assert.equal(JSON.parse(compared.stdout).status, 'COMPARED');
  for (const args of [[], ['run'], ['capture', '--workspace', root, '--input', 'private.json'],
    ['compare', '--workspace', root, '--input', '-'], ['capture', '--workspace', root, '--input', '-', '--command', 'private-command']]) {
    const failed = run(args, 'password=synthetic-private-value');
    assert.notEqual(failed.status, 0);
    assert.equal(`${failed.stdout}${failed.stderr}`.includes('synthetic-private-value'), false);
  }
  const secret = 'password=synthetic-private-value';
  const failed = run(['capture', '--workspace', root, '--input', '-'], input([finding('TS1001', secret)]));
  assert.notEqual(failed.status, 0);
  assert.equal(`${failed.stdout}${failed.stderr}`.includes(secret), false);
});
