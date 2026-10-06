import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipientRegistry, recipientAlias } from '../src/recipient-registry.mjs';

async function fixture(t, options = {}, deps = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wxcc-recipients-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'recipients.json');
  return { directory, filePath, registry: new RecipientRegistry({ filePath, ...options }, deps) };
}
const id = 'wxid_test_authorized_123';
test('alias derives from exact UTF-8 ID and never from list order or display name', () => {
  assert.equal(recipientAlias(id), `u_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`);
  assert.notEqual(recipientAlias('wxid_case'), recipientAlias('wxid_CASE'));
  assert.equal(recipientAlias(id), recipientAlias(id));
  for (const bad of [123, '', ' leading', 'trailing ', 'a\0b', 'a\nb', '\ud800']) assert.throws(() => recipientAlias(bad), { code: 'E_RECIPIENT_ID' });
});
test('read missing registry is empty and creates no private files', async t => {
  const fx = await fixture(t);
  assert.deepEqual(await fx.registry.read(), []);
  assert.deepEqual(await readdir(fx.directory), []);
  assert.throws(() => fx.registry.resolve(recipientAlias(id)), { code: 'E_RECIPIENT_UNKNOWN' });
});
test('atomic registration persists privately but default public methods contain only alias and full name', async t => {
  const fx = await fixture(t);
  const displayName = '完整姓名 👩‍💻 / 测试联系人';
  assert.deepEqual(await fx.registry.register({ id, displayName }), { alias: recipientAlias(id), displayName });
  assert.deepEqual(fx.registry.list(), [{ alias: recipientAlias(id), displayName }]);
  assert.equal(JSON.stringify(fx.registry.list()).includes(id), false);
  assert.equal(fx.registry.resolve(recipientAlias(id)), id);
  assert.deepEqual(fx.registry.list({ includeIds: true }), [{ alias: recipientAlias(id), id, displayName }]);
  assert.deepEqual(await readdir(fx.directory), ['recipients.json']);
  const privateData = JSON.parse(await readFile(fx.filePath, 'utf8'));
  assert.equal(privateData.recipients[0].id, id);
  const reopened = new RecipientRegistry({ recipientsFile: fx.filePath });
  assert.deepEqual(await reopened.read(), fx.registry.list());
  assert.equal(reopened.resolve(recipientAlias(id)), id);
});
test('new users and name updates do not change existing aliases; independent instances merge disk records', async t => {
  const fx = await fixture(t);
  await fx.registry.register({ id, displayName: '原名' });
  const other = new RecipientRegistry({ filePath: fx.filePath });
  await other.register({ id: 'custom_username', displayName: '其他联系人' });
  await fx.registry.register({ id, displayName: '更改后的完整名称' });
  assert.equal(fx.registry.list().length, 2);
  assert.equal(fx.registry.resolve(recipientAlias(id)), id);
  await fx.registry.register({ id });
  assert.equal(fx.registry.list().find(record => record.alias === recipientAlias(id)).displayName, '更改后的完整名称');
  assert.deepEqual(Object.keys(fx.registry.list()[0]).sort(), ['alias', 'displayName']);
});
test('same-instance concurrent registrations are serialized without losing recipients', async t => {
  const fx = await fixture(t);
  await Promise.all(['wxid_one', 'wxid_two', 'wxid_three'].map((id, index) => fx.registry.register({ id, displayName: `用户${index}` })));
  assert.equal(fx.registry.list().length, 3);
  assert.equal((JSON.parse(await readFile(fx.filePath, 'utf8'))).recipients.length, 3);
});
test('alias collision refuses overwrite and releases temporary lock', async t => {
  const fixed = 'u_0000000000000000';
  const fx = await fixture(t, {}, { aliasImpl: () => fixed });
  await fx.registry.register({ id: 'wxid_first', displayName: '第一人' });
  await assert.rejects(fx.registry.register({ id: 'wxid_second', displayName: '第二人' }), { code: 'E_RECIPIENT_COLLISION' });
  assert.equal(fx.registry.resolve(fixed), 'wxid_first');
  assert.deepEqual(await readdir(fx.directory), ['recipients.json']);
  assert.equal((await readFile(fx.filePath, 'utf8')).includes('wxid_second'), false);
});
test('tampered aliases, duplicates, invalid names and malformed files fail without leaking IDs', async t => {
  const fx = await fixture(t);
  for (const contents of [
    '{broken',
    { version: 2, recipients: [] },
    { version: 1, recipients: [{ alias: 'u_0000000000000000', id, displayName: '名字' }] },
    { version: 1, recipients: [{ alias: recipientAlias(id), id, displayName: '名字' }, { alias: recipientAlias(id), id, displayName: '重复' }] },
    { version: 1, recipients: [{ alias: recipientAlias(id), id, displayName: '\ud800' }] },
  ]) {
    await writeFile(fx.filePath, typeof contents === 'string' ? contents : JSON.stringify(contents));
    await assert.rejects(fx.registry.read(), error => {
      assert.match(error.code, /^E_RECIPIENT_/);
      assert.equal(error.message.includes(id), false);
      return true;
    });
  }
});
test('a busy private registry is not overwritten, and resolving requires a registered alias', async t => {
  const fx = await fixture(t);
  assert.throws(() => fx.registry.resolve(recipientAlias(id)), { code: 'E_RECIPIENT_NOT_LOADED' });
  assert.throws(() => fx.registry.resolve(id), { code: 'E_RECIPIENT_ALIAS' });
  await writeFile(`${fx.filePath}.lock`, '');
  await assert.rejects(fx.registry.register({ id, displayName: '测试联系人' }), { code: 'E_RECIPIENT_BUSY' });
  assert.deepEqual(fx.registry.list(), []);
  assert.deepEqual(await readdir(fx.directory), ['recipients.json.lock']);
});
