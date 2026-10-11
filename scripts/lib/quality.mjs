import { spawn, execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { physicalWorkspace, safePath, readSafe, writeSafe, sourceFingerprint, sha256 } from './quality-files.mjs';

import { workflowContext, recheckWorkflowContext } from './workflow-context.mjs';
import { parseStrictJson } from './strict-json.mjs';
import { unsafeJevText } from './sensitive-data.mjs';
import { inspectRequirementInventory, inspectRequirementCoverage } from './requirement-coverage.mjs';

export const REPORT_PATH = 'step_archive/outputs/quality-gate.json';
const CONFIG_PATH = 'harness50.quality.json';
const CHECKS = ['test', 'lint', 'typecheck', 'security'];
const METRICS = ['lines', 'statements', 'functions', 'branches'];
const MAX_TIMEOUT = 120000;
const MAX_TOTAL_TIMEOUT = 4 * MAX_TIMEOUT;
// Commands are explicitly configured project programs, not OS-sandboxed code. They
// must not silently receive the agent host's API keys or runtime loader overrides.
const CHILD_ENV_KEYS = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'CI', 'NO_COLOR', 'FORCE_COLOR', 'TERM']);
export function commandEnvironment(parent = process.env) {
  return Object.fromEntries(Object.entries(parent).filter(([name, value]) => CHILD_ENV_KEYS.has(name.toUpperCase()) && typeof value === 'string'));
}

function parseConfig(bytes) {
  const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (![1, 2].includes(value?.schema_version) || !value.checks || CHECKS.some(name => {
    const command = value.checks[name]?.command;
    return !Array.isArray(command) || command.length === 0 || command.length > 64 || command.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0') || arg.length > 8192);
  }) || typeof value.coverage?.path !== 'string' || !value.coverage.path.startsWith('coverage/') || !Number.isFinite(value.coverage.minimum) || value.coverage.minimum < 85 || value.coverage.minimum > 100) {
    throw new Error('Invalid quality config: four check argv arrays, a coverage/ report path and coverage minimum >= 85 required');
  }
  for (const name of CHECKS) {
    if (unsafeJevText(value.checks[name].command.join(' '))) throw new Error('Quality command contains sensitive or ambiguous argument text; use host-managed credentials');
  }
  if (value.schema_version === 2) {
    const requirements = value.requirements;
    if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)
        || Object.keys(requirements).length !== 1
        || !/^[a-f0-9]{64}$/.test(requirements.inventory_sha256 ?? '')) {
      throw new Error('Quality schema 2 requires the frozen requirement inventory SHA256');
    }
  } else if (Object.hasOwn(value, 'requirements')) {
    throw new Error('Requirement inventory binding requires quality schema 2');
  }
  return value;
}

async function configuredInventory(root, config, options = {}) {
  if (config.schema_version === 1) return null;
  const inventory = await inspectRequirementInventory(root, {
    ...options, inventorySha256: config.requirements.inventory_sha256
  });
  if (inventory.verdict !== 'PASS') throw new Error('Frozen requirement inventory is missing, changed or invalid');
  return inventory;
}

// Both host completion paths use this read-only final gate. A schema-1 project
// retains its historical meaning; schema 2 cannot replace omitted QA with PASS.
export async function inspectRequirementCompletion(workspaceRoot, options = {}) {
  try {
    const root = await physicalWorkspace(workspaceRoot);
    const context = await workflowContext(root, options);
    const configBytes = await readSafe(root, CONFIG_PATH, 65536);
    const config = parseConfig(configBytes);
    if (config.schema_version === 1) return { status: 'not_configured', verdict: 'NOT_CONFIGURED' };
    const result = await inspectRequirementCoverage(root, {
      ...options, inventorySha256: config.requirements.inventory_sha256
    });
    if (sha256(await readSafe(root, CONFIG_PATH, 65536)) !== sha256(configBytes)) {
      throw new Error('Requirement quality configuration changed during inspection');
    }
    await recheckWorkflowContext(root, context);
    return result;
  } catch { return { status: 'invalid', verdict: 'INCOMPLETE' }; }
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise(resolve => {
    let child, timer, finished = false, outputBytes = 0;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve({ command, exit_code: null, timed_out: false, output_limit: false, ...result });
    };
    const kill = () => {
      if (!child?.pid) return;
      if (process.platform === 'win32') execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    try {
      // No shell expansion. Windows .cmd files must be replaced with their Node CLI entry point.
      child = spawn(command[0] === 'node' ? process.execPath : command[0], command.slice(1), {
        cwd, env: commandEnvironment(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
      });
      const count = bytes => {
        outputBytes += bytes.length;
        if (outputBytes > 1024 * 1024) { kill(); finish({ output_limit: true }); }
      };
      child.stdout.on('data', count); child.stderr.on('data', count);
      child.on('error', error => finish({ error: error.code ?? 'COMMAND_ERROR' }));
      child.on('close', (code, signal) => finish({ exit_code: code, signal }));
      timer = setTimeout(() => { kill(); finish({ timed_out: true }); }, timeoutMs);
    } catch (error) { finish({ error: error.code ?? 'COMMAND_ERROR' }); }
  });
}

function commandPass(check) {
  return check?.exit_code === 0 && check.timed_out === false && check.output_limit === false && !check.error && !check.signal;
}

function coverageResult(bytes, minimum) {
  const summary = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const metrics = {};
  for (const name of METRICS) {
    const item = summary?.total?.[name];
    if (!Number.isInteger(item?.total) || !Number.isInteger(item?.covered) || item.total <= 0 || item.covered < 0 || item.covered > item.total) throw new Error(`Coverage ${name} lacks real measured totals`);
    // Compute from counts; never trust a supplied percentage alone.
    metrics[name] = 100 * item.covered / item.total;
  }
  return { generated_by: 'test', minimum, metrics, pass: METRICS.every(name => metrics[name] >= minimum), sha256: sha256(bytes) };
}

export async function prepareQualityGate(workspaceRoot) {
  const root = await physicalWorkspace(workspaceRoot);
  const bytes = await readSafe(root, CONFIG_PATH, 65536);
  const config = parseConfig(bytes);
  return { schema_version: 1, action: 'execute-quality-config', config_path: CONFIG_PATH, config_sha256: sha256(bytes),
    checks: config.checks, coverage: config.coverage, environment_keys: Object.keys(commandEnvironment()).sort(), shell: false,
    os_sandbox: false, requires_native_host_authorization: true, command_timeout_ms: MAX_TIMEOUT, total_timeout_ms: MAX_TOTAL_TIMEOUT,
    source: await sourceFingerprint(root) };
}

export async function runQualityGate(workspaceRoot, { timeoutMs = MAX_TIMEOUT, totalTimeoutMs = MAX_TOTAL_TIMEOUT, approvedConfigSha256 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) throw new Error('Invalid command timeout');
  if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > MAX_TOTAL_TIMEOUT) throw new Error('Invalid total quality timeout');
  const root = await physicalWorkspace(workspaceRoot);
  const context = await workflowContext(root);
  const report = { schema_version: context.generation ? 2 : 1, ...context.binding, generated_at: new Date().toISOString(), verdict: 'FAIL', checks: {}, coverage: null };
  try {
    const configBytes = await readSafe(root, CONFIG_PATH, 65536);
    const config = parseConfig(configBytes);
    report.config_sha256 = sha256(configBytes);
    const inventory = await configuredInventory(root, config);
    if (inventory) report.requirements_inventory_sha256 = inventory.inventory_sha256;
    if (approvedConfigSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(approvedConfigSha256) || approvedConfigSha256 !== report.config_sha256)) throw new Error('Approved quality config hash does not match the current config; execution stopped');
    if (approvedConfigSha256 !== undefined) report.approved_config_sha256 = approvedConfigSha256;
    const before = await sourceFingerprint(root);
    const deadline = Date.now() + totalTimeoutMs;
    report.execution_boundary = { shell: false, environment: 'allowlist', os_sandbox: false, total_timeout_ms: totalTimeoutMs };
    const recheckInputs = async () => {
      if (sha256(await readSafe(root, CONFIG_PATH, 65536)) !== report.config_sha256) throw new Error('Quality config changed during checks; execution stopped');
      if ((await sourceFingerprint(root)).sha256 !== before.sha256) throw new Error('Source changed during quality checks; execution stopped');
      await recheckWorkflowContext(root, context);
      await configuredInventory(root, config);
      if (Date.now() >= deadline) throw new Error('Total quality execution budget exceeded');
    };
    // A previous run's report cannot establish what this test invocation covered.
    // Only generated files under coverage/ are eligible for this cleanup.
    const coveragePath = await safePath(root, config.coverage.path, { createParents: true });
    await unlink(coveragePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const name of CHECKS) {
      await recheckInputs();
      report.checks[name] = await runCommand(config.checks[name].command, root, Math.min(timeoutMs, deadline - Date.now()));
      if (name === 'test') {
        try { report.coverage = coverageResult(await readSafe(root, config.coverage.path), config.coverage.minimum); }
        catch (error) { report.error = `Test did not produce valid fresh coverage: ${error.message}`; }
      }
      await recheckInputs();
    }
    report.source = await sourceFingerprint(root);
    if (before.sha256 !== report.source.sha256) throw new Error('Source changed during quality checks; rerun on stable input');
    if (report.coverage && sha256(await readSafe(root, config.coverage.path)) !== report.coverage.sha256) throw new Error('Coverage changed after the test invocation');
    if (!report.error && CHECKS.every(name => commandPass(report.checks[name])) && report.coverage?.pass) report.verdict = 'PASS';
  } catch (error) { report.error = error.message; }
  await recheckWorkflowContext(root, context);
  await writeSafe(root, REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function inspectQualityReport(workspaceRoot, options = {}) {
  try {
    const root = await physicalWorkspace(workspaceRoot);
    const context = await workflowContext(root, options);
    const report = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await readSafe(root, REPORT_PATH)));
    const configBytes = await readSafe(root, CONFIG_PATH, 65536);
    const config = parseConfig(configBytes);
    if ((report.schema_version !== (context.generation ? 2 : 1) || (context.generation && (report.workflow_profile !== context.profile.id || report.workflow_generation !== context.generation))) || report.verdict !== 'PASS' || report.error || report.config_sha256 !== sha256(configBytes) || !Number.isFinite(Date.parse(report.generated_at)) || CHECKS.some(name => !commandPass(report.checks?.[name]) || JSON.stringify(report.checks[name].command) !== JSON.stringify(config.checks[name].command))) throw new Error('Quality report does not contain four successful configured checks');
    const inventory = await configuredInventory(root, config, options);
    if (inventory && report.requirements_inventory_sha256 !== inventory.inventory_sha256) {
      throw new Error('Quality report does not bind the frozen requirement inventory');
    }
    const current = await sourceFingerprint(root);
    if (current.sha256 !== report.source?.sha256 || current.files !== report.source?.files) throw new Error('Quality report is stale: source fingerprint changed');
    const coverage = coverageResult(await readSafe(root, config.coverage.path), config.coverage.minimum);
    if (!coverage.pass || JSON.stringify(coverage) !== JSON.stringify(report.coverage)) throw new Error('Coverage evidence failed or changed');
    await recheckWorkflowContext(root, context);
    return report;
  } catch (error) { return { schema_version: 1, verdict: 'INCOMPLETE', error: error.message }; }
}
