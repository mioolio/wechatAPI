import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, lstat, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WxError } from './errors.mjs';

const DEFAULT_DIRECTORY = fileURLToPath(new URL('../data/send-requests/', import.meta.url));
const MAX_RECORD_BYTES = 16384;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['reserved', 'accepted', 'failed', 'unknown']);
function normalizedRequestId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value.trim())) throw new WxError('E_SEND_REQUEST_ID', '发送请求 ID 必须是有效 ASCII 标识符。');
  return value.trim().toLowerCase();
}
function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
function validIdentity(record) {
  return record && record.version === 1 && typeof record.requestId === 'string' && record.requestId === normalizedRequestId(record.requestId)
    && /^u_[a-f0-9]{16}$/.test(record.alias ?? '') && HASH.test(record.textHash ?? '') && UUID.test(record.generation ?? '')
    && Number.isSafeInteger(record.pid) && record.pid > 0 && STATUSES.has(record.status)
    && validTimestamp(record.createdAt) && validTimestamp(record.updatedAt);
}
function safeReceipt(receipt, requestId, status) {
  if (receipt === undefined) return undefined;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new WxError('E_SEND_JOURNAL_RECEIPT', '发送回执格式无效。');
  if (receipt.requestId !== undefined && normalizedRequestId(receipt.requestId) !== requestId) throw new WxError('E_SEND_JOURNAL_RECEIPT', '发送回执与请求 ID 不一致。');
  if (receipt.status !== undefined && receipt.status !== status) throw new WxError('E_SEND_JOURNAL_RECEIPT', '发送回执与记录状态不一致。');
  const result = { requestId, status };
  for (const key of ['native', 'deliveryConfirmed', 'nativeEntryCalled']) if (typeof receipt[key] === 'boolean') result[key] = receipt[key];
  for (const key of ['createdAt', 'completedAt']) if (validTimestamp(receipt[key])) result[key] = receipt[key];
  // No message body, resultMessage, error text, headers, credentials, or raw recipient IDs are persisted.
  return result;
}

/** Cross-process reservation; neither host restart nor a new generation clears a request ID. */
export class SendJournal {
  constructor({ directory = DEFAULT_DIRECTORY } = {}, { openImpl = open } = {}) {
    this.directory = resolve(directory);
    this.openImpl = openImpl;
    this.operation = Promise.resolve();
  }
  fileFor(requestId) { return join(this.directory, `${createHash('sha256').update(requestId, 'utf8').digest('hex')}.json`); }
  async serialized(callback) {
    const operation = this.operation.then(callback);
    this.operation = operation.catch(() => {});
    return operation;
  }
  async writeSynced(path, data) {
    const bytes = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(bytes, 'utf8') > MAX_RECORD_BYTES) throw new WxError('E_SEND_JOURNAL_STORE', '发送登记记录过大。');
    const handle = await this.openImpl(path, 'wx', 0o600);
    try {
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
  }
  async reserve({ requestId: suppliedId, alias, textHash, generation, pid } = {}) {
    const requestId = normalizedRequestId(suppliedId);
    if (typeof alias !== 'string' || !/^u_[a-f0-9]{16}$/.test(alias) || typeof textHash !== 'string' || !HASH.test(textHash.toLowerCase()) || typeof generation !== 'string' || !UUID.test(generation) || !Number.isSafeInteger(pid) || pid <= 0) throw new WxError('E_SEND_JOURNAL_ARGUMENT', '发送登记需要稳定别名、正文 SHA-256、有效 PID 和 generation。');
    const timestamp = new Date().toISOString();
    const record = { version: 1, requestId, alias, textHash: textHash.toLowerCase(), generation, pid, status: 'reserved', createdAt: timestamp, updatedAt: timestamp };
    try {
      await mkdir(this.directory, { recursive: true });
      await this.writeSynced(this.fileFor(requestId), record);
    } catch (error) {
      if (error.code === 'EEXIST') throw new WxError('E_SEND_REQUEST_REUSED', '该发送请求 ID 已被登记；不会再次发送。');
      // Do not unlink a partially created reservation: uncertainty must continue to block repeat sends.
      throw new WxError('E_SEND_JOURNAL_STORE', '无法确认发送登记已可靠写入；拒绝调用发送。');
    }
    return record;
  }
  async get(suppliedId) {
    const requestId = normalizedRequestId(suppliedId), path = this.fileFor(requestId);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_RECORD_BYTES) throw Error('invalid record file');
      const bytes = await readFile(path);
      if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) throw Error('invalid record size');
      const record = JSON.parse(bytes.toString('utf8'));
      if (!validIdentity(record) || record.requestId !== requestId) throw Error('invalid record identity');
      const expectedFields = new Set(['version', 'requestId', 'alias', 'textHash', 'generation', 'pid', 'status', 'createdAt', 'updatedAt', 'receipt']);
      if (Object.keys(record).some(key => !expectedFields.has(key))) throw Error('unexpected record fields');
      if (record.receipt !== undefined && JSON.stringify(record.receipt) !== JSON.stringify(safeReceipt(record.receipt, requestId, record.status))) throw Error('invalid persisted receipt');
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new WxError('E_SEND_JOURNAL_CORRUPT', '发送登记不可读或已损坏；不会据此重新发送。');
    }
  }
  async finish(suppliedId, { status, receipt } = {}) {
    const requestId = normalizedRequestId(suppliedId);
    if (!['accepted', 'failed', 'unknown'].includes(status)) throw new WxError('E_SEND_JOURNAL_ARGUMENT', '发送结束状态必须是 accepted、failed 或 unknown。');
    const persistedReceipt = safeReceipt(receipt, requestId, status);
    return this.serialized(async () => {
      const previous = await this.get(requestId);
      if (!previous) throw new WxError('E_SEND_REQUEST_MISSING', '发送请求尚未登记；不能补写一个已发送结果。');
      const record = { ...previous, status, updatedAt: new Date().toISOString() };
      if (persistedReceipt !== undefined) record.receipt = persistedReceipt;
      else delete record.receipt;
      const temporary = `${this.fileFor(requestId)}.${randomUUID()}.tmp`;
      try {
        await this.writeSynced(temporary, record);
        await rename(temporary, this.fileFor(requestId));
      } catch {
        throw new WxError('E_SEND_JOURNAL_STORE', '无法保存发送结果；已有请求登记仍保留，禁止重发。');
      } finally { await unlink(temporary).catch(() => {}); }
      return record;
    });
  }
}
