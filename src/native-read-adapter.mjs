import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callPersistentHost } from './native-runtime-client.mjs';
import { RecipientRegistry, recipientAlias } from './recipient-registry.mjs';
import { WxError } from './errors.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
export const NATIVE_READ_SCRIPT = 'readnative_live3';
const isGeneration = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,256}$/.test(value);
const isName = value => typeof value === 'string' && value.length <= 4096 && value.isWellFormed() && !value.includes('\0');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const sameHash = (left, right) => isHash(left) && isHash(right) && left.toLowerCase() === right.toLowerCase();
const isIntegerToken = value => typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const error = (code, message) => new WxError(code, message);

async function readJsonFile(path) {
  try {
    if ((await stat(path)).size > 65536) throw new Error('oversized');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { throw error('E_NATIVE_READ_CONFIG', '原生读取宿主描述文件缺失、过大或格式错误。'); }
}

/** Validate the complete cache snapshot before any registration or native history request. */
export function requireContactSnapshot(snapshot, runtime) {
  if (!snapshot || snapshot.pid !== runtime.pid || snapshot.generation !== runtime.generation || snapshot.scope !== 'loaded-contact-cache' || snapshot.complete !== false || snapshot.cacheSnapshotComplete !== true || !Array.isArray(snapshot.contacts) || snapshot.count !== snapshot.contacts.length || snapshot.count > 4096) throw error('E_CONTACT_SNAPSHOT', '原生联系人快照范围、代次或完整性校验失败。');
  const ids = new Set();
  for (const row of snapshot.contacts) {
    if (!row || !isId(row.username) || ids.has(row.username) || !isName(row.displayName)) throw error('E_CONTACT_SNAPSHOT', '原生联系人 ID 或名称校验失败；不会保存部分结果。');
    ids.add(row.username);
  }
  return ids;
}

function requireAccount(result, runtime) {
  if (!result || result.pid !== runtime.pid || result.generation !== runtime.generation || result.source !== 'reverse-native' || result.scope !== 'current-account' || result.self !== runtime.self || !isName(result.displayName) || result.accountVerified !== true || result.automaticMessagesSent !== 0) throw error('E_NATIVE_ACCOUNT_UNVERIFIED', '本人账户结果未通过当前运行代次与结构校验。');
  return result;
}

function normalizeHistoryMessage(row, { self, chatId }) {
  if (!row || !isIntegerToken(row.serverId) || !isIntegerToken(row.type) || !isIntegerToken(row.createTime) || typeof row.content !== 'string' || row.content.length > 1024 * 1024 || !row.content.isWellFormed() || typeof row.senderUsername !== 'string' || (row.senderUsername && !isId(row.senderUsername)) || (row.senderName !== undefined && !isName(row.senderName)) || (row.subType !== undefined && !isIntegerToken(row.subType))) throw error('E_NATIVE_HISTORY_SCHEMA', '原生历史消息字段尚未通过严格结构校验。');
  const milliseconds = BigInt(row.createTime) * 1000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw error('E_NATIVE_HISTORY_SCHEMA', '消息时间超出可精确表示的毫秒范围。');
  return {
    serverId: row.serverId, createTime: row.createTime, content: row.content, senderUsername: row.senderUsername,
    ...(row.senderName === undefined ? {} : { senderName: row.senderName }),
    ...(row.subType === undefined ? {} : { subType: row.subType }),
    id: row.serverId, chatId, senderId: row.senderUsername || null,
    isSelf: row.senderUsername ? row.senderUsername === self : null,
    type: row.type, text: row.content, timestamp: Number(milliseconds), source: 'reverse-native',
    ...(row.senderUsername ? {} : { direction: 'unknown' }),
  };
}

/** Reuses a verified already loaded host; never attaches, loads, unloads, or sends. */
export class NativeReadAdapter {
  constructor({ tokenFile = resolve(WORKSPACE, 'data/native-read-host.json'), recipientsFile = resolve(WORKSPACE, 'data/recipients.json'), registry, callImpl = callPersistentHost, readJsonImpl = readJsonFile } = {}) {
    this.tokenFile = tokenFile;
    this.registry = registry ?? new RecipientRegistry({ filePath: recipientsFile });
    this.callImpl = callImpl;
    this.readJsonImpl = readJsonImpl;
    this.contactsCache = null;
  }

  async call(method, args) {
    const response = await this.callImpl({ tokenFile: this.tokenFile, method, args });
    if (response?.success !== true) throw error(response?.error?.code ?? 'E_NATIVE_READ_HOST', response?.error?.message ?? '常驻原生读取宿主未返回成功结果；不会自动重试。');
    return response.result;
  }

  rpc(method, params = []) { return this.call('rpc', { name: NATIVE_READ_SCRIPT, method, params }); }

  async inspect() {
    const descriptor = await this.readJsonImpl(this.tokenFile);
    if (!descriptor || descriptor.host !== '127.0.0.1' || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 || !isGeneration(descriptor.generation) || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !isHash(descriptor.token) || typeof descriptor.version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(descriptor.version) || !isHash(descriptor.dllSha256)) throw error('E_NATIVE_READ_CONFIG', '读取宿主描述的地址、代次、版本或 DLL 校验信息无效。');
    const host = await this.call('status', {});
    if (!host || host.pid !== descriptor.pid || host.generation !== descriptor.generation || host.attached !== true || host.verified !== true || host.status !== 'ready') throw error('E_NATIVE_READ_GENERATION', '读取宿主未就绪，或 PID 与运行代次已变化。');
    if (host.version !== descriptor.version || !sameHash(host.dllSha256, descriptor.dllSha256)) throw error('E_NATIVE_READ_VERSION', '读取宿主版本或 DLL SHA-256 与描述不匹配。');
    const runtime = await this.rpc('inspect');
    if (!runtime || runtime.pid !== host.pid || runtime.generation !== host.generation || runtime.version !== host.version || !sameHash(runtime.dllSha256, host.dllSha256)) throw error('E_NATIVE_READ_GENERATION', '原生读取 agent 的身份、版本或 DLL SHA-256 与宿主不匹配。');
    if (runtime.accountVerified !== true || runtime.readScopeVerified !== true || runtime.ready !== true || runtime.automaticMessagesSent !== 0 || !isId(runtime.self) || runtime.self.includes('@chatroom') || runtime.self.startsWith('gh_')) throw error('E_NATIVE_READ_UNVERIFIED', '原生读取的本人账户、范围或只读状态尚未验证。');
    if ((runtime.pendingTasks ?? 0) !== 0 || (runtime.pendingCallbacks ?? 0) !== 0) throw error('E_NATIVE_READ_BUSY', '读取 agent 存在未完成的原生任务或回调；不会继续排队读取。');
    const key = JSON.stringify([runtime.pid, runtime.generation, runtime.self, runtime.dllSha256.toLowerCase()]);
    if (this.contactsCache?.key !== key) this.contactsCache = null;
    return { ...runtime, source: 'reverse-native', attached: true, historyAvailable: runtime.historyAvailable === true, ready: true };
  }

  async doctor() { return this.inspect(); }

  async account() {
    const runtime = await this.inspect();
    const result = requireAccount(await this.rpc('account'), runtime);
    const registered = await this.registry.register({ id: result.self, displayName: result.displayName });
    return { ...result, alias: registered.alias };
  }

  async accounts() {
    const current = await this.account();
    return { source: 'reverse-native', scope: 'current-account', accounts: [current], complete: false, accountVerified: true, automaticMessagesSent: 0 };
  }

  async contactSnapshot(runtime) {
    const key = JSON.stringify([runtime.pid, runtime.generation, runtime.self, runtime.dllSha256.toLowerCase()]);
    if (this.contactsCache?.key === key) return this.contactsCache;
    const snapshot = await this.rpc('contacts');
    const ids = requireContactSnapshot(snapshot, runtime);
    if (snapshot.self !== runtime.self || snapshot.automaticMessagesSent !== 0) throw error('E_CONTACT_SNAPSHOT', '联系人快照的本人账户或只读状态校验失败。');
    const users = [];
    await this.registry.read();
    const existing = new Map((typeof this.registry.list === 'function' ? this.registry.list({ includeIds: true }) : []).map(row => [row.id, row]));
    for (const row of snapshot.contacts) {
      const known = existing.get(row.username), alias = recipientAlias(row.username);
      // Short-lived CLI instances should not rewrite every unchanged mapping on each history query.
      const registered = known?.alias === alias && known.displayName === row.displayName
        ? { alias, displayName: row.displayName }
        : await this.registry.register({ id: row.username, displayName: row.displayName });
      users.push({ ...registered, chatId: row.username, canSend: false });
    }
    const cached = { key, ids, users: users.sort((left, right) => left.alias.localeCompare(right.alias)) };
    this.contactsCache = cached;
    return cached;
  }

  async ids({ keyword } = {}) {
    if (keyword !== undefined && (typeof keyword !== 'string' || keyword.length > 4096 || !keyword.isWellFormed())) throw error('E_ARGUMENT', 'keyword 必须是有效且长度受限的字符串。');
    const runtime = await this.inspect();
    const snapshot = await this.contactSnapshot(runtime);
    const users = snapshot.users.filter(row => !keyword || row.displayName.includes(keyword) || row.alias.includes(keyword) || row.chatId.includes(keyword));
    return { pid: runtime.pid, generation: runtime.generation, version: runtime.version, self: runtime.self, source: 'reverse-native', scope: 'loaded-contact-cache', complete: false, users, automaticMessagesSent: 0 };
  }

  async history({ to, limit = 30 } = {}) {
    if (!isId(to)) throw error('E_CHAT_TARGET', 'history 需要准确的稳定用户编号或当前已验证的会话 ID。');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw error('E_ARGUMENT', 'history limit 必须是 1 至 200 的整数。');
    const runtime = await this.inspect();
    if (runtime.historyAvailable !== true) throw error('E_NATIVE_HISTORY_UNVERIFIED', '当前运行代次的原生历史读取能力尚未验证。');
    let chatId = to;
    let snapshot;
    if (/^u_[a-f0-9]{16}$/.test(to)) {
      await this.registry.read();
      try { chatId = this.registry.resolve(to); }
      catch (failure) {
        if (failure?.code !== 'E_RECIPIENT_UNKNOWN') throw failure;
        snapshot = await this.contactSnapshot(runtime);
        await this.registry.read();
        chatId = this.registry.resolve(to);
      }
    }
    if (!isId(chatId)) throw error('E_CHAT_SCOPE', '编号未精确解析为已验证的真实会话 ID。');
    if (chatId !== runtime.self) {
      snapshot ??= await this.contactSnapshot(runtime);
      if (!snapshot.ids.has(chatId)) throw error('E_CHAT_SCOPE', '目标不在当前已验证的联系人快照中；不会按昵称或旧登记猜测。');
    }
    const result = await this.rpc('history', [{ to: chatId, limit }]);
    if (!result || result.pid !== runtime.pid || result.generation !== runtime.generation || result.self !== runtime.self || result.chatId !== chatId || result.source !== 'reverse-native' || result.schemaValidated !== true || result.automaticMessagesSent !== 0 || !Array.isArray(result.messages) || result.messages.length > limit) throw error('E_NATIVE_HISTORY_SCHEMA', '历史读取结果的会话、账户、运行代次或结构未通过校验。');
    const messages = result.messages.map(row => normalizeHistoryMessage(row, { self: runtime.self, chatId }));
    return { ...result, messages, historyAvailable: true };
  }

  async close() { /* The persistent host stays attached and loaded. */ }
}
