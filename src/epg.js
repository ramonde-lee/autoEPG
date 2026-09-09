import { create } from 'xmlbuilder2';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HOME } from './source.js';

const DAY = 86_400;
const OFFSET = 8 * 3600;

export function dateKey(seconds) {
  return new Date((seconds + OFFSET) * 1000).toISOString().slice(0, 10);
}
export function xmltvTime(seconds) {
  return new Date((seconds + OFFSET) * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '') + ' +0800';
}
export function windowFor(today, pastDays, futureDays) {
  const midnight = Date.parse(`${today}T00:00:00+08:00`) / 1000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(midnight) || dateKey(midnight) !== today) {
    throw new Error('Date must be a valid YYYY-MM-DD date');
  }
  return { start: midnight - pastDays * DAY, stop: midnight + (futureDays + 1) * DAY };
}
export function cleanText(value) {
  // XML 1.0 permits tabs, CR/LF, and these Unicode ranges only.
  return String(value).replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '').trim();
}

export function normalize(rows, channel, date) {
  const midnight = windowFor(date, 0, 0).start;
  return rows.map(row => {
    const start = row.st, stop = row.et;
    const title = cleanText(row.name ?? '');
    if (!title || !Number.isSafeInteger(start) || !Number.isSafeInteger(stop) ||
        start < midnight || start >= midnight + 2 * DAY || stop <= start || stop - start > DAY) {
      throw new Error(`Invalid programme ${channel.pid}/${date}/${row.programId ?? '?'}: title or timestamps`);
    }
    return { channel: channel.id, title, start, stop };
  });
}

export function deduplicate(programmes) {
  const unique = new Map();
  for (const programme of programmes) {
    const key = `${programme.channel}/${programme.start}`;
    const previous = unique.get(key);
    if (previous && (previous.title !== programme.title || previous.stop !== programme.stop)) {
      throw new Error(`Conflicting programmes at ${key}`);
    }
    unique.set(key, programme);
  }
  return [...unique.values()].sort((a, b) => a.channel.localeCompare(b.channel) || a.start - b.start);
}

export async function collect(source, {
  today = dateKey(Date.now() / 1000), pastDays = 3, futureDays = 3,
  concurrency = 4, minChannels = 50, minTodayCoverage = 0.9,
  delayMs = 150, onProgress = () => {},
} = {}) {
  const range = windowFor(today, pastDays, futureDays);
  const channels = await source.channels();
  if (channels.length < minChannels) throw new Error(`Only ${channels.length} channels; expected at least ${minChannels}`);
  const first = dateKey(range.start), last = dateKey(range.stop - 1);
  // Include the preceding day's final programme if it crosses into our window.
  const firstFetch = dateKey(range.start - DAY);
  const tasks = channels.flatMap(channel => channel.dates
    .filter(date => date >= firstFetch && date <= last).map(date => ({ channel, date })));
  const empty = [], failures = [], programmes = [];
  let next = 0, completed = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const { channel, date } = tasks[next++];
      try {
        const rows = await source.programmes(channel, date);
        if (!rows.length) empty.push({ channel: channel.id, date });
        // The extra day is only a lookback for programmes crossing midnight.
        // Malformed old rows that ended before our window cannot affect this EPG.
        const relevant = date < first ? rows.filter(row => row.et > range.start) : rows;
        const parsed = normalize(relevant, channel, date);
        if (parsed.length && !parsed.some(p => dateKey(p.start) === date)) {
          throw new Error('Response contains no programmes starting on the requested date');
        }
        programmes.push(...parsed.filter(p => p.start < range.stop && p.stop > range.start));
      } catch (error) {
        failures.push(`${channel.name}/${date}: ${error.message}`);
      }
      onProgress(++completed, tasks.length);
      if (delayMs) await sleep(delayMs);
    }
  }));
  // Never publish a partial scrape after network/schema failures.
  if (failures.length) throw new Error(`${failures.length} schedule request(s) failed:\n${failures.join('\n')}`);
  const result = deduplicate(programmes);
  if (!result.length) throw new Error('No programmes; refusing to publish an empty EPG');
  const todayChannels = new Set(result.filter(p => dateKey(p.start) === today).map(p => p.channel));
  const coverage = todayChannels.size / channels.length;
  if (coverage < minTodayCoverage) {
    throw new Error(`Today's channel coverage ${(coverage * 100).toFixed(1)}% is below ${minTodayCoverage * 100}%`);
  }
  const counts = new Map();
  for (const p of result) counts.set(p.channel, (counts.get(p.channel) ?? 0) + 1);
  const manifest = {
    generatedAt: new Date().toISOString(), referenceDate: today, source: HOME, timezone: 'Asia/Shanghai',
    requestedDates: { from: first, to: last },
    channelCount: channels.length, programmeCount: result.length,
    channelsWithProgrammes: counts.size, todayChannelCoverage: coverage,
    earliestStart: new Date(result.reduce((min, p) => Math.min(min, p.start), Infinity) * 1000).toISOString(),
    latestStop: new Date(result.reduce((max, p) => Math.max(max, p.stop), -Infinity) * 1000).toISOString(),
    requestCount: tasks.length, emptySchedules: empty.sort((a, b) => a.channel.localeCompare(b.channel) || a.date.localeCompare(b.date)),
    missingToday: channels.filter(c => !todayChannels.has(c.id)).map(c => ({ id: c.id, name: c.name })),
  };
  return { channels, programmes: result, manifest };
}

export function renderXml(channels, programmes) {
  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const tv = doc.ele('tv', {
    'generator-info-name': 'autoEPG', 'generator-info-url': 'https://github.com/TvWasm/autoEPG',
    'source-info-name': '央视频', 'source-info-url': HOME,
  });
  const ids = new Set();
  for (const c of channels) {
    if (ids.has(c.id)) throw new Error(`Duplicate channel ${c.id}`);
    ids.add(c.id);
    const channel = tv.ele('channel', { id: c.id });
    channel.ele('display-name', { lang: 'zh' }).txt(cleanText(c.name));
    // Common IPTV spelling; PID remains the stable identity.
    if (/^CCTV\d+\+?$/.test(c.name)) channel.ele('display-name').txt(c.name.replace('CCTV', 'CCTV-'));
    if (/^https?:\/\//.test(c.logo)) channel.ele('icon', { src: c.logo });
    channel.ele('url').txt(`${HOME}?pid=${c.pid}`);
  }
  for (const p of programmes) {
    if (!ids.has(p.channel)) throw new Error(`Unknown channel ${p.channel}`);
    tv.ele('programme', { start: xmltvTime(p.start), stop: xmltvTime(p.stop), channel: p.channel })
      .ele('title', { lang: 'zh' }).txt(cleanText(p.title));
  }
  return doc.end({ prettyPrint: true }) + '\n';
}

export async function writeArtifacts(directory, dataset) {
  const releases = [];
  const { from, to } = dataset.manifest.requestedDates;
  const start = windowFor(from, 0, 0).start;
  const stop = windowFor(to, 0, 0).stop;
  for (let day = start; day < stop; day += DAY) {
    const date = dateKey(day);
    const programmes = dataset.programmes.filter(p => p.start < day + DAY && p.stop > day);
    if (!programmes.length) continue;
    const xml = Buffer.from(renderXml(dataset.channels, programmes));
    const manifest = {
      ...dataset.manifest, date, requestedDates: { from: date, to: date }, programmeCount: programmes.length,
      channelsWithProgrammes: new Set(programmes.map(p => p.channel)).size,
      earliestStart: new Date(programmes.reduce((min, p) => Math.min(min, p.start), Infinity) * 1000).toISOString(),
      latestStop: new Date(programmes.reduce((max, p) => Math.max(max, p.stop), -Infinity) * 1000).toISOString(),
      emptySchedules: dataset.manifest.emptySchedules.filter(s => s.date === date),
      xmlBytes: xml.length,
    };
    const files = {
      'epg.xml': xml,
      'channels.json': Buffer.from(JSON.stringify(dataset.channels, null, 2) + '\n'),
      'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    };
    files['SHA256SUMS'] = Buffer.from(Object.entries(files).map(([name, data]) =>
      `${createHash('sha256').update(data).digest('hex')}  ${name}\n`).join(''));
    const folder = join(directory, date);
    await mkdir(folder, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      const target = join(folder, name);
      await writeFile(`${target}.tmp`, data);
      await rename(`${target}.tmp`, target);
    }
    releases.push({ date, programmeCount: programmes.length, xmlBytes: xml.length });
  }
  await mkdir(directory, { recursive: true });
  const index = { ...dataset.manifest, releases };
  await writeFile(join(directory, 'releases.json.tmp'), JSON.stringify(index, null, 2) + '\n');
  await rename(join(directory, 'releases.json.tmp'), join(directory, 'releases.json'));
  return index;
}
