import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { callPersistentHost } from './native-runtime-client.mjs';
import { WxError } from './errors.mjs';
import { RecipientRegistry, recipientAlias } from './recipient-registry.mjs';
import { SendJournal } from './send-journal.mjs';
import { NativeReadAdapter } from './native-read-adapter.mjs';
import { DEFAULT_NATIVE_TARGET_FILE, requireNativeTarget, configureNativeTarget, isIndividualId } from './native-target.mjs';
export { requireContactSnapshot } from './native-read-adapter.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
export const NATIVE_SEND_SCRIPT = 'sendnative_live3';
const isStateId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);
const isGeneration = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

async function readJsonFile(path) {
  try {
    if ((await stat(path)).size > 65536) throw new Error('oversized');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new WxError('E_NATIVE_CONFIG', '原生发送配置文件缺失、过大或格式错误。'); }
}
function requestId(value) {
  const id = value ?? randomUUID();
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id.trim())) throw new WxError('E_REQUEST_ID', 'requestId 必须是 1 至 128 位 ASCII 标识符字符串。');
  return id.trim().toLowerCase();
}

/** Reuses an already attached host. Never attaches, loads scripts, or performs cleanup. */
export class NativeSendAdapter {
  constructor({ tokenFile, readTokenFile = resolve(WORKSPACE, 'data/native-read-host.json'), bindingFile = resolve(WORKSPACE, 'data/native-send-binding.json'), targetFile = DEFAULT_NATIVE_TARGET_FILE, recipientsFile = resolve(WORKSPACE, 'data/recipients.json'), registry, journal, readAdapter, configureImpl = configureNativeTarget, callImpl = callPersistentHost, readJsonImpl } = {}) {
    this.tokenFile = tokenFile ?? resolve(WORKSPACE, 'data/research-host.json');
    this.bindingFile = bindingFile;
    this.targetFile = targetFile;
    this.configureImpl = configureImpl;
    this.callImpl = callImpl;
    this.readJsonImpl = readJsonImpl ?? readJsonFile;
    this.registry = registry ?? new RecipientRegistry({ filePath: recipientsFile });
    this.journal = journal ?? new SendJournal();
    this.readAdapter = readAdapter ?? new NativeReadAdapter({ tokenFile: tokenFile ?? readTokenFile, recipientsFile, registry: this.registry, callImpl, ...(readJsonImpl ? { readJsonImpl } : {}) });
  }

  async call(method, args, id) {
    const response = await this.callImpl({ tokenFile: this.tokenFile, method, args, ...(id ? { requestId: id } : {}) });
    if (response?.success !== true) {
      const message = response?.error?.message ?? '常驻原生调试宿主未返回成功结果。';
      const suffix = response?.requestStatus === 'unknown' ? `（请求 ID：${response?.requestId ?? id ?? '未知'}；不会重试。）` : '';
      throw new WxError(response?.error?.code ?? 'E_NATIVE_HOST', `${message}${suffix}`, { requestId: response?.requestId, requestStatus: response?.requestStatus });
    }
    return response.result;
  }

  async context() {
    let configured;
    try { configured = await this.readJsonImpl(this.targetFile); }
    catch { throw new WxError('E_NATIVE_TARGET', '尚无可用的本机目标授权；先运行 configure-target --to 精确 ID 或已登记编号。该命令不会发送消息。'); }
    const target = requireNativeTarget(configured);
    const [binding, descriptor] = await Promise.all([this.readJsonImpl(this.bindingFile), this.readJsonImpl(this.tokenFile)]);
    if (!binding || binding.chatId !== target.chatId || binding.displayName !== target.displayName || binding.self !== target.self || !isIndividualId(binding.self) || !Number.isSafeInteger(binding.pid) || binding.pid <= 0 || !isGeneration(binding.generation) || !isStateId(binding.sessionId) || binding.version !== target.version || binding.dllSha256 !== target.dllSha256) throw new WxError('E_NATIVE_BINDING', '发送绑定必须匹配本地单目标授权及当前本人账号；旧绑定、其他账号和其他联系人均不接受。');
    if (!descriptor || descriptor.host !== '127.0.0.1' || descriptor.pid !== binding.pid || descriptor.generation !== binding.generation) throw new WxError('E_NATIVE_GENERATION', '绑定与常驻宿主的 PID 或 generation 不一致；拒绝使用旧会话状态。');
    return { binding, descriptor, target };
  }

  async inspectContext(context) {
    const { binding, target, descriptor } = context;
    const host = await this.call('status', {});
    if (!host || host.pid !== binding.pid || host.generation !== binding.generation || host.attached !== true || host.verified !== true || host.status !== 'ready') throw new WxError('E_NATIVE_GENERATION', '当前常驻宿主未就绪，或绑定已失效。');
    if (host.version !== target.version || host.dllSha256?.toLowerCase() !== target.dllSha256 || descriptor.version !== host.version || descriptor.dllSha256?.toLowerCase() !== target.dllSha256) throw new WxError('E_NATIVE_HASH', '发送宿主及描述文件的二进制与本地目标授权不一致。');
    const runtime = await this.call('rpc', { name: NATIVE_SEND_SCRIPT, method: 'inspect', params: [] });
    if (!runtime || runtime.pid !== binding.pid || runtime.generation !== binding.generation || runtime.self !== binding.self || runtime.accountVerified !== true || runtime.dllSha256?.toLowerCase() !== target.dllSha256 || runtime.chatId !== binding.chatId || runtime.sessionId !== binding.sessionId || runtime.displayName !== binding.displayName) throw new WxError('E_NATIVE_SCOPE', '原生发送探针的本人账户、目标、二进制或运行代次与本地授权绑定不一致。');
    if (typeof runtime.version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(runtime.version) || runtime.version !== host.version) throw new WxError('E_NATIVE_VERSION', '原生发送探针版本与宿主已验证版本不一致。');
    // A failed block-file write must not reopen a host with unfinished native work.
    const nativeWorkPending = runtime.pendingTasks > 0 || runtime.pendingCallbacks > 0;
    const ready = runtime.ready === true && runtime.sendValidated === true && runtime.prologuesVerified === true && binding.validatedBinarySha256 === target.dllSha256 && !binding.runtimeBlocked && !nativeWorkPending;
    return { ...runtime, source: 'reverse-native', ready, runtimeBlocked: Boolean(binding.runtimeBlocked), nativeWorkPending, nativeReady: runtime.ready === true, attached: true, scopeVerified: true, ...(ready ? {} : { reason: binding.runtimeBlocked ? '此前的原生读取任务仍阻塞；需微信和宿主重新启动后建立新的运行代次。' : nativeWorkPending ? '原生任务或回调尚未结束；稍后检查状态。持续阻塞时需重新启动微信和宿主。' : '发送函数 ABI、prologue 与一次真实原生发送尚未全部验证。' }) };
  }

  async inspect() {
    const [reading, sending] = await Promise.allSettled([
      this.readAdapter.inspect(),
      (async () => this.inspectContext(await this.context()))(),
    ]);
    const failure = outcome => ({ ready: false, error: { code: outcome.reason?.code ?? 'E_NATIVE_HOST', message: outcome.reason?.message ?? '宿主能力未通过验证。' } });
    const read = reading.status === 'fulfilled' ? reading.value : failure(reading);
    const send = sending.status === 'fulfilled' ? sending.value : failure(sending);
    const identity = reading.status === 'fulfilled' ? read : sending.status === 'fulfilled' ? send : {};
    return {
      source: 'reverse-native', pid: identity.pid, generation: identity.generation, version: identity.version,
      ready: read.ready === true || send.ready === true, attached: read.attached === true || send.attached === true,
      accountVerified: read.accountVerified === true, readScopeVerified: read.readScopeVerified === true,
      historyAvailable: read.historyAvailable === true, sendAvailable: send.ready === true,
      scopeVerified: send.scopeVerified === true,
      sendValidated: send.ready === true && send.sendValidated === true,
      prologuesVerified: send.prologuesVerified === true,
      read, send, automaticMessagesSent: 0,
    };
  }
  async doctor() { return this.inspect(); }
  async account(args = {}) { return this.readAdapter.account(args); }
  async accounts(args = {}) { return this.readAdapter.accounts(args); }
  async history(args = {}) { return this.readAdapter.history(args); }
  async configureTarget(args = {}) {
    const runtime = await this.readAdapter.inspect();
    const account = await this.readAdapter.account();
    const contacts = await this.readAdapter.ids({});
    if (account.pid !== runtime.pid || account.generation !== runtime.generation || account.self !== runtime.self || account.accountVerified !== true || account.automaticMessagesSent !== 0 || contacts.pid !== runtime.pid || contacts.generation !== runtime.generation || contacts.self !== runtime.self || contacts.version !== runtime.version) throw new WxError('E_NATIVE_TARGET_SCOPE', '本人账号或联系人在配置过程中已变化；不会保存目标。');
    return this.configureImpl({ ...args, targetFile: this.targetFile }, { registry: this.registry, currentReadAccount: { ...account, version: runtime.version, dllSha256: runtime.dllSha256, readScopeVerified: runtime.readScopeVerified }, currentContacts: contacts });
  }
  async sendStatus({ requestId: suppliedId } = {}) {
    if (suppliedId === undefined) throw new WxError('E_REQUEST_ID', '查询必须指定原始 requestId。');
    const id = requestId(suppliedId);
    const record = await this.journal.get(id);
    if (!record) throw new WxError('E_SEND_REQUEST_UNKNOWN', '本机发送账本没有该请求；不要据此推断旧宿主中的消息未发送。');
    return { source: 'local-send-journal', ...record, deliveryConfirmed: record.receipt?.deliveryConfirmed === true };
  }

  async ids({ keyword } = {}) {
    const result = await this.readAdapter.ids({ keyword });
    let sending;
    try { sending = await this.inspectContext(await this.context()); }
    catch { /* A missing send binding must not prevent independently verified reads. */ }
    // Each host has its own generation; both sides validate it against their own descriptor.
    const sameClient = sending?.pid === result.pid && sending?.version === result.version && sending?.self === result.self && sending?.accountVerified === true;
    return { ...result, users: result.users.map(row => {
      const bound = sameClient && sending?.ready === true && row.chatId === sending.chatId;
      return { ...row, canSend: Boolean(bound), ...(bound ? { sessionId: sending.sessionId } : {}) };
    }) };
  }

  async send({ to, session, text, requestId: suppliedId } = {}) {
    if ((to === undefined) === (session === undefined)) throw new WxError('E_CHAT_TARGET', '发送必须且只能指定 --to 或 --session 之一。');
    let target = to ?? session;
    if (!isStateId(target)) throw new WxError('E_CHAT_SCOPE', '发送仅接受已授权的明确会话 ID；昵称不能用作 ID。');
    if (typeof text !== 'string' || !text.trim() || text.includes('\0') || !text.isWellFormed() || Buffer.byteLength(text, 'utf8') > 1024) throw new WxError('E_TEXT', '发送正文必须是非空且完整的 Unicode 字符串，不能包含 NUL，UTF-8 长度不超过 1024 字节。');
    const id = requestId(suppliedId);
    const context = await this.context();
    const expected = to === undefined ? context.binding.sessionId : context.binding.chatId;
    if (/^u_[a-f0-9]{16}$/.test(target)) {
      await this.registry.read();
      const resolved = this.registry.resolve(target);
      if (!resolved) throw new WxError('E_RECIPIENT_ALIAS', '编号尚未登记；先运行 ids 获取当前用户编号。');
      target = to === undefined && resolved === context.binding.chatId ? context.binding.sessionId : resolved;
    }
    if (target !== expected) throw new WxError('E_CHAT_SCOPE', '目标不属于本机明确授权的单个联系人绑定；拒绝发送。');
    const runtime = await this.inspectContext(context);
    if (!runtime.ready) throw new WxError('E_NATIVE_SEND_NOT_READY', '逆向发送尚未完成运行态与真实调用验证，CLI 发送入口保持关闭。', { ready: runtime.nativeReady, sendValidated: runtime.sendValidated === true, prologuesVerified: runtime.prologuesVerified === true });
    const alias = recipientAlias(context.binding.chatId);
    await this.journal.reserve({ requestId: id, alias, textHash: createHash('sha256').update(text, 'utf8').digest('hex'), generation: context.binding.generation, pid: context.binding.pid });
    let result;
    try { result = await this.call('rpc', { name: NATIVE_SEND_SCRIPT, method: 'sendText', params: [{ to: context.binding.chatId, text, requestId: id }] }, id); }
    catch (error) { await this.journal.finish(id, { status: 'unknown' }).catch(() => {}); throw error; }
    if (!result || result.requestId !== id || result.native !== true || result.chatId !== context.binding.chatId || result.sessionId !== context.binding.sessionId || !['accepted', 'failed', 'unknown'].includes(result.status)) {
      await this.journal.finish(id, { status: 'unknown' }).catch(() => {});
      throw new WxError('E_NATIVE_OUTCOME_UNKNOWN', '原生调用回执缺失或与绑定不一致；发送结果未知，不会重试。', { requestId: id });
    }
    try { await this.journal.finish(id, { status: result.status, receipt: result }); }
    catch { throw new WxError('E_NATIVE_OUTCOME_UNKNOWN', '原生请求已提交，但回执保存失败；不会重试，请保留原请求 ID 查账本。', { requestId: id }); }
    if (result.status === 'failed') throw new WxError('E_NATIVE_SEND_FAILED', '客户端内部发送报告失败，不会重试。', { requestId: id });
    if (result.status === 'unknown') throw new WxError('E_NATIVE_OUTCOME_UNKNOWN', '客户端内部发送结果未知，不会重试。', { requestId: id });
    return { ...result, alias: recipientAlias(context.binding.chatId), displayName: context.binding.displayName, source: 'reverse-native', deliveryConfirmed: false };
  }

  async close() { await this.readAdapter.close?.(); /* Persistent hosts remain attached and loaded. */ }
}
