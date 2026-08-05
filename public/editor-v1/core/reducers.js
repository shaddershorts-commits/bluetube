// editor-v1/core/reducers.js
// Reducer puro do documento. Invariantes garantidas AQUI (nao na UI):
//   - clip.source_in < clip.source_out (sempre, minimo MIN_CLIP_DURATION)
//   - clips nunca ultrapassam [0, video.duration]
//   - deletar/mover nunca corrompe next_clip_id
// Estado e imutavel: cada action retorna um objeto novo.

import { A } from './actions.js';
import { createInitialState, normalizeLoadedState, createFullClip, clamp, clamp01, MIN_CLIP_DURATION, TEXT_FONTS, TEXT_SIZES, clampLane, TEXT_DEFAULT_LANE, OVERLAY_DEFAULT_LANE, MAX_LANE, MAX_AUDIO_LANE, MAX_EXTRA_LANES } from './schema.js';
import { transicaoPorId } from './transitions.js';
import { timelineSegments, segmentAt, mainTrackItems, clipSpeed, clipTimelineDur, audioTimelineDur, overlayTimelineDur, audioLaneMap } from './selectors.js';
// REGRAS DE CAMADA (2026-07-29): faixa de texto so aceita texto, dois itens
// nao se sobrepoem na mesma camada. O reducer e o funil — validar aqui (e nao
// na UI) garante que arrasto, colar e menu de contexto obedecem a mesma regra.
import { laneDestino, repelirStart, reordenarLanes, laneKind, laneDestinoAudio, repelirStartAudio } from './lanes.js';
import { animValida } from './text-anim.js';

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

    case A.ADD_MEDIA_CLIP: {
      // take extra: entra no pool e vira clip no FIM da track principal.
      // NAO reseta nada — pedido explicito do user (2026-07-20): importar com
      // a edicao em andamento ACRESCENTA na timeline.
      // action.mediaId (sem media) = reusar item ja existente no pool.
      let media, pool = state.media || [], nextMediaId = state.next_media_id;
      if (action.mediaId != null) {
        media = pool.find(m => m.id === action.mediaId);
        if (!media) return state;
      } else {
        const m = action.media;
        if (!m?.url || !(m.duration > 0)) return state;
        media = {
          id: nextMediaId, url: m.url, path: m.path || null,
          filename: m.filename || 'mídia', duration: m.duration,
          width: m.width || 0, height: m.height || 0,
        };
        pool = [...pool, media];
        nextMediaId++;
      }
      const clip = {
        id: state.next_clip_id, media_id: media.id,
        source_in: 0, source_out: media.duration, active: true,
      };
      return touch({
        ...state,
        media: pool,
        next_media_id: nextMediaId,
        clips: [...state.clips, clip],
        next_clip_id: state.next_clip_id + 1,
        selected_clip_id: clip.id,
      });
    }

    case A.REMOVE_PRIMARY: {
      // Excluir o vídeo PRINCIPAL da biblioteca (2026-07-29). Antes ele não
      // tinha botão de excluir — quem importava o arquivo errado primeiro
      // ficava preso com ele pro resto do projeto.
      //
      // Se existir take no pool, o primeiro é PROMOVIDO a principal: os clips
      // dele passam a resolver por `state.video` (media_id null, ver
      // mediaUrlFor), então a timeline continua tocando. Sem take, o projeto
      // volta a ficar vazio — o que agora é um estado válido, porque o editor
      // abre sem mídia nenhuma.
      if (!state.video) return state;
      const pool = state.media || [];
      const promovido = pool[0] || null;
      // clips do principal (sem media_id) saem junto com ele
      let clips = state.clips.filter((c) => c.media_id != null);
      let media = pool;
      let video = null;
      if (promovido) {
        video = {
          url: promovido.url, filename: promovido.filename, duration: promovido.duration,
          width: promovido.width, height: promovido.height,
        };
        media = pool.filter((m) => m.id !== promovido.id);
        clips = clips.map((c) => (c.media_id === promovido.id ? { ...c, media_id: null } : c));
      }
      // trilha destacada do principal (kind 'video') não faz mais sentido
      const audio_clips = (state.audio_clips || []).filter((a) => a.kind !== 'video');
      const aindaSel = clips.some((c) => c.id === state.selected_clip_id);
      return touch({
        ...state,
        video, media, clips, audio_clips,
        audio_detached: false,
        video_audio_removed: false,
        selected_clip_id: aindaSel ? state.selected_clip_id : null,
      });
    }

    case A.REMOVE_MEDIA: {
      // exclui um take da biblioteca: tira do pool E remove todos os clips que
      // apontam pra ele (o video principal — sem media_id — nunca é afetado).
      const pool = (state.media || []).filter(m => m.id !== action.mediaId);
      if (pool.length === (state.media || []).length) return state;
      const clips = state.clips.filter(c => c.media_id !== action.mediaId);
      const stillSel = clips.some(c => c.id === state.selected_clip_id);
      return touch({
        ...state,
        media: pool,
        clips,
        selected_clip_id: stillSel ? state.selected_clip_id : null,
      });
    }

    case A.ADD_IMAGE_OVERLAY: {
      // imagem (PNG com transparência) vira CAMADA sobre o vídeo, no topo,
      // 3s por padrão (esticável arrastando a borda), centrada.
      const m = action.media;
      if (!m?.url) return state;
      const usadas = (state.overlays || []).filter(o => o.active !== false).map(o => o.lane || 1);
      const desejada = Math.min(MAX_LANE, (usadas.length ? Math.max(...usadas) : 0) + 1);
      // escala inicial: imagem larga cabe ~40% do quadro
      const scale = m.width && m.height ? Math.min(0.6, 0.4) : 0.4;
      const inicioImg = Math.max(0, action.atT || 0);
      // a conta acima olha SO pras camadas de vídeo — sem isto a imagem nascia
      // exatamente em cima de uma legenda (camada de texto)
      const laneImg = laneDestino(state, {
        tipo: 'overlay', id: state.next_overlay_id, laneAlvo: desejada,
        start: inicioImg, end: inicioImg + 3,
      });
      // NUNCA recusar aqui: o arquivo ja foi enviado e a interface ja avisou
      // "midia adicionada". Sem camada livre, entra na de cima e ANDA NO TEMPO
      // ate achar espaco — sumir com a imagem em silencio seria pior.
      const laneFinalImg = laneImg ?? clampLane(desejada, OVERLAY_DEFAULT_LANE);
      const startImg = laneImg != null ? inicioImg : repelirStart(state, {
        tipo: 'overlay', id: state.next_overlay_id, lane: laneFinalImg, start: inicioImg, dur: 3,
      });
      const overlay = {
        id: state.next_overlay_id, kind: 'image', url: m.url,
        img_w: m.width || 0, img_h: m.height || 0,
        source_in: 0, source_out: 3,            // 3s na timeline (esticável)
        start: startImg,
        x_pct: 0.5, y_pct: 0.5, scale,
        lane: laneFinalImg,
        active: true,
      };
      return touch({
        ...state,
        overlays: [...state.overlays, overlay],
        next_overlay_id: state.next_overlay_id + 1,
        selected_overlay_id: overlay.id,
        selected_clip_id: null, selected_text_id: null, selected_audio_id: null,
      });
    }

    case A.SET_CLIP_TRANSFORM: {
      // escala + opacidade da cena (aba Vídeo > Básico). Aplica em clip da
      // main (inclui composto). Missing = 1.0 (retrocompat).
      const idx = state.clips.findIndex(c => c.id === action.clipId);
      if (idx < 0) return state;
      const patch = {};
      if (action.patch.scale != null) patch.scale = clamp(action.patch.scale, 0.1, 3);
      if (action.patch.opacity != null) patch.opacity = clamp01(action.patch.opacity);
      // POSIÇÃO da cena no quadro (2026-07-29): mover o vídeo dentro do frame,
      // como no CapCut. Fração do quadro a partir do centro; 0 = centralizado.
      if (action.patch.pos_x != null) patch.pos_x = clamp(action.patch.pos_x, -1.5, 1.5);
      if (action.patch.pos_y != null) patch.pos_y = clamp(action.patch.pos_y, -1.5, 1.5);
      if (!Object.keys(patch).length) return state;
      const clips = state.clips.slice();
      clips[idx] = { ...clips[idx], ...patch };
      return touch({ ...state, clips });
    }

    case A.SET_CLIP_GRADE: {
      // Correção de cor da cena (aba Vídeo > Retoque). Merge parcial: a UI
      // manda só o campo mexido. null = volta tudo ao neutro (botão redefinir).
      const idx = state.clips.findIndex(c => c.id === action.clipId);
      if (idx < 0) return state;
      const clips = state.clips.slice();
      if (action.patch === null) {
        if (!clips[idx].grade) return state;
        const { grade, ...resto } = clips[idx];
        clips[idx] = resto;
        return touch({ ...state, clips });
      }
      const atual = clips[idx].grade || {};
      const novo = { ...atual };
      for (const [k, v] of Object.entries(action.patch || {})) {
        novo[k] = clamp(Number(v) || 0, -100, 100);
      }
      clips[idx] = { ...clips[idx], grade: novo };
      return touch({ ...state, clips });
    }

    case A.SET_SPEED: {
      // velocidade da faixa SELECIONADA (clip ou audio). Muda a duracao na
      // timeline (selectors dividem o span pela velocidade). clamp 0.1-100.
      const speed = clamp(action.speed, 0.1, 100);
      if (action.target === 'audio') {
        const idx = state.audio_clips.findIndex(a => a.id === action.id);
        if (idx < 0) return state;
        const audio_clips = state.audio_clips.slice();
        audio_clips[idx] = { ...audio_clips[idx], speed };
        return touch({ ...state, audio_clips });
      }
      if (action.target === 'overlay') {
        const idx = state.overlays.findIndex(o => o.id === action.id);
        if (idx < 0) return state;
        const overlays = state.overlays.slice();
        overlays[idx] = { ...overlays[idx], speed };
        return touch({ ...state, overlays });
      }
      const idx = state.clips.findIndex(c => c.id === action.id);
      if (idx < 0) return state;
      const clips = state.clips.slice();
      clips[idx] = { ...clips[idx], speed };
      return touch({ ...state, clips });
    }

    case A.PASTE: {
      // cola uma CÓPIA do item copiado (Ctrl+C/X → Ctrl+V). Nunca mexe no
      // original — o "some + restaurar" era o Ctrl+V caindo no toggle 'v'.
      const { kind, data } = action;
      const atT = Math.max(0, action.atT || 0);
      if (!data) return state;
      if (kind === 'clip') {
        if (data.compound_id) {
          // duplica o composto inteiro
          const src = (state.compounds || []).find(k => k.id === data.compound_id);
          if (!src) return state;
          const newComp = {
            ...src, id: state.next_compound_id, name: (src.name || 'Composto') + ' (cópia)',
            clips: (src.clips || []).map(x => ({ ...x })),
            texts: (src.texts || []).map(x => ({ ...x })),
            audio_clips: (src.audio_clips || []).map(x => ({ ...x })),
            overlays: (src.overlays || []).map(x => ({ ...x })),
          };
          const clip = { id: state.next_clip_id, compound_id: newComp.id, active: true };
          return touch({
            ...state, clips: [...state.clips, clip], compounds: [...state.compounds, newComp],
            next_clip_id: state.next_clip_id + 1, next_compound_id: state.next_compound_id + 1,
            selected_clip_id: clip.id,
          });
        }
        const clip = { ...data, id: state.next_clip_id, active: true };
        return touch({ ...state, clips: [...state.clips, clip], next_clip_id: state.next_clip_id + 1, selected_clip_id: clip.id, selected_audio_id: null, selected_text_id: null, selected_overlay_id: null });
      }
      if (kind === 'audio') {
        const a = { ...data, id: state.next_audio_id, start: atT, active: true };
        return touch({ ...state, audio_clips: [...state.audio_clips, a], next_audio_id: state.next_audio_id + 1, selected_audio_id: a.id, selected_clip_id: null, selected_text_id: null, selected_overlay_id: null });
      }
      if (kind === 'text') {
        const dur = Math.max(0.3, (data.end_sec - data.start_sec) || 2);
        // colar em cima do original sobreporia na mesma camada: sobe uma camada
        const laneQuer = clampLane(data.lane, TEXT_DEFAULT_LANE);
        const laneOk = laneDestino(state, {
          tipo: 'text', id: state.next_text_id, laneAlvo: laneQuer,
          start: atT, end: atT + dur, legenda: data.caption === true,
        });
        // sem camada livre: cola na mesma e anda no tempo (nunca em cima)
        const lane = laneOk ?? laneQuer;
        const inicio = laneOk != null ? atT
          : repelirStart(state, { tipo: 'text', id: state.next_text_id, lane, start: atT, dur });
        const tx = buildText({ ...data, lane, start_sec: inicio, end_sec: inicio + dur }, state.next_text_id);
        return touch({ ...state, texts: [...state.texts, tx], next_text_id: state.next_text_id + 1, selected_text_id: tx.id, selected_clip_id: null, selected_audio_id: null, selected_overlay_id: null });
      }
      if (kind === 'overlay') {
        const oBase = { ...data, id: state.next_overlay_id, start: atT, active: true };
        const durOv = overlayTimelineDur(oBase);
        const laneQuerOv = clampLane(data.lane, OVERLAY_DEFAULT_LANE);
        const laneOkOv = laneDestino(state, {
          tipo: 'overlay', id: oBase.id, laneAlvo: laneQuerOv, start: atT, end: atT + durOv,
        });
        const lane = laneOkOv ?? laneQuerOv;
        const inicioOv = laneOkOv != null ? atT
          : repelirStart(state, { tipo: 'overlay', id: oBase.id, lane, start: atT, dur: durOv });
        const o = { ...oBase, lane, start: inicioOv };
        return touch({ ...state, overlays: [...state.overlays, o], next_overlay_id: state.next_overlay_id + 1, selected_overlay_id: o.id, selected_clip_id: null });
      }
      return state;
    }

    case A.FREEZE_FRAME: {
      // Congelar (CapCut): o frame no playhead vira uma "cena imagem" de 3s
      // esticável, inserida no ponto. Divide o clip e enfia o congelado.
      const seg = segmentAt(state, action.atT);
      if (!seg) return state;
      const idx = state.clips.findIndex(c => c.id === seg.clip.id);
      if (idx < 0) return state; // sub-clip de composto
      const srcAt = seg.clip.source_in + (action.atT - seg.tStart) * clipSpeed(seg.clip);
      const fs = Math.max(0, srcAt);
      const frozen = {
        id: state.next_clip_id,
        ...(seg.clip.media_id != null ? { media_id: seg.clip.media_id } : {}),
        frozen: true, freeze_src: fs, freeze_dur: 3,
        source_in: fs, source_out: fs, // range degenerado (evita NaN em export)
        active: true,
      };
      const pieces = [];
      // esquerda (se sobra >= min)
      if (srcAt - seg.clip.source_in >= MIN_CLIP_DURATION) pieces.push({ ...seg.clip, source_out: srcAt });
      pieces.push(frozen);
      // direita (se sobra >= min)
      if (seg.clip.source_out - srcAt >= MIN_CLIP_DURATION) {
        pieces.push({ ...seg.clip, id: state.next_clip_id + 1, source_in: srcAt });
      }
      const clips = [...state.clips.slice(0, idx), ...pieces, ...state.clips.slice(idx + 1)];
      return touch({ ...state, clips, next_clip_id: state.next_clip_id + 2, selected_clip_id: frozen.id });
    }

    case A.SET_CLIP_FX: {
      // Reverso / Espelhar / Mudo (toggle). Aplica no clip da main.
      const idx = state.clips.findIndex(c => c.id === action.clipId);
      if (idx < 0) return state;
      const clips = state.clips.slice();
      clips[idx] = { ...clips[idx], ...action.patch };
      return touch({ ...state, clips });
    }

    case A.SET_CLIP_MASK: {
      // Máscara da cena (CapCut): patch faz merge (cria com defaults se não
      // existe); null remove. Clamps aqui — a UI manda valores crus.
      const idx = state.clips.findIndex(c => c.id === action.clipId);
      if (idx < 0) return state;
      const clips = state.clips.slice();
      if (action.patch === null) {
        if (!clips[idx].mask) return state;
        const { mask, ...resto } = clips[idx];
        clips[idx] = resto;
        return touch({ ...state, clips });
      }
      const cur = clips[idx].mask || { shape: 'rect', x_pct: 0.5, y_pct: 0.5, w_pct: 0.6, h_pct: 0.6, feather: 0, radius: 0 };
      const p = action.patch || {};
      const m = {
        shape: ['circle', 'rect'].includes(p.shape) ? p.shape : cur.shape,
        x_pct: clamp01(p.x_pct ?? cur.x_pct), y_pct: clamp01(p.y_pct ?? cur.y_pct),
        w_pct: clamp(p.w_pct ?? cur.w_pct, 0.05, 1), h_pct: clamp(p.h_pct ?? cur.h_pct, 0.05, 1),
        feather: clamp(p.feather ?? cur.feather, 0, 100), radius: clamp(p.radius ?? cur.radius, 0, 100),
      };
      clips[idx] = { ...clips[idx], mask: m };
      return touch({ ...state, clips });
    }

    case A.SET_FREEZE_DUR: {
      // estica/encolhe a cena congelada na timeline (0.1s a 60s)
      const idx = state.clips.findIndex(c => c.id === action.clipId);
      if (idx < 0 || !state.clips[idx].frozen) return state;
      const dur = clamp(action.dur, MIN_CLIP_DURATION, 60);
      const clips = state.clips.slice();
      clips[idx] = { ...clips[idx], freeze_dur: dur };
      return touch({ ...state, clips });
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
      // Divide o clip sob o tempo virtual t em dois. velocidade: 1s de
      // timeline = speed s do arquivo.
      const seg = segmentAt(state, action.t);
      if (!seg) return state;
      const srcSplit = seg.clip.source_in + (action.t - seg.tStart) * clipSpeed(seg.clip);
      // Nao cria fatia menor que o minimo
      if (srcSplit - seg.clip.source_in < MIN_CLIP_DURATION) return state;
      if (seg.clip.source_out - srcSplit < MIN_CLIP_DURATION) return state;
      const idx = state.clips.findIndex(c => c.id === seg.clip.id);
      if (idx < 0) return state; // sub-clip de composto: split acontece dentro dele
      // ambas as metades preservam media_id/scale/opacity/speed (spread)
      const left = { ...seg.clip, source_out: srcSplit };
      const right = { ...seg.clip, id: state.next_clip_id, source_in: srcSplit, source_out: seg.clip.source_out, active: true };
      const clips = [...state.clips.slice(0, idx), left, right, ...state.clips.slice(idx + 1)];
      return touch({ ...state, clips, next_clip_id: state.next_clip_id + 1, selected_clip_id: right.id });
    }

    case A.TRIM_CLIP: {
      // edge: 'in' | 'out'. sourceTime em tempo do arquivo.
      const idx = state.clips.findIndex(c => c.id === action.clipId);
      if (idx < 0) return state;
      const c = state.clips[idx];
      // take extra: o limite e a duracao da PROPRIA midia, nao a do principal
      const dur = c.media_id != null
        ? ((state.media || []).find(m => m.id === c.media_id)?.duration || Infinity)
        : (state.video?.duration || Infinity);
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

    case A.CLEAR_SELECTION: {
      // limpa QUALQUER seleção (clip/texto/áudio/overlay). Antes o clique no
      // vazio chamava selectClip(null), que dava no-op quando o selecionado era
      // texto/overlay (selected_clip_id já era null) — a camada não desmarcava.
      if (state.selected_clip_id == null && state.selected_text_id == null &&
          state.selected_audio_id == null && state.selected_overlay_id == null) return state;
      return { ...state, selected_clip_id: null, selected_text_id: null, selected_audio_id: null, selected_overlay_id: null };
    }

    case A.DELETE_RANGE_LEFT: {
      // ÁUDIO selecionado: Q trima a parte à ESQUERDA do playhead dentro dele
      // (fix 2026-07-21: antes só funcionava em vídeo — user pegou).
      // multi-seleção: corta TUDO que estiver selecionado (mesma correção do W)
      if (state.multi_selected?.length) return trimMultiRange(state, action.t, 'left');
      if (state.selected_audio_id != null) return trimAudioRange(state, action.t, 'left');
      // CapCut "Q" (fix 2026-07-20): age SÓ no clip SELECIONADO — trima a
      // parte à ESQUERDA do playhead DENTRO dele. O comportamento antigo
      // (varrer a timeline inteira e deletar tudo antes do playhead) apagava
      // o projeto — user pegou. Sem seleção: trima só o clip sob o playhead.
      //
      // mainTrackItems e não timelineSegments: o segundo achata composto em
      // sub-clips e o id do composto nunca aparece (ver DELETE_RANGE_RIGHT).
      const itensQ = mainTrackItems(state);
      const alvo = state.selected_clip_id != null
        ? itensQ.find(s2 => s2.clip.id === state.selected_clip_id)
        : itensQ.find(s2 => action.t >= s2.tStart && action.t < s2.tEnd);
      if (!alvo) return state;
      // playhead fora do clip alvo: nada a trimar
      if (action.t <= alvo.tStart + 1e-9 || action.t >= alvo.tEnd - 1e-9) return state;
      if (alvo.clip.compound_id != null) return trimCompound(state, alvo.clip.compound_id, action.t - alvo.tStart, 'left');
      const srcCut = alvo.clip.source_in + (action.t - alvo.tStart) * clipSpeed(alvo.clip);
      if (srcCut - alvo.clip.source_in < MIN_CLIP_DURATION) return state;
      if (alvo.clip.source_out - srcCut < MIN_CLIP_DURATION) return state;
      const clips = state.clips.map(c => c.id === alvo.clip.id ? { ...c, source_in: srcCut } : c);
      return touch({ ...state, clips });
    }

    case A.DELETE_RANGE_RIGHT: {
      // ── MULTI-SELEÇÃO: corta TUDO que estiver selecionado (2026-07-29) ────
      // Antes o W ignorava `multi_selected` e usava só `selected_clip_id` —
      // que guarda o ÚLTIMO item clicado. Resultado: selecionava várias
      // camadas, apertava W e só a última era cortada.
      if (state.multi_selected?.length) return trimMultiRange(state, action.t, 'right');
      // ÁUDIO selecionado: W trima a parte à DIREITA do playhead dentro dele
      if (state.selected_audio_id != null) return trimAudioRange(state, action.t, 'right');
      // CapCut "W": espelho do Q — trima a parte à DIREITA do playhead
      // dentro do clip selecionado (ou o sob o playhead, sem seleção).
      //
      // mainTrackItems, NÃO timelineSegments: este último ACHATA o composto em
      // sub-clips, cujos ids não são o do composto. Procurar por
      // selected_clip_id ali nunca achava nada e o W não fazia nada em cena
      // composta — era o relato do user.
      const itens = mainTrackItems(state);
      const alvo = state.selected_clip_id != null
        ? itens.find(s2 => s2.clip.id === state.selected_clip_id)
        : itens.find(s2 => action.t >= s2.tStart && action.t < s2.tEnd);
      if (!alvo) return state;
      if (action.t <= alvo.tStart + 1e-9 || action.t >= alvo.tEnd - 1e-9) return state;
      // COMPOSTO: nao tem source_in/out — o corte acontece no conteudo interno
      if (alvo.clip.compound_id != null) return trimCompound(state, alvo.clip.compound_id, action.t - alvo.tStart, 'right');
      const vel = clipSpeed(alvo.clip);
      const srcCut = alvo.clip.source_in + (action.t - alvo.tStart) * vel;
      if (alvo.clip.source_out - srcCut < MIN_CLIP_DURATION) return state;
      if (srcCut - alvo.clip.source_in < MIN_CLIP_DURATION) return state;
      const clips = state.clips.map(c => c.id === alvo.clip.id ? { ...c, source_out: srcCut } : c);
      return touch({ ...state, clips });
    }

    // ── textos ───────────────────────────────────────────────────────────

    case A.ADD_TEXT: {
      const base = buildText(action.props || {}, state.next_text_id);
      // ⚠️ o texto nascia SEMPRE na camada padrao — se ja tivesse video la, ele
      // sentava em cima (user 2026-07-29: "entrou na parte de camada de video,
      // E ERRADO"). A camada pedida agora e so a intencao; laneDestino manda.
      const durTx = Math.max(0.1, base.end_sec - base.start_sec);
      const laneTx = laneDestino(state, {
        tipo: 'text', id: base.id, laneAlvo: base.lane,
        start: base.start_sec, end: base.end_sec, legenda: base.caption === true,
      }) ?? base.lane;
      const iniTx = repelirStart(state, { tipo: 'text', id: base.id, lane: laneTx, start: base.start_sec, dur: durTx });
      const text = { ...base, lane: laneTx, start_sec: iniTx, end_sec: iniTx + durTx };
      return touch({
        ...state,
        texts: [...state.texts, text],
        next_text_id: state.next_text_id + 1,
        selected_text_id: text.id,
      });
    }

    // legendas em LOTE: troca todas as captions num unico passo (1 dispatch,
    // 1 undo) SEM roubar a selecao — gerar legenda nao pode trocar o painel
    case A.SET_CAPTIONS: {
      const texts = state.texts.filter(t => !t.caption);
      let id = state.next_text_id;
      // a legenda inteira vai pra UMA camada só — e ela nao pode ser uma camada
      // de video (mesma regra do texto avulso). Procura a partir da padrao.
      const semLegendas = { ...state, texts };
      let laneLeg = TEXT_DEFAULT_LANE;
      for (let l = TEXT_DEFAULT_LANE; l <= MAX_LANE; l++) {
        const k = laneKind(semLegendas, l);
        if (k === 'texto' || k === 'livre') { laneLeg = l; break; }
      }
      if (laneKind(semLegendas, laneLeg) === 'video') {
        for (let l = TEXT_DEFAULT_LANE - 1; l >= 1; l--) {
          const k = laneKind(semLegendas, l);
          if (k === 'texto' || k === 'livre') { laneLeg = l; break; }
        }
      }
      for (const c of (action.caps || [])) {
        texts.push(buildText({ ...c, caption: true, lane: laneLeg }, id++));
      }
      const sel = state.texts.some(t => t.id === state.selected_text_id && t.caption)
        ? null : state.selected_text_id;
      return touch({ ...state, texts, next_text_id: id, selected_text_id: sel });
    }

    case A.UPDATE_TEXT: {
      const idx = state.texts.findIndex(t => t.id === action.textId);
      if (idx < 0) return state;
      const cur = state.texts[idx];
      const patch = { ...action.patch };
      if (patch.font && !TEXT_FONTS.includes(patch.font)) delete patch.font;
      if (patch.size && !TEXT_SIZES.includes(patch.size)) delete patch.size;
      if (patch.color && !/^#[0-9a-fA-F]{6}$/.test(patch.color)) delete patch.color;
      // box: hex ativa a tarja; null (explícito) remove; inválido = ignora
      if (patch.box !== undefined && patch.box !== null && !/^#[0-9a-fA-F]{6}$/.test(patch.box)) delete patch.box;
      if (patch.stroke !== undefined && patch.stroke !== null && !/^#[0-9a-fA-F]{6}$/.test(patch.stroke)) delete patch.stroke;
      if (patch.anim !== undefined) patch.anim = animValida(patch.anim);
      if (patch.content != null) patch.content = String(patch.content).slice(0, 200);
      if (patch.x_pct != null) patch.x_pct = clamp01(patch.x_pct);
      if (patch.y_pct != null) patch.y_pct = clamp01(patch.y_pct);
      if (patch.start_sec != null) patch.start_sec = Math.max(0, patch.start_sec);
      if (patch.end_sec != null) patch.end_sec = Math.max(0, patch.end_sec);
      const next = { ...cur, ...patch };
      if (next.end_sec <= next.start_sec) next.end_sec = next.start_sec + 0.5;
      // REPELIR no arrasto horizontal do texto (legenda e isenta: sao centenas
      // de blocos gerados em lote, encostados de proposito).
      // DURANTE o arrasto (action.gestureId) NAO repele: o texto ainda pode
      // estar subindo de camada, e repelir contra a camada de origem deixava
      // ele grudado. Quem fecha a conta e o MOVE_ITEM_TO no fim do gesto.
      if (patch.start_sec != null && cur.caption !== true && !action.gestureId) {
        const dur = Math.max(0.1, next.end_sec - next.start_sec);
        const s = repelirStart(state, {
          tipo: 'text', id: cur.id, lane: cur.lane || TEXT_DEFAULT_LANE,
          start: next.start_sec, dur,
        });
        if (Math.abs(s - next.start_sec) > 1e-9) { next.start_sec = s; next.end_sec = s + dur; }
      }
      if (next.start_sec === cur.start_sec && next.end_sec === cur.end_sec &&
          Object.keys(patch).every(k => next[k] === cur[k])) return state;
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
        // start/lane opcionais: a LOCUÇÃO gravada cai exatamente onde o
        // fantasma da gravação estava (posição da agulha + faixa nova)
        start: Math.max(0, Number(m.start) || 0),
        ...(Number.isInteger(m.lane) && m.lane >= 0 ? { lane: Math.min(MAX_AUDIO_LANE, m.lane) } : {}),
        source_in: 0, source_out: m.duration,
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

    case A.SET_AUDIO_FX: {
      // Aprimorar áudio (print do CapCut): reduzir ruído / aprimorar voz (com
      // intensidade) / normalizar volume. Flags por CLIPE — aplicadas no
      // arquivo exportado (afftdn / eq+compressor / dynaudnorm no Railway).
      const idx = state.audio_clips.findIndex(a => a.id === action.audioId);
      if (idx < 0) return state;
      const a = state.audio_clips[idx];
      const p = action.patch || {};
      const next = { ...a };
      if (p.fx_ruido != null) next.fx_ruido = !!p.fx_ruido;
      if (p.fx_voz != null) next.fx_voz = !!p.fx_voz;
      if (p.fx_norm != null) next.fx_norm = !!p.fx_norm;
      if (p.fx_voz_int != null) next.fx_voz_int = clamp(Math.round(Number(p.fx_voz_int) || 0), 0, 100);
      if (next.fx_ruido === a.fx_ruido && next.fx_voz === a.fx_voz &&
          next.fx_norm === a.fx_norm && next.fx_voz_int === a.fx_voz_int) return state;
      const audio_clips = state.audio_clips.slice();
      audio_clips[idx] = next;
      return touch({ ...state, audio_clips });
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
      // corta o clip de audio sob o tempo virtual t (selecionado tem prioridade).
      // velocidade: a janela na timeline = span/speed; splitSrc mapeia por speed.
      const t = action.t;
      const hitClip = (a) => a.active !== false &&
        t > a.start + MIN_CLIP_DURATION &&
        t < a.start + audioTimelineDur(a) - MIN_CLIP_DURATION;
      let target = state.audio_clips.find(a => a.id === state.selected_audio_id && hitClip(a));
      if (!target) target = state.audio_clips.find(hitClip);
      if (!target) return state;
      const splitSrc = target.source_in + (t - target.start) * clipSpeed(target);
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
      const aud = state.audio_clips[idx];
      // REPELIR tambem no audio (user 2026-07-29: "a camada de audio nao ta se
      // repelindo, ta ficando por cima"). A faixa e a RESOLVIDA — audio sem
      // faixa manual e empacotado automaticamente pelo selector.
      const lane = audioLaneMap(state).get(aud.id) ?? 0;
      const start = repelirStartAudio(state, {
        id: aud.id, lane,
        start: Math.max(0, Number(action.start) || 0), dur: audioTimelineDur(aud),
      });
      if (aud.start === start) return state;
      const audio_clips = state.audio_clips.slice();
      audio_clips[idx] = { ...aud, start };
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
      const inicio = Math.max(0, action.atT || 0);
      const duracao = Math.max(0, clip.source_out - clip.source_in);
      // a camada pedida pelo drop e a intencao; as regras decidem a final
      const laneFinal = laneDestino(state, {
        tipo: 'overlay', id: state.next_overlay_id,
        laneAlvo: clampLane(action.lane, OVERLAY_DEFAULT_LANE),
        start: inicio, end: inicio + duracao,
      });
      if (laneFinal == null) return state;  // nenhuma camada livre: nao converte
      const overlay = {
        id: state.next_overlay_id,
        source_in: clip.source_in, source_out: clip.source_out,
        ...(clip.media_id != null ? { media_id: clip.media_id } : {}),
        start: inicio,
        x_pct: 0.5, y_pct: 0.5, scale: 1,
        lane: laneFinal,
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

    case A.SPLIT_OVERLAY: {
      // corta a CAMADA sob o tempo virtual t (espelho do SPLIT_AUDIO)
      const t = action.t;
      const hitOv = (o) => o.active !== false &&
        t > o.start + MIN_CLIP_DURATION &&
        t < o.start + (o.source_out - o.source_in) - MIN_CLIP_DURATION;
      let target = state.overlays.find(o => o.id === state.selected_overlay_id && hitOv(o));
      if (!target) target = state.overlays.find(hitOv);
      if (!target) return state;
      const splitSrc = target.source_in + (t - target.start);
      const left = { ...target, source_out: splitSrc };
      const right = { ...target, id: state.next_overlay_id, start: t, source_in: splitSrc };
      const overlays = state.overlays.flatMap(o => o.id === target.id ? [left, right] : [o]);
      return touch({ ...state, overlays, next_overlay_id: state.next_overlay_id + 1, selected_overlay_id: right.id });
    }

    case A.TRIM_OVERLAY: {
      const idx = state.overlays.findIndex(o => o.id === action.overlayId);
      if (idx < 0) return state;
      const o = state.overlays[idx];
      let { start, source_in, source_out } = o;
      if (action.edge === 'in') {
        // imagem: a borda esquerda só encurta a duração (source_in fica em 0)
        if (o.kind === 'image') {
          start = Math.max(0, Math.min(action.value, o.start + (o.source_out - o.source_in) - MIN_CLIP_DURATION));
          source_out = o.source_out - (start - o.start);
        } else {
          const delta = clamp(action.value - o.start,
            -o.source_in, (o.source_out - o.source_in) - MIN_CLIP_DURATION);
          start = Math.max(0, o.start + delta);
          source_in = o.source_in + delta;
        }
      } else {
        // imagem: duração livre até 60s (não tem "arquivo" limitando)
        const maxOut = o.kind === 'image' ? 60
          : o.media_id != null
            ? ((state.media || []).find(m => m.id === o.media_id)?.duration || Infinity)
            : (state.video?.duration || Infinity);
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
      const ov0 = state.overlays[idx];
      // REPELIR: dentro da camada os itens nao se sobrepoem — o arrasto encosta
      // no vizinho em vez de entrar por cima dele.
      const start = repelirStart(state, {
        tipo: 'overlay', id: ov0.id, lane: ov0.lane || OVERLAY_DEFAULT_LANE,
        start: Math.max(0, Number(action.start) || 0), dur: overlayTimelineDur(ov0),
      });
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
      const rot = p.rotation != null ? (((p.rotation % 360) + 360) % 360) : (o.rotation || 0);
      const next = {
        ...o,
        x_pct: p.x_pct != null ? clamp01(p.x_pct) : o.x_pct,
        y_pct: p.y_pct != null ? clamp01(p.y_pct) : o.y_pct,
        scale: p.scale != null ? clamp(p.scale, 0.1, 2) : o.scale,
        rotation: rot,
      };
      if (next.x_pct === o.x_pct && next.y_pct === o.y_pct && next.scale === o.scale && next.rotation === (o.rotation || 0)) return state;
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
      // A camada pedida e so a INTENCAO: laneDestino aplica as regras (faixa de
      // texto nao recebe video; sobrepor sobe pra camada de cima) e devolve a
      // camada final — ou null quando nao ha nenhuma possivel (movimento negado).
      const alvo = clampLane(action.lane, null);
      if (alvo == null) return state;
      if (action.itemType === 'overlay') {
        const idx = state.overlays.findIndex(o => o.id === action.id);
        if (idx < 0) return state;
        const ov = state.overlays[idx];
        const start = ov.start || 0;
        const lane = laneDestino(state, {
          tipo: 'overlay', id: ov.id, laneAlvo: alvo,
          start, end: start + overlayTimelineDur(ov),
        });
        if (lane == null || ov.lane === lane) return state;
        const overlays = state.overlays.slice();
        overlays[idx] = { ...overlays[idx], lane };
        return touch({ ...state, overlays });
      }
      if (action.itemType === 'text') {
        const idx = state.texts.findIndex(t => t.id === action.id);
        if (idx < 0) return state;
        const tx = state.texts[idx];
        const lane = laneDestino(state, {
          tipo: 'text', id: tx.id, laneAlvo: alvo,
          start: tx.start_sec, end: tx.end_sec, legenda: tx.caption === true,
        });
        if (lane == null || tx.lane === lane) return state;
        const texts = state.texts.slice();
        texts[idx] = { ...texts[idx], lane };
        return touch({ ...state, texts });
      }
      return state;
    }

    case A.MOVE_ITEM_TO: {
      // FIM do arrasto de uma camada/texto: tempo e camada decididos JUNTOS.
      // Antes eram dois dispatches (mover, depois trocar de camada) e o repelir
      // rodava contra a camada de ORIGEM — arrastar na diagonal pra uma camada
      // vazia jogava o item pro fim do vizinho da camada velha.
      const tipo = action.itemType;
      // ── AUDIO: espaco de faixas proprio, camada nova nasce ABAIXO ──
      if (tipo === 'audio') {
        const iA = state.audio_clips.findIndex(a => a.id === action.id);
        if (iA < 0) return state;
        const aud = state.audio_clips[iA];
        const durA = audioTimelineDur(aud);
        const laneAtualA = audioLaneMap(state).get(aud.id) ?? 0;
        const desejadoA = Math.max(0, Number(action.start) || 0);
        const alvoA = Number.isInteger(action.laneAlvo) ? action.laneAlvo : laneAtualA;
        const laneFinalA = alvoA === laneAtualA ? laneAtualA : (laneDestinoAudio(state, {
          id: aud.id, laneAlvo: alvoA, start: desejadoA, end: desejadoA + durA,
        }) ?? laneAtualA);
        const inicioA = repelirStartAudio(state, { id: aud.id, lane: laneFinalA, start: desejadoA, dur: durA });
        if (aud.start === inicioA && laneAtualA === laneFinalA && Number.isInteger(aud.lane)) return state;
        const audio_clips = state.audio_clips.slice();
        // grava a faixa EXPLICITA: sem isso o empacotamento automatico poderia
        // devolver o clipe pra outra linha no proximo calculo
        audio_clips[iA] = { ...aud, start: inicioA, lane: laneFinalA };
        return touch({ ...state, audio_clips });
      }
      const idx = tipo === 'overlay'
        ? state.overlays.findIndex(o => o.id === action.id)
        : state.texts.findIndex(t => t.id === action.id);
      if (idx < 0) return state;
      const item = tipo === 'overlay' ? state.overlays[idx] : state.texts[idx];
      const dur = tipo === 'overlay'
        ? overlayTimelineDur(item)
        : Math.max(0.1, item.end_sec - item.start_sec);
      const laneAtual = tipo === 'overlay'
        ? (item.lane || OVERLAY_DEFAULT_LANE) : (item.lane || TEXT_DEFAULT_LANE);
      const desejado = Math.max(0, Number(action.start) || 0);
      const legenda = tipo === 'text' && item.caption === true;
      // 1) camada final. As duas metades da regra do usuario sao coisas
      //    DIFERENTES e dependem da intencao do gesto:
      //    - solto na MESMA camada (arrasto horizontal) -> os itens SE REPELEM,
      //      o item fica na camada dele e escorrega pro espaco livre;
      //    - solto em OUTRA camada ja ocupada -> "tentar sobrepor cria camada
      //      nova acima", entao sobe.
      //    Sem essa distincao, arrastar de lado por cima do vizinho fazia o
      //    item PULAR DE CAMADA sozinho.
      const alvo = Number.isInteger(action.laneAlvo) ? action.laneAlvo : laneAtual;
      const laneFinal = alvo === laneAtual ? laneAtual : (laneDestino(state, {
        tipo, id: item.id, laneAlvo: alvo, start: desejado, end: desejado + dur, legenda,
      }) ?? laneAtual);
      // 2) so ENTAO repele, ja dentro da camada de destino
      const inicio = repelirStart(state, { tipo, id: item.id, lane: laneFinal, start: desejado, dur });
      if (tipo === 'overlay') {
        if (item.start === inicio && (item.lane || OVERLAY_DEFAULT_LANE) === laneFinal) return state;
        const overlays = state.overlays.slice();
        overlays[idx] = { ...item, start: inicio, lane: laneFinal };
        return touch({ ...state, overlays });
      }
      if (item.start_sec === inicio && (item.lane || TEXT_DEFAULT_LANE) === laneFinal) return state;
      const texts = state.texts.slice();
      texts[idx] = { ...item, start_sec: inicio, end_sec: inicio + dur, lane: laneFinal };
      return touch({ ...state, texts });
    }

    case A.REORDER_LANES: {
      // arrastar o cabecalho/olhinho de uma camada pra posicao de outra.
      // reordenarLanes devolve o MESMO state quando nada muda (sem undo fantasma).
      const next = reordenarLanes(state, { kind: action.kind, de: action.de, para: action.para });
      return next === state ? state : touch(next);
    }

    case A.SET_AUDIO_LANE: {
      // arrasto VERTICAL de faixa de áudio: fixa a lane manualmente (0..7).
      // Soltar abaixo da última row cria uma lane nova embaixo (CapCut).
      const lane = Number.isInteger(action.lane) ? Math.max(0, Math.min(MAX_AUDIO_LANE, action.lane)) : null;
      if (lane == null) return state;
      const idx = state.audio_clips.findIndex(a => a.id === action.audioId);
      if (idx < 0 || state.audio_clips[idx].lane === lane) return state;
      const audio_clips = state.audio_clips.slice();
      audio_clips[idx] = { ...audio_clips[idx], lane };
      return touch({ ...state, audio_clips });
    }

    case A.ADD_EXTRA_LANE: {
      // botão direito no VAZIO: "Criar camada de vídeo/áudio" — row vazia
      // visível pra arrastar faixas pra dentro (fluidez CapCut). Máx 4 extras.
      if (action.kind === 'video') {
        const n = Math.min(MAX_EXTRA_LANES, (state.extra_overlay_lanes || 0) + 1);
        if (n === state.extra_overlay_lanes) return state;
        return touch({ ...state, extra_overlay_lanes: n });
      }
      if (action.kind === 'audio') {
        const n = Math.min(MAX_EXTRA_LANES, (state.extra_audio_lanes || 0) + 1);
        if (n === state.extra_audio_lanes) return state;
        return touch({ ...state, extra_audio_lanes: n });
      }
      return state;
    }

    case A.TOGGLE_LANE_VIS: {
      // olhinho da camada: esconde do preview/export (áudio = mudo). A row
      // continua na timeline (esmaecida) — igual CapCut.
      const lane = action.lane;
      if (!Number.isInteger(lane)) return state;
      const key = action.kind === 'audio' ? 'hidden_audio_lanes' : 'hidden_overlay_lanes';
      const cur = state[key] || [];
      const next = cur.includes(lane) ? cur.filter(l => l !== lane) : [...cur, lane];
      return touch({ ...state, [key]: next });
    }

    case A.OVERLAY_TO_CLIP: {
      // arrastar a camada de vídeo DE VOLTA pra faixa principal (inverso do
      // CONVERT_TO_OVERLAY — user 2026-07-22: "não volta mais"). Insere na
      // ordem da timeline pela posição do drop; imagem não vira clip.
      const ov = state.overlays.find(o => o.id === action.overlayId);
      if (!ov || ov.kind === 'image') return state;
      const clip = {
        id: state.next_clip_id,
        ...(ov.media_id != null ? { media_id: ov.media_id } : {}),
        source_in: ov.source_in, source_out: ov.source_out,
        ...(ov.speed > 0 && ov.speed !== 1 ? { speed: ov.speed } : {}),
        active: true,
      };
      const atT = Math.max(0, action.atT || ov.start || 0);
      // índice de inserção em state.clips: antes do primeiro item cujo MEIO
      // fica depois do drop (mesma régua do drag horizontal de clips)
      const items = mainTrackItems(state);
      let insertIdx = state.clips.length;
      for (const it of items) {
        if (atT < (it.tStart + it.tEnd) / 2) {
          insertIdx = state.clips.findIndex(c => c.id === it.clip.id);
          break;
        }
      }
      if (insertIdx < 0) insertIdx = state.clips.length;
      const clips = [...state.clips.slice(0, insertIdx), clip, ...state.clips.slice(insertIdx)];
      return touch({
        ...state,
        clips,
        next_clip_id: state.next_clip_id + 1,
        overlays: state.overlays.filter(o => o.id !== action.overlayId),
        selected_clip_id: clip.id,
        selected_overlay_id: null, selected_text_id: null, selected_audio_id: null,
      });
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

    case A.MOVE_MULTI: {
      // arrasta TODA a multi-selecao junto (audio/texto/camada — clips da main
      // sao empacotados, nao movem livre). Clampa pra ninguem passar do 0.
      const sel = state.multi_selected || [];
      if (!sel.length) return state;
      const has = (tipo, id) => sel.some(x => x.type === tipo && x.id === id);
      let minStart = Infinity;
      for (const a of state.audio_clips) if (has('audio', a.id)) minStart = Math.min(minStart, a.start);
      for (const t of state.texts) if (has('text', t.id)) minStart = Math.min(minStart, t.start_sec);
      for (const o of state.overlays) if (has('overlay', o.id)) minStart = Math.min(minStart, o.start);
      let delta = action.delta;
      if (minStart !== Infinity && minStart + delta < 0) delta = -minStart;
      if (!(Math.abs(delta) > 1e-6)) return state;
      return touch({
        ...state,
        audio_clips: state.audio_clips.map(a => has('audio', a.id) ? { ...a, start: Math.max(0, a.start + delta) } : a),
        texts: state.texts.map(t => has('text', t.id) ? { ...t, start_sec: Math.max(0, t.start_sec + delta), end_sec: Math.max(0.1, t.end_sec + delta) } : t),
        overlays: state.overlays.map(o => has('overlay', o.id) ? { ...o, start: Math.max(0, o.start + delta) } : o),
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
      const textIds = sel.filter(x => x.type === 'text').map(x => x.id);
      const audioIds = sel.filter(x => x.type === 'audio').map(x => x.id);
      const ovIds = sel.filter(x => x.type === 'overlay').map(x => x.id);
      // composto aceita QUALQUER combinacao (so audio, so texto, tudo junto) —
      // precisa apenas de >=1 item real. Maximo de 4 compostos (regra do user).
      const temAlgo = inClips.length || state.texts.some(t => textIds.includes(t.id)) ||
        state.audio_clips.some(a => audioIds.includes(a.id)) ||
        state.overlays.some(o => ovIds.includes(o.id));
      if (!temAlgo) return state;
      // FIX #6: se a seleção já inclui um COMPOSTO existente (ex.: criou o
      // composto do vídeo, gerou legendas e re-selecionou tudo pra agrupar),
      // AGREGA os itens soltos (legendas/áudio/overlay) DENTRO dele — antes o
      // vídeo (já composto, filtrado por !c.compound_id) ficava de fora e as
      // legendas viravam um composto separado no fim, descolando do vídeo.
      // Não cria composto novo, então roda ANTES do limite de 4.
      const compClipSel = state.clips.find(c => clipIds.includes(c.id) && c.compound_id != null);
      const temSolto = state.texts.some(t => textIds.includes(t.id)) ||
        state.audio_clips.some(a => audioIds.includes(a.id)) ||
        state.overlays.some(o => ovIds.includes(o.id));
      if (compClipSel && temSolto) {
        const alvo = (state.compounds || []).find(k => k.id === compClipSel.compound_id);
        if (alvo) {
          const it0 = mainTrackItems(state).find(x => x.clip.id === compClipSel.id);
          const base0 = it0 ? it0.tStart : 0;
          const merged = {
            ...alvo,
            texts: [...(alvo.texts || []), ...state.texts.filter(t => textIds.includes(t.id))
              .map(t => ({ ...t, start_sec: Math.max(0, t.start_sec - base0), end_sec: Math.max(0.1, t.end_sec - base0) }))],
            audio_clips: [...(alvo.audio_clips || []), ...state.audio_clips.filter(a => audioIds.includes(a.id))
              .map(a => ({ ...a, start: Math.max(0, a.start - base0) }))],
            overlays: [...(alvo.overlays || []), ...state.overlays.filter(o => ovIds.includes(o.id))
              .map(o => ({ ...o, start: Math.max(0, o.start - base0) }))],
          };
          return touch({
            ...state,
            compounds: state.compounds.map(k => k.id === alvo.id ? merged : k),
            texts: state.texts.filter(t => !textIds.includes(t.id)),
            audio_clips: state.audio_clips.filter(a => !audioIds.includes(a.id)),
            overlays: state.overlays.filter(o => !ovIds.includes(o.id)),
            multi_selected: [],
            selected_clip_id: compClipSel.id,
            selected_text_id: null, selected_audio_id: null, selected_overlay_id: null,
          });
        }
      }
      if ((state.compounds || []).length >= 4) return state; // shell mostra o aviso
      const items = mainTrackItems(state);
      const firstIt = items.find(it => clipIds.includes(it.clip.id));
      // sem clip de video, a base e o inicio do item selecionado mais cedo —
      // o conteudo interno fica relativo a ele
      const base = firstIt ? firstIt.tStart : Math.min(...[
        ...state.texts.filter(t => textIds.includes(t.id)).map(t => t.start_sec),
        ...state.audio_clips.filter(a => audioIds.includes(a.id)).map(a => a.start),
        ...state.overlays.filter(o => ovIds.includes(o.id)).map(o => o.start),
      ]);
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
      let clips;
      if (inClips.length) {
        const firstIdx = state.clips.findIndex(c => c.id === inClips[0].id);
        clips = state.clips
          .map((c, i) => i === firstIdx ? compClip : c)
          .filter(c => c === compClip || !clipIds.includes(c.id));
      } else {
        // composto sem video vira um bloco no FIM da track principal
        clips = [...state.clips, compClip];
      }
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
      // Transição na junção `between` (índice do clip da ESQUERDA).
      // 2026-07-29: aceitava só 'fade'|'cut'. Agora aceita qualquer id do
      // catálogo — e SÓ do catálogo, porque cada um precisa ter um xfade real
      // do ffmpeg pro export sair igual ao preview.
      const between = action.between | 0;
      const transitions = (state.transitions || []).filter(tr => tr.between !== between);
      const id = action.ttype;
      if (!id || id === 'cut' || id === 'none') return touch({ ...state, transitions });
      const def = transicaoPorId(id) || (id === 'fade' ? transicaoPorId('dissolver') : null);
      if (!def) return state;                      // id desconhecido: ignora
      const duration = clamp(Number(action.duration) || 0.5, 0.1, 3);
      const intensidade = action.intensity != null ? clamp(Number(action.intensity), 0, 100) : 50;
      transitions.push({ between, type: def.id, xfade: def.xfade, duration, intensity: intensidade });
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

/** Q/W numa FAIXA DE ÁUDIO selecionada: trima a parte à esquerda ('left') ou à
 *  direita ('right') do playhead DENTRO do próprio áudio (espelha o Q/W do
 *  vídeo). Respeita a velocidade do áudio no mapeamento timeline↔arquivo. */
// ── Q/W COM VÁRIAS FAIXAS SELECIONADAS (2026-07-29) ─────────────────────────
// O user selecionou todas as camadas, apertou W esperando cortar todas a
// partir da agulha, e só a última foi. O motivo: Q/W liam apenas
// `selected_clip_id`, que guarda o ÚLTIMO item clicado — a lista
// `multi_selected` era ignorada.
//
// Aqui cada item selecionado é cortado no MESMO instante t, cada um na sua
// própria régua de tempo. Quem não é atravessado pela agulha fica intacto (não
// faz sentido "cortar" quem nem passa por ali), e uma ação só = um undo.
// Cortar um COMPOSTO não é como cortar um clip: ele não tem source_in/out
// próprios — a duração dele vem do conteúdo interno (ver compoundDuration).
// Então "cortar do playhead pra frente" significa cortar TUDO que está dentro,
// no tempo relativo ao início do bloco.
function trimCompound(state, compoundId, tRel, side) {
  const comps = state.compounds || [];
  const idx = comps.findIndex(k => k.id === compoundId);
  if (idx < 0) return state;
  const c = comps[idx];
  const dir = side === 'left' ? 'left' : 'right';

  // clips internos são sequenciais dentro do bloco
  let acc = 0;
  const clips = [];
  for (const k of (c.clips || [])) {
    const dur = clipTimelineDur(k);
    const ini = acc, fim = acc + dur;
    acc = fim;
    if (dir === 'right') {
      if (ini >= tRel - 1e-9) continue;                    // começa depois do corte: sai
      if (fim > tRel) {
        const corte = k.source_in + (tRel - ini) * clipSpeed(k);
        if (corte - k.source_in >= MIN_CLIP_DURATION) { clips.push({ ...k, source_out: corte }); continue; }
        continue;
      }
      clips.push(k);
    } else {
      if (fim <= tRel + 1e-9) continue;                    // termina antes do corte: sai
      if (ini < tRel) {
        const corte = k.source_in + (tRel - ini) * clipSpeed(k);
        if (k.source_out - corte >= MIN_CLIP_DURATION) { clips.push({ ...k, source_in: corte }); continue; }
        continue;
      }
      clips.push(k);
    }
  }

  const cortaFaixa = (lista, campoIni, durDe) => (lista || []).flatMap((x) => {
    const ini = x[campoIni] ?? 0, fim = ini + durDe(x);
    if (dir === 'right') {
      if (ini >= tRel - 1e-9) return [];
      if (fim > tRel) return [{ ...x, source_out: (x.source_in ?? 0) + (tRel - ini) }];
      return [x];
    }
    if (fim <= tRel + 1e-9) return [];
    if (ini < tRel) return [{ ...x, source_in: (x.source_in ?? 0) + (tRel - ini), [campoIni]: 0 }];
    return [{ ...x, [campoIni]: ini - tRel }];
  });

  const novo = {
    ...c,
    clips,
    audio_clips: cortaFaixa(c.audio_clips, 'start', audioTimelineDur),
    overlays: cortaFaixa(c.overlays, 'start', (o) => o.source_out - o.source_in),
    texts: (c.texts || []).flatMap((x) => {
      if (dir === 'right') {
        if (x.start_sec >= tRel - 1e-9) return [];
        return [{ ...x, end_sec: Math.min(x.end_sec, tRel) }];
      }
      if (x.end_sec <= tRel + 1e-9) return [];
      return [{ ...x, start_sec: Math.max(0, x.start_sec - tRel), end_sec: x.end_sec - tRel }];
    }),
  };
  if (JSON.stringify(novo) === JSON.stringify(c)) return state;
  const compounds = comps.slice();
  compounds[idx] = novo;
  return touch({ ...state, compounds });
}

function trimMultiRange(state, t, side) {
  const sel = state.multi_selected || [];
  if (!sel.length) return state;
  const dir = side === 'left' ? 'left' : 'right';
  const itens = mainTrackItems(state);

  const clips = state.clips.slice();
  let mexeu = false;

  // vídeo (inclui composto: mainTrackItems trata como unidade)
  for (const s of sel.filter(x => x.type === 'clip')) {
    const it = itens.find(i => i.clip.id === s.id);
    if (!it || t <= it.tStart + 1e-9 || t >= it.tEnd - 1e-9) continue;
    if (it.clip.compound_id != null) { const r = trimCompound(state, it.clip.compound_id, t - it.tStart, dir); if (r !== state) { state = r; mexeu = true; } continue; }
    const corte = it.clip.source_in + (t - it.tStart) * clipSpeed(it.clip);
    if (corte - it.clip.source_in < MIN_CLIP_DURATION) continue;
    if (it.clip.source_out - corte < MIN_CLIP_DURATION) continue;
    const idx = clips.findIndex(c => c.id === it.clip.id);
    if (idx < 0) continue;
    clips[idx] = dir === 'left' ? { ...clips[idx], source_in: corte } : { ...clips[idx], source_out: corte };
    mexeu = true;
  }

  // áudio: régua própria (start na timeline + velocidade)
  const audio_clips = (state.audio_clips || []).map((a) => {
    if (!sel.some(x => x.type === 'audio' && x.id === a.id)) return a;
    const sp = a.speed && a.speed > 0 ? a.speed : 1;
    const dur = (a.source_out - a.source_in) / sp;
    if (t <= a.start + 1e-9 || t >= a.start + dur - 1e-9) return a;
    const corte = a.source_in + (t - a.start) * sp;
    if (corte - a.source_in < MIN_CLIP_DURATION) return a;
    if (a.source_out - corte < MIN_CLIP_DURATION) return a;
    mexeu = true;
    return dir === 'left'
      ? { ...a, source_in: corte, start: t }
      : { ...a, source_out: corte };
  });

  // camadas de vídeo/imagem
  const overlays = (state.overlays || []).map((o) => {
    if (!sel.some(x => x.type === 'overlay' && x.id === o.id)) return o;
    const dur = o.source_out - o.source_in;
    if (t <= o.start + 1e-9 || t >= o.start + dur - 1e-9) return o;
    const corte = o.source_in + (t - o.start);
    if (corte - o.source_in < MIN_CLIP_DURATION) return o;
    if (o.source_out - corte < MIN_CLIP_DURATION) return o;
    mexeu = true;
    return dir === 'left' ? { ...o, source_in: corte, start: t } : { ...o, source_out: corte };
  });

  // textos/legendas: só começo e fim
  const texts = (state.texts || []).map((tx) => {
    if (!sel.some(x => x.type === 'text' && x.id === tx.id)) return tx;
    if (t <= tx.start_sec + 1e-9 || t >= tx.end_sec - 1e-9) return tx;
    mexeu = true;
    return dir === 'left' ? { ...tx, start_sec: t } : { ...tx, end_sec: t };
  });

  if (!mexeu) return state;
  return touch({ ...state, clips, audio_clips, overlays, texts });
}

function trimAudioRange(state, t, side) {
  const a = (state.audio_clips || []).find(x => x.id === state.selected_audio_id);
  if (!a) return state;
  const sp = a.speed && a.speed > 0 ? a.speed : 1;
  const tStart = a.start;
  const tEnd = a.start + (a.source_out - a.source_in) / sp;
  if (t <= tStart + 1e-9 || t >= tEnd - 1e-9) return state; // playhead fora: nada
  const srcCut = a.source_in + (t - tStart) * sp;
  if (srcCut - a.source_in < MIN_CLIP_DURATION) return state;
  if (a.source_out - srcCut < MIN_CLIP_DURATION) return state;
  const audio_clips = state.audio_clips.map(x => {
    if (x.id !== a.id) return x;
    return side === 'left'
      ? { ...x, source_in: srcCut, start: t } // corta o começo, encosta no playhead
      : { ...x, source_out: srcCut };         // corta o fim
  });
  return touch({ ...state, audio_clips });
}

/** Texto validado/normalizado — unica fonte (ADD_TEXT e SET_CAPTIONS). */
function buildText(p, id) {
  const text = {
    id,
    content: String(p.content || 'Texto').slice(0, 200),
    font: TEXT_FONTS.includes(p.font) ? p.font : 'Anton',
    size: TEXT_SIZES.includes(p.size) ? p.size : 'medium',
    color: /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : '#ffffff',
    box: /^#[0-9a-fA-F]{6}$/.test(p.box || '') ? p.box : null,
    stroke: /^#[0-9a-fA-F]{6}$/.test(p.stroke || '') ? p.stroke : null,
    x_pct: clamp01(p.x_pct ?? 0.5),
    y_pct: clamp01(p.y_pct ?? 0.35),
    start_sec: Math.max(0, p.start_sec ?? 0),
    end_sec: Math.max(0, p.end_sec ?? 3),
    caption: p.caption === true,
    anim: animValida(p.anim),        // entrada/saida (preview E render)
    lane: clampLane(p.lane, TEXT_DEFAULT_LANE),
    active: true,
  };
  if (text.end_sec <= text.start_sec) text.end_sec = text.start_sec + 1;
  return text;
}
