// Version-specific, observation-only protobuf decode hook. No native business function calls.
let listener = null;
let accepted = 0;
let rejected = 0;
let config;
let probing;
let module;

function inspect() {
  const main = Process.findModuleByName('Weixin.dll');
  return { pid: Process.id, architecture: Process.arch, pointerSize: Process.pointerSize,
    mainModule: main ? { name: main.name, path: main.path, base: main.base.toString(), size: main.size } : null };
}

function boundedString(item, offset) {
  const wrapper = item.add(offset).readPointer();
  if (wrapper.isNull() || !wrapper.readPointer().equals(module.base.add(config.arenaStringVtableRva))) throw new Error('string wrapper vtable mismatch');
  if ((wrapper.add(0x14).readU32() & 1) === 0) throw new Error('string field absent');
  const value = wrapper.add(8).readPointer();
  if (value.isNull()) throw new Error('null string');
  const length = value.add(16).readU64().toNumber();
  const capacity = value.add(24).readU64().toNumber();
  if (!Number.isSafeInteger(length) || !Number.isSafeInteger(capacity) || length < 0 || length > 65536 || capacity < length) throw new Error('string length out of range');
  if (capacity < 16 && length > 15) throw new Error('invalid inline string');
  const data = capacity >= 16 ? value.readPointer() : value;
  return length === 0 ? '' : data.readUtf8String(length);
}

function decode(item) {
  if (item.isNull() || !item.readPointer().equals(module.base.add(config.addMsgVtableRva))) throw new Error('AddMsg vtable mismatch');
  const hasBits = item.add(0x6c).readU32();
  if ((hasBits & 0x1e) !== 0x1e) throw new Error('required text fields absent');
  const type = item.add(0x14).readU32();
  if (type !== 1) return null;
  const from = boundedString(item, 8);
  const to = boundedString(item, 0x18);
  const content = boundedString(item, 0x20);
  if (!from || !to) throw new Error('empty participant');
  const newMsgId = (hasBits & 0x800) ? item.add(0x50).readU64().toString() : null;
  const msgId = (hasBits & 1) ? String(item.add(0x10).readU32()) : null;
  const createTime = (hasBits & 0x100) ? item.add(0x48).readU32() : null;
  return { event: 'candidate-message', verified: false, source: 'AddMsg-protobuf-parser', from, to, type,
    content, msgId, newMsgId, createTime, hasBits, isSelf: config.self ? from === config.self : null };
}

function normalize(raw) {
  if (!config.self) throw new Error('self wxid required');
  const id = raw.newMsgId && raw.newMsgId !== '0' ? raw.newMsgId : raw.msgId;
  if (!id || id === '0' || !raw.createTime) throw new Error('stable message ID / creation time missing');
  let chatId;
  let senderId;
  let text = raw.content;
  if (raw.from !== config.self && raw.to !== config.self) throw new Error('message belongs to another account');
  if (raw.from.endsWith('@chatroom')) {
    chatId = raw.from;
    const separator = text.indexOf(':\n');
    if (separator < 1 || separator > 256) throw new Error('group sender prefix unavailable');
    senderId = text.slice(0, separator);
    text = text.slice(separator + 2);
  } else if (raw.to.endsWith('@chatroom')) {
    chatId = raw.to;
    senderId = raw.from;
  } else {
    if (raw.from !== config.self && raw.to !== config.self) throw new Error('message belongs to another account');
    chatId = raw.from === config.self ? raw.to : raw.from;
    senderId = raw.from;
  }
  return { id, chatId, senderId, isSelf: senderId === config.self, type: 'text', text, timestamp: raw.createTime * 1000 };
}

rpc.exports = {
  inspect,
  start(profile, probe) {
    if (listener) throw new Error('hook already active');
    config = profile;
    probing = probe;
    module = Process.getModuleByName('Weixin.dll');
    if (Process.arch !== 'x64' || config.architecture !== 'x64') throw new Error('x64 required');
    const target = module.base.add(config.receiveRva);
    const range = Process.findRangeByAddress(target);
    if (!range || !range.protection.includes('x')) throw new Error('target is not executable');
    const actual = Array.from(new Uint8Array(target.readByteArray(config.prologue.length))).map(x => x.toString(16).padStart(2, '0'));
    if (actual.join('') !== config.prologue.join('').toLowerCase()) throw new Error('receive prologue mismatch');
    if (!probe && (!config.receiveValidated || !config.self)) throw new Error('receive validation and self wxid required');
    listener = Interceptor.attach(target, {
      onEnter(args) { this.item = args[0]; },
      onLeave(result) {
        if ((result.toInt32() & 0xff) !== 1) return;
        try {
          const raw = decode(this.item);
          if (!raw) return;
          const event = probing ? raw : { event: 'message', message: normalize(raw) };
          accepted++;
          send(event);
        } catch (error) {
          rejected++;
          if (rejected <= 3) send({ event: 'diagnostic', accepted, rejected, reason: error.message });
        }
      }
    });
    return { pid: Process.id, source: 'AddMsg-protobuf-parser', receiveRva: config.receiveRva, validated: config.receiveValidated };
  },
  stats() { return { accepted, rejected }; },
  stop() { if (listener) { listener.detach(); listener = null; } return { accepted, rejected }; }
};
