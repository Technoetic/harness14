import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { initWorkflow } from '../scripts/lib/workflow.mjs';
import { parseReceipt } from '../scripts/lib/receipts.mjs';
import { makeWorkspace } from './helpers/workspace.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));

function runPowerShell(args, options) {
  // GitHub Actions starts Node from pwsh; let Windows PowerShell rebuild its own module path.
  return spawnSync('powershell.exe', args, {
    ...options,
    env: Object.fromEntries(Object.entries(options.env ?? process.env)
      .filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  });
}

test('isolated packaged preflight validates all four definitions and refuses missing shared dependencies or changed bodies', {
  skip: process.platform !== 'win32', timeout: 180000
}, async () => {
  const sandbox = await makeWorkspace(); // Existing helper guards cleanup beneath the temporary test root.
  const packaged = join(sandbox, 'package');
  const bin = join(sandbox, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'codex.cmd'), [
    '@echo off',
    'rem Isolated test fixture: version query only; no installation.',
    'if not "%~1"=="--version" exit /b 9',
    'if not "%~2"=="" exit /b 9',
    'echo codex-cli 0.150.1',
    'exit /b 0',
    ''
  ].join('\r\n'), 'utf8');
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path';
  const environment = { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` };
  for (const path of ['.codex-plugin', '.claude-plugin', 'codex', 'assets', 'hooks', 'scripts', 'docs']) {
    await cp(join(repo, path), join(packaged, path), {
      recursive: true, filter: path => !path.includes(`${join('codex', 'tests')}`)
    });
  }
  const smoke = () => {
    const result = runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(repo, 'codex/tests/install-smoke.ps1'), '-PluginRoot', packaged, '-Mode', 'Preflight'],
    { env: environment, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.ifError(result.error);
    return { exit: result.status, report: JSON.parse(result.stdout.trim()) };
  };
  const positive = smoke();
  assert.equal(positive.exit, 0, JSON.stringify(positive.report));
  assert.equal(positive.report.manifest.name, 'harness14');
  assert.equal(positive.report.manifest.version, '4.2.1');
  assert.equal(positive.report.codex_version, 'codex-cli 0.150.1');
  assert.equal(positive.report.step_count, 14);
  assert.deepEqual(positive.report.workflow_profiles, { 'legacy-50-v1': 50, 'research-free-36-v1': 36, 'planning-first-20-v1': 20, 'planning-first-14-v1': 14 });
  assert.equal(positive.report.shared_dependencies_verified, true);

  const dependency = join(packaged, 'scripts/lib/json-io.mjs');
  const originalDependency = await readFile(dependency);
  await rm(dependency);
  const missing = smoke();
  assert.equal(missing.exit, 1);
  assert.equal(missing.report.passed, false);
  await writeFile(dependency, originalDependency);

  const body = join(packaged, 'assets/profiles/research-free-36-v1/steps/step017.md');
  await writeFile(body, Buffer.concat([await readFile(body), Buffer.from('\nChanged packaged body\n')]));
  const changed = smoke();
  assert.equal(changed.exit, 1);
  assert.equal(changed.report.error_code, 'STEP_VALIDATION_FAILED');
});

test('native smoke readers use the validated selected profile and reject count or receipt cross-binding', {
  skip: process.platform !== 'win32', timeout: 60000
}, async () => {
  const fixture = await makeWorkspace();
  const smokeSource = await readFile(join(repo, 'codex/tests/install-smoke.ps1'), 'utf8');
  const mainOffset = smokeSource.lastIndexOf('\ntry {');
  assert.ok(mainOffset > 0);
  const paths = [];
  for (const workflowProfile of ['research-free-36-v1', 'legacy-50-v1', 'planning-first-20-v1', 'planning-first-14-v1']) {
    const workspaceRoot = await makeWorkspace();
    const state = await initWorkflow({ workspaceRoot, workflowProfile, topic: 'Public profile smoke fixture' });
    const receipt = parseReceipt({ schema_version: state.schema_version,
      ...(state.schema_version === 2 ? { workflow_profile: workflowProfile } : {}),
      workflow_id: state.workflow_id, step: 1, attempt_id: 'smoke-attempt', provenance: 'codex-verified',
      completed_at: state.created_at, summary: 'Public first-step fixture',
      evidence: [{ acceptance_id: 'required-tool-inventory', kind: 'check', detail: 'Synthetic reader evidence', ok: true }] });
    await mkdir(join(workspaceRoot, 'step_archive/.harness50-codex/receipts'), { recursive: true });
    await writeFile(join(workspaceRoot, 'step_archive/.harness50-codex/receipts/step001.json'), JSON.stringify(receipt));
    paths.push(workspaceRoot.replaceAll("'", "''"));
  }
  const script = `${smokeSource.slice(0, mainOffset)}
$newRoot = '${paths[0]}'
$legacyRoot = '${paths[1]}'
$planningRoot = '${paths[2]}'
$fourteenRoot = '${paths[3]}'
foreach ($case in @(@{root=$newRoot;profile='research-free-36-v1';total=36}, @{root=$legacyRoot;profile='legacy-50-v1';total=50}, @{root=$planningRoot;profile='planning-first-20-v1';total=20}, @{root=$fourteenRoot;profile='planning-first-14-v1';total=14})) {
  $state = Read-StrictJson (Resolve-SafeFile $case.root 'step_archive/.harness50-codex/state.json' 'State') 'State'
  [void](Assert-State $state $case.root 'Reader')
  $receipts = @(Read-Receipts $case.root $state.workflow_id 'Reader' $case.profile)
  if ($receipts.Count -ne 1) { throw 'Expected one receipt' }
  $sample = if ($case.total -eq 14) { 3 } else { 17 }
  $contract = Get-NativeStepContract $PluginRoot $sample $case.profile
  $body = 'step{0:D3}.md' -f $sample
  $expectedPath = if ($case.total -eq 50) { 'codex/assets/steps/' + $body } else { 'codex/assets/profiles/' + $case.profile + '/steps/' + $body }
  if ($contract.target -cne $expectedPath) { throw 'Wrong selected contract' }
  $state.total_steps = if ($case.total -eq 50) { 36 } else { 50 }
  try { [void](Assert-State $state $case.root 'Reader'); throw 'Count mismatch accepted' } catch {
    if ($_.Exception.Data['SmokeCode'] -cne 'STATE_INVALID') { throw }
  }
}
$state = Read-StrictJson (Resolve-SafeFile $newRoot 'step_archive/.harness50-codex/state.json' 'State') 'State'
try { [void](Read-Receipts $newRoot $state.workflow_id 'Reader' 'legacy-50-v1'); throw 'Cross-profile receipt accepted' } catch {
  if ($_.Exception.Data['SmokeCode'] -cne 'SCHEMA_INVALID') { throw }
}
Write-Output 'selected profile readers verified'
`;
  const scriptPath = join(fixture, 'profile-readers.ps1');
  await writeFile(scriptPath, script, 'utf8');
  const result = runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PluginRoot', repo],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'selected profile readers verified');
});

test('PowerShell smoke children hash safely despite an inherited incompatible Utility module', {
  skip: process.platform !== 'win32', timeout: 30000
}, async () => {
  const fixture = await makeWorkspace();
  const moduleRoot = join(fixture, 'Microsoft.PowerShell.Utility', '99.0.0');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(join(moduleRoot, 'Microsoft.PowerShell.Utility.psd1'),
    "@{RootModule='Microsoft.PowerShell.Utility.psm1';ModuleVersion='99.0.0';GUID='84579e8f-e2da-44eb-a0b7-ff23c9d52767';FunctionsToExport=@('Get-FileHash');CmdletsToExport=@();AliasesToExport=@()}", 'utf8');
  await writeFile(join(moduleRoot, 'Microsoft.PowerShell.Utility.psm1'),
    "function Get-FileHash { throw 'INCOMPATIBLE_POWERSHELL_MODULE_FIXTURE' }; Export-ModuleMember -Function Get-FileHash", 'utf8');
  await writeFile(join(fixture, 'hash-source.txt'), 'abc', 'utf8');
  const smokeSource = await readFile(join(repo, 'codex/tests/install-smoke.ps1'), 'utf8');
  const stopOffset = smokeSource.indexOf('function Stop-Smoke {');
  const hashOffset = smokeSource.indexOf('function Get-Sha256 {');
  assert.ok(stopOffset > 0 && hashOffset > stopOffset);
  const scriptPath = join(fixture, 'hash-reader.ps1');
  // Exercise the smoke's actual hash reader before other Utility cmdlets preload a default.
  await writeFile(scriptPath, `$ErrorActionPreference = 'Stop'
${smokeSource.slice(stopOffset, smokeSource.indexOf('function Test-IsReparsePoint {', stopOffset))}
${smokeSource.slice(hashOffset, smokeSource.indexOf('function Assert-SingleLinkFile {', hashOffset))}
Write-Output (Get-Sha256 '${join(fixture, 'hash-source.txt').replaceAll("'", "''")}')
Write-Output $env:HARNESS50_FIXTURE
`, 'utf8');
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    PsMoDuLePaTh: fixture,
    HARNESS50_FIXTURE: 'preserved'
  };
  const before = { ...environment };
  const result = runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { env: environment, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'preserved'
  ]);
  assert.deepEqual(environment, before);
});

test('installed identity validates explicit personal or harness14 marketplaces while preserving disabled legacy caches', {
  skip: process.platform !== 'win32', timeout: 60000
}, async () => {
  const fixture = await makeWorkspace();
  const codexHome = join(fixture, 'codex-home');
  const bin = join(fixture, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'codex.cmd'), [
    '@echo off',
    'rem Read-only installed catalog fixture; no installation or config writes.',
    'if not "%~1"=="plugin" exit /b 9',
    'if not "%~2"=="list" exit /b 9',
    'if not "%~3"=="--json" exit /b 9',
    'if not "%~4"=="" exit /b 9',
    'type "%~dp0catalog.json"',
    ''
  ].join('\r\n'), 'utf8');
  const manifest = JSON.parse(await readFile(join(repo, '.codex-plugin/plugin.json'), 'utf8'));
  const version = manifest.version;
  const smokeSource = await readFile(join(repo, 'codex/tests/install-smoke.ps1'), 'utf8');
  const mainOffset = smokeSource.lastIndexOf('\ntry {');
  assert.ok(mainOffset > 0);
  const scriptPath = join(fixture, 'identity-reader.ps1');
  const quotedBin = join(bin, 'codex.cmd').replaceAll("'", "''");
  await writeFile(scriptPath, `${smokeSource.slice(0, mainOffset)}
$script:CodexExecutable = '${quotedBin}'
$script:Report.manifest.name = 'harness14'
$script:Report.manifest.version = '${version}'
try {
  $resolved = Get-InstalledPluginRoot $PluginRoot $PluginRoot
  [ordered]@{ passed=$true; root=$resolved } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ passed=$false; error_code=$_.Exception.Data['SmokeCode']; message=$_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
`, 'utf8');
  const environment = { ...process.env, CODEX_HOME: codexHome };
  const legacyRoot = join(codexHome, 'plugins/cache/personal/harness50/2.13.0');
  await mkdir(legacyRoot, { recursive: true });
  const legacyFile = join(legacyRoot, 'preserved.txt');
  await writeFile(legacyFile, 'existing legacy cache stays unchanged', 'utf8');
  const researchFreeRoot = join(codexHome, 'plugins/cache/personal/harness36/3.0.0');
  await mkdir(researchFreeRoot, { recursive: true });
  const researchFreeFile = join(researchFreeRoot, 'preserved.txt');
  await writeFile(researchFreeFile, 'existing research-free cache stays unchanged', 'utf8');
  const oldTwentyRoot = join(codexHome, 'plugins/cache/personal/harness20/4.2.0');
  await mkdir(oldTwentyRoot, { recursive: true });
  const oldTwentyFile = join(oldTwentyRoot, 'preserved.txt');
  await writeFile(oldTwentyFile, 'existing twenty-step cache stays unchanged', 'utf8');
  const entry = (marketplaceName, sourcePath, overrides = {}) => ({
    pluginId: `harness14@${marketplaceName}`, name: 'harness14', marketplaceName, version,
    installed: true, enabled: true, source: { source: 'local', path: sourcePath },
    installPolicy: 'AVAILABLE', authPolicy: 'ON_INSTALL', ...overrides
  });
  const observe = async (marketplaceName, requestedRoot, installed) => {
    await writeFile(join(bin, 'catalog.json'), JSON.stringify({ installed, available: [] }), 'utf8');
    const result = runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-PluginRoot', requestedRoot, '-MarketplaceName', marketplaceName],
    { env: environment, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.ifError(result.error);
    return result;
  };
  for (const marketplaceName of ['personal', 'harness14']) {
    const sourceRoot = join(fixture, `source-${marketplaceName}`);
    const cacheRoot = join(codexHome, 'plugins/cache', marketplaceName, 'harness14', version);
    for (const root of [sourceRoot, cacheRoot]) {
      await mkdir(join(root, '.codex-plugin'), { recursive: true });
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await writeFile(join(root, '.codex-plugin/plugin.json'), JSON.stringify({
        name: 'harness14', version, skills: './codex/skills/', hooks: './codex/hooks/hooks.json'
      }), 'utf8');
      await writeFile(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'harness14' }), 'utf8');
    }
    const active = entry(marketplaceName, sourceRoot);
    const legacy = entry('personal', legacyRoot, { pluginId: 'harness50@personal', name: 'harness50', version: '2.13.0', enabled: false });
    const researchFree = entry('personal', researchFreeRoot, { pluginId: 'harness36@personal', name: 'harness36', version: '3.0.0', enabled: false });
    const oldTwenty = entry('personal', oldTwentyRoot, { pluginId: 'harness20@personal', name: 'harness20', version: '4.2.0', enabled: false });
    const positive = await observe(marketplaceName, cacheRoot, [active, oldTwenty, legacy, researchFree]);
    assert.equal(positive.status, 0, positive.stderr || positive.stdout);
    assert.deepEqual(JSON.parse(positive.stdout.trim()), { passed: true, root: cacheRoot });
    for (const [label, inputMarketplace, requestedRoot, installed] of [
      ['unsafe marketplace path', '../personal', cacheRoot, [active]],
      ['missing explicit marketplace', '', cacheRoot, [active]],
      ['wrong selected marketplace', marketplaceName === 'personal' ? 'harness14' : 'personal', cacheRoot, [active]],
      ['source used as active cache', marketplaceName, sourceRoot, [active]],
      ['unexpected plugin ID', marketplaceName, cacheRoot, [{ ...active, pluginId: 'harness50@personal' }]],
      ['twenty-step and renamed hooks both active', marketplaceName, cacheRoot, [active, { ...oldTwenty, enabled: true }]],
      ['malformed twenty-step activation', marketplaceName, cacheRoot, [active, { ...oldTwenty, enabled: 'false' }]],
      ['legacy and renamed hooks both active', marketplaceName, cacheRoot, [active, { ...legacy, enabled: true }]],
      ['research-free and renamed hooks both active', marketplaceName, cacheRoot, [active, { ...researchFree, enabled: true }]],
      ['malformed research-free activation', marketplaceName, cacheRoot, [active, { ...researchFree, enabled: 'false' }]],
      ['duplicate active renamed install', marketplaceName, cacheRoot, [active, entry('another', sourceRoot)]]
    ]) {
      const rejected = await observe(inputMarketplace, requestedRoot, installed);
      assert.equal(rejected.status, 1, `${label}: ${rejected.stdout}`);
      const report = JSON.parse(rejected.stdout.trim());
      assert.equal(report.passed, false, label);
      assert.ok(['PARAMETER_INVALID', 'PLUGIN_IDENTITY_FAILED'].includes(report.error_code), `${label}: ${rejected.stdout}`);
    }
    const sourceManifest = join(sourceRoot, '.codex-plugin/plugin.json');
    const previous = await readFile(sourceManifest);
    await writeFile(sourceManifest, JSON.stringify({ name: 'harness14', version, skills: './codex/skills/', hooks: './codex/hooks/hooks.json', changed: true }), 'utf8');
    const drifted = await observe(marketplaceName, cacheRoot, [active]);
    assert.equal(drifted.status, 1, drifted.stdout);
    assert.equal(JSON.parse(drifted.stdout.trim()).error_code, 'PLUGIN_IDENTITY_FAILED');
    await writeFile(sourceManifest, previous);
  }
  assert.equal(await readFile(oldTwentyFile, 'utf8'), 'existing twenty-step cache stays unchanged');
  assert.equal(await readFile(legacyFile, 'utf8'), 'existing legacy cache stays unchanged');
  assert.equal(await readFile(researchFreeFile, 'utf8'), 'existing research-free cache stays unchanged');
});
