import * as zlib from 'node:zlib';
import { WxError } from './errors.mjs';

export const MAX_NATIVE_CONTENT_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 4 * MAX_NATIVE_CONTENT_BYTES;
const MAX_ZSTD_FRAMES = 64;
const ZSTD_MAGIC = 0xfd2fb528;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function failure(code, message) { return new WxError(code, message); }
function isZstd(bytes) {
  return bytes.length >= 4 && (bytes.readUInt32LE(0) === ZSTD_MAGIC || bytes.readUInt32BE(0) === ZSTD_MAGIC);
}
function strictUtf8(bytes) {
  if (bytes.length > MAX_NATIVE_CONTENT_BYTES) throw failure('E_NATIVE_CONTENT_LIMIT', '消息正文超过 1 MiB 上限。');
  try { return utf8.decode(bytes); }
  catch { throw failure('E_NATIVE_CONTENT_UTF8', '消息正文不是有效的 UTF-8；原始正文未输出。'); }
}

function decompressFrames(input) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw failure('E_NATIVE_CONTENT_UNSUPPORTED', '当前 Node 没有内建 Zstd 解压接口。');
  const chunks = [];
  let offset = 0;
  let outputLength = 0;
  for (let frame = 0; offset < input.length; frame += 1) {
    if (frame >= MAX_ZSTD_FRAMES) throw failure('E_NATIVE_CONTENT_LIMIT', '消息压缩帧数量超过安全上限。');
    const remainingInput = input.subarray(offset);
    if (!isZstd(remainingInput)) throw failure('E_NATIVE_CONTENT_ZSTD', '消息压缩数据包含未识别的帧或尾部数据。');
    let result;
    try {
      result = zlib.zstdDecompressSync(remainingInput, {
        maxOutputLength: Math.max(1, MAX_NATIVE_CONTENT_BYTES - outputLength),
        info: true,
        params: { [zlib.constants.ZSTD_d_windowLogMax]: 23 },
      });
    } catch (cause) {
      if (cause.code === 'ERR_BUFFER_TOO_LARGE') throw failure('E_NATIVE_CONTENT_LIMIT', '消息解压正文超过 1 MiB 上限。');
      throw failure('E_NATIVE_CONTENT_ZSTD', '消息 Zstd 数据损坏或无法解压；原始正文未输出。');
    }
    const consumed = result.engine?.bytesWritten;
    if (!Buffer.isBuffer(result.buffer) || !Number.isSafeInteger(consumed) || consumed <= 0 || consumed > remainingInput.length) {
      throw failure('E_NATIVE_CONTENT_ZSTD', '消息压缩帧的读取边界无法验证。');
    }
    outputLength += result.buffer.length;
    if (outputLength > MAX_NATIVE_CONTENT_BYTES) throw failure('E_NATIVE_CONTENT_LIMIT', '消息解压正文超过 1 MiB 上限。');
    chunks.push(result.buffer);
    offset += consumed;
  }
  return Buffer.concat(chunks, outputLength);
}

function decodeBytes(bytes) {
  if (bytes.length > MAX_INPUT_BYTES) throw failure('E_NATIVE_CONTENT_LIMIT', '消息编码数据超过大小上限。');
  return strictUtf8(isZstd(bytes) ? decompressFrames(bytes) : bytes);
}

// WeFlow uses >16 characters and structural hex/base64 tests. For an unmarked
// string we additionally require readable UTF-8 and an encoding cue, so ordinary
// identifiers, hexadecimal literals, and long alphabetic text stay unchanged.
function plausibleEncodedText(text, compact, encoding) {
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) return false;
  if (encoding === 'hex') return /[^0-9a-fA-F]/u.test(text);
  return /[+/=]/.test(compact) || /[^A-Za-z0-9]/u.test(text);
}

function tryEncoded(bytes, compact, encoding) {
  if (isZstd(bytes)) return decodeBytes(bytes);
  let decoded;
  try { decoded = strictUtf8(bytes); }
  catch (cause) {
    if (cause.code === 'E_NATIVE_CONTENT_UTF8') return null;
    throw cause;
  }
  return plausibleEncodedText(decoded, compact, encoding) ? decoded : null;
}

function field(raw) {
  if (raw === null || raw === undefined) return '';
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    if (raw.byteLength > MAX_INPUT_BYTES) throw failure('E_NATIVE_CONTENT_LIMIT', '消息编码数据超过大小上限。');
    return decodeBytes(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
  }
  if (typeof raw !== 'string') throw failure('E_NATIVE_CONTENT_FORMAT', '消息正文字段需要字符串或字节数据。');
  if (!raw.isWellFormed()) throw failure('E_NATIVE_CONTENT_UTF8', '消息正文包含无效的 Unicode 字符；原始正文未输出。');
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) throw failure('E_NATIVE_CONTENT_LIMIT', '消息编码数据超过大小上限。');
  const compact = raw.replace(/\s+/g, '');
  if (compact.length > 16) {
    if (compact.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(compact)) {
      const decoded = tryEncoded(Buffer.from(compact, 'hex'), compact, 'hex');
      if (decoded !== null) return decoded;
    }
    if (compact.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
      const bytes = Buffer.from(compact, 'base64');
      if (bytes.toString('base64') === compact) {
        const decoded = tryEncoded(bytes, compact, 'base64');
        if (decoded !== null) return decoded;
      }
    }
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_NATIVE_CONTENT_BYTES) throw failure('E_NATIVE_CONTENT_LIMIT', '消息正文超过 1 MiB 上限。');
  return raw;
}

/** Return only decoded text; decoding errors never include native message data. */
export function readNativeContent(row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw failure('E_NATIVE_CONTENT_FORMAT', '消息行必须是对象。');
    const primary = field(row.compress_content);
    return primary.length > 0 ? primary : field(row.message_content);
  } catch (cause) {
    if (cause instanceof WxError) throw cause;
    throw failure('E_NATIVE_CONTENT_FORMAT', '消息正文字段无法读取；原始正文未输出。');
  }
}
