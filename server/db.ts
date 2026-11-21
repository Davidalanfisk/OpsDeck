import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDb(directory: string) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'opsdeck.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, colour TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL, type TEXT NOT NULL, url TEXT, host TEXT, port INTEGER,
      username TEXT, fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL, layout_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(client_id, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      session_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(client_id, workspace_id),
      FOREIGN KEY (client_id, workspace_id) REFERENCES workspaces(client_id, id) ON DELETE CASCADE
    ) STRICT;
  `);
  const columns = db.prepare('PRAGMA table_info(connections)').all().map(column => column.name);
  if (!columns.includes('auth_method')) db.exec("ALTER TABLE connections ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'");
  if (!columns.includes('agent_fingerprint')) db.exec('ALTER TABLE connections ADD COLUMN agent_fingerprint TEXT');
  if (!columns.includes('tls_mode')) db.exec("ALTER TABLE connections ADD COLUMN tls_mode TEXT NOT NULL DEFAULT 'explicit'");
  return db;
}

export const now = () => new Date().toISOString();
