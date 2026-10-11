import { resolve } from 'node:path';
import { physicalWorkspace, readSafe, sha256 } from './quality-files.mjs';
import { parseStrictJson } from './strict-json.mjs';
import { withReadBudget } from './read-budget.mjs';

const MAX_FILES = 128;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = MAX_FILES * MAX_FILE_BYTES;
const DEFAULT_REGISTRY = 'scripts/instruction-budget.json';
const DELIVERY = new Map([
  ['codex-base', 'base'], ['codex-controls', 'control'],
  ['codex-selected-steps', 'selected-step'], ['claude-base', 'base'],
  ['claude-commands', 'command'], ['claude-selected-steps', 'selected-step'],
  ['role-instructions', 'role'], ['companion-documents', 'on-demand'],
]);
// This small delivery contract is independent of editable size limits. Removing a
// binding instruction from the registry cannot make the shipped-tree check pass.
const REQUIRED_FILES = new Map([
  ['codex/skills/webapp/SKILL.md', 'codex-base'],
  ['codex/skills/harness14-status/SKILL.md', 'codex-controls'],
  ['codex/skills/harness14-reset/SKILL.md', 'codex-controls'],
  ['skills/harness-rules/SKILL.md', 'claude-base'],
  ['skills/evaluator/SKILL.md', 'role-instructions'],
  ['skills/chunk-writer/SKILL.md', 'role-instructions'],
  ['skills/debug-step/SKILL.md', 'role-instructions'],
  ['agents/step-executor.md', 'role-instructions'],
  ...['webapp', 'harness-status', 'harness-resume', 'harness-reset', 'harness-pause']
    .map(name => [`commands/${name}.md`, 'claude-commands']),
  ...['BROWSER-TOOLS', 'DESIGN-CONTRACT', 'FINAL-SUMMARY', 'QA-REPORTS', 'QUALITY',
    'RETIRED-VALIDATORS', 'ROUTING', 'SECURITY', 'experience-memory',
    'jev-checkpoints', 'jev-first', 'jev-first-contract', 'instruction-budget',
    'requirement-coverage', 'diagnostic-delta']
    .map(name => [`docs/${name}.md`, 'companion-documents']),
]);
for (let step = 1; step <= 14; step++) {
  const filename = `step${String(step).padStart(3, '0')}.md`;
  REQUIRED_FILES.set(`codex/assets/profiles/planning-first-14-v1/steps/${filename}`, 'codex-selected-steps');
  REQUIRED_FILES.set(`assets/profiles/planning-first-14-v1/steps/${filename}`, 'claude-selected-steps');
}
const REQUIRED_REFERENCES = ['codex/skills/webapp/SKILL.md', 'skills/harness-rules/SKILL.md']
  .flatMap(from => ['instruction-budget', 'requirement-coverage', 'diagnostic-delta']
    .map(name => ({ from, to: `docs/${name}.md` })));
const decodeUtf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const object = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function keys(value, expected) {
  return object(value) && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}
const limit = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;
const referenceKey = reference => `${reference.from}\0${reference.to}`;
function registryPath(value) {
  // Registry selection is local plugin data, never an arbitrary credential read.
  return typeof value === 'string' && value.length <= 200
    && /^(?:scripts|docs)\/[a-z0-9][a-z0-9-]*-budget\.json$/.test(value)
    && !/(?:secret|credential|token|password|private|env)/i.test(value);
}
function validateRegistry(value) {
  if (!keys(value, ['schema_version', 'files', 'surfaces', 'required_references'])
    || value.schema_version !== 1 || !Array.isArray(value.files)
    || value.files.length < 1 || value.files.length > MAX_FILES
    || !Array.isArray(value.surfaces) || value.surfaces.length !== DELIVERY.size
    || !Array.isArray(value.required_references) || value.required_references.length > MAX_FILES) throw Error();
  const paths = new Set();
  for (const file of value.files) {
    if (!keys(file, ['path', 'surface', 'max_bytes', 'max_unicode_characters'])
      || REQUIRED_FILES.get(file.path) !== file.surface || !REQUIRED_FILES.has(file.path)
      || paths.has(file.path.toLowerCase()) || !limit(file.max_bytes, MAX_FILE_BYTES)
      || !limit(file.max_unicode_characters, MAX_FILE_BYTES)) throw Error();
    paths.add(file.path.toLowerCase());
  }
  if ([...REQUIRED_FILES.keys()].some(path => !paths.has(path.toLowerCase()))) throw Error();
  const surfaces = new Set();
  for (const surface of value.surfaces) {
    if (!keys(surface, ['id', 'delivery', 'max_bytes', 'max_unicode_characters'])
      || !DELIVERY.has(surface.id) || DELIVERY.get(surface.id) !== surface.delivery
      || surfaces.has(surface.id) || !limit(surface.max_bytes, MAX_TOTAL_BYTES)
      || !limit(surface.max_unicode_characters, MAX_TOTAL_BYTES)) throw Error();
    surfaces.add(surface.id);
  }
  const references = new Set();
  for (const reference of value.required_references) {
    if (!keys(reference, ['from', 'to']) || !REQUIRED_FILES.has(reference.from)
      || !REQUIRED_FILES.has(reference.to) || reference.from === reference.to
      || references.has(referenceKey(reference))) throw Error();
    references.add(referenceKey(reference));
  }
  if (REQUIRED_REFERENCES.some(reference => !references.has(referenceKey(reference)))) throw Error();
  return value;
}
function report() {
  return {
    schema_version: 1,
    verdict: 'INCOMPLETE',
    scope: 'current-harness14-installed-source',
    measurement: {
      byte_unit: 'UTF-8 bytes', character_unit: 'Unicode code points',
      surface_aggregation: 'sum of explicitly registered installed files',
      runtime_context_measured: false, runtime_tokens_measured: false, billing_measured: false,
    },
    files: [], surfaces: [], references: [], issues: [],
  };
}
async function inspect(pluginRoot, options) {
  const result = report();
  const fail = code => { result.issues.push({ code }); return result; };
  if (!object(options) || Object.keys(options).some(key => key !== 'registryPath')
    || (Object.hasOwn(options, 'registryPath') && !registryPath(options.registryPath))) return fail('REGISTRY_INVALID');
  let root;
  try {
    if (typeof pluginRoot !== 'string' || !pluginRoot || pluginRoot.length > 2048 || pluginRoot.includes('\0')) throw Error();
    root = await physicalWorkspace(pluginRoot);
    const requested = resolve(pluginRoot);
    if (process.platform === 'win32' ? root.toLowerCase() !== requested.toLowerCase() : root !== requested) throw Error();
  } catch { return fail('PLUGIN_ROOT_UNAVAILABLE'); }
  let bytes;
  try { bytes = await readSafe(root, options.registryPath ?? DEFAULT_REGISTRY, MAX_FILE_BYTES); }
  catch { return fail('REGISTRY_UNAVAILABLE'); }
  let registry;
  try { registry = validateRegistry(parseStrictJson(decodeUtf8(bytes), { maxDepth: 8, maxNodes: 5000 })); }
  catch { return fail('REGISTRY_INVALID'); }
  result.registry_sha256 = sha256(bytes);
  const declaredReferences = new Set();
  for (const file of [...registry.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const measured = {
      path: file.path, surface: file.surface,
      max_bytes: file.max_bytes, max_unicode_characters: file.max_unicode_characters,
      available: false, within_budget: false,
    };
    try {
      const content = await readSafe(root, file.path, MAX_FILE_BYTES);
      const text = decodeUtf8(content);
      for (const reference of registry.required_references) {
        if (reference.from === file.path && text.includes(reference.to)) declaredReferences.add(referenceKey(reference));
      }
      Object.assign(measured, {
        available: true, utf8_bytes: content.length,
        unicode_characters: Array.from(text).length, utf16_code_units: text.length,
        sha256: sha256(content),
      });
      measured.within_budget = measured.utf8_bytes <= file.max_bytes
        && measured.unicode_characters <= file.max_unicode_characters;
      if (!measured.within_budget) result.issues.push({ code: 'FILE_BUDGET_EXCEEDED', path: file.path });
    } catch { result.issues.push({ code: 'FILE_UNAVAILABLE', path: file.path }); }
    result.files.push(measured);
  }
  for (const surface of [...registry.surfaces].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const files = result.files.filter(file => file.surface === surface.id);
    const utf8_bytes = files.reduce((sum, file) => sum + (file.utf8_bytes ?? 0), 0);
    const unicode_characters = files.reduce((sum, file) => sum + (file.unicode_characters ?? 0), 0);
    const available = files.every(file => file.available);
    const within_budget = available && utf8_bytes <= surface.max_bytes
      && unicode_characters <= surface.max_unicode_characters;
    result.surfaces.push({ ...surface, file_count: files.length, utf8_bytes, unicode_characters, available, within_budget });
    if (available && !within_budget) result.issues.push({ code: 'SURFACE_BUDGET_EXCEEDED', surface: surface.id });
  }
  const measuredByPath = new Map(result.files.map(file => [file.path, file]));
  for (const reference of registry.required_references) {
    const available = measuredByPath.get(reference.from).available && measuredByPath.get(reference.to).available;
    const declared = declaredReferences.has(referenceKey(reference));
    result.references.push({ ...reference, available, declared });
    if (!available) result.issues.push({ code: 'REFERENCE_UNAVAILABLE', from: reference.from, to: reference.to });
    else if (!declared) result.issues.push({ code: 'REFERENCE_NOT_DECLARED', from: reference.from, to: reference.to });
  }
  result.verdict = result.issues.length === 0 ? 'PASS' : 'INCOMPLETE';
  return result;
}

/** Read only explicit plugin-owned instruction paths; return metadata, never prose. */
export async function inspectInstructionBudget(pluginRoot, options = {}) {
  return withReadBudget((MAX_FILES + 1) * MAX_FILE_BYTES + MAX_FILES + 1,
    () => inspect(pluginRoot, options));
}
