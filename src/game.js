/** Authoritative game rules shared by the local server and its tests. */
export const CARD_IDS = Object.freeze(['builders', 'designers', 'optimizers', 'explorers']);
export const ATTACK_IDS = Object.freeze(['verification', 'governance', 'privacy', 'security']);
export const FIELD_IDS = Object.freeze(['title', 'created', 'problem', 'tools', 'agents', 'operation', 'results', 'difficulties', 'learning', 'collaboration', 'answer', 'observations', 'conclusions']);

export class GameError extends Error {
  constructor(message, status = 400, code = 'INVALID_ACTION') {
    super(message); this.name = 'GameError'; this.status = status; this.code = code;
  }
}

const assert = (condition, message, status = 400, code) => { if (!condition) throw new GameError(message, status, code); };
const timestamp = (options) => new Date(options.now ?? Date.now()).toISOString();
const identifier = (options) => options.id?.() ?? globalThis.crypto.randomUUID();
const clone = (value) => structuredClone(value);
const touch = (state) => { state.revision += 1; return state; };

export function createState(options = {}) {
  const now = options.now ?? Date.now();
  return {
    id: identifier(options), createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString(),
    phase: 'selection', organizerId: null, reportEnabled: false,
    participants: [], teams: [], turns: [], contributions: [], revision: 0,
  };
}

export function addParticipant(state, participant, options = {}) {
  assert(state.phase === 'selection', 'La selección está cerrada. Espera una nueva actividad para participar.', 409);
  assert(state.participants.length < 500, 'Se alcanzó el límite de participantes.', 409);
  assert(participant?.id && typeof participant.id === 'string', 'Identificador de participante inválido.');
  assert(!state.participants.some((p) => p.id === participant.id), 'El participante ya existe.', 409);
  const name = String(participant.name ?? '').trim();
  assert(name.length >= 1 && name.length <= 100, 'Escribe un nombre de 1 a 100 caracteres.');
  const next = clone(state);
  next.participants.push({ id: participant.id, name, cards: [], confirmed: false, joinedAt: timestamp(options) });
  next.organizerId = null;
  return touch(next);
}

export function affinity(a, b) {
  const aCards = Array.isArray(a) ? a : a.cards;
  const bCards = Array.isArray(b) ? b : b.cards;
  const sharedCards = [...new Set(aCards ?? [])].filter((id) => (bCards ?? []).includes(id));
  return { level: sharedCards.length === 2 ? 'high' : sharedCards.length === 1 ? 'medium' : 'none', sharedCards, score: sharedCards.length };
}

/** Greedy affinity groups with balanced sizes: never a singleton for n >= 2. */
export function suggestTeams(participants, options = {}) {
  assert(participants.length >= 2, 'Se necesitan al menos dos participantes para formar equipos.');
  assert(new Set(participants.map((p) => p.id)).size === participants.length, 'Hay participantes duplicados.');
  const pending = [...participants].sort((a, b) => [...a.cards].sort().join('|').localeCompare([...b.cards].sort().join('|')) || a.id.localeCompare(b.id));
  const count = Math.ceil(pending.length / 5);
  const base = Math.floor(pending.length / count);
  const extra = pending.length % count;
  const teams = [];
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    const members = [pending.shift()];
    while (members.length < size) {
      let best = 0; let bestScore = -1;
      pending.forEach((candidate, candidateIndex) => {
        const score = members.reduce((total, member) => total + affinity(candidate, member).score ** 2, 0);
        if (score > bestScore) { best = candidateIndex; bestScore = score; }
      });
      members.push(pending.splice(best, 1)[0]);
    }
    teams.push({ id: identifier(options), name: `Equipo ${index + 1}`, memberIds: members.map((p) => p.id), status: 'ready', currentTurnId: null });
  }
  return teams;
}

function validatePartition(teams, participants) {
  assert(Array.isArray(teams) && teams.length > 0, 'Debes crear al menos un equipo.');
  assert(new Set(teams.map((team) => team.id)).size === teams.length, 'Los identificadores de equipo deben ser únicos.');
  const members = [];
  for (const team of teams) {
    assert(typeof team.id === 'string' && team.id.length <= 100 && team.id.length > 0, 'Equipo inválido.');
    assert(typeof team.name === 'string' && team.name.trim().length > 0 && team.name.length <= 100, 'Escribe un nombre de equipo válido.');
    assert(Array.isArray(team.memberIds) && team.memberIds.length >= 2 && team.memberIds.length <= 5, 'Cada equipo debe tener entre 2 y 5 integrantes.');
    members.push(...team.memberIds);
  }
  assert(members.length === participants.length && new Set(members).size === members.length && participants.every((p) => members.includes(p.id)), 'Cada participante debe pertenecer a exactamente un equipo.');
}

function randomItem(items, options) {
  assert(items.length > 0, 'No quedan opciones disponibles.', 409);
  const index = options.randomIndex ? options.randomIndex(items.length) : Math.floor(Math.random() * items.length);
  assert(Number.isInteger(index) && index >= 0 && index < items.length, 'El generador aleatorio devolvió un índice inválido.', 500);
  return items[index];
}

/** Apply one authorized transition atomically. Input is never mutated. */
export function applyAction(state, actorId, action, options = {}) {
  const actor = state.participants.find((p) => p.id === actorId);
  assert(actor, 'No se reconoce al participante.', 401, 'UNAUTHORIZED');
  assert(action && typeof action.type === 'string', 'Acción inválida.');
  const payload = action.payload ?? {};
  assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'Contenido de acción inválido.');
  const next = clone(state);
  const person = next.participants.find((p) => p.id === actorId);
  const phase = (...allowed) => assert(allowed.includes(state.phase), 'Esta acción no corresponde a la fase actual.', 409, 'WRONG_PHASE');
  const getTeam = () => {
    const team = next.teams.find((t) => t.id === payload.teamId);
    assert(team, 'No existe ese equipo.', 404);
    assert(team.memberIds.includes(actorId), 'Solo puedes actuar dentro de tu equipo.', 403, 'FORBIDDEN');
    return team;
  };
  switch (action.type) {
    case 'select': {
      phase('selection');
      assert(!person.confirmed, 'La selección ya está confirmada.', 409);
      const cards = payload.cards;
      const allowed = options.cardIds ?? CARD_IDS;
      assert(Array.isArray(cards) && cards.length <= 2 && new Set(cards).size === cards.length && cards.every((id) => allowed.includes(id)), 'Selecciona como máximo dos cartas diferentes.');
      if (JSON.stringify(person.cards) === JSON.stringify(cards)) return state;
      person.cards = [...cards];
      break;
    }
    case 'confirm':
      phase('selection');
      assert(person.cards.length === 2, 'Debes seleccionar exactamente dos cartas.');
      if (person.confirmed) return state;
      person.confirmed = true;
      break;
    case 'formTeams':
      if (state.phase === 'teams') return state;
      phase('selection');
      assert(next.participants.every((p) => p.confirmed), 'Espera a que todos confirmen sus dos cartas.', 409);
      next.teams = suggestTeams(next.participants, options);
      next.phase = 'teams';
      break;
    case 'updateTeams':
      phase('teams');
      validatePartition(payload.teams, next.participants);
      next.teams = payload.teams.map((team) => ({ id: team.id, name: team.name.trim(), memberIds: [...team.memberIds], status: 'ready', currentTurnId: null }));
      break;
    case 'startSession':
      if (state.phase === 'conversation') return state;
      phase('teams'); validatePartition(next.teams, next.participants);
      next.phase = 'conversation';
      break;
    case 'spin': {
      phase('conversation'); const team = getTeam();
      if (team.currentTurnId) return state;
      assert(team.status === 'ready', 'Este equipo ya terminó.', 409);
      const finished = next.turns.filter((turn) => turn.teamId === team.id && turn.status === 'finished').map((turn) => turn.participantId);
      const pending = team.memberIds.filter((id) => !finished.includes(id));
      const turn = { id: identifier(options), teamId: team.id, participantId: randomItem(pending, options), number: next.turns.filter((t) => t.teamId === team.id).length + 1, attackId: null, status: 'active', createdAt: timestamp(options) };
      next.turns.push(turn); team.currentTurnId = turn.id; team.status = 'attack';
      break;
    }
    case 'drawAttack': {
      phase('conversation'); const team = getTeam();
      const turn = next.turns.find((t) => t.id === team.currentTurnId);
      assert(turn, 'Primero selecciona a un expositor.', 409);
      assert(turn.participantId === actorId, 'La carta debe elegirla la persona que está exponiendo.', 403);
      if (turn.attackId) return state;
      assert(team.status === 'attack', 'La carta no se puede elegir en esta fase.', 409);
      const deck = [...new Set(options.attackIds ?? ATTACK_IDS)];
      assert(deck.length > 0, 'No hay cartas de ataque configuradas.', 409);
      const drawn = next.turns.filter((t) => t.teamId === team.id && t.attackId && deck.includes(t.attackId)).map((t) => t.attackId);
      const usedThisCycle = drawn.slice(drawn.length - (drawn.length % deck.length));
      turn.attackId = randomItem(deck.filter((id) => !usedThisCycle.includes(id)), options);
      team.status = 'recording';
      break;
    }
    case 'saveContribution': {
      phase('conversation', 'finished');
      const turn = next.turns.find((t) => t.id === payload.turnId);
      assert(turn, 'No existe ese turno.', 404);
      const team = next.teams.find((t) => t.id === turn.teamId);
      assert(team.memberIds.includes(actorId), 'Solo puedes documentar experiencias de tu equipo.', 403);
      assert(turn.attackId, 'Primero debe revelarse la carta de ataque.', 409);
      assert(payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields), 'Las aportaciones deben contener campos de texto.');
      const allowedFields = options.fieldIds ?? FIELD_IDS;
      const fields = {};
      for (const [key, value] of Object.entries(payload.fields)) {
        assert(allowedFields.includes(key), `Campo desconocido: ${key}.`);
        assert(typeof value === 'string' && value.length <= 100000, 'Cada respuesta puede contener hasta 100 000 caracteres.');
        fields[key] = value;
      }
      let contribution = next.contributions.find((c) => c.turnId === turn.id && c.authorId === actorId);
      if (!contribution) {
        contribution = { id: identifier(options), turnId: turn.id, authorId: actorId, fields: {}, updatedAt: timestamp(options) };
        next.contributions.push(contribution);
      }
      contribution.fields = { ...contribution.fields, ...fields };
      contribution.updatedAt = timestamp(options);
      break;
    }
    case 'finishTurn': {
      phase('conversation', 'finished');
      const team = getTeam();
      const turn = next.turns.find((t) => t.id === payload.turnId && t.teamId === team.id);
      assert(turn, 'Indica el turno que deseas finalizar.', 400);
      if (turn.status === 'finished') return state;
      phase('conversation');
      assert(team.currentTurnId === turn.id && team.status === 'recording', 'El turno no está listo para finalizar.', 409);
      turn.status = 'finished'; turn.finishedAt = timestamp(options); team.currentTurnId = null;
      const completed = new Set(next.turns.filter((t) => t.teamId === team.id && t.status === 'finished').map((t) => t.participantId));
      team.status = team.memberIds.every((id) => completed.has(id)) ? 'finished' : 'ready';
      if (next.teams.every((item) => item.status === 'finished')) {
        next.phase = 'finished';
        next.finishedAt = timestamp(options);
        next.reportEnabled = true;
      }
      break;
    }
    case 'finishSession':
      if (state.phase === 'finished') return state;
      phase('conversation');
      assert(next.teams.every((team) => team.status === 'finished'), 'Todavía hay participantes pendientes de compartir.', 409);
      next.phase = 'finished'; next.finishedAt = timestamp(options); next.reportEnabled = true;
      break;
    case 'enableReport':
      phase('finished');
      if (state.reportEnabled) return state;
      next.reportEnabled = true;
      break;
    default: throw new GameError('Acción desconocida.');
  }
  return touch(next);
}
