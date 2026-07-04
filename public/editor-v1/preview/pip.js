// editor-v1/preview/pip.js
// Overlay de video no PREVIEW (PiP estilo CapCut): mostra a camada ativa no
// tempo atual, posicionavel por arrasto e escalavel por scroll/pinch.
// A camada de CIMA (ultima do array) aparece na frente.

import * as act from '../core/actions.js';

export function createPip(container, videoSrcEl, store, player) {
  const el = document.createElement('video');
  el.muted = true;            // audio da camada nao toca no preview (v1)
  el.playsInline = true;
  el.preload = 'auto';
  el.style.cssText = 'position:absolute;display:none;pointer-events:auto;cursor:grab;' +
    'border:1.5px dashed rgba(169,127,238,.0);border-radius:6px;object-fit:contain;' +
    'transform:translate(-50%,-50%);touch-action:none;z-index:5;';
  container.appendChild(el);

  let currentOv = null;
  let dragging = null;

  function activeOverlayAt(state, t) {
    const list = (state.overlays || []).filter(o =>
      o.active !== false && t >= o.start - 1e-6 && t < o.start + (o.source_out - o.source_in));
    return list.length ? list[list.length - 1] : null; // topo = frente
  }

  function render() {
    const state = store.getState();
    const t = player.getTime();
    const ov = activeOverlayAt(state, t);
    if (!ov) {
      if (el.style.display !== 'none') { el.pause(); el.style.display = 'none'; }
      currentOv = null;
      return;
    }
    if (!el.src && videoSrcEl.currentSrc) el.src = videoSrcEl.currentSrc;
    else if (videoSrcEl.currentSrc && el.dataset.src !== videoSrcEl.currentSrc) {
      el.src = videoSrcEl.currentSrc;
      el.dataset.src = videoSrcEl.currentSrc;
    }
    currentOv = ov;
    el.style.display = 'block';
    el.style.left = (ov.x_pct * 100) + '%';
    el.style.top = (ov.y_pct * 100) + '%';
    el.style.width = (ov.scale * 100) + '%';
    el.style.borderColor = state.selected_overlay_id === ov.id
      ? 'rgba(169,127,238,.95)' : 'rgba(169,127,238,0)';
    const local = ov.source_in + (t - ov.start);
    if (Math.abs(el.currentTime - local) > 0.2) {
      try { el.currentTime = local; } catch {}
    }
    if (player.isPlaying() && el.paused) el.play().catch(() => {});
    if (!player.isPlaying() && !el.paused) el.pause();
  }

  // drag posicao + wheel escala (commit coalescido por gesto)
  let gestureSeq = 1;
  el.addEventListener('pointerdown', (e) => {
    if (!currentOv) return;
    e.preventDefault(); e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    store.dispatch(act.selectOverlay(currentOv.id));
    dragging = {
      id: currentOv.id, pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      ox: currentOv.x_pct, oy: currentOv.y_pct,
      g: 'pip' + (gestureSeq++),
    };
    el.style.cursor = 'grabbing';
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging || dragging.pointerId !== e.pointerId) return;
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
    if (!dragging || dragging.pointerId !== e.pointerId) return;
    dragging = null;
    el.style.cursor = 'grab';
    store.endGesture();
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('wheel', (e) => {
    if (!currentOv) return;
    e.preventDefault();
    const s = store.getState().overlays.find(o => o.id === currentOv.id)?.scale ?? 0.5;
    store.dispatch({
      ...act.setOverlayTransform(currentOv.id, { scale: s * (e.deltaY < 0 ? 1.08 : 1 / 1.08) }),
      gestureId: 'pipscale',
    });
  }, { passive: false });
  el.addEventListener('wheel', () => store.endGesture());

  const unsub = store.subscribe(render);
  const unsubP = player.onUpdate(render);
  render();

  return {
    destroy() {
      unsub(); unsubP();
      el.pause(); el.remove();
    },
  };
}
