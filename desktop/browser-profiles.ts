import { session } from 'electron';
import type { DatabaseSync } from 'node:sqlite';

const retention = 30 * 24 * 60 * 60 * 1000;

export function browserProfiles(db: DatabaseSync) {
  const profile = (id: string) => session.fromPartition(`persist:opsdeck-sites-${id}`);
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'desktop_browser_activity'").get()) {
    db.exec('BEGIN');
    try {
      db.exec('CREATE TABLE desktop_browser_activity (client_id TEXT PRIMARY KEY, last_used INTEGER NOT NULL) STRICT');
      // Give existing profiles a full retention period from the upgrade.
      db.prepare(`INSERT INTO desktop_browser_activity
        SELECT DISTINCT client_id, ? FROM connections WHERE type <> 'SSH'`).run(Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const touch = db.prepare(`INSERT INTO desktop_browser_activity VALUES (?, ?)
    ON CONFLICT(client_id) DO UPDATE SET last_used = excluded.last_used`);
  const expired = db.prepare('SELECT client_id FROM desktop_browser_activity WHERE last_used <= ?');
  const lastUsed = db.prepare('SELECT last_used FROM desktop_browser_activity WHERE client_id = ?');
  const remove = db.prepare('DELETE FROM desktop_browser_activity WHERE client_id = ?');
  const clearing = new Map<string, Promise<void>>();

  function clear(id: string, closeTabs: (id: string) => void) {
    const pending = clearing.get(id);
    if (pending) return pending;
    const cleanup = Promise.resolve().then(async () => {
      closeTabs(id);
      const browser = profile(id);
      await browser.clearData();
      await browser.clearAuthCache();
      await browser.cookies.flushStore();
      remove.run(id);
    }).finally(() => clearing.delete(id));
    clearing.set(id, cleanup);
    return cleanup;
  }

  function markUsed(id: string) { touch.run(id, Date.now()); }

  return {
    markUsed,
    async open(id: string, closeTabs: (id: string) => void) {
      const stamp = lastUsed.get(id)?.last_used;
      if (typeof stamp === 'number' && stamp <= Date.now() - retention) await clear(id, closeTabs);
      markUsed(id);
      return profile(id);
    },
    sweep(active: Set<string>, closeTabs: (id: string) => void) {
      for (const id of active) markUsed(id);
      for (const { client_id: id } of expired.all(Date.now() - retention)) {
        if (typeof id !== 'string') continue;
        void clear(id, closeTabs).catch(error => console.error('Could not expire an inactive desktop browser profile:', error));
      }
    },
    settle: () => Promise.allSettled(clearing.values()),
  };
}
