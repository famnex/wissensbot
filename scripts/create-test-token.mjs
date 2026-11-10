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
  .setExpirationTime(`${config.auth.maxAge}s`)
  .sign(new TextEncoder().encode(config.auth.secret));

const loginUrl = `${config.origin}/#access_token=${jwt}`;
try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'login_url.txt'), loginUrl, 'utf8');
} catch {}

console.log('='.repeat(70));
console.log('  WISSENSRAUM — TEST-ZUGANGSTOKEN');
console.log('='.repeat(70));
console.log(`Benutzer: ${name} (${email})`);
console.log(`Gültigkeit: ${Math.round(config.auth.maxAge / 3600)} Stunden`);
console.log('');
console.log('1-KLICK-LOGIN-URL (im Browser öffnen):');
console.log(loginUrl);
console.log('');
console.log('TOKEN (zum manuellen Einfügen im Login-Formular):');
console.log(jwt);
console.log('='.repeat(70));
