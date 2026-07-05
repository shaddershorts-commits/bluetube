// editor-v1/timeline/layout.js
// Geometria da timeline: converte (state, viewport) -> retangulos em px.
// Modulo puro: sem DOM/canvas. Toda posicao visual nasce aqui — render e
// hittest consomem o MESMO layout (nunca calculam por conta propria).

import { timelineSegments, totalDuration, mainTrackItems } from '../core/selectors.js';

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

/** Layout completo de um frame. */
export function computeLayout(state, vp) {
  const segs = timelineSegments(state);
  const total = totalDuration(state);

  const yRuler = 0;
  // Track de OVERLAY adaptativa (CapCut): so existe quando ha camadas —
  // aparece ACIMA da principal (camada de cima renderiza na frente).
  const hasOverlays = (state.overlays || []).some(o => o.active !== false);
  const yOverlay = METRICS.RULER_H + METRICS.TRACK_GAP;
  const overlayH = hasOverlays ? METRICS.VIDEO_TRACK_H * 0.7 + METRICS.TRACK_GAP : 0;
  const yVideo = yOverlay + overlayH;
  const yText = yVideo + METRICS.VIDEO_TRACK_H + METRICS.TRACK_GAP;
  const yAudio = yText + METRICS.TEXT_TRACK_H + METRICS.TRACK_GAP;
  const contentH = yAudio + METRICS.AUDIO_TRACK_H + METRICS.TRACK_GAP;

  const overlayItems = (state.overlays || []).filter(o => o.active !== false).map(o => {
    const dur = o.source_out - o.source_in;
    return {
      overlayId: o.id,
      x: timeToX(vp, o.start), y: yOverlay,
      w: dur * vp.pxPerSec, h: METRICS.VIDEO_TRACK_H * 0.7,
      tStart: o.start, tEnd: o.start + dur,
      srcIn: o.source_in, srcOut: o.source_out,
      selected: state.selected_overlay_id === o.id,
    };
  });

  // Itens da track principal (compound = 1 bloco; nao expande aqui)
  const multiKeys = new Set((state.multi_selected || []).map(m => m.type + ':' + m.id));
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
      tStart: it.tStart,
      tEnd: it.tEnd,
      sourceIn: it.isCompound ? (firstSub?.source_in ?? 0) : it.clip.source_in,
      sourceOut: it.isCompound ? (firstSub?.source_out ?? 1) : it.clip.source_out,
      x, y: yVideo, w, h: METRICS.VIDEO_TRACK_H,
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
      w: dur * vp.pxPerSec, h: METRICS.VIDEO_TRACK_H,
      selected: state.selected_clip_id === c.id,
    };
    ghostT += dur + 0.5;
    return g;
  });

  // Blocos de texto (na track de texto)
  const texts = (state.texts || []).filter(t => t.active !== false).map(t => ({
    textId: t.id,
    x: timeToX(vp, t.start_sec),
    y: yText,
    w: Math.max(6, (t.end_sec - t.start_sec) * vp.pxPerSec),
    h: METRICS.TEXT_TRACK_H,
    selected: state.selected_text_id === t.id,
    content: t.content,
  }));

  // Track de audio: itens selecionaveis.
  // - 'video': audio destacado do video (Ctrl+Shift+S) — cobre a timeline,
  //   com sub-segmentos espelhando os clips pra waveform fatiada certa.
  // - 'extra': musica/narracao enviada (barra unica da duracao do arquivo).
  // Clips de audio: cada um posicionavel (start). Lanes automaticas quando
  // sobrepoe (CapCut empilha). Track de audio cresce com as lanes.
  const activeAudio = (state.audio_clips || []).filter(a => a.active !== false);
  const lanes = []; // laneIndex -> ultimo end
  const audioItems = activeAudio
    .slice()
    .sort((a, b) => a.start - b.start)
    .map(a => {
      const dur = a.source_out - a.source_in;
      const end = a.start + dur;
      let lane = lanes.findIndex(le => a.start >= le - 1e-6);
      if (lane < 0) { lane = lanes.length; lanes.push(end); }
      else lanes[lane] = end;
      return {
        audioId: a.id, kind: a.kind, url: a.url || null,
        x: timeToX(vp, a.start),
        y: yAudio + lane * (METRICS.AUDIO_TRACK_H + 2),
        w: dur * vp.pxPerSec, h: METRICS.AUDIO_TRACK_H,
        tStart: a.start, tEnd: end,
        srcIn: a.source_in, srcOut: a.source_out,
        selected: state.selected_audio_id === a.id,
        label: '♪ ' + (a.filename || 'áudio'),
      };
    });
  const audioLanes = Math.max(1, lanes.length);
  const contentHFinal = yAudio + audioLanes * (METRICS.AUDIO_TRACK_H + 2) + METRICS.TRACK_GAP;

  return {
    vp, total, segs, clips, ghosts, texts, audioItems, audioLanes,
    overlayItems, yOverlay, hasOverlays,
    // strip de waveform DENTRO do clip: so enquanto o audio esta embutido.
    // Fix waveform fantasma: apos detach (mesmo com clips deletados) a
    // strip NAO volta — audio agora vive (ou viveu) na track propria.
    clipWaveform: !state.audio_detached,
    yRuler, yVideo, yText, yAudio,
    contentH: Math.max(contentH, contentHFinal),
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

/** Zoom pra caber tudo. */
export function zoomToFit(state, width) {
  const total = totalDuration(state);
  if (total <= 0) return { pxPerSec: 40, scrollX: 0 };
  const usable = Math.max(100, width - METRICS.PAD_LEFT * 2);
  const pxPerSec = Math.min(METRICS.MAX_PX_PER_SEC, Math.max(METRICS.MIN_PX_PER_SEC, usable / total));
  return { pxPerSec, scrollX: 0 };
}
