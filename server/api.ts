import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { Router } from 'express';
import { clientInput, connectionInput, layoutInput, noteInput, workspaceInput } from '../shared/model.ts';
import { now } from './db.ts';
import { agentIdentities } from './ssh-agent.ts';
import { inspectSshHostKey } from './ssh-host-key.ts';
import { z } from 'zod';

function workspace(row: Record<string, SQLOutputValue>) {
  const { layout_json, ...rest } = row;
  return { ...rest, layout: typeof layout_json === 'string' ? JSON.parse(layout_json) : null };
}

export function api(db: DatabaseSync) {
  const router = Router();
  router.get('/health', (_req, res) => { res.json({ ok: true }); });
  router.post('/ssh/host-key', async (req, res) => {
    const { host, port } = z.object({
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65535),
    }).parse(req.body);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      const fingerprint = await inspectSshHostKey(host, port, abort.signal);
      res.json({ fingerprint });
    } catch (error) {
      if (!abort.signal.aborted) res.status(502).json({ error: error instanceof Error ? error.message : 'SSH host key lookup failed.' });
    }
  });
  router.get('/ssh-agent/identities', async (_req, res) => {
    try {
      const identities = await agentIdentities();
      res.json(identities.map(({ fingerprint, type }) => ({ fingerprint, type })));
    } catch {
      res.status(503).json({ error: 'SSH agent unavailable. Start OpsDeck with access to SSH_AUTH_SOCK.' });
    }
  });
  router.get('/clients', (_req, res) => {
    res.json(db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all());
  });
  router.post('/clients', (req, res) => {
    const data = clientInput.parse(req.body);
    const id = randomUUID();
    const stamp = now();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO clients VALUES (?, ?, ?, ?, ?, ?)').run(id, data.name, data.description, data.colour, stamp, stamp);
      db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, NULL, ?, ?)').run(randomUUID(), id, 'Main workspace', stamp, stamp);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.status(201).json({ id, ...data, created_at: stamp, updated_at: stamp });
  });

  const client = Router({ mergeParams: true });
  router.use('/clients/:clientId', client);
  client.use((req, res, next) => {
    const id = req.params.clientId;
    const row = typeof id === 'string' && db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    if (!row) { res.status(404).json({ error: 'Client not found' }); return; }
    res.locals.client = row;
    next();
  });
  client.get('/', (_req, res) => {
    const id = res.locals.client.id;
    res.json({
      client: res.locals.client,
      connections: db.prepare('SELECT * FROM connections WHERE client_id = ? ORDER BY name COLLATE NOCASE').all(id),
      notes: db.prepare('SELECT * FROM notes WHERE client_id = ? ORDER BY title COLLATE NOCASE').all(id),
      workspaces: db.prepare('SELECT * FROM workspaces WHERE client_id = ? ORDER BY created_at, id').all(id).map(workspace),
    });
  });
  client.put('/', (req, res) => {
    const { name, description, colour } = clientInput.parse(req.body);
    const stamp = now();
    db.prepare('UPDATE clients SET name = ?, description = ?, colour = ?, updated_at = ? WHERE id = ?')
      .run(name, description, colour, stamp, res.locals.client.id);
    res.json({ ...res.locals.client, name, description, colour, updated_at: stamp });
  });
  client.delete('/', (_req, res) => {
    db.prepare('DELETE FROM clients WHERE id = ?').run(res.locals.client.id);
    res.sendStatus(204);
  });
  const agentMessage = z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.string(),
    tool_name: z.string().optional(),
    tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }) })).optional(),
  });
  const agentConversation = z.object({
    id: z.string().uuid(), title: z.string(), updatedAt: z.number().finite(),
    messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'action', 'tool', 'error']), content: z.string() })),
    history: z.array(agentMessage),
  });
  client.get('/agent-conversations', (_req, res) => {
    const rows = db.prepare('SELECT conversation_json, version FROM agent_conversations WHERE client_id = ?')
      .all(res.locals.client.id);
    res.json(rows.map(row => ({ conversation: JSON.parse(String(row.conversation_json)), version: row.version })));
  });
  client.put('/agent-conversations/:conversationId', (req, res) => {
    const { conversation, expectedVersion } = z.object({
      conversation: agentConversation, expectedVersion: z.number().int().nonnegative(),
    }).parse(req.body);
    if (conversation.id !== req.params.conversationId) {
      res.status(400).json({ error: 'Conversation ID does not match the path.' }); return;
    }
    const serialized = JSON.stringify(conversation);
    const result = expectedVersion === 0
      ? db.prepare('INSERT OR IGNORE INTO agent_conversations (client_id, id, conversation_json, version) VALUES (?, ?, ?, 1)')
        .run(res.locals.client.id, conversation.id, serialized)
      : db.prepare('UPDATE agent_conversations SET conversation_json = ?, version = version + 1 WHERE client_id = ? AND id = ? AND version = ?')
        .run(serialized, res.locals.client.id, conversation.id, expectedVersion);
    if (!result.changes) { res.status(409).json({ error: 'Conversation changed in another session. Your unsaved changes were not overwritten.' }); return; }
    res.json({ version: expectedVersion + 1 });
  });
  for (const table of ['connections', 'notes'] as const) {
    function values(body: unknown) {
      if (table === 'notes') {
        const { title, content } = noteInput.parse(body);
        return { title, content };
      }
      const data = connectionInput.parse(body);
      const ssh = data.type === 'SSH' || data.type === 'SFTP';
      return {
        name: data.name, type: data.type, url: 'url' in data ? data.url : null,
        host: 'host' in data ? data.host : null, port: 'port' in data ? data.port : null,
        username: 'username' in data ? data.username : null, fingerprint: 'fingerprint' in data ? data.fingerprint : null,
        auth_method: ssh ? data.auth_method : 'password',
        agent_fingerprint: ssh && data.auth_method === 'agent' ? data.agent_fingerprint : null,
        tls_mode: 'tls_mode' in data ? data.tls_mode : 'explicit',
      };
    }
    client.post(`/${table}`, (req, res) => {
      const data = values(req.body);
      const id = randomUUID();
      const stamp = now();
      const fields = Object.keys(data);
      db.prepare(`INSERT INTO ${table} (id, client_id, ${fields.join(', ')}, created_at, updated_at)
                  VALUES (?, ?, ${fields.map(() => '?').join(', ')}, ?, ?)`)
        .run(id, res.locals.client.id, ...Object.values(data), stamp, stamp);
      res.status(201).json({ id, client_id: res.locals.client.id, ...data, created_at: stamp, updated_at: stamp });
    });
    client.put(`/${table}/:itemId`, (req, res) => {
      const data = values(req.body);
      const expected = table === 'notes' && req.body?.if_updated_at !== undefined
        ? z.string().min(1).max(80).parse(req.body.if_updated_at) : undefined;
      const expectedContent = table === 'notes' && req.body?.if_content !== undefined
        ? z.string().max(250_000).parse(req.body.if_content) : undefined;
      const expectedTitle = table === 'notes' && req.body?.if_title !== undefined
        ? z.string().max(120).parse(req.body.if_title) : undefined;
      const row = db.prepare(`UPDATE ${table} SET ${Object.keys(data).map(key => `${key} = ?`).join(', ')}, updated_at = ?
                              WHERE client_id = ? AND id = ? ${expected ? 'AND updated_at = ?' : ''}
                              ${expectedContent !== undefined ? 'AND content = ?' : ''} ${expectedTitle !== undefined ? 'AND title = ?' : ''} RETURNING *`)
        .get(...Object.values(data), now(), res.locals.client.id, req.params.itemId, ...(expected ? [expected] : []),
          ...(expectedContent !== undefined ? [expectedContent] : []), ...(expectedTitle !== undefined ? [expectedTitle] : []));
      if (!row) {
        const existing = (expected || expectedContent !== undefined || expectedTitle !== undefined) &&
          db.prepare(`SELECT id FROM ${table} WHERE client_id = ? AND id = ?`).get(res.locals.client.id, req.params.itemId);
        res.status(existing ? 409 : 404).json({ error: existing ? 'The note changed. Read it again before updating.' : 'Item not found' }); return;
      }
      res.json(row);
    });
    client.delete(`/${table}/:itemId`, (req, res) => {
      db.prepare(`DELETE FROM ${table} WHERE client_id = ? AND id = ?`).run(res.locals.client.id, req.params.itemId);
      res.sendStatus(204);
    });
  }
  client.post('/workspaces', (req, res) => {
    const { name, layout = null } = workspaceInput.parse(req.body);
    const stamp = now();
    const row = db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .get(randomUUID(), res.locals.client.id, name, layout && JSON.stringify(layout), stamp, stamp);
    if (!row) throw new Error('Workspace creation returned no row');
    res.status(201).json(workspace(row));
  });
  client.use('/workspaces/:workspaceId', (req, res, next) => {
    const row = db.prepare('SELECT * FROM workspaces WHERE client_id = ? AND id = ?').get(res.locals.client.id, req.params.workspaceId);
    if (!row) { res.status(404).json({ error: 'Workspace not found' }); return; }
    next();
  });
  client.put('/workspaces/:workspaceId', (req, res) => {
    const layout = layoutInput.parse(req.body);
    const row = db.prepare('UPDATE workspaces SET layout_json = ?, updated_at = ? WHERE id = ? RETURNING *')
      .get(JSON.stringify(layout), now(), req.params.workspaceId);
    if (!row) throw new Error('Workspace update returned no row');
    res.json(workspace(row));
  });
  client.get('/workspaces/:workspaceId/session', (req, res) => {
    const row = db.prepare('SELECT session_json FROM sessions WHERE client_id = ? AND workspace_id = ?')
      .get(res.locals.client.id, req.params.workspaceId);
    res.json(row ? JSON.parse(String(row.session_json)) : null);
  });
  client.put('/workspaces/:workspaceId/session', (req, res) => {
    db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_id, workspace_id)
                DO UPDATE SET session_json = excluded.session_json, updated_at = excluded.updated_at`)
      .run(randomUUID(), res.locals.client.id, req.params.workspaceId, JSON.stringify(layoutInput.parse(req.body)), now());
    res.sendStatus(204);
  });
  router.use((_req, res) => { res.status(404).json({ error: 'API route not found' }); });
  return router;
}
