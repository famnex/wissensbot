import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../config.mjs';
import { connect, migrate } from '../db/index.mjs';
import { Gemini } from '../services/gemini.mjs';
import { processClaimedJob } from '../services/index-job.mjs';
import { claimJob } from '../services/jobs.mjs';
import { AppError, safeError } from '../lib/errors.mjs';

process.umask(0o077);
const config = configuration();
const db = connect(config.dbPath);
migrate(db);
const gemini = new Gemini(db, config);
const owner = randomUUID();
let stopping = false;
let activeController;
for (const event of ['SIGINT', 'SIGTERM'])
  process.on(event, () => {
    stopping = true;
    activeController?.abort();
  });
const beat = () =>
  db
    .prepare(
      "INSERT INTO runtime(key,value) VALUES('worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(String(Date.now()));
beat();
const heartbeat = setInterval(beat, 5000);
let nextCleanup = 0;
function cleanup() {
  const now = Date.now();
  if (now < nextCleanup) return;
  nextCleanup = now + 3600000;
  db.prepare("DELETE FROM jobs WHERE status='done' AND updated_at<?").run(now - 30 * 86400000);
  db.prepare('DELETE FROM audit WHERE created_at<?').run(now - 90 * 86400000);
  const retained = new Set(
    db
      .prepare("SELECT payload FROM jobs WHERE payload!='{}'")
      .all()
      .map((r) => JSON.parse(r.payload).filename)
      .filter(Boolean),
  );
  for (const name of fs.readdirSync(config.uploadDir)) {
    if (!/^[a-f0-9-]+\.upload$/.test(name) || retained.has(name)) continue;
    try {
      const file = path.join(config.uploadDir, name);
      if (fs.statSync(file).mtimeMs < now - 86400000) fs.rmSync(file, { force: true });
    } catch {}
  }
}
process.send?.('ready');
while (!stopping) {
  if (fs.existsSync(path.join(config.updateDir, 'maintenance.json'))) {
    await delay(1000);
    continue;
  }
  cleanup();
  const job = claimJob(db, owner);
  if (!job) {
    await delay(800);
    continue;
  }
  activeController = new AbortController();
  const signal = activeController.signal;
  const touch = (progress, stage) => {
    const changed = db
      .prepare(
        "UPDATE jobs SET progress=?,stage=?,lease_until=?,updated_at=? WHERE id=? AND lease_owner=? AND status='processing'",
      )
      .run(progress, stage, Date.now() + 180000, Date.now(), job.id, owner).changes;
    if (!changed) activeController.abort();
  };
  const lease = setInterval(() => {
    const changed = db
      .prepare("UPDATE jobs SET lease_until=? WHERE id=? AND lease_owner=? AND status='processing'")
      .run(Date.now() + 180000, job.id, owner).changes;
    if (!changed) activeController.abort();
  }, 5000);
  try {
    await processClaimedJob({ db, config, gemini, job, owner, signal, touch });
  } catch (error) {
    const retry = stopping || (error.retryable && job.attempts < 3);
    db.transaction(() => {
      const changed = db
        .prepare(
          `UPDATE jobs SET status=?,stage=?,error=?,run_after=?,lease_owner=NULL,lease_until=NULL,attempts=attempts-?,updated_at=? WHERE id=? AND lease_owner=?`,
        )
        .run(
          retry ? 'queued' : 'failed',
          retry ? 'Wiederholung geplant' : 'Fehlgeschlagen',
          safeError(error),
          Date.now() + (stopping ? 0 : 30000 * 2 ** job.attempts),
          stopping ? 1 : 0,
          Date.now(),
          job.id,
          owner,
        ).changes;
      if (changed)
        db.prepare('UPDATE sources SET status=?,error=?,updated_at=? WHERE id=?').run(
          retry ? 'queued' : 'error',
          safeError(error),
          Date.now(),
          job.source_id,
        );
    }).immediate();
    // No document contents, credentials or upstream errors are logged.
    if (!stopping)
      console.error(
        JSON.stringify({
          event: 'job_failed',
          jobId: job.id,
          code: error instanceof AppError ? error.code : 'PROCESSING_FAILED',
          retry,
        }),
      );
  } finally {
    clearInterval(lease);
    activeController = null;
  }
}
clearInterval(heartbeat);
db.close();
