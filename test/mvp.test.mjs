import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import ssh2 from 'ssh2';
import { WebSocket } from 'ws';
import { api } from '../server/api.ts';
import { openDb } from '../server/db.ts';
import { attachSsh } from '../server/ssh.ts';

const { Server: SshServer, utils } = ssh2;

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-test-'));
  const db = openDb(dir);
  const app = express();
  app.use('/api', express.json(), api(db));
  const server = createServer(app);
  attachSsh(server, db, (origin, host) => origin === `http://${host}`);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (path, method = 'GET', data) => {
    const response = await fetch(`${origin}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: response.status === 204 ? undefined : await response.json() };
  };
  const createClient = async name => (await call('/clients', 'POST', { name, description: '', colour: '#9876ff' })).data;
  return { origin, call, createClient, dir };
}

test('named layout and latest session persist independently and stay scoped to the client', async t => {
  const { call, createClient, dir } = await fixture(t);
  const client = await createClient('Client Alpha');
  const other = await createClient('Client Beta');
  const base = `/clients/${client.id}`;
  const { data: deck } = await call(base);
  assert.equal(deck.workspaces[0].name, 'Main workspace');
  const { data: note } = await call(`${base}/notes`, 'POST', { title: 'Runbook', content: '# First step' });
  const { data: named } = await call(`${base}/workspaces`, 'POST', { name: 'Incident response' });
  const path = `${base}/workspaces/${named.id}`;
  const layout = { grid: { root: { type: 'branch', data: [] } }, panels: {} };
  const session = { ...layout, activeGroup: '2', panels: { runbook: { id: 'runbook', params: { itemId: note.id } } } };
  assert.equal((await call(path, 'PUT', layout)).status, 200);
  assert.equal((await call(`${path}/session`, 'PUT', session)).status, 204);
  const persisted = openDb(dir);
  try {
    assert.deepEqual(JSON.parse(persisted.prepare('SELECT layout_json FROM workspaces WHERE id = ?').get(named.id).layout_json), layout);
    assert.deepEqual(JSON.parse(persisted.prepare('SELECT session_json FROM sessions WHERE workspace_id = ?').get(named.id).session_json), session);
  } finally { persisted.close(); }
  assert.deepEqual((await call(`${path}/session`)).data, session);
  assert.equal((await call(`/clients/${other.id}/workspaces/${named.id}/session`)).status, 404);
  assert.equal((await call(`/clients/${other.id}/notes/${note.id}`, 'PUT', { title: 'Test', content: '' })).status, 404);
  assert.equal((await call(base, 'DELETE')).status, 204);
  const reopened = openDb(dir);
  try { assert.equal(reopened.prepare('SELECT count(*) AS total FROM sessions').get().total, 0); }
  finally { reopened.close(); }
});

test('WebSocket opens a password-authenticated SSH PTY, sends input and resizes', { timeout: 15_000 }, async t => {
  const { origin, call, createClient } = await fixture(t);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const fingerprint = `SHA256:${createHash('sha256').update(utils.parseKey(privateKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  let resize;
  const resized = new Promise(resolve => { resize = resolve; });
  let sshClient;
  const sshServer = new SshServer({ hostKeys: [privateKey] }, client => {
    sshClient = client;
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'operator' && context.password === 'fixture-password') context.accept();
      else context.reject(['password']);
    });
    client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty());
      session.on('shell', acceptShell => {
        const stream = acceptShell();
        stream.on('data', data => stream.write(data));
      });
      session.on('window-change', (acceptResize, _reject, size) => { acceptResize?.(); resize(size); });
    });
  });
  sshServer.listen(0, '127.0.0.1');
  await once(sshServer, 'listening');
  const client = await createClient('SSH client');
  const { data: connection } = await call(`/clients/${client.id}/connections`, 'POST', {
    name: 'Fixture PTY', type: 'SSH', host: '127.0.0.1', port: sshServer.address().port, username: 'operator', fingerprint,
  });
  assert.equal('password' in connection, false);
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ssh/${client.id}/${connection.id}`, { origin });
  try {
    const ready = once(socket, 'message', { signal: AbortSignal.timeout(8000) });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'connect', password: 'fixture-password', cols: 80, rows: 24 }));
    assert.equal(JSON.parse((await ready)[0].toString()).state, 'connected');
    const echoed = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({ type: 'input', data: 'hello from OpsDeck\r' }));
    const [data, binary] = await echoed;
    assert.equal(binary, true);
    assert.equal(data.toString(), 'hello from OpsDeck\r');
    socket.send(JSON.stringify({ type: 'resize', cols: 110, rows: 42 }));
    const size = await Promise.race([resized, new Promise((_, reject) => {
      setTimeout(() => reject(new Error('PTY resize did not arrive')), 3000).unref();
    })]);
    assert.equal(size.cols, 110);
    assert.equal(size.rows, 42);
  } finally {
    socket.terminate();
    sshClient?.end();
    await new Promise(resolve => sshServer.close(resolve));
  }
});
