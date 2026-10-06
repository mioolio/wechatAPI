import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MessageIndex, normalizeMessage } from './messages.mjs';
import { WxError } from './errors.mjs';

export class CaptureStore {
  constructor(path, options) {
    this.path = path;
    this.index = new MessageIndex(options);
    this.queue = Promise.resolve();
  }

  async load() {
    let text;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const lines = text.split('\n');
    // An incomplete last line is a failed write, never a valid captured message.
    if (lines.at(-1) !== '') throw new WxError('E_CAPTURE_FILE', '消息文件末行不完整，请先修复后再继续采集。');
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i]) continue;
      try { this.index.add(JSON.parse(lines[i])); }
      catch (error) { throw new WxError('E_CAPTURE_FILE', `消息文件第 ${i + 1} 行无效。`, { cause: error.message }); }
    }
  }

  async append(input) {
    const task = this.queue.then(async () => {
      const message = normalizeMessage(input);
      if (this.index.entries.has(`${message.chatId}\0${message.id}`)) return null;
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.index.add(message);
      return message;
    });
    this.queue = task;
    return task;
  }

  async flush() { await this.queue; }
}
