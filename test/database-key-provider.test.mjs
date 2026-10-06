import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { findDatabaseKey, createWin32DatabaseKeyApi, DATABASE_KEY_PROCESS_ACCESS } from '../src/database-key-provider.mjs';
import { SUPPORTED_CIPHER_PROFILES } from '../src/database-decrypt.mjs';

const expectedExePath = 'C:\\synthetic\\Weixin.exe';
const key = Buffer.alloc(32, 0x61), salt = Buffer.alloc(16, 0x27);
const profile = SUPPORTED_CIPHER_PROFILES[0];
const identity = { pid: 123, self: 'synthetic_self', generation: 'synthetic-generation', accountVerified: true };
const codeIs = code => error => error.code === code;
function firstPage(mode = 'raw', headerReserve = 80) {
  const plain = Buffer.alloc(4096); plain.writeUInt16BE(4096, 16);
  plain[18] = 1; plain[19] = 1; plain[20] = headerReserve; plain[21] = 64; plain[22] = 32; plain[23] = 32;
  const aes = mode === 'raw' ? key : pbkdf2Sync(key, salt, 256000, 32, 'sha512');
  const auth = pbkdf2Sync(aes, Buffer.from(salt.map(byte => byte ^ 0x3a)), 2, 32, 'sha512');
  const iv = Buffer.alloc(16, 9), result = Buffer.alloc(4096), cipher = createCipheriv('aes-256-cbc', aes, iv);
  cipher.setAutoPadding(false); salt.copy(result);
  Buffer.concat([cipher.update(plain.subarray(16, 4016)), cipher.final()]).copy(result, 16); iv.copy(result, 4016);
  const pgno = Buffer.alloc(4); pgno.writeUInt32LE(1);
  createHmac('sha512', auth).update(result.subarray(16, 4032)).update(pgno).digest().copy(result, 4032);
  auth.fill(0); if (mode !== 'raw') aes.fill(0);
  return result;
}
function mockReader(regions) {
  const calls = [], readBuffers = [];
  const end = regions.reduce((maximum, region) => region.base + region.bytes.length > maximum ? region.base + region.bytes.length : maximum, 0);
  return {
    calls, readBuffers,
    openProcess(pid, access) { calls.push(['open', pid, access]); return 777; },
    imagePath() { calls.push(['image']); return expectedExePath; },
    queryRegion(_handle, address) {
      calls.push(['query', address]);
      const at = Number(address);
      if (at >= end) return null;
      const region = regions.find(value => at >= value.base && at < value.base + value.bytes.length);
      if (!region) { const next = regions.find(value => value.base > at); return { baseAddress: BigInt(at), regionSize: BigInt(next.base - at), state: 0x10000, type: 0, protect: 0 }; }
      return { baseAddress: BigInt(region.base), regionSize: BigInt(region.bytes.length), state: region.state ?? 0x1000, type: region.type ?? 0x20000, protect: region.protect ?? 0x04 };
    },
    readMemory(_handle, address, length) {
      calls.push(['read', address, length]);
      const region = regions.find(value => Number(address) >= value.base && Number(address) < value.base + value.bytes.length);
      const bytes = Buffer.from(region.bytes.subarray(Number(address) - region.base, Number(address) - region.base + length)); readBuffers.push(bytes);
      return { ok: true, bytesRead: length, bytes };
    },
    closeHandle() { calls.push(['close']); return true; }
  };
}
function setup(memory = Buffer.alloc(8192), extras = {}) {
  const api = mockReader([{ base: 4096, bytes: memory }]), guards = [];
  const options = { pid: 123, expectedExePath, firstPage: firstPage(), profiles: [profile], chunkSize: 128, maxMemoryBytes: 8192, accountGuard: ({ phase }) => { guards.push(phase); return identity; }, ...extras };
  const deps = { winapi: api, platform: 'win32', arch: 'x64', canonicalPath: async value => value, readExeArchitecture: async () => 'x64' };
  return { api, guards, options, deps };
}
function rawBlob(otherSalt = salt) { return `x'${key.toString('hex')}${otherSalt.toString('hex')}'`; }
function binaryFixture(layout, overrides = {}) {
  const memory = Buffer.alloc(8192), base = 65536;
  const offset = 200, saltOffset = 1536, cipherOffset = 2048, keyOffset = 3072;
  const legacy = layout === 'legacy';
  const fields = [0, 256000, 2, 16, 32, 16, 16, 4096, ...(legacy ? [overrides.keyspecBytes ?? 100] : []), 80, 64, 0, 2, 2, ...(legacy ? [0, 0, 3] : [0, 27])];
  fields.forEach((value, index) => memory.writeUInt32LE(value, offset + index * 4));
  memory.writeBigUInt64LE(BigInt(overrides.saltPointer ?? base + saltOffset), offset + (legacy ? 72 : 64));
  memory.writeBigUInt64LE(BigInt(overrides.cipherPointer ?? base + cipherOffset), offset + (legacy ? 104 : 96));
  memory.writeBigUInt64LE(0n, offset + (legacy ? 112 : 104));
  (overrides.salt ?? salt).copy(memory, saltOffset);
  memory.writeUInt32LE(overrides.deriveKey ?? 0, cipherOffset);
  memory.writeBigUInt64LE(BigInt(overrides.keyPointer ?? base + keyOffset), cipherOffset + 8);
  (overrides.key ?? key).copy(memory, keyOffset);
  const f = setup(memory, { maxMemoryBytes: 8192, maxPassphraseCandidates: 0 });
  f.deps.winapi = mockReader([{ base, bytes: memory }]);
  return { ...f, base, memory, saltOffset, cipherOffset, keyOffset };
}

test('salt-matched raw blob crosses chunks; read access, account guards and privacy hold', async () => {
  const memory = Buffer.alloc(8192); memory.write(Buffer.alloc(32, 8).toString('hex'), 15); memory.write(rawBlob(), 200);
  const f = setup(memory);
  const result = await findDatabaseKey(f.options, f.deps);
  assert.deepEqual(result.key, key); assert.deepEqual(result.salt, salt); assert.equal(result.mode, 'raw');
  assert.deepEqual(f.api.calls[0], ['open', 123, 0x410]); assert.equal(DATABASE_KEY_PROCESS_ACCESS, 0x410);
  assert.deepEqual(f.guards, ['before', 'after']); assert.equal(f.api.calls.filter(call => call[0] === 'close').length, 1);
  assert.equal(JSON.stringify(result).includes(key.toString('hex')), false); assert.equal(JSON.stringify(result).includes(expectedExePath), false);
  assert.equal(Object.keys(result).includes('key'), false); assert.equal(Object.keys(result).includes('salt'), false);
  assert.ok(f.api.readBuffers.every(bytes => bytes.every(value => value === 0)));
  result.key.fill(0); result.salt.fill(0);
});

test('bare 64hex fallback tries all bounded raw candidates before passphrase', async () => {
  const memory = Buffer.alloc(8192); memory.write(Buffer.alloc(32, 8).toString('hex'), 100); memory.write(key.toString('hex'), 400);
  const f = setup(memory, { firstPage: firstPage('passphrase'), maxPassphraseCandidates: 2 });
  const modes = [];
  const { verifyDatabaseKey } = await import('../src/database-decrypt.mjs');
  f.options.verifyCandidate = params => { modes.push(params.mode); return verifyDatabaseKey(params); };
  const result = await findDatabaseKey(f.options, f.deps);
  assert.deepEqual(modes, ['raw', 'raw', 'passphrase', 'passphrase']);
  assert.equal(result.mode, 'passphrase'); assert.deepEqual(result.key, key); assert.equal(result.salt, undefined);
  result.key.fill(0);
});

test('other-database salt and forbidden region protections never yield keys', async () => {
  const memory = Buffer.alloc(8192); memory.write(rawBlob(Buffer.alloc(16, 7)), 10);
  const f = setup(memory, { maxPassphraseCandidates: 0 });
  let verified = 0; f.options.verifyCandidate = () => { verified++; return true; };
  await assert.rejects(findDatabaseKey(f.options, f.deps), codeIs('E_DB_KEY_NOT_FOUND')); assert.equal(verified, 0);
  for (const properties of [{ protect: 0x104 }, { protect: 0x02 }, { type: 0x40000 }, { type: 0x1000000 }, { state: 0x2000 }]) {
    const bytes = Buffer.alloc(4096); bytes.write(rawBlob(), 10);
    const fixture = setup(bytes); fixture.deps.winapi = mockReader([{ base: 4096, bytes, ...properties }]);
    await assert.rejects(findDatabaseKey(fixture.options, fixture.deps), codeIs('E_DB_KEY_NOT_FOUND'));
    assert.equal(fixture.deps.winapi.calls.some(call => call[0] === 'read'), false);
  }
});

test('changed self/generation rejects and wipes candidate; image/architecture mismatch closes safely', async () => {
  for (const changed of [{ self: 'synthetic_changed' }, { generation: 'new-generation' }]) {
    const memory = Buffer.alloc(8192); memory.write(rawBlob(), 20);
    const f = setup(memory, { accountGuard: ({ phase }) => ({ ...identity, ...(phase === 'after' ? changed : {}) }) });
    await assert.rejects(findDatabaseKey(f.options, f.deps), codeIs('E_DB_KEY_ACCOUNT_CHANGED'));
    assert.equal(f.api.calls.filter(call => call[0] === 'close').length, 1);
  }
  const image = setup(); image.api.imagePath = () => 'C:\\different\\Weixin.exe';
  await assert.rejects(findDatabaseKey(image.options, image.deps), codeIs('E_DB_KEY_PROCESS'));
  assert.equal(image.api.calls.some(call => call[0] === 'read'), false); assert.equal(image.api.calls.at(-1)[0], 'close');
  const arch = setup(); arch.deps.readExeArchitecture = async () => 'x86';
  await assert.rejects(findDatabaseKey(arch.options, arch.deps), codeIs('E_DB_KEY_ARCH')); assert.equal(arch.api.calls.length, 0);
});

test('read budget, candidate limit, deadline and missing guard are bounded', async () => {
  const f = setup(Buffer.alloc(16384), { maxMemoryBytes: 4096, maxPassphraseCandidates: 0 });
  await assert.rejects(findDatabaseKey(f.options, f.deps), error => {
    assert.equal(error.code, 'E_DB_KEY_NOT_FOUND');
    assert.ok(error.details.scannedBytes <= 4096); assert.equal(error.details.memoryBytesRead, 4096);
    assert.equal(error.details.regionsRead, 1); assert.equal(error.details.rawChecks, 0);
    assert.equal(Object.values(error.details).every(value => Number.isSafeInteger(value) && value >= 0), true);
    return true;
  });
  assert.ok(f.api.calls.filter(call => call[0] === 'read').reduce((sum, call) => sum + call[2], 0) <= 4096);
  const memory = Buffer.alloc(8192); memory.write(`x'${Buffer.alloc(32, 8).toString('hex')}${salt.toString('hex')}'`, 10); memory.write(rawBlob(), 400);
  const limited = setup(memory, { maxCandidates: 1 });
  await assert.rejects(findDatabaseKey(limited.options, limited.deps), codeIs('E_DB_KEY_CANDIDATE_LIMIT'));
  assert.equal(limited.api.calls.at(-1)[0], 'close');
  const timed = setup(undefined, { timeoutMs: 5000 }); let clock = 0; timed.deps.now = () => clock;
  const original = timed.api.queryRegion; timed.api.queryRegion = (...args) => { const value = original(...args); clock += 6000; return value; };
  await assert.rejects(findDatabaseKey(timed.options, timed.deps), codeIs('E_DB_KEY_TIMEOUT')); assert.equal(timed.api.calls.at(-1)[0], 'close');
  const guard = setup(undefined, { accountGuard: undefined });
  await assert.rejects(findDatabaseKey(guard.options, guard.deps), codeIs('E_DB_KEY_ACCOUNT')); assert.equal(guard.api.calls.length, 0);
});

test('unreadable chunks are skipped with no leaked buffers; handle closure failure rejects key', async () => {
  const f = setup(); const original = f.api.readMemory;
  f.api.readMemory = (...args) => ({ ...original(...args), ok: false, bytesRead: 0 });
  await assert.rejects(findDatabaseKey(f.options, f.deps), error => error.code === 'E_DB_KEY_NOT_FOUND' && error.details.readFailures > 0 && error.details.memoryBytesRead === 0 && error.details.regionsRead === 0);
  assert.ok(f.api.readBuffers.every(bytes => bytes.every(byte => byte === 0)));
  const memory = Buffer.alloc(8192); memory.write(rawBlob(), 20);
  const badClose = setup(memory); badClose.api.closeHandle = () => false;
  await assert.rejects(findDatabaseKey(badClose.options, badClose.deps), codeIs('E_DB_KEY_HANDLE'));
});

test('primary scan budget reserves time for raw fallback and final guard within total deadline', async () => {
  const memory = Buffer.alloc(8192); memory.write(key.toString('hex'), 10);
  const f = setup(memory, { timeoutMs: 1000, maxPassphraseCandidates: 0 });
  let clock = 0; f.deps.now = () => clock;
  const read = f.api.readMemory;
  let reads = 0;
  f.api.readMemory = (...args) => { const result = read(...args); if (++reads === 2) clock = 810; return result; };
  const result = await findDatabaseKey(f.options, f.deps);
  assert.equal(result.mode, 'raw'); assert.deepEqual(result.key, key);
  assert.deepEqual(f.guards, ['before', 'after']); assert.equal(clock < 1000, true);
  assert.equal(reads, 2); result.key.fill(0);
});

test('sparse fallback anchors preserve 64hex detection at every alignment', async () => {
  for (let offset = 1; offset <= 64; offset++) {
    const memory = Buffer.alloc(4096); memory.write(key.toString('hex'), offset);
    const f = setup(memory, { chunkSize: 4096, maxPassphraseCandidates: 0 });
    const result = await findDatabaseKey(f.options, f.deps); assert.deepEqual(result.key, key); result.key.fill(0);
  }
});

test('legacy/current binary SQLCipher contexts use matched salt and authenticated raw AES only', async () => {
  for (const layout of ['legacy', 'current']) {
    const f = binaryFixture(layout);
    const modes = [], { verifyDatabaseKey } = await import('../src/database-decrypt.mjs');
    f.options.verifyCandidate = options => { modes.push(options.mode); return verifyDatabaseKey(options); };
    const result = await findDatabaseKey(f.options, f.deps);
    assert.deepEqual(result.key, key); assert.deepEqual(result.salt, salt); assert.equal(result.mode, 'raw');
    assert.deepEqual(modes, ['raw']); assert.deepEqual(f.guards, ['before', 'after']);
    assert.ok(f.deps.winapi.readBuffers.every(bytes => bytes.every(byte => byte === 0)));
    assert.equal(JSON.stringify(result).includes(f.base.toString()), false);
    result.key.fill(0); result.salt.fill(0);
  }
});

test('legacy keyspec size accepts only the finite 96/99/100 whitelist with page authentication', async () => {
  for (const keyspecBytes of [96, 99, 100]) {
    const f = binaryFixture('legacy', { keyspecBytes });
    const result = await findDatabaseKey(f.options, f.deps); assert.deepEqual(result.key, key); result.key.fill(0); result.salt.fill(0);
  }
  const rejected = binaryFixture('legacy', { keyspecBytes: 101 });
  await assert.rejects(findDatabaseKey(rejected.options, rejected.deps), codeIs('E_DB_KEY_NOT_FOUND'));
});

test('safe context diagnostics distinguish stored HMAC matches, AES failure and invalid headers', async () => {
  for (const layout of ['legacy', 'current']) for (const failure of ['aes', 'header']) {
    const f = binaryFixture(layout, failure === 'aes' ? { key: Buffer.alloc(32, 8) } : {});
    const auth = pbkdf2Sync(key, Buffer.from(salt.map(byte => byte ^ 0x3a)), 2, 32, 'sha512');
    f.memory.writeBigUInt64LE(BigInt(f.base + f.keyOffset + 64), f.cipherOffset + 16);
    auth.copy(f.memory, f.keyOffset + 64); auth.fill(0);
    if (failure === 'header') f.options.firstPage = firstPage('raw', 0);
    await assert.rejects(findDatabaseKey(f.options, f.deps), error => {
      assert.equal(error.code, 'E_DB_KEY_NOT_FOUND');
      const stats = error.details;
      assert.equal(stats.legacySaltMatches, layout === 'legacy' ? 1 : 0);
      assert.equal(stats.currentSaltMatches, layout === 'current' ? 1 : 0);
      assert.equal(stats.contextKeyReads, 1); assert.equal(stats.contextRawChecks, 1); assert.equal(stats.contextRawFailures, 1);
      assert.equal(stats.contextHmacKeyReads, 1); assert.equal(stats.storedHmacPageMatches, 1);
      assert.equal(stats.contextZeroKeyReads, 0); assert.equal(stats.contextZeroHmacKeyReads, 0);
      assert.equal(stats.contextCipherReads, 1); assert.equal(stats.contextEmptyPassReads, 1); assert.equal(stats.contextPendingDerivationReads, 0);
      assert.equal(stats.hmacFailures, failure === 'aes' ? 1 : 0);
      assert.equal(stats.headerFailures, failure === 'header' ? 1 : 0);
      assert.ok(Object.values(stats).every(value => Number.isSafeInteger(value) && value >= 0));
      assert.equal(JSON.stringify(stats).includes(key.toString('hex')), false);
      return true;
    });
    assert.ok(f.deps.winapi.readBuffers.every(bytes => bytes.every(value => value === 0)));
  }
});

test('zero context key diagnostics reveal only counts and never accept cleared AES/HMAC buffers', async () => {
  const f = binaryFixture('legacy', { key: Buffer.alloc(32) });
  f.memory.writeBigUInt64LE(BigInt(f.base + f.keyOffset + 64), f.cipherOffset + 16);
  await assert.rejects(findDatabaseKey(f.options, f.deps), error => {
    assert.equal(error.code, 'E_DB_KEY_NOT_FOUND');
    assert.equal(error.details.contextZeroKeyReads, 1); assert.equal(error.details.contextZeroHmacKeyReads, 1);
    assert.equal(error.details.storedHmacPageMatches, 0);
    assert.ok(Object.values(error.details).every(value => Number.isSafeInteger(value) && value >= 0));
    return true;
  });
  const pending = binaryFixture('current', { deriveKey: 1 });
  await assert.rejects(findDatabaseKey(pending.options, pending.deps), error => {
    assert.equal(error.details.contextPendingDerivationReads, 1); assert.equal(error.details.contextKeyReads, 0);
    assert.equal(error.details.contextHmacKeyReads, 0);
    return error.code === 'E_DB_KEY_NOT_FOUND';
  });
});

test('legacy keyspec pointer is bounded and authenticates a salt-matched blob in a readonly region', async () => {
  const f = binaryFixture('legacy', { key: Buffer.alloc(32) });
  const blob = Buffer.from(rawBlob()), blobBase = 131072;
  f.memory.writeBigUInt64LE(BigInt(blobBase), f.cipherOffset + 32);
  f.deps.winapi = mockReader([{ base: f.base, bytes: f.memory }, { base: blobBase, bytes: blob, protect: 0x02 }]);
  const result = await findDatabaseKey(f.options, f.deps);
  assert.deepEqual(result.key, key); result.key.fill(0); result.salt.fill(0);
  assert.ok(f.deps.winapi.readBuffers.every(bytes => bytes.every(value => value === 0)));
  blob.write(rawBlob(Buffer.alloc(16, 1)));
  await assert.rejects(findDatabaseKey(f.options, f.deps), error => {
    assert.equal(error.details.contextKeyspecReads, 1); assert.equal(error.details.contextKeyspecMatches, 0);
    return error.code === 'E_DB_KEY_NOT_FOUND';
  });
});

test('binary context bad salt/key/null or noncanonical pointers never yield a candidate', async () => {
  for (const properties of [{ salt: Buffer.alloc(16, 8) }, { key: Buffer.alloc(32, 8) }, { saltPointer: 0 }, { cipherPointer: 0x800000000000n }, { keyPointer: 65536 + 8191 }, { deriveKey: 1 }]) {
    const f = binaryFixture('legacy', properties);
    await assert.rejects(findDatabaseKey(f.options, f.deps), codeIs('E_DB_KEY_NOT_FOUND'));
    assert.ok(f.deps.winapi.readBuffers.every(bytes => bytes.every(byte => byte === 0)));
    assert.equal(f.deps.winapi.calls.at(-1)[0], 'close');
  }
});

test('binary pointer reads require committed readable nonguard pages and share finite budgets', async () => {
  for (const properties of [{ protect: 0x102 }, { protect: 0x01 }, { state: 0x2000 }]) {
    const f = binaryFixture('current', { saltPointer: 131072 });
    const saltPage = Buffer.alloc(4096); salt.copy(saltPage);
    f.deps.winapi = mockReader([{ base: f.base, bytes: f.memory }, { base: 131072, bytes: saltPage, ...properties }]);
    await assert.rejects(findDatabaseKey(f.options, f.deps), codeIs('E_DB_KEY_NOT_FOUND'));
    assert.equal(f.deps.winapi.calls.some(call => call[0] === 'read' && call[1] === 131072n), false);
  }
  for (const limits of [{ maxPointerReads: 0 }, { maxContextCandidates: 0 }, { maxPointerReads: 2 }]) {
    const f = binaryFixture('legacy'); Object.assign(f.options, limits);
    await assert.rejects(findDatabaseKey(f.options, f.deps), codeIs('E_DB_KEY_NOT_FOUND'));
    assert.ok(f.deps.winapi.calls.filter(call => call[0] === 'read').reduce((sum, call) => sum + call[2], 0) <= f.options.maxMemoryBytes);
  }
});

test('Koffi adapter binds only five read APIs and decodes x64 MBI/UTF16 path', async () => {
  const signatures = [], invoked = [];
  const functions = {
    OpenProcess: (...args) => { invoked.push(args); return 12; },
    QueryFullProcessImageNameW: (_h, flags, buffer, size) => { assert.equal(flags, 0); buffer.write(expectedExePath, 'utf16le'); size[0] = expectedExePath.length; return 1; },
    VirtualQueryEx: (_h, _address, buffer, length) => { assert.equal(length, 48); buffer.writeBigUInt64LE(4096n, 0); buffer.writeBigUInt64LE(8192n, 24); buffer.writeUInt32LE(0x1000, 32); buffer.writeUInt32LE(4, 36); buffer.writeUInt32LE(0x20000, 40); return 48; },
    ReadProcessMemory: (_h, _address, buffer, length, count) => { buffer.fill(6); count[0] = length; return 1; },
    CloseHandle: () => 1
  };
  const api = await createWin32DatabaseKeyApi({ koffiImpl: { load: filename => { assert.equal(filename, 'C:\\Windows\\System32\\kernel32.dll'); return { func: signature => { signatures.push(signature); return functions[signature.match(/(?:__stdcall )([A-Za-z0-9]+)\(/)[1]]; } }; } }, systemRoot: 'C:\\Windows' });
  assert.equal(invoked.length, 0); api.openProcess(123); assert.deepEqual(invoked[0], [0x410, 0, 123]);
  assert.equal(api.imagePath(12), expectedExePath);
  assert.deepEqual(api.queryRegion(12, 4096n), { baseAddress: 4096n, regionSize: 8192n, state: 0x1000, protect: 4, type: 0x20000 });
  assert.equal(api.readMemory(12, 4096n, 128).bytesRead, 128); assert.equal(api.closeHandle(12), true);
  assert.equal(signatures.length, 5); assert.equal(signatures.some(value => /WriteProcessMemory|VirtualProtect|Thread|LoadLibrary/.test(value)), false);
});
