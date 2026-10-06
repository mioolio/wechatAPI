import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivacyFormatter, redact, redactText, format, maskIdentifier } from '../src/privacy.mjs';
import { recipientAlias } from '../src/recipient-registry.mjs';
import { WxError } from '../src/errors.mjs';

const id = 'wxid_privacy_test_123';
const alias = recipientAlias(id);
const partial = maskIdentifier(id);
test('identity fields are partially hidden while complete names, message IDs and command metadata survive', () => {
  const source = { displayName: '测试联系人', nickname: '完整名字 👩‍💻', remark: '测试账号 完整备注', username: id, chatId: id, session_id: id, senderUsername: id, to: id, self: id, id: 'message-id', serverId: '12345678901234567890', pid: 16712, requestId: 'request-001', code: 'E_TEST', accepted: false };
  const result = redact(source);
  for (const key of ['username', 'chatId', 'session_id', 'senderUsername', 'to', 'self']) assert.equal(result[key], partial);
  for (const key of ['displayName', 'nickname', 'remark', 'id', 'serverId', 'pid', 'requestId', 'code', 'accepted']) assert.equal(result[key], source[key]);
  assert.equal(source.chatId, id);
});
test('embedded IDs in messages, errors, keys and Windows paths are hidden consistently', () => {
  const error = new WxError('E_CHAT_SCOPE', `拒绝 ${id} 的操作 C:\\Users\\${id}\\data.db`, { chatId: id });
  const result = redact({ event: { content: `收到 ${id} 的消息`, path: `D:\\${id}\\message.db` }, error, [id]: id });
  assert.equal(JSON.stringify(result).includes(id), false);
  assert.equal(result.error.code, 'E_CHAT_SCOPE');
  assert.equal(result.error.details.chatId, partial);
  assert.equal(result[alias], alias);
  assert.match(result.error.message, new RegExp(alias));
  assert.equal(redactText(`id=${id}`), `id=${alias}`);
});
test('formatter reads the current registry, keeping existing aliases and human names intact', () => {
  let records = [];
  const formatter = createPrivacyFormatter({ registry: { list: options => { assert.equal(options.includeIds, true); return records; } } });
  records = [{ id: 'custom_user_1', alias: recipientAlias('custom_user_1'), displayName: '完整姓名' }];
  const result = formatter.redact({ content: 'custom_user_1 发来的消息', displayName: '完整姓名' });
  assert.equal(result.content, `${recipientAlias('custom_user_1')} 发来的消息`);
  records.push({ id: 'another_user', alias: recipientAlias('another_user'), displayName: '新增姓名' });
  assert.equal(formatter.redact({ chatId: 'custom_user_1' }).chatId, maskIdentifier('custom_user_1'));
});
test('stable aliases are not hashed again and numeric known IDs never corrupt longer message IDs', () => {
  const formatter = createPrivacyFormatter({ identifiers: [alias, '123'] });
  const value = { alias, to: alias, id: '123', serverId: '123', messageId: '912345', content: '订单912345 / ID 123 / 12345', recipientId: '123' };
  const result = formatter.redact(value);
  assert.equal(result.alias, alias);
  assert.equal(result.to, alias);
  assert.equal(result.id, '123');
  assert.equal(result.serverId, '123');
  assert.equal(result.messageId, '912345');
  assert.equal(result.content, `订单912345 / ID ${recipientAlias('123')} / 12345`);
  assert.equal(result.recipientId, maskIdentifier('123'));
});
test('raw contact alias is hidden by default while stable numbered aliases and complete names stay intact', () => {
  const rawAlias = 'custom_weixin_account_123';
  const source = { contacts: [{ alias: rawAlias, displayName: '完整微信名称 👩‍💻' }, { alias, displayName: '测试联系人' }] };
  const result = redact(source);
  assert.equal(result.contacts[0].alias, maskIdentifier(rawAlias));
  assert.equal(JSON.stringify(result).includes(rawAlias), false);
  assert.equal(result.contacts[0].displayName, source.contacts[0].displayName);
  assert.equal(result.contacts[1].alias, alias);
  assert.equal(result.contacts[1].displayName, '测试联系人');
  assert.equal(redact(source, { enabled: false }).contacts[0].alias, rawAlias);
  assert.equal(source.contacts[0].alias, rawAlias);
});
test('tokens, secrets and request headers are hidden recursively and in textual errors', () => {
  const secret = 'raw-token-abcdef';
  const formatter = createPrivacyFormatter({ secrets: [secret] });
  const result = formatter.redact({ token: secret, accessToken: 'other-value', secret: { nested: 'credential' }, dbKey: 'database-key', headers: { authorization: 'Bearer top-secret', 'x-wxcc-token': secret }, requestHeaders: [['Cookie', 'session=top-secret']], child: { api_key: 'private-api-key' }, error: `Bearer bearer-secret; token=${secret}; x-wxcc-token: header-secret; secret="quoted private value"; URL https://example.test/?token=querysecret&x=1` });
  for (const key of ['token', 'accessToken', 'secret', 'dbKey', 'headers', 'requestHeaders']) assert.equal(result[key], '[REDACTED]');
  assert.equal(result.child.api_key, '[REDACTED]');
  const serialized = JSON.stringify(result);
  for (const plaintext of [secret, 'other-value', 'credential', 'database-key', 'top-secret', 'private-api-key', 'bearer-secret', 'header-secret', 'quoted private value', 'querysecret']) assert.equal(serialized.includes(plaintext), false);
});
test('explicit raw IDs preserve identifiers but always hide credentials', () => {
  const formatter = createPrivacyFormatter({ enabled: false, secrets: ['secret-value'], identifiers: [id] });
  const result = formatter.redact({ chatId: id, name: '测试联系人', token: 'secret-value', content: `${id} secret-value Bearer hidden` });
  assert.equal(result.chatId, id);
  assert.equal(result.name, '测试联系人');
  assert.equal(result.token, '[REDACTED]');
  assert.equal(result.content.includes(id), true);
  assert.equal(result.content.includes('secret-value'), false);
  assert.equal(result.content.includes('Bearer hidden'), false);
});
test('credentials take precedence over partial ID formatting, including unusual identity fields', () => {
  const result = redact({ username: 'credential-abcdefgh', maskedId: 'credential-abcdefgh', displayName: '测试联系人' }, { secrets: ['credential-abcdefgh'] });
  assert.equal(result.username, '[REDACTED]');
  assert.equal(result.maskedId, '[REDACTED]');
  assert.equal(result.displayName, '测试联系人');
  assert.equal(maskIdentifier('😀😀😀😀😀😀😀').isWellFormed(), true);
});
test('partial ID labels remain readable and never expose complete short IDs', () => {
  assert.equal(maskIdentifier(id), 'wxid_pri…123');
  assert.equal(maskIdentifier('wxid_abc'), 'wxid_…');
  const partial = maskIdentifier(id);
  assert.equal(redact({ maskedId: partial }).maskedId, partial);
  assert.equal(redactText(partial), partial);
  assert.equal(redact({ maskedId: id }).maskedId, partial);
});
test('an ellipsis appended to a complete real ID cannot bypass maskedId privacy formatting', () => {
  const fake = `${id}…`;
  const result = redact({ maskedId: fake });
  assert.equal(result.maskedId, maskIdentifier(fake));
  assert.equal(JSON.stringify(result).includes(id), false);
  assert.equal(redact({ maskedId: 'wxid_a…' }).maskedId, maskIdentifier('wxid_a…'));
  assert.equal(redact({ maskedId: partial }).maskedId, partial);
});
test('format emits JSON for BigInt, Error, cycles, repeated objects and binary without executing getters', () => {
  const child = { chatId: id }, value = { left: child, right: child, count: 10n, time: new Date('2026-10-02T12:00:00Z'), bytes: new Uint8Array([1, 2, 3]) };
  value.circular = value;
  Object.defineProperty(value, 'getter', { enumerable: true, get() { throw Error('must not run'); } });
  const result = JSON.parse(format(value, { pretty: true }));
  assert.equal(result.left.chatId, partial);
  assert.equal(result.right.chatId, partial);
  assert.equal(result.count, '10');
  assert.equal(result.time, '2026-10-02T12:00:00.000Z');
  assert.equal(result.bytes, '[Binary 3 bytes]');
  assert.equal(result.circular, '[Circular]');
  assert.equal(result.getter, '[Unavailable]');
  assert.match(format({ chatId: id }, { pretty: true }), /\n/);
});
test('untrusted __proto__ keys do not alter the sanitized result prototype', () => {
  const result = redact(JSON.parse(`{"__proto__":{"chatId":"${id}"},"chatId":"${id}"}`));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.__proto__.chatId, partial);
  assert.equal(result.chatId, partial);
});
test('Windows user profile paths hide the personal directory name without changing names or runtime input', () => {
  const value = { path: 'C:\\Users\\真实用户名\\Desktop\\WXcc', error: '打开失败：D:/Users/private-account/AppData/file.db', name: '完整真实姓名', requestId: '123456789012345' };
  const result = redact(value);
  assert.equal(result.path, 'C:\\Users\\[USER]\\Desktop\\WXcc');
  assert.equal(result.error, '打开失败：D:/Users/[USER]/AppData/file.db');
  assert.equal(result.name, value.name);
  assert.equal(result.requestId, value.requestId);
  assert.equal(value.path.includes('真实用户名'), true);
  assert.equal(redact(value, { enabled: false }).path, value.path);
});
