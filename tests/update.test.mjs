import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from '../server/db/index.mjs';
import { runUpdate } from '../ops/update-runner.mjs';
const exec = promisify(execFile);

async function fixture(t, failure) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wissensraum-update-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const dataDir = path.join(dir, 'data');
  const updateDir = path.join(dataDir, 'updates');
  const id = randomUUID();
  const runDir = path.join(updateDir, 'runs', id);
  const dbPath = path.join(dataDir, 'knowledge.sqlite');
  await fs.mkdir(root);
  await fs.mkdir(runDir, { recursive: true });
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.test');
  await git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\ndist/\n.env\n');
  await fs.writeFile(path.join(root, 'version.txt'), 'old');
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
  await git('add', '.');
  await git('commit', '-m', 'old');
  const old = await git('rev-parse', 'HEAD');
  await git('switch', '-c', 'upstream');
  await fs.writeFile(path.join(root, 'version.txt'), 'new');
  await git('commit', '-am', 'new');
  const next = await git('rev-parse', 'HEAD');
  await git('switch', 'main');
  await git('remote', 'add', 'origin', 'https://github.com/example/wissensraum.git');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'node_modules', '.package-lock.json'), '{}');
  await fs.writeFile(path.join(root, 'node_modules', 'saved.txt'), 'old dependencies');
  await fs.writeFile(path.join(root, 'dist', 'index.html'), 'old frontend');
  const db = connect(dbPath);
  db.exec(
    "CREATE TABLE knowledge(id INTEGER PRIMARY KEY,text TEXT);INSERT INTO knowledge VALUES(1,'original knowledge');",
  );
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const calls = [];
  let failureThrown = false;
  const execute = async (program, args) => {
    calls.push([program, ...args]);
    if (program === 'git') {
      if (args[0] === 'fetch') {
        await git('fetch', '.', 'upstream');
        return '';
      }
      if (args[0] === 'pull') return git('merge', '--ff-only', next);
      return git(...args);
    }
    if (program === 'pm2') {
      if (args[0] === 'jlist')
        return JSON.stringify(
          ['web', 'worker'].map((s) => ({
            name: `test-${s}`,
            pm2_env: { exec_mode: 'fork_mode' },
          })),
        );
      if (args[0] === 'restart' && failure === 'restart' && !failureThrown) {
        failureThrown = true;
        throw new Error('Injected restart failure');
      }
      return '';
    }
    if (args[0]?.endsWith('backup.mjs')) {
      const db = connect(dbPath);
      try {
        if (args.includes('--output')) await db.backup(args.at(-1));
        else assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      } finally {
        db.close();
      }
      return '';
    }
    if (program === 'npm') {
      if (args[0] === 'install') {
        await fs.writeFile(path.join(root, 'node_modules', 'saved.txt'), 'new dependencies');
        if (failure === 'install') throw new Error('Injected installation failure');
      }
      if (args[1] === 'build') {
        await fs.writeFile(path.join(root, 'dist', 'index.html'), 'new frontend');
        if (failure === 'build') throw new Error('Injected build failure');
      }
      if (args[1] === 'db:migrate') {
        const db = connect(dbPath);
        db.exec(
          "CREATE TABLE new_schema(id INTEGER);UPDATE knowledge SET text='changed by migration';",
        );
        db.close();
        if (failure === 'migration') throw new Error('Injected migration failure');
      }
      return '';
    }
    throw new Error('Unexpected command');
  };
  const healthFetch = async () =>
    Response.json({
      ok: !(failure === 'health' && (await git('rev-parse', 'HEAD')) === next),
      revision: await git('rev-parse', 'HEAD'),
      workerAt: Date.now() + 1000,
      workerOnline: true,
    });
  return {
    root,
    dbPath,
    git,
    old,
    next,
    runDir,
    updateDir,
    calls,
    config: {
      id,
      root,
      dataDir,
      dbPath,
      updateDir,
      runDir,
      repository: 'https://github.com/example/wissensraum.git',
      branch: 'main',
      prefix: 'test',
      port: 12345,
    },
    options: { execute, healthFetch, pause: async () => {} },
  };
}
for (const failure of ['install', 'build', 'migration', 'restart', 'health'])
  test(`Update rollback restores real Git, SQLite, dependencies and frontend after ${failure} failure`, async (t) => {
    const f = await fixture(t, failure);
    const result = await runUpdate(f.config, f.options);
    assert.equal(result.state, 'rolled_back', JSON.stringify(result));
    assert.equal(await f.git('rev-parse', 'HEAD'), f.old);
    assert.equal(
      await fs.readFile(path.join(f.root, 'node_modules', 'saved.txt'), 'utf8'),
      'old dependencies',
    );
    assert.equal(
      await fs.readFile(path.join(f.root, 'dist', 'index.html'), 'utf8'),
      'old frontend',
    );
    const db = connect(f.dbPath);
    assert.equal(db.prepare('SELECT text FROM knowledge').get().text, 'original knowledge');
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name='new_schema'").get(),
      undefined,
    );
    db.close();
    await assert.rejects(fs.access(path.join(f.updateDir, 'maintenance.json')));
    const journal = JSON.parse(await fs.readFile(path.join(f.runDir, 'journal.json'), 'utf8'));
    assert.equal(journal.backupComplete, true);
  });
test('Successful update waits for readiness and keeps its durable backup', async (t) => {
  const f = await fixture(t);
  const result = await runUpdate(f.config, f.options);
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.next);
  await fs.access(path.join(f.runDir, 'database.sqlite'));
  await assert.rejects(fs.access(path.join(f.updateDir, 'maintenance.json')));
});
test('Dirty checkouts are rejected before stopping processes or changing files', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'version.txt'), 'user changes');
  const result = await runUpdate(f.config, f.options);
  assert.equal(result.state, 'failed');
  assert.ok(!f.calls.some((c) => c[0] === 'pm2' && c[1] === 'stop'));
  assert.equal(await fs.readFile(path.join(f.root, 'version.txt'), 'utf8'), 'user changes');
});
test('A crashed update resumes by rolling back from the original journal and backup', async (t) => {
  const f = await fixture(t);
  await runUpdate(f.config, f.options);
  const journalPath = path.join(f.runDir, 'journal.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  journal.state = 'migrating';
  await fs.writeFile(journalPath, JSON.stringify(journal));
  await fs.writeFile(path.join(f.updateDir, 'maintenance.json'), '{}');
  const recovered = await runUpdate(f.config, f.options);
  assert.equal(recovered.state, 'rolled_back', JSON.stringify(recovered));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.old);
  const db = connect(f.dbPath);
  assert.equal(db.prepare('SELECT text FROM knowledge').get().text, 'original knowledge');
  db.close();
});
