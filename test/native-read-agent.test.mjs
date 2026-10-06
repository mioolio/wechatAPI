import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../agents/read-native.js', import.meta.url), 'utf8');

// Execute the production decoder against synthetic byte storage and VM ranges.
// No Frida import, native process, hook, host request, or message send is involved.
function readRealm(options = {}) {
  const blocks = [], ranges = [], callableSlots = new Map();
  let nextAddress = 0x100000n;
  const state = { rangeLookups: [], constructors: [], destructors: [], queryCalls: 0, ownerReleases: 0, events: [], timers: new Map() };
  class Pointer {
    constructor(value) { this.address = value instanceof Pointer ? value.address : BigInt(value); }
    add(offset) { return new Pointer(this.address + BigInt(offset)); }
    sub(other) { return new Pointer(this.address - other.address); }
    compare(other) { return this.address < other.address ? -1 : this.address > other.address ? 1 : 0; }
    equals(other) { return this.address === other.address; }
    isNull() { return this.address === 0n; }
    toUInt32() { return Number(BigInt.asUintN(32, this.address)); }
    toString() { return `0x${this.address.toString(16)}`; }
    bytes(length) {
      const block = blocks.find(b => this.address >= b.base.address && this.address + BigInt(length) <= b.base.address + BigInt(b.buffer.length));
      if (!block) throw Error('Synthetic out-of-allocation read');
      const start = Number(this.address - block.base.address);
      return block.buffer.subarray(start, start + length);
    }
    readPointer() { return callableSlots.get(this.address) ?? new Pointer(this.bytes(8).readBigUInt64LE()); }
    writePointer(value) {
      if (typeof value === 'function') callableSlots.set(this.address, value);
      else { callableSlots.delete(this.address); this.bytes(8).writeBigUInt64LE(value.address); }
    }
    readU64() {
      const value = this.bytes(8).readBigUInt64LE();
      return { toNumber: () => Number(value), toString: () => value.toString() };
    }
    writeU64(value) { this.bytes(8).writeBigUInt64LE(BigInt(value)); }
    readU32() { return this.bytes(4).readUInt32LE(); }
    writeU32(value) { this.bytes(4).writeUInt32LE(Number(value)); }
    readS32() { return this.bytes(4).readInt32LE(); }
    writeS32(value) { this.bytes(4).writeInt32LE(Number(value)); }
    readU8() { return this.bytes(1)[0]; }
    writeU8(value) { this.bytes(1)[0] = value; }
    writeByteArray(value) { this.bytes(value.byteLength).set(new Uint8Array(value)); }
    readUtf8String(length) {
      if (length === undefined) {
        const block = blocks.find(b => this.address >= b.base.address && this.address < b.base.address + BigInt(b.buffer.length));
        if (!block) throw Error('Synthetic out-of-allocation string');
        const available = block.buffer.subarray(Number(this.address - block.base.address));
        const terminal = available.indexOf(0);
        if (terminal < 0) throw Error('Synthetic missing string terminator');
        length = terminal;
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(length));
    }
  }
  function allocate(size, { visible = true } = {}) {
    const base = new Pointer(nextAddress);
    nextAddress += BigInt(Math.ceil(size / 16) * 16 + 16);
    const block = { base, buffer: Buffer.alloc(size) };
    blocks.push(block);
    if (visible) ranges.push({ base, size, protection: 'rw-' });
    return base;
  }
  function writeString(header, value, { visibleHeap = true } = {}) {
    const encoded = Buffer.from(value, 'utf8'), capacity = Math.max(15, encoded.length);
    const data = capacity < 16 ? header : allocate(capacity + 1, { visible: visibleHeap });
    if (capacity >= 16) header.writePointer(data);
    data.writeByteArray(encoded);
    data.add(encoded.length).writeU8(0);
    header.add(16).writeU64(encoded.length);
    header.add(24).writeU64(capacity);
    return data;
  }
  function replaceRanges(base, segments) {
    const block = blocks.find(b => b.base.equals(base));
    assert.ok(block, 'range fixture must refer to an allocation');
    for (let i = ranges.length - 1; i >= 0; --i) {
      if (ranges[i].base.compare(base) >= 0 && ranges[i].base.compare(base.add(block.buffer.length)) < 0) ranges.splice(i, 1);
    }
    for (const [offset, size, protection = 'rw-'] of segments) ranges.push({ base: base.add(offset), size, protection });
  }
  function writeVector(header, begin, bytes) {
    header.writePointer(begin);
    header.add(8).writePointer(begin.add(bytes));
    header.add(16).writePointer(begin.add(bytes));
  }
  const binding = { pid: 4321, generation: 'synthetic-read-generation', self: 'wxid_synthetic_self' };
  const context = vm.createContext({
    rpc: {}, fixtureBinding: binding,
    ptr: value => new Pointer(value),
    Memory: {
      // Frida-owned storage exists but is deliberately absent from Process ranges.
      alloc: size => allocate(size, { visible: false }),
      allocUtf8String: value => { const p = allocate(Buffer.byteLength(value) + 1, { visible: false }); p.writeByteArray(Buffer.from(value)); return p; },
    },
    Process: {
      id: binding.pid,
      findRangeByAddress(p) {
        state.rangeLookups.push(p.address);
        return ranges.find(r => p.compare(r.base) >= 0 && p.compare(r.base.add(r.size)) < 0) ?? null;
      },
    },
    NativeCallback: function (callback) { return callback; },
    setTimeout(callback, delay) { const id = Symbol('timer'); state.timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => state.timers.delete(id),
  });
  vm.runInContext(source, context, { filename: 'agents/read-native.js' });
  vm.runInContext('binding = fixtureBinding;', context);
  context.verifyAccount = () => { state.events.push('verify-account'); };
  context.fn = (rva, ret, args) => {
    if (rva === 0x88ad0) {
      assert.equal(ret, 'pointer'); assert.deepEqual(Array.from(args), ['pointer', 'pointer']);
      return (header, input) => {
        const value = input.readUtf8String();
        state.constructors.push({ header, value });
        writeString(header, value, { visibleHeap: !(options.cloakInputHeap && state.constructors.length === 1) });
        options.mutateConstructor?.(header, value, state.constructors.length);
        return header;
      };
    }
    if (rva === 0x2010) return header => { state.events.push('string-dtor'); state.destructors.push(header); options.destructor?.(header, state); };
    if (rva === 0x107050) return handle => {
      state.ownerReleases++;
      const owner = handle.readPointer();
      if (!owner.isNull()) owner.add(16).readPointer()(owner);
      handle.writePointer(new Pointer(0));
    };
    if (rva === 0x5476170) {
      assert.equal(ret, 'void'); assert.deepEqual(Array.from(args), ['pointer', 'pointer', 'pointer', 'pointer']);
      return (_unused, typed, correlation, handle) => {
        state.queryCalls++; state.events.push('query-entry');
        assert.ok(_unused.isNull());
        assert.ok(typed.add(8).readPointer().equals(typed.readPointer().add(32)));
        assert.ok(typed.add(16).readPointer().equals(typed.add(8).readPointer()));
        assert.equal(typed.add(0x48).readS32(), realm.input.limit);
        assert.equal(typed.add(0x54).readU8(), 0, 'raw XML stays disabled');
        assert.equal(correlation.readUtf8String(), 'wxcc-read-1');
        const owner = handle.readPointer();
        owner.add(8).readPointer()(owner, realm.result);
        state.events.push('invoke-complete');
        // The native callee consumes the owner after invoking, before return.
        handle.writePointer(new Pointer(0));
        owner.add(16).readPointer()(owner);
        state.events.push('query-return');
      };
    }
    throw Error(`Unexpected native boundary ${rva.toString(16)}`);
  };
  const realm = { context, state, binding, allocate, writeString, replaceRanges, writeVector, ptr: value => new Pointer(value) };
  realm.fixture = ({ to = 'wxid_synthetic_chat', self = binding.self, messages = [{}], content = '完整消息 👋' } = {}) => {
    const result = allocate(0x68), group = allocate(0x90), rows = allocate(Math.max(1, messages.length * 0xc0));
    result.writeU8(1); writeString(result.add(0x30), self); writeVector(result.add(0x50), group, 0x90);
    writeString(group, to); writeVector(group.add(0x78), rows, messages.length * 0xc0);
    const messagePointers = messages.map((message, i) => {
      const p = rows.add(i * 0xc0);
      p.writeU64(message.serverId ?? 9007199254740993n);
      p.add(8).writeU64(message.type ?? 49n);
      p.add(0x10).writeU64(message.subType ?? 6n); p.add(0x18).writeU8(1);
      p.add(0x20).writeU64(message.createTime ?? 1728000000n);
      writeString(p.add(0x28), message.content ?? content); p.add(0x48).writeU8(1);
      writeString(p.add(0x50), message.senderUsername ?? 'wxid_synthetic_sender');
      writeString(p.add(0x70), message.senderName ?? '完整姓名 👩‍💻'); p.add(0x90).writeU8(1);
      p.add(0xb8).writeU8(0);
      return p;
    });
    Object.assign(realm, { result, group, rows, messagePointers, input: { to, limit: Math.max(1, messages.length) } });
    return realm;
  };
  realm.decode = () => JSON.parse(JSON.stringify(context.decodeHistory(realm.result, realm.input)));
  realm.query = () => context.nativeHistory(realm.input, () => false);
  return realm;
}

test('native history preserves uint64 server IDs and full message/display text', () => {
  const r = readRealm().fixture({ messages: [{ serverId: 18446744073709551615n, createTime: 4294967295n }] });
  const result = r.decode();
  assert.deepEqual(result.messages, [{
    serverId: '18446744073709551615', type: '49', subType: '6', createTime: '4294967295',
    content: '完整消息 👋', senderUsername: 'wxid_synthetic_sender', senderName: '完整姓名 👩‍💻',
  }]);
  assert.equal(result.self, r.binding.self);
  assert.equal(result.chatId, r.input.to);
  assert.equal(result.automaticMessagesSent, 0);
});

test('native history rejects another account and another chat before publishing', () => {
  const account = readRealm().fixture({ self: 'wxid_synthetic_other' });
  assert.throws(() => account.decode(), /E_HISTORY_ACCOUNT_SCOPE/);
  const chat = readRealm().fixture();
  chat.writeString(chat.group, 'wxid_synthetic_other');
  assert.throws(() => chat.decode(), /E_HISTORY_CHAT_SCOPE/);
});

test('native history accepts an empty, valid message vector', () => {
  const r = readRealm().fixture({ messages: [] });
  assert.deepEqual(r.decode().messages, []);
});

const invalidVectors = [
  ['a nonempty tail with a null begin', r => r.group.add(0x78).writePointer(r.ptr(0)), /E_HISTORY_VECTOR/],
  ['a reversed end', r => r.group.add(0x80).writePointer(r.rows.add(-1)), /E_HISTORY_VECTOR/],
  ['capacity before the end', r => r.group.add(0x88).writePointer(r.rows), /E_HISTORY_VECTOR/],
  ['a partial message stride', r => {r.group.add(0x80).writePointer(r.rows.add(0xbf));r.group.add(0x88).writePointer(r.rows.add(0xbf));}, /E_HISTORY_VECTOR_LIMIT/],
  ['more messages than requested', r => {r.group.add(0x80).writePointer(r.rows.add(0x180));r.group.add(0x88).writePointer(r.rows.add(0x180));}, /E_HISTORY_VECTOR_LIMIT/],
  ['a byte count that would truncate at 32 bits', r => {r.group.add(0x80).writePointer(r.rows.add(0x1000000c0n));r.group.add(0x88).writePointer(r.rows.add(0x1000000c0n));}, /E_HISTORY_VECTOR_LIMIT/],
];
for (const [description, mutate, pattern] of invalidVectors) test(`native history rejects ${description}`, () => {
  const r = readRealm().fixture(); mutate(r); assert.throws(() => r.decode(), pattern);
});

test('native history rejects invalid optional flags and unexpected XML', () => {
  for (const offset of [0x18, 0x48, 0x90, 0xb8]) {
    const r = readRealm().fixture(); r.messagePointers[0].add(offset).writeU8(2);
    assert.throws(() => r.decode(), /E_HISTORY_FLAG/);
  }
  const success = readRealm().fixture(); success.result.writeU8(2);
  assert.throws(() => success.decode(), /E_HISTORY_FLAG/);
  const xml = readRealm().fixture(); xml.messagePointers[0].add(0xb8).writeU8(1);
  assert.throws(() => xml.decode(), /E_HISTORY_XML_UNEXPECTED/);
});

test('native history rejects malformed string lengths, capacities and inline layout', () => {
  for (const mutate of [
    p => p.add(16).writeU64(262145),
    p => p.add(24).writeU64(2),
    p => p.add(24).writeU64(14),
    p => p.add(24).writeU64(1048577),
    p => p.add(16).writeU64(9007199254740993n),
  ]) {
    const r = readRealm().fixture({ content: 'hello' }); mutate(r.messagePointers[0].add(0x28));
    assert.throws(() => r.decode(), /E_STRING_LAYOUT:content/);
  }
});

test('native history rejects invalid UTF-8, embedded NUL and missing termination', () => {
  const invalid = readRealm().fixture({ content: 'xx' });
  invalid.messagePointers[0].add(0x28).writeByteArray(Uint8Array.of(0xc3, 0x28));
  assert.throws(() => invalid.decode(), /encoded data|UTF|E_STRING_ENCODING/i);
  const nul = readRealm().fixture({ content: 'ab\0cd' });
  assert.throws(() => nul.decode(), /E_STRING_ENCODING:content/);
  const terminal = readRealm().fixture({ content: 'hello' }); terminal.messagePointers[0].add(0x28 + 5).writeU8(1);
  assert.throws(() => terminal.decode(), /E_STRING_TERMINATOR:content/);
});

test('native DTO and string data can span adjacent readable VM ranges', () => {
  const r = readRealm().fixture({ content: 'a heap string crossing two regions 👋' });
  r.replaceRanges(r.result, [[0, 0x48], [0x48, 0x20]]);
  const data = r.messagePointers[0].add(0x28).readPointer(), size = Number(r.messagePointers[0].add(0x38).readU64().toNumber()) + 1;
  r.replaceRanges(data, [[0, 7], [7, size - 7]]);
  assert.equal(r.decode().messages[0].content, 'a heap string crossing two regions 👋');
});

test('native DTO and external string data reject unreadable gaps', () => {
  const dto = readRealm().fixture(); dto.replaceRanges(dto.result, [[0, 0x48], [0x49, 0x1f]]);
  assert.throws(() => dto.decode(), /E_READ_RANGE:result/);
  const string = readRealm().fixture({ content: 'a heap string with an unreadable region' });
  const header = string.messagePointers[0].add(0x28), data = header.readPointer(), size = header.add(16).readU64().toNumber() + 1;
  string.replaceRanges(data, [[0, 7], [7, 1, '---'], [8, size - 8]]);
  assert.throws(() => string.decode(), /E_READ_RANGE:content-data/);
});

test('native range guards reject null and excessive spans', () => {
  const r = readRealm().fixture();
  assert.throws(() => r.context.readable(r.ptr(0), 32), /E_READ_POINTER/);
  assert.throws(() => r.context.readable(r.result, 4 * 1024 * 1024 + 1), /E_READ_POINTER/);
});

test('native history validates an owned cloaked inline input without Process header lookup', async () => {
  const r = readRealm().fixture({ to: 'self' });
  const result = await r.query();
  assert.equal(result.messages[0].serverId, '9007199254740993');
  assert.equal(r.state.queryCalls, 1);
  const chat = r.state.constructors[0].header;
  assert.ok(!r.state.rangeLookups.some(address => address >= chat.address && address < chat.address + 32n));
  assert.equal(r.state.ownerReleases, 0, 'an entered owner is consumed only by the native boundary');
  assert.equal(r.state.destructors.length, 2);
  assert.ok(r.state.events.indexOf('query-return') < r.state.events.indexOf('string-dtor'));
});

test('owned cloaked input still requires a readable external heap buffer', async () => {
  const visible = readRealm().fixture(); await visible.query();
  const header = visible.state.constructors[0].header, heap = header.readPointer();
  assert.ok(visible.state.rangeLookups.includes(heap.address));
  assert.ok(!visible.state.rangeLookups.includes(header.address));
  const hidden = readRealm({ cloakInputHeap: true }).fixture();
  await assert.rejects(hidden.query(), /E_READ_RANGE:input-chat-data/);
  assert.equal(hidden.state.queryCalls, 0, 'input validation must fail before native query entry');
  assert.equal(hidden.state.ownerReleases, 1, 'the unentered owner is released once');
  assert.equal(hidden.state.destructors.length, 2);
});

test('owned input capacity and roundtrip validation reject corruption before query entry', async () => {
  for (const mutate of [
    header => header.add(24).writeU64(14),
    header => header.add(16).writeU64(1),
    header => header.writeU8('X'.charCodeAt(0)),
    header => header.add(4).writeU8(1),
  ]) {
    const r = readRealm({ mutateConstructor: (header, _value, index) => {if (index === 1) mutate(header);} }).fixture({ to: 'self' });
    await assert.rejects(r.query(), /E_HISTORY_INPUT_LAYOUT|E_HISTORY_STRING_ROUNDTRIP/);
    assert.equal(r.state.queryCalls, 0);
    assert.equal(r.state.ownerReleases, 1);
  }
});

test('history completes independent cleanup attempts and rejects a cleanup failure', async () => {
  const r = readRealm({ destructor: (_header, state) => {if (state.destructors.length === 1) throw Error('Synthetic destructor failure');} }).fixture();
  await assert.rejects(r.query(), /Synthetic destructor failure/);
  assert.equal(r.state.destructors.length, 2);
  assert.equal(r.state.ownerReleases, 0);
  assert.equal(vm.runInContext('runtimeBlocked', r.context), true);
});
