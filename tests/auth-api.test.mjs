import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import request from 'supertest';
import { SignJWT } from 'jose';
import { harness, model, embedding } from './helpers.mjs';

test('JWT: invalid signature, expiry, audience, missing claims and unsigned tokens never create users', async (t) => {
  const h = await harness(t);
  const base = {
    sub: 'intruder',
    iss: h.config.auth.issuer,
    aud: h.config.auth.audience,
    email: 'a@example.test',
    name: 'Name',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const signed = async (claims, secret = h.config.auth.secret) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(secret));
  const noEmail = { ...base };
  delete noEmail.email;
  for (const token of [
    await signed(base, 'a-different-secret-that-is-long-enough'),
    await signed({ ...base, exp: 1 }),
    await signed({ ...base, aud: 'wrong-app' }),
    await signed(noEmail),
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(base)).toString('base64url')}.`,
  ]) {
    const r = await request(h.app)
      .post('/api/auth/exchange')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(r.status, 401);
  }
  assert.equal(h.db.prepare('SELECT count(*) n FROM users').get().n, 0);
});
test('First-admin allocation is atomic; JWT roles are ignored and the last administrator is protected', async (t) => {
  const h = await harness(t);
  const results = await Promise.all([h.login('one'), h.login('two')]);
  assert.equal(results.filter((r) => r.user.role === 'admin').length, 1);
  const admin = results.find((r) => r.user.role === 'admin');
  const user = results.find((r) => r.user.role === 'user');
  assert.match(admin.response.headers['set-cookie'][0], /HttpOnly/);
  assert.match(admin.response.headers['set-cookie'][0], /SameSite=Strict/);
  assert.equal((await user.client.get('/api/admin/settings')).status, 403);
  assert.equal(
    (await h.csrf(user.client.post('/api/sources/text')).send({ title: 'No', text: 'Denied' }))
      .status,
    403,
  );
  assert.equal(
    (
      await h
        .csrf(admin.client.patch(`/api/admin/users/${admin.user.id}`))
        .send({ role: 'user', enabled: true })
    ).status,
    409,
  );
  assert.equal(
    (
      await h
        .csrf(admin.client.patch(`/api/admin/users/${user.user.id}`))
        .send({ role: 'editor', enabled: true })
    ).status,
    200,
  );
  assert.equal(
    (
      await h
        .csrf(user.client.post('/api/sources/text'))
        .send({ title: 'Allowed', text: 'Locally authorized' })
    ).status,
    202,
  );
  assert.equal((await user.client.get('/api/admin/settings')).status, 403);
  await h
    .csrf(admin.client.patch(`/api/admin/users/${user.user.id}`))
    .send({ role: 'editor', enabled: false });
  assert.equal((await user.client.get('/api/me')).status, 403);
});
test('Initialization never reopens after the last admin is removed outside the application', async (t) => {
  const h = await harness(t);
  await h.login();
  h.db.prepare('DELETE FROM users').run();
  const second = await h.login('second');
  assert.equal(second.user.role, 'user');
  const bootstrap = await request(h.app).get('/api/bootstrap');
  assert.equal(bootstrap.body.setup, false);
});
test('Cookie mutations require CSRF protection and hostile browser origins are rejected', async (t) => {
  const h = await harness(t);
  const { client } = await h.login();
  assert.equal(
    (await client.post('/api/sources/text').send({ title: 'Title', text: 'Text' })).status,
    403,
  );
  assert.equal(
    (
      await client
        .post('/api/sources/text')
        .set('Origin', 'https://evil.example')
        .set('X-CSRF-Guard', '1')
        .send({ title: 'Title', text: 'Text' })
    ).status,
    403,
  );
  assert.equal(
    (await h.csrf(client.post('/api/sources/text')).send({ title: 'Title', text: 'Text' })).status,
    202,
  );
  assert.equal((await request(h.app).get('/api/sources')).status, 401);
});
test('Gemini keys are encrypted; model selection and live service tests use server authorization', async (t) => {
  const h = await harness(t);
  const admin = await h.login();
  const user = await h.login('other');
  const key = 'test-key-not-a-real-google-key-123456789';
  const saved = await h.csrf(admin.client.put('/api/admin/key')).send({ apiKey: key });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.models.chat.length, 1);
  assert.ok(
    !h.db.prepare("SELECT value FROM settings WHERE key='gemini_key'").get().value.includes(key),
  );
  assert.equal(h.gemini.key(), key);
  const settings = await admin.client.get('/api/admin/settings');
  assert.ok(!JSON.stringify(settings.body).includes(key));
  assert.equal(
    (
      await h
        .csrf(user.client.put('/api/admin/models'))
        .send({ chatModel: model.name, embeddingModel: embedding.name })
    ).status,
    403,
  );
  assert.equal(
    (
      await h
        .csrf(admin.client.put('/api/admin/models'))
        .send({ chatModel: 'models/gemini-test-image', embeddingModel: embedding.name })
    ).status,
    400,
  );
  assert.equal(
    (
      await h
        .csrf(admin.client.put('/api/admin/models'))
        .send({ chatModel: model.name, embeddingModel: embedding.name })
    ).status,
    200,
  );
  assert.equal(
    (
      await h
        .csrf(admin.client.post('/api/admin/test'))
        .send({ chatModel: model.name, embeddingModel: embedding.name })
    ).status,
    200,
  );
});
test('Learn commands enforce roles and chats never create durable chat records', async (t) => {
  const h = await harness(t);
  const admin = await h.login();
  const user = await h.login('learner');
  const body = {
    messages: [{ role: 'user', text: '!learn Das Sekretariat ist die erste Anlaufstelle.' }],
  };
  assert.equal((await h.csrf(user.client.post('/api/chat')).send(body)).status, 403);
  const learned = await h.csrf(admin.client.post('/api/chat')).send(body);
  assert.equal(learned.status, 200);
  assert.match(learned.text, /learned/);
  assert.equal(h.db.prepare('SELECT count(*) n FROM sources').get().n, 1);
  assert.equal(
    h.db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name LIKE '%chat%' OR name LIKE '%message%'",
      )
      .get().n,
    0,
  );
});
test('Unauthorized and oversized uploads leave no files behind', async (t) => {
  const h = await harness(t, { uploadMaxBytes: 500 });
  const admin = await h.login();
  const user = await h.login('user');
  const unauthorized = await h
    .csrf(user.client.post('/api/sources/upload'))
    .attach('file', Buffer.from('secret'), { filename: 'secret.txt' });
  assert.equal(unauthorized.status, 403);
  const oversized = await h
    .csrf(admin.client.post('/api/sources/upload'))
    .attach('file', Buffer.alloc(1000, 65), { filename: 'big.txt' });
  assert.equal(oversized.status, 400);
  assert.deepEqual(await fs.readdir(h.config.uploadDir), []);
  const ok = await h
    .csrf(admin.client.post('/api/sources/upload'))
    .field('title', 'Knowledge')
    .attach('file', Buffer.from('Valid knowledge'), { filename: 'valid.txt' });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  const removed = await h.csrf(admin.client.delete(`/api/sources/${ok.body.id}`));
  assert.equal(removed.status, 200);
  assert.deepEqual(await fs.readdir(h.config.uploadDir), []);
});
