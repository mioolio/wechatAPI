import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.mjs';
import { MessageIndex } from '../src/messages.mjs';
import { zstdCompressSync } from 'node:zlib';

const captured = { id: '18446744073709551614', chatId: 'wxid_test', senderId: 'wxid_test', isSelf: false, type: 'text', text: 'fixture', timestamp: 1790908800000 };
function store() {
  return { index: new MessageIndex(), loads: 0, flushes: 0,
    async load() { this.loads++; }, async append(value) { return this.index.add(value); }, async flush() { this.flushes++; } };
}
const installationDoctor = async () => ({ version: '4.1.15.13', running: true });

test('start exposes verified capability summary and never constructs sending or leaks local descriptors', async () => {
  const service = await createService({ backend: 'reverse-native', pid: 123 }, {
    reverseFactory() { throw new Error('unexpected send adapter'); },
    startNativeRead: async options => { assert.equal(options.pid, 123); return { ready: true, tokenFile: 'private-host.json', logFile: 'private-log', automaticMessagesSent: 0 }; },
  });
  assert.deepEqual(await service.start(), { ready: true, automaticMessagesSent: 0 });
  await service.close();
});
test('database service is separate from send routing and closes its read adapter', async () => {
  const calls = [];
  const service = await createService({ backend: 'reverse-native', 'key-file': 'private-key.txt' }, {
    reverseFactory() { throw new Error('unexpected send adapter'); },
    createDatabaseService: options => { assert.equal(options['key-file'], 'private-key.txt'); return { execute: async args => { calls.push(args.action); return { ok: true }; }, close: async () => calls.push('close') }; },
  });
  assert.deepEqual(await service.db({ action: 'list' }), { ok: true });
  await service.close();
  assert.deepEqual(calls, ['list', 'close']);
});

test('unconfigured CLI send refuses before constructing a read backend or accessing any client', async () => {
  let touched = false;
  for (const backend of ['weflow-http', 'weflow-native', 'cache']) {
    const service = await createService({ backend }, { httpFactory: () => { touched = true; }, nativeFactory: () => { touched = true; }, installationDoctor: () => { touched = true; } });
    await assert.rejects(service.send({ to: 'wxid_test', text: 'never send' }), { code: 'E_SEND_NOT_CONFIGURED' });
    await service.close();
  }
  assert.equal(touched, false);
});

test('process inspect and probe cannot attach to the client', async () => {
  const service = await createService({}, { httpFactory: () => { throw new Error('must never create'); } });
  await assert.rejects(service.inspect(), { code: 'E_PROCESS_HOOK_DISABLED' });
  await assert.rejects(service.probe({ seconds: 1 }), { code: 'E_PROCESS_HOOK_DISABLED' });
});

test('native doctor reports resource errors without opening an account', async () => {
  let opened = false;
  const native = { async doctor() { const e = new Error('expired resource'); e.code = 'E_NATIVE_PROTECTION'; e.details = { attempts: [{ code: -101 }] }; throw e; }, async open() { opened = true; } };
  const service = await createService({ backend: 'weflow-native' }, { installationDoctor, nativeFactory: () => native });
  const result = await service.doctor();
  assert.equal(opened, false);
  assert.equal(result.connection.ready, false);
  assert.equal(result.connection.error.details.attempts[0].code, -101);
  assert.deepEqual(result.capabilities.read, { implemented: true, backendAvailable: false, accountVerified: false });
  assert.equal(result.capabilities.send, false);
});

test('HTTP health only confirms backend availability, not account or message access', async () => {
  const service = await createService({}, { installationDoctor, httpFactory: () => ({ health: async () => ({ status: 'ok', source: 'weflow-http' }) }) });
  const result = await service.doctor();
  assert.equal(result.connection.ready, true);
  assert.equal(result.capabilities.read.accountVerified, false);
});

test('HTTP queries forward exact IDs and keywords', async () => {
  const calls = [];
  const http = Object.fromEntries(['list', 'contacts', 'history'].map(method => [method, async args => { calls.push([method, args]); return { source: 'weflow-http' }; }]));
  const service = await createService({}, { httpFactory: () => http });
  await service.contacts({ keyword: '测试联系人' });
  await service.list({ keyword: '测试联系人' });
  await service.history({ to: 'wxid_test', limit: 7 });
  assert.deepEqual(calls, [['contacts', { keyword: '测试联系人' }], ['list', { keyword: '测试联系人' }], ['history', { to: 'wxid_test', limit: 7 }]]);
});

test('watch requires a single explicit target, persists and deduplicates its events', async () => {
  const cache = store();
  const service = await createService({ self: 'wxid_me' }, { store: cache, httpFactory: () => ({ watch: async ({ onEvent }) => {
    await onEvent({ ...captured, source: 'weflow-http' });
    await onEvent({ ...captured, source: 'weflow-http' });
  } }) });
  await assert.rejects(service.watch({}), { code: 'E_CHAT_REQUIRED' });
  assert.equal(cache.loads, 0);
  const events = [];
  await service.watch({ to: 'wxid_test', onEvent: event => events.push(event) });
  assert.deepEqual(events, [{ ...captured, source: 'weflow-http' }]);
  assert.equal(cache.index.entries.size, 1);
  assert.equal(cache.flushes, 1);
});

test('watch never persists a backend event from another conversation', async () => {
  const cache = store();
  const service = await createService({ self: 'wxid_me' }, { store: cache, httpFactory: () => ({ watch: async ({ onEvent }) => onEvent({ ...captured, chatId: 'other' }) }) });
  await assert.rejects(service.watch({ to: 'wxid_test' }), { code: 'E_CHAT_SCOPE' });
  assert.equal(cache.index.entries.size, 0);
  assert.equal(cache.flushes, 1);
});

test('native history maps explicit direction and preserves exact uint64 message IDs', async () => {
  const service = await createService({ backend: 'weflow-native', self: 'wxid_me' }, { nativeFactory: () => ({
    open: async () => {}, getMessages: async () => ({ source: 'weflow-native', rows: [
      { server_id: captured.id, local_id: 7, local_type: 1, create_time: captured.timestamp / 1000, computed_is_send: 0, message_content: captured.text },
      { server_id: '18446744073709551615', local_id: 8, local_type: 1, create_time: captured.timestamp / 1000 + 1, is_send: '1', message_content: 'own fixture' },
    ] }),
  }) });
  const result = await service.history({ to: 'wxid_test', limit: 30 });
  assert.deepEqual(result.messages[0], { ...captured, source: 'weflow-native' });
  assert.equal(result.messages[1].senderId, 'wxid_me');
  assert.equal(result.messages[1].isSelf, true);
});

test('native watch establishes a baseline then emits all unseen same-second records', async () => {
  const controller = new AbortController();
  const cache = store();
  const row = id => ({ server_id: id, local_id: 7, local_type: 1, create_time: captured.timestamp / 1000, computed_is_send: 0, message_content: captured.text });
  let queries = 0;
  const native = { open: async () => {}, getMessages: async () => ({ rows: [row('1')] }), getNewMessages: async () => ({ rows: ++queries === 1 ? [row('1')] : [row('1'), row('2'), row('3'), row('4')] }) };
  const service = await createService({ backend: 'weflow-native', self: 'wxid_me', interval: 1 }, { store: cache, nativeFactory: () => native });
  const ids = [];
  await service.watch({ to: 'wxid_test', signal: controller.signal, onEvent: message => { ids.push(message.id); if (ids.length === 3) controller.abort(); } });
  assert.deepEqual(ids, ['2', '3', '4']);
  assert.equal(queries, 2);
});

test('cache history is offline and cannot monitor or provide contacts', async () => {
  const cache = store();
  cache.index.add(captured);
  const service = await createService({ backend: 'cache', self: 'wxid_me' }, { store: cache });
  assert.deepEqual((await service.history({ to: 'wxid_test' })).messages, [captured]);
  assert.equal((await service.list()).chats[0].chatId, 'wxid_test');
  await assert.rejects(service.watch({ to: 'wxid_test' }), { code: 'E_UNSUPPORTED' });
  await assert.rejects(service.contacts(), { code: 'E_UNSUPPORTED' });
});

test('different self identities use different cache paths and missing identity never loads a cache', async () => {
  const paths = [];
  const factory = path => { paths.push(path); return store(); };
  for (const self of ['wxid_A', 'wxid_B', 'wxid_A']) await createService({ self }, { storeFactory: factory });
  assert.notEqual(paths[0], paths[1]);
  assert.equal(paths[0], paths[2]);
  const cache = store();
  const service = await createService({ backend: 'cache' }, { store: cache });
  await assert.rejects(service.history({ to: 'wxid_test' }), { code: 'E_SELF_REQUIRED' });
  assert.equal(cache.loads, 0);
});

test('invalid native target and interval never initialize an account', async () => {
  let opened = false;
  const service = await createService({ backend: 'weflow-native', self: 'wxid_me' }, { nativeFactory: () => ({ open: async () => { opened = true; } }) });
  await assert.rejects(service.watch({ to: '123@chatroom' }), { code: 'E_CHAT_SCOPE' });
  assert.equal(opened, false);
  await assert.rejects(createService({ interval: 2147483648 }), { code: 'E_ARGUMENT' });
});

test('reverse-native service routes inspect/send to the existing adapter', async () => {
  const calls = [];
  const reverse = { inspect: async () => { calls.push(['inspect']); return { ready: false }; }, send: async args => { calls.push(['send', args]); return { status: 'accepted', native: true }; }, close: async () => { calls.push(['close']); } };
  const service = await createService({ backend: 'reverse-native' }, { reverseFactory: () => reverse, httpFactory: () => { throw new Error('unexpected read backend'); }, nativeFactory: () => { throw new Error('unexpected read backend'); } });
  await service.inspect();
  await service.send({ session: '00123', text: 'mock-only', requestId: 'id' });
  for (const method of ['list', 'contacts', 'watch']) await assert.rejects(service[method]({ to: 'wxid_mock' }), { code: 'E_UNSUPPORTED' });
  await service.close();
  assert.deepEqual(calls, [['inspect'], ['send', { session: '00123', text: 'mock-only', requestId: 'id' }], ['close']]);
});

test('reverse-native doctor never treats a running process or merely ready agent as validated send', async () => {
  for (const connection of [
    { ready: false, sendValidated: false, prologuesVerified: false },
    { ready: true, sendValidated: false, prologuesVerified: true },
    { ready: true, sendValidated: true, prologuesVerified: false },
    { ready: true, sendValidated: true, prologuesVerified: true },
    { ready: true, sendValidated: true, prologuesVerified: true, scopeVerified: true },
  ]) {
    const service = await createService({ backend: 'reverse-native' }, { installationDoctor, reverseFactory: () => ({ doctor: async () => connection }) });
    const result = await service.doctor();
    assert.equal(result.capabilities.send, connection.ready === true && connection.sendValidated === true && connection.prologuesVerified === true && connection.scopeVerified === true);
    assert.equal(result.capabilities.read.implemented, true);
    assert.equal(result.capabilities.history, false);
    assert.equal(result.capabilities.read.backendAvailable, false);
  }
});

test('native normalization decodes compressed text and namespaces zero IDs by database source', async () => {
  const base = { server_id: '0', local_id: 7, local_type: 1, create_time: 1790908800, is_send: 0, table_name: 'Msg_scope' };
  const compressed = zstdCompressSync(Buffer.from('读取测试正文')).toString('hex');
  const rows = [
    { ...base, _db_path: 'C:/account/message_0.db', compress_content: compressed, message_content: 'fallback' },
    { ...base, _db_path: 'C:/account/message_1.db', message_content: 'second fixture' },
    { ...base, messageKey: 'scoped:original', content: 'already decoded', compress_content: 'invalid but unused' },
  ];
  const native = { open: async () => {}, getMessages: async () => ({ source: 'weflow-native', rows }) };
  const service = await createService({ backend: 'weflow-native', self: 'wxid_me' }, { nativeFactory: () => native });
  const result = await service.history({ to: 'wxid_test' });
  assert.equal(result.messages[0].text, '读取测试正文');
  assert.notEqual(result.messages[0].id, result.messages[1].id);
  assert.equal(result.messages[2].id, 'scoped:original');
  assert.equal(result.messages[2].text, 'already decoded');
  assert.equal(result.messages[0].id.includes('C:/account'), false);
});

test('native account and history route only to verified adapter methods without resolving aliases in service', async () => {
  const calls = [];
  const self = { source: 'reverse-native', self: 'wxid_account_fixture123', verified: true };
  const accounts = { source: 'reverse-native', accounts: [self], complete: false };
  const history = { source: 'reverse-native', messages: [], historyAvailable: true };
  const reverse = {
    account: async args => { calls.push(['account', args]); return self; },
    accounts: async args => { calls.push(['accounts', args]); return accounts; },
    history: async args => { calls.push(['history', args]); return history; },
    send: async () => { throw new Error('must not send'); },
    close: async () => { calls.push(['close']); },
  };
  const service = await createService({ backend: 'reverse-native' }, {
    reverseFactory: () => reverse,
    httpFactory: () => { throw new Error('must not construct HTTP backend'); },
    nativeFactory: () => { throw new Error('must not construct database backend'); },
    store: { async load() { throw new Error('must not load cache'); } },
  });
  assert.equal(await service.account(), self);
  assert.equal(await service.accounts(), accounts);
  assert.equal(await service.history({ to: 'u_0123456789abcdef', limit: 30 }), history);
  await service.close();
  assert.deepEqual(calls, [['account', {}], ['accounts', {}], ['history', { to: 'u_0123456789abcdef', limit: 30 }], ['close']]);
});

test('reverse-native doctor requires a literal verified history flag independent of send readiness', async () => {
  for (const historyAvailable of [undefined, false, 'true', 1, true]) {
    for (const ready of [false, true]) {
      const service = await createService({ backend: 'reverse-native' }, { installationDoctor, reverseFactory: () => ({ doctor: async () => ({ ready, historyAvailable, attached: true, sendValidated: true, prologuesVerified: true, scopeVerified: true }) }) });
      const result = await service.doctor();
      assert.equal(result.capabilities.history, historyAvailable === true);
      assert.equal(result.capabilities.read.backendAvailable, historyAvailable === true);
      assert.equal(result.capabilities.send, ready);
      await service.close();
    }
  }
});

test('account and history validation failures propagate without success or fallback', async () => {
  const fail = async () => { const error = new Error('Current runtime has no verified read result.'); error.code = 'E_NATIVE_HISTORY_UNVERIFIED'; throw error; };
  const service = await createService({ backend: 'reverse-native' }, { reverseFactory: () => ({ account: fail, accounts: fail, history: fail }), httpFactory: () => { throw new Error('must not fall back'); } });
  await assert.rejects(service.account(), { code: 'E_NATIVE_HISTORY_UNVERIFIED' });
  await assert.rejects(service.accounts(), { code: 'E_NATIVE_HISTORY_UNVERIFIED' });
  await assert.rejects(service.history({ to: 'u_0123456789abcdef', limit: 30 }), { code: 'E_NATIVE_HISTORY_UNVERIFIED' });
  await service.close();
});

test('explicit old read backends retain history and do not fabricate native accounts', async () => {
  for (const backend of ['weflow-http', 'weflow-native', 'cache']) {
    const calls = [];
    const cache = store();
    cache.index.add(captured);
    const service = await createService({ backend, self: 'wxid_me' }, {
      store: cache,
      httpFactory: () => ({ history: async args => { calls.push(['http', args]); return { source: 'weflow-http', messages: [] }; } }),
      nativeFactory: () => ({ open: async () => { calls.push(['open']); }, getMessages: async args => { calls.push(['native', args]); return { source: 'weflow-native', rows: [] }; } }),
      reverseFactory: () => { throw new Error('must not construct reverse backend'); },
    });
    const result = await service.history({ to: 'wxid_test', limit: 30 });
    assert.equal(result.source, backend === 'cache' ? 'captured-events' : backend);
    await assert.rejects(service.account(), { code: 'E_UNSUPPORTED' });
    await assert.rejects(service.accounts(), { code: 'E_UNSUPPORTED' });
    assert.deepEqual(calls, backend === 'cache' ? [] : backend === 'weflow-http' ? [['http', { to: 'wxid_test', limit: 30 }]] : [['open'], ['native', { to: 'wxid_test', limit: 30 }]]);
    await service.close();
  }
});
