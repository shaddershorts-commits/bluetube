// editor-v1/services/autosave.js
// Autosave: debounce 2s -> save-project. Retry backoff. Fallback sessionStorage.
// Status: 'idle' | 'saving' | 'saved' | 'error'

import { api } from './api.js';
import * as act from '../core/actions.js';

const DEBOUNCE_MS = 2000;
const SS_KEY = 'be_v1_state';

export function createAutosave(store, onStatus) {
  let timer = 0;
  let inFlight = false;
  let queued = false;
  let retryDelay = 2000;
  let disabled = false;

  function status(s, detail) { onStatus?.(s, detail); }

  async function saveNow() {
    if (inFlight) { queued = true; return; }
    const state = store.getState();
    if (!state.video) return; // nada pra salvar ainda
    inFlight = true;
    status('saving');
    try {
      const r = await api.saveProject(state.project_id, state, state.nome_projeto, state.video?.url || null);
      if (r.project_id && r.project_id !== state.project_id) {
        store.dispatch(act.setProjectId(r.project_id));
      }
      retryDelay = 2000;
      status('saved');
    } catch (e) {
      console.warn('[autosave] falhou:', e.message);
      if (e.status === 401) {
        // sem sessão: parar de tentar está certo (retry viraria spam de 401),
        // mas parar EM SILÊNCIO não — o usuário seguia editando achando que
        // salvava e perdia tudo ao fechar a aba. O aviso fica FIXO no header.
        disabled = true;
        status('error', 'sessão expirou — entre de novo pra continuar salvando');
        return;
      }
      status('error', e.message);
      setTimeout(() => { schedule(0); }, retryDelay);
      retryDelay = Math.min(60000, retryDelay * 2);
    } finally {
      inFlight = false;
      if (queued) { queued = false; schedule(500); }
    }
  }

  function schedule(ms = DEBOUNCE_MS) {
    if (disabled) return;
    clearTimeout(timer);
    timer = setTimeout(saveNow, ms);
  }

  const unsub = store.subscribe((state, action) => {
    // sessionStorage sempre (fallback F5 instantaneo)
    try { sessionStorage.setItem(SS_KEY, JSON.stringify(state)); } catch {}
    // @replace = load inicial (nao re-salvar o que veio do servidor).
    // Undo/redo (@undo/@redo) SAO mudancas reais do documento -> salvam.
    if (action?.type === '@replace') return;
    schedule();
  });

  return {
    saveNow,
    flush: saveNow,
    destroy() { unsub(); clearTimeout(timer); },
    static: { SS_KEY },
  };
}

export function readSessionFallback() {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
