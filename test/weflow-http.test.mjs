import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WeFlowHttpAdapter, normalizeApiMessage } from '../src/weflow-http.mjs';

const TOKEN = 'test-secret-never-in-a-url';
const TO = 'wxid_verified_target';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const row = (id = '9007199254740993', overrides = {}) => ({
  serverId: id, localId: 1, localType: 1, createTime: Math.floor(Date.now() / 1000) - 10,
  isSend: 0, senderUsername: TO, content: '正文', ...overrides,
});
const client = (fetchImpl, options = {}) => new WeFlowHttpAdapter({ token: TOKEN, fetchImpl, intervalMs: 1, ...options });

function messageResponse(messages, hasMore = false, extra = {}) {
  return json({ success: true, talker: TO, messages, hasMore, ...extra });
}

test('only loopback origins are accepted and secrets cannot be supplied in the URL', () => {
  for (const baseUrl of ['http://example.com:5031', 'http://127.0.0.1.evil', `http://localhost/?access_token=${TOKEN}`, `http://${TOKEN}@localhost`, 'file:///tmp/api', 'http://localhost/api/v1']) {
    assert.throws(() => client(() => {}, { baseUrl }), error => error.code === 'E_WEFLOW_URL' && !error.message.includes(TOKEN));
  }
  for (const baseUrl of ['http://127.0.0.1:5031', 'http://localhost:5031', 'http://[::1]:5031', 'http://127.0.0.2:5031']) assert.ok(client(() => {}, { baseUrl }));
  for (const option of ['intervalMs', 'timeoutMs']) assert.throws(() => client(() => {}, { [option]: 0x8000_0000 }), { code: 'E_ARGUMENT' });
});

test('health uses GET without an Authorization header and prohibits redirects', async () => {
  let requested;
  const adapter = client(async (url, options) => { requested = { url, options }; return json({ success: true, version: '5.0.0' }); });
  assert.deepEqual(await adapter.health(), { success: true, version: '5.0.0', source: 'weflow-http' });
  assert.equal(requested.url.pathname, '/api/v1/health');
  assert.equal(requested.url.search, '');
  assert.ok(!requested.url.toString().includes(TOKEN));
  assert.equal(Object.hasOwn(requested.options.headers, 'Authorization'), false);
  assert.equal(requested.options.method, 'GET');
  assert.equal(requested.options.redirect, 'error');
  await assert.rejects(adapter.request('https://example.com/api/v1/health'), { code: 'E_WEFLOW_URL' });
});

test('health works without a token while data APIs still require explicit credentials', async () => {
  let calls = 0;
  const adapter = new WeFlowHttpAdapter({ fetchImpl: async (_url, options) => {
    calls += 1;
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
    return json({ status: 'ok' });
  } });
  assert.equal((await adapter.health()).status, 'ok');
  await assert.rejects(adapter.list(), { code: 'E_WEFLOW_AUTH' });
  await assert.rejects(adapter.contacts({ keyword: '测试联系人' }), { code: 'E_WEFLOW_AUTH' });
  await assert.rejects(adapter.history({ to: TO }), { code: 'E_WEFLOW_AUTH' });
  assert.equal(calls, 1);
});

test('the exported normalizer supports an explicit native source without loosening identity rules', () => {
  const normalized = normalizeApiMessage(row('9007199254740993', { createTime: 100 }), TO, undefined, { source: 'weflow-native' });
  assert.equal(normalized.source, 'weflow-native');
  assert.equal(normalized.id, '9007199254740993');
  assert.throws(() => normalizeApiMessage(row(), 123), { code: 'E_ARGUMENT' });
});

test('the WeFlow internal Message schema keeps the original uint64 beside its rounded numeric copy', () => {
  // Synthetic fixture with the fields produced by chatService.mapRowsToMessagesLiteForApi.
  const weflowMessage = {
    messageKey: 'fixture-message-key', localId: 17, localType: 1,
    serverId: Number('18446744073709551614'), serverIdRaw: '18446744073709551614',
    createTime: 1760000000, sortSeq: 1760000000000,
    senderUsername: TO, isSend: 0, rawContent: '原始正文', parsedContent: '显示正文',
  };
  assert.equal(normalizeApiMessage(weflowMessage, TO, undefined, { source: 'weflow-native' }).id, '18446744073709551614');
  assert.equal(normalizeApiMessage(weflowMessage, TO).text, '显示正文');
  // HTTP toApiMessage writes getMessageServerId(msg) as a string and omits serverIdRaw.
  const httpMessage = { ...weflowMessage, serverId: weflowMessage.serverIdRaw, content: '显示正文' };
  delete httpMessage.serverIdRaw;
  assert.equal(normalizeApiMessage(httpMessage, TO).id, '18446744073709551614');
  assert.throws(() => normalizeApiMessage({ ...weflowMessage, serverIdRaw: undefined }, TO), { code: 'E_WEFLOW_MESSAGE' });
});

test('contacts and sessions expose exact IDs without treating display names as unique', async () => {
  const requests = [];
  const adapter = client(async url => {
    requests.push(url);
    if (url.pathname.endsWith('/contacts')) return json({ success: true, contacts: [{ username: 'wxid_a', displayName: '测试联系人' }, { username: 'wxid_b', displayName: '测试联系人' }] });
    return json({ success: true, sessions: [{ username: '001', displayName: '测试联系人' }] });
  });
  const contacts = await adapter.contacts({ keyword: '测试联系人' });
  assert.equal(contacts.contacts.length, 2);
  assert.equal(contacts.source, 'weflow-http');
  assert.equal(requests[0].searchParams.get('keyword'), '测试联系人');
  assert.equal((await adapter.list({ keyword: '测试联系人' })).chats[0].chatId, '001');
});

test('history normalizes large server IDs, seconds, types and the source', async () => {
  const adapter = client(async url => {
    assert.equal(url.searchParams.get('talker'), TO);
    assert.equal(url.searchParams.get('limit'), '30');
    assert.equal(url.searchParams.get('media'), '0');
    return messageResponse([row('9007199254740994', { createTime: 101, localType: 3 }), row('9007199254740993', { createTime: 100 })]);
  });
  assert.deepEqual(await adapter.history({ to: TO }), {
    source: 'weflow-http', messages: [
      { id: '9007199254740993', chatId: TO, senderId: TO, isSelf: false, type: 'text', text: '正文', timestamp: 100000, source: 'weflow-http' },
      { id: '9007199254740994', chatId: TO, senderId: TO, isSelf: false, type: 'image', text: '正文', timestamp: 101000, source: 'weflow-http' },
    ],
  });
});

test('safe numeric IDs are converted exactly, unsafe ones and string isSend are rejected', async () => {
  assert.equal((await client(async () => messageResponse([row(123)])).history({ to: TO })).messages[0].id, '123');
  for (const raw of [row(Number.MAX_SAFE_INTEGER + 1), row('1', { isSend: '1' }), row('1', { isSend: 2 }), row('1', { createTime: 0.5 })]) {
    await assert.rejects(client(async () => messageResponse([raw])).history({ to: TO }), { code: 'E_WEFLOW_MESSAGE' });
  }
});

test('missing self sender requires an explicit self ID; only a confirmed private endpoint can supply an incoming sender', async () => {
  const response = async () => messageResponse([row('1', { isSend: true, senderUsername: '' })]);
  await assert.rejects(client(response).history({ to: TO }), { code: 'E_WEFLOW_MESSAGE' });
  const own = (await client(response, { self: '001' }).history({ to: TO })).messages[0];
  assert.equal(own.senderId, '001');
  assert.equal(own.isSelf, true);
  assert.equal((await client(async () => messageResponse([row('1', { senderUsername: '' })])).history({ to: TO })).messages[0].senderId, TO);
  assert.equal(normalizeApiMessage(row('1', { senderUsername: null }), '123456789').senderId, '123456789');
  for (const target of ['room@chatroom', 'gh_account', '测试联系人', 'person@openim']) {
    assert.throws(() => normalizeApiMessage(row('1', { senderUsername: null }), target), { code: 'E_WEFLOW_MESSAGE' });
  }
});

test('serverId zero requires the original scoped messageKey rather than an unscoped local ID', async () => {
  await assert.rejects(client(async () => messageResponse([row('0', { localId: '77', createTime: 100 })])).history({ to: TO }), { code: 'E_WEFLOW_MESSAGE' });
  await assert.rejects(client(async () => messageResponse([row('0', { localId: 0 })])).history({ to: TO }), { code: 'E_WEFLOW_MESSAGE' });
  const first = normalizeApiMessage(row('0', { messageKey: 'local:database-a:1:100:1:sender:10000' }), TO);
  const second = normalizeApiMessage(row('0', { messageKey: 'local:database-b:1:100:1:sender:10000' }), TO);
  assert.notEqual(first.id, second.id);
  assert.equal(first.id, 'local:database-a:1:100:1:sender:10000');
});

test('history and watch require an exact string target and reject cross-chat responses', async () => {
  let calls = 0;
  const adapter = client(async () => { calls += 1; return messageResponse([], false, { talker: 'another' }); });
  await assert.rejects(adapter.watch({ onEvent() {} }), { code: 'E_ARGUMENT' });
  await assert.rejects(adapter.history({ to: 123 }), { code: 'E_ARGUMENT' });
  assert.equal(calls, 0);
  await assert.rejects(adapter.history({ to: TO }), { code: 'E_WEFLOW_SCOPE' });
});

test('initial watch baseline is silent and only the selected conversation is queried', async () => {
  const controller = new AbortController();
  const events = [];
  const requests = [];
  const adapter = client(async url => {
    requests.push(url);
    if (requests.length === 3) setImmediate(() => controller.abort());
    return messageResponse([row('1')]);
  });
  await adapter.watch({ to: TO, signal: controller.signal, onEvent: event => events.push(event) });
  assert.deepEqual(events, []);
  for (const url of requests) {
    assert.equal(url.pathname, '/api/v1/messages');
    assert.equal(url.searchParams.get('talker'), TO);
    assert.ok(!url.toString().includes('/push/'));
  }
});

test('already-existing messages in the current second belong to the silent baseline', async () => {
  const controller = new AbortController();
  const currentSecond = Math.floor(Date.now() / 1000);
  let calls = 0;
  const events = [];
  const adapter = client(async url => {
    calls += 1;
    if (calls === 1) assert.ok(Number(url.searchParams.get('end')) >= currentSecond);
    if (calls === 3) setImmediate(() => controller.abort());
    return messageResponse([row('1', { createTime: currentSecond })]);
  });
  await adapter.watch({ to: TO, signal: controller.signal, onEvent: event => events.push(event) });
  assert.deepEqual(events, []);
});

test('watch catches up across every page after a burst larger than thirty messages', async () => {
  const controller = new AbortController();
  const events = [];
  const requests = [];
  const baseTime = Math.floor(Date.now() / 1000) - 10;
  let data = [row('1', { createTime: baseTime })];
  const adapter = client(async url => {
    requests.push(url);
    if (requests.length === 3) data.push(...Array.from({ length: 75 }, (_, index) => row(String(index + 2), { localId: index + 2, createTime: baseTime + 1 })));
    const start = Number(url.searchParams.get('start') ?? 0);
    const end = Number(url.searchParams.get('end'));
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset'));
    const filtered = data.filter(item => item.createTime >= start && item.createTime <= end).reverse();
    return messageResponse(filtered.slice(offset, offset + limit), offset + limit < filtered.length);
  }, { pageSize: 7 });
  await adapter.watch({ to: TO, signal: controller.signal, onEvent: event => {
    events.push(event);
    if (events.length === 75) controller.abort();
  } });
  assert.equal(events.length, 75);
  assert.equal(new Set(events.map(event => event.id)).size, 75);
  assert.ok(!events.some(event => event.id === '1'));
  assert.ok(requests.some(url => Number(url.searchParams.get('offset')) >= 70));
  const pollEnds = requests.slice(2).map(url => url.searchParams.get('end'));
  assert.equal(new Set(pollEnds).size, 1);
});

test('overlap deduplicates existing IDs while admitting late messages with the same text', async () => {
  const controller = new AbortController();
  const events = [];
  const baseTime = Math.floor(Date.now() / 1000) - 10;
  let calls = 0;
  const adapter = client(async () => {
    calls += 1;
    const baseline = row('1', { createTime: baseTime });
    if (calls < 3) return messageResponse([baseline]);
    const newest = row('2', { createTime: baseTime + 1 });
    const late = row('3', { createTime: baseTime - 1 });
    return messageResponse(calls === 3 ? [newest, baseline] : [newest, baseline, late]);
  });
  await adapter.watch({ to: TO, signal: controller.signal, onEvent: event => { events.push(event); if (event.id === '3') controller.abort(); } });
  assert.deepEqual(events.map(event => event.id), ['2', '3']);
});

test('multiple paginated batches in the same second are caught without advancing past later IDs', async () => {
  const controller = new AbortController();
  const events = [];
  const baseTime = Math.floor(Date.now() / 1000) - 10;
  let windows = 0;
  const data = [row('1', { createTime: baseTime })];
  const adapter = client(async url => {
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset'));
    if (limit !== 1 && offset === 0) {
      windows += 1;
      if (windows === 2) data.push(...Array.from({ length: 40 }, (_, index) => row(String(index + 2), { createTime: baseTime + 1 })));
      if (windows === 3) data.push(...Array.from({ length: 30 }, (_, index) => row(String(index + 42), { createTime: baseTime + 1 })));
    }
    const sorted = [...data].reverse();
    return messageResponse(sorted.slice(offset, offset + limit), offset + limit < sorted.length);
  }, { pageSize: 7 });
  await adapter.watch({ to: TO, signal: controller.signal, onEvent: event => { events.push(event); if (events.length === 70) controller.abort(); } });
  assert.ok(windows >= 3);
  assert.equal(events.length, 70);
  assert.equal(new Set(events.map(event => event.id)).size, 70);
  assert.deepEqual(new Set(events.map(event => event.timestamp)), new Set([(baseTime + 1) * 1000]));
});

test('a pagination stall is an explicit error instead of a silent incomplete catch-up', async () => {
  let calls = 0;
  const adapter = client(async () => { calls += 1; return messageResponse([row('1')], calls > 1); });
  await assert.rejects(adapter.watch({ to: TO, onEvent() {} }), { code: 'E_WEFLOW_PAGINATION' });
});

test('request timeout and abort work even when a mock fetch ignores cancellation', async () => {
  await assert.rejects(client(() => new Promise(() => {}), { timeoutMs: 10 }).health(), { code: 'E_WEFLOW_TIMEOUT' });
  const controller = new AbortController();
  const watching = client(() => new Promise(() => {})).watch({ to: TO, signal: controller.signal, onEvent() { assert.fail('no events'); } });
  setImmediate(() => controller.abort());
  await watching;
});

test('HTTP, API and network failures do not copy tokens or response bodies into errors', async () => {
  const cases = [
    async () => { throw new Error(`failure ${TOKEN}`); },
    async () => json({ error: TOKEN }, 401),
    async () => json({ success: false, error: TOKEN }),
    async () => new Response(TOKEN, { status: 200 }),
  ];
  for (const fetchImpl of cases) await assert.rejects(client(fetchImpl).health(), error => !error.message.includes(TOKEN) && !JSON.stringify(error).includes(TOKEN));
});

test('redirect responses and unexpected response origins are denied', async () => {
  await assert.rejects(client(async () => new Response(null, { status: 302, headers: { Location: 'https://example.com' } })).health(), { code: 'E_WEFLOW_REDIRECT' });
  await assert.rejects(client(async () => ({ ok: true, status: 200, redirected: true, url: 'http://example.com', json: async () => ({}) })).health(), { code: 'E_WEFLOW_REDIRECT' });
  await assert.rejects(client(async () => ({ ok: true, status: 200, url: 'http://example.com', json: async () => ({}) })).health(), { code: 'E_WEFLOW_REDIRECT' });
});

test('plain text tokenFile is supported without exposing its content in URLs', async () => {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'wxcc-weflow-token-'));
  try {
    const tokenFile = join(directory, 'token.txt');
    await writeFile(tokenFile, `${TOKEN}\n`);
    const adapter = new WeFlowHttpAdapter({ tokenFile, fetchImpl: async (url, options) => {
      assert.ok(!url.toString().includes(TOKEN));
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      return messageResponse([]);
    } });
    assert.deepEqual((await adapter.history({ to: TO })).messages, []);
  } finally {
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(basename(directory).startsWith('wxcc-weflow-token-'));
    await rm(directory, { recursive: true, force: true });
  }
});
