import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors.mjs';
export class Retriever {
  constructor(config) {
    this.config = config;
    this.pending = new Map();
    this.start();
  }
  start() {
    if (this.closed) return;
    this.worker = new Worker(new URL('../workers/retrieval.mjs', import.meta.url), {
      workerData: { dbPath: this.config.dbPath },
    });
    this.worker.on('message', ({ id, results, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(id);
      error ? request.reject(new AppError(503, 'SEARCH_FAILED', error)) : request.resolve(results);
    });
    this.worker.on('error', () => {});
    this.worker.on('exit', () => {
      for (const r of this.pending.values()) {
        clearTimeout(r.timer);
        r.reject(new AppError(503, 'SEARCH_RESTARTING', 'Die Wissenssuche startet gerade neu.'));
      }
      this.pending.clear();
      this.worker = null;
      if (!this.closed) this.restartTimer = setTimeout(() => this.start(), 1000);
    });
  }
  search(vector, profile) {
    if (!this.worker || this.closed)
      throw new AppError(503, 'SEARCH_RESTARTING', 'Die Wissenssuche startet gerade neu.');
    if (this.pending.size >= 20)
      throw new AppError(
        429,
        'SEARCH_BUSY',
        'Die Wissenssuche ist ausgelastet. Bitte kurz warten.',
      );
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(503, 'SEARCH_TIMEOUT', 'Die Wissenssuche hat zu lange gedauert.'));
        this.worker?.terminate();
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, vector, profile, minScore: this.config.ragMinScore });
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.restartTimer);
    if (this.worker) {
      try {
        this.worker.postMessage({ action: 'close' });
      } catch {}
      await this.worker.terminate();
      this.worker = null;
    }
  }
}
