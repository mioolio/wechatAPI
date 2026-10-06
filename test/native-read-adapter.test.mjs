import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeReadAdapter, NATIVE_READ_SCRIPT } from '../src/native-read-adapter.mjs';
import { NativeSendAdapter } from '../src/native-send-adapter.mjs';
import { recipientAlias } from '../src/recipient-registry.mjs';

const generation = '10000000-0000-4000-8000-000000000001';
const nextGeneration = '10000000-0000-4000-8000-000000000002';
const self = 'fixture_self';
const chatId = 'fixture_contact_1';
const dllSha256 = 'a'.repeat(64);

function registryFixture(initial = []) {
  const records = new Map(initial.map(row => [recipientAlias(row.id), row]));
  const registered = [];
  return {
    records, registered,
    async read() {},
    async register(row) { registered.push(row); records.set(recipientAlias(row.id), row); return { alias: recipientAlias(row.id), displayName: row.displayName }; },
    resolve(alias) { const record = records.get(alias); if (!record) throw Object.assign(new Error('Unknown alias.'), { code: 'E_RECIPIENT_UNKNOWN' }); return record.id; },
    list() { return [...records.values()]; },
  };
}

function fixture(changes = {}) {
  const calls = [], descriptorReads = [];
  const registry = changes.registry ?? registryFixture();
  const descriptor = { host: '127.0.0.1', port: 5001, token: 'b'.repeat(64), pid: 1234, generation, version: '4.1.15.13', dllSha256, ...changes.descriptor };
  const host = { status: 'ready', pid: 1234, generation, version: '4.1.15.13', dllSha256, verified: true, attached: true, ...changes.host };
  const runtime = { pid: 1234, generation, version: '4.1.15.13', dllSha256, self, ready: true, accountVerified: true, readScopeVerified: true, historyAvailable: true, automaticMessagesSent: 0, ...changes.runtime };
  const account = { pid: 1234, generation, source: 'reverse-native', scope: 'current-account', self, displayName: 'Fixture Account 👩‍💻', accountVerified: true, automaticMessagesSent: 0, ...changes.account };
  const contacts = { pid: 1234, generation, self, scope: 'loaded-contact-cache', complete: false, cacheSnapshotComplete: true, contacts: [{ username: chatId, displayName: 'Fixture Contact' }], count: 1, automaticMessagesSent: 0, ...changes.contacts };
  const history = { pid: 1234, generation, self, chatId, source: 'reverse-native', schemaValidated: true, automaticMessagesSent: 0, messages: [{ serverId: '18446744073709551615', type: '1', createTime: '1790908800', content: 'mock-only', senderUsername: chatId }], ...changes.history };
  const adapter = new NativeReadAdapter({ tokenFile: 'read-host.json', registry,
    readJsonImpl: async path => { descriptorReads.push(path); return descriptor; },
    callImpl: async request => {
      calls.push(request);
      if (changes.call) return changes.call(request, { descriptor, host, runtime, account, contacts, history });
      if (request.method === 'status') return { success: true, result: host };
      assert.equal(request.method, 'rpc');
      assert.equal(request.args.name, NATIVE_READ_SCRIPT);
      return { success: true, result: { inspect: runtime, account, contacts, history }[request.args.method] };
    },
  });
  return { adapter, calls, descriptorReads, registry, descriptor, host, runtime, account, contacts, history };
}

const rpcMethods = calls => calls.filter(row => row.method === 'rpc').map(row => row.args.method);

test('an unchanged verified recipient mapping can read history without rewriting the registry', async () => {
  const registry = registryFixture([{ id: chatId, alias: recipientAlias(chatId), displayName: 'Fixture Contact' }]);
  const fx = fixture({ registry });
  const result = await fx.adapter.history({ to: recipientAlias(chatId), limit: 1 });
  assert.equal(result.messages.length, 1);
  assert.deepEqual(registry.registered, []);
  assert.deepEqual(rpcMethods(fx.calls), ['inspect', 'contacts', 'history']);
});

test('read adapter reuses the loaded host, verifies metadata and registers current self', async () => {
  const fx = fixture();
  const result = await fx.adapter.account();
  assert.equal(result.self, self);
  assert.equal(result.displayName, 'Fixture Account 👩‍💻');
  assert.equal(result.alias, recipientAlias(self));
  assert.equal(result.automaticMessagesSent, 0);
  assert.deepEqual(fx.registry.registered, [{ id: self, displayName: result.displayName }]);
  assert.deepEqual(fx.calls.map(row => [row.tokenFile, row.method, row.args.method]), [['read-host.json', 'status', undefined], ['read-host.json', 'rpc', 'inspect'], ['read-host.json', 'rpc', 'account']]);
  await fx.adapter.close();
  assert.equal(fx.calls.length, 3);
});

test('accounts returns only the verified current account and never claims all accounts', async () => {
  const fx = fixture();
  const result = await fx.adapter.accounts();
  assert.equal(result.scope, 'current-account');
  assert.equal(result.complete, false);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].self, self);
  assert.deepEqual(rpcMethods(fx.calls), ['inspect', 'account']);
});

test('descriptor, host and agent mismatches cannot reach data RPCs', async () => {
  for (const changes of [
    { descriptor: { host: 'remote.example' } }, { descriptor: { pid: '1234' } }, { descriptor: { generation: 'invalid' } },
    { descriptor: { port: 0 } }, { descriptor: { token: 'invalid' } }, { descriptor: { dllSha256: undefined } }, { descriptor: { version: undefined } },
    { host: { pid: 5678 } }, { host: { generation: nextGeneration } }, { host: { attached: false } }, { host: { verified: 1 } },
    { host: { status: 'detached' } }, { host: { version: '4.1.10.27' } }, { host: { dllSha256: 'c'.repeat(64) } },
    { runtime: { pid: 5678 } }, { runtime: { generation: nextGeneration } }, { runtime: { version: '4.1.10.27' } }, { runtime: { dllSha256: 'c'.repeat(64) } },
    { runtime: { ready: false } }, { runtime: { accountVerified: 1 } }, { runtime: { readScopeVerified: 'true' } },
    { runtime: { automaticMessagesSent: '0' } }, { runtime: { self: '10001@chatroom' } }, { runtime: { self: 123 } },
    { runtime: { pendingTasks: 1 } }, { runtime: { pendingCallbacks: 1 } },
  ]) {
    const fx = fixture(changes);
    await assert.rejects(fx.adapter.account());
    assert.equal(rpcMethods(fx.calls).some(method => method !== 'inspect'), false);
    assert.deepEqual(fx.registry.registered, []);
  }
});

test('account RPC identity, names and strict proof flags must be verified before registering', async () => {
  for (const account of [{ pid: 5678 }, { generation: nextGeneration }, { self: 'another_fixture' }, { scope: 'all-accounts' }, { source: 'cache' }, { accountVerified: 'true' }, { automaticMessagesSent: 1 }, { displayName: '\ud800' }, { displayName: 'a\0b' }]) {
    const fx = fixture({ account });
    await assert.rejects(fx.adapter.account(), { code: 'E_NATIVE_ACCOUNT_UNVERIFIED' });
    assert.deepEqual(fx.registry.registered, []);
  }
});

test('ids contains only validated cache rows, complete names, stable aliases and no send grant', async () => {
  const fx = fixture({ contacts: { contacts: [{ username: chatId, displayName: 'Fixture Contact 👩‍💻' }, { username: 'fixture_contact_2', displayName: 'Second Fixture' }], count: 2 } });
  const result = await fx.adapter.ids();
  assert.equal(result.scope, 'loaded-contact-cache');
  assert.equal(result.complete, false);
  assert.equal(result.users.length, 2);
  assert.equal(result.users.find(row => row.chatId === chatId).displayName, 'Fixture Contact 👩‍💻');
  assert.equal(result.users.every(row => row.canSend === false), true);
  assert.equal(result.users.some(row => row.chatId === self), false);
  assert.equal((await fx.adapter.ids({ keyword: recipientAlias(chatId) })).users[0].chatId, chatId);
  assert.equal(fx.calls.some(row => ['sendText', 'load', 'unload', 'detach'].includes(row.args.method ?? row.method)), false);
});

test('invalid last contact rejects the entire batch before registration', async () => {
  for (const contacts of [
    { contacts: [{ username: chatId, displayName: 'Fixture Contact' }, { username: 'bad id', displayName: 'Bad Fixture' }], count: 2 },
    { contacts: [{ username: chatId, displayName: 'Fixture Contact' }, { username: chatId, displayName: 'Duplicate' }], count: 2 },
    { self: 'other_fixture' }, { generation: nextGeneration }, { complete: true }, { count: '1' }, { automaticMessagesSent: 1 },
  ]) {
    const fx = fixture({ contacts });
    await assert.rejects(fx.adapter.ids(), { code: 'E_CONTACT_SNAPSHOT' });
    assert.deepEqual(fx.registry.registered, []);
  }
});

test('history resolves an exact current alias and preserves uint64 IDs and known or unknown direction', async () => {
  const fx = fixture({ history: { messages: [
    { serverId: '18446744073709551615', type: '1', createTime: '1790908800', content: 'incoming fixture', senderUsername: chatId, senderName: 'Fixture Contact', subType: '0' },
    { serverId: '18446744073709551614', type: '1', createTime: '1790908801', content: 'self fixture', senderUsername: self },
    { serverId: '18446744073709551613', type: '1', createTime: '1790908802', content: 'unknown fixture', senderUsername: '' },
  ] } });
  const result = await fx.adapter.history({ to: recipientAlias(chatId) });
  assert.deepEqual(fx.calls.at(-1), { tokenFile: 'read-host.json', method: 'rpc', args: { name: NATIVE_READ_SCRIPT, method: 'history', params: [{ to: chatId, limit: 30 }] } });
  assert.equal(result.messages[0].id, '18446744073709551615');
  assert.equal(result.messages[0].serverId, '18446744073709551615');
  assert.equal(result.messages[0].timestamp, 1790908800000);
  assert.equal(result.messages[0].isSelf, false);
  assert.equal(result.messages[1].isSelf, true);
  assert.equal(result.messages[2].isSelf, null);
  assert.equal(result.messages[2].senderId, null);
  assert.equal(result.messages[2].direction, 'unknown');
  assert.equal(Object.hasOwn(result.messages[0], 'localId'), false);
});

test('history refuses unverified capability, stale aliases, guessed names and invalid limits before native query', async () => {
  const unavailable = fixture({ runtime: { historyAvailable: false } });
  await assert.rejects(unavailable.adapter.history({ to: recipientAlias(chatId) }), { code: 'E_NATIVE_HISTORY_UNVERIFIED' });
  assert.deepEqual(rpcMethods(unavailable.calls), ['inspect']);
  for (const to of [recipientAlias('old_fixture_contact'), 'FixtureContact', recipientAlias(chatId).toUpperCase()]) {
    const fx = fixture({ registry: registryFixture([{ id: 'old_fixture_contact', displayName: 'Old Fixture' }]) });
    await assert.rejects(fx.adapter.history({ to }));
    assert.equal(rpcMethods(fx.calls).includes('history'), false);
  }
  for (const args of [{ to: 123 }, {}, { to: chatId, limit: 0 }, { to: chatId, limit: 201 }, { to: chatId, limit: '30' }, { to: chatId, limit: 1.5 }]) {
    const fx = fixture();
    await assert.rejects(fx.adapter.history(args));
    assert.deepEqual(fx.calls, []);
  }
});

test('history result rejects stale identity, wrong scope and unsafe numeric message fields', async () => {
  for (const history of [
    { pid: 5678 }, { generation: nextGeneration }, { self: 'other_fixture' }, { chatId: 'other_contact' },
    { source: 'cache' }, { schemaValidated: 'true' }, { automaticMessagesSent: 1 },
    ...[{ serverId: 18446744073709551615 }, { serverId: '18446744073709551616' }, { createTime: '9007199254741' }, { createTime: 1790908800 }, { senderUsername: null }, { senderUsername: 'invalid id' }, { content: '\ud800' }, { type: '' }].map(row => ({ messages: [{ serverId: '1', type: '1', createTime: '1790908800', content: 'fixture', senderUsername: chatId, ...row }] })),
    { messages: Array(31).fill({ serverId: '1', type: '1', createTime: '1790908800', content: 'fixture', senderUsername: chatId }) },
  ]) {
    const fx = fixture({ history });
    await assert.rejects(fx.adapter.history({ to: chatId }), { code: 'E_NATIVE_HISTORY_SCHEMA' });
    assert.equal(rpcMethods(fx.calls).filter(method => method === 'history').length, 1);
  }
});

test('self alias history uses the independently verified account without requiring a contacts cache row', async () => {
  const fx = fixture({ registry: registryFixture([{ id: self, displayName: 'Fixture Account' }]), history: { chatId: self, messages: [] } });
  const result = await fx.adapter.history({ to: recipientAlias(self), limit: 5 });
  assert.equal(result.chatId, self);
  assert.deepEqual(rpcMethods(fx.calls), ['inspect', 'history']);
  assert.deepEqual(fx.calls.at(-1).args.params, [{ to: self, limit: 5 }]);
});

test('zero server IDs are preserved for distinct unreported records without guessed local IDs', async () => {
  const fx = fixture({ history: { messages: [
    { serverId: '0', type: '3', createTime: '1790908800', content: 'media fixture one', senderUsername: self },
    { serverId: '0', type: '3', createTime: '1790908800', content: 'media fixture two', senderUsername: self },
  ] } });
  const result = await fx.adapter.history({ to: chatId });
  assert.deepEqual(result.messages.map(row => row.serverId), ['0', '0']);
  assert.deepEqual(result.messages.map(row => row.text), ['media fixture one', 'media fixture two']);
  assert.equal(result.messages.some(row => Object.hasOwn(row, 'localId')), false);
});

test('contact cache is scoped to the verified runtime and is invalidated on generation change', async () => {
  const fx = fixture();
  await fx.adapter.history({ to: recipientAlias(chatId) });
  await fx.adapter.history({ to: recipientAlias(chatId) });
  assert.equal(rpcMethods(fx.calls).filter(method => method === 'contacts').length, 1);
  for (const value of [fx.descriptor, fx.host, fx.runtime, fx.contacts, fx.history]) value.generation = nextGeneration;
  fx.contacts.contacts = [];
  fx.contacts.count = 0;
  await assert.rejects(fx.adapter.history({ to: recipientAlias(chatId) }), { code: 'E_CHAT_SCOPE' });
  assert.equal(rpcMethods(fx.calls).filter(method => method === 'contacts').length, 2);
  assert.equal(rpcMethods(fx.calls).filter(method => method === 'history').length, 2);
});

test('host failure is returned once with no automatic load, attach or retry', async () => {
  const fx = fixture({ call: async () => ({ success: false, error: { code: 'E_NATIVE_READ_TIMEOUT', message: 'Mock timeout.' } }) });
  await assert.rejects(fx.adapter.account(), { code: 'E_NATIVE_READ_TIMEOUT' });
  assert.equal(fx.calls.length, 1);
});

test('send adapter defaults each host separately and explicit tokenFile overrides the read host', () => {
  const defaults = new NativeSendAdapter();
  assert.match(defaults.tokenFile, /[\\/]data[\\/]research-host\.json$/);
  assert.match(defaults.readAdapter.tokenFile, /[\\/]data[\\/]native-read-host\.json$/);
  assert.equal(new NativeSendAdapter({ readTokenFile: 'read-only-host.json' }).readAdapter.tokenFile, 'read-only-host.json');
  const explicit = new NativeSendAdapter({ tokenFile: 'explicit-host.json', readTokenFile: 'ignored.json' });
  assert.equal(explicit.tokenFile, 'explicit-host.json');
  assert.equal(explicit.readAdapter.tokenFile, 'explicit-host.json');
});

test('send adapter delegates account/accounts/history without accessing send binding', async () => {
  const calls = [];
  const readAdapter = Object.fromEntries(['account', 'accounts', 'history'].map(method => [method, async args => { calls.push([method, args]); return { source: 'reverse-native', method }; }]));
  const adapter = new NativeSendAdapter({ readAdapter, readJsonImpl: async () => { throw new Error('must not read send binding'); }, callImpl: async () => { throw new Error('must not call send host'); } });
  await adapter.account(); await adapter.accounts(); await adapter.history({ to: recipientAlias(chatId), limit: 30 });
  assert.deepEqual(calls, [['account', {}], ['accounts', {}], ['history', { to: recipientAlias(chatId), limit: 30 }]]);
  await adapter.close();
});

test('combined inspect reports read and send availability independently', async () => {
  const fx = fixture();
  const adapter = new NativeSendAdapter({ readAdapter: fx.adapter, readJsonImpl: async () => { throw Object.assign(new Error('No send binding.'), { code: 'E_NATIVE_BINDING' }); } });
  const result = await adapter.doctor();
  assert.equal(result.ready, true);
  assert.equal(result.accountVerified, true);
  assert.equal(result.historyAvailable, true);
  assert.equal(result.sendAvailable, false);
  assert.equal(result.sendValidated, false);
  assert.equal(result.read.ready, true);
  assert.equal(result.send.ready, false);
  assert.equal(result.send.error.code, 'E_NATIVE_TARGET');
});
