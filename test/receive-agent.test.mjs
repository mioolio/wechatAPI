import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../agents/receive.js', import.meta.url), 'utf8');
const profile = JSON.parse(await readFile(new URL('../profiles/4.1.15.13.json', import.meta.url), 'utf8'));
const evidence = JSON.parse(await readFile(new URL('./fixtures/receive-layout.json', import.meta.url), 'utf8'));
const self = 'wxid_self';
const base = 0x180000000n;

/** Fake Frida memory rejects every read outside one explicitly allocated region. */
function harness({ arch = 'x64', protection = 'r-x', changedPrologue = false } = {}) {
  const regions = [];
  const reads = [];
  const events = [];
  let next = 0x10000n;
  let hook;
  let detached = false;
  function allocate(length, at) {
    const address = at ?? next;
    next = address + BigInt(length) + 0x100n;
    const bytes = Buffer.alloc(length);
    regions.push({ address, bytes });
    return { address, bytes, pointer: new Pointer(address) };
  }
  function read(address, length, kind) {
    assert.ok(Number.isSafeInteger(length) && length >= 0, 'read length must be bounded');
    reads.push({ address, length, kind });
    const region = regions.find(({ address: start, bytes }) => address >= start && address + BigInt(length) <= start + BigInt(bytes.length));
    if (!region) throw new Error('fake memory: read crosses an allocated boundary');
    const offset = Number(address - region.address);
    return region.bytes.subarray(offset, offset + length);
  }
  class Pointer {
    constructor(value) { this.value = BigInt(value); }
    add(offset) { return new Pointer(this.value + BigInt(offset)); }
    isNull() { return this.value === 0n; }
    equals(other) { return this.value === other.value; }
    toString() { return `0x${this.value.toString(16)}`; }
    readPointer() { return new Pointer(read(this.value, 8, 'pointer').readBigUInt64LE()); }
    readU32() { return read(this.value, 4, 'u32').readUInt32LE(); }
    readU64() {
      const value = read(this.value, 8, 'u64').readBigUInt64LE();
      return { toNumber: () => Number(value), toString: () => value.toString() };
    }
    readByteArray(length) { return Uint8Array.from(read(this.value, length, 'bytes')).buffer; }
    readUtf8String(length) { return new TextDecoder('utf-8', { fatal: true }).decode(read(this.value, length, 'utf8')); }
  }
  const target = allocate(profile.prologue.length, base + BigInt(profile.receiveRva));
  target.bytes.set(Buffer.from(profile.prologue.join(''), 'hex'));
  if (changedPrologue) target.bytes[0] ^= 0xff;
  const main = { name: 'Weixin.dll', path: 'C:\\fixture\\Weixin.dll', base: new Pointer(base), size: 0xa000000 };
  const rpc = {};
  const context = vm.createContext({
    rpc,
    Process: { id: 123, arch, pointerSize: 8, findModuleByName: () => main, getModuleByName: () => main, findRangeByAddress: () => ({ protection }) },
    Interceptor: { attach: (address, callbacks) => {
      assert.equal(address.value, target.address);
      hook = callbacks;
      return { detach() { detached = true; hook = null; } };
    } },
    send: (event) => events.push(JSON.parse(JSON.stringify(event))),
  });
  vm.runInContext(source, context, { filename: 'receive.js', timeout: 1000 });
  function stringWrapper(value, { forceHeap = false } = {}) {
    const encoded = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const wrapper = allocate(Number.parseInt(evidence.nestedString.allocatedSize));
    const native = allocate(32);
    wrapper.bytes.writeBigUInt64LE(base + BigInt(evidence.nestedString.vtableRva), 0);
    wrapper.bytes.writeBigUInt64LE(native.address, Number.parseInt(evidence.nestedString.stringPointerOffset));
    wrapper.bytes.writeUInt32LE(1, Number.parseInt(evidence.nestedString.hasBitsOffset));
    const heap = forceHeap || encoded.length >= evidence.nestedString.heapCapacityThreshold;
    const capacity = heap ? Math.max(16, encoded.length) : 15;
    const data = heap ? allocate(encoded.length) : native;
    if (heap) native.bytes.writeBigUInt64LE(data.address, 0);
    data.bytes.set(encoded);
    native.bytes.writeBigUInt64LE(BigInt(encoded.length), Number.parseInt(evidence.nestedString.nativeStringLengthOffset));
    native.bytes.writeBigUInt64LE(BigInt(capacity), Number.parseInt(evidence.nestedString.nativeStringCapacityOffset));
    return { wrapper, native, data };
  }
  function message({ from = 'wxid_peer', to = self, content = '测试消息', type = 1, msgId = 42, newMsgId = '18446744073709551614', createTime = 1790908800, hasBits } = {}) {
    const item = allocate(Number.parseInt(evidence.candidate.allocationSize));
    item.bytes.writeBigUInt64LE(base + BigInt(evidence.candidate.vtableRva));
    const wrappers = {};
    for (const [name, text] of [['fromUserName', from], ['toUserName', to], ['content', content]]) {
      const value = stringWrapper(text);
      wrappers[name] = value;
      item.bytes.writeBigUInt64LE(value.wrapper.address, Number.parseInt(evidence.fields[name].offset));
    }
    let bits = 0;
    for (const name of ['msgId', 'fromUserName', 'toUserName', 'msgType', 'content', 'createTime', 'newMsgId']) bits |= Number.parseInt(evidence.fields[name].hasBit);
    item.bytes.writeUInt32LE(hasBits ?? bits, Number.parseInt(evidence.candidate.hasBitsOffset));
    item.bytes.writeUInt32LE(type, Number.parseInt(evidence.fields.msgType.offset));
    item.bytes.writeUInt32LE(msgId, Number.parseInt(evidence.fields.msgId.offset));
    item.bytes.writeBigUInt64LE(BigInt(newMsgId), Number.parseInt(evidence.fields.newMsgId.offset));
    item.bytes.writeUInt32LE(createTime, Number.parseInt(evidence.fields.createTime.offset));
    return { item, wrappers };
  }
  return {
    rpc, reads, events, message,
    start({ probe = true, overrides = {} } = {}) { return rpc.exports.start({ ...profile, self, ...overrides }, probe); },
    emit(message, result = 1) {
      assert.ok(hook, 'a hook must be attached');
      const invocation = {};
      hook.onEnter.call(invocation, [message.item.pointer]);
      hook.onLeave.call(invocation, { toInt32: () => result });
    },
    get attached() { return !!hook; }, get detached() { return detached; },
  };
}

test('receive profile agrees with the version-specific static evidence and remains unvalidated', () => {
  assert.equal(profile.receiveRva, evidence.candidate.rva);
  assert.equal(profile.addMsgVtableRva, evidence.candidate.vtableRva);
  assert.equal(profile.arenaStringVtableRva, evidence.nestedString.vtableRva);
  assert.equal(profile.dllSha256, evidence.dll.sha256);
  assert.equal(profile.architecture, evidence.dll.architecture);
  assert.equal(profile.receiveValidated, false);
  assert.equal(evidence.runtimeVerified, false);
  const staticBytes = evidence.candidate.prologueBytes32.split(' ');
  assert.ok(profile.prologue.length >= 16);
  assert.deepEqual(profile.prologue, staticBytes.slice(0, profile.prologue.length));
});

test('checks architecture, executable memory and exact prologue before attaching', () => {
  for (const [options, reason] of [
    [{ arch: 'ia32' }, /x64 required/],
    [{ protection: 'r--' }, /not executable/],
    [{ changedPrologue: true }, /prologue mismatch/],
  ]) {
    const agent = harness(options);
    assert.throws(() => agent.start(), reason);
    assert.equal(agent.attached, false);
  }
  const agent = harness();
  assert.throws(() => agent.start({ probe: false }), /validation and self/);
  assert.equal(agent.attached, false);
  agent.start();
  assert.equal(agent.reads[0].length, profile.prologue.length);
  agent.rpc.exports.stop();
  assert.equal(agent.detached, true);
});

test('only reads decoded objects when parser returns AL == 1 and preserves uint64 IDs', () => {
  const agent = harness();
  agent.start();
  const value = agent.message();
  const before = agent.reads.length;
  agent.emit(value, 0);
  agent.emit(value, 0x100);
  assert.equal(agent.reads.length, before);
  assert.deepEqual(agent.events, []);
  agent.emit(value, 0x101);
  assert.equal(agent.events[0].event, 'candidate-message');
  assert.equal(agent.events[0].verified, false);
  assert.equal(agent.events[0].newMsgId, '18446744073709551614');
  assert.equal(agent.events[0].content, '测试消息');
  assert.equal(agent.events[0].isSelf, false);
});

test('normalizes direct messages and incoming/outgoing groups using explicit self identity', () => {
  const cases = [
    [{ from: 'wxid_peer', to: self, content: 'hello' }, { chatId: 'wxid_peer', senderId: 'wxid_peer', isSelf: false, text: 'hello' }],
    [{ from: self, to: 'wxid_peer', content: 'outgoing' }, { chatId: 'wxid_peer', senderId: self, isSelf: true, text: 'outgoing' }],
    [{ from: 'room@chatroom', to: self, content: 'wxid_peer:\nhello:\nworld' }, { chatId: 'room@chatroom', senderId: 'wxid_peer', isSelf: false, text: 'hello:\nworld' }],
    [{ from: 'room@chatroom', to: self, content: `${self}:\necho` }, { chatId: 'room@chatroom', senderId: self, isSelf: true, text: 'echo' }],
    [{ from: self, to: 'room@chatroom', content: 'outgoing group' }, { chatId: 'room@chatroom', senderId: self, isSelf: true, text: 'outgoing group' }],
  ];
  for (const [input, expected] of cases) {
    const agent = harness();
    agent.start({ probe: false, overrides: { receiveValidated: true } });
    agent.emit(agent.message(input));
    assert.equal(agent.events.length, 1);
    assert.equal(agent.events[0].event, 'message');
    assert.deepEqual(agent.events[0].message, {
      id: '18446744073709551614', ...expected, type: 'text', timestamp: 1790908800000,
    });
  }
});

test('rejects objects with wrong vtables, absent fields, malformed lengths or invalid UTF-8', () => {
  const mutations = [
    (value) => value.item.bytes.writeBigUInt64LE(0n),
    (value) => value.item.bytes.writeUInt32LE(0, Number.parseInt(evidence.candidate.hasBitsOffset)),
    (value) => value.item.bytes.writeBigUInt64LE(0n, Number.parseInt(evidence.fields.content.offset)),
    (value) => value.wrappers.content.wrapper.bytes.writeBigUInt64LE(base + BigInt(evidence.nestedString.correctedCandidate.match(/0x[0-9a-f]+/)[0])),
    (value) => value.wrappers.content.wrapper.bytes.writeUInt32LE(0, Number.parseInt(evidence.nestedString.hasBitsOffset)),
    (value) => value.wrappers.content.wrapper.bytes.writeBigUInt64LE(0n, Number.parseInt(evidence.nestedString.stringPointerOffset)),
    (value) => value.wrappers.content.native.bytes.writeBigUInt64LE(65537n, 16),
    (value) => value.wrappers.content.native.bytes.writeBigUInt64LE(0n, 24),
    (value) => value.wrappers.content.native.bytes.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 16),
  ];
  for (const mutate of mutations) {
    const agent = harness();
    agent.start();
    const value = agent.message();
    mutate(value);
    agent.emit(value);
    assert.equal(agent.events.length, 1);
    assert.equal(agent.events[0].event, 'diagnostic');
    assert.equal(agent.events[0].rejected, 1);
    assert.ok(agent.reads.every(({ length }) => length <= 65536));
  }
  const invalidUtf8 = harness();
  invalidUtf8.start();
  invalidUtf8.emit(invalidUtf8.message({ content: Buffer.from([0xc3, 0x28]) }));
  assert.equal(invalidUtf8.events[0].event, 'diagnostic');
  assert.equal(invalidUtf8.rpc.exports.stats().accepted, 0);
});

test('heap strings are length bounded and non-text messages do not read string payloads', () => {
  const agent = harness();
  agent.start();
  agent.emit(agent.message({ content: 'a'.repeat(65536) }));
  assert.equal(agent.events[0].content.length, 65536);
  assert.ok(agent.reads.every(({ length }) => length <= 65536));
  const nonText = harness();
  nonText.start();
  nonText.emit(nonText.message({ type: 3, content: 'not decoded' }));
  assert.deepEqual(nonText.events, []);
  assert.ok(nonText.reads.every(({ kind }) => kind !== 'utf8'));
});

test('missing stable ID, malformed group sender and other-account messages are rejected', () => {
  for (const input of [
    { msgId: 0, newMsgId: '0' },
    { createTime: 0 },
    { from: 'room@chatroom', content: 'no sender prefix' },
    { from: 'room@chatroom', content: `${'x'.repeat(257)}:\nhello` },
    { from: 'wxid_other', to: 'wxid_unrelated' },
    { from: 'room@chatroom', to: 'wxid_other', content: 'wxid_peer:\nhello' },
    { from: 'wxid_other', to: 'room@chatroom', content: 'hello' },
  ]) {
    const agent = harness();
    agent.start({ probe: false, overrides: { receiveValidated: true } });
    agent.emit(agent.message(input));
    assert.equal(agent.events.length, 1);
    assert.equal(agent.events[0].event, 'diagnostic', JSON.stringify(input));
    assert.equal(agent.rpc.exports.stats().accepted, 0, 'normalization failures must not count as accepted messages');
  }
});

test('fallback message ID remains decimal text and diagnostics stop after three errors', () => {
  const agent = harness();
  agent.start({ probe: false, overrides: { receiveValidated: true } });
  agent.emit(agent.message({ newMsgId: '0', msgId: 123 }));
  assert.equal(agent.events[0].message.id, '123');
  const broken = agent.message();
  broken.item.bytes.writeBigUInt64LE(0n);
  for (let index = 0; index < 5; index += 1) agent.emit(broken);
  assert.equal(agent.events.filter(({ event }) => event === 'diagnostic').length, 3);
  assert.equal(agent.rpc.exports.stats().rejected, 5);
});
