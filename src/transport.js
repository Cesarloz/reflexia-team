/** Real network transport. localStorage contains identity credentials, never a fake room. */
const LOCAL_KEY = 'reflexia:local-identity:v1';

function readStored(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {
    // The active tab continues working, but browser privacy settings may prevent recovery.
  }
}

export class TransportError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'TransportError'; this.status = status; }
}

async function request(url, options = {}) {
  let response;
  try { response = await fetch(url, { cache: 'no-store', ...options }); }
  catch { throw new TransportError('Sin conexión. Tus cambios pendientes se conservan en este navegador; vuelve a intentarlo cuando regrese la red.'); }
  let value;
  try { value = await response.json(); }
  catch { throw new TransportError('No hay un servidor multijugador conectado. Inicia el servidor local o configura Supabase para GitHub Pages.', response.status); }
  if (!response.ok) {
    throw new TransportError(value.message || value.error_description || value.msg || value.error || 'No se pudo completar la operación.', response.status);
  }
  return value;
}

export function createTransport(config = globalThis.REFLEXIA_CONFIG || {}) {
  const fragment = new URLSearchParams(globalThis.location?.hash?.replace(/^#/, '') || '');
  const settings = { ...config };
  settings.sessionId = fragment.get('session') || settings.sessionId;
  settings.invitationToken = fragment.get('invite') || settings.invitationToken;
  const remote = Boolean(settings.supabaseUrl && settings.supabaseAnonKey);
  const mode = remote ? 'supabase' : 'local';
  const base = remote ? settings.supabaseUrl.replace(/\/$/, '') : '';
  const storageKey = remote ? `reflexia:supabase:${base}:${settings.sessionId}` : LOCAL_KEY;
  let identity = readStored(storageKey);
  let refreshPromise;
  let connected = false;

  async function saveAuth(result) {
    identity = { ...identity, accessToken: result.access_token, refreshToken: result.refresh_token,
      expiresAt: Date.now() + Math.max(60, result.expires_in || 3600) * 1000,
      participantId: result.user?.id || identity?.participantId };
    writeStored(storageKey, identity);
  }

  async function authenticate() {
    if (!remote) return;
    if (!settings.sessionId || !settings.invitationToken) {
      throw new TransportError('Falta el enlace de esta actividad. Abre el enlace compartido con tu grupo.');
    }
    if (identity?.accessToken && identity.expiresAt > Date.now() + 60_000) return;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const refreshing = Boolean(identity?.refreshToken);
      const path = refreshing ? '/auth/v1/token?grant_type=refresh_token' : '/auth/v1/signup';
      try {
        const result = await request(base + path, {
          method: 'POST', headers: { apikey: settings.supabaseAnonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(refreshing ? { refresh_token: identity.refreshToken } : { data: {} }),
        });
        if (!result.access_token) throw new TransportError('Supabase no devolvió una sesión anónima. Habilita Anonymous Sign-Ins en Authentication.');
        await saveAuth(result);
      } catch (error) {
        if (refreshing && [400, 401, 403].includes(error.status)) {
          throw new TransportError('La identidad del navegador venció. Usa «Entrar a una nueva actividad» para restablecer el acceso; se creará una identidad nueva.', error.status);
        }
        throw error;
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function rpc(name, data) {
    await authenticate();
    return request(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: settings.supabaseAnonKey,
        Authorization: `Bearer ${identity.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  async function local(path, body) {
    return request(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(identity?.token ? { Authorization: `Bearer ${identity.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  return {
    mode,
    get status() { return connected ? 'connected' : 'disconnected'; },
    get participantId() { return identity?.participantId || null; },
    get hasIdentity() { return Boolean(identity?.token || identity?.accessToken); },
    pollIntervalMs: Math.max(1000, Number(settings.pollIntervalMs) || 1500),
    // Explicit user action only. Never discard credentials on a network outage.
    forgetIdentity() {
      identity = null;
      connected = false;
      try { localStorage.removeItem(storageKey); } catch { /* storage may be disabled */ }
    },
    async connect(name) {
      let result;
      if (remote) {
        result = await rpc('reflexia_join', { p_session: settings.sessionId, p_invitation: settings.invitationToken,
          p_name: name });
        identity = { ...identity, participantId: result.participantId, name };
      } else {
        // A static server cannot accidentally be treated as a multiplayer backend.
        await request('/api/health');
        result = await local('join', { name, resumeToken: identity?.token || null });
        identity = { token: result.token, participantId: result.participantId, name };
      }
      writeStored(storageKey, identity);
      connected = true;
      return { participantId: result.participantId, state: result.state };
    },
    async restore() {
      if (!identity) return null;
      const state = await this.getState();
      connected = true;
      return { participantId: identity.participantId, state };
    },
    async getState() {
      if (!identity) throw new TransportError('Escribe tu nombre para entrar.');
      try {
        const state = remote ? await rpc('reflexia_state', { p_session: settings.sessionId }) : await local('state');
        connected = true;
        return state;
      } catch (error) { connected = false; throw error; }
    },
    async action(type, payload = {}, requestId = crypto.randomUUID()) {
      if (!identity) throw new TransportError('Primero entra a la actividad.');
      try {
        const state = remote ? await rpc('reflexia_action', { p_session: settings.sessionId, p_type: type,
          p_payload: payload, p_request: requestId }) : await local('action', { type, payload, requestId });
        connected = true;
        return state;
      } catch (error) { if (!error.status || error.status >= 500) connected = false; throw error; }
    },
  };
}
