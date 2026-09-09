import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { collect, dateKey, windowFor, xmltvTime, normalize, deduplicate, renderXml, writeArtifacts } from '../src/epg.js';

const today = '2026-09-09';
const epoch = value => Date.parse(value) / 1000;
const row = (name = '新闻 & <天气>', start = '2026-09-09T23:30:05+08:00', stop = '2026-09-10T00:30:00+08:00') =>
  ({ name, st: epoch(start), et: epoch(stop) });
const channel = { id: 'ysp.123', pid: '123', name: 'CCTV1', logo: 'https://example.com/logo.png?a=1&b=2', dates: [today] };
const options = { today, pastDays: 0, futureDays: 0, minChannels: 1, delayMs: 0 };
const source = (rows = [row()]) => ({ channels: async () => [channel], programmes: async () => rows });

test('Beijing day and XMLTV timestamps do not depend on runner timezone', () => {
  assert.equal(dateKey(epoch('2026-09-08T16:00:00Z')), today);
  assert.equal(xmltvTime(epoch('2026-09-09T15:30:05Z')), '20260909233005 +0800');
  assert.deepEqual(windowFor('2026-01-01', 1, 1), {
    start: epoch('2025-12-31T00:00:00+08:00'), stop: epoch('2026-01-03T00:00:00+08:00'),
  });
  assert.throws(() => windowFor('2026-02-30', 0, 0), /valid/);
});

test('keeps seconds and the real end of a cross-midnight programme', () => {
  const [p] = normalize([row()], channel, today);
  assert.equal(xmltvTime(p.start), '20260909233005 +0800');
  assert.equal(xmltvTime(p.stop), '20260910003000 +0800');
});

test('rejects invalid, stale, and millisecond timestamps, and empty titles', () => {
  for (const bad of [ { ...row(), et: 0 }, { ...row(), st: row().st * 1000 },
    { ...row(), name: '\u0000' }, { ...row(), st: epoch('2025-09-09T00:00:00Z') },
    { ...row(), st: Number.MAX_SAFE_INTEGER + 1 } ]) {
    assert.throws(() => normalize([bad], channel, today), /Invalid programme/);
  }
});

test('deduplicates identical rows but rejects conflicting schedules', () => {
  const [p] = normalize([row()], channel, today);
  assert.equal(deduplicate([p, p]).length, 1);
  assert.throws(() => deduplicate([p, { ...p, title: 'Different' }]), /Conflicting/);
});

test('XML is valid, escapes text/attributes, removes illegal characters, and orders channels first', () => {
  const [p] = normalize([row('新闻 & <天气>\u0000 😀')], channel, today);
  const xml = renderXml([channel], [p]);
  assert.equal(XMLValidator.validate(xml), true);
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  assert.equal(parsed.tv.programme.title['#text'], '新闻 & <天气> 😀');
  assert.equal(parsed.tv.programme['@_channel'], channel.id);
  assert.equal(parsed.tv.channel.icon['@_src'], channel.logo);
  assert(xml.indexOf('<channel ') < xml.indexOf('<programme '));
  assert.throws(() => renderXml([], [p]), /Unknown channel/);
  assert.throws(() => renderXml([channel, channel], [p]), /Duplicate channel/);
});

test('fetches advertised dates with one boundary day and keeps cross-midnight programmes', async () => {
  const requested = [];
  const data = await collect({
    channels: async () => [{ ...channel, dates: ['2026-09-08', today, '2026-09-10'] }],
    programmes: async (c, date) => {
      requested.push(date);
      return date === today ? [row()] : [
        row('Outside', '2026-09-08T20:00:00+08:00', '2026-09-08T21:00:00+08:00'),
        row('Boundary', '2026-09-08T23:30:00+08:00', '2026-09-09T00:15:00+08:00'),
      ];
    },
  }, options);
  assert.deepEqual(requested, ['2026-09-08', today]);
  assert.equal(data.manifest.todayChannelCoverage, 1);
  assert.equal(data.programmes.length, 2);
  assert.equal(data.programmes[0].title, 'Boundary');
  assert.equal(data.programmes[1].stop, row().et);
});

test('a transport failure prevents publication even when other schedules succeed', async () => {
  await assert.rejects(collect({
    channels: async () => [channel, { ...channel, id: 'ysp.456', pid: '456' }],
    programmes: async c => { if (c.pid === '456') throw new Error('timeout'); return [row()]; },
  }, options), /request\(s\) failed/);
});

test('refuses empty results, unexpected channel loss, and missing current-day coverage', async () => {
  await assert.rejects(collect(source([]), options), /No programmes/);
  await assert.rejects(collect(source(), { ...options, minChannels: 50 }), /expected at least/);
  await assert.rejects(collect({
    channels: async () => [channel, { ...channel, id: 'ysp.456', pid: '456', dates: [] }],
    programmes: async () => [row()],
  }, options), /coverage/);
});

test('records legitimate empty future schedules without inventing programmes', async () => {
  const data = await collect({
    channels: async () => [{ ...channel, dates: [today, '2026-09-10'] }],
    programmes: async (c, date) => date === today ? [row()] : [],
  }, { ...options, futureDays: 1 });
  assert.deepEqual(data.manifest.emptySchedules, [{ channel: channel.id, date: '2026-09-10' }]);
  assert.equal(data.programmes.length, 1);
});

test('limits concurrent requests', async () => {
  let active = 0, peak = 0;
  await collect({
    channels: async () => Array.from({ length: 8 }, (_, i) => ({ ...channel, id: `ysp.${i}`, pid: String(i) })),
    programmes: async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--; return [row()];
    },
  }, { ...options, concurrency: 2 });
  assert.equal(peak, 2);
});

test('writes parseable XML, matching gzip, metadata and verified checksums', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoepg-test-'));
  try {
    const data = await collect(source(), options);
    await writeArtifacts(directory, data);
    const xml = await readFile(join(directory, 'epg.xml'));
    assert.equal(XMLValidator.validate(xml.toString()), true);
    assert.deepEqual(gunzipSync(await readFile(join(directory, 'epg.xml.gz'))), xml);
    const sums = (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    for (const line of sums) {
      const [digest, name] = line.split('  ');
      assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), digest);
    }
    assert.equal(JSON.parse(await readFile(join(directory, 'manifest.json'))).channelCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
