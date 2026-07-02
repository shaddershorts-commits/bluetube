// editor-v1/timeline/layout.js
// Geometria da timeline: converte (state, viewport) -> retangulos em px.
// Modulo puro: sem DOM/canvas. Toda posicao visual nasce aqui — render e
// hittest consomem o MESMO layout (nunca calculam por conta propria).

import { timelineSegments, totalDuration } from '../core/selectors.js';

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
  const yVideo = METRICS.RULER_H + METRICS.TRACK_GAP;
  const yText = yVideo + METRICS.VIDEO_TRACK_H + METRICS.TRACK_GAP;
  const yAudio = yText + METRICS.TEXT_TRACK_H + METRICS.TRACK_GAP;
  const contentH = yAudio + METRICS.AUDIO_TRACK_H + METRICS.TRACK_GAP;

  // Clips ativos (na track de video)
  const clips = segs.map(seg => {
    const x = timeToX(vp, seg.tStart);
    const w = (seg.tEnd - seg.tStart) * vp.pxPerSec;
    return {
      clipId: seg.clip.id,
      tStart: seg.tStart,
      tEnd: seg.tEnd,
      sourceIn: seg.clip.source_in,
      sourceOut: seg.clip.source_out,
      x, y: yVideo, w, h: METRICS.VIDEO_TRACK_H,
      selected: state.selected_clip_id === seg.clip.id,
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

  // Track de audio extra (barra unica cobrindo a duracao do audio)
  let audio = null;
  if (state.audio_extra?.duration > 0) {
    audio = {
      x: timeToX(vp, 0),
      y: yAudio,
      w: Math.min(state.audio_extra.duration, Math.max(total, state.audio_extra.duration)) * vp.pxPerSec,
      h: METRICS.AUDIO_TRACK_H,
      duration: state.audio_extra.duration,
    };
  }

  return {
    vp, total, segs, clips, ghosts, texts, audio,
    yRuler, yVideo, yText, yAudio, contentH,
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
