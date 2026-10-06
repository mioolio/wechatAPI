import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeSendAdapter, requireContactSnapshot } from '../src/native-send-adapter.mjs';
import { recipientAlias } from '../src/recipient-registry.mjs';

const generation = '85bb4adf-6aee-40a9-b3df-12059c29b7b5';
const chatId = 'wxid_authorized_fixture';
const sessionId = '0x10000000001';
const self = 'fixture_self';
const target = { schemaVersion: 2, chatId, displayName: '合成联系人', self, sourcePid: 1234, sourceGeneration: generation, version: '4.1.15.13', dllSha256: 'a'.repeat(64) };
function fixture(changes = {}) {
  const calls = [];
  const records = new Map();
  const journal = changes.journal ?? {
    reserve: async record => { if (records.has(record.requestId)) throw Object.assign(new Error('already reserved'), { code: 'E_SEND_REQUEST_REUSED' }); records.set(record.requestId, { ...record, status: 'reserved' }); },
    finish: async (id, result) => records.set(id, { ...records.get(id), ...result }),
    get: async id => records.get(id) ?? null,
  };
  const binding = { pid: 1234, generation, self, chatId, sessionId, displayName: '合成联系人', version: target.version, dllSha256: target.dllSha256, validatedBinarySha256: target.dllSha256, ...changes.binding };
  const descriptor = { host: '127.0.0.1', port: 5001, token: 'b'.repeat(64), pid: 1234, generation, version: '4.1.15.13', dllSha256: 'a'.repeat(64), ...changes.descriptor };
  const host = { pid: 1234, generation, status: 'ready', attached: true, verified: true, version: '4.1.15.13', dllSha256: 'a'.repeat(64), ...changes.host };
  const runtime = { pid: 1234, generation, self, accountVerified: true, dllSha256: target.dllSha256, ready: true, sendValidated: true, chatId, sessionId, displayName: '合成联系人', version: '4.1.15.13', prologuesVerified: true, ...changes.runtime };
  const readRuntime = { ...runtime, ready: true, self: 'fixture_self', accountVerified: true, readScopeVerified: true, automaticMessagesSent: 0, dllSha256: 'a'.repeat(64), historyAvailable: false, ...changes.readRuntime };
  const adapter = new NativeSendAdapter({
    tokenFile: 'host.json', bindingFile: 'binding.json', targetFile: 'target.json',
    registry: changes.registry,
    journal,
    readJsonImpl: async path => path === 'host.json' ? descriptor : path === 'target.json' ? { ...target, ...changes.target } : binding,
    callImpl: async request => {
      calls.push(request);
      if (changes.call) return changes.call(request, { calls, host, runtime, readRuntime });
      if (request.method === 'status') return { success: true, result: host };
      if (request.args.method === 'inspect') return { success: true, result: request.args.name === 'readnative_live3' ? readRuntime : runtime };
      if (request.args.name === 'readnative_live3' && request.args.method === 'contacts') return { success: true, result: { ...contactSnapshot(), self: readRuntime.self, automaticMessagesSent: 0 } };
      return { success: true, result: { requestId: request.args.params[0].requestId, status: 'accepted', chatId, sessionId, native: true, ...changes.sendResult } };
    },
  });
  return { adapter, calls, binding, descriptor, host, runtime, journal, records };
}
const sendCalls = calls => calls.filter(call => call.args?.method === 'sendText');

test('reverse send reuses the host and accepts only the verified bound chat', async () => {
  const fx = fixture();
  const result = await fx.adapter.send({ to: chatId, text: 'mock-only', requestId: 'Test-ID' });
  assert.equal(result.status, 'accepted');
  assert.equal(result.native, true);
  assert.equal(result.deliveryConfirmed, false);
  assert.deepEqual(fx.calls.map(call => [call.method, call.args?.method]), [['status', undefined], ['rpc', 'inspect'], ['rpc', 'sendText']]);
  assert.deepEqual(sendCalls(fx.calls)[0], { tokenFile: 'host.json', method: 'rpc', requestId: 'test-id', args: { name: 'sendnative_live3', method: 'sendText', params: [{ to: chatId, text: 'mock-only', requestId: 'test-id' }] } });
  await fx.adapter.close();
  assert.equal(fx.calls.length, 3);
});
test('bound internal session ID maps to the same authorized chat without numeric conversion', async () => {
  const fx = fixture({ binding: { sessionId: '0018446744073709551615' }, runtime: { sessionId: '0018446744073709551615' }, sendResult: { sessionId: '0018446744073709551615' } });
  const result = await fx.adapter.send({ session: '0018446744073709551615', text: 'mock', requestId: 'unique' });
  assert.equal(result.sessionId, '0018446744073709551615');
  assert.equal(sendCalls(fx.calls)[0].args.params[0].to, chatId);
});
test('nickname, other contact and ambiguous targets fail before native send', async () => {
  for (const args of [{ to: '合成联系人' }, { to: 'wxid_other' }, { session: '0xother' }, { to: chatId, session: sessionId }, {}, { to: 1234 }]) {
    const fx = fixture();
    await assert.rejects(fx.adapter.send({ ...args, text: 'mock' }));
    assert.equal(sendCalls(fx.calls).length, 0);
  }
});
test('stale generation or mismatched runtime binding prevents sendText', async () => {
  for (const changes of [
    { descriptor: { generation: '10000000-0000-0000-0000-000000000000' } },
    { host: { pid: 9999 } },
    { host: { status: 'detached', attached: false } },
    { runtime: { generation: '10000000-0000-0000-0000-000000000000' } },
    { runtime: { chatId: 'wxid_other' } },
    { runtime: { sessionId: 1234 } },
    { runtime: { displayName: 'other' } },
    { runtime: { version: '4.1.10.27' } },
  ]) {
    const fx = fixture(changes);
    await assert.rejects(fx.adapter.send({ to: chatId, text: 'mock' }));
    assert.equal(sendCalls(fx.calls).length, 0);
  }
});
test('only strict true flags unlock CLI send after real validation', async () => {
  for (const runtime of [{ ready: false }, { ready: 'true' }, { sendValidated: false }, { sendValidated: 1 }, { prologuesVerified: false }, { prologuesVerified: 'true' }]) {
    const fx = fixture({ runtime });
    assert.equal((await fx.adapter.doctor()).sendAvailable, false);
    await assert.rejects(fx.adapter.send({ to: chatId, text: 'mock' }), { code: 'E_NATIVE_SEND_NOT_READY' });
    assert.equal(sendCalls(fx.calls).length, 0);
  }
});
test('invalid configuration, text or request ID never invokes sendText', async () => {
  for (const changes of [{ binding: { displayName: 'another user' } }, { binding: { chatId: 'nickname with spaces' } }, { binding: { sessionId: 9007199254740991 } }, { binding: { generation: 'not-generation' } }]) {
    const fx = fixture(changes);
    await assert.rejects(fx.adapter.send({ to: chatId, text: 'mock' }));
    assert.equal(sendCalls(fx.calls).length, 0);
  }
  for (const args of [{ text: '' }, { text: ' '.repeat(4) }, { text: 'x'.repeat(1025) }, { text: '正文'.repeat(171) }, { text: 'before\0after' }, { text: '\ud800' }, { text: '\udc00' }, { text: 'prefix\ud800suffix' }, { text: 'mock', requestId: 123 }, { text: 'mock', requestId: 'invalid id' }]) {
    const fx = fixture();
    await assert.rejects(fx.adapter.send({ to: chatId, ...args }));
    assert.equal(fx.calls.length, 0);
  }
});
test('exact UTF-8 byte boundary and paired Unicode surrogates preserve the complete message', async () => {
  const fx = fixture();
  const text = '😀'.repeat(256);
  assert.equal(Buffer.byteLength(text, 'utf8'), 1024);
  const result = await fx.adapter.send({ to: chatId, text, requestId: 'boundary' });
  assert.equal(result.status, 'accepted');
  assert.equal(sendCalls(fx.calls)[0].args.params[0].text, text);
});
test('unknown transport result is never automatically retried', async () => {
  let attempts = 0;
  const fx = fixture({ call: async request => {
    if (request.method === 'status') return { success: true, result: fixture().host };
    if (request.args.method === 'inspect') return { success: true, result: fixture().runtime };
    attempts++;
    throw Object.assign(new Error('outcome unknown'), { code: 'E_TRANSPORT_UNKNOWN' });
  } });
  await assert.rejects(fx.adapter.send({ to: chatId, text: 'mock', requestId: 'unique' }), { code: 'E_TRANSPORT_UNKNOWN' });
  assert.equal(attempts, 1);
});
test('host unknown result includes its request ID in the surfaced CLI message', async () => {
  const fx = fixture({ call: async (request, state) => {
    if (request.method === 'status') return { success: true, result: state.host };
    if (request.args.method === 'inspect') return { success: true, result: state.runtime };
    return { success: false, requestId: request.requestId, requestStatus: 'unknown', error: { code: 'E_TIMEOUT_UNKNOWN', message: 'timed out' } };
  } });
  await assert.rejects(fx.adapter.send({ to: chatId, text: 'mock', requestId: 'recoverable-id' }), error => error.code === 'E_TIMEOUT_UNKNOWN' && error.message.includes('recoverable-id'));
  assert.equal(sendCalls(fx.calls).length, 1);
});
test('failed, unknown or mismatched native receipts do not print successful delivery', async () => {
  for (const sendResult of [{ status: 'unknown' }, { status: 'failed' }, { native: false }, { chatId: 'other' }, { sessionId: 'other' }, { requestId: 'other' }]) {
    const fx = fixture({ sendResult });
    await assert.rejects(fx.adapter.send({ to: chatId, text: 'mock', requestId: 'unique' }));
    assert.equal(sendCalls(fx.calls).length, 1);
  }
});

test('ids performs only verified reads and registers a stable user number', async () => {
  const registered = [];
  const fx = fixture({ registry: { read: async () => {}, register: async row => { registered.push(row); return { alias: recipientAlias(row.id), displayName: row.displayName }; } } });
  const result = await fx.adapter.ids({ keyword: '合成联系人' });
  assert.deepEqual(registered, [{ id: chatId, displayName: '合成联系人' }]);
  assert.equal(result.users[0].alias, recipientAlias(chatId));
  assert.equal(result.users[0].chatId, chatId);
  assert.equal(result.users[0].canSend, true);
  assert.equal(result.automaticMessagesSent, 0);
  assert.equal(sendCalls(fx.calls).length, 0);
});

test('registered SHA-256 aliases resolve internally without expanding target authorization', async () => {
  for (const resolved of [chatId, 'wxid_other_contact', undefined]) {
    const alias = recipientAlias(resolved ?? 'wxid_unknown');
    const fx = fixture({ registry: { read: async () => {}, resolve: value => value === alias ? resolved : undefined } });
    if (resolved === chatId) {
      const result = await fx.adapter.send({ to: alias, text: 'mock-only', requestId: 'alias-test' });
      assert.equal(result.alias, alias);
      assert.equal(sendCalls(fx.calls)[0].args.params[0].to, chatId);
    } else {
      await assert.rejects(fx.adapter.send({ to: alias, text: 'mock-only' }));
      assert.equal(sendCalls(fx.calls).length, 0);
    }
  }
});

test('user number maps to the bound internal session ID when --session is chosen', async () => {
  const fx = fixture({ registry: { read: async () => {}, resolve: () => chatId } });
  const receipt = await fx.adapter.send({ session: recipientAlias(chatId), text: 'mock-only', requestId: 'alias-session' });
  assert.equal(receipt.sessionId, sessionId);
  assert.equal(sendCalls(fx.calls)[0].args.params[0].to, chatId);
});

test('journal reserves before native send and blocks a repeated ID across changed host state', async () => {
  const fx = fixture();
  await fx.adapter.send({ to: chatId, text: 'private body', requestId: 'durable-test' });
  assert.equal(fx.records.get('durable-test').status, 'accepted');
  assert.equal(fx.records.get('durable-test').textHash.length, 64);
  assert.equal(JSON.stringify(fx.records.get('durable-test')).includes('private body'), false);
  const second = fixture({ journal: fx.journal });
  await assert.rejects(second.adapter.send({ to: chatId, text: 'other text', requestId: 'DURABLE-TEST' }), { code: 'E_SEND_REQUEST_REUSED' });
  assert.equal(sendCalls(second.calls).length, 0);
});

test('journal failure prevents native entry, and unknown outcomes are retained without retry', async () => {
  const blocked = fixture({ journal: { reserve: async () => { throw new Error('disk failed'); } } });
  await assert.rejects(blocked.adapter.send({ to: chatId, text: 'mock' }));
  assert.equal(sendCalls(blocked.calls).length, 0);
  const unknown = fixture({ sendResult: { status: 'unknown' } });
  await assert.rejects(unknown.adapter.send({ to: chatId, text: 'mock', requestId: 'unknown-persisted' }), { code: 'E_NATIVE_OUTCOME_UNKNOWN' });
  assert.equal((await unknown.adapter.sendStatus({ requestId: 'unknown-persisted' })).status, 'unknown');
  assert.equal(sendCalls(unknown.calls).length, 1);
  const count = unknown.calls.length;
  await assert.rejects(unknown.adapter.sendStatus({ requestId: 'missing-record' }), { code: 'E_SEND_REQUEST_UNKNOWN' });
  assert.equal(unknown.calls.length, count);
});

function contactSnapshot(contacts = [{ username: chatId, displayName: '合成联系人' }]) {
  return { pid: 1234, generation, scope: 'loaded-contact-cache', complete: false, cacheSnapshotComplete: true, count: contacts.length, contacts };
}
function snapshotFixture(snapshot, changes = {}) {
  const registered = [];
  const fx = fixture({
    registry: { read: async () => {}, register: async row => { registered.push(row); return { alias: recipientAlias(row.id), displayName: row.displayName }; } },
    runtime: { contactSnapshotAvailable: true },
    ...changes,
    call: async (request, state) => {
      if (request.method === 'status') return { success: true, result: state.host };
      if (request.args.method === 'inspect') return { success: true, result: request.args.name === 'readnative_live3' ? state.readRuntime : state.runtime };
      assert.equal(request.args.method, 'contacts');
      return { success: true, result: { ...snapshot, self: state.readRuntime.self, automaticMessagesSent: 0 } };
    },
  });
  return { ...fx, registered };
}
test('native contact snapshot validation requires exact runtime identity, bounds and complete rows', () => {
  const runtime = { pid: 1234, generation };
  assert.deepEqual([...requireContactSnapshot(contactSnapshot(), runtime)], [chatId]);
  assert.deepEqual([...requireContactSnapshot(contactSnapshot([]), runtime)], []);
  const valid = contactSnapshot();
  for (const snapshot of [
    null, { ...valid, pid: 5678 }, { ...valid, generation: 'other' }, { ...valid, scope: 'all-contacts' },
    { ...valid, complete: true }, { ...valid, cacheSnapshotComplete: false }, { ...valid, count: '1' },
    { ...valid, count: 4097, contacts: Array(4097).fill(valid.contacts[0]) }, { ...valid, contacts: {} },
    contactSnapshot([valid.contacts[0], valid.contacts[0]]),
    ...[{ username: 123 }, { username: 'invalid id' }, { displayName: 123 }, { displayName: '\ud800' }, { displayName: 'a\0b' }, { displayName: 'x'.repeat(4097) }].map(row => contactSnapshot([{ ...valid.contacts[0], ...row }])),
  ]) assert.throws(() => requireContactSnapshot(snapshot, runtime), { code: 'E_CONTACT_SNAPSHOT' });
});
test('ids validates the entire native contact batch before saving even the first valid row', async () => {
  for (const invalidLast of [null, { username: 'invalid id', displayName: '另一个名字' }, { username: 'other_account', displayName: '\ud800' }, { username: chatId, displayName: '重复' }]) {
    const fx = snapshotFixture(contactSnapshot([{ username: chatId, displayName: '合成联系人' }, invalidLast]));
    await assert.rejects(fx.adapter.ids(), { code: 'E_CONTACT_SNAPSHOT' });
    assert.deepEqual(fx.registered, []);
    assert.equal(fx.calls.filter(call => call.args?.method === 'contacts').length, 1);
    assert.equal(sendCalls(fx.calls).length, 0);
    assert.equal(fx.records.size, 0);
  }
});
test('ids preserves complete names, registers all valid cache rows and grants sending only to bound target', async () => {
  const snapshot = contactSnapshot([{ username: 'custom_contact', displayName: '其他联系人 完整姓名 👩‍💻' }, { username: chatId, displayName: '合成联系人' }]);
  const fx = snapshotFixture(snapshot);
  const result = await fx.adapter.ids();
  assert.equal(result.scope, 'loaded-contact-cache');
  assert.equal(result.complete, false);
  assert.deepEqual(fx.registered, [{ id: 'custom_contact', displayName: '其他联系人 完整姓名 👩‍💻' }, { id: chatId, displayName: '合成联系人' }]);
  const foreign = result.users.find(row => row.chatId === 'custom_contact');
  assert.equal(foreign.displayName, '其他联系人 完整姓名 👩‍💻');
  assert.equal(foreign.alias, recipientAlias('custom_contact'));
  assert.equal(foreign.canSend, false);
  const authorized = result.users.find(row => row.chatId === chatId);
  assert.equal(authorized.canSend, true);
  assert.equal(authorized.sessionId, sessionId);
  assert.equal(sendCalls(fx.calls).length, 0);
});
test('a blocked send binding does not disable independently verified read contacts or permit sending', async () => {
  const fx = snapshotFixture(contactSnapshot(), { binding: { runtimeBlocked: true } });
  const result = await fx.adapter.ids();
  assert.equal(result.users.every(row => row.canSend === false), true);
  assert.equal(fx.calls.filter(call => call.args?.method === 'contacts' && call.args.name === 'readnative_live3').length, 1);
  assert.equal(fx.registered.length, 1);
  assert.equal(fx.records.size, 0);
  await assert.rejects(fx.adapter.send({ to: chatId, text: 'mock-only', requestId: 'blocked-no-entry' }), { code: 'E_NATIVE_SEND_NOT_READY' });
  assert.equal(sendCalls(fx.calls).length, 0);
  assert.equal(fx.records.size, 0);
});

test('unfinished native work blocks reads and sending even without a persisted block file', async () => {
  for (const pending of [{ pendingTasks: 1, pendingCallbacks: 0 }, { pendingTasks: 0, pendingCallbacks: 1 }]) {
    const fx = snapshotFixture(contactSnapshot(), { runtime: { contactSnapshotAvailable: true, ...pending } });
    await assert.rejects(fx.adapter.ids(), { code: 'E_NATIVE_READ_BUSY' });
    await assert.rejects(fx.adapter.send({ to: chatId, text: 'mock-only', requestId: 'unfinished-no-entry' }), { code: 'E_NATIVE_SEND_NOT_READY' });
    assert.equal(fx.calls.some(call => call.args?.method === 'contacts'), false);
    assert.equal(sendCalls(fx.calls).length, 0);
    assert.equal(fx.records.size, 0);
  }
});

test('missing target and a changed self fail before send-host calls or journal writes', async () => {
  for (const changes of [{ target: { schemaVersion: 1 } }, { binding: { self: 'wxid_other_self' } }, { binding: { self: undefined } }]) {
    const fx = fixture(changes);
    await assert.rejects(fx.adapter.send({ to: chatId, text: 'synthetic-only', requestId: 'no-target-or-self' }));
    assert.deepEqual(fx.calls, []);
    assert.equal(fx.records.size, 0);
  }
});

test('unverified account or altered binary cannot grant native send capability', async () => {
  for (const changes of [{ runtime: { self: 'wxid_other_self' } }, { runtime: { accountVerified: false } }, { runtime: { dllSha256: 'c'.repeat(64) } }, { descriptor: { dllSha256: 'c'.repeat(64) } }, { binding: { validatedBinarySha256: undefined } }]) {
    const fx = fixture(changes);
    await assert.rejects(fx.adapter.send({ to: chatId, text: 'synthetic-only', requestId: 'unverified-binary-or-self' }));
    assert.equal(sendCalls(fx.calls).length, 0);
    assert.equal(fx.records.size, 0);
  }
});

test('ids reports canSend false when independently verified reading belongs to another current self', async () => {
  const fx = fixture({ registry: { read: async () => {}, register: async row => ({ alias: recipientAlias(row.id), displayName: row.displayName }) }, readRuntime: { self: 'wxid_other_self' } });
  const result = await fx.adapter.ids();
  assert.equal(result.users.every(row => row.canSend === false), true);
  assert.equal(sendCalls(fx.calls).length, 0);
});
