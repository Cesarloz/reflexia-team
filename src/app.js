import { CARDS, ATTACKS, CARD_BACK, FIELDS } from './catalog.js';
import { createTransport } from './transport.js';
import { createDictation } from './voice.js';

const app = document.querySelector('#app');
const transport = createTransport();
const ui = { state: null, me: null, busy: false, online: navigator.onLine, error: '', revealed: new Set(), confirm: false, help: false, group: 'Proyecto', editingTurn: null, teamDraft: null, saveStatus: 'Guardado', drafts: {}, dirty: new Set(), saving: null, exporting: false, expiredIdentity: false };
let saveTimer, toastTimer;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const person = id => ui.state?.participants.find(item => item.id === id);
const me = () => person(ui.me);
const myTeam = () => ui.state?.teams.find(team => team.memberIds.includes(ui.me));
const names = ids => ids.map(id => CARDS.find(card => card.id === id)?.name || id).join(' · ');
const initials = name => String(name).trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
const disabled = condition => condition || ui.busy ? 'disabled' : '';
const pending = team => team.memberIds.filter(id => !ui.state.turns.some(turn => turn.teamId === team.id && turn.participantId === id && turn.status === 'finished'));
const completed = team => ui.state.turns.filter(turn => turn.teamId === team.id && turn.status === 'finished').length;
const draftKey = () => `reflexia:drafts:${ui.state?.id}:${ui.me}`;

function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message; node.classList.add('show');
  document.querySelector('#announcer').textContent = message;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 4500);
}

function accept(state) {
  if (!state || (ui.state?.id === state.id && ui.state.revision > state.revision)) return;
  ui.state = state; ui.online = true;
}

function restoreDrafts() {
  try { const saved = JSON.parse(localStorage.getItem(draftKey()) || '{}'); ui.drafts = saved.drafts || {}; ui.dirty = new Set(saved.dirty || []); }
  catch { ui.drafts = {}; ui.dirty = new Set(); }
}
function persistDrafts() {
  try { localStorage.setItem(draftKey(), JSON.stringify({ drafts: ui.drafts, dirty: [...ui.dirty], expiresAt: ui.state.expiresAt })); }
  catch { toast('El navegador no permite guardar el borrador local. Mantén esta pestaña abierta hasta sincronizar.'); }
}
function fieldsFor(turnId) {
  return ui.drafts[turnId] || ui.state.contributions.find(note => note.turnId === turnId && note.authorId === ui.me)?.fields || {};
}
function setField(turnId, field, value) {
  ui.drafts[turnId] = { ...fieldsFor(turnId), [field]: value };
  ui.dirty.add(turnId); ui.saveStatus = 'Guardando…'; persistDrafts();
  const status = document.querySelector('.save-state'); if (status) status.textContent = ui.saveStatus;
  clearTimeout(saveTimer); saveTimer = setTimeout(() => flushNotes().catch(() => {}), 800);
}
async function flushNotes() {
  clearTimeout(saveTimer);
  if (ui.saving) { await ui.saving; if (ui.dirty.size) return flushNotes(); return; }
  ui.saving = (async () => {
    for (const turnId of [...ui.dirty]) {
      const fields = { ...ui.drafts[turnId] };
      try {
        const state = await transport.action('saveContribution', { turnId, fields });
        accept(state);
        if (JSON.stringify(ui.drafts[turnId]) === JSON.stringify(fields)) ui.dirty.delete(turnId);
        persistDrafts();
      } catch (error) {
        ui.online = transport.status === 'connected'; ui.saveStatus = 'Pendiente de sincronizar';
        const status = document.querySelector('.save-state'); if (status) status.textContent = ui.saveStatus;
        throw error;
      }
    }
    ui.saveStatus = ui.dirty.size ? 'Guardando…' : 'Guardado';
    const status = document.querySelector('.save-state'); if (status) status.textContent = ui.saveStatus;
  })();
  try { await ui.saving; } finally { ui.saving = null; }
}

async function act(type, payload = {}, after) {
  if (ui.busy) return;
  ui.busy = true; ui.error = ''; render();
  try {
    accept(await transport.action(type, payload));
    if (after) await after();
  } catch (error) { ui.error = error.message; toast(error.message); ui.online = transport.status === 'connected'; }
  finally { ui.busy = false; render(); }
}

function header() {
  return `<header class="topbar"><div class="brand"><span class="wordmark">Reflex<span>IA</span></span><span class="brand-divider"></span><small>TEAM AGENTES<br>COMUNIDAD · DIÁLOGO · FUTUROS</small></div><div class="top-actions">${ui.state ? `<span class="connection ${ui.online ? '' : 'offline'}">${ui.online ? 'En conexión' : 'Reconectando'}</span><span class="profile"><span class="avatar">${esc(initials(me()?.name || ''))}</span><span class="profile-name">${esc(me()?.name)}</span></span>` : '<span class="connection">Una experiencia para compartir</span>'}<button class="outline" data-action="help" aria-expanded="${ui.help}">Cómo jugar</button></div></header>`;
}
function help() {
  return ui.help ? `<section class="help-panel"><h3>Una mesa, muchas posibilidades</h3><ol><li>Voltea las cuatro cartas y elige las dos que te representan.</li><li>Confirma tu elección. Cualquier participante puede reunir los equipos por afinidad.</li><li>La ruleta elige a una persona. Esa persona revela una carta de ataque.</li><li>Comparte tu experiencia y registra las ideas de tus compañeros.</li><li>Al terminar, descarga el reporte con las aportaciones de todos.</li></ol><p>Las notas son visibles para los participantes de esta actividad. Cada persona edita sus propias aportaciones.</p></section>` : '';
}
function welcome() {
  return `${header()}<main id="main" class="welcome">${help()}<div class="hero"><div class="hero-copy"><div class="eyebrow">ReflexIA Card Challenge</div><h1>Tu experiencia.<br>Tus habilidades.<br><span class="gradient-text">Nuevas conexiones.</span></h1><p class="hero-description">Lo que creas con inteligencia artificial puede inspirar a alguien más. Descubre tus afinidades y comparte lo que estás construyendo.</p><form class="join-form" id="join"><label for="participant-name">¿Cómo te llamas?</label><div class="join-controls"><input id="participant-name" name="name" placeholder="Tu nombre" autocomplete="given-name" maxlength="100" required ${disabled(false)}><button class="primary" ${disabled(false)}>${ui.busy ? 'Entrando…' : 'Entrar a la mesa'}</button></div><p class="privacy-note">Sin cuenta ni contraseña. Tus aportaciones y el reporte serán accesibles para los participantes de esta actividad.</p>${ui.error ? `<p class="error-message" role="alert">${esc(ui.error)}</p>${ui.expiredIdentity ? '<button type="button" class="outline" data-action="resetIdentity">Entrar a una nueva actividad</button>' : ''}` : ''}</form></div><div class="hero-art" aria-label="Cartas originales de ReflexIA"><img class="hero-card one" src="${CARDS[1].image}" alt="Carta original Diseñadores"><img class="hero-card two" src="${CARDS[3].image}" alt="Carta original Exploradores"><img class="hero-card three" src="${CARDS[0].image}" alt="Carta original Constructores"><div class="floating-label"><span>✧</span> Cada experiencia abre una posibilidad</div></div></div><div class="welcome-steps"><div class="welcome-step"><span class="step-symbol">◇</span><div><h3>Encuentra tu combinación</h3><p>Cuatro habilidades. Elige las dos que te representan.</p></div></div><div class="welcome-step"><span class="step-symbol">◎</span><div><h3>Conecta con tu equipo</h3><p>Descubre a quienes comparten tus intereses.</p></div></div><div class="welcome-step"><span class="step-symbol">✦</span><div><h3>Comparte lo que creas</h3><p>Una pregunta, una experiencia y nuevas ideas.</p></div></div></div></main><footer class="footer"><span>COMUNIDAD · DIÁLOGO · FUTUROS</span><span>ReflexIA Team Agentes · El conocimiento crece cuando se comparte.</span></footer>`;
}
function phaseNav() {
  const active = ui.state.phase === 'selection' ? 0 : ui.state.phase === 'teams' ? 1 : ui.state.phase === 'conversation' ? 2 : 3;
  return `<nav class="phase-nav" aria-label="Progreso de la actividad">${['Tus cartas','Conexiones','La conversación','Misión completada'].map((label,index) => `<span class="${index === active ? 'active' : index < active ? 'past' : ''}" ${index === active ? 'aria-current="step"' : ''}><i>${index < active ? '✓' : index + 1}</i>${label}</span>`).join('')}</nav>`;
}
function rosterMember(participant, team) {
  const done = team && ui.state.turns.some(turn => turn.teamId === team.id && turn.participantId === participant.id && turn.status === 'finished');
  const current = team && ui.state.turns.find(turn => turn.id === team.currentTurnId)?.participantId === participant.id;
  return `<div class="member"><span class="avatar">${esc(initials(participant.name))}</span><div class="member-info"><div class="member-name">${esc(participant.name)}${participant.id === ui.me ? ' <small class="muted">(tú)</small>' : ''}</div><div class="member-status ${participant.confirmed ? 'ready' : ''}">${done ? '✓ Ya compartió' : current ? 'Compartiendo su experiencia' : participant.confirmed ? '✓ Elección confirmada' : 'Explorando sus cartas'}</div>${participant.cards?.length ? `<div class="member-cards">${participant.cards.map(id=>`<span class="mini-tag">${esc(CARDS.find(card=>card.id===id)?.name || id)}</span>`).join('')}</div>` : ''}</div></div>`;
}
function sidebar() {
  const team = myTeam(), participants = team ? team.memberIds.map(person) : ui.state.participants;
  const confirmed = ui.state.participants.filter(p=>p.confirmed).length;
  return `<aside class="sidebar" aria-label="Participantes y equipos"><div class="sidebar-heading"><h3>${team ? esc(team.name) : 'En la mesa'}</h3><span class="count-pill">${participants.length}</span></div><p class="sidebar-intro">${team ? 'Distintas experiencias, una conexión.' : `${confirmed} de ${participants.length} elecciones confirmadas`}</p><div class="roster">${participants.filter(Boolean).map(p=>rosterMember(p,team)).join('')}</div>${team ? `<div class="sidebar-section"><h4>El recorrido de tu equipo</h4><p>${completed(team)} de ${team.memberIds.length} experiencias compartidas</p><div class="progress-track"><span style="width:${completed(team)/team.memberIds.length*100}%"></span></div></div>` : ''}<div class="sidebar-section"><h4>Una conversación que suma</h4><p>Escucha con curiosidad. Pregunta, comparte tus aprendizajes y descubre qué podrían crear juntos.</p><button class="outline full" data-action="share">Copiar enlace de la actividad</button></div>${sharedControls()}<div class="sidebar-section"><p>${transport.mode === 'local' ? 'Actividad compartida en el servidor local.' : 'Actividad conectada a Supabase.'} Actualización cada ${transport.pollIntervalMs / 1000} s.</p><p>La sesión vence el ${esc(new Date(ui.state.expiresAt).toLocaleString('es-MX',{timeZone:'America/Mexico_City',dateStyle:'medium',timeStyle:'short'}))}.</p></div></aside>`;
}
function sharedControls() {
  const state = ui.state, ready = state.participants.length >= 2 && state.participants.every(p=>p.confirmed);
  if(!['selection','teams'].includes(state.phase))return '';
  return `<div class="sidebar-section"><span class="pill">DECIDIMOS JUNTOS</span><p>Todos tienen los mismos controles. Esperen a que haya entrado el grupo completo.</p><div class="session-tools">${state.phase === 'selection' ? `<button class="primary" data-action="formTeams" ${disabled(!ready)}>Cerrar selección y formar equipos</button>${!ready ? '<p>Se necesitan al menos dos personas y todas las elecciones confirmadas.</p>' : ''}` : `<button class="primary" data-action="startSession" ${disabled(false)}>Confirmar equipos e iniciar</button>`}</div></div>`;
}
function selection() {
  const p = me();
  if (ui.confirm || p.confirmed) return `<div class="section-top"><div><div class="eyebrow">Tu combinación</div><h2>${p.confirmed ? 'Tu lugar en el equipo empieza aquí.' : 'Dos cartas. Muchas posibilidades.'}</h2><p>${p.confirmed ? 'Tu elección está confirmada. En cuanto todos estén listos, cualquiera podrá formar los equipos.' : 'Estas son las habilidades que elegiste. ¿Te representan?'}</p></div></div><div class="selection-preview">${p.cards.map(id=>{const c=CARDS.find(card=>card.id===id);return `<figure><button class="card-image-button" data-action="zoom" data-id="${id}"><img src="${c.image}" alt="${c.name}"></button><figcaption>${c.name}</figcaption></figure>`;}).join('')}</div><div class="center">${p.confirmed ? '<span class="success-ring">✓</span><p class="muted">Elección guardada y compartida con la mesa.</p>' : `<div class="button-row" style="justify-content:center"><button class="outline" data-action="backSelection" ${disabled(false)}>Cambiar mis cartas</button><button class="primary" data-action="confirm" ${disabled(false)}>Confirmar estas dos cartas</button></div>`}</div><div class="tip"><span class="tip-symbol">✧</span><span>Una misma combinación crea una afinidad alta. Compartir una carta abre otra conexión. Cada equipo reúne entre 2 y 5 participantes.</span></div>`;
  return `<div class="section-top"><div><div class="eyebrow">Encuentra tus habilidades</div><h2>¿Qué estás creando con IA?</h2><p>Voltea las cartas para explorarlas. Elige las dos que mejor representan tus experiencias, habilidades o intereses.</p></div><div class="selection-count">${p.cards.length}<span class="muted"> / 2</span><small>cartas elegidas</small></div></div><div class="card-grid">${CARDS.map((c,index)=>{const selected=p.cards.includes(c.id),revealed=ui.revealed.has(c.id);return `<article class="card-item ${revealed ? 'revealed' : ''} ${selected ? 'selected' : ''}" style="--accent:${c.color};--index:${index}"><button class="card-image-button" data-action="flip" data-id="${c.id}" aria-label="${revealed ? 'Mostrar reverso de' : 'Voltear carta de'} ${c.name}" aria-pressed="${revealed}"><span class="card-flip"><span class="card-face back"><img src="${CARD_BACK}" alt="Reverso original ReflexIA"></span><span class="card-face front"><img src="${c.image}" alt="Carta original ${c.name}"></span></span></button><div class="card-caption"><h3>${revealed ? c.name : 'Una habilidad por descubrir'}</h3><p>${revealed ? c.tagline : 'Toca la carta para revelarla'}</p></div><div class="card-tools">${revealed ? `<button class="outline ${selected ? 'selected-button' : ''}" data-action="select" data-id="${c.id}" aria-pressed="${selected}" ${disabled(!selected && p.cards.length>=2)}>${selected ? '✓ Elegida' : 'Elegir carta'}</button><button class="icon-button zoom-button" data-action="zoom" data-id="${c.id}" aria-label="Ampliar ${c.name}">⌕</button>` : `<button class="outline" data-action="flip" data-id="${c.id}">Descubrir carta</button>`}</div></article>`;}).join('')}</div><div class="action-bar"><p>${p.cards.length === 2 ? 'Tu combinación está lista. Revísala antes de confirmar.' : 'No hay una elección correcta: hay una que habla de ti.'}</p><button class="primary" data-action="reviewSelection" ${disabled(p.cards.length!==2)}>Revisar mi elección</button></div><div class="tip"><span class="tip-symbol">✧</span><span>Piensa en algo que hayas creado, probado o aprendido con IA. Tu experiencia puede ser el punto de partida de una gran conversación.</span></div>`;
}
function teamsView() {
  const teams = ui.teamDraft || ui.state.teams;
  return `<div class="section-top"><div><div class="eyebrow">Afinidades que nos reúnen</div><h2>Las conexiones ya están aquí.</h2><p>¡Han encontrado sus conexiones! Reúnanse con su equipo y descubran lo que sus compañeros están creando con inteligencia artificial.</p></div></div><div class="team-grid">${teams.map(team=>`<article class="team-box"><h3>${esc(team.name)}<span class="count-pill">${team.memberIds.length} personas</span></h3>${team.memberIds.map(id=>{const p=person(id);return `${rosterMember(p)}<label class="sr-only" for="move-${id}">Equipo de ${esc(p.name)}</label><select id="move-${id}" data-move="${id}" ${disabled(false)}>${teams.map(option=>`<option value="${option.id}" ${option.id===team.id?'selected':''}>${esc(option.name)}</option>`).join('')}</select>`;}).join('')}<p class="affinity">${affinityText(team)}</p></article>`).join('')}</div>${ui.teamDraft ? `<div class="action-bar"><p>Los cambios se comparten al guardarlos. Mantén de 2 a 5 personas por equipo.</p><button class="primary" data-action="saveTeams" ${disabled(false)}>Guardar distribución</button><button class="outline" data-action="cancelTeams">Cancelar</button></div>` : ''}<div class="tip"><span class="tip-symbol">◎</span><span>Puedes ajustar los integrantes antes de confirmar los equipos. Al iniciar, cada equipo seguirá su propia ruleta y su propio ritmo.</span></div>`;
}
function affinityText(team) {
  const members=team.memberIds.map(person);let high=0,medium=0;
  for(let i=0;i<members.length;i++)for(let j=i+1;j<members.length;j++){const shared=members[i].cards.filter(id=>members[j].cards.includes(id)).length;if(shared===2)high++;else if(shared===1)medium++;}
  return high || medium ? `${high ? `${high} ${high===1?'coincidencia alta':'coincidencias altas'}` : ''}${high&&medium?' · ':''}${medium ? `${medium} ${medium===1?'conexión por una carta':'conexiones por una carta'}` : ''}` : 'Equipo complementario: exploren lo que pueden aprender de sus diferencias.';
}
function conversation() {
  const team = myTeam();
  if (!team) return '<div class="empty"><h3>Sin equipo asignado</h3><p>Revisa con el grupo la distribución de equipos.</p></div>';
  if (ui.editingTurn) return recording(ui.state.turns.find(t=>t.id===ui.editingTurn), true);
  if (team.status === 'finished') return finished(false);
  const turn=ui.state.turns.find(t=>t.id===team.currentTurnId);
  if (!turn) return wheelView(team);
  if (!turn.attackId) return attackView(team,turn);
  return recording(turn);
}
function wheelView(team) {
  const left=pending(team),palette=['#9f6faf','#5f71ae','#418b9b','#9573be','#b7789f'];
  const gradient=left.map((id,index)=>`${palette[index%palette.length]} ${index/left.length*360}deg ${(index+1)/left.length*360}deg`).join(',');
  return `<div class="section-top"><div><div class="eyebrow">${esc(team.name)}</div><h2>Es momento de compartir.</h2><p>Cada voz cuenta. La ruleta elegirá a alguien que todavía no haya participado.</p></div></div><div class="wheel-stage"><div class="wheel" style="background:conic-gradient(${gradient})">${left.map((id,index)=>`<span class="wheel-label" style="transform:rotate(${(index+.5)/left.length*360}deg)">${esc(person(id).name)}</span>`).join('')}<div class="wheel-center"><span>${left.length}</span><small>por compartir</small></div></div><div class="wheel-copy"><span class="pill">EL SIGUIENTE TURNO</span><h3>Una experiencia puede<br>encender una idea.</h3><p>La persona elegida revelará una pregunta para acompañar su presentación.</p><div class="pending-list">${left.map(id=>`<span class="pill">${esc(person(id).name)}</span>`).join('')}</div><button class="primary" data-action="spin" ${disabled(false)}>${completed(team) ? 'Elegir siguiente participante' : 'Iniciar dinámica'}</button></div></div>`;
}
function attackView(team,turn) {
  const speaker=person(turn.participantId), own=turn.participantId===ui.me;
  const recent=Date.now()-Date.parse(turn.createdAt)<2200;
  if(recent&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    const left=pending(team),angle=-(left.indexOf(turn.participantId)+.5)/left.length*360;
    setTimeout(()=>{if(myTeam()?.currentTurnId===turn.id)render();},Math.max(10,2250-(Date.now()-Date.parse(turn.createdAt))));
    return `<div class="section-top"><div><div class="eyebrow">${esc(team.name)}</div><h2>La ruleta está girando…</h2><p>Una sola elección compartida por todo tu equipo.</p></div></div><div class="wheel-stage"><div class="wheel spinning" style="--winner-angle:${angle}deg;transform:rotate(${angle}deg)">${left.map((id,index)=>`<span class="wheel-label" style="transform:rotate(${(index+.5)/left.length*360}deg)">${esc(person(id).name)}</span>`).join('')}<div class="wheel-center"><span>✦</span></div></div><div class="wheel-copy"><h3>¿Quién comparte ahora?</h3><div class="pending-list">${left.map(id=>`<span class="pill">${esc(person(id).name)}</span>`).join('')}</div></div></div>`;
  }
  return `<div class="section-top"><div><div class="eyebrow">La ruleta eligió a</div><h2>${esc(speaker.name)}<span class="gradient-text">, este es tu momento.</span></h2><p>${own ? 'Elige una carta boca abajo. Su pregunta acompañará tu experiencia.' : 'Escucha su experiencia. En cuanto revele su pregunta podrás comenzar a documentarla.'}</p></div></div>${recent ? '<div class="wheel spinning" style="width:110px;height:110px;margin:10px auto"><div class="wheel-center" style="width:60px;height:60px">✦</div></div>' : ''}<div class="attack-grid">${ATTACKS.map((card,index)=>`<button class="attack-back" data-action="drawAttack" data-id="${index}" ${disabled(!own)} aria-label="Revelar carta de ataque ${index+1}"><img src="${CARD_BACK}" alt="Carta de ataque boca abajo"><span>${own ? 'Revelar pregunta' : 'Espera su elección'}</span></button>`).join('')}</div><div class="tip"><span class="tip-symbol">✦</span><span>La carta se sortea una sola vez para todo el equipo. No se repetirá una pregunta hasta agotar las cuatro cartas.</span></div>`;
}
function recording(turn,history=false) {
  if(!turn)return '';
  const speaker=person(turn.participantId),attack=ATTACKS.find(a=>a.id===turn.attackId), fields=fieldsFor(turn.id),groupFields=FIELDS.filter(field=>field.group===ui.group);
  const notes=ui.state.contributions.filter(note=>note.turnId===turn.id && note.authorId!==ui.me);
  return `<div class="section-top"><div><div class="eyebrow">${history?'Tus aportaciones':'Compartiendo su experiencia'}</div><h2>${esc(speaker.name)}</h2><p>${esc(names(speaker.cards))}</p></div>${history?'<button class="outline" data-action="closeHistory">Volver</button>':''}</div><div class="record-layout"><aside class="attack-display">${attack ? `<img src="${attack.image}" alt="Carta de ataque ${attack.name}" data-action="zoom" data-id="${attack.id}" tabindex="0" role="button"><h3>${attack.name}</h3><p>${attack.question}</p><button class="text-button" data-action="zoom" data-id="${attack.id}">Ampliar carta original</button>` : '<p>Sin pregunta registrada</p>'}</aside><section class="form-panel"><div class="form-title"><div><h3>Lo que vale la pena recordar</h3><p class="muted" style="font-size:.75rem;margin-top:6px">Aportación de ${esc(me().name)}</p></div><span class="save-state" role="status">${esc(ui.saveStatus)}</span></div><div class="form-tabs" role="tablist" aria-label="Secciones del registro">${['Proyecto','Experiencia','Reflexión'].map(group=>`<button role="tab" aria-selected="${ui.group===group}" class="${ui.group===group?'active':''}" data-action="formTab" data-id="${group}">${group}</button>`).join('')}</div><form id="notes" data-turn="${turn.id}" onsubmit="return false">${groupFields.map(field=>`<div class="field"><label for="field-${field.id}">${field.label}</label>${field.id==='title'?`<input id="field-${field.id}" data-field="${field.id}" value="${esc(fields[field.id] || '')}" placeholder="Escribe aquí…">`:`<textarea id="field-${field.id}" data-field="${field.id}" placeholder="Registra lo que la persona comparte…">${esc(fields[field.id] || '')}</textarea>`}<div class="field-tools"><button type="button" data-action="dictate" data-id="${field.id}" data-turn="${turn.id}">♩ Dictar o transcribir respuesta</button></div></div>`).join('')}</form><div class="button-row"><button class="outline" data-action="saveNotes" ${disabled(false)}>Guardar mis aportaciones</button>${ui.group!=='Reflexión'?`<button class="text-button" data-action="formTab" data-id="${ui.group==='Proyecto'?'Experiencia':'Reflexión'}">Continuar a ${ui.group==='Proyecto'?'Experiencia':'Reflexión'}</button>`:''}</div><div class="note-authors"><h4>Aportaciones del equipo · ${notes.length}</h4>${notes.length?notes.map(note=>`<details><summary>${esc(person(note.authorId)?.name || 'Participante')}</summary>${FIELDS.filter(field=>note.fields[field.id]).map(field=>`<p><strong>${field.label}</strong><br>${esc(note.fields[field.id])}</p>`).join('')}</details>`).join(''):'<p class="muted" style="font-size:.8rem">Cada integrante puede documentar desde su dispositivo. Las notas conservan su autor.</p>'}</div></section></div>${!history && myTeam()?.id===turn.teamId?`<div class="action-bar"><p>Comprueba que tu equipo haya guardado sus aportaciones antes de continuar.</p><button class="primary" data-action="finishTurn" data-id="${turn.id}" ${disabled(false)}>Finalizar participación y elegir siguiente</button></div>`:''}`;
}
function finished(global) {
  if (ui.editingTurn) return recording(ui.state.turns.find(t=>t.id===ui.editingTurn),true);
  const team=myTeam(),turns=global?ui.state.turns:ui.state.turns.filter(t=>t.teamId===team?.id);
  return `<div class="center"><div class="finish-art" aria-hidden="true">✦</div><div class="eyebrow" style="justify-content:center">ReflexIA · Comunidad que crea</div><h2 style="margin-top:20px">¡Misión completada!</h2><p class="team-message">Cada experiencia compartida abre nuevas posibilidades para aprender, crear y colaborar con IA.</p><div class="summary-stats"><div><strong>${global?ui.state.participants.length:team?.memberIds.length}</strong><span>experiencias</span></div><div><strong>${global?ui.state.teams.length:1}</strong><span>${global?'equipos':'equipo'}</span></div><div><strong>${ui.state.contributions.filter(note=>turns.some(turn=>turn.id===note.turnId)).length}</strong><span>aportaciones</span></div></div>${ui.state.reportEnabled?`<button class="primary" data-action="download" ${disabled(false)}>Descargar reporte Word</button>`:`<p class="muted">${global?'El reporte estará disponible al terminar todos los equipos.':'Tu equipo ha terminado. Los demás equipos pueden continuar a su ritmo.'}</p>`}</div><div class="report-list">${turns.map(turn=>`<article class="report-item"><div><h3>${esc(person(turn.participantId)?.name)}</h3><p>${esc(ui.state.teams.find(t=>t.id===turn.teamId)?.name)} · ${ui.state.contributions.filter(note=>note.turnId===turn.id).length} aportaciones</p></div>${team?.id===turn.teamId?`<button class="outline" data-action="editHistory" data-id="${turn.id}">Revisar mis notas</button>`:'<span class="pill">Experiencia registrada</span>'}</article>`).join('')}</div>`;
}
function render() {
  const focused=document.activeElement;const focusId=focused?.id;const selection=typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
  const details=[...document.querySelectorAll('.note-authors details')].map(d=>d.open);
  if(!ui.state){app.innerHTML=welcome();return;}
  const content=ui.state.phase==='selection'?selectionView():ui.state.phase==='teams'?teamsView():ui.state.phase==='conversation'?conversation():finished(true);
  app.innerHTML=`${header()}<div class="layout"><main id="main" class="workspace">${phaseNav()}${help()}${!ui.online?'<div class="banner" role="status">Conexión interrumpida. Tus notas pendientes permanecen en este navegador y se enviarán al reconectar.</div>':''}${ui.error?`<div class="banner" role="alert">${esc(ui.error)}</div>`:''}${content}</main>${sidebar()}</div>`;
  if(focusId){const replacement=document.getElementById(focusId);if(replacement){replacement.focus({preventScroll:true});if(selection&&replacement.setSelectionRange)replacement.setSelectionRange(...selection);}}
  document.querySelectorAll('.note-authors details').forEach((d,index)=>{d.open=Boolean(details[index]);});
}
function selectionView(){return selection();}

function zoom(id) {
  const card=[...CARDS,...ATTACKS].find(c=>c.id===id);if(!card)return;
  const dialog=document.querySelector('#viewer');dialog.querySelector('img').src=card.image;dialog.querySelector('img').alt=`Carta original ${card.name}`;dialog.showModal();
}
document.querySelector('#viewer .close-viewer').onclick=()=>document.querySelector('#viewer').close();
document.querySelector('#viewer').addEventListener('click',event=>{if(event.target===event.currentTarget)event.currentTarget.close();});

function voiceDialog(fieldId,turnId) {
  const field=FIELDS.find(f=>f.id===fieldId),dialog=document.createElement('dialog');dialog.className='voice-dialog';
  dialog.setAttribute('aria-label','Dictar o transcribir respuesta');
  dialog.innerHTML=`<div class="eyebrow">Captura por voz</div><h3>Primero escucha, después revisa.</h3><p>${field.label}</p><label for="voice-mode">Qué deseas capturar</label><select id="voice-mode"><option value="self">Dictar mis propias notas</option><option value="other">Transcribir a quien está exponiendo</option></select><label id="consent-label" hidden><input id="voice-consent" type="checkbox">La persona que expone autorizó que transcribamos su intervención.</label><p>No se guarda audio. El navegador puede enviar la voz a su servicio de reconocimiento. Inicia sólo cuando estés listo.</p><div class="voice-status" role="status">Micrófono apagado</div><div class="button-row"><button class="primary" id="voice-start">Autorizar e iniciar micrófono</button><button class="outline" id="voice-stop" disabled>Detener</button></div><label for="voice-text">Texto para revisar y corregir</label><textarea id="voice-text" placeholder="La transcripción aparecerá aquí. También puedes escribir."></textarea><p id="voice-error" role="alert"></p><div class="modal-actions"><button class="outline" id="voice-close">Cancelar</button><button class="primary" id="voice-insert">Añadir a mi respuesta</button></div>`;
  document.body.append(dialog);
  let reviewedText='';
  const speech=createDictation({onText:({text})=>{dialog.querySelector('#voice-text').value=[reviewedText,text].filter(Boolean).join('\n');},onState:({status,active})=>{dialog.querySelector('.voice-status').textContent=status==='starting'?'Solicitando acceso al micrófono…':active?'● Micrófono activo · puedes detenerlo':status==='error'?'Captura interrumpida':'Micrófono apagado';dialog.querySelector('#voice-start').disabled=active;dialog.querySelector('#voice-stop').disabled=!active;dialog.querySelector('#voice-text').readOnly=active;dialog.querySelector('#voice-insert').disabled=active;dialog.querySelector('#voice-mode').disabled=active;dialog.querySelector('#voice-consent').disabled=active;},onError:message=>{dialog.querySelector('#voice-error').textContent=message;}});
  if(!speech.supported){dialog.querySelector('#voice-start').disabled=true;dialog.querySelector('#voice-error').textContent='Este navegador no admite dictado. Puedes escribir y corregir tu respuesta aquí.';}
  dialog.querySelector('#voice-mode').onchange=event=>{dialog.querySelector('#consent-label').hidden=event.target.value!=='other';};
  dialog.querySelector('#voice-start').onclick=()=>{reviewedText=dialog.querySelector('#voice-text').value.trim();dialog.querySelector('#voice-error').textContent='';speech.start({mode:dialog.querySelector('#voice-mode').value,consent:dialog.querySelector('#voice-consent').checked});};
  dialog.querySelector('#voice-stop').onclick=()=>speech.stop();
  dialog.querySelector('#voice-close').onclick=()=>dialog.close();
  dialog.querySelector('#voice-insert').onclick=()=>{const text=dialog.querySelector('#voice-text').value.trim();if(text){setField(turnId,fieldId,[fieldsFor(turnId)[fieldId],text].filter(Boolean).join('\n'));render();}dialog.close();};
  dialog.addEventListener('close',()=>{speech.destroy();dialog.remove();});dialog.showModal();
}

app.addEventListener('submit',async event=>{
  if(event.target.id!=='join')return;event.preventDefault();
  const name=new FormData(event.target).get('name').trim();if(!name||ui.busy)return;
  ui.busy=true;ui.error='';render();
  try{const result=await transport.connect(name);ui.me=result.participantId;accept(result.state);restoreDrafts();toast('Bienvenido a la mesa. Explora tus cartas.');}
  catch(error){ui.error=error.message;ui.expiredIdentity=error.status===401;}
  finally{ui.busy=false;render();}
});
app.addEventListener('input',event=>{const field=event.target.dataset.field;if(field){const turnId=event.target.closest('form').dataset.turn;setField(turnId,field,event.target.value);}});
app.addEventListener('change',event=>{
  const id=event.target.dataset.move;if(!id)return;
  const teams=structuredClone(ui.teamDraft||ui.state.teams);for(const team of teams)team.memberIds=team.memberIds.filter(member=>member!==id);teams.find(t=>t.id===event.target.value).memberIds.push(id);ui.teamDraft=teams;render();
});
app.addEventListener('keydown',event=>{if(event.target.matches('img[data-action]')&&(event.key==='Enter'||event.key===' ')){event.preventDefault();event.target.click();}});
app.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
  const action=button.dataset.action,id=button.dataset.id,team=myTeam();
  if(action==='resetIdentity'){transport.forgetIdentity();ui.state=null;ui.me=null;ui.error='';ui.expiredIdentity=false;ui.confirm=false;ui.drafts={};ui.dirty=new Set();render();return;}
  if(action==='help'){ui.help=!ui.help;render();return;}
  if(action==='zoom'){zoom(id);return;}
  if(action==='flip'){ui.revealed.has(id)?ui.revealed.delete(id):ui.revealed.add(id);render();return;}
  if(action==='select'){const cards=me().cards.includes(id)?me().cards.filter(c=>c!==id):[...me().cards,id];return act('select',{cards});}
  if(action==='reviewSelection'){ui.confirm=true;render();return;}
  if(action==='backSelection'){ui.confirm=false;render();return;}
  if(action==='confirm')return act('confirm',{},()=>toast('Tus dos cartas están confirmadas.'));
  if(action==='formTeams')return act('formTeams');
  if(action==='saveTeams')return act('updateTeams',{teams:ui.teamDraft.map(({id,name,memberIds})=>({id,name,memberIds}))},()=>{ui.teamDraft=null;});
  if(action==='cancelTeams'){ui.teamDraft=null;render();return;}
  if(action==='startSession'){if(ui.teamDraft){toast('Guarda o cancela los ajustes de equipos antes de iniciar.');return;}return act('startSession');}
  if(action==='spin')return act('spin',{teamId:team.id});
  if(action==='drawAttack')return act('drawAttack',{teamId:team.id});
  if(action==='formTab'){ui.group=id;render();return;}
  if(action==='dictate'){voiceDialog(id,button.dataset.turn);return;}
  if(action==='saveNotes'){try{await flushNotes();toast('Tus aportaciones están guardadas.');render();}catch(error){toast(error.message);}return;}
  if(action==='finishTurn'){
    try{await flushNotes();}catch(error){toast('Guarda tus aportaciones antes de continuar: '+error.message);return;}
    return act('finishTurn',{teamId:team.id,turnId:id},async()=>{ui.group='Proyecto';if(myTeam()?.status==='ready')accept(await transport.action('spin',{teamId:team.id}));});
  }
  if(action==='finishSession'){try{await flushNotes();}catch(error){toast(error.message);return;}return act('finishSession');}
  if(action==='enableReport')return act('enableReport');
  if(action==='editHistory'){ui.editingTurn=id;ui.group='Proyecto';render();return;}
  if(action==='closeHistory'){ui.editingTurn=null;render();return;}
  if(action==='download'){
    if(ui.exporting)return;ui.exporting=true;button.disabled=true;button.textContent='Preparando Word…';
    try{await flushNotes();accept(await transport.getState());const {downloadReport}=await import('./report.js');await downloadReport(ui.state);toast('Reporte Word generado. Revisa las descargas de tu navegador.');}catch(error){toast(error.message);}finally{ui.exporting=false;render();}return;
  }
  if(action==='share'){
    const url=new URL(location.href),fragment=new URLSearchParams(url.hash.slice(1));fragment.delete('organizer');url.hash=fragment.toString();
    if(transport.mode==='local'&&['localhost','127.0.0.1'].includes(url.hostname)){toast('Para otros dispositivos usa la dirección de red que muestra el servidor al iniciar.');return;}
    try{await navigator.clipboard.writeText(url.href);toast('Enlace de participantes copiado.');}catch{toast('Copia la dirección del navegador para compartirla con tu grupo.');}
  }
});

async function poll(){
  if(!ui.state||ui.busy||document.hidden)return;
  try{const state=await transport.getState();const changed=state.revision!==ui.state.revision||!ui.online;accept(state);if(ui.dirty.size&&!ui.saving)await flushNotes();if(changed)render();}
  catch(error){
    if(error.status===401){
      clearTimeout(saveTimer);
      if(ui.dirty.size)persistDrafts();
      ui.error=error.message;ui.expiredIdentity=true;ui.online=false;
      ui.state=null;ui.me=null;ui.confirm=false;ui.teamDraft=null;ui.editingTurn=null;
      render();return;
    }
    if(ui.online){ui.online=false;render();}
  }
}
window.addEventListener('online',poll);
window.addEventListener('offline',()=>{ui.online=false;if(ui.state)render();});
window.addEventListener('beforeunload',event=>{if(ui.dirty.size){event.preventDefault();event.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
render();
if(transport.hasIdentity){
  try{const result=await transport.restore();if(result){ui.me=result.participantId;accept(result.state);restoreDrafts();render();}}
  catch(error){ui.error=error.message;ui.expiredIdentity=error.status===401;render();}
}
setInterval(poll,transport.pollIntervalMs);
