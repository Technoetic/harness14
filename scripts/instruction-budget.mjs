#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { inspectInstructionBudget } from './lib/instruction-budget.mjs';
import { writeOutput } from './lib/json-io.mjs';

function parseArgs(argv) {
  const options = Object.create(null);
  if (argv.length % 2) throw Error();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!['--root', '--registry'].includes(flag) || Object.hasOwn(options, flag)
      || typeof value !== 'string' || !value || value.startsWith('--') || value.includes('\0')) throw Error();
    options[flag] = value;
  }
  return options;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options['--root'] ?? fileURLToPath(new URL('../', import.meta.url));
  const result = await inspectInstructionBudget(root,
    options['--registry'] === undefined ? {} : { registryPath: options['--registry'] });
  await writeOutput(process.stdout, `${JSON.stringify(result)}\n`);
  process.exitCode = result.verdict === 'PASS' ? 0 : 2;
}
main().catch(async () => {
  process.exitCode = 2;
  try {
    await writeOutput(process.stderr, `${JSON.stringify({ error: {
      code: 'INSTRUCTION_BUDGET_FAILED', message: 'Instruction budget inspection failed',
    } })}\n`);
  } catch { /* Do not disclose output exceptions or submitted values. */ }
});
