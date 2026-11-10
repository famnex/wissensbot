import { parentPort, workerData } from 'node:worker_threads';
import { connect } from '../db/index.mjs';
const db = connect(workerData.dbPath, { readonly: true });
parentPort.on('message', ({ id, action, vector, profile, minScore }) => {
  if (action === 'close') {
    try {
      db.close();
    } catch {}
    process.exit(0);
  }
  try {
    const best = [];
    for (const row of db
      .prepare(
        `SELECT c.id,c.source_id,c.text,c.location,c.url,c.vector,c.title as chunk_title,s.title,s.type as source_type,s.reference as source_reference FROM chunks c
      JOIN sources s ON s.id=c.source_id WHERE c.profile=? AND s.active=1 AND s.status='ready'`,
      )
      .iterate(profile)) {
      if (row.vector.length !== vector.length * 4) continue;
      let score = 0;
      for (let i = 0; i < vector.length; i++) score += vector[i] * row.vector.readFloatLE(i * 4);
      if (score < minScore) continue;
      delete row.vector;
      best.push({ ...row, score });
      best.sort((a, b) => b.score - a.score);
      if (best.length > 40) best.pop();
    }
    const counts = new Map();
    let budget = 12000;
    const results = best
      .filter((row) => {
        const n = counts.get(row.source_id) || 0;
        if (n >= 3 || budget < row.text.length) return false;
        counts.set(row.source_id, n + 1);
        budget -= row.text.length;
        return true;
      })
      .slice(0, 7);
    parentPort.postMessage({ id, results });
  } catch {
    parentPort.postMessage({ id, error: 'Die Wissenssuche konnte nicht ausgeführt werden.' });
  }
});
