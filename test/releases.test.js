import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ASSETS, releasePolicy, upsertRelease, publishDirectory } from '../src/releases.js';
import { collect, writeArtifacts } from '../src/epg.js';

class FakeGitHub {
  repository = 'example/epg';
  releases = [];
  nextId = 1;
  latest = null;
  published = [];
  uploadCount = 0;
  async call(method, path, body, config) {
    if (method === 'GET' && path.startsWith('/releases/tags/')) {
      return structuredClone(this.releases.find(r => r.tag_name === path.split('/').at(-1)) ?? null);
    }
    if (method === 'POST' && path === '/releases') {
      const release = { ...body, id: this.nextId++, assets: [] };
      this.releases.push(release);
      return structuredClone(release);
    }
    const upload = path.match(/^\/releases\/(\d+)\/assets\?name=(.*)$/);
    if (method === 'POST' && upload) {
      assert.equal(config.contentType, decodeURIComponent(upload[2]).endsWith('.xml') ? 'application/xml' :
        decodeURIComponent(upload[2]).endsWith('.json') ? 'application/json' : 'text/plain');
      if (++this.uploadCount === this.failUploadAt) throw new Error('upload failed');
      const release = this.releases.find(r => r.id === Number(upload[1]));
      const asset = { id: this.nextId++, name: decodeURIComponent(upload[2]), size: body.length,
        digest: `sha256:${createHash('sha256').update(body).digest('hex')}` };
      release.assets.push(asset);
      return structuredClone(asset);
    }
    const assetPath = path.match(/^\/releases\/assets\/(\d+)$/);
    if (assetPath) {
      const release = this.releases.find(r => r.assets.some(a => a.id === Number(assetPath[1])));
      const asset = release.assets.find(a => a.id === Number(assetPath[1]));
      if (method === 'DELETE') { release.assets = release.assets.filter(a => a !== asset); return null; }
      if (body.name === this.failRename) { this.failRename = null; throw new Error('rename failed'); }
      assert(!release.assets.some(a => a !== asset && a.name === body.name), 'duplicate asset name');
      Object.assign(asset, body);
      return structuredClone(asset);
    }
    const releasePath = path.match(/^\/releases\/(\d+)$/);
    if (releasePath) {
      const release = this.releases.find(r => r.id === Number(releasePath[1]));
      if (method === 'PATCH') {
        Object.assign(release, body);
        if (body.make_latest === 'true') this.latest = release.tag_name;
        this.published.push(release.tag_name);
      }
      return structuredClone(release);
    }
    throw new Error(`Unexpected API call: ${method} ${path}`);
  }
}

const files = suffix => Object.fromEntries(ASSETS.map(name => [name, Buffer.from(name + suffix)]));
const options = { date: '2026-09-09', today: '2026-09-09', commit: 'abc', body: 'EPG', files: files('v1') };

test('date versions distinguish historical, current and future releases across years', () => {
  assert.equal(releasePolicy('2025-12-31', '2026-01-01').make_latest, 'false');
  assert.deepEqual(releasePolicy('2026-01-01', '2026-01-01'), {
    tag_name: '2026-01-01', name: '2026-01-01', prerelease: false, make_latest: 'true',
  });
  assert.equal(releasePolicy('2026-01-02', '2026-01-01').prerelease, true);
  assert.throws(() => releasePolicy('../../file', options.today));
});

test('creates a draft, uploads files, publishes today and keeps future releases out of Latest', async () => {
  const api = new FakeGitHub();
  await upsertRelease(api, options);
  await upsertRelease(api, { ...options, date: '2026-09-10' });
  assert.equal(api.latest, options.today);
  assert.equal(api.releases[0].draft, false);
  assert.equal(api.releases[1].prerelease, true);
  assert.deepEqual(api.releases[0].assets.map(a => a.name), ASSETS);
});

test('refreshes an existing date in place and promotes its prerelease when the date arrives', async () => {
  const api = new FakeGitHub();
  await upsertRelease(api, { ...options, today: '2026-09-08' });
  const id = api.releases[0].id;
  const digest = api.releases[0].assets[0].digest;
  await upsertRelease(api, { ...options, files: files('updated') });
  assert.equal(api.releases.length, 1);
  assert.equal(api.releases[0].id, id);
  assert.equal(api.releases[0].prerelease, false);
  assert.equal(api.latest, options.today);
  assert.notEqual(api.releases[0].assets[0].digest, digest);
  assert.deepEqual(api.releases[0].assets.map(a => a.name), ASSETS);
});

test('failed staging upload preserves all previously published file names and contents', async () => {
  const api = new FakeGitHub();
  await upsertRelease(api, options);
  const original = structuredClone(api.releases[0].assets);
  api.failUploadAt = api.uploadCount + 2;
  await assert.rejects(upsertRelease(api, { ...options, files: files('new') }), /upload failed/);
  assert.deepEqual(api.releases[0].assets.filter(a => !a.name.startsWith('__autoepg_')), original);
  assert.equal(api.latest, options.today);
});

test('failed rename rolls back both previously switched files and the current file', async () => {
  const api = new FakeGitHub();
  await upsertRelease(api, options);
  const original = structuredClone(api.releases[0].assets);
  api.failRename = 'channels.json';
  await assert.rejects(upsertRelease(api, { ...options, files: files('new') }), /rename failed/);
  assert.deepEqual(api.releases[0].assets.filter(a => !a.name.startsWith('__autoepg_')), original);
});

test('rejects immutable releases before replacing files', async () => {
  const api = new FakeGitHub();
  await upsertRelease(api, options);
  api.releases[0].immutable = true;
  await assert.rejects(upsertRelease(api, options), /immutable/);
  assert.equal(api.uploadCount, 4);
});

test('publishes date directories with checksums, sets today first and refuses stale/corrupt input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autoepg-release-test-'));
  try {
    const dates = ['2026-09-08', '2026-09-09', '2026-09-10'];
    const dataset = await collect({
      channels: async () => [{ id: 'ysp.1', pid: '1', name: 'Test', dates }],
      programmes: async (channel, date) => [{ name: date,
        st: Date.parse(`${date}T10:00:00+08:00`) / 1000, et: Date.parse(`${date}T11:00:00+08:00`) / 1000 }],
    }, { today: options.today, pastDays: 1, futureDays: 1, minChannels: 1, delayMs: 0 });
    await writeArtifacts(dir, dataset);
    const api = new FakeGitHub();
    const config = { currentDate: () => options.today };
    assert.equal(await publishDirectory(api, dir, 'abc', config), 3);
    assert.deepEqual(api.published, ['2026-09-09', '2026-09-08', '2026-09-10']);
    assert.equal(api.latest, options.today);
    await assert.rejects(publishDirectory(api, dir, 'abc', { currentDate: () => '2026-09-10' }), /Scrape date/);
    await writeFile(join(dir, options.today, 'epg.xml'), 'corrupt');
    await assert.rejects(publishDirectory(api, dir, 'abc', config), /Checksum/);
    assert.equal(api.published.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
