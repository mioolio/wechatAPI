import { readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { databaseRootCandidates } from './database-discovery.mjs';

/** Only search the current verified account, never whichever directory is newest. */
export async function findMediaRoot(self, options = {}, dependencies = {}) {
  if (options['account-dir']) return options['account-dir'];
  if (typeof self !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(self)) return undefined;
  const roots = await (dependencies.candidates ?? databaseRootCandidates)({ basePath: options['data-root'], currentAccount: { self } });
  const matches = new Set();
  const belongs = name => name === self || (name.startsWith(`${self}_`) && /^[a-z0-9]{1,32}$/i.test(name.slice(self.length + 1)));
  for (const { path } of roots) {
    try {
      if (belongs(basename(path))) matches.add(await realpath(path));
      else for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && belongs(entry.name)) matches.add(await realpath(join(path, entry.name)));
      }
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}
