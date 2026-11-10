const fs = require('node:fs');
const path = require('node:path');
// dotenv is deliberately not needed by PM2's ecosystem loader.
const envFile = process.env.CONFIG_FILE || path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const prefix = process.env.PM2_APP_PREFIX || 'wissensraum';
module.exports = {
  apps: [
    {
      name: `${prefix}-web`,
      script: 'server/index.mjs',
      max_memory_restart: '512M',
      kill_timeout: 20000,
    },
    {
      name: `${prefix}-worker`,
      script: 'server/workers/indexer.mjs',
      max_memory_restart: '600M',
      kill_timeout: 20000,
    },
    {
      name: `${prefix}-updater`,
      script: 'ops/update-daemon.mjs',
      max_memory_restart: '200M',
      kill_timeout: 20000,
    },
  ].map((app) => ({
    ...app,
    cwd: __dirname,
    interpreter: process.execPath,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    wait_ready: true,
    listen_timeout: 30000,
    exp_backoff_restart_delay: 500,
    min_uptime: 10000,
    max_restarts: 15,
    env: {
      ...process.env,
      PATH: `${path.join(__dirname, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH || ''}`,
      NODE_ENV: 'production',
      CONFIG_FILE: envFile,
    },
  })),
};
