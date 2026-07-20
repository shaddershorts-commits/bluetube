// editor-v1/core/reducers.js
// Reducer puro do documento. Invariantes garantidas AQUI (nao na UI):
//   - clip.source_in < clip.source_out (sempre, minimo MIN_CLIP_DURATION)
//   - clips nunca ultrapassam [0, video.duration]
//   - deletar/mover nunca corrompe next_clip_id
// Estado e imutavel: cada action retorna um objeto novo.

import { A } from './actions.js';
import { createInitialState, normalizeLoadedState, createFullClip, clamp, clamp01, MIN_CLIP_DURATION, TEXT_FONTS, TEXT_SIZES, clampLane, TEXT_DEFAULT_LANE, OVERLAY_DEFAULT_LANE } from './schema.js';
import { timelineSegments, segmentAt, mainTrackItems } from './selectors.js';

export function reduce(state, action) {
  switch (action.type) {

    case A.LOAD_PROJECT: {
      return normalizeLoadedState(action.project);
    }

    case A.SET_VIDEO: {
      const video = action.video;
      const next = { ...createInitialState(), nome_projeto: state.nome_projeto, project_id: state.project_id, video };
      if (video?.duration > 0) {
        next.clips = [createFullClip(next, video.duration)];
        next.next_clip_id = 2;
        next.selected_clip_id = null;
      }
      next.created_at = state.created_at || new Date().toISOString();
      return touch(next);
    }

    case A.RENAME_PROJECT: {
      const nome = String(action.nome || '').slice(0, 120).trim();
      if (!nome) return state;
      return touch({ ...state, nome_projeto: nome });
    }

    case A.SET_PROJECT_ID:
      return { ...state, project_id: action.id };

    // ── clips ────────────────────────────────────────────────────────────

    case A.SPLIT_CLIP: {
      // Divide o clip sob o tempo virtual t em dois.
      const seg = segmentAt(state, action.t);
      if (!seg) return state;
      const srcSplit = seg.clip.source_in + (action.t - seg.tStart);
      // Nao cria fatia menor que o minimo
      if (srcSplit - seg.clip.source_in < MIN_CLIP_DURATION) return state;
      if (seg.clip.source_out - srcSplit < MIN_CLIP_DURATION) return state;
      const idx = state.clips.findIndex(c => c.id === seg.clip.id);
      const left = { ...seg.clip, source_out: srcSplit };
      const right = { id: state.next_clip_id, source_in: srcSplit, source_out: seg.clip.source_out, active: true };
      const clips = [...state.clips.slice(0, idx), left, right, ...state.clips.slice(idx + 1)];
      return touch({ ...state, clips, next_clip_id: state.next_clip_id + 1, selected_clip_id: right.id });
    }

    case A.TRIM_CLIP: {
      // edge: 'in' | 'out'. sourceTime em tempo do arquivo.
      const idx = state.clips.findIndex(c => c.id === action.clipId);
      if (idx < 0) return state;
      const c = state.clips[idx];
      const dur = state.video?.duration || Infinity;
      let { source_in, source_out } = c;
      if (action.edge === 'in') {
        source_in = clamp(action.sourceTime, 0, source_out - MIN_CLIP_DURATION);
      } else {
        source_out = clamp(action.sourceTime, source_in + MIN_CLIP_DURATION, dur);
      }
      if (source_in === c.source_in && source_out === c.source_out) return state;
      const clips = state.clips.slice();
      clips[idx] = { ...c, source_in, source_out };
      return touch({ ...state, clips });
    }

    case A.MOVE_CLIP: {
      const from = state.clips.findIndex(c => c.id === action.clipId);
      if (from < 0) return state;
      const to = clamp(action.toIndex, 0, state.clips.length - 1);
      if (from === to) return state;
      const clips = state.clips.slice();
      const [moved] = clips.splice(from, 1);
      clips.splice(to, 0, moved);
      return touch({ ...state, clips });
    }

    case A.DELETE_CLIP: {
      const clips = state.clips.filter(c => c.id !== action.clipId);
      if (clips.length === state.clips.length) return state;
      const selected = state.selected_clip_id === action.clipId ? null : state.selected_clip_id;
      return touch({ ...state, clips, selected_clip_id: selected });
    }

    case A.TOGGLE_CLIP: {
      const idx = state.clips.findIndex(c => c.id === action.clipId);
      if (idx < 0) return state;
      const clips = state.clips.slice();
      clips[idx] = { ...clips[idx], active: clips[idx].active === false };
      return touch({ ...state, clips });
    }

    case A.SELECT_CLIP:
      if (state.selected_clip_id === action.clipId) return state;
      return { ...state, selected_clip_id: action.clipId, selected_text_id: null, selected_audio_id: null, selected_overlay_id: null };

    case A.DELETE_RANGE_LEFT: {
      // CapCut "Q" (fix 2026-07-20): age SÓ no clip SELECIONADO — trima a
      // parte à ESQUERDA do playhead DENTRO dele. O comportamento antigo
      // (varrer a timeline inteira e deletar tudo antes do playhead) apagava
      // o projeto — user pegou. Sem seleção: trima só o clip sob o playhead.
      const segs = timelineSegments(state);
      const alvo = state.selected_clip_id != null
        ? segs.find(s2 => s2.clip.id === state.selected_clip_id)
        : segmentAt(state, action.t);
      if (!alvo) return state;
      // playhead fora do clip alvo: nada a trimar
      if (action.t <= alvo.tStart + 1e-9 || action.t >= alvo.tEnd - 1e-9) return state;
      const srcCut = alvo.clip.source_in + (action.t - alvo.tStart);
      if (srcCut - alvo.clip.source_in < MIN_CLIP_DURATION) return state;
      if (alvo.clip.source_out - srcCut < MIN_CLIP_DURATION) return state;
      const clips = state.clips.map(c => c.id === alvo.clip.id ? { ...c, source_in: srcCut } : c);
      return touch({ ...state, clips });
    }

    case A.DELETE_RANGE_RIGHT: {
      // CapCut "W": espelho do Q — trima a parte à DIREITA do playhead
      // dentro do clip selecionado (ou o sob o playhead, sem seleção).
      const segs = timelineSegments(state);
      const alvo = state.selected_clip_id != null
        ? segs.find(s2 => s2.clip.id === state.selected_clip_id)
        : segmentAt(state, action.t);
      if (!alvo) return state;
      if (action.t <= alvo.tStart + 1e-9 || action.t >= alvo.tEnd - 1e-9) return state;
      const srcCut = alvo.clip.source_in + (action.t - alvo.tStart);
      if (alvo.clip.source_out - srcCut < MIN_CLIP_DURATION) return state;
      if (srcCut - alvo.clip.source_in < MIN_CLIP_DURATION) return state;
      const clips = state.clips.map(c => c.id === alvo.clip.id ? { ...c, source_out: srcCut } : c);
      return touch({ ...state, clips });
    }

    // ── textos ───────────────────────────────────────────────────────────

    case A.ADD_TEXT: {
      const p = action.props || {};
      const text = {
        id: state.next_text_id,
        content: String(p.content || 'Texto').slice(0, 200),
        font: TEXT_FONTS.includes(p.font) ? p.font : 'Anton',
        size: TEXT_SIZES.includes(p.size) ? p.size : 'medium',
        color: /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : '#ffffff',
        x_pct: clamp01(p.x_pct ?? 0.5),
        y_pct: clamp01(p.y_pct ?? 0.35),
        start_sec: Math.max(0, p.start_sec ?? 0),
        end_sec: Math.max(0, p.end_sec ?? 3),
        caption: p.caption === true,
        lane: clampLane(p.lane, TEXT_DEFAULT_LANE),
        active: true,
      };
      if (text.end_sec <= text.start_sec) text.end_sec = text.start_sec + 1;
      return touch({
        ...state,
        texts: [...state.texts, text],
        next_text_id: state.next_text_id + 1,
        selected_text_id: text.id,
      });
    }

    case A.UPDATE_TEXT: {
      const idx = state.texts.findIndex(t => t.id === action.textId);
      if (idx < 0) return state;
      const cur = state.texts[idx];
      const patch = { ...action.patch };
      if (patch.font && !TEXT_FONTS.includes(patch.font)) delete patch.font;
      if (patch.size && !TEXT_SIZES.includes(patch.size)) delete patch.size;
      if (patch.color && !/^#[0-9a-fA-F]{6}$/.test(patch.color)) delete patch.color;
      if (patch.content != null) patch.content = String(patch.content).slice(0, 200);
      if (patch.x_pct != null) patch.x_pct = clamp01(patch.x_pct);
      if (patch.y_pct != null) patch.y_pct = clamp01(patch.y_pct);
      if (patch.start_sec != null) patch.start_sec = Math.max(0, patch.start_sec);
      if (patch.end_sec != null) patch.end_sec = Math.max(0, patch.end_sec);
      const next = { ...cur, ...patch };
      if (next.end_sec <= next.start_sec) next.end_sec = next.start_sec + 0.5;
      const texts = state.texts.slice();
      texts[idx] = next;
      return touch({ ...state, texts });
    }

    case A.MOVE_TEXT: {
      const idx = state.texts.findIndex(t => t.id === action.textId);
      if (idx < 0) return state;
      const texts = state.texts.slice();
      texts[idx] = { ...texts[idx], x_pct: clamp01(action.x_pct), y_pct: clamp01(action.y_pct) };
      return touch({ ...state, texts });
    }

    case A.DELETE_TEXT: {
      const texts = state.texts.filter(t => t.id !== action.textId);
      if (texts.length === state.texts.length) return state;
      const sel = state.selected_text_id === action.textId ? null : state.selected_text_id;
      return touch({ ...state, texts, selected_text_id: sel });
    }

    case A.SPLIT_TEXT: {
      // divide o texto no tempo t: [start,t) + [t,end) — CapCut split em texto
      const idx = state.texts.findIndex(x => x.id === action.textId);
      if (idx < 0) return state;
      const tx = state.texts[idx];
      const t = action.t;
      if (t <= tx.start_sec + MIN_CLIP_DURATION || t >= tx.end_sec - MIN_CLIP_DURATION) return state;
      const left = { ...tx, end_sec: t };
      const right = { ...tx, id: state.next_text_id, start_sec: t };
      const texts = state.texts.flatMap(x => x.id === tx.id ? [left, right] : [x]);
      return touch({ ...state, texts, next_text_id: state.next_text_id + 1, selected_text_id: right.id });
    }

    case A.SELECT_TEXT:
      if (state.selected_text_id === action.textId) return state;
      return { ...state, selected_text_id: action.textId, selected_clip_id: null, selected_audio_id: null, selected_overlay_id: null };

    // ── audio: clips editaveis (CapCut) ─────────────────────────────────

    case A.ADD_AUDIO_CLIP: {
      const m = action.media || {};
      if (!m.url || !(m.duration > 0)) return state;
      const clip = {
        id: state.next_audio_id, kind: 'extra',
        url: m.url, filename: m.filename || 'áudio',
        media_duration: m.duration,
        start: 0, source_in: 0, source_out: m.duration,
        volume: 1, active: true,
      };
      return touch({
        ...state,
        audio_clips: [...state.audio_clips, clip],
        next_audio_id: state.next_audio_id + 1,
        selected_audio_id: clip.id,
        selected_clip_id: null, selected_text_id: null,
      });
    }

    case A.DETACH_AUDIO: {
      // Ctrl+Shift+S (CapCut): 1 clip de audio POR SEGMENTO de video atual,
      // na mesma posicao da timeline. Depois disso sao INDEPENDENTES do video.
      if (state.audio_detached || !state.video) return state;
      let nid = state.next_audio_id;
      const newClips = [];
      let t = 0;
      for (const c of state.clips.filter(c => c.active !== false && !c.compound_id)) {
        const dur = c.source_out - c.source_in;
        newClips.push({
          id: nid++, kind: 'video', url: null,
          filename: 'áudio do vídeo',
          media_duration: state.video.duration,
          start: t, source_in: c.source_in, source_out: c.source_out,
          volume: state.volumes.video ?? 1, active: true,
        });
        t += dur;
      }
      return touch({
        ...state,
        audio_detached: true,
        audio_clips: [...state.audio_clips, ...newClips],
        next_audio_id: nid,
        selected_audio_id: newClips[0]?.id ?? null,
        selected_clip_id: null, selected_text_id: null,
      });
    }

    case A.SPLIT_AUDIO: {
      // corta o clip de audio sob o tempo virtual t (selecionado tem prioridade)
      const t = action.t;
      const hitClip = (a) => a.active !== false &&
        t > a.start + MIN_CLIP_DURATION &&
        t < a.start + (a.source_out - a.source_in) - MIN_CLIP_DURATION;
      let target = state.audio_clips.find(a => a.id === state.selected_audio_id && hitClip(a));
      if (!target) target = state.audio_clips.find(hitClip);
      if (!target) return state;
      const offset = t - target.start;
      const splitSrc = target.source_in + offset;
      const left = { ...target, source_out: splitSrc };
      const right = {
        ...target, id: state.next_audio_id,
        start: t, source_in: splitSrc,
      };
      const audio_clips = state.audio_clips.flatMap(a => a.id === target.id ? [left, right] : [a]);
      return touch({ ...state, audio_clips, next_audio_id: state.next_audio_id + 1, selected_audio_id: right.id });
    }

    case A.TRIM_AUDIO: {
      // edge 'in': move start + source_in juntos (borda esquerda segue o
      // cursor, conteudo fixo — CapCut). edge 'out': so source_out.
      const idx = state.audio_clips.findIndex(a => a.id === action.audioId);
      if (idx < 0) return state;
      const a = state.audio_clips[idx];
      let { start, source_in, source_out } = a;
      if (action.edge === 'in') {
        const delta = clamp(action.value - a.start,           // delta em segundos
          -a.source_in,                                        // nao antes do inicio do media
          (a.source_out - a.source_in) - MIN_CLIP_DURATION);   // nao colapsa
        start = Math.max(0, a.start + delta);
        source_in = a.source_in + delta;
      } else {
        source_out = clamp(action.value, a.source_in + MIN_CLIP_DURATION, a.media_duration);
      }
      if (start === a.start && source_in === a.source_in && source_out === a.source_out) return state;
      const audio_clips = state.audio_clips.slice();
      audio_clips[idx] = { ...a, start, source_in, source_out };
      return touch({ ...state, audio_clips });
    }

    case A.MOVE_AUDIO: {
      const idx = state.audio_clips.findIndex(a => a.id === action.audioId);
      if (idx < 0) return state;
      const start = Math.max(0, Number(action.start) || 0);
      if (state.audio_clips[idx].start === start) return state;
      const audio_clips = state.audio_clips.slice();
      audio_clips[idx] = { ...audio_clips[idx], start };
      return touch({ ...state, audio_clips });
    }

    case A.DELETE_AUDIO_CLIP: {
      const audio_clips = state.audio_clips.filter(a => a.id !== action.audioId);
      if (audio_clips.length === state.audio_clips.length) return state;
      const sel = state.selected_audio_id === action.audioId ? null : state.selected_audio_id;
      return touch({ ...state, audio_clips, selected_audio_id: sel });
    }

    case A.SET_AUDIO_VOLUME: {
      const idx = state.audio_clips.findIndex(a => a.id === action.audioId);
      if (idx < 0) return state;
      const volume = clamp(Number(action.value) || 0, 0, 2);
      if (state.audio_clips[idx].volume === volume) return state;
      const audio_clips = state.audio_clips.slice();
      audio_clips[idx] = { ...audio_clips[idx], volume };
      return touch({ ...state, audio_clips });
    }

    case A.SELECT_AUDIO_CLIP: {
      if (state.selected_audio_id === action.audioId) return state;
      return { ...state, selected_audio_id: action.audioId, selected_clip_id: null, selected_text_id: null, selected_overlay_id: null };
    }

    // ── camadas overlay (CapCut: arrastar clip pra cima) ────────────────

    case A.CONVERT_TO_OVERLAY: {
      // remove o clip da track principal e vira CAMADA na posicao atT.
      // Regra CapCut: nao esvazia a principal (ultimo clip nao sobe).
      // scale 1.0 = camada cobre o quadro inteiro (CapCut) — o PiP menor é
      // opcao do usuario depois (arrasta/escala no preview).
      const clip = state.clips.find(c => c.id === action.clipId);
      if (!clip) return state;
      const remaining = state.clips.filter(c => c.id !== action.clipId && c.active !== false);
      if (remaining.length === 0) return state;
      const overlay = {
        id: state.next_overlay_id,
        source_in: clip.source_in, source_out: clip.source_out,
        start: Math.max(0, action.atT || 0),
        x_pct: 0.5, y_pct: 0.5, scale: 1,
        lane: clampLane(action.lane, OVERLAY_DEFAULT_LANE),
        active: true,
      };
      return touch({
        ...state,
        clips: state.clips.filter(c => c.id !== action.clipId),
        overlays: [...state.overlays, overlay],
        next_overlay_id: state.next_overlay_id + 1,
        selected_overlay_id: overlay.id,
        selected_clip_id: null,
      });
    }

    case A.TRIM_OVERLAY: {
      const idx = state.overlays.findIndex(o => o.id === action.overlayId);
      if (idx < 0) return state;
      const o = state.overlays[idx];
      let { start, source_in, source_out } = o;
      if (action.edge === 'in') {
        const delta = clamp(action.value - o.start,
          -o.source_in, (o.source_out - o.source_in) - MIN_CLIP_DURATION);
        start = Math.max(0, o.start + delta);
        source_in = o.source_in + delta;
      } else {
        const maxOut = state.video?.duration || Infinity;
        source_out = clamp(action.value, o.source_in + MIN_CLIP_DURATION, maxOut);
      }
      if (start === o.start && source_in === o.source_in && source_out === o.source_out) return state;
      const overlays = state.overlays.slice();
      overlays[idx] = { ...o, start, source_in, source_out };
      return touch({ ...state, overlays });
    }

    case A.MOVE_OVERLAY: {
      const idx = state.overlays.findIndex(o => o.id === action.overlayId);
      if (idx < 0) return state;
      const start = Math.max(0, Number(action.start) || 0);
      if (state.overlays[idx].start === start) return state;
      const overlays = state.overlays.slice();
      overlays[idx] = { ...overlays[idx], start };
      return touch({ ...state, overlays });
    }

    case A.SET_OVERLAY_TRANSFORM: {
      const idx = state.overlays.findIndex(o => o.id === action.overlayId);
      if (idx < 0) return state;
      const o = state.overlays[idx];
      const p = action.patch || {};
      const next = {
        ...o,
        x_pct: p.x_pct != null ? clamp01(p.x_pct) : o.x_pct,
        y_pct: p.y_pct != null ? clamp01(p.y_pct) : o.y_pct,
        scale: p.scale != null ? clamp(p.scale, 0.1, 2) : o.scale,
      };
      if (next.x_pct === o.x_pct && next.y_pct === o.y_pct && next.scale === o.scale) return state;
      const overlays = state.overlays.slice();
      overlays[idx] = next;
      return touch({ ...state, overlays });
    }

    case A.DELETE_OVERLAY: {
      const overlays = state.overlays.filter(o => o.id !== action.overlayId);
      if (overlays.length === state.overlays.length) return state;
      const sel = state.selected_overlay_id === action.overlayId ? null : state.selected_overlay_id;
      return touch({ ...state, overlays, selected_overlay_id: sel });
    }

    case A.SET_ITEM_LANE: {
      // arrasto vertical na timeline: muda a camada (z) de overlay/texto.
      // Camada MAIOR = mais acima na timeline = NA FRENTE no video (CapCut).
      const lane = clampLane(action.lane, null);
      if (lane == null) return state;
      if (action.itemType === 'overlay') {
        const idx = state.overlays.findIndex(o => o.id === action.id);
        if (idx < 0 || state.overlays[idx].lane === lane) return state;
        const overlays = state.overlays.slice();
        overlays[idx] = { ...overlays[idx], lane };
        return touch({ ...state, overlays });
      }
      if (action.itemType === 'text') {
        const idx = state.texts.findIndex(t => t.id === action.id);
        if (idx < 0 || state.texts[idx].lane === lane) return state;
        const texts = state.texts.slice();
        texts[idx] = { ...texts[idx], lane };
        return touch({ ...state, texts });
      }
      return state;
    }

    case A.SELECT_OVERLAY: {
      if (state.selected_overlay_id === action.overlayId) return state;
      return {
        ...state, selected_overlay_id: action.overlayId,
        selected_clip_id: null, selected_text_id: null, selected_audio_id: null,
      };
    }

    // ── clipes compostos (CapCut Alt+G) ─────────────────────────────────

    case A.TOGGLE_MULTI_SELECT: {
      const key = (x) => x.type + ':' + x.id;
      const item = { type: action.itemType, id: action.id };
      const has = state.multi_selected.some(x => key(x) === key(item));
      const multi_selected = has
        ? state.multi_selected.filter(x => key(x) !== key(item))
        : [...state.multi_selected, item];
      return { ...state, multi_selected };
    }

    case A.SELECT_ALL: {
      const multi_selected = [
        ...state.clips.filter(c => c.active !== false).map(c => ({ type: 'clip', id: c.id })),
        ...state.texts.filter(t => t.active !== false).map(t => ({ type: 'text', id: t.id })),
        ...state.audio_clips.filter(a => a.active !== false).map(a => ({ type: 'audio', id: a.id })),
        ...state.overlays.filter(o => o.active !== false).map(o => ({ type: 'overlay', id: o.id })),
      ];
      return { ...state, multi_selected };
    }

    case A.SET_MULTI_SELECT: {
      // marquee: substitui a multi-selecao inteira (lista ja validada pelo
      // controller — so ids que existem no layout)
      const items = Array.isArray(action.items) ? action.items
        .filter(x => x && ['clip', 'text', 'audio', 'overlay'].includes(x.type) && x.id != null)
        .map(x => ({ type: x.type, id: x.id })) : [];
      return { ...state, multi_selected: items };
    }

    case A.DELETE_MULTI: {
      // Delete com multi-selecao: apaga TUDO que esta selecionado, de todas
      // as faixas, num unico undo step.
      if (!state.multi_selected.length) return state;
      const ids = (tipo) => new Set(state.multi_selected.filter(x => x.type === tipo).map(x => x.id));
      const clipIds = ids('clip'), textIds = ids('text'), audioIds = ids('audio'), ovIds = ids('overlay');
      return touch({
        ...state,
        clips: state.clips.filter(c => !clipIds.has(c.id)),
        texts: state.texts.filter(t => !textIds.has(t.id)),
        audio_clips: state.audio_clips.filter(a => !audioIds.has(a.id)),
        overlays: state.overlays.filter(o => !ovIds.has(o.id)),
        multi_selected: [],
        selected_clip_id: clipIds.has(state.selected_clip_id) ? null : state.selected_clip_id,
        selected_text_id: textIds.has(state.selected_text_id) ? null : state.selected_text_id,
        selected_audio_id: audioIds.has(state.selected_audio_id) ? null : state.selected_audio_id,
        selected_overlay_id: ovIds.has(state.selected_overlay_id) ? null : state.selected_overlay_id,
      });
    }

    case A.CREATE_COMPOUND: {
      // Alt+G: agrupa a multi-selecao (ou a selecao simples) num composto.
      let sel = state.multi_selected;
      if (!sel.length) {
        sel = [];
        if (state.selected_clip_id != null) sel.push({ type: 'clip', id: state.selected_clip_id });
        if (state.selected_text_id != null) sel.push({ type: 'text', id: state.selected_text_id });
        if (state.selected_audio_id != null) sel.push({ type: 'audio', id: state.selected_audio_id });
        if (state.selected_overlay_id != null) sel.push({ type: 'overlay', id: state.selected_overlay_id });
      }
      const clipIds = sel.filter(x => x.type === 'clip').map(x => x.id);
      const inClips = state.clips.filter(c => clipIds.includes(c.id) && !c.compound_id && c.active !== false);
      if (!inClips.length) return state; // composto precisa de >=1 clip de video
      const items = mainTrackItems(state);
      const firstIt = items.find(it => clipIds.includes(it.clip.id));
      const base = firstIt ? firstIt.tStart : 0;
      const textIds = sel.filter(x => x.type === 'text').map(x => x.id);
      const audioIds = sel.filter(x => x.type === 'audio').map(x => x.id);
      const ovIds = sel.filter(x => x.type === 'overlay').map(x => x.id);
      const comp = {
        id: state.next_compound_id,
        name: 'Clipe composto ' + state.next_compound_id,
        clips: inClips.map(c => ({ ...c })),
        texts: state.texts.filter(t => textIds.includes(t.id))
          .map(t => ({ ...t, start_sec: Math.max(0, t.start_sec - base), end_sec: Math.max(0.1, t.end_sec - base) })),
        audio_clips: state.audio_clips.filter(a => audioIds.includes(a.id))
          .map(a => ({ ...a, start: Math.max(0, a.start - base) })),
        overlays: state.overlays.filter(o => ovIds.includes(o.id))
          .map(o => ({ ...o, start: Math.max(0, o.start - base) })),
      };
      const compClip = { id: state.next_clip_id, compound_id: comp.id, active: true };
      const firstIdx = state.clips.findIndex(c => c.id === inClips[0].id);
      const clips = state.clips
        .map((c, i) => i === firstIdx ? compClip : c)
        .filter(c => c === compClip || !clipIds.includes(c.id));
      return touch({
        ...state,
        clips,
        next_clip_id: state.next_clip_id + 1,
        texts: state.texts.filter(t => !textIds.includes(t.id)),
        audio_clips: state.audio_clips.filter(a => !audioIds.includes(a.id)),
        overlays: state.overlays.filter(o => !ovIds.includes(o.id)),
        compounds: [...state.compounds, comp],
        next_compound_id: state.next_compound_id + 1,
        multi_selected: [],
        selected_clip_id: compClip.id,
        selected_text_id: null, selected_audio_id: null, selected_overlay_id: null,
      });
    }

    case A.UNGROUP_COMPOUND: {
      // Shift+Alt+G: devolve o conteudo pro documento principal
      const comp = state.compounds.find(k => k.id === action.compoundId);
      if (!comp) return state;
      const items = mainTrackItems(state);
      const it = items.find(x => x.clip.compound_id === comp.id);
      const base = it ? it.tStart : 0;
      const idx = state.clips.findIndex(c => c.compound_id === comp.id);
      if (idx < 0) return state;
      let nextClip = state.next_clip_id, nextText = state.next_text_id,
          nextAudio = state.next_audio_id, nextOv = state.next_overlay_id;
      const newClips = comp.clips.map(c => ({ ...c, id: nextClip++ }));
      const newTexts = comp.texts.map(t => ({ ...t, id: nextText++, start_sec: t.start_sec + base, end_sec: t.end_sec + base }));
      const newAudios = comp.audio_clips.map(a => ({ ...a, id: nextAudio++, start: a.start + base }));
      const newOvs = comp.overlays.map(o => ({ ...o, id: nextOv++, start: o.start + base }));
      const clips = [...state.clips.slice(0, idx), ...newClips, ...state.clips.slice(idx + 1)];
      return touch({
        ...state,
        clips, next_clip_id: nextClip,
        texts: [...state.texts, ...newTexts], next_text_id: nextText,
        audio_clips: [...state.audio_clips, ...newAudios], next_audio_id: nextAudio,
        overlays: [...state.overlays, ...newOvs], next_overlay_id: nextOv,
        compounds: state.compounds.filter(k => k.id !== comp.id),
        selected_clip_id: null,
      });
    }

    case A.UPDATE_COMPOUND: {
      // salva o doc editado dentro do composto (sair do modo de edicao)
      const idx = state.compounds.findIndex(k => k.id === action.compoundId);
      if (idx < 0) return state;
      const compounds = state.compounds.slice();
      compounds[idx] = { ...compounds[idx], ...action.doc };
      return touch({ ...state, compounds });
    }

    case A.SET_VOLUME: {
      const track = action.track === 'audio_extra' ? 'audio_extra' : 'video';
      const value = clamp(Number(action.value) || 0, 0, 2);
      if (state.volumes[track] === value) return state;
      return touch({ ...state, volumes: { ...state.volumes, [track]: value } });
    }

    case A.SET_TRANSITION: {
      const between = action.between | 0;
      const ttype = action.ttype === 'fade' ? 'fade' : 'cut';
      const duration = clamp(Number(action.duration) || 0.3, 0.1, 2);
      const transitions = (state.transitions || []).filter(tr => tr.between !== between);
      if (ttype !== 'cut') transitions.push({ between, type: ttype, duration });
      return touch({ ...state, transitions });
    }

    case A.SET_ASPECT: {
      const strategy = action.strategy === 'letterbox' ? 'letterbox' : 'crop_center';
      if (state.aspect_strategy === strategy) return state;
      return touch({ ...state, aspect_strategy: strategy });
    }

    default:
      return state;
  }
}

function touch(state) {
  return { ...state, updated_at: new Date().toISOString() };
}
