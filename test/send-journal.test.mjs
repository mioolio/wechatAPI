import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SendJournal } from '../src/send-journal.mjs';

const generation = '85bb4adf-6aee-40a9-b3df-12059c29b7b5';
const textHash = createHash('sha256').update('fixture body never persisted').digest('hex');
const reservation = { requestId: 'request-001', alias: 'u_0000000000000001', textHash, generation, pid: 1234 };
async function fixture(t, deps = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wxcc-send-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, journal: new SendJournal({ directory }, deps) };
}
test('exclusive reservation persists before send and stores only body hash and recipient alias', async t => {
  const fx = await fixture(t);
  const record = await fx.journal.reserve({ ...reservation, text: 'fixture body never persisted', token: 'never-secret', chatId: 'wxid_never_persisted' });
  assert.equal(record.status, 'reserved');
  assert.equal(record.textHash, textHash);
  const files = await readdir(fx.directory);
  assert.deepEqual(files, [`${createHash('sha256').update(reservation.requestId).digest('hex')}.json`]);
  const content = await readFile(join(fx.directory, files[0]), 'utf8');
  for (const secret of ['fixture body never persisted', 'never-secret', 'wxid_never_persisted']) assert.equal(content.includes(secret), false);
  assert.deepEqual(await fx.journal.get('REQUEST-001'), record);
});
test('request IDs survive journal instance and host generation changes; normalization cannot bypass deduplication', async t => {
  const fx = await fixture(t);
  await fx.journal.reserve(reservation);
  const reopened = new SendJournal({ directory: fx.directory });
  for (const status of ['accepted', 'unknown', 'failed']) {
    await reopened.finish(reservation.requestId, { status });
    await assert.rejects(reopened.reserve({ ...reservation, requestId: ' REQUEST-001 ', generation: '10000000-0000-0000-0000-000000000000', pid: 5678 }), { code: 'E_SEND_REQUEST_REUSED' });
  }
  assert.equal((await reopened.get(reservation.requestId)).pid, reservation.pid);
});
test('concurrent processes or instances allow only one reservation of the same request ID', async t => {
  const fx = await fixture(t);
  const other = new SendJournal({ directory: fx.directory });
  const results = await Promise.allSettled([fx.journal.reserve(reservation), other.reserve(reservation)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'E_SEND_REQUEST_REUSED');
  assert.equal((await readdir(fx.directory)).length, 1);
});
test('finish atomically retains identity and whitelists receipt metadata without plaintext or real IDs', async t => {
  const fx = await fixture(t);
  await fx.journal.reserve(reservation);
  const result = await fx.journal.finish(reservation.requestId, { status: 'accepted', receipt: { requestId: 'request-001', status: 'accepted', native: true, deliveryConfirmed: false, nativeEntryCalled: true, createdAt: '2026-10-02 (private text)', completedAt: '2026-10-02T12:26:30.222Z', text: 'sensitive body', content: 'sensitive body', resultMessage: 'wxid_private', chatId: 'wxid_private', headers: { token: 'private token' } } });
  assert.deepEqual(result.receipt, { requestId: 'request-001', status: 'accepted', native: true, deliveryConfirmed: false, nativeEntryCalled: true, completedAt: '2026-10-02T12:26:30.222Z' });
  assert.equal(result.generation, generation);
  assert.deepEqual(await fx.journal.get('request-001'), result);
  assert.equal((await readdir(fx.directory)).length, 1);
});
test('missing requests are read-only null and cannot be finished; invalid metadata creates no files', async t => {
  const fx = await fixture(t);
  assert.equal(await fx.journal.get('not-registered'), null);
  await assert.rejects(fx.journal.finish('not-registered', { status: 'accepted' }), { code: 'E_SEND_REQUEST_MISSING' });
  for (const changes of [{ requestId: '../outside' }, { requestId: 'a/b' }, { requestId: '\0' }, { textHash: 'bad' }, { alias: 'nickname' }, { generation: 'bad' }, { pid: '1234' }]) await assert.rejects(fx.journal.reserve({ ...reservation, ...changes }));
  assert.deepEqual(await readdir(fx.directory), []);
});
test('corrupt, oversized or contradictory records reject reads and never become resend eligibility', async t => {
  const fx = await fixture(t);
  const valid = await fx.journal.reserve(reservation), [file] = await readdir(fx.directory), path = join(fx.directory, file);
  for (const contents of ['', '{broken', 'x'.repeat(16385), JSON.stringify({ ...valid, requestId: 'different' }), JSON.stringify({ ...valid, text: 'plaintext' }), JSON.stringify({ ...valid, status: 'accepted', receipt: { requestId: 'request-001', status: 'accepted', chatId: 'wxid_private' } })]) {
    await writeFile(path, contents);
    await assert.rejects(fx.journal.get('request-001'), { code: 'E_SEND_JOURNAL_CORRUPT' });
    await assert.rejects(fx.journal.reserve(reservation), { code: 'E_SEND_REQUEST_REUSED' });
    await assert.rejects(fx.journal.finish('request-001', { status: 'unknown' }), { code: 'E_SEND_JOURNAL_CORRUPT' });
  }
});
test('write or sync uncertainty leaves an exclusive placeholder and rejects future send reservations', async t => {
  const fx = await fixture(t, { openImpl: async (...args) => {
    const handle = await open(...args);
    return { writeFile: async () => { throw Error('private secret in filesystem error'); }, sync: () => handle.sync(), close: () => handle.close() };
  } });
  await assert.rejects(fx.journal.reserve(reservation), error => { assert.equal(error.code, 'E_SEND_JOURNAL_STORE'); assert.equal(error.message.includes('private secret'), false); return true; });
  const reopened = new SendJournal({ directory: fx.directory });
  await assert.rejects(reopened.reserve(reservation), { code: 'E_SEND_REQUEST_REUSED' });
  await assert.rejects(reopened.get(reservation.requestId), { code: 'E_SEND_JOURNAL_CORRUPT' });
});
test('invalid finish states or mismatched receipts preserve the original reservation', async t => {
  const fx = await fixture(t);
  const original = await fx.journal.reserve(reservation);
  for (const input of [{ status: 'delivered' }, { status: 'accepted', receipt: { requestId: 'different' } }, { status: 'unknown', receipt: { status: 'accepted' } }]) await assert.rejects(fx.journal.finish('request-001', input));
  assert.deepEqual(await fx.journal.get('request-001'), original);
});
