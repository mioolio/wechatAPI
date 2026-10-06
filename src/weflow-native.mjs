import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { WxError } from './errors.mjs';

export const DEFAULT_WEFLOW_ROOT = process.env.WXCC_WEFLOW_ROOT || path.resolve('WeFlow');
const MAX_LIMIT = 1000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_ROWS = 20_000;
const MAX_TOTAL_JSON_BYTES = 64 * 1024 * 1024;
const SIGNATURES = Object.freeze({
  InitProtection: 'int32 InitProtection(const char* resourcePath)',
  wcdb_init: 'int32 wcdb_init()',
  wcdb_shutdown: 'int32 wcdb_shutdown()',
  wcdb_open_account: 'int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)',
  wcdb_close_account: 'int32 wcdb_close_account(int64 handle)',
  wcdb_get_sessions: 'int32 wcdb_get_sessions(int64 handle, _Out_ void** outJson)',
  wcdb_get_messages: 'int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)',
  wcdb_free_string: 'void wcdb_free_string(void* ptr)',
  wcdb_open_message_cursor: 'int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)',
  wcdb_fetch_message_batch: 'int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)',
  wcdb_close_message_cursor: 'int32 wcdb_close_message_cursor(int64 handle, int64 cursor)',
});

function error(code, message, details) { return new WxError(code, message, details); }
function validHandle(value) {
  return typeof value === 'bigint' ? value > 0n && value <= 0x7fff_ffff_ffff_ffffn : Number.isSafeInteger(value) && value > 0;
}
function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw error('E_ARGUMENT', `${name} 必须是 ${min} 至 ${max} 之间的整数。`);
  return value;
}
function privateChat(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value) || value.startsWith('gh_')) {
    throw error('E_CHAT_SCOPE', '必须提供明确的个人会话 ID；群聊和公众号不可用于此适配器。');
  }
  return value;
}
function keyword(value = '') {
  if (typeof value !== 'string' || value.length > 128 || value.includes('\0')) throw error('E_ARGUMENT', 'keyword 必须是不超过 128 字符的字符串。');
  return value.trim().normalize('NFKC').toLowerCase();
}
function rowUsername(row) {
  return String(row.username ?? row.user_name ?? row.userName ?? row.usrName ?? row.UsrName ?? row.talker ?? row.talker_id ?? row.talkerId ?? '').trim();
}
function privateMetadata(rows, search) {
  return rows.filter((row) => {
    const username = rowUsername(row);
    try { privateChat(username); } catch { return false; }
    if (!search) return true;
    return [username, row.displayName, row.display_name, row.remark, row.nick_name, row.nickName, row.nickname, row.alias]
      .some((value) => typeof value === 'string' && value.normalize('NFKC').toLowerCase().includes(search));
  });
}
function checkAbort(signal) {
  if (signal?.aborted) throw error('E_ABORTED', '原生消息查询已取消。');
}

/** Source-compatible, read-only WCDB interface. Never attaches to Weixin. */
export class WeFlowNativeAdapter {
  #root;
  #accountDir;
  #keyFile;
  #self;
  #koffi;
  #mocked;
  #libraries = [];
  #api = {};
  #initialized = false;
  #initialization;
  #opening;
  #queries = new Set();
  #queryController = new AbortController();
  #handle = null;
  #resourcePath;
  #dllPath;

  constructor({ root = DEFAULT_WEFLOW_ROOT, accountDir, keyFile, self, koffiImpl } = {}) {
    if (typeof root !== 'string' || !root.trim()) throw error('E_NATIVE_RESOURCES', '需要完整的 WeFlow 资源目录。');
    this.#root = path.resolve(root);
    this.#accountDir = typeof accountDir === 'string' && accountDir.trim() ? path.resolve(accountDir) : null;
    this.#keyFile = typeof keyFile === 'string' && keyFile.trim() ? path.resolve(keyFile) : null;
    this.#self = self ? privateChat(self) : null;
    this.#koffi = koffiImpl;
    this.#mocked = !!koffiImpl;
  }

  #status() {
    return {
      source: 'weflow-native', root: this.#root, dllPath: this.#dllPath,
      resourcePath: this.#resourcePath, initialized: this.#initialized,
      accountOpen: this.#handle !== null, architecture: 'x64',
      capabilities: { read: this.#initialized, send: false },
    };
  }

  async initialize() {
    if (this.#initialized) return this.#status();
    if (this.#initialization) return this.#initialization;
    this.#initialization = this.#initialize();
    try { return await this.#initialization; }
    finally { this.#initialization = undefined; }
  }

  async doctor() { return this.initialize(); }

  async #initialize() {
    if (!this.#mocked && (process.platform !== 'win32' || process.arch !== 'x64')) {
      throw error('E_NATIVE_PLATFORM', '此原生适配器需要 Windows x64 Node。');
    }
    const libraryDir = path.join(this.#root, 'resources', 'wcdb', 'win32', 'x64');
    this.#dllPath = path.join(libraryDir, 'wcdb_api.dll');
    const corePath = path.join(libraryDir, 'WCDB.dll');
    try {
      const files = await Promise.all([stat(this.#dllPath), stat(corePath)]);
      if (files.some((file) => !file.isFile())) throw new Error('not a regular file');
    } catch { throw error('E_NATIVE_RESOURCES', '未找到完整的 WeFlow WCDB x64 原资源；需要 wcdb_api.dll 与 WCDB.dll。'); }
    if (!this.#koffi) {
      try { const imported = await import('koffi'); this.#koffi = imported.default ?? imported; }
      catch { throw error('E_KOFFI_UNAVAILABLE', 'Koffi 未安装或无法加载。'); }
    }
    let initAttempted = false;
    try {
      this.#libraries.push(this.#koffi.load(corePath));
      const sdlPath = path.join(libraryDir, 'SDL2.dll');
      try {
        if ((await stat(sdlPath)).isFile()) this.#libraries.push(this.#koffi.load(sdlPath));
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw error('E_NATIVE_LOAD', 'SDL2 依赖无法加载。');
      }
      const library = this.#koffi.load(this.#dllPath);
      this.#libraries.push(library);
      for (const [name, signature] of Object.entries(SIGNATURES)) {
        try { this.#api[name] = library.func(signature); }
        catch { throw error('E_NATIVE_SYMBOL', `WCDB 缺少所需接口：${name}`); }
      }
      try { this.#api.wcdb_set_my_wxid = library.func('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)'); }
      catch { /* Older compatible libraries do not expose this optional identity setter. */ }
      try { this.#api.wcdb_get_contacts_compact = library.func('int32 wcdb_get_contacts_compact(int64 handle, const char* usernamesJson, _Out_ void** outJson)'); }
      catch { /* Contacts have an explicit unsupported result when this API is missing. */ }

      // These are the original resource locations tried by WeFlow itself.
      const candidates = [...new Set([libraryDir, path.dirname(libraryDir), path.join(this.#root, 'resources')])];
      const attempts = [];
      for (const candidate of candidates) {
        let code;
        try { code = Number(this.#api.InitProtection(candidate)); }
        catch { throw error('E_NATIVE_PROTECTION', 'WeFlow 原资源保护检查调用失败；未继续初始化。'); }
        attempts.push({ path: candidate, code });
        if (code === 0) { this.#resourcePath = candidate; break; }
      }
      if (!this.#resourcePath) throw error('E_NATIVE_PROTECTION', `WeFlow 原资源保护检查未通过（尝试返回码：${attempts.map(({ code }) => code).join(', ')}）；未绕过校验或继续初始化。`, { attempts });
      initAttempted = true;
      const code = Number(this.#api.wcdb_init());
      if (code !== 0) throw error('E_NATIVE_INIT', 'WCDB 初始化失败。', { nativeCode: code });
      this.#initialized = true;
      if (this.#queryController.signal.aborted) this.#queryController = new AbortController();
      return this.#status();
    } catch (cause) {
      if (initAttempted) { try { this.#api.wcdb_shutdown?.(); } catch { /* Preserve the initialization failure. */ } }
      this.#unload();
      this.#api = {};
      this.#resourcePath = undefined;
      if (cause instanceof WxError) throw cause;
      throw error('E_NATIVE_LOAD', '无法加载 WeFlow 原生 WCDB 资源。');
    }
  }

  #unload() {
    for (const library of this.#libraries.reverse()) { try { library.unload?.(); } catch { /* Native shutdown remains the primary cleanup. */ } }
    this.#libraries = [];
  }

  async #findSessionDb() {
    if (!this.#accountDir) throw error('E_NATIVE_ACCOUNT', 'open 需要明确的 accountDir。');
    const storage = path.join(this.#accountDir, 'db_storage');
    const queue = [{ directory: storage, depth: 0 }];
    let entriesSeen = 0;
    while (queue.length) {
      const { directory, depth } = queue.shift();
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { throw error('E_NATIVE_ACCOUNT', '无法枚举 accountDir 下的 db_storage。'); }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      entriesSeen += entries.length;
      if (entriesSeen > 10_000) throw error('E_NATIVE_ACCOUNT', '账户目录枚举超过安全上限。');
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase() === 'session.db') return path.join(directory, entry.name);
      }
      if (depth < 8) for (const entry of entries) if (entry.isDirectory()) queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
    throw error('E_NATIVE_ACCOUNT', 'accountDir/db_storage 下没有 session.db。');
  }

  async #readKey() {
    let value;
    if (this.#keyFile) {
      try {
        const metadata = await stat(this.#keyFile);
        if (!metadata.isFile() || metadata.size > 4096) throw new Error('invalid file');
        value = await readFile(this.#keyFile, 'utf8');
      } catch { throw error('E_NATIVE_KEY', '无法读取有效的 keyFile；需要仅包含 64 位十六进制数据库密钥的文件。'); }
    } else {
      value = process.env.WXCC_WECHAT_DB_KEY ?? process.env.WXCC_DB_KEY;
    }
    if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.trim())) {
      throw error('E_NATIVE_KEY', '缺少有效的数据库密钥；通过 keyFile 或 WXCC_WECHAT_DB_KEY 提供 64 位十六进制值。');
    }
    return value.trim();
  }

  async open() {
    if (this.#handle !== null) return { ...this.#status(), accountOpen: true };
    if (this.#opening) return this.#opening;
    this.#opening = this.#open();
    try { return await this.#opening; }
    finally { this.#opening = undefined; }
  }

  async #open() {
    const sessionDb = await this.#findSessionDb();
    await this.initialize();
    // Kept only in this call's local scope; never included in diagnostics or state.
    let key = await this.#readKey();
    const outHandle = [0];
    let completed = false;
    try {
      const code = Number(this.#api.wcdb_open_account(sessionDb, key, outHandle));
      if (code !== 0 || !validHandle(outHandle[0])) throw error('E_NATIVE_OPEN', 'WCDB 无法打开指定账户数据库。', { nativeCode: code });
      if (this.#self && this.#api.wcdb_set_my_wxid) {
        const identityCode = Number(this.#api.wcdb_set_my_wxid(outHandle[0], this.#self));
        if (identityCode !== 0) throw error('E_NATIVE_IDENTITY', 'WCDB 无法设置明确的本人身份。', { nativeCode: identityCode });
      }
      this.#handle = outHandle[0];
      completed = true;
      return this.#status();
    } catch (cause) {
      if (!completed && validHandle(outHandle[0])) { try { this.#api.wcdb_close_account(outHandle[0]); } catch { /* Preserve the open error. */ } }
      if (cause instanceof WxError) throw cause;
      throw error('E_NATIVE_OPEN', '打开账户数据库时发生原生接口错误。');
    } finally { key = undefined; }
  }

  #requireOpen() {
    if (!this.#initialized || this.#handle === null) throw error('E_NATIVE_NOT_OPEN', '请先调用 open 连接明确的账户数据库。');
  }

  #rows(pointer, maxRows = MAX_LIMIT, stats) {
    if (!pointer) throw error('E_NATIVE_JSON', 'WCDB 未返回消息 JSON。');
    let text;
    try { text = this.#koffi.decode(pointer, 'char', -1); }
    catch { throw error('E_NATIVE_JSON', 'WCDB 消息 JSON 无法解码。'); }
    if (typeof text !== 'string') throw error('E_NATIVE_JSON', 'WCDB JSON 格式无效。');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_JSON_BYTES) throw error('E_NATIVE_JSON', 'WCDB JSON 超过大小限制。');
    if (stats) stats.bytes = bytes;
    let rows;
    try {
      rows = JSON.parse(text, (_name, value, context) => {
        if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
          if (!context?.source || !/^-?\d+$/.test(context.source)) throw new Error('unsafe integer');
          return context.source;
        }
        return value;
      });
    } catch { throw error('E_NATIVE_JSON', 'WCDB 返回的消息 JSON 无效；消息内容未写入错误信息。'); }
    if (!Array.isArray(rows) || rows.length > maxRows || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw error('E_NATIVE_JSON', 'WCDB 消息结果必须是条数受限的对象数组。');
    }
    return rows;
  }

  #jsonCall(fn, args, hasMore, { maxRows = MAX_LIMIT, stats } = {}) {
    const outJson = [null];
    let primaryError;
    try {
      const code = Number(fn(...args, outJson, ...(hasMore ? [hasMore] : [])));
      if (code !== 0) throw error('E_NATIVE_QUERY', 'WCDB 消息查询失败。', { nativeCode: code });
      return this.#rows(outJson[0], maxRows, stats);
    } catch (cause) {
      primaryError = cause;
      if (cause instanceof WxError) throw cause;
      throw error('E_NATIVE_QUERY', 'WCDB 消息查询发生原生接口错误。');
    } finally {
      if (outJson[0]) {
        try { this.#api.wcdb_free_string(outJson[0]); }
        catch { if (!primaryError) throw error('E_NATIVE_FREE', 'WCDB 返回的 JSON 资源释放失败。'); }
      }
    }
  }

  async getMessages({ to, limit = 30, offset = 0 } = {}) {
    const target = privateChat(to);
    integer(limit, 'limit', 1, MAX_LIMIT);
    integer(offset, 'offset', 0, 0x7fff_ffff);
    this.#requireOpen();
    const rows = this.#jsonCall(this.#api.wcdb_get_messages, [this.#handle, target, limit, offset]);
    if (rows.length > limit) throw error('E_NATIVE_JSON', 'WCDB 返回消息条数超过请求上限。');
    return { success: true, source: 'weflow-native', to: target, rows };
  }

  async getSessions({ keyword: searchValue = '' } = {}) {
    const search = keyword(searchValue);
    this.#requireOpen();
    let rows = this.#jsonCall(this.#api.wcdb_get_sessions, [this.#handle], null, { maxRows: MAX_METADATA_ROWS });
    if (rows.some((row) => row._error || row._info)) throw error('E_NATIVE_SCHEMA', '原生会话表结构不可用；原生诊断内容未输出。');
    if (search && this.#api.wcdb_get_contacts_compact) {
      const contacts = this.#jsonCall(this.#api.wcdb_get_contacts_compact, [this.#handle, null], null, { maxRows: MAX_METADATA_ROWS });
      const names = new Map(contacts.map((row) => [rowUsername(row), row]));
      rows = rows.map((row) => {
        const contact = names.get(rowUsername(row));
        if (!contact) return row;
        return { ...row, displayName: row.displayName || contact.remark || contact.nick_name || contact.nickName || contact.nickname || contact.alias || rowUsername(row),
          remark: row.remark || contact.remark, nickname: row.nickname || contact.nick_name || contact.nickName || contact.nickname };
      });
    }
    return { success: true, source: 'weflow-native', rows: privateMetadata(rows, search) };
  }

  async getContacts({ keyword: searchValue = '' } = {}) {
    const search = keyword(searchValue);
    this.#requireOpen();
    if (!this.#api.wcdb_get_contacts_compact) throw error('E_UNSUPPORTED', '当前 WeFlow 原生库没有稳定的联系人列表接口。', { capability: 'native-contacts' });
    const rows = this.#jsonCall(this.#api.wcdb_get_contacts_compact, [this.#handle, null], null, { maxRows: MAX_METADATA_ROWS });
    if (rows.some((row) => row._error || row._info)) throw error('E_UNSUPPORTED', '当前原生联系人表结构不可用。', { capability: 'native-contacts' });
    return { success: true, source: 'weflow-native', rows: privateMetadata(rows, search) };
  }

  async getNewMessages(options = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, this.#queryController.signal]) : this.#queryController.signal;
    const operation = this.#getNewMessages({ ...options, signal });
    this.#queries.add(operation);
    try { return await operation; }
    finally { this.#queries.delete(operation); }
  }

  async #getNewMessages({ to, since, limit = 1000, maxRows = 10_000, maxBatches = 1000, signal } = {}) {
    const target = privateChat(to);
    integer(limit, 'limit', 1, MAX_LIMIT);
    integer(since, 'since（秒级时间戳）', 0, 0x7fff_ffff);
    integer(maxRows, 'maxRows', 1, 100_000);
    integer(maxBatches, 'maxBatches', 1, 10_000);
    checkAbort(signal);
    this.#requireOpen();
    const outCursor = [0];
    let primaryError;
    try {
      const code = Number(this.#api.wcdb_open_message_cursor(this.#handle, target, limit, 1, since, 0, outCursor));
      if (code !== 0 || !validHandle(outCursor[0])) throw error('E_NATIVE_CURSOR', 'WCDB 无法打开单会话消息游标。', { nativeCode: code });
      const rows = [];
      let totalBytes = 0;
      for (let batchIndex = 0; ; batchIndex += 1) {
        checkAbort(signal);
        if (batchIndex >= maxBatches) throw error('E_NATIVE_LIMIT', '原生消息游标超过批次上限；未返回或丢弃截断结果。', { maxBatches });
        const hasMore = [0];
        const stats = {};
        const batch = this.#jsonCall(this.#api.wcdb_fetch_message_batch, [this.#handle, outCursor[0]], hasMore, { stats });
        if (batch.length > limit) throw error('E_NATIVE_JSON', 'WCDB 返回消息条数超过单批请求上限。');
        if (rows.length + batch.length > maxRows || totalBytes + stats.bytes > MAX_TOTAL_JSON_BYTES) {
          throw error('E_NATIVE_LIMIT', '原生消息结果超过总量上限；未返回或丢弃截断结果。', { maxRows, maxBytes: MAX_TOTAL_JSON_BYTES });
        }
        rows.push(...batch);
        totalBytes += stats.bytes;
        checkAbort(signal);
        if (hasMore[0] === 0) return { success: true, source: 'weflow-native', to: target, rows, hasMore: false, batches: batchIndex + 1 };
        if (hasMore[0] !== 1 || batch.length === 0) throw error('E_NATIVE_CURSOR', '原生消息游标没有推进或返回了无效分页状态。');
        // Allow cancellation and the host event loop to run between native batches.
        await new Promise((resolve) => setImmediate(resolve));
        this.#requireOpen();
      }
    } catch (cause) {
      primaryError = cause;
      if (cause instanceof WxError) throw cause;
      throw error('E_NATIVE_CURSOR', 'WCDB 消息游标发生原生接口错误。');
    } finally {
      if (validHandle(outCursor[0])) {
        try {
          const code = Number(this.#api.wcdb_close_message_cursor(this.#handle, outCursor[0]));
          if (code !== 0) throw new Error('cursor close failed');
        } catch { if (!primaryError) throw error('E_NATIVE_CURSOR_CLOSE', 'WCDB 消息游标释放失败。'); }
      }
    }
  }

  async close() {
    this.#queryController.abort();
    await Promise.allSettled([...this.#queries]);
    if (this.#opening) { try { await this.#opening; } catch { /* Close any initialized resources after an open failure. */ } }
    if (this.#initialization) { try { await this.#initialization; } catch { return; } }
    const failures = [];
    if (this.#handle !== null) {
      try { if (Number(this.#api.wcdb_close_account(this.#handle)) !== 0) failures.push('close_account'); }
      catch { failures.push('close_account'); }
      this.#handle = null;
    }
    if (this.#initialized) {
      try { if (Number(this.#api.wcdb_shutdown()) !== 0) failures.push('shutdown'); }
      catch { failures.push('shutdown'); }
      this.#initialized = false;
    }
    this.#unload();
    this.#api = {};
    this.#resourcePath = undefined;
    if (failures.length) throw error('E_NATIVE_CLOSE', 'WCDB 连接清理失败。', { operations: failures });
  }
}
