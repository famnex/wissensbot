// Uses only a fresh temporary database, random test keys and owned processes.
// --pm2 additionally exercises a separate PM2 instance; never the service instance.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SignJWT } from 'jose';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const usePm2 = process.argv.includes('--pm2');
await fs.access(path.join(root, 'dist/index.html'));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wissensraum-smoke-'));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port;
    server.close(() => resolve(selected));
  });
});
const prefix = `verify-${randomBytes(4).toString('hex')}`;
const secret = randomBytes(32).toString('hex');
const testConfig = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(port),
  APP_ORIGIN: 'https://verification.example.test',
  TRUST_PROXY_HOPS: '0',
  DATA_DIR: path.join(dir, 'data'),
  APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  JWT_MODE: 'secret',
  JWT_ALGORITHM: 'HS256',
  JWT_ISSUER: 'https://identity.example.test/',
  JWT_AUDIENCE: 'smoke-test',
  JWT_SECRET: secret,
  JWT_MAX_AGE_SECONDS: '86400',
  AUTH_LOGIN_URL: '',
  UPLOAD_MAX_MB: '20',
  CRAWL_MAX_PAGES: '40',
  RAG_MIN_SCORE: '0.3',
  PM2_APP_PREFIX: prefix,
  ALLOW_UPDATES: 'false',
  UPDATE_REPOSITORY: '',
  UPDATE_BRANCH: 'main',
};
const envFile = path.join(dir, 'app.env');
await fs.writeFile(
  envFile,
  Object.entries(testConfig)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n'),
  { mode: 0o600 },
);
const env = {
  ...process.env,
  ...testConfig,
  PM2_HOME: path.join(dir, 'pm2'),
  CONFIG_FILE: envFile,
  NO_COLOR: '1',
  PM2_DISABLE_VERSION_CHECK: 'true',
  PM2_NO_INTERACTION: 'true',
  PM2_DISCRETE_MODE: 'true',
};
const pm2 = async (...args) =>
  (
    await execute(process.execPath, [path.join(root, 'node_modules/pm2/bin/pm2'), ...args], {
      cwd: root,
      env,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    })
  ).stdout;
const scripts = {
  web: 'server/index.mjs',
  worker: 'server/workers/indexer.mjs',
  updater: 'ops/update-daemon.mjs',
};
const children = new Map();
async function start(name) {
  const child = spawn(process.execPath, [scripts[name]], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.set(name, child);
  let diagnostics = '';
  child.stderr.on('data', (b) => {
    diagnostics = (diagnostics + b).slice(-4000);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: readiness timeout`)), 30000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`${name}: exited before readiness. ${diagnostics}`));
    });
    child.once('message', (message) => {
      if (message === 'ready') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
async function stop(name) {
  const child = children.get(name);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGINT');
  });
}
const base = `http://127.0.0.1:${port}`;
async function health() {
  for (let i = 0; i < 80; i++) {
    try {
      const data = await (
        await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      ).json();
      if (data.ok && data.workerOnline) return;
    } catch {}
    await delay(250);
  }
  throw new Error('HTTP/worker readiness timeout');
}
try {
  if (usePm2) await pm2('start', 'ecosystem.config.cjs');
  else for (const name of Object.keys(scripts)) await start(name);
  await health();
  const before = usePm2 ? JSON.parse(await pm2('jlist')) : [];
  if (usePm2 && (before.length !== 3 || before.some((p) => p.pm2_env.status !== 'online')))
    throw new Error('Not all three PM2 services online');
  const token = await new SignJWT({ name: 'Smoke Test', email: 'smoke@example.test' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('smoke')
    .setIssuer(testConfig.JWT_ISSUER)
    .setAudience(testConfig.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
  const headers = { Authorization: `Bearer ${token}` };
  const login = await fetch(`${base}/api/auth/exchange`, { method: 'POST', headers });
  if (login.status !== 200 || (await login.json()).user.role !== 'admin')
    throw new Error('JWT login failed');
  const updates = await fetch(`${base}/api/admin/updates`, { headers });
  if (!(await updates.json()).daemonOnline) throw new Error('Update daemon heartbeat missing');
  const page = await fetch(`${base}/`);
  if (page.status !== 200 || !(await page.text()).includes('Wissensraum'))
    throw new Error('Built frontend unavailable');
  if (usePm2) {
    await pm2(
      'restart',
      'ecosystem.config.cjs',
      '--only',
      `${prefix}-web,${prefix}-worker`,
      '--update-env',
    );
    const after = JSON.parse(await pm2('jlist'));
    for (const name of [`${prefix}-web`, `${prefix}-worker`])
      if (before.find((p) => p.name === name).pid === after.find((p) => p.name === name).pid)
        throw new Error('PM2 process did not restart');
  } else {
    await Promise.all([stop('web'), stop('worker')]);
    await start('web');
    await start('worker');
  }
  await health();
  const me = await fetch(`${base}/api/me`, { headers });
  if (me.status !== 200 || (await me.json()).user.role !== 'admin')
    throw new Error('Local identity did not persist');
  console.log(
    JSON.stringify({
      mode: usePm2 ? 'pm2' : 'node',
      services: 3,
      jwtLogin: 'passed',
      httpFrontend: 'passed',
      restart: 'passed',
      sqliteIdentityPersistence: 'passed',
    }),
  );
} finally {
  if (usePm2)
    await pm2('kill').catch(() => {}); // Only the isolated PM2_HOME above.
  else await Promise.all([...children.keys()].map(stop));
  await fs.rm(dir, { recursive: true, force: true });
}
