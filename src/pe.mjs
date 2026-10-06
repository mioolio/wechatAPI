import { open } from 'node:fs/promises';

const MAX_TABLE_ENTRIES = 262_144;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

export class PeFormatError extends Error {
  constructor(message) {
    super(`Invalid PE file: ${message}`);
    this.name = 'PeFormatError';
    this.code = 'INVALID_PE';
  }
}

/** Parse PE data without executing or loading the image. All offsets are checked. */
export function parsePe(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const fail = (message) => { throw new PeFormatError(message); };
  const range = (offset, length, label) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > bytes.length - length) {
      fail(`${label} is outside the file`);
    }
    return offset;
  };
  const u16 = (offset, label = '16-bit field') => bytes.readUInt16LE(range(offset, 2, label));
  const u32 = (offset, label = '32-bit field') => bytes.readUInt32LE(range(offset, 4, label));
  if (u16(0, 'DOS signature') !== 0x5a4d) fail('missing MZ signature');
  const peOffset = u32(0x3c, 'PE header offset');
  if (u32(peOffset, 'PE signature') !== 0x00004550) fail('missing PE signature');
  const coff = peOffset + 4;
  range(coff, 20, 'COFF header');
  const machine = u16(coff);
  const sectionCount = u16(coff + 2);
  if (sectionCount > 4096) fail('too many sections');
  const optionalSize = u16(coff + 16);
  const optional = coff + 20;
  range(optional, optionalSize, 'optional header');
  const magic = u16(optional, 'optional header magic');
  const bitness = magic === 0x20b ? 64 : magic === 0x10b ? 32 : 0;
  if (!bitness) fail('unsupported optional header format');
  const directoryOffset = bitness === 64 ? 112 : 96;
  if (optionalSize < directoryOffset) fail('truncated optional header');
  const sizeOfHeaders = u32(optional + 60);
  if (sizeOfHeaders > bytes.length) fail('header size exceeds the file');
  const directoryCount = u32(optional + directoryOffset - 4);
  const availableDirectories = Math.floor((optionalSize - directoryOffset) / 8);
  if (directoryCount > availableDirectories) fail('data directories exceed optional header');
  const architecture = ({ 0x8664: 'x64', 0x14c: 'x86', 0xaa64: 'arm64' })[machine] ?? 'unknown';
  const sections = [];
  const sectionTable = optional + optionalSize;
  range(sectionTable, sectionCount * 40, 'section table');
  for (let index = 0; index < sectionCount; index += 1) {
    const at = sectionTable + index * 40;
    const section = {
      name: bytes.subarray(at, at + 8).toString('ascii').replace(/\0.*$/s, ''),
      virtualSize: u32(at + 8),
      virtualAddress: u32(at + 12),
      rawSize: u32(at + 16),
      rawOffset: u32(at + 20),
    };
    range(section.rawOffset, section.rawSize, `section ${section.name}`);
    if (section.virtualAddress + Math.max(section.virtualSize, section.rawSize) > 0x1_0000_0000) fail('section RVA overflows');
    sections.push(section);
  }
  const locate = (rva, length = 1, label = 'RVA') => {
    if (!Number.isSafeInteger(rva) || rva < 0 || rva > 0xffff_ffff || rva + length > 0x1_0000_0000) fail(`${label} overflows`);
    if (rva < sizeOfHeaders) {
      if (length > sizeOfHeaders - rva) fail(`${label} crosses the header boundary`);
      return { offset: range(rva, length, label), available: sizeOfHeaders - rva };
    }
    const matches = sections.filter((section) => rva >= section.virtualAddress && rva - section.virtualAddress < Math.max(section.virtualSize, section.rawSize));
    if (matches.length !== 1) fail(`${label} is unmapped or ambiguous`);
    const section = matches[0];
    const delta = rva - section.virtualAddress;
    if (delta > section.rawSize || length > section.rawSize - delta) fail(`${label} has no file-backed data`);
    return { offset: range(section.rawOffset + delta, length, label), available: section.rawSize - delta };
  };
  const r16 = (rva, label) => u16(locate(rva, 2, label).offset, label);
  const r32 = (rva, label) => u32(locate(rva, 4, label).offset, label);
  let totalStringBytes = 0;
  const string = (rva, label, maxLength = 4096) => {
    const mapped = locate(rva, 1, label);
    const end = mapped.offset + Math.min(mapped.available, maxLength);
    const relativeZero = bytes.subarray(mapped.offset, end).indexOf(0);
    if (relativeZero < 0) fail(`${label} is not terminated within its boundary`);
    const zero = mapped.offset + relativeZero;
    totalStringBytes += relativeZero;
    if (totalStringBytes > 16 * 1024 * 1024) fail('metadata strings exceed size limit');
    return bytes.toString('utf8', mapped.offset, zero);
  };
  const directory = (index) => {
    if (index >= directoryCount) return null;
    const at = optional + directoryOffset + index * 8;
    const rva = u32(at);
    const size = u32(at + 4);
    if (!rva && !size) return null;
    if (!rva || !size || rva + size > 0x1_0000_0000) fail('invalid data directory range');
    locate(rva, size, 'data directory');
    return { rva, size };
  };
  const exports = [];
  const exportDirectory = directory(0);
  if (exportDirectory) {
    const { rva, size } = exportDirectory;
    if (size < 40) fail('truncated export directory');
    const ordinalBase = r32(rva + 16);
    const functionCount = r32(rva + 20);
    const nameCount = r32(rva + 24);
    if (functionCount > MAX_TABLE_ENTRIES || nameCount > MAX_TABLE_ENTRIES) fail('export table exceeds entry limit');
    const functionTable = r32(rva + 28);
    const nameTable = r32(rva + 32);
    const ordinalTable = r32(rva + 36);
    if (functionCount) locate(functionTable, functionCount * 4, 'export address table');
    if (nameCount) {
      locate(nameTable, nameCount * 4, 'export name table');
      locate(ordinalTable, nameCount * 2, 'export ordinal table');
    }
    const named = new Set();
    const addExport = (index, name) => {
      const address = r32(functionTable + index * 4, 'export RVA');
      const ordinal = ordinalBase + index;
      if (ordinal > 0xffff_ffff) fail('export ordinal overflows');
      const forwarder = address >= rva && address < rva + size
        ? string(address, 'export forwarder', Math.min(4096, rva + size - address)) : null;
      exports.push({ name, ordinal, rva: address, forwarder });
    };
    for (let index = 0; index < nameCount; index += 1) {
      const functionIndex = r16(ordinalTable + index * 2, 'export ordinal index');
      if (functionIndex >= functionCount) fail('export ordinal index exceeds address table');
      named.add(functionIndex);
      addExport(functionIndex, string(r32(nameTable + index * 4), 'export name'));
    }
    for (let index = 0; index < functionCount; index += 1) {
      if (!named.has(index) && r32(functionTable + index * 4)) addExport(index, null);
    }
  }
  const imports = [];
  const importDirectory = directory(1);
  let totalImports = 0;
  if (importDirectory) {
    const { rva, size } = importDirectory;
    const descriptorLimit = Math.min(Math.floor(size / 20), 4096);
    let terminated = false;
    for (let index = 0; index < descriptorLimit; index += 1) {
      const at = rva + index * 20;
      const fields = Array.from({ length: 5 }, (_, field) => r32(at + field * 4, 'import descriptor'));
      if (fields.every((value) => value === 0)) { terminated = true; break; }
      const [originalThunk, , , nameRva, firstThunk] = fields;
      const thunk = originalThunk || firstThunk;
      if (!nameRva || !thunk) fail('incomplete import descriptor');
      const dll = string(nameRva, 'import DLL name');
      const step = bitness / 8;
      const mapped = locate(thunk, step, 'import thunk table');
      const limit = Math.min(Math.floor(mapped.available / step), MAX_TABLE_ENTRIES);
      const functions = [];
      let thunkTerminated = false;
      for (let entry = 0; entry < limit; entry += 1) {
        const offset = mapped.offset + entry * step;
        const value = bitness === 64 ? bytes.readBigUInt64LE(offset) : BigInt(u32(offset));
        if (!value) { thunkTerminated = true; break; }
        if (++totalImports > MAX_TABLE_ENTRIES) fail('import table exceeds entry limit');
        const ordinalFlag = bitness === 64 ? 0x8000_0000_0000_0000n : 0x8000_0000n;
        if (value & ordinalFlag) {
          if ((value & ~ordinalFlag) > 0xffffn) fail('invalid ordinal import');
          functions.push({ ordinal: Number(value & 0xffffn) });
        } else {
          if (value > 0xffff_ffffn) fail('import name RVA overflows');
          const name = Number(value);
          const hint = r16(name, 'import hint');
          functions.push({ name: string(name + 2, 'import name'), hint });
        }
      }
      if (!thunkTerminated) fail('unterminated import thunk table');
      imports.push({ dll, functions });
    }
    if (!terminated) fail('unterminated import descriptor table');
  }
  return { architecture, machine, bitness, sections, imports, exports };
}

/** Read a bounded file into memory; this does not call LoadLibrary. */
export async function inspectPe(filePath, { maxBytes = MAX_FILE_BYTES } = {}) {
  const handle = await open(filePath, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new PeFormatError('path is not a regular file');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || metadata.size > maxBytes) throw new PeFormatError('file exceeds size limit');
    const bytes = Buffer.alloc(metadata.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) throw new PeFormatError('file changed or was truncated while reading');
      position += bytesRead;
    }
    return parsePe(bytes);
  } finally {
    await handle.close();
  }
}
