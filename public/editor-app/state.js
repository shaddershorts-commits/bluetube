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
      // Edicao
      // trim define bounds globais (handles externos). Clips definem cortes
      // internos. Output = concat dos clips ativos em ordem source_in.
      trim: { in: 0, out: 0 },     // 0 = ate fim
      clips: [],                    // [{ id, source_in, source_out }] (Fase 3)
      next_clip_id: 1,
      selected_clip_id: null,       // pra UI destacar + ops keyboard
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

  // ─── Clips helpers (Fase 3) ────────────────────────────────────────────
  // getEffectiveClips: retorna clips ordenados por source_in.
  // Se clips[] vazio, retorna 1 clip virtual representando trim global.
  function getEffectiveClips() {
    if (state.clips && state.clips.length > 0) {
      return [...state.clips].sort((a, b) => a.source_in - b.source_in);
    }
    const dur = state.video.duration || 0;
    const inT = state.trim.in || 0;
    const outT = state.trim.out > 0 ? state.trim.out : dur;
    if (dur <= 0) return [];
    return [{ id: 0, source_in: inT, source_out: outT, virtual: true }];
  }

  // Localiza o clipe que contem o tempo t (no source). Retorna null se nenhum.
  function clipAtTime(t) {
    const list = getEffectiveClips();
    for (const c of list) {
      if (t >= c.source_in && t <= c.source_out) return c;
    }
    return null;
  }

  // Calcula duracao total do output (soma de todos clipes ativos)
  function getOutputDuration() {
    return getEffectiveClips().reduce((acc, c) => acc + (c.source_out - c.source_in), 0);
  }

  // Materializa clipes virtuais em clipes reais (1° split)
  // Apos materializar, trim handles deixam de afetar bounds — clips assumem.
  function materializeIfNeeded() {
    if (state.clips && state.clips.length > 0) return;
    const dur = state.video.duration || 0;
    if (dur <= 0) return;
    const inT = state.trim.in || 0;
    const outT = state.trim.out > 0 ? state.trim.out : dur;
    state.clips = [{ id: state.next_clip_id++, source_in: inT, source_out: outT }];
  }

  // Split: divide o clip em t (segundos no source) em 2 clips adjacentes.
  // Retorna ids dos 2 novos clips (ou null se nao foi possivel).
  function splitAtTime(t) {
    materializeIfNeeded();
    const list = state.clips;
    const idx = list.findIndex(c => t > c.source_in + 0.05 && t < c.source_out - 0.05);
    if (idx < 0) return null;
    const original = list[idx];
    const left = { id: state.next_clip_id++, source_in: original.source_in, source_out: t };
    const right = { id: state.next_clip_id++, source_in: t, source_out: original.source_out };
    state.clips = [...list.slice(0, idx), left, right, ...list.slice(idx + 1)];
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return [left.id, right.id];
  }

  // Delete: remove clip por id. Retorna o clip removido (pra undo).
  function deleteClip(id) {
    if (!state.clips || state.clips.length === 0) return null;
    const idx = state.clips.findIndex(c => c.id === id);
    if (idx < 0) return null;
    if (state.clips.length === 1) return null; // nao pode deletar ultimo
    const removed = state.clips[idx];
    state.clips = [...state.clips.slice(0, idx), ...state.clips.slice(idx + 1)];
    if (state.selected_clip_id === id) state.selected_clip_id = null;
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return removed;
  }

  // Reinsert (pra undo de delete)
  function insertClip(clip, atIndex) {
    if (!state.clips) state.clips = [];
    const newList = [...state.clips];
    newList.splice(atIndex, 0, clip);
    state.clips = newList;
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
  }

  // Substitui clips inteiro (pra undo de split)
  function replaceClips(newClips) {
    state.clips = [...newClips];
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
  }

  function selectClip(id) {
    state.selected_clip_id = id;
    emit();
  }

  // Localiza clip + retorna {clip, idx} no array atual
  function findClip(id) {
    if (!state.clips) return null;
    const idx = state.clips.findIndex(c => c.id === id);
    if (idx < 0) return null;
    return { clip: state.clips[idx], idx };
  }

  // Move clip (mantem duracao). delta em segundos. Clamp em [0, duration].
  function moveClip(id, delta) {
    materializeIfNeeded();
    const found = findClip(id);
    if (!found) return false;
    const dur = state.video.duration || 0;
    const clipDur = found.clip.source_out - found.clip.source_in;
    let newIn = found.clip.source_in + delta;
    if (newIn < 0) newIn = 0;
    if (newIn + clipDur > dur) newIn = dur - clipDur;
    const newOut = newIn + clipDur;
    if (Math.abs(newIn - found.clip.source_in) < 0.001) return false;
    state.clips[found.idx] = { ...found.clip, source_in: newIn, source_out: newOut };
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return true;
  }

  // Toggle clip.active. Default = true (incluido no export).
  function toggleClipActive(id) {
    materializeIfNeeded();
    const found = findClip(id);
    if (!found) return false;
    const newActive = found.clip.active === false ? true : false;
    state.clips[found.idx] = { ...found.clip, active: newActive };
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return true;
  }

  // Delete left of playhead (Q): encolhe source_in do clip atual ate t
  function deleteLeftFromPlayhead(t) {
    materializeIfNeeded();
    const clip = clipAtTime(t);
    if (!clip || clip.virtual) return false;
    if (t <= clip.source_in + 0.05) return false; // ja no inicio
    if (t >= clip.source_out - 0.05) return false; // deletaria tudo
    const found = findClip(clip.id);
    if (!found) return false;
    state.clips[found.idx] = { ...found.clip, source_in: t };
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return true;
  }

  // Delete right of playhead (W): encolhe source_out do clip atual ate t
  function deleteRightFromPlayhead(t) {
    materializeIfNeeded();
    const clip = clipAtTime(t);
    if (!clip || clip.virtual) return false;
    if (t >= clip.source_out - 0.05) return false; // ja no fim
    if (t <= clip.source_in + 0.05) return false; // deletaria tudo
    const found = findClip(clip.id);
    if (!found) return false;
    state.clips[found.idx] = { ...found.clip, source_out: t };
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return true;
  }

  // Define um clip inteiro (pra undo de move/Q/W)
  function updateClip(id, newProps) {
    const found = findClip(id);
    if (!found) return false;
    state.clips[found.idx] = { ...found.clip, ...newProps };
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return true;
  }

  // ─── Texts API (Fase 4) ────────────────────────────────────────────────
  let nextTextId = 1;
  function addText(props) {
    if (!state.texts) state.texts = [];
    // Gera id unico (max existing + 1)
    const maxId = state.texts.reduce((m, t) => Math.max(m, t.id || 0), 0);
    const id = Math.max(nextTextId, maxId + 1);
    nextTextId = id + 1;
    const newText = {
      id,
      content: 'Texto',
      font: 'Anton',
      color: '#ffffff',
      size: 'medium',           // small | medium | large | xlarge
      x_pct: 0.5,                // centro (0-1)
      y_pct: 0.5,
      start_sec: 0,
      end_sec: 3,
      active: true,
      ...props,
    };
    state.texts = [...state.texts, newText];
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return id;
  }
  function updateText(id, props) {
    if (!state.texts) return false;
    const idx = state.texts.findIndex(t => t.id === id);
    if (idx < 0) return false;
    state.texts[idx] = { ...state.texts[idx], ...props };
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return true;
  }
  function deleteText(id) {
    if (!state.texts) return false;
    const idx = state.texts.findIndex(t => t.id === id);
    if (idx < 0) return false;
    const removed = state.texts[idx];
    state.texts = [...state.texts.slice(0, idx), ...state.texts.slice(idx + 1)];
    state.updated_at = new Date().toISOString();
    backupSessionStorage();
    emit();
    scheduleSave();
    return removed;
  }
  function findText(id) {
    if (!state.texts) return null;
    const idx = state.texts.findIndex(t => t.id === id);
    if (idx < 0) return null;
    return { text: state.texts[idx], idx };
  }
  function getActiveTextsAt(t) {
    if (!state.texts) return [];
    return state.texts.filter(tx => tx.active !== false && t >= tx.start_sec && t <= tx.end_sec);
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

  return {
    init, get, patch, subscribe, reset, setProjectId, loadFromServer,
    // Fase 3 clips API
    getEffectiveClips, clipAtTime, getOutputDuration,
    splitAtTime, deleteClip, insertClip, replaceClips, selectClip,
    // Fase 3.1 — CapCut-style
    findClip, moveClip, toggleClipActive,
    deleteLeftFromPlayhead, deleteRightFromPlayhead,
    updateClip,
    // Fase 4 — texts
    addText, updateText, deleteText, findText, getActiveTextsAt,
  };
})();
