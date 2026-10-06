import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseService, databaseAlias } from '../src/database-service.mjs';
import { redact } from '../src/privacy.mjs';

const self = 'wxid_demo_self';
const account = { self, pid: 100, generation: 'demo-generation', accountVerified: true, automaticMessagesSent: 0, displayName: '演示账号' };
function harness(extra = {}, options = {}) {
  const database = { relativePath: 'message/message_0.db', path: 'D:\\private\\encrypted.db' };
  const calls = [];
  const deps = {
    readAdapter: {}, accountProvider: async () => account,
    discover: async () => ({ databases: [database] }),
    summary: () => ({ ok: true, accountVerified: false, directoryMatchVerified: true, binding: 'pending-page-auth', databaseCount: 1, databases: [{ encrypted: true, bytes: 4096, index: 0 }] }),
    decrypt: async args => { calls.push(['decrypt', args.databasePath]); if (args.keyProvider) await args.keyProvider({ firstPage: Buffer.alloc(4096), profiles: [] }); await args.beforePublish?.(); return { ok: true, quickCheck: 'ok' }; },
    inspectProvider: async () => ({ ...account, readScopeVerified: true, version: '4.1.15.13', dllSha256: 'a'.repeat(64) }),
    installationDoctor: async () => ({ architecture: 'x64', version: '4.1.15.13', hashes: { dll: 'a'.repeat(64) }, exe: { path: 'D:\\Apps\\Weixin.exe' } }),
    ...extra
  };
  return { service: createDatabaseService(options, deps), calls };
}
test('database aliases survive reordering and remain visible with default privacy', () => {
  const alias = databaseAlias(self, 'message/message_0.db');
  assert.equal(databaseAlias(self, 'message\\message_0.db'), alias);
  assert.notEqual(databaseAlias('wxid_other', 'message/message_0.db'), alias);
  assert.deepEqual(redact({ alias, key: 'hidden', salt: 'hidden' }), { alias, key: '[REDACTED]', salt: '[REDACTED]' });
});
test('discovery exposes stable metadata without claiming cryptographic ownership or leaking paths', async () => {
  const h = harness(); const result = await h.service.execute({ action: 'list' });
  assert.equal(result.accountVerified, false);
  assert.equal(result.databases[0].alias, databaseAlias(self, 'message/message_0.db'));
  assert.equal(result.databases[0].kind, 'message');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(h.calls.length, 0);
});
test('account changes between discovery and use prevent decryption', async () => {
  let count = 0;
  const h = harness({ accountProvider: async () => ++count === 1 ? account : { ...account, self: 'wxid_other' } });
  await assert.rejects(() => h.service.execute({ action: 'decrypt', database: databaseAlias(self, 'message/message_0.db'), output: 'copy.sqlite' }), { code: 'E_DB_ACCOUNT_CHANGED' });
  assert.equal(h.calls.length, 0);
});
test('automatic key is supplied only from matching current runtime and wiped after decryption', async () => {
  const key = Buffer.alloc(32, 0xab);
  const h = harness({ findKey: async ({ accountGuard }) => { await accountGuard(); return { key, mode: 'raw' }; } });
  const result = await h.service.execute({ action: 'decrypt', database: databaseAlias(self, 'message/message_0.db'), output: 'copy.sqlite' });
  assert.equal(result.accountCryptographicBinding, true);
  assert.equal(result.automaticMessagesSent, 0);
  assert.ok(key.equals(Buffer.alloc(32)));
});
test('key-file mode does not scan memory and offline mode never reads a client', async () => {
  const fail = () => { throw new Error('unexpected scan'); };
  const h = harness({ findKey: fail }, { 'key-file': 'private-key.txt' });
  assert.equal((await h.service.execute({ action: 'decrypt', database: databaseAlias(self, 'message/message_0.db'), output: 'copy.sqlite' })).accountCryptographicBinding, false);
  const offline = harness({ accountProvider: fail, discover: fail }, { 'key-file': 'private-key.txt' });
  assert.equal((await offline.service.execute({ action: 'decrypt', input: 'encrypted.db', output: 'copy.sqlite' })).source, 'offline-database-copy');
});
test('online key-file export rechecks owner before publication', async () => {
  let reads = 0;
  const h = harness({ accountProvider: async () => ++reads < 3 ? account : { ...account, self: 'wxid_other' } }, { 'key-file': 'key.txt' });
  await assert.rejects(() => h.service.execute({ action: 'decrypt', database: databaseAlias(self, 'message/message_0.db'), output: 'copy.sqlite' }), { code: 'E_DB_ACCOUNT_CHANGED' });
});
