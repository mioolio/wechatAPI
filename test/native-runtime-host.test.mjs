import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPersistentHost, validateInstallation, agentPath } from '../src/native-runtime-host.mjs';
import { callPersistentHost } from '../src/native-runtime-client.mjs';

const scratch = fileURLToPath(new URL('../artifacts/research/', import.meta.url));
const hash = 'a'.repeat(64);
class Signal {
  handlers = [];
  connect(fn) { this.handlers.push(fn); }
  emit(...args) { for (const fn of this.handlers) fn(...args); }
}
class FakeCancellable {
  isCancelled = false;
  cancel() { this.isCancelled = true; this.onCancel?.(); }
}
async function fixture() {
  await mkdir(scratch, { recursive: true });
  const workspace = await mkdtemp(resolve(scratch, 'frida-mock-'));
  await mkdir(resolve(workspace, 'agents'));
  await mkdir(resolve(workspace, 'profiles'));
  await writeFile(resolve(workspace, 'agents/inspect.js'), '// mock metadata agent');
  await writeFile(resolve(workspace, 'agents/probe.js'), '// mock probe agent');
  await writeFile(resolve(workspace, 'profiles/4.1.15.13.json'), JSON.stringify({ version: '4.1.15.13', architecture: 'x64', dllSha256: hash }));
  const exePath = resolve(workspace, 'installed/Weixin.exe');
  const dllPath = resolve(workspace, 'installed/4.1.15.13/Weixin.dll');
  const info = { version: '4.1.15.13', architecture: 'x64', hashes: { dll: hash }, exe: { path: exePath }, dll: { path: dllPath }, processes: [{ pid: 1234, path: exePath }], processInspectionAvailable: true, diagnostics: [] };
  const calls = [];
  const session = {
    detached: new Signal(), isDetached: () => session.didDetach ?? false,
    async createScript(source, options) {
      calls.push({ method: 'createScript', name: options.name, source });
      const script = {
        message: new Signal(), destroyed: new Signal(), isDestroyed: false,
        async load() { calls.push({ method: 'load', name: options.name }); },
        async unload() { calls.push({ method: 'unload', name: options.name }); script.isDestroyed = true; script.destroyed.emit(); },
        exports: {
          async inspect() { calls.push({ method: 'inspect' }); return { pid: 1234, architecture: 'x64', mainModule: { path: dllPath, base: '0x10000000', size: 1000 } }; },
          async echo(value) { calls.push({ method: 'echo', value }); return value; },
          async hang(cancellable) { calls.push({ method: 'hang' }); return new Promise((_, reject) => { cancellable.onCancel = () => reject(new Error('cancelled')); }); },
        },
      };
      session.created ??= [];
      session.created.push(script);
      return script;
    },
    async detach() { calls.push({ method: 'detach' }); session.didDetach = true; session.detached.emit('application-requested', null); },
  };
  const frida = { Cancellable: FakeCancellable, async getLocalDevice() { return { async attach(pid) { calls.push({ method: 'attach', pid }); return session; } }; } };
  const stdout = [];
  async function start(timeoutMs = 1000) {
    const host = await createPersistentHost({ pid: 1234, workspace, timeoutMs }, { frida, doctor: async () => info, stdout: value => stdout.push(value) });
    await host.startup;
    return host;
  }
  async function cleanup(host) {
    if (host) {
      if (host.status().attached) await callPersistentHost({ tokenFile: host.tokenFile, method: 'detach', args: { explicit: true } });
      await callPersistentHost({ tokenFile: host.tokenFile, method: 'stop' });
      await host.closed;
    }
    if (!resolve(workspace).startsWith(`${resolve(scratch)}${sep}`)) throw new Error('Refusing cleanup outside the explicit mock fixture directory');
    await rm(workspace, { recursive: true, force: true });
  }
  return { workspace, info, session, frida, calls, stdout, start, cleanup };
}

test('static identity failures precede every mock attach', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(validateInstallation({ pid: 8888, workspace: fx.workspace }, async () => fx.info), { code: 'E_PID' });
    const altered = { ...fx.info, hashes: { dll: 'b'.repeat(64) } };
    await assert.rejects(validateInstallation({ pid: 1234, workspace: fx.workspace }, async () => altered), { code: 'E_HASH' });
    assert.equal(fx.calls.length, 0);
  } finally { await fx.cleanup(); }
});
test('agent file must resolve inside workspace agents', async () => {
  const fx = await fixture();
  try {
    await writeFile(resolve(fx.workspace, 'outside.js'), '// outside');
    await assert.rejects(agentPath(fx.workspace, 'outside.js'), { code: 'E_AGENT_PATH' });
    assert.equal(await agentPath(fx.workspace, 'agents/probe.js'), resolve(fx.workspace, 'agents/probe.js'));
  } finally { await fx.cleanup(); }
});
test('persistent host authenticates locally, loads one initial script and emits no token', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start();
    const descriptor = JSON.parse(await readFile(host.tokenFile, 'utf8'));
    assert.equal(descriptor.host, '127.0.0.1');
    assert.equal(fx.calls.filter(x => x.method === 'attach').length, 1);
    assert.equal(fx.calls.filter(x => x.method === 'createScript').length, 1);
    assert.equal(host.status().status, 'ready');
    assert.equal(JSON.stringify(fx.stdout).includes(descriptor.token), false);
    const unauthorized = await fetch(`http://127.0.0.1:${descriptor.port}/command`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    const status = await callPersistentHost({ tokenFile: host.tokenFile, method: 'status' });
    assert.equal(status.success, true);
    assert.equal(status.result.verified, true);
  } finally { await fx.cleanup(host); }
});
test('named scripts and explicit RPC use the existing session', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start();
    assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'probe', path: 'agents/probe.js' } })).success, true);
    const rpc = await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', args: { name: 'probe', method: 'echo', params: ['ok'] } });
    assert.equal(rpc.result, 'ok');
    assert.equal(fx.calls.filter(x => x.method === 'attach').length, 1);
    const unload = await callPersistentHost({ tokenFile: host.tokenFile, method: 'unload', args: { name: 'probe', explicit: true } });
    assert.equal(unload.success, true);
  } finally { await fx.cleanup(host); }
});
test('script hashes describe the loaded source even when the file is later changed', async () => {
  const fx = await fixture();
  let host;
  const sourceHash = source => createHash('sha256').update(source, 'utf8').digest('hex');
  try {
    host = await fx.start();
    const inspectSource = fx.calls.find(x => x.method === 'createScript' && x.name === 'wxcc-inspect').source;
    assert.equal(host.status().scripts.find(x => x.name === 'inspect').sourceSha256, sourceHash(inspectSource));
    const original = await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'probe', path: 'agents/probe.js' } });
    assert.equal(original.success, true);
    const originalSource = fx.calls.find(x => x.method === 'createScript' && x.name === 'wxcc-probe').source;
    assert.equal(original.result.sourceSha256, sourceHash(originalSource));

    const changedSource = '// 改变源码后，仅新加载的脚本使用这个版本\n';
    await writeFile(resolve(fx.workspace, 'agents/probe.js'), changedSource, 'utf8');
    const afterEdit = await callPersistentHost({ tokenFile: host.tokenFile, method: 'status' });
    assert.equal(afterEdit.result.scripts.find(x => x.name === 'probe').sourceSha256, original.result.sourceSha256);

    const fresh = await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'probeNew', path: 'agents/probe.js' } });
    assert.equal(fresh.success, true);
    assert.equal(fx.calls.find(x => x.method === 'createScript' && x.name === 'wxcc-probeNew').source, changedSource);
    assert.equal(fresh.result.sourceSha256, sourceHash(changedSource));
    assert.notEqual(fresh.result.sourceSha256, original.result.sourceSha256);
    const status = await callPersistentHost({ tokenFile: host.tokenFile, method: 'status' });
    assert.equal(status.result.scripts.find(x => x.name === 'probe').sourceSha256, original.result.sourceSha256);
    assert.equal(status.result.scripts.find(x => x.name === 'probeNew').sourceSha256, fresh.result.sourceSha256);
  } finally { await fx.cleanup(host); }
});
test('same normalized requestId is rejected and timed-out RPC remains unknown', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start(100);
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'probe', path: 'agents/probe.js' } });
    const result = await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: ' Test-ID ', args: { name: 'probe', method: 'hang', params: [] } });
    assert.equal(result.requestStatus, 'unknown');
    assert.equal(result.error.code, 'E_TIMEOUT_UNKNOWN');
    const duplicate = await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: 'test-id', args: { name: 'probe', method: 'hang', params: [] } });
    assert.equal(duplicate.error.code, 'E_REQUEST_DUPLICATE');
    assert.equal(fx.calls.filter(x => x.method === 'hang').length, 1);
    const lookup = await callPersistentHost({ tokenFile: host.tokenFile, method: 'status', args: { requestId: 'TEST-ID' } });
    assert.equal(lookup.result.request.status, 'unknown');
    assert.deepEqual(lookup.result.host.unknownRequests, ['test-id']);
  } finally { await fx.cleanup(host); }
});
test('stop/SIGINT never initiate cleanup; unload/detach require explicit arguments', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start();
    host.noteSignal('SIGINT');
    const denied = await callPersistentHost({ tokenFile: host.tokenFile, method: 'stop' });
    assert.equal(denied.error.code, 'E_ATTACHED_STOP');
    assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'detach' })).error.code, 'E_EXPLICIT_REQUIRED');
    assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'unload', args: { name: 'inspect' } })).error.code, 'E_EXPLICIT_REQUIRED');
    assert.equal(fx.calls.filter(x => ['detach', 'unload'].includes(x.method)).length, 0);
  } finally { await fx.cleanup(host); }
});
test('explicit agent payload is logged but attached binary bytes are never dumped', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start();
    fx.session.created[0].message.emit({ type: 'send', payload: { observation: 'mock-only' } }, Buffer.from('DO-NOT-DUMP'));
    fx.session.created[0].logHandler('info', 'DO-NOT-PRINT-CONSOLE');
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'status' });
    const log = await readFile(host.eventFile, 'utf8');
    assert.match(log, /mock-only/);
    assert.equal(log.includes('DO-NOT-DUMP'), false);
    assert.equal(log.includes('RE8tTk9ULURVTVA='), false);
    assert.equal(log.includes('DO-NOT-PRINT-CONSOLE'), false);
    assert.equal(JSON.stringify(fx.stdout).includes('DO-NOT-PRINT-CONSOLE'), false);
  } finally { await fx.cleanup(host); }
});
test('HTTP content length above 1 MiB is rejected before commands execute', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start();
    const descriptor = JSON.parse(await readFile(host.tokenFile, 'utf8'));
    const oversized = JSON.stringify({ requestId: 'large', method: 'status', padding: 'x'.repeat(1024 * 1024) });
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/command`, { method: 'POST', headers: { 'x-wxcc-token': descriptor.token, 'content-type': 'application/json' }, body: oversized });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'E_BODY_SIZE');
  } finally { await fx.cleanup(host); }
});
test('independent requests run serially and explicit cleanup records begin before end', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start();
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'probe', path: 'agents/probe.js' } });
    const order = [];
    const probe = fx.session.created[1];
    probe.exports.step = async value => {
      order.push(`begin:${value}`);
      await new Promise(resolveTick => setTimeout(resolveTick, 20));
      order.push(`end:${value}`);
      return value;
    };
    const first = callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', args: { name: 'probe', method: 'step', params: [1] } });
    const second = callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', args: { name: 'probe', method: 'step', params: [2] } });
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.result), [1, 2]);
    // File reads and HTTP delivery can reorder independently dispatched requests.
    // Both arrival orders must remain serialized, with no overlapping native RPC.
    const arrivedFirst = order[0] === 'begin:1' ? 1 : 2;
    const arrivedSecond = arrivedFirst === 1 ? 2 : 1;
    assert.deepEqual(order, [`begin:${arrivedFirst}`, `end:${arrivedFirst}`, `begin:${arrivedSecond}`, `end:${arrivedSecond}`]);
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'unload', args: { name: 'probe', explicit: true } });
    const journal = (await readFile(host.eventFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const begin = journal.findIndex(row => row.phase === 'unload.begin');
    const end = journal.findIndex(row => row.phase === 'unload.end');
    assert.ok(begin >= 0 && begin < end);
  } finally { await fx.cleanup(host); }
});
test('startup RPC error keeps session alive without automatic detach', async () => {
  const fx = await fixture();
  let host;
  try {
    const original = fx.session.createScript;
    fx.session.createScript = async (...args) => {
      const script = await original(...args);
      script.exports.inspect = async () => { throw new Error('mock inspection error'); };
      return script;
    };
    host = await fx.start();
    assert.equal(host.status().status, 'attached-error');
    assert.equal(host.status().attached, true);
    assert.equal(fx.calls.some(x => x.method === 'detach'), false);
  } finally { await fx.cleanup(host); }
});
