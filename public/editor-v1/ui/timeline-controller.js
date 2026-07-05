// editor-v1/ui/timeline-controller.js
// Adapter DOM da timeline: UNICO dono dos pointer events do canvas.
// Converte eventos -> FSM pura -> executa effects. Nenhuma logica de negocio
// aqui: so traducao evento<->efeito.

import { computeLayout, zoomAt, zoomToFit, METRICS } from '../timeline/layout.js';
import { hitTest } from '../timeline/hittest.js';
import { transition, idle, LONG_PRESS_MS } from '../timeline/interaction.js';
import { createRenderer } from '../timeline/render.js';
import { cutPoints, totalDuration } from '../core/selectors.js';
import { A } from '../core/actions.js';
import * as act from '../core/actions.js';

export function createTimelineController({ canvas, store, player, onEditText, onOpenCompound }) {
  // width 0 = "ainda nao medido" -> zoomFit vira pendingFit ate o RO medir
  let vp = { pxPerSec: 40, scrollX: 0, width: 0, height: 200 };
  let fsm = idle();
  let snapIndicator = { active: false, t: null };
  let thumbs = null;
  let wave = null;
  let videoWave = null;
  let longPressTimer = 0;
  const pointers = new Map(); // pointerId -> {x,y}
  const renderer = createRenderer(canvas);

  // ── render pipeline ──
  function layoutNow() {
    return computeLayout(store.getState(), vp);
  }
  function ctxNow() {
    const state = store.getState();
    return {
      layout: layoutNow(),
      playhead: player.getTime(),
      cutPoints: cutPoints(state),
      snapEnabled: true,
      videoDuration: state.video?.duration || 0,
    };
  }
  function draw() {
    renderer.draw({
      layout: layoutNow(),
      playhead: player.getTime(),
      fsm,
      snapIndicator,
      thumbs,
      wave,
      videoWave,
      dpr: Math.min(2, window.devicePixelRatio || 1),
    });
  }

  // ── effects executor ──
  function runEffects(effects) {
    for (const e of effects || []) {
      switch (e.do) {
        case 'dispatch': {
          let action = e.action;
          if (action.type === A.MOVE_CLIP) action = remapMove(action);
          store.dispatch(action);
          break;
        }
        case 'seek': player.seek(e.t); break;
        case 'select-clip': store.dispatch(act.selectClip(e.clipId)); break;
        case 'select-text': store.dispatch(act.selectText(e.textId)); break;
        case 'clear-selection': store.dispatch(act.selectClip(null)); break;
        case 'select-audio-clip': store.dispatch(act.selectAudioClip(e.audioId)); break;
        case 'select-overlay': store.dispatch(act.selectOverlay(e.overlayId)); break;
        case 'convert-to-overlay': store.dispatch(act.convertToOverlay(e.clipId, e.atT)); break;
        case 'toggle-multi': store.dispatch(act.toggleMultiSelect(e.itemType, e.id)); break;
        case 'open-compound': onOpenCompound?.(e.compoundId); break;
        case 'zoom': vp = { ...vp, pxPerSec: e.pxPerSec, scrollX: clampScroll(e.scrollX, e.pxPerSec) }; draw(); break;
        case 'scroll': vp = { ...vp, scrollX: clampScroll(e.scrollX, vp.pxPerSec) }; draw(); break;
        case 'end-gesture': store.endGesture(); break;
        case 'abort-gesture': store.undo(); break;
        case 'set-cursor': canvas.style.cursor = e.cursor || 'default'; break;
        case 'show-snap': snapIndicator = { active: !!e.active, t: e.t ?? null }; draw(); break;
        case 'open-text-editor': onEditText?.(e.textId); break;
        case 'haptic': try { navigator.vibrate?.(30); } catch {} break;
        case 'autoscroll-edge': autoscroll(e.x); break;
      }
    }
  }

  /** FSM entrega visIndex entre clips ATIVOS (sem o arrastado). Converte pro
   *  indice real do array state.clips. */
  function remapMove(action) {
    const state = store.getState();
    const dragged = state.clips.find(c => c.id === action.clipId);
    if (!dragged) return action;
    const activesExcl = state.clips.filter(c => c.active !== false && c.id !== action.clipId);
    const visIndex = Math.min(action.toIndex, activesExcl.length);
    let arrayIndex;
    if (visIndex >= activesExcl.length) {
      // depois do ultimo ativo
      const last = activesExcl[activesExcl.length - 1];
      arrayIndex = last ? state.clips.filter(c => c.id !== action.clipId).indexOf(last) + 1 : 0;
    } else {
      const target = activesExcl[visIndex];
      arrayIndex = state.clips.filter(c => c.id !== action.clipId).indexOf(target);
    }
    // reducer faz splice(from,1) + splice(to,0): to é indice no array pos-remocao
    return { ...action, toIndex: arrayIndex };
  }

  function autoscroll(x) {
    const EDGE = 40, SPEED = 14;
    if (x < EDGE) { vp = { ...vp, scrollX: clampScroll(vp.scrollX - SPEED, vp.pxPerSec) }; draw(); }
    else if (x > vp.width - EDGE) { vp = { ...vp, scrollX: clampScroll(vp.scrollX + SPEED, vp.pxPerSec) }; draw(); }
  }

  /** Scroll nunca deixa o conteudo 100% fora da tela: clamp entre -PAD_LEFT
   *  e (fim do conteudo - 20% da largura visivel). Ghosts contam no range. */
  function clampScroll(scrollX, pxPerSec) {
    const state = store.getState();
    const total = totalDuration(state);
    const inactive = (state.clips || []).filter(c => c.active === false)
      .reduce((a, c) => a + (c.source_out - c.source_in) + 0.5, 0);
    const contentEnd = (total + (inactive ? 1 + inactive : 0)) * pxPerSec;
    const maxScroll = Math.max(-METRICS.PAD_LEFT, contentEnd - vp.width * 0.2);
    return Math.min(maxScroll, Math.max(-METRICS.PAD_LEFT, scrollX));
  }

  // ── pointer events (unico listener) ──
  function evFrom(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, touch: e.pointerType === 'touch' };
  }

  function step(ev) {
    const r = transition(fsm, ev, ctxNow());
    fsm = r.next;
    runEffects(r.effects);
    draw();
  }

  // long-press em touch dispara contextmenu nativo -> cancelaria o gesto
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = evFrom(e);
    pointers.set(e.pointerId, p);

    if (pointers.size === 2) {
      // segundo dedo -> pinch
      const [p1, p2] = [...pointers.values()];
      step({ kind: 'second-down', x: p.x, y: p.y, d: dist(p1, p2), cx: (p1.x + p2.x) / 2 });
      return;
    }
    const hit = hitTest(layoutNow(), p.x, p.y, { touch: p.touch });
    clearTimeout(longPressTimer);
    if (p.touch) {
      longPressTimer = setTimeout(() => step({ kind: 'longpress' }), LONG_PRESS_MS);
    }
    step({ kind: 'down', ...p, hit, button: e.button, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      // hover: cursor affordance
      if (fsm.name === 'idle') {
        const p = evFrom(e);
        const hit = hitTest(layoutNow(), p.x, p.y);
        canvas.style.cursor =
          hit.type === 'trim-in' || hit.type === 'trim-out' ? 'ew-resize' :
          hit.type === 'clip-body' || hit.type === 'text-block' ? 'grab' :
          hit.type === 'ruler' ? 'col-resize' : 'default';
      }
      return;
    }
    const p = evFrom(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2 && fsm.name === 'pinching') {
      const [p1, p2] = [...pointers.values()];
      step({ kind: 'pinch-move', d: dist(p1, p2), cx: (p1.x + p2.x) / 2 });
      return;
    }
    // movimento cancela long-press pendente se passou threshold
    step({ kind: 'move', ...p, shiftKey: e.shiftKey });
  });

  function release(e, kind) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    clearTimeout(longPressTimer);
    const p = evFrom(e);
    if (fsm.name === 'pinching' && pointers.size === 1) {
      const rest = [...pointers.values()][0];
      step({ kind: 'pinch-end', x: rest.x, y: rest.y });
      return;
    }
    step({ kind, ...p });
  }
  canvas.addEventListener('pointerup', (e) => release(e, 'up'));
  canvas.addEventListener('pointercancel', (e) => release(e, 'cancel'));

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = evFrom(e);
    step({ kind: 'wheel', ...p, deltaY: e.deltaY, deltaX: e.deltaX, ctrlKey: e.ctrlKey || e.metaKey });
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const p = evFrom(e);
    const hit = hitTest(layoutNow(), p.x, p.y);
    step({ kind: 'dblclick', ...p, hit });
  });

  // Esc global (quando canvas focado ou nao — gesto ativo deve abortar sempre)
  const escHandler = (e) => { if (e.key === 'Escape' && fsm.name !== 'idle') step({ kind: 'esc' }); };
  window.addEventListener('keydown', escHandler);

  // ── resize ──
  // pendingFit: zoomFit chamado antes do canvas ter medida real (parent era
  // display:none) fica pendente e executa na primeira medicao valida do RO.
  let pendingFit = false;
  function doFit() {
    const z = zoomToFit(store.getState(), vp.width);
    vp = { ...vp, ...z };
    draw();
  }
  const ro = new ResizeObserver((entries) => {
    const r = entries[0].contentRect;
    const widthChanged = Math.abs(r.width - vp.width) > 1;
    vp = { ...vp, width: r.width, height: r.height };
    if (pendingFit && r.width > 50) {
      pendingFit = false;
      doFit();
      return;
    }
    if (widthChanged) vp = { ...vp, scrollX: clampScroll(vp.scrollX, vp.pxPerSec) };
    draw();
  });
  ro.observe(canvas.parentElement || canvas);

  // ── subscriptions ──
  const unsubStore = store.subscribe(() => draw());
  const unsubPlayer = player.onUpdate(() => draw());

  draw();

  return {
    draw,
    getViewport: () => vp,
    zoomFit() {
      if (vp.width < 50) { pendingFit = true; return; }
      doFit();
    },
    zoomBy(factor) {
      const z = zoomAt(vp, factor, vp.width / 2);
      vp = { ...vp, pxPerSec: z.pxPerSec, scrollX: clampScroll(z.scrollX, z.pxPerSec) };
      draw();
    },
    /** playhead sempre visivel (chamado no play) */
    followPlayhead() {
      const x = METRICS.PAD_LEFT + player.getTime() * vp.pxPerSec - vp.scrollX;
      if (x < 0 || x > vp.width - 60) {
        vp = { ...vp, scrollX: Math.max(-METRICS.PAD_LEFT, player.getTime() * vp.pxPerSec - vp.width * 0.3) };
        draw();
      }
    },
    setThumbs(t) { thumbs = t; draw(); },
    setWave(w) { wave = w; draw(); },
    setVideoWave(w) { videoWave = w; draw(); },
    getFsmName: () => fsm.name,
    destroy() {
      renderer.destroy();
      ro.disconnect();
      unsubStore(); unsubPlayer();
      window.removeEventListener('keydown', escHandler);
      clearTimeout(longPressTimer);
    },
  };
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
