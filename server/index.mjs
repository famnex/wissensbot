import { execFileSync } from 'node:child_process';
import { configuration } from './config.mjs';
import { connect, migrate } from './db/index.mjs';
import { createApp } from './app.mjs';
process.umask(0o077);
const config = configuration();
const db = connect(config.dbPath);
migrate(db);
let revision = 'local';
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: config.root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {}
const { app, close } = await createApp({ config, db, revision });
const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: 'server_ready', port: config.port, revision }));
  process.send?.('ready');
});
server.requestTimeout = 120000;
server.headersTimeout = 30000;
server.keepAliveTimeout = 5000;
let stopping = false;
for (const event of ['SIGINT', 'SIGTERM'])
  process.on(event, async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 15000).unref();
    server.close(async () => {
      await close();
      db.close();
      clearTimeout(force);
      process.exit(0);
    });
    await close();
    server.closeIdleConnections();
  });
