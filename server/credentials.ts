import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { connectionInput } from '../shared/model.ts';
import { FileError } from './file-transport.ts';

export type FileCredentialStorage = {
  available: () => boolean;
  encrypt: (password: string) => Buffer;
  decrypt: (encrypted: Buffer) => string;
};

export function credentialStore(db: DatabaseSync, storage?: FileCredentialStorage) {
  function connectionFor(clientId: string, connectionId: string) {
    const row = db.prepare('SELECT * FROM connections WHERE client_id = ? AND id = ?').get(clientId, connectionId);
    const parsed = connectionInput.safeParse(row);
    if (!parsed.success || !('host' in parsed.data)) throw new FileError('Connection not found.', 404);
    const connection = parsed.data;
    const hash = createHash('sha256').update(JSON.stringify([
      connection.type, connection.host, connection.port, connection.username,
      'fingerprint' in connection ? connection.fingerprint : null,
      'auth_method' in connection ? connection.auth_method : null,
      'tls_mode' in connection ? connection.tls_mode : null,
    ])).digest('hex');
    return { row, connection, hash };
  }
  function available() {
    try { return Boolean(storage?.available()); } catch { return false; }
  }
  function status(connectionId: string, hash: string) {
    const saved = db.prepare('SELECT settings_hash FROM file_credentials WHERE connection_id = ?').get(connectionId);
    return { available: available(), saved: saved?.settings_hash === hash, stored: Boolean(saved) };
  }
  function password(connectionId: string, hash: string) {
    const saved = db.prepare('SELECT encrypted FROM file_credentials WHERE connection_id = ? AND settings_hash = ?').get(connectionId, hash);
    if (!saved) return undefined;
    if (!available() || !storage) throw new FileError('Secure password storage is unavailable. Enter your password instead.', 503);
    try { return storage.decrypt(Buffer.from(saved.encrypted as Uint8Array)); }
    catch { throw new FileError('Could not unlock the saved password. Enter your password instead.', 503); }
  }
  function save(connectionId: string, hash: string, value: string) {
    if (!available() || !storage) throw new FileError('Secure password storage is unavailable; password was not saved.', 503);
    let encrypted: Buffer;
    try { encrypted = storage.encrypt(value); }
    catch { throw new FileError('Could not securely save the password.', 503); }
    db.prepare('INSERT OR REPLACE INTO file_credentials (connection_id, settings_hash, encrypted) VALUES (?, ?, ?)')
      .run(connectionId, hash, encrypted);
  }
  function forget(connectionId: string) {
    db.prepare('DELETE FROM file_credentials WHERE connection_id = ?').run(connectionId);
  }
  return { connectionFor, available, status, password, save, forget };
}
