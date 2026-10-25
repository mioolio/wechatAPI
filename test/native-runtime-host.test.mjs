import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, unlink } from 'node:fs/promises';
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
async function fixture({ version = '4.1.15.13' } = {}) {
  await mkdir(scratch, { recursive: true });
  const workspace = await mkdtemp(resolve(scratch, 'frida-mock-'));
  await mkdir(resolve(workspace, 'agents'));
  for (const version of ['4.1.15.13', '4.2.0.7']) await mkdir(resolve(workspace, 'wechat-adapters', version), { recursive: true });
  await writeFile(resolve(workspace, 'agents/inspect.js'), '// mock metadata agent');
  await writeFile(resolve(workspace, 'agents/probe.js'), '// mock probe agent');
  await writeFile(resolve(workspace, 'wechat-adapters/4.1.15.13/read-agent.js'), '// mock trusted read agent');
  await writeFile(resolve(workspace, 'wechat-adapters/4.1.15.13/send-agent.js'), '// mock trusted send agent');
  await writeFile(resolve(workspace, 'wechat-adapters/4.2.0.7/read-agent.js'), '// mock trusted 4.2 read agent');
  await writeFile(resolve(workspace, 'wechat-adapters/4.2.0.7/send-agent.js'), '// mock trusted 4.2 send agent');
  await writeFile(resolve(workspace, 'wechat-adapters', version, 'profile.json'), JSON.stringify({ version, architecture: 'x64', dllSha256: hash }));
  const exePath = resolve(workspace, 'installed/Weixin.exe');
  const dllPath = resolve(workspace, 'installed', version, 'Weixin.dll');
  const info = { version, architecture: 'x64', hashes: { dll: hash }, exe: { path: exePath }, dll: { path: dllPath }, processes: [{ pid: 1234, path: exePath }], processInspectionAvailable: true, diagnostics: [] };
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
          async account() { calls.push({ method: 'account' }); return { read: true }; },
          async contacts() { calls.push({ method: 'contacts' }); return { read: true }; },
          async history() { calls.push({ method: 'history' }); return { read: true }; },
          async prepare() { calls.push({ method: 'prepare' }); return { configured: true }; },
          async rebind() { calls.push({ method: 'rebind' }); return { configured: true }; },
          async prepareImage() { calls.push({ method: 'prepareImage' }); return { prepared: true }; },
          async sendText() { calls.push({ method: 'sendText' }); return { status: 'accepted' }; },
          async sendImage() { calls.push({ method: 'sendImage' }); return { status: 'accepted' }; },
          async changedAccount() { throw new Error('E_ACCOUNT_CHANGED'); },
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
  let server;
  async function start(timeoutMs = 1000, overrides = {}) {
    const host = await createPersistentHost({ pid: 1234, workspace, timeoutMs }, { frida, doctor: async () => info, stdout: value => stdout.push(value),
      createServer(handler) { server = createServer(handler); return server; }, ...overrides });
    await host.startup;
    return host;
  }
  async function cleanup(host) {
    if (host) {
      const status = host.status();
      const cleanupSlots = status.attached ? 2 : 1;
      if (status.requestLedger.limit - status.requestLedger.retained < cleanupSlots) {
        // This is an injected Fake Frida session, not Weixin. Close only the mock
        // HTTP listener when deliberately testing the protected ledger at capacity.
        await new Promise(done => server.close(done));
      } else {
        if (status.attached) await callPersistentHost({ tokenFile: host.tokenFile, method: 'detach', args: { explicit: true } });
        await callPersistentHost({ tokenFile: host.tokenFile, method: 'stop' });
      }
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
test('only registered version agent files can load outside common agents', async () => {
  const fx = await fixture();
  try {
    const allowed = 'wechat-adapters/4.2.0.7/read-agent.js';
    assert.equal(await agentPath(fx.workspace, allowed), resolve(fx.workspace, allowed));
    assert.equal(await agentPath(fx.workspace, resolve(fx.workspace, allowed)), resolve(fx.workspace, allowed));
    await writeFile(resolve(fx.workspace, 'wechat-adapters/4.2.0.7/index.mjs'), '// metadata is not executable as an agent');
    await writeFile(resolve(fx.workspace, 'wechat-adapters/4.2.0.7/unregistered.js'), '// not approved');
    await assert.rejects(agentPath(fx.workspace, 'wechat-adapters/4.2.0.7/index.mjs'), { code: 'E_AGENT_PATH' });
    await assert.rejects(agentPath(fx.workspace, 'wechat-adapters/4.2.0.7/unregistered.js'), { code: 'E_AGENT_PATH' });
    await writeFile(resolve(fx.workspace, 'outside.js'), '// outside');
    await assert.rejects(agentPath(fx.workspace, 'wechat-adapters/4.2.0.7/../../outside.js'), { code: 'E_AGENT_PATH' });
  } finally { await fx.cleanup(); }
});
test('a registered version directory cannot redirect its source through a junction', async t => {
  const fx = await fixture();
  const versionDirectory = resolve(fx.workspace, 'wechat-adapters/4.2.0.7');
  const redirectedDirectory = resolve(fx.workspace, 'redirected-version');
  let linked = false;
  try {
    await rename(versionDirectory, redirectedDirectory);
    try { await symlink(redirectedDirectory, versionDirectory, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('This filesystem cannot create directory links.'); return; } throw error; }
    await assert.rejects(agentPath(fx.workspace, 'wechat-adapters/4.2.0.7/read-agent.js'), { code: 'E_AGENT_PATH' });
  } finally {
    if (linked) await unlink(versionDirectory);
    await fx.cleanup();
  }
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

test('native identity failures preserve their actionable error code', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start();
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'probe', path: 'agents/probe.js' } });
    const result = await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', args: { name: 'probe', method: 'changedAccount', params: [] } });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'E_ACCOUNT_CHANGED');
    assert.equal(fx.calls.filter(call => call.method === 'attach').length, 1);
    assert.equal(fx.calls.some(call => call.method === 'unload'), false);
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

test('trusted read and send metadata polling exceeds the ledger limit without retaining successful reads', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start(1000, { requestLedgerLimit: 3 });
    for (const [name, path] of [['readnative_live5', 'wechat-adapters/4.1.15.13/read-agent.js'], ['sendnative_live5', 'wechat-adapters/4.1.15.13/send-agent.js']]) {
      assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name, path } })).success, true);
    }
    for (let round = 0; round < 12; round++) {
      const status = await callPersistentHost({ tokenFile: host.tokenFile, method: 'status', requestId: 'repeat-safe-status' });
      assert.equal(status.success, true);
      for (const [name, methods] of [['readnative_live5', ['inspect', 'account', 'contacts', 'history']], ['sendnative_live5', ['inspect', 'contacts']]]) {
        for (const method of methods) {
          const response = await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: `repeat-${name}-${method}`, args: { name, method, params: [] } });
          assert.equal(response.success, true, `${name}.${method}`);
        }
      }
    }
    assert.deepEqual(host.status().requestLedger, { limit: 3, retained: 2, readOnlyLimit: 3, readOnlyRetained: 0, unknown: 0 });
  } finally { await fx.cleanup(host); }
});

test('4.2 trusted read lane pins 4.2 paths and never treats the old source as trusted', async () => {
  for (const oldSource of [false, true]) {
    const fx = await fixture({ version: '4.2.0.7' });
    let host;
    try {
      host = await fx.start(1000, { requestLedgerLimit: 3 });
      const path = oldSource ? 'wechat-adapters/4.1.15.13/read-agent.js' : 'wechat-adapters/4.2.0.7/read-agent.js';
      assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'readnative_live5', path } })).success, true);
      if (oldSource) {
        for (let index = 0; index < 2; index++) assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', args: { name: 'readnative_live5', method: 'account', params: [] } })).success, true);
        assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', args: { name: 'readnative_live5', method: 'account', params: [] } })).error.code, 'E_REQUEST_LIMIT');
      } else {
        assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'sendnative_live5', path: 'wechat-adapters/4.2.0.7/send-agent.js' } })).success, true);
        for (let index = 0; index < 6; index++) {
          for (const [name, methods] of [['readnative_live5', ['inspect', 'account', 'contacts', 'history']], ['sendnative_live5', ['inspect', 'contacts']]]) {
            for (const method of methods) assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: `repeat-${name}-${method}`, args: { name, method, params: [] } })).success, true);
          }
        }
        assert.deepEqual(host.status().requestLedger, { limit: 3, retained: 2, readOnlyLimit: 3, readOnlyRetained: 0, unknown: 0 });
      }
    } finally { await fx.cleanup(host); }
  }
});

test('full protected ledger still permits reads and status while never losing or replaying a send', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start(1000, { requestLedgerLimit: 3 });
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'readnative_live5', path: 'wechat-adapters/4.1.15.13/read-agent.js' } });
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'probe', path: 'agents/probe.js' } });
    const send = { tokenFile: host.tokenFile, method: 'rpc', requestId: 'send-once', args: { name: 'probe', method: 'sendText', params: [] } };
    assert.equal((await callPersistentHost(send)).success, true);
    for (let i = 0; i < 10; i++) {
      assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', args: { name: 'readnative_live5', method: 'account', params: [] } })).success, true);
    }
    const lookup = await callPersistentHost({ tokenFile: host.tokenFile, method: 'status', args: { requestId: 'SEND-ONCE' } });
    assert.equal(lookup.success, true);
    assert.equal(lookup.result.request.status, 'complete');
    assert.equal(lookup.result.host.requestLedger.retained, 3);
    assert.equal((await callPersistentHost(send)).error.code, 'E_REQUEST_DUPLICATE');
    assert.equal((await callPersistentHost({ ...send, requestId: 'new-send' })).error.code, 'E_REQUEST_LIMIT');
    assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'status', requestId: 'send-once' })).error.code, 'E_REQUEST_DUPLICATE');
    assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: 'send-once', args: { name: 'readnative_live5', method: 'account', params: [] } })).error.code, 'E_REQUEST_DUPLICATE');
    assert.equal(fx.calls.filter(call => call.method === 'sendText').length, 1);
  } finally { await fx.cleanup(host); }
});

test('unknown trusted reads and arbitrary RPCs remain queryable and cannot be replayed after read polling', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start(100, { requestLedgerLimit: 4 });
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'readnative_live5', path: 'wechat-adapters/4.1.15.13/read-agent.js' } });
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'probe', path: 'agents/probe.js' } });
    const loadedRead = fx.session.created[1];
    loadedRead.exports.history = async cancellable => {
      fx.calls.push({ method: 'uncertain-history' });
      return new Promise((_, reject) => { cancellable.onCancel = () => reject(new Error('synthetic read cancellation')); });
    };
    const read = { tokenFile: host.tokenFile, method: 'rpc', requestId: 'unknown-read', args: { name: 'readnative_live5', method: 'history', params: [] } };
    assert.equal((await callPersistentHost(read)).requestStatus, 'unknown');
    const write = { tokenFile: host.tokenFile, method: 'rpc', requestId: 'unknown-operation', args: { name: 'probe', method: 'hang', params: [] } };
    assert.equal((await callPersistentHost(write)).requestStatus, 'unknown');
    for (let i = 0; i < 12; i++) {
      assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', args: { name: 'readnative_live5', method: 'account', params: [] } })).success, true);
    }
    assert.equal((await callPersistentHost(read)).error.code, 'E_REQUEST_DUPLICATE');
    assert.equal((await callPersistentHost(write)).error.code, 'E_REQUEST_DUPLICATE');
    const status = await callPersistentHost({ tokenFile: host.tokenFile, method: 'status', args: { requestId: 'unknown-read' } });
    assert.equal(status.result.request.status, 'unknown');
    assert.deepEqual(new Set(status.result.host.unknownRequests), new Set(['unknown-read', 'unknown-operation']));
    assert.equal(status.result.host.requestLedger.retained, 3);
    assert.equal(status.result.host.requestLedger.readOnlyRetained, 1);
    assert.equal(fx.calls.filter(call => call.method === 'uncertain-history').length, 1);
    assert.equal(fx.calls.filter(call => call.method === 'hang').length, 1);
  } finally { await fx.cleanup(host); }
});

test('method-name spoofing, different script names, and source changes never acquire the read lane', async () => {
  for (const scenario of ['wrong-path', 'wrong-name', 'changed-source']) {
    const fx = await fixture();
    let host;
    try {
      host = await fx.start(1000, { requestLedgerLimit: 3 });
      const name = scenario === 'wrong-name' ? 'probe' : 'readnative_live5';
      const path = scenario === 'wrong-path' ? 'agents/probe.js' : 'wechat-adapters/4.1.15.13/read-agent.js';
      if (scenario === 'changed-source') await writeFile(resolve(fx.workspace, path), '// changed after the host pinned its trusted source');
      await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name, path } });
      const args = { name, method: 'account', params: [] };
      assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: 'account-1', args })).success, true, scenario);
      assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: 'account-2', args })).success, true, scenario);
      assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: 'account-3', args })).error.code, 'E_REQUEST_LIMIT', scenario);
      assert.deepEqual(host.status().requestLedger, { limit: 3, retained: 3, readOnlyLimit: 3, readOnlyRetained: 0, unknown: 0 });
      assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'status' })).success, true);
    } finally { await fx.cleanup(host); }
  }
});

test('prepare, rebind, image preparation and sends retain lifetime replay protection on trusted scripts', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start(1000, { requestLedgerLimit: 10 });
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'readnative_live5', path: 'wechat-adapters/4.1.15.13/read-agent.js' } });
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'sendnative_live5', path: 'wechat-adapters/4.1.15.13/send-agent.js' } });
    for (const [name, methods] of [['readnative_live5', ['prepare', 'rebind']], ['sendnative_live5', ['prepare', 'prepareImage', 'sendText', 'sendImage']]]) {
      for (const method of methods) {
        const request = { tokenFile: host.tokenFile, method: 'rpc', requestId: `${name}-${method}`, args: { name, method, params: [] } };
        assert.equal((await callPersistentHost(request)).success, true);
        assert.equal((await callPersistentHost(request)).error.code, 'E_REQUEST_DUPLICATE');
      }
    }
    assert.equal(host.status().requestLedger.retained, 8);
    assert.equal(host.status().requestLedger.readOnlyRetained, 0);
  } finally { await fx.cleanup(host); }
});

test('trusted reads stay serialized and show their in-flight ledger without leaking completed entries', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start(1000, { requestLedgerLimit: 3 });
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'readnative_live5', path: 'wechat-adapters/4.1.15.13/read-agent.js' } });
    const order = [];
    let started, release;
    const entered = new Promise(resolveStarted => { started = resolveStarted; });
    const gate = new Promise(resolveGate => { release = resolveGate; });
    let count = 0;
    fx.session.created[1].exports.account = async () => {
      const index = ++count;
      order.push(`begin-${index}`);
      if (index === 1) { started(); await gate; }
      order.push(`end-${index}`);
      return { read: true };
    };
    const request = { tokenFile: host.tokenFile, method: 'rpc', args: { name: 'readnative_live5', method: 'account', params: [] } };
    const first = callPersistentHost(request);
    await entered;
    assert.equal(host.status().requestLedger.readOnlyRetained, 1);
    const second = callPersistentHost(request);
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    assert.deepEqual(order, ['begin-1']);
    release();
    assert.equal((await first).success, true);
    assert.equal((await second).success, true);
    assert.deepEqual(order, ['begin-1', 'end-1', 'begin-2', 'end-2']);
    assert.equal(host.status().requestLedger.readOnlyRetained, 0);
  } finally { await fx.cleanup(host); }
});

test('a full uncertain-read ledger remains bounded and diagnosable without evicting unknown outcomes', async () => {
  const fx = await fixture();
  let host;
  try {
    host = await fx.start(1000, { requestLedgerLimit: 2 });
    await callPersistentHost({ tokenFile: host.tokenFile, method: 'load', args: { name: 'readnative_live5', path: 'wechat-adapters/4.1.15.13/read-agent.js' } });
    fx.session.created[1].exports.account = async () => { throw new Error('E_ACCOUNT_CHANGED'); };
    const args = { name: 'readnative_live5', method: 'account', params: [] };
    for (const requestId of ['uncertain-read-1', 'uncertain-read-2']) {
      assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId, args })).requestStatus, 'unknown');
    }
    assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: 'new-read', args })).error.code, 'E_REQUEST_LIMIT');
    const status = await callPersistentHost({ tokenFile: host.tokenFile, method: 'status', args: { requestId: 'uncertain-read-1' } });
    assert.equal(status.success, true);
    assert.equal(status.result.request.status, 'unknown');
    assert.equal(status.result.host.requestLedger.readOnlyRetained, 2);
    assert.deepEqual(status.result.host.unknownRequests, ['uncertain-read-1', 'uncertain-read-2']);
    assert.equal((await callPersistentHost({ tokenFile: host.tokenFile, method: 'rpc', requestId: 'uncertain-read-1', args })).error.code, 'E_REQUEST_DUPLICATE');
  } finally { await fx.cleanup(host); }
});
