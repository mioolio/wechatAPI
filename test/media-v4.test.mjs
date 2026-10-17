import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { createV4MediaDecoder, decodeV4MediaBytes, findV4ImageKey, v4MediaVersion } from '../src/media-v4.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
const KEY = Buffer.from('abcdefghijklmnop', 'ascii');
function encrypted({ version = 2, key = KEY, aesSize = 32, xorSize = 8, xorKey = 97 } = {}) {
  const header = Buffer.alloc(15); Buffer.from([7, 8, 86, version === 1 ? 49 : 50, 8, 7]).copy(header);
  header.writeUInt32LE(aesSize, 6); header.writeUInt32LE(xorSize, 10);
  const cipher = createCipheriv('aes-128-ecb', key, null), prefix = Buffer.concat([cipher.update(PNG.subarray(0, aesSize)), cipher.final()]);
  return Buffer.concat([header, prefix, PNG.subarray(aesSize, PNG.length - xorSize), Buffer.from(PNG.subarray(PNG.length - xorSize).map(byte => byte ^ xorKey))]);
}

test('V2 decoder preserves AES prefix, raw middle, and independently verified PNG XOR trailer', () => {
  const bytes = encrypted();
  assert.equal(v4MediaVersion(bytes), 2);
  assert.deepEqual(decodeV4MediaBytes(bytes, { aesKey: KEY }), PNG);
  assert.throws(() => decodeV4MediaBytes(bytes, { aesKey: Buffer.alloc(16) }), { code: 'E_MEDIA_IMAGE_KEY' });
  assert.throws(() => decodeV4MediaBytes(bytes), { code: 'E_MEDIA_IMAGE_KEY' });
});

test('V1 fixed key decoding and V4 bounds checks reject wrong lengths and ambiguous tail keys', () => {
  assert.deepEqual(decodeV4MediaBytes(encrypted({ version: 1, key: Buffer.from('cfcd208495d565ef') })), PNG);
  const bytes = encrypted({ xorSize: 4 });
  assert.throws(() => decodeV4MediaBytes(bytes, { aesKey: KEY }), { code: 'E_MEDIA_IMAGE_XOR_KEY' });
  assert.deepEqual(decodeV4MediaBytes(bytes, { aesKey: KEY, xorKey: 97 }), PNG);
  bytes.writeUInt32LE(0xffffffff, 6);
  assert.throws(() => decodeV4MediaBytes(bytes, { aesKey: KEY }), { code: 'E_MEDIA_V4_FORMAT' });
});

function readerFixture(data) {
  let closed = 0;
  const reader = {
    openProcess: () => 'handle', imagePath: () => 'C:\\Weixin\\Weixin.exe',
    queryRegion: (_handle, address) => address >= 0x12000n ? null : { baseAddress: 0x10000n, regionSize: 8192n, state: 0x1000, protect: 4, type: 0x20000 },
    readMemory: (_handle, address, length) => ({ ok: true, bytesRead: length, bytes: Buffer.from(data.subarray(Number(address - 0x10000n), Number(address - 0x10000n) + length)) }),
    closeHandle: () => { closed++; },
  };
  return { reader, closed: () => closed };
}

test('read-only key discovery accepts only a ciphertext-verified ASCII key and never serializes it', async () => {
  const data = Buffer.alloc(8192); KEY.copy(data, 32);
  const fx = readerFixture(data); let guardCalls = 0;
  const result = await findV4ImageKey({ pid: 123, template: encrypted(), guard: () => { guardCalls++; return true; } }, { reader: fx.reader, platform: 'win32' });
  assert.deepEqual(result.decode(encrypted()), PNG);
  assert.equal(JSON.stringify(result).includes(KEY.toString()), false);
  assert.equal(guardCalls, 2); assert.equal(fx.closed(), 1);
  result.dispose(); assert.throws(() => result.decode(encrypted()), { code: 'E_MEDIA_IMAGE_KEY' });
});

test('verified account config dword derives V2 key when the plaintext key is not resident', async () => {
  const self = 'wxid_fixture_account', dword = 123456789;
  const derived = Buffer.from(createHash('md5').update(`${dword}${self}`).digest('hex').slice(0, 16));
  const data = Buffer.alloc(8192), header = 64, accountOffset = 256;
  data.writeUInt32LE(dword, header - 8); data.writeBigUInt64LE(0x10000n + BigInt(accountOffset), header);
  data.writeBigUInt64LE(BigInt(self.length), header + 16); data.writeBigUInt64LE(31n, header + 24);
  data.write(self, accountOffset);
  const fx = readerFixture(data), template = encrypted({ key: derived, xorKey: dword & 255 });
  const result = await findV4ImageKey({ pid: 123, self, template, guard: () => true }, { reader: fx.reader, platform: 'win32' });
  assert.deepEqual(result.decode(template), PNG); assert.equal(fx.closed(), 1);
  assert.equal(JSON.stringify(result).includes(derived.toString()), false); result.dispose(); derived.fill(0);
});

test('account and process changes cannot return a found key', async () => {
  const data = Buffer.alloc(8192); KEY.copy(data, 32);
  const fx = readerFixture(data); let calls = 0;
  await assert.rejects(findV4ImageKey({ pid: 123, template: encrypted(), guard: () => ++calls === 1 }, { reader: fx.reader, platform: 'win32' }), { code: 'E_ACCOUNT_CHANGED' });
  assert.equal(fx.closed(), 1);
  await assert.rejects(findV4ImageKey({ pid: 123, template: encrypted(), expectedExePath: 'C:\\Other\\Weixin.exe', guard: () => true }, { reader: readerFixture(data).reader, platform: 'win32' }), { code: 'E_MEDIA_KEY_PROCESS' });
});

test('archive decoder discovers once, preserves fallback behavior, and releases its key', async () => {
  let discoveries = 0, disposals = 0, fallbacks = 0;
  const decoder = createV4MediaDecoder({ pid: 123, self: 'fixture' }, {
    fallback: bytes => { fallbacks++; return { bytes, encoding: 'test-fallback' }; },
    findImpl: async options => { discoveries++; assert.equal(options.pid, 123); return { decode: bytes => decodeV4MediaBytes(bytes, { aesKey: KEY }), dispose: () => { disposals++; } }; },
  });
  assert.equal((await decoder.decodeMedia(PNG)).encoding, 'test-fallback');
  assert.deepEqual((await decoder.decodeMedia(encrypted())).bytes, PNG);
  assert.deepEqual((await decoder.decodeMedia(encrypted())).bytes, PNG);
  assert.equal(discoveries, 1); assert.equal(fallbacks, 1); decoder.dispose(); assert.equal(disposals, 1);
  await assert.rejects(decoder.decodeMedia(encrypted()), { code: 'E_MEDIA_IMAGE_KEY' });
});

test('candidate limits stop before testing a later key and always close the read-only handle', async () => {
  const data = Buffer.alloc(8192); data.write('wrongwrongwrongw!', 32); KEY.copy(data, 96);
  const fx = readerFixture(data);
  // Two distinct 16-byte alphanumeric runs, with a failed candidate first.
  data.write('wrongwrongwrongw', 32); data[48] = 0;
  await assert.rejects(findV4ImageKey({ pid: 123, template: encrypted(), maximumCandidates: 1, guard: () => true }, { reader: fx.reader, platform: 'win32' }), { code: 'E_MEDIA_KEY_LIMIT' });
  assert.equal(fx.closed(), 1);
});
