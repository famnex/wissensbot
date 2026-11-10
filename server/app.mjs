import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { AppError } from './lib/errors.mjs';
import {
  createVerifier,
  registerIdentity,
  publicUser,
  authenticate,
  setSession,
  bearer,
} from './auth.mjs';
import { getSetting } from './db/index.mjs';
import { Gemini } from './services/gemini.mjs';
import { Retriever } from './services/retrieval.mjs';
import { createSource } from './services/jobs.mjs';
import { chatSchema, prepareChat } from './services/chat.mjs';
import { knowledgeRoutes } from './routes/knowledge.mjs';
import { adminRoutes } from './routes/admin.mjs';
import { inboxRoutes } from './routes/inbox.mjs';

export async function createApp({
  config,
  db,
  gemini = new Gemini(db, config),
  retriever,
  revision = 'local',
}) {
  const verify = await createVerifier(config, db);
  const search = retriever || new Retriever(config);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  const basePrefix = (config.basePath || '/wissen').replace(/\/+$/, '');
  if (basePrefix) {
    app.use((req, _res, next) => {
      if (req.url.startsWith(`${basePrefix}/`)) {
        req.url = req.url.slice(basePrefix.length);
      } else if (req.url === basePrefix) {
        req.url = '/';
      }
      next();
    });
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          ...(config.production ? {} : { upgradeInsecureRequests: null }),
        },
      },
      strictTransportSecurity: config.production ? { maxAge: 31536000 } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      const workerAt = Number(
        db.prepare("SELECT value FROM runtime WHERE key='worker_heartbeat'").get()?.value || 0,
      );
      res.json({
        ok: true,
        revision,
        workerAt,
        workerOnline: Date.now() - workerAt < 20000,
        maintenance: fs.existsSync(path.join(config.updateDir, 'maintenance.json')),
      });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.use('/api', (req, res, next) => {
    if (
      fs.existsSync(path.join(config.updateDir, 'maintenance.json')) &&
      !(req.method === 'GET' && req.path === '/admin/updates')
    ) {
      res.setHeader('Retry-After', '10');
      throw new AppError(503, 'MAINTENANCE', 'Die Anwendung wird aktualisiert. Bitte kurz warten.');
    }
    // Cookie-authenticated mutations require same-origin plus a non-simple custom header.
    // Bearer clients need no CSRF token, but browser requests from other origins are still rejected.
    if (req.headers.origin && req.headers.origin !== config.origin)
      throw new AppError(
        403,
        'ORIGIN_REJECTED',
        'Diese Anfrage stammt von einer nicht erlaubten Website.',
      );
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !bearer(req) &&
      (req.headers.origin !== config.origin || req.headers['x-csrf-guard'] !== '1')
    )
      throw new AppError(
        403,
        'CSRF_REJECTED',
        'Die Anfrage konnte nicht sicher zugeordnet werden. Bitte die Seite neu laden.',
      );
    next();
  });
  app.use('/api', express.json({ limit: '2mb', strict: true }));
  app.get('/api/bootstrap', (_req, res) => {
    let loginUrl = config.loginUrl;
    let ssoParam = 'sso_token';
    const ssoConfigRaw = getSetting(db, 'sso_config');
    if (ssoConfigRaw) {
      try {
        const sso = JSON.parse(ssoConfigRaw);
        if (sso.enabled && sso.loginUrl) {
          loginUrl = sso.loginUrl;
          ssoParam = sso.paramName || 'sso_token';
        }
      } catch {}
    }
    res.json({ setup: !getSetting(db, 'first_admin_completed'), loginUrl, ssoParam });
  });
  const loginLimit = rateLimit({
    windowMs: 60000,
    limit: 15,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMIT', message: 'Zu viele Anmeldeversuche. Bitte eine Minute warten.' },
    },
  });
  app.post('/api/auth/exchange', loginLimit, async (req, res) => {
    const token = bearer(req);
    if (!token) throw new AppError(401, 'TOKEN_REQUIRED', 'Bitte ein gültiges JWT übergeben.');
    const identity = await verify(token);
    const user = registerIdentity(db, identity);
    const sessionExpiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const sessionPayload = JSON.stringify({
      type: 'session',
      userId: user.id,
      issuer: user.issuer,
      subject: user.subject,
      expiresAt: sessionExpiresAt,
    });
    setSession(res, sessionPayload, config);
    res.json({ user: publicUser(user), expiresAt: sessionExpiresAt });
  });
  app.post('/api/auth/logout', (_req, res) => {
    setSession(res, null, config);
    let redirectUrl = config.loginUrl || null;
    const ssoConfigRaw = getSetting(db, 'sso_config');
    if (ssoConfigRaw) {
      try {
        const sso = JSON.parse(ssoConfigRaw);
        if (sso.enabled) {
          redirectUrl = sso.logoutUrl || sso.loginUrl || redirectUrl;
        }
      } catch {}
    }
    res.json({ ok: true, redirectUrl });
  });
  app.use('/api', authenticate(db, verify, config));
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: 240,
      keyGenerator: (req) => req.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMIT', message: 'Zu viele Anfragen. Bitte kurz warten.' } },
    }),
  );
  app.get('/api/me', (req, res) =>
    res.json({ user: publicUser(req.user), expiresAt: req.identity.expiresAt }),
  );
  app.get('/api/overview', (req, res) => {
    const n = db
      .prepare(
        "SELECT count(*) totalSources, sum(CASE WHEN active=1 AND status='ready' THEN 1 ELSE 0 END) readySources, coalesce(sum(chunk_count), 0) totalArticles, coalesce(sum(CASE WHEN active=1 AND status='ready' THEN chunk_count ELSE 0 END), 0) readyArticles FROM sources",
      )
      .get();
    const model = JSON.parse(getSetting(db, 'chat_model', 'null'));
    const workerAt = Number(
      db.prepare("SELECT value FROM runtime WHERE key='worker_heartbeat'").get()?.value || 0,
    );
    res.json({
      ready: n.readyArticles ?? 0,
      readyArticles: n.readyArticles ?? 0,
      totalArticles: n.totalArticles ?? 0,
      readySources: n.readySources || 0,
      totalSources: n.totalSources || 0,
      chunks: n.totalArticles || 0,
      ...(req.user.role === 'user'
        ? {}
        : {
            total: n.totalArticles ?? 0,
            sourcesTotal: n.totalSources || 0,
            queued: db
              .prepare("SELECT count(*) n FROM jobs WHERE status IN ('queued','processing')")
              .get().n,
            workerOnline: Date.now() - workerAt < 20000,
            uploadMaxMb: config.uploadMaxBytes / 1024 / 1024,
            crawlMaxPages: config.crawlMaxPages,
          }),
      model: model?.displayName || null,
      configured: Boolean(model && getSetting(db, 'gemini_key')),
      inboxOpen: db.prepare("SELECT count(*) n FROM inbox WHERE status='open'").get()?.n || 0,
    });
  });
  const knowledge = knowledgeRoutes(db, config, gemini);
  app.use('/api/sources', knowledge);
  app.use('/api/chunks', knowledge);

  app.get(
    ['/api/attachments/:id', '/api/attachments/:id/:filename'],
    authenticate(db, verify, config),
    (req, res) => {
      const attachment = db
        .prepare(
          'SELECT id, chunk_id, filename, original_name, mime_type, size FROM chunk_attachments WHERE id=?',
        )
        .get(req.params.id);
      if (!attachment) {
        throw new AppError(404, 'NOT_FOUND', 'Anhang nicht gefunden.');
      }
      const filePath = path.join(config.attachmentsDir, attachment.filename);
      if (!fs.existsSync(filePath)) {
        throw new AppError(404, 'NOT_FOUND', 'Datei nicht mehr auf dem Server vorhanden.');
      }
      res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
      res.setHeader('Content-Length', attachment.size);
      const isImage = (attachment.mime_type || '').startsWith('image/');
      const disposition = isImage ? 'inline' : 'attachment';
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`,
      );
      res.setHeader('Cache-Control', 'private, max-age=86400');
      fs.createReadStream(filePath).pipe(res);
    },
  );

  app.delete(
    '/api/attachments/:id',
    authenticate(db, verify, config),
    async (req, res) => {
      if (!['admin', 'editor'].includes(req.user.role)) {
        throw new AppError(403, 'FORBIDDEN', 'Keine Berechtigung zum Löschen von Anhängen.');
      }
      const attachment = db
        .prepare('SELECT * FROM chunk_attachments WHERE id=?')
        .get(req.params.id);
      if (!attachment) throw new AppError(404, 'NOT_FOUND', 'Anhang nicht gefunden.');
      db.prepare('DELETE FROM chunk_attachments WHERE id=?').run(attachment.id);
      if (attachment.filename) {
        try {
          await fs.promises.rm(path.join(config.attachmentsDir, attachment.filename), { force: true });
        } catch {}
      }
      res.json({ ok: true, deleted: true, id: attachment.id });
    },
  );

  app.use('/api/admin', adminRoutes(db, config, gemini));
  app.use('/api/inbox', inboxRoutes(db));
  const inFlight = new Map();
  let globalChats = 0;
  const controllers = new Set();
  app.post(
    '/api/chat',
    rateLimit({
      windowMs: 60000,
      limit: 15,
      keyGenerator: (req) => req.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: {
        error: {
          code: 'CHAT_RATE_LIMIT',
          message: 'Bitte einen Moment warten, bevor du weitere Fragen sendest.',
        },
      },
    }),
    async (req, res) => {
      const { messages } = chatSchema.parse(req.body);
      const last = messages.at(-1).text;
      if (/^!learn(?:\s|$)/i.test(last)) {
        if (!['admin', 'editor'].includes(req.user.role))
          throw new AppError(
            403,
            'FORBIDDEN',
            'Nur Wissensvermittler und Administratoren dürfen Wissen hinzufügen.',
          );
        const text = last.replace(/^!learn\s*/i, '').trim();
        if (!text)
          throw new AppError(400, 'LEARN_EMPTY', 'Bitte hinter !learn einen Wissenstext eingeben.');
        const learned = createSource(db, req.user.id, {
          title: text.slice(0, 80),
          type: 'text',
          documents: [{ text, location: 'Wissensnotiz aus dem Chat' }],
        });
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.end(
          `data: ${JSON.stringify({ type: 'learned', ...learned })}\n\ndata: {"type":"done"}\n\n`,
        );
        return;
      }
      if ((inFlight.get(req.user.id) || 0) >= 2 || globalChats >= 12)
        throw new AppError(
          429,
          'CHAT_BUSY',
          'Es laufen bereits mehrere Antworten. Bitte kurz warten.',
        );
      inFlight.set(req.user.id, (inFlight.get(req.user.id) || 0) + 1);
      globalChats++;
      const controller = new AbortController();
      controllers.add(controller);
      res.on('close', () => controller.abort());
      let ping;
      const send = async (event) => {
        if (res.destroyed) throw new Error('Client closed');
        if (!res.write(`data: ${JSON.stringify(event)}\n\n`))
          await once(res, 'drain', { signal: controller.signal });
      };
      try {
        const { body, model, sources } = await prepareChat(
          db,
          gemini,
          search,
          messages,
          controller.signal,
          config,
        );
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        ping = setInterval(() => {
          if (!res.destroyed) res.write(': keepalive\n\n');
        }, 15000);
        await send({ type: 'sources', sources, model: model.displayName });
        let text = '';
        for await (const event of gemini.stream(model.name, body, controller.signal)) {
          if (event.type === 'delta') text += event.text;
          await send(event);
        }
        if (!text.trim())
          throw new AppError(
            422,
            'EMPTY_RESPONSE',
            'Das Modell hat keine Textantwort geliefert. Bitte die Frage anders formulieren.',
          );

        const lastQuestion = messages.at(-1)?.text;
        const isUnanswered =
          sources.length === 0 ||
          text.includes('[WISSENSLUECKE]') ||
          text.includes('[UNBEANTWORTET]');

        if (isUnanswered && lastQuestion) {
          const trimmedQuestion = lastQuestion.trim();
          const cleanAnswer = text
            .replace(/\[(WISSENSLUECKE|UNBEANTWORTET)\]/gi, '')
            .trim();

          try {
            const existing = db
              .prepare("SELECT id, count FROM inbox WHERE question = ? AND status = 'open'")
              .get(trimmedQuestion);

            let inboxId;
            if (existing) {
              inboxId = existing.id;
              db.prepare(
                'UPDATE inbox SET count = count + 1, answer = ?, updated_at = ? WHERE id = ?',
              ).run(cleanAnswer, Date.now(), existing.id);
            } else {
              inboxId = randomUUID();
              db.prepare(
                `INSERT INTO inbox(id, question, answer, asked_by, asked_by_name, count, status, created_at, updated_at)
                 VALUES(?, ?, ?, ?, ?, 1, 'open', ?, ?)`,
              ).run(
                inboxId,
                trimmedQuestion,
                cleanAnswer,
                req.user?.id || null,
                req.user?.name || null,
                Date.now(),
                Date.now(),
              );
            }

            await send({
              type: 'inbox_recorded',
              inboxId,
              question: trimmedQuestion,
            });
          } catch (inboxErr) {
            console.warn('Failed to record inbox question:', inboxErr.message);
          }
        }

        await send({ type: 'done' });
        res.end();
      } catch (error) {
        if (controller.signal.aborted) {
          if (!res.destroyed) res.end();
          return;
        }
        if (res.headersSent) {
          await send({
            type: 'error',
            code: error instanceof AppError ? error.code : 'CHAT_FAILED',
            message:
              error instanceof AppError
                ? error.message
                : 'Die Antwort wurde unterbrochen. Bitte erneut versuchen.',
          });
          res.end();
        } else throw error;
      } finally {
        clearInterval(ping);
        controllers.delete(controller);
        globalChats--;
        const remaining = Math.max(0, (inFlight.get(req.user.id) || 1) - 1);
        if (remaining) inFlight.set(req.user.id, remaining);
        else inFlight.delete(req.user.id);
      }
    },
  );
  app.use('/api', () => {
    throw new AppError(404, 'NOT_FOUND', 'Diese API-Adresse existiert nicht.');
  });
  app.use(
    express.static(path.join(config.root, 'dist'), {
      index: false,
      maxAge: config.production ? '1h' : 0,
      dotfiles: 'deny',
    }),
  );
  app.get('/{*path}', (_req, res) => {
    const index = path.join(config.root, 'dist', 'index.html');
    if (!fs.existsSync(index))
      return res
        .status(503)
        .type('text')
        .send('Die Oberfläche wurde noch nicht gebaut. Bitte npm run build ausführen.');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root: path.join(config.root, 'dist') });
  });
  app.use((error, req, res, _next) => {
    if (res.headersSent) return res.end();
    let status = error instanceof AppError ? error.status : 500;
    let code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    let message =
      error instanceof AppError
        ? error.message
        : 'Die Anfrage konnte nicht verarbeitet werden. Bitte erneut versuchen.';
    if (error instanceof ZodError) {
      status = 400;
      code = 'INVALID_INPUT';
      message =
        'Bitte die Eingaben prüfen. Pflichtfelder oder zulässige Längen wurden nicht eingehalten.';
    }
    if (error instanceof multer.MulterError) {
      status = 400;
      code = 'UPLOAD_LIMIT';
      message = `Upload abgelehnt: maximal eine Datei mit ${config.uploadMaxBytes / 1024 / 1024} MB.`;
    }
    if (error.type === 'entity.too.large') {
      status = 413;
      code = 'BODY_TOO_LARGE';
      message =
        'Die Anfrage ist zu groß. Bitte die Quelle aufteilen oder ein neues Gespräch beginnen.';
    }
    if (error.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'Ungültige Anfrage.';
    }
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: 'request_failed',
          requestId: req.requestId,
          code,
          errorName: error?.name,
          errorMessage: error?.message,
          stack: error?.stack,
        }),
      );
    res.status(status).json({ error: { code, message, requestId: req.requestId } });
  });
  return {
    app,
    close: async () => {
      for (const c of controllers) c.abort();
      if (!retriever) await search.close();
    },
  };
}
