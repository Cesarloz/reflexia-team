import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { generateReport } from '../src/report.js';
import { createDictation } from '../src/voice.js';

// Read the ZIP directory rather than trusting a filename or MIME type.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, 'DOCX has a ZIP end record');
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let index = 0; index < entries; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameSize = buffer.readUInt16LE(offset + 28);
    const extraSize = buffer.readUInt16LE(offset + 30);
    const commentSize = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const filename = buffer.subarray(offset + 46, offset + 46 + nameSize).toString();
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files[filename] = (method === 8 ? inflateRawSync(data) : data).toString();
    offset += 46 + nameSize + extraSize + commentSize;
  }
  return files;
}

const fixture = () => ({
  id: 'test-session', createdAt: '2026-11-19T02:00:00.000Z', phase: 'finished', reportEnabled: true,
  participants: [
    { id: 'a', name: 'Ana & Luis', cards: ['builders', 'designers'], confirmed: true },
    { id: 'b', name: 'Mónica <R>', cards: ['designers', 'builders'], confirmed: true },
  ],
  teams: [{ id: 'team', name: 'Equipo colaboración', memberIds: ['a', 'b'], status: 'finished' }],
  turns: [{ id: 'turn', teamId: 'team', participantId: 'a', number: 1, attackId: 'privacy', status: 'finished' }],
  contributions: [
    { id: 'note-a', turnId: 'turn', authorId: 'a', updatedAt: '2026-11-19T02:05:00Z', fields: { title: 'Laboratorio <AI> & práctica', created: 'Primera línea\nSegunda línea', tools: 'Herramienta exacta', answer: 'Reviso el acceso a datos.', collaboration: 'Crear un taller entre pares.', conclusions: 'Aprendimos a escuchar.' } },
    { id: 'note-b', turnId: 'turn', authorId: 'b', updatedAt: '2026-11-19T02:07:00Z', fields: { title: 'Registro de Mónica', observations: 'Esta es mi propia observación.', results: 'Resultado sin resumir: ' + 'Información extensa. '.repeat(2000) } },
  ],
});

test('DOCX is a real OOXML ZIP and preserves all authors, fields, full text and blank markers', async () => {
  const state = fixture();
  const before = JSON.stringify(state);
  const blob = await generateReport(state);
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const files = unzip(Buffer.from(await blob.arrayBuffer()));
  for (const filename of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels']) assert.ok(files[filename], filename);
  const xml = files['word/document.xml'];
  for (const value of ['ReflexIA Card Challenge', 'Ana &amp; Luis', 'Mónica &lt;R&gt;', 'Laboratorio &lt;AI&gt; &amp; práctica', 'Aportación de Ana', 'Aportación de Mónica', 'Primera línea', 'Segunda línea', 'Esta es mi propia observación.', 'Reviso el acceso a datos.', 'Crear un taller entre pares.', 'Aprendimos a escuchar.', 'Sin registrar', 'coincidencia alta', '18 de noviembre de 2026']) assert.ok(xml.includes(value), value);
  assert.ok(xml.includes('Información extensa. '.repeat(2000)), 'long narrative is not truncated');
  assert.ok(xml.includes('Sin participación registrada.'), 'does not invent a missing participation');
  assert.ok(Object.entries(files).some(([name, data]) => /^word\/footer/.test(name) && data.includes('PAGE') && data.includes('NUMPAGES')), 'footer contains live page fields');
  assert.ok(Object.entries(files).some(([name, data]) => /^word\/header/.test(name) && data.includes('ReflexIA')), 'branded header exists');
  assert.equal(JSON.stringify(state), before, 'report generation does not mutate session');
});

test('report stays disabled until all teams finish', async () => {
  const state = fixture();
  state.reportEnabled = false;
  await assert.rejects(generateReport(state), /todos los equipos/);
});

test('empty report accurately represents missing data', async () => {
  const blob = await generateReport({ id: 'empty', reportEnabled: true, createdAt: null, participants: [], teams: [], turns: [], contributions: [] });
  const xml = unzip(Buffer.from(await blob.arrayBuffer()))['word/document.xml'];
  assert.match(xml, /0 participantes · 0 equipos/);
  assert.match(xml, /Sin equipos registrados/);
  assert.match(xml, /Sin conclusiones ni posibilidades de colaboración registradas/);
});

test('dictation is unavailable honestly and never starts automatically', () => {
  const errors = [];
  const voice = createDictation({ scope: {}, onError: value => errors.push(value) });
  assert.equal(voice.supported, false);
  assert.equal(voice.start(), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /escritura manual/);
});

test('dictation requires consent for others and emits reviewable text without saving', () => {
  let instance;
  let starts = 0;
  let stops = 0;
  let aborts = 0;
  class FakeRecognition {
    constructor() { instance = this; }
    start() { starts++; this.onstart(); }
    stop() { stops++; this.onend(); }
    abort() { aborts++; }
  }
  const texts = [], states = [], errors = [];
  const voice = createDictation({ scope: { SpeechRecognition: FakeRecognition }, onText: value => texts.push(value), onState: value => states.push(value), onError: value => errors.push(value) });
  assert.equal(starts, 0);
  assert.equal(voice.start({ mode: 'other' }), false);
  assert.match(errors[0], /consentimiento/);
  assert.equal(starts, 0);
  assert.equal(voice.start({ mode: 'other', consent: true }), true);
  assert.equal(instance.lang, 'es-MX');
  assert.equal(voice.start(), false, 'double click cannot start twice');
  const final = Object.assign([{ transcript: 'Hola equipo.' }], { isFinal: true });
  const interim = Object.assign([{ transcript: 'Estoy creando' }], { isFinal: false });
  instance.onresult({ results: [final, interim] });
  assert.deepEqual(texts.at(-1), { text: 'Hola equipo. Estoy creando', finalText: 'Hola equipo.', interimText: 'Estoy creando' });
  voice.stop();
  assert.equal(stops, 1);
  assert.equal(voice.status, 'idle');
  assert.equal(starts, 1, 'recognition is not restarted on end');
  assert.ok(states.some(state => state.status === 'listening' && state.active));
  voice.start();
  voice.destroy();
  assert.equal(aborts, 1);
  assert.equal(voice.start(), false);
});
