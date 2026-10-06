import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WxError } from './errors.mjs';

const DEFAULT_FILE = fileURLToPath(new URL('../data/recipients.json', import.meta.url));
const ALIAS = /^u_[a-f0-9]{16}$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 512 && id.trim() === id && !/[\0\r\n]/.test(id) && id.isWellFormed();
}
function requireId(id) {
  if (!validId(id)) throw new WxError('E_RECIPIENT_ID', '真实用户 ID 必须是有效、非空的完整字符串。');
}
function requireName(name) {
  if (typeof name !== 'string' || name.length > 4096 || name.includes('\0') || !name.isWellFormed()) throw new WxError('E_RECIPIENT_NAME', '显示名称必须是有效字符串。');
}
/** Deterministic per ID; adding another recipient never renumbers an existing alias. */
export function recipientAlias(id) {
  requireId(id);
  return `u_${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)}`;
}

/** Local private lookup only. Registration grants no permission to send messages. */
export class RecipientRegistry {
  constructor({ filePath, recipientsFile } = {}, { aliasImpl = recipientAlias } = {}) {
    this.filePath = resolve(filePath ?? recipientsFile ?? DEFAULT_FILE);
    this.aliasImpl = aliasImpl;
    this.records = new Map();
    this.loaded = false;
    this.operation = Promise.resolve();
  }
  async serialize(callback) {
    const operation = this.operation.then(callback);
    this.operation = operation.catch(() => {});
    return operation;
  }
  derive(id) {
    requireId(id);
    const alias = this.aliasImpl(id);
    if (typeof alias !== 'string' || !ALIAS.test(alias)) throw new WxError('E_RECIPIENT_ALIAS', '派生别名格式无效。');
    return alias;
  }
  async loadRecords() {
    let data;
    try {
      if ((await stat(this.filePath)).size > MAX_FILE_BYTES) throw new WxError('E_RECIPIENT_CONFIG', '本地用户登记文件过大。');
      data = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      if (error instanceof WxError) throw error;
      throw new WxError('E_RECIPIENT_CONFIG', '无法读取本地用户登记文件。');
    }
    if (!data || data.version !== 1 || !Array.isArray(data.recipients)) throw new WxError('E_RECIPIENT_CONFIG', '本地用户登记文件格式无效。');
    const records = new Map(), ids = new Set();
    for (const record of data.recipients) {
      if (!record || !validId(record.id) || typeof record.alias !== 'string' || !ALIAS.test(record.alias) || typeof record.displayName !== 'string') throw new WxError('E_RECIPIENT_CONFIG', '本地用户登记记录无效。');
      requireName(record.displayName);
      if (records.has(record.alias)) throw new WxError('E_RECIPIENT_COLLISION', '本地用户别名发生碰撞；不会覆盖已有用户。');
      if (ids.has(record.id) || record.alias !== this.derive(record.id)) throw new WxError('E_RECIPIENT_CONFIG', '本地用户登记与稳定别名不一致。');
      records.set(record.alias, { alias: record.alias, id: record.id, displayName: record.displayName });
      ids.add(record.id);
    }
    return records;
  }
  async read() {
    return this.serialize(async () => {
      this.records = await this.loadRecords();
      this.loaded = true;
      return this.list();
    });
  }
  async register({ id, displayName } = {}) {
    const alias = this.derive(id);
    if (displayName !== undefined) requireName(displayName);
    return this.serialize(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const lockPath = `${this.filePath}.lock`;
      let lock;
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw new WxError('E_RECIPIENT_BUSY', '本地用户登记正在写入，请稍后重试。');
        throw new WxError('E_RECIPIENT_WRITE', '无法锁定本地用户登记文件。');
      }
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        const records = await this.loadRecords();
        const existing = records.get(alias);
        if (existing && existing.id !== id) throw new WxError('E_RECIPIENT_COLLISION', '稳定用户别名发生碰撞；不会覆盖已有用户。');
        const record = { alias, id, displayName: displayName ?? existing?.displayName ?? '' };
        records.set(alias, record);
        const data = { version: 1, recipients: [...records.values()].sort((a, b) => a.alias.localeCompare(b.alias)) };
        await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.filePath);
        this.records = records;
        this.loaded = true;
        return { alias, displayName: record.displayName };
      } catch (error) {
        if (error instanceof WxError) throw error;
        throw new WxError('E_RECIPIENT_WRITE', '无法原子保存本地用户登记文件。');
      } finally {
        await unlink(temporary).catch(() => {});
        await lock.close();
        await unlink(lockPath).catch(() => {});
      }
    });
  }
  resolve(alias) {
    if (typeof alias !== 'string' || !ALIAS.test(alias)) throw new WxError('E_RECIPIENT_ALIAS', '请输入已登记的稳定用户别名。');
    if (!this.loaded) throw new WxError('E_RECIPIENT_NOT_LOADED', '请先读取本地用户登记。');
    const record = this.records.get(alias);
    if (!record) throw new WxError('E_RECIPIENT_UNKNOWN', '用户别名未登记；不会猜测真实会话。');
    return record.id;
  }
  list({ includeIds = false } = {}) {
    return [...this.records.values()].sort((a, b) => a.alias.localeCompare(b.alias)).map(({ alias, id, displayName }) => ({ alias, displayName, ...(includeIds === true ? { id } : {}) }));
  }
}
