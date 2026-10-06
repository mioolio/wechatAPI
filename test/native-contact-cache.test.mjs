import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const agentSource = await readFile(new URL('../agents/send-native.js', import.meta.url), 'utf8');
// The original research fragment used the wrong service container and was withdrawn.
// Exercise the production implementation, never silently fall back to that fragment.
assert.ok(agentSource.includes('function cachedContacts('));
const source = agentSource;

function cacheRealm(options = {}) {
  const slots = new Map(), bytes = new Map();
  let nextAddress = 0x100000;
  class Pointer {
    constructor(address) { this.address = Number(address); }
    add(offset) { return new Pointer(this.address + Number(offset)); }
    compare(other) { return Math.sign(this.address - other.address); }
    equals(other) { return this.address === other.address; }
    isNull() { return this.address === 0; }
    toString() { return `0x${this.address.toString(16)}`; }
    readPointer() { return slots.get(this.address) ?? new Pointer(0); }
    writePointer(value) { slots.set(this.address, value); }
    readU64() { return { toNumber: () => Number(slots.get(this.address) ?? 0) }; }
    writeU64(value) { slots.set(this.address, Number(value)); }
    readU32() { return Number(slots.get(this.address) ?? 0) >>> 0; }
    readS32() { return this.readU32() | 0; }
    writeU32(value) { slots.set(this.address, Number(value)); }
    readU8() { return bytes.get(this.address) ?? 0; }
    readUtf8String(length) {
      const buffer = Buffer.from(Array.from({ length }, (_, i) => bytes.get(this.address + i) ?? 0));
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    }
  }
  const allocate = size => {
    const p = new Pointer(nextAddress);
    nextAddress += Math.ceil(size / 16) * 16 + 16;
    return p;
  };
  const writeString = (p, value) => {
    const buffer = Buffer.from(value, 'utf8');
    const capacity = Math.max(15, buffer.length), data = capacity < 16 ? p : allocate(capacity + 1);
    if (capacity >= 16) p.writePointer(data);
    for (let i = 0; i < buffer.length; ++i) bytes.set(data.address + i, buffer[i]);
    bytes.set(data.address + buffer.length, 0);
    p.add(16).writeU64(buffer.length);
    p.add(24).writeU64(capacity);
  };
  const base = new Pointer(0x180000000), kernelBase = new Pointer(0x70000000);
  const account = allocate(0x470), changedAccount = allocate(0x470), task = allocate(64);
  // A is the ordinary service container. B is the separate CacheCenter owned at +0x460.
  const ordinaryServiceContainer = allocate(0x100), ordinaryControl = allocate(16);
  const cacheCenter = allocate(0xc8), centerControl = allocate(16);
  const store = allocate(0x240), storeControl = allocate(16), head = allocate(0x40), buckets = allocate(128);
  const state = {
    events: [], allocatedPairs: [], releasedPairs: [], lockCalls: 0, unlockCalls: 0, accountCalls: 0,
    ordinaryGetterCalls: 0, centerGetterCalls: 0, storeGetterCalls: 0, storeOwners: [],
  };
  account.writePointer(base.add(0x8dfe2f8));
  writeString(account.add(0x48), 'wxid_synthetic_self');
  account.add(0x28).writePointer(ordinaryServiceContainer);
  account.add(0x30).writePointer(ordinaryControl);
  account.add(0x460).writePointer(cacheCenter);
  account.add(0x468).writePointer(centerControl);
  ordinaryServiceContainer.writePointer(base.add(0x8dfe000));
  cacheCenter.writePointer(base.add(0x8f9bf98));
  for (const control of [ordinaryControl, centerControl, storeControl]) {
    control.add(8).writeU32(1);
    control.add(12).writeU32(1);
  }
  const contacts = options.contacts ?? [{ username: 'wxid_synthetic_one', type: 1, nickname: '完整昵称 👩‍💻', remark: '完整备注', alias: 'synthetic_alias' }];
  const nodes = contacts.map(() => allocate(0x40));
  const values = contacts.map(() => allocate(0x460));
  store.writePointer(base.add(0x8fa2538));
  store.add(0x1a0).writeU32(2);
  store.add(0xd0).writePointer(head);
  store.add(0xd8).writeU64(contacts.length);
  store.add(0xe0).writePointer(buckets);
  store.add(0xe8).writePointer(buckets.add(128));
  store.add(0xf0).writePointer(buckets.add(128));
  store.add(0xf8).writeU64(7);
  store.add(0x100).writeU64(8);
  head.writePointer(nodes[0] ?? head);
  head.add(8).writePointer(nodes.at(-1) ?? head);
  for (let i = 0; i < 16; ++i) buckets.add(i * 8).writePointer(head);
  contacts.forEach((contact, i) => {
    const node = nodes[i], value = values[i], control = allocate(16);
    node.writePointer(nodes[i + 1] ?? head);
    node.add(8).writePointer(nodes[i - 1] ?? head);
    writeString(node.add(0x10), contact.username);
    node.add(0x30).writePointer(value);
    node.add(0x38).writePointer(control);
    control.add(8).writeU32(1);
    control.add(12).writeU32(1);
    value.add(4).writeU32(contact.type);
    writeString(value.add(8), contact.username);
    writeString(value.add(0x28), contact.alias ?? '');
    writeString(value.add(0x78), contact.remark ?? '');
    writeString(value.add(0xd8), contact.nickname ?? '');
  });
  if (nodes.length) {buckets.writePointer(nodes[0]); buckets.add(8).writePointer(nodes.at(-1));}
  const exportSymbols = ['AcquireSRWLockExclusive', 'GetCurrentThreadId', 'ReleaseSRWLockExclusive', 'TryAcquireSRWLockExclusive'];
  const exportPointers = new Map(exportSymbols.map((name, i) => [name, kernelBase.add(0x100 + i * 0x20)]));
  const imports = [[0x9c6ce88, exportSymbols[0]], [0x9c6d158, exportSymbols[1]], [0x9c6d640, exportSymbols[2]], [0x9c6d7f0, exportSymbols[3]]];
  imports.forEach(([rva, name]) => base.add(rva).writePointer(exportPointers.get(name)));
  const binding = { pid: 1234, generation: 'synthetic-generation', self: 'wxid_synthetic_self', account: account.toString() };
  const context = vm.createContext({
    rpc: {}, fixtureBinding: binding, ptr: value => new Pointer(value),
    Memory: { alloc: allocate },
    Process: {
      id: 1234,
      enumerateModules: () => [{ name: 'KERNEL32.dll', getExportByName: name => exportPointers.get(name) }],
      findModuleByAddress: () => ({ name: 'KERNELBASE.dll' }),
      findRangeByAddress: p => p.isNull() ? null : ({ base: new Pointer(p.address >= base.address ? base.address : p.address >= kernelBase.address ? kernelBase.address : 0x100000), size: 0x10000000, protection: 'rwx' }),
    },
  });
  vm.runInContext(source, context, { filename: 'native-contact-cache-under-test.js' });
  vm.runInContext('binding = fixtureBinding;', context);
  context.moduleVerified = () => ({ base });
  context.pair = () => {
    const p = allocate(16);
    p.writePointer(new Pointer(0)); p.add(8).writePointer(new Pointer(0));
    state.allocatedPairs.push(p);
    return p;
  };
  context.release = p => {
    state.events.push('release');
    state.releasedPairs.push(p);
    options.release?.(p, state);
    p.writePointer(new Pointer(0)); p.add(8).writePointer(new Pointer(0));
  };
  const returnPair = (out, owner, control = storeControl) => {
    out.writePointer(owner); out.add(8).writePointer(control); return out;
  };
  context.fn = (rva, ret, args) => {
    const expect = (expectedRet, expectedArgs) => {
      assert.equal(ret, expectedRet);
      assert.deepEqual(Array.from(args), expectedArgs);
    };
    if (rva === 0x48af50) {expect('pointer', ['pointer']); return out => returnPair(out, task);}
    if (rva === 0x47220) {
      expect('pointer', ['pointer']);
      return out => {
        state.accountCalls++;
        const changed = options.accountChangedInitially || (options.accountChangedAfterUnlock && state.unlockCalls > 0);
        return returnPair(out, changed ? changedAccount : account);
      };
    }
    if (rva === 0x36c740) {
      expect('pointer', ['pointer', 'pointer']);
      return (owner, out) => {
        assert.ok(owner.equals(account)); state.ordinaryGetterCalls++;
        return returnPair(out, ordinaryServiceContainer, ordinaryControl);
      };
    }
    if (rva === 0x36c7b0) {
      expect('pointer', ['pointer', 'pointer']);
      return (owner, out) => {
        assert.ok(owner.equals(account)); state.centerGetterCalls++;
        // A synthetic getter must not conceal entry into the native lazy factory branch.
        assert.ok(owner.add(0x460).readPointer().equals(cacheCenter), 'CacheCenter must already be owned');
        assert.ok(owner.add(0x468).readPointer().equals(centerControl), 'CacheCenter must retain its owner');
        return returnPair(out, cacheCenter, centerControl);
      };
    }
    if (rva === 0x6dcf80) {
      expect('pointer', ['pointer', 'pointer']);
      return (owner, out) => {
        state.storeGetterCalls++; state.storeOwners.push(owner);
        assert.ok(!owner.equals(ordinaryServiceContainer), 'ordinary service container A is not a CacheCenter');
        assert.ok(owner.equals(cacheCenter), 'store getter accepts only CacheCenter B');
        return returnPair(out, store);
      };
    }
    if (rva === 0x74ac950) {expect('int', ['pointer', 'pointer']); return () => {throw Error('Mutex implementation must only be signature checked');};}
    if (rva === 0x74ac908) {
      expect('int', ['pointer']);
      return p => {assert.ok(p.equals(store.add(0x1a0))); state.lockCalls++; state.events.push('lock'); return options.lockResult ?? 0;};
    }
    if (rva === 0x74ac930) {
      expect('int', ['pointer']);
      return p => {
        assert.ok(p.equals(store.add(0x1a0))); state.unlockCalls++; state.events.push('unlock');
        options.unlock?.(context, state);
        return options.unlockResult ?? 0;
      };
    }
    throw Error(`Unexpected native function ${rva.toString(16)}`);
  };
  const realm = {
    context, state, base, account, ordinaryServiceContainer, ordinaryControl, cacheCenter, centerControl,
    store, head, nodes, values, buckets, allocate, writeString,
  };
  options.mutate?.(realm);
  return { ...realm, run: () => JSON.parse(JSON.stringify(context.cachedContacts())) };
}

function assertCleaned(realm, unlockCalls) {
  assert.equal(realm.state.unlockCalls, unlockCalls);
  assert.equal(realm.state.allocatedPairs.length, 5);
  assert.equal(realm.state.releasedPairs.length, 5, 'all native shared-pair owners are released even when snapshot fails');
  assert.equal(new Set(realm.state.releasedPairs).size, 5, 'no pair is released twice');
  assert.ok(realm.state.allocatedPairs.every(p => realm.state.releasedPairs.includes(p)));
  if (unlockCalls) assert.ok(realm.state.events.indexOf('unlock') < realm.state.events.indexOf('release'), 'borrowed native owners stay alive until unlock');
}

function assertCenterRoute(realm) {
  assert.equal(realm.state.ordinaryGetterCalls, 0, 'ordinary service getter is never used to obtain the cache');
  assert.equal(realm.state.centerGetterCalls, 1);
  assert.equal(realm.state.storeGetterCalls, 1);
  assert.ok(realm.state.storeOwners[0].equals(realm.cacheCenter));
}

test('synthetic native getters distinguish ordinary container A from CacheCenter B', () => {
  const realm = cacheRealm(), a = realm.allocate(16), b = realm.allocate(16), out = realm.allocate(16);
  realm.context.fn(0x36c740, 'pointer', ['pointer', 'pointer'])(realm.account, a);
  realm.context.fn(0x36c7b0, 'pointer', ['pointer', 'pointer'])(realm.account, b);
  assert.ok(a.readPointer().equals(realm.ordinaryServiceContainer));
  assert.ok(b.readPointer().equals(realm.cacheCenter));
  assert.ok(!a.readPointer().equals(b.readPointer()));
  const getStore = realm.context.fn(0x6dcf80, 'pointer', ['pointer', 'pointer']);
  assert.throws(() => getStore(a.readPointer(), out), /ordinary service container A is not a CacheCenter/);
  getStore(b.readPointer(), out);
  assert.ok(out.readPointer().equals(realm.store));
});

const rejectedCenterCases = [
  ['wrong account vtable', /E_CONTACTS_ACCOUNT_TYPE/, r => r.account.writePointer(r.base.add(0x8dfe000))],
  ['empty CacheCenter', /E_CONTACTS_POINTER/, r => r.account.add(0x460).writePointer(r.context.ptr(0))],
  ['empty CacheCenter owner', /E_CONTACTS_POINTER/, r => r.account.add(0x468).writePointer(r.context.ptr(0))],
  ['wrong CacheCenter vtable', /E_CONTACTS_CACHE_CENTER_TYPE/, r => r.cacheCenter.writePointer(r.base.add(0x8dfe000))],
  ['expired CacheCenter owner', /E_CONTACTS_CACHE_CENTER_TYPE/, r => r.centerControl.add(8).writeU32(0)],
  ['ordinary service container substituted for CacheCenter', /E_CONTACTS_CACHE_CENTER_TYPE/, r => r.account.add(0x460).writePointer(r.ordinaryServiceContainer)],
];
for (const [name, error, mutate] of rejectedCenterCases) {
  test(`native cache rejects ${name} before calling either CacheCenter or store getter`, () => {
    const realm = cacheRealm({ mutate });
    assert.throws(() => realm.run(), error);
    assert.equal(realm.state.ordinaryGetterCalls, 0);
    assert.equal(realm.state.centerGetterCalls, 0, 'a rejected precondition cannot enter the lazy factory branch');
    assert.equal(realm.state.storeGetterCalls, 0, 'rejection occurs before executing the native store getter');
    assert.equal(realm.state.lockCalls, 0);
    assertCleaned(realm, 0);
  });
}

test('native cache returns one record with complete Unicode names beyond the old text helper limit', () => {
  const fullName = '完整姓名 👩‍💻 '.repeat(150);
  assert.ok(Buffer.byteLength(fullName) > 1024);
  const realm = cacheRealm({ contacts: [{ username: 'wxid_synthetic_one', type: 1, nickname: fullName, remark: '完整备注', alias: '' }] });
  const result = realm.run();
  assert.equal(result.scope, 'loaded-contact-cache');
  assert.equal(result.complete, false);
  assert.equal(result.cacheSnapshotComplete, true);
  assert.equal(result.count, 1);
  assert.equal(result.contacts[0].nickname, fullName);
  assert.equal(result.contacts[0].displayName, '完整备注');
  assertCenterRoute(realm);
  assertCleaned(realm, 1);
});

test('native cache returns two distinct exact IDs and keeps remark/nickname precedence', () => {
  const realm = cacheRealm({ contacts: [
    { username: 'wxid_synthetic_one', type: 1, nickname: '第一位完整名称', remark: '第一位备注' },
    { username: 'synthetic_group@chatroom', type: 5, nickname: '第二个完整群名 👪', remark: '' },
  ] });
  assert.deepEqual(realm.run().contacts, [
    { username: 'wxid_synthetic_one', type: 1, nickname: '第一位完整名称', remark: '第一位备注', alias: '', displayName: '第一位备注' },
    { username: 'synthetic_group@chatroom', type: 5, nickname: '第二个完整群名 👪', remark: '', alias: '', displayName: '第二个完整群名 👪' },
  ]);
  assertCenterRoute(realm);
  assertCleaned(realm, 1);
});

test('production cache uses an unnamed placeholder without exposing a raw ID as displayName', { skip: !agentSource.includes('function cachedContacts(') }, () => {
  const realm = cacheRealm({ contacts: [{ username: 'wxid_synthetic_unnamed', type: 1, nickname: '', remark: '', alias: '' }] });
  const row = realm.run().contacts[0];
  assert.equal(row.displayName, '（未命名）');
  assert.equal(row.displayName.includes(row.username), false);
  assertCleaned(realm, 1);
});

const rejectionCases = [
  ['broken next/previous link', /E_CONTACTS_CHAIN_LINK/, r => r.nodes[0].add(8).writePointer(r.nodes[0])],
  ['cache count above 4096', /E_CONTACTS_CACHE_LIMIT/, r => r.store.add(0xd8).writeU64(4097)],
  ['declared count differs from traversal', /E_CONTACTS_CHAIN_COUNT/, r => r.store.add(0xd8).writeU64(2)],
  ['contact username differs from map key', /E_CONTACTS_IDENTITY/, r => r.writeString(r.values[0].add(8), 'wxid_other_synthetic')],
  ['invalid username with whitespace', /E_CONTACTS_IDENTITY/, r => r.writeString(r.nodes[0].add(0x10), 'bad synthetic')],
  ['bucket endpoint is outside this exact list', /E_CONTACTS_BUCKET_ENDPOINT/, r => r.buckets.writePointer(r.allocate(0x40))],
  ['string field has oversized length', /E_CONTACTS_STRING_SIZE/, r => r.values[0].add(0xd8 + 16).writeU64(16385)],
  ['native contact owner is expired', /E_CONTACTS_CONTROL/, r => r.nodes[0].add(0x38).readPointer().add(8).writeU32(0)],
];
for (const [name, error, mutate] of rejectionCases) {
  test(`native cache rejects ${name} and unlocks/releases every owner`, () => {
    const realm = cacheRealm({ mutate });
    assert.throws(() => realm.run(), error);
    assertCleaned(realm, 1);
  });
}

test('native cache rejects an account mismatch before lock and still releases all pairs', () => {
  const realm = cacheRealm({ accountChangedInitially: true });
  assert.throws(() => realm.run(), /E_ACCOUNT_OR_TARGET_CHANGED/);
  assert.equal(realm.state.lockCalls, 0);
  assertCleaned(realm, 0);
});

test('native cache rejects an account switch after unlock before exposing any rows', () => {
  const realm = cacheRealm({ accountChangedAfterUnlock: true });
  assert.throws(() => realm.run(), /E_ACCOUNT_OR_TARGET_CHANGED/);
  assert.equal(realm.state.accountCalls, 2);
  assertCleaned(realm, 1);
});

test('native cache rejects a different self on the same account pointer before invoking cache getters', () => {
  const realm = cacheRealm({ mutate: r => r.writeString(r.account.add(0x48), 'wxid_other_self') });
  assert.throws(realm.run, /E_ACCOUNT_OR_TARGET_CHANGED/);
  assert.equal(realm.state.centerGetterCalls, 0);
  assert.equal(realm.state.storeGetterCalls, 0);
  assertCleaned(realm, 0);
});

test('native cache rechecks self after unlock even when the account pointer is unchanged', () => {
  let realm;
  realm = cacheRealm({ unlock: () => realm.writeString(realm.account.add(0x48), 'wxid_other_self') });
  assert.throws(realm.run, /E_ACCOUNT_OR_TARGET_CHANGED/);
  assertCleaned(realm, 1);
});

test('native cache rejects changed generation at the native unlock boundary', () => {
  const realm = cacheRealm({ unlock: context => vm.runInContext("binding = {...binding, generation: 'changed-generation'};", context) });
  assert.throws(() => realm.run(), /E_ACCOUNT_OR_TARGET_CHANGED/);
  assertCleaned(realm, 1);
});

test('native cache does not unlock when native lock acquisition failed', () => {
  const realm = cacheRealm({ lockResult: 3 });
  assert.throws(() => realm.run(), /E_CONTACTS_LOCK/);
  assertCleaned(realm, 0);
});

test('native cache cleanup still releases every shared pair after unlock failure', () => {
  const realm = cacheRealm({ unlock: () => {throw Error('synthetic unlock failure');} });
  assert.throws(() => realm.run(), /synthetic unlock failure/);
  assertCleaned(realm, 1);
});

test('native cache attempts all owner releases when one release throws', () => {
  let calls = 0;
  const realm = cacheRealm({ release: () => {if (++calls === 2) throw Error('synthetic release failure');} });
  assert.throws(() => realm.run(), /synthetic release failure/);
  assertCleaned(realm, 1);
});
