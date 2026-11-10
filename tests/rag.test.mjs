import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { harness, model, embedding, unitVector } from './helpers.mjs';
import { setSetting, migrate } from '../server/db/index.mjs';
import { createSource, claimJob } from '../server/services/jobs.mjs';
import { processClaimedJob } from '../server/services/index-job.mjs';
import { Retriever } from '../server/services/retrieval.mjs';
import { embeddingProfile, isChatModel, Gemini } from '../server/services/gemini.mjs';
import { chunksFromDocuments } from '../server/services/chunking.mjs';

test('Real indexing pipeline persists vectors and the search worker excludes inactive, deleted and incompatible sources', async (t) => {
  const h = await harness(t);
  const { user } = await h.login();
  const id = createSource(h.db, user.id, {
    title: 'Sekretariat',
    type: 'text',
    documents: [
      {
        text: 'Das Sekretariat ist die erste Anlaufstelle für alle organisatorischen Fragen.',
        location: 'Notiz',
      },
    ],
  }).id;
  const job = claimJob(h.db, 'worker-a');
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
    owner: 'worker-a',
    signal: new AbortController().signal,
  });
  assert.equal(h.db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'done');
  const retriever = new Retriever(h.config);
  assert.equal((await retriever.search(unitVector(), embeddingProfile(embedding.name))).length, 1);
  assert.equal(
    (await retriever.search(unitVector(), embeddingProfile('models/gemini-embedding-2'))).length,
    0,
  );
  h.db.prepare('UPDATE sources SET active=0 WHERE id=?').run(id);
  assert.equal((await retriever.search(unitVector(), embeddingProfile(embedding.name))).length, 0);
  h.db.prepare('DELETE FROM sources WHERE id=?').run(id);
  assert.equal(h.db.prepare('SELECT count(*) n FROM chunks').get().n, 0);
  await retriever.close();
});
test('An expired lease cannot publish chunks after another worker has reclaimed the job', async (t) => {
  const h = await harness(t);
  const { user } = await h.login();
  createSource(h.db, user.id, {
    title: 'Knowledge',
    type: 'text',
    documents: [{ text: 'One fact', location: 'Text' }],
  });
  const old = claimJob(h.db, 'old');
  h.db.prepare('UPDATE jobs SET lease_until=0').run();
  const newer = claimJob(h.db, 'new');
  assert.equal(newer.id, old.id);
  const gemini = {
    key: () => true,
    embeddingModel: () => embedding.name,
    embed: async (texts) => texts.map(() => unitVector()),
  };
  await assert.rejects(
    processClaimedJob({
      db: h.db,
      config: h.config,
      gemini,
      job: old,
      owner: 'old',
      signal: new AbortController().signal,
    }),
    /ersetzt/,
  );
  assert.equal(h.db.prepare('SELECT count(*) n FROM chunks').get().n, 0);
});
test('Complete multi-turn history reaches Gemini and sources accompany the streamed answer', async (t) => {
  const h = await harness(t);
  const admin = await h.login();
  await h
    .csrf(admin.client.put('/api/admin/key'))
    .send({ apiKey: 'test-gemini-key-not-real-123456789' });
  setSetting(h.db, 'chat_model', JSON.stringify(model));
  createSource(h.db, admin.user.id, {
    title: 'Sekretariat',
    type: 'text',
    documents: [{ text: 'Das Sekretariat ist die Anlaufstelle.', location: 'Text' }],
  });
  const job = claimJob(h.db, 'index');
  await processClaimedJob({
    db: h.db,
    config: h.config,
    gemini: h.gemini,
    job,
    owner: 'index',
    signal: new AbortController().signal,
  });
  const messages = [
    { role: 'user', text: 'Ich frage nach Zuständigkeiten.' },
    { role: 'model', text: 'Welche Zuständigkeit meinst du?' },
    { role: 'user', text: 'Wer ist die erste Anlaufstelle?' },
  ];
  const answer = await h.csrf(admin.client.post('/api/chat')).send({ messages });
  assert.equal(answer.status, 200);
  assert.match(answer.text, /Sekretariat/);
  assert.match(answer.text, /"type":"done"/);
  assert.match(answer.text, /"citation":1/);
  const called = h.calls.find((c) => c.url.includes(':streamGenerateContent'));
  assert.deepEqual(
    called.body.contents.map((c) => ({ role: c.role, text: c.parts[0].text })),
    messages,
  );
  assert.equal(h.db.prepare("SELECT count(*) n FROM sources WHERE type='text'").get().n, 1);
});
test('Chunking covers long inputs with bounded overlapping chunks and rejects empty text', () => {
  const text = Array.from({ length: 700 }, (_, i) => `Information Nummer ${i}.`).join(' ');
  const chunks = chunksFromDocuments([{ text, location: 'Test' }]);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.text.length <= 1800));
  for (let i = 0; i < 700; i++)
    assert.ok(chunks.some((c) => c.text.includes(`Information Nummer ${i}.`)));
  assert.throws(
    () => chunksFromDocuments([{ text: '  \n ', location: 'Empty' }]),
    /Kein lesbarer Text/,
  );
});
test('Models.list pagination is exhaustive and non-chat models are filtered', async (t) => {
  const h = await harness(t);
  const seen = [];
  const gemini = new Gemini(h.db, h.config, async (url) => {
    seen.push(String(url));
    return Response.json(
      String(url).includes('pageToken=next')
        ? { models: [{ ...model, name: 'models/gemini-second' }] }
        : { models: [model, embedding], nextPageToken: 'next' },
    );
  });
  const models = await gemini.models('test-key');
  assert.equal(models.chat.length, 2);
  assert.equal(seen.length, 2);
  for (const name of [
    'models/gemini-image',
    'models/gemini-tts',
    'models/gemini-audio',
    'models/imagen',
    'models/embedding',
  ])
    assert.equal(isChatModel({ ...model, name }), false);
});
test('Migration checksums prevent changed historical migrations and migration application is transactional', async (t) => {
  const h = await harness(t);
  const directory = path.join(h.dir, 'migrations');
  await fs.mkdir(directory);
  const realMigrations = (await fs.readdir(path.join(h.config.root, 'server/db/migrations'))).filter(
    (f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f),
  );
  for (const file of realMigrations) {
    await fs.copyFile(
      path.join(h.config.root, 'server/db/migrations', file),
      path.join(directory, file),
    );
  }
  await fs.writeFile(
    path.join(directory, '999_broken.sql'),
    'CREATE TABLE should_rollback(id INTEGER); INVALID SQL;',
  );
  assert.throws(() => migrate(h.db, directory));
  assert.equal(
    h.db.prepare("SELECT 1 FROM sqlite_master WHERE name='should_rollback'").get(),
    undefined,
  );
  await fs.appendFile(path.join(directory, '001_initial.sql'), '\n-- changed');
  assert.throws(() => migrate(h.db, directory), /historische Migration/);
});
