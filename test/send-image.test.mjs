import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSendImage, cacheSendImage, MAX_SEND_IMAGE_BYTES } from '../src/send-image.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ0kAAAAASUVORK5CYII=', 'base64');
const testRoot = fileURLToPath(new URL('../', import.meta.url));

test('image staging preserves the original bytes under a content hash and survives source changes', async () => {
  const dir = await mkdtemp(join(testRoot, 'wxcc-send-image-test-'));
  try {
    const image = join(dir, '图片.png');
    await writeFile(image, png);
    const result = await stageSendImage(image, { directory: join(dir, 'stage') });
    assert.equal(result.format, 'png');
    assert.equal(result.bytes, png.length);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    await writeFile(image, 'source changed');
    assert.deepEqual(await readFile(result.path), png);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('image staging rejects remote paths, directories, empty files, oversized files and forged extensions', async () => {
  const dir = await mkdtemp(join(testRoot, 'wxcc-send-image-test-'));
  try {
    for (const image of ['https://example.invalid/image.png', '\\\\server\\image.png', '//server/image.png', 'a\0b', '\ud800']) await assert.rejects(stageSendImage(image), { code: 'E_IMAGE_PATH' });
    await assert.rejects(stageSendImage(dir), { code: 'E_IMAGE_SIZE' });
    const image = join(dir, 'forged.png');
    await writeFile(image, 'not an image');
    await assert.rejects(stageSendImage(image), { code: 'E_IMAGE_FORMAT' });
    await writeFile(image, '');
    await assert.rejects(stageSendImage(image), { code: 'E_IMAGE_SIZE' });
    await writeFile(image, Buffer.alloc(MAX_SEND_IMAGE_BYTES + 1));
    assert.equal((await stat(image)).size, MAX_SEND_IMAGE_BYTES + 1);
    await assert.rejects(stageSendImage(image), { code: 'E_IMAGE_SIZE' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native resource caching checks the staged hash and never overwrites an existing entry', async () => {
  const dir = await mkdtemp(join(testRoot, 'wxcc-send-image-test-'));
  try {
    const image = join(dir, 'picture.png'); await writeFile(image, png);
    const staged = await stageSendImage(image, { directory: join(dir, 'staged') });
    const cachePath = join(dir, 'HttpResource', 'a'.repeat(32));
    if (process.platform === 'win32') {
      assert.equal((await cacheSendImage(staged, cachePath)).cached, true);
      assert.deepEqual(await readFile(cachePath), png);
      await assert.rejects(cacheSendImage(staged, cachePath), { code: 'E_IMAGE_CACHE_WRITE' });
      await writeFile(staged.path, Buffer.alloc(png.length));
      await assert.rejects(cacheSendImage(staged, join(dir, 'HttpResource', 'b'.repeat(32))), { code: 'E_IMAGE_CHANGED' });
    }
    for (const badPath of ['https://example.invalid/a', 'C:\\temp\\overwrite.png', '\\\\host\\HttpResource\\' + 'a'.repeat(32), 'C:\\temp\\..\\HttpResource\\' + 'a'.repeat(32)]) await assert.rejects(cacheSendImage(staged, badPath), { code: 'E_IMAGE_CACHE_PATH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
