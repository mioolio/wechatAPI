import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { parseArgs, runCli, tokenize } from '../src/cli.mjs';

test('portable startup, local target and database routes select native without sending', async () => {
  for (const [argv, method, expected] of [
    [['start', '--install-path', 'D:\\Apps\\Weixin', '--timeout', '20000', '--json'], 'start', {}],
    [['configure-target', '--to', 'u_0123456789abcdef', '--json'], 'configureTarget', { to: 'u_0123456789abcdef' }],
    [['db', 'list', '--json'], 'db', { action: 'list' }],
  ]) {
    const h = harness({ [method]: async args => { h.calls.push([method, args]); return { automaticMessagesSent: 0 }; } });
    assert.equal(await runCli(argv, h.dependencies), 0);
    assert.equal(h.calls[0][1].backend, 'reverse-native');
    assert.deepEqual(h.calls[1], [method, expected]);
    assert.ok(!h.calls.some(([name]) => name === 'send'));
  }
});

function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk; callback(); } });
  return { stream, text: () => text };
}

function harness(overrides = {}) {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const interrupts = new EventEmitter();
  const service = {
    doctor: async () => ({ available: true }),
    inspect: async () => ({ controls: [] }),
    account: async args => { calls.push(['account', args]); return { source: 'reverse-native', self: 'wxid_account_fixture123', verified: true }; },
    accounts: async args => { calls.push(['accounts', args]); return { source: 'reverse-native', accounts: [] }; },
    list: async () => [],
    history: async args => { calls.push(['history', args]); return [{ id: '9007199254740993' }]; },
    send: async args => { calls.push(['send', args]); return { accepted: true }; },
    watch: async ({ onEvent }) => { onEvent({ id: '1', text: 'first' }); onEvent({ id: '2', text: 'second' }); },
    probe: async ({ onEvent }) => { onEvent({ event: 'candidate-hit', chatValidated: false }); },
    close: async () => { calls.push(['close']); },
    ...overrides,
  };
  const dependencies = {
    input: Readable.from([]), output: stdout.stream, error: stderr.stream,
    terminal: false, interruptSource: interrupts,
    registry: { async read() {}, list() { return []; } },
    createService: async options => { calls.push(['create', options]); return service; },
  };
  return { stdout, stderr, calls, interrupts, dependencies };
}

test('global options work before and after commands; IDs stay strings', () => {
  assert.deepEqual(parseArgs(['--json', 'history', '00123', '--pid=123', '--profile', 'C:\\logs', '--limit', '7', '--verbose']), {
    command: 'history', options: { json: true, pid: 123, profile: 'C:\\logs', verbose: true }, args: { to: '00123', limit: 7 },
  });
  assert.deepEqual(parseArgs(['history', '--to', '9007199254740993']).args, { to: '9007199254740993', limit: 30 });
  assert.deepEqual(parseArgs(['send', '--text', 'hello world', '--to', '007']).args, { text: 'hello world', to: '007' });
  assert.deepEqual(parseArgs(['probe']).args, { seconds: 30 });
  assert.deepEqual(parseArgs(['probe', '--seconds=15', '--to', '007']).args, { seconds: 15, to: '007' });
  assert.deepEqual(parseArgs(['--self', '001', 'watch']).options, { self: '001' });
  assert.deepEqual(parseArgs(['probe', '--self=wxid_me']).options, { self: 'wxid_me' });
});

test('WeFlow connection options and contact keyword are parsed without shell interpretation', () => {
  assert.deepEqual(parseArgs(['contacts', '--keyword', '测试联系人', '--backend', 'weflow-http', '--url=http://127.0.0.1:5031', '--token-file', 'C:\\private\\token.txt', '--interval', '1500']), {
    command: 'contacts', options: { backend: 'weflow-http', url: 'http://127.0.0.1:5031', 'token-file': 'C:\\private\\token.txt', interval: 1500 }, args: { keyword: '测试联系人' },
  });
  assert.throws(() => parseArgs(['history', 'wxid_test', '--keyword', '测试联系人']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseArgs(['watch', 'wxid_test', '--interval', '0']), { code: 'INVALID_ARGUMENT' });
});

test('reverse-native accepts exactly one string target and a local send request ID', () => {
  assert.deepEqual(parseArgs(['send', '--backend', 'reverse-native', '--session', '0018446744073709551615', '--text', 'mock', '--request-id', 'Unique-ID']), {
    command: 'send', options: { backend: 'reverse-native' }, args: { session: '0018446744073709551615', text: 'mock', requestId: 'Unique-ID' },
  });
  assert.deepEqual(parseArgs(['send', '--session', '0x001', 'mock']).args, { session: '0x001', text: 'mock' });
  for (const argv of [
    ['send', '--to', 'one', '--session', 'two', '--text', 'mock'],
    ['send', '--session', 'one'], ['send', '--text', 'mock', '--request-id', 'id'],
    ['history', '--session', 'one'], ['doctor', '--request-id', 'id'],
  ]) assert.throws(() => parseArgs(argv), { code: 'INVALID_ARGUMENT' });
});

test('CLI forwards native internal session IDs and never converts long string IDs', async () => {
  const h = harness();
  assert.equal(await runCli(['send', '--backend', 'reverse-native', '--session', '0018446744073709551615', '--text', 'mock-only', '--request-id', 'send-1', '--json'], h.dependencies), 0);
  assert.deepEqual(h.calls[0], ['create', { backend: 'reverse-native', json: true }]);
  assert.deepEqual(h.calls[1], ['send', { session: '0018446744073709551615', text: 'mock-only', requestId: 'send-1' }]);
});
test('send alone defaults to reverse-native while explicit read backend choice is preserved', async () => {
  for (const backend of [undefined, 'weflow-http']) {
    const h = harness();
    const args = ['send', '--to', 'wxid_fixture', '--text', 'mock-only', '--json', ...(backend ? ['--backend', backend] : [])];
    assert.equal(await runCli(args, h.dependencies), 0);
    assert.deepEqual(h.calls[0], ['create', { json: true, backend: backend ?? 'reverse-native' }]);
  }
});

test('CLI forwards contact searches to the selected backend', async () => {
  const h = harness({ contacts: async args => { h.calls.push(['contacts', args]); return { contacts: [] }; } });
  assert.equal(await runCli(['contacts', '--keyword', '测试联系人', '--backend', 'weflow-native', '--root', 'D:\\Apps\\WeFlow', '--json'], h.dependencies), 0);
  assert.deepEqual(h.calls[0], ['create', { backend: 'weflow-native', root: 'D:\\Apps\\WeFlow', json: true }]);
  assert.deepEqual(h.calls[1], ['contacts', { keyword: '测试联系人' }]);
});

test('rejects incomplete send and unknown or ambiguous arguments', () => {
  for (const argv of [
    ['send', '--text', 'hello'], ['send', '--to', '123'], ['send', '123', ''],
    ['send', '123', 'hello', 'world'], ['history', '--to', '123', '--limit', '0'],
    ['doctor', '--to', '123'], ['list', '--wat'], ['--pid', 'invalid', 'doctor'],
    ['watch', '--to', 'a', '--to', 'b'], ['unknown'],
    ['probe', '--seconds', '0'], ['probe', '--seconds', '1.5'], ['watch', '--seconds', '3'],
    ['watch', '--self='],
  ]) assert.throws(() => parseArgs(argv), { code: 'INVALID_ARGUMENT' });
});

test('REPL lexer preserves quoted text and Windows paths without shell execution', () => {
  assert.deepEqual(tokenize('send "007" --text "你好 世界" --profile C:\\Users\\me'), ['send', '007', '--text', '你好 世界', '--profile', 'C:\\Users\\me']);
  assert.deepEqual(tokenize("send '007' 'a \"quote\" $(x)'"), ['send', '007', 'a "quote" $(x)']);
  assert.throws(() => tokenize('send 007 "open'), /引号未闭合/);
});

test('JSON command output goes to stdout and service options are forwarded', async () => {
  const h = harness();
  assert.equal(await runCli(['history', '--to', '001', '--json', '--pid', '88'], h.dependencies), 0);
  assert.deepEqual(JSON.parse(h.stdout.text()), [{ id: '9007199254740993' }]);
  assert.equal(h.stderr.text(), '');
  assert.deepEqual(h.calls, [['create', { json: true, pid: 88, backend: 'reverse-native' }], ['history', { to: '001', limit: 30 }], ['close']]);
  assert.equal(h.interrupts.listenerCount('SIGINT'), 0);
});

test('watch emits exactly one JSON object per line even without --json', async () => {
  const h = harness();
  assert.equal(await runCli(['watch'], h.dependencies), 0);
  assert.deepEqual(h.stdout.text().trim().split('\n').map(line => JSON.parse(line)), [{ id: '1', text: 'first' }, { id: '2', text: 'second' }]);
  assert.equal(h.stderr.text(), '');
});

test('probe forwards duration and filter, and preserves unvalidated NDJSON events', async () => {
  const h = harness({ probe: async ({ seconds, to, onEvent }) => {
    h.calls.push(['probe', { seconds, to }]);
    onEvent({ event: 'candidate-hit', chatValidated: false });
  } });
  assert.equal(await runCli(['probe', '--seconds', '2', '--to', '007'], h.dependencies), 0);
  assert.equal(h.stdout.text(), '{"event":"candidate-hit","chatValidated":false}\n');
  assert.deepEqual(h.calls[1], ['probe', { seconds: 2, to: '007' }]);
  assert.equal(h.stderr.text(), '');
});

test('self is passed through to the service for watch and probe', async () => {
  for (const command of ['watch', 'probe']) {
    const h = harness();
    assert.equal(await runCli([command, '--self', '001', '--json'], h.dependencies), 0);
    assert.deepEqual(h.calls[0], ['create', { self: '001', json: true }]);
  }
});

test('unsupported capabilities fail without printing success', async () => {
  const h = harness({ send: async () => { const error = new Error('send unavailable'); error.code = 'UNSUPPORTED'; throw error; } });
  assert.equal(await runCli(['send', '--to', 'filehelper', '--text', 'test', '--json'], h.dependencies), 1);
  assert.equal(h.stdout.text(), '');
  assert.deepEqual(JSON.parse(h.stderr.text()), { error: { code: 'UNSUPPORTED', message: 'send unavailable' } });
  assert.deepEqual(h.calls.at(-1), ['close']);
});

test('invalid arguments do not create a service or invoke send', async () => {
  const h = harness();
  assert.equal(await runCli(['send', '--to', '007', '--json'], h.dependencies), 2);
  assert.equal(h.calls.length, 0);
  assert.equal(h.stdout.text(), '');
  assert.equal(JSON.parse(h.stderr.text()).error.code, 'INVALID_ARGUMENT');
});

test('a missing service method reports Unsupported explicitly', async () => {
  const h = harness({ list: undefined });
  assert.equal(await runCli(['list', '--json'], h.dependencies), 1);
  assert.equal(h.stdout.text(), '');
  assert.equal(JSON.parse(h.stderr.text()).error.code, 'UNSUPPORTED');
});

test('REPL shares a service, accepts quoted input, recovers from errors and exits', async () => {
  const h = harness();
  h.dependencies.input = Readable.from(['bogus\nsend "007" "你好 世界"\nhistory 007 --limit 2\nexit\n']);
  assert.equal(await runCli(['--json'], h.dependencies), 0);
  assert.deepEqual(h.calls.filter(call => call[0] !== 'close'), [
    ['create', { json: true, backend: 'reverse-native' }], ['send', { to: '007', text: '你好 世界' }], ['history', { to: '007', limit: 2 }],
  ]);
  assert.equal(h.stdout.text().trim().split('\n').length, 2);
  assert.equal(JSON.parse(h.stderr.text()).error.code, 'INVALID_ARGUMENT');
});

test('SIGINT cancels one-shot watch and closes service', async () => {
  const h = harness({ watch: ({ signal, onEvent }) => new Promise(resolve => {
    onEvent({ id: 'first' });
    signal.addEventListener('abort', () => { onEvent({ id: 'late' }); resolve(); }, { once: true });
    setImmediate(() => h.interrupts.emit('SIGINT'));
  }) });
  assert.equal(await runCli(['watch'], h.dependencies), 0);
  assert.equal(h.stdout.text(), '{"id":"first"}\n');
  assert.deepEqual(h.calls.at(-1), ['close']);
});

test('SIGINT cancels probe and suppresses events emitted after cancellation', async () => {
  const h = harness({ probe: ({ signal, onEvent }) => new Promise((_resolve, reject) => {
    onEvent({ event: 'candidate-hit' });
    signal.addEventListener('abort', () => {
      onEvent({ event: 'late' });
      const error = new Error('cancelled');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
    setImmediate(() => h.interrupts.emit('SIGINT'));
  }) });
  assert.equal(await runCli(['probe'], h.dependencies), 0);
  assert.equal(h.stdout.text(), '{"event":"candidate-hit"}\n');
  assert.equal(h.stderr.text(), '');
  assert.deepEqual(h.calls.at(-1), ['close']);
});

test('SIGINT treats the adapter E_ABORTED result as intentional cancellation', async () => {
  const h = harness({ probe: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('已取消。');
      error.code = 'E_ABORTED';
      reject(error);
    }, { once: true });
    setImmediate(() => h.interrupts.emit('SIGINT'));
  }) });
  assert.equal(await runCli(['probe'], h.dependencies), 0);
  assert.equal(h.stderr.text(), '');
});

test('SIGINT during REPL watch returns to command processing', async () => {
  const input = new PassThrough();
  const h = harness({ watch: ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => {
      resolve();
      setImmediate(() => input.end('status\nexit\n'));
    }, { once: true });
    setImmediate(() => h.interrupts.emit('SIGINT'));
  }) });
  h.dependencies.input = input;
  const running = runCli(['--json'], h.dependencies);
  input.write('watch\n');
  assert.equal(await running, 0);
  assert.deepEqual(JSON.parse(h.stdout.text()), { available: true });
  assert.deepEqual(h.calls.at(-1), ['close']);
});

test('ID privacy is on by default and is disabled only by an explicit option', async () => {
  const real = 'wxid_demonstration_contact123';
  for (const flags of [[], ['--redact', 'true'], ['--redact', 'false'], ['--no-redact']]) {
    const h = harness({ ids: async () => ({ users: [{ alias: 'u_0123456789abcdef', displayName: '完整姓名', chatId: real }], token: 'must-stay-secret' }) });
    assert.equal(await runCli(['ids', '--json', ...flags], h.dependencies), 0);
    const value = JSON.parse(h.stdout.text());
    assert.equal(value.users[0].displayName, '完整姓名');
    assert.equal(value.users[0].alias, 'u_0123456789abcdef');
    assert.equal(value.users[0].chatId === real, flags.includes('false') || flags.includes('--no-redact'));
    assert.equal(h.stdout.text().includes('must-stay-secret'), false);
    assert.equal(h.calls[0][1].backend, 'reverse-native');
  }
  for (const flags of [['--redact', 'sometimes'], ['--redact=true', '--no-redact'], ['--pick']]) assert.throws(() => parseArgs(['ids', ...flags]));
});

test('privacy covers parser errors, service errors and streamed events', async () => {
  const real = 'wxid_private_fixture123';
  const parser = harness();
  assert.equal(await runCli(['unknown', real, '--json'], parser.dependencies), 2);
  assert.equal(parser.stderr.text().includes(real), false);
  const error = harness({ history: async () => { throw new Error(`private path C:\\data\\${real}`); } });
  assert.equal(await runCli(['history', '--to', real, '--json'], error.dependencies), 1);
  assert.equal(error.stderr.text().includes(real), false);
  const event = harness({ watch: async ({ onEvent }) => onEvent({ chatId: real, content: `ID=${real}`, displayName: '完整姓名' }) });
  assert.equal(await runCli(['watch', '--to', real], event.dependencies), 0);
  assert.equal(event.stdout.text().includes(real), false);
  assert.equal(JSON.parse(event.stdout.text()).displayName, '完整姓名');
});

test('pick fetches IDs before sending and requires an explicit registered choice', async () => {
  const alias = 'u_0123456789abcdef';
  for (const choice of [alias, 'cancel', 'u_ffffffffffffffff', '']) {
    const h = harness({ ids: async () => ({ users: [{ alias, displayName: '测试联系人', chatId: 'wxid_private123', canSend: true }] }) });
    h.dependencies.input = Readable.from([`${choice}\n`]);
    const code = await runCli(['send', '--pick', '--text', 'mock-only', '--json'], h.dependencies);
    assert.equal(code, choice && ![alias, 'cancel'].includes(choice) ? 1 : 0);
    const sends = h.calls.filter(call => call[0] === 'send');
    assert.equal(sends.length, choice === alias ? 1 : 0);
    if (sends.length) assert.deepEqual(sends[0][1], { to: alias, text: 'mock-only' });
    assert.equal(h.stdout.text().includes('wxid_private123'), false);
  }
});

test('pick refuses users outside the send whitelist and supports REPL selection', async () => {
  const alias = 'u_0123456789abcdef';
  const blocked = harness({ ids: async () => ({ users: [{ alias, displayName: '其他联系人', canSend: false }] }) });
  blocked.dependencies.input = Readable.from([`${alias}\n`]);
  assert.equal(await runCli(['send', '--pick', '--text', 'mock-only', '--json'], blocked.dependencies), 1);
  assert.equal(blocked.calls.some(call => call[0] === 'send'), false);
  const repl = harness({ ids: async () => ({ users: [{ alias, displayName: '测试联系人', canSend: true }] }) });
  repl.dependencies.input = Readable.from([`send --pick --text mock-only\n${alias}\nstatus\nexit\n`]);
  assert.equal(await runCli(['--json'], repl.dependencies), 0);
  assert.deepEqual(repl.calls.find(call => call[0] === 'send')[1], { to: alias, text: 'mock-only' });
  assert.equal(repl.stdout.text().includes('available'), true);
});

test('send-status is an explicit offline journal query and never invokes send', async () => {
  const h = harness({ sendStatus: async args => { h.calls.push(['sendStatus', args]); return { requestId: args.requestId, status: 'unknown', deliveryConfirmed: false }; } });
  assert.equal(await runCli(['send-status', '--request-id', 'test-request', '--json'], h.dependencies), 0);
  assert.equal(h.calls[0][1].backend, 'reverse-native');
  assert.deepEqual(h.calls[1], ['sendStatus', { requestId: 'test-request' }]);
  assert.equal(h.calls.some(call => call[0] === 'send'), false);
  assert.throws(() => parseArgs(['send-status']));
});

test('account commands have no positional or command-local arguments', () => {
  for (const command of ['account', 'accounts']) {
    assert.deepEqual(parseArgs([command, '--json']), { command, options: { json: true }, args: {} });
    assert.throws(() => parseArgs([command, 'unexpected']), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => parseArgs([command, '--to', 'u_0123456789abcdef']), { code: 'INVALID_ARGUMENT' });
  }
});

test('account and accounts default to reverse-native and preserve explicit backends', async () => {
  for (const command of ['account', 'accounts']) {
    for (const backend of [undefined, 'weflow-native']) {
      const h = harness();
      assert.equal(await runCli([command, '--json', ...(backend ? ['--backend', backend] : [])], h.dependencies), 0);
      assert.deepEqual(h.calls, [['create', { json: true, backend: backend ?? 'reverse-native' }], [command, {}], ['close']]);
      assert.equal(h.calls.some(call => call[0] === 'send'), false);
    }
  }
});

test('account self is masked by default and disclosure is explicit', async () => {
  const self = 'legacy_account_fixture123';
  for (const flags of [[], ['--no-redact']]) {
    const h = harness({ account: async () => ({ source: 'reverse-native', self, verified: true }) });
    assert.equal(await runCli(['account', '--json', ...flags], h.dependencies), 0);
    const result = JSON.parse(h.stdout.text());
    assert.equal(result.self === self, flags.includes('--no-redact'));
    assert.equal(result.verified, true);
    assert.equal(h.stderr.text(), '');
  }
});

test('history defaults to reverse-native and passes stable aliases unchanged', async () => {
  const to = 'u_0123456789abcdef';
  for (const backend of [undefined, 'weflow-http', 'weflow-native', 'cache']) {
    const h = harness();
    assert.equal(await runCli(['history', '--to', to, '--limit', '30', '--json', ...(backend ? ['--backend', backend] : [])], h.dependencies), 0);
    assert.deepEqual(h.calls, [['create', { json: true, backend: backend ?? 'reverse-native' }], ['history', { to, limit: 30 }], ['close']]);
    assert.equal(typeof h.calls[1][1].to, 'string');
  }
  const unchanged = harness();
  assert.equal(await runCli(['list', '--json'], unchanged.dependencies), 0);
  assert.deepEqual(unchanged.calls[0], ['create', { json: true }]);
});

test('unverified native history fails without a success result or send invocation', async () => {
  const h = harness({ history: async () => { const error = new Error('History has not been verified for this runtime.'); error.code = 'E_NATIVE_HISTORY_UNVERIFIED'; throw error; } });
  assert.equal(await runCli(['history', '--to', 'u_0123456789abcdef', '--json'], h.dependencies), 1);
  assert.equal(h.stdout.text(), '');
  assert.equal(JSON.parse(h.stderr.text()).error.code, 'E_NATIVE_HISTORY_UNVERIFIED');
  assert.equal(h.calls.some(call => call[0] === 'send'), false);
});

test('REPL account and alias history reuse the default native service', async () => {
  const h = harness();
  h.dependencies.input = Readable.from(['account\naccounts\nhistory --to u_0123456789abcdef --limit 2\nexit\n']);
  assert.equal(await runCli(['--json'], h.dependencies), 0);
  assert.deepEqual(h.calls, [
    ['create', { json: true, backend: 'reverse-native' }], ['account', {}], ['accounts', {}],
    ['history', { to: 'u_0123456789abcdef', limit: 2 }], ['close'],
  ]);
  assert.equal(h.stdout.text().trim().split('\n').length, 3);
  assert.equal(h.stderr.text(), '');
});
