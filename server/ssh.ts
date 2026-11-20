import type { IncomingMessage, Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { Client } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { connectionInput } from '../shared/model.ts';
import { agentIdentities, keyFingerprint, SelectedAgent } from './ssh-agent.ts';

const dimensions = { cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) };
const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect'), password: z.string().min(1).max(4096).optional(), ...dimensions }),
  z.object({ type: z.literal('resize'), ...dimensions }),
  z.object({ type: z.literal('input'), data: z.string().max(48 * 1024) }),
]);

export function attachSsh(server: Server, db: DatabaseSync, allowsOrigin: (origin?: string, host?: string) => boolean,
  authorize?: (request: IncomingMessage) => boolean) {
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
    const { host, port, username, fingerprint, auth_method, agent_fingerprint } = target.data;
    sockets.handleUpgrade(req, socket, head, ws => {
      const ssh = new Client();
      let shell: ClientChannel | undefined;
      let started = false;
      let alive = true;
      let verified = false;
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
        shell?.close();
        ssh.destroy();
      });
      ssh.on('error', error => fail(error.level === 'agent'
        ? error.message === 'Selected SSH agent identity is missing'
          ? 'The selected SSH agent identity is missing. Load it with ssh-add.'
          : 'SSH agent unavailable or unable to sign. Check SSH_AUTH_SOCK and the loaded key.'
        : error.level === 'client-authentication'
        ? 'SSH authentication failed.'
        : error.message.includes('Host denied')
          ? 'SSH host key did not match the saved fingerprint.'
          : 'SSH connection failed. Check the host, port and network access.'));
      ssh.on('close', () => { status('disconnected'); ws.close(); });
      ssh.on('ready', () => {
        ssh.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => {
          if (error) { fail('The server refused to open a terminal.'); return; }
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
          if (auth_method === 'password' && !data.password) { fail('SSH password is required.'); return; }
          let agent: SelectedAgent | undefined;
          if (auth_method === 'agent') {
            const socket = process.env.SSH_AUTH_SOCK;
            try {
              const identities = await agentIdentities();
              if (ws.readyState !== WebSocket.OPEN) return;
              if (!identities.some(identity => identity.fingerprint === agent_fingerprint)) {
                fail('The selected SSH agent identity is missing. Load it with ssh-add.');
                return;
              }
              if (!socket) { fail('SSH agent unavailable. Start OpsDeck with access to SSH_AUTH_SOCK.'); return; }
              agent = new SelectedAgent(socket, agent_fingerprint);
            } catch {
              if (ws.readyState === WebSocket.OPEN) fail('SSH agent unavailable. Start OpsDeck with access to SSH_AUTH_SOCK.');
              return;
            }
          }
          try {
            ssh.connect({
              host, port, username,
              ...(agent ? { agent, authHandler: ['agent'] } : { password: data.password }),
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
