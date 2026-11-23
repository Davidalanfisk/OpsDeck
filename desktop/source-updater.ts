import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserWindow } from 'electron';
import { compareVersions, type UpdateStatus } from '../shared/update.ts';
import { unpackSource } from './source-package.ts';

const feed = 'https://raw.githubusercontent.com/Davidalanfisk/OpsDeck-updates/main/latest.json';
const prefix = 'https://raw.githubusercontent.com/Davidalanfisk/OpsDeck-updates/main/packages/';
type Release = { version: string; sha256: string; url: string };

async function exists(path: string) {
  try { await access(path); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function fetchUpdate(url: string, limit: number, signal: AbortSignal) {
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Update download failed (HTTP ${response.status}).`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Update download exceeded the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function parseRelease(data: unknown): Release {
  if (!data || typeof data !== 'object' || !('version' in data) || typeof data.version !== 'string' ||
    !('sha256' in data) || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256) ||
    !('url' in data) || data.url !== `${prefix}OpsDeck-${data.version}-source.json.gz`) {
    throw new Error('Invalid update manifest.');
  }
  compareVersions(data.version, data.version);
  return { version: data.version, sha256: data.sha256, url: data.url };
}

export function createSourceUpdater(root: string, source: string, current: string, supported: boolean) {
  let state: UpdateStatus = { phase: 'idle', current, supported, detail: supported ? 'Check for updates' : 'Source updates support macOS Apple silicon source installs only.' };
  let release: Release | undefined;
  let running = false;
  let task: Promise<void> | undefined;
  const shutdown = new AbortController();
  const set = (phase: UpdateStatus['phase'], detail: string, latest = release?.version) => { state = { phase, current, supported, detail, latest }; };
  async function run(binary: string, args: string[], cwd: string, env = process.env) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { cwd, env, stdio: 'ignore', detached: process.platform !== 'win32' });
      const cancel = () => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill(); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) reject(error); }
      };
      shutdown.signal.addEventListener('abort', cancel, { once: true });
      if (shutdown.signal.aborted) cancel();
      child.once('error', error => { shutdown.signal.removeEventListener('abort', cancel); reject(error); });
      child.once('exit', code => {
        shutdown.signal.removeEventListener('abort', cancel);
        if (code === 0) resolve();
        else reject(new Error(`Update preparation failed (${basename(binary)} exited ${code}). The current installation is unchanged.`));
      });
    });
  }
  async function runtime() {
    const destination = join(root, 'runtime');
    const node = join(destination, 'bin', 'node');
    const npm = join(destination, 'npm', 'bin', 'npm-cli.js');
    if (await exists(node) && await exists(npm)) return { node, npm };
    const originalNode = process.env.npm_node_execpath;
    const originalNpm = process.env.npm_execpath;
    if (!originalNode || !originalNpm || basename(originalNpm) !== 'npm-cli.js') {
      throw new Error('For the first update, launch OpsDeck using npm run start:desktop so its Node/npm runtime can be preserved.');
    }
    await mkdir(root, { recursive: true });
    const temp = await mkdtemp(join(root, 'runtime-'));
    try {
      await mkdir(join(temp, 'bin'));
      await copyFile(originalNode, join(temp, 'bin', 'node'));
      await chmod(join(temp, 'bin', 'node'), 0o700);
      await cp(dirname(dirname(originalNpm)), join(temp, 'npm'), { recursive: true, dereference: true });
      await run(join(temp, 'bin', 'node'), ['--version'], source);
      await run(join(temp, 'bin', 'node'), [join(temp, 'npm', 'bin', 'npm-cli.js'), '--version'], source);
      await rename(temp, destination);
      return { node, npm };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  async function writeLauncher(tools: { node: string }) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await copyFile(join(source, 'scripts', 'start-desktop.mjs'), join(root, 'start-desktop.mjs'));
    await writeFile(join(root, 'OpsDeck.command'), `#!/bin/sh\nexport PATH=${quote(dirname(tools.node))}:"$PATH"\nexport OPSDECK_SOURCE_DIR=${quote(source)}\nexec ${quote(tools.node)} ${quote(join(root, 'start-desktop.mjs'))}\n`, { mode: 0o700 });
  }
  async function check() {
    if (!supported) throw new Error(state.detail);
    if (running) throw new Error('An update operation is already running.');
    running = true;
    set('checking', 'Checking for updates…');
    try {
      release = parseRelease(JSON.parse((await fetchUpdate(feed, 32_000, AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]))).toString('utf8')));
      const prepared = join(root, 'versions', release.version, '.prepared.json');
      if (compareVersions(release.version, current) > 0 && await exists(prepared) &&
        JSON.parse(await readFile(prepared, 'utf8')).sha256 === release.sha256) {
        set('ready', 'A previously prepared update is ready to install. Save your work, then restart.');
        return;
      }
      set(compareVersions(release.version, current) > 0 ? 'available' : 'current',
        compareVersions(release.version, current) > 0 ? `OpsDeck ${release.version} is available.` : `OpsDeck ${current} is up to date.`);
    } catch (error) {
      release = undefined;
      set('error', `Update check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    } finally { running = false; }
  }
  async function prepare() {
    if (running || state.phase !== 'available' || !release) throw new Error('Check for an available update first.');
    const selected = release;
    running = true;
    set('installing', 'Downloading and verifying the update…');
    let temp: string | undefined;
    let installed: string | undefined;
    try {
      const archive = await fetchUpdate(selected.url, 20_000_000, AbortSignal.any([shutdown.signal, AbortSignal.timeout(5 * 60_000)]));
      if (createHash('sha256').update(archive).digest('hex') !== selected.sha256) throw new Error('Update checksum mismatch. Nothing was installed.');
      await mkdir(root, { recursive: true });
      const versions = join(root, 'versions');
      await mkdir(versions, { recursive: true });
      const target = join(versions, selected.version);
      if (await exists(target)) throw new Error('This update version is already staged. Restart OpsDeck or contact support.');
      temp = await mkdtemp(join(versions, 'preparing-'));
      await unpackSource(archive, temp, selected.version);
      const tools = await runtime();
      const env = { ...process.env, PATH: `${dirname(tools.node)}:${process.env.PATH ?? ''}`,
        npm_node_execpath: tools.node, npm_execpath: tools.npm };
      set('installing', 'Installing dependencies and building the update. The current app remains open…');
      await run(tools.node, [tools.npm, 'ci', '--no-audit', '--no-fund'], temp, env);
      await run(tools.node, [tools.npm, 'run', 'build:desktop'], temp, env);
      if (!await exists(join(temp, 'desktop-dist/main.cjs')) || !await exists(join(temp, 'dist/index.html'))) {
        throw new Error('The update build did not produce the expected desktop files.');
      }
      if (shutdown.signal.aborted) throw new Error('Update cancelled.');
      await rename(temp, target);
      installed = target;
      await writeLauncher(tools);
      await writeFile(join(target, '.prepared.json'), JSON.stringify({ sha256: selected.sha256 }), { mode: 0o600 });
      set('ready', 'Update built. Restart to install; open OpsDeck.command from the source-updates folder for future launches.');
    } catch (error) {
      if (installed) await rm(installed, { recursive: true, force: true });
      set('error', `Update failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true });
      running = false;
    }
  }
  return {
    status: () => state,
    async initialize() {
      if (!supported) return;
      running = true;
      try { await writeLauncher(await runtime()); }
      catch (error) { set('error', `Updater setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`); throw error; }
      finally { running = false; }
    },
    check,
    prepare() { task = prepare(); return task; },
    async restart(window: BrowserWindow) {
      if (state.phase !== 'ready' || !release) throw new Error('Prepare an update before restarting.');
      const tools = await runtime();
      const pointer = join(root, 'current.json');
      const previous = await exists(pointer) ? (JSON.parse(await readFile(pointer, 'utf8')) as { version: string }).version : undefined;
      const planPath = join(root, `restart-${randomUUID()}.json`);
      await writeFile(planPath, JSON.stringify({ root, version: release.version, previous, source, parent: process.pid,
        marker: join(root, `ready-${randomUUID()}`) }), { mode: 0o600 });
      const helper = spawn(tools.node, [join(source, 'desktop-dist', 'update-helper.cjs'), planPath], {
        detached: true, stdio: 'ignore', env: process.env,
      });
      await new Promise<void>((resolve, reject) => { helper.once('spawn', resolve); helper.once('error', reject); });
      helper.unref();
      window.close();
      await delay(500);
      if (!window.isDestroyed()) {
        helper.kill();
        await rm(planPath, { force: true });
        throw new Error('Restart cancelled; your running app and pending update are unchanged.');
      }
    },
    async close() {
      shutdown.abort();
      await task?.catch(() => undefined);
    },
  };
}
