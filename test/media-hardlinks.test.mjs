import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareMediaHardlinks } from '../src/media-hardlinks.mjs';
import { databaseAlias } from '../src/database-service.mjs';
import { recipientAlias } from '../src/recipient-registry.mjs';

const self = 'wxid_synthetic_self', pid = 1234, generation = '10000000-0000-4000-8000-000000000001';
const md5 = '1234567890abcdef1234567890abcdef', directory = 'a'.repeat(32), basename = `${'b'.repeat(32)}_h.dat`;
async function fixture(t, changes = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'wxcc-hardlinks-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const root = path.join(folder, `${self}_0123`), temporaryRoot = path.join(folder, 'snapshots');
  await mkdir(root);
  const account = { self, pid, generation, bindingRevision: 1, accountVerified: true, automaticMessagesSent: 0 };
  let guards = 0;
  const calls = [];
  const dependencies = {
    temporaryRoot,
    accountProvider: async () => ({ ...account, ...(changes.account?.(++guards) ?? {}) }),
    createDatabaseService: (options, deps) => ({
      async execute(args) {
        calls.push({ options, args });
        await deps.accountProvider();
        const db = new DatabaseSync(args.output);
        try {
          db.exec('CREATE TABLE dir2id(username TEXT PRIMARY KEY); CREATE TABLE image_hardlink_info_v4(md5 TEXT, file_name TEXT, dir1 INTEGER, dir2 INTEGER);');
          db.prepare('INSERT INTO dir2id(rowid,username) VALUES (?,?)').run(1, directory);
          db.prepare('INSERT INTO dir2id(rowid,username) VALUES (?,?)').run(2, changes.month ?? '2026-10');
          const insert = db.prepare('INSERT INTO image_hardlink_info_v4(md5,file_name,dir1,dir2) VALUES (?,?,1,2)');
          insert.run(md5, changes.filename ?? basename);
          insert.run('f'.repeat(32), `${'c'.repeat(32)}.dat`);
          changes.mutateDb?.(db);
        } finally { db.close(); }
        return { ok: true, source: 'current-account-database-copy', databaseAlias: databaseAlias(self, 'hardlink/hardlink.db'), accountAlias: recipientAlias(self), accountCryptographicBinding: true, binding: 'current-process-page-auth', quickCheck: 'ok', ...changes.verified };
      },
      async close() { calls.push('close'); },
    }),
  };
  return { folder, root, temporaryRoot, calls, dependencies, input: { self, pid, generation, bindingRevision: 1, mediaRoot: root, md5s: [md5] } };
}

test('hardlink resolver maps exact message MD5 through directory rowids to independent cache filenames', async t => {
  const fx = await fixture(t);
  const result = await prepareMediaHardlinks({ ...fx.input, md5s: [md5.toUpperCase(), md5] }, fx.dependencies);
  assert.equal(result.root, fx.root);
  assert.equal(result.count, 1);
  assert.deepEqual(result.resolveLocalPaths({ md5 }), [path.join(fx.root, 'msg', 'attach', directory, '2026-10', 'Img', basename)]);
  assert.deepEqual(result.resolveLocalPaths({ md5: 'f'.repeat(32) }), [], 'unrequested MD5 rows are never loaded');
  assert.deepEqual(result.resolveLocalPaths({ md5: 'not-an-md5' }), []);
  assert.equal(fx.calls[0].args.database, databaseAlias(self, 'hardlink/hardlink.db'));
  assert.equal(fx.calls[0].options['account-dir'], fx.root);
  assert.deepEqual(await readdir(fx.temporaryRoot), [], 'authenticated temporary plaintext is removed after copying exact references');
  assert.equal(fx.calls.at(-1), 'close');
});

test('hardlink resolver refuses stale accounts, unverified plaintext copies and path traversal', async t => {
  for (const changes of [
    { account: () => ({ self: 'wxid_other' }) },
    { account: count => count >= 3 ? { generation: '20000000-0000-4000-8000-000000000001' } : {} },
    { account: count => count >= 3 ? { bindingRevision: 2 } : {} },
    { verified: { accountCryptographicBinding: false } },
    { verified: { accountAlias: recipientAlias('wxid_other') } },
    { verified: { quickCheck: 'failed' } },
    { filename: '../outside.dat' }, { month: '2026-99' },
    { mutateDb: db => db.exec('DROP TABLE image_hardlink_info_v4') },
  ]) {
    const fx = await fixture(t, changes);
    await assert.rejects(prepareMediaHardlinks(fx.input, fx.dependencies), { code: 'E_MEDIA_HARDLINKS' });
    const files = await readdir(fx.temporaryRoot).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    assert.deepEqual(files, []);
  }
});

test('hardlink resolver skips all account/database work when no message MD5 needs resolving', async () => {
  let called = false;
  const result = await prepareMediaHardlinks({ self, pid, generation, md5s: [] }, { accountProvider: () => { called = true; } });
  assert.equal(result.count, 0);
  assert.equal(called, false);
});
