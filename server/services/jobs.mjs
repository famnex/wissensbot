import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors.mjs';
import { audit } from '../db/index.mjs';
export function enqueue(db, sourceId, kind = 'ingest', payload = {}) {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO jobs(id,source_id,kind,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
  ).run(id, sourceId, kind, JSON.stringify(payload), now, now);
  return id;
}
export function createSource(
  db,
  actor,
  { title, type, reference = null, documents = null, payload = {} },
) {
  return db
    .transaction(() => {
      if (
        db.prepare("SELECT count(*) n FROM jobs WHERE status IN ('queued','processing')").get().n >=
        200
      )
        throw new AppError(
          429,
          'QUEUE_FULL',
          'Die Warteschlange ist voll. Bitte später erneut versuchen.',
        );
      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        'INSERT INTO sources(id,title,type,reference,documents_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        id,
        title,
        type,
        reference,
        documents ? JSON.stringify(documents) : null,
        actor,
        now,
        now,
      );
      const jobId = enqueue(db, id, 'ingest', payload);
      audit(db, actor, 'source_created', id);
      return { id, jobId };
    })
    .immediate();
}
export function claimJob(db, owner) {
  return db
    .transaction(() => {
      const now = Date.now();
      db.prepare(
        "UPDATE jobs SET status='failed',error='Verarbeitung nach wiederholtem Prozessabbruch beendet.',stage='Fehlgeschlagen' WHERE status='processing' AND lease_until<? AND attempts>=3",
      ).run(now);
      db.prepare(
        "UPDATE sources SET status='error',error='Verarbeitung wurde wiederholt unterbrochen. Bitte erneut indexieren.' WHERE status='indexing' AND id IN (SELECT source_id FROM jobs WHERE status='failed') AND id NOT IN (SELECT source_id FROM jobs WHERE status IN ('queued','processing'))",
      ).run();
      db.prepare(
        "UPDATE jobs SET status='queued',lease_owner=NULL,lease_until=NULL WHERE status='processing' AND lease_until<? AND attempts<3",
      ).run(now);
      const job = db
        .prepare(
          "SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY created_at LIMIT 1",
        )
        .get(now);
      if (!job) return null;
      db.prepare(
        "UPDATE jobs SET status='processing',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?",
      ).run(owner, now + 180000, now, job.id);
      db.prepare("UPDATE sources SET status='indexing',error=NULL,updated_at=? WHERE id=?").run(
        now,
        job.source_id,
      );
      return { ...job, attempts: job.attempts + 1, lease_owner: owner };
    })
    .immediate();
}
