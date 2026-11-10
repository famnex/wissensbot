import fs from 'node:fs';
import path from 'node:path';
import { SignJWT } from 'jose';
import { configuration } from '../server/config.mjs';

const config = configuration();
if (config.auth.mode !== 'secret' || !config.auth.secret) {
  console.error('Fehler: JWT_MODE in .env muss "secret" sein und JWT_SECRET muss gesetzt sein.');
  process.exit(1);
}

const subject = process.argv[2] || 'admin';
const name = process.argv[3] || 'Lokaler Administrator';
const email = process.argv[4] || 'admin@local.test';
const days = Number(process.argv[5]) || 0;
const expirationSeconds = days > 0 ? days * 86400 : config.auth.maxAge;

const jwt = await new SignJWT({
  email,
  name,
  role: 'admin',
})
  .setProtectedHeader({ alg: config.auth.algorithm || 'HS256' })
  .setSubject(subject)
  .setIssuer(config.auth.issuer)
  .setAudience(config.auth.audience)
  .setIssuedAt()
  .setExpirationTime(`${expirationSeconds}s`)
  .sign(new TextEncoder().encode(config.auth.secret));

const subpath = config.basePath ? (config.basePath.startsWith('/') ? config.basePath : '/' + config.basePath) : '';
const loginUrl = `${config.origin}${subpath}/#access_token=${jwt}`;
try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'login_url.txt'), loginUrl, 'utf8');
} catch {}

const validityLabel =
  days > 0
    ? `${days} Tage`
    : config.auth.maxAge >= 86400
      ? `${Math.round(config.auth.maxAge / 86400)} Tag(e)`
      : `${Math.round(config.auth.maxAge / 3600)} Stunden`;

console.log('='.repeat(70));
console.log('  WISSENSRAUM — ZUGANGS-TOKEN ERSTELLT');
console.log('='.repeat(70));
console.log(`Benutzer:   ${name} (${email})`);
console.log(`Kennung:    ${subject}`);
console.log(`Gültigkeit: ${validityLabel}`);
console.log('');
console.log('1-KLICK-LOGIN-URL (für den Benutzer zum Öffnen im Browser):');
console.log(loginUrl);
console.log('');
console.log('TOKEN (für manuelles Einfügen im Anmeldefenster):');
console.log(jwt);
console.log('='.repeat(70));
console.log('Tipp: Weitere Benutzer anlegen mit:');
console.log('node scripts/create-test-token.mjs <kennung> "<Name>" <email> [tage]');
console.log('='.repeat(70));
