import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PROJECT_NAMES, hookShellTimeout, installPlugin, runClaudeHook, tempRoot } from './helpers/claude-hooks.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const bashOnWindows = windows && process.env.H50_TEST_BASH === '1';
const active = { current_step: 1, total_steps: 50, completed_steps: [] };
// A run is active only next to the body of its current step, as after /webapp <topic>.
function stepBody(root, step) {
  fs.mkdirSync(path.join(root, 'step_archive', 'archived'), { recursive: true });
  fs.writeFileSync(path.join(root, 'step_archive', 'archived', `step${String(step).padStart(3, '0')}.md`), `# Step ${step}\n`);
}
function fixture(t, state = active, { body = true } = {}) {
  // macOS exposes /var through /private/var; fixtures use the shared physical root.
  const root = tempRoot(t, 'h50-security-');
  fs.mkdirSync(path.join(root, 'step_archive'));
  if (state !== null) fs.writeFileSync(path.join(root, 'step_archive/progress.json'), typeof state === 'string' ? state : JSON.stringify(state));
  const step = state?.current_step;
  if (body && Number.isInteger(step) && step >= 1 && step <= 50) stepBody(root, step);
  return root;
}
// Runs a hook from the repository without judging its stderr; run() requires stderr to be empty.
function runRaw(root, hook, event, env = {}, cwd = root) {
  const script = path.join(repo, 'hooks', hook + (windows && !bashOnWindows ? '.ps1' : '.sh'));
  const shell = bashOnWindows ? 'C:/Program Files/Git/bin/bash.exe' : windows ? 'powershell.exe' : 'bash';
  const args = bashOnWindows ? ['-c', 'uname(){ echo Linux; }; python3(){ python "$@" | tr -d "\\r"; }; export -f uname python3; bash "$1"', 'fixture', script.replaceAll('\\', '/')] : windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [script];
  const result = spawnSync(shell, args, {
    cwd, input: JSON.stringify(event), encoding: 'utf8', timeout: hookShellTimeout(windows && !bashOnWindows ? 'ps1' : 'sh'),
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', CLAUDE_PROJECT_DIR: root, ...env },
  });
  assert.equal(result.error, undefined);
  return { status: result.status, output: result.stdout.trim(), stderr: result.stderr };
}
function run(root, hook, event, env = {}, cwd = root) {
  const result = runRaw(root, hook, event, env, cwd);
  assert.equal(result.stderr, '', result.stderr);
  return { status: result.status, output: result.output };
}
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'example' } });
test('shipping hook allows an ordinary project write in bootstrap state', t => {
  const root = fixture(t);
  assert.match(run(root, 'auto-approve', write('src/app.js')).output, /"allow"/);
});
for (const [name, state] of Object.entries({ missing: null, malformed: '{', empty: {}, completed: { ...active, current_step: 50, completed_steps: Array.from({ length: 50 }, (_, i) => i + 1) }, paused: { ...active, paused: true }, pausedNull: { ...active, paused: null }, pausedString: { ...active, paused: 'true' }, pausedOne: { ...active, paused: 1 }, statusPaused: { ...active, status: 'paused' }, gap: { ...active, current_step: 3, completed_steps: [2] }, inconsistent: { ...active, current_step: 2 }, strings: { ...active, current_step: '1' } })) {
  test(`autoapproval defers for ${name} state`, t => {
    assert.equal(run(fixture(t, state), 'auto-approve', write('src/app.js')).output, '');
  });
}
for (const target of ['/cache/harness14/4.2.1/hooks/auto-approve.ps1', '/cache/HARNESS14/4.2.1/.claude-plugin/plugin.json', '/cache/harness20/4.0.0/hooks/auto-approve.ps1', '/cache/HARNESS20/4.0.0/.claude-plugin/plugin.json', '.claude/subdir/../settings.json', '/cache/harness50/2.1.0/hooks/auto-approve.ps1', '/cache/harness36/0.0.0-test/hooks/auto-approve.ps1', '/cache/HARNESS36/0.0.0-test/.claude-plugin/plugin.json', path.join(repo, 'hooks/auto-approve.ps1')]) {
  test(`protect canonical target ${target}`, t => {
    const root = fixture(t);
    assert.equal(run(root, 'auto-approve', write(target)).output, '');
    const guard = run(root, 'permission-request-guard', write(target));
    assert.equal(guard.status, 2);
    assert.match(guard.output, /"deny"/);
  });
}
test('arbitrary shell and out-of-project writes require normal permission', t => {
  const root = fixture(t);
  assert.equal(run(root, 'auto-approve', { tool_name: 'Bash', tool_input: { command: 'echo hello' } }).output, '');
  // The named pause CLI changes progress.json, so it keeps the host permission prompt too.
  assert.equal(run(root, 'auto-approve', { tool_name: 'Bash', tool_input: { command: 'node x/scripts/harness-pause.mjs resume --workspace .' } }).output, '');
  assert.equal(run(root, 'auto-approve', write('../outside.txt')).output, '');
});
test('existing destructive command denial remains (payload never executed)', t => {
  const root = fixture(t);
  const event = { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } };
  assert.equal(run(root, 'auto-approve', event).output, '');
  // A Bash deny explains the file route on stderr (see the guard wording tests below).
  const guard = runRaw(root, 'permission-request-guard', event);
  assert.equal(guard.status, 2);
  assert.match(guard.stderr, /Do not move commands into a script/);
});
test('event cwd is used when project environment is absent', t => {
  const root = fixture(t);
  assert.match(run(root, 'auto-approve', { ...write('src/app.js'), cwd: root }, { CLAUDE_PROJECT_DIR: '' }, repo).output, /"allow"/);
});
test('Unicode event cwd survives the PowerShell to Node pipe', t => {
  const parent = fixture(t);
  const root = path.join(parent, '프로젝트');
  fs.mkdirSync(path.join(root, 'step_archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'step_archive/progress.json'), JSON.stringify(active));
  stepBody(root, 1);
  assert.match(run(root, 'auto-approve', { ...write('src/app.js'), cwd: root }, { CLAUDE_PROJECT_DIR: '' }, repo).output, /"allow"/);
});
test('hard links to protected files do not grant write approval', t => {
  const root = fixture(t);
  const privatePath = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(privatePath));
  fs.writeFileSync(privatePath, '{}');
  fs.linkSync(privatePath, path.join(root, 'innocent.json'));
  assert.equal(run(root, 'auto-approve', write('innocent.json')).output, '');
});
test('parent traversal after a directory link cannot hide its protected target', t => {
  const root = fixture(t);
  const protectedChild = path.join(root, '.claude', 'child');
  fs.mkdirSync(protectedChild, { recursive: true });
  fs.symlinkSync(protectedChild, path.join(root, 'alias'), windows ? 'junction' : 'dir');
  const event = write('alias/../settings.json');
  assert.equal(run(root, 'auto-approve', event).output, '');
  assert.equal(run(root, 'permission-request-guard', event).status, 2);
});
test('canonical linked directories cannot escape project scope or plugin protection', t => {
  const root = fixture(t);
  const outside = fixture(t);
  fs.symlinkSync(outside, path.join(root, 'outside'), windows ? 'junction' : 'dir');
  fs.symlinkSync(path.join(repo, 'hooks'), path.join(root, 'plugin'), windows ? 'junction' : 'dir');
  assert.equal(run(root, 'auto-approve', write('outside/file.txt')).output, '');
  assert.equal(run(root, 'auto-approve', write('plugin/auto-approve.ps1')).output, '');
  assert.equal(run(root, 'permission-request-guard', write('plugin/auto-approve.ps1')).status, 2);
});
test('WebSearch and middle workflow project edits are eligible; WebFetch defers', t => {
  const root = fixture(t, { ...active, current_step: 3, completed_steps: [1, 2] });
  assert.match(run(root, 'auto-approve', write('src/app.js')).output, /"allow"/);
  assert.match(run(root, 'auto-approve', { tool_name: 'WebSearch', tool_input: { query: 'css' } }).output, /"allow"/);
  assert.equal(run(root, 'auto-approve', { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }).output, '');
  assert.equal(run(root, 'auto-approve', write('step_archive/progress.json')).output, '');
});
// 8.3 alias of an existing path's last component, or null when the volume creates no short names.
function shortName(target) {
  if (!windows) return null;
  const result = spawnSync(`for %I in ("${target}") do @echo %~sI`, { shell: true, encoding: 'utf8', timeout: 15000 });
  const alias = path.basename(result.stdout.trim());
  return result.status === 0 && alias && alias.toLowerCase() !== path.basename(target).toLowerCase() ? alias : null;
}
test('Codex workflow state paths never receive write approval in an active Claude workflow', t => {
  // A state.json there would silence the Claude Stop gates, just like a rewritten progress.json.
  const root = fixture(t, { ...active, current_step: 40, completed_steps: Array.from({ length: 39 }, (_, i) => i + 1) });
  assert.match(run(root, 'auto-approve', write('src/app.js')).output, /"allow"/);
  const targets = ['step_archive/.harness50-codex/state.json', 'step_archive/.harness50-codex', 'step_archive/.harness50-codex/backups/reset-1/state.json',
    'STEP_ARCHIVE/.Harness50-Codex/state.json', 'step_archive/.harness50-codex./state.json', 'step_archive/.harness50-codex/state.json::$DATA',
    'STEP_ARCHIVE/PROGRESS.JSON', path.join(root, 'step_archive', '.harness50-codex', 'state.json')];
  for (const target of targets) assert.equal(run(root, 'auto-approve', write(target)).output, '', target);
  const codexDirectory = path.join(root, 'step_archive', '.harness50-codex');
  fs.mkdirSync(codexDirectory);
  for (const target of targets) assert.equal(run(root, 'auto-approve', write(target)).output, '', `${target} (existing directory)`);
  for (const alias of [shortName(codexDirectory) && `step_archive/${shortName(codexDirectory)}/state.json`,
    shortName(path.join(root, 'step_archive')) && `${shortName(path.join(root, 'step_archive'))}/.harness50-codex/state.json`]) {
    if (alias) assert.equal(run(root, 'auto-approve', write(alias)).output, '', alias);
  }
  assert.match(run(root, 'auto-approve', write('step_archive/.harness50-codex-notes.md')).output, /"allow"/);
});
for (const [name, create] of Object.entries({
  'running state': file => fs.writeFileSync(file, JSON.stringify({ schema_version: 1, workflow_id: 'wf', status: 'running', current_step: 30, completed_steps: Array.from({ length: 29 }, (_, i) => i + 1) })),
  'empty object': file => fs.writeFileSync(file, '{}'),
  'empty file': file => fs.writeFileSync(file, ''),
  directory: file => fs.mkdirSync(file),
})) {
  test(`Codex state (${name}) turns autoapproval off next to an active progress.json`, t => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, 'step_archive', '.harness50-codex'));
    create(path.join(root, 'step_archive', '.harness50-codex', 'state.json'));
    assert.equal(run(root, 'auto-approve', write('src/app.js')).output, '');
    assert.equal(run(root, 'auto-approve', { tool_name: 'WebSearch', tool_input: { query: 'css' } }).output, '');
  });
}
test('dangling directory links cannot grant project write approval', t => {
  const root = fixture(t);
  const outside = fixture(t);
  fs.symlinkSync(path.join(outside, 'missing'), path.join(root, 'dangling'), windows ? 'junction' : 'dir');
  assert.equal(run(root, 'auto-approve', write('dangling/file.txt')).output, '');
});
test('an active-looking progress.json without its step body is stale and defers', t => {
  // The shape an older SessionStart loader created in any folder it opened.
  assert.equal(run(fixture(t, active, { body: false }), 'auto-approve', write('src/app.js')).output, '');
  assert.equal(run(fixture(t, { ...active, current_step: 3, completed_steps: [1, 2] }, { body: false }), 'auto-approve', write('src/app.js')).output, '');
});
test('approval follows the first unfinished step, and total_steps must be present', t => {
  // The writer's QA gate can leave a gap and move current_step back to it.
  assert.match(run(fixture(t, { ...active, current_step: 3, completed_steps: [1, 2, 4] }), 'auto-approve', write('src/app.js')).output, /"allow"/);
  const { total_steps, ...withoutTotal } = active;
  assert.equal(total_steps, 50);
  assert.equal(run(fixture(t, withoutTotal), 'auto-approve', write('src/app.js')).output, '');
});
// Files that a later git operation, install, editor, CI run or agent session executes or follows.
const EXECUTION_LINKED = ['.mcp.json', 'CLAUDE.md', 'docs/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.husky/pre-commit',
  '.githooks/pre-push', '.vscode/tasks.json', '.devcontainer/devcontainer.json', '.github/workflows/ci.yml', 'package.json',
  'packages/a/package.json', 'package-lock.json', '.yarnrc.yml', '.pnpmfile.cjs', '.envrc', 'lefthook.yml', '.pre-commit-config.yaml',
  'node_modules/x/index.js', 'harness50.quality.json', 'step_archive/tools/html-bundler.ps1', 'PACKAGE.JSON', '.HUSKY/pre-commit',
  ...(windows ? ['package.json::$DATA'] : [])];
test('execution-linked files never receive hook approval in an active workflow', t => {
  const root = fixture(t);
  assert.match(run(root, 'auto-approve', write('src/app.js')).output, /"allow"/);
  for (const target of EXECUTION_LINKED) assert.equal(run(root, 'auto-approve', write(target)).output, '', target);
  for (const target of ['src/app.js', 'src/package-helper.js', 'docs/claude-notes.md', '.github/ISSUE_TEMPLATE/bug.md', 'vite.config.js']) {
    assert.match(run(root, 'auto-approve', write(target)).output, /"allow"/, target);
  }
});
test('step bodies and a subfolder run state never receive hook approval; step results still do', t => {
  // The loader and the Stop hook tell the next session to read and run archived step bodies, and a
  // progress.json in a subfolder would start a run there once that folder is opened.
  const root = fixture(t);
  for (const target of ['step_archive/archived/step002.md', 'step_archive/archived/step001.md', 'step_archive/archived', 'STEP_ARCHIVE/Archived/step003.md',
    'sub/step_archive/progress.json', 'a/b/STEP_ARCHIVE/PROGRESS.JSON', 'sub/step_archive/.harness50-codex/state.json', 'sub/step_archive/.harness50-codex',
    ...(windows ? ['step_archive/archived/step001.md::$DATA', 'sub/step_archive/progress.json::$DATA'] : [])]) {
    assert.equal(run(root, 'auto-approve', write(target)).output, '', target);
  }
  for (const target of ['step_archive/step001_preflight.md', 'step_archive/outputs/notes.md', 'sub/step_archive_notes/progress.json', 'src/step_archive.js', 'docs/archived/x.md']) {
    assert.match(run(root, 'auto-approve', write(target)).output, /"allow"/, target);
  }
});
// The approval policy the auto-approve relay asks, run directly with node (no PowerShell start):
// 'eligible' or '' in auto mode, 'protected' or '' in guard mode.
function policy(root, file_path, mode = 'auto') {
  const result = spawnSync(process.execPath, [path.join(repo, 'hooks', 'lib', 'approval-policy.mjs'), mode], {
    input: JSON.stringify(write(file_path)), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '', result.stderr);
  return result.stdout;
}
// Windows opens one file under several spellings. Auto-approval judges the path the file system
// opens as well as the typed one, so no alias reaches a protected file. On POSIX ':' is an
// ordinary character; the same judgement there only keeps the prompt, so the stream cases run on
// every OS.
test('stream, 8.3, trailing-dot and home-level aliases never receive hook approval', t => {
  const root = fixture(t);
  for (const dir of ['.claude/commands', '.git/hooks', '.codex']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ['.claude/settings.json', '.git/config', '.npmrc', '.env', '.codex/config.toml']) fs.writeFileSync(path.join(root, file), '');
  assert.equal(policy(root, 'src/app.js'), 'eligible');
  const streams = ['.claude::$INDEX_ALLOCATION/settings.json', '.claude::$INDEX_ALLOCATION/settings.local.json',
    '.claude:$I30:$INDEX_ALLOCATION/settings.json', '.git::$INDEX_ALLOCATION/config', '.git::$INDEX_ALLOCATION/hooks/pre-commit',
    '.git::$INDEX_ALLOCATION/hooks/new-hook', '.git ::$INDEX_ALLOCATION/config', '.codex::$INDEX_ALLOCATION/config.toml',
    '.npmrc::$DATA', '.env:secret', '.env::$DATA', path.join(root, '.git::$INDEX_ALLOCATION', 'hooks', 'pre-commit')];
  // 8.3 short names, where the volume creates them.
  const shortNames = Object.entries({ '.git': ['/config', '/hooks/pre-commit', '/hooks/new-hook'], '.claude': ['/settings.json', '/commands/evil.md'],
    '.codex': ['/config.toml'], '.npmrc': [''], '.env': [''], step_archive: ['/archived/step002.md'] })
    .flatMap(([name, tails]) => { const alias = shortName(path.join(root, name)); return alias ? tails.map(tail => alias + tail) : []; });
  // PR #1 C-3: a project rooted at the home folder (login units, PATH entries, the pip index).
  const homeLevel = ['.config/systemd/user/x.service', '.config/autostart/x.desktop', '.local/bin/git', '.bin/node', 'pip.conf'];
  for (const target of [...streams, ...shortNames, ...homeLevel]) assert.equal(policy(root, target), '', target);
  // No over-blocking: streams of ordinary paths and names that only contain git or env.
  for (const target of ['src/lib::$INDEX_ALLOCATION/x.js', 'src/app.js::$DATA', 'docs/git-notes.md', 'src/env.js']) {
    assert.equal(policy(root, target), 'eligible', target);
  }
  // The guard mode keeps the typed path and its meaning.
  assert.equal(policy(root, '.git/config', 'guard'), 'protected');
  // Once through the shipping hook.
  assert.equal(run(root, 'auto-approve', write('.claude::$INDEX_ALLOCATION/settings.json')).output, '');
});
// Flat step bodies are the fallback location of the step bodies (harness-activity stepBody), and
// archived/ and tools/ under a subfolder step_archive are the same material. Step 1 writes
// TOPIC.md itself, so it stays eligible.
test('workflow bodies and frozen TOPIC stay out of approval; ordinary step results stay in', t => {
  const root = fixture(t);
  for (const target of ['step_archive/step002.md', 'STEP_ARCHIVE/STEP050.MD', 'step_archive/step002.md.', 'step_archive/step002.md::$DATA',
    'sub/step_archive/archived/step001.md', 'a/STEP_ARCHIVE/Archived/x.md', 'sub/step_archive/tools/html-bundler.ps1', 'step_archive/TOPIC/TOPIC.md']) {
    assert.equal(policy(root, target), '', target);
  }
  for (const target of ['step_archive/step002_result.md', 'step_archive/step0021.md', 'sub/step_archive_x/archived/a.md', 'docs/archived/x.md']) {
    assert.equal(policy(root, target), 'eligible', target);
  }
});
test('the guard mode leaves execution-linked edits to the normal prompt instead of denying them', t => {
  const root = fixture(t);
  const guard = run(root, 'permission-request-guard', { hook_event_name: 'PermissionRequest', ...write('package.json') });
  assert.equal(guard.status, 0);
  assert.equal(guard.output, '');
});
// Missing Node grants no approval and the tool guard denies rather than fail open.
test('missing Node runtime cannot grant approval', t => {
  const root = fixture(t);
  const executable = windows ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/bash';
  const withoutNode = (hook, event) => {
    const script = path.join(repo, 'hooks', `${hook}.${windows ? 'ps1' : 'sh'}`);
    const result = spawnSync(executable, windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [script], {
      cwd: root, input: JSON.stringify(event), encoding: 'utf8', timeout: hookShellTimeout(windows ? 'ps1' : 'sh'),
      env: { ...process.env, PATH: root, CLAUDE_PROJECT_DIR: root, HARNESS50_NODE: '' },
    });
    assert.equal(result.error, undefined);
    return { status: result.status, stdout: result.stdout.trim() };
  };
  assert.deepEqual(withoutNode('auto-approve', write('src/app.js')), { status: 0, stdout: '' });
  assert.deepEqual(withoutNode('destructive-guard', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }), { status: 2, stdout: '' });
});

// The guards read the whole command text, quoted strings and heredoc bodies included. A block
// caused by message text should point at the file route instead of inviting a workaround.
// Windows runs the .ps1 hooks and POSIX (or H50_TEST_BASH=1) the .sh hooks, so each wording set
// is checked where it ships.
const bodyCommand = 'gh pr create --title t --body "Never run git reset --hard on shared branches"';
const heredocCommand = "gh pr create --title t --body-file - <<'EOF'\n- `git reset --hard` counts as deletion\nEOF";
function installedGuard(t) {
  const root = tempRoot(t, 'h50-guard-');
  const plugin = installPlugin(root);
  const project = path.join(root, PROJECT_NAMES[0]);
  fs.mkdirSync(project);
  const run = (hook, event) => runClaudeHook(plugin, hook, event, { cwd: project, env: { CLAUDE_PROJECT_DIR: project }, stripCR: true });
  return { plugin, project, run };
}
function assertFileRoute(stderr) {
  assert.match(stderr, /--body-file <file>/);
  assert.match(stderr, /git commit -F <file>/);
  assert.match(stderr, /Do not move commands into a script/);
}
test('destructive-guard blocks quoted body text but names the file route', t => {
  const { run } = installedGuard(t);
  const bash = command => run('destructive-guard', { tool_name: 'Bash', tool_input: { command } });
  for (const command of [bodyCommand, heredocCommand]) {
    const result = bash(command);
    assert.equal(result.status, 2, command);
    assertFileRoute(result.stderr);
  }
  for (const command of ['git reset --hard HEAD~1', 'bash -c "git reset --hard"', 'git commit -m "$(git reset --hard)"', 'rm -rf /']) {
    assert.equal(bash(command).status, 2, command);
  }
  // Known boundary: --force alone in a message is not one of the patterns.
  assert.equal(bash('git commit -m "docs: explain why we avoid --force"').status, 0);
});
test('permission-request-guard explains the file route for Bash denies only', t => {
  const { plugin, project, run } = installedGuard(t);
  const bash = run('permission-request-guard', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: bodyCommand } });
  assert.equal(bash.status, 2);
  assert.match(bash.stdout, /"behavior":"deny"/);
  assertFileRoute(bash.stderr);
  fs.symlinkSync(path.join(plugin, 'hooks'), path.join(project, 'plugin'), windows ? 'junction' : 'dir');
  const edit = run('permission-request-guard', { hook_event_name: 'PermissionRequest', ...write('plugin/auto-approve.ps1') });
  assert.equal(edit.status, 2);
  assert.match(edit.stdout, /"deny"/);
  assert.equal(edit.stderr, '');
});

// One catalog decides both guards, so permission-request-guard denies only what destructive-guard
// blocks: a command it passes or asks about is never refused at the permission prompt.
test('permission-request-guard never refuses what destructive-guard leaves to the user', t => {
  const { run } = installedGuard(t);
  const bash = (command, hook_event_name) => ({ hook_event_name, tool_name: 'Bash', tool_input: { command } });
  const guards = command => [run('destructive-guard', bash(command, 'PreToolUse')), run('permission-request-guard', bash(command, 'PermissionRequest'))];
  for (const command of ['git commit -m "remove sudo usage"', 'rm -rf ./dist', 'rm -rf /tmp/h50-x', 'git branch -d feature']) {
    const [pre, permission] = guards(command);
    assert.deepEqual({ status: pre.status, stdout: pre.stdout }, { status: 0, stdout: '' }, command);
    assert.deepEqual({ status: permission.status, stdout: permission.stdout }, { status: 0, stdout: '' }, command);
  }
  for (const command of ['sudo apt install jq', 'pip install semgrep', 'git config core.hooksPath .githooks']) {
    const [pre, permission] = guards(command);
    assert.equal(pre.status, 0, command);
    assert.match(pre.stdout, /"permissionDecision":"ask"/, command);
    assert.deepEqual({ status: permission.status, stdout: permission.stdout }, { status: 0, stdout: '' }, command);
  }
  const [pre, permission] = guards('echo x > .claude/settings.json');
  assert.equal(pre.status, 2);
  assert.equal(permission.status, 2);
});
// Writing text that names a command is not running it: the permission guard never denies an edit
// for its content. Auto-approval keeps the prompt for such text instead (approval-policy auto mode).
test('edit content never makes permission-request-guard deny', t => {
  const installed = installedGuard(t);
  const edit = new_string => ({ tool_name: 'Edit', tool_input: { file_path: 'README.md', old_string: 'x', new_string } });
  const permission = installed.run('permission-request-guard', { hook_event_name: 'PermissionRequest', ...edit('sudo apt install jq') });
  assert.deepEqual({ status: permission.status, stdout: permission.stdout }, { status: 0, stdout: '' });
  // In an active run the same edit keeps the prompt, and harmless text is still approved.
  const root = fixture(t);
  assert.equal(run(root, 'auto-approve', edit('sudo apt install jq')).output, '');
  assert.equal(run(root, 'auto-approve', { tool_name: 'MultiEdit', tool_input: { file_path: 'README.md', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'rm -rf /' }] } }).output, '');
  assert.match(run(root, 'auto-approve', edit('const a = 1')).output, /"permissionDecision":"allow"/);
});

test('profile and legacy archived bodies cannot be overwritten through ordinary tools', t => {
  const root = fixture(t);
  for (const target of ['step_archive/profiles/research-free-36-v1/archived/step017.md', 'step_archive/archived/step017.md']) {
    assert.equal(run(root, 'auto-approve', write(target)).output, '');
    assert.equal(run(root, 'permission-request-guard', write(target)).status, 2);
  }
});
