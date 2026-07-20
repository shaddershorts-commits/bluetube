// editor-v1/timeline/layout.js
// Geometria da timeline: converte (state, viewport) -> retangulos em px.
// Modulo puro: sem DOM/canvas. Toda posicao visual nasce aqui — render e
// hittest consomem o MESMO layout (nunca calculam por conta propria).

import { timelineSegments, totalDuration, mainTrackItems, audioTimelineDur } from '../core/selectors.js';

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
  const multiKeys = new Set((state.multi_selected || []).map(m => m.type + ':' + m.id));

  // ── CAMADAS (CapCut): rows empilhadas ACIMA da principal ──
  // Cada lane em uso vira uma row; lane MAIOR fica mais ACIMA na timeline e
  // renderiza NA FRENTE no video. Textos e overlays compartilham as lanes
  // (a regra do user: texto abaixo de uma camada de video fica ATRAS dela).
  const ovsAtivas = (state.overlays || []).filter(o => o.active !== false);
  const textosAtivos = (state.texts || []).filter(t => t.active !== false);
  const lanesUsadas = [...new Set([
    ...ovsAtivas.map(o => o.lane || 1),
    ...textosAtivos.map(t => t.lane || 4),
  ])].sort((a, b) => b - a); // desc: topo primeiro
  const LANE_H = Math.round(METRICS.VIDEO_TRACK_H * 0.7);
  const laneRows = []; // [{lane, y, h}] na ordem visual (topo -> base)
  let yCursor = METRICS.RULER_H + METRICS.TRACK_GAP;
  for (const lane of lanesUsadas) {
    laneRows.push({ lane, y: yCursor, h: LANE_H });
    yCursor += LANE_H + 4;
  }
  const laneY = new Map(laneRows.map(r => [r.lane, r.y]));
  const hasOverlays = ovsAtivas.length > 0;
  const yOverlay = laneRows.length ? laneRows[0].y : (METRICS.RULER_H + METRICS.TRACK_GAP);
  const yVideo = yCursor + (laneRows.length ? METRICS.TRACK_GAP - 4 : 0);
  const yAudio = yVideo + METRICS.VIDEO_TRACK_H + METRICS.TRACK_GAP;
  const contentH = yAudio + METRICS.AUDIO_TRACK_H + METRICS.TRACK_GAP;
  // compat: yText aponta pra row de texto mais comum (paineis antigos)
  const yText = laneRows.length ? laneRows[0].y : yVideo;

  const overlayItems = ovsAtivas.map(o => {
    const dur = o.source_out - o.source_in;
    return {
      overlayId: o.id, lane: o.lane || 1,
      mediaId: o.media_id ?? null,  // camada de take usa a miniatura DELE
      isImage: o.kind === 'image', imageUrl: o.kind === 'image' ? o.url : null,
      x: timeToX(vp, o.start), y: laneY.get(o.lane || 1) ?? yOverlay,
      w: dur * vp.pxPerSec, h: LANE_H,
      tStart: o.start, tEnd: o.start + dur,
      srcIn: o.source_in, srcOut: o.source_out,
      selected: state.selected_overlay_id === o.id,
      multi: multiKeys.has('overlay:' + o.id),
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

  // Blocos de texto: vivem na ROW da sua lane (centralizados na altura)
  const texts = textosAtivos.map(t => {
    const rowY = laneY.get(t.lane || 4) ?? yText;
    return {
      textId: t.id, lane: t.lane || 4,
      x: timeToX(vp, t.start_sec),
      y: rowY + Math.max(0, (LANE_H - METRICS.TEXT_TRACK_H) / 2),
      w: Math.max(6, (t.end_sec - t.start_sec) * vp.pxPerSec),
      h: METRICS.TEXT_TRACK_H,
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
  const lanes = []; // laneIndex -> ultimo end
  const audioItems = activeAudio
    .slice()
    .sort((a, b) => a.start - b.start)
    .map(a => {
      const dur = audioTimelineDur(a);  // largura reflete a velocidade
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
        multi: multiKeys.has('audio:' + a.id),
        label: '♪ ' + (a.filename || 'áudio'),
      };
    });
  const audioLanes = Math.max(1, lanes.length);
  const contentHFinal = yAudio + audioLanes * (METRICS.AUDIO_TRACK_H + 2) + METRICS.TRACK_GAP;

  return {
    vp, total, segs, clips, ghosts, texts, audioItems, audioLanes,
    overlayItems, yOverlay, hasOverlays, laneRows,
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
  if (y < topo.y - 4) return Math.min(5, topo.lane + 1);
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
