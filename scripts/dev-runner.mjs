import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('='.repeat(70));
console.log('  WISSENSRAUM — LOKALER ENTWICKLUNGS- & TEST-SERVER');
console.log('='.repeat(70));
console.log('Starte Webserver und Hintergrund-Worker...');

const web = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env },
});

const worker = spawn(process.execPath, ['server/workers/indexer.mjs'], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env },
});

function pipeOutput(child, prefix) {
  child.stdout?.on('data', (data) => {
    const lines = data.toString().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      console.log(`[${prefix}] ${line}`);
    }
  });
  child.stderr?.on('data', (data) => {
    const lines = data.toString().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      console.error(`[${prefix}:err] ${line}`);
    }
  });
}

pipeOutput(web, 'web');
pipeOutput(worker, 'worker');

let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  console.log('\nBeende Dienste...');
  web.kill('SIGINT');
  worker.kill('SIGINT');
  setTimeout(() => {
    try { web.kill('SIGKILL'); } catch {}
    try { worker.kill('SIGKILL'); } catch {}
    process.exit(0);
  }, 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

web.on('exit', (code) => {
  if (!exiting) {
    console.log(`[web] Prozess beendet mit Code ${code}`);
    shutdown();
  }
});

worker.on('exit', (code) => {
  if (!exiting) {
    console.log(`[worker] Prozess beendet mit Code ${code}`);
    shutdown();
  }
});
