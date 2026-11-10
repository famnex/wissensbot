import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireRole } from '../auth.mjs';
import { createSource, enqueue } from '../services/jobs.mjs';
import { validateUrl } from '../services/safe-fetch.mjs';
import { audit } from '../db/index.mjs';
import { AppError } from '../lib/errors.mjs';
import { deriveChunkTitle } from '../services/chunking.mjs';
import { embeddingProfile, vectorToBuffer, Gemini } from '../services/gemini.mjs';

export function knowledgeRoutes(db, config, gemini = new Gemini(db, config)) {
  const router = Router();
  router.use(requireRole('admin', 'editor'));
  router.get('/', (req, res) => {
    const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
    const size = 25;
    const query = String(req.query.q || '').slice(0, 150);
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const where = "WHERE s.title LIKE ? ESCAPE '\\'";
    const sources = db
      .prepare(
        `SELECT s.id,s.title,s.type,s.reference,s.active,s.status,s.error,s.warning,s.chunk_count,s.created_at,s.updated_at,
      (SELECT stage FROM jobs WHERE source_id=s.id ORDER BY created_at DESC LIMIT 1) stage,
      (SELECT progress FROM jobs WHERE source_id=s.id ORDER BY created_at DESC LIMIT 1) progress
      FROM sources s ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(pattern, size, (page - 1) * size);
    const total = db.prepare(`SELECT count(*) n FROM sources s ${where}`).get(pattern).n;
    res.json({ sources, total, page, pageSize: size });
  });
  router.post('/text', (req, res) => {
    const value = z
      .object({
        title: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(200000),
      })
      .strict()
      .parse(req.body);
    res.status(202).json(
      createSource(db, req.user.id, {
        title: value.title,
        type: 'text',
        documents: [{ text: value.text, location: 'Wissensnotiz' }],
      }),
    );
  });
  router.post('/url', (req, res) => {
    const value = z
      .object({ title: z.string().trim().max(200).optional(), url: z.string().max(2000) })
      .strict()
      .parse(req.body);
    const url = validateUrl(value.url).href;
    res.status(202).json(
      createSource(db, req.user.id, {
        title: value.title || new URL(url).hostname,
        type: 'url',
        reference: url,
      }),
    );
  });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
    }),
    limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 1, parts: 3, fieldSize: 1000 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md', '.sql', '.json'];
      cb(
        allowed.includes(path.extname(file.originalname).toLowerCase())
          ? null
          : new AppError(
              415,
              'FILE_TYPE',
              'Erlaubt sind PDF, DOCX, XLSX, CSV, TXT, Markdown, SQL und JSON.',
            ),
        true,
      );
    },
  });
  router.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) throw new AppError(400, 'FILE_MISSING', 'Bitte eine Datei auswählen.');
    try {
      const title = z
        .string()
        .trim()
        .min(1)
        .max(200)
        .parse(req.body.title || req.file.originalname);
      const result = createSource(db, req.user.id, {
        title,
        type: 'file',
        reference: path.basename(req.file.originalname),
        payload: { filename: req.file.filename },
      });
      res.status(202).json(result);
    } catch (error) {
      await fs.rm(req.file.path, { force: true });
      throw error;
    }
  });
  router.get('/export', (req, res) => {
    const sources = db
      .prepare(
        'SELECT id, title, type, reference, documents_json, active, created_at, updated_at FROM sources ORDER BY created_at ASC',
      )
      .all();
    const allChunks = db
      .prepare(
        'SELECT source_id, ordinal, title, location, url, text FROM chunks ORDER BY source_id, ordinal ASC',
      )
      .all();

    const chunksBySource = new Map();
    for (const c of allChunks) {
      if (!chunksBySource.has(c.source_id)) chunksBySource.set(c.source_id, []);
      chunksBySource.get(c.source_id).push({
        ordinal: c.ordinal,
        title: c.title,
        location: c.location,
        url: c.url,
        text: c.text,
      });
    }

    const payload = {
      $schema: 'https://wissensraum.app/schema/export-v1.json',
      version: 1,
      exported_at: Date.now(),
      sources: sources.map((s) => ({
        title: s.title,
        type: s.type,
        reference: s.reference,
        active: Boolean(s.active),
        documents: s.documents_json ? JSON.parse(s.documents_json) : null,
        chunks: chunksBySource.get(s.id) || [],
      })),
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="wissensraum-export-all-${dateStr}.json"`,
    );
    res.json(payload);
  });

  router.post('/import', upload.single('file'), async (req, res) => {
    let raw;
    try {
      if (req.file) {
        raw = await fs.readFile(req.file.path, 'utf8');
      } else if (req.body) {
        raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      } else {
        throw new AppError(400, 'FILE_MISSING', 'Bitte eine JSON-Exportdatei auswählen.');
      }
    } finally {
      if (req.file) {
        await fs.rm(req.file.path, { force: true });
      }
    }

    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      throw new AppError(400, 'INVALID_JSON', 'Die hochgeladene Datei enthält kein gültiges JSON.');
    }

    let rawSources;
    if (Array.isArray(parsed)) {
      rawSources = parsed;
    } else if (parsed && Array.isArray(parsed.sources)) {
      rawSources = parsed.sources;
    } else if (parsed && typeof parsed.title === 'string') {
      rawSources = [parsed];
    } else {
      throw new AppError(400, 'INVALID_FORMAT', 'Im Export wurden keine gültigen Quellen gefunden.');
    }

    if (rawSources.length === 0) {
      throw new AppError(400, 'EMPTY_IMPORT', 'Die Datei enthält keine Quellen zum Importieren.');
    }

    let model = null;
    let profile = 'imported';
    let canEmbed = false;
    if (gemini) {
      try {
        gemini.key();
        model = gemini.embeddingModel();
        profile = embeddingProfile(model);
        canEmbed = true;
      } catch (err) {
        console.warn('Embedding disabled during import:', err.message);
      }
    }

    const imported = [];
    for (const item of rawSources) {
      const title =
        String(item.title || 'Importierte Quelle').trim().slice(0, 200) || 'Importierte Quelle';
      const type = ['text', 'file', 'url'].includes(item.type) ? item.type : 'text';
      const reference = item.reference ? String(item.reference).trim().slice(0, 2000) : null;
      const documents = Array.isArray(item.documents) ? item.documents : null;
      const rawChunks = Array.isArray(item.chunks) ? item.chunks : [];

      const sourceId = randomUUID();
      const now = Date.now();

      if (rawChunks.length > 0) {
        const chunksToInsert = rawChunks
          .map((c, idx) => ({
            ordinal: typeof c.ordinal === 'number' ? c.ordinal : idx,
            title: c.title
              ? String(c.title).trim().slice(0, 200)
              : deriveChunkTitle(c.text || '', c.location, idx),
            location: c.location
              ? String(c.location).trim().slice(0, 200)
              : type === 'url'
                ? 'Webseite'
                : 'Import',
            url: c.url ? String(c.url).trim().slice(0, 2000) : type === 'url' ? reference : null,
            text: String(c.text || '').trim(),
          }))
          .filter((c) => c.text.length > 0);

        if (chunksToInsert.length === 0) {
          continue;
        }

        const vectors = [];
        if (canEmbed) {
          try {
            for (let i = 0; i < chunksToInsert.length; i += 24) {
              const batch = chunksToInsert.slice(i, i + 24);
              const batchVectors = await gemini.embed(
                batch.map((c) => ({ text: c.text, title })),
                { model },
              );
              vectors.push(...batchVectors);
            }
          } catch (embedErr) {
            console.warn(
              'Batch embedding failed during import, using fallback vectors:',
              embedErr.message,
            );
          }
        }

        const docsJson = documents
          ? JSON.stringify(documents)
          : JSON.stringify(
              chunksToInsert.map((c) => ({ text: c.text, location: c.location, url: c.url })),
            );

        db.transaction(() => {
          db.prepare(
            `INSERT INTO sources(id,title,type,reference,active,status,documents_json,chunk_count,created_by,created_at,updated_at)
             VALUES(?,?,?,?,1,'ready',?,?,?,?,?)`,
          ).run(
            sourceId,
            title,
            type,
            reference,
            docsJson,
            chunksToInsert.length,
            req.user.id,
            now,
            now,
          );

          const insertChunk = db.prepare(
            'INSERT INTO chunks(source_id, ordinal, title, location, url, text, vector, profile) VALUES(?,?,?,?,?,?,?,?)',
          );

          for (let i = 0; i < chunksToInsert.length; i++) {
            const c = chunksToInsert[i];
            const vec = vectors[i] ? vectorToBuffer(vectors[i]) : Buffer.alloc(768 * 4);
            const prof = vectors[i] ? profile : 'imported';
            insertChunk.run(sourceId, c.ordinal, c.title, c.location, c.url, c.text, vec, prof);
          }

          audit(db, req.user.id, 'source_imported', sourceId);
        })();

        imported.push({ id: sourceId, title, chunk_count: chunksToInsert.length });
      } else if (documents && documents.length > 0) {
        const result = createSource(db, req.user.id, {
          title,
          type,
          reference,
          documents,
        });
        imported.push({ id: result.id, title, chunk_count: 0 });
      } else if (type === 'url' && reference) {
        const result = createSource(db, req.user.id, {
          title,
          type: 'url',
          reference,
        });
        imported.push({ id: result.id, title, chunk_count: 0 });
      }
    }

    res.status(201).json({
      ok: true,
      importedCount: imported.length,
      sources: imported,
    });
  });

  router.get('/:id/export', (req, res) => {
    const source = db
      .prepare(
        'SELECT id, title, type, reference, documents_json, active, created_at, updated_at FROM sources WHERE id=?',
      )
      .get(req.params.id);
    if (!source) throw new AppError(404, 'NOT_FOUND', 'Quelle nicht gefunden.');

    const chunks = db
      .prepare(
        'SELECT ordinal, title, location, url, text FROM chunks WHERE source_id=? ORDER BY ordinal ASC',
      )
      .all(source.id);

    const payload = {
      $schema: 'https://wissensraum.app/schema/export-v1.json',
      version: 1,
      exported_at: Date.now(),
      sources: [
        {
          title: source.title,
          type: source.type,
          reference: source.reference,
          active: Boolean(source.active),
          documents: source.documents_json ? JSON.parse(source.documents_json) : null,
          chunks: chunks.map((c) => ({
            ordinal: c.ordinal,
            title: c.title,
            location: c.location,
            url: c.url,
            text: c.text,
          })),
        },
      ],
    };

    const sanitizedTitle =
      source.title.toLowerCase().replace(/[^a-z0-9_-]/gi, '_').slice(0, 50) || 'quelle';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="wissensraum-${sanitizedTitle}.json"`,
    );
    res.json(payload);
  });

  router.patch('/:id', (req, res) => {
    const value = z
      .object({
        active: z.boolean().optional(),
        title: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .refine((data) => data.active !== undefined || data.title !== undefined, {
        message: 'Mindestens active oder title muss angegeben werden.',
      })
      .parse(req.body);

    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(req.params.id);
    if (!source) throw new AppError(404, 'NOT_FOUND', 'Quelle nicht gefunden.');

    const newActive = value.active !== undefined ? Number(value.active) : source.active;
    const newTitle = value.title !== undefined ? value.title : source.title;

    db.prepare('UPDATE sources SET active=?,title=?,updated_at=? WHERE id=?').run(
      newActive,
      newTitle,
      Date.now(),
      source.id,
    );

    if (value.active !== undefined && value.active !== Boolean(source.active)) {
      audit(db, req.user.id, value.active ? 'source_enabled' : 'source_disabled', source.id);
    }
    if (value.title !== undefined && value.title !== source.title) {
      audit(db, req.user.id, 'source_renamed', source.id);
    }

    const updated = db
      .prepare('SELECT id,title,type,reference,active,status,chunk_count FROM sources WHERE id=?')
      .get(source.id);
    res.json({ ok: true, source: updated });
  });
  router.post('/:id/reindex', (req, res) => {
    db.transaction(() => {
      const source = db.prepare('SELECT * FROM sources WHERE id=?').get(req.params.id);
      if (!source) throw new AppError(404, 'NOT_FOUND', 'Quelle nicht gefunden.');
      if (
        db
          .prepare("SELECT 1 FROM jobs WHERE source_id=? AND status IN ('queued','processing')")
          .get(source.id)
      )
        throw new AppError(409, 'JOB_ACTIVE', 'Diese Quelle wird bereits verarbeitet.');
      const previous = db
        .prepare('SELECT payload FROM jobs WHERE source_id=? ORDER BY created_at DESC LIMIT 1')
        .get(source.id);
      enqueue(
        db,
        source.id,
        source.documents_json ? 'reindex' : 'ingest',
        previous ? JSON.parse(previous.payload) : {},
      );
      db.prepare("UPDATE sources SET status='queued',error=NULL,updated_at=? WHERE id=?").run(
        Date.now(),
        source.id,
      );
      audit(db, req.user.id, 'source_reindex', source.id);
    }).immediate();
    res.status(202).json({ ok: true });
  });
  router.delete('/:id', async (req, res) => {
    const payloads = db.prepare('SELECT payload FROM jobs WHERE source_id=?').all(req.params.id);
    const attachments = db
      .prepare(
        'SELECT a.filename FROM chunk_attachments a JOIN chunks c ON a.chunk_id=c.id WHERE c.source_id=?',
      )
      .all(req.params.id);
    const deleted = db
      .transaction(() => {
        const changed = db.prepare('DELETE FROM sources WHERE id=?').run(req.params.id).changes;
        if (changed) audit(db, req.user.id, 'source_deleted', req.params.id);
        return changed;
      })
      .immediate();
    if (!deleted) throw new AppError(404, 'NOT_FOUND', 'Quelle nicht gefunden.');
    for (const row of payloads) {
      const { filename } = JSON.parse(row.payload);
      if (filename && /^[a-f0-9-]+\.upload$/.test(filename))
        await fs.rm(path.join(config.uploadDir, filename), { force: true });
    }
    for (const att of attachments) {
      if (att.filename)
        await fs.rm(path.join(config.attachmentsDir, att.filename), { force: true });
    }
    res.json({ ok: true });
  });
  router.get('/:id/chunks', (req, res) => {
    const source = db
      .prepare('SELECT id,title,status,chunk_count FROM sources WHERE id=?')
      .get(req.params.id);
    if (!source) throw new AppError(404, 'NOT_FOUND', 'Quelle nicht gefunden.');
    const chunks = db
      .prepare(
        'SELECT id, source_id, ordinal, title, location, url, text, profile, length(text) as char_count, length(text) as length FROM chunks WHERE source_id=? ORDER BY ordinal ASC',
      )
      .all(source.id);
    const chunkIds = chunks.map((c) => c.id);
    const attachmentsByChunk = new Map();
    if (chunkIds.length > 0) {
      const allAttachments = db
        .prepare(
          `SELECT id, chunk_id, filename, original_name, mime_type, size, created_at FROM chunk_attachments WHERE chunk_id IN (${chunkIds.map(() => '?').join(',')}) ORDER BY created_at ASC`,
        )
        .all(...chunkIds);
      for (const att of allAttachments) {
        if (!attachmentsByChunk.has(att.chunk_id)) attachmentsByChunk.set(att.chunk_id, []);
        attachmentsByChunk.get(att.chunk_id).push(att);
      }
    }
    for (const c of chunks) {
      c.attachments = attachmentsByChunk.get(c.id) || [];
    }
    res.json({ source, chunks });
  });
  router.post('/:id/chunks', async (req, res) => {
    const value = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        text: z.string().trim().min(1).max(50000),
        location: z.string().trim().max(200).optional(),
      })
      .strict()
      .parse(req.body);

    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(req.params.id);
    if (!source) throw new AppError(404, 'NOT_FOUND', 'Quelle nicht gefunden.');

    const maxOrdinalRow = db
      .prepare('SELECT max(ordinal) as max_ord FROM chunks WHERE source_id=?')
      .get(source.id);
    const nextOrdinal = (maxOrdinalRow?.max_ord ?? -1) + 1;

    const title = value.title || deriveChunkTitle(value.text, value.location, nextOrdinal);
    const location = value.location || 'Ergänzung';

    let vectorBuffer = null;
    let profile = 'manual';

    if (gemini) {
      try {
        gemini.key();
        const model = gemini.embeddingModel();
        profile = embeddingProfile(model);
        const [vector] = await gemini.embed([{ text: value.text, title: source.title }], { model });
        if (vector) vectorBuffer = vectorToBuffer(vector);
      } catch (err) {
        console.warn('Embedding calculation deferred/failed:', err.message);
      }
    }

    if (!vectorBuffer) {
      vectorBuffer = Buffer.alloc(768 * 4);
    }

    let insertedId;
    db.transaction(() => {
      const info = db
        .prepare(
          'INSERT INTO chunks(source_id, ordinal, title, location, url, text, vector, profile) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(source.id, nextOrdinal, title, location, null, value.text, vectorBuffer, profile);
      insertedId = Number(info.lastInsertRowid);
      const remainingCount = db
        .prepare('SELECT count(*) n FROM chunks WHERE source_id=?')
        .get(source.id).n;
      db.prepare('UPDATE sources SET chunk_count=?, updated_at=? WHERE id=?').run(
        remainingCount,
        Date.now(),
        source.id,
      );
      audit(db, req.user.id, 'chunk_created', insertedId);
    })();

    const created = db
      .prepare(
        'SELECT id, source_id, ordinal, title, location, url, text, profile, length(text) as length FROM chunks WHERE id=?',
      )
      .get(insertedId);
    res.status(201).json({ chunk: created });
  });
  router.patch('/:id/chunks/:chunkId', async (req, res) => {
    const value = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        text: z.string().trim().min(1).max(50000).optional(),
        location: z.string().trim().max(200).optional(),
      })
      .strict()
      .parse(req.body);

    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(req.params.id);
    if (!source) throw new AppError(404, 'NOT_FOUND', 'Quelle nicht gefunden.');

    const chunk = db
      .prepare('SELECT * FROM chunks WHERE id=? AND source_id=?')
      .get(req.params.chunkId, source.id);
    if (!chunk) throw new AppError(404, 'NOT_FOUND', 'Wissensabschnitt nicht gefunden.');

    const newTitle = value.title !== undefined ? value.title : chunk.title;
    const newText = value.text !== undefined ? value.text : chunk.text;
    const newLocation = value.location !== undefined ? value.location : chunk.location;

    let newVectorBuffer = null;
    let newProfile = chunk.profile;

    if (value.text && value.text !== chunk.text && gemini) {
      try {
        gemini.key();
        const model = gemini.embeddingModel();
        newProfile = embeddingProfile(model);
        const [vector] = await gemini.embed([{ text: newText, title: source.title }], { model });
        if (vector) newVectorBuffer = vectorToBuffer(vector);
      } catch (err) {
        console.warn('Embedding update deferred/failed:', err.message);
      }
    }

    db.transaction(() => {
      if (newVectorBuffer) {
        db.prepare(
          'UPDATE chunks SET title=?, text=?, location=?, vector=?, profile=? WHERE id=?',
        ).run(newTitle, newText, newLocation, newVectorBuffer, newProfile, chunk.id);
      } else {
        db.prepare('UPDATE chunks SET title=?, text=?, location=? WHERE id=?').run(
          newTitle,
          newText,
          newLocation,
          chunk.id,
        );
      }
      db.prepare('UPDATE sources SET updated_at=? WHERE id=?').run(Date.now(), source.id);
      audit(db, req.user.id, 'chunk_updated', chunk.id);
    })();

    const updated = db
      .prepare(
        'SELECT id, source_id, ordinal, title, location, url, text, profile, length(text) as length FROM chunks WHERE id=?',
      )
      .get(chunk.id);
    res.json({ chunk: updated });
  });
  router.delete('/:id/chunks/:chunkId', async (req, res) => {
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(req.params.id);
    if (!source) throw new AppError(404, 'NOT_FOUND', 'Quelle nicht gefunden.');

    const chunk = db
      .prepare('SELECT * FROM chunks WHERE id=? AND source_id=?')
      .get(req.params.chunkId, source.id);
    if (!chunk) throw new AppError(404, 'NOT_FOUND', 'Wissensabschnitt nicht gefunden.');

    const attachments = db
      .prepare('SELECT filename FROM chunk_attachments WHERE chunk_id=?')
      .all(chunk.id);

    db.transaction(() => {
      db.prepare('DELETE FROM chunks WHERE id=?').run(chunk.id);
      const remainingCount = db
        .prepare('SELECT count(*) n FROM chunks WHERE source_id=?')
        .get(source.id).n;
      db.prepare('UPDATE sources SET chunk_count=?, updated_at=? WHERE id=?').run(
        remainingCount,
        Date.now(),
        source.id,
      );
      audit(db, req.user.id, 'chunk_deleted', chunk.id);
    })();

    for (const att of attachments) {
      if (att.filename)
        await fs.rm(path.join(config.attachmentsDir, att.filename), { force: true });
    }

    res.json({ ok: true, deleted: true, chunkId: chunk.id });
  });

  const attachmentUpload = multer({
    storage: multer.diskStorage({
      destination: config.attachmentsDir,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).slice(0, 16);
        cb(null, `${randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: config.uploadMaxBytes, files: 1 },
  });

  router.get(
    ['/:chunkId/attachments', '/chunks/:chunkId/attachments', '/:id/chunks/:chunkId/attachments'],
    (req, res) => {
      const chunkId = Number(req.params.chunkId);
      const chunk = db.prepare('SELECT id, source_id FROM chunks WHERE id=?').get(chunkId);
      if (!chunk) throw new AppError(404, 'NOT_FOUND', 'Wissensabschnitt nicht gefunden.');
      const attachments = db
        .prepare(
          'SELECT id, chunk_id, filename, original_name, mime_type, size, created_at FROM chunk_attachments WHERE chunk_id=? ORDER BY created_at ASC',
        )
        .all(chunkId);
      res.json({ attachments });
    },
  );

  router.post(
    ['/:chunkId/attachments', '/chunks/:chunkId/attachments', '/:id/chunks/:chunkId/attachments'],
    attachmentUpload.single('file'),
    async (req, res) => {
      const chunkId = Number(req.params.chunkId);
      const chunk = db.prepare('SELECT id, source_id FROM chunks WHERE id=?').get(chunkId);
      if (!chunk) {
        if (req.file) await fs.rm(req.file.path, { force: true });
        throw new AppError(404, 'NOT_FOUND', 'Wissensabschnitt nicht gefunden.');
      }
      if (!req.file)
        throw new AppError(400, 'FILE_MISSING', 'Bitte eine Datei zum Anhängen auswählen.');

      const attachmentId = randomUUID();
      const storedFilename = req.file.filename;
      const originalName = req.file.originalname.slice(0, 255);
      const mimeType = req.file.mimetype || 'application/octet-stream';
      const size = req.file.size;
      const now = Date.now();

      db.prepare(
        'INSERT INTO chunk_attachments(id, chunk_id, filename, original_name, mime_type, size, created_at) VALUES(?,?,?,?,?,?,?)',
      ).run(attachmentId, chunk.id, storedFilename, originalName, mimeType, size, now);

      audit(db, req.user.id, 'chunk_attachment_created', attachmentId);

      const attachment = db
        .prepare(
          'SELECT id, chunk_id, filename, original_name, mime_type, size, created_at FROM chunk_attachments WHERE id=?',
        )
        .get(attachmentId);

      res.status(201).json({ attachment });
    },
  );

  router.delete('/attachments/:id', async (req, res) => {
    const attachment = db
      .prepare('SELECT * FROM chunk_attachments WHERE id=?')
      .get(req.params.id);
    if (!attachment) throw new AppError(404, 'NOT_FOUND', 'Anhang nicht gefunden.');

    db.prepare('DELETE FROM chunk_attachments WHERE id=?').run(attachment.id);
    if (attachment.filename) {
      await fs.rm(path.join(config.attachmentsDir, attachment.filename), { force: true });
    }
    audit(db, req.user.id, 'chunk_attachment_deleted', attachment.id);
    res.json({ ok: true, deleted: true, id: attachment.id });
  });

  return router;
}
