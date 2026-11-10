import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { harness, model, embedding, unitVector } from './helpers.mjs';
import { Gemini } from '../server/services/gemini.mjs';
import { createVerifier } from '../server/auth.mjs';
import { createSource, claimJob } from '../server/services/jobs.mjs';
import { processClaimedJob } from '../server/services/index-job.mjs';

test('SSE decoding survives arbitrary UTF-8 boundaries and multi-line data fields', async () => {
  const values = [
    { candidates: [{ content: { parts: [{ text: 'Grü' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'ße' }] }, finishReason: 'STOP' }] },
  ];
  const text = values
    .map(
      (value) =>
        JSON.stringify(value, null, 2)
          .split('\n')
          .map((line) => `data: ${line}`)
          .join('\r\n') + '\r\n\r\n',
    )
    .join('');
  const bytes = new TextEncoder().encode(text);
  const gemini = new Gemini(
    null,
    {},
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
            controller.close();
          },
        }),
      ),
  );
  gemini.key = () => 'test-only';
  let result = '';
  for await (const event of gemini.stream(model.name, {}, new AbortController().signal))
    if (event.type === 'delta') result += event.text;
  assert.equal(result, 'Grüße');
});
test('A stream without a model completion is rejected instead of saving a truncated answer', async () => {
  const gemini = new Gemini(
    null,
    {},
    async () =>
      new Response('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'),
  );
  gemini.key = () => 'test-only';
  await assert.rejects(async () => {
    for await (const _event of gemini.stream(model.name, {}, new AbortController().signal)) {
    }
  }, /vor dem Abschluss/);
});
test('SPKI public-key JWT verification supports RSA and rejects HMAC algorithm confusion', async (t) => {
  const h = await harness(t);
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const file = path.join(h.dir, 'public.pem');
  await fs.writeFile(file, await exportSPKI(publicKey));
  const verify = await createVerifier({
    ...h.config,
    auth: { ...h.config.auth, mode: 'public_key', algorithm: 'RS256', publicKeyFile: file },
  });
  const token = await new SignJWT({ email: 'rsa@example.test', name: 'RSA User' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(h.config.auth.issuer)
    .setAudience(h.config.auth.audience)
    .setSubject('rsa-user')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  assert.equal((await verify(token)).subject, 'rsa-user');
  await assert.rejects(verify(await h.token('hmac-user')), /ungültig/);
});
test('Embedding model changes wait for jobs, reindex stored text and preserve deactivation', async (t) => {
  const h = await harness(t);
  const admin = await h.login();
  const id = createSource(h.db, admin.user.id, {
    title: 'Source',
    type: 'text',
    documents: [{ text: 'Saved knowledge', location: 'Text' }],
  }).id;
  const newer = 'models/gemini-embedding-2';
  h.gemini.models = async () => ({
    chat: [model],
    embedding: [embedding, { name: newer, displayName: 'Embedding 2' }],
  });
  const choose = () =>
    h
      .csrf(admin.client.put('/api/admin/models'))
      .send({ chatModel: model.name, embeddingModel: newer });
  assert.equal((await choose()).status, 409);
  const job = claimJob(h.db, 'worker');
  const gemini = {
    key: () => true,
    embeddingModel: () => embedding.name,
    embed: async (texts) => texts.map(() => unitVector()),
  };
  await processClaimedJob({
    db: h.db,
    config: h.config,
    gemini,
    job,
    owner: 'worker',
    signal: new AbortController().signal,
  });
  h.db.prepare('UPDATE sources SET active=0 WHERE id=?').run(id);
  const selected = await choose();
  assert.equal(selected.status, 200);
  assert.equal(selected.body.reindexed, 1);
  const source = h.db
    .prepare('SELECT active,status,documents_json FROM sources WHERE id=?')
    .get(id);
  assert.equal(source.active, 0);
  assert.equal(source.status, 'queued');
  assert.match(source.documents_json, /Saved knowledge/);
});
