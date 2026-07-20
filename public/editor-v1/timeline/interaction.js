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
    if (fsm.name === 'trimming' || fsm.name === 'trimming-audio' || fsm.name === 'dragging-audio' ||
        fsm.name === 'trimming-overlay' || fsm.name === 'dragging-overlay') {
      fx.push({ do: 'show-snap', active: false });
    }
    fx.push({ do: 'set-cursor', cursor: 'default' });
    return { next: idle(), effects: fx };
  }

  switch (fsm.name) {

    case 'idle': {
      if (ev.kind === 'wheel') {
        // Rolar = ZOOM ancorado no cursor (pedido do user: aproximar/afastar
        // a visão das faixas direto no scroll). Shift ou scroll horizontal
        // de trackpad = rolagem da timeline. Ctrl também zooma (hábito).
        const horizontal = Math.abs(ev.deltaX) > Math.abs(ev.deltaY);
        if (ev.shiftKey || horizontal) {
          fx.push({ do: 'scroll', scrollX: ctx.layout.vp.scrollX + (horizontal ? ev.deltaX : ev.deltaY) });
        } else {
          const z = zoomAt(ctx.layout.vp, ev.deltaY < 0 ? 1.18 : 1 / 1.18, ev.x);
          fx.push({ do: 'zoom', ...z });
        }
        return { next: fsm, effects: fx };
      }
      if (ev.kind === 'dblclick') {
        if (ev.hit.type === 'text-block') fx.push({ do: 'open-text-editor', textId: ev.hit.textId });
        if (ev.hit.type === 'clip-body' && ev.hit.compoundId) {
          fx.push({ do: 'open-compound', compoundId: ev.hit.compoundId });
        }
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
        if (ev.touch) {
          // Touch em area vazia: PAN (CapCut mobile — navega a timeline)
          fx.push({ do: 'clear-selection' });
          return { next: { name: 'panning', x0: ev.x, scrollX0: ctx.layout.vp.scrollX }, effects: fx };
        }
        if (ev.double || (ev.detail || 1) >= 2) {
          // DUPLO clique no vazio segurando: a agulha vai pro mouse e SEGUE
          // enquanto o botao estiver pressionado (user 2026-07-20)
          fx.push({ do: 'seek', t: clampT(xToTime(ctx.layout.vp, ev.x), ctx) });
          return { next: { name: 'scrubbing' }, effects: fx };
        }
        // Mouse no vazio: CLIQUE (1x) = a agulha vai pro mouse na hora
        // (decidido no up); ARRASTO = seletor retangular (marquee).
        // Seek IMEDIATO no down tambem, pra resposta instantanea.
        fx.push({ do: 'seek', t: clampT(xToTime(ctx.layout.vp, ev.x), ctx) });
        return { next: { name: 'armed-empty', x0: ev.x, y0: ev.y }, effects: fx };
      }
      if (hit.type === 'ghost') {
        // Click em ghost reativa o clip (decidido no up — armed)
        return { next: { name: 'armed', hit, x0: ev.x, y0: ev.y, touch: !!ev.touch, gestureId: null }, effects: fx };
      }
      if (hit.type === 'trim-in' || hit.type === 'trim-out') {
        const c = ctx.layout.clips.find(k => k.clipId === hit.clipId);
        if (!c) return { next: fsm, effects: fx };
        fx.push({ do: 'set-cursor', cursor: 'ew-resize' });
        // cena CONGELADA: arrastar a borda estica/encolhe a duração (freeze_dur),
        // não corta o arquivo (é 1 frame). Estado dedicado.
        if (c.frozen) {
          return {
            next: {
              name: 'resizing-frozen', clipId: hit.clipId,
              edge: hit.type === 'trim-in' ? 'in' : 'out',
              tStart: c.tStart, tEnd: c.tEnd, previewDur: c.tEnd - c.tStart,
            },
            effects: fx,
          };
        }
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
        if (ev.ctrlKey) {
          // Ctrl+click: alterna na multi-selecao (CapCut) sem virar drag
          fx.push({ do: 'toggle-multi', itemType: 'clip', id: hit.clipId });
          return { next: fsm, effects: fx };
        }
        return { next: { name: 'armed', hit, x0: ev.x, y0: ev.y, touch: !!ev.touch, gestureId: null }, effects: fx };
      }
      if (hit.type === 'text-block') {
        if (ev.ctrlKey) {
          fx.push({ do: 'toggle-multi', itemType: 'text', id: hit.textId });
          return { next: fsm, effects: fx };
        }
        return { next: { name: 'armed', hit, x0: ev.x, y0: ev.y, touch: !!ev.touch, gestureId: null }, effects: fx };
      }
      if (hit.type === 'overlay-trim-in' || hit.type === 'overlay-trim-out') {
        const o = ctx.layout.overlayItems.find(k => k.overlayId === hit.overlayId);
        if (!o) return { next: fsm, effects: fx };
        fx.push({ do: 'set-cursor', cursor: 'ew-resize' });
        return {
          next: {
            name: 'trimming-overlay', overlayId: hit.overlayId,
            edge: hit.type === 'overlay-trim-in' ? 'in' : 'out',
            tStart0: o.tStart, tEnd0: o.tEnd, srcIn0: o.srcIn, srcOut0: o.srcOut,
            preview: hit.type === 'overlay-trim-in' ? o.tStart : o.tEnd,
          },
          effects: fx,
        };
      }
      if (hit.type === 'overlay-body') {
        if (ev.ctrlKey) {
          fx.push({ do: 'toggle-multi', itemType: 'overlay', id: hit.overlayId });
          return { next: fsm, effects: fx };
        }
        fx.push({ do: 'select-overlay', overlayId: hit.overlayId });
        return { next: { name: 'armed', hit, x0: ev.x, y0: ev.y, touch: !!ev.touch, gestureId: null }, effects: fx };
      }
      if (hit.type === 'audio-trim-in' || hit.type === 'audio-trim-out') {
        const a = ctx.layout.audioItems.find(k => k.audioId === hit.audioId);
        if (!a) return { next: fsm, effects: fx };
        const edge = hit.type === 'audio-trim-in' ? 'in' : 'out';
        fx.push({ do: 'set-cursor', cursor: 'ew-resize' });
        return {
          next: {
            name: 'trimming-audio', audioId: hit.audioId, edge,
            tStart0: a.tStart, tEnd0: a.tEnd,
            srcIn0: a.srcIn, srcOut0: a.srcOut,
            preview: edge === 'in' ? a.tStart : a.tEnd, // em tempo VIRTUAL
          },
          effects: fx,
        };
      }
      if (hit.type === 'audio-body') {
        if (ev.ctrlKey) {
          fx.push({ do: 'toggle-multi', itemType: 'audio', id: hit.audioId });
          return { next: fsm, effects: fx };
        }
        fx.push({ do: 'select-audio-clip', audioId: hit.audioId });
        return { next: { name: 'armed', hit, x0: ev.x, y0: ev.y, touch: !!ev.touch, gestureId: null }, effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'armed-empty': {
      // mouse desceu no vazio: clique = seek+limpa; arrasto = marquee
      if (ev.kind === 'move') {
        const dist = Math.hypot(ev.x - fsm.x0, ev.y - fsm.y0);
        if (dist < DRAG_THRESHOLD_MOUSE) return { next: fsm, effects: fx };
        return { next: { name: 'marquee', x0: fsm.x0, y0: fsm.y0, x1: ev.x, y1: ev.y }, effects: fx };
      }
      if (ev.kind === 'up') {
        fx.push({ do: 'clear-selection' });
        fx.push({ do: 'clear-multi' });
        fx.push({ do: 'seek', t: clampT(xToTime(ctx.layout.vp, fsm.x0), ctx) });
        return { next: idle(), effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'marquee': {
      // seletor retangular (área de trabalho do Windows): seleciona ao vivo
      if (ev.kind === 'move') {
        const next = { ...fsm, x1: ev.x, y1: ev.y };
        fx.push({ do: 'marquee-live', rect: rectOf(next) });
        return { next, effects: fx };
      }
      if (ev.kind === 'up') {
        fx.push({ do: 'marquee-apply', rect: rectOf(fsm) });
        return { next: idle(), effects: fx };
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
        if (fsm.hit.type === 'overlay-body') {
          const o = ctx.layout.overlayItems.find(k => k.overlayId === fsm.hit.overlayId);
          if (!o) return { next: idle(), effects: fx };
          const grabT = xToTime(ctx.layout.vp, fsm.x0);
          return {
            next: {
              name: 'dragging-overlay', overlayId: fsm.hit.overlayId,
              grabOffset: grabT - o.tStart, previewStart: o.tStart,
            },
            effects: fx,
          };
        }
        if (fsm.hit.type === 'audio-body') {
          const a = ctx.layout.audioItems.find(k => k.audioId === fsm.hit.audioId);
          if (!a) return { next: idle(), effects: fx };
          const grabT = xToTime(ctx.layout.vp, fsm.x0);
          return {
            next: {
              name: 'dragging-audio', audioId: fsm.hit.audioId,
              grabOffset: grabT - a.tStart,
              duration: a.tEnd - a.tStart,
              previewStart: a.tStart,
            },
            effects: fx,
          };
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
        // arrastar pra CIMA da track principal = criar camada (CapCut).
        // FLUIDO: NÃO converte no meio do arrasto — mostra um FANTASMA da nova
        // camada seguindo o cursor; a conversão acontece só ao SOLTAR (user
        // 2026-07-20: "quero ver a faixa sendo criada na hora que arrasto").
        const lifting = ev.y != null && ctx.layout.yVideo - ev.y > 24;
        if (lifting) {
          fx.push({ do: 'set-cursor', cursor: 'grabbing' });
          return { next: { ...fsm, lifting: true, liftX: ev.x, liftY: ev.y }, effects: fx };
        }
        // de volta na track principal: reordena (MOVE_CLIP coalescido) + ghost
        const target = dropIndexAt(ctx.layout, ev.x, fsm.clipId);
        if (target != null) {
          fx.push({ do: 'dispatch', action: { ...act.moveClip(fsm.clipId, target.arrayIndex), gestureId: fsm.gestureId } });
        }
        fx.push({ do: 'autoscroll-edge', x: ev.x });
        return { next: { ...fsm, lifting: false, liftX: ev.x, liftY: ev.y }, effects: fx };
      }
      if (ev.kind === 'up') {
        fx.push({ do: 'end-gesture' });
        if (fsm.lifting) {
          // solta em cima = cria a camada na posição/altura do drop
          const atT = Math.max(0, xToTime(ctx.layout.vp, fsm.liftX ?? ev.x));
          fx.push({ do: 'convert-to-overlay', clipId: fsm.clipId, atT, y: fsm.liftY ?? ev.y });
        }
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
          // takes extras tem duracao propria (clipMaxOut); principal usa a do video
          const maxOut = ctx.clipMaxOut?.[fsm.clipId] ?? (ctx.videoDuration || Infinity);
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

    case 'resizing-frozen': {
      if (ev.kind === 'move') {
        const vpT = xToTime(ctx.layout.vp, ev.x);
        let dur;
        if (fsm.edge === 'out') dur = vpT - fsm.tStart;          // borda direita
        else dur = fsm.tEnd - vpT;                                // borda esquerda
        dur = Math.max(MIN_CLIP_DURATION, Math.min(60, dur));
        return { next: { ...fsm, previewDur: dur }, effects: fx };
      }
      if (ev.kind === 'up') {
        fx.push({ do: 'dispatch', action: act.setFreezeDur(fsm.clipId, fsm.previewDur) });
        fx.push({ do: 'set-cursor', cursor: 'default' });
        return { next: idle(), effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'trimming-audio': {
      if (ev.kind === 'move') {
        const vpT = xToTime(ctx.layout.vp, ev.x);
        const points = defaultSnapPoints(ctx.cutPoints.filter(p =>
          Math.abs(p - fsm.tStart0) > 1e-6 && Math.abs(p - fsm.tEnd0) > 1e-6), ctx.playhead);
        const snapped = ctx.snapEnabled && !ev.shiftKey
          ? snapTime(vpT, points, ctx.layout.vp.pxPerSec)
          : { t: vpT, snapped: false };
        let preview = snapped.t;
        if (fsm.edge === 'in') {
          // borda esquerda: limitada pelo inicio do media e pelo minimo
          const minT = fsm.tStart0 - fsm.srcIn0;                     // source_in chegaria a 0
          const maxT = fsm.tEnd0 - MIN_CLIP_DURATION;
          preview = Math.min(Math.max(preview, Math.max(0, minT)), maxT);
        } else {
          const maxT = fsm.tStart0 + (ctx.audioMediaDur?.[fsm.audioId] ?? Infinity) - fsm.srcIn0;
          preview = Math.max(fsm.tStart0 + MIN_CLIP_DURATION, Math.min(preview, maxT));
        }
        fx.push({ do: 'show-snap', active: snapped.snapped, t: snapped.point });
        return { next: { ...fsm, preview }, effects: fx };
      }
      if (ev.kind === 'up') {
        const orig = fsm.edge === 'in' ? fsm.tStart0 : fsm.tEnd0;
        if (Math.abs(fsm.preview - orig) > 1e-4) {
          // FSM trabalha em tempo virtual; reducer espera:
          //   in  -> novo START desejado (value = novo tStart)
          //   out -> novo source_out (srcIn0 + (preview - tStart0))
          const value = fsm.edge === 'in'
            ? fsm.preview
            : fsm.srcIn0 + (fsm.preview - fsm.tStart0);
          fx.push({ do: 'dispatch', action: act.trimAudio(fsm.audioId, fsm.edge, value) });
        }
        fx.push({ do: 'show-snap', active: false });
        fx.push({ do: 'set-cursor', cursor: 'default' });
        return { next: idle(), effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'dragging-audio': {
      if (ev.kind === 'move') {
        const t = xToTime(ctx.layout.vp, ev.x) - fsm.grabOffset;
        const snapped = ctx.snapEnabled && !ev.shiftKey
          ? snapTime(t, defaultSnapPoints(ctx.cutPoints, ctx.playhead), ctx.layout.vp.pxPerSec)
          : { t, snapped: false };
        const previewStart = Math.max(0, snapped.t);
        fx.push({ do: 'show-snap', active: snapped.snapped, t: snapped.point });
        return { next: { ...fsm, previewStart }, effects: fx };
      }
      if (ev.kind === 'up') {
        fx.push({ do: 'dispatch', action: act.moveAudio(fsm.audioId, fsm.previewStart) });
        fx.push({ do: 'show-snap', active: false });
        return { next: idle(), effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'trimming-overlay': {
      if (ev.kind === 'move') {
        const vpT = xToTime(ctx.layout.vp, ev.x);
        const points = defaultSnapPoints(ctx.cutPoints.filter(pt =>
          Math.abs(pt - fsm.tStart0) > 1e-6 && Math.abs(pt - fsm.tEnd0) > 1e-6), ctx.playhead);
        const snapped = ctx.snapEnabled && !ev.shiftKey
          ? snapTime(vpT, points, ctx.layout.vp.pxPerSec)
          : { t: vpT, snapped: false };
        let preview = snapped.t;
        if (fsm.edge === 'in') {
          const minT = fsm.tStart0 - fsm.srcIn0;
          preview = Math.min(Math.max(preview, Math.max(0, minT)), fsm.tEnd0 - MIN_CLIP_DURATION);
        } else {
          const maxT = fsm.tStart0 + (ctx.videoDuration || Infinity) - fsm.srcIn0;
          preview = Math.max(fsm.tStart0 + MIN_CLIP_DURATION, Math.min(preview, maxT));
        }
        fx.push({ do: 'show-snap', active: snapped.snapped, t: snapped.point });
        return { next: { ...fsm, preview }, effects: fx };
      }
      if (ev.kind === 'up') {
        const orig = fsm.edge === 'in' ? fsm.tStart0 : fsm.tEnd0;
        if (Math.abs(fsm.preview - orig) > 1e-4) {
          const value = fsm.edge === 'in'
            ? fsm.preview
            : fsm.srcIn0 + (fsm.preview - fsm.tStart0);
          fx.push({ do: 'dispatch', action: act.trimOverlay(fsm.overlayId, fsm.edge, value) });
        }
        fx.push({ do: 'show-snap', active: false });
        fx.push({ do: 'set-cursor', cursor: 'default' });
        return { next: idle(), effects: fx };
      }
      return { next: fsm, effects: fx };
    }

    case 'dragging-overlay': {
      if (ev.kind === 'move') {
        const t = xToTime(ctx.layout.vp, ev.x) - fsm.grabOffset;
        const snapped = ctx.snapEnabled && !ev.shiftKey
          ? snapTime(t, defaultSnapPoints(ctx.cutPoints, ctx.playhead), ctx.layout.vp.pxPerSec)
          : { t, snapped: false };
        const previewStart = Math.max(0, snapped.t);
        fx.push({ do: 'show-snap', active: snapped.snapped, t: snapped.point });
        return { next: { ...fsm, previewStart, lastY: ev.y ?? fsm.lastY }, effects: fx };
      }
      if (ev.kind === 'up') {
        fx.push({ do: 'dispatch', action: act.moveOverlay(fsm.overlayId, fsm.previewStart) });
        // arrasto VERTICAL muda a camada (row sob o cursor no drop)
        const dropY = ev.y ?? fsm.lastY;
        if (dropY != null) fx.push({ do: 'drop-lane', itemType: 'overlay', id: fsm.overlayId, y: dropY });
        fx.push({ do: 'show-snap', active: false });
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
        return { next: { ...fsm, lastY: ev.y ?? fsm.lastY }, effects: fx };
      }
      if (ev.kind === 'up') {
        fx.push({ do: 'end-gesture' });
        // arrasto vertical: texto muda de camada (pode ficar ATRAS de video)
        const dropY = ev.y ?? fsm.lastY;
        if (dropY != null) fx.push({ do: 'drop-lane', itemType: 'text', id: fsm.textId, y: dropY });
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

function rectOf(m) {
  return {
    x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1),
    w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0),
  };
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
