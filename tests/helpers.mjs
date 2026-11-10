import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { connect, migrate } from '../server/db/index.mjs';
import { createApp } from '../server/app.mjs';
import { Gemini } from '../server/services/gemini.mjs';
import { ROOT } from '../server/config.mjs';

export const model = {
  name: 'models/gemini-test-flash',
  displayName: 'Test Flash',
  inputTokenLimit: 100000,
  outputTokenLimit: 8192,
  supportedGenerationMethods: ['generateContent', 'countTokens'],
};
export const embedding = {
  name: 'models/gemini-embedding-001',
  displayName: 'Test Embedding',
  supportedGenerationMethods: ['embedContent', 'batchEmbedContents'],
};
export const unitVector = () => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
export function fakeFetch(calls = []) {
  return async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).includes('models?pageSize'))
      return Response.json({
        models: [
          model,
          embedding,
          { name: 'models/gemini-test-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-test-tts', supportedGenerationMethods: ['generateContent'] },
        ],
      });
    if (String(url).includes(':batchEmbedContents'))
      return Response.json({ embeddings: body.requests.map(() => ({ values: unitVector() })) });
    if (String(url).includes(':countTokens')) return Response.json({ totalTokens: 250 });
    if (String(url).includes(':streamGenerateContent'))
      return new Response(
        'data: ' +
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Die Anlaufstelle ist das Sekretariat [1].' }] },
                finishReason: 'STOP',
              },
            ],
          }) +
          '\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    return Response.json({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
  };
}
export async function harness(t, { uploadMaxBytes = 1024 * 1024 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wissensraum-test-'));
  const config = {
    root: ROOT,
    dataDir: dir,
    dbPath: path.join(dir, 'knowledge.sqlite'),
    uploadDir: path.join(dir, 'uploads'),
    updateDir: path.join(dir, 'updates'),
    production: false,
    origin: 'http://localhost:3000',
    host: '127.0.0.1',
    port: 3000,
    trustProxy: 0,
    encryptionKey: randomBytes(32),
    auth: {
      mode: 'secret',
      algorithm: 'HS256',
      secret: 'test-only-secret-with-more-than-thirty-two-bytes',
      issuer: 'https://identity.example.test/',
      audience: 'wissensraum-test',
      maxAge: 86400,
    },
    loginUrl: '',
    uploadMaxBytes,
    crawlMaxPages: 10,
    ragMinScore: 0.3,
    allowUpdates: false,
    pm2Prefix: 'wissensraum-test',
    updateBranch: 'main',
    updateRepository: '',
  };
  await fs.mkdir(config.uploadDir);
  await fs.mkdir(config.updateDir);
  const db = connect(config.dbPath);
  migrate(db);
  const calls = [];
  const gemini = new Gemini(db, config, fakeFetch(calls));
  const server = await createApp({ config, db, gemini });
  t.after(async () => {
    await server.close();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function token(subject = 'first', claims = {}, secret = config.auth.secret) {
    return new SignJWT({
      email: `${subject}@example.test`,
      name: `Name ${subject}`,
      role: 'admin',
      ...claims,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(config.auth.issuer)
      .setAudience(config.auth.audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));
  }
  async function login(subject = 'first', claims = {}) {
    const client = request.agent(server.app);
    const signed = await token(subject, claims);
    const response = await client
      .post('/api/auth/exchange')
      .set('Authorization', `Bearer ${signed}`);
    return { client, response, token: signed, user: response.body.user };
  }
  const csrf = (client) => client.set('Origin', config.origin).set('X-CSRF-Guard', '1');
  return { config, dir, db, gemini, calls, app: server.app, token, login, csrf };
}
