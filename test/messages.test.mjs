import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageIndex, normalizeMessage } from '../src/messages.mjs';

const message = { id: '18446744073709551614', chatId: 'room@chatroom', senderId: 'wxid_person', isSelf: false, type: 'text', text: '相同文字', timestamp: 12345 };

test('64-bit IDs keep exact text and numeric IDs are rejected', () => {
  assert.equal(normalizeMessage(message).id, message.id);
  assert.throws(() => normalizeMessage({ ...message, id: Number(message.id) }), { code: 'E_MESSAGE' });
});

test('dedupe uses conversation and message ID, not message body', () => {
  const index = new MessageIndex();
  assert.ok(index.add(message));
  assert.equal(index.add({ ...message }), null);
  assert.ok(index.add({ ...message, id: 'another' }));
  assert.ok(index.add({ ...message, chatId: 'private' }));
  assert.equal(index.history({ to: message.chatId }).length, 2);
});

test('history is time ordered and retention stays bounded', () => {
  const index = new MessageIndex({ maxEntries: 2 });
  index.add(message);
  index.add({ ...message, id: 'b', timestamp: 12347 });
  index.add({ ...message, id: 'c', timestamp: 12346 });
  assert.deepEqual(index.history().map(m => m.id), ['c', 'b']);
  assert.equal(index.list()[0].lastMessage.id, 'b');
  assert.throws(() => index.history({ limit: -1 }), { code: 'E_ARGUMENT' });
});
