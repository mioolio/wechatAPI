import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { decryptDatabase, verifyDatabaseKey, parseDatabaseWal, SUPPORTED_CIPHER_PROFILES } from '../src/database-decrypt.mjs';
import { WxError } from '../src/errors.mjs';

const testKey = Buffer.alloc(32, 0x73);
const testSalt = Buffer.alloc(16, 0x29);
const profile4 = SUPPORTED_CIPHER_PROFILES[0];

async function fixture(t, profile = profile4, withSchema = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wxcc-db-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plaintext = path.join(directory, 'fixture.sqlite');
  const database = new DatabaseSync(plaintext);
  database.exec(`PRAGMA page_size=${profile.pageSize}; PRAGMA user_version=1;`);
  if (withSchema) database.exec("CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES('fixture only');");
  database.close();
  const bytes = await fs.readFile(plaintext);
  await fs.unlink(plaintext);
  // Tiny independent SQLite leaf pages contain no free blocks/overflow pages.
  // Move their cell area and pointers to accommodate the codec's reserved tail.
  bytes[20] = profile.reserveSize;
  for (let offset = 0; offset < bytes.length; offset += profile.pageSize) {
    const page = bytes.subarray(offset, offset + profile.pageSize), base = offset === 0 ? 100 : 0;
    assert.equal(page[base], 13); assert.equal(page.readUInt16BE(base + 1), 0);
    const top = page.readUInt16BE(base + 5), count = page.readUInt16BE(base + 3);
    page.copy(page, top - profile.reserveSize, top);
    page.fill(0, profile.pageSize - profile.reserveSize);
    for (let index = 0; index < count; index++) page.writeUInt16BE(page.readUInt16BE(base + 8 + index * 2) - profile.reserveSize, base + 8 + index * 2);
    page.writeUInt16BE(top - profile.reserveSize, base + 5);
  }
  return { directory, bytes, input: path.join(directory, 'encrypted', 'fixture.db'), output: path.join(directory, 'output', 'copy.sqlite') };
}
function encrypted(page, pageNumber = 1, profile = profile4, mode = 'raw', key = testKey) {
  const aes = mode === 'raw' ? key : pbkdf2Sync(key, testSalt, profile.kdfIterations, 32, profile.kdf);
  const mask = Buffer.from(testSalt.map(byte => byte ^ 0x3a));
  const authKey = pbkdf2Sync(aes, mask, 2, 32, profile.kdf);
  const out = Buffer.alloc(profile.pageSize);
  const start = pageNumber === 1 ? 16 : 0;
  const end = profile.pageSize - profile.reserveSize;
  const iv = Buffer.alloc(16, page.readUInt32BE(60) & 0xff);
  const cipher = createCipheriv('aes-256-cbc', aes, iv);
  cipher.setAutoPadding(false);
  Buffer.concat([cipher.update(page.subarray(start, end)), cipher.final()]).copy(out, start);
  if (pageNumber === 1) testSalt.copy(out);
  iv.copy(out, end);
  const number = Buffer.alloc(4); number.writeUInt32LE(pageNumber);
  createHmac(profile.hmac, authKey).update(out.subarray(start, end + 16)).update(number).digest().copy(out, end + 16);
  authKey.fill(0); mask.fill(0);
  if (mode !== 'raw') aes.fill(0);
  return out;
}
function walChecksum(data, state, bigEndian = false) {
  let [a, b] = state;
  for (let index = 0; index < data.length; index += 8) {
    a = (a + (bigEndian ? data.readUInt32BE(index) : data.readUInt32LE(index)) + b) >>> 0;
    b = (b + (bigEndian ? data.readUInt32BE(index + 4) : data.readUInt32LE(index + 4)) + a) >>> 0;
  }
  return [a, b];
}
function makeWal(frames, profile = profile4, bigEndian = false) {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(bigEndian ? 0x377f0683 : 0x377f0682, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(profile.pageSize, 8);
  header.writeUInt32BE(19, 16); header.writeUInt32BE(27, 20);
  let checksum = walChecksum(header.subarray(0, 24), [0, 0], bigEndian);
  header.writeUInt32BE(checksum[0], 24); header.writeUInt32BE(checksum[1], 28);
  return Buffer.concat([header, ...frames.map(({ page, pageNumber = 1, commit = 0 }) => {
    const h = Buffer.alloc(24); h.writeUInt32BE(pageNumber, 0); h.writeUInt32BE(commit, 4);
    header.copy(h, 8, 16, 24);
    checksum = walChecksum(page, walChecksum(h.subarray(0, 8), checksum, bigEndian), bigEndian);
    h.writeUInt32BE(checksum[0], 16); h.writeUInt32BE(checksum[1], 20);
    return Buffer.concat([h, page]);
  })]);
}
async function writeInput(f, bytes, wal) {
  await fs.mkdir(path.dirname(f.input), { recursive: true });
  await fs.writeFile(f.input, bytes);
  if (wal) await fs.writeFile(`${f.input}-wal`, wal);
}
const codeIs = code => error => error.code === code;

test('raw AES and 32-byte passphrase authenticate finite SQLCipher 3/4 profiles', async t => {
  for (const profile of SUPPORTED_CIPHER_PROFILES) {
    const f = await fixture(t, profile);
    for (const mode of ['raw', 'passphrase']) {
      const firstPage = encrypted(f.bytes, 1, profile, mode);
      const result = verifyDatabaseKey({ firstPage, key: testKey, keyMode: 'auto' });
      assert.equal(result.valid, true);
      assert.equal(result.profile.id, profile.id);
      assert.equal(result.keyMode, mode);
      assert.equal('key' in result, false);
    }
  }
});

test('key+salt SQLCipher raw blob is accepted only for the exact database salt', async t => {
  const f = await fixture(t);
  const page = encrypted(f.bytes);
  assert.equal(verifyDatabaseKey({ firstPage: page, key: `x'${testKey.toString('hex')}${testSalt.toString('hex')}'` }).valid, true);
  const invalid = verifyDatabaseKey({ firstPage: page, key: testKey, salt: Buffer.alloc(16, 1) });
  assert.deepEqual(invalid, { valid: false, reason: 'salt-mismatch' });
  assert.equal(verifyDatabaseKey({ firstPage: page, key: Buffer.alloc(32, 9) }).valid, false);
  page[700] ^= 1;
  assert.equal(verifyDatabaseKey({ firstPage: page, key: testKey }).valid, false);
});

test('verification distinguishes authenticated invalid SQLite headers without returning header bytes', async t => {
  const f = await fixture(t); f.bytes[20] = 0;
  const result = verifyDatabaseKey({ firstPage: encrypted(f.bytes), key: testKey, profiles: [profile4] });
  assert.deepEqual(result, { valid: false, reason: 'sqlite-header-invalid' });
  const badKey = verifyDatabaseKey({ firstPage: encrypted(f.bytes), key: Buffer.alloc(32, 1), profiles: [profile4] });
  assert.deepEqual(badKey, { valid: false, reason: 'authentication-failed' });
});

test('copy-only decrypt authenticates and quick_checks before atomic publication', async t => {
  const f = await fixture(t);
  const ciphertext = encrypted(f.bytes);
  await writeInput(f, ciphertext);
  let called = 0;
  const result = await decryptDatabase({ databasePath: f.input, output: f.output, keyProvider: async ({ salt, firstPage }) => {
    called++; assert.deepEqual(salt, testSalt); assert.deepEqual(firstPage, ciphertext);
    return [{ key: Buffer.alloc(32), mode: 'raw' }, { key: testKey, mode: 'raw', salt: testSalt }];
  } });
  assert.equal(called, 1);
  assert.equal(result.quickCheck, 'ok'); assert.equal(result.schemaObjects, 0);
  assert.equal(result.outputPath, f.output);
  assert.equal(JSON.stringify(result).includes(f.directory), false);
  assert.equal(JSON.stringify(result).includes(testKey.toString('hex')), false);
  assert.deepEqual(await fs.readFile(f.input), ciphertext);
  const sqlite = new DatabaseSync(f.output, { readOnly: true });
  try { assert.equal(sqlite.prepare('PRAGMA user_version').get().user_version, 1); }
  finally { sqlite.close(); }
  assert.deepEqual(testKey, Buffer.alloc(32, 0x73)); // Caller/provider retains ownership.
  assert.equal((await fs.readdir(path.dirname(f.output))).some(name => name.startsWith('.wxcc-decrypt-')), false);
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey }), codeIs('E_DB_OUTPUT_EXISTS'));
});

test('WAL replay applies the final commit and ignores valid uncommitted frames', async t => {
  const f = await fixture(t);
  f.bytes[18] = 2; f.bytes[19] = 2;
  const committed = Buffer.from(f.bytes); committed.writeUInt32BE(7, 60);
  const pending = Buffer.from(f.bytes); pending.writeUInt32BE(999, 60);
  const wal = makeWal([{ page: encrypted(committed), commit: 1 }, { page: encrypted(pending) }]);
  await writeInput(f, encrypted(f.bytes), wal);
  const result = await decryptDatabase({ databasePath: f.input, output: f.output, key: testKey });
  assert.equal(result.wal.committedFrames, 1); assert.equal(result.wal.uncommittedFrames, 1);
  const sqlite = new DatabaseSync(f.output, { readOnly: true });
  try { assert.equal(sqlite.prepare('PRAGMA user_version').get().user_version, 7); }
  finally { sqlite.close(); }
  assert.deepEqual(await fs.readFile(`${f.input}-wal`), wal);
});

test('a real synthetic schema/row survives multi-page decryption and integrity validation', async t => {
  const f = await fixture(t, profile4, true);
  const ciphertext = Buffer.concat(Array.from({ length: f.bytes.length / 4096 }, (_, index) => encrypted(f.bytes.subarray(index * 4096, (index + 1) * 4096), index + 1)));
  await writeInput(f, ciphertext);
  const result = await decryptDatabase({ databasePath: f.input, output: f.output, key: testKey });
  assert.equal(result.schemaObjects, 1); assert.equal(result.pages, 2);
  const sqlite = new DatabaseSync(f.output, { readOnly: true });
  try { assert.equal(sqlite.prepare('SELECT value FROM synthetic').get().value, 'fixture only'); }
  finally { sqlite.close(); }
});

test('authenticated malformed SQLite schema fails quick_check before publication', async t => {
  const f = await fixture(t); f.bytes[100] = 0xff;
  await writeInput(f, encrypted(f.bytes));
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey }), codeIs('E_DB_INTEGRITY'));
  await assert.rejects(fs.stat(f.output), error => error.code === 'ENOENT');
});

test('WAL validates both checksum byte orders, old generations, and torn frames', async t => {
  const f = await fixture(t);
  for (const bigEndian of [false, true]) {
    const wal = makeWal([{ page: encrypted(f.bytes), commit: 1 }], profile4, bigEndian);
    assert.equal(parseDatabaseWal(wal, { pageSize: 4096 }).committedFrames, 1);
    const oldFrame = Buffer.from(wal.subarray(32)); oldFrame.writeUInt32BE(999, 8);
    assert.equal(parseDatabaseWal(Buffer.concat([wal, oldFrame]), { pageSize: 4096 }).staleBytes, oldFrame.length);
    assert.throws(() => parseDatabaseWal(wal.subarray(0, wal.length - 1), { pageSize: 4096 }), codeIs('E_DB_WAL'));
    wal[300] ^= 1;
    assert.throws(() => parseDatabaseWal(wal, { pageSize: 4096 }), codeIs('E_DB_WAL_CHECKSUM'));
  }
});

test('wrong key, corrupt later page, and WAL auth failure publish no plaintext', async t => {
  for (const failure of ['key', 'page', 'wal']) {
    const f = await fixture(t);
    let dbBytes = encrypted(f.bytes), wal;
    if (failure === 'page') {
      const second = encrypted(Buffer.alloc(4096), 2); second[10] ^= 1;
      dbBytes = Buffer.concat([dbBytes, second]);
    }
    if (failure === 'wal') { const bad = encrypted(f.bytes); bad[10 + 16] ^= 1; wal = makeWal([{ page: bad, commit: 1 }]); }
    await writeInput(f, dbBytes, wal);
    await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: failure === 'key' ? Buffer.alloc(32, 2) : testKey }), codeIs(failure === 'key' ? 'E_DB_KEY_INVALID' : 'E_DB_PAGE_AUTH'));
    await assert.rejects(fs.stat(f.output), error => error.code === 'ENOENT');
    assert.equal((await fs.readdir(path.dirname(f.output))).some(name => name.startsWith('.wxcc-decrypt-')), false);
  }
});

test('explicit output, a single key source, and inactive journals are enforced', async t => {
  const f = await fixture(t); await writeInput(f, encrypted(f.bytes));
  await assert.rejects(decryptDatabase({ databasePath: f.input, key: testKey }), codeIs('E_DB_OUTPUT_REQUIRED'));
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: path.join(path.dirname(f.input), 'copy.db'), key: testKey }), codeIs('E_DB_LIVE_OUTPUT'));
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey, keyProvider: async () => testKey }), codeIs('E_DB_KEY_SOURCE'));
  await fs.writeFile(`${f.input}-journal`, Buffer.from('active rollback journal'));
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey }), codeIs('E_DB_JOURNAL'));
});

test('bounded key-file supports raw binary and hex without persisting extra key copies', async t => {
  for (const content of [testKey, `${testKey.toString('hex')}\n`]) {
    const f = await fixture(t); await writeInput(f, encrypted(f.bytes));
    const keyFile = path.join(f.directory, 'provided.key'); await fs.writeFile(keyFile, content);
    const result = await decryptDatabase({ databasePath: f.input, output: f.output, keyFile });
    assert.equal(result.quickCheck, 'ok');
    assert.equal((await fs.readdir(path.dirname(f.output))).length, 1);
  }
});

test('known sanitized provider errors retain codes; unexpected errors reveal no private content', async t => {
  const f = await fixture(t); await writeInput(f, encrypted(f.bytes));
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, keyProvider: async () => { throw new WxError('E_DB_KEY_TIMEOUT', '只读密钥扫描达到时间上限。'); } }), codeIs('E_DB_KEY_TIMEOUT'));
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, keyProvider: async () => { throw new Error('private synthetic provider detail'); } }), error => error.code === 'E_DB_KEY_PROVIDER' && !error.message.includes('private'));
});

test('beforePublish runs after integrity but rejects account changes before any destination exists', async t => {
  const f = await fixture(t); await writeInput(f, encrypted(f.bytes));
  let calls = 0;
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey, beforePublish: async () => {
    calls++;
    await assert.rejects(fs.stat(f.output), error => error.code === 'ENOENT');
    const folders = (await fs.readdir(path.dirname(f.output))).filter(name => name.startsWith('.wxcc-decrypt-'));
    assert.equal(folders.length, 1);
    const sqlite = new DatabaseSync(path.join(path.dirname(f.output), folders[0], 'database.sqlite'), { readOnly: true });
    try { assert.equal(Object.values(sqlite.prepare('PRAGMA quick_check').get())[0], 'ok'); }
    finally { sqlite.close(); }
    throw new WxError('E_DB_ACCOUNT_CHANGED', '当前账号已变化。');
  } }), codeIs('E_DB_ACCOUNT_CHANGED'));
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(f.output), error => error.code === 'ENOENT');
  assert.equal((await fs.readdir(path.dirname(f.output))).length, 0);
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey, beforePublish: async () => { throw new Error('private synthetic guard detail'); } }), error => error.code === 'E_DB_PUBLISH_GUARD' && !error.message.includes('private'));
  const result = await decryptDatabase({ databasePath: f.input, output: f.output, key: testKey, beforePublish: async () => true });
  assert.equal(result.quickCheck, 'ok');
});
