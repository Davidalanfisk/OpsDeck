import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import express from 'express';
import ssh2 from 'ssh2';
import { WebSocket } from 'ws';
import { api } from '../server/api.ts';
import { openDb } from '../server/db.ts';
import { attachSsh } from '../server/ssh.ts';

const { Server: SshServer, utils } = ssh2;

function fingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

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

test('note updates can reject stale revisions without changing existing update behavior', async t => {
  const { call, createClient, dir } = await fixture(t);
  const client = await createClient('Notes fixture');
  const base = `/clients/${client.id}/notes`;
  const { data: note } = await call(base, 'POST', { title: 'Runbook', content: 'original' });
  const stale = await call(`${base}/${note.id}`, 'PUT', { title: note.title, content: 'stale edit', if_updated_at: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal((await call(`/clients/${client.id}`)).data.notes[0].content, 'original');
  const db = openDb(dir);
  try { db.prepare('UPDATE notes SET content = ? WHERE id = ?').run('changed with same timestamp', note.id); }
  finally { db.close(); }
  assert.equal((await call(`${base}/${note.id}`, 'PUT', { title: note.title, content: 'stale edit', if_updated_at: note.updated_at, if_content: 'original', if_title: note.title })).status, 409);
  assert.equal((await call(`${base}/${note.id}`, 'PUT', { title: note.title, content: 'safe edit', if_updated_at: note.updated_at, if_content: 'changed with same timestamp', if_title: note.title })).status, 200);
  assert.equal((await call(`${base}/${note.id}`, 'PUT', { title: note.title, content: 'regular edit' })).status, 200);
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
    client.on('error', () => {});
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
  assert.equal(connection.auth_method, 'password');
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
    async function failure(id, password) {
      const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ssh/${client.id}/${id}`, { origin });
      try {
        await once(ws, 'open');
        const reply = once(ws, 'message', { signal: AbortSignal.timeout(8000) });
        ws.send(JSON.stringify({ type: 'connect', password, cols: 80, rows: 24 }));
        return JSON.parse((await reply)[0].toString()).detail;
      } finally { ws.terminate(); }
    }
    assert.match(await failure(connection.id, 'incorrect-password'), /authentication failed/i);
    const badHost = (await call(`/clients/${client.id}/connections`, 'POST', {
      name: 'Incorrect host key', type: 'SSH', host: '127.0.0.1', port: sshServer.address().port,
      username: 'operator', fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })).data;
    assert.match(await failure(badHost.id, 'fixture-password'), /host key did not match/i);
  } finally {
    socket.terminate();
    sshClient?.end();
    await new Promise(resolve => sshServer.close(resolve));
  }
});

test('existing database connections migrate to password authentication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-migrate-'));
  try {
    const old = new DatabaseSync(join(dir, 'opsdeck.sqlite'));
    old.exec(`CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, colour TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE connections (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, type TEXT NOT NULL, url TEXT, host TEXT, port INTEGER, username TEXT, fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      INSERT INTO clients VALUES ('client', 'Client', '', '#000000', 'now', 'now');
      INSERT INTO connections VALUES ('connection', 'client', 'SSH', 'SSH', NULL, 'localhost', 22, 'operator', 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'now', 'now');`);
    old.close();
    const db = openDb(dir);
    try {
      assert.deepEqual({ ...db.prepare('SELECT auth_method, agent_fingerprint FROM connections').get() }, { auth_method: 'password', agent_fingerprint: null });
    } finally { db.close(); }
    const reopened = openDb(dir);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SSH agent uses only the selected identity and retains host key verification', { timeout: 30_000 }, async t => {
  const { origin, call, createClient, dir } = await fixture(t);
  const previousSocket = process.env.SSH_AUTH_SOCK;
  const socketPath = join(dir, 'agent.sock');
  const agent = spawn('ssh-agent', ['-D', '-a', socketPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let sshServer;
  const clients = new Set();
  const sockets = new Set();
  try {
    await Promise.race([
      once(agent.stdout, 'data'),
      once(agent, 'exit').then(() => { throw new Error('Fixture SSH agent exited'); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture SSH agent timed out')), 5000).unref()),
    ]);
    process.env.SSH_AUTH_SOCK = socketPath;
    const makeKey = name => {
      const path = join(dir, name);
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], { stdio: 'pipe' });
      execFileSync('ssh-add', [path], { env: { ...process.env, SSH_AUTH_SOCK: socketPath }, stdio: 'pipe' });
      return utils.parseKey(readFileSync(`${path}.pub`));
    };
    const selected = makeKey('selected-key');
    const other = makeKey('other-key');
    const selectedFingerprint = fingerprint(selected.getPublicSSH());
    const otherFingerprint = fingerprint(other.getPublicSSH());
    const { data: listed } = await call('/ssh-agent/identities');
    assert.deepEqual(listed.map(key => key.fingerprint).sort(), [selectedFingerprint, otherFingerprint].sort());
    assert.deepEqual(Object.keys(listed[0]).sort(), ['fingerprint', 'type']);

    const { privateKey: hostKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
    const hostFingerprint = fingerprint(utils.parseKey(hostKey).getPublicSSH());
    const offered = [];
    sshServer = new SshServer({ hostKeys: [hostKey] }, client => {
      clients.add(client);
      client.on('error', () => {});
      client.on('close', () => clients.delete(client));
      client.on('authentication', context => {
        if (context.method !== 'publickey' || context.username !== 'operator') { context.reject(['publickey']); return; }
        offered.push(fingerprint(context.key.data));
        if (!context.key.data.equals(selected.getPublicSSH())) { context.reject(['publickey']); return; }
        if (!context.signature || selected.verify(context.blob, context.signature, context.hashAlgo)) context.accept();
        else context.reject(['publickey']);
      });
      client.on('session', accept => {
        const session = accept();
        session.on('pty', acceptPty => acceptPty());
        session.on('shell', acceptShell => {
          const stream = acceptShell();
          stream.on('data', data => stream.write(data));
        });
      });
    });
    sshServer.listen(0, '127.0.0.1');
    await once(sshServer, 'listening');
    const client = await createClient('Agent fixture');
    const base = `/clients/${client.id}/connections`;
    const settings = { name: 'Agent SSH', type: 'SSH', host: '127.0.0.1', port: sshServer.address().port, username: 'operator',
      fingerprint: hostFingerprint, auth_method: 'agent', agent_fingerprint: selectedFingerprint };
    const { data: connection } = await call(base, 'POST', settings);
    assert.equal(connection.agent_fingerprint, selectedFingerprint);
    assert.equal(connection.fingerprint, hostFingerprint);
    assert.equal((await call(`/clients/${client.id}`)).data.connections[0].agent_fingerprint, selectedFingerprint);
    const updated = (await call(`${base}/${connection.id}`, 'PUT', { ...settings, agent_fingerprint: otherFingerprint })).data;
    assert.equal(updated.agent_fingerprint, otherFingerprint);
    assert.equal((await call(`${base}/${connection.id}`, 'PUT', settings)).data.agent_fingerprint, selectedFingerprint);
    const persisted = openDb(dir);
    try {
      const row = persisted.prepare('SELECT * FROM connections WHERE id = ?').get(connection.id);
      assert.equal(row.agent_fingerprint, selectedFingerprint);
      assert.equal(JSON.stringify(row).includes('PRIVATE KEY'), false);
      assert.equal('password' in row, false);
    } finally { persisted.close(); }
    async function connect(id) {
      const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ssh/${client.id}/${id}`, { origin });
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      await once(ws, 'open');
      const reply = once(ws, 'message', { signal: AbortSignal.timeout(8000) });
      ws.send(JSON.stringify({ type: 'connect', cols: 80, rows: 24 }));
      return { ws, result: JSON.parse((await reply)[0].toString()) };
    }
    let response = await connect(connection.id);
    assert.equal(response.result.state, 'connected');
    const echo = once(response.ws, 'message', { signal: AbortSignal.timeout(3000) });
    response.ws.send(JSON.stringify({ type: 'input', data: 'agent terminal\r' }));
    assert.equal((await echo)[0].toString(), 'agent terminal\r');
    response.ws.terminate();
    assert.ok(offered.length > 0);
    assert.ok(offered.every(key => key === selectedFingerprint));

    const denied = (await call(base, 'POST', { ...settings, agent_fingerprint: otherFingerprint })).data;
    offered.length = 0;
    response = await connect(denied.id);
    assert.match(response.result.detail, /authentication failed/i);
    response.ws.terminate();
    assert.ok(offered.length > 0);
    assert.ok(offered.every(key => key === otherFingerprint));

    const badHost = (await call(base, 'POST', { ...settings, fingerprint: otherFingerprint })).data;
    offered.length = 0;
    response = await connect(badHost.id);
    assert.match(response.result.detail, /host key did not match/i);
    response.ws.terminate();
    assert.equal(offered.length, 0);

    execFileSync('ssh-add', ['-D'], { env: { ...process.env, SSH_AUTH_SOCK: socketPath }, stdio: 'pipe' });
    response = await connect(connection.id);
    assert.match(response.result.detail, /identity is missing/i);
    response.ws.terminate();
    process.env.SSH_AUTH_SOCK = join(dir, 'missing.sock');
    assert.equal((await call('/ssh-agent/identities')).status, 503);
    response = await connect(connection.id);
    assert.match(response.result.detail, /agent unavailable/i);
    response.ws.terminate();
  } finally {
    if (previousSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previousSocket;
    for (const ws of sockets) ws.terminate();
    for (const client of clients) client.destroy();
    if (sshServer?.address()) await new Promise(resolve => sshServer.close(resolve));
    if (agent.exitCode === null && agent.signalCode === null) {
      const exited = once(agent, 'exit');
      agent.kill('SIGTERM');
      await exited;
    }
  }
});
