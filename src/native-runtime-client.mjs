#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPrivacyFormatter } from './privacy.mjs';
import { RecipientRegistry } from './recipient-registry.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
const MAX_BODY = 1024 * 1024;
function failure(code, message) { return Object.assign(new Error(message), { code }); }
export async function callPersistentHost({ method, args = {}, requestId = randomUUID(), tokenFile = resolve(WORKSPACE, 'data/research-host.json'), timeoutMs }, fetchImpl = fetch) {
  const descriptor = JSON.parse(await readFile(tokenFile, 'utf8'));
  if (descriptor.host !== '127.0.0.1' || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[a-f0-9]{64}$/.test(descriptor.token ?? '')) throw failure('E_HOST_DESCRIPTOR', 'Invalid localhost host descriptor');
  const body = JSON.stringify({ method, args, requestId });
  if (Buffer.byteLength(body) > MAX_BODY) throw failure('E_BODY_SIZE', 'Body exceeds 1 MiB');
  const limit = timeoutMs ?? (descriptor.timeoutMs ?? 15000) + 10000;
  if (!Number.isSafeInteger(limit) || limit < 100 || limit > 180000) throw failure('E_TIMEOUT_VALUE', 'Invalid client timeout');
  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${descriptor.port}/command`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-wxcc-token': descriptor.token }, body, signal: AbortSignal.timeout(limit) });
  } catch (error) {
    // The request may already have entered the target. Never reconnect or retry automatically.
    throw failure('E_TRANSPORT_UNKNOWN', `No response; target outcome is unknown. Query status with requestId ${requestId}. No automatic retry was attempted. (${error.name})`);
  }
  const value = await response.json();
  if (typeof value !== 'object' || value === null) throw failure('E_HOST_RESPONSE', 'Host returned invalid JSON');
  return { ...value, httpStatus: response.status };
}
function parseCli(argv) {
  if (argv[0] === '--help' || !argv.length) return { help: true };
  const method = argv[0];
  if (!['status', 'inspect', 'load', 'rpc', 'unload', 'detach', 'stop'].includes(method)) throw failure('E_METHOD', 'Supported: status, inspect, load, rpc, unload, detach, stop');
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--no-redact') { flags.redact = false; continue; }
    if (!['--args', '--request-id', '--token-file', '--timeout', '--redact'].includes(argv[i]) || argv[i + 1] === undefined) throw failure('E_ARGUMENT', 'Options: --args JSON --request-id ID --token-file FILE --timeout MS --redact true|false');
    flags[argv[i].slice(2)] = argv[++i];
  }
  if (flags.redact !== undefined && flags.redact !== false && !['true', 'false'].includes(flags.redact)) throw failure('E_ARGUMENT', '--redact must be true or false');
  return { method, args: flags.args ? JSON.parse(flags.args) : {}, requestId: flags['request-id'] ?? randomUUID(), tokenFile: flags['token-file'], timeoutMs: flags.timeout === undefined ? undefined : Number(flags.timeout), redact: flags.redact !== false && flags.redact !== 'false' };
}
export async function runNativeRuntimeClient(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write('node src/native-runtime-client.mjs METHOD [--args JSON] [--request-id ID]\nMethods: status, inspect, load, rpc, unload, detach, stop\nload args: {"name":"probe","path":"agents/probe.js"}\nrpc args: {"name":"probe","method":"inspect","params":[]}\nunload args: {"name":"probe","explicit":true}; detach args: {"explicit":true}\nQuery an unknown outcome: status --args {"requestId":"ORIGINAL_ID"}\nUse a new requestId for each request. Repeated requestIds are rejected. Token stays in the ignored data/research-host.json file; do not share it. Windows uses the directory ACL. Detach before stop.\n');
    return;
  }
  const value = await callPersistentHost(options);
  const registry = new RecipientRegistry();
  await registry.read();
  const privacy = createPrivacyFormatter({ enabled: options.redact, registry });
  process.stdout.write(`${privacy.format(value)}\n`);
  if (!value.success) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNativeRuntimeClient().catch(error => { process.stderr.write(`${createPrivacyFormatter().format({ success: false, error: { code: error.code ?? 'E_CLIENT', message: error.message } })}\n`); process.exitCode = 1; });
}
