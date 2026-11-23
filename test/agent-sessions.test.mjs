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

test('agent file actions update open drafts only when their snapshot still matches', async t => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, method: options.method, body: JSON.parse(options.body) });
    if (path.endsWith('/read')) return Response.json({ path: '/test.txt', content: 'old', revision: 'a'.repeat(64) });
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = original; });
  let draft = { content: 'unsaved edit', revision: 'b'.repeat(64) };
  const unregister = registerAgentFiles('fixture', {
    session: 'local-session',
    readOpen: path => path === '/open.txt' ? draft : undefined,
    applyOpen: (_path, expected, content) => {
      if (draft.content !== expected.content || draft.revision !== expected.revision) throw new Error('conflict');
      draft = { ...draft, content };
    },
  });
  t.after(unregister);
  const file = await fileRead('fixture', '/test.txt');
  const open = await fileRead('fixture', '/other/../open.txt');
  assert.equal(open.content, 'unsaved edit');
  await fileWrite('fixture', '/open.txt', 'agent edit', open.revision, open);
  assert.equal(draft.content, 'agent edit');
  await assert.rejects(() => fileWrite('fixture', '/open.txt', 'overwrite', open.revision, open), /conflict/);
  await assert.rejects(() => fileWrite('fixture', '/open.txt', 'overwrite', file.revision, file), /editor state changed/);
  await fileWrite('fixture', '/test.txt', 'updated', file.revision);
  await fileCreate('fixture', '/new.txt', 'new é');
  assert.equal(calls[1].path, '/api/files/local-session/save');
  assert.deepEqual(calls[1].body, { path: '/test.txt', content: 'updated', revision: 'a'.repeat(64) });
  assert.equal(Buffer.from(calls[2].body.data, 'base64').toString(), 'new é');
  assert.throws(() => terminalRead('fixture'), /connect/);
});
