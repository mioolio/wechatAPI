import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootstrapNativeSend, hasPriorNativeValidation, hasPriorContactValidation } from '../src/native-runtime-bootstrap.mjs';
import { NATIVE_SEND_SCRIPT } from '../src/native-send-adapter.mjs';

const generation = '85bb4adf-6aee-40a9-b3df-12059c29b7b5';
const sha = 'a'.repeat(64);
const source = '/* synthetic send agent source for bootstrap tests */';
const sourceSha = createHash('sha256').update(source, 'utf8').digest('hex');
const id = 'wxid_synthetic_target';
const self = 'wxid_synthetic_self';
const target = { schemaVersion: 2, chatId: id, displayName: '合成联系人', self, sourcePid: 1234, sourceGeneration: generation, version: '4.1.15.13', dllSha256: sha };
function fixture(changes = {}) {
  const calls = [], saves = [], sourceReads = [];
  const host = { pid: 1234, generation, version: '4.1.15.13', dllSha256: sha, status: 'ready', attached: true, verified: true, scripts: [], ...changes.host };
  const descriptor = { host: '127.0.0.1', pid: 1234, generation, ...changes.descriptor };
  const profile = { version: '4.1.15.13', dllSha256: sha, ...changes.profile };
  let runtime = { pid: 1234, generation: null, self, accountVerified: true, dllSha256: sha, version: host.version, ready: false, sendValidated: false, prologuesVerified: true, ...changes.runtime };
  const options = { tokenFile: 'host.json', bindingFile: 'binding.json', targetFile: 'target.json', profileFile: 'profile.json' };
  const deps = {
    readJsonImpl: async path => path === 'target.json' ? changes.target === null ? null : { ...target, ...changes.target } : path === 'host.json' ? descriptor : path === 'binding.json' ? changes.previousBinding : profile,
    readSourceImpl: async path => { sourceReads.push(path); return Object.hasOwn(changes, 'source') ? changes.source : source; },
    saveBindingImpl: async (path, binding) => saves.push({ path, binding }),
    callImpl: async request => {
      calls.push(request);
      if (request.method === 'status') return { success: true, result: host };
      if (request.method === 'load') return { success: true, result: { name: NATIVE_SEND_SCRIPT, loaded: true, sourceSha256: sourceSha, ...changes.loaded } };
      if (request.args.method === 'inspect') return { success: true, result: runtime };
      if (request.args.method === 'contacts') {
        if (changes.contactError) throw Object.assign(new Error('contact task timeout'), { code: 'E_TIMEOUT_UNKNOWN' });
        runtime.contactSnapshotAvailable = true;
        return { success: true, result: { pid: host.pid, generation, scope: 'loaded-contact-cache', complete: false, cacheSnapshotComplete: true, count: 1, contacts: [{ username: id, displayName: '合成联系人' }], ...changes.contactResult } };
      }
      assert.equal(request.args.method, 'prepare');
      const config = request.args.params[0];
      runtime = { ...runtime, ...config, ready: true, sendValidated: config.validatedBinarySha256 === sha, ...changes.prepared };
      return { success: true, result: runtime };
    },
  };
  return { options, deps, calls, saves, sourceReads, host, profile };
}
const evidence = { version: '4.1.15.13', dllSha256: sha, entryRva: '0x54b02f0', nativeEntryCalled: true, status: 'accepted', verifiedAt: '2025-01-01T00:00:00.000Z', requestId: 'synthetic-test-evidence' };
test('bootstrap loads and prepares the fixed agent without sending or manufacturing validation', async () => {
  const fx = fixture();
  const result = await bootstrapNativeSend(fx.options, fx.deps);
  assert.equal(result.prepared, true);
  assert.equal(result.ready, false);
  assert.equal(result.sendValidated, false);
  assert.equal(result.automaticMessagesSent, 0);
  assert.deepEqual(fx.calls.map(call => [call.method, call.args?.method]), [['status', undefined], ['load', undefined], ['rpc', 'inspect'], ['rpc', 'prepare']]);
  assert.equal(fx.calls[1].args.name, NATIVE_SEND_SCRIPT);
  const config = fx.calls.at(-1).args.params[0];
  assert.equal(Object.hasOwn(config, 'validatedBinarySha256'), false);
  assert.deepEqual(fx.saves[0].binding, { pid: 1234, generation, self, chatId: id, sessionId: id, displayName: '合成联系人', version: target.version, dllSha256: sha });
});
test('only matching recorded accepted evidence restores a validated binary flag', async () => {
  const fx = fixture({ profile: { nativeSendValidation: evidence } });
  const result = await bootstrapNativeSend(fx.options, fx.deps);
  assert.equal(result.ready, true);
  assert.equal(result.priorBinaryValidation, true);
  assert.equal(fx.calls.at(-1).args.params[0].validatedBinarySha256, sha);
  assert.equal(fx.calls.some(call => call.args?.method === 'sendText'), false);
});
test('mismatched/incomplete evidence cannot unlock sending', () => {
  const fx = fixture();
  for (const record of [
    { ...evidence, dllSha256: 'b'.repeat(64) }, { ...evidence, status: 'unknown' },
    { ...evidence, verifiedAt: 'bad date' }, { ...evidence, requestId: 123 }, { ...evidence, requestId: 'invalid id' },
    { ...evidence, version: '4.1.15.12' }, { ...evidence, version: undefined },
    { ...evidence, nativeEntryCalled: false }, { ...evidence, nativeEntryCalled: 'true' }, { ...evidence, nativeEntryCalled: undefined },
    { ...evidence, entryRva: '0x54b02f1' }, { ...evidence, entryRva: undefined },
  ]) {
    assert.equal(hasPriorNativeValidation({ ...fx.profile, nativeSendValidation: record }, fx.host), false);
  }
});
test('a valid already bound live3 agent is reused without load, prepare, unload or detach', async () => {
  const fx = fixture({ profile: { nativeSendValidation: evidence }, host: { scripts: [{ name: NATIVE_SEND_SCRIPT, loaded: true, destroyed: false, sourceSha256: sourceSha }] }, runtime: { generation, chatId: id, sessionId: id, displayName: '合成联系人', ready: true, sendValidated: true } });
  const result = await bootstrapNativeSend(fx.options, fx.deps);
  assert.equal(result.ready, true);
  assert.deepEqual(fx.calls.map(call => [call.method, call.args?.method]), [['status', undefined], ['rpc', 'inspect']]);
  assert.equal(fx.saves.length, 1);
  assert.equal(fx.sourceReads.length, 1);
  assert.match(fx.sourceReads[0], /agents[\\/]send-native\.js$/);
});

test('changed local source or missing loaded source hash refuses reuse before any agent RPC', async () => {
  for (const changes of [
    { source: `${source}\n/* changed own-account guard */`, sourceSha256: sourceSha },
    { source, sourceSha256: undefined },
    { source, sourceSha256: 'invalid' },
    { source, sourceSha256: 'c'.repeat(64) },
  ]) {
    const fx = fixture({ source: changes.source, profile: { nativeSendValidation: evidence, nativeContactCacheValidation: contactEvidence }, host: { scripts: [{ name: NATIVE_SEND_SCRIPT, loaded: true, destroyed: false, sourceSha256: changes.sourceSha256 }] } });
    await assert.rejects(bootstrapNativeSend(fx.options, fx.deps), { code: 'E_NATIVE_SOURCE' });
    assert.deepEqual(fx.calls.map(call => call.method), ['status']);
    assert.deepEqual(fx.saves, []);
  }
});

test('actual loaded source identity is checked before inspect, prepare, contacts or binding save', async () => {
  for (const loaded of [
    { sourceSha256: 'c'.repeat(64) }, { sourceSha256: undefined },
    { sourceSha256: 'invalid' }, { name: 'other_agent' },
    { loaded: false }, { loaded: undefined }, { destroyed: true },
  ]) {
    const fx = fixture({ loaded, profile: { nativeSendValidation: evidence, nativeContactCacheValidation: contactEvidence } });
    await assert.rejects(bootstrapNativeSend(fx.options, fx.deps), { code: 'E_NATIVE_SOURCE' });
    assert.deepEqual(fx.calls.map(call => call.method), ['status', 'load']);
    assert.deepEqual(fx.saves, []);
  }
});

test('invalid or oversized source refuses to load or call the agent', async () => {
  for (const invalidSource of [null, Buffer.from(source), 'a'.repeat(1024 * 1024 + 1), '中'.repeat(350000)]) {
    const fx = fixture({ source: invalidSource });
    await assert.rejects(bootstrapNativeSend(fx.options, fx.deps), { code: 'E_NATIVE_SOURCE' });
    assert.deepEqual(fx.calls.map(call => call.method), ['status']);
    assert.deepEqual(fx.saves, []);
  }
});

test('matching source SHA-256 comparison accepts uppercase hex without relaxing source identity', async () => {
  const fx = fixture({ loaded: { sourceSha256: sourceSha.toUpperCase() } });
  assert.equal((await bootstrapNativeSend(fx.options, fx.deps)).prepared, true);
  assert.equal(fx.saves.length, 1);
});

test('missing, duplicate or invalid loaded script metadata is rejected without agent calls', async () => {
  const valid = { name: NATIVE_SEND_SCRIPT, loaded: true, destroyed: false, sourceSha256: sourceSha };
  for (const scripts of [undefined, null, [valid, { ...valid }], [{ ...valid, loaded: 1 }], [{ ...valid, destroyed: undefined }]]) {
    const fx = fixture({ host: { scripts } });
    await assert.rejects(bootstrapNativeSend(fx.options, fx.deps), { code: 'E_NATIVE_SCRIPT_STATE' });
    assert.deepEqual(fx.calls.map(call => call.method), ['status']);
    assert.deepEqual(fx.saves, []);
  }
});

const contactEvidence = { version: '4.1.15.13', dllSha256: sha, agentSourceSha256: sourceSha, native: true, scope: 'loaded-contact-cache', complete: false, cacheSnapshotComplete: true, count: 103, verifiedAt: '2026-10-02T13:09:00.000Z', registryGetterRva: '0x36c7b0', storeGetterRva: '0x6dcf80', accountVtableRva: '0x8dfe2f8', cacheCenterVtableRva: '0x8f9bf98' };
test('a fresh host initializes contacts only with exact DLL and actual loaded source evidence', async () => {
  const fx = fixture({ profile: { nativeContactCacheValidation: contactEvidence } });
  const result = await bootstrapNativeSend(fx.options, fx.deps);
  assert.equal(result.contactSnapshotAvailable, true);
  assert.equal(result.contactCount, 1);
  assert.equal(result.priorContactValidation, true);
  assert.equal(result.automaticMessagesSent, 0);
  assert.equal(fx.calls.filter(call => call.args?.method === 'contacts').length, 1);
  assert.equal(fx.calls.some(call => call.args?.method === 'sendText'), false);
});

test('unvalidated, changed or obsolete cache getters are not automatically called', async () => {
  for (const record of [undefined, { ...contactEvidence, agentSourceSha256: 'c'.repeat(64) }, { ...contactEvidence, dllSha256: 'd'.repeat(64) }, { ...contactEvidence, registryGetterRva: '0x36c740' }, { ...contactEvidence, cacheSnapshotComplete: false }, { ...contactEvidence, cacheCenterVtableRva: '0x8f831e8' }, { ...contactEvidence, verifiedAt: 'bad' }, { ...contactEvidence, count: 0 }]) {
    const fx = fixture({ profile: { nativeContactCacheValidation: record } });
    assert.equal(hasPriorContactValidation(fx.profile, fx.host, sourceSha), false);
    assert.equal((await bootstrapNativeSend(fx.options, fx.deps)).contactSnapshotAvailable, false);
    assert.equal(fx.calls.some(call => call.args?.method === 'contacts'), false);
  }
  for (const sourceSha256 of [undefined, 'c'.repeat(64)]) {
    const fx = fixture({ profile: { nativeContactCacheValidation: contactEvidence }, host: { scripts: [{ name: NATIVE_SEND_SCRIPT, loaded: true, destroyed: false, sourceSha256 }] } });
    await assert.rejects(bootstrapNativeSend(fx.options, fx.deps), { code: 'E_NATIVE_SOURCE' });
    assert.equal(fx.calls.some(call => call.args?.method === 'contacts'), false);
    assert.deepEqual(fx.calls.map(call => call.method), ['status']);
    assert.deepEqual(fx.saves, []);
  }
});

test('already verified cache is reused without additional initialization reads', async () => {
  const fx = fixture({ profile: { nativeContactCacheValidation: contactEvidence }, runtime: { contactSnapshotAvailable: true } });
  assert.equal((await bootstrapNativeSend(fx.options, fx.deps)).contactSnapshotAvailable, true);
  assert.equal(fx.calls.some(call => call.args?.method === 'contacts'), false);
});

test('failed or invalid cache initialization persists a block and cannot be cleared in the same generation', async () => {
  for (const change of [{ contactError: true }, { contactResult: { generation: '00000000-0000-0000-0000-000000000000' } }, { contactResult: { contacts: [{ username: id, displayName: '\ud800' }] } }]) {
    const fx = fixture({ profile: { nativeContactCacheValidation: contactEvidence }, ...change });
    await assert.rejects(bootstrapNativeSend(fx.options, fx.deps));
    assert.equal(fx.saves.length, 1);
    assert.equal(fx.saves[0].binding.runtimeBlocked, true);
    const second = fixture({ previousBinding: fx.saves[0].binding });
    await assert.rejects(bootstrapNativeSend(second.options, second.deps), { code: 'E_NATIVE_RUNTIME_BLOCKED' });
    assert.equal(second.saves.length, 0);
    assert.equal(second.calls.some(call => call.args?.method === 'contacts' || call.args?.method === 'prepare'), false);
  }
});

test('a block from an older generation does not prevent a fresh validated binding', async () => {
  const fx = fixture({ previousBinding: { pid: 1234, generation: '00000000-0000-0000-0000-000000000000', runtimeBlocked: true } });
  await bootstrapNativeSend(fx.options, fx.deps);
  assert.equal(Object.hasOwn(fx.saves[0].binding, 'runtimeBlocked'), false);
});
test('stale host identity, changed binary or broken loaded agent is rejected', async () => {
  for (const changes of [
    { descriptor: { generation: '10000000-0000-0000-0000-000000000000' } },
    { host: { attached: false } },
    { profile: { dllSha256: 'b'.repeat(64) } },
    { host: { scripts: [{ name: NATIVE_SEND_SCRIPT, loaded: false, destroyed: true }] } },
  ]) {
    const fx = fixture(changes);
    await assert.rejects(bootstrapNativeSend(fx.options, fx.deps));
    assert.equal(fx.calls.some(call => call.args?.method === 'sendText'), false);
    assert.equal(fx.saves.length, 0);
  }
});
test('wrong prepared target or unverified native prologues never writes a binding', async () => {
  for (const prepared of [{ self: 'wxid_other_self' }, { accountVerified: false }, { dllSha256: 'c'.repeat(64) }, { chatId: 'wxid_other' }, { sessionId: 'other' }, { generation: '10000000-0000-0000-0000-000000000000' }, { prologuesVerified: false }, { pid: 9999 }]) {
    const fx = fixture({ prepared });
    await assert.rejects(bootstrapNativeSend(fx.options, fx.deps), { code: 'E_NATIVE_SCOPE' });
    assert.equal(fx.saves.length, 0);
  }
});

test('missing explicit target fails before any native host call', async () => {
  const fx = fixture({ target: null });
  await assert.rejects(bootstrapNativeSend(fx.options, fx.deps), { code: 'E_NATIVE_TARGET' });
  assert.deepEqual(fx.calls, []);
  assert.deepEqual(fx.saves, []);
});

test('configuration source PID and generation are evidence and do not prevent a fresh same-account binding', async () => {
  const fx = fixture({ target: { sourcePid: 5678, sourceGeneration: '20000000-0000-0000-0000-000000000001' }, profile: { nativeSendValidation: evidence } });
  assert.equal((await bootstrapNativeSend(fx.options, fx.deps)).ready, true);
  assert.equal(fx.saves[0].binding.pid, fx.host.pid);
  assert.equal(fx.saves[0].binding.self, self);
  assert.equal(fx.calls.some(call => call.args?.method === 'sendText'), false);
});

test('changing explicit target or self cannot reuse a host generation already bound elsewhere', async () => {
  for (const previousBinding of [{ pid: 1234, generation, self: 'wxid_other_self', chatId: id, displayName: target.displayName }, { pid: 1234, generation, self, chatId: 'wxid_other_target', displayName: target.displayName }]) {
    const fx = fixture({ previousBinding });
    await assert.rejects(bootstrapNativeSend(fx.options, fx.deps), { code: 'E_NATIVE_TARGET_CHANGED' });
    assert.deepEqual(fx.calls.map(call => call.method), ['status']);
    assert.deepEqual(fx.saves, []);
  }
});

test('an already validated agent cannot replace missing binary validation evidence', async () => {
  const fx = fixture({ runtime: { generation, chatId: id, sessionId: id, displayName: target.displayName, ready: true, sendValidated: true } });
  const result = await bootstrapNativeSend(fx.options, fx.deps);
  assert.equal(result.ready, false);
  assert.equal(result.priorBinaryValidation, false);
  assert.equal(Object.hasOwn(fx.saves[0].binding, 'validatedBinarySha256'), false);
});
