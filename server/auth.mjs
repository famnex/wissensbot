import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, importSPKI, jwtVerify } from 'jose';
import { AppError } from './lib/errors.mjs';
import { getSetting, setSetting, audit } from './db/index.mjs';
import { seal, unseal } from './lib/secrets.mjs';

export async function createVerifier(config) {
  const auth = config.auth;
  let key;
  if (auth.mode === 'secret') {
    if (auth.algorithm !== 'HS256' || Buffer.byteLength(auth.secret || '') < 32)
      throw new Error('JWT_MODE=secret benötigt HS256 und ein Secret mit mindestens 32 Bytes.');
    key = new TextEncoder().encode(auth.secret);
  } else {
    if (!['RS256', 'ES256', 'EdDSA'].includes(auth.algorithm))
      throw new Error('Unzulässiger JWT-Algorithmus.');
    if (auth.mode === 'jwks') {
      const url = new URL(auth.jwksUrl);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('JWKS benötigt eine vertrauenswürdige HTTPS-URL.');
      key = createRemoteJWKSet(url, {
        timeoutDuration: 5000,
        cooldownDuration: 10000,
        cacheMaxAge: 300000,
      });
    } else if (auth.mode === 'public_key') {
      key = await importSPKI(fs.readFileSync(auth.publicKeyFile, 'utf8'), auth.algorithm);
    } else throw new Error('JWT_MODE muss jwks, public_key oder secret sein.');
  }
  return async (token) => {
    try {
      if (typeof token !== 'string' || token.length > 16000) throw new Error('Token length');
      const { payload } = await jwtVerify(token, key, {
        issuer: auth.issuer,
        audience: auth.audience,
        algorithms: [auth.algorithm],
        clockTolerance: 5,
        maxTokenAge: auth.maxAge,
        requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'email', 'name'],
      });
      if (
        ![payload.sub, payload.email, payload.name].every(
          (x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 320,
        )
      )
        throw new Error('Claims');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) throw new Error('Email');
      return {
        subject: payload.sub,
        issuer: payload.iss,
        email: payload.email,
        name: payload.name,
        expiresAt: payload.exp * 1000,
      };
    } catch {
      throw new AppError(
        401,
        'INVALID_TOKEN',
        'Die Anmeldung ist ungültig oder abgelaufen. Bitte erneut über deinen Identitätsanbieter anmelden.',
      );
    }
  };
}
export function registerIdentity(db, identity) {
  return db
    .transaction(() => {
      let user = db
        .prepare('SELECT * FROM users WHERE issuer=? AND subject=?')
        .get(identity.issuer, identity.subject);
      if (user && !user.enabled)
        throw new AppError(403, 'USER_DISABLED', 'Dieser Zugang wurde deaktiviert.');
      const initialized = getSetting(db, 'first_admin_completed');
      const hasAdmin = db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get();
      if (hasAdmin && !initialized) setSetting(db, 'first_admin_completed', 'true');
      if (!user) {
        const role = !initialized && !hasAdmin ? 'admin' : 'user';
        const id = randomUUID();
        db.prepare(
          'INSERT INTO users(id,issuer,subject,email,name,role,created_at,last_login_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          id,
          identity.issuer,
          identity.subject,
          identity.email,
          identity.name,
          role,
          Date.now(),
          Date.now(),
        );
        if (role === 'admin') {
          setSetting(db, 'first_admin_completed', 'true');
          audit(db, id, 'first_admin', id);
        }
      } else
        db.prepare('UPDATE users SET email=?,name=?,last_login_at=? WHERE id=?').run(
          identity.email,
          identity.name,
          Date.now(),
          user.id,
        );
      user = db
        .prepare('SELECT * FROM users WHERE issuer=? AND subject=?')
        .get(identity.issuer, identity.subject);
      return user;
    })
    .immediate();
}
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    enabled: Boolean(user.enabled),
  };
}
export function bearer(req) {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}
export function sessionToken(req, config) {
  if (bearer(req)) return bearer(req);
  const name = config.production ? '__Host-wissensraum' : 'wissensraum';
  const value = (req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!value) return null;
  try {
    return unseal(value, config.encryptionKey, 'session');
  } catch {
    return null;
  }
}
export function setSession(res, token, config) {
  const value = token ? seal(token, config.encryptionKey, 'session') : '';
  if (value.length > 3800)
    throw new AppError(
      400,
      'TOKEN_TOO_LARGE',
      'Das JWT ist zu groß für die Browser-Anmeldung. Der Anbieter muss unnötige Claims entfernen. Die Bearer-API unterstützt größere Tokens.',
    );
  res.cookie(config.production ? '__Host-wissensraum' : 'wissensraum', value, {
    httpOnly: true,
    secure: config.production,
    sameSite: 'strict',
    path: '/',
    ...(token ? {} : { maxAge: 0 }),
  });
}
export function authenticate(db, verify, config) {
  return async (req, _res, next) => {
    const token = sessionToken(req, config);
    if (!token) throw new AppError(401, 'LOGIN_REQUIRED', 'Bitte anmelden.');
    const identity = await verify(token);
    const user = db
      .prepare('SELECT * FROM users WHERE issuer=? AND subject=?')
      .get(identity.issuer, identity.subject);
    if (!user) throw new AppError(401, 'LOGIN_REQUIRED', 'Bitte zuerst die Anmeldung abschließen.');
    if (!user.enabled) throw new AppError(403, 'USER_DISABLED', 'Dieser Zugang wurde deaktiviert.');
    req.user = user;
    req.identity = identity;
    next();
  };
}
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!roles.includes(req.user.role))
      throw new AppError(403, 'FORBIDDEN', 'Dafür fehlen dir die erforderlichen Rechte.');
    next();
  };
export function changeUser(db, actor, id, role, enabled) {
  return db
    .transaction(() => {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!user) throw new AppError(404, 'NOT_FOUND', 'Benutzer nicht gefunden.');
      if (user.role === 'admin' && user.enabled && (role !== 'admin' || !enabled)) {
        if (
          db.prepare("SELECT count(*) n FROM users WHERE role='admin' AND enabled=1").get().n <= 1
        )
          throw new AppError(
            409,
            'LAST_ADMIN',
            'Der letzte aktive Administrator muss erhalten bleiben.',
          );
      }
      db.prepare('UPDATE users SET role=?,enabled=? WHERE id=?').run(role, Number(enabled), id);
      audit(db, actor, 'user_permissions_changed', id);
      return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
    })
    .immediate();
}
