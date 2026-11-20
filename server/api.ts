import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { Router } from 'express';
import { clientInput, connectionInput, layoutInput, noteInput, workspaceInput } from '../shared/model.ts';
import { now } from './db.ts';

function workspace(row: Record<string, SQLOutputValue>) {
  const { layout_json, ...rest } = row;
  return { ...rest, layout: typeof layout_json === 'string' ? JSON.parse(layout_json) : null };
}

export function api(db: DatabaseSync) {
  const router = Router();
  router.get('/health', (_req, res) => { res.json({ ok: true }); });
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
  for (const table of ['connections', 'notes'] as const) {
    function values(body: unknown) {
      if (table === 'notes') {
        const { title, content } = noteInput.parse(body);
        return { title, content };
      }
      const data = connectionInput.parse(body);
      return {
        name: data.name, type: data.type, url: data.type === 'SSH' ? null : data.url,
        host: data.type === 'SSH' ? data.host : null, port: data.type === 'SSH' ? data.port : null,
        username: data.type === 'SSH' ? data.username : null, fingerprint: data.type === 'SSH' ? data.fingerprint : null,
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
      const row = db.prepare(`UPDATE ${table} SET ${Object.keys(data).map(key => `${key} = ?`).join(', ')}, updated_at = ?
                              WHERE client_id = ? AND id = ? RETURNING *`)
        .get(...Object.values(data), now(), res.locals.client.id, req.params.itemId);
      if (!row) { res.status(404).json({ error: 'Item not found' }); return; }
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
