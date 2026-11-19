const ERROR_MESSAGES = {
  'not-allowed': 'No se autorizó el micrófono. Puedes escribir tu respuesta o cambiar el permiso del navegador.',
  'service-not-allowed': 'El navegador no permite este servicio de dictado. Continúa escribiendo.',
  'audio-capture': 'No se encontró un micrófono disponible. Puedes escribir tu respuesta.',
  'no-speech': 'No se detectó voz. Puedes iniciar el dictado de nuevo o escribir.',
  'network': 'El servicio de reconocimiento no pudo conectarse. El dictado puede requerir Internet; puedes escribir.',
  'language-not-supported': 'El servicio no admite español en este dispositivo. Puedes escribir tu respuesta.',
};

/**
 * Browser speech only. The host UI must show a separate editable preview and
 * explicitly ask the user before adding it to a field. Audio is never stored.
 * onText({text,finalText,interimText}), onState({status,active,supported}).
 */
export function createDictation({ onText = () => {}, onState = () => {}, onError = () => {}, scope = globalThis } = {}) {
  const Recognition = scope.SpeechRecognition || scope.webkitSpeechRecognition;
  const supported = typeof Recognition === 'function';
  let recognition = null;
  let status = 'idle';
  let destroyed = false;
  let requestedStop = false;
  const emit = next => {
    status = next;
    if (!destroyed) onState({ status, active: ['starting', 'listening', 'stopping'].includes(status), supported });
  };

  function start({ mode = 'self', consent = false } = {}) {
    if (destroyed) return false;
    if (!supported) {
      onError('Este navegador no admite dictado por voz. La escritura manual está disponible.');
      return false;
    }
    if (mode === 'other' && !consent) {
      onError('Para transcribir a otra persona, primero confirma su consentimiento.');
      return false;
    }
    if (recognition || (status !== 'idle' && status !== 'error')) return false;
    requestedStop = false;
    try {
      recognition = new Recognition();
    } catch {
      emit('error');
      onError('No fue posible activar el servicio de reconocimiento. Puedes escribir tu respuesta.');
      return false;
    }
    recognition.lang = 'es-MX';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => emit('listening');
    recognition.onresult = event => {
      if (destroyed) return;
      const final = [];
      const interim = [];
      for (let index = 0; index < event.results.length; index++) {
        const result = event.results[index];
        (result.isFinal ? final : interim).push(result[0].transcript);
      }
      const finalText = final.join(' ').trim();
      const interimText = interim.join(' ').trim();
      onText({ finalText, interimText, text: [finalText, interimText].filter(Boolean).join(' ') });
    };
    recognition.onerror = event => {
      if (destroyed || (event.error === 'aborted' && requestedStop)) return;
      emit('error');
      onError(ERROR_MESSAGES[event.error] || 'No fue posible completar el dictado. El texto ya reconocido sigue disponible para revisarlo.');
      requestedStop = true;
      try { recognition?.abort(); } catch { recognition = null; }
    };
    recognition.onend = () => {
      recognition = null;
      emit('idle');
    };
    emit('starting');
    onText({ text: '', finalText: '', interimText: '' });
    try {
      // This is the only capture start: invoked by an explicit user action.
      recognition.start();
      return true;
    } catch (error) {
      recognition = null;
      emit('error');
      onError(error?.name === 'NotAllowedError' ? ERROR_MESSAGES['not-allowed'] : 'No se pudo iniciar el micrófono. Puedes escribir tu respuesta.');
      return false;
    }
  }

  function stop() {
    if (!recognition) return;
    requestedStop = true;
    emit('stopping');
    try { recognition.stop(); } catch { recognition = null; emit('idle'); }
  }

  function destroy() {
    destroyed = true;
    requestedStop = true;
    if (recognition) {
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch { /* Already stopped. */ }
      recognition = null;
    }
    status = 'idle';
  }

  return { supported, start, stop, destroy, get status() { return status; } };
}
