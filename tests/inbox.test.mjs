import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, model, embedding } from './helpers.mjs';

test('Wissens-Inbox REST API and Role Security', async (t) => {
  const env = await harness(t);
  const { client: adminClient, user: adminUser } = await env.login('admin-user', { role: 'admin' });
  const { client: editorClient, user: editorUser } = await env.login('editor-user');
  const { client: viewerClient, user: viewerUser } = await env.login('viewer-user');

  // Promote editor-user to role 'editor'
  env.db.prepare("UPDATE users SET role = 'editor' WHERE id = ?").run(editorUser.id);
  // Ensure viewer-user has role 'user'
  env.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(viewerUser.id);

  // 1. Viewer is blocked (403)
  const viewerRes = await viewerClient.get('/api/inbox');
  assert.equal(viewerRes.status, 403);

  // 2. Editor and Admin can list inbox
  const emptyList = await editorClient.get('/api/inbox');
  assert.equal(emptyList.status, 200);
  assert.equal(emptyList.body.total, 0);
  assert.equal(emptyList.body.openCount, 0);

  // 3. Admin creates an inbox entry
  const createRes = await env.csrf(adminClient.post('/api/inbox')).send({
    question: 'Wie funktioniert die Zeiterfassung im Betrieb?',
    answer: 'Dazu liegen bisher keine Daten vor.',
  });
  assert.equal(createRes.status, 201);
  const created = createRes.body;
  assert.equal(created.question, 'Wie funktioniert die Zeiterfassung im Betrieb?');
  assert.equal(created.count, 1);
  assert.equal(created.status, 'open');

  // 4. Repeated question increments count
  const duplicateRes = await env.csrf(editorClient.post('/api/inbox')).send({
    question: 'Wie funktioniert die Zeiterfassung im Betrieb?',
    answer: 'Erneute Nachfrage',
  });
  assert.equal(duplicateRes.status, 200);
  assert.equal(duplicateRes.body.count, 2);
  assert.equal(duplicateRes.body.id, created.id);

  // 5. Overview reflects open inbox count
  const overviewRes = await adminClient.get('/api/overview');
  assert.equal(overviewRes.status, 200);
  assert.equal(overviewRes.body.inboxOpen, 1);

  // 6. Update status to resolved and add note
  const patchRes = await env.csrf(editorClient.patch(`/api/inbox/${created.id}`)).send({
    status: 'resolved',
    note: 'Wissen in Tabelle Arbeitszeiten eingepflegt.',
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.status, 'resolved');
  assert.equal(patchRes.body.note, 'Wissen in Tabelle Arbeitszeiten eingepflegt.');

  // 7. Verify filtering
  const openRes = await adminClient.get('/api/inbox?status=open');
  assert.equal(openRes.body.total, 0);

  const resolvedRes = await adminClient.get('/api/inbox?status=resolved');
  assert.equal(resolvedRes.body.total, 1);
  assert.equal(resolvedRes.body.items[0].id, created.id);

  // 8. Delete inbox entry
  const deleteRes = await env.csrf(adminClient.delete(`/api/inbox/${created.id}`));
  assert.equal(deleteRes.status, 200);

  const afterDelete = await adminClient.get('/api/inbox?status=all');
  assert.equal(afterDelete.body.total, 0);
});

test('Chat automatically logs unanswered questions to Inbox', async (t) => {
  const env = await harness(t);
  const { client: adminClient } = await env.login('admin-user');
  await env
    .csrf(adminClient.put('/api/admin/key'))
    .send({ apiKey: 'test-key-not-a-real-google-key-123456789' })
    .expect(200);
  await env
    .csrf(adminClient.put('/api/admin/models'))
    .send({ chatModel: model.name, embeddingModel: embedding.name })
    .expect(200);

  const { client } = await env.login('test-chat-user', { name: 'Max Mustermann' });

  // No sources configured -> 0 sources retrieved
  const response = await env.csrf(client.post('/api/chat')).send({
    messages: [{ role: 'user', text: 'Welche Kleiderordnung gilt im Labor?' }],
  });
  assert.equal(response.status, 200);
  const text = response.text;

  // SSE response should contain inbox_recorded event
  assert.ok(text.includes('inbox_recorded'), 'Should emit inbox_recorded SSE event');

  // Verify in database that the inbox row was created
  const inboxRow = env.db
    .prepare('SELECT * FROM inbox WHERE question LIKE ?')
    .get('%Kleiderordnung gilt im Labor%');
  assert.ok(inboxRow, 'Inbox row must exist in database');
  assert.equal(inboxRow.status, 'open');
  assert.equal(inboxRow.count, 1);
  assert.equal(inboxRow.asked_by_name, 'Max Mustermann');

  // Asking the same question again should increment count
  await env.csrf(client.post('/api/chat')).send({
    messages: [{ role: 'user', text: 'Welche Kleiderordnung gilt im Labor?' }],
  });
  const updatedRow = env.db
    .prepare('SELECT * FROM inbox WHERE id=?')
    .get(inboxRow.id);
  assert.equal(updatedRow.count, 2, 'Count should be incremented to 2');
});
