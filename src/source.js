import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const HOME = 'https://www.yangshipin.cn/tv/home';
const API = 'https://capi.yangshipin.cn/api/';
const schema = await protobuf.load(fileURLToPath(new URL('./yangshipin.proto', import.meta.url)));

export function decode(type, bytes) {
  const message = schema.lookupType(`yangshipin.${type}`);
  const data = message.toObject(message.decode(bytes), { longs: Number, arrays: true });
  if (data.code !== 200) throw new Error(`Upstream code ${data.code}: ${data.message ?? 'invalid response'}`);
  return data;
}

export async function request(url, type, {
  fetchImpl = fetch, retries = 3, timeoutMs = 20_000, delay = sleep,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'autoEPG/1.0 (+https://github.com/TvWasm/autoEPG)', Referer: HOME },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return decode(type, new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      lastError = error;
      if (attempt + 1 < retries) await delay(1000 * 2 ** attempt);
    }
  }
  throw new Error(`${url}: ${lastError.message}`, { cause: lastError });
}

export function extractChannels(page) {
  const channels = new Map();
  for (const module of page.data?.feedModuleList ?? []) {
    if (module.moduleType !== 'tvChannel') continue;
    for (const c of module.dataTvChannelList ?? []) {
      if (!/^\d+$/.test(c.pid) || !c.channelName?.trim()) throw new Error('Invalid upstream channel');
      const dates = [...new Set(c.programDates ?? [])].sort();
      if (dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        Number.isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) {
        throw new Error(`Invalid programme date for ${c.pid}`);
      }
      const channel = {
        id: `ysp.${c.pid}`, pid: c.pid, name: c.channelName.trim(),
        logo: c.tvLogo ?? '', group: c.channelType ?? '', dates,
      };
      const previous = channels.get(c.pid);
      if (previous && previous.name !== channel.name) throw new Error(`Conflicting channel ${c.pid}`);
      if (previous) channel.dates = [...new Set([...previous.dates, ...dates])].sort();
      channels.set(c.pid, channel);
    }
  }
  if (!channels.size) throw new Error('No TV channels found; upstream schema may have changed');
  return [...channels.values()];
}

export class Yangshipin {
  constructor(options = {}) { this.options = options; }
  async channels() {
    const nav = await request(`${API}oms/pc/navigation/home_top_nav`, 'NavigationResponse', this.options);
    const tab = nav.data?.tabList?.find(t => t.channelTag === 2);
    if (!tab?.feedId) throw new Error('TV navigation missing; upstream schema may have changed');
    const page = await request(`${API}oms/pc/page/${encodeURIComponent(tab.feedId)}`, 'PageResponse', this.options);
    return extractChannels(page);
  }
  async programmes(channel, date) {
    const response = await request(`${API}yspepg/program/${channel.pid}/${date.replaceAll('-', '')}`,
      'ProgrammeResponse', this.options);
    return response.dataList;
  }
}
