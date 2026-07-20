// editor-v1/preview/pip.js
// Camadas de video no PREVIEW (CapCut): TODAS as camadas ativas no tempo
// atual renderizam simultaneamente, empilhadas por LANE (lane maior = na
// frente; interleava com os textos via z-index compartilhado 10+lane).
// Cada camada tem seu proprio <video>; posicionavel por arrasto e escalavel
// por scroll (a selecionada).

import * as act from '../core/actions.js';
import { effectiveOverlays } from '../core/selectors.js';

export function createPip(container, videoSrcEl, store, player) {
  const pool = new Map(); // overlay.id -> <video>
  let dragging = null;
  let gestureSeq = 1;

  function makeEl(ovId) {
    const el = document.createElement('video');
    el.muted = true;            // audio da camada nao toca no preview (v1)
    el.playsInline = true;
    el.preload = 'auto';
    el.style.cssText = 'position:absolute;pointer-events:auto;cursor:grab;' +
      'border:1.5px dashed rgba(169,127,238,0);border-radius:6px;object-fit:contain;' +
      'transform:translate(-50%,-50%);touch-action:none;';
    el.dataset.ovId = ovId;
    wireGestures(el);
    container.appendChild(el);
    return el;
  }

  function activeOverlays(state, t) {
    return effectiveOverlays(state).filter(o =>
      t >= o.start - 1e-6 && t < o.start + (o.source_out - o.source_in));
  }

  function render() {
    const state = store.getState();
    const t = player.getTime();
    const ativos = activeOverlays(state, t);
    const vistos = new Set();
    for (const ov of ativos) {
      vistos.add(String(ov.id));
      let el = pool.get(String(ov.id));
      if (!el) { el = makeEl(String(ov.id)); pool.set(String(ov.id), el); }
      const src = videoSrcEl.currentSrc || videoSrcEl.src;
      if (src && el.dataset.src !== src) { el.src = src; el.dataset.src = src; }
      el.style.display = 'block';
      el.style.left = (ov.x_pct * 100) + '%';
      el.style.top = (ov.y_pct * 100) + '%';
      el.style.width = (ov.scale * 100) + '%';
      // z compartilhado com os textos do overlay.js: lane MAIOR = na frente
      el.style.zIndex = String(10 + (ov.lane || 1));
      el.style.borderColor = state.selected_overlay_id === ov.id
        ? 'rgba(169,127,238,.95)' : 'rgba(169,127,238,0)';
      const local = ov.source_in + (t - ov.start);
      if (Math.abs(el.currentTime - local) > 0.2) {
        try { el.currentTime = local; } catch {}
      }
      if (player.isPlaying() && el.paused) el.play().catch(() => {});
      if (!player.isPlaying() && !el.paused) el.pause();
    }
    // esconde/limpa os que sairam do tempo
    for (const [id, el] of pool) {
      if (!vistos.has(id)) {
        if (el.style.display !== 'none') { el.pause(); el.style.display = 'none'; }
      }
    }
  }

  function ovIdOf(el) {
    const raw = el.dataset.ovId;
    const n = Number(raw);
    return Number.isFinite(n) && String(n) === raw ? n : raw; // compostos tem id string
  }

  function wireGestures(el) {
    el.addEventListener('pointerdown', (e) => {
      const id = ovIdOf(el);
      const state = store.getState();
      const ov = state.overlays.find(o => o.id === id);
      if (!ov) return; // camada de composto: nao editavel aqui
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      store.dispatch(act.selectOverlay(id));
      dragging = {
        id, el, pointerId: e.pointerId,
        x0: e.clientX, y0: e.clientY,
        ox: ov.x_pct, oy: ov.y_pct,
        g: 'pip' + (gestureSeq++),
      };
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || dragging.el !== el || dragging.pointerId !== e.pointerId) return;
      const box = container.getBoundingClientRect();
      store.dispatch({
        ...act.setOverlayTransform(dragging.id, {
          x_pct: dragging.ox + (e.clientX - dragging.x0) / box.width,
          y_pct: dragging.oy + (e.clientY - dragging.y0) / box.height,
        }),
        gestureId: dragging.g,
      });
    });
    const endDrag = (e) => {
      if (!dragging || dragging.el !== el || dragging.pointerId !== e.pointerId) return;
      dragging = null;
      el.style.cursor = 'grab';
      store.endGesture();
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('wheel', (e) => {
      const id = ovIdOf(el);
      const ov = store.getState().overlays.find(o => o.id === id);
      if (!ov) return;
      e.preventDefault();
      store.dispatch({
        ...act.setOverlayTransform(id, { scale: (ov.scale ?? 1) * (e.deltaY < 0 ? 1.08 : 1 / 1.08) }),
        gestureId: 'pipscale',
      });
      store.endGesture();
    }, { passive: false });
  }

  const unsub = store.subscribe(render);
  const unsubP = player.onUpdate(render);
  render();

  return {
    destroy() {
      unsub(); unsubP();
      for (const [, el] of pool) { el.pause(); el.remove(); }
      pool.clear();
    },
  };
}
