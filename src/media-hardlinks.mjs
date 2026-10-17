import { mkdir, mkdtemp, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeReadAdapter } from './native-read-adapter.mjs';
import { createDatabaseService, databaseAlias } from './database-service.mjs';
import { findMediaRoot } from './media-roots.mjs';
import { recipientAlias } from './recipient-registry.mjs';
import { WxError } from './errors.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
const fail = message => new WxError('E_MEDIA_HARDLINKS', message);
const isMd5 = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const isSafeFilename = value => typeof value === 'string' && /^[a-f0-9]{32}(?:_[a-z0-9]+)?\.(?:dat|png|jpe?g|gif|webp|bmp)$/i.test(value);

/**
 * Resolve message MD5s through an authenticated snapshot of the current account's
 * hardlink DB. Cache filenames are independent of message MD5s in Weixin 4.x.
 * No previously exported DB or caller-supplied plaintext DB is trusted.
 */
export async function prepareMediaHardlinks({ self, pid, generation, bindingRevision, options = {}, mediaRoot, md5s = [] } = {}, dependencies = {}) {
  if (typeof self !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(self) || !Number.isSafeInteger(pid) || pid < 1 || typeof generation !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(generation) || (bindingRevision !== undefined && (!Number.isSafeInteger(bindingRevision) || bindingRevision < 1)) || !Array.isArray(md5s) || md5s.length > 10000 || md5s.some(value => !isMd5(value))) throw fail('图片硬链接解析需要当前已验证的账号、进程、代次和有效 MD5。');
  const wanted = [...new Set(md5s.map(value => value.toLowerCase()))];
  const paths = new Map();
  const resolver = root => ({ root, source: 'current-account-hardlinks', count: paths.size, resolveLocalPaths: media => isMd5(media?.md5) ? [...(paths.get(media.md5.toLowerCase()) ?? [])] : [] });
  if (!wanted.length) return resolver(undefined);
  const readAdapter = dependencies.readAdapter ?? new NativeReadAdapter({ tokenFile: options['token-file'] });
  const getAccount = dependencies.accountProvider ?? (() => readAdapter.account());
  let revision = bindingRevision;
  const guard = async () => {
    const account = await getAccount();
    if (!account || account.accountVerified !== true || account.automaticMessagesSent !== 0 || account.self !== self || account.pid !== pid || account.generation !== generation || !Number.isSafeInteger(account.bindingRevision) || account.bindingRevision < 1 || (revision !== undefined && account.bindingRevision !== revision)) throw fail('图片硬链接解析期间微信账号、进程或运行代次已变化。');
    revision ??= account.bindingRevision;
    return account;
  };
  await guard();
  const detected = mediaRoot ?? await (dependencies.findMediaRoot ?? findMediaRoot)(self, options);
  if (typeof detected !== 'string') throw fail('未找到当前账号的图片缓存目录。');
  let root;
  try { root = await realpath(detected); }
  catch { throw fail('当前账号图片缓存目录不存在或无法读取。'); }
  const directoryName = path.basename(root), suffix = directoryName.slice(self.length + 1);
  if (directoryName !== self && !(directoryName.startsWith(`${self}_`) && /^[a-z0-9]{1,32}$/i.test(suffix))) throw fail('图片缓存目录与当前账号不匹配。');
  const temporaryRoot = path.resolve(dependencies.temporaryRoot ?? path.join(WORKSPACE, 'data', 'media-hardlinks-tmp'));
  await mkdir(temporaryRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(temporaryRoot, 'snapshot-'));
  const copy = path.join(temporary, 'hardlink.sqlite');
  let database, service;
  try {
    service = (dependencies.createDatabaseService ?? createDatabaseService)({ ...options, 'account-dir': root }, { readAdapter, accountProvider: guard });
    const verified = await service.execute({ action: 'decrypt', database: databaseAlias(self, 'hardlink/hardlink.db'), output: copy });
    if (!verified || verified.ok !== true || verified.source !== 'current-account-database-copy' || verified.accountAlias !== recipientAlias(self) || verified.databaseAlias !== databaseAlias(self, 'hardlink/hardlink.db') || verified.accountCryptographicBinding !== true || verified.binding !== 'current-process-page-auth' || verified.quickCheck !== 'ok') throw fail('硬链接数据库副本未通过当前账号的页面认证及完整性检查。');
    const Database = dependencies.DatabaseSync ?? (await import('node:sqlite')).DatabaseSync;
    database = new Database(copy, { readOnly: true, enableExtensionLoading: false });
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    if (database.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') throw fail('硬链接数据库副本完整性校验失败。');
    const columns = database.prepare('PRAGMA table_info(image_hardlink_info_v4)').all().map(row => row.name);
    if (!['md5', 'file_name', 'dir1', 'dir2'].every(column => columns.includes(column)) || !database.prepare('PRAGMA table_info(dir2id)').all().some(row => row.name === 'username')) throw fail('当前硬链接数据库结构尚未验证。');
    let references = 0;
    for (let offset = 0; offset < wanted.length; offset += 200) {
      const batch = wanted.slice(offset, offset + 200);
      const rows = database.prepare(`SELECT h.md5, h.file_name, d1.username AS directory, d2.username AS month FROM image_hardlink_info_v4 h JOIN dir2id d1 ON d1.rowid=h.dir1 JOIN dir2id d2 ON d2.rowid=h.dir2 WHERE lower(h.md5) IN (${batch.map(() => '?').join(',')}) LIMIT 10001`).all(...batch);
      references += rows.length;
      if (references > 10000) throw fail('硬链接数据库返回的图片引用超过上限。');
      for (const row of rows) {
        if (!isMd5(row.md5) || !batch.includes(row.md5.toLowerCase()) || !isSafeFilename(row.file_name) || typeof row.directory !== 'string' || !/^[a-f0-9]{32}$/i.test(row.directory) || typeof row.month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.month)) throw fail('硬链接数据库图片引用字段无效。');
        const key = row.md5.toLowerCase(), filename = path.join(root, 'msg', 'attach', row.directory, row.month, 'Img', row.file_name);
        const existing = paths.get(key) ?? [];
        if (!existing.includes(filename)) existing.push(filename);
        paths.set(key, existing);
      }
    }
    await guard();
    return resolver(root);
  } finally {
    let cleanupError;
    for (const cleanup of [() => database?.close(), () => service?.close?.(), () => unlink(copy), () => rmdir(temporary)]) {
      try { await cleanup(); }
      catch (error) { if (error.code !== 'ENOENT') cleanupError ??= error; }
    }
    if (cleanupError) throw fail('无法清理硬链接数据库临时副本；请检查本地媒体临时目录。');
  }
}
