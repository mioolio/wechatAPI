import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { readNativeContent, MAX_NATIVE_CONTENT_BYTES } from '../src/native-content.mjs';

const text = '测试联系人，synthetic message: hello!\n第二行 😀';

test('uses compressed content first and only falls back for an empty primary field', () => {
  assert.equal(readNativeContent({ compress_content: 'primary text', message_content: 'fallback' }), 'primary text');
  for (const compress_content of [undefined, null, '', Buffer.alloc(0), new Uint8Array()]) {
    assert.equal(readNativeContent({ compress_content, message_content: text }), text);
  }
  assert.equal(readNativeContent({}), '');
  assert.equal(readNativeContent({ compress_content: '  ', message_content: text }), '  ');
});

test('reads strict UTF-8 buffers and honors Uint8Array view boundaries', () => {
  assert.equal(readNativeContent({ message_content: Buffer.from(text) }), text);
  const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(text), Buffer.from([0xff])]);
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 1, bytes.length - 2);
  assert.equal(readNativeContent({ message_content: view }), text);
  assert.equal(readNativeContent({ message_content: Buffer.from('\ufeffliteral replacement \ufffd') }), '\ufeffliteral replacement \ufffd');
});

test('decodes canonical hexadecimal and base64 payloads with whitespace formatting', () => {
  const bytes = Buffer.from(text);
  const hex = bytes.toString('hex');
  const base64 = bytes.toString('base64');
  assert.equal(readNativeContent({ message_content: hex }), text);
  assert.equal(readNativeContent({ message_content: hex.match(/.{1,8}/g).join(' \n') }), text);
  assert.equal(readNativeContent({ message_content: base64 }), text);
  assert.equal(readNativeContent({ message_content: base64.match(/.{1,8}/g).join('\n') }), text);
  assert.equal(readNativeContent({ message_content: Buffer.from('Hello world, long ASCII text!').toString('base64') }), 'Hello world, long ASCII text!');
});

test('preserves short tokens, hex literals, numeric identifiers and ordinary alphabetic text', () => {
  for (const value of ['6869', 'abcd', '616161616161616161', 'deadbeefdeadbeefdeadbeef', '012345678901234567890123', 'abcdefghijklmnopqrstuvwx', 'YWJjZGVmZ2hpamtsbW5v', 'this is an ordinary long message']) {
    assert.equal(readNativeContent({ message_content: value }), value, value);
  }
});

test('uses builtin Zstd for buffer, hexadecimal and base64 data', () => {
  assert.equal(typeof zlib.zstdCompressSync, 'function');
  assert.equal(typeof zlib.zstdDecompressSync, 'function');
  const compressed = zlib.zstdCompressSync(Buffer.from(text));
  for (const compress_content of [compressed, new Uint8Array(compressed), compressed.toString('hex'), compressed.toString('base64')]) {
    assert.equal(readNativeContent({ compress_content, message_content: 'unused fallback' }), text);
  }
  const empty = zlib.zstdCompressSync(Buffer.alloc(0));
  assert.equal(readNativeContent({ compress_content: empty, message_content: text }), text);
});

test('reads every concatenated Zstd frame and rejects garbage after the final frame', () => {
  const first = zlib.zstdCompressSync(Buffer.from('first '));
  const second = zlib.zstdCompressSync(Buffer.from('第二帧'));
  assert.equal(readNativeContent({ compress_content: Buffer.concat([first, second]) }), 'first 第二帧');
  const withGarbage = Buffer.concat([first, Buffer.from('private message tail')]);
  assert.throws(() => readNativeContent({ compress_content: withGarbage }), { code: 'E_NATIVE_CONTENT_ZSTD' });
});

test('rejects bad UTF-8 and corrupt recognized compressed fields without falling back or disclosing content', () => {
  const compressed = zlib.zstdCompressSync(Buffer.from('secret synthetic message'));
  for (const compress_content of [Buffer.from([0xc3, 0x28]), compressed.subarray(0, 6), Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('secret synthetic message')])]) {
    assert.throws(() => readNativeContent({ compress_content, message_content: 'fallback must not hide corruption' }), (error) => {
      assert.ok(error.code.startsWith('E_NATIVE_CONTENT_'));
      assert.equal(error.message.includes('secret synthetic message'), false);
      assert.equal(JSON.stringify(error).includes('secret synthetic message'), false);
      return true;
    });
  }
  assert.throws(() => readNativeContent({ message_content: '\ud800' }), { code: 'E_NATIVE_CONTENT_UTF8' });
});

test('enforces the one MiB output limit for plaintext, single frames and combined frames', () => {
  const exact = Buffer.alloc(MAX_NATIVE_CONTENT_BYTES, 120);
  assert.equal(readNativeContent({ compress_content: zlib.zstdCompressSync(exact) }).length, MAX_NATIVE_CONTENT_BYTES);
  assert.throws(() => readNativeContent({ message_content: Buffer.alloc(MAX_NATIVE_CONTENT_BYTES + 1, 120) }), { code: 'E_NATIVE_CONTENT_LIMIT' });
  assert.throws(() => readNativeContent({ compress_content: zlib.zstdCompressSync(Buffer.alloc(MAX_NATIVE_CONTENT_BYTES + 1, 120)) }), { code: 'E_NATIVE_CONTENT_LIMIT' });
  const half = zlib.zstdCompressSync(Buffer.alloc(MAX_NATIVE_CONTENT_BYTES / 2 + 1, 120));
  assert.throws(() => readNativeContent({ compress_content: Buffer.concat([half, half]) }), { code: 'E_NATIVE_CONTENT_LIMIT' });
  const multibyte = '中'.repeat(Math.floor(MAX_NATIVE_CONTENT_BYTES / 3) + 1);
  assert.throws(() => readNativeContent({ message_content: multibyte }), { code: 'E_NATIVE_CONTENT_LIMIT' });
});

test('bounds compressed input and frame counts and sanitizes unexpected field errors', () => {
  assert.throws(() => readNativeContent({ compress_content: Buffer.alloc(4 * MAX_NATIVE_CONTENT_BYTES + 1) }), { code: 'E_NATIVE_CONTENT_LIMIT' });
  const emptyFrame = zlib.zstdCompressSync(Buffer.alloc(0));
  assert.throws(() => readNativeContent({ compress_content: Buffer.concat(Array(65).fill(emptyFrame)) }), { code: 'E_NATIVE_CONTENT_LIMIT' });
  assert.throws(() => readNativeContent({ compress_content: { secret: 'untrusted body' } }), { code: 'E_NATIVE_CONTENT_FORMAT' });
  const row = { get compress_content() { throw new Error('untrusted body'); } };
  assert.throws(() => readNativeContent(row), (error) => error.code === 'E_NATIVE_CONTENT_FORMAT' && !error.message.includes('untrusted body'));
});
