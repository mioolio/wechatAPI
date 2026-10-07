import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { doctor as installationDoctor } from './doctor.mjs';
import { WeFlowHttpAdapter, normalizeApiMessage } from './weflow-http.mjs';
import { WeFlowNativeAdapter } from './weflow-native.mjs';
import { readNativeContent } from './native-content.mjs';
import { CaptureStore } from './store.mjs';
import { WxError } from './errors.mjs';
import { NativeSendAdapter } from './native-send-adapter.mjs';

const BACKENDS = new Set(['weflow-http', 'weflow-native', 'cache', 'reverse-native']);

function requirePrivateTarget(to) {
  if (typeof to !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(to) || to.toLowerCase().startsWith('gh_')) {
    throw new WxError('E_CHAT_SCOPE', '原生读取只接受明确的个人会话 ID。');
  }
}

function nativeMessageKey(row) {
  if (row.messageKey) return row.messageKey;
  const source = row._db_path ?? row.db_path;
  const table = row.table_name;
  const localId = row.local_id ?? row.localId;
  const time = row.create_time ?? row.createTime;
  const validLocal = typeof localId === 'string' ? /^\d+$/.test(localId) && !/^0+$/.test(localId) : Number.isSafeInteger(localId) && localId > 0;
  if (typeof source !== 'string' || !source || typeof table !== 'string' || !table || !validLocal || !Number.isSafeInteger(time) || time < 0) return undefined;
  const scope = createHash('sha256').update(JSON.stringify([source, table])).digest('hex');
  return `native:${scope}:${localId}:${time}`;
}

function nativeMessage(row, to, self) {
  const isSend = row.computed_is_send ?? row.is_send ?? row.isSend;
  const direction = isSend === '0' ? 0 : isSend === '1' ? 1 : isSend;
  const sender = row.sender_username ?? row.senderUsername;
  // A personal chat has two endpoints; direction must already be explicit.
  const senderUsername = sender || (direction === 0 ? to : direction === 1 ? self : undefined);
  return normalizeApiMessage({
    chatId: row.chatId ?? row.session_id,
    serverId: row.server_id ?? row.serverId,
    serverIdRaw: row.serverIdRaw,
    messageKey: nativeMessageKey(row),
    localId: row.local_id ?? row.localId,
    localType: row.local_type ?? row.localType,
    createTime: row.create_time ?? row.createTime,
    isSend: direction,
    senderUsername,
    content: typeof row.content === 'string' ? row.content : typeof row.rawContent === 'string' && row.message_content === undefined && row.compress_content === undefined ? row.rawContent : readNativeContent(row),
  }, to, self, { source: 'weflow-native' });
}

/** Read backends and the explicitly validated persistent native host. */
export async function createService(options = {}, dependencies = {}) {
  const backend = options.backend ?? 'weflow-http';
  if (!BACKENDS.has(backend)) throw new WxError('E_BACKEND', `未知后端：${backend}`);
  if (options.interval !== undefined && (!Number.isSafeInteger(options.interval) || options.interval < 1 || options.interval > 0x7fff_ffff)) {
    throw new WxError('E_ARGUMENT', 'interval 必须是 1 至 2147483647 之间的毫秒整数。');
  }
  const accountScope = typeof options.self === 'string' ? createHash('sha256').update(options.self).digest('hex') : 'unconfigured';
  const storePath = resolve('data', accountScope, 'messages.ndjson');
  const store = dependencies.store ?? dependencies.storeFactory?.(storePath) ?? new CaptureStore(storePath);
  let storeLoaded = false;
  let adapter;
  let databaseService;
  let historyCopyService;
  const loadStore = async () => {
    if (typeof options.self !== 'string' || !options.self.trim()) throw new WxError('E_SELF_REQUIRED', '监听与离线缓存需要 --self <本人 wxid>，用于隔离不同账户的数据。');
    if (!storeLoaded) { await store.load(); storeLoaded = true; }
  };
  const adapterFor = () => {
    if (adapter) return adapter;
    if (backend === 'weflow-http') {
      adapter = dependencies.httpFactory?.() ?? new WeFlowHttpAdapter({
        baseUrl: options.url ?? process.env.WXCC_WEFLOW_URL,
        token: options['token-file'] ? undefined : process.env.WXCC_WEFLOW_TOKEN,
        tokenFile: options['token-file'],
        intervalMs: options.interval ?? 1000,
        self: options.self,
      });
    } else if (backend === 'weflow-native') {
      adapter = dependencies.nativeFactory?.() ?? new WeFlowNativeAdapter({
        root: options.root, accountDir: options['account-dir'], keyFile: options['key-file'], self: options.self,
      });
    } else if (backend === 'reverse-native') {
      adapter = dependencies.reverseFactory?.() ?? new NativeSendAdapter({ tokenFile: options['token-file'] });
    }
    return adapter;
  };
  const openNative = async () => { const native = adapterFor(); await native.open(); return native; };

  async function watchNative({ signal, to, onEvent }) {
    if (!options.self) throw new WxError('E_SELF_REQUIRED', '原生 watch 需要 --self <本人 wxid>，用于确认消息方向。');
    const native = await openNative();
    const latest = await native.getMessages({ to, limit: 1 });
    let watermark = latest.rows[0] ? Math.floor(nativeMessage(latest.rows[0], to, options.self).timestamp / 1000) : Math.floor(Date.now() / 1000);
    const seen = new Map();
    const fetchNew = async () => {
      const result = await native.getNewMessages({ to, since: Math.max(0, watermark - 30), signal });
      return result.rows.map(row => nativeMessage(row, to, options.self)).sort((a, b) => a.timestamp - b.timestamp);
    };
    const baseline = await fetchNew();
    for (const message of baseline) { seen.set(message.id, message.timestamp); watermark = Math.max(watermark, message.timestamp / 1000); }
    try {
      while (!signal?.aborted) {
        await delay(options.interval ?? 1000, undefined, { signal });
        for (const message of await fetchNew()) {
          if (signal?.aborted) return;
          if (!seen.has(message.id)) { await onEvent(message); seen.set(message.id, message.timestamp); }
          watermark = Math.max(watermark, message.timestamp / 1000);
        }
        for (const [id, timestamp] of seen) if (timestamp < (watermark - 30) * 1000) seen.delete(id);
      }
    } catch (error) {
      if (!(signal?.aborted && (error.name === 'AbortError' || error.code === 'E_ABORTED'))) throw error;
    }
  }

  return {
    async start() {
      if (backend !== 'reverse-native') throw new WxError('E_BACKEND', 'start 只用于 reverse-native。');
      const start = dependencies.startNativeRead ?? (await import('./native-start.mjs')).startNativeRead;
      const result = await start(options);
      // Descriptor/log paths are local installation details; CLI summaries keep them private.
      const { tokenFile: _tokenFile, logFile: _logFile, archivedDescriptor: _archivedDescriptor, ...publicResult } = result;
      return publicResult;
    },
    async configureTarget(args = {}) {
      if (backend !== 'reverse-native') throw new WxError('E_BACKEND', 'configure-target 只用于 reverse-native。');
      return adapterFor().configureTarget(args);
    },
    async db(args = {}) {
      if (backend !== 'reverse-native') throw new WxError('E_BACKEND', 'db 使用独立原生数据库读取模块；请使用 reverse-native。');
      if (!databaseService) { const create = dependencies.createDatabaseService ?? (await import('./database-service.mjs')).createDatabaseService; databaseService = create(options); }
      return databaseService.execute(args);
    },
    async record(args = {}) {
      if (!historyCopyService) {
        const create = dependencies.createHistoryCopyService ?? (await import('./history-copy-service.mjs')).createHistoryCopyService;
        historyCopyService = create({ ...options, backend }, {
          ...(dependencies.historyCopyStore ? { store: dependencies.historyCopyStore } : {}),
          ...(dependencies.historyCopyRegistry ? { registry: dependencies.historyCopyRegistry } : {}),
          readHistory: query => this.history(query),
        });
      }
      return historyCopyService.execute(args);
    },
    async doctor() {
      const raw = await (dependencies.installationDoctor ?? installationDoctor)({ includeExports: false, installPath: options['install-path'], pid: options.pid });
      const installation = options.verbose ? raw : {
        installPath: raw.installPath, version: raw.version, architecture: raw.architecture, nodeVersion: raw.nodeVersion,
        exe: raw.exe ? { path: raw.exe.path, exportCount: raw.exe.exportCount } : undefined,
        dll: raw.dll ? { path: raw.dll.path, exportCount: raw.dll.exportCount } : undefined,
        running: raw.running, processes: raw.processes, processInspectionAvailable: raw.processInspectionAvailable,
        hashes: raw.hashes, diagnostics: raw.diagnostics, discovery: raw.discovery,
      };
      let connection;
      try {
        connection = backend === 'cache' ? { ready: true, source: 'captured-events' } : {
          ready: true, ...await (backend === 'weflow-http' ? adapterFor().health() : adapterFor().doctor()),
        };
      } catch (error) {
        connection = { ready: false, error: { code: error.code ?? 'E_BACKEND', message: error.message, ...(error.details ? { details: error.details } : {}) } };
      }
      return {
        installation, backend, connection,
        capabilities: {
          read: { implemented: backend !== 'cache', backendAvailable: backend === 'reverse-native' ? connection.historyAvailable === true : connection.ready, accountVerified: backend === 'reverse-native' && connection.accountVerified === true },
          history: backend === 'reverse-native' && connection.historyAvailable === true,
          cache: true, send: backend === 'reverse-native' && connection.ready === true && connection.scopeVerified === true && connection.sendValidated === true && connection.prologuesVerified === true,
          processHook: backend === 'reverse-native' && connection.attached === true,
        },
        requirements: backend === 'weflow-http' ? ['WeFlow 已连接账户并开启本机 HTTP API', 'WXCC_WEFLOW_TOKEN 或 --token-file', 'history/watch 使用准确会话 ID；watch 需要 --self']
          : backend === 'weflow-native' ? ['有效的兼容原生资源', '--account-dir', '--key-file 或 WXCC_WECHAT_DB_KEY', 'watch 的 --self 与 --to']
          : backend === 'reverse-native' ? ['已有常驻 Frida host 和匹配版本的原生 agent', 'account/accounts 只返回当前运行代次已核验的账户', 'history 的读取能力须单独验证，并使用已登记的稳定用户编号', 'send 还需授权绑定、ABI/prologue 和真实原生发送验证；accepted 表示内部提交'] : [],
      };
    },
    async inspect() { if (backend === 'reverse-native') return adapterFor().inspect(); throw new WxError('E_PROCESS_HOOK_DISABLED', '当前读取后端没有进程 Hook；使用 doctor 检查读取后端。'); },
    async account(args = {}) { if (backend === 'reverse-native') return adapterFor().account(args); throw new WxError('E_UNSUPPORTED', 'account 使用 reverse-native 后端读取当前已验证的本人账户。'); },
    async accounts(args = {}) { if (backend === 'reverse-native') return adapterFor().accounts(args); throw new WxError('E_UNSUPPORTED', 'accounts 使用 reverse-native 后端列出实际已验证的可用账户。'); },
    async ids(args = {}) { if (backend === 'reverse-native') return adapterFor().ids(args); throw new WxError('E_UNSUPPORTED', 'ids 使用 reverse-native 后端获取已核验的内部用户 ID。'); },
    async sendStatus(args = {}) { if (backend === 'reverse-native') return adapterFor().sendStatus(args); throw new WxError('E_UNSUPPORTED', 'send-status 使用 reverse-native 后端的本机发送账本。'); },
    async probe() { throw new WxError('E_PROCESS_HOOK_DISABLED', '当前客户端曾在 Frida 会话清理后退出；接收探针已停用。'); },
    async list(args = {}) {
      if (backend === 'reverse-native') throw new WxError('E_UNSUPPORTED', '逆向发送后端尚未提供会话列表；使用读取后端。');
      if (backend === 'cache') { await loadStore(); return { source: 'captured-events', chats: store.index.list() }; }
      if (backend === 'weflow-http') return adapterFor().list(args);
      const result = await (await openNative()).getSessions(args);
      return { source: result.source, chats: result.rows };
    },
    async contacts(args = {}) {
      if (backend === 'reverse-native') throw new WxError('E_UNSUPPORTED', '逆向发送后端尚未提供联系人查询；使用读取后端。');
      if (backend === 'cache') throw new WxError('E_UNSUPPORTED', '离线缓存不包含联系人。');
      if (backend === 'weflow-http') return adapterFor().contacts(args);
      const result = await (await openNative()).getContacts(args);
      return { source: result.source, contacts: result.rows };
    },
    async history(args) {
      if (backend === 'reverse-native') return adapterFor().history(args);
      if (backend === 'cache') { await loadStore(); return { source: 'captured-events', messages: store.index.history(args) }; }
      if (backend === 'weflow-http') return adapterFor().history(args);
      requirePrivateTarget(args.to);
      const result = await (await openNative()).getMessages(args);
      return { source: result.source, messages: result.rows.map(row => nativeMessage(row, args.to, options.self)).sort((a, b) => a.timestamp - b.timestamp) };
    },
    async watch(args) {
      if (backend === 'reverse-native') throw new WxError('E_UNSUPPORTED', '逆向发送后端尚未提供消息监听；使用读取后端。');
      if (!args?.to) throw new WxError('E_CHAT_REQUIRED', 'watch 必须显式指定 --to <会话 ID>。');
      if (backend === 'weflow-native') requirePrivateTarget(args.to);
      if (backend === 'cache') throw new WxError('E_UNSUPPORTED', '离线缓存无法获取新消息。');
      if (args.signal?.aborted) return;
      await loadStore();
      const onEvent = async message => {
        if (message.chatId !== args.to) throw new WxError('E_CHAT_SCOPE', '拒绝保存目标会话以外的消息。');
        const captured = await store.append(message);
        if (captured) await args.onEvent?.({ ...captured, source: message.source });
      };
      try {
        if (backend === 'weflow-http') await adapterFor().watch({ ...args, onEvent });
        else await watchNative({ ...args, onEvent });
      } finally { await store.flush(); }
    },
    async send(args) { if (backend === 'reverse-native') return adapterFor().send(args); throw new WxError('E_SEND_NOT_CONFIGURED', '读取后端不提供发送接口；逆向发送需显式选择 --backend reverse-native 并完成运行态验证。'); },
    async close() { await adapter?.close?.(); await databaseService?.close?.(); await historyCopyService?.close?.(); if (storeLoaded) await store.flush(); },
  };
}
