import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootstrapNativeRead } from '../src/native-read-bootstrap.mjs';
import { NATIVE_READ_SCRIPT, LEGACY_NATIVE_READ_SCRIPTS } from '../src/native-read-adapter.mjs';
import { parseCli as parseHostArgs } from '../src/native-runtime-host.mjs';

const generation = '10000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(64);
const self = 'fixture_self';
const source = '// Fake read agent used only by mock RPC tests.\n';
const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');

function fixture(changes = {}) {
  const calls = [], reads = [], sourceReads = [];
  const descriptor = { host: '127.0.0.1', port: 5001, token: 'b'.repeat(64), pid: 1234, generation, version: '4.1.15.13', dllSha256: sha, ...changes.descriptor };
  const host = { pid: 1234, generation, version: '4.1.15.13', dllSha256: sha, status: 'ready', attached: true, verified: true, scripts: [], ...changes.host };
  const profile = { version: '4.1.15.13', architecture: 'x64', dllSha256: sha, ...changes.profile };
  let runtime = { pid: 1234, generation: null, self: null, bindingRevision: 1, version: '4.1.15.13', dllSha256: sha, ready: false, accountVerified: false, readScopeVerified: false, automaticMessagesSent: 0, historyAvailable: false, pendingTasks: 0, pendingCallbacks: 0, ...changes.runtime };
  const account = { pid: 1234, generation, bindingRevision: 1, source: 'reverse-native', scope: 'current-account', self, displayName: 'Fixture Account', accountVerified: true, automaticMessagesSent: 0, ...changes.account };
  const contacts = { pid: 1234, generation, bindingRevision: 1, self, scope: 'loaded-contact-cache', complete: false, cacheSnapshotComplete: true, count: 1, contacts: [{ username: 'fixture_contact', displayName: 'Fixture Contact' }], automaticMessagesSent: 0, ...changes.contacts };
  const history = { pid: 1234, generation, bindingRevision: 1, self, chatId: self, source: 'reverse-native', messages: [{ serverId: '18446744073709551615', type: '1', createTime: '1790908800', content: 'Mock self history', senderUsername: self }], schemaValidated: true, automaticMessagesSent: 0, ...changes.history };
  const options = { workspace: 'C:/mock-workspace', tokenFile: 'read-host.json', profileFile: 'profile.json' };
  const dependencies = {
    readJsonImpl: async path => { reads.push(path); return path === options.tokenFile ? descriptor : profile; },
    readSourceImpl: async path => { sourceReads.push(path); return changes.source ?? source; },
    callImpl: async request => {
      calls.push(request);
      if (changes.call) return changes.call(request, { host, runtime, account, contacts, history });
      if (request.method === 'status') return { success: true, result: host };
      if (request.method === 'load') return { success: true, result: { name: NATIVE_READ_SCRIPT, path: 'C:/mock-workspace/agents/read-native.js', loaded: true, sourceSha256, ...changes.loaded } };
      assert.equal(request.method, 'rpc');
      if (request.args.name === LEGACY_NATIVE_READ_SCRIPTS[0].name) return { success: true, result: { ...runtime, generation, ...changes.legacyRuntime } };
      assert.equal(request.args.name, NATIVE_READ_SCRIPT);
      switch (request.args.method) {
        case 'inspect': return { success: true, result: runtime };
        case 'prepare': runtime = { ...runtime, ...request.args.params[0], self, ready: true, accountVerified: true, readScopeVerified: true, ...changes.prepared }; return { success: true, result: runtime };
        case 'account':
          if (changes.accountError) { const problem = changes.accountError; changes.accountError = null; return { success: false, error: problem }; }
          return { success: true, result: account };
        case 'rebind': runtime = { ...runtime, self, bindingRevision: account.bindingRevision, historyAvailable: false, contactSnapshotAvailable: false, ...changes.rebound }; return { success: true, result: runtime };
        case 'contacts': return { success: true, result: contacts };
        case 'history':
          if (changes.historyError) throw Object.assign(new Error('Mock read query failed.'), { code: 'E_READ_RANGE' });
          runtime = { ...runtime, historyAvailable: true, ...changes.final };
          return { success: true, result: history };
        default: throw new Error('Unexpected mock RPC method.');
      }
    },
  };
  return { options, dependencies, calls, reads, sourceReads, descriptor, host, profile };
}

const operations = calls => calls.map(row => [row.method, row.args?.method]);
const queried = calls => calls.some(row => row.args?.method === 'history');

test('read bootstrap loads the exact source, binds metadata and verifies one self-history query', async () => {
  const fx = fixture();
  const result = await bootstrapNativeRead(fx.options, fx.dependencies);
  assert.equal(result.prepared, true);
  assert.equal(result.ready, true);
  assert.equal(result.historyAvailable, true);
  assert.equal(result.self, self);
  assert.equal(result.contactCount, 1);
  assert.equal(result.agentSourceSha256, sourceSha256);
  assert.equal(result.automaticMessagesSent, 0);
  assert.deepEqual(result.historyValidation, { to: self, limit: 1 });
  assert.deepEqual(operations(fx.calls), [['status', undefined], ['load', undefined], ['rpc', 'inspect'], ['rpc', 'prepare'], ['rpc', 'account'], ['rpc', 'contacts'], ['rpc', 'history'], ['rpc', 'inspect']]);
  assert.deepEqual(fx.calls[1].args, { name: NATIVE_READ_SCRIPT, path: 'agents/read-native.js' });
  assert.deepEqual(fx.calls[3].args.params, [{ pid: 1234, generation, dllSha256: sha }]);
  assert.deepEqual(fx.calls[6].args.params, [{ to: self, limit: 1 }]);
  assert.match(fx.sourceReads[0], /[\\/]agents[\\/]read-native\.js$/);
  assert.equal(fx.calls.some(row => ['attach', 'detach', 'unload', 'sendText'].includes(row.args?.method ?? row.method)), false);
});

test('a matching prepared script is reused without replacement and still verifies real read RPCs', async () => {
  const fx = fixture({ host: { scripts: [{ name: NATIVE_READ_SCRIPT, loaded: true, destroyed: false, sourceSha256 }] }, runtime: { generation, self, ready: true, accountVerified: true, readScopeVerified: true, historyAvailable: true } });
  const result = await bootstrapNativeRead(fx.options, fx.dependencies);
  assert.equal(result.historyAvailable, true);
  assert.deepEqual(operations(fx.calls), [['status', undefined], ['rpc', 'inspect'], ['rpc', 'account'], ['rpc', 'contacts'], ['rpc', 'history'], ['rpc', 'inspect']]);
});

test('a known legacy read agent is checked idle and kept loaded while the new name is prepared', async () => {
  const legacy = { ...LEGACY_NATIVE_READ_SCRIPTS[0], loaded: true, destroyed: false };
  const fx = fixture({ host: { scripts: [legacy] } });
  assert.equal((await bootstrapNativeRead(fx.options, fx.dependencies)).ready, true);
  assert.deepEqual(fx.calls.slice(0, 3).map(row => [row.method, row.args.name, row.args.method]), [['status', undefined, undefined], ['rpc', legacy.name, 'inspect'], ['load', NATIVE_READ_SCRIPT, undefined]]);
  assert.equal(fx.calls.some(row => ['unload', 'detach', 'stop'].includes(row.method)), false);
});

test('unknown, changed or busy legacy agents prevent loading another agent', async () => {
  const legacy = { ...LEGACY_NATIVE_READ_SCRIPTS[0], loaded: true, destroyed: false };
  for (const changes of [
    { host: { scripts: [{ ...legacy, sourceSha256: 'c'.repeat(64) }] } },
    { host: { scripts: [{ ...legacy, name: 'readnative_live2' }] } },
    { host: { scripts: [legacy] }, legacyRuntime: { pendingTasks: 1 } },
    { host: { scripts: [legacy] }, legacyRuntime: { runtimeBlocked: true } },
  ]) {
    const fx = fixture(changes);
    await assert.rejects(bootstrapNativeRead(fx.options, fx.dependencies));
    assert.equal(fx.calls.some(row => row.method === 'load'), false);
  }
});

test('only explicit start recovery rebinds one changed account and proves the new contact/history scope', async () => {
  for (const accountError of [{ code: 'E_ACCOUNT_CHANGED', message: 'E_ACCOUNT_CHANGED' }, { code: 'E_OPERATION', message: 'E_ACCOUNT_CHANGED' }]) {
    const fx = fixture({ runtime: { generation, self: 'fixture_old_self', ready: true, accountVerified: true, readScopeVerified: true, historyAvailable: true }, accountError, account: { bindingRevision: 2 }, contacts: { bindingRevision: 2 }, history: { bindingRevision: 2 } });
    const result = await bootstrapNativeRead({ ...fx.options, rebindAccount: true }, fx.dependencies);
    assert.equal(result.bindingRevision, 2);
    const recovery = fx.calls.filter(row => row.args?.method === 'rebind');
    assert.equal(recovery.length, 1);
    assert.deepEqual(recovery[0].args.params, [{ pid: 1234, generation, dllSha256: sha, expectedSelf: 'fixture_old_self', expectedBindingRevision: 1 }]);
    assert.equal(fx.calls.filter(row => row.args?.method === 'history').length, 1);
  }
});

test('ordinary bootstrap and unrelated failures never silently rebind an account', async () => {
  for (const [rebindAccount, accountError] of [[false, { code: 'E_ACCOUNT_CHANGED', message: 'E_ACCOUNT_CHANGED' }], [true, { code: 'E_OPERATION', message: 'E_ACCOUNT_CHANGED: unknown native outcome' }], [true, { code: 'E_TIMEOUT_UNKNOWN', message: 'Mock timeout' }]]) {
    const fx = fixture({ accountError });
    await assert.rejects(bootstrapNativeRead({ ...fx.options, rebindAccount }, fx.dependencies));
    assert.equal(fx.calls.some(row => row.args?.method === 'rebind'), false);
  }
});

test('recovery with uncleared old capabilities fails before contacts or history', async () => {
  const fx = fixture({ runtime: { generation, self, ready: true, accountVerified: true, readScopeVerified: true }, accountError: { code: 'E_ACCOUNT_CHANGED', message: 'E_ACCOUNT_CHANGED' }, rebound: { historyAvailable: true } });
  await assert.rejects(bootstrapNativeRead({ ...fx.options, rebindAccount: true }, fx.dependencies), { code: 'E_NATIVE_READ_SCOPE' });
  assert.equal(fx.calls.some(row => row.args?.method === 'contacts' || row.args?.method === 'history'), false);
});

test('stale identity or different profile fails before loading any agent', async () => {
  for (const changes of [
    { descriptor: { host: 'remote.example' } }, { descriptor: { pid: 9999 } }, { descriptor: { generation: '10000000-0000-4000-8000-000000000002' } },
    { descriptor: { port: 0 } }, { descriptor: { token: 'bad' } }, { descriptor: { version: '4.1.10.27' } }, { descriptor: { dllSha256: 'c'.repeat(64) } },
    { host: { attached: false } }, { host: { verified: 1 } }, { host: { status: 'attached-error' } },
    { profile: { dllSha256: 'c'.repeat(64) } }, { profile: { version: '4.1.10.27' } }, { profile: { architecture: 'arm64' } },
  ]) {
    const fx = fixture(changes);
    await assert.rejects(bootstrapNativeRead(fx.options, fx.dependencies));
    assert.deepEqual(operations(fx.calls), [['status', undefined]]);
  }
});

test('an existing broken or changed script is never unloaded, covered or called', async () => {
  for (const existing of [
    { name: NATIVE_READ_SCRIPT, loaded: false, destroyed: false, sourceSha256 },
    { name: NATIVE_READ_SCRIPT, loaded: true, destroyed: true, sourceSha256 },
    { name: NATIVE_READ_SCRIPT, loaded: true, destroyed: false, sourceSha256: 'c'.repeat(64) },
    { name: NATIVE_READ_SCRIPT, loaded: true, destroyed: false },
  ]) {
    const fx = fixture({ host: { scripts: [existing] } });
    await assert.rejects(bootstrapNativeRead(fx.options, fx.dependencies));
    assert.deepEqual(operations(fx.calls), [['status', undefined]]);
  }
});

test('fresh loaded source metadata must match the local file before any RPC', async () => {
  for (const loaded of [{ sourceSha256: 'c'.repeat(64) }, { sourceSha256: undefined }, { name: 'other_read_agent' }, { loaded: false }]) {
    const fx = fixture({ loaded });
    await assert.rejects(bootstrapNativeRead(fx.options, fx.dependencies), { code: 'E_NATIVE_READ_SOURCE' });
    assert.deepEqual(operations(fx.calls), [['status', undefined], ['load', undefined]]);
  }
});

test('unprepared or prepared metadata must strictly verify the read identity and idle state', async () => {
  for (const changes of [
    { runtime: { pid: 9999 } }, { runtime: { version: '4.1.10.27' } }, { runtime: { dllSha256: 'c'.repeat(64) } },
    { runtime: { automaticMessagesSent: '0' } }, { runtime: { pendingTasks: 1 } }, { runtime: { pendingCallbacks: 1 } },
    { runtime: { generation: '10000000-0000-4000-8000-000000000002', ready: true } },
    { prepared: { ready: false } }, { prepared: { readScopeVerified: 1 } }, { prepared: { accountVerified: false } }, { prepared: { bindingRevision: undefined } }, { prepared: { bindingRevision: 0 } },
    { prepared: { self: '10001@chatroom' } }, { prepared: { self: 'gh_fixture' } }, { prepared: { pid: 9999 } },
  ]) {
    const fx = fixture(changes);
    await assert.rejects(bootstrapNativeRead(fx.options, fx.dependencies), { code: 'E_NATIVE_READ_SCOPE' });
    assert.equal(fx.calls.some(row => row.args?.method === 'account'), false);
  }
});

test('invalid account or contacts results cannot start history verification', async () => {
  for (const changes of [
    { account: { self: 'other_fixture' } }, { account: { scope: 'all-accounts' } }, { account: { accountVerified: false } }, { account: { automaticMessagesSent: 1 } },
    { contacts: { count: '1' } }, { contacts: { complete: true } }, { contacts: { self: 'other_fixture' } }, { contacts: { automaticMessagesSent: 1 } },
    { contacts: { contacts: [{ username: 'invalid id', displayName: 'Fixture Contact' }] } },
  ]) {
    const fx = fixture(changes);
    await assert.rejects(bootstrapNativeRead(fx.options, fx.dependencies));
    assert.equal(queried(fx.calls), false);
  }
});

test('history errors, wrong envelopes or invalid DTOs never manufacture verified capability', async () => {
  for (const changes of [
    { historyError: true }, { history: { chatId: 'fixture_contact' } }, { history: { schemaValidated: false } },
    { history: { automaticMessagesSent: 1 } }, { history: { self: 'other_fixture' } },
    { history: { messages: [{ serverId: 9007199254740992, type: '1', createTime: '1790908800', content: 'fixture', senderUsername: self }] } },
    { history: { messages: [{ serverId: '1', type: 'text', createTime: '1790908800', content: 'fixture', senderUsername: self }] } },
    { history: { messages: [{ serverId: '1', type: '1', subType: '-1', createTime: '1790908800', content: 'fixture', senderUsername: self }] } },
    { history: { messages: [{ serverId: '1', type: '1', createTime: '9007199254741', content: 'fixture', senderUsername: self }] } },
  ]) {
    const fx = fixture(changes);
    await assert.rejects(bootstrapNativeRead(fx.options, fx.dependencies));
    assert.equal(queried(fx.calls), true);
    assert.equal(fx.calls.some(row => ['unload', 'detach', 'sendText'].includes(row.args?.method ?? row.method)), false);
  }
});

test('the final agent state must confirm actual history proof, exact account and no outstanding work', async () => {
  for (const final of [{ historyAvailable: false }, { historyAvailable: 1 }, { self: 'other_fixture' }, { generation: '10000000-0000-4000-8000-000000000002' }, { pendingCallbacks: 1 }, { ready: false }]) {
    const fx = fixture({ final });
    await assert.rejects(bootstrapNativeRead(fx.options, fx.dependencies));
    assert.deepEqual(operations(fx.calls).at(-1), ['rpc', 'inspect']);
  }
});

test('an empty verified self history still proves the completed ABI without fabricating messages', async () => {
  const fx = fixture({ history: { messages: [] } });
  assert.equal((await bootstrapNativeRead(fx.options, fx.dependencies)).historyAvailable, true);
});

test('host failures are not retried or followed by script cleanup', async () => {
  const fx = fixture({ call: async () => ({ success: false, error: { code: 'E_TIMEOUT_UNKNOWN', message: 'Mock timeout.' } }) });
  await assert.rejects(bootstrapNativeRead(fx.options, fx.dependencies), { code: 'E_TIMEOUT_UNKNOWN' });
  assert.equal(fx.calls.length, 1);
});

test('host parser separates read/send defaults and preserves explicit descriptor paths', () => {
  const ordinary = parseHostArgs(['--pid', '1234']);
  assert.equal(ordinary.read, false); assert.equal(ordinary.send, false); assert.equal(ordinary.tokenFile, undefined);
  const read = parseHostArgs(['--pid', '1234', '--read']);
  assert.equal(read.read, true); assert.equal(read.send, false); assert.match(read.tokenFile, /[\\/]data[\\/]native-read-host\.json$/);
  const send = parseHostArgs(['--send', '--pid', '1234']);
  assert.equal(send.send, true); assert.equal(send.read, false); assert.equal(send.tokenFile, undefined);
  const explicit = parseHostArgs(['--read', '--token-file', 'C:\\fake\\read-host.json', '--pid', '1234']);
  assert.equal(explicit.tokenFile, 'C:\\fake\\read-host.json');
  assert.throws(() => parseHostArgs(['--pid', '1234', '--read', '--send']), { code: 'E_ARGUMENT' });
  assert.throws(() => parseHostArgs(['--pid', '1234', '--read', '--token-file']), { code: 'E_ARGUMENT' });
  assert.throws(() => parseHostArgs(['--pid', '1234', '--token-file', '--read']), { code: 'E_ARGUMENT' });
});
