/* ═══════════════════════════════════════════════════════════════════════════
   state.js — Estado central + autosave debounced
   ═══════════════════════════════════════════════════════════════════════════
   Estado e single source of truth. Mudancas disparam:
     1. Listeners (pub/sub) pra UI reagir
     2. Autosave debounced 2s pro Supabase (action=save-project)

   Persistencia em memoria primeiro (sempre rapido), backup em sessionStorage
   pra sobreviver F5 acidental enquanto autosave nao confirma, e backup final
   em editor_jobs.project_state (Supabase) pra recuperar de qualquer device.
   ═══════════════════════════════════════════════════════════════════════════ */

window.BEState = (function() {
  'use strict';

  // ─── Schema do estado ──────────────────────────────────────────────────
  // V1 = primeira versao. Migrations futuras: incrementa + funcao migrate().
  const SCHEMA_VERSION = 1;

  function emptyState() {
    return {
      version: SCHEMA_VERSION,
      project_id: null,            // UUID do editor_jobs (null = ainda nao salvou)
      nome_projeto: 'Projeto sem título',
      // Video carregado
      video: {
        url: null,                  // public URL Supabase
        path: null,                 // storage path pra cleanup futuro
        filename: null,             // original filename
        duration: 0,                // segundos (float)
        width: 0,
        height: 0,
        aspect: null,               // 'vertical' | 'square' | 'horizontal'
        size_bytes: 0,
      },
      // Edicao (preenchido em fases 2+)
      trim: { in: 0, out: 0 },     // 0 = ate fim
      clips: [],                    // splits (Fase 3)
      texts: [],                    // texto overlays (Fase 4)
      audio_extra: null,            // upload extra (Fase 5)
      transitions: [],              // entre clips (Fase 6)
      style_id: null,
      // Volume mix (default vai pra render)
      volumes: { video: 1.0, audio_extra: 1.0 },
      // Aspect strategy quando input nao e 9:16
      aspect_strategy: 'crop_center', // 'crop_center' | 'letterbox'
      // Meta
      created_at: null,
      updated_at: null,
    };
  }

  let state = emptyState();
  const listeners = new Set();
  let saveTimer = null;
  let saveInFlight = false;
  let pendingSaveAfterFlight = false;

  // ─── Pub/sub ────────────────────────────────────────────────────────────
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function emit() {
    listeners.forEach(fn => {
      try { fn(state); } catch (e) { console.error('[state listener]', e); }
    });
  }

  // ─── Mutators ───────────────────────────────────────────────────────────
  // `patch(partial)` — merge profundo limitado a 1 nivel pra simplicidade.
  // Pra mudar `video.url`, use `patch({ video: { ...state.video, url: 'x' } })`.
  function patch(partial) {
    if (!partial || typeof partial !== 'object') return;
    state = { ...state, ...partial };
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
  }

  function get() { return state; }

  function setProjectId(id) {
    state.project_id = id;
    backupSessionStorage();
  }

  function reset() {
    state = emptyState();
    backupSessionStorage();
    emit();
  }

  // ─── Backup em sessionStorage (resiliencia anti-F5) ─────────────────────
  const SS_KEY = 'be_state_backup';
  function backupSessionStorage() {
    try { sessionStorage.setItem(SS_KEY, JSON.stringify(state)); } catch(e) {}
  }
  function loadFromSessionStorage() {
    try {
      const raw = sessionStorage.getItem(SS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === SCHEMA_VERSION) return parsed;
    } catch(e) {}
    return null;
  }

  // ─── Autosave debounced ─────────────────────────────────────────────────
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    setSaveStatus('saving');
    saveTimer = setTimeout(doSave, 2000);
  }

  async function doSave() {
    if (saveInFlight) { pendingSaveAfterFlight = true; return; }
    if (!state.video.url) { setSaveStatus('idle'); return; } // nao salva projeto vazio
    saveInFlight = true;
    try {
      const token = localStorage.getItem('bt_token');
      if (!token) { setSaveStatus('error', 'sem login'); return; }
      const body = {
        action: 'save-project',
        token,
        project_id: state.project_id,
        project_state: state,
        nome_projeto: state.nome_projeto,
        video_url: state.video.url,
      };
      const r = await fetch('/api/blue-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (r.ok && d.ok) {
        if (!state.project_id && d.project_id) setProjectId(d.project_id);
        setSaveStatus('saved');
      } else {
        setSaveStatus('error', d.error || 'falha');
      }
    } catch (e) {
      setSaveStatus('error', e.message);
    } finally {
      saveInFlight = false;
      if (pendingSaveAfterFlight) {
        pendingSaveAfterFlight = false;
        scheduleSave();
      }
    }
  }

  // ─── UI: status do autosave ─────────────────────────────────────────────
  function setSaveStatus(status, extra) {
    const el = document.getElementById('saveStatus');
    if (!el) return;
    el.classList.remove('saving', 'saved');
    if (status === 'saving') {
      el.textContent = '◌ salvando…';
      el.classList.add('saving');
    } else if (status === 'saved') {
      el.textContent = '✓ salvo';
      el.classList.add('saved');
      setTimeout(() => {
        if (el.textContent === '✓ salvo') el.textContent = '○ pronto';
      }, 1500);
    } else if (status === 'error') {
      el.textContent = '⚠ ' + (extra || 'erro');
    } else {
      el.textContent = '○ pronto';
    }
  }

  // ─── Load do servidor (recuperar projeto) ───────────────────────────────
  async function loadFromServer(projectId) {
    try {
      const token = localStorage.getItem('bt_token');
      if (!token) return null;
      const url = '/api/blue-editor?action=load-project&token=' + encodeURIComponent(token)
        + (projectId ? '&project_id=' + encodeURIComponent(projectId) : '');
      // Simplificacao: usa POST porque blue-editor.js le req.body. Vou via POST.
      const r = await fetch('/api/blue-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'load-project', token, project_id: projectId || null }),
      });
      const d = await r.json();
      if (!r.ok || !d.project) return null;
      const ps = d.project.project_state;
      if (ps && ps.version === SCHEMA_VERSION) {
        state = { ...emptyState(), ...ps, project_id: d.project.id, nome_projeto: d.project.nome_projeto || ps.nome_projeto };
        backupSessionStorage();
        emit();
        return state;
      }
    } catch(e) { console.warn('[state load]', e); }
    return null;
  }

  // ─── Init ───────────────────────────────────────────────────────────────
  // 1. Tenta carregar do servidor (mais recente projeto editing)
  // 2. Fallback: sessionStorage (caso conexao caiu mid-edit)
  // 3. Fallback: estado vazio novo
  async function init() {
    const server = await loadFromServer();
    if (server) {
      console.log('[BEState] carregado do servidor:', server.project_id);
      return state;
    }
    const ss = loadFromSessionStorage();
    if (ss) {
      state = ss;
      emit();
      console.log('[BEState] carregado de sessionStorage (fallback)');
      return state;
    }
    console.log('[BEState] novo projeto');
    emit();
    return state;
  }

  return { init, get, patch, subscribe, reset, setProjectId, loadFromServer };
})();
