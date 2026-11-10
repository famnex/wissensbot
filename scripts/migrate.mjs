import { configuration } from '../server/config.mjs';
import { connect, migrate } from '../server/db/index.mjs';
process.umask(0o077);
const config = configuration();
const db = connect(config.dbPath);
try {
  migrate(db);
  console.log('Datenbank-Migrationen erfolgreich.');
} finally {
  db.close();
}
