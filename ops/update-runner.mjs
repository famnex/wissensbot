// Deliberately uses only Node built-ins. The daemon snapshots this file outside
// the checkout before execution; npm install and git pull cannot replace it mid-run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const terminal = new Set(['succeeded', 'no_change', 'failed', 'rolled_back', 'rollback_failed']);
export async function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
export function command(
  program,
  args,
  { cwd, timeout = 120000, env = process.env, lockFile } = {},
) {
  return new Promise((resolve, reject) => {
    // flock remains alive if this Node runner crashes; recovery cannot overtake an
    // orphaned installer. Timeouts kill only the process group created here.
    const child = spawn(
      lockFile ? 'flock' : program,
      lockFile ? ['--exclusive', '--wait', '1200', lockFile, program, ...args] : args,
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    let out = '';
    let bytes = 0;
    let settled = false;
    const terminate = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      terminate();
      finish(new Error(`${program}: Zeitlimit überschritten.`));
    }, timeout);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(out.trim());
    };
    child.stdout.on('data', (b) => {
      bytes += b.length;
      if (bytes > 8 * 1024 * 1024) {
        terminate();
        finish(new Error(`${program}: Ausgabe zu groß.`));
      } else out += b;
    });
    // Do not copy lifecycle output into admin responses or logs: it may contain secrets.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error(`${program} konnte nicht gestartet werden.`)));
    child.on('exit', (code) =>
      finish(code === 0 ? null : new Error(`${program} ist fehlgeschlagen (Exit ${code}).`)),
    );
  });
}
export async function runUpdate(
  config,
  { execute = command, healthFetch = fetch, forceRecovery = false, pause = delay } = {},
) {
  const c = config;
  const journalPath = path.join(c.runDir, 'journal.json');
  const statusPath = path.join(c.updateDir, 'status.json');
  const maintenance = path.join(c.updateDir, 'maintenance.json');
  const depsBackup = path.join(c.runDir, 'node_modules');
  const distBackup = path.join(c.runDir, 'dist');
  const dbBackup = path.join(c.runDir, 'database.sqlite');
  let journal = {
    id: c.id,
    state: 'preparing',
    startedAt: Date.now(),
    previousSha: null,
    targetSha: null,
    backupComplete: false,
    mutationStarted: false,
    servicesStopped: false,
  };
  const names = [`${c.prefix}-web`, `${c.prefix}-worker`];
  const run = (program, args, timeout) =>
    execute(program, args, {
      cwd: c.root,
      timeout,
      lockFile: path.join(c.updateDir, 'command.lock'),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  const git = (...args) => run('git', args);
  const persist = async (state, message) => {
    Object.assign(journal, { state, message, updatedAt: Date.now() });
    await atomicJson(journalPath, journal);
    await atomicJson(statusPath, {
      id: journal.id,
      state,
      message,
      startedAt: journal.startedAt,
      updatedAt: journal.updatedAt,
      previousSha: journal.previousSha,
      targetSha: journal.targetSha,
      backupReady: journal.backupComplete,
    });
  };
  const stop = async () => {
    await run('pm2', ['stop', ...names], 60000);
  };
  const restart = async () => {
    await run(
      'pm2',
      [
        'restart',
        path.join(c.root, 'ecosystem.config.cjs'),
        '--only',
        names.join(','),
        '--update-env',
      ],
      90000,
    );
  };
  const healthy = async (sha, after) => {
    for (let i = 0; i < 40; i++) {
      try {
        const response = await healthFetch(`http://127.0.0.1:${c.port}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        const health = await response.json();
        if (
          response.ok &&
          health.ok &&
          health.revision === sha &&
          health.workerAt >= after &&
          health.workerOnline
        )
          return;
      } catch {}
      await pause(1000);
    }
    throw new Error('Webserver oder Indexierungsprozess haben die Startprüfung nicht bestanden.');
  };
  const restore = async (reason) => {
    await persist(
      'rolling_back',
      'Update fehlgeschlagen. Der vorherige Stand wird wiederhergestellt.',
    );
    try {
      await stop();
      if (journal.mutationStarted) {
        if (!journal.backupComplete || !/^[a-f0-9]{40,64}$/.test(journal.previousSha || ''))
          throw new Error('Ein vollständiges Backup fehlt.');
        await git('reset', '--hard', journal.previousSha);
        // Validate both backup trees before deleting any installed tree.
        if (
          !(await exists(path.join(depsBackup, '.package-lock.json'))) ||
          !(await exists(path.join(distBackup, 'index.html'))) ||
          !(await exists(dbBackup))
        )
          throw new Error('Das Backup ist unvollständig.');
        for (const [backup, target] of [
          [depsBackup, path.join(c.root, 'node_modules')],
          [distBackup, path.join(c.root, 'dist')],
        ]) {
          await fs.rm(target, { recursive: true, force: true });
          await fs.cp(backup, target, { recursive: true, verbatimSymlinks: true });
        }
        await fs.rm(`${c.dbPath}-wal`, { force: true });
        await fs.rm(`${c.dbPath}-shm`, { force: true });
        const temp = `${c.dbPath}.restore`;
        await fs.copyFile(dbBackup, temp);
        await fs.rename(temp, c.dbPath);
        await run(process.execPath, [path.join(c.root, 'scripts/backup.mjs'), '--verify'], 60000);
      }
      const after = Date.now();
      await restart();
      await healthy(journal.previousSha, after);
      journal.failure = reason;
      await persist(
        journal.mutationStarted ? 'rolled_back' : 'failed',
        journal.mutationStarted
          ? 'Update zurückgerollt. Der vorherige Stand läuft wieder.'
          : 'Update abgebrochen. Der vorherige Stand läuft weiter.',
      );
      await fs.rm(maintenance, { force: true });
    } catch {
      await persist(
        'rollback_failed',
        'Die automatische Wiederherstellung konnte nicht abgeschlossen werden. Der Wartungsmodus bleibt aktiv. Bitte das Wiederherstellungsverfahren auf dem Server ausführen.',
      );
    }
  };
  let previous;
  try {
    previous = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous) {
    journal = previous;
    if (terminal.has(journal.state) && !forceRecovery) {
      if (
        ['succeeded', 'rolled_back', 'failed'].includes(journal.state) &&
        (await exists(maintenance))
      ) {
        const sha = journal.state === 'succeeded' ? journal.targetSha : journal.previousSha;
        if (sha) {
          const after = Date.now();
          await restart();
          await healthy(sha, after);
          await fs.rm(maintenance, { force: true });
        }
      }
      return journal;
    }
    if (
      journal.previousSha &&
      (journal.servicesStopped || journal.mutationStarted || (await exists(maintenance)))
    )
      await restore('Abgebrochener Update-Prozess wurde erkannt.');
    else
      await persist(
        'failed',
        'Der vorige Update-Versuch wurde vor Änderungen unterbrochen. Bitte erneut starten.',
      );
    return journal;
  }
  try {
    await persist('preparing', 'Repository und Voraussetzungen werden geprüft.');
    let repoUrl = c.repository;
    if (!repoUrl) {
      try {
        repoUrl = (await git('remote', 'get-url', 'origin')).trim();
      } catch {
        repoUrl = 'https://github.com/famnex/wissensbot.git';
      }
    }
    const cleanRepo = repoUrl
      .replace(/^https:\/\/[^@/]+@github\.com\//i, 'https://github.com/')
      .replace(/\.git$/i, '');
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/i.test(cleanRepo))
      throw new Error(
        'UPDATE_REPOSITORY muss auf ein gültiges GitHub-Repository per HTTPS verweisen.',
      );
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,45}$/.test(c.prefix))
      throw new Error('Ungültige PM2-Prozessnamen.');
    await git('check-ref-format', '--branch', c.branch);
    const rawRemote = (await git('remote', 'get-url', 'origin')).trim();
    const cleanRemote = rawRemote
      .replace(/^https:\/\/[^@/]+@github\.com\//i, 'https://github.com/')
      .replace(/\.git$/i, '');
    if (cleanRemote.toLowerCase() !== cleanRepo.toLowerCase())
      throw new Error('Git-Remote und UPDATE_REPOSITORY stimmen nicht überein.');
    if ((await git('branch', '--show-current')) !== c.branch)
      throw new Error('Der aktuelle Git-Branch entspricht nicht UPDATE_BRANCH.');
    if (await git('status', '--porcelain', '--untracked-files=normal'))
      throw new Error('Lokale Änderungen müssen vor dem Update committed oder entfernt werden.');
    for (const item of ['.env', 'node_modules/.package-lock.json', 'dist/index.html'])
      await git('check-ignore', '--quiet', item);
    const relData = path.relative(c.root, c.dataDir);
    if (!relData.startsWith('..') && !path.isAbsolute(relData))
      await git('check-ignore', '--quiet', path.join(relData, 'knowledge.sqlite'));
    if (
      !(await exists(path.join(c.root, 'node_modules', '.package-lock.json'))) ||
      !(await exists(path.join(c.root, 'dist', 'index.html')))
    )
      throw new Error(
        'Vor dem ersten Update müssen Installation und Frontend-Build abgeschlossen sein.',
      );
    const free = await fs.statfs(c.runDir);
    if (free.bavail * free.bsize < 512 * 1024 * 1024)
      throw new Error('Für das Update-Backup ist nicht genügend freier Speicher vorhanden.');
    const rawPm2 = await run('pm2', ['jlist'], 30000);
    const startIdx = rawPm2.indexOf('[');
    const endIdx = rawPm2.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
      throw new Error(
        `PM2 lieferte keine gültige Prozessliste. Ausgabe: ${rawPm2.slice(0, 200)}`,
      );
    }
    const processes = JSON.parse(rawPm2.slice(startIdx, endIdx + 1));
    for (const name of names) {
      const matching = processes.filter((p) => p.name === name);
      if (matching.length !== 1 || matching[0].pm2_env?.exec_mode !== 'fork_mode')
        throw new Error(
          'Webserver und Worker müssen jeweils genau einmal im PM2-Fork-Modus laufen.',
        );
    }
    journal.previousSha = await git('rev-parse', 'HEAD');
    await git('fetch', '--no-tags', 'origin', c.branch);
    journal.targetSha = await git('rev-parse', 'FETCH_HEAD');
    if (journal.targetSha === journal.previousSha) {
      await persist('no_change', 'Die Anwendung ist bereits auf dem neuesten Stand.');
      return journal;
    }
    await git('merge-base', '--is-ancestor', journal.previousSha, journal.targetSha);
    const tracked = (await git('ls-tree', '-r', '--name-only', journal.targetSha)).split('\n');
    const runtimePrefix =
      !relData.startsWith('..') && !path.isAbsolute(relData) ? `${relData}/` : null;
    if (
      tracked.some(
        (f) =>
          f === '.env' ||
          f.startsWith('node_modules/') ||
          f.startsWith('dist/') ||
          (runtimePrefix && f.startsWith(runtimePrefix)),
      )
    )
      throw new Error('Der neue Commit enthält geschützte Laufzeitdateien.');
    // Persist intent before stopping services so a crash at every subsequent step is recoverable.
    journal.servicesStopped = true;
    await persist('backup', 'Wartungsmodus aktivieren und konsistentes Backup erstellen.');
    await atomicJson(maintenance, { id: c.id, at: Date.now() });
    await stop();
    await run(
      process.execPath,
      [path.join(c.root, 'scripts/backup.mjs'), '--output', dbBackup],
      120000,
    );
    await fs.cp(path.join(c.root, 'node_modules'), depsBackup, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    await fs.cp(path.join(c.root, 'dist'), distBackup, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    journal.backupComplete = true;
    await persist(
      'backup',
      'Datenbank, installierte Abhängigkeiten und Oberfläche sind gesichert.',
    );
    journal.mutationStarted = true;
    await persist('pulling', 'Neuen Git-Stand übernehmen.');
    await git('pull', '--ff-only', 'origin', c.branch);
    if ((await git('rev-parse', 'HEAD')) !== journal.targetSha)
      throw new Error(
        'Der Remote-Branch wurde während des Updates verändert. Bitte erneut starten.',
      );
    await persist('installing', 'Abhängigkeiten installieren.');
    await run('npm', ['install', '--include=dev', '--no-audit', '--no-fund'], 15 * 60 * 1000);
    await git('diff', '--exit-code', '--', 'package.json', 'package-lock.json');
    await persist('building', 'Oberfläche bauen und Prüfungen ausführen.');
    await run('npm', ['run', 'build'], 5 * 60 * 1000);
    await run('npm', ['test'], 5 * 60 * 1000);
    await persist('migrating', 'Datenbank-Migrationen anwenden.');
    await run('npm', ['run', 'db:migrate'], 120000);
    await persist('restarting', 'PM2-Prozesse neu starten und Bereitschaft prüfen.');
    const after = Date.now();
    await restart();
    await healthy(journal.targetSha, after);
    await persist('succeeded', 'Update abgeschlossen. Webserver und Indexierung sind bereit.');
    await fs.rm(maintenance, { force: true });
  } catch (error) {
    if (journal.servicesStopped || journal.mutationStarted) await restore(error.message);
    else await persist('failed', error.message || 'Die Update-Voraussetzungen sind nicht erfüllt.');
  }
  return journal;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const lock = path.join(config.updateDir, 'runner.lock');
  try {
    const old = JSON.parse(await fs.readFile(lock, 'utf8'));
    try {
      process.kill(old.pid, 0);
      throw new Error('Ein Update-Runner läuft bereits.');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await fs.rm(lock);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  try {
    await runUpdate(config, { forceRecovery: process.argv.includes('--recover') });
  } finally {
    await fs.rm(lock, { force: true });
  }
}
