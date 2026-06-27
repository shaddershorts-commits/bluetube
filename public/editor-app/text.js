/* ═══════════════════════════════════════════════════════════════════════════
   text.js — Texto overlay WYSIWYG sobre o player
   ═══════════════════════════════════════════════════════════════════════════
   Renderiza textos do state.texts em canvas absolute sobre o video, sincronizado
   pixel-perfect com o source resolution. Permite drag pra reposicionar.

   Pra preservar fidelidade entre preview e export, posições sao em PCT (0-1)
   do source. Backend FFmpeg drawtext usa as mesmas coordenadas.

   Tamanhos relativos:
     small  = sourceWidth * 0.04
     medium = sourceWidth * 0.06
     large  = sourceWidth * 0.09
     xlarge = sourceWidth * 0.13
   ═══════════════════════════════════════════════════════════════════════════ */

window.BEText = (function() {
  'use strict';

  let overlayEl = null;     // <canvas> overlay
  let ctxOverlay = null;
  let videoEl = null;
  let frameEl = null;
  let dprOverlay = 1;
  let rafId = null;
  let dragging = null;     // { textId, startX, startY, startXPct, startYPct }
  let selectedTextId = null;

  const SIZE_MAP = {
    small: 0.04,
    medium: 0.06,
    large: 0.09,
    xlarge: 0.13,
  };

  function fontFamily(name) {
    if (name === 'Bebas Neue') return '"Bebas Neue", "Anton", sans-serif';
    if (name === 'Oswald') return '"Oswald", sans-serif';
    if (name === 'Inter') return '"Inter", -apple-system, sans-serif';
    return '"Anton", "Bebas Neue", sans-serif';
  }

  function ensureOverlay() {
    frameEl = document.getElementById('previewFrame');
    videoEl = document.getElementById('previewVideo');
    if (!frameEl) return false;
    overlayEl = frameEl.querySelector('canvas.text-overlay');
    if (!overlayEl) {
      overlayEl = document.createElement('canvas');
      overlayEl.className = 'text-overlay';
      overlayEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:auto;z-index:3;';
      frameEl.appendChild(overlayEl);
      bindOverlayInput();
    }
    ctxOverlay = overlayEl.getContext('2d');
    resizeOverlay();
    return true;
  }

  function resizeOverlay() {
    if (!overlayEl || !frameEl) return;
    const rect = frameEl.getBoundingClientRect();
    dprOverlay = Math.max(1, window.devicePixelRatio || 1);
    overlayEl.width = Math.max(1, Math.floor(rect.width * dprOverlay));
    overlayEl.height = Math.max(1, Math.floor(rect.height * dprOverlay));
    overlayEl.style.width = rect.width + 'px';
    overlayEl.style.height = rect.height + 'px';
    if (ctxOverlay) ctxOverlay.setTransform(dprOverlay, 0, 0, dprOverlay, 0, 0);
  }

  // ─── Render loop ───────────────────────────────────────────────────────
  function tick() {
    render();
    rafId = requestAnimationFrame(tick);
  }
  function start() {
    if (rafId) return;
    rafId = requestAnimationFrame(tick);
  }

  function render() {
    if (!overlayEl || !ctxOverlay || !videoEl) return;
    const rect = frameEl.getBoundingClientRect();
    if (rect.width === 0) return;
    // Resize se mudou
    if (Math.abs(overlayEl.clientWidth - rect.width) > 1 || Math.abs(overlayEl.clientHeight - rect.height) > 1) {
      resizeOverlay();
    }
    const w = rect.width;
    const h = rect.height;
    ctxOverlay.clearRect(0, 0, w, h);

    const t = videoEl.currentTime || 0;
    const s = BEState.get();
    const sourceWidth = s.video.width || 1080;
    const sourceHeight = s.video.height || 1920;
    // Calcula a area de RENDER do video dentro do frame (object-fit:contain)
    const videoRatio = sourceWidth / sourceHeight;
    const frameRatio = w / h;
    let videoRenderW, videoRenderH, offsetX, offsetY;
    if (videoRatio > frameRatio) {
      videoRenderW = w;
      videoRenderH = w / videoRatio;
      offsetX = 0;
      offsetY = (h - videoRenderH) / 2;
    } else {
      videoRenderH = h;
      videoRenderW = h * videoRatio;
      offsetX = (w - videoRenderW) / 2;
      offsetY = 0;
    }

    const texts = BEState.getActiveTextsAt ? BEState.getActiveTextsAt(t) : [];
    for (const tx of texts) {
      drawText(tx, offsetX, offsetY, videoRenderW, videoRenderH);
    }
    // Render texto selecionado mesmo fora do tempo se for o caso (pra preview de edicao)
    if (selectedTextId) {
      const found = BEState.findText && BEState.findText(selectedTextId);
      const selText = found && found.text;
      if (selText && !texts.find(t2 => t2.id === selText.id)) {
        // Renderiza com opacidade pra indicar "fora do tempo"
        ctxOverlay.save();
        ctxOverlay.globalAlpha = 0.5;
        drawText(selText, offsetX, offsetY, videoRenderW, videoRenderH);
        ctxOverlay.restore();
      }
    }
  }

  function drawText(tx, offsetX, offsetY, vw, vh) {
    const s = BEState.get();
    const sourceWidth = s.video.width || 1080;
    const sizePct = SIZE_MAP[tx.size] || SIZE_MAP.medium;
    // Tamanho fonte em px do preview: proporcional ao tamanho relativo do source no preview
    const fontSizePx = sizePct * vw;
    const x = offsetX + tx.x_pct * vw;
    const y = offsetY + tx.y_pct * vh;
    ctxOverlay.save();
    ctxOverlay.font = `900 ${fontSizePx}px ${fontFamily(tx.font)}`;
    ctxOverlay.textAlign = 'center';
    ctxOverlay.textBaseline = 'middle';
    // Stroke preto pra contraste (estilo Shorts virais)
    ctxOverlay.lineWidth = Math.max(2, fontSizePx * 0.06);
    ctxOverlay.strokeStyle = 'rgba(0,0,0,0.85)';
    ctxOverlay.lineJoin = 'round';
    ctxOverlay.strokeText(tx.content || '', x, y);
    ctxOverlay.fillStyle = tx.color || '#ffffff';
    ctxOverlay.fillText(tx.content || '', x, y);
    // Caixa de selecao se selecionado
    if (selectedTextId === tx.id) {
      const metrics = ctxOverlay.measureText(tx.content || '');
      const tw = metrics.width;
      const th = fontSizePx;
      ctxOverlay.strokeStyle = '#fbbf24';
      ctxOverlay.lineWidth = 2;
      ctxOverlay.setLineDash([4, 4]);
      ctxOverlay.strokeRect(x - tw/2 - 8, y - th/2 - 4, tw + 16, th + 8);
      ctxOverlay.setLineDash([]);
    }
    ctxOverlay.restore();
  }

  // ─── Hit test pra drag ─────────────────────────────────────────────────
  function hitTestText(clientX, clientY) {
    if (!overlayEl || !videoEl) return null;
    const rect = overlayEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const s = BEState.get();
    const sourceWidth = s.video.width || 1080;
    const sourceHeight = s.video.height || 1920;
    const videoRatio = sourceWidth / sourceHeight;
    const frameRatio = w / h;
    let videoRenderW, videoRenderH, offsetX, offsetY;
    if (videoRatio > frameRatio) {
      videoRenderW = w; videoRenderH = w / videoRatio;
      offsetX = 0; offsetY = (h - videoRenderH) / 2;
    } else {
      videoRenderH = h; videoRenderW = h * videoRatio;
      offsetX = (w - videoRenderW) / 2; offsetY = 0;
    }
    // Itera textos visiveis no tempo atual + selecionado
    const t = videoEl.currentTime || 0;
    const visible = BEState.getActiveTextsAt ? BEState.getActiveTextsAt(t) : [];
    const checkOrder = [...visible];
    if (selectedTextId) {
      const found = BEState.findText(selectedTextId);
      if (found && !checkOrder.find(t2 => t2.id === found.text.id)) checkOrder.push(found.text);
    }
    for (let i = checkOrder.length - 1; i >= 0; i--) {
      const tx = checkOrder[i];
      const sizePct = SIZE_MAP[tx.size] || SIZE_MAP.medium;
      const fontSizePx = sizePct * videoRenderW;
      const tCenterX = offsetX + tx.x_pct * videoRenderW;
      const tCenterY = offsetY + tx.y_pct * videoRenderH;
      // Bounding box aproximado
      const approxW = (tx.content || '').length * fontSizePx * 0.6 + 24;
      if (x >= tCenterX - approxW/2 && x <= tCenterX + approxW/2 &&
          y >= tCenterY - fontSizePx/2 - 8 && y <= tCenterY + fontSizePx/2 + 8) {
        return { text: tx, offsetX, offsetY, videoRenderW, videoRenderH };
      }
    }
    return null;
  }

  function bindOverlayInput() {
    overlayEl.addEventListener('mousedown', onDown);
    overlayEl.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    overlayEl.addEventListener('touchstart', e => {
      const t = e.touches[0];
      onDown({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() });
    }, { passive: false });
    overlayEl.addEventListener('touchmove', e => {
      const t = e.touches[0];
      onMove({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() });
    }, { passive: false });
    overlayEl.addEventListener('touchend', onUp);
    overlayEl.addEventListener('mousemove', e => {
      const hit = hitTestText(e.clientX, e.clientY);
      overlayEl.style.cursor = hit ? (dragging ? 'grabbing' : 'grab') : 'default';
    });
  }

  function onDown(e) {
    const hit = hitTestText(e.clientX, e.clientY);
    if (hit) {
      e.preventDefault();
      selectedTextId = hit.text.id;
      dragging = {
        textId: hit.text.id,
        startX: e.clientX,
        startY: e.clientY,
        startXPct: hit.text.x_pct,
        startYPct: hit.text.y_pct,
        videoRenderW: hit.videoRenderW,
        videoRenderH: hit.videoRenderH,
      };
      // Notifica painel pra destacar
      if (window.BEEditor && BEEditor.onTextSelected) BEEditor.onTextSelected(selectedTextId);
    } else {
      selectedTextId = null;
      if (window.BEEditor && BEEditor.onTextSelected) BEEditor.onTextSelected(null);
    }
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    const newXPct = Math.max(0.05, Math.min(0.95, dragging.startXPct + dx / dragging.videoRenderW));
    const newYPct = Math.max(0.05, Math.min(0.95, dragging.startYPct + dy / dragging.videoRenderH));
    if (BEState.updateText) BEState.updateText(dragging.textId, { x_pct: newXPct, y_pct: newYPct });
  }

  function onUp() {
    if (!dragging) return;
    // Registra Command pra undo (snapshot do final apos drag)
    const id = dragging.textId;
    const startXPct = dragging.startXPct;
    const startYPct = dragging.startYPct;
    const found = BEState.findText(id);
    if (found && window.BEHistory) {
      const endXPct = found.text.x_pct;
      const endYPct = found.text.y_pct;
      if (Math.abs(endXPct - startXPct) > 0.001 || Math.abs(endYPct - startYPct) > 0.001) {
        BEHistory.execute({
          label: 'mover texto',
          do() { /* ja aplicado */ },
          undo() { BEState.updateText(id, { x_pct: startXPct, y_pct: startYPct }); },
        });
      }
    }
    dragging = null;
  }

  function selectText(id) {
    selectedTextId = id;
  }
  function getSelectedTextId() { return selectedTextId; }

  function init() {
    if (!ensureOverlay()) {
      // Retry quando o player monta
      setTimeout(init, 200);
      return;
    }
    start();
    window.addEventListener('resize', resizeOverlay);
    BEState.subscribe(() => {
      ensureOverlay();
    });
  }

  return { init, selectText, getSelectedTextId, render };
})();
