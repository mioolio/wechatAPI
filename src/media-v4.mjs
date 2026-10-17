import { createDecipheriv, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { createWin32DatabaseKeyApi } from './database-key-provider.mjs';
import { WxError } from './errors.mjs';

const V1 = Buffer.from([7, 8, 86, 49, 8, 7]), V2 = Buffer.from([7, 8, 86, 50, 8, 7]);
const credentials = new WeakMap();
const fail = (code, message) => new WxError(code, message);
const isAsciiKeyByte = byte => (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
const hasImageHeader = bytes => bytes.length >= 12 && ((bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') || bytes.subarray(0, 4).toString('ascii') === 'wxgf');

export function v4MediaVersion(bytes) {
  if (bytes.length < 6) return 0;
  return bytes.subarray(0, 6).equals(V1) ? 1 : bytes.subarray(0, 6).equals(V2) ? 2 : 0;
}

function layout(bytes) {
  if (!v4MediaVersion(bytes) || bytes.length < 31) throw fail('E_MEDIA_V4_FORMAT', '图片缓存的 V4 结构无效。');
  const aesSize = bytes.readUInt32LE(6), xorSize = bytes.readUInt32LE(10), encryptedSize = aesSize + 16 - (aesSize % 16);
  if (!aesSize || aesSize > 50 * 1024 * 1024 || encryptedSize > bytes.length - 15 || xorSize > bytes.length - 15 - encryptedSize) throw fail('E_MEDIA_V4_FORMAT', '图片缓存的加密区间越界。');
  return { aesSize, xorSize, encryptedSize };
}

/** V4 layout independently checked against WeFlow's public JS image decryptor. */
export function decodeV4MediaBytes(input, { aesKey, xorKey } = {}) {
  const bytes = Buffer.from(input), { aesSize, xorSize, encryptedSize } = layout(bytes);
  const version = v4MediaVersion(bytes);
  const key = version === 1 ? Buffer.from('cfcd208495d565ef', 'ascii') : Buffer.isBuffer(aesKey) && aesKey.length === 16 ? aesKey : null;
  if (!key) throw fail('E_MEDIA_IMAGE_KEY', '当前 V2 图片缓存缺少经过验证的本机图片密钥。');
  let prefix;
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    prefix = Buffer.concat([decipher.update(bytes.subarray(15, 15 + encryptedSize)), decipher.final()]);
  } catch { throw fail('E_MEDIA_IMAGE_KEY', '图片缓存 AES 密钥或填充验证失败。'); }
  if (prefix.length !== aesSize || !hasImageHeader(prefix)) { prefix.fill(0); throw fail('E_MEDIA_IMAGE_KEY', '图片缓存 AES 结果未通过长度与图像头校验。'); }
  const raw = bytes.subarray(15 + encryptedSize, bytes.length - xorSize), tail = Buffer.from(bytes.subarray(bytes.length - xorSize));
  if (xorSize) {
    let selected = xorKey;
    if (selected === undefined && prefix[0] === 255 && prefix[1] === 216 && tail.length >= 2 && (tail.at(-2) ^ 255) === (tail.at(-1) ^ 217)) selected = tail.at(-2) ^ 255;
    if (selected === undefined && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && tail.length >= 8) {
      const ending = Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]), candidate = tail.at(-1) ^ ending.at(-1);
      if (ending.every((byte, index) => (tail[tail.length - 8 + index] ^ candidate) === byte)) selected = candidate;
    }
    if (!Number.isInteger(selected) || selected < 0 || selected > 255) { prefix.fill(0); throw fail('E_MEDIA_IMAGE_XOR_KEY', '图片缓存尾部缺少可验证的 XOR 密钥。'); }
    for (let index = 0; index < tail.length; index++) tail[index] ^= selected;
  }
  return Buffer.concat([prefix, raw, tail]);
}

function validateKey(template, candidate) {
  let decrypted;
  try {
    const decipher = createDecipheriv('aes-128-ecb', candidate, null); decipher.setAutoPadding(false);
    decrypted = Buffer.concat([decipher.update(template.subarray(15, 47)), decipher.final()]);
    return hasImageHeader(decrypted);
  } catch { return false; }
  finally { decrypted?.fill(0); }
}

/** Bounded read-only current-process key discovery; successful keys are non-serializable and wipeable. */
export async function findV4ImageKey({ pid, template, expectedExePath, self, guard, maxMemoryBytes = 512 * 1024 * 1024, timeoutMs = 15000, maximumCandidates = 250000 } = {}, { reader, platform = process.platform } = {}) {
  if (platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1 || !Buffer.isBuffer(template) || v4MediaVersion(template) !== 2 || template.length < 47 || typeof guard !== 'function') throw fail('E_MEDIA_KEY_ARGUMENT', '图片密钥发现需要明确的微信 PID、V2 样本和当前账号校验。');
  if (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes < 4096 || maxMemoryBytes > 1024 * 1024 * 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 || !Number.isSafeInteger(maximumCandidates) || maximumCandidates < 1 || maximumCandidates > 1000000) throw fail('E_MEDIA_KEY_ARGUMENT', '图片密钥扫描限制无效。');
  layout(template);
  const api = reader ?? await createWin32DatabaseKeyApi(), started = performance.now(), seen = new Set();
  if (self !== undefined && (typeof self !== 'string' || !/^[A-Za-z0-9_.:@-]{1,256}$/.test(self))) throw fail('E_MEDIA_KEY_ARGUMENT', '图片密钥派生需要已验证的当前账号 ID。');
  const selfBytes = self ? Buffer.from(self, 'utf8') : null;
  let handle, scannedBytes = 0, candidates = 0, regions = 0, pointerReads = 0;
  const withinBudget = () => { if (performance.now() - started > timeoutMs || scannedBytes > maxMemoryBytes || candidates >= maximumCandidates) throw fail('E_MEDIA_KEY_LIMIT', '只读图片密钥扫描达到时间、内存或候选上限。'); };
  const prove = async () => { if (await guard() !== true) throw fail('E_ACCOUNT_CHANGED', '图片密钥扫描期间当前账号验证失败。'); const executable = await api.imagePath(handle); if (path.win32.basename(executable).toLowerCase() !== 'weixin.exe' || (expectedExePath && path.win32.resolve(executable).toLowerCase() !== path.win32.resolve(expectedExePath).toLowerCase())) throw fail('E_MEDIA_KEY_PROCESS', '图片密钥扫描目标不是已验证的微信进程。'); };
  const accept = async (candidate, xorKey) => {
    if (!validateKey(template, candidate)) { candidate.fill(0); return null; }
    try { await prove(); } catch (cause) { candidate.fill(0); throw cause; }
    const result = { found: true, pid, scannedBytes, candidates, regions, source: 'read-only-process-memory', dispose() { credentials.get(this)?.fill(0); credentials.delete(this); }, decode(bytes, options = {}) { const key = credentials.get(this); if (!key) throw fail('E_MEDIA_IMAGE_KEY', '图片密钥已释放。'); return decodeV4MediaBytes(bytes, { xorKey, ...options, aesKey: key }); } };
    credentials.set(result, candidate); return result;
  };
  try {
    handle = await api.openProcess(pid); if (!handle) throw fail('E_MEDIA_KEY_PROCESS', '无法打开微信的只读进程句柄。'); await prove();
    let address = 0n;
    while (address < 0x7fffffffffffn && regions < 65536) {
      withinBudget(); const region = await api.queryRegion(handle, address); regions++;
      if (!region || region.regionSize <= 0n) break;
      const end = region.baseAddress + region.regionSize; if (end <= address) throw fail('E_MEDIA_KEY_PROCESS', '微信内存区域边界无效。');
      if (region.state === 0x1000 && region.type === 0x20000 && !(region.protect & 0x100) && [0x02, 0x04, 0x08, 0x20, 0x40, 0x80].includes(region.protect & 0xff)) {
        for (let cursor = region.baseAddress; cursor < end; cursor += 1024n * 1024n - 64n) {
          withinBudget(); if (scannedBytes >= maxMemoryBytes) throw fail('E_MEDIA_KEY_LIMIT', '只读图片密钥扫描达到内存上限。');
          const count = Math.min(Number(end - cursor), 1024 * 1024, maxMemoryBytes - scannedBytes);
          const result = await api.readMemory(handle, cursor, count); scannedBytes += count;
          const data = result.bytes;
          try {
            if (!result.ok || result.bytesRead !== count || !Buffer.isBuffer(data)) continue;
            if (selfBytes) for (let offset = 8; offset + 32 <= data.length; offset += 8) {
              if (data.readBigUInt64LE(offset + 16) !== BigInt(selfBytes.length)) continue;
              const capacity = data.readBigUInt64LE(offset + 24); if (capacity < BigInt(selfBytes.length) || capacity > 4096n || (capacity < 16n && capacity !== 15n)) continue;
              let account;
              if (capacity < 16n) account = data.subarray(offset, offset + selfBytes.length);
              else {
                const pointer = data.readBigUInt64LE(offset); if (pointer < 0x10000n || pointer > 0x7fffffffffffn || pointerReads >= 512) continue;
                const existing = pointer - cursor;
                if (existing >= 0n && existing + BigInt(selfBytes.length + 1) <= BigInt(data.length)) account = data.subarray(Number(existing), Number(existing) + selfBytes.length);
                else { pointerReads++; const remote = await api.readMemory(handle, pointer, selfBytes.length + 1); if (remote.ok && remote.bytesRead === selfBytes.length + 1 && remote.bytes?.[selfBytes.length] === 0) account = remote.bytes.subarray(0, selfBytes.length); else remote.bytes?.fill(0); }
              }
              if (!account?.equals(selfBytes)) { if (account && account.buffer !== data.buffer) account.fill(0); continue; }
              if (account.buffer !== data.buffer) account.fill(0);
              const dword = data.readUInt32LE(offset - 8), candidate = Buffer.from(createHash('md5').update(`${dword}${self}`).digest('hex').slice(0, 16), 'ascii');
              withinBudget(); candidates++; const accepted = await accept(candidate, dword & 255); if (accepted) return accepted;
            }
            for (let offset = 0; offset + 16 <= data.length; offset++) {
              if (offset && isAsciiKeyByte(data[offset - 1])) continue;
              let length = 0; while (offset + length < data.length && length < 33 && isAsciiKeyByte(data[offset + length])) length++;
              if (length !== 16 && length !== 32) { offset += length; continue; }
              const candidate = Buffer.from(data.subarray(offset, offset + 16)), identity = candidate.toString('hex');
              if (seen.has(identity)) { candidate.fill(0); offset += length; continue; }
              withinBudget(); seen.add(identity); candidates++;
              const accepted = await accept(candidate); if (accepted) return accepted;
              offset += length; if (candidates % 1000 === 0) withinBudget();
            }
          } finally { data?.fill(0); }
        }
      }
      address = end;
    }
    throw new WxError('E_MEDIA_IMAGE_KEY', '没有找到能够验证当前 V2 图片的本机密钥。', { scannedBytes, candidates, regions, pointerReads });
  } finally { if (handle) await api.closeHandle(handle); seen.clear(); }
}

/** One archive operation, one lazy discovery, no persistent key cache. */
export function createV4MediaDecoder(options = {}, { fallback = bytes => ({ bytes, encoding: 'plain' }), findImpl = findV4ImageKey } = {}) {
  let pending, discovered, disposed = false;
  return {
    decodeMedia: async (bytes, context) => {
      if (disposed) throw fail('E_MEDIA_IMAGE_KEY', '图片解码器已释放。');
      const version = v4MediaVersion(bytes);
      if (!version) return fallback(bytes, context);
      if (version === 1) return { bytes: decodeV4MediaBytes(bytes), encoding: 'v1-aes' };
      pending ??= Promise.resolve().then(() => findImpl({ ...options, template: bytes }));
      discovered = await pending;
      if (disposed) { discovered.dispose(); throw fail('E_MEDIA_IMAGE_KEY', '图片解码器已释放。'); }
      return { bytes: discovered.decode(bytes), encoding: 'v2-aes' };
    },
    dispose: () => { disposed = true; discovered?.dispose(); },
  };
}
