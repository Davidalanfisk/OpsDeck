import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createOllama, fetchModelContextLimit, modelContextLimit } from '../desktop/ollama.ts';

test('model context limit requires valid metadata and handles model architectures', () => {
  assert.equal(modelContextLimit({ model_info: { 'qwen3moe.context_length': 40960 } }), 40960);
  assert.equal(modelContextLimit({ model_info: { 'qwen3.context_length': 131072, 'other.context_length': 65536 } }), 65536);
  assert.throws(() => modelContextLimit({ model_info: {} }), /context limit/);
  assert.throws(() => modelContextLimit({ model_info: { 'qwen3.context_length': 4096 } }), /context limit/);
});

test('model context metadata request uses the selected model and reports failures', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:1234/api/show');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { model: 'qwen3:30b-a3b' });
    return Response.json({ model_info: { 'qwen3moe.context_length': 40960 } });
  };
  assert.equal(await fetchModelContextLimit('http://127.0.0.1:1234', 'qwen3:30b-a3b', AbortSignal.timeout(1000)), 40960);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(fetchModelContextLimit('http://127.0.0.1:1234', 'qwen3:30b-a3b', AbortSignal.timeout(1000)), /HTTP 503/);
});

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
  if (request.url === '/api/show') return response.end('{"model_info":{"qwen3.context_length":40960}}');
  if (request.url === '/api/pull') {
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => { pulls++; server.lastModel = JSON.parse(body).model; response.end('{"status":"success"}\\n'); });
    return;
  }
  if (request.url === '/env') return response.end(JSON.stringify({ cloud: process.env.OLLAMA_NO_CLOUD, models: process.env.OLLAMA_MODELS, pulls, lastModel: server.lastModel }));
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
  assert.equal(ollama.status().contextLimit, 40960);
  const { origin, model } = ollama.origin();
  assert.equal(model, 'qwen3:4b');
  const env = await (await fetch(`${origin}/env`)).json();
  assert.equal(env.cloud, '1');
  assert.equal(env.models, join(dir, 'ollama', 'models'));
  assert.equal(env.pulls, 0);
  await ollama.setup('qwen3:8b');
  assert.equal(ollama.status().model, 'qwen3:8b');
  assert.equal((await (await fetch(`${origin}/env`)).json()).pulls, 1);
  await ollama.setup('qwen3:30b-a3b');
  assert.equal(ollama.status().model, 'qwen3:30b-a3b');
  assert.equal((await (await fetch(`${origin}/env`)).json()).lastModel, 'qwen3:30b-a3b');
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
