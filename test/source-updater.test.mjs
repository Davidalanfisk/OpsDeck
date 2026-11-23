import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { compareVersions } from '../shared/update.ts';
import { unpackSource } from '../desktop/source-package.ts';
import { createSourceUpdater, parseRelease } from '../desktop/source-updater.ts';

const url = 'https://raw.githubusercontent.com/Davidalanfisk/OpsDeck-updates/main/packages/OpsDeck-0.6.0-source.json.gz';
const manifest = { version: '0.6.0', sha256: 'a'.repeat(64), url };

test('update feed validates versions and only trusts the configured source package URL', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.2.3-beta', '1.2.3'), /Invalid/);
  assert.deepEqual(parseRelease(manifest), manifest);
  assert.throws(() => parseRelease({ ...manifest, url: 'https://example.com/payload' }), /Invalid/);
});

test('source packages reject traversal and workspace data before writing any file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'opsdeck-source-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const encode = files => gzipSync(JSON.stringify({ version: '0.6.0', files }));
  for (const path of ['src/../../escape', 'data/opsdeck.sqlite', 'node_modules/package.js', '/tmp/escape', '.env']) {
    await assert.rejects(() => unpackSource(encode([{ path, content: '' }]), root, '0.6.0'), /Invalid/);
    assert.deepEqual(await readdir(root), []);
  }
  const files = [
    { path: 'package.json', content: Buffer.from('{"version":"0.6.0"}').toString('base64') },
    { path: 'package-lock.json', content: '' },
    { path: 'desktop/main.ts', content: Buffer.from('fixture').toString('base64') },
  ];
  await unpackSource(encode(files), root, '0.6.0');
  assert.equal(await readFile(join(root, 'desktop/main.ts'), 'utf8'), 'fixture');
});

test('update checks report current versions, network errors and checksum failures without changing the installation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'opsdeck-source-update-'));
  const original = globalThis.fetch;
  const updater = createSourceUpdater(root, root, '0.5.2', true);
  t.after(async () => { globalThis.fetch = original; await updater.close(); await rm(root, { recursive: true, force: true }); });
  globalThis.fetch = async () => new Response(JSON.stringify({ ...manifest, version: '0.5.2', url: url.replace('0.6.0', '0.5.2') }));
  await updater.check();
  assert.equal(updater.status().phase, 'current');
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(() => updater.check(), /HTTP 503/);
  assert.equal(updater.status().phase, 'error');
  globalThis.fetch = async requested => new Response(requested === url ? 'bad archive' : JSON.stringify(manifest));
  await updater.check();
  assert.equal(updater.status().phase, 'available');
  await assert.rejects(() => updater.prepare(), /checksum mismatch/);
  assert.equal(updater.status().current, '0.5.2');
  assert.deepEqual(await readdir(root), []);
});

test('source preparation retains Node/npm and never changes the active version before restart', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'opsdeck-preparation-'));
  const updaterRoot = join(root, 'updates');
  const originalFetch = globalThis.fetch;
  const originalNode = process.env.npm_node_execpath;
  const originalNpm = process.env.npm_execpath;
  const npm = join(root, 'npm', 'bin', 'npm-cli.js');
  await mkdir(join(root, 'npm', 'bin'), { recursive: true });
  await writeFile(npm, `if (process.argv.includes('--version')) process.exit(0);
const fs = require('node:fs');
if (process.argv.includes('build:desktop')) {
  fs.mkdirSync('desktop-dist', { recursive: true });
  fs.writeFileSync('desktop-dist/main.cjs', 'fixture build');
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync('dist/index.html', 'fixture');
}`);
  process.env.npm_node_execpath = process.execPath;
  process.env.npm_execpath = npm;
  const updater = createSourceUpdater(updaterRoot, process.cwd(), '0.5.2', true);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalNode === undefined) delete process.env.npm_node_execpath; else process.env.npm_node_execpath = originalNode;
    if (originalNpm === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = originalNpm;
    await updater.close();
    await rm(root, { recursive: true, force: true });
  });
  const archive = gzipSync(JSON.stringify({ version: '0.6.0', files: [
    { path: 'package.json', content: Buffer.from('{"version":"0.6.0"}').toString('base64') },
    { path: 'package-lock.json', content: '' },
    { path: 'desktop/main.ts', content: '' },
  ] }));
  const release = { ...manifest, sha256: createHash('sha256').update(archive).digest('hex') };
  globalThis.fetch = async requested => new Response(requested === url ? archive : JSON.stringify(release));
  await updater.initialize();
  assert.ok((await readFile(join(updaterRoot, 'OpsDeck.command'), 'utf8')).includes('runtime/bin/node'));
  await updater.check();
  await updater.prepare();
  assert.equal(updater.status().phase, 'ready');
  assert.equal(await readFile(join(updaterRoot, 'versions/0.6.0/desktop-dist/main.cjs'), 'utf8'), 'fixture build');
  assert.ok((await readFile(join(updaterRoot, 'OpsDeck.command'), 'utf8')).includes(join(updaterRoot, 'runtime/bin/node')));
  await assert.rejects(() => readFile(join(updaterRoot, 'current.json')), { code: 'ENOENT' });
  assert.ok((await readdir(join(updaterRoot, 'runtime/npm/bin'))).includes('npm-cli.js'));
  const resumed = createSourceUpdater(updaterRoot, process.cwd(), '0.5.2', true);
  t.after(() => resumed.close());
  await resumed.check();
  assert.equal(resumed.status().phase, 'ready');
  await writeFile(join(updaterRoot, 'runtime/npm/bin/npm-cli.js'), 'process.exit(17)');
  const failed = createSourceUpdater(updaterRoot, process.cwd(), '0.5.2', true);
  t.after(() => failed.close());
  const nextArchive = gzipSync(JSON.stringify({ version: '0.6.1', files: [
    { path: 'package.json', content: Buffer.from('{"version":"0.6.1"}').toString('base64') },
    { path: 'package-lock.json', content: '' }, { path: 'desktop/main.ts', content: '' },
  ] }));
  const nextUrl = url.replace('0.6.0', '0.6.1');
  globalThis.fetch = async requested => new Response(requested === nextUrl ? nextArchive :
    JSON.stringify({ version: '0.6.1', url: nextUrl, sha256: createHash('sha256').update(nextArchive).digest('hex') }));
  await failed.check();
  await assert.rejects(() => failed.prepare(), /exited 17/);
  assert.equal(failed.status().phase, 'error');
  assert.deepEqual(await readdir(join(updaterRoot, 'versions')), ['0.6.0']);
});

test('restart helper activates a healthy update and rolls back a failed startup', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'opsdeck-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'original');
  const candidate = join(root, 'versions/0.6.0');
  const fallback = join(root, 'fallback.txt');
  const fixture = async (dir, script) => {
    await mkdir(join(dir, 'node_modules/electron'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"main":"index.cjs"}');
    await writeFile(join(dir, 'node_modules/electron/index.js'), `module.exports = ${JSON.stringify(process.execPath)}`);
    await writeFile(join(dir, 'index.cjs'), script);
  };
  await fixture(source, `require('node:fs').writeFileSync(${JSON.stringify(fallback)}, 'restored')`);
  await fixture(candidate, `require('node:fs').writeFileSync(process.env.OPSDECK_UPDATE_READY, 'ready')`);
  const marker = join(root, 'ready');
  const planPath = join(root, 'plan.json');
  const plan = { root, version: '0.6.0', source, parent: 2147483647, marker };
  await writeFile(planPath, JSON.stringify(plan));
  await promisify(execFile)(process.execPath, ['desktop/update-helper.ts', planPath]);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'current.json'), 'utf8')), { version: '0.6.0' });
  await fixture(candidate, 'process.exit(1)');
  await rm(join(root, 'current.json'));
  await writeFile(planPath, JSON.stringify(plan));
  await promisify(execFile)(process.execPath, ['desktop/update-helper.ts', planPath]);
  await assert.rejects(() => readFile(join(root, 'current.json')), { code: 'ENOENT' });
  assert.match(await readFile(join(root, 'last-error.txt'), 'utf8'), /rolled back/);
  for (let attempt = 0; attempt < 30; attempt++) {
    try { assert.equal(await readFile(fallback, 'utf8'), 'restored'); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
  }
  assert.fail('The original version was not restarted.');
});
