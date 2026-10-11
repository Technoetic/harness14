#!/usr/bin/env node
import { readJsonInput, writeOutput } from './lib/json-io.mjs';
import { freezeRequirements, inspectRequirementInventory, inspectRequirementCoverage } from './lib/requirement-coverage.mjs';

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!['freeze', 'inspect', 'inspect-inventory'].includes(command) || args.length % 2) throw new Error('Invalid command');
  const allowed = new Set(['workspace', 'workflow-profile', ...(command === 'freeze' ? ['input'] : ['inventory-sha256'])]);
  const options = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2); const value = args[i + 1];
    if (!args[i].startsWith('--') || !allowed.has(key) || Object.hasOwn(options, key) ||
        typeof value !== 'string' || !value.trim() || value.startsWith('--') || value.includes('\0')) throw new Error('Invalid flags');
    options[key] = value;
  }
  if (!options.workspace || (command === 'freeze' && options.input !== '-')) throw new Error('Missing flags');
  return { command, workspace: options.workspace, options: {
    ...(options['workflow-profile'] ? { workflowProfile: options['workflow-profile'] } : {}),
    ...(options['inventory-sha256'] ? { inventorySha256: options['inventory-sha256'] } : {}) } };
}

async function main() {
  const { command, workspace, options } = parseArgs(process.argv.slice(2));
  const result = command === 'freeze' ? await freezeRequirements(workspace, await readJsonInput(process.stdin, 64 * 1024), options)
    : command === 'inspect-inventory' ? await inspectRequirementInventory(workspace, options)
    : await inspectRequirementCoverage(workspace, options);
  await writeOutput(process.stdout, `${JSON.stringify(result)}\n`);
  process.exitCode = result.verdict === 'PASS' ? 0 : 2;
}
main().catch(async () => {
  process.exitCode = 2;
  try { await writeOutput(process.stderr, `${JSON.stringify({ error: {
    code: 'REQUIREMENT_COMMAND_FAILED', message: 'Requirement coverage command failed' } })}\n`); }
  catch { /* Keep secondary stream failures private. */ }
});
