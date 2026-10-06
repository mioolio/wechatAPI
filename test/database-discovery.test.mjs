import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { databaseRootCandidates, discoverDatabases, databaseDiscoverySummary } from '../src/database-discovery.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxcc-db-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function account(root, name) {
  const folder = path.join(root, name), storage = path.join(folder, 'db_storage', 'message');
  await fs.mkdir(storage, { recursive: true });
  await fs.writeFile(path.join(storage, 'message_0.db'), Buffer.alloc(4096, 1));
  await fs.writeFile(path.join(storage, 'message_0.db-wal'), Buffer.alloc(32, 2));
  return folder;
}
const codeIs = code => error => error.code === code;

test('discovery selects exact current identity; public JSON never reveals paths or headers', async t => {
  const root = await fixture(t);
  await account(root, 'synthetic_self'); await account(root, 'synthetic_other');
  const result = await discoverDatabases({ basePath: root, currentAccount: { username: 'synthetic_self' }, platform: 'linux', home: path.join(root, 'nonexistent') });
  assert.equal(result.databaseCount, 1); assert.equal(result.username, 'synthetic_self');
  assert.equal(result.databases[0].header.length, 32); assert.equal(result.databases[0].walBytes, 32);
  const json = JSON.stringify(result);
  assert.equal(json.includes('synthetic_self'), false); assert.equal(json.includes(JSON.stringify(root).slice(1, -1)), false);
  assert.equal(json.includes(JSON.stringify(await fs.realpath(root)).slice(1, -1)), false);
  assert.equal(json.includes('header'), false); assert.equal(json.includes('message_0'), false);
  assert.equal(databaseDiscoverySummary(result).accountVerified, true);
});

test('suffix/recency cannot select an account without exact provider directory binding', async t => {
  const root = await fixture(t); const directory = await account(root, 'synthetic_self_random');
  const options = { basePath: root, currentAccount: { username: 'synthetic_self' }, platform: 'linux', home: path.join(root, 'none') };
  await assert.rejects(discoverDatabases(options), codeIs('E_DB_NOT_FOUND'));
  await assert.rejects(discoverDatabases({ ...options, accountDir: directory }), codeIs('E_DB_ACCOUNT_BINDING'));
  const result = await discoverDatabases({ ...options, currentAccount: { ...options.currentAccount, accountDirectoryName: 'synthetic_self_random' } });
  const canonicalDirectory = await fs.realpath(directory);
  assert.equal(result.accountDir, canonicalDirectory);
  assert.equal(JSON.stringify(result).includes(JSON.stringify(canonicalDirectory).slice(1, -1)), false);
  const byIdentityProvider = await discoverDatabases({ ...options, accountDir: directory, resolveAccountIdentity: async () => ({ username: 'synthetic_self', accountDirectoryName: 'synthetic_self_random' }) });
  assert.equal(byIdentityProvider.accountDir, canonicalDirectory);
  assert.equal(JSON.stringify(byIdentityProvider).includes(JSON.stringify(canonicalDirectory).slice(1, -1)), false);
});

test('candidate roots honor redirected Documents, registry custom paths, and in-memory config', async t => {
  const root = await fixture(t);
  const values = { Personal: '%TEST_DOCUMENTS%', FileSavePath: path.join(root, 'custom') };
  const candidates = await databaseRootCandidates({ home: path.join(root, 'home'), env: { TEST_DOCUMENTS: path.join(root, 'redirected') }, platform: 'win32', configuration: { dbPath: path.join(root, 'configured') }, registryReader: async (_key, value) => values[value] });
  assert.equal(candidates[0].source, 'configuration');
  assert.ok(candidates.some(item => item.path === path.join(root, 'redirected', 'xwechat_files')));
  assert.ok(candidates.some(item => item.path === path.join(root, 'custom', 'xwechat_files')));
});

test('identity traversal, wrong explicit directory, and duplicate matching roots fail', async t => {
  const root = await fixture(t); await account(root, 'self'); const other = await account(root, 'other');
  const base = { basePath: root, platform: 'linux', home: path.join(root, 'none') };
  await assert.rejects(discoverDatabases({ ...base, currentAccount: { username: '../self' } }), codeIs('E_DB_ACCOUNT'));
  await assert.rejects(discoverDatabases({ ...base, currentAccount: { username: 'self' }, accountDir: other }), codeIs('E_DB_ACCOUNT_BINDING'));
  const another = path.join(root, 'another'); await account(another, 'self');
  await assert.rejects(discoverDatabases({ ...base, configuration: { dbPath: another }, currentAccount: { username: 'self' } }), codeIs('E_DB_AMBIGUOUS'));
});

test('automatic strict suffix lookup remains pending until PID/account/page authentication', async t => {
  const root = await fixture(t); await account(root, 'synthetic_self_ab123'); await account(root, 'other_ab123');
  const options = { basePath: root, currentAccount: { self: 'synthetic_self' }, allowCryptographicBinding: true, platform: 'linux', home: path.join(root, 'none') };
  const result = await discoverDatabases(options);
  const summary = databaseDiscoverySummary(result);
  assert.equal(summary.directoryMatchVerified, true); assert.equal(summary.accountVerified, false);
  assert.equal(summary.cryptographicAccountVerified, false); assert.equal(summary.binding, 'pending-page-auth');
  assert.equal(JSON.stringify(summary).includes('synthetic_self'), false);
  const direct = await discoverDatabases({ ...options, basePath: result.accountDir });
  assert.equal(direct.accountDir, result.accountDir); assert.equal(direct.accountVerified, false);
  await account(root, 'synthetic_self_cd456');
  await assert.rejects(discoverDatabases(options), codeIs('E_DB_AMBIGUOUS'));
});
