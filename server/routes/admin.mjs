import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireRole, changeUser } from '../auth.mjs';
import { getSetting, setSetting, audit } from '../db/index.mjs';
import { seal } from '../lib/secrets.mjs';
import { AppError } from '../lib/errors.mjs';
import { enqueue } from '../services/jobs.mjs';

export function adminRoutes(db, config, gemini) {
  const router = Router();
  router.use(requireRole('admin'));
  router.get('/settings', (_req, res) => {
    let sso = {
      enabled: false,
      loginUrl: 'https://cloud.mso-hef.de/novus/api/tiles/sso/',
      paramName: 'sso_token',
      usernameClaim: 'username',
      nameClaim: 'display_name',
      emailClaim: 'email',
      hasSecret: Boolean(getSetting(db, 'sso_secret')),
    };
    const ssoConfigRaw = getSetting(db, 'sso_config');
    if (ssoConfigRaw) {
      try {
        const parsed = JSON.parse(ssoConfigRaw);
        sso = { ...sso, ...parsed, hasSecret: Boolean(getSetting(db, 'sso_secret')) };
      } catch {}
    }
    return res.json({
      hasKey: Boolean(getSetting(db, 'gemini_key')),
      chatModel: JSON.parse(getSetting(db, 'chat_model', 'null')),
      embeddingModel: gemini.embeddingModel(),
      auth: {
        mode: config.auth.mode,
        algorithm: config.auth.algorithm,
        issuer: config.auth.issuer,
        audience: config.auth.audience,
      },
      sso,
      updatesEnabled: config.allowUpdates,
      updateRepository: config.updateRepository,
      updateBranch: config.updateBranch,
    });
  });

  router.put('/sso', async (req, res) => {
    const value = z
      .object({
        enabled: z.boolean(),
        loginUrl: z.string().trim().max(1000).optional().default(''),
        secret: z.string().trim().max(1000).optional(),
        paramName: z.string().trim().max(100).optional().default('sso_token'),
        usernameClaim: z.string().trim().max(100).optional().default('username'),
        nameClaim: z.string().trim().max(100).optional().default('display_name'),
        emailClaim: z.string().trim().max(100).optional().default('email'),
      })
      .strict()
      .parse(req.body);

    db.transaction(() => {
      if (value.secret) {
        setSetting(db, 'sso_secret', seal(value.secret, config.encryptionKey, 'sso-secret'));
      }
      const configToStore = {
        enabled: value.enabled,
        loginUrl: value.loginUrl,
        paramName: value.paramName || 'sso_token',
        usernameClaim: value.usernameClaim || 'username',
        nameClaim: value.nameClaim || 'display_name',
        emailClaim: value.emailClaim || 'email',
      };
      setSetting(db, 'sso_config', JSON.stringify(configToStore));
      audit(db, req.user.id, 'sso_settings_changed');
    }).immediate();

    res.json({
      ok: true,
      sso: {
        ...value,
        hasSecret: Boolean(getSetting(db, 'sso_secret')),
        secret: undefined,
      },
    });
  });
  router.get('/models', async (_req, res) => res.json(await gemini.models()));
  router.put('/key', async (req, res) => {
    const { apiKey } = z
      .object({ apiKey: z.string().trim().min(20).max(300) })
      .strict()
      .parse(req.body);
    const models = await gemini.models(apiKey);
    if (!models.chat.length || !models.embedding.length)
      throw new AppError(
        400,
        'MODELS_MISSING',
        'Dieser Zugang bietet keine kompatiblen Chat- und Embedding-Modelle.',
      );
    db.transaction(() => {
      setSetting(db, 'gemini_key', seal(apiKey, config.encryptionKey, 'gemini-key'));
      const selected = JSON.parse(getSetting(db, 'chat_model', 'null'));
      if (selected && !models.chat.some((m) => m.name === selected.name))
        db.prepare("DELETE FROM settings WHERE key='chat_model'").run();
      audit(db, req.user.id, 'gemini_key_changed');
    }).immediate();
    res.json({ ok: true, models });
  });
  router.put('/models', async (req, res) => {
    const value = z
      .object({ chatModel: z.string().max(150), embeddingModel: z.string().max(150) })
      .strict()
      .parse(req.body);
    const models = await gemini.models();
    const selected = models.chat.find((m) => m.name === value.chatModel);
    if (!selected || !models.embedding.some((m) => m.name === value.embeddingModel))
      throw new AppError(
        400,
        'INVALID_MODEL',
        'Bitte ein aktuell verfügbares Modell aus der Liste auswählen.',
      );
    let reindexed = 0;
    db.transaction(() => {
      if (value.embeddingModel !== gemini.embeddingModel()) {
        if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','processing') LIMIT 1").get())
          throw new AppError(
            409,
            'JOBS_ACTIVE',
            'Bitte warten, bis die aktuelle Indexierung abgeschlossen ist, bevor du das Embedding-Modell wechselst.',
          );
        const sources = db.prepare('SELECT id FROM sources WHERE documents_json IS NOT NULL').all();
        for (const source of sources) {
          enqueue(db, source.id, 'reindex');
          db.prepare("UPDATE sources SET status='queued',error=NULL,updated_at=? WHERE id=?").run(
            Date.now(),
            source.id,
          );
          reindexed++;
        }
        setSetting(db, 'embedding_model', value.embeddingModel);
      }
      setSetting(db, 'chat_model', JSON.stringify(selected));
      audit(db, req.user.id, 'models_changed');
    }).immediate();
    res.json({ ok: true, reindexed });
  });
  router.post('/test', async (req, res) => {
    const value = z
      .object({ chatModel: z.string().max(150), embeddingModel: z.string().max(150) })
      .strict()
      .parse(req.body);
    const models = await gemini.models();
    if (
      !models.chat.some((m) => m.name === value.chatModel) ||
      !models.embedding.some((m) => m.name === value.embeddingModel)
    )
      throw new AppError(400, 'INVALID_MODEL', 'Bitte verfügbare Modelle auswählen.');
    await gemini.test(undefined, value.chatModel, value.embeddingModel);
    res.json({ ok: true });
  });
  router.get('/users', (req, res) => {
    const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
    const q = `%${String(req.query.q || '')
      .slice(0, 150)
      .replace(/[\\%_]/g, '\\$&')}%`;
    const where = "WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'";
    res.json({
      users: db
        .prepare(
          `SELECT id,name,email,role,enabled,last_login_at FROM users ${where} ORDER BY created_at LIMIT 50 OFFSET ?`,
        )
        .all(q, q, (page - 1) * 50),
      total: db.prepare(`SELECT count(*) n FROM users ${where}`).get(q, q).n,
      page,
      pageSize: 50,
    });
  });
  router.patch('/users/:id', (req, res) => {
    const { role, enabled } = z
      .object({ role: z.enum(['admin', 'editor', 'user']), enabled: z.boolean() })
      .strict()
      .parse(req.body);
    res.json(changeUser(db, req.user.id, req.params.id, role, enabled));
  });
  router.get('/updates', async (_req, res) => {
    let status = { state: 'idle', message: 'Noch kein Update ausgeführt.' };
    try {
      status = JSON.parse(await fs.readFile(path.join(config.updateDir, 'status.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      const pending = JSON.parse(
        await fs.readFile(path.join(config.updateDir, 'request.json'), 'utf8'),
      );
      if (pending.id !== status.id)
        status = {
          id: pending.id,
          state: 'preparing',
          message: 'Update wurde angefordert.',
          startedAt: pending.createdAt,
        };
    } catch {}
    let daemonOnline = false;
    try {
      const beat = JSON.parse(
        await fs.readFile(path.join(config.updateDir, 'daemon.json'), 'utf8'),
      );
      daemonOnline = Date.now() - beat.at < 15000;
    } catch {}
    res.json({ ...status, enabled: config.allowUpdates, daemonOnline });
  });
  router.post('/updates', async (req, res) => {
    if (!config.allowUpdates)
      throw new AppError(
        403,
        'UPDATES_DISABLED',
        'Updates müssen auf dem Server mit ALLOW_UPDATES=true freigeschaltet werden.',
      );
    let daemon;
    try {
      daemon = JSON.parse(await fs.readFile(path.join(config.updateDir, 'daemon.json'), 'utf8'));
    } catch {}
    if (!daemon || Date.now() - daemon.at > 15000)
      throw new AppError(
        503,
        'UPDATER_OFFLINE',
        'Der PM2-Update-Prozess läuft nicht. Bitte auf dem Server starten.',
      );
    const request = { id: randomUUID(), actor: req.user.id, createdAt: Date.now() };
    try {
      await fs.writeFile(path.join(config.updateDir, 'request.json'), JSON.stringify(request), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new AppError(409, 'UPDATE_RUNNING', 'Ein Update ist bereits in Bearbeitung.');
      throw error;
    }
    audit(db, req.user.id, 'update_requested', request.id);
    res.status(202).json(request);
  });
  return router;
}
