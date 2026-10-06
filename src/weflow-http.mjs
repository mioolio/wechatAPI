import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeMessage } from './messages.mjs';
import { WxError } from './errors.mjs';

const SOURCE = 'weflow-http';
const TYPES = new Map([[1, 'text'], [3, 'image'], [34, 'voice'], [43, 'video'], [47, 'emoji'], [49, 'link'], [10000, 'system'], [10002, 'revoke']]);

function argumentId(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new WxError('E_ARGUMENT', `${name} 必须为明确、无多余空格的字符串 ID。`);
  }
  return value;
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new WxError('E_ARGUMENT', `${name} 必须为有效的正整数。`);
  return value;
}

function loopbackUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new WxError('E_WEFLOW_URL', 'WeFlow 地址必须是本机 HTTP 服务地址。'); }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!isLoopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new WxError('E_WEFLOW_URL', '只允许无凭据、无查询参数的本机 HTTP 服务地址，禁止外部目的地。');
  }
  return url;
}

function apiId(value, name) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new WxError('E_WEFLOW_MESSAGE', `${name} 的数字精度不安全。`);
    return String(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value.length > 128) throw new WxError('E_WEFLOW_MESSAGE', `${name} 缺少有效的整数字符串。`);
  return value;
}

function privateEndpoint(value) {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(value) && !value.toLowerCase().startsWith('gh_');
}

export function normalizeApiMessage(raw, to, self, { source = SOURCE } = {}) {
  argumentId(to, 'to');
  if (self !== undefined) argumentId(self, 'self');
  if (typeof source !== 'string' || !source) throw new WxError('E_ARGUMENT', 'source 必须为非空字符串。');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WxError('E_WEFLOW_MESSAGE', 'WeFlow 消息记录无效。');
  if (raw.chatId !== undefined && raw.chatId !== to) throw new WxError('E_WEFLOW_SCOPE', 'WeFlow 返回了目标会话之外的消息。');
  // WeFlow's internal Message keeps an exact serverIdRaw beside a lossy Number.
  const exactId = raw.serverIdRaw;
  const serverId = apiId(exactId !== undefined && exactId !== null && exactId !== '' ? exactId : raw.serverId, 'serverId');
  const seconds = raw.createTime;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(seconds * 1000)) {
    throw new WxError('E_WEFLOW_MESSAGE', 'createTime 必须为精度安全的秒级整数。');
  }
  let id = serverId;
  if (/^0+$/.test(serverId)) {
    // Native Message.messageKey includes database scope; prefer it when it exists.
    if (typeof raw.messageKey === 'string' && raw.messageKey) {
      try { id = argumentId(raw.messageKey, 'messageKey'); }
      catch { throw new WxError('E_WEFLOW_MESSAGE', 'messageKey 不是有效字符串 ID。'); }
    } else {
      throw new WxError('E_WEFLOW_MESSAGE', 'serverId 为零且缺少包含数据库来源范围的 messageKey，无法可靠去重。');
    }
  }
  if (![0, 1, false, true].some(value => Object.is(value, raw.isSend))) throw new WxError('E_WEFLOW_MESSAGE', 'isSend 只接受 0、1 或布尔值。');
  const isSelf = raw.isSend === 1 || raw.isSend === true;
  let senderId = raw.senderUsername;
  if (senderId === undefined || senderId === null || senderId === '') {
    if (isSelf && self) senderId = self;
    else if (!isSelf && privateEndpoint(to)) senderId = to;
    else throw new WxError('E_WEFLOW_MESSAGE', '消息缺少 senderUsername；本人消息可通过明确的 self ID 补充。');
  }
  try { argumentId(senderId, 'senderUsername'); }
  catch { throw new WxError('E_WEFLOW_MESSAGE', 'senderUsername 不是有效字符串 ID。'); }
  if (!Number.isSafeInteger(raw.localType) || raw.localType < 0) throw new WxError('E_WEFLOW_MESSAGE', 'localType 必须为有效整数。');
  const text = [raw.content, raw.parsedContent, raw.rawContent].find(value => typeof value === 'string');
  if (text === undefined) throw new WxError('E_WEFLOW_MESSAGE', '消息正文缺少有效字符串。');
  return { ...normalizeMessage({ id, chatId: to, senderId, isSelf, type: TYPES.get(raw.localType) ?? `wechat:${raw.localType}`, text, timestamp: seconds * 1000 }), source };
}

/** Read-only API client. It never invokes a message-send endpoint. */
export class WeFlowHttpAdapter {
  constructor({ baseUrl = 'http://127.0.0.1:5031', token, tokenFile, fetchImpl = globalThis.fetch, intervalMs = 1000, self,
    timeoutMs = 10000, overlapSeconds = 30, pageSize = 500 } = {}) {
    this.baseUrl = loopbackUrl(baseUrl);
    this.token = token;
    this.tokenFile = tokenFile;
    this.fetchImpl = fetchImpl;
    if (typeof fetchImpl !== 'function') throw new WxError('E_ARGUMENT', 'fetchImpl 必须为函数。');
    this.intervalMs = positiveInteger(intervalMs, 'intervalMs', 0x7fff_ffff);
    this.timeoutMs = positiveInteger(timeoutMs, 'timeoutMs', 0x7fff_ffff);
    this.overlapSeconds = positiveInteger(overlapSeconds, 'overlapSeconds');
    this.pageSize = positiveInteger(pageSize, 'pageSize', 10000);
    this.self = self === undefined ? undefined : argumentId(self, 'self');
  }

  async authToken(signal) {
    let token = this.token;
    if (token === undefined && this.tokenFile) {
      try { token = await readFile(this.tokenFile, { encoding: 'utf8', signal }); }
      catch {
        if (signal?.aborted) throw new WxError('E_ABORTED', '已取消。');
        throw new WxError('E_WEFLOW_AUTH', '无法读取指定的 API Token 文件。');
      }
    }
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token.trim())) {
      throw new WxError('E_WEFLOW_AUTH', '需要手动提供有效的 WeFlow API Token 或纯文本 Token 文件。');
    }
    this.token = token.trim();
    return this.token;
  }

  async request(path, params = {}, { signal, authenticate = true } = {}) {
    if (signal?.aborted) throw new WxError('E_ABORTED', '已取消。');
    const url = new URL(path, this.baseUrl.origin);
    if (url.origin !== this.baseUrl.origin || url.username || url.password || url.hash) throw new WxError('E_WEFLOW_URL', '请求必须留在指定的本机 WeFlow 服务。');
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    let timedOut = false;
    const relayAbort = () => controller.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    let rejectInterrupted;
    const interrupted = new Promise((_resolve, reject) => { rejectInterrupted = reject; });
    const localAbort = () => rejectInterrupted(new WxError(timedOut ? 'E_WEFLOW_TIMEOUT' : 'E_ABORTED', timedOut ? 'WeFlow HTTP 请求超时。' : '已取消。'));
    controller.signal.addEventListener('abort', localAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const perform = async () => {
      const headers = { Accept: 'application/json' };
      if (authenticate) headers.Authorization = `Bearer ${await this.authToken(controller.signal)}`;
      if (controller.signal.aborted) throw new WxError('E_ABORTED', '已取消。');
      let response;
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
      } catch {
        throw new WxError('E_WEFLOW_REQUEST', '无法连接 WeFlow 本地 HTTP 服务。');
      }
      let responseOrigin = url.origin;
      try { if (response.url) responseOrigin = new URL(response.url).origin; }
      catch { throw new WxError('E_WEFLOW_REDIRECT', 'WeFlow 返回了无效的响应地址。'); }
      if (response.redirected || (response.status >= 300 && response.status < 400) || responseOrigin !== url.origin) {
        throw new WxError('E_WEFLOW_REDIRECT', '禁止 WeFlow HTTP 重定向。');
      }
      if (!response.ok) throw new WxError('E_WEFLOW_HTTP', `WeFlow HTTP 请求失败（状态 ${Number.isInteger(response.status) ? response.status : '未知'}）。`);
      let value;
      try { value = await response.json(); }
      catch { throw new WxError('E_WEFLOW_RESPONSE', 'WeFlow 返回了无效 JSON。'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WxError('E_WEFLOW_RESPONSE', 'WeFlow 响应必须是 JSON 对象。');
      if (value.success === false) throw new WxError('E_WEFLOW_API', 'WeFlow API 报告请求失败。');
      return value;
    };
    try { return await Promise.race([perform(), interrupted]); }
    finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', localAbort);
      signal?.removeEventListener('abort', relayAbort);
    }
  }

  async health() { return { ...await this.request('/api/v1/health', {}, { authenticate: false }), source: SOURCE }; }

  async list({ keyword } = {}) {
    const value = await this.request('/api/v1/sessions', { keyword, limit: 10000 });
    if (!Array.isArray(value.sessions)) throw new WxError('E_WEFLOW_RESPONSE', 'WeFlow 响应缺少 sessions 数组。');
    return { source: SOURCE, chats: value.sessions.map(row => ({ ...row, chatId: argumentId(row?.username, '会话 username') })) };
  }

  async contacts({ keyword } = {}) {
    const value = await this.request('/api/v1/contacts', { keyword, limit: 10000 });
    if (!Array.isArray(value.contacts)) throw new WxError('E_WEFLOW_RESPONSE', 'WeFlow 响应缺少 contacts 数组。');
    for (const row of value.contacts) argumentId(row?.username, '联系人 username');
    return { source: SOURCE, contacts: value.contacts };
  }

  async messagePage(to, params, signal) {
    const value = await this.request('/api/v1/messages', { talker: to, media: 0, ...params }, { signal });
    if (value.talker !== undefined && value.talker !== to) throw new WxError('E_WEFLOW_SCOPE', 'WeFlow 返回了目标会话之外的数据。');
    if (!Array.isArray(value.messages) || typeof value.hasMore !== 'boolean') {
      throw new WxError('E_WEFLOW_RESPONSE', 'WeFlow 消息响应缺少有效 messages 或 hasMore。');
    }
    return { messages: value.messages.map(raw => normalizeApiMessage(raw, to, this.self)), hasMore: value.hasMore === true };
  }

  async history({ to, limit = 30 } = {}) {
    argumentId(to, 'to');
    positiveInteger(limit, 'limit', 10000);
    const page = await this.messagePage(to, { limit, offset: 0 });
    return { source: SOURCE, messages: page.messages.sort((a, b) => a.timestamp - b.timestamp) };
  }

  async windowMessages(to, start, end, signal) {
    const messages = new Map();
    let offset = 0;
    while (!signal?.aborted) {
      const page = await this.messagePage(to, { start, end, limit: this.pageSize, offset }, signal);
      let added = 0;
      for (const message of page.messages) {
        if (message.timestamp < start * 1000 || message.timestamp > end * 1000) throw new WxError('E_WEFLOW_RESPONSE', 'WeFlow 消息超出了请求时间窗口。');
        if (!messages.has(message.id)) { messages.set(message.id, message); added += 1; }
      }
      if (!page.hasMore) return [...messages.values()].sort((a, b) => a.timestamp - b.timestamp);
      if (!page.messages.length || (offset > 0 && added === 0)) throw new WxError('E_WEFLOW_PAGINATION', 'WeFlow 分页未前进，已停止以避免静默遗漏消息。');
      offset += page.messages.length;
      if (!Number.isSafeInteger(offset)) throw new WxError('E_WEFLOW_PAGINATION', 'WeFlow 分页偏移超出安全范围。');
    }
    throw new WxError('E_ABORTED', '已取消。');
  }

  async watch({ signal, to, onEvent } = {}) {
    argumentId(to, 'watch 的 to');
    if (typeof onEvent !== 'function') throw new WxError('E_ARGUMENT', 'watch 需要 onEvent 回调。');
    if (signal?.aborted) return;
    const seen = new Map();
    try {
      // The initial baseline includes already-existing messages in the current second.
      const baselineEnd = Math.max(0, Math.floor(Date.now() / 1000));
      const latest = await this.messagePage(to, { limit: 1, offset: 0, end: baselineEnd }, signal);
      let watermark = latest.messages[0] ? Math.floor(latest.messages[0].timestamp / 1000) : baselineEnd;
      const baseline = await this.windowMessages(to, Math.max(0, watermark - this.overlapSeconds), baselineEnd, signal);
      for (const message of baseline) {
        seen.set(message.id, message.timestamp);
        watermark = Math.max(watermark, Math.floor(message.timestamp / 1000));
      }
      for (const message of latest.messages) seen.set(message.id, message.timestamp);
      while (!signal?.aborted) {
        await delay(this.intervalMs, undefined, { signal });
        const start = Math.max(0, watermark - this.overlapSeconds);
        // Completed seconds give offset pagination a stable upper time bound where possible.
        const end = Math.max(watermark, Math.floor(Date.now() / 1000) - 1);
        const messages = await this.windowMessages(to, start, end, signal);
        for (const message of messages) {
          if (signal?.aborted) return;
          if (!seen.has(message.id)) {
            await onEvent(message);
            seen.set(message.id, message.timestamp);
          }
          watermark = Math.max(watermark, Math.floor(message.timestamp / 1000));
        }
        const cutoff = (watermark - this.overlapSeconds) * 1000;
        for (const [id, timestamp] of seen) if (timestamp < cutoff) seen.delete(id);
      }
    } catch (error) {
      if (!(signal?.aborted && (error?.name === 'AbortError' || error?.code === 'E_ABORTED'))) throw error;
    }
  }
}
