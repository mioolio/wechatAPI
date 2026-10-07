import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HistoryCopyStore } from './history-copy-store.mjs';
import { RecipientRegistry } from './recipient-registry.mjs';
import { createPrivacyFormatter } from './privacy.mjs';
import { WxError } from './errors.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const INPUT_LIMIT = 64 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;
const ACTIONS = new Set(['import', 'list', 'show', 'edit', 'changes', 'undo', 'export']);
const fail = (code, message) => { throw new WxError(code, message); };

function identity(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.@:-]{1,512}$/.test(value) && !/^u_[a-f0-9]{16}$/.test(value);
}
function textValue(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > TEXT_LIMIT) {
    fail('E_RECORD_TEXT', '正文必须是有效 Unicode 字符串，无 NUL，UTF-8 不超过 1 MiB；允许空正文。');
  }
  return value;
}
async function readText(filename, limit, code) {
  let file;
  try {
    file = await fs.open(filename, 'r');
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > limit) fail(code, '输入必须是大小受限的普通文件。');
    // Read at most limit+1 even when the file grows after stat().
    const bytes = Buffer.alloc(Math.min(metadata.size + 1, limit + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== metadata.size || (await file.stat()).size !== metadata.size) fail(code, '输入文件正在变化或超过大小限制；请使用稳定副本。');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } catch (error) {
    if (error instanceof WxError) throw error;
    fail(code, '无法读取有效 UTF-8 输入文件。');
  } finally { await file?.close().catch(() => fail(code, '输入文件未能正常关闭。')); }
}
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function liveDirectory(filename) {
  return filename.split(/[\\/]/).some(part => ['db_storage', 'xwechat_files', 'wechat files'].includes(part.toLowerCase()));
}

async function validateExportParent(parent, name, realWorkspace) {
  let ancestor = parent;
  const missing = [];
  while (true) {
    try {
      const information = await fs.stat(ancestor);
      if (!information.isDirectory()) fail('E_RECORD_OUTPUT', '导出父路径必须是目录。');
      const actualAncestor = await fs.realpath(ancestor);
      const candidate = path.join(actualAncestor, ...missing.reverse(), name);
      if (contained(realWorkspace, candidate) || liveDirectory(candidate)) fail('E_RECORD_OUTPUT_SCOPE', '导出请使用程序源码与微信数据目录之外的私有位置。');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(ancestor);
      if (next === ancestor) fail('E_RECORD_OUTPUT', '无法确认导出父目录。');
      missing.push(path.basename(ancestor));
      ancestor = next;
    }
  }
}

async function publishExport(output, data) {
  if (typeof output !== 'string' || !output.trim() || output.includes('\0')) fail('E_RECORD_OUTPUT', '导出需要明确的新文件路径。');
  const destination = path.resolve(output);
  if (contained(WORKSPACE, destination) || liveDirectory(destination)) fail('E_RECORD_OUTPUT_SCOPE', '导出请使用程序源码与微信数据目录之外的私有位置。');
  let folder, temporary, file;
  try {
    const parent = path.dirname(destination);
    const realWorkspace = await fs.realpath(WORKSPACE);
    // Resolve the nearest existing ancestor before mkdir: a junction into a
    // prohibited directory must be rejected before creating any child there.
    await validateExportParent(parent, path.basename(destination), realWorkspace);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const realParent = await fs.realpath(parent);
    const target = path.join(realParent, path.basename(destination));
    if (contained(realWorkspace, target) || liveDirectory(target)) fail('E_RECORD_OUTPUT_SCOPE', '导出请使用程序源码与微信数据目录之外的私有位置。');
    try { await fs.lstat(target); fail('E_RECORD_OUTPUT_EXISTS', '导出文件已存在，请指定新的文件名。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    folder = await fs.mkdtemp(path.join(realParent, '.wxcc-record-export-'));
    await fs.chmod(folder, 0o700);
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      try {
        const { stdout } = await run(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
        const sid = stdout.trim();
        if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('invalid SID');
        await run(path.join(systemRoot, 'System32', 'icacls.exe'), [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
      } catch { fail('E_RECORD_OUTPUT_PERMISSIONS', '无法保护导出文件的本机访问权限。'); }
    }
    temporary = path.join(folder, 'history.json');
    file = await fs.open(temporary, 'wx', 0o600);
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    if (bytes.length > INPUT_LIMIT) fail('E_RECORD_OUTPUT', '导出内容超过 64 MiB 限制。');
    await file.writeFile(bytes);
    await file.sync();
    await file.close(); file = null;
    try { await fs.link(temporary, target); }
    catch (error) { fail(error.code === 'EEXIST' ? 'E_RECORD_OUTPUT_EXISTS' : 'E_RECORD_OUTPUT', '无法发布新的导出文件。'); }
    const result = { bytes: bytes.length };
    Object.defineProperty(result, 'outputPath', { value: target, enumerable: false });
    return result;
  } catch (error) {
    if (error instanceof WxError) throw error;
    fail('E_RECORD_OUTPUT', '导出文件未能安全写入。');
  } finally {
    await file?.close().catch(() => {});
    if (temporary) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') fail('E_RECORD_CLEANUP', '导出的私有临时文件清理失败。'); });
    if (folder) await fs.rmdir(folder).catch(error => { if (error.code !== 'ENOENT') fail('E_RECORD_CLEANUP', '导出的私有临时目录清理失败。'); });
  }
}

/** Independent local editing. Only an explicit online import invokes readHistory. */
export function createHistoryCopyService(options = {}, dependencies = {}) {
  const store = dependencies.store ?? new HistoryCopyStore();
  const registry = dependencies.registry ?? new RecipientRegistry();
  async function resolveTarget(value) {
    if (/^u_[a-f0-9]{16}$/.test(value ?? '')) { await registry.read(); return registry.resolve(value); }
    if (!identity(value)) fail('E_RECORD_CHAT', '需要完整会话 ID 或已登记的用户编号，不能导入脱敏后的身份。');
    return value;
  }
  return {
    async execute(args = {}) {
      if (!args || typeof args !== 'object' || !ACTIONS.has(args.action)) fail('E_RECORD_ACTION', '未知本地记录命令；运行 wxcc help record。');
      switch (args.action) {
        case 'import': {
          let history, accountId, target, source;
          if (args.input !== undefined) {
            if (!identity(options.self)) fail('E_RECORD_SELF', '离线导入需要 --self <完整本人 ID>。');
            const input = await readText(args.input, INPUT_LIMIT, 'E_RECORD_INPUT');
            try { history = JSON.parse(input); } catch { fail('E_RECORD_INPUT', '历史输入不是有效 JSON。'); }
            if (Array.isArray(history)) history = { messages: history };
            if (!history || typeof history !== 'object' || !Array.isArray(history.messages)) fail('E_RECORD_INPUT', '输入需要包含 messages 数组的原始历史结果。');
            accountId = options.self;
            if (history.self !== undefined && history.self !== accountId) fail('E_RECORD_ACCOUNT', '输入历史的本人账号与 --self 不一致。');
            const messageChats = new Set(history.messages.map(row => row?.chatId));
            if (messageChats.size > 1) fail('E_RECORD_CHAT', '一个副本只能包含一个明确会话。');
            target = await resolveTarget(args.to ?? history.chatId ?? [...messageChats][0]);
            if (history.chatId !== undefined && history.chatId !== target) fail('E_RECORD_CHAT', '输入会话与选择的目标不一致。');
            source = 'file-history-unverified';
          } else {
            if (!args.to || typeof dependencies.readHistory !== 'function') fail('E_RECORD_CHAT', '在线导入需要 --to <用户编号> 和可用的读取后端。');
            const requested = options.backend === 'reverse-native' ? args.to : await resolveTarget(args.to);
            history = await dependencies.readHistory({ to: requested, limit: args.limit ?? 30 });
            if (!history || !Array.isArray(history.messages)) fail('E_RECORD_INPUT', '读取后端没有返回规范化的消息数组。');
            target = await resolveTarget(args.to);
            accountId = history.self ?? options.self;
            if (!identity(accountId)) fail('E_RECORD_SELF', '当前读取结果没有完整本人 ID；该后端需要 --self。');
            if (options.self !== undefined && options.self !== accountId) fail('E_RECORD_ACCOUNT', '当前历史账号与指定本人账号不一致。');
            if (history.chatId !== undefined && history.chatId !== target) fail('E_RECORD_CHAT', '读取结果不属于选择的会话。');
            source = history.source ?? options.backend ?? 'unknown';
          }
          for (const row of history.messages) {
            if (!row || row.chatId !== target || (row.senderId !== null && !identity(row.senderId))) fail('E_RECORD_CHAT', '消息含跨会话或脱敏身份，拒绝作为原始副本导入。');
          }
          await registry.read();
          const displayName = registry.list({ includeIds: true }).find(row => row.id === target)?.displayName ?? '';
          return store.create({ accountId, chatId: target, displayName, messages: history.messages, source });
        }
        case 'list': return store.list();
        case 'show': return store.show({ copyId: args.copyId, limit: args.limit ?? 30 });
        case 'changes': return store.changes({ copyId: args.copyId, limit: args.limit ?? 30 });
        case 'edit': {
          if (args.text !== undefined && args.textFile !== undefined) fail('E_RECORD_TEXT', '--text 和 --text-file 只能选择一个。');
          const text = args.textFile === undefined ? args.text : await readText(args.textFile, TEXT_LIMIT, 'E_RECORD_TEXT_FILE');
          if (text !== undefined) textValue(text);
          return store.edit({ copyId: args.copyId, ...(args.recordId === undefined ? {} : { recordId: args.recordId }), ...(args.messageId === undefined ? {} : { messageId: args.messageId }), ...(text === undefined ? {} : { text }), ...(args.timestamp === undefined ? {} : { timestamp: args.timestamp }), ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }) });
        }
        case 'undo': return store.undo({ copyId: args.copyId, ...(args.changeId === undefined ? {} : { changeId: args.changeId }), ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }) });
        case 'export': {
          const raw = await store.exportData({ copyId: args.copyId });
          const identifiers = raw.messages.flatMap(row => [row.chatId, row.senderId]).filter(Boolean);
          await registry.read();
          const privacy = createPrivacyFormatter({ enabled: options.redact !== false, registry, identifiers });
          const data = { ...privacy.redact(raw), exportedAt: new Date().toISOString(), redacted: options.redact !== false };
          const published = await (dependencies.publishExport ?? publishExport)(args.output, data);
          const result = { ok: true, source: 'local-history-copy', localOnly: true, copyId: raw.copyId, revision: raw.revision, messageCount: raw.messageCount, edited: raw.edited, redacted: data.redacted, bytes: published.bytes };
          Object.defineProperty(result, 'outputPath', { value: published.outputPath, enumerable: false });
          return result;
        }
      }
    },
    async close() {},
  };
}
