import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fileCreate, fileRead, fileWrite, registerAgentFiles, registerAgentTerminal, terminalRead, terminalSend,
} from '../src/agent-sessions.ts';

test('agent terminal access is scoped to a registered session and single-line commands', () => {
  const sent = [];
  const unregister = registerAgentTerminal('fixture', { read: () => 'fixture output', send: command => sent.push(command) });
  assert.equal(terminalRead('fixture'), 'fixture output');
  terminalSend('fixture', 'pwd');
  assert.deepEqual(sent, ['pwd']);
  assert.throws(() => terminalSend('fixture', 'pwd\nrm anything'), /single line/);
  assert.throws(() => terminalRead('other'), /connect/);
  unregister();
  assert.throws(() => terminalSend('fixture', 'pwd'), /connect/);
});

test('agent file actions protect open drafts and use the existing revision-aware API', async t => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, method: options.method, body: JSON.parse(options.body) });
    if (path.endsWith('/read')) return Response.json({ path: '/test.txt', content: 'old', revision: 'a'.repeat(64) });
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = original; });
  const unregister = registerAgentFiles('fixture', { session: 'local-session', openPaths: new Set(['/open.txt']) });
  t.after(unregister);
  const file = await fileRead('fixture', '/test.txt');
  await assert.rejects(() => fileWrite('fixture', '/open.txt', 'draft', file.revision), /Close this file/);
  await fileWrite('fixture', '/test.txt', 'updated', file.revision);
  await fileCreate('fixture', '/new.txt', 'new é');
  assert.equal(calls[1].path, '/api/files/local-session/save');
  assert.deepEqual(calls[1].body, { path: '/test.txt', content: 'updated', revision: 'a'.repeat(64) });
  assert.equal(Buffer.from(calls[2].body.data, 'base64').toString(), 'new é');
  assert.throws(() => terminalRead('fixture'), /connect/);
});
