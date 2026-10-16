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
  if (typeof withSchema === 'string') {
    database.enableDefensive(false); // Only synthetic schemas may use writable_schema.
    database.exec(withSchema);
  } else if (withSchema) database.exec("CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES('fixture only');");
  database.close();
  const bytes = await fs.readFile(plaintext);
  await fs.unlink(plaintext);
  // Tiny independent SQLite leaf pages contain no free blocks/overflow pages.
  // Move their cell area and pointers to accommodate the codec's reserved tail.
  bytes[20] = profile.reserveSize;
  for (let offset = 0; offset < bytes.length; offset += profile.pageSize) {
    const page = bytes.subarray(offset, offset + profile.pageSize), base = offset === 0 ? 100 : 0;
    assert.ok(page[base] === 13 || page[base] === 10); assert.equal(page.readUInt16BE(base + 1), 0);
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
  const canonicalOutput = await fs.realpath(f.output);
  const canonicalDirectory = await fs.realpath(f.directory);
  assert.equal(result.outputPath, canonicalOutput);
  const json = JSON.stringify(result);
  assert.equal(json.includes(JSON.stringify(f.directory).slice(1, -1)), false);
  assert.equal(json.includes(JSON.stringify(canonicalDirectory).slice(1, -1)), false);
  assert.equal(json.includes(JSON.stringify(canonicalOutput).slice(1, -1)), false);
  assert.equal(json.includes(testKey.toString('hex')), false);
  assert.deepEqual(await fs.readFile(f.input), ciphertext);
  const sqlite = new DatabaseSync(f.output, { readOnly: true });
  try { assert.equal(sqlite.prepare('PRAGMA user_version').get().user_version, 1); }
  finally { sqlite.close(); }
  assert.deepEqual(testKey, Buffer.alloc(32, 0x73)); // Caller/provider retains ownership.
  assert.equal((await fs.readdir(path.dirname(f.output))).some(name => name.startsWith('.wxcc-decrypt-')), false);
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey }), codeIs('E_DB_OUTPUT_EXISTS'));
});

test('key-only authenticates a stable first page without output, WAL reads, or a full database copy', async t => {
  const f = await fixture(t);
  const ciphertext = encrypted(f.bytes);
  await writeInput(f, ciphertext, Buffer.from('not a valid WAL'));
  // The key command is independent of full-copy size, later pages and active journals.
  const input = await fs.open(f.input, 'r+');
  try { await input.truncate(8192); }
  finally { await input.close(); }
  await fs.writeFile(`${f.input}-journal`, Buffer.from('active rollback journal'));
  await fs.chmod(f.input, 0o400);
  t.after(() => fs.chmod(f.input, 0o600).catch(() => {}));
  const before = await fs.readdir(f.directory, { recursive: true });
  let guards = 0, providerContext;
  const result = await decryptDatabase({ databasePath: f.input, keyOnly: true, keyProvider: async context => { providerContext = context; return testKey; }, maximumBytes: 4096, output: f.output, beforePublish: async () => { guards++; return true; } });
  assert.deepEqual(result, { ok: true, scope: 'database-key', keyAuthenticated: true, profile: profile4.id, keyMode: 'raw', keyEncoding: 'hex', key: testKey.toString('hex') });
  assert.equal(guards, 1);
  assert.equal('quickCheck' in result, false); assert.equal('pages' in result, false); assert.equal('outputPath' in result, false);
  assert.deepEqual(await fs.readdir(f.directory, { recursive: true }), before);
  assert.deepEqual((await fs.readFile(f.input)).subarray(0, 4096), ciphertext);
  assert.equal(providerContext.firstPage.every(byte => byte === 0), true);
  assert.equal(providerContext.salt.every(byte => byte === 0), true);
});

test('key-only refuses changing first-page reads within its bounded retry budget', async t => {
  const f = await fixture(t); await writeInput(f, encrypted(f.bytes));
  const inputPath = await fs.realpath(f.input);
  const open = fs.open;
  let reads = 0, providerCalls = 0;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === inputPath) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        reads++; assert.ok(readArgs[2] <= 4096);
        if (reads % 2 === 0) readArgs[0][100] ^= 1;
        return result;
      };
    }
    return handle;
  };
  try {
    await assert.rejects(decryptDatabase({ databasePath: f.input, keyOnly: true, snapshotAttempts: 2, keyProvider: async () => { providerCalls++; return testKey; } }), codeIs('E_DB_SNAPSHOT_BUSY'));
  } finally { fs.open = open; }
  assert.equal(reads, 4); assert.equal(providerCalls, 0);
  assert.deepEqual(await fs.readdir(f.directory), ['encrypted']);
});

test('key-only returns the derived raw AES key for passphrase input and supports all finite profiles', async t => {
  for (const profile of SUPPORTED_CIPHER_PROFILES) {
    const f = await fixture(t, profile);
    const ciphertext = encrypted(f.bytes, 1, profile, 'passphrase');
    await writeInput(f, ciphertext);
    const result = await decryptDatabase({ databasePath: f.input, keyOnly: true, key: testKey, keyMode: 'auto' });
    const expected = pbkdf2Sync(testKey, testSalt, profile.kdfIterations, 32, profile.kdf);
    try {
      assert.equal(result.keyMode, 'passphrase'); assert.equal(result.profile, profile.id);
      assert.equal(result.key, expected.toString('hex')); assert.notEqual(result.key, testKey.toString('hex'));
      assert.equal(verifyDatabaseKey({ firstPage: ciphertext, key: result.key, keyMode: 'raw', profile: result.profile }).valid, true);
    } finally { expected.fill(0); }
    assert.deepEqual(await fs.readdir(f.directory), ['encrypted']);
  }
});

test('key-only rejects invalid keys and account guards without returning key material or creating files', async t => {
  const f = await fixture(t); await writeInput(f, encrypted(f.bytes));
  const before = await fs.readdir(f.directory, { recursive: true });
  let guards = 0;
  await assert.rejects(decryptDatabase({ databasePath: f.input, keyOnly: true, key: Buffer.alloc(32, 2), beforePublish: async () => { guards++; return true; } }), codeIs('E_DB_KEY_INVALID'));
  assert.equal(guards, 0);
  for (const guard of [async () => false, async () => { throw new Error('private synthetic guard'); }, async () => { throw new WxError('E_DB_ACCOUNT_CHANGED', '当前账号已变化。'); }]) {
    await assert.rejects(decryptDatabase({ databasePath: f.input, keyOnly: true, key: testKey, beforePublish: guard }), error => {
      assert.ok(['E_DB_PUBLISH_GUARD', 'E_DB_ACCOUNT_CHANGED'].includes(error.code));
      assert.equal('key' in error, false); assert.equal(JSON.stringify(error).includes(testKey.toString('hex')), false);
      assert.equal(error.message.includes('private'), false); return true;
    });
  }
  assert.deepEqual(await fs.readdir(f.directory, { recursive: true }), before);
});

test('full-copy includes raw AES key only when explicitly requested and only after successful publication', async t => {
  for (const mode of ['raw', 'passphrase']) {
    const f = await fixture(t); await writeInput(f, encrypted(f.bytes, 1, profile4, mode));
    let guarded = false;
    const result = await decryptDatabase({ databasePath: f.input, output: f.output, key: testKey, keyMode: mode, includeKey: true, beforePublish: async () => {
      guarded = true; await assert.rejects(fs.stat(f.output), error => error.code === 'ENOENT'); return true;
    } });
    assert.equal(guarded, true); assert.equal(result.quickCheck, 'ok');
    assert.equal(result.keyEncoding, 'hex');
    const expected = mode === 'raw' ? Buffer.from(testKey) : pbkdf2Sync(testKey, testSalt, profile4.kdfIterations, 32, profile4.kdf);
    try { assert.equal(result.key, expected.toString('hex')); } finally { expected.fill(0); }
    assert.ok((await fs.stat(f.output)).isFile());
  }
  const f = await fixture(t); const corrupt = encrypted(f.bytes); corrupt[100] ^= 1;
  await writeInput(f, corrupt);
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey, includeKey: true }), error => {
    assert.equal(error.code, 'E_DB_KEY_INVALID'); assert.equal('key' in error, false); return true;
  });
  await assert.rejects(fs.stat(f.output), error => error.code === 'ENOENT');
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

test('missing WeChat FTS tokenizer is diagnosed without publishing authenticated plaintext', async t => {
  const f = await fixture(t, profile4, `
    CREATE VIRTUAL TABLE synthetic_fts USING fts5(content, tokenize='porter        ');
    INSERT INTO synthetic_fts(content) VALUES('fixture only');
    PRAGMA writable_schema=ON;
    UPDATE sqlite_schema SET sql=replace(sql, 'porter        ', 'MMFtsTokenizer') WHERE name='synthetic_fts';
    PRAGMA writable_schema=OFF;
  `);
  const ciphertext = Buffer.concat(Array.from({ length: f.bytes.length / profile4.pageSize }, (_, index) =>
    encrypted(f.bytes.subarray(index * profile4.pageSize, (index + 1) * profile4.pageSize), index + 1)));
  await writeInput(f, ciphertext);
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey }), codeIs('E_DB_SQLITE_TOKENIZER'));
  await assert.rejects(fs.stat(f.output), error => error.code === 'ENOENT');
  assert.deepEqual(await fs.readdir(path.dirname(f.output)), []);
  assert.deepEqual(await fs.readFile(f.input), ciphertext);
});

test('other missing FTS tokenizers retain the integrity failure and publish nothing', async t => {
  const f = await fixture(t, profile4, `
    CREATE VIRTUAL TABLE synthetic_fts USING fts5(content, tokenize='porter        ');
    INSERT INTO synthetic_fts(content) VALUES('fixture only');
    PRAGMA writable_schema=ON;
    UPDATE sqlite_schema SET sql=replace(sql, 'porter        ', 'NotATokenizerX') WHERE name='synthetic_fts';
    PRAGMA writable_schema=OFF;
  `);
  const ciphertext = Buffer.concat(Array.from({ length: f.bytes.length / profile4.pageSize }, (_, index) =>
    encrypted(f.bytes.subarray(index * profile4.pageSize, (index + 1) * profile4.pageSize), index + 1)));
  await writeInput(f, ciphertext);
  await assert.rejects(decryptDatabase({ databasePath: f.input, output: f.output, key: testKey }), codeIs('E_DB_INTEGRITY'));
  await assert.rejects(fs.stat(f.output), error => error.code === 'ENOENT');
  assert.deepEqual(await fs.readdir(path.dirname(f.output)), []);
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
