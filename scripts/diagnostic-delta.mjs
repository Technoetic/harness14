#!/usr/bin/env node
import { captureDiagnostics, compareDiagnostics } from './lib/diagnostic-delta.mjs';

const fail = () => { throw Error('Invalid diagnostic CLI arguments or bounded input.'); };
function argumentsFor(args) {
  const action = args[0];
  if (!['capture', 'compare'].includes(action)) fail();
  const allowed = new Set(['--workspace', '--input', '--workflow-profile', ...(action === 'compare' ? ['--baseline-id', '--baseline-sha256'] : [])]);
  const values = {};
  for (let i = 1; i < args.length; i += 2) {
    const option = args[i], value = args[i + 1];
    if (!allowed.has(option) || Object.hasOwn(values, option) || typeof value !== 'string' || !value || value.startsWith('--')) fail();
    values[option] = value;
  }
  if (!values['--workspace'] || values['--input'] !== '-') fail();
  if (action === 'compare' && (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(values['--baseline-id'] ?? '')
      || !/^[a-f0-9]{64}$/.test(values['--baseline-sha256'] ?? ''))) fail();
  return { action, workspace: values['--workspace'], options: {
    ...(values['--workflow-profile'] ? { workflowProfile: values['--workflow-profile'] } : {}),
    ...(action === 'compare' ? { baseline: { id: values['--baseline-id'], sha256: values['--baseline-sha256'] } } : {}) } };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('diagnostic-delta.mjs capture|compare --workspace <root> --input - [--workflow-profile <id>]\ncompare also requires --baseline-id <uuid> --baseline-sha256 <sha256>');
    return;
  }
  const selected = argumentsFor(args);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) fail();
    chunks.push(chunk);
  }
  const operation = selected.action === 'capture' ? captureDiagnostics : compareDiagnostics;
  const result = await operation(selected.workspace, Buffer.concat(chunks), selected.options);
  console.log(JSON.stringify(result, null, 2));
  if (!['CAPTURED', 'COMPARED'].includes(result.status)) process.exitCode = 1;
}
main().catch(() => {
  // Parser/FS messages may contain the raw input or an absolute private path.
  console.log(JSON.stringify({ status: 'INCOMPLETE', advisory: true, error: 'Invalid diagnostic CLI arguments or bounded input.' }));
  process.exitCode = 2;
});
