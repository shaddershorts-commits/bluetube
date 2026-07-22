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

// ── CAMADAS (CapCut): lane = prioridade de composicao ──
// main video = base. lane 1..MAX_LANE empilham ACIMA: lane MAIOR renderiza NA
// FRENTE (o que esta por cima na timeline aparece por cima no video).
// Textos e overlays COMPARTILHAM o espaco de lanes — texto em lane 1 fica
// ATRAS de um overlay em lane 2 (regra pedida pelo user 2026-07-20).
export const MAX_LANE = 5;
export const TEXT_DEFAULT_LANE = 4;   // texto nasce no topo (padrao CapCut)
export const OVERLAY_DEFAULT_LANE = 1;
export function clampLane(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LANE, Math.max(1, n));
}

/** @returns {object} estado inicial completo do documento */
export function createInitialState() {
  return {
    version: 1,
    project_id: null,
    nome_projeto: 'Projeto sem título',
    video: null,          // { url, path, filename, duration, width, height, size_bytes }
    // POOL de midias extras (multi-take 2026-07-20): videos alem do principal.
    // clips/overlays com media_id apontam pra ca; sem media_id = video principal.
    media: [],            // [{ id, url, path, filename, duration, width, height }]
    next_media_id: 1,
    clips: [],            // [{ id, media_id?, source_in, source_out, active }] — ordem do array = ordem na timeline
    next_clip_id: 1,
    selected_clip_id: null,
    texts: [],            // [{ id, content, font, size, color, x_pct, y_pct, start_sec, end_sec, active }]
    next_text_id: 1,
    selected_text_id: null,
    // clips de audio EDITAVEIS (CapCut): posicionaveis (start), cortaveis,
    // com volume proprio. kind 'extra' = arquivo enviado (url);
    // kind 'video' = trecho do audio do proprio video (pos-detach).
    audio_clips: [],      // [{id, kind, url?, filename, media_duration, start, source_in, source_out, volume, active}]
    next_audio_id: 1,
    selected_audio_id: null,
    audio_detached: false,      // Ctrl+Shift+S: video fica mudo, audio vira clips
    // camadas de video (CapCut): arrastar clip pra CIMA cria overlay.
    // Posicionamento livre (start) + transform no preview (PiP).
    overlays: [],        // [{id, source_in, source_out, start, x_pct, y_pct, scale, active}]
    next_overlay_id: 1,
    selected_overlay_id: null,
    // clipes compostos (CapCut Alt+G): conteudo agrupado vive aqui; na main
    // track o composto e um clip {id, compound_id}. Offsets internos sao
    // RELATIVOS ao inicio do composto.
    compounds: [],       // [{id, name, clips, texts, audio_clips, overlays}]
    next_compound_id: 1,
    multi_selected: [],  // [{type:'clip'|'text'|'audio'|'overlay', id}] ctrl+click
    // legado (migrado em normalizeLoadedState): audio_extra, selected_audio,
    // video_audio_removed
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
  s.media = Array.isArray(raw.media) ? raw.media
    .filter(m => m && m.url && m.duration > 0)
    .map(m => ({ id: m.id, url: m.url, path: m.path || null, filename: m.filename || 'mídia', duration: m.duration, width: m.width || 0, height: m.height || 0 })) : [];
  const mediaIds = new Set(s.media.map(m => m.id));
  const maxMedia = s.media.reduce((m, x) => Math.max(m, x.id || 0), 0);
  s.next_media_id = Math.max(raw.next_media_id || 1, maxMedia + 1);
  s.clips = Array.isArray(raw.clips) ? raw.clips
    .filter(c => c && typeof c.source_in === 'number' && typeof c.source_out === 'number' && c.source_out > c.source_in)
    .map(c => ({
      id: c.id, source_in: c.source_in, source_out: c.source_out, active: c.active !== false,
      ...(c.media_id != null && mediaIds.has(c.media_id) ? { media_id: c.media_id } : {}),
      ...(typeof c.scale === 'number' ? { scale: clamp(c.scale, 0.1, 3) } : {}),
      ...(typeof c.opacity === 'number' ? { opacity: clamp01(c.opacity) } : {}),
      ...(typeof c.speed === 'number' ? { speed: clamp(c.speed, 0.1, 100) } : {}),
      ...(c.frozen ? { frozen: true, freeze_src: Math.max(0, c.freeze_src || 0), freeze_dur: Math.max(0.1, c.freeze_dur || 3) } : {}),
      ...(c.reversed ? { reversed: true } : {}),
      ...(c.mirrored ? { mirrored: true } : {}),
    })) : [];
  s.texts = Array.isArray(raw.texts) ? raw.texts
    .filter(t => t && typeof t.content === 'string')
    .map(t => ({
      id: t.id,
      content: t.content,
      font: TEXT_FONTS.includes(t.font) ? t.font : 'Anton',
      size: TEXT_SIZES.includes(t.size) ? t.size : 'medium',
      color: /^#[0-9a-fA-F]{6}$/.test(t.color || '') ? t.color : '#ffffff',
      // tarja/caixa colorida atrás da legenda (estilo CapCut) — null = sem caixa
      box: /^#[0-9a-fA-F]{6}$/.test(t.box || '') ? t.box : null,
      stroke: /^#[0-9a-fA-F]{6}$/.test(t.stroke || '') ? t.stroke : null,
      x_pct: clamp01(t.x_pct ?? 0.5),
      y_pct: clamp01(t.y_pct ?? 0.5),
      start_sec: Math.max(0, t.start_sec || 0),
      end_sec: Math.max(0, t.end_sec || 0),
      caption: t.caption === true,
      lane: clampLane(t.lane, TEXT_DEFAULT_LANE),
      active: t.active !== false,
    })) : [];
  s.transitions = Array.isArray(raw.transitions) ? raw.transitions : [];
  s.volumes = { video: 1, audio_extra: 1, ...(raw.volumes || {}) };
  s.audio_detached = raw.audio_detached === true;
  s.selected_audio_id = null;
  // audio_clips (modelo novo) + migracao dos formatos legados
  s.audio_clips = Array.isArray(raw.audio_clips) ? raw.audio_clips
    .filter(a => a && typeof a.source_in === 'number' && a.source_out > a.source_in)
    .map(a => ({
      id: a.id, kind: a.kind === 'video' ? 'video' : 'extra',
      url: a.url || null, filename: a.filename || '',
      media_duration: a.media_duration || (a.source_out - a.source_in),
      start: Math.max(0, a.start || 0),
      source_in: a.source_in, source_out: a.source_out,
      volume: typeof a.volume === 'number' ? clamp(a.volume, 0, 2) : 1,
      ...(typeof a.speed === 'number' ? { speed: clamp(a.speed, 0.1, 100) } : {}),
      active: a.active !== false,
    })) : [];
  if (!s.audio_clips.length && raw.audio_extra?.url && raw.audio_extra?.duration > 0) {
    // legado: audio_extra unico fixo no 0:00 -> vira clip editavel
    s.audio_clips = [{
      id: 1, kind: 'extra', url: raw.audio_extra.url,
      filename: raw.audio_extra.filename || 'áudio',
      media_duration: raw.audio_extra.duration,
      start: 0, source_in: 0, source_out: raw.audio_extra.duration,
      volume: s.volumes.audio_extra ?? 1, active: true,
    }];
  }
  if (raw.video_audio_removed === true) {
    // legado: detach+delete -> modelo novo = detach sem clips de video
    s.audio_detached = true;
    s.audio_clips = s.audio_clips.filter(a => a.kind !== 'video');
  }
  s.overlays = Array.isArray(raw.overlays) ? raw.overlays
    .filter(o => o && o.source_out > o.source_in)
    .map(o => ({
      id: o.id, source_in: o.source_in, source_out: o.source_out,
      ...(o.media_id != null && mediaIds.has(o.media_id) ? { media_id: o.media_id } : {}),
      ...(o.kind === 'image' && o.url ? { kind: 'image', url: o.url, img_w: o.img_w || 0, img_h: o.img_h || 0 } : {}),
      ...(typeof o.speed === 'number' ? { speed: clamp(o.speed, 0.1, 100) } : {}),
      start: Math.max(0, o.start || 0),
      x_pct: clamp01(o.x_pct ?? 0.5), y_pct: clamp01(o.y_pct ?? 0.5),
      scale: Math.min(2, Math.max(0.1, o.scale ?? 0.5)),
      ...(typeof o.rotation === 'number' ? { rotation: ((o.rotation % 360) + 360) % 360 } : {}),
      lane: clampLane(o.lane, OVERLAY_DEFAULT_LANE),
      active: o.active !== false,
    })) : [];
  s.compounds = Array.isArray(raw.compounds) ? raw.compounds : [];
  const maxComp = s.compounds.reduce((m, c) => Math.max(m, c.id || 0), 0);
  s.next_compound_id = Math.max(raw.next_compound_id || 1, maxComp + 1);
  s.multi_selected = [];
  const maxOv = s.overlays.reduce((m, o) => Math.max(m, o.id || 0), 0);
  s.next_overlay_id = Math.max(raw.next_overlay_id || 1, maxOv + 1);
  s.selected_overlay_id = null;
  const maxAudio = s.audio_clips.reduce((m, a) => Math.max(m, a.id || 0), 0);
  s.next_audio_id = Math.max(raw.next_audio_id || 1, maxAudio + 1);
  delete s.audio_extra;
  delete s.selected_audio;
  delete s.video_audio_removed;
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
