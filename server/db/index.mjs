import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
export function connect(dbPath, { readonly = false } = {}) {
  const db = new Database(dbPath, { readonly, timeout: 5000 });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  return db;
}
export function migrate(db, directory = migrationsDir) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT',
  );
  const apply = db.transaction(() => {
    const applied = new Map(
      db
        .prepare('SELECT * FROM schema_migrations')
        .all()
        .map((r) => [r.version, r]),
    );
    const files = fs
      .readdirSync(directory)
      .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
      .sort();
    for (const version of applied.keys())
      if (!files.includes(version)) throw new Error(`Fehlende Migration: ${version}`);
    for (const version of files) {
      const sql = fs.readFileSync(path.join(directory, version), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(version)) {
        if (applied.get(version).checksum !== checksum)
          throw new Error(`Veränderte historische Migration: ${version}`);
      } else {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(
          version,
          checksum,
          Date.now(),
        );
      }
    }
  });
  apply.immediate();
  db.pragma('optimize');
}
export function getSetting(db, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
}
export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, String(value));
}
export function audit(db, actor, action, target = null) {
  db.prepare('INSERT INTO audit(actor_id,action,target_id,created_at) VALUES(?,?,?,?)').run(
    actor,
    action,
    target,
    Date.now(),
  );
}
