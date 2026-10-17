import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli.mjs';
import { createService } from '../src/service.mjs';
import { createPrivacyFormatter } from '../src/privacy.mjs';
import { findMediaRoot } from '../src/media-roots.mjs';

test('media CLI accepts directory overrides and image sends require exactly one payload', () => {
  assert.deepEqual(parseArgs(['media', '--to', 'filehelper', '--output', 'D:\\Photos', '--media-root', 'D:\\WeChat']).args,
    { to: 'filehelper', output: 'D:\\Photos', mediaRoot: 'D:\\WeChat', limit: 30 });
  assert.deepEqual(parseArgs(['send', '--to', 'filehelper', '--image', 'D:\\测试 图片.png', '--request-id', 'image-1']).args,
    { to: 'filehelper', image: 'D:\\测试 图片.png', requestId: 'image-1' });
  for (const argv of [
    ['send', '--to', 'filehelper', '--text', 'x', '--image', 'image.png'],
    ['send', '--to', 'filehelper'], ['media'], ['history', '--to', 'filehelper', '--image', 'x'],
  ]) assert.throws(() => parseArgs(argv), { code: 'INVALID_ARGUMENT' });
});

test('service saves native media automatically while forwarding only read parameters', async () => {
  const calls = [];
  const message = { id: '9007199254740993', chatId: 'filehelper', type: '3', text: '[图片消息]', timestamp: 1792260000000 };
  const service = await createService({ backend: 'reverse-native' }, {
    reverseFactory: () => ({ history: async args => { calls.push(args); return { self: 'wxid_self', chatId: 'filehelper', messages: [message], automaticMessagesSent: 0 }; } }),
    findMediaRoot: async self => { assert.equal(self, 'wxid_self'); return 'D:\\CurrentAccount'; },
    saveMessageMedia: async (messages, options) => { assert.equal(messages[0].media[0].kind, 'image'); calls.push(options); return { saved: 1, indexPath: 'D:\\Photos\\index.html' }; },
  });
  const result = await service.media({ to: 'filehelper', limit: 5, output: 'D:\\Photos' });
  assert.deepEqual(calls, [{ to: 'filehelper', limit: 5 }, { output: 'D:\\Photos', mediaRoot: 'D:\\CurrentAccount' }]);
  assert.equal(result.messages, undefined);
  assert.equal(result.media.saved, 1);
  assert.equal(result.automaticMessagesSent, 0);
});

test('plain history neither scans media roots nor creates an archive', async () => {
  const history = { messages: [{ type: '1', text: 'hello' }] };
  const fail = () => { throw new Error('unexpected media IO'); };
  const service = await createService({ backend: 'reverse-native' }, { reverseFactory: () => ({ history: async () => history }), findMediaRoot: fail, saveMessageMedia: fail });
  assert.equal(await service.history({ to: 'filehelper', limit: 1 }), history);
});

test('artifact directory and gallery links remain usable with ID masking enabled', () => {
  const indexPath = 'C:\\Users\\demo\\Desktop\\WXcc\\data\\media\\index.html';
  const result = createPrivacyFormatter().redact({ indexPath, directory: 'C:\\Users\\demo\\Pictures', chatId: 'wxid_private123' });
  assert.equal(result.indexPath, indexPath);
  assert.equal(result.directory, 'C:\\Users\\demo\\Pictures');
  assert.notEqual(result.chatId, 'wxid_private123');
  assert.equal(createPrivacyFormatter({ identifiers: ['filehelper'] }).redact({ requestId: 'filehelper-image-001' }).requestId, 'filehelper-image-001');
  const xml = '<img aeskey="private-aes" cdnthumbaeskey="private-thumb" />';
  const formatted = createPrivacyFormatter().format({ rawXml: xml });
  assert.equal(formatted.includes('private-aes'), false);
  assert.equal(formatted.includes('private-thumb'), false);
});

test('native media composes authenticated hardlinks, lazy decoder and account recheck', async () => {
  const md5 = 'a'.repeat(32), calls = [];
  const account = { self: 'wxid_self', pid: 123, generation: 'generation-test', bindingRevision: 1, accountVerified: true };
  const message = { id: '1', chatId: 'filehelper', type: '3', text: '[图片消息]', rawXml: `<msg><img md5="${md5}" /></msg>` };
  const resolveLocalPaths = () => [], decodeMedia = () => {};
  const service = await createService({ backend: 'reverse-native' }, {
    reverseFactory: () => ({ history: async () => ({ ...account, chatId: 'filehelper', messages: [message] }), account: async () => { calls.push('account'); return account; } }),
    findMediaRoot: async () => 'D:\\CurrentAccount',
    prepareMediaHardlinks: async args => { assert.deepEqual(args.md5s, [md5]); assert.equal(args.self, account.self); calls.push('hardlinks'); return { resolveLocalPaths }; },
    createMediaDecoder: options => { calls.push('decoder'); return { decodeMedia, dispose() { calls.push('dispose'); } }; },
    saveMessageMedia: async (messages, options) => { assert.equal(options.resolveLocalPaths, resolveLocalPaths); assert.equal(options.decodeMedia, decodeMedia); calls.push('save'); return { saved: 1 }; },
  });
  assert.equal((await service.media({ to: 'filehelper' })).media.saved, 1);
  assert.deepEqual(calls, ['hardlinks', 'decoder', 'save', 'account', 'dispose']);
});

test('media decoder is disposed if final account verification changes', async () => {
  let disposed = false;
  const account = { self: 'wxid_self', pid: 123, generation: 'generation-test', bindingRevision: 1 };
  const service = await createService({ backend: 'reverse-native' }, {
    reverseFactory: () => ({ history: async () => ({ ...account, messages: [{ type: '3', md5: 'a'.repeat(32) }] }), account: async () => ({ ...account, self: 'wxid_changed' }) }),
    findMediaRoot: async () => undefined,
    createMediaDecoder: () => ({ decodeMedia() {}, dispose() { disposed = true; } }),
    saveMessageMedia: async () => ({ saved: 0 }),
  });
  await assert.rejects(service.media({ to: 'filehelper' }), { code: 'E_ACCOUNT_CHANGED' });
  assert.equal(disposed, true);
});

test('media root selection uses current account identity and refuses ambiguity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wxcc-media-roots-'));
  await mkdir(join(directory, 'wxid_self_suffix'));
  await mkdir(join(directory, 'wxid_other'));
  await writeFile(join(directory, 'wxid_self_fake'), 'not a directory');
  const deps = { candidates: async () => [{ path: directory }] };
  assert.equal(await findMediaRoot('wxid_self', {}, deps), join(directory, 'wxid_self_suffix'));
  await mkdir(join(directory, 'wxid_self_second'));
  assert.equal(await findMediaRoot('wxid_self', {}, deps), undefined);
  assert.equal(await findMediaRoot('wxid_self', { 'account-dir': 'D:\\Explicit' }, deps), 'D:\\Explicit');
});
