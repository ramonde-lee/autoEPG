import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const directory = new URL('../assets/logos/', import.meta.url);
const { logos } = JSON.parse(readFileSync(new URL('sources.json', directory), 'utf8'));
const repository = process.env.GITHUB_REPOSITORY || 'TvWasm/autoEPG';
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid logo repository');
const base = `https://raw.githubusercontent.com/${repository}/main/assets/logos/`;
const byUrl = new Map(Object.values(logos).map(asset => [base + asset.file, asset]));

export function projectLogo(channelId) {
  const asset = logos[channelId];
  return asset ? base + asset.file : undefined;
}

export function projectLogoBytes(url) {
  const asset = byUrl.get(url);
  if (!asset) return undefined;
  if (!/^[a-z0-9]+\.png$/.test(asset.file)) throw new Error('Invalid project logo filename');
  const bytes = readFileSync(new URL(asset.file, directory));
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`Project logo checksum mismatch: ${asset.file}`);
  }
  return bytes;
}
