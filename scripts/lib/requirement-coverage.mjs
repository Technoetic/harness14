import { open, unlink } from 'node:fs/promises';
import { physicalWorkspace, safePath, readSafe, sha256 } from './quality-files.mjs';
import { workflowContext, recheckWorkflowContext, evidenceDirectory } from './workflow-context.mjs';
import { parseStrictJson } from './strict-json.mjs';
import { unsafeJevText, validateJevStructure } from './sensitive-data.mjs';
import { inspectQa } from './qa-report.mjs';

const BASE = 'step_archive/outputs/requirement-coverage';
const TOPIC = 'step_archive/TOPIC/TOPIC.md';
const LIMIT = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;
const rejected = () => new Error('Requirement inventory rejected: invalid, unsafe, changed or already frozen input.');
const require = condition => { if (!condition) throw rejected(); };
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const empty = status => ({ status, verdict: 'INCOMPLETE' });

function object(value, fields) {
  require(value && typeof value === 'object' && !Array.isArray(value));
  require(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
}
function list(value) { require(Array.isArray(value) && value.length > 0 && value.length <= 64); return value; }
function identifier(value) { require(typeof value === 'string' && ID.test(value) && !unsafeJevText(value)); return value; }
function unique(values) { require(new Set(values.map(value => value.toLowerCase())).size === values.length); }
function references(value) { const result = list(value).map(identifier); unique(result); return result; }
function mapping(value) {
  const requirements = list(value.requirements).map(item => {
    object(item, ['id', 'acceptance_ids']);
    return { id: identifier(item.id), acceptance_ids: references(item.acceptance_ids) };
  });
  const acceptance = list(value.acceptance).map(item => {
    object(item, ['id', 'check_ids']);
    return { id: identifier(item.id), check_ids: references(item.check_ids) };
  });
  unique(requirements.map(item => item.id));
  unique(acceptance.map(item => item.id));
  const checks = acceptance.flatMap(item => item.check_ids);
  require(checks.length <= 64); unique(checks);
  const known = new Set(acceptance.map(item => item.id));
  const covered = new Set(requirements.flatMap(item => item.acceptance_ids));
  require([...covered].every(id => known.has(id)) && covered.size === known.size);
  return { requirements, acceptance };
}
function reviewedInput(input) {
  // Reject accessors, cycles, unsupported objects and credential-shaped values
  // before serialization; callers cannot smuggle an unbounded executable getter.
  validateJevStructure(input);
  object(input, ['schema_version', 'requirements', 'acceptance']);
  require(input.schema_version === 1);
  const data = encode(input); require(data.length <= LIMIT);
  const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(data));
  return mapping(value);
}
function inspectorOptions(options) {
  require(options && typeof options === 'object' && !Array.isArray(options));
  require(typeof options.inventorySha256 === 'string' && HASH.test(options.inventorySha256));
  require(options.pathPolicy === undefined || typeof options.pathPolicy === 'function');
}
async function topicHash(root) {
  try { return sha256(await readSafe(root, TOPIC, 1024 * 1024)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function sameContext(root, context, topic) {
  await recheckWorkflowContext(root, context);
  require(await topicHash(root) === topic);
}
async function writeOnce(root, name, data) {
  require(data.length <= LIMIT);
  const target = await safePath(root, name, { createParents: true });
  const handle = await open(target, 'wx', 0o600);
  let saved = false;
  try { await handle.writeFile(data); await handle.sync(); saved = true; }
  finally { await handle.close(); if (!saved) await unlink(target).catch(() => {}); }
}
async function json(root, name) {
  const data = await readSafe(root, name, LIMIT);
  return { value: parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(data)), digest: sha256(data) };
}
function metadata(inventory, digest) {
  return { inventory_sha256: digest, workflow_profile: inventory.workflow_profile,
    workflow_generation: inventory.workflow_generation, requirement_count: inventory.requirements.length,
    acceptance_count: inventory.acceptance.length, check_count: inventory.acceptance.reduce((count, item) => count + item.check_ids.length, 0) };
}
async function load(root, context, expected) {
  const base = evidenceDirectory(BASE, context);
  const claim = (await json(root, `${base}/frozen.json`)).value;
  object(claim, ['schema_version', 'inventory_sha256']);
  require(claim.schema_version === 1 && claim.inventory_sha256 === expected);
  const loaded = await json(root, `${base}/${expected}.inventory.json`);
  require(loaded.digest === expected);
  const value = loaded.value;
  validateJevStructure(value);
  object(value, ['schema_version', 'workflow_profile', 'workflow_generation', 'topic_sha256', 'requirements', 'acceptance']);
  require(value.schema_version === 1 && value.workflow_profile === context.profile.id && value.workflow_generation === context.generation);
  require(value.topic_sha256 === null || (typeof value.topic_sha256 === 'string' && HASH.test(value.topic_sha256)));
  mapping(value);
  require(value.topic_sha256 === await topicHash(root));
  return value;
}

export async function freezeRequirements(workspaceRoot, input, options = {}) {
  try {
    const reviewed = reviewedInput(input);
    const root = await physicalWorkspace(workspaceRoot);
    const context = await workflowContext(root, options);
    const topic = await topicHash(root);
    const inventory = { schema_version: 1, workflow_profile: context.profile.id,
      workflow_generation: context.generation, topic_sha256: topic, ...reviewed };
    const data = encode(inventory); require(data.length <= LIMIT);
    const digest = sha256(data);
    const base = evidenceDirectory(BASE, context);
    await sameContext(root, context, topic);
    // Claim first: only one reviewed inventory may exist for a generation. A
    // crash leaves an incomplete claim; it never authorizes an overwrite.
    await writeOnce(root, `${base}/frozen.json`, encode({ schema_version: 1, inventory_sha256: digest }));
    await writeOnce(root, `${base}/${digest}.inventory.json`, data);
    await load(root, context, digest);
    await sameContext(root, context, topic);
    return { status: 'frozen', verdict: 'PASS', ...metadata(inventory, digest) };
  } catch { throw rejected(); }
}

export async function inspectRequirementInventory(workspaceRoot, options = {}) {
  try {
    inspectorOptions(options);
    const root = await physicalWorkspace(workspaceRoot);
    const context = await workflowContext(root, options);
    const inventory = await load(root, context, options.inventorySha256);
    await sameContext(root, context, inventory.topic_sha256);
    await load(root, context, options.inventorySha256);
    return { status: 'current', verdict: 'PASS', ...metadata(inventory, options.inventorySha256) };
  } catch (error) { return empty(error.code === 'ENOENT' ? 'missing' : 'invalid'); }
}

export async function inspectRequirementCoverage(workspaceRoot, options = {}) {
  try {
    inspectorOptions(options);
    const root = await physicalWorkspace(workspaceRoot);
    const context = await workflowContext(root, options);
    const inventory = await load(root, context, options.inventorySha256);
    const step = context.profile.milestones.final;
    const authorized = new Set();
    const originalPolicy = options.pathPolicy;
    const firstOptions = originalPolicy === undefined ? options : { ...options,
      pathPolicy: (path, kind) => {
        originalPolicy(path, kind);
        authorized.add(JSON.stringify([kind, path]));
      } };
    const qa = await inspectQa(root, step, firstOptions);
    const current = qa.status === 'current' && qa.verdict === 'PASS' && qa.report?.verifier.mode === 'independent';
    if (current) {
      // The last artifact authorization callback can change evidence already
      // checked by inspectQa. Recheck its current bytes after all host callbacks,
      // using only their successfully authorized paths and no repeated effects.
      const finalOptions = originalPolicy === undefined ? options : { ...options,
        pathPolicy: (path, kind) => require(authorized.has(JSON.stringify([kind, path]))) };
      const finalQa = await inspectQa(root, step, finalOptions);
      require(finalQa.status === 'current' && finalQa.verdict === 'PASS' &&
        finalQa.report_sha256 === qa.report_sha256 &&
        finalQa.report?.snapshot_sha256 === qa.report.snapshot_sha256 &&
        JSON.stringify(finalQa.artifacts) === JSON.stringify(qa.artifacts));
    }
    const outcomes = new Map((qa.report?.outcomes ?? []).map(outcome => [outcome.id, outcome]));
    const checks = inventory.acceptance.flatMap(item => item.check_ids).map(id => ({ id,
      status: current && outcomes.get(id)?.status === 'pass' && outcomes.get(id).evidence?.length > 0 ? 'PASS' : 'INCOMPLETE' }));
    const passedChecks = new Set(checks.filter(item => item.status === 'PASS').map(item => item.id));
    const acceptance = inventory.acceptance.map(item => ({ id: item.id,
      status: item.check_ids.every(id => passedChecks.has(id)) ? 'PASS' : 'INCOMPLETE' }));
    const passedAcceptance = new Set(acceptance.filter(item => item.status === 'PASS').map(item => item.id));
    const requirements = inventory.requirements.map(item => ({ id: item.id,
      status: item.acceptance_ids.every(id => passedAcceptance.has(id)) ? 'PASS' : 'INCOMPLETE' }));
    await load(root, context, options.inventorySha256);
    await sameContext(root, context, inventory.topic_sha256);
    const pass = current && requirements.every(item => item.status === 'PASS');
    return { status: qa.status, verdict: pass ? 'PASS' : 'INCOMPLETE', ...metadata(inventory, options.inventorySha256),
      final_step: step, ...(qa.report_sha256 ? { report_sha256: qa.report_sha256 } : {}), requirements, acceptance, checks };
  } catch (error) { return empty(error.code === 'ENOENT' ? 'missing' : 'invalid'); }
}
