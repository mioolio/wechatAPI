import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { parseArgs, runCli } from '../src/cli.mjs';
import { createService } from '../src/service.mjs';

const key = '0123456789abcdef'.repeat(4);
const database = 'd_0123456789abcdef';

function capture() {
  let value = '';
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { value += chunk; callback(); } }),
    text: () => value,
  };
}

function cliHarness(decrypt) {
  const stdout = capture(), stderr = capture(), calls = [];
  const unexpected = () => { throw new Error('only decrypt may run'); };
  return {
    stdout, stderr, calls,
    dependencies: {
      input: Readable.from([]), output: stdout.stream, error: stderr.stream,
      terminal: false, interruptSource: new EventEmitter(),
      registry: { async read() {}, list() { return []; } },
      createService: async options => {
        calls.push(['create', options]);
        return {
          start: unexpected, db: unexpected, send: unexpected,
          decrypt: async args => { calls.push(['decrypt', args]); return decrypt(args); },
          close: async () => { calls.push(['close']); },
        };
      },
    },
  };
}

test('decrypt needs no database path, ID or output and only an explicit output requests a copy', () => {
  assert.deepEqual(parseArgs(['decrypt']), { command: 'decrypt', options: {}, args: { showKey: true, keyOnly: true } });
  assert.deepEqual(parseArgs(['decrypt', '--database', database, '--json']), {
    command: 'decrypt', options: { json: true }, args: { database, showKey: true, keyOnly: true },
  });
  assert.deepEqual(parseArgs(['decrypt', '--output', 'copy.sqlite', '--database', database]), {
    command: 'decrypt', options: {}, args: { output: 'copy.sqlite', database, showKey: true, keyOnly: false },
  });
  for (const argv of [
    ['decrypt', '--database', 'not-a-database-alias'], ['decrypt', 'unexpected'],
    ['decrypt', '--input', 'encrypted.sqlite'], ['decrypt', '--to', 'someone'],
    ['decrypt', '--timeout', '99'], ['decrypt', '--timeout', '30001'],
  ]) assert.throws(() => parseArgs(argv), { code: 'INVALID_ARGUMENT' });
});

test('decrypt CLI calls its own route and displays the successful key while IDs remain masked', async () => {
  const self = 'wxid_decrypt_demo_123';
  for (const flags of [[], ['--json']]) {
    const h = cliHarness(async () => ({ ok: true, key, self, displayName: '完整名称', token: 'private-token', dbKey: key, headers: { authorization: key }, child: { key } }));
    assert.equal(await runCli(['decrypt', ...flags], h.dependencies), 0);
    const result = JSON.parse(h.stdout.text());
    assert.equal(result.key, key);
    assert.equal(result.self === self, false);
    assert.equal(result.displayName, '完整名称');
    assert.equal(result.token, '[REDACTED]');
    assert.equal(result.dbKey, '[REDACTED]');
    assert.equal(result.headers, '[REDACTED]');
    assert.equal(result.child.key, '[REDACTED]');
    assert.deepEqual(h.calls, [
      ['create', { ...(flags.length ? { json: true } : {}), backend: 'reverse-native' }],
      ['decrypt', { showKey: true, keyOnly: true }], ['close'],
    ]);
    assert.equal(h.stderr.text(), '');
  }
});

test('decrypt CLI never grants key disclosure to an unsuccessful result', async () => {
  for (const ok of [false, undefined, 'true']) {
    const h = cliHarness(async () => ({ ...(ok === undefined ? {} : { ok }), key }));
    assert.equal(await runCli(['decrypt', '--json'], h.dependencies), 0);
    assert.equal(JSON.parse(h.stdout.text()).key, '[REDACTED]');
    assert.equal(h.stdout.text().includes(key), false);
  }
});

test('decrypt errors preserve the error code and give actionable advanced commands without disclosing keys', async () => {
  for (const flags of [[], ['--json']]) {
    const h = cliHarness(async () => { throw Object.assign(new Error(`cannot authenticate key=${key}`), { code: 'E_DB_KEY_NOT_FOUND' }); });
    assert.equal(await runCli(['decrypt', ...flags], h.dependencies), 1);
    assert.equal(h.stdout.text(), '');
    assert.equal(h.stderr.text().includes(key), false);
    assert.match(h.stderr.text(), /db list --json/);
    assert.match(h.stderr.text(), /help db decrypt/);
    if (flags.length) assert.equal(JSON.parse(h.stderr.text()).error.code, 'E_DB_KEY_NOT_FOUND');
    assert.deepEqual(h.calls.at(-1), ['close']);
  }
});

test('decrypt service starts reading, automatically selects a database and never constructs a send adapter', async () => {
  const calls = [];
  const options = { backend: 'reverse-native', pid: 123, timeout: 2500, 'install-path': 'D:\\Apps\\Weixin', 'token-file': 'private-host.json' };
  const result = { ok: true, key, keyAuthenticated: true };
  const service = await createService(options, {
    reverseFactory() { throw new Error('unexpected send adapter'); },
    startNativeRead: async received => { calls.push(['start', received]); return { ready: true }; },
    createDatabaseService: received => {
      calls.push(['database', received]);
      return { execute: async args => { calls.push(['execute', args]); return result; }, close: async () => { calls.push(['close']); } };
    },
  });
  assert.equal(await service.decrypt({}), result);
  assert.equal(await service.decrypt({ database, output: 'copy.sqlite', keyOnly: true, showKey: false }), result);
  await service.close();
  const { timeout: _timeout, ...startupOptions } = options;
  assert.deepEqual(calls, [
    ['start', startupOptions], ['database', options],
    ['execute', { action: 'decrypt', autoSelect: true, keyOnly: true, showKey: true }],
    ['start', startupOptions],
    ['execute', { database, output: 'copy.sqlite', action: 'decrypt', autoSelect: true, keyOnly: false, showKey: true }],
    ['close'],
  ]);
});

test('decrypt startup failure prevents database discovery or any sending setup', async () => {
  const calls = [];
  const error = Object.assign(new Error('native runtime unavailable'), { code: 'E_NATIVE_HOST_UNAVAILABLE' });
  const service = await createService({ backend: 'reverse-native' }, {
    reverseFactory() { throw new Error('unexpected send adapter'); },
    startNativeRead: async () => { calls.push('start'); throw error; },
    createDatabaseService() { throw new Error('database must wait for startup'); },
  });
  await assert.rejects(service.decrypt({}), caught => caught === error);
  await service.close();
  assert.deepEqual(calls, ['start']);
});

test('decrypt explicitly rejects non-native backends before starting any client', async () => {
  for (const backend of ['weflow-http', 'weflow-native', 'cache']) {
    const unexpected = () => { throw new Error('unexpected client access'); };
    const service = await createService({ backend }, { startNativeRead: unexpected, createDatabaseService: unexpected, reverseFactory: unexpected, httpFactory: unexpected, nativeFactory: unexpected });
    await assert.rejects(service.decrypt({}), { code: 'E_BACKEND' });
    await service.close();
  }
});
