import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { decode, extractChannels } from '../src/source.js';
import { channelProfile } from '../src/channels.js';
import { collect, writeArtifacts } from '../src/epg.js';

const channels = extractChannels(decode('PageResponse', await readFile(new URL('./fixtures/page.pb', import.meta.url))));

test('canonical IDs preserve distinct source channels and legacy mappings', () => {
  assert.equal(new Set(channels.map(c => c.id)).size, 73);
  assert(channels.every(c => /^[a-z][a-z0-9]*$/.test(c.id)));
  assert(channels.every(c => c.legacyIds.includes(`ysp.${c.pid}`)));
  for (const id of ['cctv3', 'cctv5plus', 'cctv16', 'cctv164k', 'hunanweishi']) {
    assert(channels.some(c => c.id === id));
  }
  assert(channels.find(c => c.id === 'cctv3').aliases.includes('央视综艺'));
  assert.equal(channels.filter(c => c.groupId === 'cctv').length, 40);
  assert.equal(channels.filter(c => c.groupId === 'weishi').length, 33);
  assert.equal(channelProfile('999', 'New', 'weishi').id, 'ysp999');
  assert.throws(() => channelProfile('999', 'New', 'unknown'), /Unknown channel group/);
});

test('group feeds partition full XML, retain aliases, and cover each requested duration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoepg-groups-'));
  try {
    const dates = ['2026-09-09', '2026-09-10', '2026-09-11'];
    const selected = channels.filter(c => ['cctv3', 'hunanweishi'].includes(c.id)).map(c => ({ ...c, dates }));
    const data = await collect({
      channels: async () => selected,
      programmes: async (c, date) => [{ name: c.name, st: Date.parse(`${date}T12:00:00+08:00`) / 1000,
        et: Date.parse(`${date}T13:00:00+08:00`) / 1000 }],
    }, { today: dates[0], pastDays: 0, futureDays: 2, minChannels: 2, delayMs: 0 });
    const index = await writeArtifacts(directory, data);
    const folder = join(directory, dates[0]);
    const groups = JSON.parse(await readFile(join(folder, 'groups.json')));
    assert.equal(groups.channelSchemaVersion, 2);
    assert.deepEqual(groups.groups.map(g => g.name), ['央视频道', '卫视频道']);
    const parser = new XMLParser({ ignoreAttributes: false, isArray: name => ['channel', 'programme', 'display-name'].includes(name) });
    for (const days of [1, 2, 3]) {
      const base = days === 1 ? 'epg' : `epg${days}`;
      const full = parser.parse(await readFile(join(folder, `${base}.xml`), 'utf8')).tv;
      assert.equal(full['@_source-info-name'], '央视频');
      assert.deepEqual(full.channel.map(c => c['@_id']), ['cctv3', 'hunanweishi']);
      const union = [];
      for (const group of groups.groups) {
        const feed = group.feeds.find(f => f.days === days);
        assert.equal(feed.to, dates[days - 1]);
        assert(index.releases[0].assets.includes(feed.file));
        const xml = parser.parse(await readFile(join(folder, feed.file), 'utf8')).tv;
        assert.equal(xml['@_source-info-name'], group.name);
        assert.deepEqual(xml.channel.map(c => c['@_id']), group.channelIds);
        assert.equal(xml.programme.length, days);
        assert(xml.programme.every(p => group.channelIds.includes(p['@_channel'])));
        assert.deepEqual(xml.channel[0], full.channel.find(c => c['@_id'] === group.channelIds[0]));
        union.push(...xml.programme);
      }
      assert.deepEqual(union, full.programme);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
