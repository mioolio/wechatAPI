import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { runCli, parseArgs } from '../src/cli.mjs';
import { renderHelp, helpData } from '../src/help.mjs';

test('topic help and JSON directory do not initialize clients or private registries', async () => {
  for (const argv of [['help', 'history'], ['db', 'decrypt', '--help'], ['help', '--json']]) {
    let text = '';
    const stream = new Writable({ write(chunk, _, done) { text += chunk; done(); } });
    const fail = () => { throw new Error('help touched private runtime'); };
    assert.equal(await runCli(argv, { output: stream, error: stream, input: Readable.from([]), createService: fail, registry: { read: fail } }), 0);
    if (argv.includes('--json')) { const data = JSON.parse(text); assert.ok(data.commands['db decrypt']); assert.equal(data.defaultRedaction, true); }
    else assert.match(text, /用法：wxcc/);
  }
});
test('typos suggest but never execute another command, and unsupported topics fail', () => {
  assert.throws(() => parseArgs(['histroy', '--to', 'u_0123456789abcdef']), /可能是 history/);
  assert.throws(() => parseArgs(['history', '--lmit', '20']), /可能是 --limit/);
  assert.throws(() => parseArgs(['db', 'decrpyt']), /可能是 decrypt/);
  assert.throws(() => helpData('nonexistent'), { code: 'INVALID_ARGUMENT' });
  assert.match(renderHelp('send'), /accepted/);
});
test('new commands enforce unambiguous database/key/output selection before any IO', () => {
  assert.deepEqual(parseArgs(['db', 'list', '--data-root', 'D:\\Private\\xwechat_files']).args, { action: 'list' });
  assert.deepEqual(parseArgs(['configure-target', '--to', 'u_0123456789abcdef']).args, { to: 'u_0123456789abcdef' });
  assert.deepEqual(parseArgs(['db', 'decrypt', '--input', 'encrypted.db', '--key-file', 'key.txt', '--key-mode', 'auto', '--output', 'copy.sqlite']).args, { action: 'decrypt', input: 'encrypted.db', keyMode: 'auto', output: 'copy.sqlite' });
  for (const argv of [['db', 'decrypt'], ['db', 'decrypt', '--database', 'bad', '--output', 'x'], ['db', 'decrypt', '--input', 'x', '--output', 'y'], ['db', 'list', '--output', 'x'], ['configure-target'], ['db', 'decrypt', '--database', 'd_0123456789abcdef', '--input', 'x', '--output', 'y']]) assert.throws(() => parseArgs(argv), { code: 'INVALID_ARGUMENT' });
});
