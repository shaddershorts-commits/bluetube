// editor-v1/preview/pip.js
// Camadas de video no PREVIEW (CapCut): TODAS as camadas ativas no tempo
// atual renderizam simultaneamente, empilhadas por LANE (lane maior = na
// frente; interleava com os textos via z-index compartilhado 10+lane).
// Cada camada tem seu proprio <video>; posicionavel por arrasto e escalavel
// por scroll (a selecionada).

import * as act from '../core/actions.js';
import { effectiveOverlays, mediaUrlFor, overlayTimelineDur, clipSpeed } from '../core/selectors.js';

export function createPip(container, videoSrcEl, store, player) {
  const pool = new Map(); // overlay.id -> <video>
  let dragging = null;
  let gestureSeq = 1;

  function makeEl(ovId, kind) {
    // imagem (PNG/sticker com transparência) usa <img>; camada de vídeo usa <video>
    const el = document.createElement(kind === 'image' ? 'img' : 'video');
    if (kind !== 'image') { el.muted = true; el.playsInline = true; el.preload = 'auto'; }
    // ⚠️ object-fit por TIPO (bug 2026-07-29: "corto o vídeo, movo pra cima e
    // ele aparece com bordas pretas — não é pra mudar NADA no vídeo"):
    //  · VÍDEO: `cover`, igual à faixa principal (que também corta pra
    //    preencher). Virar camada não pode reenquadrar a cena sozinho.
    //  · IMAGEM: `contain` — um sticker/PNG tem proporção PRÓPRIA e cortá-lo
    //    seria destruir o desenho.
    el.style.cssText = 'position:absolute;pointer-events:auto;cursor:grab;' +
      'border:1.5px dashed rgba(169,127,238,0);border-radius:6px;' +
      'object-fit:' + (kind === 'image' ? 'contain' : 'cover') + ';' +
      'transform-origin:center;touch-action:none;';
    el.dataset.ovId = ovId;
    el.dataset.kind = kind || 'video';
    wireGestures(el);
    container.appendChild(el);
    return el;
  }

  // alça de GIRAR (bolinha acima do overlay selecionado). Arrastar = rotaciona.
  let rotHandle = null;
  function ensureRotHandle() {
    if (rotHandle) return rotHandle;
    rotHandle = document.createElement('div');
    rotHandle.style.cssText = 'position:absolute;width:18px;height:18px;border-radius:50%;' +
      'background:#a97fee;border:2px solid #fff;cursor:grab;z-index:999;display:none;' +
      'transform:translate(-50%,-50%);box-shadow:0 1px 4px rgba(0,0,0,.4);touch-action:none;';
    rotHandle.title = 'Girar';
    rotHandle.innerHTML = '<span style="font-size:11px;position:absolute;top:2px;left:3px">⟳</span>';
    wireRotate(rotHandle);
    container.appendChild(rotHandle);
    return rotHandle;
  }
  function wireRotate(h) {
    let rot = null;
    h.addEventListener('pointerdown', (e) => {
      const id = store.getState().selected_overlay_id;
      const ov = store.getState().overlays.find(o => o.id === id);
      if (!ov) return;
      e.preventDefault(); e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const box = container.getBoundingClientRect();
      rot = { id, cx: box.left + ov.x_pct * box.width, cy: box.top + ov.y_pct * box.height, g: 'rot' + (gestureSeq++) };
    });
    h.addEventListener('pointermove', (e) => {
      if (!rot) return;
      const ang = Math.atan2(e.clientY - rot.cy, e.clientX - rot.cx) * 180 / Math.PI + 90;
      store.dispatch({ ...act.setOverlayTransform(rot.id, { rotation: ang }), gestureId: rot.g });
    });
    const end = () => { if (rot) { rot = null; store.endGesture(); } };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }

  function activeOverlays(state, t) {
    return effectiveOverlays(state).filter(o =>
      t >= o.start - 1e-6 && t < o.start + overlayTimelineDur(o));
  }

  function render() {
    const state = store.getState();
    const t = player.getTime();
    const ativos = activeOverlays(state, t);
    const vistos = new Set();
    for (const ov of ativos) {
      vistos.add(String(ov.id));
      const kind = ov.kind === 'image' ? 'image' : 'video';
      let el = pool.get(String(ov.id));
      if (!el || el.dataset.kind !== kind) {
        if (el) { el.remove(); }
        el = makeEl(String(ov.id), kind);
        pool.set(String(ov.id), el);
      }
      const src = kind === 'image'
        ? ov.url
        // multi-take: camada de take usa a midia DELA; camada do principal usa
        // a escolha do shell (blob local > CDN)
        : (ov.media_id != null ? mediaUrlFor(state, ov)
           : (videoSrcEl.dataset.primaryChoice || videoSrcEl.currentSrc || videoSrcEl.src));
      if (src && el.dataset.src !== src) { el.src = src; el.dataset.src = src; }
      el.style.display = 'block';
      el.style.left = (ov.x_pct * 100) + '%';
      el.style.top = (ov.y_pct * 100) + '%';
      el.style.width = (ov.scale * 100) + '%';
      // a caixa da camada de VÍDEO tem a proporção do QUADRO (largura% e
      // altura% do mesmo palco): com object-fit:cover o vídeo preenche
      // cortando o excedente — exatamente o que a faixa principal faz.
      // Imagem fica com altura automática pra manter a proporção dela.
      if (kind !== 'image') el.style.height = (ov.scale * 100) + '%';
      el.style.transform = `translate(-50%,-50%) rotate(${ov.rotation || 0}deg)`;
      // z compartilhado com os textos do overlay.js: lane MAIOR = na frente
      el.style.zIndex = String(10 + (ov.lane || 1));
      const sel = state.selected_overlay_id === ov.id;
      el.style.borderColor = sel ? 'rgba(169,127,238,.95)' : 'rgba(169,127,238,0)';
      if (sel) {
        // alça de girar acima da imagem/camada
        const h = ensureRotHandle();
        const box = container.getBoundingClientRect();
        const cx = ov.x_pct * box.width;
        const topY = ov.y_pct * box.height - (el.offsetHeight / 2) - 22;
        h.style.left = cx + 'px';
        h.style.top = Math.max(10, topY) + 'px';
        h.style.zIndex = String(10 + (ov.lane || 1) + 1);
        h.style.display = 'block';
      }
      if (kind === 'video') {
        const sp = clipSpeed(ov);
        el.playbackRate = sp;                          // camada acelerada
        // O SOM DA CAMADA TOCA (user 14/08). O elemento NASCE muted (makeEl)
        // pro el.play() passar sem gesto; aqui, a cada tick, o mudo segue o
        // documento — igual ao vidMuted() da cena principal. Pausado fica mudo
        // (scrub não pode vazar áudio).
        el.muted = !!ov.muted || !player.isPlaying();
        const local = ov.source_in + (t - ov.start) * sp;
        if (Math.abs(el.currentTime - local) > 0.2 * sp) {
          try { el.currentTime = local; } catch {}
        }
        if (player.isPlaying() && el.paused) el.play().catch(() => {});
        if (!player.isPlaying() && !el.paused) el.pause();
      }
    }
    // esconde/limpa os que sairam do tempo
    for (const [id, el] of pool) {
      if (!vistos.has(id)) {
        if (el.style.display !== 'none') { el.pause?.(); el.style.display = 'none'; }
      }
    }
    // alça de girar: só quando o overlay selecionado está ativo agora
    if (rotHandle && !vistos.has(String(state.selected_overlay_id))) {
      rotHandle.style.display = 'none';
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
      for (const [, el] of pool) { el.pause?.(); el.remove(); }
      rotHandle?.remove();
      pool.clear();
    },
  };
}
