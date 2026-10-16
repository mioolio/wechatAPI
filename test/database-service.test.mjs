import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseService, databaseAlias } from '../src/database-service.mjs';
import { redact } from '../src/privacy.mjs';

const self = 'wxid_demo_self';
const account = { self, pid: 100, generation: 'demo-generation', bindingRevision: 1, accountVerified: true, automaticMessagesSent: 0, displayName: '演示账号' };
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
  assert.equal(result.databases[0].role, 'message-history');
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

test('simple decryption auto-selects a primary database and permits key-only output', async () => {
  let received;
  const h = harness({ decrypt: async args => { received = args; await args.beforePublish(); return { ok: true, keyAuthenticated: true, key: 'ab'.repeat(32) }; } }, { 'key-file': 'private-key.txt' });
  const result = await h.service.execute({ action: 'decrypt', autoSelect: true, keyOnly: true, showKey: true });
  assert.equal(result.databaseAlias, databaseAlias(self, 'message/message_0.db'));
  assert.equal(result.source, 'current-account-database-key');
  assert.equal(result.keyAuthenticated, true);
  assert.equal(received.output, undefined);
  assert.equal(received.keyOnly, true);
  assert.equal(received.includeKey, true);
});

test('automatic selection prefers the session database and excludes search indexes', async () => {
  const rows = ['message/message_fts.db', 'message/message_0.db', 'session/session.db'].map(relativePath => ({ relativePath, path: `D:\\synthetic\\${relativePath}` }));
  const h = harness({
    discover: async () => ({ databases: rows }),
    summary: () => ({ databases: rows.map(() => ({ encrypted: true })) }),
  }, { 'key-file': 'private-key.txt' });
  const result = await h.service.execute({ action: 'decrypt', autoSelect: true, keyOnly: true, showKey: true });
  assert.equal(result.databaseAlias, databaseAlias(self, 'session/session.db'));
  assert.equal(h.calls[0][1], 'D:\\synthetic\\session/session.db');
});

test('a changed binding revision blocks automatic key scanning even when self and generation match', async () => {
  let scans = 0;
  const h = harness({
    inspectProvider: async () => ({ ...account, bindingRevision: 2, readScopeVerified: true, version: '4.1.15.13', dllSha256: 'a'.repeat(64) }),
    findKey: async () => { scans++; throw new Error('key scan must not start'); },
  });
  await assert.rejects(h.service.execute({ action: 'decrypt', database: databaseAlias(self, 'message/message_0.db'), output: 'copy.sqlite' }), { code: 'E_DB_ACCOUNT_CHANGED' });
  assert.equal(scans, 0);
});

test('the key-scan account guard rejects a revision change without publishing a copy', async () => {
  let revision = 1, scans = 0, published = false;
  const h = harness({
    accountProvider: async () => ({ ...account, bindingRevision: revision }),
    findKey: async ({ accountGuard }) => {
      scans++;
      revision = 2;
      await accountGuard();
      throw new Error('changed binding must not produce a key');
    },
    decrypt: async args => {
      await args.keyProvider({ firstPage: Buffer.alloc(4096), profiles: [] });
      await args.beforePublish();
      published = true;
      return { ok: true, quickCheck: 'ok' };
    },
  });
  await assert.rejects(h.service.execute({ action: 'decrypt', database: databaseAlias(self, 'message/message_0.db'), output: 'copy.sqlite' }), { code: 'E_DB_ACCOUNT_CHANGED' });
  assert.equal(scans, 1);
  assert.equal(published, false);
});

test('a revision change after key acquisition prevents publication and wipes acquired secrets', async () => {
  let revision = 1, published = false;
  const key = Buffer.alloc(32, 0xab), salt = Buffer.alloc(16, 0xcd);
  const h = harness({
    accountProvider: async () => ({ ...account, bindingRevision: revision }),
    findKey: async ({ accountGuard }) => { await accountGuard(); return { key, salt, mode: 'raw' }; },
    decrypt: async args => {
      await args.keyProvider({ firstPage: Buffer.alloc(4096), profiles: [] });
      revision = 2;
      await args.beforePublish();
      published = true;
      return { ok: true, quickCheck: 'ok' };
    },
  });
  await assert.rejects(h.service.execute({ action: 'decrypt', database: databaseAlias(self, 'message/message_0.db'), output: 'copy.sqlite' }), { code: 'E_DB_ACCOUNT_CHANGED' });
  assert.equal(published, false);
  assert.ok(key.equals(Buffer.alloc(32)));
  assert.ok(salt.equals(Buffer.alloc(16)));
});
