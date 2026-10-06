import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { doctor, discoverInstallation, classifyWeixinProcesses, DEFAULT_INSTALL_PATH } from '../src/doctor.mjs';

// Valid minimal PE image with no imported or exported symbols.
function emptyPe(machine = 0x8664) {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(240, 84);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt32LE(512, 148);
  bytes.writeUInt32LE(16, 196);
  return bytes;
}

test('default installation path points to Tencent Weixin', () => {
  assert.equal(DEFAULT_INSTALL_PATH, String.raw`C:\Program Files\Tencent\Weixin`);
});

test('reports missing installation and missing core files clearly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wxcc-doctor-missing-'));
  try {
    await assert.rejects(doctor({ installPath: path.join(directory, 'absent') }), { code: 'WEIXIN_INSTALL_NOT_FOUND' });
    await assert.rejects(doctor({ installPath: directory }), /Weixin.exe was not found/);
    await writeFile(path.join(directory, 'Weixin.exe'), emptyPe());
    await assert.rejects(doctor({ installPath: directory, inspectProcesses: false }), /No version directory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('selects versions numerically, hashes exact core files, and stays JSON serializable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wxcc doctor $()-'));
  try {
    const bytes = emptyPe();
    await writeFile(path.join(directory, 'Weixin.exe'), bytes);
    for (const version of ['4.1.9.1', '4.1.15.13', '9.0.0.0']) await mkdir(path.join(directory, version));
    for (const version of ['4.1.9.1', '4.1.15.13']) await writeFile(path.join(directory, version, 'Weixin.dll'), bytes);
    const result = await doctor({ installPath: directory, inspectProcesses: false });
    assert.equal(result.version, '4.1.15.13');
    assert.equal(result.architecture, 'x64');
    assert.equal(result.exe.path, path.join(directory, 'Weixin.exe'));
    assert.equal(result.dll.path, path.join(directory, '4.1.15.13', 'Weixin.dll'));
    assert.deepEqual(result.exports, []);
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    assert.deepEqual(result.hashes, { exe: expectedHash, dll: expectedHash });
    assert.deepEqual(result.processes, []);
    assert.equal(result.processInspectionAvailable, false);
    assert.equal(result.nodeVersion, process.versions.node);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    const compact = await doctor({ installPath: directory, includeHashes: false, includeExports: false, inspectProcesses: false });
    assert.equal('hashes' in compact, false);
    assert.equal('exports' in compact, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('surfaces malformed PE data instead of loading or executing it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wxcc-doctor-invalid-'));
  try {
    await mkdir(path.join(directory, '4.1.15.13'));
    await writeFile(path.join(directory, 'Weixin.exe'), 'not an executable');
    await writeFile(path.join(directory, '4.1.15.13', 'Weixin.dll'), emptyPe());
    await assert.rejects(doctor({ installPath: directory, inspectProcesses: false }), { code: 'INVALID_PE' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function discoveryFixture({ metadata = {}, env = {}, available = [], config } = {}) {
  const checked = [], queries = [];
  const valid = new Set(available.map(value => path.resolve(value).toLowerCase()));
  return { checked, queries, dependencies: {
    platform: 'win32', env,
    queryDiscoveryImpl: async () => { queries.push('metadata'); return metadata; },
    checkInstallationImpl: async value => { checked.push(value); return valid.has(value.toLowerCase()); },
    readConfigImpl: async () => { if (config) return config; throw Object.assign(new Error('missing config'), { code: 'ENOENT' }); },
  } };
}

test('explicit installation wins without querying running processes or registry', async () => {
  const directory = path.resolve('C:/mock/Explicit Weixin');
  const fx = discoveryFixture({ available: [directory] });
  const result = await discoverInstallation({ installPath: directory }, fx.dependencies);
  assert.equal(result.installPath, directory);
  assert.equal(result.source, 'explicit');
  assert.deepEqual(fx.queries, []);
  assert.deepEqual(fx.checked, [directory]);
  await assert.rejects(discoverInstallation({ installPath: 'C:/mock/missing' }, fx.dependencies), { code: 'WEIXIN_INSTALL_NOT_FOUND' });
});

test('discovery prioritizes environment, then running executable, then registry', async () => {
  const environment = path.resolve('C:/mock/Environment Weixin');
  const running = path.resolve('D:/mock/Running Weixin');
  const registry = path.resolve('E:/mock/Registry Weixin');
  const metadata = { processes: [{ pid: 111, parentPid: 10, path: path.join(running, 'Weixin.exe'), role: 'main' }], paths: [{ path: `"${path.join(registry, 'Weixin.exe')}",0`, source: 'registry-app-paths' }] };
  for (const [available, expected, source] of [
    [[environment, running, registry], environment, 'environment'], [[running, registry], running, 'running-process'], [[registry], registry, 'registry-app-paths'],
  ]) {
    const fx = discoveryFixture({ metadata, env: { WXCC_WEIXIN_PATH: environment }, available });
    const result = await discoverInstallation({}, fx.dependencies);
    assert.equal(result.installPath, expected);
    assert.equal(result.source, source);
  }
});

test('multiple live installations require an explicit PID and paths remain literal', async () => {
  const first = path.resolve('C:/mock/Weixin $() one');
  const second = path.resolve('D:/mock/Weixin two');
  const fx = discoveryFixture({ available: [first, second], metadata: { processes: [
    { pid: 111, parentPid: 10, path: path.join(first, 'Weixin.exe'), role: 'main' },
    { pid: 222, parentPid: 10, path: path.join(second, 'Weixin.exe'), role: 'main' },
  ] } });
  await assert.rejects(discoverInstallation({}, fx.dependencies), { code: 'WEIXIN_INSTALL_AMBIGUOUS' });
  const chosen = await discoverInstallation({ pid: 222 }, fx.dependencies);
  assert.equal(chosen.installPath, second);
  assert.equal(fx.checked.includes(first), true);
});

test('ProgramFiles and user configuration are static fallback candidates', async () => {
  const programRoot = path.resolve('D:/mock/Programs');
  const fallback = path.join(programRoot, 'Tencent', 'Weixin');
  const configured = path.resolve('E:/mock/Configured Weixin');
  const fx = discoveryFixture({ env: { ProgramFiles: programRoot, WXCC_CONFIG: 'C:/mock/config.json' }, available: [configured], config: { installPath: configured, token: 'never-return-this-field' } });
  const result = await discoverInstallation({}, fx.dependencies);
  assert.equal(result.installPath, configured);
  assert.equal(result.source, 'user-config');
  assert.equal(fx.checked.includes(fallback), true);
  assert.equal(JSON.stringify(result).includes('never-return-this-field'), false);
});

test('process roles retain parent metadata and never infer a main role from absent evidence', () => {
  const result = classifyWeixinProcesses([
    { pid: 111, parentPid: 10, path: 'C:/mock/Weixin.exe', role: 'main', roleEvidence: 'verified-parent' },
    { pid: 222, parentPid: 111, path: 'C:/mock/Weixin.exe', role: 'main' },
    { pid: 333, parentPid: 999, path: 'C:/mock/Weixin.exe' },
  ]);
  assert.deepEqual(result.map(row => [row.pid, row.parentPid, row.role, row.main]), [[111, 10, 'main', true], [222, 111, 'child', false], [333, 999, 'unknown', false]]);
});

test('doctor accepts fake Windows metadata and includes explicit main/child roles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wxcc-doctor-metadata-'));
  try {
    await writeFile(path.join(directory, 'Weixin.exe'), emptyPe());
    await mkdir(path.join(directory, '4.1.15.13'));
    await writeFile(path.join(directory, '4.1.15.13', 'Weixin.dll'), emptyPe());
    const exe = path.join(directory, 'Weixin.exe');
    const result = await doctor({ installPath: directory }, { platform: 'win32', queryWindowsImpl: async (file, inspect) => {
      assert.equal(file, exe); assert.equal(inspect, true);
      return { fileVersion: '4.1.15.13', processes: [{ pid: 111, parentPid: 10, path: exe, role: 'main' }, { pid: 222, parentPid: 111, path: exe, role: 'child' }], processError: null };
    } });
    assert.equal(result.processInspectionAvailable, true);
    assert.deepEqual(result.processes.map(row => row.role), ['main', 'child']);
    assert.equal(result.discovery.source, 'explicit');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a version-directory executable with a directly adjacent DLL is supported by static discovery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wxcc-doctor-layout-'));
  try {
    const versioned = path.join(directory, '4.1.15.13');
    await mkdir(versioned);
    await writeFile(path.join(versioned, 'Weixin.exe'), emptyPe());
    await writeFile(path.join(versioned, 'Weixin.dll'), emptyPe());
    const result = await doctor({ installPath: versioned, inspectProcesses: false }, { platform: 'win32', queryWindowsImpl: async () => ({ fileVersion: '4.1.15.13', processes: [] }) });
    assert.equal(result.version, '4.1.15.13');
    assert.equal(result.dll.path, path.join(versioned, 'Weixin.dll'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
