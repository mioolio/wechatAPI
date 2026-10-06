import { readFile, stat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { callPersistentHost } from './native-runtime-client.mjs';
import { NATIVE_SEND_SCRIPT, requireContactSnapshot } from './native-send-adapter.mjs';
import { WxError } from './errors.mjs';
import { createPrivacyFormatter } from './privacy.mjs';
import { DEFAULT_NATIVE_TARGET_FILE, requireNativeTarget } from './native-target.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const sameHash = (left, right) => isHash(left) && isHash(right) && left.toLowerCase() === right.toLowerCase();
async function readJson(path) {
  if ((await stat(path)).size > 65536) throw new WxError('E_NATIVE_CONFIG', '配置文件过大。');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function readSource(path) {
  if ((await stat(path)).size > 1024 * 1024) throw new WxError('E_NATIVE_SOURCE', '发送 agent 源码超过 1 MiB。');
  return readFile(path, 'utf8');
}
async function saveBinding(path, binding) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
export function hasPriorNativeValidation(profile, host) {
  const evidence = profile?.nativeSendValidation;
  return Boolean(evidence && profile.version === host.version && /^[a-f0-9]{64}$/i.test(host.dllSha256 ?? '') && profile.dllSha256?.toLowerCase() === host.dllSha256.toLowerCase()
    && evidence.dllSha256?.toLowerCase() === host.dllSha256.toLowerCase() && evidence.status === 'accepted'
    && evidence.version === host.version && evidence.nativeEntryCalled === true && evidence.entryRva === '0x54b02f0'
    && typeof evidence.verifiedAt === 'string' && Number.isFinite(Date.parse(evidence.verifiedAt))
    && typeof evidence.requestId === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(evidence.requestId));
}
export function hasPriorContactValidation(profile, host, sourceSha256) {
  const evidence = profile?.nativeContactCacheValidation;
  return Boolean(evidence && profile.version === host.version && /^[a-f0-9]{64}$/i.test(host.dllSha256 ?? '') && /^[a-f0-9]{64}$/i.test(sourceSha256 ?? '')
    && profile.dllSha256?.toLowerCase() === host.dllSha256.toLowerCase() && evidence.dllSha256?.toLowerCase() === host.dllSha256.toLowerCase()
    && evidence.agentSourceSha256?.toLowerCase() === sourceSha256.toLowerCase() && evidence.version === host.version
    && evidence.native === true && evidence.scope === 'loaded-contact-cache' && evidence.complete === false && evidence.cacheSnapshotComplete === true
    && evidence.registryGetterRva === '0x36c7b0' && evidence.storeGetterRva === '0x6dcf80' && evidence.accountVtableRva === '0x8dfe2f8' && evidence.cacheCenterVtableRva === '0x8f9bf98'
    && Number.isSafeInteger(evidence.count) && evidence.count > 0 && evidence.count <= 4096
    && typeof evidence.verifiedAt === 'string' && Number.isFinite(Date.parse(evidence.verifiedAt)));
}
function requireBoundRuntime(runtime, host, target) {
  if (!runtime || runtime.pid !== host.pid || runtime.generation !== host.generation || runtime.version !== host.version || runtime.dllSha256?.toLowerCase() !== host.dllSha256.toLowerCase() || runtime.self !== target.self || runtime.accountVerified !== true || runtime.chatId !== target.chatId || runtime.sessionId !== target.chatId || runtime.displayName !== target.displayName || runtime.ready !== true || runtime.prologuesVerified !== true) throw new WxError('E_NATIVE_SCOPE', '当前账号或原生会话与本地单目标授权、PID、版本、二进制或代次不一致；不会复用旧绑定。');
}

/** Explicitly prepare an already running host. Never attach/detach, replace agents, or send. */
export async function bootstrapNativeSend({ workspace = WORKSPACE, tokenFile = resolve(WORKSPACE, 'data/research-host.json'), bindingFile = resolve(WORKSPACE, 'data/native-send-binding.json'), targetFile = DEFAULT_NATIVE_TARGET_FILE, profileFile } = {}, deps = {}) {
  const read = deps.readJsonImpl ?? readJson;
  const readAgent = deps.readSourceImpl ?? readSource;
  const call = deps.callImpl ?? callPersistentHost;
  const save = deps.saveBindingImpl ?? saveBinding;
  const target = requireNativeTarget(await read(targetFile));
  const descriptor = await read(tokenFile);
  async function invoke(method, args) {
    const response = await call({ tokenFile, method, args });
    if (response?.success !== true) throw new WxError(response?.error?.code ?? 'E_NATIVE_HOST', response?.error?.message ?? '原生宿主未返回成功结果。');
    return response.result;
  }
  const host = await invoke('status', {});
  if (!descriptor || descriptor.host !== '127.0.0.1' || !host || host.status !== 'ready' || host.attached !== true || host.verified !== true || !Number.isSafeInteger(host.pid) || host.pid <= 0 || host.pid !== descriptor.pid || !UUID.test(host.generation ?? '') || host.generation !== descriptor.generation || !/^\d+\.\d+\.\d+\.\d+$/.test(host.version ?? '')) throw new WxError('E_NATIVE_GENERATION', '宿主未就绪，或其 PID/generation 与描述文件不一致。');
  let previousBinding;
  try { previousBinding = await read(bindingFile); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previousBinding?.pid === host.pid && previousBinding?.generation === host.generation && previousBinding.runtimeBlocked) throw new WxError('E_NATIVE_RUNTIME_BLOCKED', '本次运行仍有阻塞任务；初始化不会清除阻塞标记。需微信和宿主重新启动后建立新的运行代次。');
  if (previousBinding?.pid === host.pid && previousBinding?.generation === host.generation && (previousBinding.self !== target.self || previousBinding.chatId !== target.chatId || previousBinding.displayName !== target.displayName)) throw new WxError('E_NATIVE_TARGET_CHANGED', '本次运行代次已有其他账号或目标绑定；新授权需要新的发送宿主代次。');
  const profile = await read(profileFile ?? resolve(workspace, 'profiles', `${host.version}.json`));
  if (profile?.version !== host.version || !/^[a-f0-9]{64}$/i.test(host.dllSha256 ?? '') || profile?.dllSha256?.toLowerCase() !== host.dllSha256.toLowerCase()) throw new WxError('E_NATIVE_HASH', '启动时已验证的 DLL SHA-256 与当前版本 profile 不一致。');
  if (target.version !== host.version || target.dllSha256 !== host.dllSha256.toLowerCase()) throw new WxError('E_NATIVE_TARGET_BINARY', '目标授权的客户端版本或 DLL 与当前已验证二进制不一致；重新读取并配置目标。');
  const source = await readAgent(resolve(workspace, 'agents/send-native.js'));
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 1024 * 1024) throw new WxError('E_NATIVE_SOURCE', '发送 agent 源码格式或大小无效。');
  const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  if (!Array.isArray(host.scripts)) throw new WxError('E_NATIVE_SCRIPT_STATE', '宿主未提供可验证的已加载脚本列表。');
  const existing = host.scripts.filter(script => script.name === NATIVE_SEND_SCRIPT);
  if (existing.length > 1 || (existing.length === 1 && (existing[0].loaded !== true || existing[0].destroyed !== false))) throw new WxError('E_NATIVE_SCRIPT_STATE', '指定脚本名已存在但失效；不会自动卸载或覆盖。');
  if (existing.length && !sameHash(existing[0].sourceSha256, sourceSha256)) throw new WxError('E_NATIVE_SOURCE', '同名已加载脚本与当前 send-native.js 源哈希不一致；不会覆盖或卸载。');
  const agent = existing[0] ?? await invoke('load', { name: NATIVE_SEND_SCRIPT, path: 'agents/send-native.js' });
  if (!agent || agent.name !== NATIVE_SEND_SCRIPT || agent.loaded !== true || agent.destroyed === true || !sameHash(agent.sourceSha256, sourceSha256)) throw new WxError('E_NATIVE_SOURCE', '实际加载的发送脚本与当前源哈希或名称不匹配。');
  let runtime = await invoke('rpc', { name: NATIVE_SEND_SCRIPT, method: 'inspect', params: [] });
  const priorValidated = hasPriorNativeValidation(profile, host);
  if (runtime?.generation === null && runtime?.ready === false) {
    const config = { pid: host.pid, generation: host.generation, self: target.self, chatId: target.chatId, sessionId: target.chatId, displayName: target.displayName, ...(priorValidated ? { validatedBinarySha256: host.dllSha256.toLowerCase() } : {}) };
    runtime = await invoke('rpc', { name: NATIVE_SEND_SCRIPT, method: 'prepare', params: [config] });
  }
  requireBoundRuntime(runtime, host, target);
  const binding = { pid: host.pid, generation: host.generation, self: target.self, chatId: target.chatId, sessionId: target.chatId, displayName: target.displayName, version: host.version, dllSha256: host.dllSha256.toLowerCase(), ...(priorValidated ? { validatedBinarySha256: host.dllSha256.toLowerCase() } : {}) };
  const priorContactValidated = hasPriorContactValidation(profile, host, agent?.sourceSha256);
  let contactCount;
  if (runtime.contactSnapshotAvailable !== true && priorContactValidated) {
    try {
      const snapshot = await invoke('rpc', { name: NATIVE_SEND_SCRIPT, method: 'contacts', params: [] });
      requireContactSnapshot(snapshot, runtime);
      contactCount = snapshot.count;
      runtime = await invoke('rpc', { name: NATIVE_SEND_SCRIPT, method: 'inspect', params: [] });
      requireBoundRuntime(runtime, host, target);
      if (runtime.contactSnapshotAvailable !== true) throw new WxError('E_CONTACT_SNAPSHOT', '原生联系人快照未进入已验证状态。');
    } catch (error) {
      await save(bindingFile, { ...binding, runtimeBlocked: true, runtimeBlockReason: 'contact-cache-initialization-failed' });
      throw error;
    }
  }
  await save(bindingFile, binding);
  return { source: 'reverse-native', prepared: true, pid: host.pid, generation: host.generation, self: target.self, accountVerified: true, chatId: target.chatId, sessionId: target.chatId, displayName: target.displayName, version: host.version, prologuesVerified: true, ready: priorValidated && runtime.sendValidated === true, sendValidated: priorValidated && runtime.sendValidated === true, priorBinaryValidation: priorValidated, contactSnapshotAvailable: runtime.contactSnapshotAvailable === true, priorContactValidation: priorContactValidated, ...(contactCount === undefined ? {} : { contactCount }), automaticMessagesSent: 0 };
}

export async function runNativeRuntimeBootstrap(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help') { process.stdout.write('node src/native-runtime-bootstrap.mjs [--token-file FILE] [--target-file FILE] [--profile FILE]\nPrepares the locally authorized single target using a fresh current-account proof. It never sends messages.\nRecorded native validation is reused only for the exact verified DLL SHA-256; missing evidence keeps sending disabled.\n'); return; }
    const flag = argv[index];
    if (flag === '--no-redact') { options.redact = false; continue; }
    if (flag === '--redact') {
      if (!['true', 'false'].includes(argv[index + 1])) throw new WxError('E_ARGUMENT', '--redact 必须是 true 或 false。');
      options.redact = argv[++index] === 'true';
      continue;
    }
    if (!['--token-file', '--target-file', '--profile'].includes(flag) || !argv[index + 1]) throw new WxError('E_ARGUMENT', '可选参数：--token-file FILE、--target-file FILE、--profile FILE。');
    options[flag === '--token-file' ? 'tokenFile' : flag === '--target-file' ? 'targetFile' : 'profileFile'] = argv[++index];
  }
  process.stdout.write(`${createPrivacyFormatter({ enabled: options.redact !== false }).format(await bootstrapNativeSend(options))}\n`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNativeRuntimeBootstrap().catch(error => { process.stderr.write(`${createPrivacyFormatter().format({ success: false, error: { code: error.code ?? 'E_BOOTSTRAP', message: error.message } })}\n`); process.exitCode = 1; });
}
