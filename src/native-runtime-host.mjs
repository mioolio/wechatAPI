#!/usr/bin/env node
// Engineering-only persistent Frida host. No attachment occurs merely by importing this module.
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, writeFile, appendFile, unlink } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { doctor as inspectInstallation } from './doctor.mjs';
import { createPrivacyFormatter } from './privacy.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
const MAX_BODY = 1024 * 1024;
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function serializeError(error) { return { code: error?.code ?? 'E_OPERATION', message: error?.message ?? String(error) }; }
function normalizePath(value) { return resolve(value).replaceAll('/', sep).toLowerCase(); }
function normalizeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.trim())) throw failure('E_REQUEST_ID', 'requestId must be 1–128 ASCII letters, digits, or ._:-');
  return value.trim().toLowerCase();
}
function scriptName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) throw failure('E_SCRIPT_NAME', 'A short alphanumeric script name is required');
  return value;
}
export async function agentPath(workspace, value) {
  if (typeof value !== 'string' || !value || !/\.(?:js|mjs)$/.test(value)) throw failure('E_AGENT_PATH', 'Only workspace agents/*.js or *.mjs files are permitted');
  const root = await realpath(workspace);
  const agents = await realpath(resolve(workspace, 'agents'));
  const agentsRelative = relative(root, agents);
  if (!agentsRelative || isAbsolute(agentsRelative) || agentsRelative === '..' || agentsRelative.startsWith(`..${sep}`)) throw failure('E_AGENT_PATH', 'The agents directory resolves outside the workspace');
  const target = await realpath(resolve(workspace, value));
  const rel = relative(agents, target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw failure('E_AGENT_PATH', 'Agent path is outside the workspace agents directory');
  return target;
}
export async function validateInstallation({ pid, workspace = WORKSPACE, profile, installPath }, doctor = inspectInstallation) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw failure('E_PID', '--pid must explicitly identify a positive Weixin PID');
  const info = await doctor({ installPath, includeHashes: true, includeExports: false, inspectProcesses: true });
  if (!info.processInspectionAvailable || !info.processes.some(p => p.pid === pid && normalizePath(p.path) === normalizePath(info.exe.path))) throw failure('E_PID', 'PID does not match the verified Weixin installation');
  const trusted = JSON.parse(await readFile(profile ?? resolve(workspace, 'profiles', `${info.version}.json`), 'utf8'));
  if (info.diagnostics.some(d => ['VERSION_MISMATCH', 'ARCHITECTURE_MISMATCH'].includes(d.code))) throw failure('E_VERSION', 'Installation version/architecture diagnostics prevent attachment');
  if (trusted.version !== info.version || trusted.architecture !== info.architecture || info.architecture !== 'x64') throw failure('E_PROFILE', 'Installed version and architecture must exactly match the profile');
  if (!/^[0-9a-f]{64}$/i.test(trusted.dllSha256 ?? '') || trusted.dllSha256.toLowerCase() !== info.hashes.dll.toLowerCase()) throw failure('E_HASH', 'Weixin.dll SHA-256 does not match the static profile');
  return { info, trusted };
}

/** Start only when explicitly called. deps permit tests without loading Frida or touching Weixin. */
export async function createPersistentHost(options, deps = {}) {
  const workspace = resolve(options.workspace ?? WORKSPACE);
  const { info } = await validateInstallation({ ...options, workspace }, deps.doctor);
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw failure('E_TIMEOUT_VALUE', 'timeout must be 100–120000 milliseconds');
  const tokenFile = resolve(options.tokenFile ?? resolve(workspace, 'data/research-host.json'));
  const eventFile = resolve(workspace, 'artifacts/research/runtime-events.ndjson');
  await mkdir(dirname(tokenFile), { recursive: true });
  await mkdir(dirname(eventFile), { recursive: true });
  const token = randomBytes(32).toString('hex');
  const generation = randomUUID();
  const state = { status: 'starting', pid: options.pid, generation, version: info.version, dllSha256: info.hashes.dll, attached: false, verified: false, scripts: [], unknownRequests: [], port: null };
  const stdout = deps.stdout ?? (record => process.stdout.write(`${JSON.stringify(record)}\n`));
  let logTail = Promise.resolve();
  async function record(kind, details = {}) {
    const entry = { time: new Date().toISOString(), kind, pid: state.pid, generation, ...details };
    const line = JSON.stringify(entry);
    const safeLine = Buffer.byteLength(line) <= MAX_BODY ? line : JSON.stringify({ time: entry.time, kind, pid: state.pid, generation, truncated: true });
    logTail = logTail.then(() => appendFile(eventFile, `${safeLine}\n`, { mode: 0o600 }));
    await logTail;
    if (kind === 'phase') stdout({ phase: details.phase, pid: state.pid, port: state.port, status: state.status, ...(details.script ? { script: details.script } : {}) });
  }
  function event(kind, details) { void record(kind, details).catch(() => { state.logError = 'E_EVENT_LOG'; }); }
  const scripts = new Map();
  const requests = new Map();
  let frida;
  let session;
  let releaseStartup;
  let serial = new Promise(resolveReady => { releaseStartup = resolveReady; });
  let stopped = false;
  let resolveClosed;
  const closed = new Promise(resolveDone => { resolveClosed = resolveDone; });
  function snapshot() {
    return { ...state, scripts: [...scripts].map(([name, value]) => ({ name, path: value.path, sourceSha256: value.sourceSha256, loaded: value.loaded, destroyed: value.script.isDestroyed })), unknownRequests: [...requests].filter(([, value]) => value.status === 'unknown').map(([requestId]) => requestId) };
  }
  async function operation(fn) {
    const cancellable = new frida.Cancellable();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancellable.cancel(); }, timeoutMs);
    try { return await fn(cancellable); }
    catch (error) { if (timedOut) throw failure('E_TIMEOUT_UNKNOWN', 'Operation timed out; the target operation may still be running. No automatic retry was attempted.'); throw error; }
    finally { clearTimeout(timer); }
  }
  async function load(name, path) {
    scriptName(name);
    if (scripts.has(name)) throw failure('E_SCRIPT_EXISTS', 'A script with this name already exists; use a fresh name');
    const file = await agentPath(workspace, path);
    const source = await readFile(file, 'utf8');
    if (Buffer.byteLength(source) > MAX_BODY) throw failure('E_AGENT_SIZE', 'Agent source exceeds 1 MiB');
    const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');
    await record('phase', { phase: 'create-script.begin', script: name });
    const script = await operation(c => session.createScript(source, { name: `wxcc-${name}`, runtime: 'qjs' }, c));
    const entry = { script, path: file, sourceSha256, loaded: false };
    scripts.set(name, entry);
    // Agents must use send(filteredPayload). Do not leak console content to stdout.
    script.logHandler = level => event('agent-console-suppressed', { script: name, level });
    script.destroyed.connect(() => { entry.loaded = false; event('script-destroyed', { script: name }); });
    script.message.connect((message, data) => {
      // Persist only payload explicitly emitted by the agent, never raw attached binary data.
      if (message.type === 'send') event('agent-payload', { script: name, payload: message.payload, attachedDataBytes: data?.length ?? 0 });
      else if (message.type === 'error') event('agent-error', { script: name, description: message.description, stack: message.stack });
    });
    await record('phase', { phase: 'load.begin', script: name });
    await operation(c => script.load(c));
    entry.loaded = true;
    await record('phase', { phase: 'load.end', script: name });
    return { name, path: file, sourceSha256, loaded: true };
  }
  function activeScript(name) {
    const item = scripts.get(scriptName(name));
    if (!item || !item.loaded || item.script.isDestroyed) throw failure('E_SCRIPT_STATE', 'Script is not loaded');
    return item.script;
  }
  async function command(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('E_BODY', 'A JSON object is required');
    const id = normalizeId(body.requestId);
    if (requests.has(id)) throw failure('E_REQUEST_DUPLICATE', 'requestId already exists; use status with args.requestId to inspect its state');
    if (requests.size >= 10000) throw failure('E_REQUEST_LIMIT', 'Request ledger is full; no entries are silently evicted');
    const method = body.method;
    const args = body.args ?? {};
    if (typeof args !== 'object' || !args || Array.isArray(args)) throw failure('E_ARGS', 'args must be an object');
    const pending = { status: 'queued', method, createdAt: new Date().toISOString() };
    requests.set(id, pending);
    let enteredRpc = false;
    try {
      pending.status = 'executing';
      if (stopped) throw failure('E_STOPPED', 'Host is stopped');
      let result;
      if (method === 'status') {
        const lookup = args.requestId ? normalizeId(args.requestId) : null;
        result = lookup ? { requestId: lookup, request: requests.get(lookup) ?? null, host: snapshot() } : snapshot();
      } else if (method === 'stop') {
        if (state.attached) throw failure('E_ATTACHED_STOP', 'Explicitly detach first. stop never unloads or detaches a live Frida session.');
        stopped = true;
        state.status = 'stopped';
        await record('phase', { phase: 'stop' });
        result = snapshot();
        setImmediate(() => server.close());
      } else {
        if (!state.attached || !session || session.isDetached()) throw failure('E_SESSION_STATE', 'Session is not attached');
        if (method === 'inspect') {
          const script = activeScript('inspect');
          enteredRpc = true;
          const metadata = await operation(c => script.exports.inspect(c));
          if (metadata.pid !== state.pid || !metadata.mainModule || metadata.architecture !== info.architecture || normalizePath(metadata.mainModule.path) !== normalizePath(info.dll.path)) throw failure('E_RUNTIME_IDENTITY', 'Runtime module/PID/architecture differs from the static installation');
          state.verified = true;
          result = metadata;
        } else if (method === 'load') {
          if (!state.verified) throw failure('E_RUNTIME_UNVERIFIED', 'Initial runtime identity has not been verified');
          result = await load(args.name, args.path);
        } else if (method === 'rpc') {
          if (!state.verified) throw failure('E_RUNTIME_UNVERIFIED', 'Runtime identity must be verified before custom RPC');
          if (typeof args.method !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(args.method) || ['then', 'catch', 'finally', 'constructor', '__proto__', 'prototype'].includes(args.method)) throw failure('E_RPC_METHOD', 'A valid explicit RPC method is required');
          if (!Array.isArray(args.params ?? [])) throw failure('E_RPC_PARAMS', 'params must be a JSON array');
          const script = activeScript(args.name);
          await record('phase', { phase: 'rpc.begin', script: args.name, requestId: id, method: args.method });
          enteredRpc = true;
          result = await operation(c => script.exports[args.method](...(args.params ?? []), c));
          await record('phase', { phase: 'rpc.end', script: args.name, requestId: id, method: args.method });
        } else if (method === 'unload') {
          if (args.explicit !== true) throw failure('E_EXPLICIT_REQUIRED', 'unload requires explicit:true; target cleanup risk remains unverified');
          const script = activeScript(args.name);
          await record('phase', { phase: 'unload.begin', script: args.name });
          await operation(c => script.unload(c));
          scripts.get(args.name).loaded = false;
          if (args.name === 'inspect') state.verified = false;
          await record('phase', { phase: 'unload.end', script: args.name });
          result = snapshot();
        } else if (method === 'detach') {
          if (args.explicit !== true) throw failure('E_EXPLICIT_REQUIRED', 'detach requires explicit:true; it may cause target cleanup and unload scripts');
          await record('phase', { phase: 'detach.begin' });
          await operation(c => session.detach(c));
          state.attached = false;
          state.verified = false;
          state.status = 'detached';
          await record('phase', { phase: 'detach.end' });
          result = snapshot();
        } else throw failure('E_METHOD', 'Supported methods: status, inspect, load, rpc, unload, detach, stop');
      }
      pending.status = 'complete';
      pending.completedAt = new Date().toISOString();
      // Retain status metadata, not possibly sensitive arbitrary RPC result bodies.
      return { success: true, requestId: id, result };
    } catch (error) {
      pending.status = enteredRpc || error.code === 'E_TIMEOUT_UNKNOWN' ? 'unknown' : 'failed';
      pending.error = serializeError(error);
      await record('request-error', { requestId: id, method, status: pending.status, error: pending.error });
      return { success: false, requestId: id, requestStatus: pending.status, error: pending.error };
    }
  }
  function authenticated(req) {
    const supplied = req.headers['x-wxcc-token'];
    if (typeof supplied !== 'string') return false;
    const bytes = Buffer.from(supplied);
    const expected = Buffer.from(token);
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  }
  const server = createServer(async (req, res) => {
    function respond(status, value) { if (res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); }
    if (!authenticated(req)) { req.resume(); respond(401, { success: false, error: { code: 'E_AUTH', message: 'A valid TokenHeader is required' } }); return; }
    if (req.method !== 'POST' || req.url !== '/command') { req.resume(); respond(404, { success: false, error: { code: 'E_ENDPOINT', message: 'POST /command only' } }); return; }
    try {
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { req.resume(); respond(413, { success: false, error: { code: 'E_BODY_SIZE', message: 'Body exceeds 1 MiB' } }); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw failure('E_BODY_SIZE', 'Body exceeds 1 MiB'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const work = serial.then(() => command(body));
      serial = work.catch(() => {});
      const result = await work;
      respond(result.success ? 200 : 409, result);
    } catch (error) { respond(error.code === 'E_BODY_SIZE' ? 413 : 400, { success: false, error: serializeError(error) }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('close', () => {
    void (async () => {
      try { const saved = JSON.parse(await readFile(tokenFile, 'utf8')); if (saved.generation === generation) await unlink(tokenFile); } catch { /* Retain any unrelated descriptor. */ }
      await logTail.catch(() => {});
      resolveClosed();
    })();
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); ready(); }); });
  state.port = server.address().port;
  try {
    await writeFile(tokenFile, `${JSON.stringify({ format: 1, host: '127.0.0.1', port: state.port, token, pid: state.pid, hostPid: process.pid, generation, version: state.version, dllSha256: state.dllSha256, createdAt: new Date().toISOString(), timeoutMs, tokenFilePermissions: process.platform === 'win32' ? 'Windows directory ACL applies; mode 0600 does not set a Windows ACL' : 'mode 0600' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) { server.close(); throw failure('E_TOKEN_FILE', error.code === 'EEXIST' ? 'Token descriptor already exists; inspect/stop its host before replacing it' : 'Could not create private host token descriptor'); }
  await record('phase', { phase: 'server.ready' });
  const startup = (async () => {
    try {
      frida = deps.frida ?? await import('frida');
      const device = await operation(c => frida.getLocalDevice(c));
      await record('phase', { phase: 'attach.begin' });
      session = await operation(c => device.attach(state.pid, {}, c));
      state.attached = true;
      state.status = 'attached';
      session.detached.connect((reason, crash) => {
        state.attached = false;
        state.verified = false;
        state.status = 'detached';
        event('phase', { phase: 'session.detached', reason, crash: crash ? { pid: crash.pid, processName: crash.processName, summary: crash.summary } : null });
      });
      await record('phase', { phase: 'attach.end' });
      await load('inspect', 'agents/inspect.js');
      const initial = await operation(c => activeScript('inspect').exports.inspect(c));
      if (initial.pid !== state.pid || !initial.mainModule || initial.architecture !== info.architecture || normalizePath(initial.mainModule.path) !== normalizePath(info.dll.path)) throw failure('E_RUNTIME_IDENTITY', 'Runtime identity differs from the verified installation');
      state.verified = true;
      state.status = 'ready';
      await record('phase', { phase: 'runtime.verified' });
    } catch (error) {
      state.status = state.attached ? 'attached-error' : 'startup-error';
      state.startupError = serializeError(error);
      await record('startup-error', { error: state.startupError });
      await record('phase', { phase: 'startup.error-kept-alive' });
      // Keep the server/session alive for explicit diagnostics/cleanup. No unload/detach here.
    }
    return snapshot();
  })();
  startup.then(releaseStartup, releaseStartup);
  return { startup, closed, tokenFile, eventFile, status: snapshot, noteSignal(signal) { event('phase', { phase: `signal.${signal}.kept-alive` }); } };
}

export function parseCli(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help') return { help: true };
    if (key === '--send') { result.send = true; continue; }
    if (key === '--read') { result.read = true; continue; }
    if (!['--pid', '--install-path', '--profile', '--timeout', '--token-file'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw failure('E_ARGUMENT', 'Use --pid PID [--read | --send] [--token-file FILE] [--install-path PATH] [--profile FILE] [--timeout MS]');
    const value = argv[++i];
    result[key.slice(2)] = value;
  }
  if (result.read && result.send) throw failure('E_ARGUMENT', '--read 与 --send 请分别启动两个独立宿主，不能在同一次启动中同时指定。');
  return { pid: Number(result.pid), installPath: result['install-path'], profile: result.profile, timeoutMs: result.timeout === undefined ? undefined : Number(result.timeout), send: result.send === true, read: result.read === true, tokenFile: result['token-file'] ?? (result.read ? resolve(WORKSPACE, 'data/native-read-host.json') : undefined) };
}
export async function runNativeRuntimeHost(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) { process.stdout.write('node src/native-runtime-host.mjs --pid PID [--read | --send] [--token-file FILE]\nDefault loads only metadata. --read prepares the read agent and verifies one self-history query. --send prepares the authorized send agent. Neither sends messages automatically.\nStart read and send as separate hosts. Read defaults to data/native-read-host.json; other modes default to data/research-host.json. On Windows protect these files with the workspace directory ACL.\nCtrl+C keeps the host alive; explicitly detach, then stop via the client. RPC timeouts remain unknown and are never automatically retried.\n'); return; }
  const host = await createPersistentHost(options);
  const keepAlive = signal => host.noteSignal(signal);
  const intHandler = () => keepAlive('SIGINT');
  const termHandler = () => keepAlive('SIGTERM');
  process.on('SIGINT', intHandler);
  process.on('SIGTERM', termHandler);
  await host.startup;
  if (options.read && host.status().status === 'ready') {
    try {
      const { bootstrapNativeRead } = await import('./native-read-bootstrap.mjs');
      const result = await bootstrapNativeRead({ tokenFile: host.tokenFile, profileFile: options.profile });
      process.stdout.write(`${JSON.stringify({ phase: 'native-read.prepared', pid: result.pid, port: host.status().port, status: result.historyAvailable === true ? 'read-ready' : 'history-unverified' })}\n`);
    } catch (error) { process.stderr.write(`${createPrivacyFormatter().format({ success: false, error: serializeError(error) })}\n`); }
  }
  if (options.send && host.status().status === 'ready') {
    try {
      const { bootstrapNativeSend } = await import('./native-runtime-bootstrap.mjs');
      const result = await bootstrapNativeSend({ tokenFile: host.tokenFile, profileFile: options.profile });
      process.stdout.write(`${JSON.stringify({ phase: 'native-send.prepared', pid: result.pid, port: host.status().port, status: result.ready ? 'send-ready' : 'send-not-validated' })}\n`);
    } catch (error) { process.stderr.write(`${createPrivacyFormatter().format({ success: false, error: serializeError(error) })}\n`); }
  }
  await host.closed;
  process.removeListener('SIGINT', intHandler);
  process.removeListener('SIGTERM', termHandler);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNativeRuntimeHost().catch(error => { process.stderr.write(`${createPrivacyFormatter().format({ success: false, error: serializeError(error) })}\n`); process.exitCode = 1; });
}
