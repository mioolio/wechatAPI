import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { parseArgs, runCli } from '../src/cli.mjs';

const copy = `c_${'1'.repeat(32)}`;
const record = `m_${'2'.repeat(16)}`;
const change = `e_${'3'.repeat(32)}`;
test('record parser preserves exact source IDs and zero revisions, supports clear text and subcommand help', () => {
  assert.deepEqual(parseArgs(['record', 'edit', '--copy', copy, '--message-id', '18446744073709551615', '--text', '', '--timestamp', '0', '--revision', '0']).args,
    { action: 'edit', copyId: copy, messageId: '18446744073709551615', text: '', timestamp: 0, expectedRevision: 0 });
  assert.deepEqual(parseArgs(['record', 'undo', '--copy', copy, '--change-id', change]).args, { action: 'undo', copyId: copy, changeId: change });
  assert.deepEqual(parseArgs(['record', 'import', '--to', 'u_0123456789abcdef']).args, { action: 'import', to: 'u_0123456789abcdef', limit: 30 });
  assert.deepEqual(parseArgs(['record', 'edit', '--help']).args, { topic: 'record edit' });
  assert.deepEqual(parseArgs(['record']).args, { action: 'list' });
  assert.deepEqual(parseArgs(['record', 'show', '--copy', copy]).args, { action: 'show', copyId: copy, limit: 30 });
});
test('record parser rejects missing selectors, conflicting patches, scope mixing and invalid revisions before IO', () => {
  for (const argv of [
    ['record', 'import'], ['record', 'import', '--to', 'user', '--limit', '201'],
    ['record', 'import', '--input', 'history.json'], ['record', 'list', '--to', 'user'],
    ['record', 'show', '--copy', '../private'], ['record', 'edit', '--copy', copy, '--text', 'x'],
    ['record', 'edit', '--copy', copy, '--record-id', record, '--message-id', '0', '--text', 'x'],
    ['record', 'edit', '--copy', copy, '--record-id', record, '--text', 'x', '--text-file', 'text.txt'],
    ['record', 'edit', '--copy', copy, '--record-id', record, '--revision', '-1', '--text', 'x'],
    ['record', 'undo', '--copy', copy, '--revision', '9007199254740992'],
    ['record', 'edit', '--copy', copy, '--record-id', record, '--to', 'other', '--text', 'x'],
    ['record', 'export', '--copy', copy], ['send', '--to', 'user', '--text', ''],
  ]) assert.throws(() => parseArgs(argv), { code: 'INVALID_ARGUMENT' });
});
test('record execution stays separate from send and applies default ID redaction to local rows', async () => {
  let output = '', error = '';
  const calls = [];
  const stdout = new Writable({ write(chunk, _, done) { output += chunk; done(); } });
  const stderr = new Writable({ write(chunk, _, done) { error += chunk; done(); } });
  const dependencies = {
    output: stdout, error: stderr, input: Readable.from([]), terminal: false,
    registry: { async read() {}, list: () => [] },
    createService: async options => {
      assert.equal(options.backend, 'reverse-native');
      return {
        record: async args => { calls.push(args); return { copyId: copy, localOnly: true, messages: [{ id: '18446744073709551615', recordId: record, chatId: 'wxid_private_fixture123', text: 'edited fixture', edited: true }] }; },
        send() { throw new Error('record sent a message'); }, close: async () => {},
      };
    },
  };
  assert.equal(await runCli(['record', 'show', '--copy', copy, '--json'], dependencies), 0);
  assert.equal(error, ''); assert.equal(calls.length, 1);
  const data = JSON.parse(output);
  assert.equal(data.messages[0].id, '18446744073709551615');
  assert.equal(data.messages[0].recordId, record);
  assert.notEqual(data.messages[0].chatId, 'wxid_private_fixture123');
  assert.equal(data.localOnly, true); assert.equal(data.messages[0].edited, true);
});
