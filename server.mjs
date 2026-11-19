import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createState, addParticipant, applyAction, GameError } from './src/game.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const emptyRecord = (ttlMs) => ({ state: createState({ ttlMs }), tokens: {}, requests: {} });

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new GameError('Utiliza contenido JSON.', 415);
  let length = 0; const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new GameError('La aportación excede el tamaño permitido.', 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new GameError('El contenido JSON no es válido.'); }
}

function sameOrigin(request) {
  if (!request.headers.origin) return;
  let origin;
  try { origin = new URL(request.headers.origin); } catch { throw new GameError('Origen no permitido.', 403); }
  if (origin.host !== request.headers.host || !['http:', 'https:'].includes(origin.protocol)) throw new GameError('Origen no permitido.', 403);
}

export async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? path.join(ROOT, '.runtime'));
  const staticDir = path.resolve(options.staticDir ?? path.join(ROOT, 'public'));
  const sourceDir = path.resolve(options.sourceDir ?? path.join(ROOT, 'src'));
  const ttlMs = options.ttlMs ?? Number(process.env.REFLEXIA_RETENTION_HOURS ?? 24) * 3600000;
  if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 365 * 86400000) throw new Error('REFLEXIA_RETENTION_HOURS debe ser un número positivo (máximo 8760).');
  const stateFile = path.join(dataDir, 'session.json');
  await fs.mkdir(dataDir, { recursive: true });
  let record;
  try {
    record = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (!record.state?.id || !Array.isArray(record.state.participants) || !record.tokens || !record.requests || !Number.isFinite(Date.parse(record.state.expiresAt))) throw new Error('El archivo de sesión no es válido. Conserva una copia y revisa .runtime/session.json.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    record = emptyRecord(ttlMs);
  }
  const persist = async (value) => {
    const temp = `${stateFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temp, stateFile);
  };
  if (Date.parse(record.state.expiresAt) <= Date.now()) record = emptyRecord(ttlMs);
  await persist(record);
  let rules = { randomIndex: randomInt, ...options.rules };
  if (!options.rules) {
    try {
      const catalog = await import('./src/catalog.js');
      if (catalog.CARDS) rules.cardIds = catalog.CARDS.map((card) => card.id);
      if (catalog.ATTACKS) rules.attackIds = catalog.ATTACKS.filter((card) => card.enabled !== false).map((card) => card.id);
      if (catalog.FIELDS) rules.fieldIds = catalog.FIELDS.map((field) => field.id);
    } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  }

  // Every read/write uses one serial transaction queue. State is published only after durable save.
  let queue = Promise.resolve();
  const transaction = (callback) => {
    const result = queue.then(async () => {
      if (Date.parse(record.state.expiresAt) <= Date.now()) {
        const replacement = emptyRecord(ttlMs);
        await persist(replacement); record = replacement;
      }
      return callback();
    });
    queue = result.catch(() => {});
    return result;
  };
  const authenticate = (request) => {
    const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(request.headers.authorization ?? '');
    const actorId = match && record.tokens[tokenHash(match[1])];
    if (!actorId || !record.state.participants.some((person) => person.id === actorId)) throw new GameError('Tu sesión venció o no es válida. Vuelve a ingresar.', 401, 'UNAUTHORIZED');
    return actorId;
  };
  const interval = setInterval(() => { transaction(() => {}).catch((error) => console.error('No se pudo limpiar la sesión vencida:', error.message)); }, Math.min(60000, ttlMs));
  interval.unref();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        sameOrigin(request);
        if (request.method === 'GET' && url.pathname === '/api/health') {
          json(response, 200, { ok: true, mode: 'local', version: 1 }); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/join') {
          const input = await body(request);
          const result = await transaction(async () => {
            if (input.resumeToken) {
              const participantId = record.tokens[tokenHash(String(input.resumeToken))];
              if (!participantId) throw new GameError('La sesión guardada venció. Ingresa nuevamente.', 401, 'UNAUTHORIZED');
              return { token: input.resumeToken, participantId, state: record.state };
            }
            const participantId = globalThis.crypto.randomUUID();
            const token = randomBytes(32).toString('base64url');
            const next = structuredClone(record);
            next.state = addParticipant(record.state, { id: participantId, name: input.name });
            next.tokens[tokenHash(token)] = participantId;
            await persist(next); record = next;
            return { token, participantId, state: record.state };
          });
          json(response, 200, result); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/state') {
          const result = await transaction(() => { authenticate(request); return record.state; });
          json(response, 200, result); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/action') {
          const action = await body(request);
          const result = await transaction(async () => {
            const actorId = authenticate(request);
            let key; let fingerprint;
            if (action.requestId !== undefined) {
              if (typeof action.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(action.requestId)) throw new GameError('Identificador de petición inválido.');
              key = `${actorId}:${action.requestId}`;
              fingerprint = tokenHash(JSON.stringify({ type: action.type, payload: action.payload ?? {} }));
              if (record.requests[key]) {
                if (record.requests[key] !== fingerprint) throw new GameError('La petición repetida contiene datos diferentes.', 409);
                return record.state;
              }
            }
            const nextState = applyAction(record.state, actorId, action, rules);
            if (nextState === record.state && !key) return record.state;
            const next = { ...record, state: nextState, requests: { ...record.requests } };
            if (key) next.requests[key] = fingerprint;
            const requestKeys = Object.keys(next.requests);
            for (const stale of requestKeys.slice(0, Math.max(0, requestKeys.length - 10000))) delete next.requests[stale];
            await persist(next); record = next;
            return record.state;
          });
          json(response, 200, result); return;
        }
        throw new GameError('No existe esa ruta.', 404);
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new GameError('Método no permitido.', 405);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new GameError('Ruta inválida.'); }
      const source = pathname.startsWith('/src/');
      const base = source ? sourceDir : staticDir;
      const relative = source ? pathname.slice(5) : pathname === '/' ? 'index.html' : pathname.slice(1);
      const filename = path.resolve(base, relative);
      if (!filename.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`) || !MIME[path.extname(filename).toLowerCase()]) throw new GameError('No existe ese recurso.', 404);
      let data;
      try { data = await fs.readFile(filename); } catch (error) { if (['ENOENT', 'EISDIR'].includes(error.code)) throw new GameError('No existe ese recurso.', 404); throw error; }
      response.writeHead(200, { 'Content-Type': MIME[path.extname(filename).toLowerCase()], 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof GameError ? error.status : 500;
      if (status === 500) console.error(error);
      json(response, status, { error: status === 500 ? 'No se pudo guardar la operación. Inténtalo de nuevo.' : error.message, code: error.code ?? 'SERVER_ERROR' });
    }
  });
  server.on('close', () => clearInterval(interval));
  return { server, close: async () => { clearInterval(interval); await queue; if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4174);
  const host = process.env.HOST ?? '0.0.0.0';
  const app = await createApp();
  app.server.listen(port, host, () => {
    const boundPort = app.server.address().port;
    const addresses = ['0.0.0.0', '::'].includes(host)
      ? [...new Set(Object.values(networkInterfaces()).flat().filter((entry) => entry && !entry.internal && entry.family === 'IPv4').map((entry) => entry.address))]
      : host === '127.0.0.1' || host === 'localhost' || host === '::1' ? [] : [host];
    const sharedLinks = addresses.map((address) => `  http://${address.includes(':') ? `[${address}]` : address}:${boundPort}`).join('\n');
    console.log(`ReflexIA Team Agentes: http://localhost:${boundPort}\n${sharedLinks ? `Enlaces para otros dispositivos de la misma red:\n${sharedLinks}` : 'No se detectó una dirección de red compartida; usa localhost en esta computadora.'}\nTodos los participantes pueden coordinar la actividad. Los datos vencen en ${process.env.REFLEXIA_RETENTION_HOURS ?? 24} horas.`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { app.close().then(() => process.exit(0)); });
}
