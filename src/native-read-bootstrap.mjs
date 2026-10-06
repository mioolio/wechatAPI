import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { callPersistentHost } from './native-runtime-client.mjs';
import { NATIVE_READ_SCRIPT, requireContactSnapshot } from './native-read-adapter.mjs';
import { createPrivacyFormatter } from './privacy.mjs';
import { WxError } from './errors.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const sameHash = (left, right) => isHash(left) && isHash(right) && left.toLowerCase() === right.toLowerCase();
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,256}$/.test(value);
const isName = value => typeof value === 'string' && value.length <= 4096 && value.isWellFormed() && !value.includes('\0');
const uint64 = value => typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const failure = (code, message) => new WxError(code, message);

async function readJson(path) {
  if ((await stat(path)).size > 65536) throw failure('E_NATIVE_READ_CONFIG', '读取配置文件过大。');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function readSource(path) {
  if ((await stat(path)).size > 1024 * 1024) throw failure('E_NATIVE_READ_SOURCE', '读取 agent 源码超过 1 MiB。');
  return readFile(path, 'utf8');
}

function requireIdentity(runtime, host) {
  if (!runtime || runtime.pid !== host.pid || runtime.version !== host.version || !sameHash(runtime.dllSha256, host.dllSha256) || runtime.automaticMessagesSent !== 0 || (runtime.pendingTasks ?? 0) !== 0 || (runtime.pendingCallbacks ?? 0) !== 0) throw failure('E_NATIVE_READ_SCOPE', '读取 agent 的 PID、版本、DLL 哈希、只读状态或待处理任务未通过验证。');
}
function requirePrepared(runtime, host) {
  requireIdentity(runtime, host);
  if (runtime.generation !== host.generation || runtime.ready !== true || runtime.accountVerified !== true || runtime.readScopeVerified !== true || !isId(runtime.self) || runtime.self.includes('@chatroom') || runtime.self.toLowerCase().startsWith('gh_')) throw failure('E_NATIVE_READ_SCOPE', '准备后的本人账户或读取范围未通过当前运行代次验证。');
}
function requireHistory(result, host, self) {
  if (!result || result.pid !== host.pid || result.generation !== host.generation || result.self !== self || result.chatId !== self || result.source !== 'reverse-native' || result.schemaValidated !== true || result.automaticMessagesSent !== 0 || !Array.isArray(result.messages) || result.messages.length > 1) throw failure('E_NATIVE_HISTORY_SCHEMA', '用于 ABI 验证的本人历史结果身份或结构无效。');
  for (const row of result.messages) {
    if (!row || !uint64(row.serverId) || !uint64(row.type) || !uint64(row.createTime) || BigInt(row.createTime) * 1000n > BigInt(Number.MAX_SAFE_INTEGER) || typeof row.content !== 'string' || row.content.length > 1024 * 1024 || !row.content.isWellFormed() || typeof row.senderUsername !== 'string' || (row.senderUsername && !isId(row.senderUsername)) || (row.senderName !== undefined && !isName(row.senderName)) || (row.subType !== undefined && !uint64(row.subType))) throw failure('E_NATIVE_HISTORY_SCHEMA', '用于 ABI 验证的消息字段结构无效。');
  }
}

/** Prepare only an already verified host. Never attach, replace/unload scripts, or send. */
export async function bootstrapNativeRead({ workspace = WORKSPACE, tokenFile = resolve(WORKSPACE, 'data/native-read-host.json'), profileFile } = {}, dependencies = {}) {
  const read = dependencies.readJsonImpl ?? readJson;
  const readAgent = dependencies.readSourceImpl ?? readSource;
  const call = dependencies.callImpl ?? callPersistentHost;
  async function invoke(method, args) {
    const response = await call({ tokenFile, method, args });
    if (response?.success !== true) throw failure(response?.error?.code ?? 'E_NATIVE_READ_HOST', response?.error?.message ?? '读取宿主未返回成功结果；不会自动重试。');
    return response.result;
  }
  const rpc = (method, params = []) => invoke('rpc', { name: NATIVE_READ_SCRIPT, method, params });
  const descriptor = await read(tokenFile);
  const host = await invoke('status', {});
  if (!descriptor || descriptor.host !== '127.0.0.1' || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !isHash(descriptor.token) || !host || host.status !== 'ready' || host.attached !== true || host.verified !== true || !Number.isSafeInteger(host.pid) || host.pid < 1 || host.pid !== descriptor.pid || !UUID.test(host.generation ?? '') || host.generation !== descriptor.generation || !/^\d+\.\d+\.\d+\.\d+$/.test(host.version ?? '') || host.version !== descriptor.version || !sameHash(host.dllSha256, descriptor.dllSha256)) throw failure('E_NATIVE_READ_GENERATION', '读取宿主未就绪，或其地址、PID、代次、版本与哈希描述不一致。');
  const profile = await read(profileFile ?? resolve(workspace, 'profiles', `${host.version}.json`));
  if (!profile || profile.version !== host.version || profile.architecture !== 'x64' || !sameHash(profile.dllSha256, host.dllSha256)) throw failure('E_NATIVE_READ_HASH', '当前版本 profile、x64 架构或 DLL SHA-256 与读取宿主不匹配。');
  const source = await readAgent(resolve(workspace, 'agents/read-native.js'));
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 1024 * 1024) throw failure('E_NATIVE_READ_SOURCE', '读取 agent 源码格式或大小无效。');
  const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  if (!Array.isArray(host.scripts)) throw failure('E_NATIVE_READ_SCRIPT_STATE', '宿主未提供可验证的已加载脚本列表。');
  const existing = host.scripts.filter(script => script.name === NATIVE_READ_SCRIPT);
  if (existing.length > 1 || (existing.length === 1 && (existing[0].loaded !== true || existing[0].destroyed !== false))) throw failure('E_NATIVE_READ_SCRIPT_STATE', '同名读取脚本已存在但失效；不会自动卸载或覆盖。');
  if (existing.length && !sameHash(existing[0].sourceSha256, sourceSha256)) throw failure('E_NATIVE_READ_SOURCE', '同名已加载脚本与当前 read-native.js 源哈希不一致；不会覆盖或卸载。');
  const agent = existing[0] ?? await invoke('load', { name: NATIVE_READ_SCRIPT, path: 'agents/read-native.js' });
  if (!agent || agent.name !== NATIVE_READ_SCRIPT || agent.loaded !== true || agent.destroyed === true || !sameHash(agent.sourceSha256, sourceSha256)) throw failure('E_NATIVE_READ_SOURCE', '实际加载的读取脚本与当前源哈希或名称不匹配。');
  let runtime = await rpc('inspect');
  requireIdentity(runtime, host);
  if (runtime.generation === null && runtime.ready === false && runtime.accountVerified === false && runtime.readScopeVerified === false && runtime.self === null) {
    runtime = await rpc('prepare', [{ pid: host.pid, generation: host.generation, dllSha256: host.dllSha256.toLowerCase() }]);
  }
  requirePrepared(runtime, host);
  const account = await rpc('account');
  if (!account || account.pid !== host.pid || account.generation !== host.generation || account.self !== runtime.self || account.scope !== 'current-account' || account.source !== 'reverse-native' || account.accountVerified !== true || account.automaticMessagesSent !== 0 || !isName(account.displayName)) throw failure('E_NATIVE_ACCOUNT_UNVERIFIED', '准备流程的本人账户结果尚未验证。');
  const contacts = await rpc('contacts');
  requireContactSnapshot(contacts, runtime);
  if (contacts.self !== account.self || contacts.automaticMessagesSent !== 0) throw failure('E_CONTACT_SNAPSHOT', '准备流程的联系人快照账户或只读状态无效。');
  const history = await rpc('history', [{ to: account.self, limit: 1 }]);
  requireHistory(history, host, account.self);
  runtime = await rpc('inspect');
  requirePrepared(runtime, host);
  if (runtime.self !== account.self || runtime.historyAvailable !== true) throw failure('E_NATIVE_HISTORY_UNVERIFIED', '实际本人历史查询后，agent 仍未确认本次运行的 history ABI 验证。');
  return {
    source: 'reverse-native', prepared: true, ready: true, pid: host.pid, generation: host.generation,
    version: host.version, dllSha256: host.dllSha256, agentSourceSha256: sourceSha256,
    self: account.self, displayName: account.displayName, accountVerified: true, readScopeVerified: true,
    scope: 'current-account', contactCount: contacts.count, historyAvailable: true,
    historyValidation: { to: account.self, limit: 1 }, automaticMessagesSent: 0,
  };
}

export async function runNativeReadBootstrap(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') {
      process.stdout.write('node src/native-read-bootstrap.mjs [--token-file FILE] [--profile FILE]\nPrepares the read agent in an already ready native-read host, then verifies account, contacts and one self-history query. No messages are sent.\n');
      return;
    }
    if (flag === '--no-redact') { options.redact = false; continue; }
    if (!['--token-file', '--profile'].includes(flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw failure('E_ARGUMENT', '可选参数：--token-file FILE、--profile FILE、--no-redact。');
    const key = flag === '--token-file' ? 'tokenFile' : 'profileFile';
    if (Object.hasOwn(options, key)) throw failure('E_ARGUMENT', '读取准备参数不能重复指定。');
    options[key] = argv[++index];
  }
  process.stdout.write(`${createPrivacyFormatter({ enabled: options.redact !== false }).format(await bootstrapNativeRead(options))}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNativeReadBootstrap().catch(error => { process.stderr.write(`${createPrivacyFormatter().format({ success: false, error: { code: error.code ?? 'E_READ_BOOTSTRAP', message: error.message } })}\n`); process.exitCode = 1; });
}
