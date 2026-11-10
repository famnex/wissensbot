import fs from 'node:fs';
import path from 'node:path';
import { configuration } from '../server/config.mjs';
import { connect } from '../server/db/index.mjs';
process.umask(0o077);
const config = configuration();
const db = connect(config.dbPath);
try {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok')
    throw new Error('SQLite-Integritätsprüfung fehlgeschlagen.');
  if (!process.argv.includes('--verify')) {
    const arg = process.argv.indexOf('--output');
    const output =
      arg >= 0
        ? process.argv[arg + 1]
        : path.join(config.dataDir, 'backups', `knowledge-${Date.now()}.sqlite`);
    if (!output) throw new Error('Backup-Ziel fehlt.');
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    if (fs.existsSync(output)) throw new Error('Das Backup-Ziel existiert bereits.');
    await db.backup(output);
    const copied = connect(output, { readonly: true });
    try {
      if (copied.pragma('integrity_check', { simple: true }) !== 'ok')
        throw new Error('Backup-Integrität fehlgeschlagen.');
    } finally {
      copied.close();
    }
    fs.chmodSync(output, 0o600);
    console.log('Konsistentes SQLite-Backup erfolgreich erstellt.');
  } else console.log('SQLite-Integrität bestätigt.');
} finally {
  db.close();
}
