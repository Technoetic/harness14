// Deterministic host mediation. This is not an OS/network sandbox or a classifier
// for private business prose: unresolved DNS, redirects and unknown tools retain
// the host's own authorization and network controls.
import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { unsafeJevText, validateJevStructure } from './sensitive-data.mjs';

export const TOOL_INPUT_LIMIT = 1024 * 1024;
const MUTATIONS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_TOOLS = new Set([...MUTATIONS, 'Read']);
const TOOL_FIELDS = new Map([
  ['Read', new Set(['file_path','offset','limit','pages'])],
  ['Write', new Set(['file_path','content'])],
  ['Edit', new Set(['file_path','old_string','new_string','replace_all'])],
  ['MultiEdit', new Set(['file_path','edits'])],
  ['NotebookEdit', new Set(['notebook_path','new_source','cell_id','cell_type','edit_mode'])],
  ['WebFetch', new Set(['url','prompt'])],
  ['WebSearch', new Set(['query','allowed_domains','blocked_domains'])]
]);
function validToolFields(name, input) {
  if (FILE_TOOLS.has(name) && (typeof (input.file_path || input.notebook_path) !== 'string' || !(input.file_path || input.notebook_path).trim())) return false;
  if (name === 'Write' && typeof input.content !== 'string' || name === 'NotebookEdit' && typeof input.new_source !== 'string') return false;
  if (name === 'Edit' && typeof input.new_string !== 'string') return false;
  for (const field of ['content','new_source','new_string','old_string','prompt','pages','cell_id','cell_type','edit_mode']) {
    if (Object.hasOwn(input, field) && typeof input[field] !== 'string') return false;
  }
  if (Object.hasOwn(input, 'replace_all') && typeof input.replace_all !== 'boolean') return false;
  for (const field of ['offset','limit']) if (Object.hasOwn(input, field) && (!Number.isSafeInteger(input[field]) || input[field] < 0)) return false;
  for (const field of ['allowed_domains','blocked_domains']) if (Object.hasOwn(input, field) &&
    (!Array.isArray(input[field]) || input[field].length > 100 || input[field].some(value => typeof value !== 'string' || !value || value.length > 253))) return false;
  if (name === 'MultiEdit' && (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 100 || input.edits.some(edit =>
    !edit || typeof edit !== 'object' || Array.isArray(edit) || Object.keys(edit).some(key => !['old_string','new_string','replace_all'].includes(key)) ||
    typeof edit.new_string !== 'string' || Object.hasOwn(edit, 'old_string') && typeof edit.old_string !== 'string' ||
    Object.hasOwn(edit, 'replace_all') && typeof edit.replace_all !== 'boolean'))) return false;
  return true;
}
const HIDDEN_DIR = /(^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.claude|\.codex|\.git|\.harness36-security)(?:\/|$)/;
const CREDENTIAL = /(^|\/)(?:\.env(?:\.[^/]*)?|\.netrc|\.git-credentials|\.npmrc|\.pypirc|credentials(?:\.[^/]*)?|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)|application_default_credentials\.json|\.pgpass)$/;
const CONTROL_FILES = /(^|\/)(?:\.mcp\.json|agents(?:\.override)?\.md|claude(?:\.local)?\.md|\.cursorrules|\.windsurfrules)$/;
const STATE = /(^|\/)step_archive\/(?:\.harness50-codex(?:\/|$)|security(?:\/|$)|(?:progress|workflow-profile|progress-refusals)\.json(?:\.|$)|(?:\.continue|\.stall)[^/]*$)/;
const CONTROL_WRITE = /(^|\/)step_archive\/(?:TOPIC(?:\/|$)|archived(?:\/|$)|profiles(?:\/|$)|step\d{3}\.md$|tools(?:\/|$))/i;
// Canonical measured evidence is written by host runners, never directly by model tools.
// Keep ordinary advisory children writable, but protect parent replacement and direct cleanup.
const MEASURED_OUTPUT = /(^|\/)step_archive\/outputs(?:\/?$|\/(?:browser-output|quality-gate)\.json(?:\/|$)|\/\*(?:$|[/.]))/;
const EXECUTION = /(^|\/)(?:\.husky|\.githooks|\.claude-plugin|\.codex-plugin)(?:\/|$)|(^|\/)\.github\/(?:workflows|actions)(?:\/|$)/;
const PLUGIN_ROOT = fs.realpathSync.native(fileURLToPath(new URL('../../', import.meta.url)));

export function readBoundedStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  let total = 0;
  for (;;) {
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (!count) break;
    if ((total += count) > TOOL_INPUT_LIMIT) throw Error('input too large');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, total);
}

function normalized(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw Error('invalid path');
  const decoded = decodeURIComponent(value).replaceAll('\\', '/').replace(/^\/\/\?\//, '');
  const components = decoded.split('/').map((p, i) => /^[a-z]:$/i.test(p) && i === 0 ? p : p.replace(/:.*$/, '').replace(/[. ]+$/, ''));
  return components.join('/').toLowerCase();
}

export function isSensitiveReadPath(value) {
  const p = normalized(value);
  const template = /(^|\/)\.env(?:\.[^/]*)?\.(?:example|sample|template|dist|defaults)$/.test(p);
  return HIDDEN_DIR.test(p) || CREDENTIAL.test(p) && !template || STATE.test(p) ||
    /(^|\/)\.config\/gcloud(?:\/|$)|(^|\/)\.docker\/config\.json$/.test(p) || /\.(?:key|pem|p12|pfx)$/.test(p) || configuredBudgetPath(p);
}

function configuredBudgetPath(value) {
  const configured = process.env.HARNESS36_JEV_BUDGET_ROOT;
  if (!configured) return false;
  const root = normalized(path.resolve(configured)).replace(/\/$/, '');
  return value === root || value.startsWith(`${root}/`);
}

export function isProtectedWritePath(value) {
  const p = normalized(value);
  return isSensitiveReadPath(value) || CONTROL_FILES.test(p) || CONTROL_WRITE.test(p) || MEASURED_OUTPUT.test(p) || EXECUTION.test(p) || /(^|\/)step_archive\/?$/.test(p) ||
    /(^|\/)harness(?:14|20|36|50)(?:\/[^/]+)?\/(?:hooks|\.claude-plugin|\.codex-plugin)(?:\/|$)/.test(p) ||
    /(^|\/)(?:\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.zshenv)$|(^|\/)\.config\/(?:systemd|autostart)(?:\/|$)/.test(p) ||
    /^\/(?:etc|var|boot)(?:\/|$)|\/(?:system32|windows|program files)(?:\/|$)/.test(p);
}

export function containsSensitiveText(value) {
  return typeof value === 'string' && unsafeJevText(value);
}

export function inspectShellBoundary(command) {
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 256 * 1024) return 'malformed-input';
  if (/\bHARNESS36_JEV_BUDGET_ROOT\b[^\r\n]{0,256}=|(?:\bsetx|\bSetEnvironmentVariable)\b[^\r\n]{0,128}\bHARNESS36_JEV_BUDGET_ROOT\b/i.test(command)) return 'security-environment';
  const tokens = command.match(/[^\s"'`<>;|(),]+/g) ?? [];
  const mutation = /(?:^|\s)(?:rm|cp|mv|tee|install|ln|dd|sed|set-content|add-content|out-file|copy-item|move-item|new-item|remove-item)\b|\b(?:writeFile(?:Sync)?|write_text|write_bytes|rmtree|rmSync|renameSync)\s*\(|\.(?:write|unlink)\s*\(|>(?!&)/i.test(command);
  const read = /(?:^|\s)(?:cat|less|more|head|tail|base64|xxd|od|strings|type|get-content|gc|bat|nl)\b|\b(?:readFile(?:Sync)?|read_text|read_bytes)\s*\(|\.read\s*\(/i.test(command);
  for (const token of tokens) {
    try {
      if (mutation && isProtectedWritePath(token) || read && isSensitiveReadPath(token)) return 'protected-path';
    } catch { /* Syntax tokens are not file paths; the bounded shell parser handles them. */ }
  }
  return null;
}

function privateIPv4(host) {
  const [a,b,c] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113);
}

function privateIPv6(host) {
  const h = host.toLowerCase();
  // The public global-unicast range is 2000::/3. All other literal ranges are
  // rejected, including mapped IPv4, local, multicast and transition addresses.
  return !/^[23][0-9a-f]{3}:/.test(h) || /^2001::|^2001:(?:db8|0|10|20):/.test(h) || /^2002:/.test(h);
}

export function inspectNetworkUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value) || containsSensitiveText(value)) return 'unsafe-url';
  let url;
  try { url = new URL(value); } catch { return 'unsafe-url'; }
  try { if (containsSensitiveText(decodeURIComponent(value))) return 'unsafe-url'; } catch { return 'unsafe-url'; }
  try {
    // SearchParams decodes percent escapes and '+' form encoding. Validate every
    // occurrence: turning the list into an object would erase duplicate keys.
    for (const [key, value] of url.searchParams) validateJevStructure({ [key]: value });
  } catch { return 'unsafe-url'; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'unsafe-url';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || !host.includes('.') && isIP(host) === 0 ||
      /(?:^|\.)(?:local|internal|home|lan)$/.test(host) || host === 'metadata.azure.com' || host === 'metadata.google.internal') return 'unsafe-url';
  if (isIP(host) === 4 && privateIPv4(host) || isIP(host) === 6 && privateIPv6(host)) return 'unsafe-url';
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return 'unsafe-url'; }
  if (/\.(?:sh|ps1|bat|cmd|exe|dll|so|dylib|msi)$/i.test(pathname)) return 'unsafe-url';
  return null;
}

function physicalPath(value, workspaceRoot) {
  const decoded = decodeURIComponent(value).replaceAll('\\', '/').replace(/^\/\/\?\//, '');
  const parsed = path.parse(decoded);
  let current = path.isAbsolute(decoded) ? parsed.root : workspaceRoot;
  // Resolve links before consuming '..': lexical collapse can hide an escape.
  for (const component of decoded.slice(parsed.root.length).split('/')) {
    if (!component) continue;
    current = path.resolve(current, component);
    try { current = fs.realpathSync.native(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const info = fs.lstatSync(current, { throwIfNoEntry: false });
  if (info?.isSymbolicLink() || info?.isFile() && info.nlink !== 1) throw Error('aliased file');
  return current;
}

export function inspectToolPolicy(event, { workspaceRoot = process.cwd() } = {}) {
  const name = event?.tool_name;
  const input = event?.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { supported: FILE_TOOLS.has(name) || ['WebFetch','WebSearch'].includes(name), rule: 'malformed-input' };
  const fields = TOOL_FIELDS.get(name);
  if (fields && (Object.keys(input).some(field => !fields.has(field)) || !validToolFields(name, input))) return { supported: true, rule: 'malformed-input' };
  if (name === 'WebFetch') return { supported: true, rule: inspectNetworkUrl(input.url) };
  if (name === 'WebSearch') return { supported: true, rule: typeof input.query !== 'string' || !input.query.trim() || input.query.length > 8192 ? 'malformed-input' : containsSensitiveText(input.query) ? 'sensitive-input' : null };
  if (!FILE_TOOLS.has(name)) return { supported: false, rule: null };
  try {
    const value = input.file_path || input.notebook_path;
    const physical = physicalPath(value, workspaceRoot);
    const mutation = MUTATIONS.has(name);
    const predicate = mutation ? isProtectedWritePath : isSensitiveReadPath;
    const relativePlugin = path.relative(PLUGIN_ROOT, physical);
    const pluginWrite = mutation && relativePlugin !== '..' && !relativePlugin.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePlugin);
    return { supported: true, rule: predicate(value) || predicate(physical) || pluginWrite ? 'protected-path' : null };
  } catch { return { supported: true, rule: 'malformed-input' }; }
}

export function toolContent(input) {
  return [input?.content, input?.new_source, input?.new_string,
    ...(Array.isArray(input?.edits) ? input.edits.map(edit => edit?.new_string) : [])].filter(value => typeof value === 'string');
}
