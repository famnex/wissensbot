import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { requireRole } from '../auth.mjs';
import { audit } from '../db/index.mjs';
import { AppError } from '../lib/errors.mjs';

export function inboxRoutes(db) {
  const router = Router();
  router.use(requireRole('admin', 'editor'));

  router.get('/', (req, res) => {
    const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
    const size = Math.max(1, Math.min(100, Number(req.query.pageSize) || 25));
    const status = String(req.query.status || 'all').toLowerCase();
    const query = String(req.query.q || '').slice(0, 150);

    const conditions = [];
    const params = [];

    if (['open', 'resolved', 'dismissed'].includes(status)) {
      conditions.push('status = ?');
      params.push(status);
    }

    if (query) {
      const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push("(question LIKE ? ESCAPE '\\' OR asked_by_name LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const items = db
      .prepare(
        `SELECT id, question, answer, asked_by, asked_by_name, count, status, note, created_at, updated_at
         FROM inbox
         ${whereClause}
         ORDER BY (CASE status WHEN 'open' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END), updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, size, (page - 1) * size);

    const total = db
      .prepare(`SELECT count(*) n FROM inbox ${whereClause}`)
      .get(...params).n;

    const openCount = db
      .prepare("SELECT count(*) n FROM inbox WHERE status = 'open'")
      .get().n;

    const resolvedCount = db
      .prepare("SELECT count(*) n FROM inbox WHERE status = 'resolved'")
      .get().n;

    const dismissedCount = db
      .prepare("SELECT count(*) n FROM inbox WHERE status = 'dismissed'")
      .get().n;

    res.json({
      items,
      total,
      openCount,
      resolvedCount,
      dismissedCount,
      page,
      pageSize: size,
    });
  });

  router.get('/count', (req, res) => {
    const openCount = db
      .prepare("SELECT count(*) n FROM inbox WHERE status = 'open'")
      .get().n;
    res.json({ openCount });
  });

  router.post('/', (req, res) => {
    const value = z
      .object({
        question: z.string().trim().min(1).max(2000),
        answer: z.string().trim().max(10000).optional(),
        note: z.string().trim().max(1000).optional(),
      })
      .strict()
      .parse(req.body);

    const now = Date.now();
    const existing = db
      .prepare('SELECT * FROM inbox WHERE question = ? AND status = ?')
      .get(value.question, 'open');

    if (existing) {
      db.prepare(
        'UPDATE inbox SET count = count + 1, answer = COALESCE(?, answer), note = COALESCE(?, note), updated_at = ? WHERE id = ?',
      ).run(value.answer || null, value.note || null, now, existing.id);
      const updated = db.prepare('SELECT * FROM inbox WHERE id = ?').get(existing.id);
      res.json(updated);
      return;
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO inbox(id, question, answer, asked_by, asked_by_name, count, status, note, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, 1, 'open', ?, ?, ?)`,
    ).run(
      id,
      value.question,
      value.answer || null,
      req.user.id,
      req.user.name,
      value.note || null,
      now,
      now,
    );

    audit(db, req.user.id, 'inbox_created', id);

    const created = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
    res.status(201).json(created);
  });

  router.patch('/:id', (req, res) => {
    const value = z
      .object({
        status: z.enum(['open', 'resolved', 'dismissed']).optional(),
        note: z.string().trim().max(1000).optional(),
      })
      .strict()
      .refine((data) => data.status !== undefined || data.note !== undefined, {
        message: 'Status oder Notiz muss angegeben werden.',
      })
      .parse(req.body);

    const existing = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Eintrag nicht gefunden.');

    const newStatus = value.status !== undefined ? value.status : existing.status;
    const newNote = value.note !== undefined ? value.note : existing.note;
    const now = Date.now();

    db.prepare('UPDATE inbox SET status = ?, note = ?, updated_at = ? WHERE id = ?').run(
      newStatus,
      newNote,
      now,
      existing.id,
    );

    if (value.status && value.status !== existing.status) {
      audit(db, req.user.id, `inbox_status_${value.status}`, existing.id);
    }

    const updated = db.prepare('SELECT * FROM inbox WHERE id = ?').get(existing.id);
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Eintrag nicht gefunden.');

    db.prepare('DELETE FROM inbox WHERE id = ?').run(existing.id);
    audit(db, req.user.id, 'inbox_deleted', existing.id);

    res.json({ ok: true, deleted: true });
  });

  return router;
}
