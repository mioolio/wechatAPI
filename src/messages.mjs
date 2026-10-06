import { WxError } from './errors.mjs';

function id(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new WxError('E_MESSAGE', `${field} 必须是非空字符串；消息 ID 不转换成 Number。`);
  }
  return value;
}

export function normalizeMessage(input) {
  if (!input || typeof input !== 'object') throw new WxError('E_MESSAGE', '消息必须是对象。');
  const message = {
    id: id(input.id, 'id'),
    chatId: id(input.chatId, 'chatId'),
    senderId: id(input.senderId, 'senderId'),
    isSelf: input.isSelf,
    type: input.type,
    text: input.text,
    timestamp: input.timestamp
  };
  if (typeof message.isSelf !== 'boolean') throw new WxError('E_MESSAGE', 'isSelf 必须是布尔值。');
  if (typeof message.type !== 'string' || !message.type) throw new WxError('E_MESSAGE', 'type 必须是非空字符串。');
  if (typeof message.text !== 'string' || message.text.length > 1024 * 1024) throw new WxError('E_MESSAGE', 'text 必须是长度受限的字符串。');
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0) throw new WxError('E_MESSAGE', 'timestamp 必须为毫秒整数。');
  return message;
}

export class MessageIndex {
  constructor({ maxEntries = 10000 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer');
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  add(input) {
    const message = normalizeMessage(input);
    const key = `${message.chatId}\0${message.id}`;
    if (this.entries.has(key)) return null;
    this.entries.set(key, message);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return message;
  }

  history({ to, limit = 30 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new WxError('E_ARGUMENT', 'limit 必须在 1 至 10000 之间。');
    return [...this.entries.values()].filter(m => !to || m.chatId === to).sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
  }

  list() {
    const chats = new Map();
    for (const message of this.entries.values()) {
      const chat = chats.get(message.chatId);
      if (!chat || message.timestamp >= chat.lastMessage.timestamp) chats.set(message.chatId, { chatId: message.chatId, lastMessage: message });
    }
    return [...chats.values()].sort((a, b) => b.lastMessage.timestamp - a.lastMessage.timestamp);
  }
}
