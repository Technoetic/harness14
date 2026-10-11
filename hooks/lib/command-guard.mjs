#!/usr/bin/env node
// Read-only. The one Bash command catalog behind destructive-guard (PreToolUse),
// permission-request-guard (PermissionRequest) and the edit-content check of approval-policy auto
// mode. The .ps1 and .sh variants of both guards only relay the event here, so Windows and POSIX
// reach the same decision.
//
// Levels:
//   block - destructive-guard exits 2 with the rule on stderr. It cannot be approved, and
//           permission-request-guard denies the same command (deny decision, exit 2).
//   ask   - destructive-guard prints a PreToolUse 'ask' decision: the user confirms or refuses.
//   pass  - no decision; the host's normal permission checks apply.
// Invariant: the permission-request-guard deny set is the block set, and destructive-guard blocks
// every command in it. permission-request-guard never refuses a command that destructive-guard
// leaves to the user, so no command is both allowed by one guard and unapprovable in the other.
//
// The whole text is still checked, quoted strings and heredoc bodies included. It is cut into
// segments at shell separators, once with quote characters removed ("rm" -rf "/" reads as rm -rf /)
// and once with quote characters as extra separators (the text inside quotes is read on its own).
// Block rules match their command word at any position of a segment, so a wrapper (strace,
// flock, ...) cannot hide it. Ask rules match only the command a segment runs (after VAR=value and
// known wrappers), so prose such as "remove sudo usage" does not prompt. A line that is only a #
// comment is skipped when the text has no quotes (a # line can belong to a quoted string).
//
// Linear time: every rule is one pass over the words of a segment or a regular expression without
// nested quantifiers whose repeats are bounded. A rule reads at most LOOKAHEAD_WORDS words after its
// command word. A command longer than MAX_COMMAND_CHARS (256 KiB) asks; edit content is read in
// chunks of that size, and content longer than MAX_CONTENT_CHARS (1 MiB) always keeps the prompt.
//
// Hook input is data only: nothing in it is evaluated or run. This module imports only node:
// built-in modules, and everything it writes to stdout is ASCII (JSON, or prompt/clean).
//
// CLI: node command-guard.mjs pretool|permission|content, with the hook event JSON on stdin. An
// event that is not valid JSON produces no output and exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseStrictJson } from '../../scripts/lib/strict-json.mjs';
import { TOOL_INPUT_LIMIT, inspectToolPolicy, inspectShellBoundary, toolContent, readBoundedStdin } from '../../scripts/lib/tool-policy.mjs';

export const MAX_COMMAND_CHARS = 256 * 1024;
export const MAX_CONTENT_CHARS = 1024 * 1024;
const LOOKAHEAD_WORDS = 64;

const stripComments = text => text.split('\n').filter(line => !/^[ \t]*#/.test(line)).join('\n');
// $( and backticks become a marker glued to the next word, so a substituted target such as
// rm -rf $(pwd) stays visible and the substituted command still reads as a command.
const SUBST = '\u0001';
const SEP = /[\r\n;&|()]+/;
const SEP_QUOTES = /[\r\n;&|()"'\u0001]+/;
export function segments(text) {
  const marked = text.replace(/\$\(|`/g, ` ${SUBST}`);
  const out = [];
  for (const part of marked.replace(/["']/g, '').split(SEP)) if (part.trim()) out.push(part.trim());
  for (const part of marked.split(SEP_QUOTES)) if (part.trim()) out.push(part.trim());
  return out;
}
// Redirection is syntax even without spaces: cat<.env and reset --hard>/dev/null.
const words = segment => segment.replace(/[<>]+&?/g, ' ').split(/\s+/).filter(Boolean);
const baseName = word => word.replace(/^[\u0001{}]+/, '').replace(/^\\/, '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
const unquote = word => word.replace(/^["']+|["']+$/g, '');

const WRAPPERS = new Map([
  ['sudo', /^-[ugpCUrtTDh]$/], ['doas', /^-[uC]$/], ['env', /^-[uCS]$/], ['command', null], ['builtin', null],
  ['exec', /^-a$/], ['nohup', null], ['time', /^-[fo]$/], ['nice', /^-n$/], ['ionice', /^-[cnp]$/],
  ['timeout', /^-[sk]$/], ['stdbuf', null], ['xargs', /^-[nILPsadE]$/], ['busybox', null], ['setsid', null],
  ['watch', /^-n$/], ['{', null], ['then', null], ['do', null], ['else', null], ['elif', null], ['!', null]
]);
// The command a segment runs: { name, raw, args, escalated }.
export function commandOf(segment) {
  const w = words(segment);
  let i = 0;
  let escalated = false;
  while (i < w.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) { i += 1; continue; }
    const name = baseName(w[i]);
    if (!WRAPPERS.has(name)) return { name, raw: w[i], args: w.slice(i + 1), escalated };
    if (name === 'sudo' || name === 'doas') escalated = true;
    const valued = WRAPPERS.get(name);
    i += 1;
    while (i < w.length && (w[i].startsWith('-') || (name === 'timeout' && /^\d/.test(w[i])) || (name === 'env' && /^[A-Za-z_]\w*=/.test(w[i])))) {
      i += valued && valued.test(w[i]) ? 2 : 1;
    }
  }
  return { name: '', raw: '', args: [], escalated };
}

// A recursive-delete target that is a filesystem root, a system directory, a home, a home's direct
// entry, the working directory or a parent, or a bare wildcard. Deeper project paths pass.
export function dangerousTarget(raw, { cwd = true } = {}) {
  if (raw.startsWith(SUBST)) return true;
  if (!/[\\/.~$%:*?\[{]/.test(raw)) return false;
  // Collapse home spellings before splitting; a HOME parameter default can itself contain '/'.
  const input = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    .replace(/^(?:~[^/]*|\$\{(?:HOME|USERPROFILE|PWD)(?::[^}]*)?\}|\$(?:HOME|USERPROFILE|PWD)(?=\/|$)|%USERPROFILE%)/i, '~');
  const anchor = /^(?:~(?=\/|$)|[A-Za-z]:|\/[A-Za-z](?=\/|$)|\/)/.exec(input)?.[0] || '';
  const parts = [];
  for (const part of input.slice(anchor.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop();
      else if (anchor) return true;
      else parts.push(part);
    } else parts.push(part);
  }
  // Keep the first wildcard component, not just its parent: ~/proj/*/dist stays a deep path.
  const wildcard = parts.findIndex(part => /[*?[{]/.test(part));
  if (wildcard === 0 && anchor && anchor !== '~') return true;
  if (wildcard !== -1) parts.length = wildcard + 1;
  const t = anchor + (anchor && anchor !== '/' && parts.length ? '/' : '') + parts.join('/') || '.';
  if (/^(?:\/|[A-Za-z]:\/?|\/[A-Za-z]\/?)\*?$/.test(t)) return true;
  if (cwd && /^(?:\.{1,2}\/)*\.{1,2}\/?\*?$|^\*$|^\.\*$|^\.\/\.\*$/.test(t)) return true;
  if (cwd && /^\.git$/i.test(t)) return true;
  if (/^(?:~|\$\{?(?:HOME|USERPROFILE|PWD)\}?|%USERPROFILE%)(?:\/[^/]*)?\/?$/i.test(t)) return true;
  const p = t.replace(/^(?:[A-Za-z]:|\/[A-Za-z](?=\/))/, '');
  if (/^\/(?:etc|usr|bin|sbin|boot|lib|lib32|lib64|sys|proc|dev|root|windows|progra(?:m files|m|~\d)|programdata|system|library|applications)(?:\/|$)/i.test(p)) return true;
  return /^\/(?:home|users|var|opt|srv|mnt|media)(?:\/[^/]*){0,2}\/?$/i.test(p);
}

const HARD_SECRET = /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|\.azure)(?:[\\/]|$)|\.config[\\/]gcloud(?:[\\/]|$)|(?:\.kube[\\/]config|\.docker[\\/]config\.json|(?:^|[\\/])(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|\.netrc|\.git-credentials|\.pgpass|credentials(?:\.json)?|application_default_credentials\.json|\.npmrc|\.pypirc))(?:[*?{\[][^\\/]*)?$/i;
const ENV_FILE = /(?:^|[\\/])[*?]*\.env(?:[.*?{\[][^\\/]*)?$/i;
const ENV_TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/i;
export const secretPath = arg => HARD_SECRET.test(arg) || (!ENV_TEMPLATE.test(arg) && ENV_FILE.test(arg));
// Files a later git operation, shell start, login, service manager, scheduler or Claude session
// runs or follows: git hooks and config, Claude settings, the installed plugin's hooks and
// manifest, shell rc files, authorized_keys, systemd user units and autostart entries, sudoers and
// the cron tables.
const PERSISTENT_TARGET = new RegExp([
  String.raw`(?:^|[\\/])\.git[\\/](?:hooks(?:[\\/]|$)|config$)`,
  String.raw`(?:^|[\\/])\.claude[\\/]settings(?:\.local)?\.json$`,
  String.raw`(?:^|[\\/])harness(?:14|20|36|50)(?:[\\/][^\\/]+)?[\\/](?:hooks|\.claude-plugin)(?:[\\/]|$)`,
  String.raw`(?:^|[\\/])\.(?:bashrc|bash_profile|zshrc|zprofile|profile|zshenv)$`,
  String.raw`(?:^|[\\/])\.ssh[\\/]authorized_keys2?$`,
  String.raw`(?:^|[\\/])\.config[\\/](?:systemd|autostart)(?:[\\/]|$)`,
  String.raw`^[\\/]etc[\\/](?:sudoers(?:\.d)?|crontab|anacrontab|cron\.[a-z]+)(?:[\\/]|$)`,
  String.raw`^[\\/]var[\\/]spool[\\/]cron(?:[\\/]|$)`
].join('|'), 'i');
const WRITE_VERBS = new Set(['cp', 'mv', 'install', 'ln', 'tee', 'dd', 'sed', 'set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'new-item']);
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'base64', 'xxd', 'od', 'strings', 'type', 'get-content', 'gc', 'bat', 'nl']);
const COPIERS = new Set(['cp', 'mv', 'scp', 'rsync', 'copy-item', 'move-item']);
const ARCHIVERS = new Set(['tar', 'zip', '7z']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'python', 'python3', 'node', 'perl', 'ruby', 'pwsh', 'powershell', 'iex', 'invoke-expression']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const PIPE_SOURCES = new Set([...DOWNLOADERS, 'echo', 'printf', 'base64']);
const RECURSIVE_RM = /^-[A-Za-z]*[rR][A-Za-z]*$|^--recursive$/;
const CMD_SWITCH = /^\/(?:[A-Za-z?]{1,2}\/)*[A-Za-z?]{1,2}$/;
// Every output redirection in a segment and its target (2>/dev/null, >>file, > file).
const REDIRECT = />{1,2}\s*([^\s<>]+)/g;

// Block rules: the command word may sit anywhere in the segment.
function blockHits(segment, hits) {
  const w = words(segment);
  const names = w.map(baseName);
  const tail = i => { const out = []; for (let k = i + 1; k < w.length && out.length < LOOKAHEAD_WORDS; k += 1) out.push(w[k]); return out; };
  for (let i = 0; i < w.length; i += 1) {
    const name = names[i];
    const variable = /^\$\{?[A-Za-z_]\w*\}?$/.test(w[i]);
    if (name !== 'rm' && !variable && !/^(?:git|find|rd|rmdir|del|erase|remove-item|ri|dd|chmod|npm|nc|ncat|netcat|socat|aws|docker|kubectl|terraform|ngrok|cloudflared|echo|curl|drop|truncate)$/.test(name) &&
        !/^mkfs/.test(name) && !['format-volume', 'clear-disk', 'diskpart', 'wipefs'].includes(name) &&
        !READERS.has(name) && !COPIERS.has(name) && !ARCHIVERS.has(name)) continue;
    const args = tail(i);
    const flags = args.filter(a => a.startsWith('-'));
    const targets = args.filter(a => !a.startsWith('-')).map(unquote);
    const has = re => args.some(a => re.test(a));
    if ((name === 'rm' || variable) && flags.some(f => RECURSIVE_RM.test(f)) && (args.includes('--no-preserve-root') || targets.some(dangerousTarget))) hits.push({ level: 'block', rule: 'recursive-delete-root' });
    if (['rd', 'rmdir', 'del', 'erase'].includes(name) && args.some(a => CMD_SWITCH.test(a) && /\/s(?:\/|$)/i.test(a)) &&
        targets.filter(a => !CMD_SWITCH.test(a)).some(dangerousTarget)) hits.push({ level: 'block', rule: 'recursive-delete-root' });
    if (['remove-item', 'ri'].includes(name) && has(/^-r(?:ecurse)?$/i) && targets.some(dangerousTarget)) hits.push({ level: 'block', rule: 'recursive-delete-root' });
    if (name === 'find' && targets.length && dangerousTarget(targets[0], { cwd: false }) && (args.includes('-delete') || args.some((a, k) => /^-exec(?:dir)?$/.test(a) && baseName(args[k + 1] || '') === 'rm'))) hits.push({ level: 'block', rule: 'find-delete-root' });
    if (/^mkfs(?:\.|$)/.test(name) || ['format-volume', 'clear-disk', 'diskpart', 'wipefs'].includes(name)) hits.push({ level: 'block', rule: 'disk' });
    if (name === 'dd' && has(/^of=\/dev\/(?:sd|nvme|hd|disk|mmcblk)/)) hits.push({ level: 'block', rule: 'disk' });
    if (name === 'git') {
      let k = 0;
      while (k < args.length && args[k].startsWith('-')) k += /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)$/.test(args[k]) ? 2 : 1;
      const sub = args[k] || '';
      const rest = args.slice(k + 1);
      const restFlags = rest.filter(a => a.startsWith('-'));
      if (sub === 'push' && (restFlags.some(f => /^(?:--force(?:-with-lease(?:=.*)?|-if-includes)?|-[A-Za-z]*f[A-Za-z]*)$/.test(f)) || rest.some(a => /^\+/.test(unquote(a))))) hits.push({ level: 'block', rule: 'git-force-push' });
      if (sub === 'reset' && rest.includes('--hard')) hits.push({ level: 'block', rule: 'git-reset-hard' });
      if (sub === 'clean' && restFlags.some(f => /^(?:--force|-[A-Za-z]*f[A-Za-z]*)$/.test(f)) && !restFlags.some(f => /^(?:-[A-Za-z]*n[A-Za-z]*|--dry-run)$/.test(f))) hits.push({ level: 'block', rule: 'git-clean' });
      if (sub === 'checkout' && rest.some(a => a === '.' || a === './')) hits.push({ level: 'block', rule: 'git-discard' });
      if (sub === 'restore' && rest.some(a => a === '.' || a === './') && !(rest.some(a => /^(?:--staged|-S)$/.test(a)) && !rest.some(a => /^(?:--worktree|-W)$/.test(a)))) hits.push({ level: 'block', rule: 'git-discard' });
      if (sub === 'branch' && (restFlags.some(f => /^-[A-Za-z]*D[A-Za-z]*$/.test(f)) ||
          (restFlags.some(f => /^(?:--delete|-[A-Za-z]*d[A-Za-z]*)$/.test(f)) && restFlags.some(f => /^(?:--force|-[A-Za-z]*f[A-Za-z]*)$/.test(f))))) hits.push({ level: 'block', rule: 'git-branch-force-delete' });
    }
    if ((name === 'drop' && /^(?:table|database|schema)$/i.test(args[0] || '')) || (name === 'truncate' && /^table$/i.test(args[0] || ''))) hits.push({ level: 'block', rule: 'sql-drop' });
    if (name === 'npm' && args[0] === 'publish' && !args.includes('--dry-run')) hits.push({ level: 'block', rule: 'publish' });
    if (name === 'chmod' && has(/^(?:0?777|a\+rwx)$/)) hits.push({ level: 'block', rule: 'chmod-777' });
    if (['nc', 'ncat', 'netcat'].includes(name) && has(/^(?:-[A-Za-z]*l[A-Za-z]*|--listen)$/)) hits.push({ level: 'block', rule: 'listener' });
    if (name === 'socat' && args.some(a => /^(?:tcp|exec|system):/i.test(a))) hits.push({ level: 'block', rule: 'reverse-shell' });
    if (name === 'aws' && /^(?:s3 rb|iam delete-user|ec2 terminate-instances)$/.test(args.slice(0, 2).join(' '))) hits.push({ level: 'block', rule: 'cloud-destroy' });
    if (name === 'docker' && ((/^(?:rmi)$/.test(args[0] || '') || (args[0] === 'volume' && args[1] === 'rm')) && has(/^-[A-Za-z]*f[A-Za-z]*$|^--force$/) || (args[0] === 'system' && args[1] === 'prune' && has(/^-[A-Za-z]*a[A-Za-z]*$|^--all$/)))) hits.push({ level: 'block', rule: 'cloud-destroy' });
    if (name === 'kubectl' && args[0] === 'delete' && /^(?:ns|namespace|namespaces|node|nodes|pv|pvc|--all)$/.test(args[1] || '')) hits.push({ level: 'block', rule: 'cloud-destroy' });
    if (name === 'terraform' && args[0] === 'destroy' && has(/^-(?:auto-approve|force)$/)) hits.push({ level: 'block', rule: 'cloud-destroy' });
    if (['ngrok', 'cloudflared'].includes(name) && args[0] === 'http' && /^(?:0\.0\.0\.0|\*)/.test(args[1] || '')) hits.push({ level: 'block', rule: 'public-tunnel' });
    if (name === 'echo' && args.some(a => /^["']?(?:AKIA|ghp_|sk-|xoxb-)/.test(a))) hits.push({ level: 'block', rule: 'secret-echo' });
    if (READERS.has(name) && targets.some(secretPath)) hits.push({ level: 'block', rule: 'credential-read' });
    // A single brace token can expand to both the source and destination: cp .env{,.bak}.
    if (COPIERS.has(name) && targets.some((target, k) => (k < targets.length - 1 || /\{[^}]*,/.test(target)) && secretPath(target))) hits.push({ level: 'block', rule: 'credential-read' });
    if (ARCHIVERS.has(name) && targets.some(secretPath)) hits.push({ level: 'block', rule: 'credential-read' });
    if (name === 'curl' && (has(/^(?:-T|--upload-file)$/) || has(/^-F\S*=@/) || args.some((a, k) => /^(?:--data-binary|-d|--data|-F|--form)$/.test(a) && /@/.test(args[k + 1] || '')))) hits.push({ level: 'block', rule: 'upload' });
  }
}

// Ask rules: only the command a segment runs.
function askHits(segment, hits) {
  const { name, args, escalated } = commandOf(segment);
  const ask = rule => hits.push({ level: 'ask', rule });
  // Before the empty-name return: a bare 'sudo -i' or 'doas -s' runs no further command word.
  // A JS assignment to su is not a privilege shell; redirects and sudo still need their checks.
  if (escalated || (name === 'su' && !args[0]?.startsWith('=')) || name === 'sudo' || name === 'doas') ask('privilege');
  if (!name) return;
  const targets = args.filter(a => !a.startsWith('-')).map(unquote);
  const has = re => args.some(a => re.test(a));
  if (name === 'rm' && args.some(a => RECURSIVE_RM.test(a)) && targets.some(t => /^\$\{?[A-Za-z_]/.test(t))) ask('recursive-delete-variable');
  if (name === 'find' && (args.includes('-delete') || args.some((a, k) => /^-exec(?:dir)?$/.test(a) && baseName(args[k + 1] || '') === 'rm'))) ask('find-delete');
  const installers = { apt: 'install', 'apt-get': 'install', yum: 'install', dnf: 'install', brew: 'install', zypper: 'install', opkg: 'install', apk: 'add', snap: 'install', flatpak: 'install', gem: 'install', conda: 'install', choco: 'install', winget: 'install', scoop: 'install' };
  if ((Object.hasOwn(installers, name) && args.includes(installers[name])) || (name === 'pacman' && has(/^-S/)) || name === 'emerge') ask('system-package-install');
  if ((['pip', 'pip3'].includes(name) && args[0] === 'install') || (/^python\d*(?:\.\d+)?$/.test(name) && args[0] === '-m' && /^pip\d*$/.test(args[1] || '') && args[2] === 'install')) ask('package-install');
  if (['npm', 'pnpm'].includes(name) && /^(?:install|i|add)$/.test(args[0] || '') && has(/^(?:-g|--global|--registry(?:=.*)?)$/)) ask('package-install');
  if ((name === 'yarn' && args[0] === 'global') || (name === 'cargo' && args[0] === 'install')) ask('package-install');
  if (['useradd', 'adduser', 'userdel', 'deluser', 'groupadd', 'groupdel', 'usermod', 'groupmod', 'chsh', 'passwd', 'gpasswd', 'visudo', 'setcap'].includes(name)) ask('account');
  if (name === 'chown' && targets.length && /^(?:root|0)(?::|$)/.test(targets[0])) ask('account');
  if (name === 'systemctl' && /^(?:stop|disable|mask)$/.test(targets[0] || '')) ask('service');
  if (name === 'launchctl' && /^(?:unload|remove|bootout)$/.test(args[0] || '')) ask('service');
  if (['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'].includes(name) || (name === 'init' && /^[06]$/.test(args[0] || ''))) ask('machine-state');
  if ((name === 'iptables' && has(/^(?:-F|--flush)$/)) || (name === 'ufw' && args[0] === 'disable')) ask('firewall');
  if (name === 'crontab' && (has(/^-[er]$/) || targets.length)) ask('scheduler');
  if (name === 'export' && args.some(a => /^PATH=/.test(a))) ask('path-hijack');
  if (['set', 'setx'].includes(name) && args.some(a => /^PATH(?:=|$)/i.test(a))) ask('path-hijack');
  if (/^PATH=/i.test(segment) && /\$\{?PATH\b/i.test(segment.split(/\s/)[0])) ask('path-hijack');
  if (/^\$env:PATH\s*\+?=/i.test(segment)) ask('path-hijack');
  if (name === 'ssh' && args.some(a => baseName(a) === 'rm')) ask('remote-delete');
  if (name === 'scp' && args.some(a => /^[^\s/:]+:\s*\//.test(a))) ask('remote-copy-root');
  if (name === 'git') {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k += /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)$/.test(args[k]) ? 2 : 1;
    const rest = args.slice(k + 1);
    if (args[k] === 'config') {
      const readOnly = rest.some(a => /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|--show-origin|--show-scope|--name-only|--unset(?:-all)?|get|list|unset)$/.test(a));
      if (!readOnly && (rest.some(a => /^core\.(?:hookspath|fsmonitor|sshcommand)$/i.test(a)) || rest.some((a, j) => /^alias\./i.test(a) && /^!/.test(unquote(rest[j + 1] || ''))))) ask('git-config-exec');
    }
  }
  const redirected = [...segment.matchAll(REDIRECT)].some(match => PERSISTENT_TARGET.test(unquote(match[1])));
  const downloaderWrite = DOWNLOADERS.has(name) && args.some((arg, i) => {
    const output = /^(?:--output|--output-document|-OutFile)(?:=(.*))?$/i.exec(arg);
    const short = /^-[A-Za-z]*?[oO](.*)$/.exec(arg);
    const target = output ? output[1] || args[i + 1] : short ? short[1] || args[i + 1] : null;
    return target && PERSISTENT_TARGET.test(unquote(target));
  });
  if (redirected || downloaderWrite || (WRITE_VERBS.has(name) && targets.some(t => PERSISTENT_TARGET.test(t)))) ask('persistence-write');
}

// Line rules: pipelines, download-then-run, process substitution, interpreter code, reverse shells.
const INTERPRETER = /\b(?:python\d*(?:\.\d+)?|node|perl|ruby|php)(?:\s+\S+){0,6}?\s+(?:-c|-e|--eval|-p|--print|-r|-re)\b/i;
// A root-like literal in interpreter code: '/' or "~" (also as \"/\" inside a double-quoted shell
// argument), a bare / ~ or drive root, or a home lookup.
const ROOT_LITERAL = /\\?(["'])(?:\/|~|[A-Za-z]:[\\/]{0,2})\*?\\?\1|(?:^|[\s(,=])(?:\/\*?|~\/?|[A-Za-z]:[\\/]{1,2})(?=[\s),;]|$)|expanduser|homedir\(\)|process\.env\.(?:HOME|USERPROFILE)|os\.environ\[.HOME/;
function lineHits(text, hits) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/["']/g, '');
    let downloaded = false;
    let chmodded = false;
    for (const statement of line.split(/;|&&|\|\||(?<![|&>])&(?![&>])/)) {
      const stages = statement.split(/\|(?!\|)/).map(s => s.trim()).filter(Boolean);
      // What the earlier stages of this pipeline feed forward, carried stage by stage so a long
      // pipeline is read once.
      let fedCode = false;
      let fedSecret = false;
      for (let k = 0; k < stages.length; k += 1) {
        const stage = commandOf(stages[k]);
        if (k > 0) {
          if (SHELLS.has(stage.name) && fedCode) hits.push({ level: 'block', rule: 'pipe-to-shell' });
          if (['curl', 'wget', 'nc', 'ncat'].includes(stage.name) && fedSecret) hits.push({ level: 'block', rule: 'credential-exfil' });
        }
        const stageWords = words(stages[k]);
        fedCode ||= PIPE_SOURCES.has(stage.name) || stageWords.some(w => DOWNLOADERS.has(baseName(w)));
        fedSecret ||= stageWords.some(w => secretPath(w));
      }
      const first = commandOf(stages[0] || '');
      if (first.name && (downloaded || chmodded) && (SHELLS.has(first.name) || first.name === 'source' || first.name === '.' || /^\.[\\/]/.test(first.raw))) hits.push({ level: 'block', rule: 'download-then-run' });
      if (DOWNLOADERS.has(first.name) && first.args.some(a => /^(?:--output|-OutFile)$/i.test(a) || /^-[A-Za-z]*[oO]$/.test(a))) downloaded = true;
      if (first.name === 'chmod' && first.args.includes('+x')) chmodded = true;
    }
    if (/\b(?:bash|sh|zsh|source)\s+<\(\s*(?:curl|wget)\b|(?:^|\s)\.\s+<\(\s*(?:curl|wget)\b|\beval\s+\$\(\s*(?:curl|wget)\b|\b(?:iex|invoke-expression)\b[^\n]{0,200}?\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b/i.test(line)) hits.push({ level: 'block', rule: 'pipe-to-shell' });
    if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&/.test(line)) hits.push({ level: 'block', rule: 'fork-bomb' });
    if (/(?:^|\s)\d?>\s*\/dev\/(?:sd|nvme|hd|disk|mmcblk)/.test(line)) hits.push({ level: 'block', rule: 'disk' });
    if (/\/dev\/tcp\/[0-9A-Za-z.:-]{1,253}\/\d{1,5}/.test(line)) hits.push({ level: 'block', rule: 'reverse-shell' });
    if (/\bgh\s+(?:auth\s+token|secret\s+set)\b[^|\n]{0,500}\|/.test(line)) hits.push({ level: 'block', rule: 'secret-pipe' });
    const interp = INTERPRETER.exec(rawLine);
    if (interp) {
      const code = rawLine.slice(interp.index);
      const lang = interp[0].toLowerCase();
      const deletes = /shutil\.rmtree|os\.(?:remove|unlink|rmdir)\b|rmSync|unlinkSync|rmdirSync|fs\.(?:rm|unlink|rmdir)\b|fs\.promises\.rm|\bunlink\b|rmtree|File::Path|FileUtils\.rm|File\.delete|Dir\.(?:rmdir|delete)/.test(code);
      if (deletes) hits.push({ level: ROOT_LITERAL.test(code) ? 'block' : 'ask', rule: 'interpreter-delete' });
      const writes = /write(?:File|FileSync|Text|_text|_bytes)?\b|appendFile(?:Sync)?\b|copyFile(?:Sync)?\b|File\.open|open\([^\n]{0,200},\s*["'][wax+]/.test(code);
      if (writes && code.split(/[\s"'(),;]+/).some(token => PERSISTENT_TARGET.test(token))) hits.push({ level: 'ask', rule: 'persistence-write' });
      if ((lang.startsWith('python') && /\bsocket\b/.test(code) && /dup2|\bpty\b|subprocess|\/bin\/(?:ba)?sh/.test(code)) ||
          (lang.startsWith('perl') && /\bsocket\b/i.test(code)) || (lang.startsWith('ruby') && /TCPSocket/.test(code)) || (lang.startsWith('php') && /fsockopen/.test(code))) hits.push({ level: 'block', rule: 'reverse-shell' });
    }
  }
}

const RANK = { pass: 0, ask: 1, block: 2 };
// { level: 'block' | 'ask' | 'pass', rule } for one Bash command text.
export function inspectCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return { level: 'pass', rule: null };
  if (command.length > MAX_COMMAND_CHARS) return { level: 'ask', rule: 'oversized' };
  const uncommented = /["']/.test(command) ? command : stripComments(command);
  // Shell logical lines preserve pipeline and download state across continuations. Both passes
  // are linear: no rescanning or repeated concatenation of a growing logical line.
  const text = uncommented.replace(/\\\r?\n/g, ' ').replace(/(\||&&)[ \t]*\r?\n/g, '$1 ');
  const hits = [];
  for (const segment of segments(text)) { blockHits(segment, hits); askHits(segment, hits); }
  lineHits(text, hits);
  const boundary = inspectShellBoundary(command);
  if (boundary && boundary !== 'malformed-input') hits.push({ level: 'block', rule: boundary });
  let best = { level: 'pass', rule: null };
  for (const h of hits) if (RANK[h.level] > RANK[best.level]) best = h;
  return best;
}
// Edit content that holds command text the guard would block or ask about keeps the normal
// permission prompt (approval-policy auto mode). It is read in command-sized chunks.
export function contentNeedsPrompt(text) {
  if (typeof text !== 'string' || !text) return false;
  if (text.length > MAX_CONTENT_CHARS) return true;
  for (let start = 0; start < text.length; start += MAX_COMMAND_CHARS) {
    if (inspectCommand(text.slice(start, start + MAX_COMMAND_CHARS)).level !== 'pass') return true;
  }
  return false;
}

// URL and file-tool arguments are parsed by the shared deterministic tool policy.

const BLOCK_LINES = [
  'Harness20 checks the whole command text, including quoted strings and heredoc bodies, and this block cannot be approved from here.',
  'If the match is only inside a commit message or PR/issue body, write that text to a file with the Write tool and pass the file: git commit -F <file>, gh pr create --body-file <file>.',
  'Do not move commands into a script to get past this check. If the command itself must run, ask the user to run it.'
];
// hooks/destructive-guard.log next to the installed hooks, one line per block or ask. Best effort:
// a log that cannot be written never changes the decision.
const LOG_FILE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'destructive-guard.log');
function logDecision(verdict, command) {
  let descriptor;
  try {
    const now = new Date();
    const two = value => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
    const digest = createHash('sha256').update(String(command)).digest('hex');
    const line = `[${stamp}] ${verdict.level === 'block' ? 'BLOCKED' : 'ASK'} rule=${verdict.rule} command_sha256=${digest}\n`;
    const prior = fs.lstatSync(LOG_FILE, { throwIfNoEntry: false });
    if (prior && (!prior.isFile() || prior.nlink !== 1 || prior.size + Buffer.byteLength(line) > TOOL_INPUT_LIMIT)) return;
    descriptor = fs.openSync(LOG_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size + Buffer.byteLength(line) > TOOL_INPUT_LIMIT ||
        prior && (info.ino !== prior.ino || info.dev !== prior.dev)) return;
    // An explicit bounded position prevents concurrent writers from growing an
    // append-only file past the ceiling. Telemetry may overlap under contention;
    // it is best effort and never controls the deny decision.
    fs.writeSync(descriptor, line, info.size, 'utf8');
  } catch {} finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {} }
}

function main(mode) {
  let event;
  try {
    const raw = readBoundedStdin();
    if (raw.length > TOOL_INPUT_LIMIT) throw Error('input too large');
    event = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/, ''));
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw Error('invalid event');
  } catch {
    if (['pretool','permission'].includes(mode)) {
      process.stderr.write('BLOCKED: Harness20 rejected malformed or oversized tool input.\n');
      return 2;
    }
    process.stdout.write('prompt');
    return 0;
  }
  if (mode === 'content') {
    const input = event?.tool_input || {};
    const texts = toolContent(input);
    process.stdout.write(texts.some(contentNeedsPrompt) ? 'prompt' : 'clean');
    return 0;
  }
  const policy = inspectToolPolicy(event, { workspaceRoot: process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd() });
  if (policy.supported && policy.rule) {
    const reason = `harness20: blocked unsafe tool input (${policy.rule})`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: mode === 'permission'
      ? { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', reason } }
      : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    return 2;
  }
  if (event?.tool_name !== 'Bash') return 0;
  const command = event?.tool_input?.command;
  const boundary = inspectShellBoundary(command);
  const verdict = boundary === 'malformed-input' ? { level: 'block', rule: boundary } : inspectCommand(command);
  if (mode === 'pretool') {
    if (verdict.level !== 'pass') logDecision(verdict, command);
    if (verdict.level === 'block') {
      process.stderr.write(`BLOCKED: Destructive command detected\nRule: ${verdict.rule}\nCommand SHA256: ${createHash('sha256').update(String(command)).digest('hex')}\n${BLOCK_LINES.join('\n')}\n`);
      return 2;
    }
    if (verdict.level === 'ask') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `harness20: ${verdict.rule} needs your confirmation (destructive-guard ask rule)` } }));
    }
    return 0;
  }
  if (mode === 'permission' && verdict.level === 'block') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', reason: `harness20: PermissionRequest blocked - destructive command pattern (${verdict.rule}) (cross-plugin tamper protection)` } } }));
    process.stderr.write(`Harness20 denied this permission request because the command text matches a destructive pattern (quoted strings and heredoc bodies included).\n${BLOCK_LINES.slice(1).join('\n')}\n`);
    return 2;
  }
  return 0;
}
function invokedDirectly() {
  try { return fs.realpathSync.native(process.argv[1] ?? '') === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (invokedDirectly()) process.exitCode = main(process.argv[2]);
