import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../wechat-adapters/4.1.15.13/send-agent.js', import.meta.url), 'utf8');
function imageRealm({ nativeError, accepted = true, cleanupError } = {}) {
  const values = new Map(), calls = [], destructors = [];
  let next = 0x1000;
  class Pointer {
    constructor(address) { this.address = address; }
    add(offset) { return new Pointer(this.address + offset); }
    writeByteArray() {}
    readU8() { return values.get(this.address) ?? 0; }
    readU64() { return { toString: () => String(values.get(this.address) ?? 0) }; }
  }
  const alloc = size => { const pointer = new Pointer(next); next += size + 16; return pointer; };
  const context = vm.createContext({ rpc: {}, Memory: { alloc, allocUtf8String: value => value }, ptr: value => new Pointer(Number(value)), Process: { id: 1 } });
  vm.runInContext(source, context);
  context.fn = rva => {
    if (rva === 0x88ad0) return (destination, value) => { values.set(destination.address, value); return destination; };
    if (rva === 0x2010) return pointer => { destructors.push(values.get(pointer.address)); if (cleanupError) throw Error('E_SYNTHETIC_DTOR'); };
    if (rva === 0x2ba7a20) return (_unused, out, recipient, path) => {
      calls.push({ to: values.get(recipient.address), path: values.get(path.address) });
      if (nativeError) throw Error('E_SYNTHETIC_NATIVE');
      values.set(out.address, accepted ? 1 : 0);
      values.set(out.address + 8, '9007199254740993');
      values.set(out.address + 0x10, '100');
      values.set(out.address + 0x18, accepted ? '' : 'synthetic failure');
      return out;
    };
    throw Error(`Unexpected native function ${rva.toString(16)}`);
  };
  context.text = pointer => values.get(pointer.address);
  context.verifyBoundAccount = () => {};
  vm.runInContext(`binding={chatId:'filehelper',sessionId:'filehelper'};sendValidated=true;imageValidationAllowed=true;`, context);
  return { context, calls, destructors };
}
const input = { to: 'filehelper', requestId: 'image-mock', imageResource: 'wxcc-image-85bb4adf-6aee-40a9-b3df-12059c29b7b5', imageSha256: 'a'.repeat(64) };

test('native image entry uses constructed strings, exact IDs and releases the returned result string once', () => {
  const fx = imageRealm();
  const result = fx.context.nativeSendImage(input, { nativeEntryCalled: false }, () => false);
  assert.equal(result.status, 'accepted');
  assert.equal(result.localId, '9007199254740993');
  assert.equal(result.deliveryConfirmed, false);
  assert.deepEqual(fx.calls, [{ to: input.to, path: input.imageResource }]);
  assert.deepEqual(fx.destructors, ['', input.imageResource, input.to]);
  assert.equal(vm.runInContext('imageSendValidated', fx.context), true);
});

test('native image cancellation occurs before entry and cannot mark the image ABI validated', () => {
  const fx = imageRealm();
  const result = fx.context.nativeSendImage(input, { nativeEntryCalled: false }, () => true);
  assert.equal(result.status, 'failed');
  assert.equal(fx.calls.length, 0);
  assert.deepEqual(fx.destructors, [input.imageResource, input.to]);
  assert.equal(vm.runInContext('imageSendValidated', fx.context), false);
});

test('a thrown image native entry retains unknown state and closes further sends', () => {
  const fx = imageRealm({ nativeError: true });
  const result = fx.context.nativeSendImage(input, { nativeEntryCalled: false }, () => false);
  assert.equal(result.status, 'unknown');
  assert.equal(fx.calls.length, 1);
  assert.deepEqual(fx.destructors, [input.imageResource, input.to], 'unreturned output has no proved live C++ string');
  assert.equal(vm.runInContext('imageRuntimeBlocked', fx.context), true);
  assert.throws(() => fx.context.validateRequest(input, 'image'), /E_NATIVE_SEND_BUSY/);
});

test('native rejection does not validate images and a destructor failure changes acceptance to unknown', () => {
  const rejected = imageRealm({ accepted: false });
  assert.equal(rejected.context.nativeSendImage(input, { nativeEntryCalled: false }, () => false).status, 'failed');
  assert.equal(vm.runInContext('imageSendValidated', rejected.context), false);
  const failedCleanup = imageRealm({ cleanupError: true });
  assert.equal(failedCleanup.context.nativeSendImage(input, { nativeEntryCalled: false }, () => false).status, 'unknown');
  assert.equal(vm.runInContext('imageRuntimeBlocked', failedCleanup.context), true);
});

test('first image validation is confined to exact filehelper and checks paths and duplicate IDs', () => {
  const fx = imageRealm();
  fx.context.preparedInput = input;
  vm.runInContext(`imageResources.set(preparedInput.imageResource,{sha256:preparedInput.imageSha256,used:false});`, fx.context);
  fx.context.validateRequest(input, 'image');
  vm.runInContext(`binding.chatId='wxid_fixture';`, fx.context);
  assert.throws(() => fx.context.validateRequest({ ...input, to: 'wxid_fixture' }, 'image'), /E_IMAGE_BINARY_UNVERIFIED/);
  vm.runInContext(`binding.chatId='filehelper';`, fx.context);
  for (const imageResource of ['https://example.invalid/p.png', '\\\\server\\image.png', 'relative.png', 'C:\\a\0b']) assert.throws(() => fx.context.validateRequest({ ...input, imageResource }, 'image'), /E_IMAGE_PATH/);
  vm.runInContext(`requests.set('image-mock',{status:'unknown'});`, fx.context);
  assert.throws(() => fx.context.validateRequest(input, 'image'), /E_REQUEST_DUPLICATE/);
});
