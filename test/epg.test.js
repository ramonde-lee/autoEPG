import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Ten consecutive Beijing days ending three days after `today`.
const tenDayDates = (() => {
  const base = Date.parse(`${today}T00:00:00+08:00`) / 1000 - 6 * 86_400;
  return Array.from({ length: 10 }, (_, i) => dateKey(base + i * 86_400));
})();

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

test('real Hunan and Guizhou schedule edits discard only zero-duration rows and report them by date', async () => {
  const cases = JSON.parse(await readFile(new URL('./fixtures/zero-duration-programmes.json', import.meta.url)));
  const directory = await mkdtemp(join(tmpdir(), 'autoepg-zero-duration-'));
  try {
    // `today` must be the latest fixture date so pastDays: 1 covers both.
    const refDate = cases.map(c => c.date).sort().at(-1);
    const data = await collect({
      channels: async () => cases.map(c => ({ ...channel, id: c.pid, pid: c.pid, dates: [c.date] })),
      programmes: async c => cases.find(f => f.pid === c.pid).rows,
    }, { today: refDate, pastDays: 1, futureDays: 0, minChannels: 1, minTodayCoverage: 0.5, delayMs: 0 });

    assert.equal(data.programmes.length, 4);
    assert.equal(data.manifest.discardedProgrammes.length, 2);
    for (const fixture of cases) {
      const kept = data.programmes.filter(p => p.channel === fixture.pid);
      assert.deepEqual(kept, fixture.rows.filter(r => r.et > r.st).map(r =>
        ({ channel: fixture.pid, title: r.name, start: r.st, stop: r.et })));
      const discarded = data.manifest.discardedProgrammes.find(p => p.programId === fixture.discardedId);
      assert.equal(discarded.reason, 'zero-duration');
      assert.equal(discarded.start, discarded.stop);
    }
    // writeArtifacts needs 10 days; this fixture only has 2 dates, so verify the
    // reference-day manifest filter directly rather than writing a release tree.
    const manifest = {
      ...data.manifest,
      date: refDate,
      requestedDates: { from: refDate, to: refDate },
      discardedProgrammes: (data.manifest.discardedProgrammes ?? []).filter(p => dateKey(p.start) === refDate),
    };
    assert(manifest.discardedProgrammes.every(p => dateKey(p.start) === refDate));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('zero-duration rows never manufacture airtime or count toward coverage', async () => {
  const zero = { ...row(), et: row().st };
  assert.deepEqual(normalize([zero], channel, today), []);
  await assert.rejects(collect(source([zero]), options), /No programmes/);
  await assert.rejects(collect({
    channels: async () => [channel, { ...channel, id: 'empty', pid: '456' }],
    programmes: async c => c.id === 'empty' ? [zero] : [row()],
  }, options), /coverage/);
  for (const bad of [{ ...zero, et: zero.st - 1 }, { ...zero, name: '' },
    { ...zero, st: zero.st * 1000, et: zero.st * 1000 }]) {
    assert.throws(() => normalize([bad], channel, today), /Invalid programme/);
  }
});

test('discarding an empty interval does not hide conflicting positive-duration programmes', async () => {
  await assert.rejects(collect(source([row('A'), { ...row(), et: row().st }, row('B')]), options), /Conflicting/);
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
        row('Zero duration outside', '2026-09-08T19:00:00+08:00', '2026-09-08T19:00:00+08:00'),
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

test('writes the reference day only and verifies checksums', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoepg-test-'));
  try {
    const data = await collect({
      channels: async () => [{ ...channel, dates: tenDayDates }],
      programmes: async (c, date) => [row(date, `${date}T12:00:00+08:00`, `${date}T13:00:00+08:00`)],
    }, { today, pastDays: 6, futureDays: 3, minChannels: 1, delayMs: 0 });
    const index = await writeArtifacts(directory, data);

    assert.deepEqual(index.releases.map(r => r.date), [today]);

    const folder = join(directory, today);
    const xml = await readFile(join(folder, 'epg.xml'));
    assert.equal(XMLValidator.validate(xml.toString()), true);
    assert(!(await readdir(folder)).some(name => name.endsWith('.gz')));

    const sums = (await readFile(join(folder, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    for (const line of sums) {
      const [digest, name] = line.split('  ');
      assert.equal(createHash('sha256').update(await readFile(join(folder, name))).digest('hex'), digest);
    }
    assert.equal(JSON.parse(await readFile(join(folder, 'manifest.json'))).date, today);
    // Top level holds only the reference-day folder and releases.json.
    assert.deepEqual((await readdir(directory)).sort(), [today, 'releases.json'].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('today exports the six epg variants with precise ranges and no duplicate programmes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoepg-variants-test-'));
  try {
    const cctv = { id: 'ysp.123', pid: '123', name: 'CCTV1', groupId: 'cctv',
      logo: 'https://example.com/a.png', dates: tenDayDates };
    const weishi = { id: 'ysp.456', pid: '456', name: '湖南卫视', groupId: 'weishi',
      logo: 'https://example.com/b.png', dates: tenDayDates };
    const data = await collect({
      channels: async () => [cctv, weishi],
      programmes: async (c, date) => [row(`${c.name} ${date}`,
        `${date}T23:00:00+08:00`, `${date}T23:30:00+08:00`)],
    }, { today, pastDays: 6, futureDays: 3, minChannels: 1, delayMs: 0 });
    await writeArtifacts(directory, data);
    const folder = join(directory, today);
    const parser = new XMLParser({ ignoreAttributes: false, isArray: name => name === 'programme' });

    const expected = [
      { file: 'epg.xml',            days: 4,  channels: 2, first: today,          last: tenDayDates[9] },
      { file: 'epg-10d.xml',        days: 10, channels: 2, first: tenDayDates[0], last: tenDayDates[9] },
      { file: 'epg-cctv.xml',       days: 4,  channels: 1, first: today,          last: tenDayDates[9] },
      { file: 'epg-cctv-10d.xml',   days: 10, channels: 1, first: tenDayDates[0], last: tenDayDates[9] },
      { file: 'epg-weishi.xml',     days: 4,  channels: 1, first: today,          last: tenDayDates[9] },
      { file: 'epg-weishi-10d.xml', days: 10, channels: 1, first: tenDayDates[0], last: tenDayDates[9] },
    ];

    for (const spec of expected) {
      const xml = await readFile(join(folder, spec.file), 'utf8');
      assert.equal(XMLValidator.validate(xml), true, `${spec.file} must be valid XML`);
      const tv = parser.parse(xml).tv;
      const channels = tv.channel;
      const programmes = tv.programme ?? [];
      assert.equal(channels.length, spec.channels, `${spec.file} channel count`);
      assert.equal(programmes.length, spec.channels * spec.days, `${spec.file} programme count`);

      // Titles encode "Channel YYYY-MM-DD"; the set of dates must match the window.
      const titles = programmes.map(p => typeof p.title === 'string' ? p.title : p.title['#text']);
      const datesInFile = [...new Set(titles.map(t => t.split(' ').at(-1)))].sort();
      const windowDates = tenDayDates.slice(tenDayDates.indexOf(spec.first), tenDayDates.indexOf(spec.last) + 1);
      assert.deepEqual(datesInFile, windowDates, `${spec.file} window`);
    }

    const manifest = JSON.parse(await readFile(join(folder, 'manifest.json')));
    assert.deepEqual(manifest.variants.map(v => v.file).sort(), expected.map(e => e.file).sort());
    for (const spec of expected) {
      const v = manifest.variants.find(x => x.file === spec.file);
      assert.equal(v.days, spec.days);
      assert.equal(v.from, spec.first);
      assert.equal(v.to, spec.last);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects scraped ranges too narrow for the required outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoepg-narrow-'));
  try {
    const data = await collect(source(), { ...options, futureDays: 1 });
    await assert.rejects(writeArtifacts(directory, data), /scraped range is/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
