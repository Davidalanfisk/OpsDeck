import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { createOpsDeckServer } from '../server/app.ts';
import { maxTextBytes, maxTransferBytes } from '../shared/files.ts';
import { ftpFixture, sftpFixture, text } from './fixtures/remote.mjs';
import ssh2 from 'ssh2';

async function apiFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opsdeck-files-'));
  const { server, db } = createOpsDeckServer({ directory: dir, frontend: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'POST', body) => {
    const response = await fetch(`${origin}/api${path}`, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: response.status === 204 ? undefined : await response.json() };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const client = (await call('/clients', 'POST', { name: 'File fixture', description: '', colour: '#9876ff' })).data;
  return { call, db, dir, origin, client };
}

for (const protocol of ['FTP', 'FTPS', 'FTPS implicit', 'SFTP']) {
  test(`${protocol} lists, edits UTF-8 safely, detects conflicts and transfers files`, { timeout: 30_000 }, async t => {
    const api = await apiFixture(t);
    let tls;
    if (protocol.startsWith('FTPS')) {
      const key = join(api.dir, 'fixture.key'), cert = join(api.dir, 'fixture.crt');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
      tls = { key: readFileSync(key), cert: readFileSync(cert), implicit: protocol === 'FTPS implicit' };
    }
    const remote = protocol === 'SFTP' ? await sftpFixture(t) : await ftpFixture(t, tls);
    const connection = (await api.call(`/clients/${api.client.id}/connections`, 'POST', remote.connection)).data;
    assert.equal(connection.type, protocol.startsWith('FTPS') ? 'FTPS' : protocol);
    assert.equal('password' in api.db.prepare('SELECT * FROM connections').get(), false);
    const input = { clientId: api.client.id, connectionId: connection.id, password: 'fixture-password', allowInsecure: true };
    if (protocol === 'FTP') {
      assert.equal((await api.call('/files/connect', 'POST', { ...input, allowInsecure: undefined })).status, 400);
    }
    assert.equal((await api.call('/files/connect', 'POST', { ...input, password: 'bad-password' })).status, 502);
    if (tls) {
      const untrusted = await api.call('/files/connect', 'POST', input);
      assert.equal(untrusted.status, 502); assert.match(untrusted.data.error, /certificate/i);
      const previous = getCACertificates('default');
      setDefaultCACertificates([...previous, tls.cert.toString()]);
      t.after(() => setDefaultCACertificates(previous));
      const badAuth = await api.call('/files/connect', 'POST', { ...input, password: 'bad-password' });
      assert.equal(badAuth.status, 502); assert.match(badAuth.data.error, /authentication failed/i);
    }
    const connected = await api.call('/files/connect', 'POST', input);
    assert.equal(connected.status, 200, JSON.stringify(connected.data));
    const base = `/files/${connected.data.session}`;
    assert.equal((await api.call(`${base}/list`, 'POST', { path: '/' })).data.entries.length, 2);
    const opened = await api.call(`${base}/read`, 'POST', { path: '/fixture.php' });
    assert.equal(opened.data.content, text.toString());
    const content = text.toString().replace('hello', 'saved');
    const saved = await api.call(`${base}/save`, 'PUT', { ...opened.data, content });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(remote.files.get('/fixture.php').toString(), content);
    if (remote.modes) assert.equal(remote.modes.get('/fixture.php') & 0o777, 0o640);
    remote.files.set('/fixture.php', Buffer.from('someone else'));
    assert.equal((await api.call(`${base}/save`, 'PUT', { path: '/fixture.php', revision: saved.data.revision, content: 'my edit' })).status, 409);
    assert.equal(remote.files.get('/fixture.php').toString(), 'someone else');
    assert.equal((await api.call(`${base}/read`, 'POST', { path: '/binary.bin' })).status, 400);
    assert.equal((await api.call(`${base}/read`, 'POST', { path: '/fixture.php\r\nDELE /fixture.php' })).status, 400);
    const bytes = Buffer.from([0, 1, 2, 255]);
    assert.equal((await api.call(`${base}/upload`, 'POST', { path: '/new.bin', data: bytes.toString('base64') })).status, 204);
    assert.equal((await api.call(`${base}/upload`, 'POST', { path: '/new.bin', data: bytes.toString('base64') })).status, 409);
    assert.deepEqual(Buffer.from((await api.call(`${base}/download`, 'POST', { path: '/new.bin' })).data.data, 'base64'), bytes);
    remote.files.set('/too-big.txt', Buffer.alloc(maxTextBytes + 1, 'a'));
    assert.equal((await api.call(`${base}/read`, 'POST', { path: '/too-big.txt' })).status, 413);
    remote.files.set('/too-big.bin', Buffer.alloc(maxTransferBytes + 1));
    assert.equal((await api.call(`${base}/download`, 'POST', { path: '/too-big.bin' })).status, 413);
    const unauthorized = await fetch(`${api.origin}/api${base}/save`, { method: 'PUT',
      headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/fixture.php', revision: saved.data.revision, content: 'bad' }) });
    assert.equal(unauthorized.status, 403);
    assert.equal((await api.call(`/clients/${api.client.id}/connections/${connection.id}`, 'DELETE')).status, 204);
    assert.equal((await api.call(`${base}/list`, 'POST', { path: '/' })).status, 410);
    assert.ok([...remote.files.keys()].every(path => !path.startsWith('/.opsdeck-')));
  });

}

test('SFTP uses the selected agent identity and reports missing or unavailable agents', { timeout: 20_000 }, async t => {
    const api = await apiFixture(t);
    const socketPath = join(api.dir, 'agent.sock');
    const previous = process.env.SSH_AUTH_SOCK;
    const agent = spawn('ssh-agent', ['-D', '-a', socketPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => {
      if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previous;
      if (agent.exitCode === null && agent.signalCode === null) {
        const exited = once(agent, 'exit'); agent.kill('SIGTERM'); await exited;
      }
    });
    await once(agent.stdout, 'data', { signal: AbortSignal.timeout(5000) });
    process.env.SSH_AUTH_SOCK = socketPath;
    const keyPath = join(api.dir, 'identity');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'pipe' });
    execFileSync('ssh-add', [keyPath], { stdio: 'pipe', env: { ...process.env, SSH_AUTH_SOCK: socketPath } });
    const identity = ssh2.utils.parseKey(readFileSync(`${keyPath}.pub`));
    const remote = await sftpFixture(t, identity);
    const settings = {
      ...remote.connection, auth_method: 'agent',
      agent_fingerprint: `SHA256:${createHash('sha256').update(identity.getPublicSSH()).digest('base64').replace(/=+$/, '')}`,
    };
    const connection = (await api.call(`/clients/${api.client.id}/connections`, 'POST', settings)).data;
    const credentials = { clientId: api.client.id, connectionId: connection.id };
    const result = await api.call('/files/connect', 'POST', credentials);
    assert.equal(result.status, 200);
    assert.equal((await api.call(`/files/${result.data.session}/read`, 'POST', { path: '/fixture.php' })).data.content, text.toString());
    assert.ok(remote.offered.length > 0 && remote.offered.every(key => key.equals(identity.getPublicSSH())));
    await api.call(`/files/${result.data.session}`, 'DELETE');
    execFileSync('ssh-add', ['-D'], { stdio: 'pipe', env: { ...process.env, SSH_AUTH_SOCK: socketPath } });
    const missing = await api.call('/files/connect', 'POST', credentials);
    assert.equal(missing.status, 502); assert.match(missing.data.error, /identity is missing/i);
    process.env.SSH_AUTH_SOCK = join(api.dir, 'unavailable.sock');
    const unavailable = await api.call('/files/connect', 'POST', credentials);
    assert.equal(unavailable.status, 502); assert.match(unavailable.data.error, /agent unavailable/i);
});

test('SFTP refuses a mismatched host key before authentication', { timeout: 10_000 }, async t => {
  const api = await apiFixture(t);
  const remote = await sftpFixture(t);
  const connection = (await api.call(`/clients/${api.client.id}/connections`, 'POST', {
    ...remote.connection, fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })).data;
  const response = await api.call('/files/connect', 'POST', { clientId: api.client.id, connectionId: connection.id, password: 'fixture-password' });
  assert.equal(response.status, 502); assert.match(response.data.error, /host key did not match/i);
});
