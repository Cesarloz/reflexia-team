import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel,
  PageBreak, PageNumber, Packer, Paragraph, Table, TableCell, TableRow,
  TextRun, WidthType,
} from './vendor/docx.mjs';
import { CARDS, ATTACKS, FIELDS } from './catalog.js';

const NAVY = '132445';
const MAGENTA = 'BE198A';
const GRAY = '526079';
const WIDTH = 9360;
const MISSING = 'Sin registrar';
const cardName = id => CARDS.find(card => card.id === id)?.name || id;
const participantName = (state, id) => state.participants.find(person => person.id === id)?.name || `ID: ${id}`;
const text = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const supplied = value => text(value).trim() ? text(value) : MISSING;

function paragraph(value, options = {}) {
  const lines = text(value).split(/\r?\n/);
  return new Paragraph({
    spacing: { after: 140, line: 285 },
    ...options,
    children: lines.flatMap((line, index) => [new TextRun({ text: line, ...(index ? { break: 1 } : {}) })]),
  });
}

function heading(value, level = HeadingLevel.HEADING_1) {
  return paragraph(value, { heading: level, keepNext: true });
}

function labeled(label, value) {
  return [
    new Paragraph({ spacing: { before: 180, after: 65 }, keepNext: true, children: [new TextRun({ text: label, bold: true, color: NAVY })] }),
    paragraph(supplied(value)),
  ];
}

function table(headers, rows, widths) {
  const makeCell = (value, index, isHeader) => new TableCell({
    width: { size: widths[index], type: WidthType.DXA },
    margins: { top: 110, bottom: 110, left: 110, right: 110 },
    shading: { fill: isHeader ? NAVY : 'F4F6FA' },
    children: [new Paragraph({
      spacing: { after: 40, line: 250 },
      children: [new TextRun({ text: supplied(value), bold: isHeader, color: isHeader ? 'FFFFFF' : NAVY, size: 20 })],
    })],
  });
  return new Table({
    width: { size: WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    borders: Object.fromEntries(['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map(key => [key, { style: BorderStyle.SINGLE, size: 4, color: 'D8DFEA' }])),
    rows: [new TableRow({ tableHeader: true, children: headers.map((value, index) => makeCell(value, index, true)) }),
      ...rows.map(row => new TableRow({ children: row.map((value, index) => makeCell(value, index, false)) }))],
  });
}

function dateLabel(value) {
  if (value === null || value === undefined || value === '') return MISSING;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? MISSING : new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City', dateStyle: 'long', timeStyle: 'short',
  }).format(date);
}

function teamAffinities(state, team) {
  const members = team.memberIds.map(id => state.participants.find(person => person.id === id)).filter(Boolean);
  const matches = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const common = (members[i].cards || []).filter(id => (members[j].cards || []).includes(id));
      if (common.length) matches.push(`${members[i].name} y ${members[j].name}: coincidencia ${common.length === 2 ? 'alta' : 'media'} (${common.map(cardName).join(', ')}).`);
    }
  }
  return matches.length ? matches : ['No se registraron cartas coincidentes entre los integrantes de este equipo.'];
}

/** Build the full document from recorded data only. Does not contact any service. */
export function createReportDocument(state) {
  if (!state?.reportEnabled) throw new Error('El reporte estará disponible cuando todos los equipos terminen.');
  const participants = state.participants || [];
  const teams = state.teams || [];
  const turns = state.turns || [];
  const contributions = state.contributions || [];
  const body = [
    new Paragraph({ spacing: { before: 1600, after: 300 }, children: [new TextRun({ text: 'Reflex', size: 74, bold: true, color: NAVY }), new TextRun({ text: 'IA', size: 74, bold: true, color: MAGENTA })] }),
    new Paragraph({ spacing: { after: 180 }, children: [new TextRun({ text: 'Team Agentes', size: 44, bold: true, color: NAVY })] }),
    new Paragraph({ spacing: { after: 700 }, children: [new TextRun({ text: 'ReflexIA Card Challenge', size: 32, color: MAGENTA })] }),
    paragraph('Comunidad · Diálogo · Futuros', { spacing: { after: 500 } }),
    ...labeled('Fecha de la sesión', dateLabel(state.createdAt)),
    ...labeled('Participación', `${participants.length} participantes · ${teams.length} equipos`),
    paragraph('Reporte consolidado de experiencias, preguntas y aportaciones registradas durante la actividad. Cada aportación conserva la autoría de quien la documentó.'),
    paragraph('Documento accesible para los participantes autorizados de la sesión. Los campos sin contenido se identifican como «Sin registrar».', { spacing: { before: 500 } }),
    new Paragraph({ children: [new PageBreak()] }),
    heading('Resumen de la sesión'),
    table(['Participante', 'Equipo', 'Cartas seleccionadas'], participants.map(person => [
      person.name,
      teams.find(team => team.memberIds.includes(person.id))?.name || 'Sin equipo asignado',
      (person.cards || []).map(cardName).join(' · '),
    ]), [2300, 2100, 4960]),
    heading('Equipos y afinidades'),
  ];
  for (const team of teams) {
    body.push(heading(team.name, HeadingLevel.HEADING_2));
    body.push(paragraph(`Integrantes: ${team.memberIds.map(id => participantName(state, id)).join(', ')}`));
    body.push(...teamAffinities(state, team).map(value => paragraph(value)));
  }
  if (!teams.length) body.push(paragraph('Sin equipos registrados.'));

  body.push(new Paragraph({ children: [new PageBreak()] }), heading('Experiencias compartidas'));
  for (const [index, speaker] of participants.entries()) {
    if (index) body.push(new Paragraph({ children: [new PageBreak()] }));
    const team = teams.find(item => item.memberIds.includes(speaker.id));
    const speakerTurns = turns.filter(turn => turn.participantId === speaker.id).sort((a, b) => a.number - b.number);
    body.push(heading(speaker.name, HeadingLevel.HEADING_2));
    body.push(...labeled('Equipo', team?.name));
    body.push(...labeled('Cartas seleccionadas', (speaker.cards || []).map(cardName).join(' · ')));
    if (!speakerTurns.length) body.push(paragraph('Sin participación registrada.'));
    for (const turn of speakerTurns) {
      const attack = ATTACKS.find(card => card.id === turn.attackId);
      body.push(heading(`Participación ${turn.number} · ${turn.status === 'finished' ? 'Finalizada' : 'En curso'}`, HeadingLevel.HEADING_3));
      body.push(...labeled('Pregunta de la carta de ataque', attack?.question));
      const notes = contributions.filter(note => note.turnId === turn.id);
      if (!notes.length) body.push(paragraph('Sin aportaciones registradas para esta participación.'));
      for (const note of notes) {
        body.push(heading(`Aportación de ${participantName(state, note.authorId)}`, HeadingLevel.HEADING_3));
        body.push(paragraph(`Última edición: ${dateLabel(note.updatedAt)}`, { spacing: { after: 120 } }));
        const fields = note.fields || {};
        for (const field of FIELDS) body.push(...labeled(field.label, fields[field.id]));
        for (const [key, value] of Object.entries(fields)) {
          if (!FIELDS.some(field => field.id === key)) body.push(...labeled(key, value));
        }
      }
    }
  }

  body.push(new Paragraph({ children: [new PageBreak()] }), heading('Conclusiones y posibilidades de colaboración'));
  let conclusionCount = 0;
  for (const note of contributions) {
    const turn = turns.find(item => item.id === note.turnId);
    const author = participantName(state, note.authorId);
    for (const [key, title] of [['conclusions', 'Conclusiones'], ['collaboration', 'Posibilidades de colaboración']]) {
      if (!text(note.fields?.[key]).trim()) continue;
      conclusionCount++;
      body.push(heading(`${title} · ${author}`, HeadingLevel.HEADING_3));
      if (turn) body.push(paragraph(`Experiencia de ${participantName(state, turn.participantId)}`));
      body.push(paragraph(note.fields[key]));
    }
  }
  if (!conclusionCount) body.push(paragraph('Sin conclusiones ni posibilidades de colaboración registradas.'));

  return new Document({
    creator: 'ReflexIA Team Agentes', title: 'ReflexIA Card Challenge — Reporte de sesión',
    description: 'Experiencias y aportaciones de los participantes, conservadas por autor.',
    styles: {
      default: {
        document: { run: { font: 'Aptos', size: 22, color: NAVY }, paragraph: { spacing: { after: 140, line: 285 } } },
        heading1: { run: { font: 'Aptos Display', size: 34, bold: true, color: NAVY }, paragraph: { spacing: { before: 420, after: 240 }, keepNext: true } },
        heading2: { run: { font: 'Aptos', size: 28, bold: true, color: MAGENTA }, paragraph: { spacing: { before: 320, after: 180 }, keepNext: true } },
        heading3: { run: { font: 'Aptos', size: 24, bold: true, color: NAVY }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
      },
    },
    sections: [{
      properties: { titlePage: true, page: { size: { width: 11906, height: 16838 }, margin: { top: 1273, bottom: 1273, left: 1273, right: 1273 } } },
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: 'ReflexIA · Team Agentes', color: GRAY, size: 18 })], border: { bottom: { color: MAGENTA, size: 8, style: BorderStyle.SINGLE, space: 8 } } })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'ReflexIA Card Challenge  ·  ', color: GRAY, size: 18 }), new TextRun({ children: ['Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES], color: GRAY, size: 18 })] })] }) },
      children: body,
    }],
  });
}

export async function generateReport(state) {
  return Packer.toBlob(createReportDocument(state));
}

export async function downloadReport(state) {
  const blob = await generateReport(state);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const date = new Date(state.createdAt);
  const stamp = !state.createdAt || Number.isNaN(date.getTime()) ? 'sesion' : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  anchor.href = url;
  anchor.download = `ReflexIA-Card-Challenge-${stamp}.docx`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return blob;
}
