import type { IncomingMessage, Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { Client } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { connectionInput } from '../shared/model.ts';
import { keyFingerprint } from './ssh-agent.ts';
import { sshAuthentication, sshErrorDetail } from './ssh-auth.ts';
import { credentialStore } from './credentials.ts';
import type { FileCredentialStorage } from './credentials.ts';

const dimensions = { cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) };
const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect'), password: z.string().min(1).max(4096).optional(), remember: z.literal(true).optional(), ...dimensions }),
  z.object({ type: z.literal('resize'), ...dimensions }),
  z.object({ type: z.literal('input'), data: z.string().max(48 * 1024) }),
]);

export function attachSsh(server: Server, db: DatabaseSync, allowsOrigin: (origin?: string, host?: string) => boolean,
  authorize?: (request: IncomingMessage) => boolean, storage?: FileCredentialStorage) {
  const credentials = credentialStore(db, storage);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const route = /^\/ssh\/([\w-]+)\/([\w-]+)$/.exec(req.url ?? '');
    if (!route || (authorize && !authorize(req)) || !allowsOrigin(req.headers.origin, req.headers.host) || sockets.clients.size >= 24) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = connectionInput.safeParse(db.prepare(
      "SELECT * FROM connections WHERE client_id = ? AND id = ? AND type = 'SSH'",
    ).get(route[1], route[2]));
    if (!target.success || target.data.type !== 'SSH') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const connection = target.data;
    const clientId = route[1], connectionId = route[2];
    const { hash } = credentials.connectionFor(clientId, connectionId);
    const { host, port, username, fingerprint } = connection;
    sockets.handleUpgrade(req, socket, head, ws => {
      const ssh = new Client();
      let shell: ClientChannel | undefined;
      let started = false;
      let alive = true;
      let verified = false;
      let passwordToSave: string | undefined;
      let cols = 80;
      let rows = 24;
      const authTimeout = setTimeout(() => ws.close(1008, 'Connect request timed out'), 10_000);
      const heartbeat = setInterval(() => {
        if (!alive) { ws.terminate(); return; }
        alive = false;
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
      const status = (state: string, detail?: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ state, detail }));
      };
      const fail = (detail: string) => { status('error', detail); ws.close(1011); };
      ws.on('pong', () => { alive = true; });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        clearTimeout(authTimeout);
        clearInterval(heartbeat);
        passwordToSave = undefined;
        shell?.close();
        ssh.destroy();
      });
      ssh.on('error', error => fail(sshErrorDetail(error)));
      ssh.on('close', () => { status('disconnected'); ws.close(); });
      ssh.on('ready', () => {
        ssh.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => {
          if (error) { fail('The server refused to open a terminal.'); return; }
          if (ws.readyState !== WebSocket.OPEN) { channel.close(); return; }
          try {
            if (credentials.connectionFor(clientId, connectionId).hash !== hash) throw new Error('Connection settings changed. Reconnect to continue.');
            if (passwordToSave) credentials.save(connectionId, hash, passwordToSave);
          } catch (error) {
            passwordToSave = undefined;
            channel.close();
            fail(error instanceof Error ? error.message : 'Could not securely save the password.');
            return;
          }
          passwordToSave = undefined;
          shell = channel;
          function output(data: Buffer) {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 4 * 1024 * 1024) { fail('The browser could not keep up with terminal output.'); return; }
            ws.send(data, { binary: true }, error => { if (error) ws.terminate(); });
          }
          channel.on('data', output);
          channel.stderr.on('data', output);
          channel.on('close', () => { status('disconnected'); ws.close(); });
          channel.on('error', () => fail('The SSH terminal ended unexpectedly.'));
          status('connected');
        });
      });
      ws.on('message', async (raw, binary) => {
        if (binary) { ws.close(1003); return; }
        let body: unknown;
        try { body = JSON.parse(raw.toString()); }
        catch { ws.close(1007); return; }
        const parsed = message.safeParse(body);
        if (!parsed.success) { ws.close(1008); return; }
        const data = parsed.data;
        if (data.type === 'connect' && !started) {
          started = true;
          clearTimeout(authTimeout);
          ({ cols, rows } = data);
          let authentication;
          try {
            if (credentials.connectionFor(clientId, connectionId).hash !== hash) throw new Error('Connection settings changed. Reconnect to continue.');
            if (data.remember && connection.auth_method === 'agent') {
              throw new Error('SSH agent connections do not use saved passwords.');
            }
            if (data.remember && (!data.password || !credentials.available())) {
              throw new Error('Secure password storage is unavailable or no password was supplied.');
            }
            const password = connection.auth_method === 'password'
              ? data.password ?? credentials.password(connectionId, hash) : undefined;
            if (data.remember) passwordToSave = data.password;
            authentication = await sshAuthentication(connection, password);
            if (credentials.connectionFor(clientId, connectionId).hash !== hash) throw new Error('Connection settings changed. Reconnect to continue.');
          }
          catch (error) { if (ws.readyState === WebSocket.OPEN) fail(error instanceof Error ? error.message : 'SSH authentication unavailable.'); return; }
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            ssh.connect({
              host, port, username,
              ...authentication,
              readyTimeout: 15_000, keepaliveInterval: 20_000, keepaliveCountMax: 3,
              hostVerifier: (key: Buffer) => {
                verified = keyFingerprint(key) === fingerprint;
                return verified;
              },
            });
          } catch { fail('Invalid SSH connection settings.'); }
        } else if (data.type === 'resize') {
          ({ cols, rows } = data);
          shell?.setWindow(rows, cols, 0, 0);
        } else if (data.type === 'input' && shell && verified) {
          if (shell.writableLength > 1024 * 1024) { fail('The server could not keep up with terminal input.'); return; }
          shell.write(data.data);
        }
      });
    });
  });
}
