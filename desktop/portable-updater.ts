import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { compareVersions, type UpdateStatus } from '../shared/update.ts';
import { fetchUpdate } from './source-updater.ts';

const feed = 'https://raw.githubusercontent.com/Davidalanfisk/OpsDeck-updates/main/latest.json';
const releaseBase = 'https://github.com/Davidalanfisk/OpsDeck/releases/download';
export type PortablePlatform = 'mac-arm64' | 'win-x64';
type Release = { version: string; url: string; sha256: string; name: string };

export function parsePortableRelease(data: unknown, platform: PortablePlatform): Release {
  if (!data || typeof data !== 'object' || !('version' in data) || typeof data.version !== 'string')
    throw new Error('Invalid update manifest.');
  compareVersions(data.version, data.version);
  const name = `OpsDeck-${data.version}-${platform}.zip`;
  if (!('portable' in data) || !data.portable || typeof data.portable !== 'object' ||
      !(platform in data.portable)) throw new Error(`The update feed does not include a ${platform} portable ZIP.`);
  const asset = (data.portable as Record<string, unknown>)[platform];
  if (!asset || typeof asset !== 'object' || !('url' in asset) ||
      asset.url !== `${releaseBase}/v${data.version}/${name}` ||
      !('sha256' in asset) || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256))
    throw new Error('Invalid portable update asset.');
  return { version: data.version, url: asset.url, sha256: asset.sha256, name };
}

async function download(url: string, path: string, expected: string, signal: AbortSignal) {
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    try { response = await fetch(url, { signal, redirect: 'manual' }); }
    catch { throw new Error('Portable update download failed or was cancelled.'); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    let next: URL;
    try { next = new URL(location ?? '', url); } catch { throw new Error('Invalid update download redirect.'); }
    if (next.protocol !== 'https:' || next.username || next.password ||
        !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname) ||
        (next.port && next.port !== '443')) throw new Error('Untrusted update download redirect.');
    await response.body?.cancel();
    url = next.href;
    response = undefined;
  }
  if (!response) throw new Error('Too many update download redirects.');
  if (!response.ok || !response.body) throw new Error(`Update download failed (HTTP ${response.status}).`);
  const hash = createHash('sha256');
  let size = 0;
  const file = await open(path, 'wx', 0o600);
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 500_000_000) throw new Error('Update download exceeded the size limit.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (!size || hash.digest('hex') !== expected) throw new Error('Update checksum mismatch. Nothing was installed.');
  } finally { await file.close(); }
}

export function createPortableUpdater(root: string, current: string, platform: PortablePlatform, reveal: (path: string) => void) {
  let state: UpdateStatus = { phase: 'idle', current, supported: true, mode: 'portable', detail: 'Check for updates' };
  let release: Release | undefined;
  let staged: string | undefined;
  let running = false;
  let task: Promise<void> | undefined;
  const shutdown = new AbortController();
  const set = (phase: UpdateStatus['phase'], detail: string) => {
    state = { phase, current, supported: true, mode: 'portable', detail, latest: release?.version };
  };
  async function check() {
    if (running) throw new Error('An update operation is already running.');
    running = true;
    set('checking', 'Checking for updates…');
    try {
      release = parsePortableRelease(JSON.parse((await fetchUpdate(feed, 32_000,
        AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]))).toString('utf8')), platform);
      staged = undefined;
      const available = compareVersions(release.version, current) > 0;
      set(available ? 'available' : 'current', available ? `OpsDeck ${release.version} is available.` : `OpsDeck ${current} is up to date.`);
    } catch (error) {
      release = undefined;
      set('error', `Update check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    } finally { running = false; }
  }
  async function prepare() {
    if (running || state.phase !== 'available' || !release) throw new Error('Check for an available update first.');
    running = true;
    const selected = release;
    set('installing', 'Downloading and verifying the portable ZIP…');
    let directory: string | undefined;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(root, 'download-'));
      const partial = join(directory, 'download.part');
      await download(selected.url, partial, selected.sha256,
        AbortSignal.any([shutdown.signal, AbortSignal.timeout(10 * 60_000)]));
      if (shutdown.signal.aborted) throw new Error('Update cancelled.');
      staged = join(directory, selected.name);
      await rename(partial, staged);
      directory = undefined;
      set('ready', 'ZIP verified. Show it in your file manager, extract it to a new folder, close OpsDeck, and launch the new copy. Keep the old copy for rollback.');
    } catch (error) {
      staged = undefined;
      set('error', `Update failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      running = false;
    }
  }
  return {
    status: () => state,
    async initialize() {},
    check,
    prepare() { task = prepare(); return task; },
    async restart(_window: BrowserWindow) {
      if (state.phase !== 'ready' || !staged) throw new Error('Download an update first.');
      await access(staged);
      reveal(staged);
    },
    async close() { shutdown.abort(); await task?.catch(() => undefined); },
  };
}
