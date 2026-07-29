// editor-v1/timeline/layout.js
// Geometria da timeline: converte (state, viewport) -> retangulos em px.
// Modulo puro: sem DOM/canvas. Toda posicao visual nasce aqui — render e
// hittest consomem o MESMO layout (nunca calculam por conta propria).

import { timelineSegments, totalDuration, mainTrackItems, audioTimelineDur, overlayTimelineDur, audioLaneMap, playableDuration } from '../core/selectors.js';
import { MAX_LANE } from '../core/schema.js';

export const METRICS = {
  PAD_LEFT: 16,          // margem esquerda em px antes de t=0
  RULER_H: 26,
  TRACK_GAP: 8,
  VIDEO_TRACK_H: 56,
  AUDIO_TRACK_H: 34,
  TEXT_TRACK_H: 26,
  HANDLE_W: 12,          // largura visual do trim handle
  HANDLE_HIT_W: 16,      // area de hit (mouse). touch usa TOUCH_EXTRA
  TOUCH_EXTRA: 12,       // px extras de hit pra touch
  MIN_PX_PER_SEC: 4,
  MAX_PX_PER_SEC: 400,
};

/** @typedef {{ pxPerSec:number, scrollX:number, width:number, height:number }} Viewport */

export function timeToX(vp, t) {
  return METRICS.PAD_LEFT + t * vp.pxPerSec - vp.scrollX;
}

export function xToTime(vp, x) {
  return (x - METRICS.PAD_LEFT + vp.scrollX) / vp.pxPerSec;
}

/** Layout completo de um frame.
 *  `hint` (opcional) desenha camadas que ainda NAO existem no estado — e como
 *  a faixa nova aparece NA HORA em que o usuario arrasta uma cena pra cima
 *  (user 2026-07-29: "arrastar take cria camada nova na hora"), antes do drop.
 *  { laneExtra:1..5 } = row de video/texto fantasma
 *  { laneAudioExtra:>=0 } = row de audio fantasma */
export function computeLayout(state, vp, hint = null) {
  const segs = timelineSegments(state);
  const total = totalDuration(state);

  const yRuler = 0;
  const multiKeys = new Set((state.multi_selected || []).map(m => m.type + ':' + m.id));

  // ── CAMADAS (CapCut): rows empilhadas ACIMA da principal ──
  // Cada lane em uso vira uma row; lane MAIOR fica mais ACIMA na timeline e
  // renderiza NA FRENTE no video. Textos e overlays compartilham as lanes
  // (a regra do user: texto abaixo de uma camada de video fica ATRAS dela).
  const ovsAtivas = (state.overlays || []).filter(o => o.active !== false);
  const textosAtivos = (state.texts || []).filter(t => t.active !== false);
  const usadasSet = new Set([
    ...ovsAtivas.map(o => o.lane || 1),
    ...textosAtivos.map(t => t.lane || 4),
  ]);
  // camadas EXTRAS vazias (menu "Criar camada de vídeo"): rows acima do topo
  // em uso, prontas pra receber um arrasto (fluidez CapCut). Cap na lane 5.
  const maxUsada = usadasSet.size ? Math.max(...usadasSet) : 0;
  for (let i = 0; i < (state.extra_overlay_lanes || 0); i++) {
    const l = maxUsada + 1 + i;
    if (l <= MAX_LANE) usadasSet.add(l);
  }
  // camada FANTASMA do arrasto em curso (nasce na hora, some se o gesto voltar)
  const laneFantasma = hint && Number.isInteger(hint.laneExtra) ? hint.laneExtra : null;
  if (laneFantasma != null && laneFantasma >= 1 && laneFantasma <= MAX_LANE) usadasSet.add(laneFantasma);
  const lanesUsadas = [...usadasSet].sort((a, b) => b - a); // desc: topo primeiro
  const hidOv = state.hidden_overlay_lanes || [];

  // ── ALTURA DAS FAIXAS (user 2026-07-22): as camadas NÃO esticam mais.
  // Agora que a timeline é redimensionável de verdade, expandir = MAIS ESPAÇO
  // visível pra camadas (CapCut), com cada faixa na altura natural. O auto-
  // altura antigo (trackScale até 2.4) era pra época da timeline fixa de 190px
  // — esticava tudo junto e o user rejeitou ("as camadas não é pra esticar").
  const baseLaneH = METRICS.VIDEO_TRACK_H * 0.7;
  const trackScale = 1; // fixo: faixas na altura natural
  const VH = Math.round(METRICS.VIDEO_TRACK_H * trackScale);
  const AH = Math.round(METRICS.AUDIO_TRACK_H * trackScale);
  const TH = Math.round(METRICS.TEXT_TRACK_H * trackScale);
  const GAP = Math.round(METRICS.TRACK_GAP * trackScale);
  const LANE_H = Math.round(baseLaneH * trackScale);

  const laneRows = []; // [{lane, y, h, hidden}] na ordem visual (topo -> base)
  // ROLAGEM VERTICAL (2026-07-29): com ate 18 camadas + 9 de audio o conteudo
  // passa da altura visivel. scrollY desloca TUDO que vem depois da regua —
  // como render e hittest bebem do mesmo layout, o que se ve continua sendo o
  // que se clica, sem tocar em nenhuma conta do eixo X.
  const scrollY = Math.max(0, vp.scrollY || 0);
  let yCursor = METRICS.RULER_H + GAP - scrollY;
  for (const lane of lanesUsadas) {
    laneRows.push({ lane, y: yCursor, h: LANE_H, hidden: hidOv.includes(lane) });
    yCursor += LANE_H + 4;
  }
  const laneY = new Map(laneRows.map(r => [r.lane, r.y]));
  const hasOverlays = ovsAtivas.length > 0;
  const yOverlay = laneRows.length ? laneRows[0].y : (METRICS.RULER_H + GAP);
  const yVideo = yCursor + (laneRows.length ? GAP - 4 : 0);
  const yAudio = yVideo + VH + GAP;
  const contentH = yAudio + AH + GAP;
  // compat: yText aponta pra row de texto mais comum (paineis antigos)
  const yText = laneRows.length ? laneRows[0].y : yVideo;

  const overlayItems = ovsAtivas.map(o => {
    const dur = overlayTimelineDur(o);   // largura reflete a velocidade da camada
    return {
      overlayId: o.id, lane: o.lane || 1,
      mediaId: o.media_id ?? null,  // camada de take usa a miniatura DELE
      isImage: o.kind === 'image', imageUrl: o.kind === 'image' ? o.url : null,
      x: timeToX(vp, o.start), y: laneY.get(o.lane || 1) ?? yOverlay,
      w: dur * vp.pxPerSec, h: LANE_H,
      tStart: o.start, tEnd: o.start + dur,
      srcIn: o.source_in, srcOut: o.source_out, speed: o.speed > 0 ? o.speed : 1,
      selected: state.selected_overlay_id === o.id,
      multi: multiKeys.has('overlay:' + o.id),
      hidden: hidOv.includes(o.lane || 1),
    };
  });

  // Itens da track principal (compound = 1 bloco; nao expande aqui)
  const clips = mainTrackItems(state).map(it => {
    const x = timeToX(vp, it.tStart);
    const w = (it.tEnd - it.tStart) * vp.pxPerSec;
    const comp = it.isCompound
      ? (state.compounds || []).find(k => k.id === it.clip.compound_id) : null;
    const firstSub = comp?.clips?.[0];
    return {
      clipId: it.clip.id,
      isCompound: it.isCompound,
      compoundId: it.clip.compound_id || null,
      compoundName: comp?.name || null,
      // take extra: thumbs do principal nao valem — render mostra slab+nome
      mediaId: it.clip.media_id ?? null,
      mediaName: it.clip.media_id != null
        ? ((state.media || []).find(m => m.id === it.clip.media_id)?.filename || 'take')
        : null,
      tStart: it.tStart,
      tEnd: it.tEnd,
      sourceIn: it.isCompound ? (firstSub?.source_in ?? 0) : it.clip.source_in,
      sourceOut: it.isCompound ? (firstSub?.source_out ?? 1) : it.clip.source_out,
      frozen: !!it.clip.frozen,             // cena congelada: resize por freeze_dur
      reversed: !!it.clip.reversed, mirrored: !!it.clip.mirrored,
      x, y: yVideo, w, h: VH,
      selected: state.selected_clip_id === it.clip.id,
      multi: multiKeys.has('clip:' + it.clip.id),
    };
  });

  // Clips desativados: renderizados como "fantasmas" apos o fim da timeline
  // (visiveis pra reativar), cada um com largura proporcional.
  const inactive = (state.clips || []).filter(c => c.active === false);
  let ghostT = total + (total > 0 ? 1.0 : 0); // gap de 1s virtual
  const ghosts = inactive.map(c => {
    const dur = c.source_out - c.source_in;
    const g = {
      clipId: c.id,
      x: timeToX(vp, ghostT), y: yVideo,
      w: dur * vp.pxPerSec, h: VH,
      selected: state.selected_clip_id === c.id,
    };
    ghostT += dur + 0.5;
    return g;
  });

  // Blocos de texto: vivem na ROW da sua lane (centralizados na altura)
  const texts = textosAtivos.map(t => {
    const rowY = laneY.get(t.lane || 4) ?? yText;
    return {
      textId: t.id, lane: t.lane || 4,
      x: timeToX(vp, t.start_sec),
      y: rowY + Math.max(0, (LANE_H - TH) / 2),
      w: Math.max(6, (t.end_sec - t.start_sec) * vp.pxPerSec),
      h: TH,
      selected: state.selected_text_id === t.id,
      multi: multiKeys.has('text:' + t.id),
      content: t.content,
    };
  });

  // Track de audio: itens selecionaveis.
  // - 'video': audio destacado do video (Ctrl+Shift+S) — cobre a timeline,
  //   com sub-segmentos espelhando os clips pra waveform fatiada certa.
  // - 'extra': musica/narracao enviada (barra unica da duracao do arquivo).
  // Clips de audio: cada um posicionavel (start). Lanes automaticas quando
  // sobrepoe (CapCut empilha). Track de audio cresce com as lanes.
  const activeAudio = (state.audio_clips || []).filter(a => a.active !== false);
  // lane RESOLVIDA vem do selector (fonte única: manual vence, resto empacota)
  const laneOf = audioLaneMap(state);
  const hidAu = state.hidden_audio_lanes || [];
  const audioItems = activeAudio
    .slice()
    .sort((a, b) => a.start - b.start)
    .map(a => {
      const dur = audioTimelineDur(a);  // largura reflete a velocidade
      const end = a.start + dur;
      const lane = laneOf.get(a.id) ?? 0;
      return {
        audioId: a.id, kind: a.kind, url: a.url || null,
        x: timeToX(vp, a.start),
        y: yAudio + lane * (AH + 2),
        w: dur * vp.pxPerSec, h: AH,
        tStart: a.start, tEnd: end,
        srcIn: a.source_in, srcOut: a.source_out,
        selected: state.selected_audio_id === a.id,
        multi: multiKeys.has('audio:' + a.id),
        label: '♪ ' + (a.filename || 'áudio'),
        volume: a.volume == null ? 1 : a.volume,
        lane, hidden: hidAu.includes(lane),
      };
    });
  const maxAudioLane = audioItems.length ? Math.max(...audioItems.map(i => i.lane)) : -1;
  // lanes extras vazias EMBAIXO (menu "Criar camada de áudio" / drop abaixo)
  const laneAudioFantasma = hint && Number.isInteger(hint.laneAudioExtra) ? hint.laneAudioExtra : null;
  const audioLanes = Math.max(
    Math.max(1, maxAudioLane + 1) + (state.extra_audio_lanes || 0),
    laneAudioFantasma != null ? laneAudioFantasma + 1 : 0,
  );
  const audioLaneRows = [];
  for (let i = 0; i < audioLanes; i++) {
    audioLaneRows.push({ lane: i, y: yAudio + i * (AH + 2), h: AH, hidden: hidAu.includes(i) });
  }
  const contentHFinal = yAudio + audioLanes * (AH + 2) + GAP;

  // ── MARCADORES DE TRANSIÇÃO (2026-07-29) ──────────────────────────────────
  // Ficam NA EMENDA de duas cenas da mesma faixa, como no CapCut: um losango
  // sobre o corte. Sem isso a transição era invisível na timeline — o usuário
  // aplicava e não tinha como ver onde estava, nem clicar pra ajustar.
  const transMarks = [];
  {
    const itens = mainTrackItems(state);
    for (const tr of state.transitions || []) {
      const saindo = itens[tr.between];
      if (!saindo) continue;
      const x = timeToX(vp, saindo.tEnd);
      if (x < -20 || x > vp.width + 20) continue;   // fora da vista
      transMarks.push({
        between: tr.between, t: saindo.tEnd, type: tr.type,
        x, y: yVideo + VH / 2, r: 11,
        selected: state._juncao_sel === tr.between,
      });
    }
  }

  return {
    vp, total, extent: playableDuration(state), segs, clips, ghosts, texts, audioItems, audioLanes, audioLaneRows,
    overlayItems, yOverlay, hasOverlays, laneRows, transMarks,
    // strip de waveform DENTRO do clip: so enquanto o audio esta embutido.
    // Fix waveform fantasma: apos detach (mesmo com clips deletados) a
    // strip NAO volta — audio agora vive (ou viveu) na track propria.
    clipWaveform: !state.audio_detached,
    yRuler, yVideo, yText, yAudio, scrollY,
    videoTrackH: VH, audioTrackH: AH, trackScale,  // alturas ESCALADAS (auto-altura)
    // altura REAL do conteudo (soma o scroll de volta): e a regua do quanto da
    // pra rolar. Sem somar, rolar encolheria o proprio limite e travaria no meio.
    contentH: Math.max(contentH, contentHFinal) + scrollY,
    maxScrollY: Math.max(0, Math.max(contentH, contentHFinal) + scrollY - (vp.height || 0)),
  };
}

/** Ticks da regua adaptados ao zoom (retorna [{t, x, major, label}]). */
export function rulerTicks(layout) {
  const { vp } = layout;
  const pxPerSec = vp.pxPerSec;
  // escolhe passo: >=80px entre majors
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let step = steps[steps.length - 1];
  for (const s of steps) { if (s * pxPerSec >= 80) { step = s; break; } }
  const t0 = Math.max(0, Math.floor(xToTime(vp, 0) / step) * step);
  const t1 = xToTime(vp, vp.width) + step;
  const ticks = [];
  for (let t = t0; t <= t1; t += step) {
    ticks.push({ t, x: timeToX(vp, t), major: true, label: formatTime(t) });
    // minors (4 por major)
    for (let i = 1; i < 4; i++) {
      const tm = t + (step * i) / 4;
      if (tm <= t1) ticks.push({ t: tm, x: timeToX(vp, tm), major: false, label: null });
    }
  }
  return ticks;
}

export function formatTime(t) {
  if (t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (t < 10 && t % 1 !== 0) return `${t.toFixed(1)}s`;
  return `${m}:${s.toFixed(0).padStart(2, '0')}`;
}

/** Zoom ancorado num ponto x do canvas: retorna novo {pxPerSec, scrollX}. */
export function zoomAt(vp, factor, anchorX) {
  const tAnchor = xToTime(vp, anchorX);
  const pxPerSec = Math.min(METRICS.MAX_PX_PER_SEC, Math.max(METRICS.MIN_PX_PER_SEC, vp.pxPerSec * factor));
  // scrollX tal que tAnchor continua no mesmo x
  const scrollX = METRICS.PAD_LEFT + tAnchor * pxPerSec - anchorX;
  return { pxPerSec, scrollX: Math.max(-METRICS.PAD_LEFT, scrollX) };
}

/** Lane alvo pra um y do canvas (drop do arrasto vertical).
 *  - dentro de uma row existente -> a lane dela
 *  - ACIMA da row do topo -> topo+1 (cria camada nova acima, CapCut)
 *  - abaixo das rows (main/audio) -> null (mantem a lane atual) */
export function laneForY(layout, y) {
  const rows = layout.laneRows || [];
  if (!rows.length) {
    // sem rows ainda: qualquer y acima da main = lane 1
    return y < layout.yVideo - 8 ? 1 : null;
  }
  const topo = rows[0];
  if (y < topo.y - 4) return Math.min(MAX_LANE, topo.lane + 1);
  for (const r of rows) {
    if (y >= r.y - 4 && y <= r.y + r.h + 4) return r.lane;
  }
  return null;
}

/** Zoom pra caber tudo. */
export function zoomToFit(state, width) {
  const total = totalDuration(state);
  if (total <= 0) return { pxPerSec: 40, scrollX: 0 };
  const usable = Math.max(100, width - METRICS.PAD_LEFT * 2);
  const pxPerSec = Math.min(METRICS.MAX_PX_PER_SEC, Math.max(METRICS.MIN_PX_PER_SEC, usable / total));
  return { pxPerSec, scrollX: 0 };
}
