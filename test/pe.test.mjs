import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePe, inspectPe, PeFormatError } from '../src/pe.mjs';

// A small independently assembled PE with a real named import, ordinal import,
// named export, and forwarded export. RVAs use one section at 0x1000.
function fixture() {
  const bytes = Buffer.alloc(0x800);
  bytes.write('MZ');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt32LE(0x200, 0xd4);
  bytes.writeUInt32LE(16, 0x104);
  bytes.writeUInt32LE(0x1000, 0x108);
  bytes.writeUInt32LE(0x100, 0x10c);
  bytes.writeUInt32LE(0x1100, 0x110);
  bytes.writeUInt32LE(0x40, 0x114);
  bytes.write('.rdata', 0x188);
  bytes.writeUInt32LE(0x800, 0x190);
  bytes.writeUInt32LE(0x1000, 0x194);
  bytes.writeUInt32LE(0x600, 0x198);
  bytes.writeUInt32LE(0x200, 0x19c);
  bytes.writeUInt32LE(3, 0x210); // Export ordinal base.
  bytes.writeUInt32LE(2, 0x214);
  bytes.writeUInt32LE(2, 0x218);
  bytes.writeUInt32LE(0x1040, 0x21c);
  bytes.writeUInt32LE(0x1050, 0x220);
  bytes.writeUInt32LE(0x1058, 0x224);
  bytes.writeUInt32LE(0x1400, 0x240);
  bytes.writeUInt32LE(0x1080, 0x244);
  bytes.writeUInt32LE(0x1070, 0x250);
  bytes.writeUInt32LE(0x1078, 0x254);
  bytes.writeUInt16LE(0, 0x258);
  bytes.writeUInt16LE(1, 0x25a);
  bytes.write('Alpha\0', 0x270);
  bytes.write('Beta\0', 0x278);
  bytes.write('NTDLL.RtlExitUserProcess\0', 0x280);
  bytes.writeUInt32LE(0x1150, 0x300);
  bytes.writeUInt32LE(0x1140, 0x30c);
  bytes.writeUInt32LE(0x1180, 0x310);
  bytes.write('KERNEL32.dll\0', 0x340);
  bytes.writeBigUInt64LE(0x1190n, 0x350);
  bytes.writeBigUInt64LE(0x8000_0000_0000_0007n, 0x358);
  bytes.writeUInt16LE(12, 0x390);
  bytes.write('GetTickCount\0', 0x392);
  return bytes;
}

test('reads named and ordinal imports, export addresses, and forwarders', () => {
  const parsed = parsePe(fixture());
  assert.equal(parsed.architecture, 'x64');
  assert.equal(parsed.bitness, 64);
  assert.deepEqual(parsed.imports, [{ dll: 'KERNEL32.dll', functions: [{ name: 'GetTickCount', hint: 12 }, { ordinal: 7 }] }]);
  assert.deepEqual(parsed.exports, [
    { name: 'Alpha', ordinal: 3, rva: 0x1400, forwarder: null },
    { name: 'Beta', ordinal: 4, rva: 0x1080, forwarder: 'NTDLL.RtlExitUserProcess' },
  ]);
});

test('retains aliases and includes exports that have no names', () => {
  const bytes = fixture();
  bytes.writeUInt16LE(0, 0x25a);
  const entries = parsePe(bytes).exports;
  assert.deepEqual(entries.map(({ name, ordinal }) => ({ name, ordinal })), [
    { name: 'Alpha', ordinal: 3 }, { name: 'Beta', ordinal: 3 }, { name: null, ordinal: 4 },
  ]);
});

test('rejects truncations with a controlled format error, never an out-of-range read', () => {
  const bytes = fixture();
  for (const length of [0, 1, 2, 59, 63, 127, 151, 200, 391, 415, 511, 512, 1000, 2047]) {
    assert.throws(() => parsePe(bytes.subarray(0, length)), PeFormatError, `length ${length}`);
  }
});

test('rejects invalid counts, ordinal indices, and unmapped or virtual-only data', () => {
  const mutations = [
    [0x218, 0xffff_ffff], // Huge name count.
    [0x250, 0xffff_fff0], // Name RVA outside all sections.
    [0x250, 0x1700], // Virtual section tail, no corresponding file bytes.
    [0x198, 0x10000], // Raw section exceeds file.
    [0x104, 17], // Directory count exceeds optional header.
  ];
  for (const [offset, value] of mutations) {
    const bytes = fixture();
    bytes.writeUInt32LE(value, offset);
    assert.throws(() => parsePe(bytes), PeFormatError, `offset ${offset}`);
  }
  const invalidOrdinal = fixture();
  invalidOrdinal.writeUInt16LE(2, 0x25a);
  assert.throws(() => parsePe(invalidOrdinal), /ordinal index/);
});

test('strings and descriptor tables cannot read beyond their declared boundaries', () => {
  const bytes = fixture();
  bytes.writeUInt32LE(0x10ff, 0x244);
  bytes[0x2ff] = 65;
  assert.throws(() => parsePe(bytes), /forwarder.*terminated/);
  const descriptors = fixture();
  descriptors.writeUInt32LE(20, 0x114);
  assert.throws(() => parsePe(descriptors), /unterminated import descriptor/);
  const hugeName = fixture();
  hugeName.writeBigUInt64LE(0x1_0000_0000n, 0x350);
  assert.throws(() => parsePe(hugeName), /import name RVA overflows/);
});

test('file reader enforces size limit and returns no executable handles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wxcc-pe-test-'));
  try {
    const file = path.join(directory, 'fixture.dll');
    await writeFile(file, fixture());
    assert.equal((await inspectPe(file)).exports.length, 2);
    await assert.rejects(inspectPe(file, { maxBytes: 1000 }), /size limit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
