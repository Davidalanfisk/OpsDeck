import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createOllama } from '../desktop/ollama.ts';

test('setup starts a loopback-only runtime and reuses an installed model', { timeout: 15_000, skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-ollama-'));
  const binary = join(dir, 'ollama', 'v0.40.17', 'Ollama.app', 'Contents', 'Resources', 'ollama');
  mkdirSync(join(dir, 'ollama', 'v0.40.17', 'Ollama.app', 'Contents', 'Resources'), { recursive: true });
  writeFileSync(binary, `#!/usr/bin/env node
const http = require('node:http');
let pulls = 0;
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/version') return response.end('{"version":"fixture"}');
  if (request.url === '/api/tags') return response.end('{"models":[{"name":"qwen3:4b"}]}');
  if (request.url === '/api/pull') { pulls++; return response.end('{"status":"success"}\\n'); }
  if (request.url === '/env') return response.end(JSON.stringify({ cloud: process.env.OLLAMA_NO_CLOUD, models: process.env.OLLAMA_MODELS, pulls }));
  response.writeHead(404).end();
});
const port = Number(process.env.OLLAMA_HOST.split(':').pop());
server.listen(port, '127.0.0.1');
`);
  chmodSync(binary, 0o755);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const arch = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  const ollama = createOllama(dir);
  t.after(() => {
    ollama.close();
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(() => ollama.setup('not-a-model'), /supported local model/);
  await ollama.setup('qwen3:4b');
  assert.equal(ollama.status().phase, 'ready');
  const { origin, model } = ollama.origin();
  assert.equal(model, 'qwen3:4b');
  const env = await (await fetch(`${origin}/env`)).json();
  assert.equal(env.cloud, '1');
  assert.equal(env.models, join(dir, 'ollama', 'models'));
  assert.equal(env.pulls, 0);
  await ollama.setup('qwen3:8b');
  assert.equal(ollama.status().model, 'qwen3:8b');
  assert.equal((await (await fetch(`${origin}/env`)).json()).pulls, 1);
  ollama.close();
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(200) }); }
    catch { return; }
    await delay(50);
  }
  assert.fail('The owned Ollama process did not stop');
});

test('setup reports failed downloads and checksum mismatches without installing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-ollama-failure-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const arch = Object.getOwnPropertyDescriptor(process, 'arch');
  const originalFetch = globalThis.fetch;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  t.after(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
    rmSync(dir, { recursive: true, force: true });
  });
  const ollama = createOllama(dir);
  t.after(() => ollama.close());

  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(() => ollama.setup('qwen3:4b'), /download failed \(HTTP 503\)/);
  assert.equal(ollama.status().phase, 'error');
  assert.deepEqual(readdirSync(join(dir, 'ollama')), []);

  globalThis.fetch = async () => new Response('invalid archive');
  await assert.rejects(() => ollama.setup('qwen3:4b'), /checksum did not match/);
  assert.equal(ollama.status().phase, 'error');
  assert.deepEqual(readdirSync(join(dir, 'ollama')), []);
});
