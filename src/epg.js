import { create } from 'xmlbuilder2';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HOME } from './source.js';
import { GROUPS, groupedChannels, groupFile } from './channels.js';

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
  return String(value).replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '').trim();
}

export function normalize(rows, channel, date, { onDiscard = () => {} } = {}) {
  const midnight = windowFor(date, 0, 0).start;
  return rows.flatMap(row => {
    const start = row.st, stop = row.et;
    const title = cleanText(row.name ?? '');
    if (!title || !Number.isSafeInteger(start) || !Number.isSafeInteger(stop) ||
        start < midnight || start >= midnight + 2 * DAY || stop < start || stop - start > DAY) {
      throw new Error(`Invalid programme ${channel.pid}/${date}/${row.programId ?? '?'}: title or timestamps`);
    }
    if (stop === start) {
      onDiscard({ channel: channel.id, date, programId: row.programId ?? null,
        title, start, stop, reason: 'zero-duration' });
      return [];
    }
    return [{ channel: channel.id, title, start, stop }];
  });
}

/**
 * 去重逻辑：如果 start 时间相同，保留 stop 更大（持续时间更长）的节目，避免严格校验导致程序崩溃
 */
export function deduplicate(programmes) {
  const unique = new Map();
  for (const programme of programmes) {
    const key = `${programme.channel}/${programme.start}`;
    const previous = unique.get(key);
    if (previous) {
      // 遇到 start 相同的冲突，保留时间跨度更大的节目
      if (programme.stop > previous.stop) {
        unique.set(key, programme);
      }
      continue;
    }
    unique.set(key, programme);
  }
  return [...unique.values()].sort((a, b) => a.channel.localeCompare(b.channel) || a.start - b.start);
}

/**
 * 补全每天起始时间的缺失部分 (深度修正版)
 * 核心逻辑：严格检查当天 00:00:00 是否被任何节目（含跨天节目）覆盖。
 * 只有当 00:00:00 处于空窗期时，才读取前一天最后一个节目进行填充。
 */
function fillMissingStartOfDay(programmes) {
  if (!programmes || programmes.length === 0) return [];

  const byChannel = new Map();
  for (const p of programmes) {
    if (!byChannel.has(p.channel)) byChannel.set(p.channel, []);
    byChannel.get(p.channel).push(p);
  }

  const result = [];

  for (const [channelId, progs] of byChannel.entries()) {
    // 确保按时间排序
    progs.sort((a, b) => a.start - b.start);
    
    // 计算该频道数据的最小和最大时间，确定需要检查的日期范围
    const minTime = progs[0].start;
    const maxTime = progs[progs.length - 1].stop;
    const startDayStr = dateKey(minTime);
    const endDayStr = dateKey(maxTime - 1); // 防止 maxTime 刚好是次日 00:00

    // 生成需要检查的每一天午夜时间戳列表
    const daysToCheck = [];
    let current = windowFor(startDayStr, 0, 0).start;
    const end = windowFor(endDayStr, 0, 0).start;
    while (current <= end) {
      daysToCheck.push(current);
      current += DAY;
    }

    for (const dayMidnight of daysToCheck) {
      // 1. 核心检查：当天 00:00:00 是否已经被某个节目覆盖（包括跨天节目）
      const coversMidnight = progs.some(p => p.start <= dayMidnight && p.stop > dayMidnight);
      
      if (!coversMidnight) {
        // 2. 寻找当天 00:00:00 之后开始的第一个节目
        const firstProg = progs.find(p => p.start >= dayMidnight);
        
        if (firstProg) {
          // 3. 寻找前一天（start < dayMidnight）的最后一个节目
          const prevProgs = progs.filter(p => p.start < dayMidnight);
          const prevProg = prevProgs.length > 0 ? prevProgs[prevProgs.length - 1] : null;

          const fillerStart = dayMidnight;
          const fillerStop = firstProg.start - 1;

          // 4. 确保填充时长合法
          if (fillerStop >= fillerStart) {
            result.push({
              channel: channelId,
              title: prevProg ? prevProg.title : "未知节目",
              start: fillerStart,
              stop: fillerStop,
            });
          }
        }
      }
    }
    
    // 将原始节目加入结果
    result.push(...progs);
  }

  // 返回前再次排序，确保时间线连续
  return result.sort((a, b) => a.channel.localeCompare(b.channel) || a.start - b.start);
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
  const firstFetch = dateKey(range.start - DAY);
  
  const tasks = [];
  for (const channel of channels) {
    let datesToFetch = [];
    
    if (Array.isArray(channel.dates)) {
      datesToFetch = channel.dates.filter(date => date >= firstFetch && date <= last);
    } else {
      const startDay = new Date(range.start * 1000);
      const endDay = new Date((range.stop - 1) * 1000);
      for (let d = new Date(startDay); d <= endDay; d.setDate(d.getDate() + 1)) {
        datesToFetch.push(dateKey(d.getTime() / 1000));
      }
    }
    
    for (const date of datesToFetch) {
      tasks.push({ channel, date });
    }
  }

  const empty = [], failures = [], programmes = [], discarded = [];
  let next = 0, completed = 0;
  
  if (tasks.length === 0) {
      throw new Error('No tasks generated. Check channel dates configuration or date range.');
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const taskIndex = next++;
      const { channel, date } = tasks[taskIndex];
      try {
        const rows = await source.programmes(channel, date);
        if (!rows.length) empty.push({ channel: channel.id, date });
        
        const relevant = date < first ? rows.filter(row => row.et > range.start) : rows;
        const parsed = normalize(relevant, channel, date, { onDiscard: p => discarded.push(p) });
        
        if (parsed.length && date >= first && date <= last && !parsed.some(p => dateKey(p.start) === date)) {
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
  
  if (failures.length) throw new Error(`${failures.length} schedule request(s) failed:\n${failures.join('\n')}`);
  
  // 1. 先去重（容错模式）
  const rawResult = deduplicate(programmes);
  
  // 2. 补全缺失的起始时间 (修复跨天重叠问题)
  const filledResult = fillMissingStartOfDay(rawResult);
  
  // 3. 再次去重（防止填充节目与现有节目冲突）
  const result = deduplicate(filledResult);

  if (!result.length) throw new Error('No programmes; refusing to publish an empty EPG');
  
  const todayChannels = new Set(result.filter(p => dateKey(p.start) === today).map(p => p.channel));
  const coverage = todayChannels.size / channels.length;
  if (coverage < minTodayCoverage) {
    throw new Error(`Today's channel coverage ${(coverage * 100).toFixed(1)}% is below ${minTodayCoverage * 100}%`);
  }
  
  const counts = new Map();
  for (const p of result) counts.set(p.channel, (counts.get(p.channel) ?? 0) + 1);
  
  const manifest = {
    generatedAt: new Date().toISOString(), referenceDate: today, source: HOME,
    format: 'XMLTV', channelSchemaVersion: 2, encoding: 'UTF-8', timezone: 'Asia/Shanghai', logoFormat: 'PNG',
    requestedDates: { from: first, to: last },
    channelCount: channels.length, programmeCount: result.length,
    channelsWithProgrammes: counts.size, todayChannelCoverage: coverage,
    earliestStart: new Date(result.reduce((min, p) => Math.min(min, p.start), Infinity) * 1000).toISOString(),
    latestStop: new Date(result.reduce((max, p) => Math.max(max, p.stop), -Infinity) * 1000).toISOString(),
    requestCount: tasks.length, emptySchedules: empty.sort((a, b) => a.channel.localeCompare(b.channel) || a.date.localeCompare(b.date)),
    discardedProgrammes: discarded.sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) ||
      a.start - b.start || String(a.programId).localeCompare(String(b.programId))),
    missingToday: channels.filter(c => !todayChannels.has(c.id)).map(c => ({ id: c.id, name: c.name })),
  };
  return { channels, programmes: result, manifest };
}

export function renderXml(channels, programmes, { sourceName = '央视频' } = {}) {
  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const tv = doc.ele('tv', {
    'generator-info-name': 'autoEPG', 'generator-info-url': 'https://github.com/TvWasm/autoEPG',
    'source-info-name': sourceName, 'source-info-url': HOME,
  });
  const ids = new Set();
  const ordered = groupedChannels(channels);
  for (const c of ordered) {
    if (ids.has(c.id)) throw new Error(`Duplicate channel ${c.id}`);
    ids.add(c.id);
    const channel = tv.ele('channel', { id: c.id });
    for (const name of new Set([c.name, ...(c.aliases ?? [])])) {
      channel.ele('display-name', { lang: 'zh' }).txt(cleanText(name));
    }
    if (/^https?:\/\//.test(c.logo)) channel.ele('icon', { src: c.logo });
    channel.ele('url').txt(`${HOME}?pid=${c.pid}`);
  }
  const rank = new Map(ordered.map((c, i) => [c.id, i]));
  for (const p of [...programmes].sort((a, b) => rank.get(a.channel) - rank.get(b.channel) || a.start - b.start)) {
    if (!ids.has(p.channel)) throw new Error(`Unknown channel ${p.channel}`);
    tv.ele('programme', { start: xmltvTime(p.start), stop: xmltvTime(p.stop), channel: p.channel })
      .ele('title', /\p{Script=Han}/u.test(p.title) ? { lang: 'zh' } : {}).txt(cleanText(p.title));
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
      discardedProgrammes: (dataset.manifest.discardedProgrammes ?? []).filter(p => dateKey(p.start) === date),
      xmlBytes: xml.length,
    };
    const files = { 'epg.xml': xml };
    manifest.variants = [{ file: 'epg.xml', days: 1, from: date, to: date, programmeCount: programmes.length, bytes: xml.length }];
    if (date === dataset.manifest.referenceDate) {
      for (const days of [2, 3]) {
        const end = day + days * DAY;
        if (end > stop) continue;
        const combined = dataset.programmes.filter(p => p.start < end && p.stop > day);
        const name = `epg${days}.xml`;
        files[name] = Buffer.from(renderXml(dataset.channels, combined));
        manifest.variants.push({ file: name, days, from: date, to: dateKey(end - 1),
          programmeCount: combined.length, bytes: files[name].length });
      }
    }
    const variants = [...manifest.variants];
    const groups = [];
    for (const group of GROUPS) {
      const members = dataset.channels.filter(c => c.groupId === group.id);
      if (!members.length) continue;
      const ids = new Set(members.map(c => c.id));
      const feeds = [];
      for (const variant of variants) {
        const name = groupFile(variant.file, group.id);
        const subset = dataset.programmes.filter(p => ids.has(p.channel) && p.start < day + variant.days * DAY && p.stop > day);
        files[name] = Buffer.from(renderXml(members, subset, { sourceName: group.name }));
        const feed = { file: name, days: variant.days, from: variant.from, to: variant.to,
          programmeCount: subset.length, bytes: files[name].length, groupId: group.id };
        feeds.push(feed);
        manifest.variants.push(feed);
      }
      groups.push({ id: group.id, name: group.name, channelIds: members.map(c => c.id), feeds });
    }
    files['channels.json'] = Buffer.from(JSON.stringify(dataset.channels, null, 2) + '\n');
    files['groups.json'] = Buffer.from(JSON.stringify({ source: '央视频', channelSchemaVersion: 2, groups }, null, 2) + '\n');
    files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    files['SHA256SUMS'] = Buffer.from(Object.entries(files).map(([name, data]) =>
      `${createHash('sha256').update(data).digest('hex')}  ${name}\n`).join(''));
    const folder = join(directory, date);
    await mkdir(folder, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      const target = join(folder, name);
      await writeFile(`${target}.tmp`, data);
      await rename(`${target}.tmp`, target);
    }
    releases.push({ date, programmeCount: programmes.length, xmlBytes: xml.length, assets: Object.keys(files) });
  }
  await mkdir(directory, { recursive: true });
  const index = { ...dataset.manifest, releases };
  await writeFile(join(directory, 'releases.json.tmp'), JSON.stringify(index, null, 2) + '\n');
  await rename(join(directory, 'releases.json.tmp'), join(directory, 'releases.json'));
  return index;
}
