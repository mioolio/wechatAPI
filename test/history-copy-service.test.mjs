import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHistoryCopyService } from '../src/history-copy-service.mjs';
import { recipientAlias } from '../src/recipient-registry.mjs';
import { createService } from '../src/service.mjs';

const self = 'wxid_ownerfixture001';
const chat = 'wxid_friendfixture002';
const alias = recipientAlias(chat);
const copyId = `c_${'1'.repeat(32)}`;
const recordId = `m_${'2'.repeat(16)}`;
const message = { id: '18446744073709551615', chatId: chat, senderId: null, isSelf: null, type: '1', text: 'original fixture', timestamp: 1000, source: 'reverse-native' };
function registry() {
  return { async read() {}, list: () => [{ id: chat, alias, displayName: '测试联系人' }], resolve: value => { assert.equal(value, alias); return chat; } };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxcc-record-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('native import stores unredacted verified history with unknown sender and exact uint64 IDs', async () => {
  let captured, queries = 0;
  const service = createHistoryCopyService({ backend: 'reverse-native' }, {
    registry: registry(),
    readHistory: async args => { queries++; assert.deepEqual(args, { to: alias, limit: 30 }); return { self, chatId: chat, source: 'reverse-native', messages: [message] }; },
    store: { create: async args => { captured = args; return { copyId, localOnly: true }; } },
  });
  assert.deepEqual(await service.execute({ action: 'import', to: alias }), { copyId, localOnly: true });
  assert.equal(queries, 1);
  assert.equal(captured.accountId, self);
  assert.equal(captured.chatId, chat);
  assert.equal(captured.displayName, '测试联系人');
  assert.equal(captured.messages[0].id, message.id);
  assert.equal(captured.messages[0].senderId, null);
  assert.equal(captured.messages[0].text, message.text);
  assert.equal(message.chatId, chat);
});

test('offline import infers one full chat, binds explicit self and never reads the client', async t => {
  const root = await temporary(t), input = path.join(root, 'history.json');
  await fs.writeFile(input, JSON.stringify({ self, messages: [message] }));
  let captured;
  const service = createHistoryCopyService({ backend: 'reverse-native', self }, {
    registry: registry(), readHistory: () => { throw new Error('offline import touched client'); },
    store: { create: async args => { captured = args; return { copyId }; } },
  });
  await service.execute({ action: 'import', input });
  assert.equal(captured.chatId, chat);
  assert.equal(captured.source, 'file-history-unverified');
  assert.equal(captured.accountId, self);
  assert.equal(captured.messages[0].id, message.id);
});

test('import refuses mismatched accounts, cross-chat rows, ambiguous chats and redacted identities before saving', async t => {
  const root = await temporary(t), input = path.join(root, 'history.json');
  let saved = 0;
  const service = createHistoryCopyService({ self }, { registry: registry(), store: { create: () => { saved++; } } });
  for (const [data, args, code] of [
    [{ self: 'other_account', messages: [message] }, {}, 'E_RECORD_ACCOUNT'],
    [{ self, chatId: 'other_chat', messages: [message] }, { to: chat }, 'E_RECORD_CHAT'],
    [{ self, messages: [message, { ...message, chatId: 'other_chat' }] }, {}, 'E_RECORD_CHAT'],
    [{ self, messages: [{ ...message, chatId: 'wxid_abc…xyz' }] }, {}, 'E_RECORD_CHAT'],
    [{ self, messages: [{ ...message, senderId: recipientAlias(self) }] }, {}, 'E_RECORD_CHAT'],
  ]) {
    await fs.writeFile(input, JSON.stringify(data));
    await assert.rejects(service.execute({ action: 'import', input, ...args }), { code });
  }
  assert.equal(saved, 0);
});

test('copy actions stay offline, preserve empty text and reject invalid UTF8 or oversized text', async t => {
  const root = await temporary(t), textFile = path.join(root, 'text.txt');
  const calls = [];
  const store = Object.fromEntries(['list', 'show', 'changes', 'edit', 'undo'].map(method => [method, async args => { calls.push([method, args]); return { localOnly: true }; }]));
  const service = createHistoryCopyService({}, { store, registry: registry(), readHistory: () => { throw new Error('offline action touched client'); } });
  await service.execute({ action: 'list' });
  await service.execute({ action: 'show', copyId });
  await service.execute({ action: 'changes', copyId });
  await service.execute({ action: 'edit', copyId, recordId, text: '', expectedRevision: 0, timestamp: 0 });
  assert.deepEqual(calls[3], ['edit', { copyId, recordId, text: '', timestamp: 0, expectedRevision: 0 }]);
  await fs.writeFile(textFile, 'file fixture\n第二行');
  await service.execute({ action: 'edit', copyId, recordId, textFile });
  assert.equal(calls.at(-1)[1].text, 'file fixture\n第二行');
  await service.execute({ action: 'undo', copyId });
  await fs.writeFile(textFile, Buffer.from([0xff]));
  await assert.rejects(service.execute({ action: 'edit', copyId, recordId, textFile }), { code: 'E_RECORD_TEXT_FILE' });
  await assert.rejects(service.execute({ action: 'edit', copyId, recordId, text: '中'.repeat(400000) }), { code: 'E_RECORD_TEXT' });
  await assert.rejects(service.execute({ action: 'edit', copyId, recordId, text: 'x', textFile }), { code: 'E_RECORD_TEXT' });
});

test('export keeps local-edit provenance and default ID privacy, requires a new private output', async t => {
  const root = await temporary(t), output = path.join(root, 'copy.json');
  const raw = { source: 'local-history-copy', localOnly: true, copyId, revision: 1, messageCount: 1, edited: true, messages: [{ ...message, recordId, senderId: self, isSelf: true, edited: true, senderName: '测试联系人', source: 'local-history-copy', origin: { source: 'reverse-native' } }] };
  const dependencies = { registry: registry(), store: { exportData: async () => raw }, readHistory: () => { throw new Error('export touched client'); } };
  const service = createHistoryCopyService({}, dependencies);
  const result = await service.execute({ action: 'export', copyId, output });
  const text = await fs.readFile(output, 'utf8'), data = JSON.parse(text);
  assert.equal(result.redacted, true);
  assert.equal(JSON.stringify(result).includes(JSON.stringify(output).slice(1, -1)), false);
  assert.equal(text.includes(self), false); assert.equal(text.includes(chat), false);
  assert.equal(data.localOnly, true); assert.equal(data.edited, true); assert.equal(data.revision, 1);
  assert.equal(data.messages[0].id, message.id); assert.equal(data.messages[0].recordId, recordId);
  assert.equal(data.messages[0].senderName, '测试联系人'); assert.equal(data.messages[0].text, message.text);
  await assert.rejects(service.execute({ action: 'export', copyId, output }), { code: 'E_RECORD_OUTPUT_EXISTS' });
  assert.equal(await fs.readFile(output, 'utf8'), text);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.wxcc-record-export-')), false);
  const workspaceOutput = fileURLToPath(new URL('../never-write.json', import.meta.url));
  await assert.rejects(service.execute({ action: 'export', copyId, output: workspaceOutput }), { code: 'E_RECORD_OUTPUT_SCOPE' });
  const workspace = fileURLToPath(new URL('../', import.meta.url));
  const linked = path.join(root, 'linked-source');
  await fs.symlink(workspace, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const unexpectedFolder = path.join(workspace, `must-not-create-${path.basename(root)}`);
  await assert.rejects(service.execute({ action: 'export', copyId, output: path.join(linked, path.basename(unexpectedFolder), 'copy.json') }), { code: 'E_RECORD_OUTPUT_SCOPE' });
  await assert.rejects(fs.lstat(unexpectedFolder), { code: 'ENOENT' });
  const explicit = createHistoryCopyService({ redact: false }, dependencies);
  const privateOutput = path.join(root, 'explicit-private.json');
  await explicit.execute({ action: 'export', copyId, output: privateOutput });
  assert.equal(JSON.parse(await fs.readFile(privateOutput, 'utf8')).messages[0].chatId, chat);
  assert.equal(raw.messages[0].chatId, chat);
});

test('service routes local record operations without constructing native adapters', async () => {
  const calls = [];
  const service = await createService({ backend: 'reverse-native' }, {
    reverseFactory() { throw new Error('local operation constructed client'); },
    createHistoryCopyService: (options, dependencies) => {
      assert.equal(options.backend, 'reverse-native'); assert.equal(typeof dependencies.readHistory, 'function');
      return { execute: async args => { calls.push(args.action); return { localOnly: true }; }, close: async () => calls.push('close') };
    },
  });
  await service.record({ action: 'show', copyId });
  await service.record({ action: 'edit', copyId, recordId, text: 'copy fixture' });
  await service.close();
  assert.deepEqual(calls, ['show', 'edit', 'close']);
});
