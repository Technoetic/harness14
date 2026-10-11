import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { physicalWorkspace, readSafe, safePath, sha256 } from './quality-files.mjs';
import { workflowContext, recheckWorkflowContext, evidenceDirectory } from './workflow-context.mjs';
import { parseStrictJson } from './strict-json.mjs';
import { validateJevStructure, unsafeJevText } from './sensitive-data.mjs';
import { withReadBudget } from './read-budget.mjs';

const INPUT_LIMIT = 65536;
const ARTIFACT_LIMIT = 512 * 1024;
const SOURCE_LIMIT = 1024 * 1024;
const TOTAL_SOURCE_LIMIT = 16 * SOURCE_LIMIT;
const REQUEST_READ_LIMIT = 64 * SOURCE_LIMIT;
const TOPIC_PATH = 'step_archive/TOPIC/TOPIC.md';
const BASE_DIRECTORY = 'step_archive/outputs/diagnostics';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const isHash = value => typeof value === 'string' && HASH.test(value);
const isUuid = value => typeof value === 'string' && UUID.test(value);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$/;
const SEVERITIES = new Set(['error', 'warning', 'info', 'hint']);
const FORBIDDEN_DIRECTORY = new Set(['step_archive', 'node_modules', 'coverage', 'test-results', 'playwright-report']);
const PRIVATE_NAME = /(?:^|[._ -])(?:env|private|secrets?|credentials?|passwords?|tokens?|api[_-]?keys?|private[_-]?keys?|id_rsa|id_ed25519)(?:[._ -]|$)/i;

class DiagnosticFailure extends Error {
  constructor(message, status = 'INCOMPLETE') { super(message); this.status = status; }
}
function reject(message = 'Diagnostic input is invalid or exceeds its bounds.', status) {
  throw new DiagnosticFailure(message, status);
}
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) reject();
}
function validateInputStructure(value) {
  validateJevStructure(value);
  const visit = item => {
    if (item !== null && typeof item === 'object') {
      if (Object.getOwnPropertySymbols(item).length) reject();
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) visit(descriptor.value);
    }
  };
  visit(value);
}
function text(value, maximum = 128) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum && !unsafeJevText(value);
}
function sourcePath(value) {
  if (!text(value, 512) || value !== value.normalize('NFC') || value.includes('\\') || /[<>:"|?*]/.test(value)) reject();
  const parts = value.split('/');
  if (parts.length > 32 || parts.some(part => {
    const normalized = part.normalize('NFKC');
    return !part || normalized.startsWith('.') || /[. ]$/.test(normalized)
      || FORBIDDEN_DIRECTORY.has(normalized.toLowerCase()) || PRIVATE_NAME.test(normalized)
      || /\.(?:pem|key|p12|pfx|keystore)$/i.test(normalized)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized);
  })) reject('Selected source paths must be ordinary, explicit, nonprivate relative files.');
  return value;
}
function uniquePaths(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 128) reject();
  const seen = new Set();
  const result = paths.map(path => {
    sourcePath(path);
    const folded = path.normalize('NFKC').toLowerCase();
    if (seen.has(folded)) reject('Duplicate selected source paths are not allowed.');
    seen.add(folded);
    return path;
  });
  return result.sort();
}
function producingTool(value) {
  fields(value, ['id', 'version', 'configuration_sha256']);
  if (!text(value.id) || !TOKEN.test(value.id) || !text(value.version) || !TOKEN.test(value.version)
      || !isHash(value.configuration_sha256)) reject('Tool ID, version and explicit configuration SHA256 are required.');
  return { id: value.id, version: value.version, configuration_sha256: value.configuration_sha256 };
}
function location(value) {
  fields(value, ['line', 'column'], ['end_line', 'end_column']);
  const validCoordinate = item => Number.isSafeInteger(item) && item >= 1 && item <= 10000000;
  const end = Object.hasOwn(value, 'end_line');
  if (!validCoordinate(value.line) || !validCoordinate(value.column) || end !== Object.hasOwn(value, 'end_column')
      || (end && (!validCoordinate(value.end_line) || !validCoordinate(value.end_column)
        || value.end_line < value.line || (value.end_line === value.line && value.end_column < value.column)))) reject();
  return { line: value.line, column: value.column, ...(end ? { end_line: value.end_line, end_column: value.end_column } : {}) };
}
function identity(value) {
  return sha256(JSON.stringify([value.file, value.code, value.severity,
    [value.location.line, value.location.column, value.location.end_line ?? null, value.location.end_column ?? null], value.message_sha256]));
}
function diagnostics(values, files, stored = false) {
  if (!Array.isArray(values) || values.length > 512) reject();
  const selected = new Set(files), seen = new Set();
  return values.map(value => {
    fields(value, ['file', 'code', 'severity', 'location', ...(stored ? ['message_sha256', 'identity_sha256'] : ['message'])]);
    if (!selected.has(value.file) || !text(value.code) || !TOKEN.test(value.code) || !SEVERITIES.has(value.severity)) reject();
    const normalized = { file: value.file, code: value.code, severity: value.severity, location: location(value.location) };
    if (stored) {
      if (!isHash(value.message_sha256) || !isHash(value.identity_sha256)) reject();
      normalized.message_sha256 = value.message_sha256;
    } else {
      if (!text(value.message, 4096)) reject();
      normalized.message_sha256 = sha256(value.message);
    }
    normalized.identity_sha256 = identity(normalized);
    if ((stored && normalized.identity_sha256 !== value.identity_sha256) || seen.has(normalized.identity_sha256)) reject('Diagnostic identities must be unique and valid.');
    seen.add(normalized.identity_sha256);
    return normalized;
  }).sort((a, b) => a.identity_sha256.localeCompare(b.identity_sha256));
}
function parseInput(input) {
  let value = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if ((typeof input === 'string' && input.length > INPUT_LIMIT) || Buffer.byteLength(input) > INPUT_LIMIT) reject();
    if (typeof input === 'string' && Buffer.from(input, 'utf8').toString('utf8') !== input) reject();
    value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(input)), { maxDepth: 8 });
  }
  // Validate descriptors before JSON.stringify: accessors, cycles and non-JSON
  // values must never run code or erase unreviewed fields during normalization.
  validateInputStructure(value);
  if (Buffer.byteLength(JSON.stringify(value)) > INPUT_LIMIT) reject();
  fields(value, ['schema_version', 'tool', 'files', 'diagnostics']);
  if (value.schema_version !== 1) reject();
  const files = uniquePaths(value.files);
  return { tool: producingTool(value.tool), files, diagnostics: diagnostics(value.diagnostics, files) };
}
function parseOptions(options, comparing) {
  validateInputStructure(options);
  fields(options, [], comparing ? ['workflowProfile', 'baseline'] : ['workflowProfile']);
  if (options.workflowProfile !== undefined && (!text(options.workflowProfile, 80) || !/^[a-z0-9-]+$/.test(options.workflowProfile))) reject();
  if (comparing) {
    fields(options.baseline, ['id', 'sha256']);
    if (!isUuid(options.baseline.id) || !isHash(options.baseline.sha256)) reject('An exact immutable baseline UUID and SHA256 reference are required.');
  }
  return { ...(options.workflowProfile === undefined ? {} : { workflowProfile: options.workflowProfile }),
    ...(comparing ? { baseline: { id: options.baseline.id, sha256: options.baseline.sha256 } } : {}) };
}
async function sourceHashes(root, files) {
  let total = 0;
  const sources = [];
  for (const path of files) {
    const bytes = await readSafe(root, path, Math.max(1, Math.min(SOURCE_LIMIT, TOTAL_SOURCE_LIMIT - total)));
    total += bytes.length;
    if (total > TOTAL_SOURCE_LIMIT) reject('Selected source byte budget exceeded.');
    sources.push({ path, sha256: sha256(bytes) });
  }
  return sources;
}
async function snapshot(root, normalized, context) {
  if (!context.generation) reject('An active workflow generation is required.');
  return { ...context.binding, topic_sha256: sha256(await readSafe(root, TOPIC_PATH, SOURCE_LIMIT)),
    tool: normalized.tool, sources: await sourceHashes(root, normalized.files), diagnostics: normalized.diagnostics };
}
async function recheckSnapshot(root, normalized, context, captured) {
  await recheckWorkflowContext(root, context);
  if (sha256(await readSafe(root, TOPIC_PATH, SOURCE_LIMIT)) !== captured.topic_sha256
      || JSON.stringify(await sourceHashes(root, normalized.files)) !== JSON.stringify(captured.sources)) {
    reject('Workflow scope or selected source files changed during the snapshot.');
  }
}
function artifactPath(context, kind, id) {
  return `${evidenceDirectory(BASE_DIRECTORY, context)}/${kind}-${id}.json`;
}
async function storeImmutable(root, name, record) {
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  if (bytes.length > ARTIFACT_LIMIT) reject('Diagnostic artifact exceeds its byte limit.');
  const path = await safePath(root, name, { createParents: true });
  const handle = await open(path, 'wx', 0o600);
  try { await safePath(root, name); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await safePath(root, name);
  if (sha256(await readSafe(root, name, ARTIFACT_LIMIT)) !== sha256(bytes)) reject('Diagnostic artifact changed during storage.');
  return sha256(bytes);
}
function validateBaseline(value, id) {
  // This is strict parsed JSON, not caller-owned objects. Its exact metadata
  // schema is bounded below; the 64-KiB outbound-prose guard is input-only.
  fields(value, ['schema_version', 'kind', 'status', 'advisory', 'id', 'generated_at', 'workflow_profile',
    'workflow_generation', 'topic_sha256', 'tool', 'sources', 'diagnostics']);
  if (value.schema_version !== 1 || value.kind !== 'diagnostic-baseline' || value.status !== 'CAPTURED' || value.advisory !== true
      || value.id !== id || !text(value.workflow_profile, 80) || !isHash(value.workflow_generation)
      || !isHash(value.topic_sha256) || typeof value.generated_at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.generated_at) || !Number.isFinite(Date.parse(value.generated_at))
      || !Array.isArray(value.sources)) reject('Baseline diagnostic metadata is invalid.');
  const files = uniquePaths(value.sources.map(source => {
    fields(source, ['path', 'sha256']);
    if (!isHash(source.sha256)) reject();
    return source.path;
  }));
  if (JSON.stringify(files) !== JSON.stringify(value.sources.map(source => source.path))) reject();
  const normalized = diagnostics(value.diagnostics, files, true);
  if (JSON.stringify(normalized) !== JSON.stringify(value.diagnostics)) reject();
  return { ...value, tool: producingTool(value.tool) };
}
function failure(error) {
  return { status: error instanceof DiagnosticFailure ? error.status : 'INCOMPLETE', advisory: true,
    error: error instanceof DiagnosticFailure ? error.message : 'Diagnostic input or evidence is invalid, unavailable or changed.' };
}

/** Capture metadata only; this never executes the diagnostic-producing tool. */
export async function captureDiagnostics(workspaceRoot, input, options = {}) {
  try {
    return await withReadBudget(REQUEST_READ_LIMIT, async () => {
      const normalized = parseInput(input), selectedOptions = parseOptions(options, false);
      const root = await physicalWorkspace(workspaceRoot);
      const context = await workflowContext(root, selectedOptions);
      const captured = await snapshot(root, normalized, context);
      const id = randomUUID(), name = artifactPath(context, 'baseline', id);
      const artifact = { schema_version: 1, kind: 'diagnostic-baseline', status: 'CAPTURED', advisory: true,
        id, generated_at: new Date().toISOString(), ...captured };
      await recheckSnapshot(root, normalized, context, captured);
      const hash = await storeImmutable(root, name, artifact);
      await recheckSnapshot(root, normalized, context, captured);
      return { status: 'CAPTURED', advisory: true, baseline: { id, sha256: hash }, artifact_path: name, ...captured };
    });
  } catch (error) { return failure(error); }
}

/** Compare identities within an exact scope; source contents are allowed to change. */
export async function compareDiagnostics(workspaceRoot, input, options = {}) {
  try {
    return await withReadBudget(REQUEST_READ_LIMIT, async () => {
      const normalized = parseInput(input), selectedOptions = parseOptions(options, true);
      const root = await physicalWorkspace(workspaceRoot);
      const context = await workflowContext(root, selectedOptions);
      if (!context.generation) reject('An active workflow generation is required.');
      const baselineName = artifactPath(context, 'baseline', selectedOptions.baseline.id);
      const bytes = await readSafe(root, baselineName, ARTIFACT_LIMIT);
      if (sha256(bytes) !== selectedOptions.baseline.sha256) reject('Baseline bytes do not match the supplied SHA256 reference.');
      const baseline = validateBaseline(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), selectedOptions.baseline.id);
      // Artifact source paths are metadata only: all source reads below are driven
      // by the independently supplied, validated current file selection.
      if (baseline.workflow_profile !== context.profile.id || baseline.workflow_generation !== context.generation
          || JSON.stringify(baseline.tool) !== JSON.stringify(normalized.tool)
          || JSON.stringify(baseline.sources.map(source => source.path)) !== JSON.stringify(normalized.files)) {
        reject('Baseline workflow, tool/configuration or explicitly selected scope is incompatible.', 'INCOMPARABLE');
      }
      const current = await snapshot(root, normalized, context);
      if (current.topic_sha256 !== baseline.topic_sha256) reject('The approved TOPIC scope differs from the baseline.', 'INCOMPARABLE');
      const before = new Map(baseline.diagnostics.map(item => [item.identity_sha256, item]));
      const after = new Map(current.diagnostics.map(item => [item.identity_sha256, item]));
      const introduced = current.diagnostics.filter(item => !before.has(item.identity_sha256));
      const resolved = baseline.diagnostics.filter(item => !after.has(item.identity_sha256));
      const retained = current.diagnostics.filter(item => before.has(item.identity_sha256));
      const id = randomUUID(), name = artifactPath(context, 'comparison', id);
      const result = { schema_version: 1, kind: 'diagnostic-comparison', status: 'COMPARED', advisory: true, id,
        generated_at: new Date().toISOString(), ...context.binding, topic_sha256: current.topic_sha256,
        tool: current.tool, baseline: selectedOptions.baseline,
        sources: current.sources.map((source, index) => ({ path: source.path, baseline_sha256: baseline.sources[index].sha256, current_sha256: source.sha256 })),
        counts: { baseline: before.size, current: after.size, introduced: introduced.length, resolved: resolved.length, retained: retained.length },
        introduced, resolved, retained };
      const recheck = async () => {
        await recheckSnapshot(root, normalized, context, current);
        if (sha256(await readSafe(root, baselineName, ARTIFACT_LIMIT)) !== selectedOptions.baseline.sha256) reject('Baseline changed during comparison.');
      };
      await recheck();
      const hash = await storeImmutable(root, name, result);
      await recheck();
      return { ...result, comparison: { id, sha256: hash }, artifact_path: name };
    });
  } catch (error) { return failure(error); }
}
