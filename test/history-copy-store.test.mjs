import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rm, writeFile, symlink, mkdir, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HistoryCopyStore } from '../src/history-copy-store.mjs';
import { recipientAlias } from '../src/recipient-registry.mjs';

const run = promisify(execFile);
const accountId = 'wxid_account_for_local_copy';
const chatId = 'wxid_chat_for_local_copy';
const uint64 = '18446744073709551615';
const message = (overrides = {}) => ({ id: uint64, chatId, senderId: null, isSelf: null, type: '1', text: '原始正文 👩‍💻\n第二行', timestamp: 1700000000000, source: 'native', ...overrides });
async function fixture(t, dependencies = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wxcc-history-copy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'history-copies');
  return { directory, root, store: new HistoryCopyStore({ root }, dependencies) };
}
async function imported(fx, messages = [message()]) {
  return fx.store.create({ accountId, chatId, displayName: '指定联系人', source: 'native', messages });
}
const copyFile = (fx, copyId) => join(fx.root, `${copyId}.json`);

test('a missing private directory lists no copies and does not create files', async t => {
  const fx = await fixture(t);
  assert.deepEqual(await fx.store.list(), { source: 'local-history-copy', localOnly: true, copies: [] });
  assert.deepEqual(await readdir(fx.directory), []);
});

test('create snapshots inputs, preserves full uint64 IDs and nullable native direction, and exposes aliases', async t => {
  const fx = await fixture(t), messages = [message({ senderName: '完整昵称' })];
  const originalInput = structuredClone(messages);
  const creation = imported(fx, messages);
  messages[0].text = '调用方稍后改变输入';
  messages.push(message({ id: 'new' }));
  const result = await creation;
  assert.match(result.copyId, /^c_[a-f0-9]{32}$/);
  assert.equal(result.accountAlias, recipientAlias(accountId));
  assert.equal(result.chatAlias, recipientAlias(chatId));
  assert.equal(result.source, 'local-history-copy');
  assert.equal(result.localOnly, true);
  assert.equal(result.revision, 0);
  assert.equal(result.edited, false);
  assert.equal(JSON.stringify(result).includes(accountId), false);
  assert.equal(JSON.stringify(result).includes(chatId), false);
  assert.equal(JSON.stringify(result).includes(fx.root), false);
  const shown = await fx.store.show({ copyId: result.copyId });
  assert.equal(shown.messages.length, 1);
  assert.equal(shown.messages[0].id, uint64);
  assert.equal(shown.messages[0].senderId, null);
  assert.equal(shown.messages[0].isSelf, null);
  assert.equal(shown.messages[0].text, originalInput[0].text);
  assert.equal(shown.messages[0].senderName, '完整昵称');
  assert.match(shown.messages[0].recordId, /^m_[a-f0-9]{16}$/);
  assert.equal(shown.messages[0].source, 'local-history-copy');
  assert.deepEqual(shown.messages[0].origin, { source: 'native', localOnly: true });
  shown.messages[0].text = '修改返回对象';
  assert.equal((await fx.store.show({ copyId: result.copyId })).messages[0].text, originalInput[0].text);
  const listed = await fx.store.list();
  assert.equal(listed.copies[0].copyId, result.copyId);
  assert.equal(JSON.stringify(listed).includes(chatId), false);
  const second = await imported(fx, originalInput);
  assert.notEqual(second.copyId, result.copyId);
  assert.equal((await fx.store.list()).copies.length, 2);
  if (process.platform !== 'win32') {
    assert.equal((await stat(fx.root)).mode & 0o777, 0o700);
    assert.equal((await stat(copyFile(fx, result.copyId))).mode & 0o777, 0o600);
  }
});

test('edits, audit, export and reload preserve immutable original records and can undo empty text and zero time', async t => {
  const fx = await fixture(t), created = await imported(fx), copyId = created.copyId;
  const before = JSON.parse(await readFile(copyFile(fx, copyId), 'utf8'));
  const edit = await fx.store.edit({ copyId, messageId: uint64, text: '', timestamp: 0, expectedRevision: 0 });
  assert.equal(edit.revision, 1);
  assert.equal(edit.edited, true);
  assert.equal(edit.activeEditCount, 1);
  assert.equal(Object.hasOwn(edit, 'text'), false);
  assert.match(edit.changeId, /^e_[a-f0-9]{32}$/);
  const after = JSON.parse(await readFile(copyFile(fx, copyId), 'utf8'));
  assert.deepEqual(after.originalMessages, before.originalMessages);
  assert.equal(after.originalHash, before.originalHash);
  const reopened = new HistoryCopyStore({ root: fx.root });
  const exported = await reopened.exportData({ copyId });
  assert.equal(exported.messages[0].text, '');
  assert.equal(exported.messages[0].timestamp, 0);
  assert.equal(exported.messages[0].edited, true);
  assert.equal(exported.source, 'local-history-copy');
  assert.equal(Object.hasOwn(exported, 'originalMessages'), false);
  const audit = await reopened.changes({ copyId });
  assert.deepEqual(audit.changes[0].before, { text: message().text, timestamp: message().timestamp });
  assert.deepEqual(audit.changes[0].after, { text: '', timestamp: 0 });
  assert.equal(audit.changes[0].messageId, uint64);
  const undo = await reopened.undo({ copyId, expectedRevision: 1 });
  assert.equal(undo.changeId, edit.changeId);
  assert.match(undo.undoId, /^e_[a-f0-9]{32}$/);
  assert.equal(undo.revision, 2);
  assert.equal(undo.edited, false);
  assert.equal((await fx.store.show({ copyId })).messages[0].text, message().text);
  assert.equal((await fx.store.show({ copyId })).messages[0].timestamp, message().timestamp);
  const finalAudit = await fx.store.changes({ copyId });
  assert.equal(finalAudit.changes[0].undone, true);
  assert.equal(finalAudit.changes[1].kind, 'undo');
  assert.equal(finalAudit.changes[1].targetChangeId, edit.changeId);
  assert.deepEqual(JSON.parse(await readFile(copyFile(fx, copyId), 'utf8')).originalMessages, before.originalMessages);
  assert.deepEqual((await readdir(fx.root)).sort(), [`${copyId}.json`]);
});

test('duplicate original IDs are retained and require unique recordId for editing', async t => {
  const fx = await fixture(t), created = await imported(fx, [message({ id: '0' }), message({ id: '0', text: '另一条', timestamp: 1700000000001 })]);
  const shown = await fx.store.show({ copyId: created.copyId });
  assert.equal(shown.messages.length, 2);
  assert.notEqual(shown.messages[0].recordId, shown.messages[1].recordId);
  await assert.rejects(fx.store.edit({ copyId: created.copyId, messageId: '0', text: '不能猜选' }), { code: 'E_HISTORY_COPY_MESSAGE_AMBIGUOUS' });
  const result = await fx.store.edit({ copyId: created.copyId, recordId: shown.messages[1].recordId, text: '指定这一条' });
  assert.equal(result.messageId, '0');
  const changed = await fx.store.show({ copyId: created.copyId });
  assert.equal(changed.messages[0].text, message().text);
  assert.equal(changed.messages[1].text, '指定这一条');
  await fx.store.undo({ copyId: created.copyId });
  assert.equal((await fx.store.show({ copyId: created.copyId })).messages[1].text, '另一条');
});

test('imports reject cross-chat data, rounded IDs, invalid Unicode and excessive records without publishing files', async t => {
  const fx = await fixture(t);
  const invalidMessages = [
    [message({ chatId: 'wxid_another_chat' })], [message({ id: Number(uint64) })],
    [message({ senderId: '' })], [message({ isSelf: 'unknown' })], [message({ type: 1 })],
    [message({ text: '\ud800' })], [message({ text: 'NUL\0正文' })],
    [message({ text: '你'.repeat(Math.ceil(1024 * 1024 / 3)) })],
    [message({ timestamp: -1 })], [message({ timestamp: Number.MAX_SAFE_INTEGER + 1 })],
    new Array(1),
    Array.from({ length: 10001 }, () => message())
  ];
  for (const messages of invalidMessages) await assert.rejects(imported(fx, messages), error => /^E_HISTORY_COPY_/.test(error.code));
  assert.deepEqual(await readdir(fx.directory), []);
  await assert.rejects(fx.store.create({ accountId: ' leading', chatId, messages: [] }), { code: 'E_HISTORY_COPY_ARGUMENT' });
});

test('editing rejects immutable fields, cross-copy records and path traversal without touching stored bytes', async t => {
  const fx = await fixture(t), created = await imported(fx), copyId = created.copyId;
  const other = await imported(fx), otherRecord = (await fx.store.show({ copyId: other.copyId })).messages[0].recordId;
  const original = await readFile(copyFile(fx, copyId), 'utf8');
  for (const input of [
    { copyId, messageId: uint64, text: 'x', id: 'new' },
    { copyId, messageId: uint64, text: 'x', chatId: 'other' },
    { copyId, messageId: uint64, text: 'x', senderId: accountId },
    { copyId, messageId: uint64 },
    { copyId, messageId: uint64, text: '\udfff' },
    { copyId, messageId: uint64, text: '\0' },
    { copyId, messageId: uint64, timestamp: 1.1 },
    { copyId, recordId: otherRecord, text: 'x' },
    { copyId, messageId: 'not-in-copy', text: 'x' },
    { copyId: '../recipients', messageId: uint64, text: 'x' },
    { copyId, recordId: 'm_0000000000000000', messageId: uint64, text: 'x' }
  ]) await assert.rejects(fx.store.edit(input), error => /^E_HISTORY_COPY_/.test(error.code));
  assert.equal(await readFile(copyFile(fx, copyId), 'utf8'), original);
  await assert.rejects(fx.store.show({ copyId: '../recipients' }), { code: 'E_HISTORY_COPY_ARGUMENT' });
});

test('undo refuses to jump over later changes to the same record and supports independent message undo', async t => {
  const fx = await fixture(t), created = await imported(fx, [message(), message({ id: 'second' })]), copyId = created.copyId;
  const first = await fx.store.edit({ copyId, messageId: uint64, text: '第一次' });
  const second = await fx.store.edit({ copyId, messageId: uint64, text: '第二次' });
  const third = await fx.store.edit({ copyId, messageId: 'second', text: '另一条消息' });
  await assert.rejects(fx.store.undo({ copyId, changeId: first.changeId }), { code: 'E_HISTORY_COPY_UNDO_ORDER' });
  assert.equal((await fx.store.undo({ copyId, changeId: second.changeId })).changeId, second.changeId);
  assert.equal((await fx.store.undo({ copyId })).changeId, third.changeId);
  assert.equal((await fx.store.undo({ copyId })).changeId, first.changeId);
  await assert.rejects(fx.store.undo({ copyId }), { code: 'E_HISTORY_COPY_UNDO_NOT_FOUND' });
  await assert.rejects(fx.store.undo({ copyId, changeId: first.changeId }), { code: 'E_HISTORY_COPY_UNDO_NOT_FOUND' });
  const shown = await fx.store.show({ copyId });
  assert.equal(shown.activeEditCount, 0);
  assert.equal(shown.revision, 6);
  assert.ok(shown.messages.every(item => item.text === message().text));
});

test('show sorts the edited displayed timeline, export includes all records, and audit applies limit', async t => {
  const fx = await fixture(t), created = await imported(fx, [message({ id: 'first', timestamp: 0 }), message({ id: 'second', timestamp: 10 }), message({ id: 'third', timestamp: 20 })]), copyId = created.copyId;
  await fx.store.edit({ copyId, messageId: 'first', timestamp: Number.MAX_SAFE_INTEGER });
  assert.deepEqual((await fx.store.show({ copyId, limit: 2 })).messages.map(item => item.id), ['third', 'first']);
  assert.equal((await fx.store.exportData({ copyId })).messages.length, 3);
  await fx.store.undo({ copyId });
  assert.equal((await fx.store.changes({ copyId, limit: 1 })).changes[0].kind, 'undo');
  for (const limit of [0, -1, 10001, 1.5, '2']) await assert.rejects(fx.store.show({ copyId, limit }), { code: 'E_HISTORY_COPY_ARGUMENT' });
});

test('independent store instances serialize concurrent edits and optimistic revision prevents stale writes', async t => {
  const fx = await fixture(t), created = await imported(fx), copyId = created.copyId;
  const stores = Array.from({ length: 6 }, () => new HistoryCopyStore({ root: fx.root }));
  await Promise.all(stores.map((store, index) => store.edit({ copyId, messageId: uint64, text: `并发修改 ${index}` })));
  assert.equal((await fx.store.show({ copyId })).revision, 6);
  assert.equal((await fx.store.changes({ copyId })).changes.length, 6);
  const race = await Promise.allSettled(stores.map((store, index) => store.edit({ copyId, messageId: uint64, text: `乐观锁 ${index}`, expectedRevision: 6 })));
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
  assert.ok(race.filter(item => item.status === 'rejected').every(item => item.reason.code === 'E_HISTORY_COPY_REVISION_CONFLICT'));
  await assert.rejects(fx.store.undo({ copyId, expectedRevision: 6 }), { code: 'E_HISTORY_COPY_REVISION_CONFLICT' });
  assert.equal((await fx.store.show({ copyId })).revision, 7);
});

test('separate Node processes use the same lock without losing audit events', async t => {
  const fx = await fixture(t), created = await imported(fx), copyId = created.copyId;
  const moduleUrl = new URL('../src/history-copy-store.mjs', import.meta.url).href;
  const script = `import { HistoryCopyStore } from ${JSON.stringify(moduleUrl)}; const [root,copyId,messageId,text] = process.argv.slice(1); await new HistoryCopyStore({root}).edit({copyId,messageId,text});`;
  await Promise.all(Array.from({ length: 4 }, (_, index) => run(process.execPath, ['--input-type=module', '-e', script, fx.root, copyId, uint64, `子进程 ${index}`], { windowsHide: true, timeout: 30000, maxBuffer: 8192 })));
  const audit = await fx.store.changes({ copyId });
  assert.equal(audit.revision, 4);
  assert.equal(new Set(audit.changes.map(item => item.changeId)).size, 4);
  assert.deepEqual(audit.changes.map(item => item.revision), [1, 2, 3, 4]);
  for (let index = 0; index < 4; index++) await fx.store.undo({ copyId });
  assert.equal((await fx.store.show({ copyId })).messages[0].text, message().text);
});

test('failed atomic update keeps previous bytes, releases the lock and does not mutate originals', async t => {
  const fx = await fixture(t), created = await imported(fx), copyId = created.copyId;
  const original = await readFile(copyFile(fx, copyId), 'utf8');
  const broken = new HistoryCopyStore({ root: fx.root }, { renameImpl: async () => { throw Object.assign(Error(`secret path ${fx.root}`), { code: 'EIO' }); } });
  await assert.rejects(broken.edit({ copyId, messageId: uint64, text: '无法写入' }), error => {
    assert.equal(error.code, 'E_HISTORY_COPY_STORE');
    assert.equal(error.message.includes(fx.root), false);
    assert.equal(error.message.includes('无法写入'), false);
    return true;
  });
  assert.equal(await readFile(copyFile(fx, copyId), 'utf8'), original);
  assert.deepEqual(await readdir(fx.root), [`${copyId}.json`]);
  assert.equal((await fx.store.edit({ copyId, messageId: uint64, text: '随后可保存' })).revision, 1);
});

test('failed initial publication and ID collision never overwrite an existing copy', async t => {
  const fx = await fixture(t, { linkImpl: async () => { throw Error('failed publication'); } });
  await assert.rejects(imported(fx), { code: 'E_HISTORY_COPY_STORE' });
  assert.deepEqual(await readdir(fx.root), []);
  const fixedUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fixed = new HistoryCopyStore({ root: fx.root }, { randomUUIDImpl: () => fixedUuid });
  const created = await fixed.create({ accountId, chatId, messages: [message()] });
  const original = await readFile(copyFile(fx, created.copyId), 'utf8');
  await assert.rejects(fixed.create({ accountId, chatId, messages: [message({ text: '不得覆盖' })] }), { code: 'E_HISTORY_COPY_COLLISION' });
  assert.equal(await readFile(copyFile(fx, created.copyId), 'utf8'), original);
});

test('corrupt, truncated, oversized and internally inconsistent files fail closed on show, edit and list', async t => {
  const fx = await fixture(t), created = await imported(fx), copyId = created.copyId;
  const original = await readFile(copyFile(fx, copyId), 'utf8'), originalRecord = JSON.parse(original);
  const mutation = change => { const value = structuredClone(originalRecord); change(value); return `${JSON.stringify(value)}\n`; };
  const invalidContents = [
    '', original.slice(0, -30), Buffer.from([0xff]),
    mutation(value => { value.version = 2; }),
    mutation(value => { value.accountId = 'wxid_mismatched_account'; }),
    mutation(value => { value.chatId = 'wxid_mismatched'; }),
    mutation(value => { value.originalMessages[0].text = '改原始记录'; }),
    mutation(value => { value.originalMessages[0].recordId = 'm_0000000000000000'; }),
    mutation(value => { value.revision = 1; }),
    mutation(value => { value.unexpected = true; }),
    mutation(value => { value.originalMessages[0].senderId = undefined; }),
    `${original.slice(0, -2)},"version":1}\n`
  ];
  for (const contents of invalidContents) {
    await writeFile(copyFile(fx, copyId), contents);
    for (const action of [() => fx.store.show({ copyId }), () => fx.store.list(), () => fx.store.edit({ copyId, messageId: uint64, text: '拒绝修改' })]) {
      await assert.rejects(action(), error => {
        assert.equal(error.code, 'E_HISTORY_COPY_CORRUPT');
        assert.equal(error.message.includes(chatId), false);
        assert.equal(error.message.includes(fx.root), false);
        return true;
      });
    }
  }
  await writeFile(copyFile(fx, copyId), Buffer.alloc(64 * 1024 * 1024 + 1, 0x20));
  await assert.rejects(fx.store.show({ copyId }), { code: 'E_HISTORY_COPY_CORRUPT' });
  await writeFile(copyFile(fx, copyId), original);
  await fx.store.edit({ copyId, messageId: uint64, text: '审计内容' });
  const withEvent = JSON.parse(await readFile(copyFile(fx, copyId), 'utf8'));
  withEvent.events[0].before.text = '不符的修改前值';
  await writeFile(copyFile(fx, copyId), `${JSON.stringify(withEvent)}\n`);
  await assert.rejects(fx.store.show({ copyId }), { code: 'E_HISTORY_COPY_CORRUPT' });
});

test('a leftover lock fails explicitly and the copy is left untouched', async t => {
  const fx = await fixture(t), created = await imported(fx), copyId = created.copyId;
  const original = await readFile(copyFile(fx, copyId), 'utf8');
  await writeFile(join(fx.root, `${copyId}.lock`), '999999\n');
  const busy = new HistoryCopyStore({ root: fx.root }, { lockTimeoutMs: 0 });
  await assert.rejects(busy.edit({ copyId, messageId: uint64, text: '不得抢锁' }), { code: 'E_HISTORY_COPY_BUSY' });
  assert.equal(await readFile(copyFile(fx, copyId), 'utf8'), original);
});

test('directory junctions or symlinks cannot redirect private copy writes outside the root', async t => {
  const fx = await fixture(t), outside = join(fx.directory, 'outside');
  await mkdir(outside);
  try { await symlink(outside, fx.root, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('This filesystem cannot create test links.'); return; } throw error; }
  await assert.rejects(imported(fx), { code: 'E_HISTORY_COPY_PATH' });
  await assert.rejects(fx.store.list(), { code: 'E_HISTORY_COPY_PATH' });
  assert.deepEqual(await readdir(outside), []);
});

test('custom roots cannot change workspace or Weixin directory permissions, or use non-copy directories', async t => {
  const fx = await fixture(t);
  for (const root of [process.cwd(), join(fx.directory, 'db_storage', 'anything'), join(fx.directory, 'xwechat_files', 'account'), join(fx.directory, 'WeChat Files', 'account')]) {
    assert.throws(() => new HistoryCopyStore({ root }), { code: 'E_HISTORY_COPY_PATH' });
  }
  await mkdir(fx.root);
  await writeFile(join(fx.root, 'unrelated.txt'), '必须保持原内容');
  let protectedDirectory = false;
  const guarded = new HistoryCopyStore({ root: fx.root }, { protectDirectoryImpl: async () => { protectedDirectory = true; } });
  await assert.rejects(guarded.create({ accountId, chatId, messages: [message()] }), { code: 'E_HISTORY_COPY_PATH' });
  assert.equal(protectedDirectory, false);
  assert.equal(await readFile(join(fx.root, 'unrelated.txt'), 'utf8'), '必须保持原内容');
});

test('a file that grows after stat is read with a hard size bound and rejected', async t => {
  const fx = await fixture(t), created = await imported(fx), copyId = created.copyId;
  const original = await readFile(copyFile(fx, copyId)), requests = [];
  const growing = new HistoryCopyStore({ root: fx.root }, { openImpl: async (path, ...args) => {
    const handle = await open(path, ...args);
    let first = true;
    return {
      stat: async options => {
        const snapshot = await handle.stat(options);
        if (first) { first = false; await writeFile(path, Buffer.concat([original, Buffer.alloc(2 * 1024 * 1024, 0x20)])); }
        return snapshot;
      },
      read: (...readArgs) => { requests.push(readArgs[2]); return handle.read(...readArgs); },
      close: () => handle.close()
    };
  } });
  await assert.rejects(growing.show({ copyId }), { code: 'E_HISTORY_COPY_CORRUPT' });
  assert.ok(requests.length > 0);
  assert.ok(requests.every(length => length <= original.length + 1));
});

test('the edit-count limit leaves saved changes undoable', async t => {
  const fx = await fixture(t), created = await imported(fx), copyId = created.copyId;
  const record = JSON.parse(await readFile(copyFile(fx, copyId), 'utf8')), original = record.originalMessages[0];
  let previousText = original.text;
  record.events = Array.from({ length: 10000 }, (_, index) => {
    const text = `已有修改 ${index + 1}`;
    const event = { id: `e_${(index + 1).toString(16).padStart(32, '0')}`, kind: 'edit', recordId: original.recordId, messageId: original.id,
      before: { text: previousText, timestamp: original.timestamp }, after: { text, timestamp: original.timestamp }, revision: index + 1, createdAt: record.createdAt };
    previousText = text;
    return event;
  });
  record.revision = 10000;
  await writeFile(copyFile(fx, copyId), `${JSON.stringify(record)}\n`);
  await assert.rejects(fx.store.edit({ copyId, messageId: uint64, text: '拒绝第 10001 次编辑' }), { code: 'E_HISTORY_COPY_SIZE' });
  const undone = await fx.store.undo({ copyId });
  assert.equal(undone.revision, 10001);
  assert.equal(undone.activeEditCount, 9999);
  assert.equal((await fx.store.show({ copyId })).messages[0].text, '已有修改 9999');
});

test('byte-size limits reject an edit that would leave no room to undo, while smaller edits remain reversible', async t => {
  const fx = await fixture(t), text = 'x'.repeat(1024 * 1024), escapedText = '\u0001'.repeat(1024 * 1024);
  // Escaped characters fill 54 MiB of JSON with only 9 MiB of in-memory text.
  const messages = [
    ...Array.from({ length: 9 }, (_, index) => message({ id: `escaped-${index}`, text: escapedText })),
    ...Array.from({ length: 6 }, (_, index) => message({ id: `text-${index}`, text }))
  ];
  const created = await imported(fx, messages), copyId = created.copyId;
  await assert.rejects(fx.store.edit({ copyId, messageId: 'text-0', text: 'y'.repeat(1024 * 1024) }), { code: 'E_HISTORY_COPY_SIZE' });
  assert.equal((await fx.store.show({ copyId, limit: 1 })).revision, 0);
  const edited = await fx.store.edit({ copyId, messageId: 'text-0', text: '小改动' });
  assert.equal(edited.revision, 1);
  assert.equal((await fx.store.undo({ copyId })).revision, 2);
  assert.equal((await fx.store.exportData({ copyId })).messages.find(item => item.id === 'text-0').text, text);
});

test('Windows 8.3 aliases are supported after link checks without weakening junction rejection', { skip: process.platform !== 'win32' }, async t => {
  const fx = await fixture(t);
  // cmd.exe parses the command itself; libuv argument quoting would insert literal backslashes.
  const { stdout } = await run('cmd.exe', ['/d', '/u', '/c', 'for %I in ("%WXCC_TEST_LONG_ROOT%") do @echo %~fsI'], { env: { ...process.env, WXCC_TEST_LONG_ROOT: fx.directory }, encoding: 'utf16le', windowsVerbatimArguments: true, windowsHide: true, timeout: 10000, maxBuffer: 8192 });
  const outputPath = stdout.trim();
  const shortPath = outputPath.startsWith('"') && outputPath.endsWith('"') ? outputPath.slice(1, -1) : outputPath;
  assert.equal((await stat(shortPath)).isDirectory(), true, 'The short-path helper must return an existing directory.');
  assert.equal((await realpath(shortPath)).toLowerCase(), (await realpath(fx.directory)).toLowerCase(), 'The short-path helper must identify the same temporary directory.');
  if (!shortPath.includes('~')) { t.skip('This filesystem has no 8.3 alias for the temporary directory.'); return; }
  const shortStore = new HistoryCopyStore({ root: join(shortPath, 'history-copies') });
  const created = await shortStore.create({ accountId, chatId, messages: [message()] });
  assert.equal((await fx.store.show({ copyId: created.copyId })).messages[0].id, uint64);
  assert.equal(shortStore.root.toLowerCase(), (await realpath(fx.root)).toLowerCase());
  const linkedRoot = join(shortPath, 'junction-copy-root'), outside = join(fx.directory, 'outside');
  await mkdir(outside);
  await symlink(outside, linkedRoot, 'junction');
  await assert.rejects(new HistoryCopyStore({ root: linkedRoot }).create({ accountId, chatId, messages: [message()] }), { code: 'E_HISTORY_COPY_PATH' });
  assert.deepEqual(await readdir(outside), []);
});
