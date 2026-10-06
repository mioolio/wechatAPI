import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CaptureStore } from '../src/store.mjs';

async function temporaryStore(run) {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'wxcc-store-'));
  try { await run(directory); }
  finally {
    // Validate the computed Windows target before recursively removing this fixture.
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(basename(directory).startsWith('wxcc-store-'));
    await rm(directory, { recursive: true, force: true });
  }
}

function message(id, overrides = {}) {
  return { id, chatId: '007', senderId: 'wxid_sender', isSelf: false, type: 'text', text: `message ${id}`, timestamp: 1000, ...overrides };
}

test('missing capture file loads as empty without creating a file', async () => {
  await temporaryStore(async directory => {
    const path = join(directory, 'missing', 'messages.ndjson');
    const store = new CaptureStore(path);
    await store.load();
    assert.deepEqual(store.index.history(), []);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  });
});

test('queued writes are ordered, deduplicated and reloadable without ID precision loss', async () => {
  await temporaryStore(async directory => {
    const path = join(directory, 'nested', 'messages.ndjson');
    const store = new CaptureStore(path);
    const first = message('9007199254740993', { timestamp: 2000 });
    const second = message('9007199254740994', { timestamp: 3000 });
    const results = await Promise.all([store.append(first), store.append(first), store.append(second)]);
    await store.flush();
    assert.deepEqual(results, [first, null, second]);
    const contents = await readFile(path, 'utf8');
    assert.ok(contents.endsWith('\n'));
    assert.deepEqual(contents.trimEnd().split('\n').map(line => JSON.parse(line)), [first, second]);
    const reopened = new CaptureStore(path);
    await reopened.load();
    assert.deepEqual(reopened.index.history({ to: '007' }), [first, second]);
    assert.equal(await reopened.append(first), null);
    assert.equal(await readFile(path, 'utf8'), contents);
  });
});

test('concurrent submissions preserve NDJSON boundaries and per-chat identity', async () => {
  await temporaryStore(async directory => {
    const path = join(directory, 'messages.ndjson');
    const store = new CaptureStore(path);
    const messages = Array.from({ length: 20 }, (_, index) => message(String(index), {
      chatId: index % 2 ? 'group@chatroom' : '007', timestamp: 1000 + index, text: '多行\n正文 "quoted"',
    }));
    messages.push(message('0', { chatId: 'another', timestamp: 3000 }));
    await Promise.all(messages.map(item => store.append(item)));
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, messages.length);
    assert.deepEqual(lines.map(line => JSON.parse(line)), messages);
    assert.equal(store.index.list().length, 3);
  });
});

test('load rejects incomplete or malformed records instead of silently discarding them', async () => {
  await temporaryStore(async directory => {
    const path = join(directory, 'messages.ndjson');
    await writeFile(path, JSON.stringify(message('1')));
    await assert.rejects(new CaptureStore(path).load(), { code: 'E_CAPTURE_FILE' });
    await writeFile(path, `${JSON.stringify(message('1'))}\ninvalid JSON\n`);
    await assert.rejects(new CaptureStore(path).load(), error => error.code === 'E_CAPTURE_FILE' && error.message.includes('2'));
    await writeFile(path, `${JSON.stringify(message(9007199254740992))}\n`);
    await assert.rejects(new CaptureStore(path).load(), { code: 'E_CAPTURE_FILE' });
  });
});

test('a failed persistent write does not publish an unpersisted message in history', async () => {
  await temporaryStore(async directory => {
    const blockedParent = join(directory, 'blocked');
    await writeFile(blockedParent, 'regular file, not a directory');
    const store = new CaptureStore(join(blockedParent, 'messages.ndjson'));
    await assert.rejects(store.append(message('never-persisted')));
    assert.deepEqual(store.index.history(), []);
    assert.deepEqual(store.index.list(), []);
    await assert.rejects(store.flush());
  });
});
