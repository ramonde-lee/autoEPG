import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dateKey, windowFor } from './epg.js';

export const ASSETS = ['epg.xml', 'channels.json', 'manifest.json', 'SHA256SUMS'];
const OPTIONAL_ASSETS = [
  'epg-10d.xml',
  'epg-cctv.xml', 'epg-cctv-10d.xml',
  'epg-weishi.xml', 'epg-weishi-10d.xml',
  'epg.xml.gz', 'epg-10d.xml.gz',
  'epg-cctv.xml.gz', 'epg-cctv-10d.xml.gz',
  'epg-weishi.xml.gz', 'epg-weishi-10d.xml.gz',
  'groups.json',
];

function assetNames(names) {
  if (!Array.isArray(names) || new Set(names).size !== names.length ||
      ASSETS.some(name => !names.includes(name)) || names.some(name => ![...ASSETS, ...OPTIONAL_ASSETS].includes(name))) {
    throw new Error('Invalid release asset list');
  }
  return names;
}

export function releasePolicy(date, today) {
  windowFor(date, 0, 0);
  windowFor(today, 0, 0);
  return { tag_name: date, name: date, prerelease: false, make_latest: date === today ? 'true' : 'false' };
}

export class GitHub {
  constructor(repository, token) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
    this.repository = repository;
    this.token = token;
  }
  async call(method, path, body, { allow404 = false, upload = false, contentType = 'application/octet-stream' } = {}) {
    const host = upload ? 'https://uploads.github.com' : 'https://api.github.com';
    const response = await fetch(`${host}/repos/${this.repository}${path}`, {
      method, signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'autoEPG',
        'Content-Type': upload ? contentType : 'application/json',
      },
      body: body === undefined ? undefined : upload ? body : JSON.stringify(body),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return response.status === 204 ? null : response.json();
  }
}

export async function ensureDateTag(api, date, commit) {
  windowFor(date, 0, 0);
  const ref = await api.call('GET', `/git/ref/tags/${date}`, undefined, { allow404: true });
  if (ref) return;
  // The tag date is the schedule date, independent of the generator commit date.
  const tag = await api.call('POST', '/git/tags', {
    tag: date, message: `EPG schedule for ${date} (Asia/Shanghai)`, object: commit, type: 'commit',
    tagger: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com',
      date: `${date}T00:00:00+08:00` },
  });
  try {
    await api.call('POST', '/git/refs', { ref: `refs/tags/${date}`, sha: tag.sha });
  } catch (error) {
    // A concurrent run may have created the same tag; treat that as success.
    if (!/already exists|422/.test(error.message)) throw error;
  }
}

export async function deleteAllReleases(api) {
  const releases = [];
  // Snapshot all pages before deleting, so pagination cannot skip shifted entries.
  for (let page = 1; ; page++) {
    const batch = await api.call('GET', `/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  if (releases.some(r => r.immutable)) throw new Error('Cannot rebuild immutable releases');
  for (const release of releases) {
    await api.call('DELETE', `/releases/${release.id}`);
    console.log(`Deleted Release ${release.tag_name}`);
  }
  // Recreate only tags attached to the deleted releases; leave unrelated tags alone.
  for (const tag of new Set(releases.map(r => r.tag_name))) {
    await api.call('DELETE', `/git/refs/tags/${encodeURIComponent(tag)}`, undefined, { allow404: true });
  }
  return releases.length;
}

// Delete every Release whose tag is not `keepDate`, along with its tag.
// Enforces "single Release, current day only" on every run.
async function deleteOtherReleases(api, keepDate) {
  const releases = [];
  for (let page = 1; ; page++) {
    const batch = await api.call('GET', `/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  if (releases.some(r => r.immutable)) throw new Error('Cannot delete immutable releases');
  let removed = 0;
  for (const release of releases) {
    if (release.tag_name === keepDate) continue;
    await api.call('DELETE', `/releases/${release.id}`);
    await api.call('DELETE', `/git/refs/tags/${encodeURIComponent(release.tag_name)}`, undefined, { allow404: true });
    console.log(`Deleted stale Release ${release.tag_name}`);
    removed++;
  }
  return removed;
}

export async function upsertRelease(api, { date, today, commit, body, files }) {
  const policy = releasePolicy(date, today);
  let release = await api.call('GET', `/releases/tags/${date}`, undefined, { allow404: true });
  if (release?.immutable) throw new Error(`Release ${date} is immutable; disable release immutability to refresh daily assets`);
  await ensureDateTag(api, date, commit);
  if (!release) release = await api.call('POST', '/releases', {
    ...policy, target_commitish: commit, body, draft: true, make_latest: 'false',
  });
  // Stage every new file before changing public names. Failed uploads leave old files intact.
  const nonce = randomUUID();
  const staged = [];
  for (const name of assetNames(Object.keys(files))) {
    const bytes = files[name];
    if (!Buffer.isBuffer(bytes)) throw new Error(`Missing asset ${name}`);
    const pendingName = `__autoepg_${nonce}_${name}`;
    const contentType = name.endsWith('.xml') ? 'application/xml' : name.endsWith('.json') ? 'application/json' : 'text/plain';
    const asset = await api.call('POST', `/releases/${release.id}/assets?name=${encodeURIComponent(pendingName)}`, bytes, { upload: true, contentType });
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (asset.size !== bytes.length || (asset.digest && asset.digest !== digest)) throw new Error(`Upload verification failed: ${name}`);
    staged.push({ name, asset, pendingName, old: release.assets?.find(a => a.name === name) });
  }
  const started = [];
  try {
    for (const item of staged) {
      started.push(item);
      if (item.old) await api.call('PATCH', `/releases/assets/${item.old.id}`, { name: `__autoepg_${nonce}_previous_${item.name}` });
      await api.call('PATCH', `/releases/assets/${item.asset.id}`, { name: item.name });
    }
  } catch (error) {
    // Best-effort rollback for a failed rename; original bytes have not been deleted.
    for (const item of started.reverse()) {
      try {
        await api.call('PATCH', `/releases/assets/${item.asset.id}`, { name: item.pendingName });
        if (item.old) await api.call('PATCH', `/releases/assets/${item.old.id}`, { name: item.name });
      } catch (rollbackError) { console.error(`Rollback ${date}/${item.name}: ${rollbackError.message}`); }
    }
    throw error;
  }
  await api.call('PATCH', `/releases/${release.id}`, { ...policy, body, draft: false });
  // Clean only our staging/backup assets. Leave user-added attachments untouched.
  const current = await api.call('GET', `/releases/${release.id}`);
  for (const asset of current.assets ?? []) {
    if (asset.name.startsWith('__autoepg_')) {
      try { await api.call('DELETE', `/releases/assets/${asset.id}`); }
      catch (error) { console.warn(`Cleanup ${date}: ${error.message}`); }
    }
  }
  return policy;
}

export async function publishDirectory(api, directory, commit, {
  currentDate = () => dateKey(Date.now() / 1000), today = currentDate(), rebuild = false,
} = {}) {
  const index = JSON.parse(await readFile(join(directory, 'releases.json'), 'utf8'));
  if (index.referenceDate !== today) throw new Error('Scrape date is not today; regenerate before publishing');
  if (!index.releases.some(r => r.date === today)) throw new Error('Current-day EPG is missing');

  // Only the reference day is published.
  const entry = index.releases.find(r => r.date === today);
  const names = assetNames(entry.assets ?? ASSETS);
  const files = Object.fromEntries(await Promise.all(names.map(async name =>
    [name, await readFile(join(directory, entry.date, name))])));

  const expected = names.filter(name => name !== 'SHA256SUMS').map(name =>
    `${createHash('sha256').update(files[name]).digest('hex')}  ${name}\n`).join('');
  if (files.SHA256SUMS.toString() !== expected) throw new Error(`Checksum mismatch: ${entry.date}`);

  const m = JSON.parse(files['manifest.json']);
  if (m.date !== entry.date) throw new Error(`Manifest date mismatch: ${entry.date}`);

  const base = `https://github.com/${api.repository}/releases`;
  const variants = (m.variants ?? []).map(v =>
    `- [\`${v.file}\`](${base}/download/${entry.date}/${v.file})：${v.from} 至 ${v.to}（${v.days} 天，${v.bytes} 字节）`).join('\n');

  const body = `央视频节目单 · ${entry.date}（北京时间）\n\n` +
    `更新：${index.generatedAt}；频道：${m.channelCount}；节目：${m.programmeCount}；XML：${m.xmlBytes} 字节。\n\n` +
    `本版本包含：\n\n${variants}\n\n` +
    `[当天固定订阅](${base}/latest/download/epg.xml)`;

  if (currentDate() !== today) throw new Error('Beijing midnight crossed before publishing; regenerate schedules');

  // Destructive rebuild is explicitly opt-in and happens only after full validation.
  if (rebuild) await deleteAllReleases(api);
  // Enforce "single Release, current day only": drop any other releases/tags.
  await deleteOtherReleases(api, today);

  const policy = await upsertRelease(api, { date: entry.date, today, commit, files, body });
  console.log(`${entry.date}: ${policy.make_latest === 'true' ? 'Latest' : 'Release'}`);
  return 1;
}
