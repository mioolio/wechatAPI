import { createHash } from 'node:crypto';
import { NativeReadAdapter } from './native-read-adapter.mjs';
import { recipientAlias } from './recipient-registry.mjs';
import { discoverDatabases, databaseDiscoverySummary } from './database-discovery.mjs';
import { decryptDatabase } from './database-decrypt.mjs';
import { doctor } from './doctor.mjs';
import { WxError } from './errors.mjs';

export function databaseAlias(self, relativePath) {
  return `d_${createHash('sha256').update(JSON.stringify([self, relativePath.replaceAll('\\', '/')])).digest('hex').slice(0, 16)}`;
}
function verifiedAccount(value) {
  if (!value || value.accountVerified !== true || value.automaticMessagesSent !== 0 || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.generation !== 'string' || typeof value.self !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.self)) throw new WxError('E_DB_ACCOUNT', '数据库命令需要当前已验证的本人账户。');
  return value;
}
const sameAccount = (a, b) => a.pid === b.pid && a.generation === b.generation && a.self === b.self;
function kind(relativePath) {
  const folder = relativePath.replaceAll('\\', '/').split('/')[0].toLowerCase();
  return ['message', 'session', 'contact', 'head_image', 'favorite', 'emoticon', 'sns', 'biz', 'chat_room'].includes(folder) ? folder : 'other';
}

/** DB operations never instantiate a send adapter or expose account paths/key material. */
export function createDatabaseService(options = {}, dependencies = {}) {
  const native = dependencies.readAdapter ?? new NativeReadAdapter({ tokenFile: options['token-file'] });
  const accountProvider = dependencies.accountProvider ?? (() => native.account());
  const discover = dependencies.discover ?? discoverDatabases;
  const decrypt = dependencies.decrypt ?? decryptDatabase;
  const summary = dependencies.summary ?? databaseDiscoverySummary;
  const inspect = dependencies.inspectProvider ?? (() => native.inspect());
  const installationDoctor = dependencies.installationDoctor ?? doctor;
  return {
    async execute(args = {}) {
      const action = args.action ?? 'status';
      if (!['status', 'list', 'decrypt'].includes(action)) throw new WxError('E_ARGUMENT', '未知数据库命令。');
      if (args.input) {
        if (action !== 'decrypt' || !options['key-file'] || args.database) throw new WxError('E_ARGUMENT', '离线解密需要 --input、--key-file 和 --output。');
        const result = await decrypt({ databasePath: args.input, output: args.output, keyFile: options['key-file'], keyMode: args.keyMode ?? 'raw' });
        return { source: 'offline-database-copy', ...result, accountCryptographicBinding: false, automaticMessagesSent: 0 };
      }
      const account = verifiedAccount(await accountProvider());
      const guard = async () => {
        const fresh = verifiedAccount(await accountProvider());
        if (!sameAccount(account, fresh)) throw new WxError('E_DB_ACCOUNT_CHANGED', '当前微信账号、主进程或运行代次已变化，数据库操作停止。');
        return fresh;
      };
      const discovery = await discover({ currentAccount: { self: account.self }, basePath: options['data-root'], accountDir: options['account-dir'], allowCryptographicBinding: true });
      await guard();
      const publicInfo = summary(discovery);
      const aliases = new Map();
      const databases = discovery.databases.map((database, index) => {
        const alias = databaseAlias(account.self, database.relativePath);
        if (aliases.has(alias)) throw new WxError('E_DB_ALIAS_COLLISION', '数据库编号发生碰撞，不会猜测文件。');
        aliases.set(alias, database);
        return { alias, kind: kind(database.relativePath), ...publicInfo.databases[index] };
      });
      const common = { source: 'current-account-databases', accountAlias: recipientAlias(account.self), accountDisplayName: account.displayName, ...publicInfo, databases, automaticMessagesSent: 0 };
      if (action !== 'decrypt') return common;
      if (typeof args.database !== 'string' || !aliases.has(args.database)) throw new WxError('E_DB_UNKNOWN', '数据库编号不在当前账号发现结果中；先运行 wxcc db list。');
      if (!args.output) throw new WxError('E_ARGUMENT', '解密必须指定新副本 --output。');
      const selected = aliases.get(args.database);
      let acquired;
      let memoryAuthenticated = false;
      try {
        const keyProvider = options['key-file'] ? undefined : async ({ firstPage, profiles }) => {
          const runtime = await inspect();
          if (!sameAccount(account, runtime) || runtime.accountVerified !== true || runtime.readScopeVerified !== true) throw new WxError('E_DB_ACCOUNT_CHANGED', '读取宿主与当前账号不匹配。');
          const installation = await installationDoctor({ installPath: options['install-path'], pid: account.pid, includeExports: false });
          if (installation.architecture !== 'x64' || installation.version !== runtime.version || installation.hashes?.dll?.toLowerCase() !== runtime.dllSha256?.toLowerCase()) throw new WxError('E_DB_PROCESS', '数据库密钥读取需要与当前原生宿主匹配的微信安装。');
          const find = dependencies.findKey ?? (await import('./database-key-provider.mjs')).findDatabaseKey;
          acquired = await find({ pid: account.pid, expectedExePath: installation.exe?.path, firstPage, profiles, accountGuard: guard, ...(options.timeout ? { timeoutMs: options.timeout } : {}) });
          if (!acquired?.key) throw new WxError('E_DB_AUTO_KEY', '未自动找到通过认证的数据库密钥；请使用私有 --key-file。');
          memoryAuthenticated = true;
          return acquired;
        };
        const result = await decrypt({ databasePath: selected.path, output: args.output, keyFile: options['key-file'], keyMode: args.keyMode ?? 'raw', keyProvider, beforePublish: guard });
        return { source: 'current-account-database-copy', databaseAlias: args.database, accountAlias: common.accountAlias, ...result, accountCryptographicBinding: memoryAuthenticated, binding: memoryAuthenticated ? 'current-process-page-auth' : 'directory-match-key-file-auth', automaticMessagesSent: 0 };
      } finally { acquired?.key?.fill(0); acquired?.salt?.fill(0); }
    },
    async close() { await native.close?.(); }
  };
}
