// editor-v1/timeline/interaction.js
// FSM de interacao da timeline — o CORACAO anti-bug do editor.
//
// Regras:
//   - transition() e PURA: recebe (fsm, ev, ctx) e retorna { next, effects }.
//     Nenhum acesso a DOM/canvas/store aqui dentro.
//   - Todo caminho termina em 'idle'. cancel/esc SEMPRE volta pra idle.
//   - Durante drags continuos, os effects dispatcham actions com o MESMO
//     gestureId -> history coalesce = 1 undo step por gesto.
//   - O adapter (dom-adapter no render/shell) executa os effects.
//
// Estados:
//   idle
//   armed          { hit, x0, y0, touch, gestureId }   aguardando threshold/long-press
//   dragging-clip  { clipId, gestureId }
//   trimming       { clipId, edge, tStartSeg, sourceIn0, gestureId }
//   dragging-text  { textId, grabOffset, duration, gestureId }
//   scrubbing      {}
//   panning        { x0, scrollX0 }
//   pinching       { d0, pxPerSec0, cx }
//
// Eventos (do adapter):
//   down / move / up / cancel / longpress / second-down / pinch-move /
//   esc / dblclick / wheel

import { xToTime, zoomAt, METRICS } from './layout.js';
import { snapTime, defaultSnapPoints } from './snap.js';
import { MIN_CLIP_DURATION } from '../core/schema.js';
import * as act from '../core/actions.js';

export const DRAG_THRESHOLD_MOUSE = 4;
export const DRAG_THRESHOLD_TOUCH = 8;
export const LONG_PRESS_MS = 300;

export const idle = () => ({ name: 'idle' });

let gestureSeq = 1;
function newGestureId() { return 'g' + (gestureSeq++); }

/**
 * @param {object} fsm estado atual da FSM
 * @param {object} ev evento
 * @param {object} ctx { layout, playhead, cutPoints, snapEnabled }
 * @returns {{ next: object, effects: object[] }}
 */
export function transition(fsm, ev, ctx) {
  const fx = [];

  // Esc/cancel de qualquer estado -> idle, sem commit
  if (ev.kind === 'cancel' || ev.kind === 'esc') {
    if (fsm.name !== 'idle') fx.push({ do: 'end-gesture' });
    // Gestos que live-dispatcham precisam de undo do coalescido. Trimming NAO
    // dispatcha durante o gesto (preview puro) — descartar o preview basta.
    if (fsm.name === 'dragging-clip' || fsm.name === 'dragging-text') {
      fx.push({ do: 'abort-gesture' }); // adapter faz store.undo() do gesto coalescido
    }
    if (fsm.name === 'trimming') fx.push({ do: 'show-snap', active: false });
    fx.push({ do: 'set-cursor', cursor: 'default' });
    return { next: idle(), effects: fx };
  }

  switch (fsm.name) {

    case 'idle': {
      if (ev.kind === 'wheel') {
        if (ev.ctrlKey) {
          const z = zoomAt(ctx.layout.vp, ev.deltaY < 0 ? 1.2 : 1 / 1.2, ev.x);
          fx.push({ do: 'zoom', ...z });
        } else {
          fx.push({ do: 'scroll', scrollX: ctx.layout.vp.scrollX + (ev.deltaY + ev.deltaX) });
        }
        return { next: fsm, effects: fx };
      }
      if (ev.kind === 'dblclick') {
        if (ev.hit.type === 'text-block') fx.push({ do: 'open-text-editor', textId: ev.hit.textId });
        return { next: fsm, effects: fx };
      }
      if (ev.kind !== 'down') return { next: fsm, effects: fx };

      const hit = ev.hit;
      if (hit.type === 'ruler') {
        // Regua: scrub imediato (mouse E touch — CapCut)
        fx.push({ do: 'seek', t: clampT(xToTime(ctx.layout.vp, ev.x), ctx) });
        return { next: { name: 'scrubbing' }, effects: fx };
      }
      if (hit.type === 'track-empty' || hit.type === 'empty') {
        fx.push({ do: 'clear-selection' });
        if (ev.touch) {
          // Touch em area vazia: PAN (CapCut mobile — navega a timeline)
          return { next: { name: 'panning', x0: ev.x, scrollX0: ctx.layout.vp.scrollX }, effects: fx };
        }
        // Mouse: scrub (CapCut desktop)
        fx.push({ do: 'seek', t: clampT(xToTime(ctx.layout.vp, ev.x), ctx) });
        return { next: { name: 'scrubbing' }, effects: fx };
      }
      if (hit.type === 'ghost') {
        // Click em ghost reativa o clip (decidido no up — armed)
        return { next: { name: 'armed', hit, x0: ev.x, y0: ev.y, touch: !!ev.touch, gestureId: null }, effects: fx };
      }
      if (hit.type === 'trim-in' || hit.type === 'trim-out') {
        const c = ctx.layout.clips.find(k => k.clipId === hit.clipId);
        if (!c) return { next: fsm, effects: fx };
        fx.push({ do: 'set-cursor', cursor: 'ew-resize' });
        const edge = hit.type === 'trim-in' ? 'in' : 'out';
        return {
          next: {
            name: 'trimming', clipId: hit.clipId, edge,
            tStartSeg: c.tStart, tEndSeg: c.tEnd,
            sourceIn0: c.sourceIn, sourceOut0: c.sourceOut,
            // preview do gesto: NENHUM dispatch durante o move — o render
            // desenha a partir daqui e o commit e 1 action unica no up
            previewSource: edge === 'in' ? c.sourceIn : c.sourceOut,
          },
          effects: fx,
        };
      }
      if (hit.type === 'clip-body') {
        return { next: { name: 'armed', hit, x0: ev.x, y0: ev.y, touch: !!ev.touch, gestureId: null }, effects: fx };
      }
      if (hit.type === 'text-block') {
        return { next: { name: 'armed', hit, x0: ev.x, y0: ev.y, touch: !!ev.touch, gestureId: null }, effects: fx };
      }
      if (hit.type === 'audio-item') {
        fx.push({ do: 'select-audio', kind: hit.kind });
        return { next: fsm, effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'armed': {
      if (ev.kind === 'second-down') {
        return { next: pinchStart(ev, ctx), effects: fx };
      }
      if (ev.kind === 'longpress' && fsm.touch) {
        // Touch: long-press em clip inicia drag (CapCut mobile)
        if (fsm.hit.type === 'clip-body') {
          fx.push({ do: 'haptic' });
          fx.push({ do: 'select-clip', clipId: fsm.hit.clipId });
          return { next: { name: 'dragging-clip', clipId: fsm.hit.clipId, gestureId: newGestureId() }, effects: fx };
        }
        return { next: fsm, effects: fx };
      }
      if (ev.kind === 'move') {
        const dist = Math.hypot(ev.x - fsm.x0, ev.y - fsm.y0);
        const threshold = fsm.touch ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE;
        if (dist < threshold) return { next: fsm, effects: fx };
        // passou o threshold:
        if (fsm.touch) {
          // touch antes do long-press = pan da timeline (scroll)
          return {
            next: { name: 'panning', x0: ev.x, scrollX0: ctx.layout.vp.scrollX },
            effects: fx,
          };
        }
        if (fsm.hit.type === 'clip-body') {
          fx.push({ do: 'select-clip', clipId: fsm.hit.clipId });
          fx.push({ do: 'set-cursor', cursor: 'grabbing' });
          return { next: { name: 'dragging-clip', clipId: fsm.hit.clipId, gestureId: newGestureId() }, effects: fx };
        }
        if (fsm.hit.type === 'text-block') {
          const tb = ctx.layout.texts.find(t => t.textId === fsm.hit.textId);
          const tAtGrab = xToTime(ctx.layout.vp, fsm.x0);
          const tbStart = tb ? xToTime(ctx.layout.vp, tb.x) : tAtGrab;
          const dur = tb ? tb.w / ctx.layout.vp.pxPerSec : 1;
          fx.push({ do: 'select-text', textId: fsm.hit.textId });
          return {
            next: { name: 'dragging-text', textId: fsm.hit.textId, grabOffset: tAtGrab - tbStart, duration: dur, gestureId: newGestureId() },
            effects: fx,
          };
        }
        // ghost etc: vira pan
        return { next: { name: 'panning', x0: ev.x, scrollX0: ctx.layout.vp.scrollX }, effects: fx };
      }
      if (ev.kind === 'up') {
        // CLICK
        const hit = fsm.hit;
        if (hit.type === 'clip-body') {
          fx.push({ do: 'select-clip', clipId: hit.clipId });
        } else if (hit.type === 'text-block') {
          fx.push({ do: 'select-text', textId: hit.textId });
        } else if (hit.type === 'ghost') {
          fx.push({ do: 'dispatch', action: act.toggleClip(hit.clipId) });
        }
        return { next: idle(), effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'dragging-clip': {
      if (ev.kind === 'move') {
        // live reorder: calcula indice alvo e dispatcha MOVE_CLIP coalescido
        const target = dropIndexAt(ctx.layout, ev.x, fsm.clipId);
        if (target != null) {
          fx.push({ do: 'dispatch', action: { ...act.moveClip(fsm.clipId, target.arrayIndex), gestureId: fsm.gestureId } });
        }
        fx.push({ do: 'autoscroll-edge', x: ev.x });
        return { next: fsm, effects: fx };
      }
      if (ev.kind === 'up') {
        fx.push({ do: 'end-gesture' });
        fx.push({ do: 'set-cursor', cursor: 'default' });
        return { next: idle(), effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'trimming': {
      if (ev.kind === 'move') {
        const vpT = xToTime(ctx.layout.vp, ev.x);
        // Snap SEM as bordas do proprio clip — sem isso o handle "gruda"
        // de volta no ponto original nos primeiros px do arrasto (bug v1.0)
        const ownEdges = (p) =>
          Math.abs(p - fsm.tStartSeg) < 1e-6 || Math.abs(p - fsm.tEndSeg) < 1e-6;
        const points = defaultSnapPoints(ctx.cutPoints.filter(p => !ownEdges(p)), ctx.playhead);
        const snapped = ctx.snapEnabled && !ev.shiftKey
          ? snapTime(vpT, points, ctx.layout.vp.pxPerSec)
          : { t: vpT, snapped: false };
        // tempo virtual -> tempo source relativo ao inicio do segmento
        let sourceTime = fsm.sourceIn0 + (snapped.t - fsm.tStartSeg);
        // clamp do preview (o reducer clampa de novo no commit)
        if (fsm.edge === 'in') {
          sourceTime = Math.min(Math.max(0, sourceTime), fsm.sourceOut0 - MIN_CLIP_DURATION);
        } else {
          const maxOut = ctx.videoDuration || Infinity;
          sourceTime = Math.max(fsm.sourceIn0 + MIN_CLIP_DURATION, Math.min(sourceTime, maxOut));
        }
        fx.push({ do: 'show-snap', active: snapped.snapped, t: snapped.point });
        return { next: { ...fsm, previewSource: sourceTime }, effects: fx };
      }
      if (ev.kind === 'up') {
        // commit unico: 1 action = 1 undo step, sem estados intermediarios
        const orig = fsm.edge === 'in' ? fsm.sourceIn0 : fsm.sourceOut0;
        if (Math.abs(fsm.previewSource - orig) > 1e-4) {
          fx.push({ do: 'dispatch', action: act.trimClip(fsm.clipId, fsm.edge, fsm.previewSource) });
        }
        fx.push({ do: 'show-snap', active: false });
        fx.push({ do: 'set-cursor', cursor: 'default' });
        return { next: idle(), effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'dragging-text': {
      if (ev.kind === 'move') {
        const t = xToTime(ctx.layout.vp, ev.x) - fsm.grabOffset;
        const snapped = ctx.snapEnabled && !ev.shiftKey
          ? snapTime(t, defaultSnapPoints(ctx.cutPoints, ctx.playhead), ctx.layout.vp.pxPerSec)
          : { t, snapped: false };
        const start = Math.max(0, snapped.t);
        fx.push({
          do: 'dispatch',
          action: { ...act.updateText(fsm.textId, { start_sec: start, end_sec: start + fsm.duration }), gestureId: fsm.gestureId },
        });
        return { next: fsm, effects: fx };
      }
      if (ev.kind === 'up') {
        fx.push({ do: 'end-gesture' });
        return { next: idle(), effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'scrubbing': {
      if (ev.kind === 'move') {
        fx.push({ do: 'seek', t: clampT(xToTime(ctx.layout.vp, ev.x), ctx) });
        return { next: fsm, effects: fx };
      }
      if (ev.kind === 'up') return { next: idle(), effects: fx };
      if (ev.kind === 'second-down') return { next: pinchStart(ev, ctx), effects: fx };
      return { next: fsm, effects: fx };
    }

    case 'panning': {
      if (ev.kind === 'move') {
        fx.push({ do: 'scroll', scrollX: fsm.scrollX0 - (ev.x - fsm.x0) });
        return { next: fsm, effects: fx };
      }
      if (ev.kind === 'up') return { next: idle(), effects: fx };
      if (ev.kind === 'second-down') return { next: pinchStart(ev, ctx), effects: fx };
      return { next: fsm, effects: fx };
    }

    case 'pinching': {
      if (ev.kind === 'pinch-move') {
        const factor = ev.d / fsm.d0;
        const z = zoomAt({ ...ctx.layout.vp, pxPerSec: fsm.pxPerSec0 }, factor, fsm.cx);
        fx.push({ do: 'zoom', ...z });
        return { next: fsm, effects: fx };
      }
      if (ev.kind === 'pinch-end') {
        // volta pra panning com 1 dedo (ev.x = dedo restante)
        return { next: { name: 'panning', x0: ev.x, scrollX0: ctx.layout.vp.scrollX }, effects: fx };
      }
      if (ev.kind === 'up') return { next: idle(), effects: fx };
      return { next: fsm, effects: fx };
    }

    default:
      return { next: idle(), effects: fx };
  }
}

function pinchStart(ev, ctx) {
  return { name: 'pinching', d0: ev.d || 1, pxPerSec0: ctx.layout.vp.pxPerSec, cx: ev.cx ?? ev.x };
}

function clampT(t, ctx) {
  const total = ctx.layout.total;
  return Math.min(Math.max(0, t), Math.max(0, total));
}

/** Indice de drop no ARRAY state.clips a partir do x do mouse.
 *  layout.clips sao so os ativos; converte pra indice do array completo. */
function dropIndexAt(layout, x, draggingClipId) {
  const others = layout.clips.filter(c => c.clipId !== draggingClipId);
  let visIndex = others.length;
  for (let i = 0; i < others.length; i++) {
    if (x < others[i].x + others[i].w / 2) { visIndex = i; break; }
  }
  // o adapter converte visIndex (entre ativos) pro indice real do array
  return { visIndex, arrayIndex: visIndex };
}
