import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../wechat-adapters/4.2.0.7/send-agent.js', import.meta.url), 'utf8');
const oldHash = '10f8e995453e2da46d4f2b5080cd6da1f13cc5147746adc119ceae38cb039de5';
const generation = '85bb4adf-6aee-40a9-b3df-12059c29b7b5';
const validationId = 'wxcc42-text-validation-' + 'a'.repeat(32);
const imageInput = { to: 'filehelper', requestId: 'image-mock', imageResource: `wxcc-image-${generation}`, imageSha256: 'a'.repeat(64) };

// Synthetic address space only. No Frida import, DLL load, process access or real send.
function nativeRealm({ imageError, imageAccepted = true, cleanupError, textAccepted = true, accountError } = {}) {
  const values = new Map(), calls = [], destructors = [], allocations = [], releasedHandles = [];
  let next = 0x1000;
  class Pointer {
    constructor(address) { this.address = address; }
    add(offset) { return new Pointer(this.address + offset); }
    isNull() { return this.address === 0; }
    writeByteArray() {}
    writeU8(value) { values.set(this.address, value); }
    writeS32(value) { values.set(this.address, value); }
    writePointer(value) { values.set(this.address, value); }
    readPointer() { return values.get(this.address) ?? new Pointer(0); }
    readU8() { return values.get(this.address) ?? 0; }
    readU64() { return { toString: () => String(values.get(this.address) ?? 0) }; }
  }
  const alloc = size => { const p = new Pointer(next); next += size + 16; allocations.push({ pointer: p, size }); return p; };
  const context = vm.createContext({ rpc: {}, Memory: { alloc, allocUtf8String: value => value }, ptr: value => new Pointer(Number(value)), Process: { id: 1 }, NativeCallback: function (callback) { return callback; }, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(source, context);
  context.fn = rva => {
    if (rva === 0x88ad0) return (destination, value) => { values.set(destination.address, value); return destination; };
    if (rva === 0x2010) return pointer => { destructors.push(values.get(pointer.address)); if (cleanupError) throw Error('E_SYNTHETIC_DTOR'); };
    if (rva === 0x10dcd0) return pointer => { releasedHandles.push(pointer.address); pointer.writePointer(new Pointer(0)); };
    if (rva === 0x2c7ddd0) return (_unused, out, recipient, path) => {
      calls.push({ kind: 'image', to: values.get(recipient.address), resource: values.get(path.address) });
      assert.equal(allocations.find(a => a.pointer.address === out.address).size, 0x40, '4.2 writes through result+0x3f');
      if (imageError) throw Error('E_SYNTHETIC_NATIVE');
      values.set(out.address, imageAccepted ? 1 : 0);
      values.set(out.address + 8, '9007199254740993');
      values.set(out.address + 0x10, '42');
      values.set(out.address + 0x18, '1792800000');
      values.set(out.address + 0x20, imageAccepted ? '' : 'synthetic image failure');
      return out;
    };
    if (rva === 0x570db60) return (_unused, input, correlation, handle) => {
      calls.push({ kind: 'text', to: values.get(input.address), text: values.get(input.address + 32), requestId: values.get(correlation.address) });
      const object = handle.readPointer(), result = alloc(0x30);
      values.set(result.address, textAccepted ? 1 : 0);
      values.set(result.address + 8, 'synthetic text result');
      values.set(result.address + 0x28, 1);
      object.add(8).readPointer()(object, result);
      handle.writePointer(new Pointer(0));
    };
    throw Error(`Unexpected native function ${rva.toString(16)}`);
  };
  context.text = p => values.get(p.address);
  context.verifyBoundAccount = () => { if (accountError) throw Error('E_ACCOUNT_CHANGED'); };
  vm.runInContext(`binding={chatId:'filehelper',sessionId:'filehelper'};`, context);
  return { context, calls, destructors, allocations, releasedHandles };
}

test('4.2 agent loads without invoking any native or client APIs', () => {
  const context = vm.createContext({ rpc: {} });
  vm.runInContext(source, context);
  assert.equal(typeof context.rpc.exports.validateText, 'function');
  assert.equal(vm.runInContext('sendValidated', context), false);
  assert.equal(vm.runInContext('imageSendValidated', context), false);
});

test('4.2 text callback keeps result bool and optional error layout without assuming server delivery', async () => {
  for (const textAccepted of [true, false]) {
    const fx = nativeRealm({ textAccepted });
    const result = await fx.context.nativeSend({ to: 'filehelper', text: 'synthetic', requestId: 'mock' }, { status: 'executing', nativeEntryCalled: false }, () => false);
    assert.equal(result.status, textAccepted ? 'accepted' : 'failed');
    assert.equal(result.resultMessage, 'synthetic text result');
    assert.equal(result.deliveryConfirmed, false);
    assert.equal(vm.runInContext('sendValidated', fx.context), textAccepted);
    assert.deepEqual(fx.destructors, ['mock', 'synthetic', 'filehelper']);
  }
});

test('4.2 text account change or cancellation cannot reach the native send entry', async () => {
  const changed = nativeRealm({ accountError: true });
  const result = await changed.context.nativeSend({ to: 'filehelper', text: 'synthetic', requestId: 'account-changed' }, { status: 'executing', nativeEntryCalled: false }, () => false);
  assert.equal(result.status, 'failed');
  assert.equal(changed.calls.length, 0);
  assert.equal(changed.releasedHandles.length, 1, 'the unsubmitted callback owner is released once');
  assert.deepEqual(changed.destructors, ['account-changed', 'synthetic', 'filehelper']);
  assert.equal(vm.runInContext('sendValidated', changed.context), false);
  const cancelled = nativeRealm();
  assert.throws(() => cancelled.context.nativeSend({ to: 'filehelper', text: 'synthetic', requestId: 'cancelled' }, { status: 'executing', nativeEntryCalled: false }, () => true), /E_TASK_CANCELLED/);
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.allocations.length, 0);
});

test('4.2 image rechecks account immediately before the native entry and preserves binary validation', () => {
  const changed = nativeRealm({ accountError: true });
  const result = changed.context.nativeSendImage(imageInput, { nativeEntryCalled: false }, () => false);
  assert.equal(result.status, 'failed');
  assert.equal(changed.calls.length, 0);
  assert.deepEqual(changed.destructors, [imageInput.imageResource, 'filehelper']);
  assert.equal(vm.runInContext('imageSendValidated', changed.context), false);
  assert.equal(vm.runInContext('imageRuntimeBlocked', changed.context), false);
});

test('4.2 image result allocates 0x40 and cleans the moved string at +0x20 exactly once', () => {
  const fx = nativeRealm();
  const result = fx.context.nativeSendImage(imageInput, { nativeEntryCalled: false }, () => false);
  assert.equal(result.status, 'accepted');
  assert.equal(result.localId, '9007199254740993');
  assert.equal(result.extraNativeId, '42');
  assert.equal(result.createTime, '1792800000');
  assert.equal(result.deliveryConfirmed, false);
  assert.deepEqual(fx.destructors, ['', imageInput.imageResource, 'filehelper']);
  assert.equal(vm.runInContext('imageSendValidated', fx.context), true);
});

test('4.2 image native errors never destroy uninitialized output or allow retries', () => {
  const fx = nativeRealm({ imageError: true });
  const result = fx.context.nativeSendImage(imageInput, { nativeEntryCalled: false }, () => false);
  assert.equal(result.status, 'unknown');
  assert.deepEqual(fx.destructors, [imageInput.imageResource, 'filehelper']);
  assert.equal(vm.runInContext('imageRuntimeBlocked', fx.context), true);
  assert.equal(vm.runInContext('imageSendValidated', fx.context), false);
});

test('4.2 image cancellation stays before entry; native rejection and cleanup failure remain distinct', () => {
  const cancelled = nativeRealm();
  assert.equal(cancelled.context.nativeSendImage(imageInput, { nativeEntryCalled: false }, () => true).status, 'failed');
  assert.equal(cancelled.calls.length, 0);
  assert.deepEqual(cancelled.destructors, [imageInput.imageResource, 'filehelper']);
  const rejected = nativeRealm({ imageAccepted: false });
  const result = rejected.context.nativeSendImage(imageInput, { nativeEntryCalled: false }, () => false);
  assert.equal(result.status, 'failed');
  assert.equal(result.resultMessage, 'synthetic image failure');
  assert.equal(vm.runInContext('imageSendValidated', rejected.context), false);
  const cleanup = nativeRealm({ cleanupError: true });
  assert.equal(cleanup.context.nativeSendImage(imageInput, { nativeEntryCalled: false }, () => false).status, 'unknown');
  assert.equal(vm.runInContext('imageRuntimeBlocked', cleanup.context), true);
});

function prepareRealm() {
  const sends = [];
  const context = vm.createContext({ rpc: {}, Process: { id: 1234, getCurrentThreadId: () => 5678 }, captureSend: input => { sends.push(input); return Promise.resolve({ status: 'failed' }); } });
  vm.runInContext(source, context);
  vm.runInContext(`queue=callback=>Promise.resolve(callback(()=>false));lookup=(chatId,displayName)=>({chatId,displayName,displayNameMatches:true,self:'wxid_fixture_self',account:'synthetic'});currentTask=()=>({readPointer:()=>({add:()=>({readU32:()=>1})})});release=()=>{};inspect=()=>({sendValidated,imageSendValidated,textValidationAllowed});nativeSend=captureSend;`, context);
  return { context, sends };
}
const config = { pid: 1234, generation, self: 'wxid_fixture_self', chatId: 'filehelper', sessionId: 'filehelper', displayName: '文件传输助手' };

test('4.1 validation evidence cannot unlock the independently relocated 4.2 binary', async () => {
  const fx = prepareRealm();
  const proof = await fx.context.rpc.exports.prepare({ ...config, validatedBinarySha256: oldHash, validatedImageBinarySha256: oldHash });
  assert.equal(proof.sendValidated, false);
  assert.equal(proof.imageSendValidated, false);
  await assert.rejects(fx.context.rpc.exports.sendText({ to: 'filehelper', text: 'synthetic', requestId: 'test' }), /E_SEND_BINARY_UNVERIFIED/);
  assert.equal(fx.sends.length, 0);
});

test('engineering text validation requires explicit filehelper-only preparation', async () => {
  for (const change of [{}, { allowTextValidation: true, chatId: 'wxid_fixture_friend', sessionId: 'wxid_fixture_friend' }]) {
    const fx = prepareRealm();
    await fx.context.rpc.exports.prepare({ ...config, ...change });
    await assert.rejects(fx.context.rpc.exports.validateText({ requestId: validationId }), /E_TEXT_VALIDATION_SCOPE/);
    assert.equal(fx.sends.length, 0);
  }
});

test('engineering validation fixes recipient/text, is single use, and does not premark success', async () => {
  const fx = prepareRealm();
  await fx.context.rpc.exports.prepare({ ...config, allowTextValidation: true });
  for (const invalid of [{ requestId: validationId, to: 'wxid_other' }, { requestId: validationId, text: 'arbitrary' }, { requestId: 'arbitrary' }]) await assert.rejects(fx.context.rpc.exports.validateText(invalid), /E_TEXT_VALIDATION_REQUEST/);
  await fx.context.rpc.exports.validateText({ requestId: validationId });
  assert.equal(fx.sends.length, 1);
  assert.equal(fx.sends[0].to, 'filehelper');
  assert.equal(fx.sends[0].text, 'WXcc 4.2.0.7 兼容性验证');
  assert.equal(vm.runInContext('sendValidated', fx.context), false);
  await assert.rejects(fx.context.rpc.exports.validateText({ requestId: 'wxcc42-text-validation-' + 'b'.repeat(32) }), /E_TEXT_VALIDATION_SCOPE/);
  await assert.rejects(fx.context.rpc.exports.sendText({ to: 'filehelper', text: 'normal', requestId: 'normal' }), /E_SEND_BINARY_UNVERIFIED/);
});
