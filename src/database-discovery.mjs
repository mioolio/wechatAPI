import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WxError } from './errors.mjs';

const run = promisify(execFile);
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const privateDiscoveries = new WeakMap();

function fail(code, message) { throw new WxError(code, message); }
function expandEnvironment(value, env) {
  return value.replace(/%([^%]+)%/g, (whole, name) => {
    const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry?.[1] ?? whole;
  });
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function directory(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const resolved = await fs.realpath(value); return (await fs.stat(resolved)).isDirectory() ? resolved : null; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; fail('E_DB_PATH', '数据库目录无法读取。'); }
}
async function registryValue(key, name, env) {
  try {
    const executable = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    const { stdout } = await run(executable, ['query', key, '/v', name], { windowsHide: true, timeout: 5000, maxBuffer: 32768 });
    const line = stdout.split(/\r?\n/).find(item => new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+`, 'i').test(item));
    return line ? expandEnvironment(line.replace(/^\s*\S+\s+REG_(?:EXPAND_)?SZ\s+/i, '').trim(), env) : null;
  } catch { return null; }
}

/** Candidate roots contain paths only. No account directory is selected by recency or prefix. */
export async function databaseRootCandidates({ basePath, currentAccount, configuration, documentsPath, platform = process.platform, env = process.env, home = os.homedir(), registryReader = registryValue } = {}) {
  const roots = [];
  const add = (value, source, append = false) => {
    if (typeof value !== 'string' || !value.trim()) return;
    let expanded = expandEnvironment(value, env);
    if (expanded === '~' || expanded.startsWith(`~${path.sep}`)) expanded = path.join(home, expanded.slice(2));
    const resolved = path.resolve(append && path.basename(expanded).toLowerCase() !== 'xwechat_files' ? path.join(expanded, 'xwechat_files') : expanded);
    if (!roots.some(entry => entry.path.toLowerCase() === resolved.toLowerCase())) roots.push({ path: resolved, source });
  };
  add(basePath, 'explicit');
  add(currentAccount?.basePath, 'current-account');
  add(configuration?.dbPath, 'configuration');
  add(configuration?.basePath, 'configuration');
  if (documentsPath) add(documentsPath, 'known-folder', true);
  else if (platform === 'win32') {
    const queries = await Promise.all([
      registryReader('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'Personal', env),
      registryReader('HKCU\\Software\\Tencent\\WeChat', 'FileSavePath', env),
      registryReader('HKCU\\Software\\Tencent\\Weixin', 'FileSavePath', env)
    ]);
    add(queries[0], 'known-folder', true);
    for (const value of queries.slice(1)) if (value !== 'MyDocument:') add(value, 'registry', true);
  }
  add(path.join(home, 'Documents', 'xwechat_files'), 'documents-default');
  return roots;
}

function accountComponent(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\0<>:"|?*]/.test(value) || /[ .]$/.test(value)) fail('E_DB_ACCOUNT', '需要已验证的当前账号标识。');
  return value;
}

async function scanStorage(storagePath, maximumFiles) {
  const result = [];
  const walk = async (folder, depth) => {
    if (depth > 4) fail('E_DB_LAYOUT', '数据库目录层级超过支持范围。');
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(fullPath, depth + 1);
      else if (entry.isFile() && /\.db$/i.test(entry.name)) {
        if (result.length >= maximumFiles) fail('E_DB_LIMIT', '数据库文件数量超过支持范围。');
        const [stat, walStat] = await Promise.all([fs.stat(fullPath), fs.stat(`${fullPath}-wal`).catch(error => { if (error.code === 'ENOENT') return null; throw error; })]);
        const handle = await fs.open(fullPath, 'r');
        let header;
        try { header = Buffer.alloc(32); const read = await handle.read(header, 0, header.length, 0); header = header.subarray(0, read.bytesRead); }
        finally { await handle.close(); }
        const record = { bytes: stat.size, encrypted: !header.subarray(0, 16).equals(SQLITE_HEADER), walBytes: walStat?.size ?? 0 };
        for (const [key, value] of Object.entries({ path: fullPath, relativePath: path.relative(storagePath, fullPath), header, walPath: `${fullPath}-wal` })) Object.defineProperty(record, key, { value, enumerable: false });
        result.push(record);
      }
    }
  };
  await walk(storagePath, 0);
  return result;
}

/**
 * Identity must come from the current client or an explicit, verified provider.
 * A suffix is never inferred: supply accountDirectoryName from that provider,
 * or resolveAccountIdentity(accountDir) => {username, accountDirectoryName}.
 * Private paths/header bytes are non-enumerable and never emitted by JSON.stringify.
 */
export async function discoverDatabases(options = {}) {
  try {
  const { currentAccount, resolveAccountIdentity, maximumFiles = 512, allowCryptographicBinding = false } = options;
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1 || maximumFiles > 4096) fail('E_DB_LIMIT', '数据库文件数量限制无效。');
  const username = accountComponent(currentAccount?.username ?? currentAccount?.accountusername ?? currentAccount?.self);
  const roots = await databaseRootCandidates(options);
  const matches = [];
  const explicitDirectory = currentAccount?.accountDir ?? options.accountDir;
  const directoryName = currentAccount?.accountDirectoryName ? accountComponent(currentAccount.accountDirectoryName) : username;
  const currentNameMatches = name => name === username || (name.startsWith(`${username}_`) && /^[a-z0-9]{1,32}$/.test(name.slice(username.length + 1)));
  for (const candidate of roots) {
    const root = await directory(candidate.path);
    if (!root) continue;
    let targets;
    if (explicitDirectory) targets = [await directory(explicitDirectory)];
    else if (path.basename(root) === directoryName || ((allowCryptographicBinding || resolveAccountIdentity) && currentNameMatches(path.basename(root)))) targets = [root];
    else if ((allowCryptographicBinding || resolveAccountIdentity) && !currentAccount?.accountDirectoryName) {
      const names = await fs.readdir(root, { withFileTypes: true });
      targets = await Promise.all(names.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && currentNameMatches(entry.name)).map(entry => directory(path.join(root, entry.name))));
    } else targets = [await directory(path.join(root, directoryName))];
    for (const target of targets) {
      if (!target || !(inside(root, target) || root === target)) continue;
      const expectedTarget = path.basename(root) === directoryName ? root : path.join(root, directoryName);
      let identityConfirmed = target === expectedTarget && path.basename(target) === directoryName;
      if (identityConfirmed && directoryName !== username && !currentAccount?.accountDirectoryName) identityConfirmed = false;
      if (!identityConfirmed && typeof resolveAccountIdentity === 'function') {
        const identity = await resolveAccountIdentity(target);
        identityConfirmed = identity?.username === username && identity?.accountDirectoryName === path.basename(target);
      }
      const pendingMatch = allowCryptographicBinding && currentNameMatches(path.basename(target));
      if (!identityConfirmed && !pendingMatch) fail('E_DB_ACCOUNT_BINDING', '数据库目录与当前账号的精确对应关系尚未验证。');
      const storagePath = await directory(path.join(target, 'db_storage'));
      if (!storagePath || !inside(target, storagePath)) continue;
      if (!matches.some(match => match.accountDir === target)) matches.push({ root, source: candidate.source, accountDir: target, storagePath });
    }
  }
  // An explicit account path can itself serve as the current-account base path.
  if (!matches.length && explicitDirectory) {
    const target = await directory(explicitDirectory);
    if (target && (path.basename(target) === directoryName || (allowCryptographicBinding && currentNameMatches(path.basename(target))))) {
      const storagePath = await directory(path.join(target, 'db_storage'));
      if (storagePath && inside(target, storagePath)) matches.push({ root: path.dirname(target), source: 'current-account', accountDir: target, storagePath });
    } else if (target) fail('E_DB_ACCOUNT_BINDING', '数据库目录与当前账号的精确对应关系尚未验证。');
  }
  if (!matches.length) fail('E_DB_NOT_FOUND', '未发现与当前账号精确对应的数据库目录。');
  if (matches.length > 1) fail('E_DB_AMBIGUOUS', '多个数据库目录都对应当前账号，请明确 basePath。');
  let databases;
  try { databases = await scanStorage(matches[0].storagePath, maximumFiles); }
  catch (error) { if (error instanceof WxError) throw error; fail('E_DB_PATH', '数据库文件元数据无法读取。'); }
  if (!databases.length) fail('E_DB_NOT_FOUND', '当前账号目录中没有数据库文件。');
  const result = { ok: true, databaseCount: databases.length, source: matches[0].source, accountVerified: !allowCryptographicBinding, directoryMatchVerified: true, cryptographicAccountVerified: false, binding: allowCryptographicBinding ? 'pending-page-auth' : 'exact-directory' };
  const privateData = { ...matches[0], username, databases };
  privateDiscoveries.set(result, privateData);
  for (const [key, value] of Object.entries(privateData)) if (!(key in result)) Object.defineProperty(result, key, { value, enumerable: false });
  Object.defineProperty(result, 'toJSON', { value: () => databaseDiscoverySummary(result), enumerable: false });
  return result;
  } catch (error) { if (error instanceof WxError) throw error; fail('E_DB_DISCOVERY', '无法安全读取数据库发现元数据。'); }
}

/** The public summary deliberately contains no paths, directory names, salts, or identities. */
export function databaseDiscoverySummary(discovery) {
  const data = privateDiscoveries.get(discovery);
  if (!data) fail('E_DB_DISCOVERY', '数据库发现结果无效。');
  return {
    ok: true, source: discovery.source, accountVerified: discovery.accountVerified, directoryMatchVerified: true,
    cryptographicAccountVerified: false, binding: discovery.binding, databaseCount: data.databases.length,
    encryptedCount: data.databases.filter(item => item.encrypted).length,
    totalBytes: data.databases.reduce((sum, item) => sum + item.bytes, 0),
    databases: data.databases.map((item, index) => ({ index, bytes: item.bytes, encrypted: item.encrypted, walBytes: item.walBytes, aligned4096: item.bytes > 0 && item.bytes % 4096 === 0 }))
  };
}
