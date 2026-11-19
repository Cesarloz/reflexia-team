import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, addParticipant, applyAction, suggestTeams, affinity, CARD_IDS, GameError } from '../src/game.js';

function session(count = 5) {
  let state = createState();
  for (let i = 0; i < count; i++) {
    const id = `person-${i}`;
    state = addParticipant(state, { id, name: i < 2 ? 'Alex' : `Persona ${i}` });
    state = applyAction(state, id, { type: 'select', payload: { cards: [CARD_IDS[i % 4], CARD_IDS[(i + 1) % 4]] } });
    state = applyAction(state, id, { type: 'confirm' });
  }
  return state;
}
function running(count = 5) {
  let state = session(count);
  state = applyAction(state, 'person-1', { type: 'formTeams' });
  return applyAction(state, 'person-0', { type: 'startSession' });
}

test('selection requires exactly two distinct known cards and never mutates input', () => {
  const original = addParticipant(createState(), { id: 'first', name: 'Alex' });
  const unchanged = JSON.stringify(original);
  for (const cards of [['builders', 'builders'], ['builders', 'designers', 'optimizers'], ['fake']]) {
    assert.throws(() => applyAction(original, 'first', { type: 'select', payload: { cards } }), GameError);
  }
  assert.throws(() => applyAction(original, 'first', { type: 'confirm' }), /exactamente dos/);
  const selected = applyAction(original, 'first', { type: 'select', payload: { cards: ['designers', 'builders'] } });
  assert.equal(JSON.stringify(original), unchanged);
  const confirmed = applyAction(selected, 'first', { type: 'confirm' });
  assert.throws(() => applyAction(confirmed, 'first', { type: 'select', payload: { cards: [] } }), /confirmada/);
  assert.equal(applyAction(confirmed, 'first', { type: 'confirm' }), confirmed);
});

test('identical names retain distinct identities; every participant can coordinate without an administrator', () => {
  let state = session(2);
  assert.equal(state.participants[0].name, state.participants[1].name);
  assert.notEqual(state.participants[0].id, state.participants[1].id);
  assert.equal(state.organizerId, null);
  state = applyAction(state, 'person-1', { type: 'formTeams' });
  assert.equal(state.phase, 'teams');
  const teams = state.teams.map((team) => ({ ...team, name: 'Conexiones compartidas' }));
  state = applyAction(state, 'person-0', { type: 'updateTeams', payload: { teams } });
  assert.equal(state.teams[0].name, 'Conexiones compartidas');
  state = applyAction(state, 'person-1', { type: 'startSession' });
  assert.equal(state.phase, 'conversation');
});

test('affinity ignores selection order and reports exact shared cards', () => {
  assert.equal(affinity(['builders', 'designers'], ['designers', 'builders']).level, 'high');
  assert.deepEqual(affinity(['builders', 'designers'], ['explorers', 'designers']).sharedCards, ['designers']);
  assert.equal(affinity(['builders', 'designers'], ['explorers', 'optimizers']).level, 'none');
});

test('grouping produces one membership each and 2–5 people without singletons', () => {
  for (let count = 2; count <= 60; count++) {
    const participants = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, cards: [CARD_IDS[i % 4], CARD_IDS[(i + 1) % 4]] }));
    const teams = suggestTeams(participants);
    assert.ok(teams.every((team) => team.memberIds.length >= 2 && team.memberIds.length <= 5));
    const members = teams.flatMap((team) => team.memberIds);
    assert.equal(members.length, count);
    assert.equal(new Set(members).size, count);
  }
  assert.throws(() => suggestTeams([{ id: 'alone', cards: [] }]), /al menos dos/);
});

test('manual grouping rejects duplicates, omitted members, oversized and singleton teams', () => {
  let state = session(6);
  state = applyAction(state, 'person-1', { type: 'formTeams' });
  const teams = structuredClone(state.teams);
  teams[1].memberIds[0] = teams[0].memberIds[0];
  assert.throws(() => applyAction(state, 'person-0', { type: 'updateTeams', payload: { teams } }), /exactamente un equipo/);
  const singleton = [{ id: 'a', name: 'A', memberIds: ['person-0'] }, { id: 'b', name: 'B', memberIds: ['person-1', 'person-2', 'person-3', 'person-4', 'person-5'] }];
  assert.throws(() => applyAction(state, 'person-1', { type: 'updateTeams', payload: { teams: singleton } }), /entre 2 y 5/);
});

test('turns choose pending speakers once; attacks do not repeat until deck exhausted', () => {
  let state = running(5);
  const teamId = state.teams[0].id;
  const speakers = []; const attacks = [];
  for (let i = 0; i < 5; i++) {
    state = applyAction(state, 'person-0', { type: 'spin', payload: { teamId } }, { randomIndex: () => 0 });
    assert.equal(applyAction(state, 'person-0', { type: 'spin', payload: { teamId } }), state);
    const turn = state.turns.at(-1); speakers.push(turn.participantId);
    state = applyAction(state, turn.participantId, { type: 'drawAttack', payload: { teamId } }, { randomIndex: () => 0 });
    assert.equal(applyAction(state, turn.participantId, { type: 'drawAttack', payload: { teamId } }), state);
    attacks.push(state.turns.at(-1).attackId);
    state = applyAction(state, turn.participantId, { type: 'finishTurn', payload: { teamId, turnId: turn.id } });
    assert.equal(applyAction(state, turn.participantId, { type: 'finishTurn', payload: { teamId, turnId: turn.id } }), state);
  }
  assert.equal(new Set(speakers).size, 5);
  assert.equal(new Set(attacks.slice(0, 4)).size, 4);
  assert.equal(state.teams[0].status, 'finished');
  assert.throws(() => applyAction(state, 'person-0', { type: 'spin', payload: { teamId } }), /fase actual/);
  assert.equal(state.phase, 'finished'); assert.equal(state.reportEnabled, true);
  assert.equal(applyAction(state, 'person-1', { type: 'finishSession' }), state);
  assert.equal(applyAction(state, 'person-2', { type: 'enableReport' }), state);
});

test('other teams cannot spin, draw, finish or contribute; authors retain independent notes', () => {
  let state = running(6);
  const team = state.teams[0]; const stranger = state.teams[1].memberIds[0];
  const actor = team.memberIds[0]; const teammate = team.memberIds[1];
  assert.throws(() => applyAction(state, stranger, { type: 'spin', payload: { teamId: team.id } }), /tu equipo/);
  state = applyAction(state, actor, { type: 'spin', payload: { teamId: team.id } }, { randomIndex: () => 0 });
  const turn = state.turns.at(-1);
  assert.throws(() => applyAction(state, teammate, { type: 'drawAttack', payload: { teamId: team.id } }), /exponiendo/);
  state = applyAction(state, actor, { type: 'drawAttack', payload: { teamId: team.id } });
  // Legacy persisted organizer metadata grants no cross-team permission.
  state.organizerId = stranger;
  assert.throws(() => applyAction(state, stranger, { type: 'finishTurn', payload: { teamId: team.id, turnId: turn.id } }), /tu equipo/);
  assert.throws(() => applyAction(state, stranger, { type: 'saveContribution', payload: { turnId: turn.id, fields: { title: 'Wrong' } } }), /tu equipo/);
  state = applyAction(state, actor, { type: 'saveContribution', payload: { turnId: turn.id, authorId: stranger, fields: { title: 'Primera nota', results: 'Medición A' } } });
  state = applyAction(state, teammate, { type: 'saveContribution', payload: { turnId: turn.id, fields: { title: 'Segunda nota' } } });
  state = applyAction(state, actor, { type: 'saveContribution', payload: { turnId: turn.id, fields: { title: 'Nota corregida' } } });
  assert.equal(state.contributions.length, 2);
  assert.equal(state.contributions.find((note) => note.authorId === actor).fields.results, 'Medición A');
  assert.equal(state.contributions.find((note) => note.authorId === teammate).fields.title, 'Segunda nota');
  assert.ok(!state.contributions.some((note) => note.authorId === stranger));
  assert.throws(() => applyAction(state, actor, { type: 'saveContribution', payload: { turnId: turn.id, fields: { unexpected: 'bad' } } }), /desconocido/);
  assert.throws(() => applyAction(state, actor, { type: 'finishTurn', payload: { teamId: team.id } }), /Indica el turno/);
  state = applyAction(state, teammate, { type: 'finishTurn', payload: { teamId: team.id, turnId: turn.id } });
  assert.equal(state.turns.at(-1).status, 'finished');
});

test('the last team completion automatically closes the session and releases its report', () => {
  let state = running(6);
  for (let teamIndex = 0; teamIndex < state.teams.length; teamIndex++) {
    const teamId = state.teams[teamIndex].id;
    const members = state.teams[teamIndex].memberIds;
    for (let index = 0; index < members.length; index++) {
      state = applyAction(state, members[1], { type: 'spin', payload: { teamId } }, { randomIndex: () => 0 });
      const turn = state.turns.at(-1);
      state = applyAction(state, turn.participantId, { type: 'drawAttack', payload: { teamId } });
      const nonSpeaker = members.find((member) => member !== turn.participantId);
      state = applyAction(state, nonSpeaker, { type: 'finishTurn', payload: { teamId, turnId: turn.id } });
      const isLast = teamIndex === state.teams.length - 1 && index === members.length - 1;
      assert.equal(state.phase, isLast ? 'finished' : 'conversation');
      assert.equal(state.reportEnabled, isLast);
    }
  }
  assert.ok(state.finishedAt);
});

test('phase checks prevent premature reports and require every selection before teams', () => {
  let state = addParticipant(session(2), { id: 'late', name: 'Llegó después' });
  assert.throws(() => applyAction(state, 'person-0', { type: 'formTeams' }), /todos confirmen/);
  assert.throws(() => applyAction(state, 'person-0', { type: 'enableReport' }), /fase actual/);
  state = running(2);
  assert.throws(() => applyAction(state, 'person-0', { type: 'finishSession' }), /pendientes/);
  assert.throws(() => addParticipant(state, { id: 'too-late', name: 'Late' }), /cerrada/);
});
