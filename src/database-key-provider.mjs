import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyDatabaseKey, SUPPORTED_CIPHER_PROFILES } from './database-decrypt.mjs';
import { WxError } from './errors.mjs';

export const DATABASE_KEY_PROCESS_ACCESS = 0x410; // QUERY_INFORMATION | VM_READ only.
const MAX_ADDRESS = 0x7fffffffffffn;
const COMMIT = 0x1000, PRIVATE = 0x20000, GUARD = 0x100;
const WRITABLE = new Set([0x04, 0x08, 0x40, 0x80]);
const READABLE = new Set([0x02, 0x04, 0x08, 0x20, 0x40, 0x80]);
const OVERLAP = 128;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const RAW_BLOB_PREFIXES = [Buffer.from("x'"), Buffer.from("X'")];
const CODEC_LAYOUTS = [
  { id: 'sqlcipher-4.5', legacy: true, flags: 64, saltPointer: 72, readPointer: 104, writePointer: 112, bytes: 120 },
  { id: 'sqlcipher-current', legacy: false, flags: 56, saltPointer: 64, readPointer: 96, writePointer: 104, bytes: 112 }
];
const fail = (code, message) => { throw new WxError(code, message); };
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);
let nativeApiPromise;

async function executableArchitecture(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await file.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) return 'unknown';
    const offset = dos.readUInt32LE(0x3c);
    if (offset < 64 || offset > 1024 * 1024) return 'unknown';
    const pe = Buffer.alloc(26);
    if ((await file.read(pe, 0, pe.length, offset)).bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x4550) return 'unknown';
    return pe.readUInt16LE(4) === 0x8664 && pe.readUInt16LE(24) === 0x20b ? 'x64' : 'unknown';
  } finally { await file.close(); }
}

/** Binds only read/query/close Win32 APIs. Binding performs no target-process call. */
export async function createWin32DatabaseKeyApi({ koffiImpl, systemRoot = process.env.SystemRoot ?? 'C:\\Windows' } = {}) {
  try {
    const koffi = koffiImpl ?? (await import('koffi')).default;
    const kernel = koffi.load(path.win32.join(systemRoot, 'System32', 'kernel32.dll'));
    const open = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
    const queryImage = kernel.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ char16_t *name, _Inout_ uint32_t *size)');
    // On the required x64 ABI, uintptr_t has the exact LPCVOID register width.
    // Integer addresses avoid loss of precision or dereferencing a remote pointer locally.
    const query = kernel.func('size_t __stdcall VirtualQueryEx(void *process, uintptr_t address, _Out_ uint8_t *info, size_t length)');
    const read = kernel.func('int __stdcall ReadProcessMemory(void *process, uintptr_t address, _Out_ uint8_t *buffer, size_t length, _Out_ size_t *bytesRead)');
    const close = kernel.func('int __stdcall CloseHandle(void *process)');
    return {
      openProcess: pid => open(DATABASE_KEY_PROCESS_ACCESS, 0, pid),
      imagePath: handle => {
        const buffer = Buffer.alloc(32768 * 2), size = [32768];
        try {
          if (!queryImage(handle, 0, buffer, size) || !Number.isSafeInteger(size[0]) || size[0] < 1 || size[0] >= 32768) fail('E_DB_KEY_PROCESS', '无法验证微信进程映像。');
          return buffer.toString('utf16le', 0, size[0] * 2);
        } finally { buffer.fill(0); }
      },
      queryRegion: (handle, address) => {
        // MEMORY_BASIC_INFORMATION64 is 48 bytes. Native x64 MBI also places
        // RegionSize at 24, State/Protect/Type at 32/36/40 (PartitionId is in padding).
        const buffer = Buffer.alloc(48);
        if (Number(query(handle, address, buffer, buffer.length)) !== 48) return null;
        return { baseAddress: buffer.readBigUInt64LE(0), regionSize: buffer.readBigUInt64LE(24), state: buffer.readUInt32LE(32), protect: buffer.readUInt32LE(36), type: buffer.readUInt32LE(40) };
      },
      readMemory: (handle, address, length) => {
        const bytes = Buffer.alloc(length), count = [0];
        const ok = !!read(handle, address, bytes, length, count);
        const bytesRead = Number(count[0]);
        return { ok, bytesRead, bytes };
      },
      closeHandle: handle => !!close(handle)
    };
  } catch (error) { if (error instanceof WxError) throw error; fail('E_DB_KEY_API', '无法初始化只读 Windows 内存接口。'); }
}

function nibble(byte) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 65 && byte <= 70) return byte - 55;
  if (byte >= 97 && byte <= 102) return byte - 87;
  return -1;
}
function decodeHex(bytes, offset, size) {
  const result = Buffer.alloc(size);
  for (let index = 0; index < size; index++) {
    const hi = nibble(bytes[offset + index * 2]), lo = nibble(bytes[offset + index * 2 + 1]);
    if (hi < 0 || lo < 0) { result.fill(0); return null; }
    result[index] = (hi << 4) | lo;
  }
  return result;
}
function saltMatches(bytes, offset, salt) {
  for (let index = 0; index < 16; index++) if (((nibble(bytes[offset + index * 2]) << 4) | nibble(bytes[offset + index * 2 + 1])) !== salt[index] || nibble(bytes[offset + index * 2]) < 0 || nibble(bytes[offset + index * 2 + 1]) < 0) return false;
  return true;
}
function profileList(values = SUPPORTED_CIPHER_PROFILES) {
  if (!Array.isArray(values) || !values.length || values.length > 3) fail('E_DB_CIPHER_PROFILE', '密钥验证参数候选无效。');
  return [...new Set(values.map(value => typeof value === 'string' ? value : value?.id))].map(id => {
    const profile = SUPPORTED_CIPHER_PROFILES.find(value => value.id === id);
    if (!profile) fail('E_DB_CIPHER_PROFILE', '不支持此密钥验证参数。');
    return profile;
  });
}
function limit(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function codecSignatures(profiles) {
  return profiles.flatMap(profile => CODEC_LAYOUTS.flatMap(layout => (layout.legacy ? [96, 99, 100] : [null]).map(keyspecBytes => {
    const algorithm = profile.hmac === 'sha512' ? 2 : 0;
    const values = [2, 16, 32, 16, 16, profile.pageSize, ...(layout.legacy ? [keyspecBytes] : []), profile.reserveSize, profile.hmacBytes, 0, algorithm, algorithm];
    const signature = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => signature.writeUInt32LE(value, index * 4));
    return { layout, profile, signature };
  })));
}
function guardIdentity(value, pid) {
  if (!value || value.pid !== pid || value.accountVerified !== true || typeof value.self !== 'string' || value.self.length < 1 || value.self.length > 256 || /[\0\r\n]/.test(value.self) || value.self.endsWith('@chatroom') || typeof value.generation !== 'string' || !value.generation || value.generation.length > 128) fail('E_DB_KEY_ACCOUNT', '密钥扫描需要已验证的当前微信账号与运行代次。');
  return { pid, self: value.self, generation: value.generation };
}
function publicKeyResult(key, mode, salt, verified) {
  const result = { found: true, mode, ...(verified?.profile ? { profile: verified.profile } : {}) };
  Object.defineProperty(result, 'key', { value: Buffer.from(key), enumerable: false });
  if (salt) Object.defineProperty(result, 'salt', { value: Buffer.from(salt), enumerable: false });
  Object.defineProperty(result, 'toJSON', { value: () => ({ found: true, mode, ...(verified?.profile ? { profile: typeof verified.profile === 'string' ? verified.profile : verified.profile.id } : {}) }), enumerable: false });
  return result;
}

/**
 * Read-only, bounded candidate acquisition for a verified own Weixin x64 process.
 * accountGuard({phase,pid}) must return {pid,self,generation,accountVerified:true}.
 * No keys/addresses/identity/path are logged or persisted. Caller must wipe result.key.
 * Dependencies are injectable for tests; no test needs a real target process.
 */
export async function findDatabaseKey(options = {}, deps = {}) {
  const { pid, expectedExePath, firstPage, accountGuard, maxMemoryBytes = 512 * 1024 * 1024, timeoutMs = 15000, maxCandidates = 128, maxPassphraseCandidates = 2, maxContextCandidates = 64, maxPointerReads = 256, chunkSize = 1024 * 1024, maxRegions = 65536 } = options;
  if ((deps.platform ?? process.platform) !== 'win32' || (deps.arch ?? process.arch) !== 'x64') fail('E_DB_KEY_PLATFORM', '自动密钥候选获取仅支持 Windows x64。');
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff || typeof expectedExePath !== 'string' || !path.win32.isAbsolute(expectedExePath) || path.win32.basename(expectedExePath).toLowerCase() !== 'weixin.exe') fail('E_DB_KEY_PROCESS', '需要已验证的微信 PID 与绝对映像路径。');
  if (!(firstPage instanceof Uint8Array) || firstPage.length < 1024 || firstPage.length > 65536 || Buffer.from(firstPage).subarray(0, 16).equals(SQLITE_HEADER)) fail('E_DB_HEADER', '密钥扫描需要加密数据库首页面。');
  if (typeof accountGuard !== 'function') fail('E_DB_KEY_ACCOUNT', '密钥扫描需要当前账号前后验证接口。');
  if (!limit(maxMemoryBytes, 4096, 1024 * 1024 * 1024) || !limit(timeoutMs, 100, 30000) || !limit(maxCandidates, 1, 256) || !limit(maxPassphraseCandidates, 0, 8) || !limit(maxContextCandidates, 0, 256) || !limit(maxPointerReads, 0, 1024) || !limit(chunkSize, 128, 4 * 1024 * 1024) || !limit(maxRegions, 1, 262144)) fail('E_DB_KEY_LIMIT', '密钥扫描范围、时间或候选限制无效。');
  const profiles = profileList(options.profiles);
  const contextSignatures = codecSignatures(profiles), seenContexts = new Set();
  const now = deps.now ?? (() => performance.now());
  const deadline = now() + timeoutMs;
  // Reserve part of the same total deadline for raw fallback and the final guard.
  // No extra timeout is added when the primary scan finishes its own budget.
  const primaryDeadline = deadline - Math.min(1500, Math.max(25, Math.floor(timeoutMs / 5)));
  const checkTime = () => { if (now() >= deadline) fail('E_DB_KEY_TIMEOUT', '只读密钥扫描达到时间上限。'); };
  const bounded = async operation => {
    checkTime();
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new WxError('E_DB_KEY_TIMEOUT', '只读密钥扫描达到时间上限。')), Math.max(1, deadline - now())); })]);
    } finally { clearTimeout(timer); }
  };
  const canonicalPath = deps.canonicalPath ?? (value => fs.realpath(value));
  const readArchitecture = deps.readExeArchitecture ?? executableArchitecture;
  const verify = options.verifyCandidate ?? deps.verifyCandidate ?? verifyDatabaseKey;
  const page = Buffer.from(firstPage), salt = Buffer.from(page.subarray(0, 16));
  const fallback = [], primarySeen = [];
  const readRegions = new Set();
  let handle, reader, selected, finalIdentity, carry = Buffer.alloc(0), rawChecks = 0, scannedBytes = 0, beforeIdentity, failure, primaryBudgetEnded = false, contextChecks = 0, pointerReads = 0, queriedRegions = 0, readFailures = 0, memoryBytesRead = 0, contextSaltMatches = 0, passphraseChecks = 0;
  let legacyContextCandidates = 0, currentContextCandidates = 0, legacySaltMatches = 0, currentSaltMatches = 0, contextCipherReads = 0, contextEmptyPassReads = 0, contextPendingDerivationReads = 0, contextKeyReads = 0, contextZeroKeyReads = 0, contextRawChecks = 0, contextRawFailures = 0, contextHmacKeyReads = 0, contextZeroHmacKeyReads = 0, storedHmacPageMatches = 0, contextKeyspecReads = 0, contextKeyspecMatches = 0, contextKeyspecRawChecks = 0, hmacFailures = 0, headerFailures = 0, otherVerificationFailures = 0;
  const stats = () => ({ scannedBytes, memoryBytesRead, regionsRead: readRegions.size, regionsQueried: queriedRegions, rawChecks, passphraseChecks, contextCandidates: contextChecks, contextSaltMatches, legacyContextCandidates, currentContextCandidates, legacySaltMatches, currentSaltMatches, contextCipherReads, contextEmptyPassReads, contextPendingDerivationReads, contextKeyReads, contextZeroKeyReads, contextRawChecks, contextRawFailures, contextHmacKeyReads, contextZeroHmacKeyReads, storedHmacPageMatches, contextKeyspecReads, contextKeyspecMatches, contextKeyspecRawChecks, hmacFailures, headerFailures, otherVerificationFailures, pointerReads, readFailures });
  try {
    const expected = await bounded(() => canonicalPath(expectedExePath));
    if (await bounded(() => readArchitecture(expected)) !== 'x64') fail('E_DB_KEY_ARCH', '微信进程映像未通过 x64 PE 验证。');
    beforeIdentity = guardIdentity(await bounded(() => accountGuard({ phase: 'before', pid })), pid);
    reader = deps.winapi ?? await bounded(() => nativeApiPromise ??= createWin32DatabaseKeyApi({ koffiImpl: deps.koffiImpl }));
    // Native OpenProcess is synchronous; assign the handle before another deadline
    // check so even an expired budget cannot lose ownership of an opened handle.
    checkTime(); handle = reader.openProcess(pid, DATABASE_KEY_PROCESS_ACCESS); checkTime();
    if (!handle) fail('E_DB_KEY_ACCESS', '无法以只读权限打开已验证的微信进程。');
    const requireImage = async () => {
      const image = await bounded(() => reader.imagePath(handle));
      const actual = await bounded(() => canonicalPath(image));
      if (path.win32.normalize(actual).toLowerCase() !== path.win32.normalize(expected).toLowerCase()) fail('E_DB_KEY_PROCESS', '微信进程映像与已验证路径不一致。');
    };
    await requireImage();
    const queryRegion = async address => {
      if (queriedRegions >= maxRegions) return null;
      queriedRegions++;
      return bounded(() => reader.queryRegion(handle, address));
    };
    const readPointer = async (address, length, window, windowAddress) => {
      if (address < 65536n || address + BigInt(length) > MAX_ADDRESS + 1n || pointerReads >= maxPointerReads) return null;
      checkTime();
      if (now() >= primaryDeadline) { primaryBudgetEnded = true; return null; }
      pointerReads++;
      // Reuse the current already-validated private writable window when possible.
      if (address >= windowAddress && address + BigInt(length) <= windowAddress + BigInt(window.length)) return Buffer.from(window.subarray(Number(address - windowAddress), Number(address - windowAddress) + length));
      const region = await queryRegion(address);
      if (!region) return null;
      const base = BigInt(region.baseAddress), end = base + BigInt(region.regionSize);
      if (base > address || address + BigInt(length) > end || region.state !== COMMIT || (region.protect & GUARD) || !READABLE.has(region.protect & 0xff) || scannedBytes + length > maxMemoryBytes) return null;
      scannedBytes += length;
      let result;
      try {
        result = await bounded(() => reader.readMemory(handle, address, length));
        if (!result?.ok || result.bytesRead !== length || !(result.bytes instanceof Uint8Array) || result.bytes.length !== length) { readFailures++; return null; }
        memoryBytesRead += length; readRegions.add(base);
        return Buffer.from(result.bytes);
      } finally { result?.bytes?.fill(0); }
    };
    const validate = async (key, mode) => {
      checkTime();
      const value = await bounded(() => verify({ firstPage: page, key, keyMode: mode, mode, salt, profiles }));
      checkTime();
      const result = value === true ? { valid: true } : value;
      if (result?.valid !== true) {
        if (result?.reason === 'authentication-failed') hmacFailures++;
        else if (result?.reason === 'sqlite-header-invalid') headerFailures++;
        else otherVerificationFailures++;
      }
      return result;
    };
    const tryPrimary = async key => {
      if (primarySeen.some(value => equal(value, key))) { key.fill(0); return { checked: false }; }
      if (rawChecks >= maxCandidates) { key.fill(0); fail('E_DB_KEY_CANDIDATE_LIMIT', '只读密钥验证达到候选上限。'); }
      primarySeen.push(key); rawChecks++;
      const verified = await validate(key, 'raw');
      if (verified?.valid === true) selected = publicKeyResult(key, 'raw', salt, verified);
      return { checked: true, valid: verified?.valid === true };
    };
    const scan = async (bytes, windowAddress) => {
      // Salt-matched x'96hex' is considered before every generic hexadecimal run.
      for (const prefix of RAW_BLOB_PREFIXES) {
        for (let offset = bytes.indexOf(prefix); offset >= 0 && offset + 99 <= bytes.length; offset = bytes.indexOf(prefix, offset + 2)) {
          checkTime();
          if (now() >= primaryDeadline) { primaryBudgetEnded = true; return; }
          if (bytes[offset + 98] !== 0x27 || !saltMatches(bytes, offset + 66, salt)) continue;
          const key = decodeHex(bytes, offset + 2, 32);
          if (key) await tryPrimary(key);
          if (selected) return;
        }
      }
      // These public layouts are candidates, not an asserted Tencent ABI.
      // Salt equality and first-page authentication determine whether a key is usable.
      for (const { layout, profile, signature } of contextSignatures) {
        if (contextChecks >= maxContextCandidates || pointerReads >= maxPointerReads) break;
        for (let offset = bytes.indexOf(signature); offset >= 0; offset = bytes.indexOf(signature, offset + 4)) {
          checkTime();
          if (now() >= primaryDeadline) { primaryBudgetEnded = true; return; }
          const start = offset - 8, address = windowAddress + BigInt(start);
          if (start < 0 || start + layout.bytes > bytes.length || address % 8n !== 0n || seenContexts.has(address) || contextChecks >= maxContextCandidates) continue;
          const header = bytes.subarray(start, start + layout.bytes), flags = header.readUInt32LE(layout.flags);
          if (![0, 1].includes(header.readUInt32LE(0)) || header.readUInt32LE(4) < 1 || header.readUInt32LE(4) > 1000000 || (flags & 7) !== 3 || (layout.legacy ? header.readUInt32LE(56) !== 0 || header.readUInt32LE(60) > 1 : header.readUInt32LE(52) !== 0)) continue;
          seenContexts.add(address); contextChecks++;
          if (layout.legacy) legacyContextCandidates++; else currentContextCandidates++;
          let contextSalt;
          try {
            contextSalt = await readPointer(header.readBigUInt64LE(layout.saltPointer), 16, bytes, windowAddress);
            if (!contextSalt || !equal(contextSalt, salt)) continue;
            contextSaltMatches++;
            if (layout.legacy) legacySaltMatches++; else currentSaltMatches++;
            for (const cipherOffset of [layout.readPointer, layout.writePointer]) {
              let cipher, candidate, hmacKey, hmacTag, keyspec;
              try {
                cipher = await readPointer(header.readBigUInt64LE(cipherOffset), layout.legacy ? 40 : 32, bytes, windowAddress);
                if (!cipher) continue;
                contextCipherReads++;
                if (cipher.readUInt32LE(4) === 0) contextEmptyPassReads++;
                if (cipher.readUInt32LE(0) === 1) contextPendingDerivationReads++;
                if (cipher.readUInt32LE(0) !== 0 || cipher.readUInt32LE(4) > 4096) continue;
                // The documented legacy getter uses cipher_ctx.keyspec at +32.
                // It may reside outside globally scanned writable regions.
                if (layout.legacy && header.readUInt32LE(32) >= 99) {
                  keyspec = await readPointer(cipher.readBigUInt64LE(32), 99, bytes, windowAddress);
                  if (keyspec) {
                    contextKeyspecReads++;
                    if ([0x78, 0x58].includes(keyspec[0]) && keyspec[1] === 0x27 && keyspec[98] === 0x27 && saltMatches(keyspec, 66, salt)) {
                      contextKeyspecMatches++;
                      candidate = decodeHex(keyspec, 2, 32);
                      if (candidate) {
                        const result = await tryPrimary(candidate); candidate = null;
                        if (result.checked) contextKeyspecRawChecks++;
                        if (selected) return;
                      }
                    }
                  }
                }
                // Diagnostic only: a stored HMAC key can identify the page's context,
                // but can never authorize an AES candidate or skip its header check.
                if (page.length >= profile.pageSize) {
                  hmacKey = await readPointer(cipher.readBigUInt64LE(16), 32, bytes, windowAddress);
                  if (hmacKey) {
                    contextHmacKeyReads++;
                    if (hmacKey.every(byte => byte === 0)) contextZeroHmacKeyReads++;
                    const tagPosition = profile.pageSize - profile.reserveSize + 16;
                    const pgno = Buffer.alloc(4); pgno.writeUInt32LE(1);
                    hmacTag = createHmac(profile.hmac, hmacKey).update(page.subarray(16, tagPosition)).update(pgno).digest();
                    if (equal(hmacTag, page.subarray(tagPosition, tagPosition + profile.hmacBytes))) storedHmacPageMatches++;
                  }
                }
                candidate = await readPointer(cipher.readBigUInt64LE(8), 32, bytes, windowAddress);
                if (!candidate) continue;
                contextKeyReads++;
                if (candidate.every(byte => byte === 0)) contextZeroKeyReads++;
                const result = await tryPrimary(candidate); candidate = null; // tryPrimary owns and wipes it.
                if (result.checked) { contextRawChecks++; if (!result.valid) contextRawFailures++; }
                if (selected) return;
              } finally { cipher?.fill(0); candidate?.fill(0); hmacKey?.fill(0); hmacTag?.fill(0); keyspec?.fill(0); }
            }
          } finally { contextSalt?.fill(0); }
        }
      }
      if (fallback.length >= maxCandidates) return;
      // Every 64-byte hex run contains at least one position on this 64-byte grid.
      // Expand only those sparse anchors; this avoids a second full bytewise walk.
      for (let anchor = 0; anchor < bytes.length && fallback.length < maxCandidates; anchor += 64) {
        if ((anchor & 0xffff) === 0) {
          checkTime();
          if (now() >= primaryDeadline) { primaryBudgetEnded = true; return; }
        }
        if (nibble(bytes[anchor]) < 0) continue;
        let start = anchor, end = anchor + 1;
        while (start > 0 && anchor - start < 65 && nibble(bytes[start - 1]) >= 0) start--;
        while (end < bytes.length && end - start <= 64 && nibble(bytes[end]) >= 0) end++;
        if (end - start === 64 && end < bytes.length && (start === 0 || nibble(bytes[start - 1]) < 0)) {
          const key = decodeHex(bytes, start, 32);
          if (key && !fallback.some(value => equal(value, key))) fallback.push(key);
          else key?.fill(0);
        }
      }
    };
    let address = 0n;
    for (; queriedRegions < maxRegions && address <= MAX_ADDRESS && scannedBytes < maxMemoryBytes && !selected && !primaryBudgetEnded;) {
      checkTime();
      if (now() >= primaryDeadline) break;
      const region = await queryRegion(address);
      if (!region) break;
      const base = BigInt(region.baseAddress), size = BigInt(region.regionSize), next = base + size;
      if (base < 0n || base > address || size < 1n || next <= address || next > MAX_ADDRESS + 1n) fail('E_DB_KEY_MEMORY_LAYOUT', '只读内存区域布局无效。');
      carry.fill(0); carry = Buffer.alloc(0);
      if (region.state === COMMIT && region.type === PRIVATE && !(region.protect & GUARD) && WRITABLE.has(region.protect & 0xff)) {
        for (let position = address; position < next && scannedBytes < maxMemoryBytes && !selected && !primaryBudgetEnded;) {
          const length = Number([BigInt(chunkSize), next - position, BigInt(maxMemoryBytes - scannedBytes)].reduce((a, b) => a < b ? a : b));
          if (length < 1) break;
          checkTime(); scannedBytes += length;
          if (now() >= primaryDeadline) { primaryBudgetEnded = true; break; }
          const read = await bounded(() => reader.readMemory(handle, position, length));
          let bytes;
          try {
            if (!read || !(read.bytes instanceof Uint8Array) || !read.ok || read.bytesRead !== length || read.bytes.length !== length) { readFailures++; carry.fill(0); carry = Buffer.alloc(0); continue; }
            memoryBytesRead += length; readRegions.add(base);
            bytes = Buffer.concat([carry, read.bytes]);
            await scan(bytes, position - BigInt(carry.length));
            carry.fill(0); carry = Buffer.from(bytes.subarray(Math.max(0, bytes.length - OVERLAP)));
          } finally { bytes?.fill(0); read?.bytes?.fill(0); position += BigInt(length); }
        }
      }
      address = next;
    }
    if (!selected) for (const key of fallback) {
      if (primarySeen.some(value => equal(value, key))) continue;
      if (rawChecks >= maxCandidates) break;
      rawChecks++;
      const verified = await validate(key, 'raw');
      if (verified?.valid === true) { selected = publicKeyResult(key, 'raw', undefined, verified); break; }
    }
    if (!selected) for (const key of fallback.slice(0, maxPassphraseCandidates)) {
      passphraseChecks++;
      const verified = await validate(key, 'passphrase');
      if (verified?.valid === true) { selected = publicKeyResult(key, 'passphrase', undefined, verified); break; }
    }
    await requireImage();
    finalIdentity = guardIdentity(await bounded(() => accountGuard({ phase: 'after', pid })), pid);
    if (beforeIdentity.self !== finalIdentity.self || beforeIdentity.generation !== finalIdentity.generation) fail('E_DB_KEY_ACCOUNT_CHANGED', '扫描期间微信账号或运行代次发生变化。');
    if (!selected) fail('E_DB_KEY_NOT_FOUND', '在有限只读范围内未找到通过页面认证的密钥候选。');
    return selected;
  } catch (error) {
    failure = error instanceof WxError ? error : new WxError('E_DB_KEY_SCAN', '只读密钥候选扫描失败。');
    if (/^E_DB_KEY_[A-Z0-9_]+$/.test(failure.code)) failure.details = stats();
    selected?.key.fill(0); selected?.salt?.fill(0);
    throw failure;
  } finally {
    carry.fill(0); page.fill(0); salt.fill(0);
    seenContexts.clear();
    readRegions.clear();
    for (const key of [...fallback, ...primarySeen]) key.fill(0);
    if (handle) {
      let closed = false;
      try { closed = await reader.closeHandle(handle); } catch { /* sanitized below */ }
      if (!closed && !failure) { selected?.key.fill(0); selected?.salt?.fill(0); fail('E_DB_KEY_HANDLE', '只读微信进程句柄未能正常关闭。'); }
    }
  }
}
