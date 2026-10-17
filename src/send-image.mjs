import { open, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WxError } from './errors.mjs';

export const MAX_SEND_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_DIRECTORY = fileURLToPath(new URL('../data/send-images/', import.meta.url));

export function imageFormat(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

/** Keep a private immutable copy because Weixin may read it asynchronously after submission. */
export async function stageSendImage(image, { directory = DEFAULT_DIRECTORY } = {}) {
  if (typeof image !== 'string' || !image.trim() || image.includes('\0') || !image.isWellFormed() || image.length > 32767 || /^(?:[a-z]+:\/\/|\\\\|\/\/)/i.test(image)) throw new WxError('E_IMAGE_PATH', '图片必须是明确的本机文件路径，不能是网址或网络共享路径。');
  const source = resolve(image);
  const handle = await open(source, 'r').catch(() => { throw new WxError('E_IMAGE_PATH', '无法打开指定的本机图片。'); });
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_SEND_IMAGE_BYTES) throw new WxError('E_IMAGE_SIZE', '图片必须是 1 字节至 25 MiB 的普通文件。');
    bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== info.size) throw new WxError('E_IMAGE_CHANGED', '读取过程中图片大小发生变化；没有发送。');
    bytes = bytes.subarray(0, offset);
  } finally { await handle.close(); }
  const format = imageFormat(bytes);
  if (!format) throw new WxError('E_IMAGE_FORMAT', '图片文件头无效；支持 PNG、JPEG、GIF、WebP 和 BMP。');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(resolve(directory), `${sha256}-${randomUUID()}.${format}`);
  const staged = await open(path, 'wx', 0o600);
  try { await staged.writeFile(bytes); await staged.sync(); }
  finally { await staged.close(); }
  return { path, sha256, bytes: bytes.length, format };
}

/** Populate only a new entry in the current client's verified native resource cache. */
export async function cacheSendImage(staged, cachePath) {
  if (typeof cachePath !== 'string' || cachePath.includes('\0') || !/^[A-Za-z]:[\\/].*[\\/]HttpResource[\\/][a-f0-9]{32,64}$/i.test(cachePath) || cachePath.split(/[\\/]/).includes('..')) throw new WxError('E_IMAGE_CACHE_PATH', '客户端返回的图片缓存路径不符合已验证的本机 HttpResource 目录结构。');
  const source = await open(staged.path, 'r');
  let bytes;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size !== staged.bytes || info.size > MAX_SEND_IMAGE_BYTES) throw new WxError('E_IMAGE_CHANGED', '暂存图片发生变化；没有发送。');
    bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) { const result = await source.read(bytes, offset, bytes.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset !== staged.bytes) throw new WxError('E_IMAGE_CHANGED', '暂存图片发生变化；没有发送。');
    bytes = bytes.subarray(0, offset);
    if (createHash('sha256').update(bytes).digest('hex') !== staged.sha256) throw new WxError('E_IMAGE_CHANGED', '暂存图片 SHA-256 已变化；没有发送。');
  } finally { await source.close(); }
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
  const target = await open(cachePath, 'wx', 0o600).catch(error => { throw new WxError('E_IMAGE_CACHE_WRITE', error.code === 'EEXIST' ? '图片缓存条目已存在；不会覆盖或发送。' : '无法写入当前客户端的图片资源缓存；没有发送。'); });
  try { await target.writeFile(bytes); await target.sync(); }
  finally { await target.close(); }
  return { cached: true, bytes: bytes.length, sha256: staged.sha256 };
}
