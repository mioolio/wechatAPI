import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { requireNativeTarget, readNativeTarget, saveNativeTarget, configureNativeTarget } from '../src/native-target.mjs';
import { NativeSendAdapter } from '../src/native-send-adapter.mjs';
import { recipientAlias } from '../src/recipient-registry.mjs';

const generation = '10000000-0000-0000-0000-000000000001';
const self = 'wxid_synthetic_self', chatId = 'wxid_synthetic_target', name = '合成联系人 全名 😀';
const dllSha256 = 'a'.repeat(64);
const account = { pid: 1234, generation, version: '4.1.15.13', dllSha256, self, accountVerified: true, readScopeVerified: true, automaticMessagesSent: 0 };
const contacts = { pid: account.pid, generation, version: account.version, self, scope: 'loaded-contact-cache', complete: false, automaticMessagesSent: 0, users: [{ chatId, displayName: name, alias: recipientAlias(chatId) }, { chatId: 'room@chatroom', displayName: '合成群组' }, { chatId: 'gh_official', displayName: '合成公众号' }] };
const target = { schemaVersion: 2, chatId, displayName: name, self, sourcePid: account.pid, sourceGeneration: generation, version: account.version, dllSha256 };

test('local target has no default, excludes groups and services, and binds an explicit current account', () => {
  assert.deepEqual(requireNativeTarget(target), target);
  for (const value of [undefined, {}, { ...target, schemaVersion: 1 }, { ...target, extra: true }, { ...target, self: undefined }, { ...target, chatId: 'room@chatroom' }, { ...target, chatId: 'gh_official' }, { ...target, chatId: 'filehelper' }, { ...target, chatId: recipientAlias(chatId) }, { ...target, displayName: ' ' }, { ...target, displayName: '\ud800' }, { ...target, displayName: 'a\nb' }, { ...target, sourceGeneration: 'stale' }, { ...target, dllSha256: 'invalid' }]) assert.throws(() => requireNativeTarget(value), { code: 'E_NATIVE_TARGET' });
});

test('target storage rejects missing, oversized or malformed files and saves only validated fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wxcc-target-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'native-target.json');
  await assert.rejects(readNativeTarget(path), { code: 'E_NATIVE_TARGET' });
  for (const value of ['{broken', 'x'.repeat(16385), JSON.stringify({ ...target, password: 'synthetic-secret' })]) {
    await writeFile(path, value);
    await assert.rejects(readNativeTarget(path), { code: 'E_NATIVE_TARGET' });
  }
  await saveNativeTarget(path, target);
  assert.deepEqual(await readNativeTarget(path), target);
});

function configureFixture(changes = {}) {
  const saved = [];
  const registry = { read: async () => {}, resolve: value => value === recipientAlias(chatId) ? chatId : undefined };
  const deps = { registry, currentReadAccount: { ...account, ...changes.account }, currentContacts: { ...contacts, ...changes.contacts }, saveTargetImpl: async (path, value) => saved.push({ path, value }) };
  return { saved, deps };
}

test('configure resolves an exact registered alias and takes the full name from verified contacts only', async () => {
  for (const to of [chatId, recipientAlias(chatId)]) {
    const fx = configureFixture();
    const result = await configureNativeTarget({ to, targetFile: 'synthetic-only.json' }, fx.deps);
    assert.deepEqual(fx.saved, [{ path: 'synthetic-only.json', value: target }]);
    assert.equal(result.displayName, name);
    assert.equal(result.alias, recipientAlias(chatId));
    assert.equal(result.automaticMessagesSent, 0);
    assert.equal(result.requiresFreshSendBinding, true);
  }
});

test('configure does not resolve nicknames, stale aliases, missing contacts, groups or official users', async () => {
  for (const to of [name, 'wxid_missing_contact', recipientAlias('wxid_missing_contact'), 'room@chatroom', 'gh_official', 'filehelper']) {
    const fx = configureFixture();
    await assert.rejects(configureNativeTarget({ to }, fx.deps));
    assert.deepEqual(fx.saved, []);
  }
  const wrongName = configureFixture();
  await assert.rejects(configureNativeTarget({ to: chatId, displayName: '姓名不符' }, wrongName.deps), { code: 'E_CHAT_SCOPE' });
  assert.deepEqual(wrongName.saved, []);
  for (const flag of [{ isOfficial: true }, { isGroup: true }, { kind: 'official' }]) {
    const fx = configureFixture({ contacts: { users: [{ ...contacts.users[0], ...flag }] } });
    await assert.rejects(configureNativeTarget({ to: chatId }, fx.deps), { code: 'E_CHAT_SCOPE' });
    assert.deepEqual(fx.saved, []);
  }
});

test('configure validates all contact rows and rejects account, generation and PID changes without writing', async () => {
  for (const change of [
    { account: { accountVerified: false } }, { account: { readScopeVerified: 'true' } }, { account: { dllSha256: 'invalid' } },
    { contacts: { pid: 5678 } }, { contacts: { generation: '20000000-0000-0000-0000-000000000001' } }, { contacts: { self: 'wxid_other_self' } }, { contacts: { version: '4.1.15.12' } }, { contacts: { automaticMessagesSent: 1 } },
    { contacts: { users: [contacts.users[0], contacts.users[0]] } }, { contacts: { users: [contacts.users[0], { chatId: 'bad id', displayName: '合成名称' }] } }, { contacts: { users: [{ ...contacts.users[0], alias: recipientAlias('wxid_other') }] } },
  ]) {
    const fx = configureFixture(change);
    await assert.rejects(configureNativeTarget({ to: chatId }, fx.deps));
    assert.deepEqual(fx.saved, []);
  }
});

test('adapter configure uses only independent verified read methods and never opens a send host', async () => {
  const calls = [], configured = [];
  const readAdapter = {
    inspect: async () => { calls.push('inspect'); return account; },
    account: async () => { calls.push('account'); return { ...account, displayName: '合成本人' }; },
    ids: async args => { calls.push(['ids', args]); return contacts; },
  };
  const adapter = new NativeSendAdapter({ readAdapter, targetFile: 'synthetic-only.json', registry: {}, configureImpl: async (args, deps) => { configured.push({ args, deps }); return { configured: true, automaticMessagesSent: 0 }; }, readJsonImpl: async () => { throw Error('must not read send binding'); }, callImpl: async () => { throw Error('must not call send host'); } });
  assert.deepEqual(await adapter.configureTarget({ to: recipientAlias(chatId) }), { configured: true, automaticMessagesSent: 0 });
  assert.deepEqual(calls, ['inspect', 'account', ['ids', {}]]);
  assert.equal(configured[0].args.targetFile, 'synthetic-only.json');
  assert.equal(configured[0].deps.currentReadAccount.self, self);
  assert.equal(configured[0].deps.currentReadAccount.dllSha256, dllSha256);
});

test('adapter configure rejects a read account switch before saving', async () => {
  let saves = 0;
  const adapter = new NativeSendAdapter({ readAdapter: { inspect: async () => account, account: async () => ({ ...account, self: 'wxid_other_self' }), ids: async () => contacts }, configureImpl: async () => saves++ });
  await assert.rejects(adapter.configureTarget({ to: chatId }), { code: 'E_NATIVE_TARGET_SCOPE' });
  assert.equal(saves, 0);
});

const agentSource = await readFile(new URL('../agents/send-native.js', import.meta.url), 'utf8');
const verifiedAgentHash = '10f8e995453e2da46d4f2b5080cd6da1f13cc5147746adc119ceae38cb039de5';
async function mockedAgent({ queueImpl = callback => Promise.resolve(callback(() => false)), lookupSelf = self } = {}) {
  const lookups = [], nativeCalls = [];
  const context = vm.createContext({ rpc: {}, Process: { id: 1234, getCurrentThreadId: () => 5678 }, queueImpl, lookupImpl: (id, displayName) => { lookups.push({ id, displayName }); return { chatId: id, displayName, displayNameMatches: true, remarkMatches: true, nicknameMatches: false, account: 'synthetic-account', self: lookupSelf }; }, mockNativeSend: (input, entry) => { nativeCalls.push(input); return Promise.resolve({ requestId: input.requestId, status: 'accepted', native: true, chatId: input.to }); } });
  vm.runInContext(agentSource, context);
  vm.runInContext(`queue=queueImpl;lookup=lookupImpl;nativeSend=mockNativeSend;currentTask=()=>({readPointer:()=>({add:()=>({readU32:()=>1})})});release=()=>{};inspect=()=>({pid:Process.id,generation:binding?.generation??null,self:binding?.self??null,chatId:binding?.chatId??null,displayName:binding?.displayName??null,ready:binding!==null,sendValidated});`, context);
  return { context, lookups, nativeCalls };
}
const agentConfig = { pid: 1234, generation, self, chatId, sessionId: chatId, displayName: name, validatedBinarySha256: verifiedAgentHash };

test('native prepare proves an exact configured user under the expected self and locks that target', async () => {
  const fx = await mockedAgent();
  const runtime = await fx.context.rpc.exports.prepare(agentConfig);
  assert.equal(runtime.self, self);
  assert.equal(runtime.chatId, chatId);
  assert.deepEqual(fx.lookups, [{ id: chatId, displayName: name }]);
  await assert.rejects(fx.context.rpc.exports.prepare({ ...agentConfig, chatId: 'wxid_other' }), /E_ALREADY_BOUND/);
  assert.throws(() => vm.runInContext(`validateRequest({to:'wxid_other',text:'synthetic',requestId:'other'})`, fx.context), /E_CHAT_SCOPE/);
  assert.deepEqual(fx.nativeCalls, []);
});

test('native prepare rejects the wrong current account even when ID and name match', async () => {
  const fx = await mockedAgent({ lookupSelf: 'wxid_other_self' });
  await assert.rejects(fx.context.rpc.exports.prepare(agentConfig), /E_TARGET_IDENTITY/);
  assert.deepEqual(fx.nativeCalls, []);
});

test('native send rejects an account switch on the same account pointer before entering business send', async () => {
  const fx = await mockedAgent();
  await fx.context.rpc.exports.prepare(agentConfig);
  fx.context.lookup = () => ({ chatId, displayName: name, displayNameMatches: true, account: 'synthetic-account', self: 'wxid_other_self' });
  const result = await fx.context.rpc.exports.sendText({ to: chatId, text: 'synthetic-only', requestId: 'account-switch-test' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(fx.nativeCalls, []);
});

test('native binary validation cannot be inferred from a configured target', async () => {
  const fx = await mockedAgent();
  await fx.context.rpc.exports.prepare({ ...agentConfig, validatedBinarySha256: 'b'.repeat(64) });
  await assert.rejects(fx.context.rpc.exports.sendText({ to: chatId, text: 'synthetic-only', requestId: 'binary-unverified-test' }), /E_SEND_BINARY_UNVERIFIED/);
  assert.deepEqual(fx.nativeCalls, []);
});

test('concurrent native preparations cannot race to replace the first target', async () => {
  let complete;
  const fx = await mockedAgent({ queueImpl: callback => new Promise(resolve => { complete = () => resolve(callback(() => false)); }) });
  const first = fx.context.rpc.exports.prepare(agentConfig);
  await assert.rejects(fx.context.rpc.exports.prepare({ ...agentConfig, chatId: 'wxid_other', sessionId: 'wxid_other' }), /E_ALREADY_BOUND/);
  complete();
  assert.equal((await first).chatId, chatId);
  assert.deepEqual(fx.nativeCalls, []);
});
