import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeMessageMedia, imageFileType, decodeMediaBytes, saveMessageMedia } from '../src/media.mjs';
import { normalizeMessage } from '../src/messages.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
const message = overrides => ({ id: '18446744073709551615', chatId: 'fixture_person', senderId: 'fixture_person', isSelf: false, timestamp: 1791000000000, type: 'image', text: '[图片]', ...overrides });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wxcc-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, 'cache'), output = join(root, 'archive');
  await mkdir(mediaRoot); return { root, mediaRoot, output };
}

test('recognizes numeric and named image/sticker types without claiming unavailable files exist', () => {
  for (const type of ['3', 3, 'image', 'wechat:3']) assert.deepEqual(describeMessageMedia({ type, text: '[图片]' }), [{ kind: 'image', urls: [], localPaths: [] }]);
  for (const type of ['47', 47, 'emoji', 'sticker']) assert.equal(describeMessageMedia({ type })[0].kind, 'sticker');
  assert.deepEqual(describeMessageMedia({ type: 'text', text: '发送图片吗？' }), []);
});

test('extracts bounded XML transport references, decodes entities, and excludes keys', () => {
  const rawXml = '<msg><emoji md5="0123456789abcdef0123456789abcdef" cdnurl="https://example.qpic.cn/image.gif?a=1&amp;b=2" localpath="cache\\sticker.dat" aeskey="secret-key" width="48" height="64" /></msg>';
  const media = describeMessageMedia({ type: '47', text: '[表情]', rawXml });
  assert.deepEqual(media, [{ kind: 'sticker', urls: ['https://example.qpic.cn/image.gif?a=1&b=2'], localPaths: ['cache\\sticker.dat'], md5: '0123456789abcdef0123456789abcdef', width: 48, height: 64, encrypted: true }]);
  assert.equal(JSON.stringify(media).includes('secret-key'), false);
  assert.deepEqual(describeMessageMedia({ type: 3, text: '<img cdnurl="javascript:alert(1)" path="bad&#0;path" />' })[0].urls, []);
});

test('message normalization keeps media references from raw XML beside display text', () => {
  const normalized = normalizeMessage(message({ rawContent: '<msg><img md5="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" localpath="image.dat" /></msg>' }));
  assert.equal(normalized.text, '[图片]');
  assert.equal(normalized.media[0].md5, 'a'.repeat(32));
  assert.equal(normalizeMessage(normalized).media[0].localPaths[0], 'image.dat');
});

test('signature verification imports plain images and reverses only verified single-byte XOR caches', () => {
  assert.deepEqual(imageFileType(PNG), { extension: 'png', mime: 'image/png' });
  const encoded = Buffer.from(PNG.map(byte => byte ^ 0x6b));
  const decoded = decodeMediaBytes(encoded);
  assert.equal(decoded.encoding, 'xor'); assert.equal(decoded.extension, 'png'); assert.deepEqual(decoded.bytes, PNG);
  assert.equal(decodeMediaBytes(PNG).encoding, 'plain');
  assert.throws(() => decodeMediaBytes(Buffer.from('not an image, even when called .jpg')), { code: 'E_MEDIA_ENCRYPTED_OR_FORMAT' });
  assert.throws(() => decodeMediaBytes(Buffer.from([7, 8, 86, 49, 0, 0, 0, 0])), { code: 'E_MEDIA_ENCRYPTED_OR_FORMAT' });
});

test('exports received cached media into a viewable gallery and exact manifest with content-based names', async t => {
  const fx = await fixture(t);
  await writeFile(join(fx.mediaRoot, 'cache.dat'), Buffer.from(PNG.map(byte => byte ^ 37)));
  const result = await saveMessageMedia([message({ rawXml: '<img localpath="cache.dat" />' })], { ...fx, download: false });
  assert.equal(result.total, 1); assert.equal(result.saved, 1); assert.equal(result.unavailable, 0);
  assert.equal(result.items[0].encoding, 'xor'); assert.match(result.indexUrl, /^file:/);
  assert.deepEqual(await readFile(result.items[0].filePath), PNG);
  const html = await readFile(result.indexPath, 'utf8');
  assert.ok(html.includes(result.items[0].filename)); assert.ok(html.includes('Content-Security-Policy'));
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.items[0].messageId, '18446744073709551615');
});

test('resolves XML md5 references by cache filenames without choosing unrelated recent files', async t => {
  const fx = await fixture(t), md5 = '1234567890abcdef1234567890abcdef';
  await mkdir(join(fx.mediaRoot, 'nested'));
  await writeFile(join(fx.mediaRoot, 'unrelated.png'), PNG);
  await writeFile(join(fx.mediaRoot, 'nested', `${md5}_t.dat`), PNG);
  const result = await saveMessageMedia([message({ rawXml: `<img md5="${md5}" />` }), message({ id: '2', rawXml: '<img md5="ffffffffffffffffffffffffffffffff" />' })], { ...fx, download: false });
  assert.equal(result.saved, 1); assert.equal(result.unavailable, 1);
  assert.equal(result.items[1].reasonCode, 'E_MEDIA_UNAVAILABLE');
});

test('never reads an XML path outside the explicitly permitted source root', async t => {
  const fx = await fixture(t);
  const outside = join(fx.root, 'private.png'); await writeFile(outside, PNG);
  const result = await saveMessageMedia([message({ media: [{ kind: 'image', localPaths: ['../private.png', outside], urls: [] }] })], { ...fx, download: false });
  assert.equal(result.saved, 0);
  const noRoot = await saveMessageMedia([message({ id: '2', localPath: outside })], { output: fx.output, download: false });
  assert.equal(noRoot.saved, 0); assert.match(noRoot.items.at(-1).reason, /mediaRoot/);
});

test('downloads signature-checked CDN images with a bounded stream and without following redirects', async t => {
  const fx = await fixture(t); let calls = 0;
  const fetchImpl = async (url, options) => { calls++; assert.equal(url.hostname, 'sample.qpic.cn'); assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, undefined); return new Response(PNG); };
  const result = await saveMessageMedia([message({ rawXml: '<img cdnurl="https://sample.qpic.cn/example" />' })], { ...fx, fetchImpl });
  assert.equal(result.saved, 1); assert.equal(calls, 1); assert.equal(result.items[0].source, 'remote');
  const tooLarge = await saveMessageMedia([message({ id: '2', imageUrl: 'https://sample.qpic.cn/large' })], { ...fx, fetchImpl: async () => new Response(PNG), maxBytes: 16 });
  assert.equal(tooLarge.items.at(-1).reasonCode, 'E_MEDIA_SIZE');
});

test('does not fetch arbitrary sender-controlled hosts or accept non-image response bodies', async t => {
  const fx = await fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('<svg onload="alert(1)"></svg>'); };
  const result = await saveMessageMedia([message({ imageUrl: 'http://127.0.0.1/private' }), message({ id: '2', imageUrl: 'https://sample.qpic.cn/not-image' })], { ...fx, fetchImpl });
  assert.equal(calls, 1); assert.equal(result.saved, 0);
  assert.equal(result.items[0].reasonCode, 'E_MEDIA_REMOTE_HOST');
  assert.equal(result.items[1].reasonCode, 'E_MEDIA_ENCRYPTED_OR_FORMAT');
});

test('repeated watch exports merge the archive, dedupe replayed messages, and preserve saved files', async t => {
  const fx = await fixture(t); await writeFile(join(fx.mediaRoot, 'one.png'), PNG);
  const first = message({ imagePath: 'one.png' }), second = message({ id: 'second', type: 'emoji', text: '<emoji localpath="one.png" />' });
  await saveMessageMedia([first], { ...fx, download: false });
  const secondResult = await saveMessageMedia([second], { ...fx, download: false });
  assert.equal(secondResult.total, 2); assert.equal(secondResult.saved, 2);
  const replay = await saveMessageMedia([first, second], { ...fx, download: false });
  assert.equal(replay.total, 2);
  const withoutRoot = await saveMessageMedia([first], { output: fx.output, download: false });
  assert.equal(withoutRoot.saved, 2);
  assert.ok((await readFile(withoutRoot.indexPath, 'utf8')).includes('second'));
});

test('zero server IDs with distinct XML are retained and gallery text cannot inject HTML', async t => {
  const fx = await fixture(t);
  const messages = ['a', 'b'].map(value => message({ id: '0', rawXml: `<img md5="${value.repeat(32)}" />` }));
  messages.push(message({ id: '<script>alert(1)</script>' }));
  const result = await saveMessageMedia(messages, { ...fx, download: false });
  assert.equal(result.total, 3);
  const html = await readFile(result.indexPath, 'utf8');
  assert.equal(html.includes('<script>alert(1)</script>'), false); assert.ok(html.includes('&lt;script&gt;'));
});

test('authenticated resource resolvers can supply exact cache paths and custom V2 decoders', async t => {
  const fx = await fixture(t), file = join(fx.mediaRoot, 'not-the-message-md5.dat');
  await writeFile(file, Buffer.from('synthetic encrypted cache'));
  let resolved = 0, decoded = 0;
  const result = await saveMessageMedia([message({ rawXml: '<img md5="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" />' })], {
    ...fx, download: false,
    resolveLocalPaths: async (media, context) => { resolved++; assert.equal(media.md5, 'a'.repeat(32)); assert.equal(context.message.id, '18446744073709551615'); return [file]; },
    decodeMedia: async bytes => { decoded++; assert.equal(bytes.toString(), 'synthetic encrypted cache'); return { bytes: PNG, encoding: 'v2-aes' }; },
  });
  assert.equal(result.saved, 1); assert.equal(resolved, 1); assert.equal(decoded, 1); assert.equal(result.items[0].encoding, 'v2-aes');
});

test('archive merge verifies preserved files and rejects modified manifest markup fields', async t => {
  const fx = await fixture(t); await writeFile(join(fx.mediaRoot, 'one.png'), PNG);
  const first = await saveMessageMedia([message({ imagePath: 'one.png' })], { ...fx, download: false });
  await rm(first.items[0].filePath);
  const checked = await saveMessageMedia([], { ...fx, download: false });
  assert.equal(checked.saved, 0); assert.equal(checked.items[0].reasonCode, 'E_MEDIA_ARCHIVE_FILE');
  const fresh = await saveMessageMedia([message({ imagePath: 'one.png' })], { ...fx, download: false });
  const manifest = JSON.parse(await readFile(fresh.manifestPath, 'utf8'));
  manifest.items[0].bytes = '<script>alert(1)</script>';
  await writeFile(fresh.manifestPath, JSON.stringify(manifest));
  await assert.rejects(saveMessageMedia([], { ...fx, download: false }), { code: 'E_MEDIA_MANIFEST' });
});
