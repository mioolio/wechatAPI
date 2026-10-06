import { readFile, stat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { recipientAlias } from './recipient-registry.mjs';
import { WxError } from './errors.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_NATIVE_TARGET_FILE = resolve(WORKSPACE, 'data/native-target.json');
export const isIndividualId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(value) && !value.startsWith('gh_') && !/^u_[a-f0-9]{16}$/.test(value) && !new Set(['filehelper', 'weixin', 'newsapp', 'fmessage', 'medianote', 'qqmail', 'qmessage', 'tmessage', 'floatbottle', 'shakeapp', 'facebookapp', 'feedsapp', 'voiceinputapp', 'notification_messages', 'brandsessionholder']).has(value);
const isName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && value.isWellFormed() && !/[\0\r\n]/.test(value);
const isGeneration = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const fields = new Set(['schemaVersion', 'chatId', 'displayName', 'self', 'sourcePid', 'sourceGeneration', 'version', 'dllSha256']);

/** Local explicit authorization for one individual, scoped to the account that created it. */
export function requireNativeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 2 || Object.keys(value).some(key => !fields.has(key)) || !isIndividualId(value.chatId) || !isIndividualId(value.self) || !isName(value.displayName) || value.chatId === value.displayName || !Number.isSafeInteger(value.sourcePid) || value.sourcePid < 1 || !isGeneration(value.sourceGeneration) || !/^\d+\.\d+\.\d+\.\d+$/.test(value.version ?? '') || !isHash(value.dllSha256)) throw new WxError('E_NATIVE_TARGET', '单目标授权配置缺失或无效；先读取当前账号及联系人，再用 configure-target --to 精确 ID 或已登记编号配置。');
  return { schemaVersion: 2, chatId: value.chatId, displayName: value.displayName, self: value.self, sourcePid: value.sourcePid, sourceGeneration: value.sourceGeneration, version: value.version, dllSha256: value.dllSha256.toLowerCase() };
}

export async function readNativeTarget(path = DEFAULT_NATIVE_TARGET_FILE) {
  let value;
  try {
    if ((await stat(path)).size > 16384) throw new Error('oversized');
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new WxError('E_NATIVE_TARGET', '缺少可用的本机单目标授权；运行 configure-target --to 精确 ID 或已登记编号。该命令只保存授权，不发送消息。'); }
  return requireNativeTarget(value);
}

export async function saveNativeTarget(path, value) {
  const target = requireNativeTarget(value);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(target, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
  return target;
}

/** No host is imported or called here; callers supply a freshly verified read snapshot. */
export async function configureNativeTarget({ to, displayName, targetFile = DEFAULT_NATIVE_TARGET_FILE } = {}, { registry, currentReadAccount, currentContacts, saveTargetImpl = saveNativeTarget } = {}) {
  const account = currentReadAccount, snapshot = currentContacts;
  if (!account || account.accountVerified !== true || account.readScopeVerified !== true || account.automaticMessagesSent !== 0 || !isIndividualId(account.self) || !Number.isSafeInteger(account.pid) || account.pid < 1 || !isGeneration(account.generation) || !isHash(account.dllSha256) || !/^\d+\.\d+\.\d+\.\d+$/.test(account.version ?? '') || !snapshot || snapshot.pid !== account.pid || snapshot.generation !== account.generation || snapshot.self !== account.self || snapshot.version !== account.version || snapshot.scope !== 'loaded-contact-cache' || snapshot.complete !== false || snapshot.automaticMessagesSent !== 0 || !Array.isArray(snapshot.users) || snapshot.users.length > 4096) throw new WxError('E_NATIVE_TARGET_SCOPE', '配置需要同一当前账号、PID、代次和版本的已验证只读联系人快照。');
  let chatId = to;
  if (typeof to === 'string' && /^u_[a-f0-9]{16}$/.test(to)) {
    if (!registry?.read || !registry?.resolve) throw new WxError('E_RECIPIENT_UNKNOWN', '编号未登记；先运行 ids。');
    await registry.read();
    chatId = registry.resolve(to);
  }
  if (!isIndividualId(chatId)) throw new WxError('E_CHAT_SCOPE', '发送授权只支持精确的个人用户 ID 或已登记编号，不支持昵称、群组、公众号或服务会话。');
  const seen = new Set();
  let contact;
  for (const row of snapshot.users) {
    if (!row || typeof row.chatId !== 'string' || !/^[A-Za-z0-9_.:@-]{1,256}$/.test(row.chatId) || seen.has(row.chatId) || !isName(row.displayName) || (row.alias !== undefined && row.alias !== recipientAlias(row.chatId))) throw new WxError('E_NATIVE_TARGET_SCOPE', '联系人快照存在无效或重复记录；不会保存部分授权。');
    seen.add(row.chatId);
    if (row.chatId === chatId) contact = row;
  }
  if (!contact || (displayName !== undefined && displayName !== contact.displayName) || contact.isGroup === true || contact.isOfficial === true || contact.kind === 'group' || contact.kind === 'official') throw new WxError('E_CHAT_SCOPE', '目标不在当前精确联系人快照中，名称不符，或不是个人联系人；不会按昵称猜测。');
  const target = requireNativeTarget({ schemaVersion: 2, chatId, displayName: contact.displayName, self: account.self, sourcePid: account.pid, sourceGeneration: account.generation, version: account.version, dllSha256: account.dllSha256 });
  await saveTargetImpl(targetFile, target);
  return { source: 'local-native-target', configured: true, chatId, displayName: target.displayName, self: target.self, alias: recipientAlias(chatId), automaticMessagesSent: 0, requiresFreshSendBinding: true };
}
