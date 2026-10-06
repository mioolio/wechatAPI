import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../agents/send-native.js', import.meta.url), 'utf8');

// Model only pointer slots and the queue boundary. No Frida import or process access.
function queueRealm({ enqueue, releaseJob } = {}) {
  const slots = new Map();
  let nextAddress = 0x1000;
  class Pointer {
    constructor(address) { this.address = address; }
    add(offset) { return new Pointer(this.address + offset); }
    isNull() { return this.address === 0; }
    toString() { return `0x${this.address.toString(16)}`; }
    writePointer(value) { slots.set(this.address, value); }
    readPointer() { return slots.get(this.address) ?? new Pointer(0); }
    writeByteArray() {}
    writeU32(value) { slots.set(this.address, value); }
  }
  const allocate = size => {
    const p = new Pointer(nextAddress);
    nextAddress += size + 16;
    return p;
  };
  const state = { invoke: null, job: null, releaseAttempts: [] };
  const context = vm.createContext({
    rpc: {},
    ptr: value => new Pointer(Number(value)),
    Memory: { alloc: allocate, allocUtf8String: value => allocate(value.length + 1) },
    NativeCallback: function (callback) { return callback; },
    setTimeout: () => { throw Error('Unexpected timer in queue cancellation test'); },
  });
  vm.runInContext(source, context, { filename: 'agents/send-native.js' });
  const mainContext = allocate(16), runner = allocate(16);
  context.fn = rva => {
    if (rva === 0x45d10) return () => mainContext;
    if (rva === 0x47310) return (_main, out) => { out.writePointer(runner); return out; };
    if (rva === 0x2fb010) return (_runner, out, _location, callable) => {
      const impl = callable.add(0x38).readPointer();
      const invoke = impl.readPointer().add(16).readPointer();
      state.invoke = () => invoke(impl);
      state.job = out;
      callable.add(0x38).writePointer(new Pointer(0));
      out.writePointer(allocate(16));
      enqueue?.(state);
      return out;
    };
    throw Error(`Unexpected native function ${rva.toString(16)}`);
  };
  context.release = pair => {
    state.releaseAttempts.push(pair);
    if (pair === state.job) releaseJob?.(state);
  };
  return { queue: context.queue, state };
}

test('an enqueue failure cancels an accepted callback before its delayed invocation', async () => {
  const realm = queueRealm({ enqueue: () => { throw Error('E_ENQUEUE_AFTER_ACCEPT'); } });
  let businessCalls = 0;
  const pending = realm.queue(() => { businessCalls++; });

  await assert.rejects(pending, /E_ENQUEUE_AFTER_ACCEPT/);
  assert.equal(typeof realm.state.invoke, 'function');
  realm.state.invoke();

  assert.equal(businessCalls, 0, 'a late callback must not revive the rejected operation');
  assert.equal(realm.state.releaseAttempts.length, 2, 'both queue temporaries are cleaned up');
});

test('cleanup failure cancels business preparation that began inside the callback', async () => {
  let finishPreparation;
  const preparation = new Promise(resolve => { finishPreparation = resolve; });
  const realm = queueRealm({
    enqueue: state => state.invoke(),
    releaseJob: () => { throw Error('E_RELEASE_JOB'); },
  });
  let started = false, cancellationObserved = false, sendCalls = 0;
  const pending = await realm.queue(isCancelled => {
    started = true;
    return { promise: preparation.then(() => {
      cancellationObserved = isCancelled();
      if (!cancellationObserved) sendCalls++;
    }) };
  });

  assert.equal(started, true, 'preparation starts before queue cleanup fails');
  finishPreparation();
  await pending.promise;

  assert.equal(cancellationObserved, true, 'the running callback sees cancellation after preparation resumes');
  assert.equal(sendCalls, 0, 'cancellation at the native preparation boundary blocks sending');
  assert.equal(realm.state.releaseAttempts.length, 2, 'runner cleanup still runs after job release fails');
});
