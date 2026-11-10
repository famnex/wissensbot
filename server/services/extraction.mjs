import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from '../lib/errors.mjs';
export function extractInProcess(file, filename, signal) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('../workers/extract-file.mjs', import.meta.url)), [], {
      execArgv: ['--max-old-space-size=256'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      error ? reject(error) : resolve(result);
    };
    const abort = () =>
      finish(new AppError(409, 'CANCELLED', 'Die Verarbeitung wurde abgebrochen.'));
    const timer = setTimeout(
      () =>
        finish(
          new AppError(
            422,
            'EXTRACTION_TIMEOUT',
            'Die Datei benötigt zu lange zum Lesen. Bitte in kleinere Dateien aufteilen.',
          ),
        ),
      90000,
    );
    child.on('message', (m) =>
      m.error ? finish(new AppError(422, m.code, m.error)) : finish(null, m.documents),
    );
    child.on('error', () =>
      finish(
        new AppError(
          500,
          'EXTRACTION_FAILED',
          'Die Dateiverarbeitung konnte nicht gestartet werden.',
        ),
      ),
    );
    child.on('exit', () => {
      if (!settled)
        finish(
          new AppError(
            422,
            'EXTRACTION_EXIT',
            'Die Dateiverarbeitung wurde beendet. Die Datei ist möglicherweise zu komplex.',
          ),
        );
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.send({ file, filename });
  });
}
