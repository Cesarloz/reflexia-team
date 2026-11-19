import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';

async function fixture(t, options = {}) {
  const prefix = path.join(os.tmpdir(), 'reflexia-tests-');
  const dataDir = await fs.mkdtemp(prefix);
  let app = await createApp({ dataDir, rules: { randomIndex: () => 0 }, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(prefix)));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const req = async (route, input, token, headers = {}) => {
    const response = await fetch(base + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    req, dataDir,
    async restart() {
      await app.close();
      app = await createApp({ dataDir, rules: { randomIndex: () => 0 }, ...options });
      await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.server.address().port}`;
    },
  };
}

test('two independent clients synchronize, recover after restart, and serialize simultaneous actions', async (t) => {
  const { req, restart, dataDir } = await fixture(t);
  const one = (await req('/api/join', { name: 'Alex' })).value;
  const two = (await req('/api/join', { name: 'Alex' })).value;
  assert.notEqual(one.participantId, two.participantId);
  assert.equal(two.state.organizerId, null);
  assert.equal((await req('/api/state', undefined, one.token)).value.participants.length, 2);
  for (const identity of [one, two]) {
    assert.equal((await req('/api/action', { type: 'select', payload: { cards: ['builders', 'designers'] } }, identity.token)).status, 200);
    assert.equal((await req('/api/action', { type: 'confirm' }, identity.token)).status, 200);
  }
  await restart();
  const restored = await req('/api/join', { resumeToken: one.token });
  assert.equal(restored.value.participantId, one.participantId);
  assert.equal(restored.value.state.participants[0].confirmed, true);
  const teams = await req('/api/action', { type: 'formTeams' }, two.token);
  const teamId = teams.value.teams[0].id;
  await req('/api/action', { type: 'startSession' }, one.token);
  const spins = await Promise.all([one, two].map((identity) => req('/api/action', { type: 'spin', payload: { teamId }, requestId: crypto.randomUUID() }, identity.token)));
  assert.ok(spins.every((result) => result.status === 200));
  assert.equal(spins[0].value.turns.length, 1);
  assert.equal(spins[0].value.turns[0].id, spins[1].value.turns[0].id);
  const turn = spins[0].value.turns[0];
  const speaker = turn.participantId === one.participantId ? one : two;
  const listener = turn.participantId === one.participantId ? two : one;
  const draw = await req('/api/action', { type: 'drawAttack', payload: { teamId } }, speaker.token);
  assert.ok(draw.value.turns[0].attackId);
  const notes = await Promise.all([one, two].map((identity, index) => req('/api/action', { type: 'saveContribution', payload: { turnId: turn.id, fields: { title: `Proyecto ${index}`, observations: 'Texto extenso '.repeat(5000) } }, requestId: crypto.randomUUID() }, identity.token)));
  assert.ok(notes.every((result) => result.status === 200));
  const final = await req('/api/state', undefined, two.token);
  assert.equal(final.value.contributions.length, 2);
  assert.equal(new Set(final.value.contributions.map((note) => note.authorId)).size, 2);
  const idempotent = { type: 'finishTurn', payload: { teamId, turnId: turn.id }, requestId: crypto.randomUUID() };
  await req('/api/action', idempotent, listener.token);
  const retry = await req('/api/action', idempotent, listener.token);
  assert.equal(retry.status, 200);
  assert.equal(retry.value.turns.length, 1);
  const mismatch = await req('/api/action', { ...idempotent, type: 'spin' }, listener.token);
  assert.equal(mismatch.status, 409);
  const nextTurnState = await req('/api/action', { type: 'spin', payload: { teamId } }, listener.token);
  const nextTurn = nextTurnState.value.turns.at(-1);
  assert.equal(nextTurn.participantId, listener.participantId);
  await req('/api/action', { type: 'drawAttack', payload: { teamId } }, listener.token);
  const completed = await req('/api/action', { type: 'finishTurn', payload: { teamId, turnId: nextTurn.id } }, speaker.token);
  assert.equal(completed.value.phase, 'finished');
  assert.equal(completed.value.reportEnabled, true);
  assert.equal((await req('/api/state', undefined, listener.token)).value.phase, 'finished');
  const persisted = await fs.readFile(path.join(dataDir, 'session.json'), 'utf8');
  assert.ok(!persisted.includes(one.token)); assert.ok(!persisted.includes(two.token));
});

test('anonymous reads, forged tokens, foreign origins and invalid transitions are rejected', async (t) => {
  const { req } = await fixture(t);
  assert.equal((await req('/api/state')).status, 401);
  assert.equal((await req('/api/state', undefined, 'x'.repeat(43))).status, 401);
  assert.equal((await req('/api/join', { name: 'Cross site' }, null, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await req('/api/join', { resumeToken: 'unknown' })).status, 401);
  const one = (await req('/api/join', { name: 'Primera persona' })).value;
  const two = (await req('/api/join', { name: 'Segunda persona' })).value;
  assert.equal((await req('/api/action', { type: 'formTeams' }, two.token)).status, 409);
  assert.equal((await req('/api/action', { type: 'confirm' }, one.token)).status, 400);
  assert.equal((await req('/api/action', { type: 'enableReport' }, one.token)).status, 409);
  assert.equal((await req('/.runtime/session.json')).status, 404);
  assert.equal((await req('/src/%2e%2e%5c.runtime%5csession.json')).status, 404);
});

test('expired persisted sessions are physically replaced and old tokens stop working', async (t) => {
  const { req, dataDir, restart } = await fixture(t);
  const one = (await req('/api/join', { name: 'Must be deleted' })).value;
  const recordPath = path.join(dataDir, 'session.json');
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  record.state.expiresAt = '2000-01-01T00:00:00.000Z';
  await fs.writeFile(recordPath, JSON.stringify(record));
  await restart();
  assert.equal((await req('/api/state', undefined, one.token)).status, 401);
  const persisted = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  assert.deepEqual(persisted.state.participants, []);
  assert.deepEqual(persisted.tokens, {});
  assert.ok(!JSON.stringify(persisted).includes('Must be deleted'));
});
