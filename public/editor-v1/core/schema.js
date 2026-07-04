// editor-v1/core/schema.js
// Estado canonico do projeto (schema V1 — compativel com editor_jobs.project_state
// da v0 e com o payload /edit-v0 do Railway). Modulo puro: sem DOM, sem fetch.

/** Enum de tamanhos de texto — espelha sizePct() do railway-ffmpeg/server.js */
export const TEXT_SIZES = ['small', 'medium', 'large', 'xlarge'];

/** Fator de fontsize por tamanho relativo a largura do output (1080px).
 *  ESPELHO EXATO de sizePct() no Railway — quebrar isso quebra o WYSIWYG. */
export const TEXT_SIZE_PCT = { small: 0.04, medium: 0.06, large: 0.09, xlarge: 0.13 };

/** Fontes com TTF real instalada no container do Railway (fontFile()). */
export const TEXT_FONTS = ['Anton', 'Bebas Neue', 'Oswald'];

export const TRANSITION_TYPES = ['cut', 'fade'];

export const MIN_CLIP_DURATION = 0.1; // segundos — reducers nunca deixam menor
export const MAX_UNDO = 100;

/** @returns {object} estado inicial completo do documento */
export function createInitialState() {
  return {
    version: 1,
    project_id: null,
    nome_projeto: 'Projeto sem título',
    video: null,          // { url, path, filename, duration, width, height, size_bytes }
    clips: [],            // [{ id, source_in, source_out, active }] — ordem do array = ordem na timeline
    next_clip_id: 1,
    selected_clip_id: null,
    texts: [],            // [{ id, content, font, size, color, x_pct, y_pct, start_sec, end_sec, active }]
    next_text_id: 1,
    selected_text_id: null,
    audio_extra: null,    // { url, path, filename, duration, size_bytes }
    audio_detached: false,      // Ctrl+Shift+S: audio do video vira track propria
    video_audio_removed: false, // item de audio destacado foi deletado (export muta o video)
    selected_audio: null,       // 'video' | 'extra' | null (selecao na track de audio)
    transitions: [],      // [{ between, type, duration }]
    volumes: { video: 1, audio_extra: 1 },
    aspect_strategy: 'crop_center',
    created_at: null,
    updated_at: null,
  };
}

/** Cria o clip inicial cobrindo o video inteiro (chamado apos upload). */
export function createFullClip(state, duration) {
  return {
    id: state.next_clip_id,
    source_in: 0,
    source_out: duration,
    active: true,
  };
}

/** Valida/normaliza um project_state carregado do backend (pode vir da v0). */
export function normalizeLoadedState(raw) {
  const base = createInitialState();
  if (!raw || typeof raw !== 'object') return base;
  const s = { ...base, ...raw };
  s.clips = Array.isArray(raw.clips) ? raw.clips
    .filter(c => c && typeof c.source_in === 'number' && typeof c.source_out === 'number' && c.source_out > c.source_in)
    .map(c => ({ id: c.id, source_in: c.source_in, source_out: c.source_out, active: c.active !== false })) : [];
  s.texts = Array.isArray(raw.texts) ? raw.texts
    .filter(t => t && typeof t.content === 'string')
    .map(t => ({
      id: t.id,
      content: t.content,
      font: TEXT_FONTS.includes(t.font) ? t.font : 'Anton',
      size: TEXT_SIZES.includes(t.size) ? t.size : 'medium',
      color: /^#[0-9a-fA-F]{6}$/.test(t.color || '') ? t.color : '#ffffff',
      x_pct: clamp01(t.x_pct ?? 0.5),
      y_pct: clamp01(t.y_pct ?? 0.5),
      start_sec: Math.max(0, t.start_sec || 0),
      end_sec: Math.max(0, t.end_sec || 0),
      active: t.active !== false,
    })) : [];
  s.transitions = Array.isArray(raw.transitions) ? raw.transitions : [];
  s.volumes = { video: 1, audio_extra: 1, ...(raw.volumes || {}) };
  s.audio_detached = raw.audio_detached === true;
  s.video_audio_removed = raw.video_audio_removed === true;
  s.selected_audio = null;
  // Migracao v0: se veio com trim global e sem clips, materializa em 1 clip
  if (s.clips.length === 0 && s.video?.duration > 0) {
    const inT = raw.trim?.in || 0;
    const outT = raw.trim?.out > 0 ? Math.min(raw.trim.out, s.video.duration) : s.video.duration;
    if (outT - inT >= MIN_CLIP_DURATION) {
      s.clips = [{ id: 1, source_in: inT, source_out: outT, active: true }];
      s.next_clip_id = 2;
    }
  }
  // next ids consistentes
  const maxClip = s.clips.reduce((m, c) => Math.max(m, c.id || 0), 0);
  if (!(s.next_clip_id > maxClip)) s.next_clip_id = maxClip + 1;
  const maxText = s.texts.reduce((m, t) => Math.max(m, t.id || 0), 0);
  if (!(s.next_text_id > maxText)) s.next_text_id = maxText + 1;
  delete s.trim; // v1 nao usa trim global — clips sao a fonte de verdade
  return s;
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
