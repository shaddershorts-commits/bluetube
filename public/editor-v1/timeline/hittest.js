// editor-v1/timeline/hittest.js
// Hit-testing puro sobre o layout. NUNCA le canvas/DOM — recebe o mesmo
// layout que o render desenhou, entao o que se ve = o que se clica.
//
// Prioridade (igual CapCut): trim handles do clip selecionado > clip body >
// text block > ghost > ruler > audio > empty.

import { METRICS } from './layout.js';

/**
 * @param {object} layout computeLayout(...)
 * @param {number} x
 * @param {number} y
 * @param {{touch?:boolean}} opts touch expande areas de hit
 * @returns {{type:string, clipId?:number, textId?:number, t?:number}}
 */
export function hitTest(layout, x, y, opts = {}) {
  const extra = opts.touch ? METRICS.TOUCH_EXTRA : 0;
  const handleW = METRICS.HANDLE_HIT_W + extra;

  // 0. MARCADOR DE TRANSIÇÃO — antes de tudo. Ele fica EM CIMA da emenda, ou
  // seja, sobre a borda de dois clips: se o teste de trim viesse primeiro, o
  // clique viraria um trim e a transição nunca abriria.
  for (const m of layout.transMarks || []) {
    const raio = m.r + extra;
    if (Math.abs(x - m.x) <= raio && Math.abs(y - m.y) <= raio) {
      return { type: 'transition', between: m.between, t: m.t };
    }
  }

  // 1. Trim handles — só do clip SELECIONADO (evita gordura de hit em toda borda,
  //    que na v0 fazia cliques virarem trims acidentais)
  const sel = layout.clips.find(c => c.selected);
  if (sel) {
    if (within(x, y, sel.x - handleW / 2, sel.y - extra, handleW, sel.h + extra * 2)) {
      return { type: 'trim-in', clipId: sel.clipId };
    }
    if (within(x, y, sel.x + sel.w - handleW / 2, sel.y - extra, handleW, sel.h + extra * 2)) {
      return { type: 'trim-out', clipId: sel.clipId };
    }
  }

  // 1b. Overlays (camadas acima da principal): handles no selecionado + corpo
  const selOv = (layout.overlayItems || []).find(o => o.selected);
  if (selOv) {
    // 1b-0. DIAMANTES de quadro-chave (user 14/08: "posso mover os diamantes
    // dentro da faixa") — ANTES do corpo, senão o clique viraria drag da camada
    const pps = layout.vp?.pxPerSec || 0;
    for (let i = 0; i < (selOv.kfTs || []).length; i++) {
      const kx = selOv.x + selOv.kfTs[i] * pps;
      const ky = selOv.y + selOv.h / 2;
      if (Math.abs(x - kx) <= 7 + extra && Math.abs(y - ky) <= 8 + extra) {
        return { type: 'overlay-kf', overlayId: selOv.overlayId, kfT: selOv.kfTs[i], itemStart: selOv.tStart };
      }
    }
    if (within(x, y, selOv.x - handleW / 2, selOv.y - extra, handleW, selOv.h + extra * 2)) {
      return { type: 'overlay-trim-in', overlayId: selOv.overlayId };
    }
    if (within(x, y, selOv.x + selOv.w - handleW / 2, selOv.y - extra, handleW, selOv.h + extra * 2)) {
      return { type: 'overlay-trim-out', overlayId: selOv.overlayId };
    }
  }
  for (const o of layout.overlayItems || []) {
    if (within(x, y, o.x, o.y, o.w, o.h)) {
      return { type: 'overlay-body', overlayId: o.overlayId };
    }
  }

  // 2. Corpo de clip ativo
  for (const c of layout.clips) {
    if (within(x, y, c.x, c.y, c.w, c.h)) {
      return { type: 'clip-body', clipId: c.clipId, compoundId: c.compoundId || null };
    }
  }

  // 3. Blocos de texto
  for (const t of layout.texts) {
    if (within(x, y, t.x, t.y - extra, t.w, t.h + extra * 2)) {
      return { type: 'text-block', textId: t.textId };
    }
  }

  // 4. Ghosts (clips desativados)
  for (const g of layout.ghosts) {
    if (within(x, y, g.x, g.y, g.w, g.h)) {
      return { type: 'ghost', clipId: g.clipId };
    }
  }

  // 5. Regua (scrub)
  if (y >= layout.yRuler && y < layout.yRuler + METRICS.RULER_H) {
    return { type: 'ruler' };
  }

  // 6. Clips de audio: trim handles no selecionado + corpo (drag/select)
  const selAudio = (layout.audioItems || []).find(a => a.selected);
  if (selAudio) {
    if (within(x, y, selAudio.x - handleW / 2, selAudio.y - extra, handleW, selAudio.h + extra * 2)) {
      return { type: 'audio-trim-in', audioId: selAudio.audioId };
    }
    if (within(x, y, selAudio.x + selAudio.w - handleW / 2, selAudio.y - extra, handleW, selAudio.h + extra * 2)) {
      return { type: 'audio-trim-out', audioId: selAudio.audioId };
    }
  }
  for (const a of layout.audioItems || []) {
    if (within(x, y, a.x, a.y, a.w, a.h)) {
      return { type: 'audio-body', audioId: a.audioId };
    }
  }

  // 7. Area da track de video vazia (scrub tambem — CapCut permite)
  if (y >= layout.yVideo && y < layout.yVideo + (layout.videoTrackH || METRICS.VIDEO_TRACK_H)) {
    return { type: 'track-empty' };
  }

  return { type: 'empty' };
}

/** Indice de drop pra drag de clip: em qual posicao do array soltar. */
export function dropIndexForX(layout, x) {
  // centro de cada clip; solta antes do primeiro cujo centro esta a direita
  for (let i = 0; i < layout.clips.length; i++) {
    const c = layout.clips[i];
    if (x < c.x + c.w / 2) return i;
  }
  return layout.clips.length > 0 ? layout.clips.length - 1 : 0;
}

function within(x, y, rx, ry, rw, rh) {
  return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
}
