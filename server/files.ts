import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Router, json } from 'express';
import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { connectionInput } from '../shared/model.ts';
import { maxTextBytes, maxTransferBytes } from '../shared/files.ts';
import { connectFiles, FileError, fileError, revision } from './file-transport.ts';
import type { RemoteTransport } from './file-transport.ts';

const remotePath = z.string().min(1).max(4096).startsWith('/').regex(/^[^\0\r\n]*$/).transform(path => posix.normalize(path));
const pathInput = z.object({ path: remotePath });
const credentials = z.object({
  clientId: z.string().uuid(), connectionId: z.string().uuid(),
  password: z.string().min(1).max(4096).regex(/^[^\0\r\n]*$/).optional(),
  allowInsecure: z.literal(true).optional(),
});
const saveInput = pathInput.extend({ content: z.string().max(maxTextBytes), revision: z.string().regex(/^[a-f0-9]{64}$/) });
const uploadInput = pathInput.extend({ data: z.string().max(Math.ceil(maxTransferBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) });
const idleTimeout = 15 * 60 * 1000;

export function fileApi(db: DatabaseSync) {
  const router = Router();
  router.use(json({ limit: '15mb' }));
  type Session = { remote: RemoteTransport; clientId: string; connectionId: string; settings: string; used: number; busy: boolean };
  const sessions = new Map<string, Session>();
  const connecting = new Set<string>();
  function close(id: string) {
    sessions.get(id)?.remote.close();
    sessions.delete(id);
  }
  const expire = setInterval(() => {
    for (const [id, entry] of sessions) if (!entry.busy && entry.used < Date.now() - idleTimeout) close(id);
  }, 60_000).unref();

  const route = (operation: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try { await operation(req, res); }
    catch (error) {
      const failure = error instanceof ZodError ? new FileError('Invalid file request.', 400) : fileError(error);
      if (!res.headersSent) res.status(failure.status).json({ error: failure.message });
    }
  };

  router.post('/connect', route(async (req, res) => {
    const input = credentials.parse(req.body);
    if (sessions.size + connecting.size >= 12) throw new FileError('Too many file connections are open.', 429);
    const row = db.prepare('SELECT * FROM connections WHERE client_id = ? AND id = ?').get(input.clientId, input.connectionId);
    const parsed = connectionInput.safeParse(row);
    if (!parsed.success || !('host' in parsed.data)) throw new FileError('File connection not found.', 404);
    const connection = parsed.data;
    if (parsed.data.type === 'FTP' && !input.allowInsecure) throw new FileError('FTP sends passwords and files unencrypted. Confirm this risk before connecting.', 400);
    const key = randomUUID();
    connecting.add(key);
    let remote: RemoteTransport | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const path = await Promise.race([
        (async () => {
          remote = await connectFiles({ ...connection, id: input.connectionId, client_id: input.clientId, created_at: '', updated_at: '' }, input.password);
          if (!connecting.has(key)) { remote.close(); throw new FileError('File connection was cancelled.'); }
          return remotePath.parse(await remote.pwd());
        })(),
        new Promise<string>((_, reject) => { timer = setTimeout(() => {
          connecting.delete(key); remote?.close(); reject(new FileError('File connection timed out.'));
        }, 30_000); }),
      ]);
      if (!remote || !connecting.has(key)) throw new FileError('File connection was cancelled.');
      const current = db.prepare('SELECT * FROM connections WHERE client_id = ? AND id = ?').get(input.clientId, input.connectionId);
      if (!current || JSON.stringify(row) !== JSON.stringify(current)) throw new FileError('Connection settings changed. Reconnect to continue.', 410);
      sessions.set(key, { remote, clientId: input.clientId, connectionId: input.connectionId, settings: JSON.stringify(row), used: Date.now(), busy: false });
      res.json({ session: key, path });
    } catch (error) { remote?.close(); throw error; }
    finally { clearTimeout(timer); connecting.delete(key); }
  }));

  async function operate(req: Request, action: (remote: RemoteTransport) => Promise<unknown>) {
    const id = String(req.params.sessionId);
    const entry = sessions.get(id);
    if (!entry || entry.used < Date.now() - idleTimeout) { close(id); throw new FileError('File connection expired. Reconnect to continue.', 410); }
    const row = db.prepare('SELECT * FROM connections WHERE client_id = ? AND id = ?').get(entry.clientId, entry.connectionId);
    if (!row || JSON.stringify(row) !== entry.settings) { close(id); throw new FileError('Connection settings changed. Reconnect to continue.', 410); }
    if (entry.busy) throw new FileError('A file operation is already running.', 409);
    entry.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(entry.remote),
        new Promise((_, reject) => { timer = setTimeout(() => { close(id); reject(new FileError('File operation timed out. Reconnect and check the remote file before retrying.')); }, 60_000); }),
      ]);
    } finally { clearTimeout(timer); entry.busy = false; entry.used = Date.now(); }
  }

  router.delete('/:sessionId', route(async (req, res) => { close(String(req.params.sessionId)); res.sendStatus(204); }));
  router.post('/:sessionId/list', route(async (req, res) => {
    const { path } = pathInput.parse(req.body);
    const entries = await operate(req, async remote => {
      const entries = await remote.list(path);
      if (entries.length > 10_000) throw new FileError('Directory contains too many entries.', 413);
      return entries.filter(entry => !['.', '..'].includes(entry.name) && !/[\/\0\r\n]/.test(entry.name));
    });
    res.json({ path, entries });
  }));
  router.post('/:sessionId/read', route(async (req, res) => {
    const { path } = pathInput.parse(req.body);
    const file = await operate(req, async remote => {
      const data = await remote.read(path, maxTextBytes);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new FileError('This file is not UTF-8 text. Download it instead.', 400); }
      if (content.includes('\0')) throw new FileError('This file appears to be binary. Download it instead.', 400);
      return { path, content, revision: revision(data) };
    });
    res.json(file);
  }));
  router.put('/:sessionId/save', route(async (req, res) => {
    const input = saveInput.parse(req.body);
    const data = Buffer.from(input.content, 'utf8');
    if (data.length > maxTextBytes) throw new FileError('Text files are limited to 1 MiB.', 413);
    await operate(req, remote => remote.write(input.path, data, input.revision));
    res.json({ revision: revision(data) });
  }));
  router.post('/:sessionId/download', route(async (req, res) => {
    const { path } = pathInput.parse(req.body);
    const file = await operate(req, async remote => ({ data: (await remote.read(path, maxTransferBytes)).toString('base64') }));
    res.json(file);
  }));
  router.post('/:sessionId/upload', route(async (req, res) => {
    const input = uploadInput.parse(req.body);
    const data = Buffer.from(input.data, 'base64');
    if (data.length > maxTransferBytes) throw new FileError('Transfers are limited to 10 MiB.', 413);
    // Creating only: existing files must be opened and saved with conflict detection.
    await operate(req, remote => remote.write(input.path, data, null));
    res.sendStatus(204);
  }));
  return {
    router,
    close() { clearInterval(expire); connecting.clear(); for (const id of sessions.keys()) close(id); },
  };
}
