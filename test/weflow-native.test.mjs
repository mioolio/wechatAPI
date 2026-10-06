import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WeFlowNativeAdapter } from '../src/weflow-native.mjs';

const syntheticKey = 'ab'.repeat(32);
const sampleJson = '[{"server_id":18446744073709551614,"local_type":1,"create_time":1790908800,"sender_username":"wxid_test_contact","message_content":"test"}]';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wxcc-native-test-'));
  const libraries = path.join(root, 'resources', 'wcdb', 'win32', 'x64');
  const accountDir = path.join(root, 'account');
  await mkdir(libraries, { recursive: true });
  for (const name of ['WCDB.dll', 'wcdb_api.dll', 'SDL2.dll']) await writeFile(path.join(libraries, name), 'mock DLL; never loaded');
  await mkdir(path.join(accountDir, 'db_storage', 'session'), { recursive: true });
  await writeFile(path.join(accountDir, 'db_storage', 'session', 'session.db'), 'mock database; never read');
  const keyFile = path.join(root, 'synthetic-key.txt');
  await writeFile(keyFile, `\n${syntheticKey}\n`);
  return { root, libraries, accountDir, keyFile, async clean() { await rm(root, { recursive: true, force: true }); } };
}

function mockKoffi(options = {}) {
  const calls = [];
  const freed = [];
  const bound = [];
  let protectionAttempt = 0;
  let batchIndex = 0;
  const implementations = {
    InitProtection: () => options.protectionCodes?.[protectionAttempt++] ?? options.protectionCode ?? 0,
    wcdb_init: () => options.initCode ?? 0,
    wcdb_shutdown: () => options.shutdownCode ?? 0,
    wcdb_open_account: (_path, _key, out) => {
      out[0] = options.handle ?? 777;
      if (options.openThrows) throw new Error(`native error includes ${syntheticKey}`);
      return options.openCode ?? 0;
    },
    wcdb_set_my_wxid: () => options.identityCode ?? 0,
    wcdb_close_account: () => options.closeCode ?? 0,
    wcdb_get_sessions: (_handle, out) => {
      out[0] = { json: options.sessionsJson ?? '[{"username":"wxid_test_contact"},{"username":"wxid_other"},{"username":"room@chatroom"}]' };
      return 0;
    },
    wcdb_get_contacts_compact: (_handle, _usernames, out) => {
      out[0] = { json: options.contactsJson ?? '[{"username":"wxid_test_contact","remark":"测试联系人","nick_name":"Nick"},{"username":"wxid_other","remark":"Other"},{"username":"room@chatroom","remark":"测试联系人群"},{"username":"gh_official","remark":"测试联系人公众号"}]' };
      return 0;
    },
    wcdb_get_messages: (_handle, _to, _limit, _offset, out) => {
      out[0] = { json: options.json ?? sampleJson };
      if (options.queryThrows) throw new Error(`native error includes ${syntheticKey}`);
      return options.queryCode ?? 0;
    },
    wcdb_free_string: (pointer) => { freed.push(pointer); },
    wcdb_open_message_cursor: (_handle, _to, _limit, _ascending, _since, _end, out) => {
      out[0] = options.cursor ?? 888;
      return options.cursorCode ?? 0;
    },
    wcdb_fetch_message_batch: (_handle, _cursor, out, hasMore) => {
      const batch = options.batches?.[batchIndex++];
      out[0] = { json: batch?.json ?? options.json ?? sampleJson };
      hasMore[0] = batch?.hasMore ?? options.hasMore ?? 0;
      if (options.queryThrows) throw new Error(`native error includes ${syntheticKey}`);
      options.onBatch?.(batchIndex);
      return options.queryCode ?? 0;
    },
    wcdb_close_message_cursor: () => options.cursorCloseCode ?? 0,
  };
  return {
    calls, freed, bound,
    load(file) {
      calls.push({ name: 'load', args: [file] });
      return {
        unload() { calls.push({ name: 'unload', args: [file] }); },
        func(signature) {
          const name = signature.match(/\b([A-Za-z_]\w*)\s*\(/)?.[1];
          if (!implementations[name] || options.missingSymbol === name) throw new Error(`missing ${name}`);
          bound.push(signature);
          return (...args) => { calls.push({ name, args }); return implementations[name](...args); };
        },
      };
    },
    decode(pointer, type, length) {
      assert.equal(type, 'char');
      assert.equal(length, -1);
      if (options.decodeThrows) throw new Error(`decode error includes ${syntheticKey}`);
      return pointer.json;
    },
  };
}

test('doctor preserves original resource paths, runs protection first, and never reads a key or opens a database', async () => {
  const files = await fixture();
  const koffi = mockKoffi({ protectionCodes: [-2201, -2201, 0] });
  const adapter = new WeFlowNativeAdapter({ root: files.root, keyFile: path.join(files.root, 'absent-key'), koffiImpl: koffi });
  try {
    const result = await adapter.doctor();
    assert.equal(result.initialized, true);
    assert.equal(result.accountOpen, false);
    assert.equal(result.capabilities.send, false);
    assert.equal(result.resourcePath, path.join(files.root, 'resources'));
    assert.deepEqual(koffi.calls.filter(({ name }) => name === 'InitProtection').map(({ args }) => args[0]), [files.libraries, path.dirname(files.libraries), path.join(files.root, 'resources')]);
    const initializeIndex = koffi.calls.findIndex(({ name }) => name === 'wcdb_init');
    const protectionIndices = koffi.calls.flatMap(({ name }, index) => name === 'InitProtection' ? [index] : []);
    assert.ok(protectionIndices.every((index) => index < initializeIndex));
    assert.equal(koffi.calls.some(({ name }) => name === 'wcdb_open_account'), false);
    await adapter.initialize();
    assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_init').length, 1);
    assert.ok(koffi.bound.every((signature) => !/send|delete|update|mark_all|cloud/.test(signature)));
  } finally { await adapter.close(); await files.clean(); }
});

test('protection rejection prevents init and frees loaded libraries', async () => {
  const files = await fixture();
  const koffi = mockKoffi({ protectionCode: -2205 });
  const adapter = new WeFlowNativeAdapter({ root: files.root, koffiImpl: koffi });
  try {
    await assert.rejects(adapter.initialize(), { code: 'E_NATIVE_PROTECTION' });
    await assert.rejects(adapter.doctor(), (failure) => failure.message.includes('-2205') && failure.details.attempts.every(({ code }) => code === -2205));
    assert.equal(koffi.calls.some(({ name }) => name === 'wcdb_init' || name === 'wcdb_open_account' || name === 'wcdb_shutdown'), false);
    assert.equal(koffi.calls.filter(({ name }) => name === 'unload').length, 6);
  } finally { await adapter.close(); await files.clean(); }
});

test('initialization and binding failures stop before opening databases', async () => {
  const files = await fixture();
  try {
    for (const [options, code] of [[{ initCode: -2 }, 'E_NATIVE_INIT'], [{ missingSymbol: 'wcdb_fetch_message_batch' }, 'E_NATIVE_SYMBOL']]) {
      const koffi = mockKoffi(options);
      const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
      await assert.rejects(adapter.initialize(), { code });
      assert.equal(koffi.calls.some(({ name }) => name === 'wcdb_open_account'), false);
      assert.equal(koffi.calls.filter(({ name }) => name === 'unload').length, 3);
      if (options.initCode) assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_shutdown').length, 1);
      await adapter.close();
    }
  } finally { await files.clean(); }
});

test('open locates only session.db, passes the explicit self identity, and does not expose the key', async () => {
  const files = await fixture();
  const koffi = mockKoffi();
  const adapter = new WeFlowNativeAdapter({ ...files, self: 'wxid_self', koffiImpl: koffi });
  try {
    const [result, concurrentResult] = await Promise.all([adapter.open(), adapter.open()]);
    assert.equal(result.accountOpen, true);
    assert.deepEqual(concurrentResult, result);
    const openCall = koffi.calls.find(({ name }) => name === 'wcdb_open_account');
    assert.equal(openCall.args[0], path.join(files.accountDir, 'db_storage', 'session', 'session.db'));
    assert.equal(openCall.args[1], syntheticKey);
    assert.deepEqual(koffi.calls.find(({ name }) => name === 'wcdb_set_my_wxid').args, [777, 'wxid_self']);
    assert.equal(JSON.stringify(result).includes(syntheticKey), false);
    assert.equal(JSON.stringify(adapter).includes(syntheticKey), false);
    await adapter.open();
    assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_open_account').length, 1);
  } finally { await adapter.close(); await files.clean(); }
});

test('queries only the explicit private target and preserves unsafe integer tokens as strings', async () => {
  const files = await fixture();
  const koffi = mockKoffi();
  const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
  try {
    await adapter.open();
    const result = await adapter.getMessages({ to: 'wxid_test_contact', limit: 5, offset: 2 });
    assert.equal(result.rows[0].server_id, '18446744073709551614');
    assert.equal(result.to, 'wxid_test_contact');
    assert.deepEqual(koffi.calls.find(({ name }) => name === 'wcdb_get_messages').args.slice(0, 4), [777, 'wxid_test_contact', 5, 2]);
    assert.equal(koffi.freed.length, 1);
    const newMessages = await adapter.getNewMessages({ to: 'wxid_test_contact', since: 1790908800, limit: 5 });
    assert.equal(newMessages.hasMore, false);
    assert.deepEqual(koffi.calls.find(({ name }) => name === 'wcdb_open_message_cursor').args.slice(0, 6), [777, 'wxid_test_contact', 5, 1, 1790908800, 0]);
    assert.deepEqual(koffi.calls.find(({ name }) => name === 'wcdb_close_message_cursor').args, [777, 888]);
    assert.equal(koffi.freed.length, 2);
  } finally { await adapter.close(); await files.clean(); }
});

test('missing, group, official and invalid query parameters never reach native message queries', async () => {
  const files = await fixture();
  const koffi = mockKoffi();
  const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
  try {
    await adapter.open();
    for (const to of [undefined, '', 'room@chatroom', 'gh_official', 'wxid_peer\n', '微信显示名']) {
      await assert.rejects(adapter.getMessages({ to }), { code: 'E_CHAT_SCOPE' });
      await assert.rejects(adapter.getNewMessages({ to, since: 0 }), { code: 'E_CHAT_SCOPE' });
    }
    for (const args of [{ limit: 0 }, { limit: 1001 }, { offset: -1 }, { offset: 0x8000_0000 }]) await assert.rejects(adapter.getMessages({ to: 'wxid_test_contact', ...args }), { code: 'E_ARGUMENT' });
    for (const since of [undefined, -1, 1.5, 0x8000_0000]) await assert.rejects(adapter.getNewMessages({ to: 'wxid_test_contact', since }), { code: 'E_ARGUMENT' });
    assert.equal(koffi.calls.some(({ name }) => name === 'wcdb_get_messages' || name === 'wcdb_open_message_cursor'), false);
  } finally { await adapter.close(); await files.clean(); }
});

test('native failure, malformed JSON and decoding exceptions always free outJson and close cursors', async () => {
  const files = await fixture();
  try {
    for (const options of [{ queryCode: -7 }, { json: '{bad-json' }, { json: '{}' }, { decodeThrows: true }, { queryThrows: true }]) {
      const koffi = mockKoffi(options);
      const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
      await adapter.open();
      await assert.rejects(adapter.getMessages({ to: 'wxid_test_contact' }), (failure) => {
        assert.equal(JSON.stringify(failure).includes(syntheticKey), false);
        assert.equal(failure.message.includes(syntheticKey), false);
        return true;
      });
      assert.equal(koffi.freed.length, 1);
      await assert.rejects(adapter.getNewMessages({ to: 'wxid_test_contact', since: 1790908800 }));
      assert.equal(koffi.freed.length, 2);
      assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_close_message_cursor').length, 1);
      await adapter.close();
    }
  } finally { await files.clean(); }
});

test('does not return more rows than requested and frees rejected JSON', async () => {
  const files = await fixture();
  const koffi = mockKoffi({ json: '[{},{}]' });
  const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
  try {
    await adapter.open();
    await assert.rejects(adapter.getMessages({ to: 'wxid_test_contact', limit: 1 }), { code: 'E_NATIVE_JSON' });
    assert.equal(koffi.freed.length, 1);
    await assert.rejects(adapter.getNewMessages({ to: 'wxid_test_contact', since: 0, limit: 1 }), { code: 'E_NATIVE_JSON' });
    assert.equal(koffi.freed.length, 2);
    assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_close_message_cursor').length, 1);
  } finally { await adapter.close(); await files.clean(); }
});

test('invalid keys and native open errors do not expose key material or leak partial handles', async () => {
  const files = await fixture();
  try {
    await writeFile(files.keyFile, 'invalid-private-key');
    const invalidKoffi = mockKoffi();
    const invalid = new WeFlowNativeAdapter({ ...files, koffiImpl: invalidKoffi });
    await assert.rejects(invalid.open(), (failure) => failure.code === 'E_NATIVE_KEY' && !failure.message.includes('invalid-private-key'));
    assert.equal(invalidKoffi.calls.some(({ name }) => name === 'wcdb_open_account'), false);
    await invalid.close();
    await writeFile(files.keyFile, syntheticKey);
    for (const options of [{ openCode: -1 }, { openThrows: true }, { identityCode: -1 }]) {
      const koffi = mockKoffi(options);
      const adapter = new WeFlowNativeAdapter({ ...files, self: 'wxid_self', koffiImpl: koffi });
      await assert.rejects(adapter.open(), (failure) => !failure.message.includes(syntheticKey));
      assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_close_account').length, 1);
      await adapter.close();
    }
  } finally { await files.clean(); }
});

test('supports an environment key without writing it to disk', async () => {
  const files = await fixture();
  const previous = process.env.WXCC_WECHAT_DB_KEY;
  process.env.WXCC_WECHAT_DB_KEY = syntheticKey;
  const koffi = mockKoffi();
  const adapter = new WeFlowNativeAdapter({ root: files.root, accountDir: files.accountDir, koffiImpl: koffi });
  try {
    const result = await adapter.open();
    assert.equal(result.accountOpen, true);
    assert.equal(koffi.calls.find(({ name }) => name === 'wcdb_open_account').args[1], syntheticKey);
    assert.equal(JSON.stringify(result).includes(syntheticKey), false);
  } finally {
    if (previous === undefined) delete process.env.WXCC_WECHAT_DB_KEY; else process.env.WXCC_WECHAT_DB_KEY = previous;
    await adapter.close(); await files.clean();
  }
});

test('close releases account then shuts down and unloads resources even on native close failure', async () => {
  const files = await fixture();
  try {
    for (const closeCode of [0, -1]) {
      const koffi = mockKoffi({ closeCode });
      const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
      await adapter.open();
      if (closeCode) await assert.rejects(adapter.close(), { code: 'E_NATIVE_CLOSE' }); else await adapter.close();
      const names = koffi.calls.map(({ name }) => name);
      assert.ok(names.indexOf('wcdb_close_account') < names.indexOf('wcdb_shutdown'));
      assert.ok(names.indexOf('wcdb_shutdown') < names.indexOf('unload'));
      assert.equal(names.filter((name) => name === 'unload').length, 3);
      await adapter.close();
      assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_shutdown').length, 1);
      await assert.rejects(adapter.getMessages({ to: 'wxid_test_contact' }), { code: 'E_NATIVE_NOT_OPEN' });
    }
  } finally { await files.clean(); }
});

test('reads private contact metadata and resolves session keyword through contact remark', async () => {
  const files = await fixture();
  const koffi = mockKoffi();
  const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
  try {
    await adapter.open();
    const contacts = await adapter.getContacts({ keyword: '测试联系人' });
    assert.deepEqual(contacts.rows.map(({ username }) => username), ['wxid_test_contact']);
    const sessions = await adapter.getSessions({ keyword: '测试联系人' });
    assert.deepEqual(sessions.rows.map(({ username, displayName }) => ({ username, displayName })), [{ username: 'wxid_test_contact', displayName: '测试联系人' }]);
    assert.deepEqual(koffi.calls.find(({ name }) => name === 'wcdb_get_contacts_compact').args.slice(0, 2), [777, null]);
    assert.equal(koffi.freed.length, 3);
    assert.ok((await adapter.getSessions()).rows.every(({ username }) => !username.includes('@chatroom')));
    await assert.rejects(adapter.getContacts({ keyword: 'x'.repeat(129) }), { code: 'E_ARGUMENT' });
  } finally { await adapter.close(); await files.clean(); }
});

test('missing compact contacts API gives explicit unsupported and session enumeration still works', async () => {
  const files = await fixture();
  const koffi = mockKoffi({ missingSymbol: 'wcdb_get_contacts_compact' });
  const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
  try {
    await adapter.open();
    await assert.rejects(adapter.getContacts({ keyword: '测试联系人' }), { code: 'E_UNSUPPORTED' });
    assert.deepEqual((await adapter.getSessions({ keyword: 'wxid_test_contact' })).rows.map(({ username }) => username), ['wxid_test_contact']);
  } finally { await adapter.close(); await files.clean(); }
});

test('metadata enumeration permits more than one thousand rows without applying message batch limits', async () => {
  const files = await fixture();
  const sessionsJson = JSON.stringify(Array.from({ length: 1500 }, (_, index) => ({ username: `wxid_${index}` })));
  const koffi = mockKoffi({ sessionsJson });
  const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
  try {
    await adapter.open();
    assert.equal((await adapter.getSessions()).rows.length, 1500);
    assert.equal(koffi.freed.length, 1);
  } finally { await adapter.close(); await files.clean(); }
});

test('drains the same cursor when more than one thousand messages share a timestamp', async () => {
  const files = await fixture();
  const first = Array.from({ length: 1000 }, (_, index) => ({ local_id: index + 1, create_time: 1790908800, message_content: 'same second' }));
  const last = [{ local_id: 1001, create_time: 1790908800, message_content: 'last message in second' }];
  const koffi = mockKoffi({ batches: [{ json: JSON.stringify(first), hasMore: 1 }, { json: JSON.stringify(last), hasMore: 0 }] });
  const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
  try {
    await adapter.open();
    const result = await adapter.getNewMessages({ to: 'wxid_test_contact', since: 1790908800 });
    assert.equal(result.rows.length, 1001);
    assert.equal(result.rows.at(-1).local_id, 1001);
    assert.equal(result.batches, 2);
    assert.equal(result.hasMore, false);
    assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_open_message_cursor').length, 1);
    assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_fetch_message_batch').length, 2);
    assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_close_message_cursor').length, 1);
    assert.equal(koffi.freed.length, 2);
  } finally { await adapter.close(); await files.clean(); }
});

test('row and batch totals fail explicitly instead of returning a truncated success', async () => {
  const files = await fixture();
  try {
    for (const [limits, expectedFetches] of [[{ maxRows: 1 }, 2], [{ maxBatches: 1 }, 1]]) {
      const koffi = mockKoffi({ hasMore: 1 });
      const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
      await adapter.open();
      await assert.rejects(adapter.getNewMessages({ to: 'wxid_test_contact', since: 0, ...limits }), { code: 'E_NATIVE_LIMIT' });
      assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_fetch_message_batch').length, expectedFetches);
      assert.equal(koffi.freed.length, expectedFetches);
      assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_close_message_cursor').length, 1);
      await adapter.close();
    }
  } finally { await files.clean(); }
});

test('aborted queries never open a cursor and cancellation after a batch frees JSON and cursor', async () => {
  const files = await fixture();
  try {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const firstKoffi = mockKoffi();
    const first = new WeFlowNativeAdapter({ ...files, koffiImpl: firstKoffi });
    await first.open();
    await assert.rejects(first.getNewMessages({ to: 'wxid_test_contact', since: 0, signal: alreadyAborted.signal }), { code: 'E_ABORTED' });
    assert.equal(firstKoffi.calls.some(({ name }) => name === 'wcdb_open_message_cursor'), false);
    await first.close();
    const controller = new AbortController();
    const koffi = mockKoffi({ hasMore: 1, onBatch: () => controller.abort() });
    const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
    await adapter.open();
    await assert.rejects(adapter.getNewMessages({ to: 'wxid_test_contact', since: 0, signal: controller.signal }), { code: 'E_ABORTED' });
    assert.equal(koffi.freed.length, 1);
    assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_close_message_cursor').length, 1);
    await adapter.close();
  } finally { await files.clean(); }
});

test('close cancels an active multi-batch cursor before unloading the library', async () => {
  const files = await fixture();
  const koffi = mockKoffi({ hasMore: 1 });
  const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
  try {
    await adapter.open();
    const query = adapter.getNewMessages({ to: 'wxid_test_contact', since: 0 });
    const rejection = assert.rejects(query, { code: 'E_ABORTED' });
    await adapter.close();
    await rejection;
    const names = koffi.calls.map(({ name }) => name);
    assert.ok(names.indexOf('wcdb_close_message_cursor') < names.indexOf('wcdb_close_account'));
    assert.ok(names.indexOf('wcdb_close_account') < names.indexOf('unload'));
    assert.equal(koffi.freed.length, 1);
  } finally { await adapter.close(); await files.clean(); }
});

test('invalid or stalled cursor paging cannot spin forever or silently return partial data', async () => {
  const files = await fixture();
  try {
    for (const options of [{ json: '[]', hasMore: 1 }, { hasMore: 2 }]) {
      const koffi = mockKoffi(options);
      const adapter = new WeFlowNativeAdapter({ ...files, koffiImpl: koffi });
      await adapter.open();
      await assert.rejects(adapter.getNewMessages({ to: 'wxid_test_contact', since: 0 }), { code: 'E_NATIVE_CURSOR' });
      assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_fetch_message_batch').length, 1);
      assert.equal(koffi.freed.length, 1);
      assert.equal(koffi.calls.filter(({ name }) => name === 'wcdb_close_message_cursor').length, 1);
      await adapter.close();
    }
  } finally { await files.clean(); }
});
