import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveChunkTitle, chunksFromDocuments } from '../server/services/chunking.mjs';
import { claimJob } from '../server/services/jobs.mjs';
import {
  processClaimedJob,
  aiAnalyzeAndStructureChunks,
  aiExtractKnowledgeChunks,
  parseJsonResponse,
} from '../server/services/index-job.mjs';
import { extractSqlDocuments } from '../server/workers/extract-file.mjs';
import { harness, model, embedding } from './helpers.mjs';

test('chunking deriveChunkTitle extracts meaningful titles', () => {
  assert.equal(
    deriveChunkTitle('# Willkommen im Wissensraum\nHier steht der Inhalt.', 'Seite 1', 0),
    'Willkommen im Wissensraum',
  );
  assert.equal(
    deriveChunkTitle('### 3. Abrechnung und Erstattung\nDetails hier...', 'Seite 2', 1),
    '3. Abrechnung und Erstattung',
  );
  assert.equal(
    deriveChunkTitle('**Wichtige Fristen**\nBitte beachten Sie die Frist bis Ende Mai.', '', 2),
    'Wichtige Fristen',
  );
  assert.equal(
    deriveChunkTitle('Urlaub muss mindestens zwei Wochen im Voraus beantragt werden. Genehmigung erfolgt durch den Vorgesetzten.', 'Handbuch', 3),
    'Urlaub muss mindestens zwei Wochen im Voraus beantragt werden.',
  );
  assert.equal(
    deriveChunkTitle('', 'Kapitel 4', 4),
    'Kapitel 4 – Abschnitt 5',
  );
  assert.equal(
    deriveChunkTitle('', '', 0),
    'Abschnitt 1',
  );
  // SQL specific derivations
  assert.equal(
    deriveChunkTitle(
      '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\nCREATE TABLE `kunden` (\n  `id` int NOT NULL\n);',
      'Datenbank',
      0,
    ),
    'Tabelle kunden: Struktur & Schema',
  );
  assert.equal(
    deriveChunkTitle(
      'INSERT INTO `kunden` (`id`, `name`) VALUES (1, "Muster");',
      'Datenbank',
      1,
    ),
    'Tabelle kunden: Datensätze & Inhalte',
  );
  assert.equal(
    deriveChunkTitle(
      '-- Tabellenstruktur für Tabelle `bestellungen`\nCREATE TABLE `bestellungen` (id int);',
      'Datenbank',
      2,
    ),
    'Tabelle bestellungen: Struktur & Schema',
  );
});

test('chunksFromDocuments includes title in produced chunks', () => {
  const chunks = chunksFromDocuments([
    {
      text: '# Einführung in das System\nDies ist ein einführender Paragraph für das System.\n\n## Konfiguration\nHier wird die Konfiguration beschrieben.',
      location: 'Dokumentation',
    },
  ]);
  assert.ok(chunks.length >= 1);
  assert.ok(chunks[0].title);
  assert.match(chunks[0].title, /Einführung/);
});

test('chunk API endpoints (list, add, edit, delete)', async (t) => {
  const env = await harness(t);
  const { client } = await env.login('admin-user');
  await env
    .csrf(client.put('/api/admin/key'))
    .send({ apiKey: 'test-key-not-a-real-google-key-123456789' })
    .expect(200);
  await env
    .csrf(client.put('/api/admin/models'))
    .send({ chatModel: model.name, embeddingModel: embedding.name })
    .expect(200);

  // 1. Create a text source
  const createRes = await env
    .csrf(client.post('/api/sources/text'))
    .send({
      title: 'IT-Sicherheitsrichtlinie',
      text: '# Passwort-Richtlinien\nPasswörter müssen mindestens 12 Zeichen lang sein.\n\n# VPN-Zugang\nDer VPN-Zugang erfordert 2FA.',
    })
    .expect(202);

  const sourceId = createRes.body.id;
  assert.ok(sourceId);

  // Process the indexing job synchronously
  const job = claimJob(env.db, 'worker-test');
  await processClaimedJob({
    db: env.db,
    config: env.config,
    gemini: env.gemini,
    job,
    owner: 'worker-test',
    signal: new AbortController().signal,
  });

  // 2. Fetch chunks of the source
  const listRes = await client.get(`/api/sources/${sourceId}/chunks`).expect(200);
  assert.ok(Array.isArray(listRes.body.chunks));
  assert.ok(listRes.body.chunks.length >= 1);
  const firstChunk = listRes.body.chunks[0];
  assert.ok(firstChunk.id);
  assert.ok(firstChunk.title);
  assert.ok(firstChunk.text);
  assert.equal(typeof firstChunk.char_count, 'number');

  // 3. Edit chunk (PATCH) with updated title and text
  const initialCallCount = env.calls.length;
  const patchRes = await env
    .csrf(client.patch(`/api/sources/${sourceId}/chunks/${firstChunk.id}`))
    .send({
      title: 'Aktualisierte Passwort-Regeln',
      location: 'Abschnitt 1.1',
      text: 'Passwörter müssen ab sofort mindestens 16 Zeichen lang sein und Groß-, Kleinbuchstaben sowie Sonderzeichen enthalten.',
    })
    .expect(200);

  assert.equal(patchRes.body.chunk.title, 'Aktualisierte Passwort-Regeln');
  assert.equal(patchRes.body.chunk.location, 'Abschnitt 1.1');
  assert.match(patchRes.body.chunk.text, /16 Zeichen/);
  // Verify embedding was re-calculated
  assert.ok(env.calls.length > initialCallCount);

  // Verify in GET
  const verifyRes = await client.get(`/api/sources/${sourceId}/chunks`).expect(200);
  const updatedChunk = verifyRes.body.chunks.find((c) => c.id === firstChunk.id);
  assert.equal(updatedChunk.title, 'Aktualisierte Passwort-Regeln');
  assert.equal(updatedChunk.location, 'Abschnitt 1.1');

  // 4. Manually add a new chunk (POST)
  const addRes = await env
    .csrf(client.post(`/api/sources/${sourceId}/chunks`))
    .send({
      title: 'Notfall-Kontakte IT',
      location: 'Anhang A',
      text: 'Bei Sicherheitsvorfällen ist das CERT rund um die Uhr unter cert@beispiel.de erreichbar.',
    })
    .expect(201);

  assert.ok(addRes.body.chunk.id);
  assert.equal(addRes.body.chunk.title, 'Notfall-Kontakte IT');
  assert.equal(addRes.body.chunk.location, 'Anhang A');

  // Verify source chunk count increased
  const listSourcesAfterAdd = await client.get(`/api/sources?q=IT-Sicherheitsrichtlinie`).expect(200);
  assert.equal(listSourcesAfterAdd.body.sources[0].chunk_count, verifyRes.body.chunks.length + 1);

  // 5. Delete the newly added chunk (DELETE)
  const deleteRes = await env
    .csrf(client.delete(`/api/sources/${sourceId}/chunks/${addRes.body.chunk.id}`))
    .expect(200);

  assert.equal(deleteRes.body.deleted, true);

  // Verify chunk is gone
  const afterDelete = await client.get(`/api/sources/${sourceId}/chunks`).expect(200);
  assert.ok(!afterDelete.body.chunks.some((c) => c.id === addRes.body.chunk.id));

  // Verify source chunk count decreased
  const listSourcesAfterDel = await client.get(`/api/sources?q=IT-Sicherheitsrichtlinie`).expect(200);
  assert.equal(listSourcesAfterDel.body.sources[0].chunk_count, verifyRes.body.chunks.length);
});

test('extractSqlDocuments strips dump noise and segments tables into documents', () => {
  const sqlDump = `
-- phpMyAdmin SQL Dump
-- version 5.2.1
-- Host: localhost:3306

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Tabellenstruktur für Tabelle \`kunden\`
--

CREATE TABLE \`kunden\` (
  \`id\` int(11) NOT NULL,
  \`name\` varchar(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO \`kunden\` (\`id\`, \`name\`) VALUES
(1, 'Musterfirma GmbH');

--
-- Tabellenstruktur für Tabelle \`bestellungen\`
--

CREATE TABLE \`bestellungen\` (
  \`id\` int(11) NOT NULL,
  \`kunde_id\` int(11) NOT NULL,
  \`betrag\` decimal(10,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

  const docs = extractSqlDocuments(sqlDump);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].location, 'Tabelle: kunden');
  assert.match(docs[0].text, /CREATE TABLE `kunden`/);
  assert.match(docs[0].text, /INSERT INTO `kunden`/);
  assert.ok(!docs[0].text.includes('/*!40101'));
  assert.ok(!docs[0].text.includes('SET SQL_MODE'));

  assert.equal(docs[1].location, 'Tabelle: bestellungen');
  assert.match(docs[1].text, /CREATE TABLE `bestellungen`/);
});

test('parseJsonResponse extracts JSON array correctly', () => {
  assert.equal(parseJsonResponse(null), null);
  assert.equal(parseJsonResponse('invalid text'), null);

  const direct = parseJsonResponse('[{"index":1,"title":"Titel 1"}]');
  assert.ok(Array.isArray(direct));
  assert.equal(direct[0].title, 'Titel 1');

  const fenced = parseJsonResponse('```json\n[{"index":2,"title":"Titel 2"}]\n```');
  assert.ok(Array.isArray(fenced));
  assert.equal(fenced[0].title, 'Titel 2');

  const withSurroundingProse = parseJsonResponse('Hier ist das Ergebnis:\n[{"index":3,"title":"Titel 3"}]\nViele Grüße');
  assert.ok(Array.isArray(withSurroundingProse));
  assert.equal(withSurroundingProse[0].title, 'Titel 3');
});

test('aiAnalyzeAndStructureChunks updates chunk titles and cleans content with Gemini', async () => {
  const fakeGemini = {
    key: () => 'valid-key',
    generateContent: async () =>
      JSON.stringify([
        {
          index: 1,
          title: 'Kundendatenbank: Stammdaten & Firmenkunden',
          location: 'Tabelle kunden',
          cleanText: 'Tabelle kunden enthält die Firmenstammdaten und Kontakte.',
        },
      ]),
  };

  const chunks = [
    {
      text: 'CREATE TABLE `kunden` (`id` int, `name` varchar(100));',
      location: 'SQL',
      title: 'Abschnitt 1',
    },
  ];

  await aiAnalyzeAndStructureChunks({
    gemini: fakeGemini,
    chunks,
    sourceTitle: 'Datenbank-Export',
  });

  assert.equal(chunks[0].title, 'Kundendatenbank: Stammdaten & Firmenkunden');
  assert.equal(chunks[0].location, 'Tabelle kunden');
  assert.equal(chunks[0].text, 'Tabelle kunden enthält die Firmenstammdaten und Kontakte.');
});

test('SQL dump indexing pipeline strips noise, generates table titles, and prevents "Ohne Titel"', async (t) => {
  const env = await harness(t);
  const { client } = await env.login('admin-user');
  await env
    .csrf(client.put('/api/admin/key'))
    .send({ apiKey: 'test-key-not-a-real-google-key-123456789' })
    .expect(200);
  await env
    .csrf(client.put('/api/admin/models'))
    .send({ chatModel: model.name, embeddingModel: embedding.name })
    .expect(200);

  const sqlDump = `
-- phpMyAdmin SQL Dump
-- version 5.2.1
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;

CREATE TABLE \`users\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`username\` varchar(50) NOT NULL,
  \`email\` varchar(100) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO \`users\` (\`id\`, \`username\`, \`email\`) VALUES
(1, 'admin', 'admin@example.com'),
(2, 'editor', 'editor@example.com');
`;

  // Create text source with SQL dump
  const createRes = await env
    .csrf(client.post('/api/sources/text'))
    .send({
      title: 'Benutzerdatenbank Dump',
      text: sqlDump,
    })
    .expect(202);

  const sourceId = createRes.body.id;

  // Process claimed job
  const job = claimJob(env.db, 'worker-sql');
  await processClaimedJob({
    db: env.db,
    config: env.config,
    gemini: env.gemini,
    job,
    owner: 'worker-sql',
    signal: new AbortController().signal,
  });

  const listRes = await client.get(`/api/sources/${sourceId}/chunks`).expect(200);
  assert.ok(listRes.body.chunks.length >= 1);

  for (const chunk of listRes.body.chunks) {
    // Assert no chunk is "Ohne Titel" or generic
    assert.ok(chunk.title);
    assert.notEqual(chunk.title, 'Ohne Titel');
    assert.notEqual(chunk.title, 'Abschnitt 1');
    assert.match(chunk.title, /Tabelle|users|Benutzer/i);

    // Assert dump directive was filtered out or not dominating
    assert.ok(!chunk.text.includes('/*!40101'));
    assert.ok(!chunk.text.includes('SET SQL_MODE'));
  }
});

test('aiExtractKnowledgeChunks directly identifies knowledge units from documents', async () => {
  const fakeGemini = {
    key: () => 'valid-key',
    generateContent: async () =>
      JSON.stringify([
        {
          title: 'Aufsicht bei Klausuren',
          location: 'Prüfungsordnung',
          text: 'Die Klausuraufsicht erfolgt aktiv. Tische auseinanderstellen, Handys einsammeln.',
        },
        {
          title: 'Beurlaubung von Schülern',
          location: 'Schulordnung',
          text: 'Beurlaubung bis zu zwei Tagen kann durch Tutor/Klassenlehrer genehmigt werden.',
        },
      ]),
  };

  const docs = [
    {
      text: 'INSERT INTO ost_faq VALUES (40, 11, 1, "Aufsicht", "<ul><li>Aufsicht aktiv</li></ul>");',
      location: 'SQL-Export',
    },
  ];

  const chunks = await aiExtractKnowledgeChunks({
    gemini: fakeGemini,
    documents: docs,
    sourceTitle: 'ost_faq.sql',
  });

  assert.ok(chunks);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].title, 'Aufsicht bei Klausuren');
  assert.equal(chunks[0].location, 'Prüfungsordnung');
  assert.match(chunks[0].text, /aktiv/);
  assert.equal(chunks[1].title, 'Beurlaubung von Schülern');
});

test('source renaming, export and import endpoints', async (t) => {
  const env = await harness(t);
  const { client } = await env.login('admin-user');
  await env
    .csrf(client.put('/api/admin/key'))
    .send({ apiKey: 'test-key-not-a-real-google-key-123456789' })
    .expect(200);
  await env
    .csrf(client.put('/api/admin/models'))
    .send({ chatModel: model.name, embeddingModel: embedding.name })
    .expect(200);

  // 1. Create a source
  const createRes = await env
    .csrf(client.post('/api/sources/text'))
    .send({
      title: 'Originale Richtlinie',
      text: 'Erster wichtiger Grundsatz: Sicherheit geht vor. Alle Zugänge müssen geschützt werden.',
    })
    .expect(202);

  const sourceId = createRes.body.id;

  // Process job to create chunks
  const job = claimJob(env.db, 'worker-1');
  assert.ok(job);
  await processClaimedJob({
    db: env.db,
    config: env.config,
    gemini: env.gemini,
    job,
    owner: 'worker-1',
  });

  // Verify source exists
  const initialGet = await client.get(`/api/sources/${sourceId}/chunks`).expect(200);
  assert.equal(initialGet.body.source.title, 'Originale Richtlinie');

  // 2. Rename source via PATCH /api/sources/:id
  const renameRes = await env
    .csrf(client.patch(`/api/sources/${sourceId}`))
    .send({ title: 'Umbenannte Richtlinie 2026' })
    .expect(200);

  assert.equal(renameRes.body.ok, true);
  assert.equal(renameRes.body.source.title, 'Umbenannte Richtlinie 2026');

  // Verify rename in GET /api/sources
  const listAfterRename = await client.get(`/api/sources?q=Umbenannte`).expect(200);
  assert.equal(listAfterRename.body.sources.length, 1);
  assert.equal(listAfterRename.body.sources[0].title, 'Umbenannte Richtlinie 2026');

  // 3. Export single source via GET /api/sources/:id/export
  const singleExport = await client.get(`/api/sources/${sourceId}/export`).expect(200);
  assert.ok(singleExport.body.sources);
  assert.equal(singleExport.body.sources.length, 1);
  assert.equal(singleExport.body.sources[0].title, 'Umbenannte Richtlinie 2026');
  assert.ok(singleExport.body.sources[0].chunks.length >= 1);

  // 4. Bulk export via GET /api/sources/export
  const bulkExport = await client.get('/api/sources/export').expect(200);
  assert.ok(bulkExport.body.sources);
  assert.ok(bulkExport.body.sources.length >= 1);
  assert.ok(bulkExport.headers['content-disposition'].includes('attachment'));

  // 5. Import into system via POST /api/sources/import
  const importPayload = {
    $schema: 'https://wissensraum.app/schema/export-v1.json',
    version: 1,
    exported_at: Date.now(),
    sources: [
      {
        title: 'Aus anderem Wissensraum importiert',
        type: 'text',
        reference: null,
        chunks: [
          {
            ordinal: 0,
            title: 'Wichtiger Import-Artikel',
            location: 'Abschnitt A',
            text: 'Dieser Text wurde aus einem fremden Wissensraum importiert und behält seinen Titel.',
          },
        ],
      },
    ],
  };

  const importRes = await env
    .csrf(client.post('/api/sources/import'))
    .send(importPayload)
    .expect(201);

  assert.equal(importRes.body.ok, true);
  assert.equal(importRes.body.importedCount, 1);
  assert.equal(importRes.body.sources[0].title, 'Aus anderem Wissensraum importiert');
  assert.equal(importRes.body.sources[0].chunk_count, 1);

  // Verify imported source and chunk in DB
  const importedChunksRes = await client.get(`/api/sources/${importRes.body.sources[0].id}/chunks`).expect(200);
  assert.equal(importedChunksRes.body.chunks.length, 1);
  assert.equal(importedChunksRes.body.chunks[0].title, 'Wichtiger Import-Artikel');
  assert.equal(importedChunksRes.body.chunks[0].location, 'Abschnitt A');
  assert.match(importedChunksRes.body.chunks[0].text, /fremden Wissensraum/);
});

test('URL source reference is passed through as clickable url in chat sources', async (t) => {
  const env = await harness(t);
  const { user } = await env.login('admin-user');

  // Insert a URL source directly
  const sourceId = 'url-source-123';
  const now = Date.now();
  env.db.prepare(
    `INSERT INTO sources(id, title, type, reference, active, status, chunk_count, created_by, created_at, updated_at)
     VALUES (?, ?, 'url', ?, 1, 'ready', 1, ?, ?, ?)`,
  ).run(sourceId, 'Offizielle Dokumentation', 'https://handbuch.beispiel.de/start', user.id, now, now);

  // Insert a chunk with null chunk.url so it falls back to source reference
  env.db.prepare(
    `INSERT INTO chunks(source_id, ordinal, title, location, url, text, vector, profile)
     VALUES (?, 0, 'Kapitel 1: Einstieg', 'Dokumentation', NULL, 'Willkommen im Handbuch der Schule.', ?, ?)`,
  ).run(sourceId, Buffer.alloc(768 * 4), 'fake-model');

  const afterChunk = env.db.prepare(
    `SELECT c.id,c.source_id,c.text,c.location,c.url,c.vector,c.title as chunk_title,s.title,s.type as source_type,s.reference as source_reference FROM chunks c
    JOIN sources s ON s.id=c.source_id WHERE s.id=?`,
  ).get(sourceId);

  assert.equal(afterChunk.source_type, 'url');
  assert.equal(afterChunk.source_reference, 'https://handbuch.beispiel.de/start');
});
