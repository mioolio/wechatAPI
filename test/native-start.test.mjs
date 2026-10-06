import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { startNativeRead } from '../src/native-start.mjs';
import { NATIVE_READ_SCRIPT } from '../src/native-read-adapter.mjs';

const generation = '10000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(64);
const source = '// Mock read agent. No native process is accessed.\n';
const sourceSha256 = createHash('sha256').update(source).digest('hex');

async function fixture(changes = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'wxcc-native-start-'));
  await mkdir(join(workspace, 'profiles'));
  await mkdir(join(workspace, 'agents'));
  await writeFile(join(workspace, 'profiles/4.1.15.13.json'), JSON.stringify({ version: '4.1.15.13', architecture: 'x64', dllSha256: sha, ...changes.profile }));
  await writeFile(join(workspace, 'agents/read-native.js'), source);
  const tokenFile = join(workspace, 'data/native-read-host.json');
  const descriptor = { host: '127.0.0.1', port: 5001, token: 'b'.repeat(64), hostPid: 9999, pid: 1234, generation, version: '4.1.15.13', dllSha256: sha, ...changes.descriptor };
  const host = { pid: 1234, generation, version: '4.1.15.13', dllSha256: sha, status: 'ready', attached: true, verified: true, scripts: [{ name: NATIVE_READ_SCRIPT, loaded: true, destroyed: false, sourceSha256 }], ...changes.host };
  const runtime = { ...host, ready: true, accountVerified: true, readScopeVerified: true, historyAvailable: true, pendingTasks: 0, pendingCallbacks: 0, automaticMessagesSent: 0, self: 'fixture_self', displayName: 'Fixture Account', ...changes.runtime };
  const info = { installPath: 'C:/mock/Weixin', version: '4.1.15.13', architecture: 'x64', exe: { path: 'C:/mock/Weixin/Weixin.exe' }, hashes: { dll: sha }, processInspectionAvailable: true, processes: [{ pid: 1234, parentPid: 10, path: 'C:/mock/Weixin/Weixin.exe', role: 'main' }, { pid: 2345, parentPid: 1234, path: 'C:/mock/Weixin/Weixin.exe', role: 'child' }], diagnostics: [], ...changes.info };
  const calls = [];
  let now = 0;
  async function saveDescriptor() { await mkdir(join(workspace, 'data'), { recursive: true }); await writeFile(tokenFile, JSON.stringify(descriptor)); }
  if (changes.existing) await saveDescriptor();
  const dependencies = {
    platform: 'win32', arch: 'x64', nodeVersion: '24.1.0', execPath: 'C:/mock/node.exe',
    nowImpl: () => now, sleepImpl: async ms => { now += ms; },
    doctorImpl: async options => { calls.push(['doctor', options]); return info; },
    processAliveImpl: changes.processAliveImpl ?? (async () => true),
    probePortImpl: async () => changes.portState ?? 'listening',
    callImpl: async request => { calls.push(['status', request]); if (changes.statusCall) return changes.statusCall(request); if (changes.statusError) throw Object.assign(new Error('Mock host unavailable.'), { code: changes.statusError }); return { success: true, result: host }; },
    adapterFactory: () => ({ inspect: async () => { calls.push(['inspect']); if (changes.inspectError) throw Object.assign(new Error('Mock busy.'), { code: changes.inspectError }); return runtime; }, close: async () => { calls.push(['close']); } }),
    bootstrapImpl: async options => { calls.push(['bootstrap', options]); if (changes.bootstrapError) throw Object.assign(new Error('Mock business timeout.'), { code: changes.bootstrapError }); return runtime; },
    spawnHostImpl: async request => { calls.push(['spawn', request]); if (changes.spawn) return changes.spawn(request, { saveDescriptor, descriptor, host, runtime }); if (!changes.noDescriptor) await saveDescriptor(); return { pid: 9999 }; },
  };
  async function cleanup() { if (!resolve(workspace).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Refusing cleanup outside mock temporary directory'); await rm(workspace, { recursive: true, force: true }); }
  return { workspace, tokenFile, descriptor, host, runtime, info, dependencies, calls, saveDescriptor, cleanup };
}
const count = (fx, method) => fx.calls.filter(row => row[0] === method).length;

test('one verified main process automatically starts one detached hidden read host with literal arguments', async () => {
  const fx = await fixture();
  try {
    const result = await startNativeRead({ workspace: fx.workspace }, fx.dependencies);
    assert.equal(result.ready, true); assert.equal(result.reused, false); assert.equal(result.pid, 1234);
    assert.equal(result.automaticMessagesSent, 0);
    assert.equal(JSON.stringify(result).includes('fixture_self'), false);
    assert.equal(JSON.stringify(result).includes(fx.descriptor.token), false);
    const launch = fx.calls.find(row => row[0] === 'spawn')[1];
    assert.equal(launch.execPath, 'C:/mock/node.exe');
    assert.deepEqual(launch.args, [join(fx.workspace, 'src/native-runtime-host.mjs'), '--pid', '1234', '--read', '--token-file', fx.tokenFile, '--profile', join(fx.workspace, 'profiles/4.1.15.13.json'), '--install-path', 'C:/mock/Weixin']);
    assert.equal(launch.options.detached, true); assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.stdio[0], 'ignore'); assert.equal(Number.isInteger(launch.options.stdio[1]), true);
    assert.equal(launch.options.stdio[1], launch.options.stdio[2]);
    assert.equal(launch.args.includes('--send'), false);
    assert.equal(count(fx, 'spawn'), 1); assert.equal(count(fx, 'bootstrap'), 0);
    await assert.rejects(access(`${fx.tokenFile}.start.lock`), { code: 'ENOENT' });
  } finally { await fx.cleanup(); }
});

test('a ready matching read host is bootstrapped and reused without another attach or spawn', async () => {
  const fx = await fixture({ existing: true });
  try {
    const result = await startNativeRead({ workspace: fx.workspace }, fx.dependencies);
    assert.equal(result.reused, true); assert.equal(count(fx, 'spawn'), 0); assert.equal(count(fx, 'bootstrap'), 1);
    assert.equal(JSON.parse(await readFile(fx.tokenFile, 'utf8')).generation, generation);
  } finally { await fx.cleanup(); }
});

test('unsupported platform, Node version, ABI version or DLL hash never launches a host', async () => {
  for (const changes of [{ platform: 'linux' }, { arch: 'arm64' }, { nodeVersion: '22.1.0' }]) {
    const fx = await fixture();
    try { await assert.rejects(startNativeRead({ workspace: fx.workspace }, { ...fx.dependencies, ...changes }), { code: 'E_NATIVE_PLATFORM' }); assert.equal(count(fx, 'doctor'), 0); assert.equal(count(fx, 'spawn'), 0); }
    finally { await fx.cleanup(); }
  }
  for (const changes of [{ info: { version: '4.2.0.1' } }, { profile: { dllSha256: 'c'.repeat(64) } }, { info: { architecture: 'arm64' } }]) {
    const fx = await fixture(changes);
    try { await assert.rejects(startNativeRead({ workspace: fx.workspace }, fx.dependencies)); assert.equal(count(fx, 'spawn'), 0); assert.equal(count(fx, 'status'), 0); }
    finally { await fx.cleanup(); }
  }
});

test('multiple main processes or unknown roles require PID and child PID is never selected', async () => {
  const fx = await fixture();
  try {
    fx.info.processes.push({ pid: 3456, parentPid: 10, path: fx.info.exe.path, role: 'main' });
    await assert.rejects(startNativeRead({ workspace: fx.workspace }, fx.dependencies), { code: 'E_NATIVE_PID_REQUIRED' });
    await assert.rejects(startNativeRead({ workspace: fx.workspace, pid: 2345 }, fx.dependencies), { code: 'E_NATIVE_PID_UNVERIFIED' });
    assert.equal(count(fx, 'spawn'), 0);
    fx.info.processes = [{ pid: 1234, parentPid: null, path: fx.info.exe.path, role: 'unknown' }];
    await assert.rejects(startNativeRead({ workspace: fx.workspace }, fx.dependencies), { code: 'E_NATIVE_PID_REQUIRED' });
    assert.equal((await startNativeRead({ workspace: fx.workspace, pid: 1234 }, fx.dependencies)).pid, 1234);
  } finally { await fx.cleanup(); }
});

test('missing client or unavailable process inspection causes no spawn or client restart', async () => {
  for (const info of [{ processes: [] }, { processInspectionAvailable: false }]) {
    const fx = await fixture({ info });
    try { await assert.rejects(startNativeRead({ workspace: fx.workspace }, fx.dependencies)); assert.equal(count(fx, 'spawn'), 0); }
    finally { await fx.cleanup(); }
  }
});

test('ready host source mismatch, wrong target, unready state or read busy never replaces the descriptor', async () => {
  for (const changes of [
    { host: { scripts: [{ name: NATIVE_READ_SCRIPT, loaded: true, destroyed: false, sourceSha256: 'c'.repeat(64) }] } },
    { host: { status: 'attached-error' } }, { host: { pid: 5678 } }, { inspectError: 'E_NATIVE_READ_BUSY' },
    { runtime: { generation: '10000000-0000-4000-8000-000000000002' } },
  ]) {
    const fx = await fixture({ existing: true, ...changes });
    try { const original = await readFile(fx.tokenFile, 'utf8'); await assert.rejects(startNativeRead({ workspace: fx.workspace }, fx.dependencies)); assert.equal(await readFile(fx.tokenFile, 'utf8'), original); assert.equal(count(fx, 'spawn'), 0); assert.equal(count(fx, 'bootstrap'), 0); }
    finally { await fx.cleanup(); }
  }
});

test('a transport error is not enough to archive a descriptor when the host is alive or liveness is unknown', async () => {
  for (const alive of [true, null]) {
    const fx = await fixture({ existing: true, statusError: 'E_TRANSPORT_UNKNOWN', portState: 'refused', processAliveImpl: async () => alive });
    try { const original = await readFile(fx.tokenFile, 'utf8'); await assert.rejects(startNativeRead({ workspace: fx.workspace }, fx.dependencies), { code: 'E_TRANSPORT_UNKNOWN' }); assert.equal(await readFile(fx.tokenFile, 'utf8'), original); assert.equal(count(fx, 'spawn'), 0); }
    finally { await fx.cleanup(); }
  }
});

test('only refused port plus proven dead host archives the old descriptor before one fresh startup', async () => {
  let statusCalls = 0;
  const fx = await fixture({ existing: true, portState: 'refused', processAliveImpl: async () => false, statusCall: async () => { if (++statusCalls === 1) throw Object.assign(new Error('Offline.'), { code: 'E_TRANSPORT_UNKNOWN' }); return { success: true, result: fx.host }; } });
  try {
    const result = await startNativeRead({ workspace: fx.workspace }, fx.dependencies);
    assert.equal(result.archivedDescriptor, true); assert.equal(result.reused, false); assert.equal(count(fx, 'spawn'), 1);
    const names = await readdir(join(fx.workspace, 'data'));
    assert.equal(names.filter(name => /^native-read-host\.offline-/.test(name)).length, 1);
    assert.equal(JSON.stringify(result).includes(fx.descriptor.token), false);
  } finally { await fx.cleanup(); }
});

test('a bootstrap business timeout never archives or restarts even if the old host later appears offline', async () => {
  const fx = await fixture({ existing: true, bootstrapError: 'E_TIMEOUT_UNKNOWN', portState: 'refused', processAliveImpl: async () => false });
  try { await assert.rejects(startNativeRead({ workspace: fx.workspace }, fx.dependencies), { code: 'E_TIMEOUT_UNKNOWN' }); assert.equal(count(fx, 'spawn'), 0); assert.equal(count(fx, 'bootstrap'), 1); assert.equal((await readdir(join(fx.workspace, 'data'))).some(name => name.includes('.offline-')), false); }
  finally { await fx.cleanup(); }
});

test('metadata status can be polled after a new launch timeout without repeating any native business call', async () => {
  let reads = 0;
  const fx = await fixture({ statusCall: async () => { if (++reads === 1) throw Object.assign(new Error('Startup is pending.'), { code: 'E_TRANSPORT_UNKNOWN' }); return { success: true, result: fx.host }; } });
  try { assert.equal((await startNativeRead({ workspace: fx.workspace, timeoutMs: 3000 }, fx.dependencies)).ready, true); assert.equal(count(fx, 'spawn'), 1); assert.equal(count(fx, 'bootstrap'), 0); }
  finally { await fx.cleanup(); }
});

test('startup timeout before descriptor creation keeps child PID reservation to prevent another attach', async () => {
  const fx = await fixture({ noDescriptor: true });
  try {
    await assert.rejects(startNativeRead({ workspace: fx.workspace, timeoutMs: 1000 }, fx.dependencies), { code: 'E_NATIVE_START_TIMEOUT' });
    const lock = JSON.parse(await readFile(`${fx.tokenFile}.start.lock`, 'utf8'));
    assert.equal(lock.childPid, 9999); assert.equal(JSON.stringify(lock).includes(fx.descriptor.token), false);
    await assert.rejects(startNativeRead({ workspace: fx.workspace, timeoutMs: 1000 }, fx.dependencies), { code: 'E_NATIVE_START_BUSY' });
    assert.equal(count(fx, 'spawn'), 1);
  } finally { await fx.cleanup(); }
});

test('concurrent CLI startup is protected by a single lock and launches only one host', async () => {
  let entered, release;
  const enteredPromise = new Promise(resolveEntered => { entered = resolveEntered; });
  const releasePromise = new Promise(resolveRelease => { release = resolveRelease; });
  const fx = await fixture({ spawn: async (_request, state) => { entered(); await releasePromise; await state.saveDescriptor(); return { pid: 9999 }; } });
  try {
    const first = startNativeRead({ workspace: fx.workspace }, fx.dependencies);
    await enteredPromise;
    await assert.rejects(startNativeRead({ workspace: fx.workspace }, fx.dependencies), { code: 'E_NATIVE_START_BUSY' });
    release(); assert.equal((await first).ready, true); assert.equal(count(fx, 'spawn'), 1);
  } finally { release?.(); await fx.cleanup(); }
});

test('a stale lock with an unproven child is retained rather than causing a second attach', async () => {
  const fx = await fixture();
  try {
    await mkdir(join(fx.workspace, 'data'), { recursive: true });
    await writeFile(`${fx.tokenFile}.start.lock`, JSON.stringify({ pid: 7777, childPid: 9999, nonce: generation }));
    fx.dependencies.processAliveImpl = async pid => pid === 7777 ? false : true;
    await assert.rejects(startNativeRead({ workspace: fx.workspace }, fx.dependencies), { code: 'E_NATIVE_START_BUSY' });
    assert.equal(count(fx, 'spawn'), 0);
  } finally { await fx.cleanup(); }
});
