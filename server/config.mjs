import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: process.env.CONFIG_FILE || path.join(ROOT, '.env'), quiet: true });
function integer(name, fallback, min, max) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`Ungültige Konfiguration: ${name}`);
  return n;
}
export function configuration() {
  const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'var');
  const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:3000');
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('APP_ORIGIN muss eine reine HTTP(S)-Origin sein.');
  const production = process.env.NODE_ENV === 'production';
  if (production && origin.protocol !== 'https:')
    throw new Error('APP_ORIGIN benötigt in Produktion HTTPS.');
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.APP_ENCRYPTION_KEY || ''))
    throw new Error(
      'APP_ENCRYPTION_KEY: genau 32 zufällige Bytes als 64 Hex-Zeichen erforderlich.',
    );
  const cfg = {
    root: ROOT,
    dataDir,
    dbPath: path.join(dataDir, 'knowledge.sqlite'),
    uploadDir: path.join(dataDir, 'uploads'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    updateDir: path.join(dataDir, 'updates'),
    production,
    origin: origin.origin,
    host: process.env.HOST || '127.0.0.1',
    port: integer('PORT', 3000, 1, 65535),
    basePath: process.env.BASE_PATH ? process.env.BASE_PATH.replace(/\/+$/, '') : '/wissen',
    trustProxy: integer('TRUST_PROXY_HOPS', 0, 0, 4),
    encryptionKey: Buffer.from(process.env.APP_ENCRYPTION_KEY, 'hex'),
    auth: {
      mode: process.env.JWT_MODE || 'jwks',
      algorithm: process.env.JWT_ALGORITHM || 'RS256',
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
      jwksUrl: process.env.JWT_JWKS_URL,
      secret: process.env.JWT_SECRET,
      publicKeyFile: process.env.JWT_PUBLIC_KEY_FILE,
      maxAge: integer('JWT_MAX_AGE_SECONDS', 86400, 60, 604800),
    },
    loginUrl: process.env.AUTH_LOGIN_URL || '',
    uploadMaxBytes: integer('UPLOAD_MAX_MB', 20, 1, 50) * 1024 * 1024,
    crawlMaxPages: integer('CRAWL_MAX_PAGES', 40, 1, 100),
    ragMinScore: Number(process.env.RAG_MIN_SCORE || '0.3'),
    allowUpdates: process.env.ALLOW_UPDATES === 'true',
    updateRepository: process.env.UPDATE_REPOSITORY || '',
    updateBranch: process.env.UPDATE_BRANCH || 'main',
    pm2Prefix: process.env.PM2_APP_PREFIX || 'wissensraum',
  };
  if (!cfg.auth.issuer || !cfg.auth.audience)
    throw new Error('JWT_ISSUER und JWT_AUDIENCE sind erforderlich.');
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,45}$/.test(cfg.pm2Prefix))
    throw new Error('PM2_APP_PREFIX ist ungültig.');
  if (!Number.isFinite(cfg.ragMinScore) || cfg.ragMinScore < 0 || cfg.ragMinScore > 1)
    throw new Error('RAG_MIN_SCORE muss zwischen 0 und 1 liegen.');
  if (cfg.loginUrl && !cfg.loginUrl.startsWith('https://'))
    throw new Error('AUTH_LOGIN_URL benötigt HTTPS.');
  for (const dir of [cfg.dataDir, cfg.uploadDir, cfg.attachmentsDir, cfg.updateDir])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return cfg;
}
