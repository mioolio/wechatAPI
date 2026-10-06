import { open, mkdir, readFile, stat, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { doctor } from './doctor.mjs';
import { NativeReadAdapter, NATIVE_READ_SCRIPT } from './native-read-adapter.mjs';
import { bootstrapNativeRead } from './native-read-bootstrap.mjs';
import { callPersistentHost } from './native-runtime-client.mjs';
import { WxError } from './errors.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
export const SUPPORTED_NATIVE_READ_VERSIONS = Object.freeze(['4.1.15.13']);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const sameHash = (left, right) => hash(left) && hash(right) && left.toLowerCase() === right.toLowerCase();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const fail = (code, message, details) => new WxError(code, message, details);
const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' && resolve(left).toLowerCase() === resolve(right).toLowerCase();

async function readJson(path) {
  if ((await stat(path)).size > 65536) throw fail('E_NATIVE_CONFIG', '本机宿主配置文件过大。');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function readAgentSource(path) {
  if ((await stat(path)).size > 1024 * 1024) throw fail('E_NATIVE_READ_SOURCE', '原生读取 agent 源码超过 1 MiB。');
  return readFile(path, 'utf8');
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : error.code === 'EPERM' ? true : null; }
}
async function probePort({ port, timeoutMs = 750 }) {
  return new Promise(resolveProbe => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let finished = false;
    const done = state => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); resolveProbe(state); };
    const timer = setTimeout(() => done('unknown'), timeoutMs);
    socket.once('connect', () => done('listening'));
    socket.once('error', error => done(error.code === 'ECONNREFUSED' ? 'refused' : 'unknown'));
  });
}
async function launchHost({ execPath, args, options }) {
  const child = spawn(execPath, args, options);
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  child.unref();
  return { pid: child.pid };
}
function descriptorValid(descriptor) {
  return descriptor && descriptor.host === '127.0.0.1' && Number.isInteger(descriptor.port) && descriptor.port > 0 && descriptor.port <= 65535 && hash(descriptor.token) && Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0 && Number.isSafeInteger(descriptor.hostPid) && descriptor.hostPid > 0 && uuid(descriptor.generation) && /^\d+\.\d+\.\d+\.\d+$/.test(descriptor.version ?? '') && hash(descriptor.dllSha256);
}

/** Discover and start only the read host. Weixin is never started, stopped or restarted here. */
export async function startNativeRead(options = {}, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.arch ?? process.arch;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  if (platform !== 'win32' || architecture !== 'x64' || !/^\d+\./.test(nodeVersion) || Number(nodeVersion.split('.')[0]) < 24) throw fail('E_NATIVE_PLATFORM', '原生读取启动需要 Windows x64 与 Node.js 24 或更高版本。');
  const timeoutMs = options.timeoutMs ?? options.timeout ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw fail('E_ARGUMENT', '启动 timeout 必须为 1000 至 180000 毫秒。');
  const workspace = resolve(options.workspace ?? WORKSPACE);
  const tokenFile = resolve(options.tokenFile ?? options['token-file'] ?? resolve(workspace, 'data/native-read-host.json'));
  const lockFile = `${tokenFile}.start.lock`;
  const logFile = resolve(workspace, 'data/native-read-host.log');
  const read = dependencies.readJsonImpl ?? readJson;
  const isAlive = dependencies.processAliveImpl ?? processAlive;
  const portProbe = dependencies.probePortImpl ?? probePort;
  const call = dependencies.callImpl ?? callPersistentHost;
  const bootstrap = dependencies.bootstrapImpl ?? bootstrapNativeRead;
  const clock = dependencies.nowImpl ?? Date.now;
  const sleep = dependencies.sleepImpl ?? (milliseconds => delay(milliseconds));
  const deadline = clock() + timeoutMs;
  const info = await (dependencies.doctorImpl ?? doctor)({ installPath: options.installPath ?? options['install-path'], pid: options.pid, configPath: options.configPath, includeHashes: true, includeExports: false, inspectProcesses: true });
  if (info.architecture !== 'x64' || info.diagnostics?.some(row => ['VERSION_MISMATCH', 'ARCHITECTURE_MISMATCH'].includes(row.code))) throw fail('E_NATIVE_VERSION', '微信安装版本或架构诊断阻止原生启动。');
  if (!SUPPORTED_NATIVE_READ_VERSIONS.includes(info.version)) throw fail('E_NATIVE_VERSION_UNSUPPORTED', '当前微信版本尚未实现经过验证的原生读取 ABI；请使用受支持版本或其它读取后端。', { version: info.version });
  const profileFile = resolve(options.profileFile ?? options.profile ?? resolve(workspace, 'profiles', `${info.version}.json`));
  let profile;
  try { profile = await read(profileFile); }
  catch { throw fail('E_NATIVE_VERSION_UNSUPPORTED', '未找到当前微信版本的可验证原生 profile。', { version: info.version }); }
  if (profile?.version !== info.version || profile.architecture !== 'x64' || !sameHash(profile.dllSha256, info.hashes?.dll)) throw fail('E_NATIVE_HASH', '安装 DLL 的 SHA-256 与受支持版本 profile 不匹配；不会启动或调用原生 RVA。');
  if (info.processInspectionAvailable !== true) throw fail('E_NATIVE_PID_UNVERIFIED', '无法验证运行中的微信进程；请检查进程查询权限。');
  const candidates = (Array.isArray(info.processes) ? info.processes : []).filter(row => Number.isSafeInteger(row.pid) && row.pid > 0 && samePath(row.path, info.exe?.path));
  let pid;
  if (options.pid !== undefined) {
    if (!Number.isSafeInteger(options.pid) || options.pid < 1) throw fail('E_ARGUMENT', 'pid 必须是正整数。');
    const selected = candidates.find(row => row.pid === options.pid);
    if (!selected || selected.role === 'child') throw fail('E_NATIVE_PID_UNVERIFIED', '指定 PID 不属于所验证的微信主进程；不会选择子进程。');
    pid = selected.pid;
  } else {
    const main = candidates.filter(row => row.role === 'main');
    if (main.length > 1) throw fail('E_NATIVE_PID_REQUIRED', '检测到多个微信主进程，请使用 --pid 明确选择。', { pids: main.map(row => row.pid) });
    if (!main.length) throw fail(candidates.length ? 'E_NATIVE_PID_REQUIRED' : 'E_WEIXIN_NOT_RUNNING', candidates.length ? '无法证明唯一主进程，请使用 --pid 明确选择。' : '微信尚未运行，请先打开并登录微信。');
    pid = main[0].pid;
  }
  const source = await (dependencies.readSourceImpl ?? readAgentSource)(resolve(workspace, 'agents/read-native.js'));
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024) throw fail('E_NATIVE_READ_SOURCE', '原生读取 agent 源码无效或超过 1 MiB。');
  const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  const metadataCall = request => {
    const remaining = deadline - clock();
    if (remaining <= 0) throw fail('E_NATIVE_START_TIMEOUT', '启动元数据查询已超过验证期限。');
    return call({ ...request, timeoutMs: Math.max(100, Math.min(2000, remaining)) });
  };
  const adapterFactory = dependencies.adapterFactory ?? (() => new NativeReadAdapter({ tokenFile, callImpl: metadataCall, readJsonImpl: read }));
  let adapter;
  let lock;
  let lockRecord;
  let keepLock = false;
  let spawnedPid;
  let archived = false;
  async function optionalDescriptor() { try { return await read(tokenFile); } catch (error) { if (error.code === 'ENOENT') return null; throw fail('E_NATIVE_HOST_DESCRIPTOR', '已有宿主描述无效；不会覆盖未知状态。'); } }
  async function hostStatus(descriptor, remaining = 2000) {
    if (!descriptorValid(descriptor)) throw fail('E_NATIVE_HOST_DESCRIPTOR', '已有宿主描述缺少可验证的身份、版本或连接信息；不会覆盖。');
    const response = await call({ tokenFile, method: 'status', args: {}, timeoutMs: Math.max(100, Math.min(2000, remaining)) });
    if (response?.success !== true) throw fail(response?.error?.code ?? 'E_NATIVE_HOST_UNVERIFIED', '已有宿主没有返回可验证状态；不会覆盖或自动重试业务请求。');
    const host = response.result;
    if (!host || host.pid !== descriptor.pid || host.generation !== descriptor.generation || host.version !== descriptor.version || !sameHash(host.dllSha256, descriptor.dllSha256)) throw fail('E_NATIVE_HOST_UNVERIFIED', '宿主与描述中的运行代次或版本不一致；不会覆盖。');
    if (host.pid !== pid || host.version !== info.version || !sameHash(host.dllSha256, profile.dllSha256)) throw fail('E_NATIVE_HOST_SCOPE', '已有宿主属于另一进程或版本；不会覆盖。');
    return host;
  }
  function verifyScript(host) {
    const matches = Array.isArray(host.scripts) ? host.scripts.filter(row => row.name === NATIVE_READ_SCRIPT) : [];
    if (matches.length !== 1 || matches[0].loaded !== true || matches[0].destroyed !== false) throw fail('E_NATIVE_HOST_NOT_READY', '已有读取脚本未就绪；不会加载多次或替换未知脚本。');
    if (!sameHash(matches[0].sourceSha256, sourceSha256)) throw fail('E_NATIVE_READ_SOURCE', '已加载读取脚本与当前源码哈希不同；不会覆盖或卸载。');
  }
  async function inspectReady(descriptor) {
    const host = await hostStatus(descriptor);
    if (host.status !== 'ready' || host.attached !== true || host.verified !== true) throw fail('E_NATIVE_HOST_NOT_READY', '已有宿主未就绪；不会覆盖或重新 attach。');
    verifyScript(host);
    adapter ??= adapterFactory({ tokenFile });
    const runtime = await adapter.inspect();
    if (runtime.pid !== pid || runtime.generation !== descriptor.generation || runtime.version !== info.version || !sameHash(runtime.dllSha256, profile.dllSha256) || runtime.ready !== true || runtime.accountVerified !== true || runtime.readScopeVerified !== true || runtime.automaticMessagesSent !== 0 || (runtime.pendingTasks ?? 0) !== 0 || (runtime.pendingCallbacks ?? 0) !== 0) throw fail('E_NATIVE_HOST_NOT_READY', '读取宿主未通过独立验证或仍有未完成任务。');
    return runtime;
  }
  async function claimLock() {
    await mkdir(dirname(lockFile), { recursive: true });
    try { lock = await open(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let prior;
      try { prior = await read(lockFile); } catch { throw fail('E_NATIVE_START_BUSY', '启动锁状态无法验证；不会删除未知锁。'); }
      if (!prior || !Number.isSafeInteger(prior.pid) || !uuid(prior.nonce) || await isAlive(prior.pid) !== false) throw fail('E_NATIVE_START_BUSY', '另一 CLI 正在准备读取宿主，请稍后再试。');
      if (prior.childPid !== undefined && await isAlive(prior.childPid) !== false) {
        const descriptor = await optionalDescriptor();
        if (!descriptor || (await inspectReady(descriptor)).historyAvailable !== true) throw fail('E_NATIVE_START_BUSY', '此前启动的宿主状态尚不明确；不会再次 attach。');
      }
      if (JSON.stringify(await read(lockFile)) !== JSON.stringify(prior)) throw fail('E_NATIVE_START_BUSY', '启动锁已变化；不会删除。');
      await unlink(lockFile);
      lock = await open(lockFile, 'wx', 0o600);
    }
    lockRecord = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
    await lock.writeFile(`${JSON.stringify(lockRecord)}\n`, 'utf8');
  }
  function summary(reused) { return { source: 'reverse-native', ready: true, reused, pid, version: info.version, architecture: 'x64', tokenFile, logFile, archivedDescriptor: archived, accountVerified: true, historyAvailable: true, automaticMessagesSent: 0 }; }
  try {
    await claimLock();
    let descriptor = await optionalDescriptor();
    if (descriptor) {
      let bootstrapEntered = false;
      try {
        await inspectReady(descriptor);
        bootstrapEntered = true;
        const prepared = await bootstrap({ workspace, tokenFile, profileFile }, { callImpl: request => {
          const remaining = deadline - clock();
          if (remaining <= 0) throw fail('E_NATIVE_START_TIMEOUT', '读取宿主复用准备已超过验证期限；未重复提交业务。');
          return call({ ...request, timeoutMs: Math.max(100, remaining) });
        } });
        if (prepared?.ready !== true || prepared.historyAvailable !== true || prepared.accountVerified !== true || prepared.pid !== pid || prepared.generation !== descriptor.generation || prepared.version !== info.version || !sameHash(prepared.dllSha256, profile.dllSha256) || prepared.automaticMessagesSent !== 0) throw fail('E_NATIVE_HOST_UNVERIFIED', '复用宿主的读取能力未通过准备验证。');
        return summary(true);
      } catch (error) {
        if (bootstrapEntered) throw error;
        if (!descriptorValid(descriptor) || await portProbe({ port: descriptor.port }) !== 'refused' || await isAlive(descriptor.hostPid) !== false) throw error;
        if (JSON.stringify(await read(tokenFile)) !== JSON.stringify(descriptor)) throw fail('E_NATIVE_HOST_DESCRIPTOR', '宿主描述已变化；不会归档。');
        await mkdir(resolve(workspace, 'data'), { recursive: true });
        await rename(tokenFile, resolve(workspace, 'data', `native-read-host.offline-${clock()}-${randomUUID()}.json`));
        archived = true;
        descriptor = null;
      }
    }
    if (clock() >= deadline) throw fail('E_NATIVE_START_TIMEOUT', '安装与进程验证已超过启动期限；尚未启动原生宿主。');
    await mkdir(dirname(logFile), { recursive: true });
    const log = await open(logFile, 'a', 0o600);
    try {
      const args = [resolve(workspace, 'src/native-runtime-host.mjs'), '--pid', String(pid), '--read', '--token-file', tokenFile, '--profile', profileFile, '--install-path', info.installPath];
      const child = await (dependencies.spawnHostImpl ?? launchHost)({ execPath: dependencies.execPath ?? process.execPath, args, options: { cwd: workspace, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] } });
      if (!Number.isSafeInteger(child?.pid) || child.pid < 1) throw fail('E_NATIVE_START_FAILED', '读取宿主未返回可验证的子进程 PID。');
      spawnedPid = child.pid;
      lockRecord.childPid = spawnedPid;
      const bytes = Buffer.from(`${JSON.stringify(lockRecord)}\n`);
      await lock.truncate(0); await lock.write(bytes, 0, bytes.length, 0);
    } finally { await log.close(); }
    while (clock() < deadline) {
      descriptor = await optionalDescriptor();
      if (descriptor) {
        let host;
        try { host = await hostStatus(descriptor, deadline - clock()); }
        catch (error) { if (!['E_TRANSPORT_UNKNOWN', 'E_TIMEOUT_UNKNOWN'].includes(error.code)) throw error; }
        if (host) {
        if (['startup-error', 'attached-error', 'detached', 'stopped'].includes(host.status)) throw fail('E_NATIVE_START_FAILED', '读取宿主启动未成功；保留现场与日志，不会自动重启微信或清理 agent。');
        if (host.status === 'ready' && host.attached === true && host.verified === true) {
          const named = Array.isArray(host.scripts) ? host.scripts.find(row => row.name === NATIVE_READ_SCRIPT) : undefined;
          if (named?.loaded === true) {
            verifyScript(host);
            adapter ??= adapterFactory({ tokenFile });
            try {
              const runtime = await adapter.inspect();
              if (runtime.pid !== pid || runtime.generation !== descriptor.generation || runtime.version !== info.version || !sameHash(runtime.dllSha256, profile.dllSha256)) throw fail('E_NATIVE_HOST_UNVERIFIED', '新宿主的读取 agent 身份或版本不匹配。');
              if (runtime.ready === true && runtime.accountVerified === true && runtime.readScopeVerified === true && runtime.historyAvailable === true && runtime.automaticMessagesSent === 0 && (runtime.pendingTasks ?? 0) === 0 && (runtime.pendingCallbacks ?? 0) === 0) return summary(false);
            } catch (error) { if (!['E_NATIVE_READ_BUSY', 'E_NATIVE_READ_UNVERIFIED', 'E_SCRIPT_STATE', 'E_TRANSPORT_UNKNOWN', 'E_TIMEOUT_UNKNOWN'].includes(error.code)) throw error; }
          }
        }
        }
      }
      if (await isAlive(spawnedPid) === false) throw fail('E_NATIVE_START_FAILED', '读取宿主进程已经退出；请查看本地启动日志。');
      await sleep(Math.min(500, Math.max(0, deadline - clock())));
    }
    throw fail('E_NATIVE_START_TIMEOUT', '读取宿主未在期限内完成验证；不会重复 attach 或自动重试原生业务。');
  } finally {
    try { if (spawnedPid && !await optionalDescriptor() && await isAlive(spawnedPid) !== false) keepLock = true; }
    catch { keepLock = true; }
    try { await adapter?.close?.(); }
    finally {
      if (lock) {
        await lock.close();
        if (!keepLock) { try { const current = await read(lockFile); if (current.nonce === lockRecord?.nonce) await unlink(lockFile); } catch { /* Keep any unrelated or unknown lock. */ } }
      }
    }
  }
}
