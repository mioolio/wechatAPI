import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, createHmac, createDecipheriv, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WxError } from './errors.mjs';

const run = promisify(execFile);
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
export const SUPPORTED_CIPHER_PROFILES = Object.freeze([
  Object.freeze({ id: 'sqlcipher4-4096', pageSize: 4096, reserveSize: 80, hmac: 'sha512', kdf: 'sha512', kdfIterations: 256000, hmacBytes: 64 }),
  Object.freeze({ id: 'sqlcipher3-4096', pageSize: 4096, reserveSize: 48, hmac: 'sha1', kdf: 'sha1', kdfIterations: 64000, hmacBytes: 20 }),
  Object.freeze({ id: 'sqlcipher3-1024', pageSize: 1024, reserveSize: 48, hmac: 'sha1', kdf: 'sha1', kdfIterations: 64000, hmacBytes: 20 })
]);
const fail = (code, message, details) => { throw new WxError(code, message, details); };
const hash = data => createHash('sha256').update(data).digest();
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);
function profilesFor({ profile, profiles } = {}) {
  const requested = profile ? [profile] : (profiles ?? SUPPORTED_CIPHER_PROFILES);
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > SUPPORTED_CIPHER_PROFILES.length) fail('E_DB_CIPHER_PROFILE', '加密参数候选无效。');
  return [...new Set(requested.map(value => typeof value === 'string' ? value : value?.id))].map(id => {
    const result = SUPPORTED_CIPHER_PROFILES.find(item => item.id === id);
    if (!result) fail('E_DB_CIPHER_PROFILE', '不支持此加密参数配置。');
    return result;
  });
}
function modesFor(mode = 'raw') {
  if (mode === 'auto') return ['raw', 'passphrase'];
  if (mode === 'raw' || mode === 'passphrase') return [mode];
  fail('E_DB_KEY_MODE', '密钥模式必须是 raw、passphrase 或 auto。');
}
function keyMaterial(value, suppliedSalt) {
  let bytes;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) bytes = Buffer.from(value);
  else if (typeof value === 'string') {
    const text = value.trim();
    const match = /^(?:x')?([a-f0-9]{64}|[a-f0-9]{96})(?:')?$/i.exec(text);
    if (!match || (/^x'/i.test(text) !== text.endsWith("'"))) fail('E_DB_KEY_FORMAT', '密钥必须是 32 字节或有效的 SQLCipher raw key。');
    bytes = Buffer.from(match[1], 'hex');
  } else fail('E_DB_KEY_FORMAT', '密钥必须是 32 字节或有效的 SQLCipher raw key。');
  let salt;
  if (bytes.length === 48) { salt = Buffer.from(bytes.subarray(32)); const old = bytes; bytes = Buffer.from(old.subarray(0, 32)); old.fill(0); }
  if (bytes.length !== 32) { bytes.fill(0); fail('E_DB_KEY_FORMAT', '当前离线解密仅支持 32 字节密钥。'); }
  if (suppliedSalt !== undefined) {
    const provided = typeof suppliedSalt === 'string' && /^[a-f0-9]{32}$/i.test(suppliedSalt) ? Buffer.from(suppliedSalt, 'hex') : Buffer.from(suppliedSalt ?? []);
    if (provided.length !== 16 || (salt && !equal(salt, provided))) { bytes.fill(0); salt?.fill(0); provided.fill(0); fail('E_DB_KEY_FORMAT', '密钥携带的 salt 无效。'); }
    salt?.fill(0); salt = provided;
  }
  return { key: bytes, salt };
}
function derive(material, salt, profile, mode) {
  const aes = mode === 'raw' ? Buffer.from(material) : pbkdf2Sync(material, salt, profile.kdfIterations, 32, profile.kdf);
  const hmacSalt = Buffer.from(salt);
  for (let index = 0; index < hmacSalt.length; index++) hmacSalt[index] ^= 0x3a;
  try { return { aes, hmac: pbkdf2Sync(aes, hmacSalt, 2, 32, profile.kdf), profile }; }
  catch (error) { aes.fill(0); throw error; }
  finally { hmacSalt.fill(0); }
}
function erase(context) { context?.aes.fill(0); context?.hmac.fill(0); }
function pageAuthenticates(page, pageNumber, context) {
  const { profile } = context;
  if (page.length !== profile.pageSize || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 0xffffffff) return false;
  const offset = pageNumber === 1 ? 16 : 0;
  const ivPosition = page.length - profile.reserveSize;
  const tagPosition = ivPosition + 16;
  const pgno = Buffer.alloc(4); pgno.writeUInt32LE(pageNumber);
  const actual = createHmac(profile.hmac, context.hmac).update(page.subarray(offset, tagPosition)).update(pgno).digest();
  const valid = equal(actual, page.subarray(tagPosition, tagPosition + profile.hmacBytes));
  actual.fill(0);
  return valid;
}
function decodePage(page, pageNumber, context) {
  if (!pageAuthenticates(page, pageNumber, context)) fail('E_DB_PAGE_AUTH', '数据库页面认证失败。', { pageNumber });
  const { profile } = context;
  const offset = pageNumber === 1 ? 16 : 0;
  const tail = profile.pageSize - profile.reserveSize;
  const decipher = createDecipheriv('aes-256-cbc', context.aes, page.subarray(tail, tail + 16));
  decipher.setAutoPadding(false);
  const payload = Buffer.concat([decipher.update(page.subarray(offset, tail)), decipher.final()]);
  const result = Buffer.alloc(profile.pageSize);
  if (pageNumber === 1) SQLITE_HEADER.copy(result);
  payload.copy(result, offset); payload.fill(0);
  return result;
}
function validHeader(page, profile) {
  return page.subarray(0, 16).equals(SQLITE_HEADER)
    && page.readUInt16BE(16) === profile.pageSize && page[20] === profile.reserveSize
    && [1, 2].includes(page[18]) && [1, 2].includes(page[19])
    && page[21] === 64 && page[22] === 32 && page[23] === 32
    && page.readUInt32BE(44) <= 4 && page.readUInt32BE(56) <= 3;
}

/** Verify one authenticated first page; key/derived bytes never escape the result. */
export function verifyDatabaseKey({ firstPage, key, keyMode = 'raw', mode, salt, ...options } = {}) {
  if (!(firstPage instanceof Uint8Array) || firstPage.length < 1024) fail('E_DB_HEADER', '数据库首页面不完整。');
  const page = Buffer.from(firstPage);
  if (page.subarray(0, 16).equals(SQLITE_HEADER)) return { valid: false, reason: 'already-plaintext' };
  const material = keyMaterial(key, salt);
  try {
    const databaseSalt = page.subarray(0, 16);
    if (material.salt && !equal(databaseSalt, material.salt)) return { valid: false, reason: 'salt-mismatch' };
    let authenticatedHeaderFailed = false;
    for (const candidateMode of modesFor(mode ?? keyMode)) for (const profile of profilesFor(options)) {
      if (page.length < profile.pageSize) continue;
      const context = derive(material.key, databaseSalt, profile, candidateMode);
      try {
        const first = page.subarray(0, profile.pageSize);
        if (!pageAuthenticates(first, 1, context)) continue;
        const decoded = decodePage(first, 1, context);
        try {
          if (validHeader(decoded, profile)) return { valid: true, profile: { ...profile }, keyMode: candidateMode };
          authenticatedHeaderFailed = true;
        }
        finally { decoded.fill(0); }
      } finally { erase(context); }
    }
    return { valid: false, reason: authenticatedHeaderFailed ? 'sqlite-header-invalid' : 'authentication-failed' };
  } finally { material.key.fill(0); material.salt?.fill(0); }
}

function checksum(bytes, state, bigEndian) {
  let [a, b] = state;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    a = (a + (bigEndian ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset)) + b) >>> 0;
    b = (b + (bigEndian ? bytes.readUInt32BE(offset + 4) : bytes.readUInt32LE(offset + 4)) + a) >>> 0;
  }
  return [a, b];
}

/** Validates SQLite's encrypted WAL checksum chain and returns only committed frames. */
export function parseDatabaseWal(wal, { pageSize, maximumPages = 1048576 } = {}) {
  if (!(wal instanceof Uint8Array)) fail('E_DB_WAL', 'WAL 数据无效。');
  if (!Number.isSafeInteger(pageSize) || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || !Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 0xffffffff) fail('E_DB_WAL', 'WAL 页面限制无效。');
  wal = Buffer.from(wal);
  if (!wal.length) return { frames: [], commitPages: null, validFrames: 0, committedFrames: 0, uncommittedFrames: 0, staleBytes: 0 };
  if (wal.length < 32) fail('E_DB_WAL', 'WAL 头部不完整。');
  const magic = wal.readUInt32BE(0);
  if (![0x377f0682, 0x377f0683].includes(magic) || wal.readUInt32BE(4) !== 3007000 || wal.readUInt32BE(8) !== pageSize) fail('E_DB_WAL', 'WAL 格式或页面大小不受支持。');
  const bigEndian = magic === 0x377f0683;
  let state = checksum(wal.subarray(0, 24), [0, 0], bigEndian);
  if (state[0] !== wal.readUInt32BE(24) || state[1] !== wal.readUInt32BE(28)) fail('E_DB_WAL_CHECKSUM', 'WAL 头部校验失败。');
  const frames = [];
  let committedFrames = 0, commitPages = null, offset = 32;
  for (; offset + 24 + pageSize <= wal.length; offset += 24 + pageSize) {
    const frameHeader = wal.subarray(offset, offset + 24);
    if (!frameHeader.subarray(8, 16).equals(wal.subarray(16, 24))) break; // Old generation after a WAL reset.
    const pageNumber = frameHeader.readUInt32BE(0), databasePages = frameHeader.readUInt32BE(4);
    if (pageNumber < 1 || pageNumber > maximumPages || databasePages > maximumPages) fail('E_DB_WAL', 'WAL 页面编号超过支持范围。');
    const page = wal.subarray(offset + 24, offset + 24 + pageSize);
    const nextState = checksum(page, checksum(frameHeader.subarray(0, 8), state, bigEndian), bigEndian);
    // A frame with matching generation but a broken chain is corruption or a torn copy;
    // fail closed instead of returning an older transaction as "complete".
    if (nextState[0] !== frameHeader.readUInt32BE(16) || nextState[1] !== frameHeader.readUInt32BE(20)) fail('E_DB_WAL_CHECKSUM', 'WAL 帧校验失败。', { frameNumber: frames.length + 1 });
    state = nextState;
    frames.push({ pageNumber, page });
    if (databasePages) { committedFrames = frames.length; commitPages = databasePages; }
  }
  if (offset < wal.length && offset + 24 + pageSize > wal.length) fail('E_DB_WAL', 'WAL 存在不完整的帧，无法确认一致快照。');
  return { frames: frames.slice(0, committedFrames), commitPages, validFrames: frames.length, committedFrames, uncommittedFrames: frames.length - committedFrames, staleBytes: wal.length - offset };
}

async function fingerprint(file, maximumBytes, required = false) {
  try {
    const stat = await fs.stat(file, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maximumBytes)) fail('E_DB_SIZE', '数据库或 WAL 大小超过支持范围。');
    return { size: Number(stat.size), stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
  } catch (error) { if (error.code === 'ENOENT' && !required) return null; if (error instanceof WxError) throw error; fail('E_DB_PATH', '数据库或侧文件无法读取。'); }
}
async function readLimited(file, maximumBytes) {
  const before = await fingerprint(file, maximumBytes, true);
  const bytes = await fs.readFile(file);
  if (bytes.length !== before.size || bytes.length > maximumBytes) fail('E_DB_SNAPSHOT_BUSY', '数据库正在变化，无法取得稳定快照。');
  return bytes;
}
async function snapshot(databasePath, { maximumBytes, snapshotAttempts }) {
  const walPath = `${databasePath}-wal`, journalPath = `${databasePath}-journal`;
  for (let attempt = 0; attempt < snapshotAttempts; attempt++) {
    const before = await Promise.all([fingerprint(databasePath, maximumBytes, true), fingerprint(walPath, maximumBytes), fingerprint(journalPath, maximumBytes)]);
    if (before[2]?.size) {
      const handle = await fs.open(journalPath, 'r');
      const header = Buffer.alloc(28);
      try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
      if (header.some(byte => byte !== 0)) fail('E_DB_JOURNAL', '存在活动 rollback journal，需要客户端正常完成事务后重试。');
    }
    let database, wal, retained = false;
    try {
      database = await readLimited(databasePath, maximumBytes);
      wal = before[1] ? await readLimited(walPath, maximumBytes) : Buffer.alloc(0);
      const middle = await Promise.all([fingerprint(databasePath, maximumBytes, true), fingerprint(walPath, maximumBytes), fingerprint(journalPath, maximumBytes)]);
      if (before.some((value, index) => value?.stamp !== middle[index]?.stamp)) continue;
      const secondDatabase = await readLimited(databasePath, maximumBytes);
      const secondWal = middle[1] ? await readLimited(walPath, maximumBytes) : Buffer.alloc(0);
      const stable = equal(hash(database), hash(secondDatabase)) && equal(hash(wal), hash(secondWal));
      secondDatabase.fill(0); secondWal.fill(0);
      const after = await Promise.all([fingerprint(databasePath, maximumBytes, true), fingerprint(walPath, maximumBytes), fingerprint(journalPath, maximumBytes)]);
      if (stable && middle.every((value, index) => value?.stamp === after[index]?.stamp)) { retained = true; return { database, wal }; }
    } catch (error) { if (!['E_DB_SNAPSHOT_BUSY', 'E_DB_PATH'].includes(error.code)) throw error; }
    finally { if (!retained) { database?.fill(0); wal?.fill(0); } }
  }
  fail('E_DB_SNAPSHOT_BUSY', '数据库正在变化，无法取得稳定快照；稍后重试。');
}

async function protectedDirectory(parent) {
  const folder = await fs.mkdtemp(path.join(parent, '.wxcc-decrypt-'));
  try {
    await fs.chmod(folder, 0o700);
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      const { stdout } = await run(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
      const sid = stdout.trim();
      if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) fail('E_DB_OUTPUT_PERMISSIONS', '无法确认明文临时目录的访问权限。');
      await run(path.join(systemRoot, 'System32', 'icacls.exe'), [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
    }
    return folder;
  } catch { await fs.rm(folder, { recursive: true, force: true }); fail('E_DB_OUTPUT_PERMISSIONS', '无法保护明文临时目录的访问权限。'); }
}
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function outputTarget(databasePath, output) {
  if (typeof output !== 'string' || !output.trim()) fail('E_DB_OUTPUT_REQUIRED', '写出明文数据库需要明确的 output 路径。');
  const destination = path.resolve(output);
  let protectedRoot = path.dirname(databasePath);
  for (let folder = protectedRoot; path.dirname(folder) !== folder; folder = path.dirname(folder)) if (path.basename(folder).toLowerCase() === 'db_storage') { protectedRoot = folder; break; }
  if (contained(protectedRoot, destination)) fail('E_DB_LIVE_OUTPUT', '明文输出必须位于实时数据库目录之外。');
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  const parentReal = await fs.realpath(parent);
  const target = path.join(parentReal, path.basename(destination));
  if (contained(protectedRoot, target) || [databasePath, `${databasePath}-wal`, `${databasePath}-journal`, `${databasePath}-shm`].some(value => path.resolve(value).toLowerCase() === target.toLowerCase())) fail('E_DB_LIVE_OUTPUT', '明文输出必须位于实时数据库目录之外。');
  try { await fs.lstat(target); fail('E_DB_OUTPUT_EXISTS', '输出文件已经存在，请选择新的 output 路径。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}
async function candidates({ key, keyFile, keyProvider, keyMode = 'raw' }, context) {
  if ([key !== undefined, !!keyFile, !!keyProvider].filter(Boolean).length !== 1) fail('E_DB_KEY_SOURCE', '请明确一个密钥来源：key-file 或内存 key provider。');
  let values, fileKey;
  if (keyFile) {
    const file = await readLimited(keyFile, 256);
    try {
      const text = file.toString('utf8').trim();
      if (file.length === 32) fileKey = Buffer.from(file);
      values = [{ key: fileKey ?? text, mode: keyMode }];
    } finally { file.fill(0); }
  } else if (keyProvider) {
    const get = typeof keyProvider === 'function' ? keyProvider : keyProvider.getKeys?.bind(keyProvider);
    if (!get) fail('E_DB_KEY_SOURCE', '内存 key provider 接口无效。');
    try { values = await get(context); }
    catch (error) {
      if (error instanceof WxError && /^E_DB_[A-Z0-9_]+$/.test(error.code)) throw error;
      fail('E_DB_KEY_PROVIDER', '内存 key provider 无法提供候选密钥。');
    }
    if (values?.candidates && Array.isArray(values.candidates)) values = values.candidates;
  } else values = [{ key, mode: keyMode }];
  if (!Array.isArray(values)) values = [values];
  if (values.length < 1) fail('E_DB_KEY_NOT_FOUND', '未找到与数据库 salt 对应的候选密钥。');
  if (values.length > 8) fail('E_DB_KEY_LIMIT', '密钥候选超过上限。');
  const result = [];
  try {
    for (const value of values) {
      const candidate = Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === 'string' ? { key: value, mode: keyMode } : value;
      if (!candidate) fail('E_DB_KEY_FORMAT', '候选密钥无效。');
      result.push({ ...keyMaterial(candidate.key, candidate.salt), mode: candidate.mode ?? candidate.keyMode ?? keyMode, profile: candidate.profile });
    }
    return result;
  } catch (error) { for (const candidate of result) { candidate.key.fill(0); candidate.salt?.fill(0); } throw error; }
  finally { fileKey?.fill(0); }
}
async function quickCheck(filename) {
  let database;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(filename, { readOnly: true, enableExtensionLoading: false });
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    // Compile and step SQLite's schema plus integrity traversal, returning counts only.
    const schemaCount = database.prepare('SELECT count(*) AS count FROM sqlite_schema').get().count;
    const rows = database.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') fail('E_DB_INTEGRITY', '解密副本未通过 SQLite quick_check。');
    return { quickCheck: 'ok', schemaObjects: Number(schemaCount) };
  } catch (error) { if (error instanceof WxError) throw error; fail('E_DB_INTEGRITY', '解密副本无法通过 SQLite schema 与 quick_check 验证。'); }
  finally { database?.close(); }
}
async function writeAll(file, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, position + offset);
    if (bytesWritten < 1) fail('E_DB_OUTPUT', '写入明文副本失败。');
    offset += bytesWritten;
  }
}

/**
 * Copy-only offline export. No live DB is opened with SQLite or written.
 * The returned outputPath is private/non-enumerable. JSON summaries contain no key/path.
 * Buffers owned by the caller/provider are copied; only module-owned key copies are wiped.
 */
export async function decryptDatabase(options = {}) {
  const { databasePath, maximumBytes = 256 * 1024 * 1024, snapshotAttempts = 3 } = options;
  if (typeof databasePath !== 'string' || !databasePath) fail('E_DB_PATH', '需要数据库路径。');
  if (options.beforePublish !== undefined && typeof options.beforePublish !== 'function') fail('E_DB_PUBLISH_GUARD', '发布前账号验证接口无效。');
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4096 || maximumBytes > 1024 * 1024 * 1024 || !Number.isSafeInteger(snapshotAttempts) || snapshotAttempts < 1 || snapshotAttempts > 5) fail('E_DB_LIMIT', '数据库快照限制无效。');
  let source, captured;
  let keyCandidates = [], selected, temporaryFolder, file, providerContext;
  try {
    try { source = await fs.realpath(databasePath); } catch { fail('E_DB_PATH', '数据库文件无法读取。'); }
    const destination = await outputTarget(source, options.output);
    const profiles = profilesFor(options);
    captured = await snapshot(source, { maximumBytes, snapshotAttempts });
    if (captured.database.length < 1024 || captured.database.subarray(0, 16).equals(SQLITE_HEADER)) fail('E_DB_HEADER', '此文件不是受支持的加密数据库。');
    const salt = Buffer.from(captured.database.subarray(0, 16));
    providerContext = { databasePath: source, salt, firstPage: Buffer.from(captured.database.subarray(0, 4096)), profiles };
    keyCandidates = await candidates(options, providerContext);
    for (const candidate of keyCandidates) {
      if (candidate.salt && !equal(candidate.salt, salt)) continue;
      const candidateProfiles = candidate.profile ? profiles.filter(profile => profile.id === (typeof candidate.profile === 'string' ? candidate.profile : candidate.profile.id)) : profiles;
      if (!candidateProfiles.length) continue;
      const valid = verifyDatabaseKey({ firstPage: captured.database.subarray(0, 4096), key: candidate.key, keyMode: candidate.mode, salt: candidate.salt, profiles: candidateProfiles });
      if (valid.valid) { selected = { ...derive(candidate.key, salt, valid.profile, valid.keyMode), keyMode: valid.keyMode }; break; }
    }
    salt.fill(0);
    if (!selected) fail('E_DB_KEY_INVALID', '候选密钥未通过数据库首页面认证。');
    const { profile } = selected;
    if (captured.database.length % profile.pageSize !== 0) fail('E_DB_SIZE', '数据库长度不是完整页的倍数。');
    const maximumPages = Math.floor(maximumBytes / profile.pageSize);
    const wal = parseDatabaseWal(captured.wal, { pageSize: profile.pageSize, maximumPages });
    const databasePages = captured.database.length / profile.pageSize;
    const finalPages = wal.commitPages ?? databasePages;
    if (!finalPages || finalPages > maximumPages) fail('E_DB_SIZE', '数据库提交页数无效。');
    temporaryFolder = await protectedDirectory(path.dirname(destination));
    const temporaryFile = path.join(temporaryFolder, 'database.sqlite');
    file = await fs.open(temporaryFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    for (let pageNumber = 1; pageNumber <= databasePages; pageNumber++) {
      const page = captured.database.subarray((pageNumber - 1) * profile.pageSize, pageNumber * profile.pageSize);
      const decoded = decodePage(page, pageNumber, selected);
      try { if (pageNumber <= finalPages) await writeAll(file, decoded, (pageNumber - 1) * profile.pageSize); }
      finally { decoded.fill(0); }
    }
    const addedPages = new Set();
    for (const frame of wal.frames) {
      if (frame.pageNumber === 1 && !frame.page.subarray(0, 16).equals(captured.database.subarray(0, 16))) fail('E_DB_WAL', 'WAL 首页 salt 与数据库不一致。');
      const decoded = decodePage(frame.page, frame.pageNumber, selected);
      try {
        if (frame.pageNumber <= finalPages) {
          await writeAll(file, decoded, (frame.pageNumber - 1) * profile.pageSize);
          if (frame.pageNumber > databasePages) addedPages.add(frame.pageNumber);
        }
      } finally { decoded.fill(0); }
    }
    for (let number = databasePages + 1; number <= finalPages; number++) if (!addedPages.has(number)) fail('E_DB_WAL', 'WAL 提交缺少扩展页面。');
    await file.truncate(finalPages * profile.pageSize);
    const header = Buffer.alloc(100);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !validHeader(header, profile)) fail('E_DB_HEADER', '解密后的数据库头部无效。');
    // The output is a standalone checkpointed snapshot; no plaintext WAL sidecar exists.
    header[18] = 1; header[19] = 1;
    header.writeUInt32BE(finalPages, 28);
    header.writeUInt32BE(header.readUInt32BE(24), 92);
    await writeAll(file, header, 0); header.fill(0);
    await file.sync(); await file.close(); file = null;
    const integrity = await quickCheck(temporaryFile);
    if (options.beforePublish) {
      try { if (await options.beforePublish() === false) fail('E_DB_PUBLISH_GUARD', '发布前账号验证未通过。'); }
      catch (error) { if (error instanceof WxError) throw error; fail('E_DB_PUBLISH_GUARD', '发布前账号验证失败。'); }
    }
    // A new hard link publishes atomically without overwriting any existing destination,
    // while keeping the protected temporary file's ACL (also on NTFS).
    try { await fs.link(temporaryFile, destination); }
    catch (error) { fail(error.code === 'EEXIST' ? 'E_DB_OUTPUT_EXISTS' : 'E_DB_OUTPUT', '无法安全发布解密副本。'); }
    const result = { ok: true, profile: profile.id, keyMode: selected.keyMode, pages: finalPages, bytes: finalPages * profile.pageSize, authenticatedPages: databasePages + wal.committedFrames, wal: { present: captured.wal.length > 0, committedFrames: wal.committedFrames, uncommittedFrames: wal.uncommittedFrames, staleBytes: wal.staleBytes }, ...integrity };
    Object.defineProperty(result, 'outputPath', { value: destination, enumerable: false });
    return result;
  } catch (error) { if (error instanceof WxError) throw error; fail('E_DB_DECRYPT', '离线数据库解密失败。'); }
  finally {
    await file?.close().catch(() => {});
    for (const candidate of keyCandidates) { candidate.key.fill(0); candidate.salt?.fill(0); }
    erase(selected); captured?.database.fill(0); captured?.wal.fill(0);
    providerContext?.salt.fill(0); providerContext?.firstPage.fill(0);
    if (temporaryFolder) {
      try { await fs.rm(temporaryFolder, { recursive: true, force: true }); }
      catch { fail('E_DB_CLEANUP', '明文临时目录清理失败。'); }
    }
  }
}
