import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decode, extractChannels, request } from '../src/source.js';

const pageBytes = await readFile(new URL('./fixtures/page.pb', import.meta.url));
const programmeBytes = await readFile(new URL('./fixtures/programmes.pb', import.meta.url));

test('decodes real website protobuf responses and discovers 73 channels', () => {
  const channels = extractChannels(decode('PageResponse', pageBytes));
  assert.equal(channels.length, 73);
  assert.equal(channels[0].name, 'CCTV1');
  assert.equal(channels[0].id, 'ysp.600001859');
  assert(channels.some(c => c.name === '湖南卫视'));
  const programmes = decode('ProgrammeResponse', programmeBytes).dataList;
  assert.equal(programmes.length, 39);
  assert.equal(programmes[0].st, 1788884105);
  assert.equal(programmes[0].name, '生活早参考-特别节目(生活圈)2026-246');
});

test('rejects corrupt/truncated protobuf, non-200 API codes, and missing channels', () => {
  assert.throws(() => decode('PageResponse', Buffer.from('<html>error</html>')));
  assert.throws(() => decode('PageResponse', pageBytes.subarray(0, 40)));
  assert.throws(() => decode('ProgrammeResponse', Buffer.from([8, 0])), /Upstream code/);
  assert.throws(() => extractChannels({}), /No TV channels/);
});

test('retries transient HTTP errors with bounded backoff and decodes success', async () => {
  let attempts = 0;
  const delays = [];
  const result = await request('https://example.com', 'ProgrammeResponse', {
    fetchImpl: async () => ++attempts < 3 ? new Response('busy', { status: 503 }) : new Response(programmeBytes),
    delay: async ms => delays.push(ms),
  });
  assert.equal(result.dataList.length, 39);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('network and decode failures exhaust retries and propagate to the caller', async () => {
  for (const failure of [async () => { throw new Error('timeout'); }, async () => new Response('<html/>')]) {
    let attempts = 0;
    await assert.rejects(request('https://example.com', 'ProgrammeResponse', {
      fetchImpl: async () => { attempts++; return failure(); }, delay: async () => {},
    }));
    assert.equal(attempts, 3);
  }
});
