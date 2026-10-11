// Hook input is data only. Never evaluate shell commands or submitted content.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isActive, physical, within } from './harness-activity.mjs';
import { parseStrictJson } from '../../scripts/lib/strict-json.mjs';
import { TOOL_INPUT_LIMIT, inspectToolPolicy, isProtectedWritePath, containsSensitiveText, toolContent, readBoundedStdin } from '../../scripts/lib/tool-policy.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function canonical(value, root) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw Error('invalid path');
  let decoded = decodeURIComponent(value).replaceAll('\\', '/').replace(/^\/\/\?\//, '');
  decoded = decoded.split('/').map(part => part === '..' || part === '.' ? part : part.replace(/[. ]+$/, '')).join('/');
  if (/^[a-z]:[^/]/i.test(decoded)) throw Error('ambiguous drive-relative path');
  // Resolve links before consuming a following '..'. Lexically collapsing the
  // whole input first can hide a protected POSIX symlink destination.
  const parsed = path.parse(decoded);
  let candidate = physical(path.isAbsolute(decoded) ? parsed.root : root);
  for (const component of decoded.slice(parsed.root.length).split(/[\\/]+/)) {
    if (component) candidate = physical(path.resolve(candidate, component));
  }
  return candidate;
}
function singlyLinked(candidate) {
  const stat = fs.statSync(candidate, { throwIfNoEntry: false });
  // realpath cannot distinguish aliases to the same inode. A protected file
  // may have a harmless-looking hard link, so retain normal permission checks.
  return !stat || (stat.isFile() && stat.nlink === 1);
}
function sensitive(candidate) {
  const p = candidate.replaceAll('\\', '/').toLowerCase();
  return within(candidate, physical(pluginRoot)) ||
    /(^|\/)harness(?:14|20|36|50)(?:\/[^/]+)?\/(hooks(?:\/|$)|\.claude-plugin(?:\/|$))/.test(p) ||
    /(^|\/)(\.claude|\.codex|\.git)(\/|$)/.test(p) ||
    /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube)(\/|$)/.test(p) ||
    /(^|\/)(\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.zshenv)$/.test(p) ||
    /(^|\/)(progra~\d+|window~\d+|system~\d+|admini~\d+|docume~\d+|users~\d+|appdat~\d+)(\/|$)/.test(p) ||
    /^\/(etc|var|boot)\//.test(p) || /\/(system32|windows|program files)\//.test(p) ||
    /\/\.config\/gcloud\//.test(p) || /\/\.docker\/config\.json$/.test(p);
}
// canonical() keeps each component as typed. Resolve case and 8.3 aliases of the existing
// prefix too, so a differently spelled path cannot reach the workflow state below.
function spelled(candidate) {
  try { return fs.realpathSync.native(candidate); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(spelled(parent), path.basename(candidate));
  }
}
// Windows opens one file under several spellings: letter case, 8.3 short names (GIT~1), trailing
// dots and spaces, and stream suffixes (.git::$INDEX_ALLOCATION is the directory itself,
// .npmrc::$DATA the file itself, .env:x a stream of .env). This is the spelling the file system
// opens: realpath.native of the longest existing prefix, then every component below the volume
// root without a ':stream' suffix or trailing dots and spaces. On POSIX ':' is an ordinary
// character; dropping it there only adds prompts, never an approval.
function resolvedPath(candidate) {
  const native = spelled(candidate);
  const { root } = path.parse(native);
  const parts = native.slice(root.length).split(/[\\/]+/)
    .map(part => (part === '.' || part === '..' ? part : part.replace(/:[\s\S]*$/, '').replace(/[. ]+$/, '')))
    .filter(Boolean);
  return root + parts.join(path.sep);
}
// Project-relative, lower case and '/' separated. nativeRoot is spelled(root).
function projectRelative(resolved, nativeRoot) {
  return path.relative(nativeRoot, resolved).replaceAll('\\', '/').toLowerCase();
}
// Claude progress.json and everything under step_archive/.harness50-codex/ steer the Stop gates.
// A Codex state.json there silences them, so edits to either never receive hook approval. The
// same names in a subfolder are excluded too: a progress.json written there without a prompt would
// start a run (loader instructions, approval, Stop continuation) once that folder is opened.
const WORKFLOW_STATE = /(^|\/)step_archive\/(?:(?:progress|workflow-profile)\.json$|\.harness50-codex(?:\/|$))/;
// Execution-linked files: a later git operation, install, editor, CI run, agent session or
// user-approved command runs or follows them without anyone reading the edit. They keep the
// normal permission prompt in auto mode. The guard mode below does not deny them, so ordinary
// edits still go through once the user confirms.
const EXECUTION_LINKED = [
  /(^|\/)\.mcp\.json$/,
  /(^|\/)(claude|claude\.local|agents|agents\.override)\.md$/,
  /(^|\/)\.(husky|githooks|vscode|idea|devcontainer|cursor|circleci|buildkite|claude-plugin|codex-plugin)(\/|$)/,
  /(^|\/)\.github\/(workflows|actions)(\/|$)/,
  /(^|\/)(\.cursorrules|\.windsurfrules)$/,
  /(^|\/)\.github\/copilot-instructions\.md$/,
  /(^|\/)(\.pre-commit-config\.ya?ml|\.?lefthook(-local)?\.(ya?ml|json|toml)|\.lefthookrc|\.?simple-git-hooks\.(json|c?js)|\.lintstagedrc(\.[^/]*)?|lint-staged\.config\.[^/]+)$/,
  /(^|\/)(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|jenkinsfile|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml)$/,
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.yarnrc(\.ya?ml)?|\.?pnpmfile\.c?js|bunfig\.toml|\.envrc|harness50\.quality\.json)$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)step_archive\/tools(\/|$)/,
  // Step bodies: the loader and the Stop hook tell the next session to read and run them, and only
  // webapp-trigger copies them in, so the model never needs to write there.
  /(^|\/)step_archive\/archived(\/|$)/,
  /(^|\/)step_archive\/profiles(\/|$)/,
  // Flat step bodies: the fallback location of the same bodies (harness-activity stepBody), which
  // the loader and the Stop hook also tell the next session to read and run.
  /(^|\/)step_archive\/step\d{3}\.md$/,
  // PR #1 C-3: a project rooted at the home folder. systemd user units and autostart entries run
  // at login, ~/.local/bin and ~/.bin sit on PATH, and pip.conf/pip.ini choose the package index.
  /(^|\/)\.config\/(systemd|autostart)(\/|$)/,
  /(^|\/)\.(local\/bin|bin)(\/|$)/,
  /(^|\/)(pip\.conf|pip\.ini)$/
];
// Active-state judgement lives in harness-activity.mjs (isActive). Any entry at the Codex state
// path makes it false there, even next to a stale or imported progress.json.
try {
  const raw = readBoundedStdin();
  if (raw.length > TOOL_INPUT_LIMIT) throw Error('input too large');
  const event = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/, ''));
  const root = physical(path.resolve(process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd()));
  const mode = process.argv[2];
  const edits = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
  if (mode === 'auto') {
    if (!isActive(root)) process.exit(0);
    // Shell commands and network fetches retain ordinary host permission checks. Bash and WebFetch
    // are never eligible here, and the auto-approve matcher in hooks/hooks.json leaves them out
    // too: widen both together or neither. Edit and MultiEdit text that holds a command the guard
    // catalog (command-guard.mjs) would block or ask about keeps the prompt as well.
    if (event.tool_name === 'WebSearch' && !inspectToolPolicy(event, { workspaceRoot: root }).rule) process.stdout.write('eligible');
    else if (edits.includes(event.tool_name)) {
      // Loaded here, not at the top: a missing or broken catalog must not stop guard mode below
      // from failing closed. In this branch an import error only means no grant.
      const { contentNeedsPrompt } = await import('./command-guard.mjs');
      const input = event.tool_input;
      const texts = toolContent(input);
      if (inspectToolPolicy(event, { workspaceRoot: root }).rule) process.exit(0);
      const candidate = canonical(input?.file_path || input?.notebook_path, root);
      // Judge both the path as typed and the path the file system opens (resolvedPath).
      const nativeRoot = spelled(root);
      const resolved = resolvedPath(candidate);
      const relative = projectRelative(resolved, nativeRoot);
      if (within(candidate, root) && within(resolved, nativeRoot) && !sensitive(candidate) && !sensitive(resolved) &&
          singlyLinked(candidate) && candidate !== root && relative !== '' &&
          !WORKFLOW_STATE.test(relative) && !EXECUTION_LINKED.some(pattern => pattern.test(relative)) &&
          !isProtectedWritePath(candidate) && !isProtectedWritePath(resolved) &&
          !texts.some(text => contentNeedsPrompt(text) || containsSensitiveText(text))) process.stdout.write('eligible');
    }
  } else if (mode === 'guard' && (edits.includes(event.tool_name) || event.tool_name === 'Read')) {
    // guard keeps the typed path: aliases fall to the host prompt (README).
    const candidate = canonical(event.tool_input?.file_path || event.tool_input?.notebook_path, root);
    if (inspectToolPolicy(event, { workspaceRoot: root }).rule || edits.includes(event.tool_name) && sensitive(candidate)) process.stdout.write('protected');
  }
} catch {
  // Invalid data, missing state, unavailable paths: no grant. Guard fails closed.
  if (process.argv[2] === 'guard') process.stdout.write('protected');
}
