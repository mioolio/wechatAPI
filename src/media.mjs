import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WxError } from './errors.mjs';

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_TEXT = 1024 * 1024;
const IMAGE_TYPES = new Set(['3', 'image', 'wechat:3']);
const STICKER_TYPES = new Set(['47', '11000', 'emoji', 'sticker', 'emoticon', 'wechat:47', 'wechat:11000']);
const CDN_SUFFIXES = ['qpic.cn', 'qlogo.cn', 'qq.com', 'wechat.com', 'wechatapp.com', 'weixin.com'];
const fail = (code, message) => new WxError(code, message);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, value) => { const relative = path.relative(root, value); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const boundedString = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.isWellFormed() && !/[\0\r\n]/.test(value);

async function canonicalPath(value) {
  try { return await realpath(value); }
  catch (cause) {
    // Some Windows application sandboxes deny GetFinalPathNameByHandle. A
    // component-by-component no-link proof retains the same containment rule.
    if (process.platform !== 'win32' || cause.code !== 'EPERM') throw cause;
    const resolved = path.resolve(value), base = path.parse(resolved).root;
    let current = base;
    for (const component of path.relative(base, resolved).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      if ((await lstat(current)).isSymbolicLink()) throw fail('E_MEDIA_ROOT', '媒体路径包含无法验证的目录链接。');
    }
    return resolved;
  }
}

function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()];
    const numeric = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return numeric > 0 && numeric <= 0x10ffff && !(numeric >= 0xd800 && numeric <= 0xdfff) ? String.fromCodePoint(numeric) : '';
  });
}

function mediaUrl(value) {
  if (!boundedString(value)) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([a-z][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) values[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3]);
  return values;
}

function descriptor(kind, values = {}) {
  const urls = [...new Set((Array.isArray(values.urls) ? values.urls : []).map(mediaUrl).filter(Boolean))].slice(0, 16);
  const localPaths = [...new Set((Array.isArray(values.localPaths) ? values.localPaths : []).filter(boundedString))].slice(0, 16);
  const result = { kind, urls, localPaths };
  if (typeof values.md5 === 'string' && /^[a-f0-9]{32}$/i.test(values.md5)) result.md5 = values.md5.toLowerCase();
  for (const dimension of ['width', 'height']) {
    const number = Number(values[dimension]);
    if (Number.isSafeInteger(number) && number > 0 && number <= 100000) result[dimension] = number;
  }
  if (values.encrypted === true) result.encrypted = true;
  return result;
}

/** Identifies the message's media type and transport references, without claiming visual understanding. */
export function describeMessageMedia(message) {
  if (!message || typeof message !== 'object') return [];
  let type = String(message.type ?? message.localType ?? message.local_type ?? '').toLowerCase();
  if (/^\d{1,20}$/.test(type)) type = String(BigInt(type) & 0xffffffffn);
  let kind = IMAGE_TYPES.has(type) ? 'image' : STICKER_TYPES.has(type) ? 'sticker' : null;
  const texts = [message.rawXml, message.rawContent, message.xml, message.content, message.text].filter(value => typeof value === 'string' && value.length <= MAX_SOURCE_TEXT);
  if (!kind && texts.some(value => /<(?:msg\b[^>]*>\s*)?(?:img|emoji|emoticon)\b/i.test(value))) kind = texts.some(value => /<(?:emoji|emoticon)\b/i.test(value)) ? 'sticker' : 'image';
  if (!kind) return [];
  const values = { urls: [], localPaths: [] };
  if (Array.isArray(message.media)) {
    for (const existing of message.media.slice(0, 16)) {
      if (!existing || !['image', 'sticker'].includes(existing.kind)) continue;
      const clean = descriptor(existing.kind, existing);
      values.urls.push(...clean.urls); values.localPaths.push(...clean.localPaths);
      for (const key of ['md5', 'width', 'height', 'encrypted']) if (clean[key] !== undefined) values[key] = clean[key];
    }
  }
  for (const key of ['imagePath', 'localPath', 'filePath', 'thumbPath']) if (boundedString(message[key])) values.localPaths.push(message[key]);
  for (const key of ['imageUrl', 'cdnUrl', 'url']) if (mediaUrl(message[key])) values.urls.push(message[key]);
  if (typeof message.md5 === 'string') values.md5 = message.md5;
  for (const text of texts) {
    for (const match of text.matchAll(/<(?:img|emoji|emoticon)\b[^>]{0,16384}>/gi)) {
      const attrs = attributes(match[0]);
      for (const key of ['cdnurl', 'cdnthumburl', 'thumburl', 'url', 'externurl', 'encrypturl', 'hdcdnurl', 'bigimgurl']) if (mediaUrl(attrs[key])) values.urls.push(attrs[key]);
      for (const key of ['path', 'localpath', 'filepath', 'thumbpath', 'bigimgpath', 'hdimgpath']) if (boundedString(attrs[key])) values.localPaths.push(attrs[key]);
      values.md5 ??= attrs.md5;
      values.width ??= attrs.width; values.height ??= attrs.height;
      if (attrs.aeskey || attrs.encrypturl) values.encrypted = true;
    }
    for (const match of text.matchAll(/<(?:localpath|filepath|thumbpath)>\s*(?:<!\[CDATA\[([\s\S]{0,4096}?)\]\]>|([^<]{0,4096}))\s*<\/(?:localpath|filepath|thumbpath)>/gi)) {
      const value = decodeEntities(match[1] ?? match[2]).trim(); if (boundedString(value)) values.localPaths.push(value);
    }
    const plain = text.trim();
    if (mediaUrl(plain)) values.urls.push(plain);
    else if (boundedString(plain) && !/[<>]/.test(plain) && /\.(?:png|jpe?g|gif|webp|bmp|dat)$/i.test(plain)) values.localPaths.push(plain);
  }
  return [descriptor(kind, values)];
}

/** Returns a supported, signature-checked browser image type. Extensions are never trusted. */
export function imageFileType(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return null;
  const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: 'png', mime: 'image/png' };
  if (value.length >= 3 && value[0] === 255 && value[1] === 216 && value[2] === 255) return { extension: 'jpg', mime: 'image/jpeg' };
  if (value.length >= 6 && ['GIF87a', 'GIF89a'].includes(value.subarray(0, 6).toString('ascii'))) return { extension: 'gif', mime: 'image/gif' };
  if (value.length >= 12 && value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
  if (value.length >= 14 && value[0] === 66 && value[1] === 77) return { extension: 'bmp', mime: 'image/bmp' };
  return null;
}

/** Decodes only the verifiable single-byte XOR cache format; other encryption stays unavailable. */
export function decodeMediaBytes(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 3 || bytes.length > MAX_MEDIA_BYTES) throw fail('E_MEDIA_FORMAT', '图片为空、过大或格式不受支持。');
  let type = imageFileType(bytes);
  if (type) return { bytes, ...type, encoding: 'plain' };
  for (const magic of [[137, 80, 78, 71, 13, 10, 26, 10], [255, 216, 255], [71, 73, 70, 56, 55, 97], [71, 73, 70, 56, 57, 97], [82, 73, 70, 70]]) {
    const key = bytes[0] ^ magic[0];
    if (!key || bytes.length < magic.length || !magic.every((byte, index) => (bytes[index] ^ key) === byte)) continue;
    const decoded = Buffer.from(bytes.map(byte => byte ^ key));
    type = imageFileType(decoded);
    if (type) return { bytes: decoded, ...type, encoding: 'xor' };
  }
  throw fail('E_MEDIA_ENCRYPTED_OR_FORMAT', '缓存不是可验证的图片或单字节 XOR 图片；可能尚未下载或采用其他加密格式。');
}

async function readBounded(file, maximum) {
  const handle = await open(file, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 3 || metadata.size > maximum) throw fail('E_MEDIA_SIZE', '媒体文件不是普通文件，或超过大小上限。');
    const bytes = Buffer.alloc(metadata.size);
    let position = 0;
    while (position < bytes.length) { const result = await handle.read(bytes, position, bytes.length - position, position); if (!result.bytesRead) throw fail('E_MEDIA_CHANGED', '媒体文件读取时发生变化。'); position += result.bytesRead; }
    return bytes;
  } finally { await handle.close(); }
}

async function localCandidates(media, root, cache) {
  if (!root) return [];
  const result = [];
  for (let candidate of media.localPaths) {
    try {
      if (/^file:/i.test(candidate)) candidate = fileURLToPath(candidate);
      const resolved = await canonicalPath(path.resolve(root, candidate));
      if (inside(root, resolved)) result.push(resolved);
    } catch { /* Missing references remain explicit in the manifest. */ }
  }
  if (media.md5 && !result.length) {
    if (!cache.files) {
      cache.files = [];
      let entriesSeen = 0;
      const walk = async (directory, depth) => {
        if (depth > 12) return;
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (++entriesSeen > 20000) throw fail('E_MEDIA_SCAN_LIMIT', '媒体目录扫描超过 20000 项；请指定更精确的媒体目录。');
          if (entry.isSymbolicLink()) continue;
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(full, depth + 1);
          else if (entry.isFile()) cache.files.push(full);
        }
      };
      await walk(root, 0);
    }
    for (const file of cache.files) if (path.basename(file).toLowerCase().includes(media.md5)) result.push(file);
  }
  return [...new Set(result)];
}

function allowedDownloadUrl(value, extraHosts) {
  const normalized = mediaUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized), hostname = url.hostname.toLowerCase();
  return (!url.port || ['80', '443'].includes(url.port)) && (CDN_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)) || extraHosts.includes(hostname)) ? url : null;
}

async function downloadBytes(url, { fetchImpl, maxBytes }) {
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'image/*' } });
  if (!response?.ok) throw fail('E_MEDIA_DOWNLOAD', '媒体链接未返回成功结果。');
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw fail('E_MEDIA_SIZE', '媒体下载超过大小上限。');
  if (!response.body?.getReader) throw fail('E_MEDIA_DOWNLOAD', '媒体下载未返回可限流的响应正文。');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maxBytes) throw fail('E_MEDIA_SIZE', '媒体下载超过大小上限。');
      chunks.push(Buffer.from(value));
    }
  } catch (cause) { await reader.cancel().catch(() => {}); throw cause; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
function gallery(items) {
  const timestamp = value => { const date = new Date(value); return value !== null && Number.isFinite(date.getTime()) ? date.toISOString() : ''; };
  const cards = items.map(item => `<article><h2>${item.kind === 'sticker' ? '表情包' : '图片'} · ${escapeHtml(item.messageId)}</h2>${item.status === 'saved' ? `<a href="${escapeHtml(item.filename)}"><img loading="lazy" src="${escapeHtml(item.filename)}" alt="${item.kind === 'sticker' ? '表情包' : '图片'}"></a><p>${escapeHtml(item.filename)} · ${item.bytes} bytes</p>` : `<p class="missing">未保存：${escapeHtml(item.reason)}</p>`}<p>${escapeHtml(timestamp(item.timestamp))}</p></article>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'"><title>微信图片与表情包</title><style>body{font:16px system-ui,sans-serif;background:#f5f6f8;color:#222;margin:clamp(16px,4vw,32px);line-height:1.5}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:20px}article{padding:20px;background:white;border:1px solid #ddd;border-radius:10px;overflow-wrap:anywhere}img{max-width:100%;max-height:360px}a:focus-visible{outline:3px solid #2563eb;outline-offset:3px}h2{font-size:16px}p{color:#666;font-size:13px}.missing{color:#933}</style><h1>微信图片与表情包</h1><p>共 ${items.length} 项，已保存 ${items.filter(item => item.status === 'saved').length} 项。点击图片查看原文件。未取得原文件的项目保留状态说明。</p><main>${cards}</main></html>`;
}

async function previousItems(manifestPath, directory) {
  let saved;
  try {
    if ((await stat(manifestPath)).size > 8 * 1024 * 1024) throw fail('E_MEDIA_MANIFEST', '已有媒体清单超过大小上限。');
    saved = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) { if (cause.code === 'ENOENT') return []; if (cause instanceof WxError) throw cause; throw fail('E_MEDIA_MANIFEST', '已有媒体清单无效，未覆盖归档。'); }
  if (saved?.version !== 1 || !Array.isArray(saved.items) || saved.items.length > 20000) throw fail('E_MEDIA_MANIFEST', '已有媒体清单无效，未覆盖归档。');
  const items = [];
  for (const item of saved.items) {
    if (!item || !/^[a-f0-9]{64}$/.test(item.messageFingerprint) || !Number.isSafeInteger(item.messageOccurrence) || item.messageOccurrence < 0 || !['image', 'sticker'].includes(item.kind) || !['saved', 'unavailable'].includes(item.status)) throw fail('E_MEDIA_MANIFEST', '已有媒体项目结构无效，未覆盖归档。');
    if ((item.messageId !== null && !boundedString(item.messageId)) || (item.chatId !== null && !boundedString(item.chatId)) || (item.timestamp !== null && (!Number.isSafeInteger(item.timestamp) || item.timestamp < 0)) || ![true, false, null].includes(item.isSelf)) throw fail('E_MEDIA_MANIFEST', '已有媒体消息身份或时间无效，未覆盖归档。');
    const clean = { messageIndex: Number.isSafeInteger(item.messageIndex) && item.messageIndex >= 0 ? item.messageIndex : 0, messageFingerprint: item.messageFingerprint, messageOccurrence: item.messageOccurrence, messageId: item.messageId, chatId: item.chatId, timestamp: item.timestamp, isSelf: item.isSelf, ...descriptor(item.kind, item), status: item.status };
    if (item.status === 'saved') {
      if (!/^(?:image|sticker)-[a-f0-9]{64}\.(?:png|jpg|gif|webp|bmp)$/.test(item.filename) || !/^[a-f0-9]{64}$/.test(item.sha256) || !item.filename.includes(`-${item.sha256}.`) || !Number.isSafeInteger(item.bytes) || item.bytes < 3 || item.bytes > MAX_MEDIA_BYTES) throw fail('E_MEDIA_MANIFEST', '已有媒体文件校验信息无效，未覆盖归档。');
      const filePath = path.join(directory, item.filename);
      try {
        const actual = await readBounded(filePath, MAX_MEDIA_BYTES), type = imageFileType(actual);
        if (!type || actual.length !== item.bytes || hash(actual) !== item.sha256) throw new Error();
        Object.assign(clean, { filename: item.filename, sha256: item.sha256, bytes: actual.length, mime: type.mime, filePath, fileUrl: pathToFileURL(filePath).href });
        if (['local-cache', 'remote'].includes(item.source)) clean.source = item.source;
        if (boundedString(item.encoding)) clean.encoding = item.encoding;
      } catch { clean.status = 'unavailable'; clean.reasonCode = 'E_MEDIA_ARCHIVE_FILE'; clean.reason = '已有归档媒体文件缺失或校验失败。'; }
    } else {
      clean.reasonCode = boundedString(item.reasonCode) ? item.reasonCode : 'E_MEDIA_UNAVAILABLE'; clean.reason = boundedString(item.reason) ? item.reason : '没有可用媒体文件。';
    }
    items.push(clean);
  }
  return items;
}

/** Saves exact media references, never guesses an attachment by timestamp or reads outside mediaRoot. */
export async function saveMessageMedia(messages, { output, mediaRoot, download = true, merge = true, maxBytes = MAX_MEDIA_BYTES, fetchImpl = globalThis.fetch, allowedRemoteHosts = [], resolveLocalPaths, decodeMedia = decodeMediaBytes } = {}) {
  if (!Array.isArray(messages) || messages.length > 10000) throw fail('E_MEDIA_ARGUMENT', '媒体导出需要最多 10000 条消息。');
  if (!boundedString(output) || typeof download !== 'boolean' || typeof merge !== 'boolean' || !Number.isSafeInteger(maxBytes) || maxBytes < 3 || maxBytes > MAX_MEDIA_BYTES || typeof fetchImpl !== 'function' || typeof decodeMedia !== 'function' || (resolveLocalPaths !== undefined && typeof resolveLocalPaths !== 'function') || !Array.isArray(allowedRemoteHosts) || !allowedRemoteHosts.every(boundedString)) throw fail('E_MEDIA_ARGUMENT', '媒体输出目录、下载选项或大小限制无效。');
  let root;
  if (mediaRoot !== undefined) {
    if (!boundedString(mediaRoot)) throw fail('E_MEDIA_ROOT', '媒体来源目录无效。');
    try { root = await canonicalPath(mediaRoot); if (!(await stat(root)).isDirectory()) throw new Error(); }
    catch { throw fail('E_MEDIA_ROOT', '媒体来源目录不存在或无法读取。'); }
  }
  const directory = path.resolve(output); await mkdir(directory, { recursive: true });
  const indexPath = path.join(directory, 'wxcc-media-index.html'), manifestPath = path.join(directory, 'wxcc-media-manifest.json');
  const prior = merge ? await previousItems(manifestPath, directory) : [], items = [], cache = {}, occurrences = new Map();
  for (const [messageIndex, message] of messages.entries()) {
    const messageFingerprint = hash(JSON.stringify([message.id ?? message.serverId ?? null, message.chatId ?? null, message.timestamp ?? null, message.isSelf ?? null, message.type ?? null, message.text ?? message.content ?? null, message.rawXml ?? message.rawContent ?? null]));
    const messageOccurrence = occurrences.get(messageFingerprint) ?? 0; occurrences.set(messageFingerprint, messageOccurrence + 1);
    for (const media of describeMessageMedia(message)) {
      const item = { messageIndex, messageFingerprint, messageOccurrence, messageId: message.id ?? message.serverId ?? null, chatId: message.chatId ?? null, timestamp: Number.isSafeInteger(message.timestamp) ? message.timestamp : null, isSelf: message.isSelf ?? null, ...media, status: 'unavailable' };
      let decoded, source, lastError;
      try {
        const context = { message, media, mediaRoot: root };
        const decode = async bytes => {
          const value = await decodeMedia(bytes, context), result = Buffer.isBuffer(value) || value instanceof Uint8Array ? { bytes: Buffer.from(value), encoding: 'custom' } : value;
          const type = result?.bytes && imageFileType(result.bytes);
          if (!type || result.bytes.length > maxBytes) throw fail('E_MEDIA_FORMAT', '媒体解码结果不是受支持的图片，或超过大小上限。');
          return { ...result, ...type };
        };
        const extraPaths = resolveLocalPaths ? await resolveLocalPaths(media, context) : [];
        if (!Array.isArray(extraPaths) || extraPaths.length > 64 || !extraPaths.every(boundedString)) throw fail('E_MEDIA_RESOLVER', '媒体文件映射返回了无效路径。');
        const candidates = await localCandidates({ ...media, localPaths: [...extraPaths, ...media.localPaths] }, root, cache);
        for (const candidate of candidates) {
          try { decoded = await decode(await readBounded(candidate, maxBytes)); source = 'local-cache'; break; }
          catch (cause) { lastError = cause; }
        }
        if (!decoded && download) for (const reference of media.urls) {
          const url = allowedDownloadUrl(reference, allowedRemoteHosts.map(value => value.toLowerCase()));
          if (!url) { lastError ??= fail('E_MEDIA_REMOTE_HOST', '媒体链接不是受支持的微信 CDN；链接已保留，未下载。'); continue; }
          try { decoded = await decode(await downloadBytes(url, { fetchImpl, maxBytes })); source = 'remote'; break; }
          catch (cause) { lastError = cause; }
        }
        if (decoded) {
          const sha256 = hash(decoded.bytes), filename = `${media.kind}-${sha256}.${decoded.extension}`, filePath = path.join(directory, filename);
          try { await writeFile(filePath, decoded.bytes, { flag: 'wx' }); }
          catch (cause) { if (cause.code !== 'EEXIST') throw cause; if (hash(await readBounded(filePath, maxBytes)) !== sha256) throw fail('E_MEDIA_OUTPUT_CONFLICT', '输出目录中同名媒体文件内容不匹配。'); }
          Object.assign(item, { status: 'saved', source, encoding: decoded.encoding, filename, filePath, fileUrl: pathToFileURL(filePath).href, sha256, mime: decoded.mime, bytes: decoded.bytes.length });
        } else {
          item.reasonCode = lastError?.code?.startsWith('E_MEDIA_') ? lastError.code : 'E_MEDIA_UNAVAILABLE';
          item.reason = lastError instanceof WxError ? lastError.message : !media.md5 && !media.urls.length && !media.localPaths.length ? '消息已识别为图片或表情包，但读取结果未提供原文件引用。' : !root && media.localPaths.length ? '有本地文件引用；需要通过 mediaRoot 指定允许读取的媒体来源目录。' : '未找到可读取的原文件；媒体可能尚未下载，或引用已失效。';
        }
      } catch (cause) {
        item.reasonCode = cause instanceof WxError ? cause.code : 'E_MEDIA_SAVE';
        item.reason = cause instanceof WxError ? cause.message : '媒体文件无法读取或保存。';
      }
      items.push(item);
    }
  }
  const combined = new Map(prior.map(item => [`${item.messageFingerprint}:${item.messageOccurrence}:${item.kind}`, item]));
  for (const item of items) {
    const key = `${item.messageFingerprint}:${item.messageOccurrence}:${item.kind}`, previous = combined.get(key);
    if (previous?.status === 'saved' && item.status !== 'saved') combined.set(key, { ...item, ...previous }); else combined.set(key, item);
  }
  const archived = [...combined.values()];
  if (archived.length > 20000) throw fail('E_MEDIA_ARCHIVE_LIMIT', '媒体归档超过 20000 项；请指定新输出目录。');
  const result = { directory, indexPath, indexUrl: pathToFileURL(indexPath).href, manifestPath, total: archived.length, saved: archived.filter(item => item.status === 'saved').length, unavailable: archived.filter(item => item.status !== 'saved').length, items: archived };
  for (const [file, body] of [[manifestPath, `${JSON.stringify({ version: 1, ...result }, null, 2)}\n`], [indexPath, gallery(archived)]]) {
    const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, body, { flag: 'wx' }); await rename(temporary, file);
  }
  return result;
}
