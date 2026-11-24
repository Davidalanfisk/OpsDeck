import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ollamaModels } from '../shared/ollama.ts';
import type { OllamaModel, OllamaStatus } from '../shared/ollama.ts';
import { contextSizes } from '../shared/agent-context.ts';

export function modelContextLimit(info: unknown): number {
  if (!info || typeof info !== 'object' || !('model_info' in info) ||
      !info.model_info || typeof info.model_info !== 'object') {
    throw new Error('Ollama did not report the model context limit. Reload the model and try again.');
  }
  const limits = Object.entries(info.model_info).filter(([key]) => key.endsWith('.context_length'))
    .map(([, value]) => value).filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  if (!limits.length || Math.min(...limits) < contextSizes[0]) {
    throw new Error('Ollama did not report a supported model context limit (at least 8K required).');
  }
  return Math.min(...limits);
}

export async function fetchModelContextLimit(origin: string, model: OllamaModel, signal: AbortSignal) {
  const response = await fetch(`${origin}/api/show`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }), signal,
  });
  if (!response.ok) throw new Error(`Could not check model context support (HTTP ${response.status}).`);
  return modelContextLimit(await response.json());
}

const release = 'v0.40.17';
const assets = {
  darwin: { name: 'Ollama-darwin.zip', sha256: '86756dc45f30e1447fc9626f828ab6098c26d8c5cc3620bab689f4cbb5411469', binary: 'Ollama.app/Contents/Resources/ollama' },
  win32: { name: 'ollama-windows-amd64.zip', sha256: '3dd80f6e3a9699f2eadf4ac418f00529cee594df9557541806eda1f1f3f5588a', binary: 'ollama.exe' },
} as const;
const memory = totalmem();
const recommended: OllamaModel = memory >= 22 * 1024 ** 3 ? 'qwen3:14b' : memory >= 14 * 1024 ** 3 ? 'qwen3:8b' : 'qwen3:4b';

export function createOllama(directory: string) {
  const root = join(directory, 'ollama');
  const installation = join(root, release);
  let state: OllamaStatus = { phase: 'idle', detail: 'Not started', memoryBytes: memory, recommended };
  let process: ChildProcess | undefined;
  let extractor: ChildProcess | undefined;
  let origin = '';
  let running = false;
  let shuttingDown = false;
  const shutdown = new AbortController();
  const set = (phase: OllamaStatus['phase'], detail: string, extra: Partial<OllamaStatus> = {}) => {
    state = { phase, detail, memoryBytes: memory, recommended, ...extra };
  };
  function supported() {
    if (globalThis.process.platform === 'darwin' && globalThis.process.arch === 'arm64') return assets.darwin;
    if (globalThis.process.platform === 'win32' && globalThis.process.arch === 'x64') return assets.win32;
    throw new Error('Automatic setup supports macOS Apple silicon and Windows x64 only.');
  }
  async function exists(path: string) {
    try { await access(path); return true; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async function extract(archive: string, target: string) {
    const mac = globalThis.process.platform === 'darwin';
    const systemRoot = globalThis.process.env.SystemRoot;
    const command = mac ? '/usr/bin/ditto'
      : systemRoot && join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!command) throw new Error('Windows system directory is unavailable.');
    const args = mac ? ['-x', '-k', archive, target] : [
      '-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:OPSDECK_ARCHIVE -DestinationPath $env:OPSDECK_DESTINATION',
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: 'ignore', windowsHide: true,
        env: { ...globalThis.process.env, OPSDECK_ARCHIVE: archive, OPSDECK_DESTINATION: target },
      });
      extractor = child;
      child.once('error', reject);
      child.once('exit', code => {
        if (extractor === child) extractor = undefined;
        if (code === 0) resolve();
        else reject(new Error('Could not extract Ollama. Check your available disk space and permissions.'));
      });
    });
  }
  async function install() {
    const asset = supported();
    const binary = join(installation, asset.binary);
    if (await exists(binary)) return binary;
    await mkdir(root, { recursive: true });
    const temp = await mkdtemp(join(root, 'setup-'));
    try {
      const archive = join(temp, asset.name);
      set('downloading', 'Downloading the official Ollama runtime…');
      const response = await fetch(`https://github.com/ollama/ollama/releases/download/${release}/${asset.name}`, {
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30 * 60_000)]),
      });
      if (!response.ok || !response.body) throw new Error(`Ollama download failed (HTTP ${response.status}).`);
      const length = Number(response.headers.get('content-length'));
      const hash = createHash('sha256');
      let received = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > 2_500_000_000) return callback(new Error('Ollama download exceeded the size limit.'));
          hash.update(chunk);
          set('downloading', 'Downloading the official Ollama runtime…', { progress: length > 0 ? received / length : undefined });
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, createWriteStream(archive, { flags: 'wx' }));
      if (hash.digest('hex') !== asset.sha256) throw new Error('Ollama download checksum did not match. Nothing was installed.');
      set('extracting', 'Extracting the verified runtime…');
      const extracted = join(temp, 'runtime');
      await mkdir(extracted);
      await extract(archive, extracted);
      if (shuttingDown) throw new Error('OpsDeck is closing.');
      if (!await exists(join(extracted, asset.binary))) throw new Error('The downloaded Ollama archive did not contain the expected executable.');
      await rename(extracted, installation);
      return binary;
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  async function freePort() {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not reserve a local port for Ollama.');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return address.port;
  }
  async function start(binary: string) {
    if (process && origin && process.exitCode === null && process.signalCode === null) return;
    set('starting', 'Starting the local-only Ollama service…');
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    await mkdir(join(root, 'models'), { recursive: true });
    const child = spawn(binary, ['serve'], {
      stdio: 'ignore', windowsHide: true,
      env: { ...globalThis.process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: join(root, 'models'), OLLAMA_NO_CLOUD: '1' },
    });
    process = child;
    let failure = '';
    child.once('error', error => { failure = error.message; });
    child.once('exit', () => {
      if (process === child) {
        process = undefined;
        origin = '';
        if (!shuttingDown) set('error', 'The local Ollama service stopped unexpectedly.');
      }
    });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`Could not start Ollama${failure ? `: ${failure}` : '.'}`);
      try {
        const response = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch (error) {
        if (!(error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError'))) throw error;
      }
      await delay(250);
    }
    child.kill();
    throw new Error('Ollama did not start in time. Check macOS or Windows security restrictions.');
  }
  async function pull(model: OllamaModel) {
    const installed = await fetch(`${origin}/api/tags`, { signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]) });
    if (!installed.ok) throw new Error(`Could not check installed models (HTTP ${installed.status}).`);
    const listing: unknown = await installed.json();
    if (!listing || typeof listing !== 'object' || !('models' in listing) || !Array.isArray(listing.models)) {
      throw new Error('Ollama returned an invalid model list.');
    }
    if (listing.models.some(item => item && typeof item === 'object' && 'name' in item && item.name === model)) return;
    set('pulling', `Downloading ${model}…`, { model });
    const response = await fetch(`${origin}/api/pull`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }), signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(2 * 60 * 60_000)]),
    });
    if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status}).`);
    const decoder = new TextDecoder();
    let pending = '';
    let success = false;
    for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 100_000) throw new Error('Invalid model download response.');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const progress: { status?: string; error?: string; total?: number; completed?: number } = JSON.parse(line);
        if (progress.error) throw new Error(`Model download failed: ${progress.error}`);
        if (progress.status === 'success') success = true;
        set('pulling', progress.status ?? `Downloading ${model}…`, {
          model, progress: progress.total && progress.completed !== undefined ? progress.completed / progress.total : undefined,
        });
      }
    }
    if (!success) throw new Error('The model download ended before completion.');
  }
  async function setup(model: unknown) {
    const selected = ollamaModels.find(option => option === model);
    if (!selected) throw new Error('Choose a supported local model.');
    if (running) throw new Error('Ollama setup is already running.');
    running = true;
    try {
      const binary = await install();
      if (shuttingDown) throw new Error('OpsDeck is closing.');
      await start(binary);
      if (shuttingDown) throw new Error('OpsDeck is closing.');
      await pull(selected);
      set('starting', `Checking context support for ${selected}…`, { model: selected });
      const contextLimit = await fetchModelContextLimit(origin, selected, AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]));
      set('ready', `Ready: ${selected}`, { model: selected, contextLimit });
    } catch (error) {
      set('error', error instanceof Error ? error.message : 'Ollama setup failed.');
      throw error;
    } finally { running = false; }
  }
  return {
    status: () => state,
    setup,
    origin: () => {
      if (state.phase !== 'ready' || !origin || !state.model) throw new Error('Set up a local model first.');
      return { origin, model: state.model };
    },
    close() { shuttingDown = true; shutdown.abort(); extractor?.kill(); process?.kill(); },
  };
}
