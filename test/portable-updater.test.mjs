import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createPortableUpdater, parsePortableRelease } from '../desktop/portable-updater.ts';

const bytes = Buffer.from('portable fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const url = platform => `https://github.com/Davidalanfisk/OpsDeck/releases/download/v0.7.0/OpsDeck-0.7.0-${platform}.zip`;
const manifest = { version: '0.7.0', portable: Object.fromEntries(['mac-arm64', 'win-x64'].map(platform =>
  [platform, { url: url(platform), sha256 }])) };

test('portable feed only accepts exact versioned release assets', () => {
  for (const platform of ['mac-arm64', 'win-x64']) {
    assert.equal(parsePortableRelease(manifest, platform).url, url(platform));
    assert.throws(() => parsePortableRelease({ ...manifest, portable: {} }, platform), /does not include/);
    assert.throws(() => parsePortableRelease({ ...manifest, portable: { [platform]: { url: 'https://example.com/a.zip', sha256 } } }, platform), /Invalid/);
    assert.throws(() => parsePortableRelease({ ...manifest, portable: { [platform]: { url: url(platform), sha256: 'bad' } } }, platform), /Invalid/);
  }
  assert.throws(() => parsePortableRelease({ ...manifest, version: '../bad' }, 'win-x64'), /Invalid/);
});

for (const platform of ['mac-arm64', 'win-x64']) {
  test(`${platform} verifies and exposes a separate ZIP without changing the running installation`, async t => {
    const root = await mkdtemp(join(process.cwd(), 'portable-updater-test-'));
    const original = globalThis.fetch;
    let revealed;
    const updater = createPortableUpdater(root, '0.6.2', platform, path => { revealed = path; });
    t.after(async () => { globalThis.fetch = original; await updater.close(); await rm(root, { recursive: true, force: true }); });
    globalThis.fetch = async requested => requested === url(platform)
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset?secret=redacted' } })
      : requested.startsWith('https://release-assets.githubusercontent.com/') ? new Response(bytes) : new Response(JSON.stringify(manifest));
    await updater.check();
    assert.equal(updater.status().phase, 'available');
    await updater.prepare();
    assert.equal(updater.status().phase, 'ready');
    await updater.restart(null);
    assert.deepEqual(await readFile(revealed), bytes);
    assert.match(revealed, new RegExp(`OpsDeck-0\\.7\\.0-${platform}\\.zip$`));
    assert.equal((await readdir(root)).length, 1);
  });
}

test('portable updates reject redirects and checksum failures and remove partial downloads', async t => {
  const root = await mkdtemp(join(process.cwd(), 'portable-updater-test-'));
  const original = globalThis.fetch;
  const updater = createPortableUpdater(root, '0.6.2', 'win-x64', () => {});
  t.after(async () => { globalThis.fetch = original; await updater.close(); await rm(root, { recursive: true, force: true }); });
  globalThis.fetch = async requested => requested === url('win-x64')
    ? new Response(null, { status: 302, headers: { location: 'https://evil.example/asset?credential=secret' } })
    : new Response(JSON.stringify(manifest));
  await updater.check();
  await assert.rejects(() => updater.prepare(), /Untrusted/);
  assert.equal(updater.status().phase, 'error');
  assert.doesNotMatch(updater.status().detail, /credential|secret/);
  assert.deepEqual(await readdir(root), []);
  globalThis.fetch = async requested => requested === url('win-x64') ? new Response('bad') : new Response(JSON.stringify(manifest));
  await updater.check();
  await assert.rejects(() => updater.prepare(), /checksum mismatch/);
  assert.deepEqual(await readdir(root), []);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(() => updater.check(), /HTTP 503/);
  assert.equal(updater.status().phase, 'error');
});

test('release feed generator preserves source fields and hashes both release ZIPs', async t => {
  const root = await mkdtemp(join(process.cwd(), 'portable-feed-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'release', 'source-updates'), { recursive: true });
  const source = { version: '0.7.0', sha256: 'b'.repeat(64),
    url: 'https://raw.githubusercontent.com/Davidalanfisk/OpsDeck-updates/main/packages/OpsDeck-0.7.0-source.json.gz' };
  const manifestPath = join(root, 'release', 'source-updates', 'latest.json');
  await writeFile(manifestPath, JSON.stringify(source));
  for (const platform of ['mac-arm64', 'win-x64'])
    await writeFile(join(root, 'release', `OpsDeck-0.7.0-${platform}.zip`), bytes);
  await promisify(execFile)(process.execPath, [join(process.cwd(), 'scripts', 'package-portable-feed.ts')], { cwd: root });
  const generated = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(generated.url, source.url);
  assert.equal(generated.sha256, source.sha256);
  for (const platform of ['mac-arm64', 'win-x64']) {
    assert.equal(parsePortableRelease(generated, platform).sha256, sha256);
  }
});
