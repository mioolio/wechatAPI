import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, lstat, realpath, readdir, rename, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve, parse, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WxError } from './errors.mjs';
import { recipientAlias } from './recipient-registry.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../data/history-copies/', import.meta.url));
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_MESSAGES = 10000;
const MAX_EDITS = 10000;
const MAX_EVENTS = MAX_EDITS * 2;
const COPY_ID = /^c_[a-f0-9]{32}$/;
const CHANGE_ID = /^e_[a-f0-9]{32}$/;
const RECORD_ID = /^m_[a-f0-9]{16}$/;
const run = promisify(execFile);
let windowsSid;
const fail = (suffix, message) => { throw new WxError(`E_HISTORY_COPY_${suffix}`, message); };
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const rowId = (copyId, index) => `m_${hash(`${copyId}\0${index}`).slice(0, 16)}`;
const originalDigest = record => hash(JSON.stringify({
  copyId: record.copyId, accountId: record.accountId, chatId: record.chatId, displayName: record.displayName,
  originSource: record.originSource, createdAt: record.createdAt, originalMessages: record.originalMessages
}));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, required, optional = []) => isObject(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
function validString(value, maximumBytes, { empty = false, identifier = false } = {}) {
  return typeof value === 'string' && (empty || value.length > 0) && value.isWellFormed() && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= maximumBytes && (!identifier || (value.trim() === value && !/[\r\n]/.test(value)));
}
function identity(value) {
  if (!validString(value, 2048, { identifier: true }) || value.length > 512) fail('ARGUMENT', '身份和消息 ID 必须是有效、非空的完整字符串。');
  return value;
}
function textValue(value) {
  if (!validString(value, MAX_TEXT_BYTES, { empty: true })) fail('ARGUMENT', '正文必须是有效 Unicode 字符串，不含 NUL，且不超过 1 MiB。');
  return value;
}
function timeValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ARGUMENT', '时间必须是非负的毫秒安全整数。');
  return value;
}
function namedString(value, maximumBytes = 4096, empty = true) {
  if (!validString(value, maximumBytes, { empty })) fail('ARGUMENT', '名称或来源必须是长度受限的有效字符串。');
  return value;
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function canonicalMessage(input, chatId, source) {
  if (!isObject(input)) fail('ARGUMENT', '聊天记录必须由消息对象组成。');
  const message = {
    id: identity(input.id), chatId: identity(input.chatId),
    senderId: input.senderId == null ? null : identity(input.senderId),
    isSelf: input.isSelf == null ? null : input.isSelf,
    type: namedString(input.type, 256, false), text: textValue(input.text), timestamp: timeValue(input.timestamp),
    source: namedString(input.source ?? source, 512, false)
  };
  if (message.chatId !== chatId) fail('CHAT_MISMATCH', '导入消息属于其他会话，无法混入该本地副本。');
  if (message.isSelf !== null && typeof message.isSelf !== 'boolean') fail('ARGUMENT', '消息方向必须为布尔值或 null。');
  if (input.senderName !== undefined) message.senderName = namedString(input.senderName);
  return message;
}
const editable = message => ({ text: message.text, timestamp: message.timestamp });
const equalEditable = (left, right) => left.text === right.text && left.timestamp === right.timestamp;
function editableSnapshot(value) {
  if (!exactKeys(value, ['text', 'timestamp'])) fail('CORRUPT', '本地聊天副本的修改快照无效。');
  textValue(value.text); timeValue(value.timestamp);
}
function requireCopyId(value) {
  if (typeof value !== 'string' || !COPY_ID.test(value)) fail('ARGUMENT', '请输入有效的本地副本 ID。');
  return value;
}
function requireLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MESSAGES) fail('ARGUMENT', 'limit 必须在 1 至 10000 之间。');
  return value;
}
function requireRevision(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) fail('ARGUMENT', '预期版本必须是非负安全整数。');
}
function revisionMatches(record, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== record.revision) fail('REVISION_CONFLICT', '本地副本已发生修改，请重新读取版本后再编辑。');
}
async function protectDirectory(directory) {
  await chmod(directory, 0o700);
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  windowsSid ??= run(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 }).then(({ stdout }) => {
    const sid = stdout.trim();
    if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw Error('invalid SID');
    return sid;
  });
  const sid = await windowsSid;
  await run(join(systemRoot, 'System32', 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
}

/** Private, reversible local copies. This class never opens a Weixin database or sends messages. */
export class HistoryCopyStore {
  constructor({ root = DEFAULT_ROOT } = {}, dependencies = {}) {
    this.root = resolve(root);
    this.assertPrivateRoot(this.root);
    this.openImpl = dependencies.openImpl ?? open;
    this.renameImpl = dependencies.renameImpl ?? rename;
    this.linkImpl = dependencies.linkImpl ?? link;
    this.randomUUIDImpl = dependencies.randomUUIDImpl ?? randomUUID;
    this.nowImpl = dependencies.nowImpl ?? (() => new Date());
    this.protectDirectoryImpl = dependencies.protectDirectoryImpl ?? protectDirectory;
    this.lockTimeoutMs = dependencies.lockTimeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 0 || this.lockTimeoutMs > 60000) fail('ARGUMENT', '文件锁等待时间无效。');
    this.prepared = null;
  }
  assertPrivateRoot(root) {
    const normalizedRoot = root.toLowerCase();
    const profileRoot = process.env.USERPROFILE;
    const forbiddenRoots = [parse(root).root, fileURLToPath(new URL('../', import.meta.url)), process.cwd(),
      ...(profileRoot ? [profileRoot, join(profileRoot, 'Desktop'), join(profileRoot, 'Documents'), join(profileRoot, 'Downloads')] : [])];
    if (forbiddenRoots.some(value => resolve(value).toLowerCase() === normalizedRoot) || root.split(/[\\/]+/).some(value => ['db_storage', 'xwechat_files', 'wechat files'].includes(value.toLowerCase()))) fail('PATH', '请使用专门的本地聊天副本目录，不得使用盘根、工作区根或微信数据库目录。');
  }
  fileFor(copyId) { return join(this.root, `${requireCopyId(copyId)}.json`); }
  generatedId(prefix) {
    const uuid = this.randomUUIDImpl();
    if (typeof uuid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uuid)) fail('STORE', '无法生成有效的本地记录标识。');
    return `${prefix}_${uuid.replaceAll('-', '')}`;
  }
  timestamp(previous) {
    try {
      const supplied = this.nowImpl();
      const value = supplied instanceof Date ? supplied.getTime() : typeof supplied === 'number' ? supplied : Date.parse(supplied);
      if (!Number.isSafeInteger(value) || value < 0) throw Error('invalid timestamp');
      const result = new Date(Math.max(value, previous === undefined ? 0 : Date.parse(previous))).toISOString();
      if (!validDate(result)) throw Error('invalid date');
      return result;
    } catch { fail('STORE', '无法获得有效的本地修改时间。'); }
  }
  async safeRoot({ missing = false } = {}) {
    const paths = [];
    for (let current = this.root; ; current = dirname(current)) {
      paths.unshift(current);
      if (current === parse(current).root) break;
    }
    let absent = false, nearestExisting;
    for (const path of paths) {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) fail('PATH', '本地副本目录不得经过符号链接或重解析路径。');
        nearestExisting = path;
      } catch (error) {
        if (error.code === 'ENOENT' && missing) { absent = true; continue; }
        if (error instanceof WxError) throw error;
        fail('PATH', '无法安全访问本地副本目录。');
      }
    }
    // Check links using the supplied spelling before resolving legitimate Windows 8.3 aliases.
    // Canonicalizing first would erase evidence of a directory junction in an ancestor.
    try {
      const canonical = resolve(await realpath(nearestExisting), relative(nearestExisting, this.root));
      this.assertPrivateRoot(canonical);
      this.root = canonical;
    } catch (error) {
      if (error instanceof WxError) throw error;
      fail('PATH', '无法确认本地副本目录的真实路径。');
    }
    return !absent;
  }
  async prepare() {
    if (!this.prepared) {
      this.prepared = (async () => {
        await this.safeRoot({ missing: true });
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await this.safeRoot();
        const entries = await readdir(this.root, { withFileTypes: true });
        if (entries.some(entry => !entry.isFile() || !/^c_[a-f0-9]{32}(?:\.json|\.lock|\.t_[a-f0-9]{32}\.tmp)$/.test(entry.name))) fail('PATH', '本地副本目录包含其他内容；请使用专门的副本目录。');
        await this.protectDirectoryImpl(this.root);
      })().catch(error => {
        this.prepared = null;
        if (error instanceof WxError) throw error;
        fail('STORE', '无法创建和保护本地聊天副本目录。');
      });
    }
    await this.prepared;
    await this.safeRoot();
  }
  async locked(copyId, callback) {
    requireCopyId(copyId);
    await this.prepare();
    const lockPath = join(this.root, `${copyId}.lock`), deadline = Date.now() + this.lockTimeoutMs;
    let handle, lockIdentity;
    while (!handle) {
      try { handle = await this.openImpl(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') fail('STORE', '无法锁定本地聊天副本。');
        const info = await lstat(lockPath).catch(() => null);
        if (info && (!info.isFile() || info.isSymbolicLink())) fail('PATH', '本地副本锁文件不是普通文件。');
        if (Date.now() >= deadline) fail('BUSY', '本地副本正在修改，或上次操作留下了锁；请稍后重试。');
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
        await this.safeRoot();
      }
    }
    try {
      lockIdentity = await handle.stat({ bigint: true });
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.sync();
      return await callback();
    } catch (error) {
      if (error instanceof WxError) throw error;
      fail('STORE', '本地聊天副本未能可靠保存；请重新读取后检查状态。');
    } finally {
      await handle.close().catch(() => {});
      const remaining = await lstat(lockPath, { bigint: true }).catch(() => null);
      if (remaining && lockIdentity && remaining.dev === lockIdentity.dev && remaining.ino === lockIdentity.ino && remaining.isFile() && !remaining.isSymbolicLink()) await unlink(lockPath).catch(() => {});
    }
  }
  replay(record, copyId) {
    try {
      if (!exactKeys(record, ['version', 'copyId', 'accountId', 'chatId', 'displayName', 'originSource', 'createdAt', 'updatedAt', 'revision', 'originalHash', 'originalMessages', 'events'])
        || record.version !== 1 || record.copyId !== copyId || !COPY_ID.test(record.copyId)
        || !validDate(record.createdAt) || !validDate(record.updatedAt)
        || !Number.isSafeInteger(record.revision) || record.revision < 0
        || !Array.isArray(record.originalMessages) || record.originalMessages.length > MAX_MESSAGES
        || !Array.isArray(record.events) || record.events.length > MAX_EVENTS || record.revision !== record.events.length
        || typeof record.originalHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.originalHash)) fail('CORRUPT', '本地聊天副本格式无效。');
      identity(record.accountId); identity(record.chatId); namedString(record.displayName); namedString(record.originSource, 512, false);
      const current = new Map(), active = new Map(), edits = new Map(), eventIds = new Set(), undone = new Set();
      record.originalMessages.forEach((message, index) => {
        if (!exactKeys(message, ['recordId', 'id', 'chatId', 'senderId', 'isSelf', 'type', 'text', 'timestamp', 'source'], ['senderName'])
          || message.recordId !== rowId(copyId, index) || !RECORD_ID.test(message.recordId) || current.has(message.recordId)
          || JSON.stringify(message) !== JSON.stringify({ recordId: message.recordId, ...canonicalMessage(message, record.chatId, record.originSource) })) fail('CORRUPT', '本地聊天副本的原始消息无效。');
        current.set(message.recordId, { ...message });
        active.set(message.recordId, []);
      });
      if (record.originalHash !== originalDigest(record)) fail('CORRUPT', '本地聊天副本原始记录及来源校验失败。');
      let previousAt = record.createdAt, editCount = 0;
      record.events.forEach((event, index) => {
        if (!exactKeys(event, ['id', 'kind', 'recordId', 'messageId', 'before', 'after', 'revision', 'createdAt'], ['targetChangeId'])
          || !CHANGE_ID.test(event.id) || eventIds.has(event.id) || !['edit', 'undo'].includes(event.kind)
          || !RECORD_ID.test(event.recordId) || !current.has(event.recordId) || event.revision !== index + 1
          || !validDate(event.createdAt) || event.createdAt < previousAt) fail('CORRUPT', '本地聊天副本审计记录无效。');
        eventIds.add(event.id); previousAt = event.createdAt;
        editableSnapshot(event.before); editableSnapshot(event.after);
        const message = current.get(event.recordId), stack = active.get(event.recordId);
        if (event.messageId !== message.id || !equalEditable(event.before, message)) fail('CORRUPT', '本地聊天副本审计与消息不一致。');
        if (event.kind === 'edit') {
          if (++editCount > MAX_EDITS) fail('CORRUPT', '本地聊天副本编辑次数超过限制。');
          if (event.targetChangeId !== undefined) fail('CORRUPT', '本地聊天副本编辑事件格式无效。');
          edits.set(event.id, event); stack.push(event);
        } else {
          const target = stack.at(-1);
          if (!CHANGE_ID.test(event.targetChangeId) || !target || target.id !== event.targetChangeId || !equalEditable(event.after, target.before)) fail('CORRUPT', '本地聊天副本撤销顺序无效。');
          undone.add(target.id); stack.pop();
        }
        message.text = event.after.text; message.timestamp = event.after.timestamp;
      });
      if (record.updatedAt !== previousAt) fail('CORRUPT', '本地聊天副本修改时间与审计不一致。');
      return { current, active, edits, undone };
    } catch { fail('CORRUPT', '本地聊天副本已损坏或格式不受支持；无法读取或修改。'); }
  }
  async load(copyId) {
    if (!await this.safeRoot({ missing: true })) fail('NOT_FOUND', '找不到指定的本地聊天副本。');
    const path = this.fileFor(copyId);
    let handle;
    try {
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) fail('PATH', '本地聊天副本必须是普通文件。');
      if (info.size < 1n || info.size > BigInt(MAX_FILE_BYTES)) fail('CORRUPT', '本地聊天副本大小无效。');
      handle = await this.openImpl(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) fail('CORRUPT', '无法确认本地聊天副本读取的一致性。');
      // Even if a file grows after stat, only the advertised size plus one byte is allocated/read.
      const buffer = Buffer.allocUnsafe(Number(opened.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const finished = await handle.stat({ bigint: true });
      if (BigInt(length) !== opened.size || length > MAX_FILE_BYTES || finished.size !== opened.size || finished.mtimeNs !== opened.mtimeNs) fail('CORRUPT', '本地聊天副本已变化、截断或超过大小限制。');
      const bytes = buffer.subarray(0, length);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes), record = JSON.parse(content);
      if (content !== `${JSON.stringify(record)}\n`) fail('CORRUPT', '本地聊天副本编码或格式无效。');
      const state = this.replay(record, copyId);
      if (bytes.length + this.undoReserveBytes(state) > MAX_FILE_BYTES) fail('CORRUPT', '本地聊天副本未保留足够的撤销空间。');
      return { record, state };
    } catch (error) {
      if (error.code === 'ENOENT') fail('NOT_FOUND', '找不到指定的本地聊天副本。');
      if (error instanceof WxError) throw error;
      fail('CORRUPT', '本地聊天副本不可读或已损坏；无法读取或修改。');
    } finally { await handle?.close().catch(() => {}); }
  }
  async save(record, { initial = false } = {}) {
    const bytes = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(bytes, 'utf8') > MAX_FILE_BYTES) fail('SIZE', '本地聊天副本及审计超过 64 MiB，无法保存此次修改。');
    if (record.events.length > MAX_EVENTS) fail('SIZE', '本地副本修改次数已达到上限。');
    const state = this.replay(record, record.copyId);
    if (Buffer.byteLength(bytes, 'utf8') + this.undoReserveBytes(state) > MAX_FILE_BYTES) fail('SIZE', '本地副本没有足够的修改和撤销空间；此次修改未保存。');
    await this.safeRoot();
    const path = this.fileFor(record.copyId), temporary = join(this.root, `${record.copyId}.${this.generatedId('t')}.tmp`);
    let handle;
    try {
      handle = await this.openImpl(temporary, 'wx', 0o600);
      await handle.writeFile(bytes, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await this.safeRoot();
      if (initial) await this.linkImpl(temporary, path);
      else {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) fail('PATH', '拒绝覆盖非普通本地副本文件。');
        await this.renameImpl(temporary, path);
      }
      if (process.platform !== 'win32') {
        const directory = await open(this.root, constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      if (error instanceof WxError) throw error;
      if (initial && error.code === 'EEXIST') fail('COLLISION', '本地副本 ID 已存在；不会覆盖原有副本。');
      fail('STORE', '本地聊天副本未能可靠保存；请重新读取后检查状态。');
    } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  }
  summary(record, state) {
    const activeEditCount = [...state.active.values()].reduce((total, stack) => total + stack.length, 0);
    return {
      source: 'local-history-copy', localOnly: true, copyId: record.copyId,
      accountAlias: recipientAlias(record.accountId), chatAlias: recipientAlias(record.chatId), displayName: record.displayName,
      origin: { source: record.originSource, localOnly: true }, revision: record.revision,
      messageCount: record.originalMessages.length, activeEditCount, edited: activeEditCount > 0,
      changeCount: record.events.length, createdAt: record.createdAt, updatedAt: record.updatedAt
    };
  }
  undoReserveBytes(state) {
    let bytes = 0, count = 0;
    for (const stack of state.active.values()) for (const event of stack) {
      count++;
      // Every saved edit reserves a full future undo event, including escaped text and long IDs.
      bytes += Buffer.byteLength(JSON.stringify({
        id: `e_${'0'.repeat(32)}`, kind: 'undo', recordId: event.recordId, messageId: event.messageId,
        before: event.after, after: event.before, revision: MAX_EVENTS, createdAt: '9999-12-31T23:59:59.999Z', targetChangeId: event.id
      }), 'utf8') + 1;
    }
    return count === 0 ? 0 : bytes + 32;
  }
  sortedMessages(state) {
    return [...state.current.values()].sort((left, right) => left.timestamp < right.timestamp ? -1 : left.timestamp > right.timestamp ? 1 : 0).map(message => ({
      ...message, source: 'local-history-copy', localOnly: true,
      origin: { source: message.source, localOnly: true }, edited: state.active.get(message.recordId).length > 0
    }));
  }
  async create({ accountId, chatId, displayName = '', messages, source = 'unknown' } = {}) {
    identity(accountId); identity(chatId); namedString(displayName); namedString(source, 512, false);
    if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) fail('ARGUMENT', '聊天副本需要至多 10000 条消息。');
    const copyId = this.generatedId('c'), createdAt = this.timestamp();
    let originalBytes = 0;
    const originalMessages = Array.from(messages, (message, index) => {
      const canonical = { recordId: rowId(copyId, index), ...canonicalMessage(message, chatId, source) };
      originalBytes += Buffer.byteLength(JSON.stringify(canonical), 'utf8') + 1;
      if (originalBytes > MAX_FILE_BYTES) fail('SIZE', '本地聊天副本超过 64 MiB，无法导入。');
      return canonical;
    });
    const record = { version: 1, copyId, accountId, chatId, displayName, originSource: source, createdAt, updatedAt: createdAt, revision: 0, originalHash: '', originalMessages, events: [] };
    record.originalHash = originalDigest(record);
    // Validate and snapshot inputs before the first await; caller mutations cannot change the import.
    const state = this.replay(record, copyId);
    return this.locked(copyId, async () => { await this.save(record, { initial: true }); return this.summary(record, state); });
  }
  async list() {
    if (!await this.safeRoot({ missing: true })) return { source: 'local-history-copy', localOnly: true, copies: [] };
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch { fail('STORE', '无法列出本地聊天副本。'); }
    const copies = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      if (!/^c_[a-f0-9]{32}\.json$/.test(entry.name)) fail('CORRUPT', '本地副本目录包含无法识别的记录文件。');
      const { record, state } = await this.load(entry.name.slice(0, -5));
      copies.push(this.summary(record, state));
    }
    copies.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.copyId.localeCompare(right.copyId));
    return { source: 'local-history-copy', localOnly: true, copies };
  }
  async show({ copyId, limit = 30 } = {}) {
    requireCopyId(copyId); requireLimit(limit);
    const { record, state } = await this.load(copyId);
    return { ...this.summary(record, state), messages: this.sortedMessages(state).slice(-limit) };
  }
  async edit(input = {}) {
    if (!exactKeys(input, ['copyId'], ['recordId', 'messageId', 'text', 'timestamp', 'expectedRevision'])) fail('ARGUMENT', '仅允许修改指定消息的正文和时间。');
    const { copyId, recordId, messageId, text, timestamp, expectedRevision } = input;
    requireCopyId(copyId); requireRevision(expectedRevision);
    if ((recordId !== undefined) === (messageId !== undefined)) fail('ARGUMENT', '请在 recordId 与 messageId 中选择一种消息标识。');
    if (recordId !== undefined && (typeof recordId !== 'string' || !RECORD_ID.test(recordId))) fail('ARGUMENT', '本地消息记录 ID 无效。');
    if (messageId !== undefined) identity(messageId);
    if (text === undefined && timestamp === undefined) fail('ARGUMENT', '至少提供正文或时间中的一项修改。');
    if (text !== undefined) textValue(text);
    if (timestamp !== undefined) timeValue(timestamp);
    return this.locked(copyId, async () => {
      const { record, state } = await this.load(copyId);
      revisionMatches(record, expectedRevision);
      if (state.edits.size >= MAX_EDITS) fail('SIZE', '本地副本编辑次数已达到上限；已有修改仍可撤销。');
      const matches = [...state.current.values()].filter(message => recordId !== undefined ? message.recordId === recordId : message.id === messageId);
      if (matches.length > 1) fail('MESSAGE_AMBIGUOUS', '多条消息具有相同原始 ID；请使用唯一的 recordId 进行编辑。');
      if (!matches.length) fail('MESSAGE_NOT_FOUND', '该消息不属于指定本地副本。');
      const message = matches[0], changeId = this.generatedId('e'), createdAt = this.timestamp(record.updatedAt);
      if (record.events.some(event => event.id === changeId)) fail('COLLISION', '修改记录 ID 已存在，无法保存此次修改。');
      const event = { id: changeId, kind: 'edit', recordId: message.recordId, messageId: message.id, before: editable(message), after: { text: text ?? message.text, timestamp: timestamp ?? message.timestamp }, revision: record.revision + 1, createdAt };
      record.events.push(event); record.revision++; record.updatedAt = createdAt;
      await this.save(record);
      return { ...this.summary(record, this.replay(record, copyId)), changeId, recordId: message.recordId, messageId: message.id };
    });
  }
  async changes({ copyId, limit = 30 } = {}) {
    requireCopyId(copyId); requireLimit(limit);
    const { record, state } = await this.load(copyId);
    const changes = record.events.slice(-limit).map(event => ({
      changeId: event.id, kind: event.kind, recordId: event.recordId, messageId: event.messageId,
      before: { ...event.before }, after: { ...event.after }, revision: event.revision, createdAt: event.createdAt,
      ...(event.kind === 'edit' ? { undone: state.undone.has(event.id) } : { targetChangeId: event.targetChangeId })
    }));
    return { ...this.summary(record, state), changes };
  }
  async undo({ copyId, changeId, expectedRevision } = {}) {
    requireCopyId(copyId); requireRevision(expectedRevision);
    if (changeId !== undefined && (typeof changeId !== 'string' || !CHANGE_ID.test(changeId))) fail('ARGUMENT', '修改记录 ID 无效。');
    return this.locked(copyId, async () => {
      const { record, state } = await this.load(copyId);
      revisionMatches(record, expectedRevision);
      const activeEdits = [...state.active.values()].flat();
      const target = changeId === undefined ? activeEdits.reduce((latest, event) => !latest || event.revision > latest.revision ? event : latest, null) : state.edits.get(changeId);
      if (!target || state.undone.has(target.id)) fail('UNDO_NOT_FOUND', '没有可撤销的活动修改。');
      if (state.active.get(target.recordId).at(-1)?.id !== target.id) fail('UNDO_ORDER', '该消息还有后续修改；请先撤销同消息的最近修改。');
      const message = state.current.get(target.recordId), undoId = this.generatedId('e'), createdAt = this.timestamp(record.updatedAt);
      if (record.events.some(event => event.id === undoId)) fail('COLLISION', '修改记录 ID 已存在，无法保存此次撤销。');
      record.events.push({ id: undoId, kind: 'undo', recordId: message.recordId, messageId: message.id, before: editable(message), after: { ...target.before }, revision: record.revision + 1, createdAt, targetChangeId: target.id });
      record.revision++; record.updatedAt = createdAt;
      await this.save(record);
      return { ...this.summary(record, this.replay(record, copyId)), undoId, changeId: target.id, recordId: message.recordId, messageId: message.id };
    });
  }
  async exportData({ copyId } = {}) {
    requireCopyId(copyId);
    const { record, state } = await this.load(copyId);
    return { ...this.summary(record, state), messages: this.sortedMessages(state) };
  }
}
