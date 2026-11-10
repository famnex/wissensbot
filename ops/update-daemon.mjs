import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../server/config.mjs';
process.umask(0o077);
const config = configuration();
const lock = path.join(config.updateDir, 'daemon.lock');
async function atomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(tmp, file);
}
try {
  const old = JSON.parse(await fs.readFile(lock, 'utf8'));
  try {
    process.kill(old.pid, 0);
    throw new Error('Ein Update-Daemon läuft bereits.');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await fs.rm(lock);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await fs.writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    stopping = true;
  });
const beat = () =>
  atomic(path.join(config.updateDir, 'daemon.json'), { at: Date.now() }).catch(() => {});
await beat();
const timer = setInterval(beat, 5000);
process.send?.('ready');
try {
  while (!stopping) {
    const requestPath = path.join(config.updateDir, 'request.json');
    let request;
    try {
      request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        await delay(1000);
        continue;
      }
      throw error;
    }
    if (!/^[a-f0-9-]{36}$/.test(request.id)) throw new Error('Ungültiger Update-Auftrag.');
    if (!config.allowUpdates) {
      await atomic(path.join(config.updateDir, 'status.json'), {
        state: 'failed',
        message: 'Server-Updates sind deaktiviert.',
        id: request.id,
      });
      await fs.rm(requestPath);
      continue;
    }
    const runDir = path.join(config.updateDir, 'runs', request.id);
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    const runner = path.join(runDir, 'runner.mjs');
    try {
      await fs.copyFile(
        path.join(config.root, 'ops/update-runner.mjs'),
        runner,
        fs.constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const configPath = path.join(runDir, 'config.json');
    try {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          id: request.id,
          root: config.root,
          dataDir: config.dataDir,
          dbPath: config.dbPath,
          updateDir: config.updateDir,
          runDir,
          repository: config.updateRepository,
          branch: config.updateBranch,
          prefix: config.pm2Prefix,
          port: config.port,
        }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [runner, configPath], {
        cwd: config.root,
        stdio: 'inherit',
        env: process.env,
      });
      child.on('error', resolve);
      child.on('exit', resolve);
    });
    let terminal = false;
    try {
      terminal = ['succeeded', 'no_change', 'failed', 'rolled_back', 'rollback_failed'].includes(
        JSON.parse(await fs.readFile(path.join(runDir, 'journal.json'), 'utf8')).state,
      );
    } catch {}
    // Leave the request intact after a crash. The next invocation recovers from the journal.
    if (terminal) {
      await fs.rm(requestPath, { force: true });
      // Keep the five newest terminal runs. An unresolved rollback is never pruned.
      const runs = [];
      for (const id of await fs.readdir(path.join(config.updateDir, 'runs'))) {
        if (!/^[a-f0-9-]{36}$/.test(id)) continue;
        try {
          const entry = JSON.parse(
            await fs.readFile(path.join(config.updateDir, 'runs', id, 'journal.json'), 'utf8'),
          );
          if (['succeeded', 'no_change', 'failed', 'rolled_back'].includes(entry.state))
            runs.push({ id, at: entry.startedAt });
        } catch {}
      }
      runs.sort((a, b) => b.at - a.at);
      for (const old of runs.slice(5))
        await fs.rm(path.join(config.updateDir, 'runs', old.id), { recursive: true, force: true });
    } else await delay(3000);
  }
} finally {
  clearInterval(timer);
  await fs.rm(lock, { force: true });
  await fs.rm(path.join(config.updateDir, 'daemon.json'), { force: true });
}
