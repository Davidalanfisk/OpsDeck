import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOpsDeckServer } from '../server/app.ts';
import { openDb } from '../server/db.ts';
import { loadAgentConversations, saveAgentConversation } from '../src/agent-storage.ts';

const chat = (id = randomUUID()) => ({
  id, title: 'Private chat', updatedAt: 123,
  messages: [{ role: 'user', content: 'hello' }],
  history: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hello' }],
});

test('conversation API persists large histories, isolates clients and rejects stale writes', async t => {
  const dir = join(process.cwd(), `.agent-storage-test-${randomUUID()}`);
  mkdirSync(dir);
  const { server, db } = createOpsDeckServer({ directory: dir, frontend: dir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
  async function call(path, method = 'GET', body) {
    const response = await fetch(`${origin}/api${path}`, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: response.status === 204 ? undefined : await response.json() };
  }
  const client = (await call('/clients', 'POST', { name: 'One', description: '', colour: '#123456' })).data;
  const other = (await call('/clients', 'POST', { name: 'Two', description: '', colour: '#123456' })).data;
  const memoryPath = `/clients/${client.id}/agent-memory`;
  assert.deepEqual((await call(memoryPath)).data, { content: '', version: 0 });
  assert.deepEqual((await call(memoryPath, 'PUT', { content: 'Pinned fact', expectedVersion: 0 })).data, { version: 1 });
  assert.equal((await call(memoryPath, 'PUT', { content: 'stale', expectedVersion: 0 })).status, 409);
  assert.deepEqual((await call(`/clients/${other.id}/agent-memory`)).data, { content: '', version: 0 });
  assert.deepEqual((await call(memoryPath)).data, { content: 'Pinned fact', version: 1 });
  const item = chat();
  item.messages.push({ role: 'tool', content: 'x'.repeat(2_100_000) });
  item.summary = { content: 'Saved separately from the transcript', through: 2 };
  const path = `/clients/${client.id}/agent-conversations/${item.id}`;
  assert.deepEqual((await call(path, 'PUT', { conversation: item, expectedVersion: 0 })).data, { version: 1 });
  assert.equal((await call(path, 'PUT', { conversation: item, expectedVersion: 0 })).status, 409);
  assert.equal((await call(`/clients/${other.id}/agent-conversations`)).data.length, 0);
  assert.equal((await call(`/clients/${other.id}/agent-conversations/${item.id}`, 'PUT', { conversation: item, expectedVersion: 1 })).status, 409);
  assert.equal((await call(path, 'PUT', { conversation: { ...item, id: randomUUID() }, expectedVersion: 1 })).status, 400);
  const reopened = openDb(dir);
  try { assert.equal(JSON.parse(reopened.prepare('SELECT conversation_json FROM agent_conversations WHERE client_id = ? AND id = ?').get(client.id, item.id).conversation_json).messages[1].content.length, 2_100_000); }
  finally { reopened.close(); }
  assert.equal((await call(path, 'PUT', { conversation: { ...item, title: 'Updated' }, expectedVersion: 1 })).data.version, 2);
  assert.equal((await call(path, 'PUT', { conversation: item, expectedVersion: 1 })).status, 409);
  assert.equal((await call(`/clients/${client.id}/agent-conversations`)).data[0].conversation.title, 'Updated');
  assert.equal((await call(`/clients/${client.id}/agent-conversations`)).data[0].conversation.summary.content, item.summary.content);
  await call(`/clients/${client.id}`, 'DELETE');
  assert.equal(db.prepare('SELECT count(*) AS total FROM agent_conversations').get().total, 0);
  assert.equal(db.prepare('SELECT count(*) AS total FROM agent_memory').get().total, 0);
});

test('legacy chats migrate without erasing data on failure or conflicting copies', async t => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key) };
  const client = randomUUID();
  const first = chat();
  const second = chat();
  const key = `opsdeck:agent-conversations:${client}`;
  values.set(key, JSON.stringify([first, second]));
  const saved = new Map();
  let fail = true;
  globalThis.fetch = async (path, options) => {
    if (options.method === 'GET') return Response.json([...saved.values()]);
    const body = JSON.parse(options.body);
    if (body.conversation.id === second.id && fail) return Response.json({ error: 'disk full' }, { status: 500 });
    const existing = saved.get(body.conversation.id);
    if ((existing?.version ?? 0) !== body.expectedVersion) return Response.json({ error: 'conflict' }, { status: 409 });
    const item = { conversation: body.conversation, version: body.expectedVersion + 1 };
    saved.set(body.conversation.id, item);
    return Response.json({ version: item.version });
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; });
  await assert.rejects(loadAgentConversations(client), /disk full/);
  assert.ok(values.has(key));
  fail = false;
  assert.equal((await loadAgentConversations(client)).length, 2);
  assert.equal(values.has(key), false);
  assert.equal(await saveAgentConversation(client, { ...first, title: 'changed' }, 1), 2);
  values.set(key, JSON.stringify([first]));
  await assert.rejects(loadAgentConversations(client), /differs/);
  assert.ok(values.has(key));
});
