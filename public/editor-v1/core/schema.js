// editor-v1/core/schema.js
// Estado canonico do projeto (schema V1 — compativel com editor_jobs.project_state
// da v0 e com o payload /edit-v0 do Railway). Modulo puro: sem DOM, sem fetch.

import { animValida } from './text-anim.js';
import { normalizarKf } from './keyframes.js';
import { vozValida } from './voz-mod.js';
import { validarBg } from './fundo.js';

/** Enum de tamanhos de texto — espelha sizePct() do railway-ffmpeg/server.js */
export const TEXT_SIZES = ['small', 'medium', 'large', 'xlarge'];

/** Fator de fontsize por tamanho relativo a largura do output (1080px).
 *  ESPELHO EXATO de sizePct() no Railway — quebrar isso quebra o WYSIWYG. */
export const TEXT_SIZE_PCT = { small: 0.04, medium: 0.06, large: 0.09, xlarge: 0.13 };

/** Fontes com TTF real instalada no container do Railway (fontFile()). */
export const TEXT_FONTS = ['Anton', 'Bebas Neue', 'Oswald'];

export const TRANSITION_TYPES = ['cut', 'fade'];

// ── FORMATO DO PROJETO (proporção do preview E do arquivo exportado) ────────
// Tabela fechada estilo CapCut (user 14/08). Dimensões SEMPRE pares (h264
// yuv420p exige) e com lado maior 1920/2340 — o /edit-v0 aceita output
// arbitrário (medido: 720x1280 e 1920x1080 saem exatos).
// 'original' não tem dims aqui: deriva das dimensões da mídia principal na
// hora do uso (formatoDoProjeto). 'custom' guarda o que o user digitou.
export const FORMATOS = [
  { id: 'original', nome: 'Original',       w: null, h: null },
  { id: 'custom',   nome: 'Personalizado',  w: null, h: null },
  { id: '16:9',     nome: '16:9',           w: 1920, h: 1080 },
  { id: '4:3',      nome: '4:3',            w: 1440, h: 1080 },
  { id: '2.35:1',   nome: '2.35:1',         w: 1920, h: 816 },
  { id: '2:1',      nome: '2:1',            w: 1920, h: 960 },
  { id: '1.85:1',   nome: '1.85:1',         w: 1920, h: 1038 },
  { id: '9:16',     nome: '9:16',           w: 1080, h: 1920 },
  { id: '3:4',      nome: '3:4',            w: 1080, h: 1440 },
  { id: '5.8',      nome: '5,8 polegadas',  w: 1080, h: 2340 },
  { id: '1:1',      nome: '1:1',            w: 1080, h: 1080 },
];
export const FORMATO_PADRAO = { id: '9:16', w: 1080, h: 1920 };
const par = (n) => Math.round(Number(n) / 2) * 2;
/** Valida um formato vindo de fora (action ou projeto salvo). null = inválido. */
export function validarFormato(f) {
  if (!f || typeof f.id !== 'string') return null;
  const cat = FORMATOS.find(x => x.id === f.id);
  if (!cat) return null;
  if (cat.id === 'original') return { id: 'original', w: null, h: null };
  if (cat.id === 'custom') {
    const w = par(f.w), h = par(f.h);
    if (!(w >= 128 && h >= 128 && w <= 4320 && h <= 4320)) return null;
    return { id: 'custom', w, h };
  }
  return { id: cat.id, w: cat.w, h: cat.h };
}

export const MIN_CLIP_DURATION = 0.1; // segundos — reducers nunca deixam menor
// Texto não decodifica mídia: pode ser bem mais curto que um clipe. Uma legenda
// palavra-a-palavra tem ~0,25s, e exigir 0,1s de cada lado tornava o corte
// impossível na prática (janela de 2px). 0,03s ainda é visível e clicável.
export const MIN_TEXT_DURATION = 0.03;
export const MAX_UNDO = 100;

// ── CAMADAS (CapCut): lane = prioridade de composicao ──
// main video = base. lane 1..MAX_LANE empilham ACIMA: lane MAIOR renderiza NA
// FRENTE (o que esta por cima na timeline aparece por cima no video).
// Textos e overlays COMPARTILHAM o espaco de lanes — texto em lane 1 fica
// ATRAS de um overlay em lane 2 (regra pedida pelo user 2026-07-20).
// 2026-07-29: teto subiu de 5 pra 18 a pedido do user ("pelo menos 9 de video
// e 9 de texto"). Como video e texto dividem a MESMA numeracao, 18 garante os
// dois lados ao mesmo tempo. O numero da lane e contrato com o render do
// Railway (ops ordenadas por lane) — subir o teto NAO muda o significado, so a
// faixa, entao projeto salvo antigo continua valendo sem migracao.
export const MAX_LANE = 18;
export const LANES_POR_TIPO = 9;      // a garantia pedida: 9 de video + 9 de texto
export const MAX_AUDIO_LANE = 8;      // indices 0..8 = 9 faixas de audio
export const MAX_EXTRA_LANES = 8;     // camadas vazias criaveis pelo menu
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
    audio_clips: [],      // [{id, kind, url?, filename, media_duration, start, source_in, source_out, volume, active, lane?}]
    next_audio_id: 1,
    selected_audio_id: null,
    // camadas EXTRAS vazias (botão direito no vazio: "Criar camada …") — viram
    // rows visíveis na timeline pra soltar faixas (fluidez CapCut)
    extra_overlay_lanes: 0,
    extra_audio_lanes: 0,
    // olhinho por camada: lane escondida sai do PREVIEW e do EXPORT (áudio da
    // lane fica mudo) — a row continua na timeline, esmaecida
    hidden_overlay_lanes: [],   // [lane, ...] (overlays E textos da lane)
    hidden_audio_lanes: [],     // [laneIndex, ...]
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
    formato: { ...FORMATO_PADRAO },   // proporção do preview + export (SET_FORMATO)
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
      // animações da cena (catálogo fechado; id desconhecido morre no load)
      ...(typeof c.anim_in === 'string' ? { anim_in: c.anim_in } : {}),
      ...(typeof c.anim_out === 'string' ? { anim_out: c.anim_out } : {}),
      ...(typeof c.anim_loop === 'string' ? { anim_loop: c.anim_loop } : {}),
      // duração escolhida no slider (user 14/08) — sem copiar, reabrir apagava
      ...(typeof c.anim_in_dur === 'number' ? { anim_in_dur: clamp(c.anim_in_dur, 0.1, 5) } : {}),
      ...(typeof c.anim_out_dur === 'number' ? { anim_out_dur: clamp(c.anim_out_dur, 0.1, 5) } : {}),
      ...(typeof c.anim_loop_dur === 'number' ? { anim_loop_dur: clamp(c.anim_loop_dur, 0.1, 5) } : {}),
      ...(c.muted ? { muted: true } : {}),  // áudio removido SÓ desta cena
      // áudio da CENA estilo CapCut (15/08) — sem copiar, reabrir apagava
      ...(typeof c.volume_db === 'number' && c.volume_db !== 0 ? { volume_db: clamp(c.volume_db, -60, 10) } : {}),
      ...(typeof c.fade_in === 'number' && c.fade_in > 0 ? { fade_in: clamp(c.fade_in, 0, 5) } : {}),
      ...(typeof c.fade_out === 'number' && c.fade_out > 0 ? { fade_out: clamp(c.fade_out, 0, 5) } : {}),
      ...(c.canal === 'esq' || c.canal === 'dir' ? { canal: c.canal } : {}),
      ...(vozValida(c.voz_mod) ? { voz_mod: vozValida(c.voz_mod) } : {}),
      // remover fundo (15/08) — sem copiar, reabrir apagava o chroma/máscara
      ...(validarBg(c.bg) ? { bg: validarBg(c.bg) } : {}),
      // máscara da cena (CapCut: círculo/retângulo + suavizar + cantos)
      ...(c.mask && ['circle', 'rect'].includes(c.mask.shape) ? { mask: {
        shape: c.mask.shape,
        x_pct: clamp01(c.mask.x_pct ?? 0.5), y_pct: clamp01(c.mask.y_pct ?? 0.5),
        w_pct: clamp(c.mask.w_pct ?? 0.6, 0.05, 1), h_pct: clamp(c.mask.h_pct ?? 0.6, 0.05, 1),
        feather: clamp(c.mask.feather ?? 0, 0, 100), radius: clamp(c.mask.radius ?? 0, 0, 100),
      } } : {}),
      // Aprimorar áudio na CENA DE VÍDEO (áudio embutido) e no COMPOSTO —
      // mesmas flags do clipe de áudio; sem copiar aqui, reabrir o projeto
      // apagaria os efeitos em silêncio
      ...(c.fx_ruido === true ? { fx_ruido: true } : {}),
      ...(c.fx_voz === true ? { fx_voz: true, fx_voz_int: clamp(Math.round(c.fx_voz_int ?? 75), 0, 100) } : {}),
      ...(c.fx_norm === true ? { fx_norm: true } : {}),
      // ⚠️ CORREÇÃO DE COR: este campo NÃO era copiado aqui — reabrir o projeto
      // apagava o Retoque inteiro em silêncio. Cada chave é um número -100..100
      // (o modelo é plano de propósito), então dá pra validar sem lista fixa e
      // as abas novas (HSL/Curvas/Roda) entram sem migração.
      ...(c.grade && typeof c.grade === 'object' ? { grade: Object.fromEntries(
        Object.entries(c.grade)
          .filter(([k, v]) => /^[a-z_]+$/.test(k) && Number.isFinite(Number(v)))
          .map(([k, v]) => [k, clamp(Number(v), -100, 100)])
      ) } : {}),
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
      // ⚠️ CAMPOS QUE SUMIAM AO REABRIR (achado 14/08, mesma classe do grade):
      // a animação do texto e a ÂNCORA da legenda (src_in/out/url — o que faz
      // a legenda seguir a fala após cortes) não eram copiados aqui — reabrir
      // o projeto apagava os dois em silêncio.
      ...(animValida(t.anim) !== 'nenhuma' ? { anim: animValida(t.anim) } : {}),
      ...(Number.isFinite(t.src_in) ? {
        src_in: Math.max(0, t.src_in),
        src_out: (Number.isFinite(t.src_out) && t.src_out > t.src_in)
          ? t.src_out : Math.max(0, t.src_in) + Math.max(0.1, (t.end_sec || 0) - (t.start_sec || 0)),
        ...(t.src_url ? { src_url: String(t.src_url) } : {}),
      } : {}),
      active: t.active !== false,
    })) : [];
  s.transitions = Array.isArray(raw.transitions) ? raw.transitions : [];
  s.volumes = { video: 1, audio_extra: 1, ...(raw.volumes || {}) };
  // projeto salvo antes do formato existir → padrão 9:16 (sem migração)
  s.formato = validarFormato(raw.formato) || { ...FORMATO_PADRAO };
  s.extra_overlay_lanes = Number.isInteger(raw.extra_overlay_lanes) ? Math.max(0, Math.min(MAX_EXTRA_LANES, raw.extra_overlay_lanes)) : 0;
  s.extra_audio_lanes = Number.isInteger(raw.extra_audio_lanes) ? Math.max(0, Math.min(MAX_EXTRA_LANES, raw.extra_audio_lanes)) : 0;
  s.hidden_overlay_lanes = Array.isArray(raw.hidden_overlay_lanes) ? raw.hidden_overlay_lanes.filter(Number.isInteger) : [];
  s.hidden_audio_lanes = Array.isArray(raw.hidden_audio_lanes) ? raw.hidden_audio_lanes.filter(Number.isInteger) : [];
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
      lane: Number.isInteger(a.lane) && a.lane >= 0 ? Math.min(MAX_AUDIO_LANE, a.lane) : null,
      // Aprimorar áudio: sem copiar aqui, reabrir o projeto apagaria os
      // efeitos em silêncio (a MESMA classe de bug do grade do Retoque)
      ...(a.fx_ruido === true ? { fx_ruido: true } : {}),
      ...(a.fx_voz === true ? { fx_voz: true, fx_voz_int: clamp(Math.round(a.fx_voz_int ?? 75), 0, 100) } : {}),
      ...(a.fx_norm === true ? { fx_norm: true } : {}),
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
      // som embutido da camada (user 14/08): sem copiar aqui, reabrir o
      // projeto devolveria o som a uma camada que o user tinha silenciado
      ...(o.muted ? { muted: true } : {}),
      // animações da camada (14/08) — mesmas chaves da cena
      ...(typeof o.anim_in === 'string' ? { anim_in: o.anim_in } : {}),
      ...(typeof o.anim_out === 'string' ? { anim_out: o.anim_out } : {}),
      ...(typeof o.anim_loop === 'string' ? { anim_loop: o.anim_loop } : {}),
      ...(typeof o.anim_in_dur === 'number' ? { anim_in_dur: clamp(o.anim_in_dur, 0.1, 5) } : {}),
      ...(typeof o.anim_out_dur === 'number' ? { anim_out_dur: clamp(o.anim_out_dur, 0.1, 5) } : {}),
      ...(typeof o.anim_loop_dur === 'number' ? { anim_loop_dur: clamp(o.anim_loop_dur, 0.1, 5) } : {}),
      // quadros-chave de movimento (14/08) — lista validada; vazia some
      ...(normalizarKf(o.kf).length ? { kf: normalizarKf(o.kf) } : {}),
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
