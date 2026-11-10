import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { harness } from './helpers.mjs';

test('Session persistence: user stays authenticated and status changes are respected', async (t) => {
  const { app, login, csrf, db } = await harness(t);
  const { client, user } = await login('persistent-user', { name: 'Dauerhafter Nutzer' });

  // 1. Initial request after login succeeds
  const meRes = await csrf(client.get('/api/me'));
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.user.name, 'Dauerhafter Nutzer');

  // 2. Disable user in SQLite
  db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(user.id);

  // 3. Request is now rejected with USER_DISABLED
  const disabledRes = await csrf(client.get('/api/me'));
  assert.equal(disabledRes.status, 403);
  assert.equal(disabledRes.body.error.code, 'USER_DISABLED');

  // 4. Re-enable user
  db.prepare('UPDATE users SET enabled=1 WHERE id=?').run(user.id);
  const reenabledRes = await csrf(client.get('/api/me'));
  assert.equal(reenabledRes.status, 200);
  assert.equal(reenabledRes.body.user.id, user.id);
});

test('Chunk attachments: upload, list, download, and delete lifecycle', async (t) => {
  const { app, login, csrf, db, config } = await harness(t);
  const { client } = await login('admin-uploader');

  // Create a source
  const sourceRes = await csrf(
    client.post('/api/sources/text').send({
      title: 'Netzwerkhandbuch',
      text: 'Hier ist die Dokumentation für das Büronetzwerk.',
    }),
  );
  assert.equal(sourceRes.status, 202);
  const sourceId = sourceRes.body.id;

  // Wait for worker or insert a chunk directly
  const chunkRes = await csrf(
    client.post(`/api/sources/${sourceId}/chunks`).send({
      title: 'WLAN & Router',
      text: 'Das WLAN-Passwort und die Router-Konfiguration.',
      location: 'Kapitel 1',
    }),
  );
  assert.equal(chunkRes.status, 201);
  const chunkId = chunkRes.body.chunk.id;

  // 1. Upload an image attachment to this chunk
  const imageBuffer = Buffer.from('fake-png-content');
  const uploadRes = await csrf(
    client
      .post(`/api/chunks/${chunkId}/attachments`)
      .attach('file', imageBuffer, { filename: 'netzplan.png', contentType: 'image/png' }),
  );
  assert.equal(uploadRes.status, 201);
  assert.ok(uploadRes.body.attachment);
  const attachmentId = uploadRes.body.attachment.id;
  assert.equal(uploadRes.body.attachment.original_name, 'netzplan.png');
  assert.equal(uploadRes.body.attachment.mime_type, 'image/png');

  // Verify file exists on disk
  const storedFilename = uploadRes.body.attachment.filename;
  const filePath = path.join(config.attachmentsDir, storedFilename);
  const diskContent = await fs.readFile(filePath);
  assert.equal(diskContent.toString(), 'fake-png-content');

  // 2. List attachments via GET /api/chunks/:chunkId/attachments
  const listRes = await csrf(client.get(`/api/chunks/${chunkId}/attachments`));
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.attachments.length, 1);
  assert.equal(listRes.body.attachments[0].id, attachmentId);

  // 3. Verify chunk listing via GET /api/sources/:id/chunks includes attachments
  const sourceChunksRes = await csrf(client.get(`/api/sources/${sourceId}/chunks`));
  assert.equal(sourceChunksRes.status, 200);
  const matchingChunk = sourceChunksRes.body.chunks.find((c) => c.id === chunkId);
  assert.ok(matchingChunk);
  assert.equal(matchingChunk.attachments.length, 1);
  assert.equal(matchingChunk.attachments[0].id, attachmentId);

  // 4. Download / view attachment via GET /api/attachments/:id/:filename
  const downloadRes = await csrf(client.get(`/api/attachments/${attachmentId}/netzplan.png`));
  assert.equal(downloadRes.status, 200);
  assert.equal(downloadRes.headers['content-type'], 'image/png');
  assert.ok(downloadRes.headers['content-disposition'].includes('inline'));
  assert.equal(downloadRes.body.toString(), 'fake-png-content');

  // 5. Delete attachment via DELETE /api/attachments/:id
  const deleteRes = await csrf(client.delete(`/api/attachments/${attachmentId}`));
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.deleted, true);

  // Verify file is gone from disk
  let fileStillExists = false;
  try {
    await fs.access(filePath);
    fileStillExists = true;
  } catch {}
  assert.equal(fileStillExists, false);

  // Verify DB record is gone
  const dbCheck = db.prepare('SELECT 1 FROM chunk_attachments WHERE id=?').get(attachmentId);
  assert.equal(dbCheck, undefined);
});

test('RAG chat: prepareChat includes chunk attachments and instructs Gemini', async (t) => {
  const { db, gemini, config } = await harness(t);
  const { prepareChat } = await import('../server/services/chat.mjs');
  const { setSetting } = await import('../server/db/index.mjs');
  const { embeddingProfile } = await import('../server/services/gemini.mjs');
  const { seal } = await import('../server/lib/secrets.mjs');

  // Set chat model and encrypted Gemini API key
  setSetting(
    db,
    'gemini_key',
    seal('test-key-not-a-real-google-key-123456789', config.encryptionKey, 'gemini-key'),
  );
  setSetting(
    db,
    'chat_model',
    JSON.stringify({
      name: 'models/gemini-test-flash',
      displayName: 'Test Flash',
      inputTokenLimit: 100000,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    }),
  );

  // Insert admin user first for foreign key
  const now = Date.now();
  db.prepare(
    "INSERT INTO users(id, issuer, subject, email, name, role, created_at, last_login_at) VALUES('user-admin', 'https://identity.example.test/', 'admin-sub', 'admin@example.test', 'Admin', 'admin', ?, ?)",
  ).run(now, now);

  // Insert ready source & chunk
  db.prepare(
    "INSERT INTO sources(id, title, type, active, status, created_by, created_at, updated_at) VALUES('src-1', 'Handbuch', 'text', 1, 'ready', 'user-admin', ?, ?)",
  ).run(now, now);

  const profile = embeddingProfile(gemini.embeddingModel());
  const vector = Buffer.alloc(768 * 4);
  const info = db
    .prepare(
      'INSERT INTO chunks(source_id, ordinal, text, location, vector, profile, title) VALUES(?, 0, ?, ?, ?, ?, ?)',
    )
    .run('src-1', 'Anleitung für Netzwerkdrucker.', 'Seite 1', vector, profile, 'Drucker-Einrichtung');
  const chunkId = Number(info.lastInsertRowid);

  // Attach a PDF file to the chunk
  db.prepare(
    'INSERT INTO chunk_attachments(id, chunk_id, filename, original_name, mime_type, size, created_at) VALUES(?,?,?,?,?,?,?)',
  ).run('att-doc-1', chunkId, 'att-doc-1.pdf', 'Drucker-Treiber.pdf', 'application/pdf', 1048576, now);

  // Mock retriever that returns this chunk
  const mockRetriever = {
    search: async () => [
      {
        id: chunkId,
        source_id: 'src-1',
        title: 'Handbuch',
        chunk_title: 'Drucker-Einrichtung',
        location: 'Seite 1',
        text: 'Anleitung für Netzwerkdrucker.',
        score: 0.95,
      },
    ],
  };

  const messages = [{ role: 'user', text: 'Wie richte ich den Drucker ein?' }];
  const result = await prepareChat(db, gemini, mockRetriever, messages, null, config);

  assert.equal(result.sources.length, 1);
  const source = result.sources[0];
  assert.equal(source.attachments.length, 1);
  assert.equal(source.attachments[0].name, 'Drucker-Treiber.pdf');
  assert.equal(source.attachments[0].isImage, false);
  assert.ok(source.attachments[0].url.includes('Drucker-Treiber.pdf'));

  // Verify system instruction mentions attachments and instructs formatting
  const systemPrompt = result.body.systemInstruction.parts[0].text;
  assert.ok(systemPrompt.includes('BILDER UND DATEIEN ANZEIGEN & HERVORHOLEN:'));
  assert.ok(systemPrompt.includes('Drucker-Treiber.pdf'));
});
